// Modular Quinlan building kit (spec 7.1). Quinlan scale: doors ~1.5 m tall and
// wide, floor-to-ceiling ~2.2 m, low eaves. Lower floors in fitted river stone,
// upper floors half-timbered with plaster infill, deep roof overhangs, painted
// shutters, carved door frames, patterned ridges and lots of decoration.

import { Rng } from '../core/rng';
import type { Building } from './layout';
import { lin, MeshBuilder, SURF, type V3 } from './meshBuilder';

export const FLOOR_H = 2.5;

const STONE = ['#a08e76', '#ab9a7c', '#8f8170', '#b3a384', '#9c8b7e'].map(lin);
const PLASTER = ['#ecdcbc', '#e4bc7c', '#dc9e7c', '#bccccc', '#cccc9c', '#f2e4cc', '#dcac64', '#e8c8a8'].map(lin);
const TIMBER = ['#4c3626', '#5c402a', '#40301e'].map(lin);
const THATCH = ['#b89858', '#a88848', '#c4a868'].map(lin);
const TILE = ['#b85a3a', '#a84a32', '#c46c44', '#b0503a'].map(lin);
const SHINGLE = ['#6c5c4a', '#7c6652', '#5e5040'].map(lin);
const SLATE = ['#4c525c', '#5a626c'].map(lin);
const PAINT = ['#2a5a8c', '#2c6c4c', '#aa3c2c', '#dcaa34', '#3c8c8c', '#7c3c7c', '#cc6a2c'].map(lin);
const TURF = lin('#5c7c34');
const GOLD = lin('#e8b848');
const DARK = lin('#1c1612');
const WOOD = lin('#7a5a3a');

export interface Ground {
  (a: number, c: number): number;
}

function roofColor(kind: Building['roof'], rng: Rng): V3 {
  switch (kind) {
    case 'thatch':
      return rng.pick(THATCH);
    case 'tile':
      return rng.pick(TILE);
    case 'shingle':
      return rng.pick(SHINGLE);
    case 'slate':
      return rng.pick(SLATE);
    case 'turf':
      return TURF;
    case 'dome':
      return GOLD;
    default:
      return rng.pick(TILE);
  }
}

function roofSurf(kind: Building['roof']): number {
  switch (kind) {
    case 'thatch':
      return SURF.thatch;
    case 'tile':
      return SURF.tile;
    case 'shingle':
      return SURF.shingle;
    case 'slate':
      return SURF.slate;
    case 'turf':
      return SURF.turf;
    case 'dome':
      return SURF.tile;
    default:
      return SURF.tile;
  }
}

/** Ground level under a building footprint (min & max of its corners). */
export function footprintGround(b: Building, ground: Ground): { lo: number; hi: number } {
  const c = Math.cos(b.rot);
  const s = Math.sin(b.rot);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, z] of [
    [-b.w / 2, -b.d / 2],
    [b.w / 2, -b.d / 2],
    [b.w / 2, b.d / 2],
    [-b.w / 2, b.d / 2],
    [0, 0],
  ]) {
    const h = ground(b.a + x * c - z * s, b.c + x * s + z * c);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return { lo, hi };
}

/**
 * Gable roof over [x0,x1] x [z0,z1] starting at eave height yE, ridge along x.
 * Returns ridge height.
 */
