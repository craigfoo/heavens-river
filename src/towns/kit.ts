// Modular Quinlan building kit (spec 7.1). Quinlan scale: doors ~1.5 m tall and
// wide, floor-to-ceiling ~2.2 m, low eaves. Lower floors in fitted river stone,
// upper floors half-timbered with plaster infill, deep roof overhangs, painted
// shutters, carved door frames, patterned ridges and lots of decoration.

import { Rng } from '../core/rng';
import type { Building } from './layout';
import { lin, MeshBuilder, SURF, wallAge, type V3 } from './meshBuilder';

export const FLOOR_H = 2.5;

const STONE = ['#a08e76', '#ab9a7c', '#8f8170', '#b3a384', '#9c8b7e'].map(lin);
const PLASTER = ['#ecdcbc', '#e4bc7c', '#dc9e7c', '#bccccc', '#cccc9c', '#f2e4cc', '#dcac64', '#e8c8a8'].map(lin);
const TIMBER = ['#4c3626', '#5c402a', '#40301e'].map(lin);
const THATCH = ['#b89858', '#a88848', '#c4a868'].map(lin);
// clay tiles: fresh terracotta to old, browned and faded
const TILE = ['#b0583a', '#9c4e36', '#b86e4c', '#8e5842', '#a2644a', '#824c3a'].map(lin);
const SHINGLE = ['#6c5c4a', '#7c6652', '#5e5040'].map(lin);
const SLATE = ['#4c525c', '#5a626c'].map(lin);
const PAINT = ['#2a5a8c', '#2c6c4c', '#aa3c2c', '#dcaa34', '#3c8c8c', '#7c3c7c', '#cc6a2c'].map(lin);
const TURF = lin('#5c7c34');
// dressed sandstone and limestone; greyer fitted fieldstone; limewash on daub
const ASHLAR = ['#cdbd9d', '#d6c8a8', '#c4b08e', '#c8bca4'].map(lin);
const FIELDSTONE = ['#9a8c78', '#8c8274', '#a39580', '#8a7c6a'].map(lin);
const LIMEWASH = ['#efe6d2', '#e8d9b8', '#e2c99a', '#dcc0a0', '#e8e0cc'].map(lin);
const IRON = lin('#2a2624');
const COPPER = lin('#b86a3c');
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

/** Where the front door sits along a building's frontage (local x), fixed by its seed. */
export function frontDoorX(b: Pick<Building, 'kind' | 'w' | 'seed'>): number {
  if (b.kind === 'warehouse') return b.w / 2 - 2.2;
  const h = (Math.imul(b.seed | 0, 2654435761) >>> 0) / 4294967296;
  return (h * 2 - 1) * Math.max(0, b.w / 2 - 1.3) * 0.6;
}

/** Paint fades and greys with age (spec 5, patina). */
function fade(c: V3, age: number): V3 {
  const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  const k = age * 0.4;
  return [c[0] + (l * 1.15 + 0.05 - c[0]) * k, c[1] + (l * 1.15 + 0.05 - c[1]) * k, c[2] + (l * 1.15 + 0.05 - c[2]) * k];
}

/** A flat polygon on the face z (facing -z); outline counter-clockwise in (x, y), fanned from (cx, cy). */
export function fanFace(mb: MeshBuilder, outline: [number, number][], cx: number, cy: number, z: number, rgb: V3, surf: number, param: number) {
  const c: V3 = [cx, cy, z];
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % outline.length];
    mb.tri(c, [q[0], q[1], z], [p[0], p[1], z], rgb, surf, param);
  }
}

/** Outline of a round-headed opening, counter-clockwise from its bottom right. */
export function archOutline(x: number, y: number, w: number, h: number, seg: number): [number, number][] {
  const r = w / 2;
  const spring = y + h - r;
  const out: [number, number][] = [
    [x + r, y],
    [x + r, spring],
  ];
  for (let i = 1; i < seg; i++) {
    const t = (i / seg) * Math.PI;
    out.push([x + Math.cos(t) * r, spring + Math.sin(t) * r]);
  }
  out.push([x - r, spring], [x - r, y]);
  return out;
}

/**
 * Round-headed doorway on the face z = zf (facing -z): spec 2 makes a
 * standard door 1.1 m wide and 1.5 m tall. Decoration (spec 6): a painted
 * band on plain houses, a carved frame from 0.4, a gilded crest and figures
 * from 0.75; a worn stone threshold, or mosaic from 0.5.
 */
