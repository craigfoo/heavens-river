// WorldGen: the deterministic generator for one topopolis section.
// Pure (no three.js) so it runs identically in workers and on the main thread.
//
// Terrain is built "valley first": every drainage feature (main river,
// tributary) defines a valley surface that rises from its water level; the
// ground is the smooth minimum of these surfaces and the hill field. Water
// therefore always sits in a channel.

import { CIRC, L, R, Z_MAX, Z_MIN } from '../../config';
import { clamp, lerp, smin, smoothstep } from '../../core/math';
import { CylFbm, value2 } from '../../core/noise';
import { Rng, seedFor } from '../../core/rng';
import { riverName, townName } from './names';
import {
  type ChannelHit,
  MainRiver,
  RIVER_CANAL,
  RIVER_MAIN,
  RIVER_TRIB,
  Tributary,
  type TributaryDesc,
  tributaryDescs,
  wrapDs,
} from './rivers';
import { planTownSites, type TownSite, type TownTerrain } from './settlements';

/** Dimensions of the hillside maintenance hatch block (metres). */
export const HATCH = { halfW: 4.2, depth: 4.6, height: 5.3, berm: 3.6 };

export interface TerrainSample {
  h: number;
  /** Water surface height, or -1e9 when this point is not near water. */
  water: number;
  /** Distance from the nearest channel edge (negative inside a channel). */
  edge: number;
  /** Distance from the main river channel edge. */
  mainEdge: number;
  /** Index of the owning main river. */
  river: number;
  flowS: number;
  flowZ: number;
  riverClass: number;
  /** 0 = valley floor, 1 = hills. */
  hill: number;
  moisture: number;
  forest: number;
  farm: number;
  orchard: number;
  town: number;
  ridge: number;
  /** Height of water level of the owning main river (for biome decisions). */
  baseLevel: number;
}

export function newSample(): TerrainSample {
  return {
    h: 0,
    water: -1e9,
    edge: 1e9,
    mainEdge: 1e9,
    river: 0,
    flowS: 0,
    flowZ: 0,
    riverClass: -1,
    hill: 0,
    moisture: 0,
    forest: 0,
    farm: 0,
    orchard: 0,
    town: 0,
    ridge: 0,
    baseLevel: 0,
  };
}

interface TribRef {
  t: Tributary;
  c0: number;
  c1: number;
}

export interface RegionCtx {
  tribs: TribRef[];
  towns: TownTerrain[];
  coarse: boolean;
}

const GRID = 8000; // tributary lookup grid cell (m)
/** Ground level of the barrier foothills shared by neighbouring sections. */
const BOUNDARY_BASE = 160;

export class WorldGen {
  readonly section: number;
  readonly seed: number;
  readonly rivers: MainRiver[] = [];
  readonly tribDescs: TributaryDesc[] = [];
  readonly towns: TownSite[] = [];
  private tribCache = new Map<number, Tributary>();
  private tribGrid = new Map<number, number[]>();
  private townTerrainCache = new Map<number, TownTerrain>();
  private townGrid = new Map<number, TownSite[]>();

  // noise fields
  private amp: CylFbm;
  private hills: CylFbm;
  private warp: CylFbm;
  private ridgeMask: CylFbm;
  private ridges: CylFbm;
  private detail: CylFbm;
  private flood: CylFbm;
  private biome: CylFbm;
  private barrierNear: CylFbm;
  private barrierFar: CylFbm;
  private barrierCrestNear: CylFbm;
  private barrierCrestFar: CylFbm;
  private readonly seedBiome: number;

