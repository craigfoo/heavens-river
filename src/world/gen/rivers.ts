// River network: 4 main rivers per section running axially (alternating flow
// direction), each meandering on a broad floodplain, plus tributaries that are
// generated lazily from compact descriptors.

import { CIRC, L } from '../../config';
import { clamp, lerp, smoothstep } from '../../core/math';
import { fbm1, perlin1 } from '../../core/noise';
import { Rng, seedFor } from '../../core/rng';

export const RIVER_MAIN = 0;
export const RIVER_TRIB = 1;
export const RIVER_CANAL = 2;

/** Where the rivers emerge from / vanish into tunnel portals in the barrier gorges. */
export const PORTAL_Z = 26_000;
const TABLE_DZ = 10; // metres per centreline sample
const PROP_DZ = 100; // metres per width/level/depth sample

export function wrapDs(ds: number): number {
  ds = ds % CIRC;
  if (ds < -CIRC / 2) ds += CIRC;
  else if (ds >= CIRC / 2) ds -= CIRC;
  return ds;
}

export interface ChannelHit {
  /** Perpendicular distance to the channel centreline (m). */
  d: number;
  /** Signed lateral offset (+ toward +s). */
  side: number;
  /** Water surface height at the nearest point. */
  level: number;
  width: number;
  depth: number;
  /** Unit flow direction in (s, z). */
  fs: number;
  fz: number;
  speed: number;
  /** Axial position of the nearest centreline point (main rivers). */
  zc: number;
  /** Arc parameter along the river (m from its upstream end). */
  along: number;
}

export class MainRiver {
  readonly index: number;
  /** +1: flows toward +z. -1: flows toward -z. */
  readonly flow: 1 | -1;
  readonly baseS: number;
  readonly zStart = PORTAL_Z;
  readonly zEnd = L - PORTAL_Z;
  readonly n: number;
  /** Meandering channel centreline s(z) (unwrapped, near baseS). */
  readonly s: Float64Array;
  /** Smooth valley centreline s(z). */
  readonly vs: Float64Array;
  readonly np: number;
  readonly width: Float32Array;
  readonly level: Float32Array;
  readonly depth: Float32Array;
  readonly floodHalf: Float32Array; // half-width of flat floodplain around the valley line
  readonly wallWidth: Float32Array; // width of the valley wall transition
  readonly hiLevel: number;
  readonly loLevel: number;
  readonly name: string;
  /** Straight reaches where towns and cities grow. */
  readonly calm: { z0: number; z1: number }[] = [];

