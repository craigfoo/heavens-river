// Builds render meshes, colliders and walkable floors for one settlement.
// Runs inside a terrain worker (needs the section's WorldGen for ground heights
// and river geometry). Geometry is authored in the town frame (a, h, c) and
// mapped to the anchor-local unrolled frame (ds, h, dz) of the town centre.

import { wrapS } from '../coords/cylinder';
import { Rng, seedFor } from '../core/rng';
import { newSample, type WorldGen } from '../world/gen/world';
import { BANK_CUT, QUAY_CUT, WALL_INSET, type TownSite } from '../world/gen/settlements';
import { buildBoathouse, buildBurrow, buildCivic, buildHouse, buildMill, buildTower, buildUniversity, FLOOR_H, PAINT, type Ground } from './kit';
import { pointSegDist, resample, type P2 } from './geom';
import { generateTownLayout, type Path, type TownLayout } from './layout';
import { MeshBuilder, SURF, lin } from './meshBuilder';
import {
  bridgeDeck,
  buildAmphitheater,
  buildBarge,
  buildSlipway,
  buildWaterDoor,
  buildWaterWall,
  canalWallLines,
  buildFootBridge,
  buildFountain,
  buildGarden,
  buildPier,
  buildPlaza,
  buildPool,
  buildRack,
  buildRiverBridge,
  buildSignpost,
  buildStall,
  buildStatue,
  buildWall,
  groundQuad,
  pathSections,
  pathStrip,
  PAVE,
  SLAB,
  slipwayFloors,
  WALL_LIP,
} from './props';

export interface TownMesh {
  position: Float32Array;
  normal: Int8Array;
  color: Uint8Array;
  surf: Float32Array;
  index: Uint32Array;
}

export interface TownTile {
  near: TownMesh;
  far: TownMesh;
  /** Centre (ds, dz) relative to the anchor and bounding radius. */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

export interface TownPoi {
  dock: [number, number, number, number]; // ds, dz, h, yaw toward the river
  signpost: [number, number, number];
  market: [number, number, number];
  gate: [number, number, number, number]; // arrival point on land: ds, dz, h, yaw
}

export interface TownResult {
  type: 'town';
  siteId: number;
  anchorS: number;
  anchorZ: number;
  tiles: TownTile[];
  /** Per collider: 4 corners (ds, dz) then hMin, hMax (10 floats). */
  colliders: Float32Array;
  /** Per floor: 4 corners (ds, dz), then 4 heights (12 floats). */
  floors: Float32Array;
  /** NPC waypoints: (ds, dz, h, kind) — kind 0 street, 1 market, 2 quay, 3 water, 4 stall. */
  waypoints: Float32Array;
  /** Statue/rooftop perches for surveillance birds: (ds, dz, h). */
  perches: Float32Array;
  /** Painted buildings: (ds, dz, h, reach radius, seed). */
  murals: Float32Array;
  /** Trees in squares and gardens, in the terrain's tree format (TREE_STRIDE floats each). */
  trees: Float32Array;
  poi: TownPoi;
  buildingCount: number;
  genMs: number;
}

export interface TownRequest {
  type: 'town';
  siteId: number;
}

interface Mapper {
  side: 1 | -1;
  pos(a: number, h: number, c: number): [number, number, number];
  normal(a: number, n: [number, number, number]): [number, number, number];
  /** The river's course at a: channel s, half width, and ds/dz of this bank's edge. */
  course(a: number, out: Course): Course;
  anchorS: number;
  /** Town-frame a of the anchor's z. */
  a0: number;
}

interface Course {
  ch: number;
  hw: number;
  m: number;
}

/** The river's course is smooth at this scale: tabulate it and interpolate. */
const COURSE_STEP = 0.5;

function makeMapper(site: TownSite, anchorS: number, anchorZ: number, side: 1 | -1): Mapper {
  const rv = site.riverRef;
  const exact = (a: number, out: Course) => {
    const z = site.z + a;
    out.ch = rv.channelAt(z);
    out.hw = rv.widthAt(z) * 0.5;
    out.m = rv.channelSlope(z) + side * (rv.widthAt(z + 1) - rv.widthAt(z - 1)) * 0.25;
    return out;
  };
  const lo = -site.halfLen - 400;
  const n = Math.ceil((2 * site.halfLen + 800) / COURSE_STEP) + 2;
  const tab = new Float64Array(n * 3);
  const tmp: Course = { ch: 0, hw: 0, m: 0 };
  for (let i = 0; i < n; i++) {
    exact(lo + i * COURSE_STEP, tmp);
    tab[i * 3] = tmp.ch;
    tab[i * 3 + 1] = tmp.hw;
    tab[i * 3 + 2] = tmp.m;
  }
  const course = (a: number, out: Course) => {
    const u = (a - lo) / COURSE_STEP;
    const i = Math.floor(u);
    if (i < 0 || i >= n - 1) return exact(a, out);
    const f = u - i;
    const k = i * 3;
    out.ch = tab[k] + (tab[k + 3] - tab[k]) * f;
    out.hw = tab[k + 1] + (tab[k + 4] - tab[k + 1]) * f;
    out.m = tab[k + 2] + (tab[k + 5] - tab[k + 2]) * f;
    return out;
  };
  const cs: Course = { ch: 0, hw: 0, m: 0 };
  return {
    side,
    anchorS,
    a0: anchorZ - site.z,
    course,
    pos(a, h, c) {
      course(a, cs);
      return [wrapS(cs.ch + side * (cs.hw + c) - anchorS), h, a - (anchorZ - site.z)];
    },
    normal(a, n) {
      course(a, cs);
      const ns = side * n[2];
      const nz = n[0] - side * cs.m * n[2];
      const l = Math.hypot(ns, n[1], nz) || 1;
      return [ns / l, n[1] / l, nz / l];
    },
  };
}

/** Linear colour to 8-bit sRGB-ish (gamma 2.2), tabulated. */
const GAMMA = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) GAMMA[i] = Math.round(Math.pow(i / 4096, 1 / 2.2) * 255);