export function gableRoof(
  mb: MeshBuilder,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  yE: number,
  pitch: number,
  ovEave: number,
  ovGable: number,
  rgb: V3,
  surf: number,
  param: number,
  thick: number,
  gableRgb: V3,
  gableSurf: number,
  ridgeRgb?: V3,
): number {
  const zc = (z0 + z1) / 2;
  const half = (z1 - z0) / 2;
  const t = Math.tan(pitch);
  const yR = yE + half * t;
  const ya = yE - ovEave * t;
  const xa = x0 - ovGable;
  const xb = x1 + ovGable;
  // front slope (faces -z and up)
  mb.quad([xb, ya, z0 - ovEave], [xa, ya, z0 - ovEave], [xa, yR, zc], [xb, yR, zc], rgb, surf, param);
  // back slope
  mb.quad([xa, ya, z1 + ovEave], [xb, ya, z1 + ovEave], [xb, yR, zc], [xa, yR, zc], rgb, surf, param);
  // undersides (soffits)
  const dk: V3 = [rgb[0] * 0.35, rgb[1] * 0.3, rgb[2] * 0.28];
  mb.quad([xa, ya - thick, z0 - ovEave], [xb, ya - thick, z0 - ovEave], [xb, yR - thick, zc], [xa, yR - thick, zc], dk, SURF.wood, param);
  mb.quad([xb, ya - thick, z1 + ovEave], [xa, ya - thick, z1 + ovEave], [xa, yR - thick, zc], [xb, yR - thick, zc], dk, SURF.wood, param);
  // eave edges (thickness)
  mb.quad([xb, ya - thick, z0 - ovEave], [xa, ya - thick, z0 - ovEave], [xa, ya, z0 - ovEave], [xb, ya, z0 - ovEave], rgb, surf, param);
  mb.quad([xa, ya - thick, z1 + ovEave], [xb, ya - thick, z1 + ovEave], [xb, ya, z1 + ovEave], [xa, ya, z1 + ovEave], rgb, surf, param);
  // gable ends: thickness faces of the roof slab
  const e0: V3 = [0, ya - thick, z0 - ovEave];
  const e1: V3 = [0, yR - thick, zc];
  const e2: V3 = [0, yR, zc];
  const e3: V3 = [0, ya, z0 - ovEave];
  const b0: V3 = [0, yR - thick, zc];
  const b1: V3 = [0, ya - thick, z1 + ovEave];
  const b2: V3 = [0, ya, z1 + ovEave];
  const b3: V3 = [0, yR, zc];
  const at = (p: V3, x: number): V3 => [x, p[1], p[2]];
  // left end (-x)
  mb.quad(at(e0, xa), at(e1, xa), at(e2, xa), at(e3, xa), rgb, surf, param);
  mb.quad(at(b0, xa), at(b1, xa), at(b2, xa), at(b3, xa), rgb, surf, param);
  // right end (+x): reversed order
  mb.quad(at(e1, xb), at(e0, xb), at(e3, xb), at(e2, xb), rgb, surf, param);
  mb.quad(at(b1, xb), at(b0, xb), at(b3, xb), at(b2, xb), rgb, surf, param);
  // gable wall triangles
  for (const [x, dir] of [
    [x0, -1],
    [x1, 1],
  ] as const) {
    if (dir > 0) mb.tri([x, yE, z1], [x, yE, z0], [x, yR - thick * 0.5, zc], gableRgb, gableSurf, param);
    else mb.tri([x, yE, z0], [x, yE, z1], [x, yR - thick * 0.5, zc], gableRgb, gableSurf, param);
  }
  // patterned ridge cap
  if (ridgeRgb) {
    const r = 0.16;
    mb.quad([xb, yR + r, zc], [xa, yR + r, zc], [xa, yR - 0.05, zc + r * 1.6], [xb, yR - 0.05, zc + r * 1.6], ridgeRgb, SURF.mosaic, param + 0.37);
    mb.quad([xa, yR + r, zc], [xb, yR + r, zc], [xb, yR - 0.05, zc - r * 1.6], [xa, yR - 0.05, zc - r * 1.6], ridgeRgb, SURF.mosaic, param + 0.37);
  }
  return yR;
}

/** Hip / pyramid roof over a rectangle. */
export function hipRoof(mb: MeshBuilder, x0: number, x1: number, z0: number, z1: number, yE: number, pitch: number, ov: number, rgb: V3, surf: number, param: number) {
  const t = Math.tan(pitch);
  const hx = (x1 - x0) / 2;
  const hz = (z1 - z0) / 2;
  const r = Math.min(hx, hz);
  const yR = yE + r * t;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const rx = hx - r;
  const rz = hz - r;
  const ya = yE - ov * t;
  const A: V3 = [x0 - ov, ya, z0 - ov];
  const B: V3 = [x1 + ov, ya, z0 - ov];
  const Cc: V3 = [x1 + ov, ya, z1 + ov];
  const Dd: V3 = [x0 - ov, ya, z1 + ov];
  const R0: V3 = [cx - rx, yR, cz - rz];
  const R1: V3 = [cx + rx, yR, cz - rz];
  const R2: V3 = [cx + rx, yR, cz + rz];
  const R3: V3 = [cx - rx, yR, cz + rz];
  mb.quad(B, A, R0, R1, rgb, surf, param);
  mb.quad(Cc, B, R1, R2, rgb, surf, param);
  mb.quad(Dd, Cc, R2, R3, rgb, surf, param);
  mb.quad(A, Dd, R3, R0, rgb, surf, param);
  return yR;
}

/** Door with carved, painted frame and mosaic threshold on the front face (z = zf, facing -z). */
function door(mb: MeshBuilder, x: number, y: number, zf: number, paint: V3, param: number, w = 1.5, h = 1.68, arch = true) {
  const d = 0.18;
  // dark recess
  mb.quad([x + w / 2, y, zf - 0.005], [x - w / 2, y, zf - 0.005], [x - w / 2, y + h, zf - 0.005], [x + w / 2, y + h, zf - 0.005], DARK, SURF.dark, param);
  // door leaf ajar (wood planks, painted)
  mb.quad([x + w / 2 - 0.05, y, zf - 0.02], [x + 0.1, y, zf - 0.02 - 0.55], [x + 0.1, y + h - 0.1, zf - 0.02 - 0.55], [x + w / 2 - 0.05, y + h - 0.1, zf - 0.02], paint, SURF.wood, param);
  // carved frame (posts + lintel)
  const fw = 0.22;
  mb.box(x - w / 2 - fw, y, zf - d, x - w / 2, y + h + fw, zf + 0.02, paint, SURF.wood, SURF.wood, param + 0.5);
  mb.box(x + w / 2, y, zf - d, x + w / 2 + fw, y + h + fw, zf + 0.02, paint, SURF.wood, SURF.wood, param + 0.5);
  mb.box(x - w / 2 - fw - 0.08, y + h, zf - d - 0.04, x + w / 2 + fw + 0.08, y + h + fw + 0.12, zf + 0.02, paint, SURF.wood, SURF.wood, param + 0.5);
  if (arch) {
    // carved crest above the lintel
    mb.tri([x + 0.55, y + h + fw + 0.12, zf - d - 0.03], [x - 0.55, y + h + fw + 0.12, zf - d - 0.03], [x, y + h + fw + 0.62, zf - d - 0.03], GOLD, SURF.gold, param);
  }
  // mosaic threshold
  mb.quad([x + w / 2 + 0.3, y + 0.02, zf - 1.0], [x - w / 2 - 0.3, y + 0.02, zf - 1.0], [x - w / 2 - 0.3, y + 0.02, zf], [x + w / 2 + 0.3, y + 0.02, zf], lin('#c8b898'), SURF.mosaic, param);
  // Quinlans move on all fours: a shallow ramp beside the steps
}

