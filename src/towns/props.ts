// Town props: quays, piers, canal walls, bridges, statues, fountains, pools,
// market stalls, fishing racks, walls, amphitheatre, barges and pavements.

import { Rng } from '../core/rng';
import { buildBoat, GOLD, PAINT, STONE, TIMBER, WOOD, type Ground } from './kit';
import type { BankLayout, Bridge, Fountain, Pier, Rect, Statue, Stall, WallSeg } from './layout';
import { lin, MeshBuilder, SURF, type V3 } from './meshBuilder';

const PAVE = lin('#a89a84');
const SLAB = lin('#b8aa92');
const QUAY_STONE = lin('#9c8c76');
const MARBLE = lin('#d8d0c0');
const BRONZE = lin('#8c6a3c');
const WATER = lin('#5a8a86');

/** A flat quad that follows the ground at its four corners (plus a small lift). */
export function groundQuad(mb: MeshBuilder, r: Rect, ground: Ground, rgb: V3, surf: number, param: number, lift = 0.04, maxCell = 12) {
  mb.resetFrame();
  const na = Math.max(1, Math.ceil((r.a1 - r.a0) / maxCell));
  const nc = Math.max(1, Math.ceil((r.c1 - r.c0) / maxCell));
  for (let i = 0; i < na; i++)
    for (let j = 0; j < nc; j++) {
      const a0 = r.a0 + ((r.a1 - r.a0) * i) / na;
      const a1 = r.a0 + ((r.a1 - r.a0) * (i + 1)) / na;
      const c0 = r.c0 + ((r.c1 - r.c0) * j) / nc;
      const c1 = r.c0 + ((r.c1 - r.c0) * (j + 1)) / nc;
      // quad in (a, h, c): counter-clockwise from above
      mb.quad(
        [a1, ground(a1, c0) + lift, c0],
        [a0, ground(a0, c0) + lift, c0],
        [a0, ground(a0, c1) + lift, c1],
        [a1, ground(a1, c1) + lift, c1],
        rgb,
        surf,
        param,
        [a1, c0, a0, c1],
      );
    }
}

/** Quay: stone wall into the water, slab deck, bollards and water stairs. */
export function buildQuay(mb: MeshBuilder, B: BankLayout, ground: Ground, water: number, halfLen: number, rng: Rng, detail: boolean) {
  mb.resetFrame();
  const top = (a: number) => ground(a, 1);
  const step = 6;
  for (let a = -halfLen; a < halfLen; a += step) {
    const a1 = Math.min(a + step, halfLen);
    // wall face toward the river (-c)
    mb.quad([a, water - 4.2, 0], [a1, water - 4.2, 0], [a1, top(a1) + 0.25, 0], [a, top(a) + 0.25, 0], QUAY_STONE, SURF.stone, 0.13);
    // coping stones
    mb.quad([a1, top(a1) + 0.25, 0], [a, top(a) + 0.25, 0], [a, top(a) + 0.25, 1.1], [a1, top(a1) + 0.25, 1.1], SLAB, SURF.stone, 0.61);
  }
  if (!detail) return;
  // bollards and carved dock posts
  for (let a = -halfLen + 6; a < halfLen - 4; a += 12) {
    mb.cylinder(a, 0.7, top(a), top(a) + 0.75, 0.22, 0.18, 7, lin('#4a4038'), SURF.stone, 0.3);
  }
  // stairs down to the water
  for (let a = -halfLen + rng.range(20, 50); a < halfLen - 20; a += rng.range(60, 110)) {
    if (B.piers.some((p) => Math.abs(p.a - a) < 8)) continue;
    const t = top(a);
    const n = Math.max(3, Math.ceil((t - water + 0.6) / 0.3));
    for (let i = 0; i < n; i++) {
      const y = t - i * 0.3;
      const c = -0.1 - i * 0.45;
      mb.box(a - 1.2, y - 0.3, c - 0.45, a + 1.2, y, c, QUAY_STONE, SURF.stone, SURF.stone, 0.4);
    }
    // ramp beside the stairs (Quinlans prefer all fours)
    mb.quad([a + 1.2, t, -0.1], [a + 2.6, t, -0.1], [a + 2.6, water - 0.5, -n * 0.45], [a + 1.2, water - 0.5, -n * 0.45], QUAY_STONE, SURF.stone, 0.4);
  }
}

