// Town props: quays, piers, canal walls, bridges, statues, fountains, pools,
// market stalls, fishing racks, walls, amphitheatre, barges and pavements.

import { Rng } from '../core/rng';
import { archOutline, buildBoat, DARK, fanFace, gableRoof, GOLD, PAINT, STONE, TIMBER, WOOD, type Ground } from './kit';
import { pointSegDist, resample, type OBB, type P2 } from './geom';
import type { CanalDef } from '../world/gen/settlements';
import type { BankLayout, Bridge, Building, Fountain, Pier, Plaza, Rack, Rect, Slipway, Statue, Stall, WallSeg, WaterDoor } from './layout';
import { cross, dot, lin, MeshBuilder, sub, SURF, type V3 } from './meshBuilder';

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

/** Add a quad turned to face roughly `want`. */
function facing(mb: MeshBuilder, A: V3, B: V3, C: V3, D: V3, want: V3, rgb: V3, surf: number, param: number) {
  if (dot(cross(sub(B, A), sub(D, A)), want) >= 0) mb.quad(A, B, C, D, rgb, surf, param);
  else mb.quad(A, D, C, B, rgb, surf, param);
}

/** Corners and heights of a slipway's ramp and (if any) its steps, for walkable floors. */
export function slipwayFloors(sl: Slipway, top: number, bottom: number): { corners: P2[]; h: [number, number, number, number] }[] {
  const kw = sl.steps ? 1.3 : 0;
  const P = (s: number, k: number): P2 => [sl.a + sl.ua * s + sl.na * k, sl.c + sl.uc * s + sl.nc * k];
  const out = [{ corners: [P(0, kw), P(sl.len, kw), P(sl.len, sl.width), P(0, sl.width)], h: [top, bottom, bottom, top] as [number, number, number, number] }];
  if (sl.steps) {
    const run = Math.ceil((top - bottom) / 0.12) * 0.4;
    out.push({ corners: [P(0, 0), P(run, 0), P(run, kw), P(0, kw)], h: [top, bottom, bottom, top] });
  }
  return out;
}

/**
 * A slipway (spec 3): a worn stone ramp at 1:6 running down beside a
 * waterside wall into the water, with a low curb along its edge; public
 * ones have a flight of steps (0.12 m risers, 0.40 m treads) against the
 * wall beside the ramp.
 */
export function buildSlipway(mb: MeshBuilder, sl: Slipway, top: number, water: number, detail: boolean) {
  mb.resetFrame();
  const bottom = water - 0.6;
  const deep = water - 3.6;
  const kw = sl.steps ? 1.3 : 0;
  const P = (s: number, k: number, y: number): V3 => [sl.a + sl.ua * s + sl.na * k, y, sl.c + sl.uc * s + sl.nc * k];
  const up: V3 = [0, 1, 0];
  const out: V3 = [sl.na, 0, sl.nc];
  const inward: V3 = [-sl.na, 0, -sl.nc];
  const down: V3 = [sl.ua, 0, sl.uc];
  const worn = lin('#a79a86');
  facing(mb, P(0, kw, top), P(sl.len, kw, bottom), P(sl.len, sl.width, bottom), P(0, sl.width, top), up, worn, SURF.stone, 0.2);
  facing(mb, P(0, sl.width, top), P(sl.len, sl.width, bottom), P(sl.len, sl.width, deep), P(0, sl.width, deep), out, QUAY_STONE, SURF.stone, 0.13);
  facing(mb, P(sl.len, kw, bottom), P(sl.len, sl.width, bottom), P(sl.len, sl.width, deep), P(sl.len, kw, deep), down, QUAY_STONE, SURF.stone, 0.13);
  if (detail) {
    const cw = 0.22;
    const k0 = sl.width - cw;
    facing(mb, P(0, k0, top + 0.2), P(sl.len, k0, bottom + 0.2), P(sl.len, sl.width, bottom + 0.2), P(0, sl.width, top + 0.2), up, SLAB, SURF.stone, 0.6);
    facing(mb, P(0, k0, top), P(sl.len, k0, bottom), P(sl.len, k0, bottom + 0.2), P(0, k0, top + 0.2), inward, SLAB, SURF.stone, 0.6);
    facing(mb, P(0, sl.width, top), P(sl.len, sl.width, bottom), P(sl.len, sl.width, bottom + 0.2), P(0, sl.width, top + 0.2), out, SLAB, SURF.stone, 0.6);
  }
  if (!sl.steps) return;
  // the flight falls faster than the ramp: the ramp's inner side shows above the treads
  facing(mb, P(0, kw, top), P(sl.len, kw, bottom), P(sl.len, kw, deep), P(0, kw, deep), inward, QUAY_STONE, SURF.stone, 0.13);
  const n = Math.ceil((top - bottom) / 0.12);
  for (let i = 0; i < n; i++) {
    const y = top - (i + 1) * 0.12;
    const s0 = i * 0.4;
    const s1 = (i + 1) * 0.4;
    facing(mb, P(s0, 0, y), P(s1, 0, y), P(s1, kw, y), P(s0, kw, y), up, worn, SURF.stone, 0.2);
    facing(mb, P(s0, 0, y + 0.12), P(s0, kw, y + 0.12), P(s0, kw, y), P(s0, 0, y), down, worn, SURF.stone, 0.2);
  }
  const run = n * 0.4;
  facing(mb, P(run, 0, bottom), P(run, kw, bottom), P(run, kw, deep), P(run, 0, deep), down, QUAY_STONE, SURF.stone, 0.13);
}