/** Window opening with painted shutters (swung open). */
function windowOpen(mb: MeshBuilder, x: number, y: number, zf: number, paint: V3, param: number, w = 0.85, h = 0.9) {
  mb.quad([x + w / 2, y, zf - 0.01], [x - w / 2, y, zf - 0.01], [x - w / 2, y + h, zf - 0.01], [x + w / 2, y + h, zf - 0.01], DARK, SURF.dark, param);
  // sill
  mb.box(x - w / 2 - 0.1, y - 0.1, zf - 0.14, x + w / 2 + 0.1, y, zf + 0.01, lin('#d8c8a8'), SURF.stone, SURF.stone, param);
  // shutters
  const sw = w / 2;
  mb.quad([x - w / 2, y, zf - 0.03], [x - w / 2 - sw * 0.8, y, zf - 0.03 - sw * 0.55], [x - w / 2 - sw * 0.8, y + h, zf - 0.03 - sw * 0.55], [x - w / 2, y + h, zf - 0.03], paint, SURF.wood, param + 0.25);
  mb.quad([x + w / 2 + sw * 0.8, y, zf - 0.03 - sw * 0.55], [x + w / 2, y, zf - 0.03], [x + w / 2, y + h, zf - 0.03], [x + w / 2 + sw * 0.8, y + h, zf - 0.03 - sw * 0.55], paint, SURF.wood, param + 0.25);
  // woven screen hint (lintel)
  mb.box(x - w / 2 - 0.12, y + h, zf - 0.08, x + w / 2 + 0.12, y + h + 0.14, zf + 0.01, TIMBER[0], SURF.timber, SURF.timber, param);
}

/** Decorate one wall face (front, facing -z at z=zf) with windows and optional door. */
function facade(mb: MeshBuilder, w: number, floors: number, yBase: number, zf: number, paint: V3, rng: Rng, param: number, withDoor: boolean, detail: boolean) {
  if (!detail) return;
  const doorX = withDoor ? rng.range(-w / 2 + 1.4, w / 2 - 1.4) * 0.6 : 1e9;
  if (withDoor) door(mb, doorX, yBase, zf, paint, param, 1.5, 1.68, rng.chance(0.6));
  for (let f = 0; f < floors; f++) {
    const y = yBase + f * FLOOR_H + (f === 0 ? 0.95 : 0.8);
    const n = Math.max(1, Math.floor((w - 1) / 2.6));
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (w * (i + 0.5)) / n;
      if (f === 0 && Math.abs(x - doorX) < 1.6) continue;
      windowOpen(mb, x, y, zf - (f > 0 ? 0.3 : 0), paint, param);
    }
  }
}

export interface BuildOpts {
  detail: boolean;
}

