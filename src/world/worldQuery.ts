// Main-thread gameplay queries against the section generator. Ground heights
// are interpolated from the finest chunk grid exactly like the rendered mesh,
// so feet always rest on the visible surface.

import { CHUNK_N, CIRC, MAX_LEVEL, ROOT_TILE_S, ROOT_TILE_Z, Z_MIN } from '../config';
import { mod } from '../core/math';
import { newSample, type TerrainSample, WorldGen } from './gen/world';

const DS = ROOT_TILE_S / (1 << MAX_LEVEL) / CHUNK_N;
const DZ = ROOT_TILE_Z / (1 << MAX_LEVEL) / CHUNK_N;
const MIN_WL = Math.max(DS, DZ) * 2.2;

export interface Collider {
  /** Push (s, z) out of solid footprints; returns ground/floor height if standing on a structure. */
  resolve(s: number, z: number, h: number, radius: number, out: { s: number; z: number; floor: number }): void;
  /** Highest walkable surface under (s, z) not above h + step, or null. */
  floorAt?(s: number, z: number, h: number, step?: number): number | null;
}

export class WorldQuery {
  gen: WorldGen;
  private cache = new Map<number, number>();
  private sample = newSample();
  colliders: Collider[] = [];

  constructor(gen: WorldGen) {
    this.gen = gen;
  }

  setGen(gen: WorldGen) {
    this.gen = gen;
    this.cache.clear();
  }

  private vertexHeight(i: number, j: number): number {
    const key = i * 1_048_576 + j; // i < ~524k, unique enough within a session
    const c = this.cache.get(key);
    if (c !== undefined) return c;
    const s = i * DS;
    const z = Z_MIN + j * DZ;
    const h = this.gen.sample(s, z, MIN_WL, this.sample).h;
    if (this.cache.size > 4096) this.cache.clear();
    this.cache.set(key, h);
    return h;
  }

  /** Ground height matching the finest rendered terrain triangles. */
  groundHeight(s: number, z: number): number {
    const u = mod(s, CIRC) / DS;
    const v = (z - Z_MIN) / DZ;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fx = u - i;
    const fz = v - j;
    const ha = this.vertexHeight(i, j);
    const hd = this.vertexHeight(i + 1, j + 1);
    if (fz > fx) {
      const hc = this.vertexHeight(i, j + 1);
      return ha + (hd - hc) * fx + (hc - ha) * fz;
    }
    const hb = this.vertexHeight(i + 1, j);
    return ha + (hb - ha) * fx + (hd - hb) * fz;
  }

  /** Ground slope normal (unrolled local frame) from the rendered grid. */
  groundNormal(s: number, z: number, out: { x: number; y: number; z: number }) {
    const h0 = this.groundHeight(s, z);
    const hx = this.groundHeight(s + 0.5, z);
    const hz = this.groundHeight(s, z + 0.5);
    const gx = (hx - h0) / 0.5;
    const gz = (hz - h0) / 0.5;
    const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    out.x = -gx * inv;
    out.y = inv;
    out.z = -gz * inv;
    return out;
  }

  /** Walkable structure surface (piers, bridges, decks) under a point, if any. */
  structureFloor(s: number, z: number, h: number, step = 0.6): number | null {
    let best: number | null = null;
    for (const c of this.colliders) {
      const f = c.floorAt?.(s, z, h, step);
      if (f !== null && f !== undefined && (best === null || f > best)) best = f;
    }
    return best;
  }

  /** Full sample at full detail (water level, flow, town mask...). */
  sampleAt(s: number, z: number, out: TerrainSample = newSample()): TerrainSample {
    return this.gen.sample(s, z, MIN_WL, out);
  }
}