/** An underwater door in a waterside wall (spec 2: 1.0 x 0.9 m, top 0.3 m under), marked by a carved stone above the water. */
export function buildWaterDoor(mb: MeshBuilder, wd: WaterDoor, water: number, paint: V3) {
  mb.frame(wd.a, 0, wd.c, Math.atan2(wd.na, -wd.nc));
  fanFace(mb, archOutline(0, water - 1.2, 1.0, 0.9, 8), 0, water - 0.8, -0.03, DARK, SURF.dark, 0.5);
  mb.box(-0.45, water + 0.12, -0.14, 0.45, water + 0.48, 0.0, lin('#c8b898'), SURF.stone, SURF.stone, 0.6);
  mb.box(-0.3, water + 0.2, -0.17, 0.3, water + 0.4, -0.13, paint, SURF.wood, SURF.wood, 1.5);
  mb.resetFrame();
}

/** How far a waterside wall's coping reaches back over the bank. */
export const WALL_LIP = 2.4;

/**
 * Stone wall along a waterside, with the water on the left of the line's
 * direction: a face down into the water and a coping slab back over the bank
 * (it hides where the terrain drops into the cut).
 */
export function buildWaterWall(mb: MeshBuilder, pts: P2[], ground: Ground, water: number, lip = WALL_LIP, depth = 2.8) {
  mb.resetFrame();
  const o = 0.25;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a0, c0] = pts[i];
    const [a1, c1] = pts[i + 1];
    const l = Math.hypot(a1 - a0, c1 - c0);
    if (l < 1e-3) continue;
    // towards the water
    const na = -(c1 - c0) / l;
    const nc = (a1 - a0) / l;
    const t0 = ground(a0 - na * 1.5, c0 - nc * 1.5) + 0.2;
    const t1 = ground(a1 - na * 1.5, c1 - nc * 1.5) + 0.2;
    mb.quad([a0, water - depth, c0], [a1, water - depth, c1], [a1, t1, c1], [a0, t0, c0], QUAY_STONE, SURF.stone, 0.5);
    mb.quad([a0 + na * o, t0 - 0.25, c0 + nc * o], [a1 + na * o, t1 - 0.25, c1 + nc * o], [a1 + na * o, t1, c1 + nc * o], [a0 + na * o, t0, c0 + nc * o], SLAB, SURF.stone, 0.6);
    mb.quad([a0 + na * o, t0, c0 + nc * o], [a1 + na * o, t1, c1 + nc * o], [a1 - na * lip, t1, c1 - nc * lip], [a0 - na * lip, t0, c0 - nc * lip], SLAB, SURF.stone, 0.6);
    // back edge, down to the bank
    mb.quad([a1 - na * lip, t1 - 0.3, c1 - nc * lip], [a0 - na * lip, t0 - 0.3, c0 - nc * lip], [a0 - na * lip, t0, c0 - nc * lip], [a1 - na * lip, t1, c1 - nc * lip], SLAB, SURF.stone, 0.6);
  }
}