/** Generic Quinlan house / shop / tavern / workshop / warehouse. */
export function buildHouse(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts) {
  const rng = new Rng(b.seed);
  const { lo, hi } = footprintGround(b, ground);
  const y0 = hi + 0.18; // floor level
  const w = b.w;
  const d = b.d;
  mb.frame(b.a, 0, b.c, b.rot);
  const stone = rng.pick(STONE);
  const plaster = rng.pick(PLASTER);
  const timber = rng.pick(TIMBER);
  const paint = rng.pick(PAINT);
  const roofRgb = roofColor(b.roof, rng);
  const param = (b.seed % 997) / 997;
  const warehouse = b.kind === 'warehouse';
  const lowerH = FLOOR_H + (warehouse ? 0.9 : 0);
  // plinth & stone lower storey (flood resistant)
  mb.box(-w / 2 - 0.12, lo - 0.6, -d / 2 - 0.12, w / 2 + 0.12, y0, d / 2 + 0.12, stone, SURF.stone, SURF.stone, param);
  mb.box(-w / 2, y0, -d / 2, w / 2, y0 + lowerH, d / 2, stone, SURF.stone, SURF.stone, param);
  let top = y0 + lowerH;
  // upper storeys: half-timbered plaster with a jettied overhang
  const upper = b.floors - 1;
  const jet = upper > 0 ? 0.35 : 0;
  if (upper > 0) {
    // jetty beam
    mb.box(-w / 2 - jet - 0.05, top - 0.05, -d / 2 - jet - 0.05, w / 2 + jet + 0.05, top + 0.22, d / 2 + jet + 0.05, timber, SURF.timber, SURF.timber, param);
    const surf = b.mural ? SURF.halftimber : rng.chance(0.75) ? SURF.halftimber : SURF.plaster;
    mb.box(-w / 2 - jet, top + 0.22, -d / 2 - jet, w / 2 + jet, top + 0.22 + upper * FLOOR_H, d / 2 + jet, plaster, surf, surf, param);
    top += 0.22 + upper * FLOOR_H;
  }
  // mural on a side wall (warehouses and civic walls get bold paintings)
  if (b.mural && o.detail) {
    const my0 = warehouse ? y0 + 0.6 : y0 + lowerH + 0.4;
    const my1 = top - 0.4;
    if (my1 - my0 > 1.2) {
      const side = rng.sign();
      const x = side * (w / 2 + jet + 0.03);
      const zA = -d / 2 + 0.6;
      const zB = d / 2 - 0.6;
      if (side > 0) mb.quad([x, my0, zB], [x, my0, zA], [x, my1, zA], [x, my1, zB], lin('#ffffff'), SURF.mural, rng.next());
      else mb.quad([x, my0, zA], [x, my0, zB], [x, my1, zB], [x, my1, zA], lin('#ffffff'), SURF.mural, rng.next());
      // and on the front of big warehouses
      if (warehouse) mb.quad([w / 2 - 1, my0 + 1.6, -d / 2 - 0.03], [-w / 2 + 1, my0 + 1.6, -d / 2 - 0.03], [-w / 2 + 1, my1, -d / 2 - 0.03], [w / 2 - 1, my1, -d / 2 - 0.03], lin('#ffffff'), SURF.mural, rng.next());
    }
  }
  // roof
  const pitch = b.roof === 'thatch' ? 0.85 : b.roof === 'slate' ? 0.7 : b.roof === 'turf' ? 0.45 : 0.6;
  const thick = b.roof === 'thatch' ? 0.38 : 0.12;
  const ov = b.roof === 'thatch' ? 1.0 : 0.85;
  const gableSurf = upper > 0 ? SURF.halftimber : SURF.plaster;
  const ridgeRgb = o.detail && b.roof !== 'thatch' && b.roof !== 'turf' ? rng.pick(PAINT) : undefined;
  let yR: number;
  if (warehouse || (b.roof === 'slate' && rng.chance(0.5))) {
    yR = hipRoof(mb, -w / 2 - jet, w / 2 + jet, -d / 2 - jet, d / 2 + jet, top, pitch * 0.9, ov, roofRgb, roofSurf(b.roof), param);
  } else {
    yR = gableRoof(mb, -w / 2 - jet, w / 2 + jet, -d / 2 - jet, d / 2 + jet, top, pitch, ov, 0.4, roofRgb, roofSurf(b.roof), param, thick, plaster, gableSurf, ridgeRgb);
  }
  if (!o.detail) return;
  // gable finials
  if (b.roof !== 'thatch' && !warehouse) {
    for (const sx of [-1, 1]) mb.cylinder(sx * (w / 2 + jet + 0.4), 0, yR - 0.1, yR + 0.55, 0.12, 0.02, 5, GOLD, SURF.gold, param);
  }
  // chimney
  if (rng.chance(b.kind === 'workshop' ? 0.9 : 0.4)) {
    const cx = rng.range(-w / 3, w / 3);
    const cz = rng.range(0, d / 4);
    mb.box(cx - 0.4, top - 0.5, cz - 0.4, cx + 0.4, yR + 0.9, cz + 0.4, stone, SURF.stone, SURF.stone, param);
  }
  // facades
  facade(mb, w, 1, y0, -d / 2, paint, rng, param, true, o.detail);
  if (upper > 0) {
    // upper floor windows on the jettied wall
    for (let f = 1; f <= upper; f++) {
      const y = y0 + lowerH + 0.22 + (f - 1) * FLOOR_H + 0.75;
      const n = Math.max(1, Math.floor((w - 1) / 2.6));
      for (let i = 0; i < n; i++) windowOpen(mb, -w / 2 + (w * (i + 0.5)) / n, y, -d / 2 - jet, paint, param);
    }
  }
  // back windows (simpler)
  mb.frame(b.a, 0, b.c, b.rot + Math.PI);
  const nb = Math.max(1, Math.floor((w - 2) / 3.2));
  for (let i = 0; i < nb; i++) windowOpen(mb, -w / 2 + (w * (i + 0.5)) / nb, y0 + 0.95, -d / 2, paint, param);
  mb.frame(b.a, 0, b.c, b.rot);
  // shop / tavern signs and awnings
  if (b.kind === 'tavern' || b.kind === 'shop') {
    const ax = rng.range(-w / 4, w / 4);
    // awning (striped cloth) over the ground floor front
    const aw = Math.min(w - 1, 5.5);
    mb.quad([ax + aw / 2, y0 + 2.35, -d / 2 - 1.6], [ax - aw / 2, y0 + 2.35, -d / 2 - 1.6], [ax - aw / 2, y0 + 2.85, -d / 2], [ax + aw / 2, y0 + 2.85, -d / 2], rng.pick(PAINT), SURF.cloth, rng.next());
    if (b.kind === 'tavern') {
      // hanging sign on a bracket
      mb.box(w / 2 - 0.2, y0 + 2.9, -d / 2 - 1.3, w / 2 - 0.1, y0 + 3.0, -d / 2, timber, SURF.timber, SURF.timber, param);
      mb.box(w / 2 - 0.2, y0 + 2.1, -d / 2 - 1.05, w / 2 - 0.1, y0 + 2.85, -d / 2 - 0.35, rng.pick(PAINT), SURF.mural, rng.next());
    }
  }
  if (warehouse) {
    // big loading door and hoist beam toward the river
    mb.quad([1.6, y0, -d / 2 - 0.02], [-1.6, y0, -d / 2 - 0.02], [-1.6, y0 + 2.8, -d / 2 - 0.02], [1.6, y0 + 2.8, -d / 2 - 0.02], DARK, SURF.dark, param);
    mb.box(-0.15, top - 0.35, -d / 2 - 1.8, 0.15, top - 0.05, -d / 2, timber, SURF.timber, SURF.timber, param);
    // barrels and crates on the quay side
    for (let i = 0; i < 4; i++) {
      const x = rng.range(-w / 2 + 1, w / 2 - 1);
      if (rng.chance(0.5)) mb.cylinder(x, -d / 2 - 1.2 - rng.range(0, 1.5), y0 - 0.15, y0 + 0.75, 0.32, 0.32, 8, WOOD, SURF.wood, param);
      else mb.box(x - 0.4, y0 - 0.15, -d / 2 - 2.2, x + 0.4, y0 + 0.65, -d / 2 - 1.4, WOOD, SURF.wood, SURF.wood, param);
    }
  }
  if (b.kind === 'workshop') {
    // lean-to shed with an open front
    const sx = w / 2 + 0.1;
    mb.box(sx, y0, -d / 2 + 0.5, sx + 3, y0 + 0.1, d / 2 - 0.5, WOOD, SURF.wood, SURF.wood, param);
    for (const z of [-d / 2 + 0.6, d / 2 - 0.6]) mb.box(sx + 2.8, y0, z - 0.1, sx + 3, y0 + 2.1, z + 0.1, timber, SURF.timber, SURF.timber, param);
    mb.quad([sx + 3.3, y0 + 2.1, d / 2 - 0.3], [sx + 3.3, y0 + 2.1, -d / 2 + 0.3], [sx - 0.1, y0 + 2.9, -d / 2 + 0.3], [sx - 0.1, y0 + 2.9, d / 2 - 0.3], roofRgb, roofSurf(b.roof), param);
  }
  if (b.waterDoor) {
    // arched water entrance on the river side
    mb.quad([1.2, lo - 0.6, -d / 2 - 0.03], [-1.2, lo - 0.6, -d / 2 - 0.03], [-1.2, y0 + 0.3, -d / 2 - 0.03], [1.2, y0 + 0.3, -d / 2 - 0.03], DARK, SURF.dark, param);
  }
}