  constructor(section: number, worldSeed = 0x5eed) {
    this.section = section;
    this.seed = seedFor(worldSeed, `section:${section}`);
    const sd = this.seed;
    this.amp = new CylFbm(seedFor(sd, 'amp'), 70_000, 3, 0.5);
    this.hills = new CylFbm(seedFor(sd, 'hills'), 11_000, 11, 0.49);
    this.warp = new CylFbm(seedFor(sd, 'warp'), 24_000, 3, 0.5);
    this.ridgeMask = new CylFbm(seedFor(sd, 'rmask'), 110_000, 2, 0.5);
    this.ridges = new CylFbm(seedFor(sd, 'ridges'), 16_000, 8, 0.5);
    this.detail = new CylFbm(seedFor(sd, 'detail'), 90, 5, 0.45);
    this.flood = new CylFbm(seedFor(sd, 'flood'), 900, 4, 0.5);
    this.biome = new CylFbm(seedFor(sd, 'biome'), 9000, 4, 0.55);
    this.seedBiome = seedFor(sd, 'bmask');
    // Barrier noise is keyed by the boundary index so neighbouring sections agree.
    const bNear = seedFor(worldSeed, `boundary:${section}`);
    const bFar = seedFor(worldSeed, `boundary:${section + 1}`);
    this.barrierNear = new CylFbm(bNear, 9_000, 9, 0.5);
    this.barrierFar = new CylFbm(bFar, 9_000, 9, 0.5);
    this.barrierCrestNear = new CylFbm(bNear + 1, 60_000, 3, 0.5);
    this.barrierCrestFar = new CylFbm(bFar + 1, 60_000, 3, 0.5);

    const nameRng = new Rng(seedFor(sd, 'names'));
    for (let i = 0; i < 4; i++) this.rivers.push(new MainRiver(i, sd, riverName(nameRng)));
    let id = 0;
    for (const r of this.rivers) {
      const d = tributaryDescs(r, sd, id, riverName);
      id += d.length;
      this.tribDescs.push(...d);
    }
    for (const d of this.tribDescs) {
      const gs0 = Math.floor(d.sMin / GRID);
      const gs1 = Math.floor(d.sMax / GRID);
      const gz0 = Math.floor(d.zMin / GRID);
      const gz1 = Math.floor(d.zMax / GRID);
      for (let gs = gs0; gs <= gs1; gs++)
        for (let gz = gz0; gz <= gz1; gz++) {
          const k = this.gridKey(gs, gz);
          let list = this.tribGrid.get(k);
          if (!list) this.tribGrid.set(k, (list = []));
          list.push(d.id);
        }
    }
    this.towns.push(...planTownSites(this, seedFor(sd, 'towns'), townName));
    for (const site of this.towns) {
      const pad = site.radius + 400;
      for (let gs = Math.floor((site.s - pad) / GRID); gs <= Math.floor((site.s + pad) / GRID); gs++)
        for (let gz = Math.floor((site.z - pad) / GRID); gz <= Math.floor((site.z + pad) / GRID); gz++) {
          const k = this.gridKey(gs, gz);
          let list = this.townGrid.get(k);
          if (!list) this.townGrid.set(k, (list = []));
          list.push(site);
        }
    }
    this.hatch = this.findHatch();
  }

  /** Maintenance hatch set into a hillside overlooking the first river city (the arrival point). */
  hatch: { s: number; z: number; yaw: number; base: number; city: number } | null = null;