/**
 * The walls of a canal, set `inset` into the water, each as a line with the
 * water on its left, starting and ending where the canal leaves the quay
 * (c = cMin). A canal that ends inland has one wall, up one side, round its
 * end and back down the other; a canal whose both ends reach the river (a
 * loop) has two, one along each side.
 */
export function canalWallLines(pts: P2[], width: number, inset: number, cMin: number): P2[][] {
  const hw = width / 2 - inset;
  const secs = pathSections(pts, hw);
  // keep the stretch of a line that lies inland of cMin
  const clip = (line: P2[]): P2[] => {
    let i0 = 0;
    while (i0 < line.length - 1 && line[i0 + 1][1] < cMin) i0++;
    let i1 = line.length - 1;
    while (i1 > 0 && line[i1 - 1][1] < cMin) i1--;
    if (i1 <= i0) return [];
    const out = line.slice(i0, i1 + 1);
    const cut = (p: P2, q: P2): P2 => (p[1] >= cMin ? p : [p[0] + ((q[0] - p[0]) * (cMin - p[1])) / (q[1] - p[1]), cMin]);
    out[0] = cut(out[0], out[1]);
    out[out.length - 1] = cut(out[out.length - 1], out[out.length - 2]);
    return out;
  };
  const right = clip(secs.map((x) => x.r));
  const left = clip(secs.map((x) => x.l)).reverse();
  const last = pts[pts.length - 1];
  if (last[1] < 0) return [right, left].filter((l) => l.length > 1);
  const prev = pts[pts.length - 2];
  const l = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1;
  // from the right-hand wall round the end to the left-hand one
  const th0 = Math.atan2(-(last[0] - prev[0]) / l, (last[1] - prev[1]) / l);
  const cap: P2[] = [];
  for (let k = 1; k < 8; k++) {
    const th = th0 + (k / 8) * Math.PI;
    cap.push([last[0] + Math.cos(th) * hw, last[1] + Math.sin(th) * hw]);
  }
  return [[...right, ...cap, ...left]];
}

/**
 * The waterside walls of a town's canals: each canal's walls, less the
 * stretches that would stand in another canal's water where two meet.
 */
export function canalWalls(canals: CanalDef[], inset: number, cMin: number): P2[][] {
  const wet = (p: P2, k: number) =>
    canals.some((o, j) => {
      if (j === k) return false;
      const hw = o.width / 2 - inset + 0.05;
      for (let i = 0; i < o.pts.length - 1; i++) if (pointSegDist(p, o.pts[i], o.pts[i + 1]) < hw) return true;
      return false;
    });
  // where a wall runs into another canal's water: the point on its edge between a dry p and a wet q
  const edge = (p: P2, q: P2, k: number): P2 => {
    let lo = p;
    let hi = q;
    for (let i = 0; i < 8; i++) {
      const m: P2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
      if (wet(m, k)) hi = m;
      else lo = m;
    }
    return lo;
  };
  const out: P2[][] = [];
  canals.forEach((cn, k) => {
    for (const line of canalWallLines(cn.pts, cn.width, inset, cMin)) {
      const pts = resample(line, 1);
      let run: P2[] = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!wet(p, k)) {
          if (!run.length && i > 0) run.push(edge(p, pts[i - 1], k));
          run.push(p);
        } else if (run.length) {
          run.push(edge(run[run.length - 1], p, k));
          if (run.length > 1) out.push(run);
          run = [];
        }
      }
      if (run.length > 1) out.push(run);
    }
  });
  return out;
}

