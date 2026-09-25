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

/**
 * How far the cut of a quay, canal or basin runs in under its bank, past the
 * waterline. Waterside walls stand out in the water with a coping back over
 * the bank, so the terrain's slope down into the cut (as coarse as the
 * terrain's level of detail) stays hidden behind and beneath them.
 */
export const QUAY_CUT = 3;
export const BANK_CUT = 2.5;
/** Waterside walls stand this far out in the water, in front of the terrain's slope into the cut. */
export const WALL_INSET = 1.2;
/** Canal water drifts along the canal at this speed (m/s), from its upstream mouth to its downstream one. */
const CANAL_FLOW = 0.3;

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
      this.halfLen = rng.range(760, 1050);
      this.depthInland = rng.range(420, 600);
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

  /**
   * Canals on flat ground loop back to the river so the water flows (spec 8).
   * A ring leaves the river, runs inland and comes back to it downstream;
   * cross canals between its arms cut the ring into islands. The ring lies
   * downstream of the market so its mills stand below the houses. Every
   * polyline runs with the flow: the ring from its upstream mouth round to
   * its downstream one, the cross canals from the ring out to the river.
   */
  private planWaterworks(rng: Rng) {
    if (this.kind === 'hamlet') return;
    const city = this.kind === 'city';
    const L = this.halfLen;
    const D = this.depthInland;
    const down = this.rv.flow;
    const width = city ? rng.range(10, 14) : rng.range(7, 10);
    const aUp = rng.range(0.14, 0.22) * L;
    const span = Math.min((city ? rng.range(0.5, 0.66) : rng.range(0.26, 0.42)) * L, 0.84 * L - aUp);
    const top = D * (city ? rng.range(0.4, 0.55) : rng.range(0.34, 0.52));
    const nCross = city ? Math.max(1, Math.floor(span / rng.range(140, 180))) : span > 150 && rng.chance(0.45) ? 1 : 0;
    // arm heads along the top of the ring, upstream to downstream
    const heads: [number, number][] = [];
    for (let i = 0; i <= nCross + 1; i++) {
      const t = i / (nCross + 1) + (i > 0 && i <= nCross ? rng.range(-0.08, 0.08) : 0);
      heads.push([down * (aUp + span * t) + rng.range(-10, 10), top + rng.range(-0.08, 0.08) * top]);
    }
    const foot = (h: [number, number]): [number, number] => [h[0] + rng.range(-12, 12), -8];
    const mid = (h: [number, number], f: [number, number]): [number, number] => [(h[0] + f[0]) / 2 + rng.range(-14, 14), h[1] * rng.range(0.45, 0.55)];
    const first = heads[0];
    const last = heads[heads.length - 1];
    const f0 = foot(first);
    const f1 = foot(last);
    const ring: [number, number][] = [f0, mid(first, f0), first];
    for (let i = 1; i < heads.length; i++) {
      const p = heads[i - 1];
      const q = heads[i];
      ring.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + rng.range(-12, 12)], q);
    }
    ring.push(mid(last, f1), f1);
    this.canals.push({ pts: roundCorners(ring, 16), width, depth: 2.6 });
    for (let i = 1; i <= nCross; i++) {
      const h = heads[i];
      const f = foot(h);
      this.canals.push({ pts: roundCorners([h, mid(h, f), f], 16), width: width * 0.8, depth: 2.6 });
    }
    if (city) {
      // harbour basin cut into the bank upstream, well away from the central market
      const len = rng.range(160, 240);
      const a0 = down < 0 ? L * rng.range(0.3, 0.45) : -L * rng.range(0.3, 0.45) - len;
      this.basins.push({ a0, a1: a0 + len, c0: -12, c1: rng.range(80, 130) });
    }
  }

  terrain(_gen: WorldGen): TownTerrain {
    return new TownTerrain(this);
  }
}

const _ret = { a: 0, c: 0, side: 1 as 1 | -1 };