/** Convert a builder's town-frame arrays into anchor-local mesh data. */
function finish(mb: MeshBuilder, map: Mapper): TownMesh {
  const n = mb.vertexCount;
  const position = new Float32Array(n * 3);
  const normal = new Int8Array(n * 4);
  const color = new Uint8Array(n * 4);
  const surf = new Float32Array(n * 4);
  const side = map.side;
  const cs: Course = { ch: 0, hw: 0, m: 0 };
  const P = mb.pos;
  const N = mb.nrm;
  const C = mb.col;
  const S = mb.surf;
  for (let i = 0; i < n; i++) {
    const a = P[i * 3];
    const c = P[i * 3 + 2];
    map.course(a, cs);
    position[i * 3] = wrapS(cs.ch + side * (cs.hw + c) - map.anchorS);
    position[i * 3 + 1] = P[i * 3 + 1];
    position[i * 3 + 2] = a - map.a0;
    const n0 = N[i * 3];
    const n1 = N[i * 3 + 1];
    const n2 = N[i * 3 + 2];
    const ns = side * n2;
    const nz = n0 - side * cs.m * n2;
    const l = 127 / (Math.sqrt(ns * ns + n1 * n1 + nz * nz) || 1);
    normal[i * 4] = Math.round(ns * l);
    normal[i * 4 + 1] = Math.round(n1 * l);
    normal[i * 4 + 2] = Math.round(nz * l);
    // store colour sRGB-encoded for precision
    for (let k = 0; k < 3; k++) {
      const v = C[i * 3 + k];
      color[i * 4 + k] = GAMMA[Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 4096)];
    }
    color[i * 4 + 3] = 255;
  }
  surf.set(S);
  const I = mb.idx;
  const index = new Uint32Array(I.length);
  const flip = map.side > 0; // (a, c) -> (s, z) is a reflection on the +s bank
  for (let t = 0; t < I.length; t += 3) {
    index[t] = I[t];
    index[t + 1] = flip ? I[t + 2] : I[t + 1];
    index[t + 2] = flip ? I[t + 1] : I[t + 2];
  }
  return { position, normal, color, surf, index };
}

function mergeMeshes(list: TownMesh[]): TownMesh {
  let nv = 0;
  let ni = 0;
  for (const m of list) {
    nv += m.position.length / 3;
    ni += m.index.length;
  }
  const out: TownMesh = {
    position: new Float32Array(nv * 3),
    normal: new Int8Array(nv * 4),
    color: new Uint8Array(nv * 4),
    surf: new Float32Array(nv * 4),
    index: new Uint32Array(ni),
  };
  let ov = 0;
  let oi = 0;
  for (const m of list) {
    out.position.set(m.position, ov * 3);
    out.normal.set(m.normal, ov * 4);
    out.color.set(m.color, ov * 4);
    out.surf.set(m.surf, ov * 4);
    for (let i = 0; i < m.index.length; i++) out.index[oi + i] = m.index[i] + ov;
    ov += m.position.length / 3;
    oi += m.index.length;
  }
  return out;
}

