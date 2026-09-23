// Procedural, stylised low-poly Quinlan (README 1.2 and 12) with GPU
// (vertex shader) animation for instanced crowds.
//
// Model space: metres, feet on y = 0, the snout (the "houra") points to -Z
// (like a three.js camera), +X is the Quinlan's own right-hand side.
// Standing height is ~1.2 m (ear tips).
//
// Canon features: stocky pear-shaped furry body with short legs, otter-like
// head with a beak-like toothed snout, big eyes set wide on the sides of the
// head, webbing between the arms and the torso, a broad flat beaver tail, and a
// woven sash and bead necklace (Iron Age people who decorate everything).
//
// Geometry attributes
//   position, normal, color   rest pose; vertex colours are linear
//   aPart   float   part index (QUINLAN_PARTS)
//   aPivot  vec3    joint pivot of that part in model space
//   aSkin   vec3    x: joint weight (1 = rigid with the part; lower values
//                      fade towards the parent near joints and across the
//                      arm webbing), y: how much instanceColor tints this
//                      vertex (fur 1, eyes/teeth/clothes 0), z: tag
//                      (0 plain, 1 clothing accent, 2 eye, 3 eye highlight)
// Per-instance attribute (InstancedBufferAttribute on the geometry)
//   aAnim   vec4    x gait (0 idle, 1 walk, 2 quadruped run, 3 swim,
//                      4 sit and sing, 5 jaw-rub smile; fractional values
//                      cross-fade to the next gait), y phase 0..1,
//                      z cadence multiplier (0 freezes the pose, e.g. statues),
//                      w variant 0..1 (proportions, posture, clothing colour)
//
// Shader injection (see quinlanAnimParsGlsl / quinlanAnimGlsl below):
//   vertex pars after  #include <common>      -> quinlanAnimParsGlsl
//   statements after   #include <begin_vertex> -> quinlanAnimGlsl
//   The host declares `uniform float uTime;` (seconds).

import {
  Box3,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  Sphere,
  Vector3,
  type MeshStandardMaterialParameters,
} from 'three';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const QUINLAN_PARTS = {
  body: 0,
  head: 1,
  jaw: 2,
  armL: 3,
  armR: 4,
  legL: 5,
  legR: 6,
  tail: 7,
} as const;

/** Values for aAnim.x. */
export const QUINLAN_GAIT = { idle: 0, walk: 1, run: 2, swim: 3, sing: 4, smile: 5 } as const;
export type QuinlanGait = (typeof QUINLAN_GAIT)[keyof typeof QUINLAN_GAIT];

/** Standing height (ear tips) in metres. */
export const QUINLAN_HEIGHT = 1.2;

/**
 * Ground speed (m/s) that matches the foot/stroke cycle at cadence 1.
 * Set aAnim.z = actualSpeed / nominal to avoid foot sliding.
 */
export const QUINLAN_NOMINAL_SPEED = { walk: 1.5, run: 7.0, swim: 3.0 } as const;

type V3 = [number, number, number];

/** Joint pivots (model space, metres). L = -X side, R = +X side. */
export const QUINLAN_JOINTS = {
  hip: [0, 0.3, 0] as V3, // root / whole-body pitch pivot
  spine: [0, 0.5, 0] as V3, // upper-body bend pivot
  neck: [0, 0.905, 0.02] as V3,
  jaw: [0, 0.957, -0.03] as V3,
  shoulderL: [-0.172, 0.772, 0] as V3,
  shoulderR: [0.172, 0.772, 0] as V3,
  hipL: [-0.112, 0.295, 0] as V3,
  hipR: [0.112, 0.295, 0] as V3,
  tail: [0, 0.25, 0.14] as V3,
};
const EYE_R: V3 = [0.126, 1.074, -0.045];
const EYE_RADIUS = 0.046;

// ---------------------------------------------------------------------------
// Palette (sRGB hex -> linear working space via three's colour management)
// ---------------------------------------------------------------------------

function lin(hex: number): V3 {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

const PAL = {
  fur: lin(0x7c5233),
  furDark: lin(0x573722),
  belly: lin(0xdcbc90),
  muzzle: lin(0xcfab80),
  beak: lin(0x8d6446),
  nose: lin(0x2a1b15),
  mouth: lin(0x5a2226),
  tongue: lin(0xb5585a),
  teeth: lin(0xf3ecd9),
  eye: lin(0x140e0b),
  shine: lin(0xffffff),
  web: lin(0xa98068),
  paw: lin(0x4b3326),
  tail: lin(0x55423a),
  tailDark: lin(0x3c2e27),
  earIn: lin(0xa27463),
  accent: lin(0xb4452c),
  gold: lin(0xd8a73a),
  turquoise: lin(0x2d9d94),
};

/** Clothing accent dyes (madder, woad, weld, green, terracotta, purple, teal, oat). */
const ACCENTS_SRGB = [0xb4452c, 0x2f5f92, 0xcf9a2c, 0x3f7c4a, 0xc2683a, 0x6d4a7e, 0x2c8a86, 0xdccfae];

/**
 * Per-instance fur tint for InstancedMesh.setColorAt(). The Quinlan shader applies
 * instanceColor to fur only (eyes, teeth and clothes keep their colours), so this is
 * a multiplier around white. variant 0..1 picks and blends a fur tone.
 */
export function quinlanFurPalette(variant: number, target = new Color()): Color {
  const tones: V3[] = [
    [1.0, 1.0, 1.0], // chestnut (base)
    [0.72, 0.66, 0.62], // chocolate
    [1.28, 1.1, 0.82], // golden
    [0.92, 0.93, 0.96], // ash brown
    [1.16, 0.88, 0.72], // russet
    [1.38, 1.26, 1.04], // sandy
    [0.55, 0.5, 0.48], // near black
    [1.1, 1.02, 0.92], // tawny
  ];
  const v = (((variant * 7.919 + 0.137) % 1) + 1) % 1;
  const f = v * tones.length;
  const i = Math.floor(f);
  const a = tones[i % tones.length];
  const b = tones[(i + 1) % tones.length];
  const k = (f - i) * 0.35; // mostly the picked tone, slightly blended
  return target.setRGB(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
}

// ---------------------------------------------------------------------------
// Small vector helpers (tuples, build time only)
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** GLSL-style smoothstep; also works with e0 > e1 (falling edge). */
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mixc = (a: V3, b: V3, t: number): V3 => lerp3(a, b, t);

function rotX(a: number, v: V3): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
function rotY(a: number, v: V3): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}
function rotZ(a: number, v: V3): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
/** Same convention as GLSL qEuler: R = Ry(e.y) * Rx(e.x) * Rz(e.z). */
const euler = (e: V3) => (v: V3): V3 => rotY(e[1], rotX(e[0], rotZ(e[2], v)));

// ---------------------------------------------------------------------------
// Primitive generators
// ---------------------------------------------------------------------------

type UV = [number, number];
interface Prim {
  p: V3[];
  t: number[];
  uv: UV[]; // (ring index, segment index) for lofts
}

/** Cross-section: c + u*a*cos(th) + v*(sin(th) >= 0 ? b1 : b2)*sin(th). */
interface Ring {
  c: V3;
  u: V3;
  v: V3;
  a: number;
  b1: number;
  b2: number;
  pole?: boolean;
}

const pole = (c: V3): Ring => ({ c, u: [1, 0, 0], v: [0, 1, 0], a: 0, b1: 0, b2: 0, pole: true });

/** Push a triangle wound so that its normal points away from `inside`. */
function tri(t: number[], p: V3[], a: number, b: number, c: number, inside: V3) {
  const n = cross(sub(p[b], p[a]), sub(p[c], p[a]));
  const cen = mul(add(add(p[a], p[b]), p[c]), 1 / 3);
  if (dot(n, sub(cen, inside)) < 0) t.push(a, c, b);
  else t.push(a, b, c);
}

function loft(rings: Ring[], seg: number): Prim {
  const p: V3[] = [];
  const uv: UV[] = [];
  const start: number[] = [];
  rings.forEach((r, i) => {
    start.push(p.length);
    if (r.pole) {
      p.push([r.c[0], r.c[1], r.c[2]]);
      uv.push([i, 0]);
      return;
    }
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * TAU;
      const cs = Math.cos(th), sn = Math.sin(th);
      const b = sn >= 0 ? r.b1 : r.b2;
      p.push(add(r.c, add(mul(r.u, r.a * cs), mul(r.v, b * sn))));
      uv.push([i, k]);
    }
  });
  const t: number[] = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    const A = rings[i], B = rings[i + 1];
    if (A.pole && B.pole) continue;
    const inside = lerp3(A.c, B.c, 0.5);
    const a0 = start[i], b0 = start[i + 1];
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      if (A.pole) tri(t, p, a0, b0 + k, b0 + k1, inside);
      else if (B.pole) tri(t, p, a0 + k, a0 + k1, b0, inside);
      else {
        tri(t, p, a0 + k, a0 + k1, b0 + k1, inside);
        tri(t, p, a0 + k, b0 + k1, b0 + k, inside);
      }
    }
  }
  return { p, t, uv };
}