/** Half-sunken burrow dwelling with a turf roof, built into the bank. */
export function buildBurrow(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts) {
  const rng = new Rng(b.seed);
  const { lo } = footprintGround(b, ground);
  mb.frame(b.a, 0, b.c, b.rot);
  const rx = b.w / 2;
  const rz = b.d / 2;
  const hgt = rng.range(2.6, 3.2);
  const stone = rng.pick(STONE);
  const param = (b.seed % 991) / 991;
  // stone ring footing
  mb.cylinder(0, 0, lo - 0.5, lo + 0.55, Math.max(rx, rz) + 0.25, Math.max(rx, rz) + 0.15, o.detail ? 18 : 8, stone, SURF.stone, param, false);
  // turf mound (ellipsoid, lower half buried)
  mb.ellipsoid(0, lo + 0.3, 0, rx + 0.1, hgt, rz + 0.1, o.detail ? 16 : 8, TURF, SURF.turf, param);
  if (!o.detail) return;
  const paint = rng.pick(PAINT);
  // round door with a carved painted frame in a stone porch
  const zf = -rz - 0.35;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * (i / 10);
    pts.push([Math.cos(a) * 1.0, lo + 1.05 + Math.sin(a) * 1.0]);
  }
  pts.push([-1.0, lo + 0.1], [1.0, lo + 0.1]);
  // stone porch walls
  mb.box(-1.6, lo, zf - 0.2, -1.05, lo + 1.9, zf + 1.6, stone, SURF.stone, SURF.stone, param);
  mb.box(1.05, lo, zf - 0.2, 1.6, lo + 1.9, zf + 1.6, stone, SURF.stone, SURF.stone, param);
  mb.box(-1.7, lo + 1.9, zf - 0.3, 1.7, lo + 2.25, zf + 1.6, TURF, SURF.turf, SURF.turf, param);
  // dark round doorway
  const arch: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI * (i / 12);
    arch.push([Math.cos(a) * 0.72, lo + 0.95 + Math.sin(a) * 0.72]);
  }
  arch.push([-0.72, lo + 0.05], [0.72, lo + 0.05]);
  mb.extrudePolygon(arch, zf + 0.9, zf + 0.95, DARK, SURF.dark, SURF.dark, param);
  // painted frame ring
  for (let i = 0; i < 12; i++) {
    const a0 = Math.PI * (i / 12);
    const a1 = Math.PI * ((i + 1) / 12);
    const r0 = 0.72;
    const r1 = 0.95;
    const yc = lo + 0.95;
    mb.quad(
      [Math.cos(a0) * r0, yc + Math.sin(a0) * r0, zf + 0.85],
      [Math.cos(a1) * r0, yc + Math.sin(a1) * r0, zf + 0.85],
      [Math.cos(a1) * r1, yc + Math.sin(a1) * r1, zf + 0.85],
      [Math.cos(a0) * r1, yc + Math.sin(a0) * r1, zf + 0.85],
      paint,
      SURF.wood,
      param + 0.5,
    );
  }
  // small windows either side, facing out of the mound
  for (const sx of [-1, 1]) {
    const ang = sx * 0.95;
    const rr = Math.hypot(Math.sin(ang) * rx, Math.cos(ang) * rz) + 0.02;
    mb.frame(b.a, 0, b.c, b.rot + ang);
    windowOpen(mb, 0, lo + 1.0, -rr * 0.93, paint, param, 0.6, 0.55);
  }
  mb.frame(b.a, 0, b.c, b.rot);
  // mosaic threshold path
  mb.quad([-0.7, lo + 0.06, zf - 1.4], [0.7, lo + 0.06, zf - 1.4], [0.7, lo + 0.06, zf + 0.5], [-0.7, lo + 0.06, zf + 0.5], lin('#c8b898'), SURF.mosaic, param);
}