  private findHatch(): { s: number; z: number; yaw: number; base: number; city: number } | null {
    const city = this.towns.find((t) => t.kind === 'city') ?? this.towns[0];
    if (!city) return null;
    const smp = newSample();
    const target = { s: city.s, z: city.z, h: city.level + 12 };
    let best: { s: number; z: number; yaw: number; score: number } | null = null;
    for (let ring = 0; ring < 7; ring++) {
      const dist = 1100 + ring * 700;
      for (let k = 0; k < 24; k++) {
        const ang = (k / 24) * Math.PI * 2;
        const s = city.s + Math.sin(ang) * dist;
        const z = city.z + Math.cos(ang) * dist;
        if (z < 20_000 || z > L - 20_000) continue;
        const o = this.sample(s, z, 0, smp);
        if (o.water > o.h - 0.5 || o.town > 0.1) continue;
        const rise = o.h - city.level;
        if (rise < 25) continue;
        // line of sight from eye height to the city centre
        let blocked = 0;
        for (let i = 1; i < 20; i++) {
          const f = i / 20;
          const lh = o.h + 1.2 + (target.h - o.h - 1.2) * f;
          if (this.heightAt(s + (target.s - s) * f, z + (target.z - z) * f) > lh - 2) blocked++;
        }
        if (blocked > 1) continue;
        // prefer a slope that rises behind the viewpoint (somewhere to cut the hatch into)
        const dS = wrapDs(city.s - s);
        const dZ = city.z - z;
        const dl = Math.hypot(dS, dZ);
        const behind = this.heightAt(s - (dS / dl) * 25, z - (dZ / dl) * 25) - o.h;
        // look down on the city from a slope: steeper view angle, nearer, hill at our back
        const view = (Math.atan2(rise, dist) * 180) / Math.PI;
        const score = Math.min(view, 6) * 10 - dist * 0.0025 - blocked * 40 - o.forest * 30 + clamp(behind, -5, 12) * 4;
        if (!best || score > best.score) best = { s, z, yaw: Math.atan2(-dS, -dZ), score };
      }
    }
    if (!best) {
      const s = city.s;
      const z = city.z - city.halfLen - 600;
      best = { s, z, yaw: 0, score: 0 };
    }
    const base = this.heightAt(best.s, best.z);
    return { s: best.s, z: best.z, yaw: best.yaw, base, city: city.id };
  }

  /**
   * Terrain around the hatch: a level apron in front, a hollow under the
   * concrete portal block (hidden inside it) and a turf berm hugging its sides
   * and back. Local frame: u = metres in front of the facade, v = lateral.
   */
  private hatchTerrain(s: number, z: number, h: number, o: TerrainSample): number {
    const hc = this.hatch!;
    const ds = wrapDs(s - hc.s);
    const dz = z - hc.z;
    if (Math.abs(ds) > 45 || Math.abs(dz) > 45) return h;
    const fs = -Math.sin(hc.yaw);
    const fz = -Math.cos(hc.yaw);
    const u = ds * fs + dz * fz;
    const v = Math.abs(ds * fz - dz * fs);
    const b = hc.base;
    // berm: highest against the block, sloping away; only behind the facade line
    const dv = Math.max(0, v - HATCH.halfW);
    const du = Math.max(0, -u - HATCH.depth);
    const berm = b + HATCH.berm - Math.hypot(dv, du) * 0.6;
    const wBerm = smoothstep(-0.15, -0.9, u);
    h = Math.max(h, lerp(h, berm, wBerm));
    // level apron in front of the door
    const wA = (1 - smoothstep(5, 9, v)) * smoothstep(-1.0, 0.3, u) * (1 - smoothstep(9, 18, u));
    h = lerp(h, b - 0.04, wA);
    // trodden gravel instead of grass right in front of the door
    o.town = Math.max(o.town, wA * (1 - smoothstep(3, 9, u)) * (1 - smoothstep(4, 7, v)));
    // hollow under the block (its walls hide the transition)
    const wDip = (1 - smoothstep(HATCH.halfW - 1.9, HATCH.halfW - 1.1, v)) * (1 - smoothstep(HATCH.depth - 1.2, HATCH.depth - 0.6, -u)) * (1 - smoothstep(0.1, 0.6, u));
    h = lerp(h, b - 0.5, wDip);
    const k = smoothstep(12, 26, Math.hypot(ds, dz));
    o.forest *= k;
    o.farm *= k;
    o.orchard *= k;
    return h;
  }

  /** Town sites whose footprint may cover (s, z). */
  townsNear(s: number, z: number): TownSite[] {
    return this.townGrid.get(this.gridKey(Math.floor(s / GRID), Math.floor(z / GRID))) ?? [];
  }

  private gridKey(gs: number, gz: number): number {
    const nS = Math.ceil(CIRC / GRID) + 2;
    const gsw = ((gs % nS) + nS) % nS;
    return (gz + 1000) * nS + gsw;
  }