/** Ellipsoid with poles along its local Y axis, rotated by euler `rot` (x, y, z). */
function ellipsoid(c: V3, r: V3, seg: number, stacks: number, rot: V3 = [0, 0, 0]): Prim {
  const R = euler(rot);
  const rings: Ring[] = [pole(add(c, R([0, r[1], 0])))];
  for (let j = 1; j < stacks; j++) {
    const ph = (j / stacks) * Math.PI;
    const s = Math.sin(ph);
    rings.push({ c: add(c, R([0, Math.cos(ph) * r[1], 0])), u: R([1, 0, 0]), v: R([0, 0, 1]), a: r[0] * s, b1: r[2] * s, b2: r[2] * s });
  }
  rings.push(pole(add(c, R([0, -r[1], 0]))));
  return loft(rings, seg);
}

/** Octahedron (faceted bead / small nub). */
function octa(c: V3, r: V3, rot: V3 = [0, 0, 0]): Prim {
  const R = euler(rot);
  const d: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const p = d.map((v) => add(c, R([v[0] * r[0], v[1] * r[1], v[2] * r[2]])));
  const t: number[] = [];
  for (const x of [0, 1]) for (const y of [2, 3]) for (const z of [4, 5]) tri(t, p, x, y, z, c);
  return { p, t, uv: p.map(() => [0, 0] as UV) };
}

/** Three-sided tooth: base around `base` (perpendicular to dir), apex along dir. */
function tooth(base: V3, dir: V3, length: number, radius: number): Prim {
  const d = norm(dir);
  const ref: V3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm(cross(d, ref));
  const v = cross(d, u);
  const p: V3[] = [];
  for (let k = 0; k < 3; k++) {
    const th = (k / 3) * TAU;
    p.push(add(base, add(mul(u, Math.cos(th) * radius), mul(v, Math.sin(th) * radius))));
  }
  p.push(add(base, mul(d, length)));
  const inside = add(base, mul(d, length * 0.3));
  const t: number[] = [];
  tri(t, p, 0, 1, 3, inside);
  tri(t, p, 1, 2, 3, inside);
  tri(t, p, 2, 0, 3, inside);
  return { p, t, uv: p.map(() => [0, 0] as UV) };
}

/** Flat hexagonal disc (pendant), axis `axis`. */
function disc(c: V3, axis: V3, radius: number, thick: number, sides = 6): Prim {
  const d = norm(axis);
  const u = norm(cross(d, [0, 1, 0]));
  const v = cross(d, u);
  const p: V3[] = [add(c, mul(d, thick)), add(c, mul(d, -thick))];
  for (const s of [1, -1]) {
    for (let k = 0; k < sides; k++) {
      const th = (k / sides) * TAU + Math.PI / 2;
      p.push(add(add(c, mul(d, s * thick)), add(mul(u, Math.cos(th) * radius), mul(v, Math.sin(th) * radius))));
    }
  }
  const t: number[] = [];
  for (let k = 0; k < sides; k++) {
    const k1 = (k + 1) % sides;
    tri(t, p, 0, 2 + k, 2 + k1, c);
    tri(t, p, 1, 2 + sides + k, 2 + sides + k1, c);
    tri(t, p, 2 + k, 2 + k1, 2 + sides + k1, c);
    tri(t, p, 2 + k, 2 + sides + k1, 2 + sides + k, c);
  }
  return { p, t, uv: p.map(() => [0, 0] as UV) };
}

function mirrorX(pr: Prim): Prim {
  const t: number[] = [];
  for (let i = 0; i < pr.t.length; i += 3) t.push(pr.t[i], pr.t[i + 2], pr.t[i + 1]);
  return { p: pr.p.map((v) => [-v[0], v[1], v[2]] as V3), t, uv: pr.uv };
}

function smoothNormals(pr: Prim): V3[] {
  const n: V3[] = pr.p.map(() => [0, 0, 0]);
  for (let i = 0; i < pr.t.length; i += 3) {
    const a = pr.t[i], b = pr.t[i + 1], c = pr.t[i + 2];
    const f = cross(sub(pr.p[b], pr.p[a]), sub(pr.p[c], pr.p[a])); // area weighted
    for (const j of [a, b, c]) n[j] = add(n[j], f);
  }
  return n.map((v) => norm(v));
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** linear rgb + fur tint weight */
type Paint = [number, number, number, number];

interface Spec {
  part: number;
  pivot: V3;
  paint: (p: V3, n: V3, uv: UV) => Paint;
  weight?: (p: V3, uv: UV) => number;
  tag?: number;
  flat?: boolean;
}

const solid = (c: V3, fur = 0) => (): Paint => [c[0], c[1], c[2], fur];

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  part: number[] = [];
  piv: number[] = [];
  skin: number[] = [];
  idx: number[] = [];

  private vertex(p: V3, n: V3, uv: UV, s: Spec) {
    const c = s.paint(p, n, uv);
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.part.push(s.part);
    this.piv.push(s.pivot[0], s.pivot[1], s.pivot[2]);
    this.skin.push(s.weight ? clamp01(s.weight(p, uv)) : 1, c[3], s.tag ?? 0);
  }

  add(pr: Prim, s: Spec) {
    if (s.flat) {
      for (let i = 0; i < pr.t.length; i += 3) {
        const a = pr.p[pr.t[i]], b = pr.p[pr.t[i + 1]], c = pr.p[pr.t[i + 2]];
        const n = norm(cross(sub(b, a), sub(c, a)));
        const base = this.pos.length / 3;
        for (let k = 0; k < 3; k++) this.vertex(pr.p[pr.t[i + k]], n, pr.uv[pr.t[i + k]], s);
        this.idx.push(base, base + 1, base + 2);
      }
      return;
    }
    const base = this.pos.length / 3;
    const n = smoothNormals(pr);
    pr.p.forEach((p, i) => this.vertex(p, n[i], pr.uv[i], s));
    for (const i of pr.t) this.idx.push(base + i);
  }

  finish(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPart', new Float32BufferAttribute(this.part, 1));
    g.setAttribute('aPivot', new Float32BufferAttribute(this.piv, 3));
    g.setAttribute('aSkin', new Float32BufferAttribute(this.skin, 3));
    g.setIndex(this.idx);
    // Generous bounds that cover every animated pose (quadruped/swim reach far forward).
    g.boundingBox = new Box3(new Vector3(-0.95, -0.75, -1.25), new Vector3(0.95, 1.3, 1.05));
    g.boundingSphere = new Sphere(new Vector3(0, 0.3, -0.1), 1.45);
    g.userData.triangles = this.idx.length / 3;
    return g;
  }
}

// ---------------------------------------------------------------------------
// Body plan
// ---------------------------------------------------------------------------

// Torso rings (perpendicular to Y): [y, cz, rx, rzBack, rzFront]
const TORSO: number[][] = [
  [0.15, 0.01, 0, 0, 0],
  [0.168, 0.01, 0.12, 0.1, 0.11],
  [0.212, 0.008, 0.198, 0.16, 0.18],
  [0.285, 0.004, 0.242, 0.182, 0.212],
  [0.375, 0, 0.256, 0.188, 0.226],
  [0.465, 0, 0.25, 0.18, 0.218],
  [0.555, 0.004, 0.232, 0.166, 0.198],
  [0.645, 0.01, 0.21, 0.152, 0.176],
  [0.73, 0.015, 0.188, 0.14, 0.156],
  [0.805, 0.02, 0.16, 0.126, 0.136],
  [0.865, 0.022, 0.122, 0.106, 0.112],
  [0.92, 0.022, 0.094, 0.09, 0.09],
  [0.965, 0.022, 0, 0, 0],
];
const TORSO_LOW = [0, 1, 3, 5, 7, 9, 11, 12];

// Head rings (perpendicular to Z, snout towards -Z): [z, cy, rx, ryTop, ryBottom]
const HEAD: number[][] = [
  [0.165, 1.04, 0, 0, 0],
  [0.15, 1.04, 0.07, 0.07, 0.065],
  [0.12, 1.042, 0.118, 0.112, 0.1],
  [0.075, 1.045, 0.145, 0.132, 0.12],
  [0.02, 1.045, 0.152, 0.138, 0.125],
  [-0.035, 1.04, 0.145, 0.13, 0.115],
  [-0.085, 1.025, 0.125, 0.11, 0.085],
  [-0.135, 1.0, 0.098, 0.082, 0.05],
  [-0.185, 0.985, 0.078, 0.06, 0.035],
  [-0.235, 0.975, 0.064, 0.048, 0.028],
  [-0.28, 0.968, 0.052, 0.04, 0.024],
  [-0.312, 0.962, 0.036, 0.028, 0.018],
  [-0.328, 0.958, 0, 0, 0],
];
const HEAD_LOW = [0, 2, 4, 6, 7, 9, 11, 12];

