// Anek's surveillance birds: glossy black robotic corvids with faintly glowing
// eyes, perched on ridges and statues. They turn to watch you, now and then
// take off, circle the town and settle somewhere else.

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { frame, wrapS } from '../coords/cylinder';
import { clamp } from '../core/math';
import { Rng, seedFor } from '../core/rng';
import { makeBentDepthMaterial, patchWorldMaterial } from '../render/bend';
import type { LoadedTown, TownManager } from '../towns/townManager';

const MAX = 96;
const TAU = Math.PI * 2;
const wrapAngle = (a: number) => a - TAU * Math.round(a / TAU);

// parts: 0 body, 1 head, 2 left wing, 3 right wing, 4 tail
function buildBirdGeometry(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const part: number[] = [];
  const glow: number[] = [];
  const tri = (a: number[], b: number[], c: number[], rgb: number[], p: number, g = 0) => {
    pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) {
      col.push(...rgb);
      part.push(p);
      glow.push(g);
    }
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], rgb: number[], p: number) => {
    tri(a, b, c, rgb, p);
    tri(a, c, d, rgb, p);
  };
  const BLACK = [0.012, 0.013, 0.02];
  const SHEEN = [0.03, 0.035, 0.06];
  const BEAK = [0.05, 0.045, 0.04];
  // body: a stretched octahedron along -z (the bird faces -z), feet at y = 0
  const cy = 0.13;
  const F = [0, cy + 0.01, -0.12];
  const B = [0, cy + 0.02, 0.14];
  const T = [0, cy + 0.075, 0];
  const D = [0, cy - 0.07, 0.01];
  const L = [-0.065, cy, 0];
  const Rr = [0.065, cy, 0];
  for (const [a, b] of [
    [L, T],
    [T, Rr],
    [Rr, D],
    [D, L],
  ]) {
    tri(F, a, b, SHEEN, 0);
    tri(B, b, a, BLACK, 0);
  }
  // legs
  quad([-0.02, 0, 0], [-0.015, 0, 0], [-0.015, cy - 0.05, 0.0], [-0.02, cy - 0.05, 0.0], BLACK, 0);
  quad([0.015, 0, 0], [0.02, 0, 0], [0.02, cy - 0.05, 0.0], [0.015, cy - 0.05, 0.0], BLACK, 0);
  // head: small octahedron at the neck + beak + glowing eyes
  const hc = [0, cy + 0.1, -0.13];
  const r = 0.042;
  const hp = (dx: number, dy: number, dz: number) => [hc[0] + dx, hc[1] + dy, hc[2] + dz];
  const H = [hp(0, r, 0), hp(0, -r, 0), hp(-r, 0, 0), hp(r, 0, 0), hp(0, 0, -r), hp(0, 0, r)];
  const faces = [
    [0, 2, 4],
    [0, 4, 3],
    [0, 3, 5],
    [0, 5, 2],
    [1, 4, 2],
    [1, 3, 4],
    [1, 5, 3],
    [1, 2, 5],
  ];
  for (const f of faces) tri(H[f[0]], H[f[1]], H[f[2]], SHEEN, 1);
  const bt = hp(0, -0.008, -r - 0.07);
  tri(hp(-0.014, 0.008, -r + 0.01), hp(0.014, 0.008, -r + 0.01), bt, BEAK, 1);
  tri(hp(0.014, -0.012, -r + 0.01), hp(-0.014, -0.012, -r + 0.01), bt, BEAK, 1);
  tri(hp(-0.014, 0.008, -r + 0.01), bt, hp(-0.014, -0.012, -r + 0.01), BEAK, 1);
  tri(hp(0.014, -0.012, -r + 0.01), bt, hp(0.014, 0.008, -r + 0.01), BEAK, 1);
  for (const sx of [-1, 1]) {
    const ex = sx * (r * 0.72 + 0.002);
    const e = 0.011;
    const n = sx; // quads face outward along x
    const a = hp(ex, 0.012 - e, -0.012 - e);
    const b = hp(ex, 0.012 - e, -0.012 + e);
    const c = hp(ex, 0.012 + e, -0.012 + e);
    const d = hp(ex, 0.012 + e, -0.012 - e);
    if (n > 0) {
      tri(a, d, c, [0.9, 0.2, 0.05], 1, 1);
      tri(a, c, b, [0.9, 0.2, 0.05], 1, 1);
    } else {
      tri(a, b, c, [0.9, 0.2, 0.05], 1, 1);
      tri(a, c, d, [0.9, 0.2, 0.05], 1, 1);
    }
  }
  // wings: folded along the flanks; rotation about the shoulder line (z axis) opens them
  for (const sx of [-1, 1]) {
    const p = sx < 0 ? 2 : 3;
    const x = sx * 0.06;
    const root0 = [x, cy + 0.045, -0.07];
    const root1 = [x, cy + 0.04, 0.09];
    const tip = [x + sx * 0.3, cy + 0.04, 0.06];
    const mid = [x + sx * 0.2, cy + 0.045, -0.04];
    const sheen = [0.022, 0.024, 0.04];
    // top and bottom faces
    if (sx > 0) {
      tri(root0, mid, root1, sheen, p);
      tri(mid, tip, root1, sheen, p);
      tri(root0, root1, mid, BLACK, p);
      tri(mid, root1, tip, BLACK, p);
    } else {
      tri(root0, root1, mid, sheen, p);
      tri(mid, root1, tip, sheen, p);
      tri(root0, mid, root1, BLACK, p);
      tri(mid, tip, root1, BLACK, p);
    }
  }
  // tail fan
  quad([-0.035, cy + 0.03, 0.12], [0.035, cy + 0.03, 0.12], [0.05, cy + 0.01, 0.27], [-0.05, cy + 0.01, 0.27], SHEEN, 4);
  quad([-0.05, cy + 0.01, 0.27], [0.05, cy + 0.01, 0.27], [0.035, cy + 0.03, 0.12], [-0.035, cy + 0.03, 0.12], BLACK, 4);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aBirdPart', new BufferAttribute(new Float32Array(part), 1));
  g.setAttribute('aGlow', new BufferAttribute(new Float32Array(glow), 1));
  g.computeVertexNormals();
  return g;
}