  // ---------------------------------------------------------------- rivers

  /** Main rivers bracketing s: [left, right, t] where t in [0,1] is the lateral fraction. */
  bracket(s: number): [MainRiver, MainRiver, number] {
    const q = CIRC / 4;
    const u = s / q - 0.5;
    const i0 = Math.floor(u);
    const t = u - i0;
    const a = this.rivers[((i0 % 4) + 4) % 4];
    const b = this.rivers[(((i0 + 1) % 4) + 4) % 4];
    return [a, b, t];
  }

  nearestRiver(s: number, z: number): MainRiver {
    const [a, b] = this.bracket(s);
    return a.valleyDistance(s, z) <= b.valleyDistance(s, z) ? a : b;
  }

  getTributary(id: number): Tributary {
    let t = this.tribCache.get(id);
    if (t) {
      // refresh LRU order
      this.tribCache.delete(id);
      this.tribCache.set(id, t);
      return t;
    }
    const d = this.tribDescs[id];
    const r = this.rivers[d.river];
    const chS = r.channelAt(d.zc);
    const w = r.widthAt(d.zc);
    const mouthS = chS + d.side * w * 0.42;
    t = new Tributary(d, mouthS, r.levelAt(d.zc), (s, z) => this.envHeight(s, z));
    this.tribCache.set(id, t);
    if (this.tribCache.size > 260) {
      const first = this.tribCache.keys().next().value as number;
      this.tribCache.delete(first);
    }
    return t;
  }