/** Deck profile of a footbridge: base level (the higher bank), half length and rise of the arch. */
export function bridgeDeck(br: Bridge, ground: Ground): { base: number; hs: number; rise: number } {
  const hs = br.span / 2 + 1.5;
  const ca = Math.cos(br.rot) * hs;
  const cc = Math.sin(br.rot) * hs;
  return { base: Math.max(ground(br.a - ca, br.c - cc), ground(br.a + ca, br.c + cc)), hs, rise: br.timber ? 0.3 + br.span * 0.02 : 1.1 + br.span * 0.04 };
}

/**
 * Timber footbridge (towns, spec 8): a cambered plank deck on stringers,
 * a trestle standing in the water inside each canal wall, and a rail at
 * Quinlan height (0.7 m, spec 2).
 */
export function buildTimberBridge(mb: MeshBuilder, br: Bridge, ground: Ground, water: number) {
  mb.frame(br.a, 0, br.c, br.rot);
  const { base, hs, rise } = bridgeDeck(br, ground);
  const hw = br.width / 2;
  const y = (x: number) => base + rise * (1 - (x / hs) ** 2) + 0.2;
  const plank = WOOD;
  const beam = TIMBER[1];
  const n = 8;
  for (let i = 0; i < n; i++) {
    const x0 = -hs + (2 * hs * i) / n;
    const x1 = -hs + (2 * hs * (i + 1)) / n;
    const y0 = y(x0);
    const y1 = y(x1);
    mb.quad([x1, y1, -hw], [x0, y0, -hw], [x0, y0, hw], [x1, y1, hw], plank, SURF.wood, 0.3);
    // stringers down the sides and under the deck
    mb.quad([x1, y1 - 0.4, -hw], [x0, y0 - 0.4, -hw], [x0, y0, -hw], [x1, y1, -hw], beam, SURF.timber, 0.2);
    mb.quad([x0, y0 - 0.4, hw], [x1, y1 - 0.4, hw], [x1, y1, hw], [x0, y0, hw], beam, SURF.timber, 0.2);
    mb.quad([x0, y0 - 0.4, -hw], [x1, y1 - 0.4, -hw], [x1, y1 - 0.4, hw], [x0, y0 - 0.4, hw], beam, SURF.timber, 0.2);
  }
  // a trestle in the water just inside each canal wall
  for (const sx of [-1, 1]) {
    const x = sx * (br.span / 2 - 2.3);
    const top = y(x) - 0.4;
    for (const z of [-hw + 0.25, hw - 0.25]) mb.box(x - 0.14, water - 2.6, z - 0.14, x + 0.14, top, z + 0.14, beam, SURF.timber, SURF.timber, 0.2);
    mb.box(x - 0.1, top - 0.35, -hw, x + 0.1, top, hw, beam, SURF.timber, SURF.timber, 0.2);
    mb.box(x - 0.08, water + 0.5, -hw + 0.25, x + 0.08, water + 0.72, hw - 0.25, beam, SURF.timber, SURF.timber, 0.2);
  }
  // rails: posts and a top rail following the camber
  const nPost = Math.max(3, Math.round((2 * hs) / 1.6));
  for (const z of [-hw + 0.07, hw - 0.07]) {
    for (let i = 0; i <= nPost; i++) {
      const x = -hs + 0.1 + ((2 * hs - 0.2) * i) / nPost;
      mb.box(x - 0.06, y(x) - 0.05, z - 0.06, x + 0.06, y(x) + 0.7, z + 0.06, beam, SURF.timber, SURF.timber, 0.2);
      if (i === nPost) continue;
      const xn = -hs + 0.1 + ((2 * hs - 0.2) * (i + 1)) / nPost;
      const ya = y(x) + 0.62;
      const yb = y(xn) + 0.62;
      mb.quad([xn, yb, z - 0.05], [x, ya, z - 0.05], [x, ya + 0.1, z - 0.05], [xn, yb + 0.1, z - 0.05], plank, SURF.wood, 0.3);
      mb.quad([x, ya, z + 0.05], [xn, yb, z + 0.05], [xn, yb + 0.1, z + 0.05], [x, ya + 0.1, z + 0.05], plank, SURF.wood, 0.3);
      mb.quad([x, ya + 0.1, z + 0.05], [xn, yb + 0.1, z + 0.05], [xn, yb + 0.1, z - 0.05], [x, ya + 0.1, z - 0.05], plank, SURF.wood, 0.3);
    }
  }
  mb.resetFrame();
}