/** Wooden pier on posts reaching into the river, with carved and painted end posts. */
export function buildPier(mb: MeshBuilder, p: Pier, ground: Ground, water: number, rng: Rng, detail: boolean) {
  mb.resetFrame();
  const deck = Math.max(ground(p.a, 1) - 0.1, water + 1.0);
  const hw = p.width / 2;
  const color = p.stone ? QUAY_STONE : WOOD;
  const surf = p.stone ? SURF.stone : SURF.wood;
  mb.frame(p.a, 0, 0, 0);
  if (p.stone) {
    mb.box(-hw, water - 4, -p.len, hw, deck, 0.5, color, surf, surf, 0.2);
  } else {
    mb.box(-hw, deck - 0.2, -p.len, hw, deck, 0.5, color, surf, surf, 0.2);
    const n = Math.ceil(p.len / 3);
    for (let i = 0; i <= n; i++) {
      const c = -p.len + (i / n) * p.len;
      for (const x of [-hw + 0.15, hw - 0.15]) mb.box(x - 0.13, water - 3, c - 0.13, x + 0.13, deck - 0.2, c + 0.13, lin('#4a3828'), SURF.timber, SURF.timber, 0.2);
    }
  }
  if (!detail) return;
  // carved dock posts at the pier head, painted in bands and topped with gold
  const paint = rng.pick(PAINT);
  for (const x of [-hw + 0.2, hw - 0.2]) {
    mb.cylinder(x, -p.len + 0.3, deck, deck + 1.6, 0.2, 0.17, 8, paint, SURF.wood, rng.next() + 1);
    mb.ellipsoid(x, deck + 1.72, -p.len + 0.3, 0.2, 0.26, 0.2, 8, GOLD, SURF.gold, 0.5);
  }
  // mooring posts along the side
  for (let c = -p.len + 4; c < -2; c += 6) mb.cylinder(hw + 0.1, c, deck - 0.3, deck + 0.6, 0.14, 0.12, 6, lin('#4a3828'), SURF.timber, 0.2);
}

/** Stone walls lining a canal segment in (a, c). */
export function buildCanalWalls(mb: MeshBuilder, pts: [number, number][], width: number, ground: Ground, water: number) {
  mb.resetFrame();
  for (let i = 0; i < pts.length - 1; i++) {
    const [a0, c0] = pts[i];
    const [a1, c1] = pts[i + 1];
    const da = a1 - a0;
    const dc = c1 - c0;
    const l = Math.hypot(da, dc) || 1;
    const na = -dc / l;
    const nc = da / l;
    const hw = width / 2;
    for (const side of [-1, 1]) {
      const pa0 = a0 + na * hw * side;
      const pc0 = c0 + nc * hw * side;
      const pa1 = a1 + na * hw * side;
      const pc1 = c1 + nc * hw * side;
      const t0 = ground(pa0 - na * side * 1.5, pc0 - nc * side * 1.5) + 0.2;
      const t1 = ground(pa1 - na * side * 1.5, pc1 - nc * side * 1.5) + 0.2;
      // wall face (facing into the canal)
      if (side > 0) mb.quad([pa1, water - 2.8, pc1], [pa0, water - 2.8, pc0], [pa0, t0, pc0], [pa1, t1, pc1], QUAY_STONE, SURF.stone, 0.5);
      else mb.quad([pa0, water - 2.8, pc0], [pa1, water - 2.8, pc1], [pa1, t1, pc1], [pa0, t0, pc0], QUAY_STONE, SURF.stone, 0.5);
      // coping
      const oa = na * side * 0.8;
      const oc = nc * side * 0.8;
      if (side > 0) mb.quad([pa0, t0, pc0], [pa1, t1, pc1], [pa1 + oa, t1, pc1 + oc], [pa0 + oa, t0, pc0 + oc], SLAB, SURF.stone, 0.6);
      else mb.quad([pa1, t1, pc1], [pa0, t0, pc0], [pa0 + oa, t0, pc0 + oc], [pa1 + oa, t1, pc1 + oc], SLAB, SURF.stone, 0.6);
    }
  }
}

/** Arched stone footbridge (over a canal). Returns the deck height profile for collisions. */
export function buildFootBridge(mb: MeshBuilder, br: Bridge, ground: Ground, water: number) {
  const rot = br.dir === 'a' ? 0 : Math.PI / 2;
  mb.frame(br.a, 0, br.c, rot);
  const base = ground(br.a, br.c + (br.dir === 'a' ? 0 : 0));
  const hs = br.span / 2 + 1.5;
  const hw = br.width / 2;
  const rise = 1.1 + br.span * 0.04;
  const n = 10;
  for (let i = 0; i < n; i++) {
    const x0 = -hs + (2 * hs * i) / n;
    const x1 = -hs + (2 * hs * (i + 1)) / n;
    const y0 = base + rise * (1 - (x0 / hs) ** 2) + 0.2;
    const y1 = base + rise * (1 - (x1 / hs) ** 2) + 0.2;
    // deck (walkway)
    mb.quad([x1, y1, -hw], [x0, y0, -hw], [x0, y0, hw], [x1, y1, hw], PAVE, SURF.cobble, 0.3);
    // arch underside
    const u0 = water + 0.6 + (rise + 0.6) * (1 - (x0 / (hs - 1.2)) ** 2);
    const u1 = water + 0.6 + (rise + 0.6) * (1 - (x1 / (hs - 1.2)) ** 2);
    for (const z of [-hw, hw]) {
      const f = z < 0 ? 1 : -1;
      // spandrel walls
      if (f > 0) mb.quad([x0, Math.min(u0, y0), z], [x1, Math.min(u1, y1), z], [x1, y1 + 0.55, z], [x0, y0 + 0.55, z], QUAY_STONE, SURF.stone, 0.45);
      else mb.quad([x1, Math.min(u1, y1), z], [x0, Math.min(u0, y0), z], [x0, y0 + 0.55, z], [x1, y1 + 0.55, z], QUAY_STONE, SURF.stone, 0.45);
    }
    mb.quad([x0, Math.min(u0, y0), -hw], [x0, Math.min(u0, y0), hw], [x1, Math.min(u1, y1), hw], [x1, Math.min(u1, y1), -hw], QUAY_STONE, SURF.stone, 0.45);
  }
  // parapet caps
  mb.box(-hs, base + 0.2, -hw - 0.25, hs, base + rise + 0.9, -hw, SLAB, SURF.stone, SURF.stone, 0.62);
  mb.box(-hs, base + 0.2, hw, hs, base + rise + 0.9, hw + 0.25, SLAB, SURF.stone, SURF.stone, 0.62);
  mb.resetFrame();
  return { base, rise, hs };
}

