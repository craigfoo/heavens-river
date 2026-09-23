// Builds render meshes, colliders and walkable floors for one settlement.
// Runs inside a terrain worker (needs the section's WorldGen for ground heights
// and river geometry). Geometry is authored in the town frame (a, h, c) and
// mapped to the anchor-local unrolled frame (ds, h, dz) of the town centre.

import { wrapS } from '../coords/cylinder';
import { Rng, seedFor } from '../core/rng';
import { newSample, type WorldGen } from '../world/gen/world';
import type { TownSite } from '../world/gen/settlements';
import { buildBoathouse, buildBurrow, buildCivic, buildHouse, buildMill, buildTower, buildUniversity, FLOOR_H, type Ground } from './kit';
import { generateTownLayout, type TownLayout } from './layout';
import { MeshBuilder, SURF, lin } from './meshBuilder';
import {
  buildAmphitheater,
  buildBarge,
  buildCanalWalls,
  buildFootBridge,
  buildFountain,
  buildGarden,
  buildPier,
  buildPool,
  buildRack,
  buildRiverBridge,
  buildSignpost,
  buildStall,
  buildStatue,
  buildWall,
  groundQuad,
  PAVE,
  SLAB,
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
}

function makeMapper(site: TownSite, anchorS: number, anchorZ: number, side: 1 | -1): Mapper {
  const rv = site.riverRef;
  return {
    side,
    pos(a, h, c) {
      const z = site.z + a;
      const s = rv.channelAt(z) + side * (rv.widthAt(z) * 0.5 + c);
      return [wrapS(s - anchorS), h, z - anchorZ];
    },
    normal(a, n) {
      const z = site.z + a;
      const m = rv.channelSlope(z) + side * (rv.widthAt(z + 1) - rv.widthAt(z - 1)) * 0.25;
      const ns = side * n[2];
      const nz = n[0] - side * m * n[2];
      const l = Math.hypot(ns, n[1], nz) || 1;
      return [ns / l, n[1] / l, nz / l];
    },
  };
}