// Lower jaw rings: [z, cy, rx, ryTop, ryBottom]
const JAW: number[][] = [
  [-0.02, 0.95, 0, 0, 0],
  [-0.04, 0.947, 0.08, 0.012, 0.036],
  [-0.095, 0.944, 0.078, 0.011, 0.038],
  [-0.15, 0.941, 0.068, 0.01, 0.032],
  [-0.205, 0.939, 0.056, 0.009, 0.026],
  [-0.25, 0.938, 0.042, 0.007, 0.019],
  [-0.272, 0.938, 0, 0, 0],
];
const JAW_LOW = [0, 1, 3, 5, 6];

// Right arm path: [x, y, z, a (front-back), b (lateral)]; mirrored for the left.
const ARM: number[][] = [
  [0.165, 0.83, 0.004, 0, 0],
  [0.18, 0.8, 0.002, 0.05, 0.05],
  [0.205, 0.76, 0, 0.066, 0.064],
  [0.252, 0.672, -0.008, 0.062, 0.06],
  [0.294, 0.585, -0.018, 0.056, 0.054],
  [0.326, 0.502, -0.03, 0.05, 0.048],
  [0.345, 0.445, -0.04, 0.044, 0.042],
  [0.354, 0.408, -0.046, 0.052, 0.03],
  [0.36, 0.37, -0.05, 0.055, 0.028],
  [0.362, 0.34, -0.052, 0.04, 0.022],
  [0.362, 0.322, -0.052, 0, 0],
];
const ARM_LOW = [0, 2, 4, 6, 8, 10];
const ARM_WRIST = 6;

// Right leg path: [x, y, z, r]
const LEG: number[][] = [
  [0.108, 0.335, 0, 0],
  [0.112, 0.305, 0, 0.062],
  [0.116, 0.262, -0.002, 0.08],
  [0.121, 0.19, -0.006, 0.078],
  [0.125, 0.125, -0.01, 0.064],
  [0.128, 0.078, -0.012, 0.052],
  [0.129, 0.05, -0.012, 0],
];
const LEG_LOW = [0, 2, 4, 6];
const FOOT_C: V3 = [0.134, 0.029, -0.052];
const FOOT_R: V3 = [0.064, 0.029, 0.108];
const FOOT_YAW = -0.18; // toes turned slightly outwards

// Tail path: [y, z, halfWidth, top, bottom]
const TAIL: number[][] = [
  [0.265, 0.095, 0, 0, 0],
  [0.262, 0.118, 0.07, 0.064, 0.064],
  [0.225, 0.2, 0.082, 0.052, 0.052],
  [0.16, 0.29, 0.1, 0.038, 0.036],
  [0.09, 0.385, 0.128, 0.03, 0.027],
  [0.055, 0.475, 0.148, 0.027, 0.024],
  [0.045, 0.57, 0.156, 0.026, 0.023],
  [0.043, 0.66, 0.146, 0.024, 0.021],
  [0.042, 0.735, 0.112, 0.02, 0.018],
  [0.041, 0.785, 0.06, 0.013, 0.012],
  [0.041, 0.805, 0, 0, 0],
];
const TAIL_LOW = [0, 1, 3, 5, 7, 8, 10];

const pick = <T>(rows: T[], hi: boolean, low: number[]): T[] => (hi ? rows : low.map((i) => rows[i]));

/** Tangent-framed rings along a path (u stays close to `side`). */
function pathRings(centers: V3[], radii: [number, number, number][], side: V3, poles: boolean[]): Ring[] {
  return centers.map((c, i) => {
    if (poles[i]) return pole(c);
    const prev = centers[Math.max(0, i - 1)], next = centers[Math.min(centers.length - 1, i + 1)];
    const T = norm(sub(next, prev));
    const u = norm(sub(side, mul(T, dot(side, T))));
    const v = norm(cross(T, u));
    return { c, u, v, a: radii[i][0], b1: radii[i][1], b2: radii[i][2] };
  });
}

/** Piecewise-linear torso ring parameters at height y over the used rings. */
function torsoAt(rows: number[][], y: number): { cz: number; rx: number; rb: number; rf: number } {
  const body = rows.filter((r) => r[2] > 0);
  if (y <= body[0][0]) return { cz: body[0][1], rx: body[0][2], rb: body[0][3], rf: body[0][4] };
  for (let i = 0; i + 1 < body.length; i++) {
    const a = body[i], b = body[i + 1];
    if (y <= b[0]) {
      const t = (y - a[0]) / (b[0] - a[0]);
      return { cz: a[1] + (b[1] - a[1]) * t, rx: a[2] + (b[2] - a[2]) * t, rb: a[3] + (b[3] - a[3]) * t, rf: a[4] + (b[4] - a[4]) * t };
    }
  }
  const l = body[body.length - 1];
  return { cz: l[1], rx: l[2], rb: l[3], rf: l[4] };
}

function torsoPoint(rows: number[][], th: number, y: number): V3 {
  const r = torsoAt(rows, y);
  const s = Math.sin(th);
  return [r.rx * Math.cos(th), y, r.cz + (s >= 0 ? r.rb : r.rf) * s];
}

