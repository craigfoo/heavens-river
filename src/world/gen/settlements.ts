// Settlement placement along the main rivers and the terrain modifiers each
// settlement imposes (flattened ground, stone quays, canals, harbour basins).
// Building layout lives in src/towns; this file only needs what the terrain
// generator must know, so it can run inside the chunk workers.

import { clamp, smoothstep } from '../../core/math';
import { Rng, seedFor } from '../../core/rng';
import { RIVER_CANAL, wrapDs } from './rivers';
import type { MainRiver } from './rivers';
import type { TerrainSample, WorldGen } from './world';

export type TownKind = 'hamlet' | 'town' | 'city';

export interface CanalDef {
  /** Polyline in town-local (a, c) coordinates. */
  pts: [number, number][];
  width: number;
  depth: number;
}

export interface BasinDef {
  a0: number;
  a1: number;
  c0: number;
  c1: number;
}

/**
 * Town-local frame: a = axial offset from the centre (metres along z),
 * c = distance inland from the river channel edge on the town's bank.
 * World: z = zc + a, s = channel(z) + side * (halfWidth(z) + c).
 */
export class TownSite {
  readonly id: number;
  readonly name: string;
  readonly kind: TownKind;
  readonly river: number;
  readonly z: number;
  /** Bank side for hamlets/towns; cities use both (+1 primary). */
  readonly side: 1 | -1;
  readonly bothBanks: boolean;
  readonly halfLen: number;
  readonly depthInland: number;
  readonly radius: number;
  readonly waterLevel: number;
  readonly level: number;
  readonly seed: number;
  /** World s of the town centre (on the primary bank edge). */
  s: number;
  canals: CanalDef[] = [];
  basins: BasinDef[] = [];
  private rv: MainRiver;

  constructor(id: number, name: string, kind: TownKind, river: MainRiver, z: number, side: 1 | -1, seed: number) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.river = river.index;
    this.rv = river;
    this.z = z;
    this.side = side;
    this.seed = seed;
    this.bothBanks = kind === 'city';
    const rng = new Rng(seed);
    if (kind === 'hamlet') {
      this.halfLen = rng.range(90, 160);
      this.depthInland = rng.range(80, 140);
    } else if (kind === 'town') {
      this.halfLen = rng.range(380, 650);
      this.depthInland = rng.range(260, 420);
    } else {
      this.halfLen = rng.range(1100, 1700);
      this.depthInland = rng.range(700, 1000);
    }
    this.radius = Math.hypot(this.halfLen, this.depthInland + river.widthAt(z));
    this.waterLevel = river.levelAt(z);
    this.level = this.waterLevel + (kind === 'hamlet' ? 2.0 : 2.5);
    this.s = this.toWorld(0, 0, side).s;
    this.planWaterworks(rng);
  }

  get riverRef(): MainRiver {
    return this.rv;
  }

  /** Town-local (a, c) on bank `side` to world (s, z). */
  toWorld(a: number, c: number, side: 1 | -1 = this.side): { s: number; z: number } {
    const z = this.z + a;
    const half = this.rv.widthAt(z) * 0.5;
    return { s: this.rv.channelAt(z) + side * (half + c), z };
  }

  /** World to town-local; returns bank side via sign of the lateral offset. */
  toLocal(s: number, z: number): { a: number; c: number; side: 1 | -1 } {
    const a = z - this.z;
    const off = wrapDs(s - this.rv.channelAt(z));
    const half = this.rv.widthAt(z) * 0.5;
    const side: 1 | -1 = off >= 0 ? 1 : -1;
    return { a, c: Math.abs(off) - half, side };
  }

  private planWaterworks(rng: Rng) {
    if (this.kind === 'hamlet') return;
    const n = this.kind === 'town' ? rng.int(1, 3) : rng.int(3, 6);
    const depth = this.depthInland * 0.6;
    const spacing = (this.halfLen * 1.6) / n;
    const aStart = -this.halfLen * 0.8 + spacing * 0.5;
    const lateral: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = aStart + i * spacing + rng.range(-0.15, 0.15) * spacing;
      const len = depth * rng.range(0.55, 1);
      this.canals.push({
        pts: [
          [a, -8],
          [a + rng.range(-20, 20), len * 0.5],
          [a + rng.range(-30, 30), len],
        ],
        width: this.kind === 'city' ? rng.range(10, 16) : rng.range(7, 11),
        depth: 2.6,
      });
      lateral.push(a);
    }
    // a canal parallel to the river links the inland ends, forming island blocks
    if (n >= 2 && rng.chance(0.75)) {
      const cLine = depth * 0.5;
      this.canals.push({
        pts: [
          [lateral[0], cLine],
          [lateral[n - 1], cLine],
        ],
        width: this.kind === 'city' ? 12 : 8,
        depth: 2.6,
      });
    }
    if (this.kind === 'city') {
      const a0 = rng.range(-this.halfLen * 0.3, this.halfLen * 0.1);
      this.basins.push({ a0, a1: a0 + rng.range(180, 280), c0: -12, c1: rng.range(90, 150) });
    }
  }

  terrain(_gen: WorldGen): TownTerrain {
    return new TownTerrain(this);
  }
}