/** Arched stone footbridge (over a canal), spanning along its rotation. */
export function buildFootBridge(mb: MeshBuilder, br: Bridge, ground: Ground, water: number) {
  mb.frame(br.a, 0, br.c, br.rot);
  const { base, hs, rise } = bridgeDeck(br, ground);
  const hw = br.width / 2;
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
/**
 * Wayside shrine (spec 7, 3 x 3 m): a small statue under a roofed niche,
 * a little pool before it, and offerings on the ledge. It faces -z.
 */
export function buildShrine(mb: MeshBuilder, b: Building, ground: Ground, detail: boolean) {
  const rng = new Rng(b.seed);
  const base = Math.max(ground(b.a, b.c), ground(b.a - Math.sin(b.rot) * 1.4, b.c + Math.cos(b.rot) * 1.4));
  const y = base + 0.25;
  mb.frame(b.a, 0, b.c, b.rot);
  const stone = rng.pick(STONE);
  // platform, back wall and two front posts under a small tiled roof
  mb.box(-1.5, base - 0.5, -1.5, 1.5, y, 1.5, stone, SURF.stone, SURF.mosaic, 0.6, false, lin('#c8b898'));
  mb.box(-1.35, y, 0.95, 1.35, y + 2.2, 1.3, stone, SURF.stone, SURF.stone, 0.45);
  for (const sx of [-1, 1]) mb.box(sx * 1.25 - 0.09, y, -0.45, sx * 1.25 + 0.09, y + 2.05, -0.27, TIMBER[0], SURF.timber, SURF.timber, 0.3);
  mb.box(-1.4, y + 2.05, -0.5, 1.4, y + 2.2, 1.3, TIMBER[0], SURF.timber, SURF.timber, 0.3);
  mb.frame(b.a, 0, b.c, b.rot + Math.PI / 2);
  gableRoof(mb, -0.75, 1.4, -1.55, 1.55, y + 2.2, 0.6, 0.25, 0.2, lin('#b0583a'), SURF.tile, 0.3, 0.1, stone, SURF.stone, b.deco > 0.6 ? GOLD : undefined);
  mb.frame(b.a, 0, b.c, b.rot);
  // the figure on a low plinth, facing out
  const sa = b.a + Math.sin(b.rot) * -0.35;
  const sc = b.c - Math.cos(b.rot) * -0.35;
  buildStatue(mb, { a: sa, c: sc, rot: b.rot, kind: rng.pick(['quinlan', 'otter', 'fish', 'flow'] as const), scale: 0.55, seed: b.seed + 1, plinth: y - ground(sa, sc) + 0.35 }, ground, detail);
  mb.frame(b.a, 0, b.c, b.rot);
  // a small pool in front, and offerings
  mb.box(-1.0, y, -1.45, 1.0, y + 0.3, -1.3, stone, SURF.stone, SURF.stone, 0.5);
  mb.box(-1.0, y, -0.85, 1.0, y + 0.3, -0.7, stone, SURF.stone, SURF.stone, 0.5);
  for (const sx of [-1, 1]) mb.box(sx > 0 ? 0.85 : -1.0, y, -1.3, sx > 0 ? 1.0 : -0.85, y + 0.3, -0.85, stone, SURF.stone, SURF.stone, 0.5);
  mb.quad([0.85, y + 0.22, -1.3], [-0.85, y + 0.22, -1.3], [-0.85, y + 0.22, -0.85], [0.85, y + 0.22, -0.85], WATER, SURF.water, 0.2);
  if (!detail) {
    mb.resetFrame();
    return;
  }
  for (let i = 0; i < 5; i++) {
    const x = -1.1 + i * 0.55 + rng.range(-0.1, 0.1);
    mb.ellipsoid(x, y + 0.08, 0.7, 0.1, 0.08, 0.1, 6, rng.pick(PAINT), SURF.plain, 0.4);
  }
  mb.resetFrame();
}

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

/** Undyed and dyed cloth on the drying racks. */
const CLOTH = [lin('#e0d6bc'), lin('#d8ccb0'), lin('#b8483a'), lin('#3a6a9a'), lin('#c89a3a'), lin('#6a8a4a')];

/** A fish rack (fish hung to dry by the water) or a drying rack for cloth (spec 8). */
export function buildRack(mb: MeshBuilder, r: Rack, ground: Ground) {
  const base = ground(r.a, r.c);
  mb.frame(r.a, 0, r.c, r.rot);
  for (const x of [-1.5, 1.5]) {
    mb.box(x - 0.06, base, -0.5, x + 0.06, base + 1.8, -0.4, TIMBER[1], SURF.timber, SURF.timber, 0.2);
    mb.box(x - 0.06, base, 0.4, x + 0.06, base + 1.8, 0.5, TIMBER[1], SURF.timber, SURF.timber, 0.2);
  }
  mb.box(-1.6, base + 1.7, -0.05, 1.6, base + 1.8, 0.05, TIMBER[1], SURF.timber, SURF.timber, 0.2);
  if (r.kind === 'fish') {
    for (let i = 0; i < 7; i++) mb.ellipsoid(-1.3 + i * 0.43, base + 1.35, 0, 0.07, 0.28, 0.03, 6, lin('#9a9a8a'), SURF.plain, 0.2);
  } else {
    // two or three lengths of cloth over the bar, stirring a little
    const k = Math.floor(Math.abs(r.a * 3.7 + r.c * 1.3));
    const n = 2 + (k % 2);
    for (let i = 0; i < n; i++) {
      const w = 2.9 / n - 0.12;
      const x0 = -1.45 + i * (2.9 / n) + 0.06;
      const drop = 0.75 + ((k >> (i + 1)) % 3) * 0.12;
      const col = CLOTH[(k + i * 5) % CLOTH.length];
      const sway = 0.06 * (i % 2 ? 1 : -1);
      for (const z of [-0.03, 0.03]) {
        const f = z < 0 ? 1 : -1;
        const p0: V3 = [x0, base + 1.72 - drop, z + sway];
        const p1: V3 = [x0 + w, base + 1.72 - drop, z + sway];
        const p2: V3 = [x0 + w, base + 1.72, z];
        const p3: V3 = [x0, base + 1.72, z];
        if (f > 0) mb.quad(p1, p0, p3, p2, col, SURF.cloth, 0.4);
        else mb.quad(p0, p1, p2, p3, col, SURF.cloth, 0.4);
      }
    }
  }
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

/** Vegetable plot (an oriented rectangle): tilled soil, crop rows and a wattle fence. */
export function buildGarden(mb: MeshBuilder, g: OBB, ground: Ground, rng: Rng) {
  const cr = Math.cos(g.rot);
  const sr = Math.sin(g.rot);
  const gl = (x: number, z: number) => ground(g.a + x * cr - z * sr, g.c + x * sr + z * cr);
  mb.frame(g.a, 0, g.c, g.rot);
  const na = Math.max(1, Math.ceil((g.hw * 2) / 4));
  const nc = Math.max(1, Math.ceil((g.hd * 2) / 4));
  const soil = lin('#5a4a32');
  for (let i = 0; i < na; i++)
    for (let j = 0; j < nc; j++) {
      const x0 = -g.hw + (2 * g.hw * i) / na;
      const x1 = -g.hw + (2 * g.hw * (i + 1)) / na;
      const z0 = -g.hd + (2 * g.hd * j) / nc;
      const z1 = -g.hd + (2 * g.hd * (j + 1)) / nc;
      mb.quad([x1, gl(x1, z0) + 0.03, z0], [x0, gl(x0, z0) + 0.03, z0], [x0, gl(x0, z1) + 0.03, z1], [x1, gl(x1, z1) + 0.03, z1], soil, SURF.plain, 0.1, [x1, z0, x0, z1]);
    }
  // crop rows
  const rows = Math.floor((g.hw * 2) / 0.9);
  const crop = rng.pick([lin('#4a7a2a'), lin('#6a8a2a'), lin('#8a6a3a')]);
  for (let i = 0; i < rows; i++) {
    const x = -g.hw + 0.45 + i * 0.9;
    const base = gl(x, 0);
    mb.box(x - 0.18, base, -g.hd + 0.4, x + 0.18, base + 0.28, g.hd - 0.4, crop, SURF.turf, SURF.turf, 0.3);
  }
  // wattle fence posts
  const nf = Math.max(1, Math.round((g.hw * 2) / 2.4));
  for (let k = 0; k <= nf; k++) {
    const x = -g.hw + (2 * g.hw * k) / nf;
    for (const z of [-g.hd, g.hd]) {
      const base = gl(x, z);
      mb.box(x - 0.04, base, z - 0.04, x + 0.04, base + 0.8, z + 0.04, TIMBER[1], SURF.timber, SURF.timber, 0.2);
    }
  }
  mb.resetFrame();
}

/**
 * Cross-sections of a path ribbon: left and right edge points and the
 * distance along the path (the paving pattern runs along it).
 */
export function pathSections(pts: P2[], hw: number): { l: P2; r: P2; u: number }[] {
  const out: { l: P2; r: P2; u: number }[] = [];
  let u = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) u += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const p = pts[Math.max(0, i - 1)];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    // left normal, lengthened at bends so the edges keep their width
    let nx = -(q[1] - p[1]) / l;
    let nz = (q[0] - p[0]) / l;
    if (i > 0 && i < pts.length - 1) {
      const e = pts[i + 1];
      const s = pts[i];
      const ls = Math.hypot(e[0] - s[0], e[1] - s[1]) || 1;
      const k = Math.max(0.6, nx * (-(e[1] - s[1]) / ls) + nz * ((e[0] - s[0]) / ls));
      nx /= k;
      nz /= k;
    }
    out.push({ l: [pts[i][0] + nx * hw, pts[i][1] + nz * hw], r: [pts[i][0] - nx * hw, pts[i][1] - nz * hw], u });
  }
  return out;
}