/** Watch house / tower with a pyramid roof and a lookout balcony. */
export function buildTower(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts, height: number, dome: boolean) {
  const rng = new Rng(b.seed + 7);
  const { lo, hi } = footprintGround(b, ground);
  mb.frame(b.a, 0, b.c, b.rot);
  const s = Math.min(b.w, b.d, 7) / 2;
  const stone = rng.pick(STONE);
  const plaster = rng.pick(PLASTER);
  const param = (b.seed % 983) / 983;
  const y0 = hi + 0.2;
  mb.box(-s, lo - 0.6, -s, s, y0 + height * 0.55, s, stone, SURF.stone, SURF.stone, param);
  mb.box(-s + 0.2, y0 + height * 0.55, -s + 0.2, s - 0.2, y0 + height, s - 0.2, plaster, SURF.halftimber, SURF.halftimber, param);
  // balcony
  mb.box(-s - 0.6, y0 + height - 0.1, -s - 0.6, s + 0.6, y0 + height + 0.15, s + 0.6, TIMBER[0], SURF.timber, SURF.timber, param);
  if (dome) {
    mb.cylinder(0, 0, y0 + height + 0.15, y0 + height + 2.2, s * 0.85, s * 0.85, 16, plaster, SURF.plaster, param, false);
    mb.dome(0, y0 + height + 2.2, 0, s * 0.85, 1.25, 16, 6, GOLD, SURF.gold, param);
    mb.cylinder(0, 0, y0 + height + 2.2 + s * 1.05, y0 + height + 3.6 + s, 0.12, 0.02, 6, GOLD, SURF.gold, param);
  } else {
    hipRoof(mb, -s, s, -s, s, y0 + height + 1.6, 0.95, 0.5, rng.pick(TILE), SURF.tile, param);
    for (const [x, z] of [
      [-s - 0.5, -s - 0.5],
      [s + 0.5, -s - 0.5],
      [s + 0.5, s + 0.5],
      [-s - 0.5, s + 0.5],
    ])
      mb.box(x - 0.1, y0 + height + 0.15, z - 0.1, x + 0.1, y0 + height + 1.65, z + 0.1, TIMBER[1], SURF.timber, SURF.timber, param);
  }
  if (o.detail) {
    const paint = rng.pick(PAINT);
    door(mb, 0, y0, -s, paint, param, 1.5, 1.7, true);
    for (let f = 1; f < Math.floor(height / FLOOR_H); f++) windowOpen(mb, 0, y0 + f * FLOOR_H + 0.7, -s + (y0 + f * FLOOR_H > y0 + height * 0.55 ? 0.2 : 0), paint, param, 0.7, 0.9);
  }
}