const _ret = { a: 0, c: 0, side: 1 as 1 | -1 };

export class TownTerrain {
  readonly site: TownSite;
  constructor(site: TownSite) {
    this.site = site;
  }

  /** Modify terrain height h at (s, z); updates water/town fields of o. */
  apply(s: number, z: number, h: number, o: TerrainSample): number {
    const t = this.site;
    const lo = t.toLocal(s, z);
    _ret.a = lo.a;
    _ret.c = lo.c;
    _ret.side = lo.side;
    const onPrimary = lo.side === t.side;
    if (!onPrimary && !t.bothBanks) {
      o.town = 0;
      return h;
    }
    const a = lo.a;
    const c = lo.c;
    const alongMask = 1 - smoothstep(t.halfLen - 40, t.halfLen + 120, Math.abs(a));
    const inland = t.depthInland * (onPrimary ? 1 : 0.8);
    const acrossMask = 1 - smoothstep(inland - 40, inland + 140, c);
    let mask = alongMask * acrossMask;
    if (c < -2) mask = 0;
    o.town = mask;
    if (mask <= 0 && c > -40) return h;
    // flat town ground, gently rising inland for drainage
    const ground = t.level + Math.max(c, 0) * 0.004;
    let out = h;
    if (c >= -2) out = h + (ground - h) * mask;
    // stone quay: deep water right at the wall for towns and cities
    if (t.kind !== 'hamlet' && c < 0 && c > -18 && alongMask > 0.5) {
      out = Math.min(out, t.waterLevel - 3.4 * clamp(1 + c / 18, 0, 1) - 0.5);
    }
    // canals and harbour basins
    let wet = false;
    for (const cn of t.canals) {
      const d = polyDist(cn.pts, a, c);
      const e = d - cn.width * 0.5;
      if (e < 3) {
        if (e < 0 && c > -4) out = Math.min(out, t.waterLevel - cn.depth);
        if (e < 1.5) wet = true;
      }
    }
    for (const b of t.basins) {
      if (a > b.a0 - 2 && a < b.a1 + 2 && c > b.c0 - 2 && c < b.c1 + 2) {
        const inside = a > b.a0 && a < b.a1 && c < b.c1;
        if (inside) out = Math.min(out, t.waterLevel - 4.5);
        wet = true;
      }
    }
    if (wet && o.water < t.waterLevel) {
      o.water = t.waterLevel;
      o.riverClass = RIVER_CANAL;
      o.flowS = 0;
      o.flowZ = 0;
    }
    return out;
  }
}

function polyDist(pts: [number, number][], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + dx * t - x;
    const ey = ay + dy * t - y;
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Place hamlets, towns and cities along every main river. */
export function planTownSites(gen: WorldGen, seed: number, nameFor: (rng: Rng) => string): TownSite[] {
  const sites: TownSite[] = [];
  let id = 0;
  for (const rv of gen.rivers) {
    const rng = new Rng(seedFor(seed, `rv${rv.index}`));
    const z0 = rv.zStart + 45_000;
    const z1 = rv.zEnd - 45_000;
    const taken: { z: number; r: number }[] = [];
    const free = (z: number, r: number) => taken.every((t) => Math.abs(t.z - z) > t.r + r + 1500);
    const maxSlope = (z: number, half: number) => {
      let m = 0;
      for (let k = -half; k <= half; k += half / 8) m = Math.max(m, Math.abs(rv.channelSlope(z + k)));
      return m;
    };
    const place = (kind: TownKind, z: number): boolean => {
      const r = kind === 'city' ? 2600 : kind === 'town' ? 900 : 250;
      if (z < z0 || z > z1 || !free(z, r)) return false;
      const side: 1 | -1 = rng.sign() as 1 | -1;
      sites.push(new TownSite(id++, nameFor(rng), kind, rv, z, side, seedFor(seed, `site${rv.index}:${Math.round(z)}`)));
      taken.push({ z, r });
      return true;
    };
    // calm reaches host the cities and towns
    const reaches = rv.calm.filter((c) => c.z0 > z0 && c.z1 < z1);
    const byLen = [...reaches].sort((p, q) => q.z1 - q.z0 - (p.z1 - p.z0));
    let cities = 0;
    for (const c of byLen) {
      if (cities >= 2) break;
      if (c.z1 - c.z0 < 5500) continue;
      if (taken.some((t) => Math.abs(t.z - (c.z0 + c.z1) / 2) < 180_000)) continue;
      if (place('city', (c.z0 + c.z1) / 2)) cities++;
    }
    for (const c of reaches) {
      const mid = (c.z0 + c.z1) / 2;
      if (rng.chance(0.85)) place('town', mid + rng.range(-800, 800));
    }
    // hamlets every ~4-10 km wherever the channel is not too sinuous
    for (let z = z0 + rng.range(0, 4000); z < z1; z += rng.range(4000, 10_000)) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const zz = z + rng.range(-1500, 1500);
        if (maxSlope(zz, 200) < 1.0 && place('hamlet', zz)) break;
      }
    }
  }
  sites.sort((p, q) => p.river - q.river || p.z - q.z);
  return sites;
}