  /** Tributaries whose influence may reach the box [s0,s1]x[z0,z1]. */
  tributariesIn(s0: number, z0: number, s1: number, z1: number): TributaryDesc[] {
    const out: TributaryDesc[] = [];
    const seen = new Set<number>();
    const gs0 = Math.floor(s0 / GRID);
    const gs1 = Math.floor(s1 / GRID);
    const gz0 = Math.floor(z0 / GRID);
    const gz1 = Math.floor(z1 / GRID);
    for (let gs = gs0; gs <= gs1; gs++)
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = this.tribGrid.get(this.gridKey(gs, gz));
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(this.tribDescs[id]);
        }
      }
    return out;
  }

  /** Build a region context for fast sampling inside a box. */
  region(s0: number, z0: number, s1: number, z1: number, spacing: number): RegionCtx {
    const pad = 4200;
    const coarse = spacing > 24;
    const tribs: TribRef[] = [];
    for (const d of this.tributariesIn(s0 - pad, z0 - pad, s1 + pad, z1 + pad)) {
      const r = this.rivers[d.river];
      // unwrap the query box near this river
      const off = wrapDs((s0 + s1) / 2 - r.baseS);
      const cs = r.baseS + off;
      const hs = (s1 - s0) / 2;
      if (cs + hs + pad < d.sMin || cs - hs - pad > d.sMax) continue;
      if (z1 + pad < d.zMin || z0 - pad > d.zMax) continue;
      const t = this.getTributary(d.id);
      const [c0, c1] = t.coarseRange(cs - hs, z0, cs + hs, z1, pad);
      if (c1 > c0) tribs.push({ t, c0, c1 });
    }
    const towns: TownTerrain[] = [];
    for (const site of this.towns) {
      const ds = Math.abs(wrapDs(site.s - (s0 + s1) / 2)) - (s1 - s0) / 2;
      const dz = Math.max(z0 - site.z, site.z - z1, 0);
      if (ds < site.radius + 200 && dz < site.radius + 200) towns.push(this.townTerrain(site));
    }
    return { tribs, towns, coarse };
  }

  townTerrain(site: TownSite): TownTerrain {
    let t = this.townTerrainCache.get(site.id);
    if (!t) {
      t = site.terrain(this);
      this.townTerrainCache.set(site.id, t);
    }
    return t;
  }

  // ---------------------------------------------------------------- terrain

  /** Height of the hill field (no valleys), including ridges and barriers. */
  hillField(s: number, z: number, minWl: number, out?: TerrainSample): number {
    // Near a section end everything section-specific fades out so the barrier
    // crest (keyed only by the boundary) is identical from both sides.
    const u = Math.min(Math.abs(z), Math.abs(L - z));
    const own = smoothstep(3000, 26_000, u);
    let e = BOUNDARY_BASE;
    let ridge = 0;
    if (own > 0) {
      const [a, b, t] = this.bracket(s);
      const zc = clamp(z, a.zStart, a.zEnd);
      const zc2 = clamp(z, b.zStart, b.zEnd);
      const ref = lerp(a.levelAt(zc), b.levelAt(zc2), smoothstep(0.2, 0.8, t)) + 24;
      const ws = s + this.warp.sample(s, z, 4000) * 2600;
      const wz = z + this.warp.sample(s + 51_000, z - 33_000, 4000) * 2600;
      const A = lerp(70, 820, smoothstep(-0.45, 0.6, this.amp.sample(s, z)));
      const hn = this.hills.sample(ws, wz, minWl);
      const shape = Math.pow(clamp(0.52 + 0.62 * hn, 0, 1.2), 1.35);
      let es = ref + A * shape;
      const rm = smoothstep(0.18, 0.5, this.ridgeMask.sample(s, z));
      if (rm > 0) {
        ridge = rm * this.ridges.ridged(ws, wz, minWl);
        es += ridge * 2900;
      }
      e = lerp(BOUNDARY_BASE, es, own);
      ridge *= own;
    }
    e += this.barrier(s, z, minWl);
    if (out) out.ridge = ridge;
    return e;
  }

  /** Barrier mountain ring at both section ends (keyed by boundary seeds). */
  barrier(s: number, z: number, minWl: number): number {
    const near = z < L / 2;
    const u = near ? Math.abs(z) : Math.abs(L - z);
    if (u > 70_000) return 0;
    const crestN = near ? this.barrierCrestNear : this.barrierCrestFar;
    const peakN = near ? this.barrierNear : this.barrierFar;
    // unify coordinates across the crest so both sides of a boundary agree
    const zz = near ? z : z - L;
    const crest = 15_500 + 4500 * crestN.sample(s, 0);
    // passes: narrow dips in the crest
    const pn = crestN.sample(s * 3.1 + 1000, 7);
    const pass = smoothstep(0.35, 0.6, pn);
    const shape = Math.pow(1 - smoothstep(0, 66_000, u), 1.7);
    const rid = peakN.ridged(s, zz, minWl);
    const hBase = crest * (1 - 0.7 * pass) * shape;
    return hBase * (0.55 + 0.6 * rid) + shape * 600 * peakN.sample(s + 9000, zz, minWl);
  }

  /** Environment height without tributaries (used to set tributary levels). */
  envHeight(s: number, z: number): number {
    const tmp = _envSample;
    this.mainSurface(s, z, 60, tmp);
    return tmp.h;
  }

  /** Main valley + hills surface. Fills h, water, flow, edge, hill, baseLevel. */
  private mainSurface(s: number, z: number, minWl: number, o: TerrainSample): void {
    const [a, b] = this.bracket(s);
    const da = a.valleyDistance(s, z);
    const db = b.valleyDistance(s, z);
    const r = da <= db ? a : b;
    const dv = Math.min(da, db);
    const zc = clamp(z, r.zStart, r.zEnd);
    const E = this.hillField(s, z, minWl, o);
    const H = r.levelAt(zc);
    o.baseLevel = H;
    o.river = r.index;
    o.mainEdge = 1e9;
    const flood = r.floodHalfAt(zc) * (1 + 0.18 * this.flood.sample(s * 0.02, z * 0.02));
    const wall = r.wallWidthAt(zc);
    const v = smoothstep(flood, flood + wall, dv);
    o.hill = v;
    let h: number;
    o.water = -1e9;
    o.edge = 1e9;
    o.riverClass = -1;
    o.flowS = 0;
    o.flowZ = 0;
    if (dv < flood + wall + 3000) {
      const hit = r.channel(s, z, _hit);
      const halfW = hit.width * 0.5;
      const e = hit.d - halfW;
      const bankH = 1.7 + 0.8 * value2(s / 400, z / 400, 0, this.seedBiome);
      const bankW = 7 + hit.width * 0.06;
      let floor: number;
      if (e < 0) {
        const u = hit.d / halfW;
        floor = hit.level - hit.depth * (1 - Math.pow(u, 2.2));
      } else {
        const undul = this.flood.sample(s, z, minWl) * 1.6 * smoothstep(bankW, bankW + 90, e);
        floor = hit.level + bankH * smoothstep(0, bankW, e) + Math.max(undul, -bankH * 0.6);
      }
      h = lerp(floor, Math.max(E, floor), v);
      // channel always carved, even where it cuts the valley wall
      const carve = e < 0 ? floor : hit.level + bankH + e * 0.9;
      h = Math.min(h, carve);
      o.edge = e;
      o.mainEdge = e;
      const margin = bankW + 6;
      if (e < margin && z > r.zStart - 1500 && z < r.zEnd + 1500) {
        o.water = hit.level;
        o.riverClass = RIVER_MAIN;
        o.flowS = hit.fs * hit.speed;
        o.flowZ = hit.fz * hit.speed;
      }
    } else {
      h = E;
    }
    o.h = h;
  }

  /**
   * Full terrain sample. `minWl` skips noise octaves shorter than it (LOD).
   * Pass a RegionCtx from region() for fast repeated sampling in an area.
   */
  sample(s: number, z: number, minWl: number, o: TerrainSample, ctx?: RegionCtx): TerrainSample {
    s = ((s % CIRC) + CIRC) % CIRC;
    this.mainSurface(s, z, minWl, o);
    let h = o.h;
    const tribs = ctx ? ctx.tribs : this.adhocTribs(s, z);
    const coarse = ctx ? ctx.coarse : false;
    for (let i = 0; i < tribs.length; i++) {
      const tr = tribs[i];
      const t = tr.t;
      const rv = this.rivers[t.desc.river];
      const su = rv.baseS + wrapDs(s - rv.baseS);
      const hit = _thit;
      // valley distance on the coarse line, channel distance on the fine line
      const dv = t.nearest(su, z, hit, true, tr.c0, tr.c1);
      const wallT = 700 + hit.width * 30;
      const floodT = hit.width * 2.5 + 25;
      if (dv > floodT + wallT) continue;
      if (!coarse && dv < floodT + 400) t.nearest(su, z, hit, false, tr.c0, tr.c1);
      const halfW = hit.width * 0.5;
      const e = hit.d - halfW;
      const bankH = 1.1 + hit.width * 0.02;
      const bankW = 3 + hit.width * 0.25;
      let floor: number;
      if (e < 0) {
        const u = hit.d / halfW;
        floor = hit.level - hit.depth * (1 - Math.pow(u, 2.0));
      } else {
        floor = hit.level + bankH * smoothstep(0, bankW, e);
      }
      const v = smoothstep(floodT, floodT + wallT, dv);
      let vt = lerp(floor, Math.max(h, floor), v);
      const carve = e < 0 ? floor : hit.level + bankH + e * 1.1;
      vt = Math.min(vt, carve);
      h = smin(h, vt, 6 + hit.width * 0.3);
      // levee: keep the water in its channel
      if (e >= 0 && e < bankW * 3) h = Math.max(h, hit.level + bankH * smoothstep(0, bankW, e) * (1 - smoothstep(bankW, bankW * 3, e)));
      if (e < o.edge) o.edge = e;
      const margin = bankW + 4;
      if (e < margin && hit.level > o.water - 0.01) {
        if (o.riverClass !== RIVER_MAIN || e < 0) {
          o.water = Math.max(o.water, hit.level);
          o.riverClass = RIVER_TRIB;
          o.flowS = hit.fs * hit.speed;
          o.flowZ = hit.fz * hit.speed;
        }
      }
    }
    // towns: flatten and carve canals / harbour basins
    const towns = ctx ? ctx.towns : this.adhocTowns(s, z);
    let townMask = 0;
    for (let i = 0; i < towns.length; i++) {
      const tt = towns[i];
      const res = tt.apply(s, z, h, o);
      h = res;
      if (o.town > townMask) townMask = o.town;
    }
    o.town = townMask;
    // micro relief (damped near water and in towns)
    if (minWl < 60) {
      const damp = smoothstep(2, 40, o.edge) * (1 - townMask);
      if (damp > 0) h += this.detail.sample(s, z, minWl) * 1.4 * damp * (0.4 + o.hill);
    }
    o.h = h;
    this.biomeMasks(s, z, o);
    if (this.hatch) o.h = this.hatchTerrain(s, z, o.h, o);
    return o;
  }

  private adhocTribs(s: number, z: number): TribRef[] {
    const res: TribRef[] = [];
    for (const d of this.tributariesIn(s - 5000, z - 5000, s + 5000, z + 5000)) {
      const r = this.rivers[d.river];
      const su = r.baseS + wrapDs(s - r.baseS);
      if (su < d.sMin - 4000 || su > d.sMax + 4000 || z < d.zMin - 4000 || z > d.zMax + 4000) continue;
      const t = this.getTributary(d.id);
      res.push({ t, c0: 0, c1: t.n });
    }
    return res;
  }

  private adhocTowns(s: number, z: number): TownTerrain[] {
    const res: TownTerrain[] = [];
    for (const site of this.townsNear(s, z)) {
      if (Math.abs(site.z - z) > site.radius + 300) continue;
      if (Math.abs(wrapDs(site.s - s)) > site.radius + 300) continue;
      res.push(this.townTerrain(site));
    }
    return res;
  }

  private biomeMasks(s: number, z: number, o: TerrainSample): void {
    const n1 = this.biome.sample(s, z, 400);
    const n2 = this.biome.sample(s + 77_000, z - 13_000, 400);
    const nearWater = 1 - smoothstep(20, 900, o.edge);
    o.moisture = clamp(0.5 + 0.5 * n1 + nearWater * 0.4, 0, 1);
    const hillF = o.hill;
    o.forest = clamp(smoothstep(-0.15, 0.35, n2 + hillF * 0.55 - 0.25) * (1 - o.town) * smoothstep(8, 40, o.edge), 0, 1);
    const flat = 1 - hillF;
    o.farm = clamp(smoothstep(-0.2, 0.2, -n2 + flat * 0.6 - 0.1) * smoothstep(35, 120, o.edge) * (1 - o.town) * (1 - o.forest * 0.8), 0, 1);
    o.orchard = clamp(smoothstep(0.25, 0.55, n1 * 0.7 + (1 - Math.abs(hillF - 0.35) * 2) * 0.4) * (1 - o.farm) * (1 - o.town) * smoothstep(30, 90, o.edge), 0, 1);
  }

  /** Quick height query (full detail) for gameplay. */
  heightAt(s: number, z: number): number {
    return this.sample(s, z, 0, _qs).h;
  }

  /** Extent of the terrain domain along z. */
  static readonly zMin = Z_MIN;
  static readonly zMax = Z_MAX;
  static readonly radius = R;
}

const _hit: ChannelHit = { d: 0, side: 0, level: 0, width: 0, depth: 0, fs: 0, fz: 0, speed: 0, zc: 0, along: 0 };
const _thit: ChannelHit = { d: 0, side: 0, level: 0, width: 0, depth: 0, fs: 0, fz: 0, speed: 0, zc: 0, along: 0 };
const _envSample = newSample();
const _qs = newSample();

export { RIVER_CANAL, RIVER_MAIN, RIVER_TRIB };
