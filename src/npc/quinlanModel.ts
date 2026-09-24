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
//   The host declares `uniform float uTime;` (seconds; float32, so wrap it every
//   hour or so to keep the cycles smooth). Needs `vertexColors: true` for the
//   colours; instanceColor (see quinlanFurPalette) tints the fur only.
//   Fractional gaits cross-fade between adjacent indices only (idle-walk-run-swim
//   make sense; switch other pairs directly).

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

export type V3 = [number, number, number];

/** Joint pivots (model space, metres). L = -X side, R = +X side. */
export const QUINLAN_JOINTS = {
  hip: [0, 0.3, 0] as V3, // root / whole-body pitch pivot
  spine: [0, 0.5, 0] as V3, // upper-body bend pivot
  neck: [0, 0.9, 0.02] as V3,
  jaw: [0, 0.955, -0.035] as V3,
  shoulderL: [-0.18, 0.772, 0] as V3,
  shoulderR: [0.18, 0.772, 0] as V3,
  elbowL: [-0.314, 0.592, -0.018] as V3, // derived from rest height in the shader (no attribute)
  elbowR: [0.314, 0.592, -0.018] as V3,
  hipL: [-0.112, 0.295, 0] as V3,
  hipR: [0.112, 0.295, 0] as V3,
  tail: [0, 0.25, 0.14] as V3,
};
const EYE_R: V3 = [0.138, 1.07, -0.035];

/** Joints of a rigged mesh model (right side; the left mirrors X), from its asset file. */
export interface QuinlanRigInfo {
  joints: { hip: V3; spine: V3; neck: V3; jaw: V3; shoulder: V3; elbow: V3; legHip: V3; tail: V3; eye: V3 };
  /** How the poses adapt to this body (radians, metres). */
  pose?: Partial<QuinlanRigPose>;
}

export interface QuinlanRigPose {
  /** How far the body already leans forward at rest, compared with the procedural one. */
  lean: number;
  /** How much higher the tail rises at rest. */
  tailUp: number;
  /** Lift while galloping on all fours. */
  runY: number;
  /** Extra height while swimming (negative = deeper). */
  swimY: number;
  /** Extra lean back while sitting. */
  sitBack: number;
  /** Scale of the jaw movements. */
  jaw: number;
}

const RIG_POSE_DEFAULTS: QuinlanRigPose = { lean: 0, tailUp: 0, runY: 0, swimY: 0, sitBack: 0, jaw: 1 };
const EYE_RADIUS = 0.05;

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
  beak: lin(0x664b3a),
  nose: lin(0x2a1b15),
  mouth: lin(0x5a2226),
  tongue: lin(0xb5585a),
  teeth: lin(0xf3ecd9),
  eye: lin(0x140e0b),
  shine: lin(0xffffff),
  web: lin(0xae8570),
  paw: lin(0x533829),
  tail: lin(0x55423a),
  tailDark: lin(0x3c2e27),
  earIn: lin(0xa27463),
  accent: lin(0xb4452c),
  gold: lin(0xd8a73a),
  turquoise: lin(0x2d9d94),
};

/** Clothing accent dyes (madder, woad, weld, green, terracotta, purple, teal, oat). */
const ACCENTS_SRGB = [0xb4452c, 0x2f5f92, 0xcf9a2c, 0x3f7c4a, 0xc2683a, 0x6d4a7e, 0x2c8a86, 0xdccfae];