/** Grand civic hall with a portico and a gilded dome, or a singing hall. */
export function buildCivic(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts) {
  const rng = new Rng(b.seed + 3);
  const { lo, hi } = footprintGround(b, ground);
  mb.frame(b.a, 0, b.c, b.rot);
  const w = b.w;
  const d = b.d;
  const stone = lin('#c8b898');
  const plaster = rng.pick(PLASTER);
  const param = (b.seed % 977) / 977;
  const y0 = hi + 0.6;
  const H = b.floors * FLOOR_H + 1.5;
  // podium with steps
  mb.box(-w / 2 - 2, lo - 0.6, -d / 2 - 3.5, w / 2 + 2, y0, d / 2 + 1, stone, SURF.stone, SURF.stone, param);
  for (let i = 0; i < 3; i++) mb.box(-w / 2 + 1, lo - 0.3, -d / 2 - 3.5 - (i + 1) * 0.45, w / 2 - 1, y0 - (i + 1) * 0.2, -d / 2 - 3.5 - i * 0.45, stone, SURF.stone, SURF.stone, param);
  mb.box(-w / 2, y0, -d / 2, w / 2, y0 + H * 0.45, d / 2, stone, SURF.stone, SURF.stone, param);
  mb.box(-w / 2, y0 + H * 0.45, -d / 2, w / 2, y0 + H, d / 2, plaster, SURF.plaster, SURF.plaster, param);
  // murals along the upper walls
  if (o.detail) {
    mb.quad([w / 2 - 1, y0 + H * 0.5, -d / 2 - 0.03], [-w / 2 + 1, y0 + H * 0.5, -d / 2 - 0.03], [-w / 2 + 1, y0 + H - 0.5, -d / 2 - 0.03], [w / 2 - 1, y0 + H - 0.5, -d / 2 - 0.03], lin('#ffffff'), SURF.mural, rng.next());
    for (const sx of [-1, 1]) {
      const x = sx * (w / 2 + 0.03);
      if (sx > 0) mb.quad([x, y0 + H * 0.5, d / 2 - 1], [x, y0 + H * 0.5, -d / 2 + 1], [x, y0 + H - 0.5, -d / 2 + 1], [x, y0 + H - 0.5, d / 2 - 1], lin('#ffffff'), SURF.mural, rng.next());
      else mb.quad([x, y0 + H * 0.5, -d / 2 + 1], [x, y0 + H * 0.5, d / 2 - 1], [x, y0 + H - 0.5, d / 2 - 1], [x, y0 + H - 0.5, -d / 2 + 1], lin('#ffffff'), SURF.mural, rng.next());
    }
  }
  // cornice
  mb.box(-w / 2 - 0.4, y0 + H, -d / 2 - 0.4, w / 2 + 0.4, y0 + H + 0.45, d / 2 + 0.4, stone, SURF.stone, SURF.stone, param);
  // portico: columns and a pediment
  const nCol = Math.max(4, Math.floor(w / 3.2));
  for (let i = 0; i < nCol; i++) {
    const x = -w / 2 + 1 + ((w - 2) * i) / (nCol - 1);
    mb.cylinder(x, -d / 2 - 2.6, y0, y0 + H * 0.62, 0.42, 0.36, o.detail ? 10 : 5, stone, SURF.stone, param);
  }
  mb.box(-w / 2 + 0.3, y0 + H * 0.62, -d / 2 - 3.2, w / 2 - 0.3, y0 + H * 0.62 + 0.6, -d / 2, stone, SURF.stone, SURF.stone, param);
  gableRoof(mb, -w / 2 + 0.3, w / 2 - 0.3, -d / 2 - 3.2, -d / 2, y0 + H * 0.62 + 0.6, 0.35, 0.2, 0.1, lin('#b85a3a'), SURF.tile, param, 0.15, stone, SURF.mosaic);
  if (b.roof === 'dome') {
    const r = Math.min(w, d) * 0.32;
    mb.cylinder(0, 0, y0 + H + 0.45, y0 + H + 3.2, r, r, 20, plaster, SURF.plaster, param, false);
    mb.dome(0, y0 + H + 3.2, 0, r, 1.1, 20, 8, GOLD, SURF.gold, param);
    mb.cylinder(0, 0, y0 + H + 3.2 + r * 1.05, y0 + H + 5.5 + r * 1.1, 0.25, 0.04, 8, GOLD, SURF.gold, param);
    hipRoof(mb, -w / 2, w / 2, -d / 2, d / 2, y0 + H + 0.45, 0.3, 0.3, lin('#a84a32'), SURF.tile, param);
  } else {
    gableRoof(mb, -w / 2, w / 2, -d / 2, d / 2, y0 + H + 0.45, 0.6, 1.0, 0.5, lin('#b85a3a'), SURF.tile, param, 0.15, plaster, SURF.plaster, rng.pick(PAINT));
  }
  if (o.detail) {
    door(mb, 0, y0, -d / 2, rng.pick(PAINT), param, 2.4, 2.6, true);
    // hanging banners (singing hall / civic)
    for (const sx of [-1, 1]) {
      const x = sx * w * 0.3;
      mb.quad([x + 0.7, y0 + H * 0.2, -d / 2 - 0.08], [x - 0.7, y0 + H * 0.2, -d / 2 - 0.08], [x - 0.7, y0 + H * 0.95, -d / 2 - 0.08], [x + 0.7, y0 + H * 0.95, -d / 2 - 0.08], rng.pick(PAINT), SURF.flags, rng.next());
    }
  }
  if (b.tower) {
    const lx = w / 2 - 3.5;
    const lz = d / 2 - 3.5;
    const cr = Math.cos(b.rot);
    const sr = Math.sin(b.rot);
    buildTower(mb, { ...b, a: b.a + lx * cr - lz * sr, c: b.c + lx * sr + lz * cr, w: 6.5, d: 6.5 }, () => lo, o, H + 7, true);
  }
  mb.frame(b.a, 0, b.c, b.rot);
}

/** University: three wings around a courtyard. */
export function buildUniversity(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts) {
  const wing = 7;
  const parts: Building[] = [
    { ...b, a: 0, c: b.d / 2 - wing / 2, w: b.w, d: wing, rot: 0 },
    { ...b, a: -b.w / 2 + wing / 2, c: 0, w: wing, d: b.d - wing, rot: 0, mural: false },
    { ...b, a: b.w / 2 - wing / 2, c: 0, w: wing, d: b.d - wing, rot: 0, mural: false },
  ];
  const c = Math.cos(b.rot);
  const s = Math.sin(b.rot);
  for (const p of parts) {
    const pa = b.a + p.a * c - p.c * s;
    const pc = b.c + p.a * s + p.c * c;
    buildHouse(mb, { ...p, a: pa, c: pc, rot: b.rot, kind: 'house', roof: 'slate', floors: 3, seed: b.seed + 11 }, ground, o);
  }
}

