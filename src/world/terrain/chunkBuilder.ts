// Builds the vertex data for one terrain chunk (runs inside a worker).

import { R } from '../../config';
import { clamp, lerp, smoothstep } from '../../core/math';
import { value2 } from '../../core/noise';
import { hash2 } from '../../core/rng';
import { newSample, type TerrainSample, WorldGen } from '../gen/world';
import { TREE_STRIDE, type ChunkRequest, type ChunkResult, type WaterData } from './chunkTypes';

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// sRGB palette (converted to linear in the shader)
const C = {
  grassGold: hex('#7c9a3e'),
  grassLush: hex('#4f8a32'),
  grassDry: hex('#a0a052'),
  reeds: hex('#7a7434'),
  mud: hex('#6b5a3e'),
  sand: hex('#b9a47c'),
  bed: hex('#5a5238'),
  forest: hex('#3b4d22'),
  orchard: hex('#74903c'),
  farm: hex('#94904e'),
  rock: hex('#7d7369'),
  rockDark: hex('#5b534d'),
  snow: hex('#eef1f5'),
  town: hex('#8e7d62'),
  townLawn: hex('#6e7a42'),
  path: hex('#9b8763'),
  scree: hex('#978a78'),
};

function mix3(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export interface BiomeOut {
  rgb: RGB;
  grass: number;
  rock: number;
  sand: number;
  farm: number;
  snow: number;
}

/** Colour and material weights for a terrain sample with surface normal y-component ny. */
/** Towpath along the main rivers (spec 7.6): a trodden strip 9-16 m from the channel edge. */
export function towpathMask(o: TerrainSample): number {
  const e = o.mainEdge;
  if (e < 8 || e > 17) return 0;
  return smoothstep(8.5, 10, e) * (1 - smoothstep(14.5, 16.5, e)) * (1 - smoothstep(0.2, 0.5, o.town));
}

export function biomeColor(o: TerrainSample, ny: number, s: number, z: number, out: BiomeOut, spacing = 1): BiomeOut {
  const col = out.rgb;
  const slope = 1 - ny;
  // gradient (tan of the slope angle): fields only on gentle ground
  const grad = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(ny, 0.05);
  const arable = smoothstep(0.26, 0.1, grad);
  const alpine = smoothstep(1700, 3000, o.h - o.baseLevel);
  const m = o.moisture;
  mix3(C.grassGold, C.grassLush, smoothstep(0.35, 0.8, m), col);
  mix3(col, C.grassDry, smoothstep(0.35, 0.05, m) * 0.7, col);
  let grass = 1;
  let rock = 0;
  let sand = 0;
  let farm = 0;
  let snow = 0;
  const forest = o.forest * (1 - alpine);
  if (forest > 0) mix3(col, C.forest, forest * 0.85, col);
  if (o.orchard > 0) mix3(col, C.orchard, o.orchard * 0.5 * arable * (1 - alpine), col);
  const f0 = o.farm * arable * (1 - alpine);
  if (f0 > 0) {
    mix3(col, C.farm, f0, col);
    farm = f0;
  }
  // wetlands and reed beds on low ground near water
  const above = o.h - o.baseLevel;
  const wet = (1 - smoothstep(30, 260, o.edge)) * (1 - smoothstep(1.5, 5, above)) * smoothstep(0.3, 0.7, m);
  if (wet > 0) {
    mix3(col, C.reeds, wet * 0.8, col);
    farm *= 1 - wet;
  }
  // banks: mud/sand band at the waterline
  const bank = 1 - smoothstep(0.5, 9, o.edge);
  if (bank > 0) {
    const hv = (hash2(Math.floor(s / 180), Math.floor(z / 180), 91) & 255) / 255;
    mix3(col, hv > 0.5 ? C.sand : C.mud, bank, col);
    sand = Math.max(sand, bank);
    farm *= 1 - bank;
  }
  if (o.water > o.h) {
    mix3(col, C.bed, smoothstep(0, 1.5, o.water - o.h), col);
    sand = 1;
    grass = 0;
    farm = 0;
  }
  // rock on steep slopes and ridges
  const r = clamp(smoothstep(0.75, 1.3, grad) + o.ridge * 0.9 * smoothstep(0.35, 0.7, grad) + alpine * smoothstep(0.45, 0.8, grad), 0, 1);
  void slope;
  if (r > 0) {
    mix3(col, slope > 0.6 ? C.rockDark : C.rock, r, col);
    rock = r;
    grass *= 1 - r;
    farm *= 1 - r;
  }
  // scree and snow on barrier peaks
  const alt = o.h;
  if (alt > 3500) {
    const sc = smoothstep(3500, 5500, alt) * (1 - r * 0.5);
    mix3(col, C.scree, sc * 0.6, col);
    grass *= 1 - sc;
    const sn = smoothstep(6200, 7400, alt + (hash2(Math.floor(s / 90), Math.floor(z / 90), 3) & 255) * 3) * smoothstep(0.75, 0.45, slope);
    if (sn > 0) {
      mix3(col, C.snow, sn, col);
      snow = sn;
      rock *= 1 - sn;
    }
  }
  // the towpath fades out on coarse chunks, where it would only alias
  const tp = towpathMask(o) * (1 - smoothstep(3, 8, spacing)) * (1 - r);
  if (tp > 0) {
    mix3(col, C.path, tp * 0.9, col);
    grass *= 1 - tp * 0.85;
    farm *= 1 - tp;
  }
  if (o.town > 0) {
    // yards: patches of lawn and trodden earth (colour only: grass blades would
    // poke through the streets, which are thin meshes laid on the ground)
    const n = 0.65 * value2(s / 11, z / 11, 0, 71) + 0.35 * value2(s / 3.7, z / 3.7, 0, 72);
    const lawn = smoothstep(0.42, 0.62, n);
    mix3(C.town, C.townLawn, lawn, _yard);
    // (the cuts of quays and canals keep their rock colour)
    mix3(col, _yard, o.town * 0.85 * (1 - rock * o.cut), col);
    grass *= 1 - o.town;
    farm *= 1 - o.town;
  }
  out.grass = clamp(grass, 0, 1);
  out.rock = rock;
  out.sand = sand;
  out.farm = farm;
  out.snow = snow;
  return out;
}

const _yard: RGB = [0, 0, 0];
const _bo: BiomeOut = { rgb: [0, 0, 0], grass: 0, rock: 0, sand: 0, farm: 0, snow: 0 };
const _t2 = newSample();

export function buildChunk(gen: WorldGen, req: ChunkRequest): ChunkResult {
  const t0 = performance.now();
  const N = req.n;
  const G = N + 3; // grid with a one-sample border
  const ds = req.sizeS / N;
  const dz = req.sizeZ / N;
  const spacing = Math.max(ds, dz);
  const minWl = spacing * 2.2;
  const anchorS = req.s0 + req.sizeS / 2;
  const anchorZ = req.z0 + req.sizeZ / 2;
  const ctx = gen.region(req.s0 - ds, req.z0 - dz, req.s0 + req.sizeS + ds, req.z0 + req.sizeZ + dz, spacing);

  const H = new Float32Array(G * G);
  const W = new Float32Array(G * G);
  const FS = new Float32Array(G * G);
  const FZ = new Float32Array(G * G);
  const KIND = new Uint8Array(G * G);
  const samples: TerrainSample[] = [];
  const o = newSample();
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const s = req.s0 + (i - 1) * ds;
      const z = req.z0 + (j - 1) * dz;
      gen.sample(s, z, minWl, o, ctx);
      const k = j * G + i;
      H[k] = o.h;
      W[k] = o.water;
      FS[k] = o.flowS;
      FZ[k] = o.flowZ;
      KIND[k] = o.riverClass < 0 ? 255 : o.riverClass;
      if (i >= 1 && i <= N + 1 && j >= 1 && j <= N + 1) {
        samples.push({ ...o });
        if (o.h < hMin) hMin = o.h;
        if (o.h > hMax) hMax = o.h;
      }
    }
  }

  const V = (N + 1) * (N + 1);
  const skirtCount = 4 * (N + 1);
  const total = V + skirtCount;
  const position = new Float32Array(total * 3);
  const normal = new Int8Array(total * 4);
  const color = new Uint8Array(total * 4);
  const mat = new Uint8Array(total * 4);
  const under = new Float32Array(total);
  const skirtDepth = Math.max(2, spacing * 1.2);

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const v = j * (N + 1) + i;
      const k = (j + 1) * G + (i + 1);
      const h = H[k];
      position[v * 3] = (i * ds) - req.sizeS / 2;
      position[v * 3 + 1] = h;
      position[v * 3 + 2] = (j * dz) - req.sizeZ / 2;
      // normal from central differences in the unrolled frame
      const gx = (H[k + 1] - H[k - 1]) / (2 * ds);
      const gz = (H[k + G] - H[k - G]) / (2 * dz);
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      const nx = -gx * inv;
      const ny = inv;
      const nz = -gz * inv;
      normal[v * 4] = Math.round(nx * 127);
      normal[v * 4 + 1] = Math.round(ny * 127);
      normal[v * 4 + 2] = Math.round(nz * 127);
      const sm = samples[v];
      const s = req.s0 + i * ds;
      const z = req.z0 + j * dz;
      biomeColor(sm, ny, s, z, _bo, spacing);
      color[v * 4] = clamp(Math.round(_bo.rgb[0]), 0, 255);
      color[v * 4 + 1] = clamp(Math.round(_bo.rgb[1]), 0, 255);
      color[v * 4 + 2] = clamp(Math.round(_bo.rgb[2]), 0, 255);
      color[v * 4 + 3] = Math.round(_bo.snow * 255);
      mat[v * 4] = Math.round(_bo.grass * 255);
      mat[v * 4 + 1] = Math.round(_bo.rock * 255);
      mat[v * 4 + 2] = Math.round(_bo.sand * 255);
      mat[v * 4 + 3] = Math.round(_bo.farm * 255);
      under[v] = W[k] > h ? W[k] - h : 0;
    }
  }
  // skirts: duplicate edge vertices, pushed down
  let sv = V;
  const edgeVerts: number[] = [];
  for (let i = 0; i <= N; i++) edgeVerts.push(i); // z = 0 edge
  for (let i = 0; i <= N; i++) edgeVerts.push(N * (N + 1) + i); // z = max edge
  for (let j = 0; j <= N; j++) edgeVerts.push(j * (N + 1)); // s = 0 edge
  for (let j = 0; j <= N; j++) edgeVerts.push(j * (N + 1) + N); // s = max edge
  for (const v of edgeVerts) {
    position[sv * 3] = position[v * 3];
    position[sv * 3 + 1] = position[v * 3 + 1] - skirtDepth;
    position[sv * 3 + 2] = position[v * 3 + 2];
    for (let c = 0; c < 4; c++) {
      normal[sv * 4 + c] = normal[v * 4 + c];
      color[sv * 4 + c] = color[v * 4 + c];
      mat[sv * 4 + c] = mat[v * 4 + c];
    }
    under[sv] = under[v];
    sv++;
  }

  // ---- water surface on the same grid, only where wet
  let water: WaterData | null = null;
  const wetQuads: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let wet = false;
      for (let q = 0; q < 4 && !wet; q++) {
        const k = (j + 1 + (q >> 1)) * G + (i + 1 + (q & 1));
        if (W[k] > H[k]) wet = true;
      }
      if (wet) wetQuads.push(j * N + i);
    }
  }
  if (wetQuads.length > 0) {
    const wpos = new Float32Array(V * 3);
    const wflow = new Float32Array(V * 2);
    const wdepth = new Float32Array(V);
    const wkind = new Uint8Array(V);
    const seam = 0.002 + Math.max(req.sizeS, req.sizeZ) * 2e-6;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const v = j * (N + 1) + i;
        const k = (j + 1) * G + (i + 1);
        let lvl = W[k];
        if (lvl < -1e8) {
          // borrow the level of a nearby wet vertex so the surface stays flat
          // under the shore; otherwise sink well below ground (never climb walls)
          let best = -1e9;
          for (let dj = -2; dj <= 2; dj++) {
            const jj = j + 1 + dj;
            if (jj < 0 || jj >= G) continue;
            for (let di = -2; di <= 2; di++) {
              const ii = i + 1 + di;
              if (ii < 0 || ii >= G) continue;
              const w = W[jj * G + ii];
              if (w > best) best = w;
            }
          }
          lvl = best > -1e8 ? Math.min(best, H[k] + 0.5) : H[k] - 6;
        }
        // overlap neighbouring water tiles by a hair (far below a pixel): float
        // rounding in the bend otherwise leaves pin-prick gaps along the seams
        wpos[v * 3] = position[v * 3] + (i === 0 ? -seam : i === N ? seam : 0);
        wpos[v * 3 + 1] = lvl;
        wpos[v * 3 + 2] = position[v * 3 + 2] + (j === 0 ? -seam : j === N ? seam : 0);
        wflow[v * 2] = FS[k];
        wflow[v * 2 + 1] = FZ[k];
        wdepth[v] = lvl - H[k];
        wkind[v] = KIND[k];
      }
    }
    const idx = V > 65535 ? new Uint32Array(wetQuads.length * 6) : new Uint16Array(wetQuads.length * 6);
    let p = 0;
    for (const q of wetQuads) {
      const i = q % N;
      const j = (q / N) | 0;
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + (N + 1);
      const d = c + 1;
      idx[p++] = a;
      idx[p++] = c;
      idx[p++] = d;
      idx[p++] = a;
      idx[p++] = d;
      idx[p++] = b;
    }
    // skirts: short curtains down from the tile's outer water edges. They are
    // drawn after every water surface, so the depth test hides them wherever a
    // surface is in front; they only show through seams between tiles of
    // different detail, where the bed would otherwise peek through
    const drop = 0.3 + (Math.max(req.sizeS, req.sizeZ) / N) * 0.002;
    const sp: number[] = [];
    const sf: number[] = [];
    const sd: number[] = [];
    const sk: number[] = [];
    const si: number[] = [];
    const curtain = (v0: number, v1: number) => {
      const b = sp.length / 3;
      for (const v of [v0, v1]) {
        for (const dy of [0, -drop]) {
          sp.push(wpos[v * 3], wpos[v * 3 + 1] + dy, wpos[v * 3 + 2]);
          sf.push(wflow[v * 2], wflow[v * 2 + 1]);
          sd.push(wdepth[v]);
          sk.push(wkind[v]);
        }
      }
      si.push(b, b + 1, b + 3, b, b + 3, b + 2);
    };
    for (const q of wetQuads) {
      const i = q % N;
      const j = (q / N) | 0;
      const a = j * (N + 1) + i;
      if (i === 0) curtain(a, a + (N + 1));
      if (i === N - 1) curtain(a + 1, a + 1 + (N + 1));
      if (j === 0) curtain(a, a + 1);
      if (j === N - 1) curtain(a + (N + 1), a + (N + 1) + 1);
    }
    const skirt =
      si.length > 0
        ? {
            position: new Float32Array(sp),
            flow: new Float32Array(sf),
            depth: new Float32Array(sd),
            kind: new Uint8Array(sk),
            index: sp.length / 3 > 65535 ? new Uint32Array(si) : new Uint16Array(si),
          }
        : null;
    water = { position: wpos, flow: wflow, depth: wdepth, kind: wkind, index: idx, skirt };
  }

  // ---- bounding sphere of the bent chunk
  const pts: number[][] = [];
  for (const u of [-0.5, 0, 0.5])
    for (const w of [-0.5, 0.5])
      for (const h of [hMin - skirtDepth, hMax]) {
        const th = (u * req.sizeS) / R;
        const r = R - h;
        const sh = Math.sin(th / 2);
        pts.push([r * Math.sin(th), h + r * 2 * sh * sh, w * req.sizeZ]);
      }
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let c = 0; c < 3; c++) {
      mn[c] = Math.min(mn[c], p[c]);
      mx[c] = Math.max(mx[c], p[c]);
    }
  const cx = (mn[0] + mx[0]) / 2;
  const cy = (mn[1] + mx[1]) / 2;
  const cz = (mn[2] + mx[2]) / 2;
  let rad = 0;
  for (const p of pts) rad = Math.max(rad, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));

  // ---- trees (fine levels only)
  let trees: Float32Array | null = null;
  if (req.veg) trees = placeTrees(gen, req, ctx);

  return {
    type: 'chunk',
    key: req.key,
    level: req.level,
    anchorS,
    anchorZ,
    hMin,
    hMax,
    sphere: [cx, cy, cz, rad * 1.02],
    position,
    normal,
    color,
    mat,
    under,
    water,
    trees,
    genMs: performance.now() - t0,
  };
}