function door(mb: MeshBuilder, x: number, y: number, zf: number, paint: V3, param: number, deco: number, w = 1.1, h = 1.5, seg = 8) {
  const r = w / 2;
  const spring = y + h - r;
  fanFace(mb, archOutline(x, y, w, h, seg), x, y + h * 0.45, zf - 0.005, DARK, SURF.dark, param);
  // the leaf stands ajar inside
  mb.quad([x + r - 0.05, y, zf + 0.02], [x + 0.05, y, zf + 0.45], [x + 0.05, spring + 0.1, zf + 0.45], [x + r - 0.05, spring + 0.1, zf + 0.02], paint, SURF.wood, param);
  // frame: posts and a band round the arch, carved on richer houses
  const fw = 0.16 + 0.1 * deco;
  const fp = deco >= 0.4 ? 1.5 : 0.2;
  mb.box(x - r - fw, y, zf - 0.1, x - r, spring, zf + 0.02, paint, SURF.wood, SURF.wood, fp);
  mb.box(x + r, y, zf - 0.1, x + r + fw, spring, zf + 0.02, paint, SURF.wood, SURF.wood, fp);
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI;
    const t1 = ((i + 1) / seg) * Math.PI;
    const p = (t: number, rr: number): V3 => [x + Math.cos(t) * rr, spring + Math.sin(t) * rr, zf - 0.1];
    mb.quad(p(t0, r), p(t1, r), p(t1, r + fw), p(t0, r + fw), paint, SURF.wood, fp);
  }
  // latch at 0.75 m: iron, or gilded on the richest doors
  mb.box(x - r + 0.08, y + 0.7, zf - 0.14, x - r + 0.16, y + 0.8, zf - 0.1, deco > 0.75 ? GOLD : IRON, deco > 0.75 ? SURF.gold : SURF.dark, SURF.dark, param);
  if (deco > 0.75) {
    // gilded crest over the arch and figures to either side
    const top = spring + r + fw;
    mb.tri([x + 0.45, top, zf - 0.11], [x - 0.45, top, zf - 0.11], [x, top + 0.5, zf - 0.11], GOLD, SURF.gold, param);
    if (deco > 0.85)
      for (const sx of [-1, 1]) mb.ellipsoid(x + sx * (r + fw + 0.25), spring + 0.1, zf - 0.12, 0.13, 0.26, 0.08, 8, GOLD, SURF.gold, param);
  }
  // threshold: worn stone or mosaic
  const tw = w / 2 + 0.3;
  if (deco >= 0.5) mb.quad([x + tw, y + 0.02, zf - 1.0], [x - tw, y + 0.02, zf - 1.0], [x - tw, y + 0.02, zf], [x + tw, y + 0.02, zf], lin('#c8b898'), SURF.mosaic, param);
  else mb.quad([x + tw, y + 0.015, zf - 0.8], [x - tw, y + 0.015, zf - 0.8], [x - tw, y + 0.015, zf], [x + tw, y + 0.015, zf], lin('#8a8070'), SURF.stone, 0.3);
}

/** How a house's windows look: one style per house. */
interface WinStyle {
  /** Opening width (spec 2: 1.2 to 2.0 m, 0.6 m tall). */
  ww: number;
  gap: number;
  /** 'top': a board hinged at the lintel, propped out; 'side': leaves folded back. */
  shutter: 'top' | 'side';
  fill: number;
  paint: V3;
  /** Shutter surface parameter: painted pattern and carving on richer houses. */
  sp: number;
}

function winStyle(b: Building, rng: Rng, paint: V3): WinStyle {
  // openings (spec 4): shutters and woven screens in villages, carved
  // lattices in towns, oiled-skin or mica panes on rich city houses
  const fill = b.base === 'ashlar' && b.deco > 0.8 ? SURF.mica : b.upper !== 'daub' && b.deco > 0.55 && rng.chance(0.6) ? SURF.lattice : SURF.dark;
  return { ww: rng.range(1.2, 2.0), gap: rng.range(0.55, 0.9), shutter: rng.chance(0.5) ? 'top' : 'side', fill, paint, sp: b.deco > 0.55 ? 1.5 : 0.2 };
}

