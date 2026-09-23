// Gradient noise that can wrap seamlessly around the cylinder circumference.
// Pure functions of doubles so workers and the main thread agree bit-for-bit.

import { CIRC } from '../config';

const GX = new Float64Array(16);
const GY = new Float64Array(16);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2 + 0.19634954;
  GX[i] = Math.cos(a);
  GY[i] = Math.sin(a);
}

function h32(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 2D Perlin gradient noise, roughly in [-1, 1].
 * periodX > 0 wraps the lattice in x with that many cells.
 */
export function perlin2(x: number, y: number, periodX: number, seed: number): number {
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  const fx = x - fx0;
  const fy = y - fy0;
  let ix0 = fx0;
  let ix1 = fx0 + 1;
  if (periodX > 0) {
    ix0 = fx0 % periodX;
    if (ix0 < 0) ix0 += periodX;
    ix1 = ix0 + 1;
    if (ix1 >= periodX) ix1 -= periodX;
  }
  const iy0 = fy0 | 0;
  const iy1 = (fy0 + 1) | 0;
  const a = h32(ix0 | 0, iy0, seed) & 15;
  const b = h32(ix1 | 0, iy0, seed) & 15;
  const c = h32(ix0 | 0, iy1, seed) & 15;
  const d = h32(ix1 | 0, iy1, seed) & 15;
  const n00 = GX[a] * fx + GY[a] * fy;
  const n10 = GX[b] * (fx - 1) + GY[b] * fy;
  const n01 = GX[c] * fx + GY[c] * (fy - 1);
  const n11 = GX[d] * (fx - 1) + GY[d] * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.41421356;
}

/** 1D gradient noise in roughly [-1, 1]. */
export function perlin1(x: number, seed: number): number {
  const i0 = Math.floor(x);
  const f = x - i0;
  const g0 = ((h32(i0 | 0, 0x3a1, seed) & 0xffff) / 32767.5 - 1) * 2;
  const g1 = ((h32((i0 + 1) | 0, 0x3a1, seed) & 0xffff) / 32767.5 - 1) * 2;
  const n0 = g0 * f;
  const n1 = g1 * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return (n0 + (n1 - n0) * u) * 0.9;
}

/** Value noise 2D in [0,1], periodic in x, useful for cheap masks. */
export function value2(x: number, y: number, periodX: number, seed: number): number {
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  const fx = x - fx0;
  const fy = y - fy0;
  let ix0 = fx0;
  let ix1 = fx0 + 1;
  if (periodX > 0) {
    ix0 = fx0 % periodX;
    if (ix0 < 0) ix0 += periodX;
    ix1 = ix0 + 1;
    if (ix1 >= periodX) ix1 -= periodX;
  }
  const a = h32(ix0 | 0, fy0 | 0, seed) / 4294967296;
  const b = h32(ix1 | 0, fy0 | 0, seed) / 4294967296;
  const c = h32(ix0 | 0, (fy0 + 1) | 0, seed) / 4294967296;
  const d = h32(ix1 | 0, (fy0 + 1) | 0, seed) / 4294967296;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

interface Octave {
  fs: number; // lattice cells per metre along s
  fz: number; // lattice cells per metre along z
  period: number; // cells around the circumference
  amp: number;
  seed: number;
  os: number;
  oz: number;
  wavelength: number;
}

/**
 * Fractal noise over the unrolled cylinder surface (s, z), seamless in s.
 * Octaves whose wavelength is below `minWavelength` are skipped (LOD).
 */
export class CylFbm {
  readonly octaves: Octave[] = [];
  readonly norm: number;
  constructor(
    seed: number,
    baseWavelength: number,
    octaveCount: number,
    gain = 0.5,
    lacunarity = 2.03,
  ) {
    let amp = 1;
    let wl = baseWavelength;
    let total = 0;
    for (let i = 0; i < octaveCount; i++) {
      const period = Math.max(1, Math.round(CIRC / wl));
      const s = h32(i, 0x77, seed);
      this.octaves.push({
        fs: period / CIRC,
        fz: 1 / wl,
        period,
        amp,
        seed: s,
        os: (s & 0xffff) / 65536 * 97.3,
        oz: ((s >>> 16) & 0xffff) / 65536 * 131.7,
        wavelength: wl,
      });
      total += amp;
      amp *= gain;
      wl /= lacunarity;
    }
    this.norm = 1 / total;
  }

  sample(s: number, z: number, minWavelength = 0): number {
    let sum = 0;
    const oct = this.octaves;
    for (let i = 0; i < oct.length; i++) {
      const o = oct[i];
      if (o.wavelength < minWavelength) break;
      sum += o.amp * perlin2(s * o.fs + o.os, z * o.fz + o.oz, o.period, o.seed);
    }
    return sum * this.norm;
  }

  /** Ridged multifractal variant in [0, 1]-ish. */
  ridged(s: number, z: number, minWavelength = 0): number {
    let sum = 0;
    let weight = 1;
    const oct = this.octaves;
    for (let i = 0; i < oct.length; i++) {
      const o = oct[i];
      if (o.wavelength < minWavelength) break;
      let n = 1 - Math.abs(perlin2(s * o.fs + o.os, z * o.fz + o.oz, o.period, o.seed));
      n *= n;
      n *= weight;
      weight = Math.min(1, n * 2);
      sum += o.amp * n;
    }
    return sum * this.norm;
  }
}

/** Simple 1D fractal noise. */
export function fbm1(x: number, seed: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin1(x * f + i * 17.13, seed + i * 1013);
    norm += amp;
    amp *= gain;
    f *= 2.07;
  }
  return sum / norm;
}