const birdPars = /* glsl */ `
attribute float aBirdPart;
attribute float aGlow;
attribute vec4 aBird; // x flap amount (0 perched .. 1 flying), y phase, z head yaw, w wing fold
varying float vGlow;
mat3 bRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 bRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
`;

const birdBegin = /* glsl */ `
{
  vec3 bn = vec3(0.0, 1.0, 0.0);
  #if defined( LAMBERT )
    bn = objectNormal;
  #endif
  float part = aBirdPart;
  if (part > 0.5 && part < 1.5) {
    // head turns about the neck
    vec3 pv = vec3(0.0, 0.2, -0.1);
    mat3 m = bRotY(aBird.z);
    transformed = m * (transformed - pv) + pv;
    bn = m * bn;
  } else if (part > 1.5 && part < 3.5) {
    float side = part < 2.5 ? -1.0 : 1.0;
    // flap: flying wings sweep through +-60 degrees; perched wings stay folded
    float flap = aBird.x * (0.35 + 0.75 * sin(uTime * 13.0 + aBird.y * 6.2831));
    float ang = side * flap;
    vec3 pv = vec3(side * 0.06, 0.175, 0.0);
    vec3 q = transformed - pv;
    // folded: squeeze the span along the flank
    q.x *= mix(0.22, 1.0, aBird.x);
    q.z += (1.0 - aBird.x) * abs(q.x) * 0.6;
    mat3 m = bRotZ(ang);
    transformed = m * q + pv;
    bn = m * bn;
  } else if (part > 3.5) {
    // tail bobs when perched
    float bob = (1.0 - aBird.x) * 0.08 * sin(uTime * 2.3 + aBird.y * 9.0);
    transformed.y += bob * max(0.0, transformed.z - 0.12) * 4.0;
  }
  #if defined( LAMBERT )
    objectNormal = bn;
  #endif
  vGlow = aGlow;
}
`;