export function buildTown(gen: WorldGen, site: TownSite): TownResult {
  const t0 = performance.now();
  const layout: TownLayout = generateTownLayout(site);
  const anchorS = site.s;
  const anchorZ = site.z;
  const water = site.waterLevel;
  const sample = newSample();
  const rv = site.riverRef;

  // Cached ground heights on a 6 m grid per bank, bilinear in between. Canals
  // and harbour basins are cut out of the ground; what stands beside them
  // stands on the bank, so their cuts are left out (else the grid would drag
  // the banks down into them).
  const cutAt = (side: 1 | -1, a: number, c: number) => {
    // (the quay's edge stands at bank level too, not on the dredged river bed)
    if (site.kind !== 'hamlet' && c > -6.5 && c < QUAY_CUT + 0.5 && Math.abs(a) < site.halfLen + 3) return true;
    if (c < 0) return false;
    if (side !== site.side) return false;
    const m = BANK_CUT + 0.5;
    for (const cn of site.canals) for (let i = 0; i < cn.pts.length - 1; i++) if (pointSegDist([a, c], cn.pts[i], cn.pts[i + 1]) < cn.width / 2 + m) return true;
    return site.basins.some((b) => a > b.a0 - m && a < b.a1 + m && c < b.c1 + m);
  };
  const groundFor = (side: 1 | -1): Ground => {
    const cell = 6;
    const sampleAt = (ia: number, ic: number) => {
      const a = ia * cell;
      const c = ic * cell;
      if (cutAt(side, a, c)) return site.level + Math.max(c, 0) * 0.004;
      const z = site.z + a;
      const s = rv.channelAt(z) + side * (rv.widthAt(z) * 0.5 + c);
      return gen.sample(s, z, 2.4, sample).h;
    };
    // a flat table over the town (NaN until sampled), a map beyond it
    const i0 = Math.floor((-site.halfLen - 300) / cell);
    const j0 = Math.floor(-80 / cell);
    const ni = Math.ceil((2 * site.halfLen + 600) / cell) + 2;
    const nj = Math.ceil((site.depthInland + 380) / cell) + 2;
    const table = new Float64Array(ni * nj).fill(NaN);
    const beyond = new Map<number, number>();
    const at = (ia: number, ic: number) => {
      const i = ia - i0;
      const j = ic - j0;
      if (i >= 0 && i < ni && j >= 0 && j < nj) {
        let h = table[i * nj + j];
        if (h !== h) table[i * nj + j] = h = sampleAt(ia, ic);
        return h;
      }
      const key = ia * 100_003 + ic;
      let h = beyond.get(key);
      if (h === undefined) beyond.set(key, (h = sampleAt(ia, ic)));
      return h;
    };
    return (a: number, c: number) => {
      const u = a / cell;
      const v = c / cell;
      const ia = Math.floor(u);
      const ic = Math.floor(v);
      const fa = u - ia;
      const fc = v - ic;
      const h00 = at(ia, ic);
      const h10 = at(ia + 1, ic);
      const h01 = at(ia, ic + 1);
      const h11 = at(ia + 1, ic + 1);
      return (h00 * (1 - fa) + h10 * fa) * (1 - fc) + (h01 * (1 - fa) + h11 * fa) * fc;
    };
  };

  const tileLen = site.kind === 'city' ? 320 : 4000;
  const nTiles = Math.max(1, Math.ceil((site.halfLen * 2 + 60) / tileLen));
  const tileOf = (a: number) => Math.min(nTiles - 1, Math.max(0, Math.floor((a + site.halfLen + 30) / tileLen)));
  const nearParts: TownMesh[][] = Array.from({ length: nTiles }, () => []);
  const farParts: TownMesh[][] = Array.from({ length: nTiles }, () => []);
  const colliders: number[] = [];
  const floors: number[] = [];
  const waypoints: number[] = [];
  const perches: number[] = [];
  const murals: number[] = [];
  const trees: number[] = [];
  let poi: TownPoi | null = null;

  for (const B of layout.banks) {
    const map = makeMapper(site, anchorS, anchorZ, B.side);
    const ground = groundFor(B.side);
    const rng = new Rng(seedFor(site.seed, `build${B.side}`));
    const near: MeshBuilder[] = Array.from({ length: nTiles }, () => new MeshBuilder());
    const farMb: MeshBuilder[] = Array.from({ length: nTiles }, () => new MeshBuilder());
    const both = (a: number, fn: (mb: MeshBuilder, detail: boolean) => void) => {
      const t = tileOf(a);
      fn(near[t], true);
      fn(farMb[t], false);
    };
    const nearOnly = (a: number, fn: (mb: MeshBuilder) => void) => fn(near[tileOf(a)]);

    // ---- buildings
    for (const b of B.buildings) {
      both(b.a, (mb, detail) => {
        const o = { detail, water };
        switch (b.kind) {
          case 'burrow':
            buildBurrow(mb, b, ground, o);
            break;
          case 'watch':
            buildTower(mb, b, ground, o, 9.5, false);
            break;
          case 'civic':
          case 'hall':
            buildCivic(mb, b, ground, o);
            break;
          case 'university':
            buildUniversity(mb, b, ground, o);
            break;
          case 'mill':
            buildMill(mb, b, ground, o);
            break;
          case 'boathouse':
            buildBoathouse(mb, b, ground, o, water);
            break;
          default:
            buildHouse(mb, b, ground, o);
        }
      });
      // collider footprint (slightly inset so doors feel reachable)
      if (b.kind !== 'boathouse') addBox(colliders, map, b.a, b.c, b.w + (b.kind === 'civic' ? 4 : 0.4), b.d + (b.kind === 'civic' ? 7 : 0.4), b.rot, ground(b.a, b.c) - 1, ground(b.a, b.c) + b.floors * FLOOR_H + 3);
      if (b.mural) {
        const p = map.pos(b.a, ground(b.a, b.c), b.c);
        murals.push(p[0], p[2], p[1], Math.max(b.w, b.d) * 0.5 + 3.5, b.seed % 100000);
      }
      // bird perches on ridges
      if (rng.chance(0.08)) {
        const p = map.pos(b.a, ground(b.a, b.c) + b.floors * FLOOR_H + 2.4 + (b.roof === 'thatch' ? 1.4 : 1.0), b.c);
        perches.push(p[0], p[2], p[1]);
      }
    }

    // ---- open water on this bank (canals are cut on the primary bank only)
    const canals = B.side === site.side ? site.canals : [];
    const wetGap = (a: number, c: number) => {
      let d = Infinity;
      for (const cn of canals) for (let i = 0; i < cn.pts.length - 1; i++) d = Math.min(d, pointSegDist([a, c], cn.pts[i], cn.pts[i + 1]) - cn.width / 2);
      for (const bs of B.basins) if (a > bs.a0 - 1 && a < bs.a1 + 1 && c < bs.c1 + 1) d = -1;
      return d;
    };
    const onBridge = (a: number, c: number) => B.bridges.some((br) => Math.hypot(a - br.a, c - br.c) < br.span / 2 + 2.5);
    // walkable coping and bank over the cut along a waterside wall (water on the left)
    const bankFloors = (line: P2[]) => {
      for (let i = 0; i < line.length - 1; i++) {
        const [a0, c0] = line[i];
        const [a1, c1] = line[i + 1];
        const l = Math.hypot(a1 - a0, c1 - c0);
        if (l < 1e-3) continue;
        const ua = (a1 - a0) / l;
        const uc = (c1 - c0) / l;
        // overlap the joints so bends leave no gaps
        const p0: P2 = [a0 - ua * 0.8, c0 - uc * 0.8];
        const p1: P2 = [a1 + ua * 0.8, c1 + uc * 0.8];
        const land = (p: P2, k: number): P2 => [p[0] + uc * k, p[1] - ua * k];
        const t0 = ground(...land([a0, c0], 1.5)) + 0.2;
        const t1 = ground(...land([a1, c1], 1.5)) + 0.2;
        addFloorQuad(floors, map, [land(p0, -0.25), land(p1, -0.25), land(p1, WALL_LIP), land(p0, WALL_LIP)], [t0, t1, t1, t0]);
        // out past the terrain's slope up out of the cut (one ~1.1 m cell of the walkable ground)
        const out = WALL_INSET + BANK_CUT + 1.6;
        const q = [land(p0, WALL_LIP), land(p1, WALL_LIP), land(p1, out), land(p0, out)];
        addFloorQuad(floors, map, q, q.map(([a, c]) => ground(a, c) + 0.05) as [number, number, number, number]);
      }
    };

    // ---- footpaths: ribbons laid on the ground, split between tiles
    for (const p of B.paths) pavepath(p);
    function pavepath(p: Path) {
      const hw = p.width / 2;
      const surf = p.paving === 'earth' ? SURF.plain : p.paving === 'stone' ? SURF.stone : SURF.cobble;
      const rgb = p.paving === 'earth' ? EARTH : p.paving === 'stone' ? SLAB : PAVE;
      const lift = p.kind === 'main' ? 0.06 : p.kind === 'canalwalk' ? 0.055 : p.paving === 'earth' ? 0.04 : 0.045;
      const far = p.kind === 'main' || p.kind === 'canalwalk';
      const secs = pathSections(p.pts, hw);
      // runs of segments within one tile
      let i0 = 0;
      for (let i = 1; i <= secs.length - 1; i++) {
        const t = tileOf((p.pts[i - 1][0] + p.pts[i][0]) / 2);
        const next = i < secs.length - 1 ? tileOf((p.pts[i][0] + p.pts[i + 1][0]) / 2) : -1;
        if (next === t) continue;
        pathStrip(near[t], secs, i0, i, hw, ground, rgb, surf, lift);
        if (far) {
          // every other section for the distant mesh
          const sub = secs.slice(i0, i + 1).filter((_, k, arr) => k % 2 === 0 || k === arr.length - 1);
          pathStrip(farMb[t], sub, 0, sub.length - 1, hw, ground, rgb, surf, lift);
        }
        i0 = i;
      }
      // NPC waypoints along the way (bridges carry their own)
      let acc = 12;
      for (let i = 0; i < p.pts.length; i++) {
        if (i > 0) acc += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]);
        if (acc < 12 && i < p.pts.length - 1) continue;
        const [a, c] = p.pts[i];
        if (onBridge(a, c) || wetGap(a, c) < 0.5 || c < 0) continue;
        acc = 0;
        const q = map.pos(a, ground(a, c), c);
        waypoints.push(q[0], q[2], q[1], 0);
      }
    }

    // ---- squares
    for (const pl of B.plazas) {
      if (pl.kind === 'quad' || pl.kind === 'amph') continue;
      const rgb = pl.kind === 'market' ? lin('#c0b094') : pl.kind === 'green' ? GREEN_EARTH : PAVE;
      const surf = pl.kind === 'market' ? SURF.mosaic : pl.kind === 'green' ? SURF.plain : SURF.cobble;
      const lift = pl.kind === 'market' ? 0.075 : 0.07;
      both(pl.a, (mb, detail) => buildPlaza(mb, pl, ground, rgb, surf, lift, detail));
    }
    // meeting places in the squares (singing circles, chats)
    for (const pl of B.plazas) {
      if (pl.kind === 'amph') continue;
      const clear = (a: number, c: number) =>
        !B.fountains.some((f) => Math.hypot(a - f.a, c - f.c) < f.r + 2.2) &&
        !B.statues.some((st) => Math.hypot(a - st.a, c - st.c) < 2.4) &&
        !B.stalls.some((st) => Math.hypot(a - st.a, c - st.c) < 2.4) &&
        !B.trees.some((t) => Math.hypot(a - t.a, c - t.c) < 1.6) &&
        !B.pools.some((r) => a > r.a0 - 1.5 && a < r.a1 + 1.5 && c > r.c0 - 1.5 && c < r.c1 + 1.5);
      const spots: P2[] = [];
      if (pl.kind === 'market') {
        for (let a = pl.a - pl.r * 1.4; a < pl.a + pl.r * 1.4; a += 9)
          for (let c = pl.c - pl.r; c < pl.c + pl.r; c += 9) if (inside(pl.rim, a, c, 2)) spots.push([a, c]);
      } else {
        const r = pl.r * 0.55;
        for (let k = 0; k < 5; k++) spots.push([pl.a + Math.cos((k / 5) * Math.PI * 2 + 0.3) * r, pl.c + Math.sin((k / 5) * Math.PI * 2 + 0.3) * r]);
      }
      for (const [a, c] of spots) {
        if (!clear(a, c)) continue;
        const q = map.pos(a, ground(a, c), c);
        waypoints.push(q[0], q[2], q[1], 1);
      }
    }

    // ---- the quay: a stone deck along the river, broken by canal mouths and basins
    if (B.quayW > 0) {
      const L = site.halfLen;
      const cell = 3;
      let run0: number | null = null;
      const flush = (a0: number, a1: number) => {
        for (let a = a0; a < a1 - 0.01; a += 24) {
          const r = { a0: a, a1: Math.min(a + 24, a1), c0: 1.1, c1: B.quayW };
          both((r.a0 + r.a1) / 2, (mb, detail) => groundQuad(mb, r, ground, SLAB, SURF.stone, 0.5, 0.05, detail ? 10 : 30));
        }
      };
      for (let a = -L; a < L + cell - 0.01; a += cell) {
        const dry = a < L && wetGap(a + cell / 2, B.quayW * 0.5) > 0.3 && wetGap(a + cell / 2, 1.2) > 0.3;
        if (dry && run0 === null) run0 = a;
        if (!dry && run0 !== null) {
          flush(run0, Math.min(a, L));
          run0 = null;
        }
      }
      const dry = (x: number) => wetGap(x, 1.5) > -WALL_INSET + 0.1;
      for (let a = -L; a < L - 0.01; a += 24) {
        const a1 = Math.min(a + 24, L);
        if (B.basins.some((bs) => a1 > bs.a0 && a < bs.a1)) continue;
        both((a + a1) / 2, (mb, detail) => quaySegment(mb, a, a1, ground, water, detail, rng, dry));
        // walkable coping and deck over the cut beneath them
        for (const [x0, x1] of drySpans(a, a1, dry)) {
          const t0 = ground(x0, 1.5) + 0.25;
          const t1 = ground(x1, 1.5) + 0.25;
          addFloor(floors, map, x0, x1, -WALL_INSET - 0.25, 1.1, [t0, t1, t1, t0]);
          const d = QUAY_CUT + 1.6;
          addFloor(floors, map, x0, x1, 1.1, d, [ground(x0, 1.1) + 0.05, ground(x1, 1.1) + 0.05, ground(x1, d) + 0.05, ground(x0, d) + 0.05]);
        }
        // quay edge waypoints
        const am = (a + a1) / 2;
        if (wetGap(am, 4) < 1) continue;
        const p = map.pos(am, ground(am, 4), 4);
        waypoints.push(p[0], p[2], p[1], 2);
      }
    }
    for (const p of B.piers) {
      both(p.a, (mb, detail) => buildPier(mb, p, ground, water, new Rng(seedFor(site.seed, `pier${p.a}`)), detail));
      const deck = Math.max(ground(p.a, 1) - 0.1, water + 1.0);
      addFloor(floors, map, p.a - p.width / 2, p.a + p.width / 2, -p.len, 0.6, [deck, deck, deck, deck]);
      const tip = map.pos(p.a, deck, -p.len + 2);
      waypoints.push(tip[0], tip[2], tip[1], 2);
    }
    for (const m of B.moorings) {
      both(m.a, (mb, detail) => buildBarge(mb, m.a, m.c, water, m.rot, m.len, m.seed, detail));
      // barge decks are walkable
      const hw = m.len * 0.15 + 0.2;
      const hl = m.len * 0.45;
      const deck = water + 0.55;
      if (m.rot === 0) addFloor(floors, map, m.a - hw, m.a + hw, m.c - hl, m.c + hl, [deck, deck, deck, deck]);
      else addFloor(floors, map, m.a - hl, m.a + hl, m.c - hw, m.c + hw, [deck, deck, deck, deck]);
    }
    // ---- harbour basin walls (three inland sides)
    for (const bs of B.basins) {
      const k = WALL_INSET;
      // (in short pieces: wall tops and floors follow the ground between their ends)
      const pts = resample(
        [
          [bs.a1 - k, -k],
          [bs.a1 - k, bs.c1 - k],
          [bs.a0 + k, bs.c1 - k],
          [bs.a0 + k, -k],
        ],
        4,
      );
      both((bs.a0 + bs.a1) / 2, (mb) => buildWaterWall(mb, pts, ground, water));
      bankFloors(pts);
    }
    // ---- canals, bridges
    if (B.side === site.side) {
      for (const cn of site.canals) {
        const a = cn.pts[0][0];
        for (const wall of canalWallLines(cn.pts, cn.width, WALL_INSET, -WALL_INSET)) {
          const line = resample(wall, 4);
          both(a, (mb) => buildWaterWall(mb, line, ground, water));
          bankFloors(line);
        }
      }
    }
    // ---- slipways, water stairs and underwater doors (the wet threshold, spec 3)
    for (const sl of B.slips) {
      const quaySide = sl.nc < -0.9 && sl.c < 0;
      const top = ground(sl.a - sl.na * 1.5, sl.c - sl.nc * 1.5) + (quaySide ? 0.25 : 0.2);
      both(sl.a, (mb, detail) => buildSlipway(mb, sl, top, water, detail));
      for (const f of slipwayFloors(sl, top, water - 0.6)) addFloorQuad(floors, map, f.corners, f.h);
      const p = map.pos(sl.a + sl.na * 1.5, top, sl.c + sl.nc * 1.5);
      waypoints.push(p[0], p[2], p[1], 2);
    }
    for (const wd of B.waterDoors) nearOnly(wd.a, (mb) => buildWaterDoor(mb, wd, water, PAINT[Math.floor(Math.abs(wd.a * 7.3)) % PAINT.length]));

    for (const br of B.bridges) {
      both(br.a, (mb) => {
        buildFootBridge(mb, br, ground, water);
      });
      // bridge deck floor as arched segments, and a waypoint on its crown
      const { base, hs, rise } = bridgeDeck(br, ground);
      const ux = Math.cos(br.rot);
      const uz = Math.sin(br.rot);
      const hw = br.width / 2;
      const n = 6;
      for (let i = 0; i < n; i++) {
        const x0 = -hs + (2 * hs * i) / n;
        const x1 = -hs + (2 * hs * (i + 1)) / n;
        const y0 = base + rise * (1 - (x0 / hs) ** 2) + 0.2;
        const y1 = base + rise * (1 - (x1 / hs) ** 2) + 0.2;
        const at = (x: number, z: number): P2 => [br.a + x * ux - z * uz, br.c + x * uz + z * ux];
        addFloorQuad(floors, map, [at(x0, -hw), at(x1, -hw), at(x1, hw), at(x0, hw)], [y0, y1, y1, y0]);
      }
      const top = map.pos(br.a, base + rise + 0.2, br.c);
      waypoints.push(top[0], top[2], top[1], 0);
    }
    // ---- squares, statues, fountains, pools, stalls, racks, gardens, walls
    for (const st of B.statues) {
      both(st.a, (mb, detail) => buildStatue(mb, st, ground, detail));
      addBox(colliders, map, st.a, st.c, 1.1 * st.scale + 0.6, 1.1 * st.scale + 0.6, st.rot, ground(st.a, st.c) - 1, ground(st.a, st.c) + st.plinth + 2 * st.scale);
      const p = map.pos(st.a, ground(st.a, st.c) + st.plinth + 1.3 * st.scale + 0.35, st.c);
      perches.push(p[0], p[2], p[1]);
    }
    for (const f of B.fountains) {
      both(f.a, (mb, detail) => buildFountain(mb, f, ground, detail));
      addBox(colliders, map, f.a, f.c, f.r * 1.7, f.r * 1.7, 0.4, ground(f.a, f.c) - 1, ground(f.a, f.c) + 0.55);
    }
    for (const p of B.pools) both(p.a0, (mb) => buildPool(mb, p, ground));
    for (const s of B.stalls) {
      nearOnly(s.a, (mb) => buildStall(mb, s, ground));
      const ka = s.a + Math.sin(s.rot) * 1.8;
      const kc = s.c - Math.cos(s.rot) * 1.8;
      const p = map.pos(ka, ground(ka, kc), kc);
      waypoints.push(p[0], p[2], p[1], 4);
    }
    for (const r of B.racks) nearOnly(r.a, (mb) => buildRack(mb, r, ground));
    for (const g of B.gardens) nearOnly(g.a, (mb) => buildGarden(mb, g, ground, rng));
    for (const w of B.walls) both((w.a0 + w.a1) / 2, (mb, detail) => buildWall(mb, w, ground, detail));
    if (B.amphitheater) {
      const am = B.amphitheater;
      both(am.a, (mb, detail) => buildAmphitheater(mb, am, ground, detail));
    }
    // signpost
    nearOnly(B.signpost.a, (mb) => buildSignpost(mb, B.signpost.a, B.signpost.c, ground));
    // trees in squares and gardens: drawn with the countryside's instanced trees
    for (const t of B.trees) {
      const p = map.pos(t.a, ground(t.a, t.c) - 0.1, t.c);
      trees.push(p[0], p[1], p[2], 0.75 * t.scale, rng.next() * Math.PI * 2, t.type, rng.next(), 0);
    }
    // ---- cross-river bridges (built once, from the primary bank frame)
    if (B.side === site.side) {
      for (const rb of layout.riverBridges) {
        const W = rv.widthAt(site.z + rb.a);
        both(rb.a, (mb, detail) => {
          buildRiverBridge(mb, rb.a, rb.width, W, ground, water, detail);
        });
        // deck floors (ramps + span) in the primary frame: local x runs along -c
        const g0 = ground(rb.a, 2);
        const deckY = water + 7.5;
        const ramp = 30;
        const pts = [-ramp, -ramp / 2, 0, W * 0.25, W * 0.5, W * 0.75, W, W + ramp / 2, W + ramp];
        const dAt = (x: number) => (x < 0 ? g0 + (deckY - g0) * Math.max(0, 1 + x / ramp) : x > W ? g0 + (deckY - g0) * Math.max(0, 1 - (x - W) / ramp) : deckY + 0.6 * Math.sin((Math.PI * x) / W));
        for (let i = 0; i < pts.length - 1; i++) {
          const x0 = pts[i];
          const x1 = pts[i + 1];
          addFloor(floors, map, rb.a - rb.width / 2, rb.a + rb.width / 2, -x1, -x0, [dAt(x1), dAt(x1), dAt(x0), dAt(x0)]);
        }
      }
    }

    // ---- finish this bank
    for (let t = 0; t < nTiles; t++) {
      if (near[t].vertexCount) nearParts[t].push(finish(near[t], map));
      if (farMb[t].vertexCount) farParts[t].push(finish(farMb[t], map));
    }
    if (!poi && B.side === site.side) {
      const dockA = B.dock.a;
      const dockC = site.kind === 'hamlet' ? 3 : 5;
      const dp = map.pos(dockA, ground(dockA, dockC) + 0.05, dockC);
      const inland = map.pos(dockA, 0, dockC + 10);
      const riverDir = Math.atan2(-(dp[0] - inland[0]), -(dp[2] - inland[2]));
      const sp = map.pos(B.signpost.a, ground(B.signpost.a, B.signpost.c), B.signpost.c);
      const mp = map.pos(B.spot.a, ground(B.spot.a, B.spot.c), B.spot.c);
      // arrival on land: a little inland from the dock (in the market's dock aisle), facing the river
      const ga = site.kind === 'hamlet' ? dockA + 8 : B.spot.a;
      const gc = site.kind === 'hamlet' ? 10 : B.spot.c;
      const gp = map.pos(ga, ground(ga, gc), gc);
      poi = {
        dock: [dp[0], dp[2], dp[1], riverDir],
        signpost: [sp[0], sp[2], sp[1]],
        market: [mp[0], mp[2], mp[1]],
        gate: [gp[0], gp[2], gp[1], riverDir],
      };
    }
  }

  // ---- tiles
  const tiles: TownTile[] = [];
  for (let t = 0; t < nTiles; t++) {
    if (!nearParts[t].length && !farParts[t].length) continue;
    const near = mergeMeshes(nearParts[t]);
    const far = farParts[t].length ? mergeMeshes(farParts[t]) : near;
    let mn = [Infinity, Infinity, Infinity];
    let mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < near.position.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], near.position[i + k]);
        mx[k] = Math.max(mx[k], near.position[i + k]);
      }
    }
    if (!isFinite(mn[0])) {
      mn = [0, 0, 0];
      mx = [0, 0, 0];
    }
    const cx = (mn[0] + mx[0]) / 2;
    const cy = (mn[1] + mx[1]) / 2;
    const cz = (mn[2] + mx[2]) / 2;
    const radius = Math.hypot(mx[0] - cx, mx[1] - cy, mx[2] - cz) + 5;
    tiles.push({ near, far, cx, cy, cz, radius });
  }
  return {
    type: 'town',
    siteId: site.id,
    anchorS,
    anchorZ,
    tiles,
    colliders: new Float32Array(colliders),
    floors: new Float32Array(floors),
    waypoints: new Float32Array(waypoints),
    perches: new Float32Array(perches),
    murals: new Float32Array(murals),
    trees: new Float32Array(trees),
    poi: poi ?? { dock: [0, 0, site.level, 0], signpost: [0, 0, site.level], market: [0, 0, site.level], gate: [0, 0, site.level, 0] },
    buildingCount: layout.buildingCount,
    genMs: performance.now() - t0,
  };
}