/** A wide, low window opening on the face z = zf (facing -z), its sill at y. */
function windowOpen(mb: MeshBuilder, x: number, y: number, zf: number, st: WinStyle, param: number, w = st.ww, h = 0.6) {
  const fillRgb = st.fill === SURF.lattice ? WOOD : st.fill === SURF.mica ? lin('#b08040') : DARK;
  mb.quad([x + w / 2, y, zf - 0.01], [x - w / 2, y, zf - 0.01], [x - w / 2, y + h, zf - 0.01], [x + w / 2, y + h, zf - 0.01], fillRgb, st.fill, param);
  mb.box(x - w / 2 - 0.1, y - 0.1, zf - 0.14, x + w / 2 + 0.1, y, zf + 0.01, lin('#d8c8a8'), SURF.stone, SURF.stone, 0.4);
  mb.box(x - w / 2 - 0.14, y + h, zf - 0.08, x + w / 2 + 0.14, y + h + 0.14, zf + 0.01, TIMBER[0], SURF.timber, SURF.timber, param);
  if (st.shutter === 'side') {
    // two leaves folded back against the wall
    for (const sx of [-1, 1]) {
      const xa = x + sx * (w / 2 + 0.04);
      const xb = x + sx * (w + 0.04);
      const [xl, xr] = sx < 0 ? [xb, xa] : [xa, xb];
      mb.quad([xr, y, zf - 0.03], [xl, y, zf - 0.03], [xl, y + h, zf - 0.03], [xr, y + h, zf - 0.03], st.paint, SURF.wood, st.sp);
    }
  } else {
    // one board hinged at the lintel and propped out as a sun shade (both faces)
    const len = h + 0.12;
    const yb = y + h - Math.cos(0.75) * len;
    const zb = zf - 0.02 - Math.sin(0.75) * len;
    mb.quad([x + w / 2, yb, zb], [x - w / 2, yb, zb], [x - w / 2, y + h, zf - 0.02], [x + w / 2, y + h, zf - 0.02], st.paint, SURF.wood, st.sp);
    mb.quad([x - w / 2, yb, zb], [x + w / 2, yb, zb], [x + w / 2, y + h, zf - 0.02], [x - w / 2, y + h, zf - 0.02], st.paint, SURF.wood, st.sp);
  }
}

/** A band of windows across a face of width w (horizontal emphasis, spec 5), sills at y. */
function windowBand(mb: MeshBuilder, w: number, y: number, zf: number, st: WinStyle, param: number, keepClear: [number, number][] = []) {
  const n = Math.max(1, Math.floor((w - 0.8 + st.gap) / (st.ww + st.gap)));
  const ww = Math.min(st.ww, w - 0.8);
  const total = n * ww + (n - 1) * st.gap;
  for (let i = 0; i < n; i++) {
    const x = -total / 2 + ww / 2 + i * (ww + st.gap);
    if (keepClear.some(([x0, x1]) => x + ww / 2 + (st.shutter === 'side' ? ww / 2 : 0) > x0 && x - ww / 2 - (st.shutter === 'side' ? ww / 2 : 0) < x1)) continue;
    windowOpen(mb, x, y, zf, st, param, ww);
  }
}

/**
 * The wet threshold as seen from outside (spec 3): at the water-side door a
 * stone apron falls to a drain, with puddles, a woven mat, gear hung on pegs
 * and a lean-to roof over it all.
 */