  constructor(index: number, seed: number, name: string) {
    this.index = index;
    this.flow = index % 2 === 0 ? 1 : -1;
    this.baseS = (index + 0.5) * (CIRC / 4);
    this.name = name;
    const rng = new Rng(seedFor(seed, `river${index}`));
    const zs = this.zStart;
    const ze = this.zEnd;
    this.n = Math.ceil((ze - zs) / TABLE_DZ) + 1;
    this.np = Math.ceil((ze - zs) / PROP_DZ) + 1;
    this.s = new Float64Array(this.n);
    this.vs = new Float64Array(this.n);
    this.width = new Float32Array(this.np);
    this.level = new Float32Array(this.np);
    this.depth = new Float32Array(this.np);
    this.floodHalf = new Float32Array(this.np);
    this.wallWidth = new Float32Array(this.np);

    const sd = seedFor(seed, `rv${index}`);
    // ---- properties along z
    this.hiLevel = 150 + rng.range(0, 40);
    this.loLevel = 30 + rng.range(0, 15);
    // monotone fall profile with gentle variation in gradient
    const slopes = new Float64Array(this.np);
    let total = 0;
    for (let i = 0; i < this.np; i++) {
      const z = zs + i * PROP_DZ;
      const g = 0.35 + 0.65 * (0.5 + 0.5 * fbm1(z / 60_000, sd + 11, 3));
      slopes[i] = g;
      total += g;
    }
    let acc = 0;
    for (let i = 0; i < this.np; i++) {
      // i indexes along z; flow direction decides where the river is high
      const k = this.flow > 0 ? i : this.np - 1 - i;
      acc += slopes[k];
      const f = acc / total;
      this.level[k] = lerp(this.hiLevel, this.loLevel, f);
    }
    for (let i = 0; i < this.np; i++) {
      const z = zs + i * PROP_DZ;
      const downstream = this.flow > 0 ? (z - zs) / (ze - zs) : (ze - z) / (ze - zs);
      const wn = 0.5 + 0.5 * fbm1(z / 45_000, sd + 23, 3);
      let w = lerp(190, 470, downstream) * (0.72 + 0.56 * wn);
      // narrow toward the portals (gorges)
      const endF = Math.min(z - zs, ze - z);
      w *= lerp(0.55, 1, smoothstep(0, 18_000, endF));
      this.width[i] = clamp(w, 140, 600);
      this.depth[i] = 3 + this.width[i] * 0.017;
      const fn = 0.5 + 0.5 * fbm1(z / 70_000, sd + 31, 2);
      this.floodHalf[i] = lerp(2200, 5200, fn) * lerp(0.15, 1, smoothstep(2000, 30_000, endF));
      this.wallWidth[i] = lerp(3500, 9000, 0.5 + 0.5 * fbm1(z / 50_000, sd + 37, 2)) * lerp(0.25, 1, smoothstep(0, 30_000, endF));
    }

    // ---- valley line: big smooth bends, tapered to baseS at both ends
    const bendAmp = rng.range(6000, 14000);
    for (let i = 0; i < this.n; i++) {
      const z = zs + i * TABLE_DZ;
      const endF = Math.min(z - zs, ze - z);
      const taper = smoothstep(0, 60_000, endF);
      const b = fbm1(z / 140_000, sd + 3, 3) * bendAmp + perlin1(z / 38_000, sd + 5) * 2200;
      this.vs[i] = this.baseS + b * taper;
    }

    // ---- calm (straight) reaches, where settlements prefer to grow
    for (let z = zs + rng.range(30_000, 50_000); z < ze - 40_000; z += rng.range(24_000, 52_000)) {
      const len = rng.range(4500, 9000);
      this.calm.push({ z0: z, z1: z + len });
    }

    // ---- channel: sine-generated meander walk around the valley line
    const dl = 4;
    let x = zs; // axial
    let y = this.baseS; // lateral
    let phase = rng.range(0, Math.PI * 2);
    let l = 0;
    const px: number[] = [x];
    const py: number[] = [y];
    while (x < ze) {
      const zi = clamp(x, zs, ze);
      const props = this.propIndex(zi);
      const w = this.width[props.i] * (1 - props.f) + this.width[Math.min(props.i + 1, this.np - 1)] * props.f;
      const endF = Math.min(x - zs, ze - x);
      const taper = smoothstep(1500, 16_000, endF);
      const lambda = w * lerp(9, 16, 0.5 + 0.5 * perlin1(l / 20_000, sd + 41)) ;
      const phiMax = lerp(0.35, 1.15, 0.5 + 0.5 * fbm1(l / 35_000, sd + 43, 2)) * taper * (1 - 0.88 * this.calmAt(x));
      phase += (2 * Math.PI * dl) / lambda;
      const vy = this.valleyAt(x);
      const vslope = (this.valleyAt(x + 50) - this.valleyAt(x - 50)) / 100;
      const flood = this.floodHalfAt(x);
      const maxOff = Math.max(200, flood - w * 0.5 - 400);
      const off = y - vy;
      const correction = -clamp(off / maxOff, -1.5, 1.5) * 0.55 - clamp(off / 200, -1, 1) * (1 - taper) * 0.6;
      let phi = phiMax * Math.sin(phase) + correction + Math.atan(vslope);
      phi = clamp(phi, -1.25, 1.25);
      x += dl * Math.cos(phi);
      y += dl * Math.sin(phi);
      l += dl;
      px.push(x);
      py.push(y);
    }
    // resample to uniform z
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const z = zs + i * TABLE_DZ;
      while (j < px.length - 2 && px[j + 1] < z) j++;
      const t = clamp((z - px[j]) / Math.max(px[j + 1] - px[j], 1e-6), 0, 1);
      this.s[i] = py[j] + (py[j + 1] - py[j]) * t;
    }
  }

  /** 1 inside a calm reach, ramping to 0 over 1.5 km outside it. */
  calmAt(z: number): number {
    let c = 0;
    for (const r of this.calm) {
      if (z < r.z0 - 1500 || z > r.z1 + 1500) continue;
      c = Math.max(c, smoothstep(r.z0 - 1500, r.z0, z) * (1 - smoothstep(r.z1, r.z1 + 1500, z)));
    }
    return c;
  }

  propIndex(z: number): { i: number; f: number } {
    const u = clamp((z - this.zStart) / PROP_DZ, 0, this.np - 1.000001);
    const i = Math.floor(u);
    return { i, f: u - i };
  }

  valleyAt(z: number): number {
    const u = clamp((z - this.zStart) / TABLE_DZ, 0, this.n - 1.000001);
    const i = Math.floor(u);
    const f = u - i;
    return this.vs[i] + (this.vs[i + 1] - this.vs[i]) * f;
  }

  channelAt(z: number): number {
    const u = clamp((z - this.zStart) / TABLE_DZ, 0, this.n - 1.000001);
    const i = Math.floor(u);
    const f = u - i;
    return this.s[i] + (this.s[i + 1] - this.s[i]) * f;
  }

  channelSlope(z: number): number {
    const u = clamp((z - this.zStart) / TABLE_DZ, 0, this.n - 1.000001);
    const i = Math.floor(u);
    return (this.s[i + 1] - this.s[i]) / TABLE_DZ;
  }

  private propLerp(arr: Float32Array, z: number): number {
    const u = clamp((z - this.zStart) / PROP_DZ, 0, this.np - 1.000001);
    const i = Math.floor(u);
    const f = u - i;
    return arr[i] + (arr[i + 1] - arr[i]) * f;
  }

  widthAt(z: number) {
    return this.propLerp(this.width, z);
  }
  levelAt(z: number) {
    return this.propLerp(this.level, z);
  }
  depthAt(z: number) {
    return this.propLerp(this.depth, z);
  }
  floodHalfAt(z: number) {
    return this.propLerp(this.floodHalf, z);
  }
  wallWidthAt(z: number) {
    return this.propLerp(this.wallWidth, z);
  }

  /** Lateral distance to the smooth valley line (perpendicular approx). */
  valleyDistance(s: number, z: number): number {
    const zc = clamp(z, this.zStart, this.zEnd);
    const off = wrapDs(s - this.valleyAt(zc));
    const u = clamp((zc - this.zStart) / TABLE_DZ, 1, this.n - 2);
    const i = Math.floor(u);
    const slope = (this.vs[i + 1] - this.vs[i - 1]) / (2 * TABLE_DZ);
    let d = Math.abs(off) / Math.sqrt(1 + slope * slope);
    // close the valley smoothly beyond the portals
    const beyond = z < this.zStart ? this.zStart - z : z > this.zEnd ? z - this.zEnd : 0;
    if (beyond > 0) d = Math.hypot(d, beyond * 3);
    return d;
  }

  /** Nearest point on the meandering channel (Gauss-Newton on the centreline). */
  channel(s: number, z: number, out: ChannelHit): ChannelHit {
    let zc = clamp(z, this.zStart, this.zEnd);
    for (let it = 0; it < 4; it++) {
      const S = this.channelAt(zc);
      const m = this.channelSlope(zc);
      const off = wrapDs(s - S);
      let step = (off * m + (z - zc)) / (1 + m * m);
      step = clamp(step, -800, 800);
      zc = clamp(zc + step, this.zStart, this.zEnd);
      if (Math.abs(step) < 0.05) break;
    }
    const S = this.channelAt(zc);
    const m = this.channelSlope(zc);
    const off = wrapDs(s - S);
    const dz = z - zc;
    const inv = 1 / Math.sqrt(1 + m * m);
    // tangent (m, 1)*inv in (s, z); flow along ±tangent
    const ts = m * inv;
    const tz = inv;
    out.d = Math.hypot(off, dz);
    out.side = off * tz - dz * ts >= 0 ? 1 : -1;
    out.zc = zc;
    out.level = this.levelAt(zc);
    out.width = this.widthAt(zc);
    out.depth = this.depthAt(zc);
    out.fs = ts * this.flow;
    out.fz = tz * this.flow;
    out.speed = 0.9 + (out.width / 600) * 0.9;
    out.along = this.flow > 0 ? zc - this.zStart : this.zEnd - zc;
    return out;
  }

  /** Point on the channel centreline at axial position z (for docks, barges). */
  pointAt(z: number): { s: number; z: number } {
    return { s: this.channelAt(z), z };
  }
}