interface Bird {
  town: LoadedTown;
  x: number;
  z: number;
  h: number;
  yaw: number;
  mode: 'perch' | 'fly';
  flap: number;
  head: number;
  headT: number;
  timer: number;
  phase: number;
  // circling
  cx: number;
  cz: number;
  cr: number;
  ch: number;
  ang: number;
  dir: number;
  target: number;
  landT: number;
  sx: number;
  sz: number;
  sh: number;
  bank: number;
}

export class SurveillanceBirds {
  readonly group = new Group();
  private mesh: InstancedMesh;
  private anim: InstancedBufferAttribute;
  private birds = new Map<number, Bird[]>();
  private rng = new Rng(0xb1ad);

  constructor(towns: TownManager) {
    const base = buildBirdGeometry();
    const g = new BufferGeometry();
    for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.getAttribute(k));
    this.anim = new InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.anim.setUsage(DynamicDrawUsage);
    g.setAttribute('aBird', this.anim);
    const mat = patchWorldMaterial(new MeshLambertMaterial({ vertexColors: true }), {
      key: 'bird',
      bend: true,
      vertexPars: birdPars,
      vertexBegin: birdBegin,
      fragmentPars: 'varying float vGlow;',
      fragmentEnd: 'gl_FragColor.rgb += vec3(1.0, 0.22, 0.06) * vGlow * 2.5;',
    });
    this.mesh = new InstancedMesh(g, mat, MAX);
    this.mesh.name = 'surveillance birds';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.customDepthMaterial = makeBentDepthMaterial('bird', { vertexPars: birdPars, vertexBegin: birdBegin });
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.matrixWorld.identity();
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.group.add(this.mesh);
    towns.onLoaded.push((t) => this.populate(t));
    towns.onUnloaded.push((t) => this.birds.delete(t.site.id));
  }

  private populate(t: LoadedTown) {
    const n = t.perches.length / 3;
    if (!n) return;
    const rng = new Rng(seedFor(t.site.seed, 'birds'));
    const want = Math.min(n, t.site.kind === 'hamlet' ? rng.int(1, 2) : t.site.kind === 'town' ? rng.int(3, 6) : rng.int(8, 14));
    const list: Bird[] = [];
    for (let i = 0; i < want; i++) {
      const k = rng.int(0, n - 1);
      list.push({
        town: t,
        x: t.perches[k * 3],
        z: t.perches[k * 3 + 1],
        h: t.perches[k * 3 + 2],
        yaw: rng.range(-Math.PI, Math.PI),
        mode: 'perch',
        flap: 0,
        head: 0,
        headT: 0,
        timer: rng.range(20, 120),
        phase: rng.next(),
        cx: 0,
        cz: 0,
        cr: 0,
        ch: 0,
        ang: 0,
        dir: 1,
        target: k,
        landT: 0,
        sx: 0,
        sz: 0,
        sh: 0,
        bank: 0,
      });
    }
    this.birds.set(t.site.id, list);
  }

  update(dt: number, cam: { s: number; z: number }, player: { s: number; z: number; h: number }) {
    let n = 0;
    const arr = this.anim.array as Float32Array;
    for (const list of this.birds.values()) {
      for (const b of list) {
        const t = b.town;
        const ax = wrapS(t.anchorS - frame.originS);
        const az = t.anchorZ - frame.originZ;
        const cx = wrapS(cam.s - t.anchorS);
        const cz = cam.z - t.anchorZ;
        if (Math.hypot(b.x - cx, b.z - cz) > 900) continue;
        this.step(b, dt, wrapS(player.s - t.anchorS), player.z - t.anchorZ, player.h);
        if (n >= MAX) continue;
        _q.setFromAxisAngle(_up, b.yaw);
        if (b.bank) {
          _q2.setFromAxisAngle(_fwd, b.bank);
          _q.multiply(_q2);
        }
        _p.set(ax + b.x, b.h, az + b.z);
        _m.compose(_p, _q, _s);
        this.mesh.setMatrixAt(n, _m);
        arr[n * 4] = b.flap;
        arr[n * 4 + 1] = b.phase;
        arr[n * 4 + 2] = b.head;
        arr[n * 4 + 3] = 0;
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.anim.needsUpdate = true;
  }

  private step(b: Bird, dt: number, px: number, pz: number, ph: number) {
    b.timer -= dt;
    if (b.mode === 'perch') {
      b.flap = Math.max(0, b.flap - dt * 3);
      b.bank = 0;
      // watch the player when they are near; otherwise glance about
      const dx = px - b.x;
      const dz = pz - b.z;
      const d = Math.hypot(dx, dz, ph - b.h);
      if (d < 45) {
        b.headT = clamp(wrapAngle(Math.atan2(-dx, -dz) - b.yaw), -1.6, 1.6);
        // too close: take off
        if (d < 3.5 && b.timer > 1) b.timer = 0.3;
      } else if (Math.random() < dt * 0.4) b.headT = (Math.random() - 0.5) * 2.4;
      // quick robotic head snaps
      b.head += clamp(b.headT - b.head, -dt * 9, dt * 9);
      if (b.timer <= 0) {
        b.mode = 'fly';
        b.cr = this.rng.range(25, 70);
        b.ch = b.h + this.rng.range(14, 40);
        b.dir = this.rng.sign();
        b.ang = this.rng.range(0, TAU);
        b.cx = b.x - Math.cos(b.ang) * b.cr;
        b.cz = b.z - Math.sin(b.ang) * b.cr;
        b.timer = this.rng.range(12, 40);
        b.sh = b.h;
        b.landT = 0;
      }
      return;
    }
    // flying: climb onto a circle, loop, then glide down to a new perch
    b.flap = Math.min(1, b.flap + dt * 4);
    b.head = 0;
    const t = b.town;
    if (b.timer > 0) {
      const w = (7.5 / b.cr) * b.dir;
      b.ang += w * dt;
      const nx = b.cx + Math.cos(b.ang) * b.cr;
      const nz = b.cz + Math.sin(b.ang) * b.cr;
      const dx = nx - b.x;
      const dz = nz - b.z;
      if (dx * dx + dz * dz > 1e-8) b.yaw += wrapAngle(Math.atan2(-dx, -dz) - b.yaw) * Math.min(1, dt * 5);
      b.x = nx;
      b.z = nz;
      b.h += (b.ch - b.h) * Math.min(1, dt * 0.8);
      b.bank = -b.dir * 0.45;
      if (b.timer <= dt) {
        // pick somewhere to land
        const n = t.perches.length / 3;
        b.target = this.rng.int(0, n - 1);
        b.sx = b.x;
        b.sz = b.z;
        b.sh = b.h;
        b.landT = 0;
      }
    } else {
      const k = b.target;
      const tx = t.perches[k * 3];
      const tz = t.perches[k * 3 + 1];
      const th = t.perches[k * 3 + 2];
      const dist = Math.max(1, Math.hypot(tx - b.sx, tz - b.sz));
      b.landT = Math.min(1, b.landT + (dt * 9) / dist);
      const u = b.landT;
      const px0 = b.x;
      const pz0 = b.z;
      b.x = b.sx + (tx - b.sx) * u;
      b.z = b.sz + (tz - b.sz) * u;
      b.h = b.sh + (th - b.sh) * (1 - (1 - u) * (1 - u));
      const dx = b.x - px0;
      const dz = b.z - pz0;
      if (dx * dx + dz * dz > 1e-8) b.yaw += wrapAngle(Math.atan2(-dx, -dz) - b.yaw) * Math.min(1, dt * 6);
      b.bank *= 1 - Math.min(1, dt * 3);
      if (u >= 1) {
        b.mode = 'perch';
        b.x = tx;
        b.z = tz;
        b.h = th;
        b.timer = this.rng.range(40, 160);
      }
    }
  }
}

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _p = new Vector3();
const _s = new Vector3(1.6, 1.6, 1.6);
const _up = new Vector3(0, 1, 0);
const _fwd = new Vector3(0, 0, 1);