export class TownTerrain {
  readonly site: TownSite;
  /** Bounds of each canal's reach (its water, cut and walls), for a quick reject. */
  private boxes: { a0: number; a1: number; c0: number; c1: number }[];
  constructor(site: TownSite) {
    this.site = site;
    this.boxes = site.canals.map((cn) => {
      const m = cn.width * 0.5 + BANK_CUT + 2;
      const b = { a0: Infinity, a1: -Infinity, c0: Infinity, c1: -Infinity };
      for (const [a, c] of cn.pts) {
        b.a0 = Math.min(b.a0, a - m);
        b.a1 = Math.max(b.a1, a + m);
        b.c0 = Math.min(b.c0, c - m);
        b.c1 = Math.max(b.c1, c + m);
      }
      return b;
    });
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
    // (in front of a quay the river is dredged deep, below)
    const quay = t.kind !== 'hamlet' && c > -18 && alongMask > 0.5;
    if (mask <= 0 && c > -40 && !quay) return h;
    // flat town ground, gently rising inland for drainage
    const ground = t.level + Math.max(c, 0) * 0.004;
    let out = h;
    if (c >= -2) out = h + (ground - h) * mask;
    const flat = out;
    // stone quay: deep water right at the wall for towns and cities
    if (quay && (c < 0 || (c < QUAY_CUT && Math.abs(a) < t.halfLen))) {
      out = Math.min(out, t.waterLevel - 3.4 * clamp(1 + Math.min(c, 0) / 18, 0, 1) - 0.5);
    }
    // canals and harbour basins (on the town's own bank)
    let wet = false;
    let nearest = Infinity;
    let fa = 0;
    let fc = 0;
    if (onPrimary) {
      for (let k = 0; k < t.canals.length; k++) {
        const bx = this.boxes[k];
        if (a < bx.a0 || a > bx.a1 || c < bx.c0 || c > bx.c1) continue;
        const cn = t.canals[k];
        const e = polyNear(cn.pts, a, c) - cn.width * 0.5;
        if (e < BANK_CUT + 1.5) {
          if (e < BANK_CUT && c > -4) out = Math.min(out, t.waterLevel - cn.depth);
          wet = true;
          if (e < nearest) {
            nearest = e;
            fa = _near.ua;
            fc = _near.uc;
          }
        }
      }
      for (const b of t.basins) {
        const m = BANK_CUT + 1.5;
        if (a > b.a0 - m && a < b.a1 + m && c > b.c0 - m && c < b.c1 + m) {
          const inside = a > b.a0 - BANK_CUT && a < b.a1 + BANK_CUT && c < b.c1 + BANK_CUT;
          if (inside) out = Math.min(out, t.waterLevel - 4.5);
          wet = true;
        }
      }
    }
    if (out < flat - 0.3) o.cut = 1;
    if (wet && o.water < t.waterLevel) {
      o.water = t.waterLevel;
      o.riverClass = RIVER_CANAL;
      // along the canal (in a harbour basin the water lies still)
      o.flowS = t.side * fc * CANAL_FLOW;
      o.flowZ = fa * CANAL_FLOW;
    }
    return out;
  }
}

const _near = { ua: 0, uc: 0 };

/** Distance from (x, y) to a polyline; leaves the direction of the nearest segment in _near. */
function polyNear(pts: [number, number][], x: number, y: number): number {
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
    if (d < best) {
      best = d;
      const l = Math.sqrt(l2) || 1;
      _near.ua = dx / l;
      _near.uc = dy / l;
    }
  }
  return Math.sqrt(best);
}

/** Round a polyline's bends with short curves reaching about r along each side. */
function roundCorners(pts: [number, number][], r: number): [number, number][] {
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    const n = pts[i + 1];
    const l0 = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const l1 = Math.hypot(n[0] - q[0], n[1] - q[1]) || 1;
    const turn = Math.acos(clamp(((q[0] - p[0]) * (n[0] - q[0]) + (q[1] - p[1]) * (n[1] - q[1])) / (l0 * l1), -1, 1));
    if (turn < 0.3) {
      out.push(q);
      continue;
    }
    const k0 = Math.min(r, l0 * 0.45) / l0;
    const k1 = Math.min(r, l1 * 0.45) / l1;
    const s0: [number, number] = [q[0] + (p[0] - q[0]) * k0, q[1] + (p[1] - q[1]) * k0];
    const s1: [number, number] = [q[0] + (n[0] - q[0]) * k1, q[1] + (n[1] - q[1]) * k1];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      const u = 1 - t;
      out.push([u * u * s0[0] + 2 * u * t * q[0] + t * t * s1[0], u * u * s0[1] + 2 * u * t * q[1] + t * t * s1[1]]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
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