// ---------------------------------------------------------------------------
// Tributaries

export interface TributaryDesc {
  id: number;
  river: number;
  side: 1 | -1;
  zc: number; // confluence axial position
  angle: number; // heading tilt toward upstream (radians)
  length: number;
  mouthWidth: number;
  seed: number;
  // conservative bounds (s unwrapped near the river's baseS)
  sMin: number;
  sMax: number;
  zMin: number;
  zMax: number;
  name: string;
}

export class Tributary {
  readonly desc: TributaryDesc;
  /** Fine polyline from mouth (0) to source (n-1). */
  readonly n: number;
  readonly ps: Float64Array;
  readonly pz: Float64Array;
  readonly w: Float32Array;
  readonly level: Float32Array;
  readonly depth: Float32Array;
  /** Coarse valley polyline indices (every VSTEP fine points). */
  static readonly STEP = 30; // fine spacing (m)
  static readonly VSTEP = 8; // coarse = 240 m
  sMin = Infinity;
  sMax = -Infinity;
  zMin = Infinity;
  zMax = -Infinity;

  constructor(desc: TributaryDesc, mouthS: number, mouthLevel: number, envHeight: (s: number, z: number) => number) {
    this.desc = desc;
    const step = Tributary.STEP;
    const n = Math.max(8, Math.floor(desc.length / step));
    this.n = n;
    this.ps = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.w = new Float32Array(n);
    this.level = new Float32Array(n);
    this.depth = new Float32Array(n);
    const rng = new Rng(desc.seed);
    // heading: away from the main river (±s), tilted upstream in z (desc.angle carries the sign)
    const baseHead = Math.atan2(Math.sin(desc.angle), desc.side * Math.cos(desc.angle));
    let head = baseHead;
    let x = mouthS; // s
    let y = desc.zc; // z
    let phase = rng.range(0, Math.PI * 2);
    const lam = desc.mouthWidth * rng.range(28, 45) + 300;
    const phiMax = rng.range(0.25, 0.75);
    for (let i = 0; i < n; i++) {
      this.ps[i] = x;
      this.pz[i] = y;
      const t = i / (n - 1);
      this.w[i] = Math.max(4, desc.mouthWidth * lerp(1, 0.18, Math.pow(t, 0.8)));
      this.depth[i] = 0.8 + this.w[i] * 0.06;
      // meander + slow heading drift back toward the base heading
      phase += (2 * Math.PI * step) / (lam * lerp(1, 0.5, t));
      const drift = perlin1(i * step / 6000, desc.seed + 7) * 0.35;
      head += (baseHead + drift - head) * 0.02;
      const phi = head + phiMax * Math.sin(phase);
      x += Math.cos(phi) * step;
      y += Math.sin(phi) * step;
      if (x < this.sMin) this.sMin = x;
      if (x > this.sMax) this.sMax = x;
      if (y < this.zMin) this.zMin = y;
      if (y > this.zMax) this.zMax = y;
    }
    // Water level: rises upstream, but never above the surrounding
    // environment minus a bank clearance; monotone so water always flows.
    const grad = rng.range(1.2, 3.2) / 1000;
    let prev = mouthLevel;
    this.level[0] = mouthLevel;
    const sampleEvery = 8;
    let cap = Infinity;
    for (let i = 1; i < n; i++) {
      if (i % sampleEvery === 1) {
        const env = envHeight(this.ps[i], this.pz[i]);
        cap = env - (1.6 + this.w[i] * 0.04);
      }
      const t = i / (n - 1);
      const planned = mouthLevel + grad * i * step + Math.pow(t, 3) * 90;
      const lv = Math.max(prev + 0.00012 * step, Math.min(planned, cap));
      this.level[i] = lv;
      prev = lv;
    }
  }

