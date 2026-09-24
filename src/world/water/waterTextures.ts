// Textures behind the river surface and the light on its bed, built once at
// startup. Technique adapted from Clearwater by Aurélien / Lumaris
// (https://github.com/Aureliengmz/clearwater, MIT): a tileable wave slope
// field from an ocean spectrum (Tessendorf), mipmapped with the mean squared
// slope so distant water turns glossy instead of sparkling (LEAN mapping), and
// caustics made by refracting a fine grid of sun rays through the same waves
// onto a floor below (Evan Wallace's WebGL Water), with a slightly different
// index of refraction per colour channel.
//
// Tile sizes divide 4096 m, the period of the world coordinates the shaders
// sample with, so the patterns stay seamless where those coordinates wrap.

import { DataTexture, DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three';
import { Rng } from '../../core/rng';

/** Metres covered by one repeat of the wave texture (4096 / 800). */
export const WAVE_TILE = 5.12;
const N = 128;
/** Root-mean-square slope of the finest level (gentle ripples). */
const TARGET_SLOPE = 0.11;
/** Depth below the surface the caustics are focused for. */
const CAUSTIC_DEPTH = 2.2;
const IORS = [1.331, 1.334, 1.338];

/** Water optics shared by the surface and the bed (per metre, from Clearwater). */
export const waterOpticsGlsl = /* glsl */ `
#ifndef HR_WATER_OPTICS
#define HR_WATER_OPTICS
const float W_IOR = 1.3335;
const vec3 W_SIG_A = vec3(0.40, 0.074, 0.088);
const vec3 W_SIG_S = vec3(0.028, 0.052, 0.068);
const vec3 W_SIG_T = W_SIG_A + W_SIG_S;
const float W_TILE = ${WAVE_TILE.toFixed(4)};
// rotations whose lattices keep the 4096 m coordinate wrap seamless for
// tiles of W_TILE * 2.5, 0.8 and 0.32 (W_ROT1) and W_TILE * 0.128 (W_ROT2)
const mat2 W_ROT1 = mat2(0.8, 0.6, -0.6, 0.8);
const mat2 W_ROT2 = mat2(0.28, 0.96, -0.96, 0.28);
float wFresnel(float ci, float n) {
  ci = clamp(ci, 0.0, 1.0);
  float st2 = (1.0 - ci * ci) / (n * n);
  float ct = sqrt(max(1.0 - st2, 0.0));
  float rs = (ci - n * ct) / (ci + n * ct);
  float rp = (n * ci - ct) / (n * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}
// cosine of a ray inside the water, from its cosine above the surface
float wCosInside(float ci) {
  return sqrt(max(1.0 - (1.0 - ci * ci) / (W_IOR * W_IOR), 0.0));
}
#endif
`;

export interface WaterTextures {
  /** rg: slope (dh/ds, dh/dz), b: height, a: mean squared slope; mipmapped for LEAN. */
  waves: DataTexture;
  /** rgb: caustic brightness / 4 (mean 0.25); the same tile as the waves. */
  caustics: DataTexture;
}

let cached: WaterTextures | null = null;

export function waterTextures(): WaterTextures {
  if (!cached) {
    const field = waveField(N, WAVE_TILE, 0x5eed);
    cached = { waves: wavesTexture(field), caustics: causticsTexture(field) };
  }
  return cached;
}

export interface WaveField {
  n: number;
  tile: number;
  sx: Float32Array;
  sz: Float32Array;
  h: Float32Array;
}

/** Wind ripples on a periodic n x n grid covering tile metres (static snapshot of a Phillips spectrum). */
export function waveField(n: number, tile: number, seed: number, wind = 3.4, small = 0.09): WaveField {
  const rng = new Rng(seed);
  const gauss = () => {
    const u = Math.max(1e-9, rng.next());
    const v = rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const g = 9.81 * 0.73; // Heaven's River spin gravity
  // wind (m/s): a light breeze over sheltered water. Lw is the largest wave it
  // builds; small damps wavelets below a few decimetres so the surface reads
  // as ripples rather than grain
  const Lw = (wind * wind) / g;
  const wd = [Math.cos(0.35), Math.sin(0.35)];
  const hr = new Float64Array(n * n);
  const hi = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const mi = i < n / 2 ? i : i - n;
      const mj = j < n / 2 ? j : j - n;
      const kx = (2 * Math.PI * mi) / tile;
      const kz = (2 * Math.PI * mj) / tile;
      const k = Math.hypot(kx, kz);
      if (k < 1e-6) continue;
      const cosW = (kx * wd[0] + kz * wd[1]) / k;
      // mostly down-wind, with some ripples in every direction
      const dir = 0.3 + 0.7 * cosW * cosW;
      const p = (Math.exp(-1 / (k * Lw * k * Lw)) / (k * k * k * k)) * dir * Math.exp(-(k * small) * (k * small));
      const a = Math.sqrt(p / 2);
      hr[j * n + i] = gauss() * a;
      hi[j * n + i] = gauss() * a;
    }
  }
  // Hermitian symmetry so the field is real: h(-k) = conj(h(k))
  const Hr = new Float64Array(n * n);
  const Hi = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = ((n - j) % n) * n + ((n - i) % n);
      Hr[j * n + i] = hr[j * n + i] + hr[c];
      Hi[j * n + i] = hi[j * n + i] - hi[c];
    }
  }
  const out = (mul: (kx: number, kz: number) => [number, number, number, number]) => {
    // spectrum times (a + ib) per k, inverse FFT, real part
    const re = new Float64Array(n * n);
    const im = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const mi = i < n / 2 ? i : i - n;
        const mj = j < n / 2 ? j : j - n;
        const [a, b] = mul((2 * Math.PI * mi) / tile, (2 * Math.PI * mj) / tile);
        const x = Hr[j * n + i];
        const y = Hi[j * n + i];
        re[j * n + i] = x * a - y * b;
        im[j * n + i] = x * b + y * a;
      }
    }
    fft2d(re, im, n, true);
    return re;
  };
  const h = out(() => [1, 0, 0, 0]);
  const sx = out((kx) => [0, kx, 0, 0]); // i kx h
  const sz = out((_, kz) => [0, kz, 0, 0]);
  let ss = 0;
  for (let q = 0; q < n * n; q++) ss += sx[q] * sx[q] + sz[q] * sz[q];
  const scale = TARGET_SLOPE / Math.sqrt(ss / (n * n) + 1e-30);
  const f = (a: Float64Array) => Float32Array.from(a, (v) => v * scale);
  return { n, tile, sx: f(sx), sz: f(sz), h: f(h) };
}