function torsoNormal(rows: number[][], th: number, y: number): V3 {
  const r = torsoAt(rows, y);
  const s = Math.sin(th);
  return norm([Math.cos(th) / r.rx, 0, s / (s >= 0 ? r.rb : r.rf)]);
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function buildTorso(B: Builder, hi: boolean, rows: number[][]) {
  const seg = hi ? 16 : 8;
  const rings = rows.map((r) =>
    r[2] === 0 ? pole([0, r[0], r[1]]) : { c: [0, r[0], r[1]] as V3, u: [1, 0, 0] as V3, v: [0, 0, 1] as V3, a: r[2], b1: r[3], b2: r[4] },
  );
  B.add(loft(rings, seg), {
    part: QUINLAN_PARTS.body,
    pivot: QUINLAN_JOINTS.hip,
    paint: (p, n) => {
      let c = PAL.fur;
      // darker saddle down the back
      c = mixc(c, PAL.furDark, 0.5 * sstep(0.25, 0.85, n[2]) * sstep(0.3, 0.55, p[1]));
      // cream belly, chest and throat
      const front = sstep(-0.3, -0.72, n[2]) * sstep(0.17, 0.27, p[1]);
      c = mixc(c, PAL.belly, front);
      return [c[0], c[1], c[2], 1 - 0.65 * front];
    },
  });
}

function buildHead(B: Builder, hi: boolean) {
  const seg = hi ? 16 : 8;
  const rows = pick(HEAD, hi, HEAD_LOW);
  const rings = rows.map((r) =>
    r[2] === 0 ? pole([0, r[1], r[0]]) : { c: [0, r[1], r[0]] as V3, u: [1, 0, 0] as V3, v: [0, 1, 0] as V3, a: r[2], b1: r[3], b2: r[4] },
  );
  const head = { part: QUINLAN_PARTS.head, pivot: QUINLAN_JOINTS.neck };
  B.add(loft(rings, seg), {
    ...head,
    paint: (p, n) => {
      let c = PAL.fur;
      let fur = 1;
      c = mixc(c, PAL.furDark, 0.4 * sstep(0.35, 0.9, n[1]) * sstep(-0.12, 0.02, p[2]));
      // pale cheeks, throat and whisker pads
      const cheek = sstep(0.02, -0.08, p[2]) * sstep(0.2, -0.45, n[1]);
      const throat = sstep(0.0, -0.6, n[1]) * sstep(0.1, -0.02, p[2]);
      const pale = Math.max(cheek, throat);
      c = mixc(c, PAL.muzzle, pale);
      fur -= 0.6 * pale;
      // pale ring around the side eyes
      const ex = Math.abs(p[0]) - EYE_R[0], ey = p[1] - EYE_R[1], ez = p[2] - EYE_R[2];
      const eyeRing = sstep(0.085, 0.055, Math.hypot(ex, ey, ez));
      c = mixc(c, PAL.belly, 0.75 * eyeRing);
      // the houra: a leathery, beak-like upper snout ...
      const beak = sstep(-0.115, -0.16, p[2]) * sstep(-0.55, -0.1, n[1]);
      c = mixc(c, PAL.beak, beak);
      fur -= 0.5 * beak;
      // ... with a dark palate underneath (seen when the mouth opens)
      const palate = sstep(-0.09, -0.13, p[2]) * sstep(-0.35, -0.7, n[1]);
      c = mixc(c, PAL.mouth, palate);
      fur *= 1 - palate;
      return [c[0], c[1], c[2], clamp01(fur)];
    },
  });

  // nose pad on the tip of the houra
  B.add(ellipsoid([0, 0.991, -0.304], [0.03, 0.018, 0.024], hi ? 8 : 5, hi ? 4 : 3, [0.25, 0, 0]), {
    ...head,
    paint: solid(PAL.nose),
  });

  // eyes, wide on the sides of the head
  const eyeSeg = hi ? 12 : 6, eyeStacks = hi ? 7 : 4;
  const eye = ellipsoid(EYE_R, [EYE_RADIUS, EYE_RADIUS, EYE_RADIUS], eyeSeg, eyeStacks, [0, 0, Math.PI / 2]);
  B.add(eye, { ...head, paint: solid(PAL.eye), tag: 2 });
  B.add(mirrorX(eye), { ...head, paint: solid(PAL.eye), tag: 2 });
  if (hi) {
    const d = norm([0.62, 0.52, -0.58]);
    const shine = octa(add(EYE_R, mul(d, EYE_RADIUS * 0.93)), [0.012, 0.012, 0.012]);
    B.add(shine, { ...head, paint: solid(PAL.shine), tag: 3, flat: true });
    B.add(mirrorX(shine), { ...head, paint: solid(PAL.shine), tag: 3, flat: true });
  }

  // small rounded ears
  const ear = ellipsoid([0.098, 1.152, 0.062], [0.031, 0.036, 0.013], hi ? 8 : 4, hi ? 4 : 2, [0.1, 0.55, -0.45]);
  const earPaint = (p: V3, n: V3): Paint => {
    const inner = sstep(-0.2, -0.6, dot(n, norm([Math.sign(p[0]) * -0.3, 0, -1])) * -1 + 0.0);
    const c = mixc(PAL.fur, PAL.earIn, 0.8 * sstep(0.2, 0.6, dot(n, norm([Math.sign(p[0]) * 0.45, 0.1, -1]))) + 0 * inner);
    return [c[0], c[1], c[2], 0.9];
  };
  B.add(ear, { ...head, paint: earPaint });
  B.add(mirrorX(ear), { ...head, paint: earPaint });

  // teeth along the rim of the houra (overbite: they hang outside the lower jaw)
  const upper: [number, number][] = hi
    ? [[-0.125, 0.021], [-0.16, 0.024], [-0.195, 0.024], [-0.23, 0.022], [-0.262, 0.02]]
    : [[-0.15, 0.024], [-0.22, 0.023]];
  for (const [z, l] of upper) {
    const r = interpRow(HEAD, z);
    const th = -0.72;
    const base: V3 = [r[2] * Math.cos(th) * 0.98, r[1] + r[4] * Math.sin(th) + 0.004, z];
    const tt = tooth(base, [0.18, -1, 0], l + 0.004, hi ? 0.0085 : 0.011);
    B.add(tt, { ...head, paint: solid(PAL.teeth), flat: true });
    B.add(mirrorX(tt), { ...head, paint: solid(PAL.teeth), flat: true });
  }
  // two front teeth
  const front = tooth([0.011, 0.952, -0.296], [0.05, -1, -0.12], 0.03, hi ? 0.01 : 0.012);
  B.add(front, { ...head, paint: solid(PAL.teeth), flat: true });
  B.add(mirrorX(front), { ...head, paint: solid(PAL.teeth), flat: true });
}

function interpRow(rows: number[][], z: number): number[] {
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    if ((z <= a[0] && z >= b[0]) || (z >= a[0] && z <= b[0])) {
      const t = (z - a[0]) / (b[0] - a[0] || 1);
      return a.map((v, k) => v + (b[k] - v) * t);
    }
  }
  return rows[rows.length - 1];
}

function buildJaw(B: Builder, hi: boolean) {
  const seg = hi ? 12 : 6;
  const rows = pick(JAW, hi, JAW_LOW);
  const rings = rows.map((r) =>
    r[2] === 0 ? pole([0, r[1], r[0]]) : { c: [0, r[1], r[0]] as V3, u: [1, 0, 0] as V3, v: [0, 1, 0] as V3, a: r[2], b1: r[3], b2: r[4] },
  );
  const jaw = { part: QUINLAN_PARTS.jaw, pivot: QUINLAN_JOINTS.jaw };
  B.add(loft(rings, seg), {
    ...jaw,
    paint: (p, n) => {
      const top = sstep(0.25, 0.6, n[1]);
      let c = mixc(PAL.muzzle, PAL.mouth, top);
      c = mixc(c, PAL.tongue, top * sstep(0.035, 0.015, Math.abs(p[0])) * sstep(-0.05, -0.09, p[2]));
      return [c[0], c[1], c[2], 0.4 * (1 - top)];
    },
  });
  if (hi) {
    for (const z of [-0.12, -0.17, -0.22]) {
      const r = interpRow(JAW, z);
      const tt = tooth([r[2] * 0.72, r[1] + r[3], z], [-0.1, 1, 0], 0.016, 0.007);
      B.add(tt, { ...jaw, paint: solid(PAL.teeth), flat: true });
      B.add(mirrorX(tt), { ...jaw, paint: solid(PAL.teeth), flat: true });
    }
  }
}

function armRings(hi: boolean): { rings: Ring[]; rows: number[][] } {
  const rows = pick(ARM, hi, ARM_LOW);
  const centers = rows.map((r) => [r[0], r[1], r[2]] as V3);
  const radii = rows.map((r) => [r[3], r[4], r[4]] as [number, number, number]);
  const rings = pathRings(centers, radii, [0, 0, 1], rows.map((r) => r[3] === 0));
  return { rings, rows };
}

function buildArms(B: Builder, hi: boolean, torsoRows: number[][]) {
  const seg = hi ? 12 : 6;
  const { rings, rows } = armRings(hi);
  const arm = loft(rings, seg);
  const wristY = ARM[ARM_WRIST][1];
  const paint = (p: V3): Paint => {
    const k = sstep(wristY + 0.03, wristY - 0.02, p[1]);
    const c = mixc(PAL.fur, PAL.paw, k);
    return [c[0], c[1], c[2], 1 - 0.5 * k];
  };
  // joint weights: soft at the shoulder so it blends into the torso
  const weight = (_p: V3, uv: UV) => {
    const y = rows[uv[0]][1];
    return 0.45 + 0.55 * sstep(0.81, 0.7, y);
  };
  const specR: Spec = { part: QUINLAN_PARTS.armR, pivot: QUINLAN_JOINTS.shoulderR, paint, weight };
  const specL: Spec = { ...specR, part: QUINLAN_PARTS.armL, pivot: QUINLAN_JOINTS.shoulderL };
  B.add(arm, specR);
  B.add(mirrorX(arm), specL);

  if (hi) {
    // stubby webbed fingers
    for (const dz of [-0.034, 0, 0.032]) {
      const f = ellipsoid([0.36, 0.333, -0.052 + dz], [0.018, 0.02, 0.016], 6, 3);
      B.add(f, { ...specR, paint: solid(PAL.paw, 0.5) });
      B.add(mirrorX(f), { ...specL, paint: solid(PAL.paw, 0.5) });
    }
  }

  // Webbing between the arm and the torso. Columns run from the torso edge
  // (weight 0: follows the body) to the arm edge (weight 1: follows the arm).
  const web = webbing(hi, torsoRows);
  const webPaint = (p: V3, n: V3, uv: UV): Paint => {
    const edge = uv[1] === 1 ? 1 : 0;
    const c = mixc(PAL.web, PAL.fur, 0.35 * edge);
    return [c[0], c[1], c[2], 0.6];
  };
  const webW = (_p: V3, uv: UV) => uv[0];
  B.add(web, { ...specR, paint: webPaint, weight: webW });
  B.add(mirrorX(web), { ...specL, paint: webPaint, weight: webW });
}

/** Point on the arm path (shoulder ring -> wrist ring) at s in 0..1, and its radius. */
function armAt(s: number): { c: V3; r: number } {
  const i0 = 2, i1 = ARM_WRIST;
  const f = i0 + s * (i1 - i0);
  const i = Math.min(i1 - 1, Math.floor(f));
  const t = f - i;
  const a = ARM[i], b = ARM[i + 1];
  return { c: lerp3([a[0], a[1], a[2]], [b[0], b[1], b[2]], t), r: a[4] + (b[4] - a[4]) * t };
}