  /** Range of coarse segment start indices whose segments come within `pad` of a box. */
  coarseRange(s0: number, z0: number, s1: number, z1: number, pad: number): [number, number] {
    const V = Tributary.VSTEP;
    let lo = -1;
    let hi = -1;
    for (let i = 0; i + V < this.n; i += V) {
      const a = this.ps[i];
      const b = this.ps[i + V];
      const c = this.pz[i];
      const d = this.pz[i + V];
      if (Math.max(a, b) + pad < s0 || Math.min(a, b) - pad > s1) continue;
      if (Math.max(c, d) + pad < z0 || Math.min(c, d) - pad > z1) continue;
      if (lo < 0) lo = i;
      hi = i + V;
    }
    return lo < 0 ? [0, 0] : [lo, hi];
  }

  /**
   * Nearest point on the channel. `coarse` limits the search to the valley
   * polyline (for low LOD); otherwise refines on the fine polyline.
   * [c0, c1) limits the coarse segments searched (from coarseRange()).
   */
  nearest(s: number, z: number, out: ChannelHit, coarse: boolean, c0 = 0, c1 = this.n): number {
    const V = Tributary.VSTEP;
    const n = this.n;
    let best = Infinity;
    let bi = c0;
    let bt = 0;
    // coarse pass
    for (let i = c0; i + V < n && i < c1; i += V) {
      const r = segDist2(s, z, this.ps[i], this.pz[i], this.ps[i + V], this.pz[i + V]);
      if (r.d2 < best) {
        best = r.d2;
        bi = i;
        bt = r.t;
      }
    }
    let i0 = bi;
    let i1 = Math.min(bi + V, n - 1);
    let tt = bt;
    if (!coarse) {
      // refine on the fine segments around the coarse hit
      const lo = Math.max(0, bi - V);
      const hi = Math.min(n - 1, bi + 2 * V);
      best = Infinity;
      for (let i = lo; i < hi; i++) {
        const r = segDist2(s, z, this.ps[i], this.pz[i], this.ps[i + 1], this.pz[i + 1]);
        if (r.d2 < best) {
          best = r.d2;
          i0 = i;
          i1 = i + 1;
          tt = r.t;
        }
      }
    }
    const d = Math.sqrt(best);
    const ds = this.ps[i1] - this.ps[i0];
    const dz = this.pz[i1] - this.pz[i0];
    const len = Math.hypot(ds, dz) || 1;
    // flow runs from source (high index) to mouth (index 0)
    out.fs = -ds / len;
    out.fz = -dz / len;
    const cross = (s - this.ps[i0]) * dz - (z - this.pz[i0]) * ds;
    out.side = cross >= 0 ? 1 : -1;
    out.d = d;
    const fi = i0 + (i1 - i0) * tt;
    const k = Math.min(Math.floor(fi), n - 2);
    const f = fi - k;
    out.level = this.level[k] + (this.level[k + 1] - this.level[k]) * f;
    out.width = this.w[k] + (this.w[k + 1] - this.w[k]) * f;
    out.depth = this.depth[k] + (this.depth[k + 1] - this.depth[k]) * f;
    out.speed = 0.5 + out.width / 60;
    out.zc = this.pz[k];
    out.along = (n - 1 - fi) * Tributary.STEP;
    return d;
  }
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ez = az + dz * t - pz;
  _seg.d2 = ex * ex + ez * ez;
  _seg.t = t;
  return _seg;
}
const _seg = { d2: 0, t: 0 };