/** Grand multi-arch bridge across the river (cities). Spans from c=0 to c=-width on the primary bank frame. */
export function buildRiverBridge(mb: MeshBuilder, a: number, bw: number, riverW: number, ground: Ground, water: number, detail: boolean) {
  mb.frame(a, 0, 0, Math.PI / 2);
  // local x runs along -c (across the river)
  const g0 = ground(a, 2);
  const deckY = water + 7.5;
  const L = riverW;
  const hw = bw / 2;
  const ramp = 30;
  const nArch = Math.max(3, Math.round(L / 34));
  const span = L / nArch;
  const deck = (x: number) => {
    if (x < 0) return g0 + (deckY - g0) * Math.max(0, 1 + x / ramp);
    if (x > L) return g0 + (deckY - g0) * Math.max(0, 1 - (x - L) / ramp);
    return deckY + 0.6 * Math.sin((Math.PI * x) / L);
  };
  const seg = detail ? 4 : 2;
  const step = span / seg;
  for (let x = -ramp; x < L + ramp - 0.01; x += step) {
    const x1 = Math.min(x + step, L + ramp);
    const y0 = deck(x);
    const y1 = deck(x1);
    mb.quad([x1, y1, -hw], [x, y0, -hw], [x, y0, hw], [x1, y1, hw], PAVE, SURF.cobble, 0.2);
    // parapets
    mb.box(x, y0 - 0.1, -hw - 0.4, x1, Math.max(y0, y1) + 0.95, -hw, SLAB, SURF.stone, SURF.stone, 0.62);
    mb.box(x, y0 - 0.1, hw, x1, Math.max(y0, y1) + 0.95, hw + 0.4, SLAB, SURF.stone, SURF.stone, 0.62);
  }
  // arches: piers + vault faces
  for (let k = 0; k < nArch; k++) {
    const xa = k * span;
    const xb = (k + 1) * span;
    const pw = Math.min(4.5, span * 0.14);
    if (k > 0) mb.box(xa - pw / 2, water - 5, -hw - 0.5, xa + pw / 2, deckY - 0.6, hw + 0.5, QUAY_STONE, SURF.stone, SURF.stone, 0.45);
    // vault as segments
    const n = detail ? 10 : 5;
    const r = (span - pw) / 2;
    const cx = (xa + xb) / 2;
    const spring = water + 1.5;
    for (let i = 0; i < n; i++) {
      const t0 = Math.PI * (i / n);
      const t1 = Math.PI * ((i + 1) / n);
      const px0 = cx - Math.cos(t0) * r;
      const px1 = cx - Math.cos(t1) * r;
      const py0 = spring + Math.sin(t0) * Math.min(r, deckY - spring - 1.2);
      const py1 = spring + Math.sin(t1) * Math.min(r, deckY - spring - 1.2);
      mb.quad([px0, py0, -hw - 0.4], [px0, py0, hw + 0.4], [px1, py1, hw + 0.4], [px1, py1, -hw - 0.4], QUAY_STONE, SURF.stone, 0.47);
      // spandrels
      mb.quad([px1, py1, -hw - 0.4], [px0, py0, -hw - 0.4], [px0, deckY - 0.1, -hw - 0.4], [px1, deckY - 0.1, -hw - 0.4], QUAY_STONE, SURF.stone, 0.45);
      mb.quad([px0, py0, hw + 0.4], [px1, py1, hw + 0.4], [px1, deckY - 0.1, hw + 0.4], [px0, deckY - 0.1, hw + 0.4], QUAY_STONE, SURF.stone, 0.45);
    }
    if (detail && k > 0) {
      // statues on the cutwaters
      mb.box(xa - 0.6, deckY + 0.9, -hw - 1.2, xa + 0.6, deckY + 1.5, -hw - 0.2, SLAB, SURF.stone, SURF.stone, 0.6);
    }
  }
  mb.resetFrame();
  return { deck };
}