/** One stretch of a path ribbon (sections i0..i1) laid on the ground. */
export function pathStrip(mb: MeshBuilder, secs: { l: P2; r: P2; u: number }[], i0: number, i1: number, hw: number, ground: Ground, rgb: V3, surf: number, lift: number) {
  mb.resetFrame();
  for (let i = i0; i < i1; i++) {
    const s0 = secs[i];
    const s1 = secs[i + 1];
    mb.quad(
      [s0.l[0], ground(s0.l[0], s0.l[1]) + lift, s0.l[1]],
      [s1.l[0], ground(s1.l[0], s1.l[1]) + lift, s1.l[1]],
      [s1.r[0], ground(s1.r[0], s1.r[1]) + lift, s1.r[1]],
      [s0.r[0], ground(s0.r[0], s0.r[1]) + lift, s0.r[1]],
      rgb,
      surf,
      0.5,
      [s0.u, hw, s1.u, -hw],
    );
  }
}

/** Paving of a square: rings from the centre out to its outline, following the ground. */
export function buildPlaza(mb: MeshBuilder, p: Plaza, ground: Ground, rgb: V3, surf: number, lift: number, detail: boolean) {
  mb.resetFrame();
  const rings = Math.max(1, Math.ceil(p.r / (detail ? 6 : 14)));
  const n = p.rim.length;
  const up: V3 = [0, 1, 0];
  const param = ((Math.abs(p.a * 7.13 + p.c * 3.71) % 1) + 1) % 1;
  const vert = (a: number, c: number) => mb.vertex([a, ground(a, c) + lift, c], up, rgb, surf, a, c, param);
  const centre = vert(p.a, p.c);
  let prev: number[] = [];
  for (let k = 1; k <= rings; k++) {
    const f = k / rings;
    const ring = p.rim.map(([a, c]) => vert(p.a + (a - p.a) * f, p.c + (c - p.c) * f));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (k === 1) mb.index(centre, ring[j], ring[i]);
      else {
        mb.index(prev[i], prev[j], ring[j]);
        mb.index(prev[i], ring[j], ring[i]);
      }
    }
    prev = ring;
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