/** Deterministic tributary descriptors for a main river. */
export function tributaryDescs(river: MainRiver, seed: number, startId: number, nameFor: (rng: Rng) => string): TributaryDesc[] {
  const out: TributaryDesc[] = [];
  let id = startId;
  for (const side of [1, -1] as const) {
    const rng = new Rng(seedFor(seed, `trib${river.index}:${side}`));
    const baseAngle = rng.range(0.35, 0.75); // tilt toward upstream
    let z = river.zStart + 22_000 + rng.range(0, 8000);
    while (z < river.zEnd - 22_000) {
      const length = rng.range(12_000, 42_000);
      const angle = baseAngle + rng.range(-0.08, 0.08);
      // upstream is -flow in z
      const upSign = -river.flow;
      const a = angle * upSign;
      // conservative bounds (straight line + meander allowance)
      const chS = river.channelAt(z);
      const endS = chS + side * Math.cos(angle) * length;
      const endZ = z + Math.sin(a) * length;
      const pad = 3500 + length * 0.12;
      const desc: TributaryDesc = {
        id: id++,
        river: river.index,
        side,
        zc: z,
        angle: a,
        length,
        mouthWidth: rng.range(12, 58),
        seed: seedFor(seed, `t${river.index}:${side}:${Math.round(z)}`),
        sMin: Math.min(chS, endS) - pad,
        sMax: Math.max(chS, endS) + pad,
        zMin: Math.min(z, endZ) - pad,
        zMax: Math.max(z, endZ) + pad,
        name: nameFor(rng),
      };
      // keep sources out of the barrier zones
      if (endZ > river.zStart + 12_000 && endZ < river.zEnd - 12_000) out.push(desc);
      z += rng.range(7_000, 16_000);
    }
  }
  return out;
}