/** Plinth plus a stylised figure: Quinlans, leaping fish, river creatures or flowing abstract forms. */
export function buildStatue(mb: MeshBuilder, st: Statue, ground: Ground, detail: boolean) {
  const rng = new Rng(st.seed);
  const base = ground(st.a, st.c);
  mb.frame(st.a, 0, st.c, st.rot);
  const s = st.scale;
  const bronze = rng.chance(0.35);
  const col = bronze ? BRONZE : MARBLE;
  const surf = bronze ? SURF.bronze : SURF.statue;
  // plinth with a gold band
  mb.box(-0.55 * s - 0.2, base - 0.3, -0.55 * s - 0.2, 0.55 * s + 0.2, base + st.plinth, 0.55 * s + 0.2, lin('#b8ac98'), SURF.stone, SURF.stone, 0.66);
  mb.box(-0.55 * s - 0.25, base + st.plinth - 0.18, -0.55 * s - 0.25, 0.55 * s + 0.25, base + st.plinth - 0.08, 0.55 * s + 0.25, GOLD, SURF.gold, 0.5);
  const y = base + st.plinth;
  const seg = detail ? 12 : 6;
  const quinlan = (x: number, z: number, rot: number, sing: boolean) => {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const P = (px: number, pz: number): [number, number] => [x + px * c - pz * sn, z + px * sn + pz * c];
    // stocky body, broad head, beaky snout, side eyes, flat tail; arms raised when singing
    let [bx, bz] = P(0, 0);
    mb.ellipsoid(bx, y + 0.55 * s, bz, 0.34 * s, 0.5 * s, 0.3 * s, seg, col, surf, 0.3);
    [bx, bz] = P(0, -0.05 * s);
    mb.ellipsoid(bx, y + 1.08 * s, bz, 0.26 * s, 0.24 * s, 0.25 * s, seg, col, surf, 0.3);
    [bx, bz] = P(0, -0.28 * s);
    mb.ellipsoid(bx, y + 1.02 * s, bz, 0.12 * s, 0.1 * s, 0.16 * s, seg, col, surf, 0.3);
    for (const sx of [-1, 1]) {
      [bx, bz] = P(sx * 0.3 * s, 0);
      mb.ellipsoid(bx, y + (sing ? 1.0 : 0.62) * s, bz, 0.09 * s, 0.28 * s, 0.09 * s, seg / 2, col, surf, 0.3);
      [bx, bz] = P(sx * 0.14 * s, 0.05 * s);
      mb.ellipsoid(bx, y + 0.12 * s, bz, 0.1 * s, 0.14 * s, 0.13 * s, seg / 2, col, surf, 0.3);
    }
    [bx, bz] = P(0, 0.42 * s);
    mb.ellipsoid(bx, y + 0.12 * s, bz, 0.22 * s, 0.05 * s, 0.34 * s, seg, col, surf, 0.3);
  };
  switch (st.kind) {
    case 'quinlan':
      quinlan(0, 0, 0, rng.chance(0.6));
      break;
    case 'singers':
      quinlan(-0.35 * s, 0, 0.5, true);
      quinlan(0.35 * s, 0, -0.5, true);
      break;
    case 'fish': {
      // leaping fish on a wave
      mb.ellipsoid(0, y + 0.25 * s, 0, 0.5 * s, 0.25 * s, 0.35 * s, seg, col, surf, 0.3);
      const tilt = 0.6;
      mb.ellipsoid(0, y + 0.9 * s, 0.1 * s, 0.22 * s, 0.55 * s * Math.cos(tilt), 0.2 * s, seg, col, surf, 0.3);
      mb.tri([0, y + 1.35 * s, 0.4 * s], [0, y + 1.75 * s, 0.75 * s], [0, y + 1.2 * s, 0.75 * s], col, surf, 0.3);
      mb.tri([0, y + 1.2 * s, 0.75 * s], [0, y + 1.75 * s, 0.75 * s], [0, y + 1.35 * s, 0.4 * s], col, surf, 0.3);
      break;
    }
    case 'otter': {
      mb.ellipsoid(0, y + 0.3 * s, 0, 0.25 * s, 0.24 * s, 0.7 * s, seg, col, surf, 0.3);
      mb.ellipsoid(0, y + 0.55 * s, -0.62 * s, 0.2 * s, 0.2 * s, 0.24 * s, seg, col, surf, 0.3);
      mb.ellipsoid(0, y + 0.12 * s, 0.75 * s, 0.25 * s, 0.05 * s, 0.35 * s, seg, col, surf, 0.3);
      break;
    }
    case 'flow': {
      // twisting ribbon: "the river as a line with no ends"
      const n = detail ? 28 : 10;
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const f = (t: number): [V3, V3] => {
          const ang = t * Math.PI * 3;
          const r = 0.35 * s * (1 - t * 0.4);
          const cx = Math.cos(ang) * r;
          const cz = Math.sin(ang) * r;
          const yy = y + t * 2.2 * s;
          const w = 0.22 * s;
          return [
            [cx - Math.sin(ang) * w, yy, cz + Math.cos(ang) * w],
            [cx + Math.sin(ang) * w, yy + 0.2 * s, cz - Math.cos(ang) * w],
          ];
        };
        const [p0, p1] = f(t0);
        const [p2, p3] = f(t1);
        mb.quad(p0, p2, p3, p1, bronze ? BRONZE : GOLD, bronze ? SURF.bronze : SURF.gold, 0.3);
        mb.quad(p2, p0, p1, p3, bronze ? BRONZE : GOLD, bronze ? SURF.bronze : SURF.gold, 0.3);
      }
      break;
    }
  }
  mb.resetFrame();
}