function wavesTexture(w: WaveField): DataTexture {
  const n = w.n;
  // level 0, then box-filtered mips: slopes average, and so does the squared
  // slope, so their difference at any level is the slope variance it hides
  let lv = new Float32Array(n * n * 4);
  for (let q = 0; q < n * n; q++) {
    lv[q * 4] = w.sx[q];
    lv[q * 4 + 1] = w.sz[q];
    lv[q * 4 + 2] = w.h[q];
    lv[q * 4 + 3] = w.sx[q] * w.sx[q] + w.sz[q] * w.sz[q];
  }
  const levels: Float32Array[] = [lv];
  for (let size = n; size > 1; size >>= 1) {
    const s2 = size >> 1;
    const next = new Float32Array(s2 * s2 * 4);
    for (let j = 0; j < s2; j++) {
      for (let i = 0; i < s2; i++) {
        for (let c = 0; c < 4; c++) {
          const at = (x: number, y: number) => lv[(y * size + x) * 4 + c];
          next[(j * s2 + i) * 4 + c] = 0.25 * (at(2 * i, 2 * j) + at(2 * i + 1, 2 * j) + at(2 * i, 2 * j + 1) + at(2 * i + 1, 2 * j + 1));
        }
      }
    }
    levels.push(next);
    lv = next;
  }
  const half = (a: Float32Array) => Uint16Array.from(a, (v) => DataUtils.toHalfFloat(v));
  const tex = new DataTexture(half(levels[0]), n, n, RGBAFormat, HalfFloatType);
  tex.mipmaps = levels.map((l, i) => ({ data: half(l), width: n >> i, height: n >> i })) as unknown as typeof tex.mipmaps;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Sun straight overhead, rays refracted through the waves onto a flat floor CAUSTIC_DEPTH below. */
export function causticsField(w: WaveField, size: number, depth = CAUSTIC_DEPTH): Float32Array[] {
  const n = w.n;
  const sub = 4; // rays per wave texel, per axis
  const R = n * sub;
  const cell = w.tile / size;
  const slope = (arr: Float32Array, x: number, y: number) => {
    // bilinear, periodic
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const x0 = ((Math.floor(x) % n) + n) % n;
    const y0 = ((Math.floor(y) % n) + n) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const a = arr[y0 * n + x0] * (1 - fx) + arr[y0 * n + x1] * fx;
    const b = arr[y1 * n + x0] * (1 - fx) + arr[y1 * n + x1] * fx;
    return a * (1 - fy) + b * fy;
  };
  const channels: Float32Array[] = [];
  for (const ior of IORS) {
    const acc = new Float32Array(size * size);
    const eta = 1 / ior;
    for (let v = 0; v < R; v++) {
      for (let u = 0; u < R; u++) {
        const tx = (u + 0.5) / sub;
        const ty = (v + 0.5) / sub;
        const gx = slope(w.sx, tx, ty);
        const gz = slope(w.sz, tx, ty);
        // surface normal and the refracted ray of a vertical sun ray (0, -1, 0)
        const il = 1 / Math.sqrt(gx * gx + gz * gz + 1);
        const nx = -gx * il;
        const ny = il;
        const nz = -gz * il;
        const cosi = ny;
        const k = 1 - eta * eta * (1 - cosi * cosi);
        const c = eta * cosi - Math.sqrt(Math.max(k, 0));
        const dx = c * nx;
        const dy = -eta + c * ny;
        const dz = c * nz;
        const t = depth / Math.max(-dy, 1e-3);
        const px = ((tx / n) * w.tile + dx * t) / cell;
        const pz = ((ty / n) * w.tile + dz * t) / cell;
        // bilinear splat, periodic
        const ix = Math.floor(px);
        const iz = Math.floor(pz);
        const fx = px - ix;
        const fz = pz - iz;
        const x0 = ((ix % size) + size) % size;
        const z0 = ((iz % size) + size) % size;
        const x1 = (x0 + 1) % size;
        const z1 = (z0 + 1) % size;
        acc[z0 * size + x0] += (1 - fx) * (1 - fz);
        acc[z0 * size + x1] += fx * (1 - fz);
        acc[z1 * size + x0] += (1 - fx) * fz;
        acc[z1 * size + x1] += fx * fz;
      }
    }
    // mean 1, then a light tent blur against splat noise
    const mean = (R * R) / (size * size);
    const blur = new Float32Array(size * size);
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const wgt = (dx ? 1 : 2) * (dz ? 1 : 2);
            s += wgt * acc[((z + dz + size) % size) * size + ((x + dx + size) % size)];
          }
        }
        blur[z * size + x] = s / 16 / mean;
      }
    }
    channels.push(blur);
  }
  return channels;
}