function dripPorch(mb: MeshBuilder, x: number, y0: number, zf: number, rng: Rng, paint: V3, roofRgb: V3, roofSurf: number, param: number) {
  const hw = 1.35;
  const dz = 1.9;
  const wetStone = lin('#6d655a');
  const z0 = zf - dz;
  // two halves falling gently towards the drain down the middle
  mb.quad([x + hw, y0 - 0.02, z0], [x + 0.09, y0 - 0.06, z0], [x + 0.09, y0 - 0.04, zf], [x + hw, y0, zf], wetStone, SURF.stone, 0.3);
  mb.quad([x - 0.09, y0 - 0.06, z0], [x - hw, y0 - 0.02, z0], [x - hw, y0, zf], [x - 0.09, y0 - 0.04, zf], wetStone, SURF.stone, 0.3);
  mb.quad([x + 0.09, y0 - 0.1, z0], [x - 0.09, y0 - 0.1, z0], [x - 0.09, y0 - 0.08, zf], [x + 0.09, y0 - 0.08, zf], DARK, SURF.dark, param);
  // puddles and a woven mat by the door
  for (let k = 0; k < 2; k++) {
    const px = x + rng.range(-1.0, 1.0);
    const pz = zf - rng.range(0.9, 1.6);
    mb.quad([px + 0.25, y0 - 0.01, pz - 0.17], [px - 0.25, y0 - 0.01, pz - 0.17], [px - 0.25, y0 - 0.01, pz + 0.17], [px + 0.25, y0 - 0.01, pz + 0.17], lin('#4a5a58'), SURF.water, 0.2);
  }
  mb.quad([x + 0.5, y0 + 0.01, zf - 0.8], [x - 0.5, y0 + 0.01, zf - 0.8], [x - 0.5, y0 + 0.01, zf - 0.2], [x + 0.5, y0 + 0.01, zf - 0.2], rng.pick(PAINT), SURF.cloth, rng.next());
  // pegs with gear: a net, a paddle, a basket
  const side = rng.sign();
  const rx0 = x + side * 0.95;
  const rx1 = x + side * 2.2;
  mb.box(Math.min(rx0, rx1), y0 + 1.15, zf - 0.08, Math.max(rx0, rx1), y0 + 1.25, zf, TIMBER[1], SURF.timber, SURF.timber, param);
  const at = (f: number) => rx0 + (rx1 - rx0) * f;
  mb.quad([at(0.15) + 0.3, y0 + 0.45, zf - 0.1], [at(0.15) - 0.3, y0 + 0.45, zf - 0.1], [at(0.15) - 0.22, y0 + 1.15, zf - 0.1], [at(0.15) + 0.22, y0 + 1.15, zf - 0.1], lin('#3c3a30'), SURF.cloth, 0.9);
  mb.box(at(0.55) - 0.05, y0 + 0.2, zf - 0.14, at(0.55) + 0.05, y0 + 1.2, zf - 0.09, WOOD, SURF.wood, SURF.wood, param);
  mb.box(at(0.55) - 0.12, y0 + 0.2, zf - 0.15, at(0.55) + 0.12, y0 + 0.55, zf - 0.08, WOOD, SURF.wood, SURF.wood, param);
  mb.cylinder(at(0.88), zf - 0.3, y0, y0 + 0.4, 0.2, 0.24, 7, lin('#a88850'), SURF.thatch, 0.3);
  // lean-to roof on two posts
  for (const sx of [-1, 1]) mb.box(x + sx * hw - 0.07, y0, z0 + 0.1, x + sx * hw + 0.07, y0 + 1.95, z0 + 0.24, TIMBER[0], SURF.timber, SURF.timber, param);
  const xr = x + hw + 0.25;
  const xl = x - hw - 0.25;
  mb.quad([xr, y0 + 1.95, z0 - 0.2], [xl, y0 + 1.95, z0 - 0.2], [xl, y0 + 2.35, zf + 0.05], [xr, y0 + 2.35, zf + 0.05], roofRgb, roofSurf, param);
  mb.quad([xl, y0 + 1.92, z0 - 0.2], [xr, y0 + 1.92, z0 - 0.2], [xr, y0 + 2.32, zf + 0.05], [xl, y0 + 2.32, zf + 0.05], lin('#3a2c20'), SURF.wood, param);
}

/** Ceramic creatures along a ridge running along x from x0 to x1 at height y (spec 6, rich roofs). */
function ridgeCreatures(mb: MeshBuilder, x0: number, x1: number, y: number, rng: Rng, gilded: boolean) {
  const n = Math.max(1, Math.floor((x1 - x0) / 2.4));
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
    const rgb = gilded ? GOLD : rng.pick(PAINT);
    const surf = gilded ? SURF.gold : SURF.plain;
    mb.ellipsoid(x, y + 0.2, 0, 0.3, 0.13, 0.1, 7, rgb, surf, 0.5);
    mb.tri([x + 0.26, y + 0.2, 0], [x + 0.5, y + 0.38, 0], [x + 0.5, y + 0.04, 0], rgb, surf, 0.5);
    mb.tri([x + 0.26, y + 0.2, 0], [x + 0.5, y + 0.04, 0], [x + 0.5, y + 0.38, 0], rgb, surf, 0.5);
  }
}

/** A railed lookout platform standing on the roof ridge (spec 5). */
function lookoutDeck(mb: MeshBuilder, yR: number, param: number) {
  const s = 1.1;
  const y = yR + 0.45;
  for (const [px, pz] of [
    [-s, -s],
    [s, -s],
    [s, s],
    [-s, s],
  ])
    mb.box(px - 0.07, yR - 1.2, pz - 0.07, px + 0.07, y + 0.7, pz + 0.07, TIMBER[0], SURF.timber, SURF.timber, param);
  mb.box(-s - 0.15, y - 0.1, -s - 0.15, s + 0.15, y, s + 0.15, WOOD, SURF.wood, SURF.wood, param);
  for (const [a0, b0, a1, b1] of [
    [-s, -s, s, -s + 0.06],
    [-s, s - 0.06, s, s],
    [-s, -s, -s + 0.06, s],
    [s - 0.06, -s, s, s],
  ])
    mb.box(a0, y + 0.62, b0, a1, y + 0.7, b1, TIMBER[0], SURF.timber, SURF.timber, param);
}

export interface BuildOpts {
  detail: boolean;
  /** Water level, for water doors and moss lines. */
  water?: number;
}