export function buildFountain(mb: MeshBuilder, f: Fountain, ground: Ground, detail: boolean) {
  const base = ground(f.a, f.c);
  mb.frame(f.a, 0, f.c, 0);
  const seg = detail ? 24 : 10;
  // basin wall
  mb.cylinder(0, 0, base - 0.2, base + 0.55, f.r, f.r, seg, lin('#b8ac98'), SURF.stone, 0.66, false);
  mb.cylinder(0, 0, base - 0.2, base + 0.55, f.r - 0.35, f.r - 0.35, seg, lin('#8c8070'), SURF.stone, 0.66, false);
  // water surface
  mb.cylinder(0, 0, base + 0.3, base + 0.35, f.r - 0.35, f.r - 0.35, seg, WATER, SURF.water, 0.1, true);
  // mosaic rim top
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const r0 = f.r - 0.35;
    const r1 = f.r;
    mb.quad(
      [Math.cos(a1) * r0, base + 0.56, Math.sin(a1) * r0],
      [Math.cos(a0) * r0, base + 0.56, Math.sin(a0) * r0],
      [Math.cos(a0) * r1, base + 0.56, Math.sin(a0) * r1],
      [Math.cos(a1) * r1, base + 0.56, Math.sin(a1) * r1],
      lin('#c8b898'),
      SURF.mosaic,
      0.8,
    );
  }
  mb.resetFrame();
}

export function buildPool(mb: MeshBuilder, r: Rect, ground: Ground) {
  const base = ground((r.a0 + r.a1) / 2, (r.c0 + r.c1) / 2);
  mb.resetFrame();
  const rim = 0.5;
  // rim
  mb.box(r.a0 - rim, base - 0.1, r.c0 - rim, r.a1 + rim, base + 0.35, r.c0, lin('#b8ac98'), SURF.stone, SURF.mosaic, 0.7);
  mb.box(r.a0 - rim, base - 0.1, r.c1, r.a1 + rim, base + 0.35, r.c1 + rim, lin('#b8ac98'), SURF.stone, SURF.mosaic, 0.7);
  mb.box(r.a0 - rim, base - 0.1, r.c0, r.a0, base + 0.35, r.c1, lin('#b8ac98'), SURF.stone, SURF.mosaic, 0.7);
  mb.box(r.a1, base - 0.1, r.c0, r.a1 + rim, base + 0.35, r.c1, lin('#b8ac98'), SURF.stone, SURF.mosaic, 0.7);
  // mosaic floor under the water and the water surface
  mb.quad([r.a1, base - 1.2, r.c0], [r.a0, base - 1.2, r.c0], [r.a0, base - 1.2, r.c1], [r.a1, base - 1.2, r.c1], lin('#4a8a9a'), SURF.mosaic, 0.9);
  mb.quad([r.a1, base + 0.15, r.c0], [r.a0, base + 0.15, r.c0], [r.a0, base + 0.15, r.c1], [r.a1, base + 0.15, r.c1], WATER, SURF.water, 0.2);
}

export function buildStall(mb: MeshBuilder, s: Stall, ground: Ground) {
  const rng = new Rng(s.seed);
  const base = ground(s.a, s.c);
  mb.frame(s.a, 0, s.c, s.rot);
  const w = 2.4;
  const d = 1.6;
  mb.box(-w / 2, base, -d / 2, w / 2, base + 0.75, d / 2, WOOD, SURF.wood, SURF.wood, 0.3);
  for (const [x, z] of [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
  ])
    mb.box(x - 0.05, base, z - 0.05, x + 0.05, base + 2.0, z + 0.05, TIMBER[0], SURF.timber, SURF.timber, 0.3);
  const cloth = rng.pick(PAINT);
  mb.quad([w / 2 + 0.2, base + 1.85, -d / 2 - 0.3], [-w / 2 - 0.2, base + 1.85, -d / 2 - 0.3], [-w / 2 - 0.2, base + 2.2, d / 2 + 0.3], [w / 2 + 0.2, base + 2.2, d / 2 + 0.3], cloth, SURF.cloth, rng.next());
  // goods: baskets, fruit, jars
  for (let i = 0; i < 5; i++) {
    const x = -w / 2 + 0.3 + i * 0.45;
    const g = rng.pick([lin('#c85a2a'), lin('#d8b040'), lin('#6a9a3a'), lin('#8a3a5a'), lin('#c8a878')]);
    mb.ellipsoid(x, base + 0.86, rng.range(-0.3, 0.3), 0.17, 0.12, 0.17, 6, g, SURF.plain, 0.2);
  }
  mb.resetFrame();
}