/** Double-sided membrane; uv = (column fraction 0..1 = joint weight, 1 if free edge). */
function webbing(hi: boolean, torsoRows: number[][]): Prim {
  const rows = hi ? 5 : 2;
  const cols = hi ? 4 : 2;
  const thick = 0.0032;
  const grid: V3[][] = [];
  for (let r = 0; r <= rows; r++) {
    const f = r / rows;
    const a = armAt(0.06 + 0.66 * f);
    const toBody = norm([-1, 0.25, 0.1]);
    const A = add(a.c, mul(toBody, a.r * 0.75));
    const y = 0.735 - 0.25 * f;
    const tp = torsoPoint(torsoRows, 0, y);
    const Bp: V3 = [tp[0] * 0.965, y, tp[2] + 0.012];
    const row: V3[] = [];
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      let p = lerp3(Bp, A, u);
      // slight backward billow, and a scalloped free edge
      p = add(p, [0, 0, 0.012 * Math.sin(Math.PI * u) * (0.4 + f)]);
      if (r === rows) p = add(p, [0, 0.045 * Math.sin(Math.PI * u), 0]);
      row.push(p);
    }
    grid.push(row);
  }
  const p: V3[] = [];
  const uv: UV[] = [];
  const t: number[] = [];
  const id = (layer: number, r: number, c: number) => layer * (rows + 1) * (cols + 1) + r * (cols + 1) + c;
  for (const layer of [0, 1]) {
    const s = layer === 0 ? -1 : 1; // layer 0 faces forward (-Z)
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const dr = sub(grid[Math.min(rows, r + 1)][c], grid[Math.max(0, r - 1)][c]);
        const dc = sub(grid[r][Math.min(cols, c + 1)], grid[r][Math.max(0, c - 1)]);
        let n = norm(cross(dr, dc));
        if (n[2] * s < 0) n = mul(n, -1);
        p.push(add(grid[r][c], mul(n, thick)));
        uv.push([c / cols, r === rows ? 1 : 0]);
      }
    }
  }
  for (const layer of [0, 1]) {
    const s = layer === 0 ? -1 : 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const q = [id(layer, r, c), id(layer, r, c + 1), id(layer, r + 1, c + 1), id(layer, r + 1, c)];
        const cen = mul(add(add(p[q[0]], p[q[1]]), add(p[q[2]], p[q[3]])), 0.25);
        const inside = add(cen, [0, 0, -s]);
        tri(t, p, q[0], q[1], q[2], inside);
        tri(t, p, q[0], q[2], q[3], inside);
      }
    }
  }
  // close the free (bottom) edge between the two layers
  for (let c = 0; c < cols; c++) {
    const a = id(0, rows, c), b = id(0, rows, c + 1), d = id(1, rows, c), e = id(1, rows, c + 1);
    const inside = add(lerp3(p[a], p[e], 0.5), [0, 0.03, 0]);
    tri(t, p, a, b, e, inside);
    tri(t, p, a, e, d, inside);
  }
  return { p, t, uv };
}

function buildLegs(B: Builder, hi: boolean) {
  const seg = hi ? 10 : 6;
  const rows = pick(LEG, hi, LEG_LOW);
  const centers = rows.map((r) => [r[0], r[1], r[2]] as V3);
  const radii = rows.map((r) => [r[3], r[3], r[3]] as [number, number, number]);
  const leg = loft(pathRings(centers, radii, [0, 0, 1], rows.map((r) => r[3] === 0)), seg);
  const weight = (_p: V3, uv: UV) => 0.45 + 0.55 * sstep(0.31, 0.24, rows[uv[0]][1]);
  const specR: Spec = {
    part: QUINLAN_PARTS.legR,
    pivot: QUINLAN_JOINTS.hipR,
    weight,
    paint: (p) => {
      const k = sstep(0.1, 0.06, p[1]);
      const c = mixc(PAL.fur, PAL.paw, k);
      return [c[0], c[1], c[2], 1 - 0.5 * k];
    },
  };
  const specL: Spec = { ...specR, part: QUINLAN_PARTS.legL, pivot: QUINLAN_JOINTS.hipL };
  B.add(leg, specR);
  B.add(mirrorX(leg), specL);
  // big flat paddle feet
  const foot = ellipsoid(FOOT_C, FOOT_R, hi ? 10 : 6, hi ? 5 : 3, [Math.PI / 2, FOOT_YAW, 0]);
  const footPaint = (p: V3, n: V3): Paint => {
    const c = mixc(PAL.paw, PAL.furDark, 0.35 * sstep(0.3, 0.9, n[1]));
    return [c[0], c[1], c[2], 0.5];
  };
  B.add(foot, { ...specR, weight: undefined, paint: footPaint });
  B.add(mirrorX(foot), { ...specL, weight: undefined, paint: footPaint });
  if (hi) {
    const R = euler([0, FOOT_YAW, 0]);
    for (const dx of [-0.036, 0, 0.036]) {
      const toe = ellipsoid(add(FOOT_C, R([dx, -0.004, -0.098 + Math.abs(dx) * 0.35])), [0.02, 0.018, 0.024], 6, 3);
      B.add(toe, { ...specR, weight: undefined, paint: solid(PAL.paw, 0.5) });
      B.add(mirrorX(toe), { ...specL, weight: undefined, paint: solid(PAL.paw, 0.5) });
    }
  }
}

function buildTail(B: Builder, hi: boolean) {
  const seg = hi ? 14 : 6;
  const rows = pick(TAIL, hi, TAIL_LOW);
  const centers = rows.map((r) => [0, r[0], r[1]] as V3);
  const radii = rows.map((r) => [r[2], r[3], r[4]] as [number, number, number]);
  const rings = pathRings(centers, radii, [1, 0, 0], rows.map((r) => r[2] === 0));
  B.add(loft(rings, seg), {
    part: QUINLAN_PARTS.tail,
    pivot: QUINLAN_JOINTS.tail,
    weight: (_p, uv) => 0.2 + 0.8 * sstep(0.12, 0.26, rows[uv[0]][1]),
    paint: (p, _n, uv) => {
      // furred base, then a leathery paddle with a cross-hatched scale pattern
      const leather = sstep(0.24, 0.33, p[2]);
      const checker = (uv[0] + uv[1]) % 2 === 0 ? 1 : 0;
      const scale = mixc(PAL.tail, PAL.tailDark, 0.55 * checker * sstep(0.3, 0.4, p[2]));
      const c = mixc(PAL.fur, scale, leather);
      return [c[0], c[1], c[2], 1 - 0.6 * leather];
    },
  });
}

function buildAccents(B: Builder, hi: boolean, torsoRows: number[][]) {
  const body = { part: QUINLAN_PARTS.body, pivot: QUINLAN_JOINTS.hip };
  // Woven sash from the left shoulder across the belly to the right hip.
  const seg = hi ? 16 : 8;
  const slope = -1.25; // y = y0 + slope * x
  const y0 = 0.62;
  const bands = hi ? [-1, -0.72, -0.5, 0, 0.5, 0.72, 1] : [-1, 0, 1];
  const halfW = 0.036;
  const p: V3[] = [];
  const uv: UV[] = [];
  for (let k = 0; k < seg; k++) {
    const th = (k / seg) * TAU;
    let yc = y0;
    for (let it = 0; it < 8; it++) yc = y0 + slope * torsoPoint(torsoRows, th, yc)[0];
    bands.forEach((b, j) => {
      const y = yc + b * halfW;
      const sp = torsoPoint(torsoRows, th, y);
      const n = torsoNormal(torsoRows, th, y);
      const lift = (hi ? 0.004 : 0.008) + (hi ? 0.006 : 0.008) * (1 - b * b);
      p.push(add(sp, mul(n, lift)));
      uv.push([j, k]);
    });
  }
  const nb = bands.length;
  const t: number[] = [];
  for (let k = 0; k < seg; k++) {
    const k1 = (k + 1) % seg;
    for (let j = 0; j + 1 < nb; j++) {
      const a = k * nb + j, b = k1 * nb + j, c = k1 * nb + j + 1, d = k * nb + j + 1;
      const inside: V3 = [0, (p[a][1] + p[c][1]) / 2, 0.01];
      tri(t, p, a, b, c, inside);
      tri(t, p, a, c, d, inside);
    }
  }
  B.add(
    { p, t, uv },
    {
      ...body,
      tag: 1,
      paint: (_p, _n, q) => {
        const trim = hi && Math.abs(bands[q[0]]) > 0.6;
        const c = trim ? PAL.gold : PAL.accent;
        return [c[0], c[1], c[2], 0];
      },
    },
  );
  // Bead necklace with a gold pendant.
  const beads = hi ? 9 : 0;
  for (let i = 0; i < beads; i++) {
    const f = i / (beads - 1);
    const th = Math.PI * (1.08 + 0.84 * f); // across the front (sin < 0)
    const y = 0.868 + 0.032 * Math.sin(th);
    const sp = torsoPoint(torsoRows, th, y);
    const n = torsoNormal(torsoRows, th, y);
    const c = add(sp, mul(n, 0.012));
    B.add(octa(c, [0.014, 0.014, 0.014], [0, th, 0]), {
      ...body,
      flat: true,
      paint: solid(i % 2 === 0 ? PAL.turquoise : PAL.gold),
    });
  }
  const pth = Math.PI * 1.5;
  const py = hi ? 0.826 : 0.83;
  const ps = torsoPoint(torsoRows, pth, py);
  const pn = torsoNormal(torsoRows, pth, py);
  B.add(disc(add(ps, mul(pn, 0.012)), add(pn, [0, 0.35, 0]), hi ? 0.028 : 0.032, 0.006, hi ? 6 : 4), {
    ...body,
    flat: true,
    paint: solid(PAL.gold),
  });
}