/** Water mill: a house with a big wheel on the canal side. */
export function buildMill(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts) {
  buildHouse(mb, { ...b, kind: 'house', floors: 2 }, ground, o);
  const { lo } = footprintGround(b, ground);
  mb.frame(b.a, 0, b.c, b.rot);
  // wheel toward the canal (front, -z)
  const r = 2.4;
  const yc = lo + 0.8;
  const zc = -b.d / 2 - 0.9;
  const n = o.detail ? 12 : 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x0 = Math.cos(a) * r;
    const y0 = Math.sin(a) * r;
    mb.box(x0 - 0.12 + b.w * 0.25, yc + y0 - 0.12, zc - 0.5, x0 + 0.12 + b.w * 0.25, yc + y0 + 0.12, zc + 0.5, WOOD, SURF.wood, SURF.wood, 0.3);
  }
  mb.cylinder(b.w * 0.25, zc, yc - 0.3, yc + 0.3, 0.3, 0.3, 8, TIMBER[0], SURF.timber, 0.3);
}

/** Boathouse: an open-fronted shed over the water. */
export function buildBoathouse(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts, waterLevel: number) {
  const rng = new Rng(b.seed);
  const { hi } = footprintGround(b, ground);
  mb.frame(b.a, 0, b.c, b.rot);
  const w = b.w;
  const d = b.d;
  const y0 = Math.max(hi, waterLevel + 0.9);
  const timber = rng.pick(TIMBER);
  // posts down into the water
  for (const [x, z] of [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
    [-w / 2, 0],
    [w / 2, 0],
  ])
    mb.box(x - 0.15, waterLevel - 2.5, z - 0.15, x + 0.15, y0 + 2.4, z + 0.15, timber, SURF.timber, SURF.timber, 0.2);
  // side walkways
  mb.box(-w / 2 - 0.2, y0 - 0.15, -d / 2, -w / 2 + 1.1, y0, d / 2, WOOD, SURF.wood, SURF.wood, 0.2);
  mb.box(w / 2 - 1.1, y0 - 0.15, -d / 2, w / 2 + 0.2, y0, d / 2, WOOD, SURF.wood, SURF.wood, 0.2);
  // back wall
  mb.box(-w / 2, y0, d / 2 - 0.2, w / 2, y0 + 2.4, d / 2, rng.pick(PLASTER), SURF.halftimber, SURF.halftimber, 0.2);
  gableRoof(mb, -w / 2, w / 2, -d / 2, d / 2, y0 + 2.4, 0.75, 0.6, 0.3, roofColor(b.roof, rng), roofSurf(b.roof), 0.2, b.roof === 'thatch' ? 0.35 : 0.12, rng.pick(PLASTER), SURF.plaster);
  if (o.detail) buildBoat(mb, 0, -0.5, waterLevel, w * 0.45, d * 0.75, 0, rng.next());
}

/** Small rowing boat / skiff. */
export function buildBoat(mb: MeshBuilder, x: number, z: number, water: number, w: number, len: number, rot: number, seed: number) {
  const rng = new Rng(Math.floor(seed * 1e9));
  const paint = rng.pick(PAINT);
  const hw = w / 2;
  const hl = len / 2;
  const y = water - 0.15;
  // hull: two slanted sides + bottom + pointed bow
  const p = (px: number, py: number, pz: number): V3 => {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    return [x + px * c - pz * s, py, z + px * s + pz * c];
  };
  mb.quad(p(-hw, y + 0.55, -hl * 0.7), p(-hw * 0.6, y, -hl * 0.6), p(-hw * 0.6, y, hl * 0.8), p(-hw, y + 0.55, hl * 0.8), paint, SURF.wood, seed);
  mb.quad(p(hw * 0.6, y, -hl * 0.6), p(hw, y + 0.55, -hl * 0.7), p(hw, y + 0.55, hl * 0.8), p(hw * 0.6, y, hl * 0.8), paint, SURF.wood, seed);
  mb.quad(p(-hw, y + 0.55, hl * 0.8), p(-hw * 0.6, y, hl * 0.8), p(0, y + 0.1, hl), p(0, y + 0.6, hl), paint, SURF.wood, seed);
  mb.quad(p(hw * 0.6, y, hl * 0.8), p(hw, y + 0.55, hl * 0.8), p(0, y + 0.6, hl), p(0, y + 0.1, hl), paint, SURF.wood, seed);
  mb.quad(p(-hw * 0.6, y, -hl * 0.6), p(-hw, y + 0.55, -hl * 0.7), p(hw, y + 0.55, -hl * 0.7), p(hw * 0.6, y, -hl * 0.6), paint, SURF.wood, seed);
  mb.quad(p(hw * 0.9, y + 0.2, -hl * 0.6), p(-hw * 0.9, y + 0.2, -hl * 0.6), p(-hw * 0.9, y + 0.2, hl * 0.75), p(hw * 0.9, y + 0.2, hl * 0.75), WOOD, SURF.wood, seed);
}

export { STONE, PLASTER, TIMBER, PAINT, GOLD, WOOD, DARK, TURF };