export function buildRack(mb: MeshBuilder, r: { a: number; c: number; rot: number }, ground: Ground) {
  const base = ground(r.a, r.c);
  mb.frame(r.a, 0, r.c, r.rot);
  for (const x of [-1.5, 1.5]) {
    mb.box(x - 0.06, base, -0.5, x + 0.06, base + 1.8, -0.4, TIMBER[1], SURF.timber, SURF.timber, 0.2);
    mb.box(x - 0.06, base, 0.4, x + 0.06, base + 1.8, 0.5, TIMBER[1], SURF.timber, SURF.timber, 0.2);
  }
  mb.box(-1.6, base + 1.7, -0.05, 1.6, base + 1.8, 0.05, TIMBER[1], SURF.timber, SURF.timber, 0.2);
  for (let i = 0; i < 7; i++) mb.ellipsoid(-1.3 + i * 0.43, base + 1.35, 0, 0.07, 0.28, 0.03, 6, lin('#9a9a8a'), SURF.plain, 0.2);
  mb.resetFrame();
}

export function buildSignpost(mb: MeshBuilder, a: number, c: number, ground: Ground) {
  const base = ground(a, c);
  mb.frame(a, 0, c, 0.3);
  mb.box(-0.08, base, -0.08, 0.08, base + 2.4, 0.08, TIMBER[0], SURF.timber, SURF.timber, 0.2);
  const paints = [PAINT[0], PAINT[2], PAINT[3]];
  for (let i = 0; i < 3; i++) {
    mb.frame(a, 0, c, 0.3 + i * 1.9);
    mb.box(0.05, base + 1.5 + i * 0.28, -0.06, 1.1, base + 1.72 + i * 0.28, 0.06, paints[i], SURF.wood, SURF.wood, 0.9 + i);
  }
  mb.resetFrame();
}

export function buildGarden(mb: MeshBuilder, g: Rect, ground: Ground, rng: Rng) {
  mb.resetFrame();
  groundQuad(mb, g, ground, lin('#5a4a32'), SURF.plain, 0.1, 0.03);
  // crop rows
  const rows = Math.floor((g.a1 - g.a0) / 0.9);
  const crop = rng.pick([lin('#4a7a2a'), lin('#6a8a2a'), lin('#8a6a3a')]);
  for (let i = 0; i < rows; i++) {
    const a = g.a0 + 0.45 + i * 0.9;
    const base = ground(a, (g.c0 + g.c1) / 2);
    mb.box(a - 0.18, base, g.c0 + 0.4, a + 0.18, base + 0.28, g.c1 - 0.4, crop, SURF.turf, SURF.turf, 0.3);
  }
  // wattle fence posts
  for (let a = g.a0; a <= g.a1; a += 1.5) {
    for (const c of [g.c0, g.c1]) {
      const base = ground(a, c);
      mb.box(a - 0.04, base, c - 0.04, a + 0.04, base + 0.8, c + 0.04, TIMBER[1], SURF.timber, SURF.timber, 0.2);
    }
  }
}

export function buildWall(mb: MeshBuilder, w: WallSeg, ground: Ground, detail: boolean) {
  const da = w.a1 - w.a0;
  const dc = w.c1 - w.c0;
  const len = Math.hypot(da, dc);
  const rot = Math.atan2(dc, da);
  const ma = (w.a0 + w.a1) / 2;
  const mc = (w.c0 + w.c1) / 2;
  const base = Math.min(ground(w.a0, w.c0), ground(w.a1, w.c1));
  mb.frame(ma, 0, mc, rot);
  const H = 7;
  const T = 2.4;
  const stone = STONE[2];
  if (w.gate) {
    mb.box(-len / 2, base - 0.5, -T / 2, -3, base + H, T / 2, stone, SURF.stone, SURF.stone, 0.44);
    mb.box(3, base - 0.5, -T / 2, len / 2, base + H, T / 2, stone, SURF.stone, SURF.stone, 0.44);
    mb.box(-3, base + 4.2, -T / 2, 3, base + H, T / 2, stone, SURF.stone, SURF.stone, 0.44);
    // gate towers with painted banners
    for (const x of [-4.5, 4.5]) {
      mb.box(x - 2, base - 0.5, -T / 2 - 1, x + 2, base + H + 3.5, T / 2 + 1, stone, SURF.stone, SURF.stone, 0.44);
      if (detail) mb.quad([x + 0.8, base + 3, -T / 2 - 1.05], [x - 0.8, base + 3, -T / 2 - 1.05], [x - 0.8, base + H + 2.5, -T / 2 - 1.05], [x + 0.8, base + H + 2.5, -T / 2 - 1.05], PAINT[2], SURF.flags, 0.4);
    }
  } else {
    mb.box(-len / 2, base - 0.5, -T / 2, len / 2, base + H, T / 2, stone, SURF.stone, SURF.stone, 0.44);
  }
  if (detail) {
    // crenellations
    for (let x = -len / 2 + 0.5; x < len / 2 - 0.5; x += 1.6) {
      if (w.gate && Math.abs(x) < 6.5) continue;
      mb.box(x, base + H, -T / 2, x + 0.8, base + H + 0.9, -T / 2 + 0.6, stone, SURF.stone, SURF.stone, 0.44);
    }
  }
  mb.resetFrame();
}