/**
 * Build the Quinlan geometry (rest pose, indexed). 'high' ~2.5k triangles for close
 * NPCs / the player's shadow / photo mode, 'low' ~0.6k for crowds.
 * Add a per-instance `aAnim` attribute (see createQuinlanInstancedGeometry).
 */
export function createQuinlanGeometry(detail: 'high' | 'low'): BufferGeometry {
  const hi = detail === 'high';
  const B = new Builder();
  const torsoRows = pick(TORSO, hi, TORSO_LOW);
  buildTorso(B, hi, torsoRows);
  buildHead(B, hi);
  buildJaw(B, hi);
  buildArms(B, hi, torsoRows);
  buildLegs(B, hi);
  buildTail(B, hi);
  buildAccents(B, hi, torsoRows);
  const g = B.finish();
  g.name = `quinlan-${detail}`;
  return g;
}

/** Per-instance aAnim attribute (gait, phase, cadence, variant), dynamic usage. */
export function createQuinlanAnimAttribute(count: number): InstancedBufferAttribute {
  const a = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
  for (let i = 0; i < count; i++) a.setXYZW(i, 0, (i * 0.618034) % 1, 1, (i * 0.381966 + 0.2) % 1);
  a.setUsage(DynamicDrawUsage);
  return a;
}

/**
 * A geometry for one InstancedMesh: shares the base buffers and index of `base`
 * (from createQuinlanGeometry) and adds its own `aAnim` instanced attribute.
 */