/** Stretches of [a0, a1] where `dry` holds, to the metre. */
function drySpans(a0: number, a1: number, dry: (a: number) => boolean): [number, number][] {
  const spans: [number, number][] = [];
  for (let a = a0; a < a1 - 0.01; a += 1) {
    const b = Math.min(a + 1, a1);
    if (!dry((a + b) / 2)) continue;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last[1] - a) < 1e-6) last[1] = b;
    else spans.push([a, b]);
  }
  return spans;
}

/** Quay wall and coping for one stretch of bank (broken where canals open into the river). */
function quaySegment(mb: MeshBuilder, a0: number, a1: number, ground: Ground, water: number, detail: boolean, rng: Rng, dry: (a: number) => boolean) {
  mb.resetFrame();
  const stone = lin('#9c8c76');
  const q = -WALL_INSET;
  for (const [x0, x1] of drySpans(a0, a1, dry)) {
    const top0 = ground(x0, 1.5) + 0.25;
    const top1 = ground(x1, 1.5) + 0.25;
    // face (towards the river) and coping with its front lip
    mb.quad([x1, water - 4.2, q], [x0, water - 4.2, q], [x0, top0, q], [x1, top1, q], stone, SURF.stone, 0.13);
    mb.quad([x1, top1 - 0.25, q - 0.25], [x0, top0 - 0.25, q - 0.25], [x0, top0, q - 0.25], [x1, top1, q - 0.25], SLAB, SURF.stone, 0.61);
    mb.quad([x1, top1, q - 0.25], [x0, top0, q - 0.25], [x0, top0, 1.1], [x1, top1, 1.1], SLAB, SURF.stone, 0.61);
    mb.quad([x0, top0 - 0.3, 1.1], [x1, top1 - 0.3, 1.1], [x1, top1, 1.1], [x0, top0, 1.1], SLAB, SURF.stone, 0.61);
  }
  if (detail) {
    for (let a = a0 + 6; a < a1 - 1; a += 12) {
      if (!dry(a)) continue;
      const t = ground(a, 1.5) + 0.25;
      mb.cylinder(a, q + 0.6, t, t + 0.75, 0.22, 0.18, 7, lin('#4a4038'), SURF.stone, 0.3);
    }
  }
}