/** Same hash as GLSL qH(v, k): decorrelated 0..1 values from one variant number. */
export function quinlanVariantHash(variant: number, channel: number): number {
  const x = Math.sin(variant * 78.233 + channel * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Per-instance fur tint for InstancedMesh.setColorAt(). The Quinlan shader applies
 * instanceColor to fur only (eyes, teeth and clothes keep their colours), so this is
 * a multiplier around white. variant 0..1 picks and blends a fur tone.
 */
export function quinlanFurPalette(variant: number, target = new Color()): Color {
  const tones: V3[] = [
    [1.0, 1.0, 1.0], // chestnut (base)
    [0.58, 0.52, 0.5], // chocolate
    [1.5, 1.28, 0.82], // golden
    [0.9, 0.98, 1.12], // ash brown
    [1.34, 0.86, 0.64], // russet
    [1.7, 1.55, 1.2], // sandy
    [0.42, 0.38, 0.37], // near black
    [1.22, 1.08, 0.88], // tawny
  ];
  const f = quinlanVariantHash(variant, 0) * tones.length;
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

/** Box with half extents r, rotated by euler `rot` (flat-shaded use). */
function box(c: V3, r: V3, rot: V3 = [0, 0, 0]): Prim {
  const R = euler(rot);
  const p: V3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) p.push(add(c, R([x * r[0], y * r[1], z * r[2]])));
  const t: number[] = [];
  const quads = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  for (const q of quads) {
    tri(t, p, q[0], q[1], q[2], c);
    tri(t, p, q[0], q[2], q[3], c);
  }
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
  tag?: number | ((uv: UV) => number);
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
    const tag = typeof s.tag === 'function' ? s.tag(uv) : (s.tag ?? 0);
    this.skin.push(s.weight ? clamp01(s.weight(p, uv)) : 1, c[3], tag);
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
  [0.865, 0.022, 0.13, 0.112, 0.118],
  [0.92, 0.022, 0.108, 0.1, 0.102],
  [0.965, 0.022, 0, 0, 0],
];
const TORSO_LOW = [0, 1, 3, 5, 7, 9, 11, 12];

// Head rings (perpendicular to Z, snout towards -Z): [z, cy, rx, ryTop, ryBottom]
const HEAD: number[][] = [
  [0.17, 1.035, 0, 0, 0],
  [0.155, 1.035, 0.075, 0.075, 0.07],
  [0.125, 1.038, 0.128, 0.122, 0.11],
  [0.078, 1.04, 0.158, 0.143, 0.128],
  [0.02, 1.04, 0.166, 0.148, 0.132],
  [-0.04, 1.034, 0.158, 0.138, 0.118],
  [-0.085, 1.02, 0.14, 0.115, 0.075], // brow "stop" and mouth corners
  [-0.115, 1.0, 0.122, 0.09, 0.055],
  [-0.15, 0.99, 0.106, 0.078, 0.05],
  [-0.184, 0.984, 0.093, 0.071, 0.048],
  [-0.211, 0.98, 0.079, 0.063, 0.044],
  [-0.228, 0.978, 0.061, 0.047, 0.038],
  [-0.238, 0.975, 0.039, 0.025, 0.025],
  [-0.243, 0.975, 0, 0, 0],
];
const HEAD_LOW = [0, 2, 4, 6, 8, 10, 12, 13];

// Lower jaw rings: [z, cy, rx, ryTop, ryBottom]
const JAW: number[][] = [
  [-0.035, 0.955, 0, 0, 0],
  [-0.055, 0.95, 0.092, 0.03, 0.045],
  [-0.1, 0.94, 0.088, 0.028, 0.048],
  [-0.14, 0.934, 0.078, 0.026, 0.043],
  [-0.178, 0.93, 0.065, 0.024, 0.036],
  [-0.205, 0.93, 0.048, 0.02, 0.027],
  [-0.222, 0.932, 0, 0, 0],
];
const JAW_LOW = [0, 1, 3, 5, 6];

// Right arm path: [x, y, z, a (front-back), b (lateral)]; mirrored for the left.
const ARM: number[][] = [
  [0.168, 0.822, 0.004, 0, 0],
  [0.186, 0.795, 0.002, 0.056, 0.056],
  [0.214, 0.752, 0, 0.07, 0.068],
  [0.265, 0.672, -0.008, 0.065, 0.062],
  [0.314, 0.592, -0.018, 0.058, 0.056],
  [0.352, 0.514, -0.03, 0.052, 0.05],
  [0.378, 0.458, -0.04, 0.046, 0.044],
  [0.391, 0.421, -0.046, 0.056, 0.032],
  [0.4, 0.382, -0.05, 0.06, 0.03],
  [0.405, 0.35, -0.052, 0.044, 0.024],
  [0.407, 0.332, -0.052, 0, 0],
];
const ARM_LOW = [0, 2, 4, 7, 10];
const ARM_WRIST = 6;

// Right leg path: [x, y, z, r]
const LEG: number[][] = [
  [0.106, 0.335, 0, 0],
  [0.11, 0.305, 0, 0.068],
  [0.115, 0.262, -0.002, 0.088],
  [0.12, 0.19, -0.006, 0.086],
  [0.124, 0.125, -0.01, 0.072],
  [0.127, 0.078, -0.012, 0.058],
  [0.128, 0.048, -0.012, 0],
];
const LEG_LOW = [0, 2, 4, 6];
const FOOT_C: V3 = [0.136, 0.03, -0.055];
// local radii: x width, y length (rotated onto -Z/+Z), z height (rotated onto Y)
const FOOT_R: V3 = [0.066, 0.112, 0.03];
const FOOT_YAW = -0.18; // toes turned slightly outwards

// Tail path: [y, z, halfWidth, top, bottom]
const TAIL: number[][] = [
  [0.265, 0.095, 0, 0, 0],
  [0.262, 0.118, 0.072, 0.064, 0.064],
  [0.228, 0.195, 0.09, 0.054, 0.052],
  [0.165, 0.28, 0.118, 0.04, 0.037],
  [0.098, 0.37, 0.145, 0.031, 0.028],
  [0.06, 0.46, 0.16, 0.028, 0.025],
  [0.047, 0.55, 0.164, 0.027, 0.024],
  [0.044, 0.635, 0.152, 0.025, 0.022],
  [0.042, 0.705, 0.118, 0.021, 0.019],
  [0.041, 0.752, 0.064, 0.014, 0.012],
  [0.041, 0.772, 0, 0, 0],
];
const TAIL_LOW = [0, 1, 4, 7, 10];

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
      const front = sstep(-0.45, -0.8, n[2]) * sstep(0.17, 0.27, p[1]);
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
      const eyeRing = sstep(0.09, 0.06, Math.hypot(ex, ey, ez));
      c = mixc(c, PAL.belly, 0.45 * eyeRing);
      // the houra: a leathery, beak-like upper snout ...
      const beak = sstep(-0.1, -0.145, p[2]) * sstep(-0.55, -0.1, n[1]);
      c = mixc(c, PAL.beak, beak);
      fur -= 0.5 * beak;
      // ... with a dark palate underneath (seen when the mouth opens)
      const palate = sstep(-0.08, -0.115, p[2]) * sstep(-0.35, -0.7, n[1]);
      c = mixc(c, PAL.mouth, palate);
      fur *= 1 - palate;
      // dark nose leather on the tip
      const nose = sstep(-0.205, -0.222, p[2]) * sstep(-0.3, 0.2, n[1]);
      c = mixc(c, PAL.nose, nose);
      fur *= 1 - nose;
      return [c[0], c[1], c[2], clamp01(fur)];
    },
  });

  // nose pad on the tip of the houra
  if (hi) {
    B.add(ellipsoid([0, 1.018, -0.221], [0.036, 0.021, 0.027], 8, 4, [0.6, 0, 0]), { ...head, paint: solid(PAL.nose) });
  }

  // big eyes, wide on the sides of the head
  const eyeSeg = hi ? 10 : 5, eyeStacks = hi ? 6 : 3;
  const eye = ellipsoid(EYE_R, [EYE_RADIUS, EYE_RADIUS, EYE_RADIUS], eyeSeg, eyeStacks, [0, 0, Math.PI / 2]);
  B.add(eye, { ...head, paint: solid(PAL.eye), tag: 2 });
  B.add(mirrorX(eye), { ...head, paint: solid(PAL.eye), tag: 2 });
  if (hi) {
    const d = norm([0.62, 0.52, -0.58]);
    const shine = octa(add(EYE_R, mul(d, EYE_RADIUS * 0.93)), [0.013, 0.013, 0.013]);
    B.add(shine, { ...head, paint: solid(PAL.shine), tag: 3, flat: true });
    B.add(mirrorX(shine), { ...head, paint: solid(PAL.shine), tag: 3, flat: true });
  }

  // small rounded ears
  const ear = ellipsoid([0.108, 1.156, 0.06], [0.033, 0.038, 0.014], hi ? 8 : 4, hi ? 4 : 2, [0.1, 0.55, -0.45]);
  const earPaint = (p: V3, n: V3): Paint => {
    // darker, pinker inner ear on the forward-facing side
    const inner = sstep(0.2, 0.6, dot(n, norm([Math.sign(p[0]) * 0.45, 0.1, -1])));
    const c = mixc(PAL.fur, PAL.earIn, 0.8 * inner);
    return [c[0], c[1], c[2], 0.9 - 0.5 * inner];
  };
  B.add(ear, { ...head, paint: earPaint });
  B.add(mirrorX(ear), { ...head, paint: earPaint });

  // two broad front teeth, beaver style, in front of the shorter lower jaw
  const inc = box([0.0105, 0.927, -0.229], [0.0095, 0.0135, 0.0045], [0.18, 0.06, 0]);
  B.add(inc, { ...head, paint: solid(PAL.teeth), flat: true });
  B.add(mirrorX(inc), { ...head, paint: solid(PAL.teeth), flat: true });
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
      const top = sstep(0.5, 0.75, n[1]);
      const lip = sstep(0.1, 0.35, n[1]) * (1 - top);
      let c = mixc(PAL.muzzle, PAL.beak, 0.6 * lip);
      c = mixc(c, PAL.mouth, top);
      c = mixc(c, PAL.tongue, top * sstep(0.035, 0.015, Math.abs(p[0])) * sstep(-0.06, -0.1, p[2]));
      return [c[0], c[1], c[2], 0.4 * (1 - top)];
    },
  });
  if (hi) {
    for (const z of [-0.1, -0.135, -0.17]) {
      const r = interpRow(JAW, z);
      const tt = tooth([r[2] * 0.62, r[1] + r[3] * 0.72, z], [-0.1, 1, 0], 0.012, 0.0065);
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
  const seg = hi ? 10 : 6;
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
    for (const dz of [-0.036, 0, 0.034]) {
      const f = ellipsoid([0.404, 0.343, -0.052 + dz], [0.017, 0.021, 0.017], 5, 3);
      B.add(f, { ...specR, weight: undefined, paint: solid(PAL.paw, 0.5) });
      B.add(mirrorX(f), { ...specL, weight: undefined, paint: solid(PAL.paw, 0.5) });
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
    const a = armAt(0.05 + 0.7 * f);
    const toBody = norm([-1, 0.35, 0.1]);
    const A = add(a.c, mul(toBody, a.r * 0.7));
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
  // (poles along Z: the ellipsoid's local y radius is the foot length)
  const footPaint = (p: V3, n: V3): Paint => {
    const c = mixc(PAL.paw, PAL.furDark, 0.35 * sstep(0.3, 0.9, n[1]));
    return [c[0], c[1], c[2], 0.5];
  };
  B.add(foot, { ...specR, weight: undefined, paint: footPaint });
  B.add(mirrorX(foot), { ...specL, weight: undefined, paint: footPaint });
  if (hi) {
    const R = euler([0, FOOT_YAW, 0]);
    for (const dx of [-0.036, 0, 0.036]) {
      const toe = ellipsoid(add(FOOT_C, R([dx, -0.006, -0.1 + Math.abs(dx) * 0.4])), [0.02, 0.018, 0.024], 5, 3);
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
  const bands = hi ? [-1, -0.62, 0, 0.62, 1] : [-1, 0, 1];
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
      // the dyed cloth takes the variant's colour (tag 1); the gold edging stays gold
      tag: (q) => (hi && Math.abs(bands[q[0]]) > 0.9 ? 0 : 1),
      paint: (_p, _n, q) => {
        const trim = hi && Math.abs(bands[q[0]]) > 0.9;
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
  if (hi) {
    const pth = Math.PI * 1.5;
    const py = 0.826;
    const ps = torsoPoint(torsoRows, pth, py);
    const pn = torsoNormal(torsoRows, pth, py);
    B.add(disc(add(ps, mul(pn, 0.012)), add(pn, [0, 0.35, 0]), 0.028, 0.006, 6), { ...body, flat: true, paint: solid(PAL.gold) });
  }
}

/**
 * Build the Quinlan geometry (rest pose, indexed). 'high' ~2.9k triangles for close
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
 * (from createQuinlanGeometry, or a LOD of the rigged mesh model) and adds its
 * own `aAnim` instanced attribute (or `anim`, to keep one across a swap).
 */
export function createQuinlanInstancedGeometry(base: BufferGeometry, count: number, anim?: InstancedBufferAttribute): BufferGeometry {
  const g = new BufferGeometry();
  for (const [name, attr] of Object.entries(base.attributes)) if (name !== 'aAnim') g.setAttribute(name, attr);
  g.setIndex(base.getIndex());
  g.boundingBox = base.boundingBox;
  g.boundingSphere = base.boundingSphere;
  g.setAttribute('aAnim', anim ?? createQuinlanAnimAttribute(count));
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
function animParsGlsl(rig: QuinlanRigInfo | null): string {
  const J = rig
    ? { hip: rig.joints.hip, spine: rig.joints.spine, neck: rig.joints.neck, eye: rig.joints.eye, elbow: rig.joints.elbow }
    : { hip: QUINLAN_JOINTS.hip, spine: QUINLAN_JOINTS.spine, neck: QUINLAN_JOINTS.neck, eye: EYE_R, elbow: QUINLAN_JOINTS.elbowR };
  const pivots = rig
    ? (() => {
        const j = rig.joints;
        const mx = (v: V3): V3 => [-v[0], v[1], v[2]];
        // indexed by part: body, head, jaw, armL, armR, legL, legR, tail
        return [j.hip, j.neck, j.jaw, mx(j.shoulder), j.shoulder, mx(j.legHip), j.legHip, j.tail].map(v3).join(', ');
      })()
    : '';
  const pose = { ...RIG_POSE_DEFAULTS, ...(rig?.pose ?? {}) };
  return /* glsl */ `
#ifndef QUINLAN_ANIM_PARS
#define QUINLAN_ANIM_PARS
${rig ? '#define QUINLAN_RIG' : ''}
#ifdef QUINLAN_RIG
attribute vec4 aQ0; // part / 255, joint weight, fur tint weight, gear dye weight
attribute vec4 aQ1; // upper-body bend weight, elbow weight, belly, chest (breathing)
const vec3 Q_PIVOTS[8] = vec3[8]( ${pivots} );
const float Q_LEAN = ${f(pose.lean)};
const float Q_TAIL_UP = ${f(pose.tailUp)};
const float Q_RUN_Y = ${f(pose.runY)};
const float Q_SWIM_Y = ${f(pose.swimY)};
const float Q_SIT_BACK = ${f(pose.sitBack)};
const float Q_JAW = ${f(pose.jaw)};
#else
attribute float aPart;
attribute vec3 aPivot;
attribute vec3 aSkin;
#endif
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
const vec3 Q_HIP = ${v3(J.hip)};
const vec3 Q_SPINE = ${v3(J.spine)};
const vec3 Q_NECK = ${v3(J.neck)};
const vec3 Q_EYE = ${v3(J.eye)};
const vec3 Q_ELBOW = ${v3(J.elbow)};
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
// per-variant channels: 0 fur (CPU side), 1 clothing dye, 2-4 proportions, 5-9 posture
float qH( float v, float k ) { return fract( sin( v * 78.233 + k * 12.9898 ) * 43758.5453 ); }

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
  vec2 elbow;  // elbow flex L, R (rad, + brings the forearm forward)
  vec3 tail;   // about the tail base
  vec3 wave;   // tail undulation: amplitude at the tip (m), phase (rad), wavenumber
  vec2 face;   // x breathing (-1..1), y eye openness (0..1)
};

float qBlink( float t, float ph ) {
  float e = fract( t * 0.21 + ph * 3.7 );
  return 0.08 + 0.92 * smoothstep( 0.0, 0.035, abs( e - 0.5 ) );
}

QPose qRest( float v ) {
  QPose P;
  P.rootT = vec3( 0.0 );
  P.root = vec3( 0.0 );
  P.spine = vec3( ( qH( v, 5.0 ) - 0.5 ) * 0.08, 0.0, 0.0 );
  P.head = vec3( ( qH( v, 6.0 ) - 0.5 ) * 0.12, 0.0, ( qH( v, 7.0 ) - 0.5 ) * 0.18 );
  P.jaw = vec3( 0.0 );
  float ab = ( qH( v, 8.0 ) - 0.5 ) * 0.12;
  P.armL = vec3( 0.0, 0.0, -ab );
  P.armR = vec3( 0.0, 0.0, ab );
  P.legL = vec3( 0.0 );
  P.legR = vec3( 0.0 );
  P.lift = vec4( 0.0 );
  P.elbow = vec2( 0.12 + 0.1 * qH( v, 9.0 ) );
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
  P.elbow = vec2( 0.2 + 0.3 * max( -s, 0.0 ), 0.2 + 0.3 * max( s, 0.0 ) );
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
#ifdef QUINLAN_RIG
  pitch += Q_LEAN; // this body already leans forward
#endif
  P.root.x = pitch;
  P.rootT.y = 0.04 * max( 0.0, sin( a + 0.8 ) ) - 0.015;
  P.spine.x = 0.1 * sin( a + 0.5 );
  float fore = -( pitch + P.spine.x );
  P.armL = vec3( fore + 0.65 * sin( a + 2.9 ), 0.0, 0.46 );
  P.armR = vec3( fore + 0.65 * sin( a + 3.3 ), 0.0, -0.46 );
  P.legL = vec3( -pitch + 0.6 * sin( a ), 0.0, 0.0 );
  P.legR = vec3( -pitch + 0.6 * sin( a + 0.4 ), 0.0, 0.0 );
  P.lift = vec4( max( cos( a ), 0.0 ), max( cos( a + 0.4 ), 0.0 ), max( cos( a + 2.9 ), 0.0 ), max( cos( a + 3.3 ), 0.0 ) ) * vec4( 0.06, 0.06, 0.03, 0.03 );
  P.elbow = vec2( 0.15 + 1.1 * max( cos( a + 2.9 ), 0.0 ), 0.15 + 1.1 * max( cos( a + 3.3 ), 0.0 ) );
  P.head.x += fore - 0.3 + 0.06 * sin( a + 1.0 );
  P.tail = vec3( -pitch * 0.92 + 0.18 * sin( a - 1.2 ), 0.05 * sin( a ), 0.0 );
  P.wave = vec3( 0.05, a - 1.0, 1.0 );
  P.jaw.x = 0.1 + 0.05 * sin( 2.0 * a );
#ifdef QUINLAN_RIG
  P.tail.x += Q_TAIL_UP * 0.8;
  P.rootT.y += Q_RUN_Y;
#endif
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
  P.elbow = vec2( 0.1 + 1.0 * max( c, 0.0 ), 0.1 + 1.0 * max( -c, 0.0 ) ); // fold on the recovery stroke
  P.legL = vec3( -0.15 + 0.38 * sin( a + 0.6 ), 0.0, -0.1 );
  P.legR = vec3( -0.15 - 0.38 * sin( a + 0.6 ), 0.0, 0.1 );
  P.tail = vec3( 1.4 + 0.1 * sin( a - 0.7 ), 0.0, 0.0 );
  P.wave = vec3( 0.11, 2.0 * a, 1.2 );
  P.face.y = qBlink( t, ph );
#ifdef QUINLAN_RIG
  P.root.x += Q_LEAN;
  P.head.x -= Q_LEAN;
  P.tail.x += Q_TAIL_UP;
  P.rootT.y += Q_SWIM_Y;
#endif
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
  P.tail = vec3( -0.52, 0.1 * s, 0.0 );
  P.wave = vec3( -0.13, 0.5 * Q_PI, 0.0 ); // static bend: lay the paddle back down flat
  float g = 0.5 + 0.5 * sin( 2.0 * a + 0.4 );
  P.armL = vec3( 0.5 + 0.25 * g, 0.2, -( 0.5 + 0.15 * g ) );
  P.armR = vec3( 0.5 + 0.25 * g, -0.2, 0.5 + 0.15 * g );
  P.elbow = vec2( 0.35 + 0.35 * g );
  P.head = vec3( 0.3 + 0.05 * sin( 2.0 * a ), 0.1 * sin( a + 0.4 ), P.head.z - 0.7 * P.root.z );
  float n = sin( Q_TAU * ( t * 1.9 + ph ) );
  float phr = fract( t * 0.21 + ph * 1.7 );
  float on = smoothstep( 0.0, 0.06, phr ) * ( 1.0 - smoothstep( 0.84, 0.92, phr ) );
  P.jaw.x = 0.03 + on * ( 0.16 + 0.2 * ( 0.5 + 0.5 * n ) );
  P.face.y = 0.55 + 0.45 * ( 1.0 - on );
#ifdef QUINLAN_RIG
  P.root.x += Q_SIT_BACK;
  P.head.x -= Q_SIT_BACK;
  P.tail.x += Q_TAIL_UP * 0.9;
#endif
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
  P.armL = vec3( 0.3, -0.2, 0.3 );
  P.armR = vec3( 0.3, 0.2, -0.3 );
  P.elbow = vec2( 1.15 ); // paws together in front
  P.tail.y = 0.25 * sin( Q_TAU * ( t * 1.3 + ph ) );
  P.rootT.y = 0.01 * abs( sin( r * 0.5 ) );
  P.face.y = min( P.face.y, 0.45 );
  return P;
}

QPose qPoseFor( float g, float t, float ph, float v ) {
  // one exit, fully assigned on every path: Direct3D's compiler flags early
  // struct returns as "potentially uninitialized", and ANGLE on some drivers
  // does not zero such variables, which can throw vertices across the screen
  QPose P = qRest( v );
  if ( g < 0.5 ) P = qIdle( t, ph, v );
  else if ( g < 1.5 ) P = qWalk( t, ph, v );
  else if ( g < 2.5 ) P = qRun( t, ph, v );
  else if ( g < 3.5 ) P = qSwim( t, ph, v );
  else if ( g < 4.5 ) P = qSing( t, ph, v );
  else P = qSmile( t, ph, v );
  return P;
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
  r.elbow = mix( a.elbow, b.elbow, k );
  r.tail = mix( a.tail, b.tail, k );
  r.wave = mix( a.wave, b.wave, k );
  r.face = mix( a.face, b.face, k );
  return r;
}

void qApply( QPose P, float v, inout vec3 p, inout vec3 n ) {
  vec3 r0 = p;
  float spineW = 0.0;
  mat3 M;
#ifdef QUINLAN_RIG
  int part = int( aQ0.x * 255.0 + 0.5 );
  float w = aQ0.y;
  vec3 piv = Q_PIVOTS[ clamp( part, 0, 7 ) ];
  float ws = aQ1.x;
  // variant belly and breathing: push the skin out along its normal
  p += n * ( ( qH( v, 2.0 ) - 0.5 ) * 0.045 * aQ1.z + 0.005 * P.face.x * aQ1.w );
  float bodyScale = 1.0;
#else
  int part = int( aPart + 0.5 );
  float w = aSkin.x;
  vec3 piv = aPivot;
  float ws = smoothstep( 0.36, 0.74, r0.y );
  // variant proportions: belly, head size, tail length; plus breathing
  float belly = smoothstep( 0.12, 0.3, r0.y ) * ( 1.0 - smoothstep( 0.55, 0.82, r0.y ) );
  float chest = smoothstep( 0.42, 0.6, r0.y ) * ( 1.0 - smoothstep( 0.78, 0.92, r0.y ) );
  float bodyScale = 1.0 + ( qH( v, 2.0 ) - 0.5 ) * 0.12 * belly + 0.016 * P.face.x * chest;
#endif
  if ( part == 0 ) {
#ifndef QUINLAN_RIG
    // (the rigged mesh's neck blends through its weights instead)
    p.xz *= bodyScale;
    float nk = smoothstep( 0.83, 0.97, r0.y ); // the neck follows the head a little
    if ( nk > 0.0 ) {
      M = qEuler( P.head * 0.5 * nk );
      p = Q_NECK + M * ( p - Q_NECK );
      n = M * n;
    }
#endif
    spineW = ws;
  } else if ( part <= 2 ) {
    if ( part == 2 ) {
      float jw = w;
#ifdef QUINLAN_RIG
      jw *= Q_JAW;
#endif
      M = qRotY( P.jaw.z * jw ) * qRotX( -P.jaw.x * jw );
      p = piv + M * ( p - piv );
      n = M * n;
      p.x += P.jaw.y * jw;
    }
#ifndef QUINLAN_RIG
    else if ( aSkin.z > 1.5 ) {
      // eyes: blink / squint by squashing towards the eye's horizontal plane
      // (and flattening against the head so a closed eye reads as a lid line)
      vec3 ec = vec3( sign( r0.x ) * Q_EYE.x, Q_EYE.yz );
      float o = max( P.face.y, 0.06 );
      float ox = mix( 0.55, 1.0, o );
      p = ec + ( p - ec ) * vec3( ox, o, 1.0 );
      n = normalize( vec3( n.x / ox, n.y / max( o, 0.25 ), n.z ) );
      if ( aSkin.z > 2.5 ) p = ec + ( p - ec ) * smoothstep( 0.2, 0.6, o );
    }
#endif
    float hw = part == 1 ? w : 1.0;
    float hs = 1.0 + ( qH( v, 3.0 ) - 0.5 ) * 0.08;
#ifdef QUINLAN_RIG
    // the head blends into the neck: scale and bend with its weight
    hs = mix( 1.0, hs, hw );
    spineW = mix( ws, 1.0, hw );
#else
    spineW = 1.0;
#endif
    p = Q_NECK + ( p - Q_NECK ) * hs;
    M = qEuler( P.head * hw );
    p = Q_NECK + M * ( p - Q_NECK );
    n = M * n;
  } else if ( part <= 4 ) {
    bool left = part == 3;
    p.xz *= mix( bodyScale, 1.0, w ); // the torso edge of the webbing stays on the torso
    // elbow: the forearm, hand and the lower arm edge of the webbing flex about the elbow
    vec3 ep = vec3( sign( r0.x ) * Q_ELBOW.x, Q_ELBOW.yz );
#ifdef QUINLAN_RIG
    float we = aQ1.y * w;
#else
    float we = ( 1.0 - smoothstep( Q_ELBOW.y - 0.045, Q_ELBOW.y + 0.045, r0.y ) ) * w;
#endif
    M = qRotX( ( left ? P.elbow.x : P.elbow.y ) * we );
    p = ep + M * ( p - ep );
    n = M * n;
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
    d.z *= 1.0 + ( qH( v, 4.0 ) - 0.5 ) * 0.16;
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

#ifdef QUINLAN_RIG
// Dyes for the gear webbing: multipliers on the source colour (olive, leather,
// madder, woad, undyed, soot, teal, weld).
const vec3 Q_GEAR[8] = vec3[8](
  vec3( 1.0 ), vec3( 1.35, 0.95, 0.7 ), vec3( 1.75, 0.72, 0.55 ), vec3( 0.72, 0.92, 1.5 ),
  vec3( 1.55, 1.42, 1.12 ), vec3( 0.55 ), vec3( 0.66, 1.12, 1.18 ), vec3( 1.55, 1.3, 0.55 )
);

/**
 * Per-vertex colour multiplier: instanceColor tints the fur (at half strength:
 * the painted fur is already warm and saturated), the variant dyes the gear.
 */
vec3 quinlanTint() {
  vec3 t = vec3( 1.0 );
  #ifdef USE_INSTANCING_COLOR
    t = mix( t, instanceColor.rgb, 0.55 * aQ0.z );
  #endif
  int i = int( floor( qH( aAnim.w, 1.0 ) * 8.0 ) );
  return t * mix( vec3( 1.0 ), Q_GEAR[ clamp( i, 0, 7 ) ], aQ0.w );
}
#else
vec3 qAccent( float v ) {
  int i = int( floor( qH( v, 1.0 ) * ${f(ACCENTS_SRGB.length)} ) );
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
#endif
`;
}

export const quinlanAnimParsGlsl = animParsGlsl(null);

/** Vertex-shader declarations for a rigged mesh model (see quinlanAsset.ts). */
export function quinlanRigAnimParsGlsl(rig: QuinlanRigInfo): string {
  return animParsGlsl(rig);
}

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
    #if defined( QUINLAN_RIG ) && defined( QUINLAN_TEXTURED )
      vColor.rgb = quinlanTint();
    #elif defined( QUINLAN_RIG )
      vColor.rgb = color.rgb * quinlanTint();
    #else
      vColor.rgb = quinlanColor( vec3( color.rgb ) );
    #endif
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

/**
 * Patch a built-in vertex shader for the rigged mesh model (quinlanAsset.ts).
 * `textured`: the LOD samples the albedo map instead of vertex colours.
 */
export function patchQuinlanRigVertexShader(vertexShader: string, rig: QuinlanRigInfo, textured: boolean, declareTime = true): string {
  const pars = `${textured ? '#define QUINLAN_TEXTURED\n' : ''}${declareTime ? 'uniform float uTime;\n' : ''}${quinlanRigAnimParsGlsl(rig)}`;
  return vertexShader
    .replace('#include <common>', `#include <common>\n${pars}`)
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