function causticsTexture(w: WaveField): DataTexture {
  const size = 256;
  const [r, g, b] = causticsField(w, size);
  const data = new Uint8Array(size * size * 4);
  for (let q = 0; q < size * size; q++) {
    data[q * 4] = Math.min(255, Math.round(r[q] * 64));
    data[q * 4 + 1] = Math.min(255, Math.round(g[q] * 64));
    data[q * 4 + 2] = Math.min(255, Math.round(b[q] * 64));
    data[q * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** In-place radix-2 FFT of an n x n complex grid (rows, then columns). Inverse includes 1/n^2. */
function fft2d(re: Float64Array, im: Float64Array, n: number, inverse: boolean): void {
  const r = new Float64Array(n);
  const i = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      r[x] = re[y * n + x];
      i[x] = im[y * n + x];
    }
    fft1d(r, i, inverse);
    for (let x = 0; x < n; x++) {
      re[y * n + x] = r[x];
      im[y * n + x] = i[x];
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      r[y] = re[y * n + x];
      i[y] = im[y * n + x];
    }
    fft1d(r, i, inverse);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = r[y];
      im[y * n + x] = i[y];
    }
  }
  if (inverse) {
    const s = 1 / (n * n);
    for (let q = 0; q < n * n; q++) {
      re[q] *= s;
      im[q] *= s;
    }
  }
}

function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let a = 1, b = 0; a < n; a++) {
    let bit = n >> 1;
    for (; b & bit; bit >>= 1) b ^= bit;
    b ^= bit;
    if (a < b) {
      [re[a], re[b]] = [re[b], re[a]];
      [im[a], im[b]] = [im[b], im[a]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let s = 0; s < n; s += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[s + k];
        const ai = im[s + k];
        const br = re[s + k + len / 2] * cr - im[s + k + len / 2] * ci;
        const bi = re[s + k + len / 2] * ci + im[s + k + len / 2] * cr;
        re[s + k] = ar + br;
        im[s + k] = ai + bi;
        re[s + k + len / 2] = ar - br;
        im[s + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}