/** Convert a builder's town-frame arrays into anchor-local mesh data. */
function finish(mb: MeshBuilder, map: Mapper): TownMesh {
  const n = mb.vertexCount;
  const position = new Float32Array(n * 3);
  const normal = new Int8Array(n * 4);
  const color = new Uint8Array(n * 4);
  const surf = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = mb.pos[i * 3];
    const h = mb.pos[i * 3 + 1];
    const c = mb.pos[i * 3 + 2];
    const p = map.pos(a, h, c);
    position[i * 3] = p[0];
    position[i * 3 + 1] = p[1];
    position[i * 3 + 2] = p[2];
    const nn = map.normal(a, [mb.nrm[i * 3], mb.nrm[i * 3 + 1], mb.nrm[i * 3 + 2]]);
    normal[i * 4] = Math.round(nn[0] * 127);
    normal[i * 4 + 1] = Math.round(nn[1] * 127);
    normal[i * 4 + 2] = Math.round(nn[2] * 127);
    // store colour sRGB-encoded for precision
    for (let k = 0; k < 3; k++) color[i * 4 + k] = Math.round(Math.pow(Math.min(1, Math.max(0, mb.col[i * 3 + k])), 1 / 2.2) * 255);
    color[i * 4 + 3] = 255;
    for (let k = 0; k < 4; k++) surf[i * 4 + k] = mb.surf[i * 4 + k];
  }
  const index = new Uint32Array(mb.idx.length);
  const flip = map.side > 0; // (a, c) -> (s, z) is a reflection on the +s bank
  for (let t = 0; t < mb.idx.length; t += 3) {
    index[t] = mb.idx[t];
    index[t + 1] = flip ? mb.idx[t + 2] : mb.idx[t + 1];
    index[t + 2] = flip ? mb.idx[t + 1] : mb.idx[t + 2];
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

  // cached ground heights on a 6 m grid per bank, bilinear in between
  const groundFor = (side: 1 | -1): Ground => {
    const cache = new Map<number, number>();
    const cell = 6;
    const at = (ia: number, ic: number) => {
      const key = ia * 100_003 + ic;
      let h = cache.get(key);
      if (h === undefined) {
        const a = ia * cell;
        const c = ic * cell;
        const z = site.z + a;
        const s = rv.channelAt(z) + side * (rv.widthAt(z) * 0.5 + c);
        h = gen.sample(s, z, 2.4, sample).h;
        cache.set(key, h);
      }
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
  let poi: TownPoi | null = null;

  for (const B of layout.banks) {
    const map = makeMapper(site, anchorS, anchorZ, B.side);
    const ground = groundFor(B.side);
    const rng = new Rng(seedFor(site.seed, `build${B.side}`));
    const near: MeshBuilder[] = Array.from({ length: nTiles }, () => new MeshBuilder());
    const far: MeshBuilder[] = Array.from({ length: nTiles }, () => new MeshBuilder());
    const both = (a: number, fn: (mb: MeshBuilder, detail: boolean) => void) => {
      const t = tileOf(a);
      fn(near[t], true);
      fn(far[t], false);
    };
    const nearOnly = (a: number, fn: (mb: MeshBuilder) => void) => fn(near[tileOf(a)]);

    // ---- buildings
    for (const b of B.buildings) {
      both(b.a, (mb, detail) => {
        const o = { detail };
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
      // bird perches on ridges
      if (rng.chance(0.08)) {
        const p = map.pos(b.a, ground(b.a, b.c) + b.floors * FLOOR_H + 2.4 + (b.roof === 'thatch' ? 1.4 : 1.0), b.c);
        perches.push(p[0], p[2], p[1]);
      }
    }

    // ---- pavements, quay and waterfront
    for (const st of B.streets) {
      const surf = st.kind === 'plaza' ? SURF.mosaic : st.kind === 'quay' ? SURF.stone : st.kind === 'path' ? SURF.plain : SURF.cobble;
      const rgb = st.kind === 'plaza' ? lin('#c0b094') : st.kind === 'quay' ? SLAB : st.kind === 'path' ? lin('#7a6a50') : PAVE;
      // split long streets into tiles
      const a0 = st.a0;
      const a1 = st.a1;
      const step = Math.min(tileLen, 200);
      for (let a = a0; a < a1 - 0.01; a += step) {
        const b1 = Math.min(a + step, a1);
        const r = { a0: a, a1: b1, c0: st.kind === 'quay' ? 1.1 : st.c0, c1: st.c1 };
        if (B.basins.some((bs) => r.a1 > bs.a0 - 2 && r.a0 < bs.a1 + 2 && r.c0 < bs.c1 + 2)) {
          // split around the basin
          const parts = [
            { a0: r.a0, a1: Math.min(r.a1, B.basins[0].a0 - 2) },
            { a0: Math.max(r.a0, B.basins[0].a1 + 2), a1: r.a1 },
          ].filter((p) => p.a1 - p.a0 > 1);
          for (const pp of parts) {
            const rr = { ...r, a0: pp.a0, a1: pp.a1 };
            both((rr.a0 + rr.a1) / 2, (mb, detail) => {
              if (detail || st.kind === 'plaza' || st.kind === 'quay' || st.kind === 'main') groundQuad(mb, rr, ground, rgb, surf, 0.5, 0.05, detail ? 10 : 30);
            });
          }
          if (st.c1 > B.basins[0].c1 + 2) {
            const rr = { ...r, c0: Math.max(r.c0, B.basins[0].c1 + 2) };
            both((rr.a0 + rr.a1) / 2, (mb, detail) => {
              if (detail || st.kind === 'main') groundQuad(mb, rr, ground, rgb, surf, 0.5, 0.05, detail ? 10 : 30);
            });
          }
          continue;
        }
        both((a + b1) / 2, (mb, detail) => {
          if (detail || st.kind === 'plaza' || st.kind === 'quay' || st.kind === 'main') groundQuad(mb, r, ground, rgb, surf, 0.5, 0.05, detail ? 10 : 30);
        });
      }
      if (st.kind !== 'quay') {
        // NPC waypoints along streets
        const len = Math.max(st.a1 - st.a0, st.c1 - st.c0);
        for (let k = 0; k < len; k += 18) {
          const a = st.a1 - st.a0 > st.c1 - st.c0 ? st.a0 + k : (st.a0 + st.a1) / 2;
          const c = st.a1 - st.a0 > st.c1 - st.c0 ? (st.c0 + st.c1) / 2 : st.c0 + k;
          const p = map.pos(a, ground(a, c), c);
          waypoints.push(p[0], p[2], p[1], st.kind === 'plaza' ? 1 : 0);
        }
      }
    }
    // quay wall segments (explicit, per tile)
    if (B.quay) {
      const L = site.halfLen;
      for (let a = -L; a < L - 0.01; a += 24) {
        const a1 = Math.min(a + 24, L);
        if (B.basins.some((bs) => a1 > bs.a0 && a < bs.a1)) continue;
        both((a + a1) / 2, (mb, detail) => quaySegment(mb, a, a1, ground, water, detail, rng));
        // quay edge waypoints
        const p = map.pos((a + a1) / 2, ground((a + a1) / 2, 4), 4);
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
      const pts: [number, number][] = [
        [bs.a0, -2],
        [bs.a0, bs.c1],
        [bs.a1, bs.c1],
        [bs.a1, -2],
      ];
      both((bs.a0 + bs.a1) / 2, (mb) => buildCanalWalls(mb, pts.map((p, i) => [p[0] + (i === 0 || i === 1 ? -1 : 1) * 0, p[1]] as [number, number]), 0.01, ground, water));
    }
    // ---- canals, bridges
    if (B.side === site.side) {
      for (const cn of site.canals) {
        const a = cn.pts[0][0];
        both(a, (mb) => buildCanalWalls(mb, cn.pts, cn.width, ground, water));
      }
    }
    for (const br of B.bridges) {
      both(br.a, (mb) => {
        buildFootBridge(mb, br, ground, water);
      });
      // bridge deck floor as arched segments
      const hs = br.span / 2 + 1.5;
      const base = ground(br.a, br.c);
      const rise = 1.1 + br.span * 0.04;
      const n = 6;
      for (let i = 0; i < n; i++) {
        const x0 = -hs + (2 * hs * i) / n;
        const x1 = -hs + (2 * hs * (i + 1)) / n;
        const y0 = base + rise * (1 - (x0 / hs) ** 2) + 0.2;
        const y1 = base + rise * (1 - (x1 / hs) ** 2) + 0.2;
        if (br.dir === 'a') addFloor(floors, map, br.a + x0, br.a + x1, br.c - br.width / 2, br.c + br.width / 2, [y0, y1, y1, y0]);
        else addFloor(floors, map, br.a - br.width / 2, br.a + br.width / 2, br.c + x0, br.c + x1, [y0, y0, y1, y1]);
      }
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
      const p = map.pos(s.a, ground(s.a, s.c), s.c - 1.8);
      waypoints.push(p[0], p[2], p[1], 4);
    }
    for (const r of B.racks) nearOnly(r.a, (mb) => buildRack(mb, r, ground));
    for (const g of B.gardens) nearOnly(g.a0, (mb) => buildGarden(mb, g, ground, rng));
    for (const w of B.walls) both((w.a0 + w.a1) / 2, (mb, detail) => buildWall(mb, w, ground, detail));
    if (B.amphitheater) {
      const am = B.amphitheater;
      both(am.a, (mb, detail) => buildAmphitheater(mb, am, ground, detail));
    }
    // signpost
    nearOnly(B.signpost.a, (mb) => buildSignpost(mb, B.signpost.a, B.signpost.c, ground));
    // trees in squares and gardens (as simple crowns on trunks)
    for (const t of B.trees) {
      both(t.a, (mb, detail) => {
        const base = ground(t.a, t.c);
        mb.frame(t.a, 0, t.c, 0);
        mb.cylinder(0, 0, base, base + 2.6 * t.scale, 0.18 * t.scale, 0.12 * t.scale, detail ? 6 : 4, lin('#4a3424'), SURF.timber, 0.2);
        mb.ellipsoid(0, base + 3.8 * t.scale, 0, 2.1 * t.scale, 1.8 * t.scale, 2.1 * t.scale, detail ? 10 : 5, t.type === 3 ? lin('#5a8a34') : lin('#3e6a26'), SURF.turf, 0.8);
        mb.resetFrame();
      });
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
      if (far[t].vertexCount) farParts[t].push(finish(far[t], map));
    }
    if (!poi && B.side === site.side) {
      const dockA = B.dock.a;
      const dockC = site.kind === 'hamlet' ? 3 : 5;
      const dp = map.pos(dockA, ground(dockA, dockC) + 0.05, dockC);
      const inland = map.pos(dockA, 0, dockC + 10);
      const riverDir = Math.atan2(-(dp[0] - inland[0]), -(dp[2] - inland[2]));
      const sp = map.pos(B.signpost.a, ground(B.signpost.a, B.signpost.c), B.signpost.c);
      const mk = B.market ?? { a0: B.dock.a - 10, a1: B.dock.a + 10, c0: 12, c1: 30 };
      const ma = (mk.a0 + mk.a1) / 2;
      const mc = (mk.c0 + mk.c1) / 2 + 6;
      const mp = map.pos(ma, ground(ma, mc), mc);
      // arrival on land: a little inland from the dock, facing the river
      const ga = dockA + 8;
      const gc = site.kind === 'hamlet' ? 10 : 14;
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
    poi: poi ?? { dock: [0, 0, site.level, 0], signpost: [0, 0, site.level], market: [0, 0, site.level], gate: [0, 0, site.level, 0] },
    buildingCount: layout.buildingCount,
    genMs: performance.now() - t0,
  };
}

/** Quay wall + coping + stone deck for one stretch of bank. */
function quaySegment(mb: MeshBuilder, a0: number, a1: number, ground: Ground, water: number, detail: boolean, rng: Rng) {
  mb.resetFrame();
  const top0 = ground(a0, 1.5) + 0.25;
  const top1 = ground(a1, 1.5) + 0.25;
  const stone = lin('#9c8c76');
  mb.quad([a0, water - 4.2, 0], [a1, water - 4.2, 0], [a1, top1, 0], [a0, top0, 0], stone, SURF.stone, 0.13);
  mb.quad([a1, top1, 0], [a0, top0, 0], [a0, top0, 1.1], [a1, top1, 1.1], SLAB, SURF.stone, 0.61);
  if (detail) {
    for (let a = a0 + 6; a < a1 - 1; a += 12) {
      const t = ground(a, 1.5) + 0.25;
      mb.cylinder(a, 0.7, t, t + 0.75, 0.22, 0.18, 7, lin('#4a4038'), SURF.stone, 0.3);
    }
    if (rng.chance(0.3)) {
      // stairs + ramp down to the water
      const a = (a0 + a1) / 2;
      const t = ground(a, 1.5);
      const n = Math.max(3, Math.ceil((t - water + 0.6) / 0.3));
      for (let i = 0; i < n; i++) mb.box(a - 1.2, t - i * 0.3 - 0.3, -0.1 - (i + 1) * 0.45, a + 1.2, t - i * 0.3, -0.1 - i * 0.45, stone, SURF.stone, SURF.stone, 0.4);
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
  const t: Transferable[] = [r.colliders.buffer, r.floors.buffer, r.waypoints.buffer, r.perches.buffer];
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