export function buildAmphitheater(mb: MeshBuilder, am: { a: number; c: number; r: number }, ground: Ground, detail: boolean) {
  const base = ground(am.a, am.c);
  mb.frame(am.a, 0, am.c, 0);
  const tiers = detail ? 9 : 4;
  const seg = detail ? 24 : 12;
  for (let t = 0; t < tiers; t++) {
    const r0 = am.r * 0.35 + (am.r * 0.65 * t) / tiers;
    const r1 = am.r * 0.35 + (am.r * 0.65 * (t + 1)) / tiers;
    const y = base + t * 0.55;
    for (let i = 0; i < seg; i++) {
      const a0 = Math.PI * (i / seg);
      const a1 = Math.PI * ((i + 1) / seg);
      // tread
      mb.quad(
        [Math.cos(a1) * r0, y + 0.55, Math.sin(a1) * r0],
        [Math.cos(a0) * r0, y + 0.55, Math.sin(a0) * r0],
        [Math.cos(a0) * r1, y + 0.55, Math.sin(a0) * r1],
        [Math.cos(a1) * r1, y + 0.55, Math.sin(a1) * r1],
        lin('#b8ac98'),
        SURF.stone,
        0.66,
      );
      // riser
      mb.quad(
        [Math.cos(a0) * r0, y, Math.sin(a0) * r0],
        [Math.cos(a1) * r0, y, Math.sin(a1) * r0],
        [Math.cos(a1) * r0, y + 0.55, Math.sin(a1) * r0],
        [Math.cos(a0) * r0, y + 0.55, Math.sin(a0) * r0],
        lin('#a89c88'),
        SURF.stone,
        0.66,
      );
    }
  }
  // stage
  mb.box(-am.r * 0.3, base - 0.2, -am.r * 0.25, am.r * 0.3, base + 0.9, am.r * 0.05, WOOD, SURF.wood, SURF.wood, 0.3);
  mb.resetFrame();
}