export function createQuinlanInstancedGeometry(base: BufferGeometry, count: number): BufferGeometry {
  const g = new BufferGeometry();
  for (const name of ['position', 'normal', 'color', 'aPart', 'aPivot', 'aSkin']) g.setAttribute(name, base.getAttribute(name));
  g.setIndex(base.getIndex());
  g.boundingBox = base.boundingBox;
  g.boundingSphere = base.boundingSphere;
  g.setAttribute('aAnim', createQuinlanAnimAttribute(count));
  g.userData = { ...base.userData };
  return g;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const f = (x: number) => {
  const s = x.toFixed(5);
  return s.includes('.') ? s : `${s}.0`;
};
const v3 = (v: V3) => `vec3(${f(v[0])}, ${f(v[1])}, ${f(v[2])})`;
const accentsGlsl = ACCENTS_SRGB.map((h) => {
  const c = lin(h);
  return v3(c);
}).join(',\n    ');
const accentLum = (PAL.accent[0] + PAL.accent[1] + PAL.accent[2]) / 3;

/**
 * Vertex-shader declarations: attributes (aPart, aPivot, aSkin, instanced aAnim),
 * constants and functions. Inject after `#include <common>`. Does NOT declare
 * `uniform float uTime;` (the host does). Safe to include once per shader.
 *
 * Also usable from a custom ShaderMaterial: call
 *   quinlanAnimate(inout vec3 position, inout vec3 normal)
 * and optionally quinlanColor(vec3 vertexColor) for the per-instance tints.
 */
export const quinlanAnimParsGlsl = /* glsl */ `
#ifndef QUINLAN_ANIM_PARS
#define QUINLAN_ANIM_PARS
attribute float aPart;
attribute vec3 aPivot;
attribute vec3 aSkin;
attribute vec4 aAnim;

// Materials whose vertex shader derives normals (objectNormal / transformedNormal / vNormal).
#if defined( QUINLAN_ANIM_NORMALS ) || defined( LAMBERT ) || defined( PHONG ) || defined( STANDARD ) || defined( TOON ) || defined( MATCAP ) || defined( NORMAL )
  #define QUINLAN_HAS_NORMALS
#endif
#ifndef QUINLAN_NORMAL_MATRIX
  #ifdef HR_BEND
    #define QUINLAN_NORMAL_MATRIX mat3( viewMatrix )
  #else
    #define QUINLAN_NORMAL_MATRIX normalMatrix
  #endif
#endif

const float Q_PI = 3.14159265;
const float Q_TAU = 6.28318531;
const vec3 Q_HIP = ${v3(QUINLAN_JOINTS.hip)};
const vec3 Q_SPINE = ${v3(QUINLAN_JOINTS.spine)};
const vec3 Q_NECK = ${v3(QUINLAN_JOINTS.neck)};
const vec3 Q_EYE = ${v3(EYE_R)};
const float Q_ACCENT_LUM = ${f(accentLum)};
const vec3 Q_ACCENTS[${ACCENTS_SRGB.length}] = vec3[${ACCENTS_SRGB.length}](
    ${accentsGlsl}
);

mat3 qRotX( float a ) { float c = cos( a ), s = sin( a ); return mat3( 1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c ); }
mat3 qRotY( float a ) { float c = cos( a ), s = sin( a ); return mat3( c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c ); }
mat3 qRotZ( float a ) { float c = cos( a ), s = sin( a ); return mat3( c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0 ); }
// x = pitch (+ tips the top backwards / swings a hanging limb forwards),
// y = yaw (+ turns the snout towards -X), z = roll (+ raises the +X side).
mat3 qEuler( vec3 e ) { return qRotY( e.y ) * qRotX( e.x ) * qRotZ( e.z ); }
float qHash( float n ) { return fract( sin( n ) * 43758.5453 ); }

struct QPose {
  vec3 rootT;  // whole-body translation (applied last)
  vec3 root;   // whole-body rotation about Q_HIP
  vec3 spine;  // upper-body bend about Q_SPINE (weighted by rest height)
  vec3 head;   // about the neck
  vec3 jaw;    // x open (rad), y sideways shift (m), z sideways yaw (rad)
  vec3 armL;
  vec3 armR;
  vec3 legL;
  vec3 legR;
  vec4 lift;   // limb lift (m) before rotation: legL, legR, armL, armR
  vec3 tail;   // about the tail base
  vec3 wave;   // tail undulation: amplitude at the tip (m), phase (rad), wavenumber
  vec2 face;   // x breathing (-1..1), y eye openness (0..1)
};

float qBlink( float t, float ph ) {
  float e = fract( t * 0.21 + ph * 3.7 );
  return 0.08 + 0.92 * smoothstep( 0.0, 0.035, abs( e - 0.035 ) );
}

QPose qRest( float v ) {
  QPose P;
  P.rootT = vec3( 0.0 );
  P.root = vec3( 0.0 );
  P.spine = vec3( ( fract( v * 5.71 + 0.3 ) - 0.5 ) * 0.08, 0.0, 0.0 );
  P.head = vec3( ( fract( v * 7.31 + 0.13 ) - 0.5 ) * 0.12, 0.0, ( fract( v * 13.17 + 0.41 ) - 0.5 ) * 0.18 );
  P.jaw = vec3( 0.0 );
  float ab = ( fract( v * 5.23 + 0.7 ) - 0.5 ) * 0.12;
  P.armL = vec3( 0.0, 0.0, -ab );
  P.armR = vec3( 0.0, 0.0, ab );
  P.legL = vec3( 0.0 );
  P.legR = vec3( 0.0 );
  P.lift = vec4( 0.0 );
  P.tail = vec3( 0.0 );
  P.wave = vec3( 0.0, 0.0, 1.0 );
  P.face = vec2( 0.0, 1.0 );
  return P;
}

QPose qIdle( float t, float ph, float v ) {
  QPose P = qRest( v );
  float b = sin( Q_TAU * ( t * 0.23 + ph ) );
  P.face.x = b;
  P.spine.x -= 0.02 * b;
  P.armL.z -= 0.03 * b;
  P.armR.z += 0.03 * b;
  P.head.x += 0.02 * b;
  // look around now and then (the side eyes see most things anyway)
  float tt = t * 0.26 + ph * 5.0;
  float k = floor( tt );
  float s = smoothstep( 0.0, 0.2, fract( tt ) );
  float hA = qHash( k * 1.37 + ph * 91.7 ), hB = qHash( ( k - 1.0 ) * 1.37 + ph * 91.7 );
  float yA = hA < 0.4 ? 0.0 : ( hA - 0.7 ) * 2.4;
  float yB = hB < 0.4 ? 0.0 : ( hB - 0.7 ) * 2.4;
  float yaw = mix( yB, yA, s );
  P.head.y += yaw;
  P.spine.y += 0.15 * yaw;
  P.head.z += mix( qHash( ( k - 1.0 ) * 2.71 + ph * 37.3 ), qHash( k * 2.71 + ph * 37.3 ), s ) * 0.3 - 0.15;
  P.root.z += 0.02 * sin( Q_TAU * ( t * 0.11 + ph * 2.0 ) );
  P.tail.y += 0.1 * sin( Q_TAU * ( t * 0.17 + ph * 3.0 ) );
  P.face.y = qBlink( t, ph );
  return P;
}

QPose qWalk( float t, float ph, float v ) {
  QPose P = qRest( v );
  float a = Q_TAU * ( t * 2.3 + ph );
  float s = sin( a ), c = cos( a );
  float sw = 0.52;
  P.legL.x = sw * s;
  P.legR.x = -sw * s;
  P.lift.xy = vec2( max( c, 0.0 ), max( -c, 0.0 ) ) * 0.045;
  // waddle: roll onto the stance leg, lifting the swinging hip
  P.root.z = -0.08 * c;
  P.legL.z = 0.08 * c;
  P.legR.z = 0.08 * c;
  P.root.y = 0.08 * s;
  P.spine.y = -0.14 * s;
  P.spine.x += -0.12 + 0.025 * cos( 2.0 * a );
  P.rootT.y = -0.24 * ( 1.0 - cos( sw * s ) );
  P.armL.x = -0.45 * s;
  P.armR.x = 0.45 * s;
  P.armL.z -= 0.05;
  P.armR.z += 0.05;
  P.head.x += 0.12 - 0.03 * cos( 2.0 * a );
  P.head.z += 0.07 * c;
  P.head.y += 0.05 * s;
  P.tail.y = 0.22 * sin( a - 0.9 );
  P.tail.x = -0.12 + 0.04 * cos( 2.0 * a );
  P.face.y = qBlink( t, ph );
  return P;
}

QPose qRun( float t, float ph, float v ) {
  // bounding gallop on all fours: fore paws (arms) together, hind paws together
  QPose P = qRest( v );
  float a = Q_TAU * ( t * 2.6 + ph );
  float s = sin( a );
  float pitch = -1.22 + 0.12 * s;
  P.root.x = pitch;
  P.rootT.y = 0.04 * max( 0.0, sin( a + 0.8 ) ) - 0.015;
  P.spine.x = 0.1 * sin( a + 0.5 );
  float fore = -( pitch + P.spine.x );
  P.armL = vec3( fore + 0.65 * sin( a + 2.9 ), 0.0, 0.34 );
  P.armR = vec3( fore + 0.65 * sin( a + 3.3 ), 0.0, -0.34 );
  P.legL = vec3( -pitch + 0.6 * sin( a ), 0.0, 0.0 );
  P.legR = vec3( -pitch + 0.6 * sin( a + 0.4 ), 0.0, 0.0 );
  P.lift = vec4( max( cos( a ), 0.0 ), max( cos( a + 0.4 ), 0.0 ), max( cos( a + 2.9 ), 0.0 ), max( cos( a + 3.3 ), 0.0 ) ) * 0.06;
  P.head.x += fore - 0.3 + 0.06 * sin( a + 1.0 );
  P.tail = vec3( -pitch * 0.92 + 0.18 * sin( a - 1.2 ), 0.05 * sin( a ), 0.0 );
  P.wave = vec3( 0.05, a - 1.0, 1.0 );
  P.jaw.x = 0.1 + 0.05 * sin( 2.0 * a );
  P.face.y = qBlink( t, ph );
  return P;
}

QPose qSwim( float t, float ph, float v ) {
  // prone at the surface (origin = waterline): dog-paddle arms, kicking legs, undulating tail
  QPose P = qRest( v );
  float a = Q_TAU * ( t * 1.1 + ph );
  float s = sin( a ), c = cos( a );
  P.root = vec3( -1.46, 0.0, 0.12 * s );
  P.rootT = vec3( 0.0, -0.46 + 0.02 * sin( 2.0 * a ), 0.0 );
  P.spine.x = 0.06 * sin( a + 1.3 );
  P.head = vec3( 1.28 + 0.05 * sin( 2.0 * a + 0.5 ), 0.0, -0.1 * s );
  P.armL = vec3( 1.45 + 0.95 * s, 0.0, -( 0.35 + 0.3 * c ) );
  P.armR = vec3( 1.45 - 0.95 * s, 0.0, 0.35 - 0.3 * c );
  P.legL = vec3( -0.15 + 0.38 * sin( a + 0.6 ), 0.0, -0.1 );
  P.legR = vec3( -0.15 - 0.38 * sin( a + 0.6 ), 0.0, 0.1 );
  P.tail = vec3( 1.4 + 0.1 * sin( a - 0.7 ), 0.0, 0.0 );
  P.wave = vec3( 0.11, 2.0 * a, 1.2 );
  P.face.y = qBlink( t, ph );
  return P;
}

QPose qSing( float t, float ph, float v ) {
  // sitting on the tail root, legs out in front, arms spread (webbing shows), swaying
  QPose P = qRest( v );
  float a = Q_TAU * ( t * 0.45 + ph );
  float s = sin( a );
  P.rootT.y = -0.15;
  P.root = vec3( 0.1, 0.0, 0.08 * s );
  P.spine = vec3( 0.04 * sin( 2.0 * a ), 0.05 * sin( a + 0.8 ), 0.05 * sin( a - 0.6 ) );
  P.legL = vec3( 1.28, 0.28, -0.2 );
  P.legR = vec3( 1.28, -0.28, 0.2 );
  P.tail = vec3( -0.3, 0.1 * s, 0.0 );
  float g = 0.5 + 0.5 * sin( 2.0 * a + 0.4 );
  P.armL = vec3( 0.5 + 0.25 * g, 0.2, -( 0.5 + 0.15 * g ) );
  P.armR = vec3( 0.5 + 0.25 * g, -0.2, 0.5 + 0.15 * g );
  P.head = vec3( 0.3 + 0.05 * sin( 2.0 * a ), 0.1 * sin( a + 0.4 ), P.head.z - 0.7 * P.root.z );
  float n = sin( Q_TAU * ( t * 1.9 + ph ) );
  float phr = fract( t * 0.21 + ph * 1.7 );
  float on = smoothstep( 0.0, 0.06, phr ) * ( 1.0 - smoothstep( 0.84, 0.92, phr ) );
  P.jaw.x = 0.03 + on * ( 0.16 + 0.2 * ( 0.5 + 0.5 * n ) );
  P.face.y = 0.55 + 0.45 * ( 1.0 - on );
  return P;
}

QPose qSmile( float t, float ph, float v ) {
  // the Quinlan smile: rubbing the jaw back and forth sideways
  QPose P = qIdle( t, ph, v );
  P.head.y *= 0.3;
  float r = Q_TAU * ( t * 2.4 + ph );
  P.jaw = vec3( 0.06, 0.02 * sin( r ), 0.12 * sin( r ) );
  P.head.x += 0.1;
  P.head.z += 0.1 * sin( Q_TAU * ( t * 0.55 + ph ) );
  P.armL = vec3( 0.55, -0.25, 0.28 );
  P.armR = vec3( 0.55, 0.25, -0.28 );
  P.tail.y = 0.25 * sin( Q_TAU * ( t * 1.3 + ph ) );
  P.rootT.y = 0.01 * abs( sin( r * 0.5 ) );
  P.face.y = min( P.face.y, 0.62 );
  return P;
}

QPose qPoseFor( float g, float t, float ph, float v ) {
  if ( g < 0.5 ) return qIdle( t, ph, v );
  if ( g < 1.5 ) return qWalk( t, ph, v );
  if ( g < 2.5 ) return qRun( t, ph, v );
  if ( g < 3.5 ) return qSwim( t, ph, v );
  if ( g < 4.5 ) return qSing( t, ph, v );
  return qSmile( t, ph, v );
}

QPose qMixPose( QPose a, QPose b, float k ) {
  QPose r;
  r.rootT = mix( a.rootT, b.rootT, k );
  r.root = mix( a.root, b.root, k );
  r.spine = mix( a.spine, b.spine, k );
  r.head = mix( a.head, b.head, k );
  r.jaw = mix( a.jaw, b.jaw, k );
  r.armL = mix( a.armL, b.armL, k );
  r.armR = mix( a.armR, b.armR, k );
  r.legL = mix( a.legL, b.legL, k );
  r.legR = mix( a.legR, b.legR, k );
  r.lift = mix( a.lift, b.lift, k );
  r.tail = mix( a.tail, b.tail, k );
  r.wave = mix( a.wave, b.wave, k );
  r.face = mix( a.face, b.face, k );
  return r;
}

void qApply( QPose P, float v, inout vec3 p, inout vec3 n ) {
  int part = int( aPart + 0.5 );
  float w = aSkin.x;
  vec3 piv = aPivot;
  vec3 r0 = p;
  float ws = smoothstep( 0.36, 0.74, r0.y );
  float spineW = 0.0;
  mat3 M;
  // variant proportions: belly, head size, tail length; plus breathing
  float belly = smoothstep( 0.12, 0.3, r0.y ) * ( 1.0 - smoothstep( 0.55, 0.82, r0.y ) );
  float chest = smoothstep( 0.42, 0.6, r0.y ) * ( 1.0 - smoothstep( 0.78, 0.92, r0.y ) );
  float bodyScale = 1.0 + ( fract( v * 3.71 + 0.29 ) - 0.5 ) * 0.12 * belly + 0.016 * P.face.x * chest;
  if ( part == 0 ) {
    p.xz *= bodyScale;
    float nk = smoothstep( 0.83, 0.97, r0.y ); // the neck follows the head a little
    if ( nk > 0.0 ) {
      M = qEuler( P.head * 0.5 * nk );
      p = Q_NECK + M * ( p - Q_NECK );
      n = M * n;
    }
    spineW = ws;
  } else if ( part <= 2 ) {
    if ( part == 2 ) {
      M = qRotY( P.jaw.z * w ) * qRotX( -P.jaw.x * w );
      p = piv + M * ( p - piv );
      n = M * n;
      p.x += P.jaw.y * w;
    } else if ( aSkin.z > 1.5 ) {
      // eyes: blink / squint by squashing towards the eye's horizontal plane
      vec3 ec = vec3( sign( r0.x ) * Q_EYE.x, Q_EYE.yz );
      float o = max( P.face.y, 0.06 );
      p.y = ec.y + ( p.y - ec.y ) * o;
      n = normalize( vec3( n.x, n.y / max( o, 0.25 ), n.z ) );
      if ( aSkin.z > 2.5 ) p = ec + ( p - ec ) * smoothstep( 0.2, 0.6, o );
    }
    float hs = 1.0 + ( fract( v * 9.13 + 0.61 ) - 0.5 ) * 0.08;
    p = Q_NECK + ( p - Q_NECK ) * hs;
    M = qEuler( P.head * ( part == 1 ? w : 1.0 ) );
    p = Q_NECK + M * ( p - Q_NECK );
    n = M * n;
    spineW = 1.0;
  } else if ( part <= 4 ) {
    bool left = part == 3;
    p.xz *= mix( bodyScale, 1.0, w ); // the torso edge of the webbing stays on the torso
    p.y += ( left ? P.lift.z : P.lift.w ) * w;
    M = qEuler( ( left ? P.armL : P.armR ) * w );
    p = piv + M * ( p - piv );
    n = M * n;
    spineW = mix( ws, 1.0, w );
  } else if ( part <= 6 ) {
    bool left = part == 5;
    p.y += ( left ? P.lift.x : P.lift.y ) * w;
    M = qEuler( ( left ? P.legL : P.legR ) * w );
    p = piv + M * ( p - piv );
    n = M * n;
  } else {
    vec3 d = p - piv;
    d.z *= 1.0 + ( fract( v * 17.3 + 0.17 ) - 0.5 ) * 0.16;
    float s = max( d.z, 0.0 ) * 1.6;
    float wph = P.wave.y - P.wave.z * s * 3.0;
    float dy = P.wave.x * s * s * sin( wph );
    float slope = P.wave.x * ( 2.0 * s * sin( wph ) - s * s * P.wave.z * 3.0 * cos( wph ) ) * 1.6;
    d.y += dy * w;
    n = qRotX( -atan( slope * w ) ) * n;
    M = qEuler( P.tail * w );
    p = piv + M * d;
    n = M * n;
  }
  M = qEuler( P.spine * spineW );
  p = Q_SPINE + M * ( p - Q_SPINE );
  n = M * n;
  M = qEuler( P.root );
  p = Q_HIP + M * ( p - Q_HIP ) + P.rootT;
  n = normalize( M * n );
}

/** Animate a rest-pose vertex in place (model space). Uses uTime and aAnim. */
void quinlanAnimate( inout vec3 p, inout vec3 n ) {
  float g = clamp( aAnim.x, 0.0, 5.0 );
  float t = uTime * aAnim.z;
  float g0 = floor( g );
  QPose P = qPoseFor( g0, t, aAnim.y, aAnim.w );
  float gf = g - g0;
  if ( gf > 0.001 ) P = qMixPose( P, qPoseFor( g0 + 1.0, t, aAnim.y, aAnim.w ), gf );
  qApply( P, aAnim.w, p, n );
}

vec3 qAccent( float v ) {
  int i = int( floor( fract( v * 7.919 + 0.123 ) * ${f(ACCENTS_SRGB.length)} ) );
  return Q_ACCENTS[ clamp( i, 0, ${ACCENTS_SRGB.length - 1} ) ];
}

/** Final vertex colour: instanceColor tints fur only; clothing takes the variant's dye. */
vec3 quinlanColor( vec3 c ) {
  #ifdef USE_INSTANCING_COLOR
    c *= mix( vec3( 1.0 ), instanceColor.rgb, aSkin.y );
  #endif
  float acc = 1.0 - step( 0.5, abs( aSkin.z - 1.0 ) );
  return mix( c, qAccent( aAnim.w ) * ( dot( c, vec3( 0.33333 ) ) / Q_ACCENT_LUM ), acc );
}
#endif
`;

/**
 * Vertex-shader statements. Inject right after `#include <begin_vertex>`.
 * Animates `transformed` and `objectNormal`; because three.js derives
 * `transformedNormal` / `vNormal` before begin_vertex, it re-derives them here
 * (mirroring defaultnormal_vertex, using mat3(viewMatrix) when HR_BEND is defined,
 * or QUINLAN_NORMAL_MATRIX if you define it). Normal work is skipped in depth /
 * distance materials, so the same snippet serves shadow materials.
 * With vertexColors enabled it also rewrites vColor (instanceColor tints fur only).
 */
export const quinlanAnimGlsl = /* glsl */ `
{
  vec3 qNrm = vec3( 0.0, 1.0, 0.0 );
  #ifdef QUINLAN_HAS_NORMALS
    qNrm = objectNormal;
  #endif
  quinlanAnimate( transformed, qNrm );
  #ifdef QUINLAN_HAS_NORMALS
    objectNormal = qNrm;
    transformedNormal = qNrm;
    #ifdef USE_BATCHING
      mat3 qBm = mat3( batchingMatrix );
      transformedNormal /= vec3( dot( qBm[ 0 ], qBm[ 0 ] ), dot( qBm[ 1 ], qBm[ 1 ] ), dot( qBm[ 2 ], qBm[ 2 ] ) );
      transformedNormal = qBm * transformedNormal;
    #endif
    #ifdef USE_INSTANCING
      mat3 qIm = mat3( instanceMatrix );
      transformedNormal /= vec3( dot( qIm[ 0 ], qIm[ 0 ] ), dot( qIm[ 1 ], qIm[ 1 ] ), dot( qIm[ 2 ], qIm[ 2 ] ) );
      transformedNormal = qIm * transformedNormal;
    #endif
    transformedNormal = QUINLAN_NORMAL_MATRIX * transformedNormal;
    #ifdef FLIP_SIDED
      transformedNormal = - transformedNormal;
    #endif
    #ifndef FLAT_SHADED
      vNormal = normalize( transformedNormal );
    #endif
  #endif
  #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
    vColor.rgb = quinlanColor( vec3( color.rgb ) );
  #endif
}
`;

/**
 * Patch a built-in vertex shader source (from onBeforeCompile) with the Quinlan
 * animation. Set declareTime = false if the host already declares uTime.
 */
export function patchQuinlanVertexShader(vertexShader: string, declareTime = true): string {
  return vertexShader
    .replace('#include <common>', `#include <common>\n${declareTime ? 'uniform float uTime;\n' : ''}${quinlanAnimParsGlsl}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${quinlanAnimGlsl}`);
}

export interface QuinlanTimeUniform {
  value: number;
}

/**
 * Stand-alone test material: MeshStandardMaterial with vertex colours and the
 * Quinlan animation. Drive `uTime.value` (seconds). The uniform object is also
 * stored in material.userData.uTime.
 */
export function createQuinlanPreviewMaterial(
  uTime: QuinlanTimeUniform = { value: 0 },
  params: MeshStandardMaterialParameters = {},
): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, ...params });
  m.userData.uTime = uTime;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = patchQuinlanVertexShader(shader.vertexShader);
  };
  m.customProgramCacheKey = () => 'quinlan-preview';
  return m;
}

/** Matching shadow-map depth material (assign to mesh.customDepthMaterial). */
export function createQuinlanDepthMaterial(uTime: QuinlanTimeUniform = { value: 0 }): MeshDepthMaterial {
  const m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = patchQuinlanVertexShader(shader.vertexShader);
  };
  m.customProgramCacheKey = () => 'quinlan-depth';
  return m;
}