/** Deterministic tree placement on a global jittered grid (stable across LODs). */
function placeTrees(gen: WorldGen, req: ChunkRequest, ctx: ReturnType<WorldGen['region']>): Float32Array {
  const CELL = 9;
  const out: number[] = [];
  const o = newSample();
  const i0 = Math.floor(req.s0 / CELL);
  const i1 = Math.floor((req.s0 + req.sizeS) / CELL);
  const j0 = Math.floor(req.z0 / CELL);
  const j1 = Math.floor((req.z0 + req.sizeZ) / CELL);
  const anchorS = req.s0 + req.sizeS / 2;
  const anchorZ = req.z0 + req.sizeZ / 2;
  const coarse = req.level < 7;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const h1 = hash2(i, j, 0x7ee5);
      const r1 = (h1 & 0xffff) / 65536;
      if (r1 > 0.55) continue; // quick reject: at most ~55% of cells can hold a tree
      const s = (i + 0.1 + 0.8 * ((h1 >>> 16) & 255) / 255) * CELL;
      const z = (j + 0.1 + 0.8 * ((h1 >>> 24) & 255) / 255) * CELL;
      if (s < req.s0 || s >= req.s0 + req.sizeS || z < req.z0 || z >= req.z0 + req.sizeZ) continue;
      gen.sample(s, z, 8, o, ctx);
      if (o.water > o.h - 0.3) continue;
      if (o.h - o.baseLevel > 2600) continue;
      const riverside = (1 - smoothstep(4, 30, o.edge)) * smoothstep(1.5, 3.5, o.edge) * 0.5;
      const scattered = 0.018 * (1 - o.farm) * (1 - o.town);
      const orchard = o.orchard * 0.5;
      const dens = Math.max(o.forest * 0.95, orchard, riverside, scattered) * (o.h > 3200 ? smoothstep(4200, 3200, o.h) : 1);
      if (r1 / 0.55 > dens) continue;
      if (o.town > 0.3) continue;
      // no trees on cliffs
      const h0 = o.h;
      const gs = (gen.sample(s + 4, z, 8, _t2, ctx).h - h0) / 4;
      const gz = (gen.sample(s, z + 4, 8, _t2, ctx).h - h0) / 4;
      if (gs * gs + gz * gz > 0.8) continue;
      let type = 0;
      if (riverside >= dens - 1e-6 && riverside > 0.05) type = 2; // willow
      else if (orchard >= dens - 1e-6 && orchard > 0.05) type = 3; // orchard
      else if (o.h > 1400 || ((h1 >>> 8) & 7) === 0) type = 1; // conifer / poplar
      const h2 = hash2(i, j, 0x51a7);
      const scale = lerp(0.7, 1.3, (h2 & 255) / 255) * (type === 3 ? 0.6 : 1);
      if (coarse && scale < 0.8 && type !== 1) continue;
      out.push(s - anchorS, o.h - 0.25, z - anchorZ, scale, ((h2 >>> 8) & 255) / 255 * Math.PI * 2, type, ((h2 >>> 16) & 255) / 255, 0);
    }
  }
  return new Float32Array(out);
}

export { TREE_STRIDE };