/** Plinth, walls and roof materials of a building (spec 4). */
function materials(b: Building, rng: Rng) {
  const baseSurf = b.base === 'ashlar' ? SURF.ashlar : b.base === 'fieldstone' ? SURF.fieldstone : SURF.stone;
  const baseRgb = b.base === 'ashlar' ? rng.pick(ASHLAR) : b.base === 'fieldstone' ? rng.pick(FIELDSTONE) : rng.pick(STONE);
  const upperSurf = b.upper === 'stone' ? SURF.ashlar : b.upper === 'daub' ? SURF.plaster : SURF.halftimber;
  const upperRgb: V3 = b.upper === 'stone' ? [baseRgb[0] * 1.08, baseRgb[1] * 1.08, baseRgb[2] * 1.08] : b.upper === 'daub' ? rng.pick(LIMEWASH) : rng.pick(PLASTER);
  return { baseSurf, baseRgb, upperSurf, upperRgb, age: wallAge(b.age) };
}

/**
 * Houses, cottages, townhouses, shops, taverns, workshops and warehouses:
 * a stone plinth and ground floor (or a footing under daub), jettied upper
 * floors, deep eaves, a round-headed front door and a back door (two exits),
 * horizontal bands of shuttered windows, and whatever the kind adds.
 */
export function buildHouse(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts) {
  const rng = new Rng(b.seed);
  const { lo, hi } = footprintGround(b, ground);
  const y0 = hi + 0.18; // floor level
  const w = b.w;
  const d = b.d;
  mb.frame(b.a, 0, b.c, b.rot);
  const m = materials(b, rng);
  const timber = rng.pick(TIMBER);
  const paint = fade(rng.pick(PAINT), b.age);
  const roofRgb = roofColor(b.roof, rng);
  const param = (b.seed % 997) / 997;
  const warehouse = b.kind === 'warehouse';
  const gableFront = b.kind === 'townhouse' || b.kind === 'shop';
  const lowerH = FLOOR_H + (warehouse ? 0.9 : 0);
  // plinth, then a stone ground floor, or a stone footing under wattle and daub
  mb.box(-w / 2 - 0.12, lo - 0.6, -d / 2 - 0.12, w / 2 + 0.12, y0, d / 2 + 0.12, m.baseRgb, m.baseSurf, m.baseSurf, m.age);
  if (b.upper === 'daub') {
    mb.box(-w / 2, y0, -d / 2, w / 2, y0 + 0.7, d / 2, m.baseRgb, m.baseSurf, m.baseSurf, m.age);
    mb.box(-w / 2, y0 + 0.7, -d / 2, w / 2, y0 + lowerH, d / 2, m.upperRgb, m.upperSurf, m.upperSurf, m.age);
  } else mb.box(-w / 2, y0, -d / 2, w / 2, y0 + lowerH, d / 2, m.baseRgb, m.baseSurf, m.baseSurf, m.age);
  let top = y0 + lowerH;
  // upper storeys, jettied out over the lane
  const upper = b.floors - 1;
  const jet = upper > 0 ? 0.35 : 0;
  if (upper > 0) {
    mb.box(-w / 2 - jet - 0.05, top - 0.05, -d / 2 - jet - 0.05, w / 2 + jet + 0.05, top + 0.22, d / 2 + jet + 0.05, timber, SURF.timber, SURF.timber, param);
    mb.box(-w / 2 - jet, top + 0.22, -d / 2 - jet, w / 2 + jet, top + 0.22 + upper * FLOOR_H, d / 2 + jet, m.upperRgb, m.upperSurf, m.upperSurf, m.age);
    top += 0.22 + upper * FLOOR_H;
  }
  // mural on a side wall (warehouses and rich walls get bold paintings)
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
      if (warehouse) mb.quad([w / 2 - 1, my0 + 1.6, -d / 2 - 0.03], [-w / 2 + 1, my0 + 1.6, -d / 2 - 0.03], [-w / 2 + 1, my1, -d / 2 - 0.03], [w / 2 - 1, my1, -d / 2 - 0.03], lin('#ffffff'), SURF.mural, rng.next());
    }
  }
  // roof: deep eaves because the light is overhead (spec 5: 0.8 to 1.5 m),
  // though never so deep that a steep roof brings its eave below ~1.7 m (spec 2)
  const pitch = b.roof === 'thatch' ? 0.8 : b.roof === 'slate' ? 0.7 : b.roof === 'turf' ? 0.45 : 0.6;
  const thick = b.roof === 'thatch' ? 0.38 : 0.12;
  const ovMax = Math.max(0.8, (top - y0 + 0.2 - 1.75) / Math.tan(pitch));
  const ov = Math.min(ovMax, b.roof === 'thatch' ? rng.range(0.9, 1.3) : b.roof === 'slate' ? rng.range(0.8, 1.0) : rng.range(0.9, 1.3));
  const gableSurf = upper > 0 ? m.upperSurf : b.upper === 'daub' ? SURF.plaster : m.upperSurf;
  const ridgeRgb = o.detail && b.deco >= 0.35 && b.roof !== 'thatch' && b.roof !== 'turf' ? rng.pick(PAINT) : undefined;
  let yR: number;
  if (warehouse || (b.roof === 'slate' && !gableFront && rng.chance(0.5))) {
    yR = hipRoof(mb, -w / 2 - jet, w / 2 + jet, -d / 2 - jet, d / 2 + jet, top, pitch * 0.9, ov, roofRgb, roofSurf(b.roof), param);
  } else if (gableFront) {
    // gable end to the lane: the ridge runs back along the depth
    mb.frame(b.a, 0, b.c, b.rot + Math.PI / 2);
    yR = gableRoof(mb, -d / 2 - jet, d / 2 + jet, -w / 2 - jet, w / 2 + jet, top, pitch, ov, 0.7, roofRgb, roofSurf(b.roof), param, thick, m.upperRgb, gableSurf, ridgeRgb);
  } else {
    yR = gableRoof(mb, -w / 2 - jet, w / 2 + jet, -d / 2 - jet, d / 2 + jet, top, pitch, ov, 0.4, roofRgb, roofSurf(b.roof), param, thick, m.upperRgb, gableSurf, ridgeRgb);
  }
  if (o.detail) {
    // ridge ornament: finials from middling decoration, ceramic creatures on rich roofs
    const ridgeLen = gableFront ? d / 2 + jet : w / 2 + jet;
    if (b.deco >= 0.5 && b.roof !== 'thatch' && !warehouse) {
      for (const sx of [-1, 1]) mb.cylinder(sx * (ridgeLen + 0.4), 0, yR - 0.1, yR + 0.55, 0.12, 0.02, 5, GOLD, SURF.gold, param);
    }
    if (b.deco > 0.7 && b.roof !== 'thatch' && b.roof !== 'turf' && !warehouse) ridgeCreatures(mb, -ridgeLen + 0.6, ridgeLen - 0.6, yR, rng, b.deco > 0.9);
  }
  mb.frame(b.a, 0, b.c, b.rot);
  if (!o.detail) return;
  if (b.lookout) lookoutDeck(mb, yR, param);
  // chimney
  if (rng.chance(b.kind === 'workshop' ? 0.9 : 0.4)) {
    const cx = gableFront ? rng.range(-w / 4, w / 4) : rng.range(-w / 3, w / 3);
    const cz = gableFront ? rng.range(-d / 4, d / 4) : rng.range(0, d / 4);
    mb.box(cx - 0.4, top - 0.5, cz - 0.4, cx + 0.4, yR + 0.9, cz + 0.4, m.baseRgb, m.baseSurf, m.baseSurf, 0.44);
  }
  // front: the door (and the drip porch at a water-side door), then windows
  const st = winStyle(b, rng, paint);
  const sill = 0.5;
  const zf = -d / 2;
  const doorX = frontDoorX(b);
  const clear: [number, number][] = [[doorX - 1.2, doorX + 1.2]];
  if (b.kind === 'workshop') {
    // open front with the forge inside
    mb.quad([1.5, y0, zf - 0.02], [-1.5, y0, zf - 0.02], [-1.5, y0 + 2.0, zf - 0.02], [1.5, y0 + 2.0, zf - 0.02], DARK, SURF.dark, param);
    mb.box(-1.75, y0 + 2.0, zf - 0.12, 1.75, y0 + 2.25, zf + 0.02, timber, SURF.timber, SURF.timber, param);
    clear.push([-2, 2]);
  } else door(mb, doorX, y0, zf, paint, param, b.deco);
  if (b.kind === 'shop') {
    // a wide shop window with a counter at 0.6 m (spec 2)
    const sx = doorX > 0 ? -w / 4 : w / 4;
    const sw = Math.min(2.2, w / 2 - 0.4);
    mb.quad([sx + sw / 2, y0 + 0.6, zf - 0.01], [sx - sw / 2, y0 + 0.6, zf - 0.01], [sx - sw / 2, y0 + 1.9, zf - 0.01], [sx + sw / 2, y0 + 1.9, zf - 0.01], DARK, SURF.dark, param);
    mb.box(sx - sw / 2 - 0.1, y0, zf - 0.45, sx + sw / 2 + 0.1, y0 + 0.6, zf, WOOD, SURF.wood, SURF.wood, st.sp);
    clear.push([sx - sw / 2 - 0.2, sx + sw / 2 + 0.2]);
  }
  if (b.kind !== 'workshop') windowBand(mb, w, y0 + sill, zf, st, param, clear);
  for (let f = 1; f <= upper; f++) windowBand(mb, w + jet * 2, y0 + lowerH + 0.22 + (f - 1) * FLOOR_H + sill, zf - jet, st, param);
  if (b.wet && b.kind !== 'workshop') dripPorch(mb, doorX, y0, zf, rng, paint, roofRgb, roofSurf(b.roof), param);
  // back: a second door (land and water: two ways out, spec 5) and windows
  mb.frame(b.a, 0, b.c, b.rot + Math.PI);
  const backX = rng.range(-w / 2 + 1.2, w / 2 - 1.2) * 0.5;
  if (w > 4.5) door(mb, backX, y0, -d / 2, paint, param, b.deco * 0.5, 1.1, 1.5, 6);
  windowBand(mb, w, y0 + sill, -d / 2, { ...st, shutter: 'side' }, param, [[backX - 1.2, backX + 1.2]]);
  mb.frame(b.a, 0, b.c, b.rot);
  // shop and tavern awnings and signs
  if (b.kind === 'tavern' || b.kind === 'shop') {
    const ax = rng.range(-w / 4, w / 4);
    const aw = Math.min(w - 1, 5.5);
    mb.quad([ax + aw / 2, y0 + 2.35, zf - 1.6], [ax - aw / 2, y0 + 2.35, zf - 1.6], [ax - aw / 2, y0 + 2.85, zf], [ax + aw / 2, y0 + 2.85, zf], rng.pick(PAINT), SURF.cloth, rng.next());
    if (b.kind === 'tavern') {
      mb.box(w / 2 - 0.2, y0 + 2.9, zf - 1.3, w / 2 - 0.1, y0 + 3.0, zf, timber, SURF.timber, SURF.timber, param);
      mb.box(w / 2 - 0.2, y0 + 2.1, zf - 1.05, w / 2 - 0.1, y0 + 2.85, zf - 0.35, rng.pick(PAINT), SURF.mural, rng.next());
      // a stage at the front corner for the singers (spec 7)
      const sx = doorX > 0 ? -w / 2 + 1.1 : w / 2 - 1.1;
      mb.box(sx - 1.0, y0 - 0.1, zf - 2.0, sx + 1.0, y0 + 0.4, zf - 0.2, WOOD, SURF.wood, SURF.wood, param);
      for (const px of [sx - 0.9, sx + 0.9]) mb.box(px - 0.06, y0 + 0.4, zf - 1.95, px + 0.06, y0 + 2.4, zf - 1.83, timber, SURF.timber, SURF.timber, param);
      mb.quad([sx + 1.1, y0 + 2.3, zf - 2.1], [sx - 1.1, y0 + 2.3, zf - 2.1], [sx - 1.1, y0 + 2.6, zf - 0.1], [sx + 1.1, y0 + 2.6, zf - 0.1], rng.pick(PAINT), SURF.cloth, rng.next());
    }
  }
  if (warehouse) {
    // big loading door with a ramp down to the quay, hoist beam, cargo
    mb.quad([1.6, y0, zf - 0.02], [-1.6, y0, zf - 0.02], [-1.6, y0 + 2.8, zf - 0.02], [1.6, y0 + 2.8, zf - 0.02], DARK, SURF.dark, param);
    mb.quad([1.6, y0, zf], [-1.6, y0, zf], [-1.6, lo, zf - 1.3], [1.6, lo, zf - 1.3], m.baseRgb, SURF.stone, 0.4);
    mb.box(-0.15, top - 0.35, zf - 1.8, 0.15, top - 0.05, zf, timber, SURF.timber, SURF.timber, param);
    for (let i = 0; i < 4; i++) {
      const x = rng.range(-w / 2 + 1, w / 2 - 1);
      if (Math.abs(x) < 2.2) continue;
      if (rng.chance(0.5)) mb.cylinder(x, zf - 1.2 - rng.range(0, 1.5), y0 - 0.15, y0 + 0.75, 0.32, 0.32, 8, WOOD, SURF.wood, param);
      else mb.box(x - 0.4, y0 - 0.15, zf - 2.2, x + 0.4, y0 + 0.65, zf - 1.4, WOOD, SURF.wood, SURF.wood, param);
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
    fanFace(mb, archOutline(0, lo - 0.6, 2.4, 1.5, 8), 0, lo, zf - 0.03, DARK, SURF.dark, param);
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
  const st: WinStyle = { ...winStyle(b, rng, paint), shutter: 'side' };
  for (const sx of [-1, 1]) {
    const ang = sx * 0.95;
    const rr = Math.hypot(Math.sin(ang) * rx, Math.cos(ang) * rz) + 0.02;
    mb.frame(b.a, 0, b.c, b.rot + ang);
    windowOpen(mb, 0, lo + 1.0, -rr * 0.93, st, param, 1.2, 0.5);
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
  const m = materials(b, rng);
  const plaster = m.upperRgb;
  const param = (b.seed % 983) / 983;
  const y0 = hi + 0.2;
  mb.box(-s, lo - 0.6, -s, s, y0 + height * 0.55, s, m.baseRgb, m.baseSurf, m.baseSurf, m.age);
  mb.box(-s + 0.2, y0 + height * 0.55, -s + 0.2, s - 0.2, y0 + height, s - 0.2, plaster, m.upperSurf, m.upperSurf, m.age);
  // balcony
  mb.box(-s - 0.6, y0 + height - 0.1, -s - 0.6, s + 0.6, y0 + height + 0.15, s + 0.6, TIMBER[0], SURF.timber, SURF.timber, param);
  if (dome) {
    mb.cylinder(0, 0, y0 + height + 0.15, y0 + height + 2.2, s * 0.85, s * 0.85, 16, plaster, SURF.plaster, param, false);
    mb.dome(0, y0 + height + 2.2, 0, s * 0.85, 1.25, 16, 6, COPPER, SURF.copper, b.age);
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
    const paint = fade(rng.pick(PAINT), b.age);
    const st: WinStyle = { ...winStyle(b, rng, paint), shutter: 'side' };
    door(mb, 0, y0, -s, paint, param, b.deco);
    for (let f = 1; f < Math.floor(height / FLOOR_H); f++) windowOpen(mb, 0, y0 + f * FLOOR_H + 0.5, -s + (y0 + f * FLOOR_H > y0 + height * 0.55 ? 0.2 : 0), st, param, 1.2, 0.6);
  }
}

/** Grand civic hall with a portico and a gilded dome, or a singing hall. */
export function buildCivic(mb: MeshBuilder, b: Building, ground: Ground, o: BuildOpts) {
  const rng = new Rng(b.seed + 3);
  const { lo, hi } = footprintGround(b, ground);
  mb.frame(b.a, 0, b.c, b.rot);
  const w = b.w;
  const d = b.d;
  // dressed stone for the grandest buildings (spec 4)
  const stone = rng.pick(ASHLAR);
  const plaster = rng.pick(PLASTER);
  const param = (b.seed % 977) / 977;
  const wall = wallAge(b.age);
  const y0 = hi + 0.6;
  const H = b.floors * FLOOR_H + 1.5;
  // podium with steps
  mb.box(-w / 2 - 2, lo - 0.6, -d / 2 - 3.5, w / 2 + 2, y0, d / 2 + 1, stone, SURF.stone, SURF.stone, param);
  for (let i = 0; i < 3; i++) mb.box(-w / 2 + 1, lo - 0.3, -d / 2 - 3.5 - (i + 1) * 0.45, w / 2 - 1, y0 - (i + 1) * 0.2, -d / 2 - 3.5 - i * 0.45, stone, SURF.stone, SURF.stone, param);
  mb.box(-w / 2, y0, -d / 2, w / 2, y0 + H * 0.45, d / 2, stone, SURF.ashlar, SURF.ashlar, wall);
  mb.box(-w / 2, y0 + H * 0.45, -d / 2, w / 2, y0 + H, d / 2, plaster, SURF.plaster, SURF.plaster, wall);
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
    // copper on civic domes (spec 4), verdigris with age; the finial stays gilded
    mb.dome(0, y0 + H + 3.2, 0, r, 1.1, 20, 8, COPPER, SURF.copper, b.age);
    mb.cylinder(0, 0, y0 + H + 3.2 + r * 1.05, y0 + H + 5.5 + r * 1.1, 0.25, 0.04, 8, GOLD, SURF.gold, param);
    hipRoof(mb, -w / 2, w / 2, -d / 2, d / 2, y0 + H + 0.45, 0.3, 0.3, lin('#a84a32'), SURF.tile, param);
  } else {
    gableRoof(mb, -w / 2, w / 2, -d / 2, d / 2, y0 + H + 0.45, 0.6, 1.0, 0.5, lin('#b85a3a'), SURF.tile, param, 0.15, plaster, SURF.plaster, rng.pick(PAINT));
  }
  if (o.detail) {
    door(mb, 0, y0, -d / 2, rng.pick(PAINT), param, Math.max(0.8, b.deco), 2.4, 2.6, 10);
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