/** Quinlan river barge (also used for the journey barge in its own frame). */
export function buildBarge(mb: MeshBuilder, x: number, z: number, water: number, rot: number, len: number, seed: number, detail: boolean) {
  const rng = new Rng(seed);
  mb.frame(x, 0, z, rot);
  const w = len * 0.3;
  const hw = w / 2;
  const hl = len / 2;
  const y = water - 0.5;
  const deck = water + 0.55;
  const hull = lin('#5a3e28');
  const band = rng.pick(PAINT);
  // hull sides (slightly flared) + bottom
  mb.quad([-hw, y, hl * 0.85], [-hw, y, -hl * 0.85], [-hw - 0.2, deck, -hl * 0.9], [-hw - 0.2, deck, hl * 0.9], hull, SURF.wood, 0.1);
  mb.quad([hw, y, -hl * 0.85], [hw, y, hl * 0.85], [hw + 0.2, deck, hl * 0.9], [hw + 0.2, deck, -hl * 0.9], hull, SURF.wood, 0.1);
  // bow and stern (raised, pointed bow at -z)
  mb.quad([-hw, y, -hl * 0.85], [0, y + 0.3, -hl], [0, deck + 0.5, -hl - 0.4], [-hw - 0.2, deck, -hl * 0.9], hull, SURF.wood, 0.1);
  mb.quad([0, y + 0.3, -hl], [hw, y, -hl * 0.85], [hw + 0.2, deck, -hl * 0.9], [0, deck + 0.5, -hl - 0.4], hull, SURF.wood, 0.1);
  mb.quad([hw, y, hl * 0.85], [-hw, y, hl * 0.85], [-hw - 0.2, deck + 0.2, hl * 0.9], [hw + 0.2, deck + 0.2, hl * 0.9], hull, SURF.wood, 0.1);
  // deck
  mb.quad([hw + 0.2, deck, -hl * 0.9], [-hw - 0.2, deck, -hl * 0.9], [-hw - 0.2, deck, hl * 0.9], [hw + 0.2, deck, hl * 0.9], lin('#8a6a48'), SURF.wood, 0.12);
  // painted band along the hull
  mb.quad([-hw - 0.21, deck - 0.35, hl * 0.88], [-hw - 0.21, deck - 0.35, -hl * 0.88], [-hw - 0.21, deck - 0.1, -hl * 0.88], [-hw - 0.21, deck - 0.1, hl * 0.88], band, SURF.mural, rng.next());
  mb.quad([hw + 0.21, deck - 0.35, -hl * 0.88], [hw + 0.21, deck - 0.35, hl * 0.88], [hw + 0.21, deck - 0.1, hl * 0.88], [hw + 0.21, deck - 0.1, -hl * 0.88], band, SURF.mural, rng.next());
  // gunwale rails
  mb.box(-hw - 0.3, deck, -hl * 0.9, -hw - 0.1, deck + 0.35, hl * 0.9, hull, SURF.wood, SURF.wood, 0.1);
  mb.box(hw + 0.1, deck, -hl * 0.9, hw + 0.3, deck + 0.35, hl * 0.9, hull, SURF.wood, SURF.wood, 0.1);
  // stern deckhouse with a decorated roof
  const hz0 = hl * 0.45;
  const hz1 = hl * 0.88;
  mb.box(-hw * 0.8, deck, hz0, hw * 0.8, deck + 2.0, hz1, rng.pick([lin('#c89a6a'), lin('#d8b888'), lin('#b8c8c8')]), SURF.halftimber, SURF.halftimber, 0.2);
  if (detail) {
    mb.quad([hw * 0.25, deck, hz0 - 0.01], [-hw * 0.25, deck, hz0 - 0.01], [-hw * 0.25, deck + 1.55, hz0 - 0.01], [hw * 0.25, deck + 1.55, hz0 - 0.01], lin('#1c1612'), SURF.dark, 0.2);
  }
  mb.quad([hw * 0.95, deck + 2.0, hz0 - 0.4], [-hw * 0.95, deck + 2.0, hz0 - 0.4], [-hw * 0.95, deck + 2.5, (hz0 + hz1) / 2], [hw * 0.95, deck + 2.5, (hz0 + hz1) / 2], lin('#b85a3a'), SURF.tile, 0.2);
  mb.quad([-hw * 0.95, deck + 2.0, hz1 + 0.4], [hw * 0.95, deck + 2.0, hz1 + 0.4], [hw * 0.95, deck + 2.5, (hz0 + hz1) / 2], [-hw * 0.95, deck + 2.5, (hz0 + hz1) / 2], lin('#b85a3a'), SURF.tile, 0.2);
  // cargo: barrels, crates and grain sacks under a striped awning
  if (detail) {
    for (let i = 0; i < 10; i++) {
      const cx = rng.range(-hw + 0.6, hw - 0.6);
      const cz = rng.range(-hl * 0.6, hz0 - 0.8);
      const k = rng.next();
      if (k < 0.4) mb.cylinder(cx, cz, deck, deck + 0.9, 0.35, 0.35, 8, lin('#7a5a3a'), SURF.wood, 0.2);
      else if (k < 0.75) mb.box(cx - 0.45, deck, cz - 0.45, cx + 0.45, deck + 0.8, cz + 0.45, lin('#9a7a50'), SURF.wood, SURF.wood, 0.2);
      else mb.ellipsoid(cx, deck + 0.3, cz, 0.4, 0.3, 0.3, 6, lin('#c8b080'), SURF.cloth, 0.95);
    }
    const aw = rng.pick(PAINT);
    mb.quad([hw * 0.9, deck + 2.2, -hl * 0.55], [-hw * 0.9, deck + 2.2, -hl * 0.55], [-hw * 0.9, deck + 2.2, hz0 - 0.4], [hw * 0.9, deck + 2.2, hz0 - 0.4], aw, SURF.cloth, rng.next());
    mb.quad([-hw * 0.9, deck + 2.19, -hl * 0.55], [hw * 0.9, deck + 2.19, -hl * 0.55], [hw * 0.9, deck + 2.19, hz0 - 0.4], [-hw * 0.9, deck + 2.19, hz0 - 0.4], aw, SURF.cloth, rng.next());
    for (const [px, pz] of [
      [-hw * 0.85, -hl * 0.5],
      [hw * 0.85, -hl * 0.5],
      [-hw * 0.85, hz0 - 0.5],
      [hw * 0.85, hz0 - 0.5],
    ])
      mb.box(px - 0.05, deck, pz - 0.05, px + 0.05, deck + 2.2, pz + 0.05, TIMBER[0], SURF.timber, SURF.timber, 0.2);
    // carved figurehead: a gilded river creature on the bow
    mb.ellipsoid(0, deck + 0.9, -hl - 0.5, 0.18, 0.3, 0.35, 8, GOLD, SURF.gold, 0.4);
    // steering sweep at the stern
    mb.box(-0.06, deck + 0.8, hz1 - 0.2, 0.06, deck + 0.95, hl + 3.2, lin('#6a4a2a'), SURF.wood, SURF.wood, 0.2);
  }
  mb.resetFrame();
  void buildBoat;
}

export { PAVE, SLAB };