function addBox(out: number[], map: Mapper, a: number, c: number, w: number, d: number, rot: number, h0: number, h1: number) {
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (const [x, z] of [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ]) {
    const pa = a + x * cr - z * sr;
    const pc = c + x * sr + z * cr;
    const p = map.pos(pa, 0, pc);
    out.push(p[0], p[2]);
  }
  out.push(h0, h1);
}

/** Walkable floor: any convex quad in (a, c) with a height per corner. */
function addFloorQuad(out: number[], map: Mapper, corners: P2[], h: [number, number, number, number]) {
  for (const [a, c] of corners) {
    const p = map.pos(a, 0, c);
    out.push(p[0], p[2]);
  }
  out.push(h[0], h[1], h[2], h[3]);
}

/** Is (a, c) inside an outline by at least `m`? */
function inside(rim: P2[], a: number, c: number, m: number): boolean {
  let inn = false;
  let d = Infinity;
  for (let i = 0, j = rim.length - 1; i < rim.length; j = i++) {
    const [xi, yi] = rim[i];
    const [xj, yj] = rim[j];
    if (yi > c !== yj > c && a < ((xj - xi) * (c - yi)) / (yj - yi) + xi) inn = !inn;
    d = Math.min(d, pointSegDist([a, c], rim[j], rim[i]));
  }
  return inn && d > m;
}

const EARTH = lin('#8a7658');
const GREEN_EARTH = lin('#8c7c5c');

/** Walkable floor: rectangle in (a, c) with corner heights [a0c0, a1c0, a1c1, a0c1]. */
function addFloor(out: number[], map: Mapper, a0: number, a1: number, c0: number, c1: number, h: [number, number, number, number]) {
  for (const [a, c] of [
    [a0, c0],
    [a1, c0],
    [a1, c1],
    [a0, c1],
  ]) {
    const p = map.pos(a, 0, c);
    out.push(p[0], p[2]);
  }
  out.push(h[0], h[1], h[2], h[3]);
}

export function townTransferables(r: TownResult): Transferable[] {
  const t: Transferable[] = [r.colliders.buffer, r.floors.buffer, r.waypoints.buffer, r.perches.buffer, r.murals.buffer, r.trees.buffer];
  const seen = new Set<ArrayBufferLike>();
  for (const tile of r.tiles)
    for (const m of [tile.near, tile.far])
      for (const arr of [m.position, m.normal, m.color, m.surf, m.index]) {
        if (!seen.has(arr.buffer)) {
          seen.add(arr.buffer);
          t.push(arr.buffer as ArrayBuffer);
        }
      }
  return t;
}
