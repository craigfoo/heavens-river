// Town layout generation (spec 7.1 / 7.2), planned in the town frame (a, c):
// a = metres along the river (axial), c = metres inland from the channel edge
// on one bank. Quinlans walk everywhere (there are no carts), so their towns
// have footpaths rather than roads and grow like old walking towns: a stone
// quay along the river (the real high street, for barges), a market square
// opening onto it by the main dock, and behind it neighbourhoods that each
// gather around a small common with a fountain, statue or grove. Winding
// paths link the commons, lanes ring each common and radiate from it, and
// every house faces the path it stands on.

import { Rng, seedFor } from '../core/rng';
import { WALL_INSET, type CanalDef, type TownSite } from '../world/gen/settlements';
import { frontDoorX } from './kit';
import { canalWallLines } from './props';
import { Hash2, obbCorners, obbOverlap, obbRadius, pointSegDist, polyLength, resample, segCross, segObbDist, smooth, type OBB, type P2 } from './geom';

export type District = 'waterfront' | 'market' | 'craft' | 'residential' | 'civic' | 'university' | 'mill' | 'edge';
export type BuildingKind =
  | 'house'
  | 'cottage'
  | 'townhouse'
  | 'burrow'
  | 'warehouse'
  | 'tavern'
  | 'shop'
  | 'workshop'
  | 'hall'
  | 'watch'
  | 'civic'
  | 'university'
  | 'mill'
  | 'boathouse'
  | 'shrine'
  | 'markethall'
  | 'singinghall'
  | 'bathhouse'
  | 'outpost';
export type RoofKind = 'thatch' | 'tile' | 'shingle' | 'slate' | 'turf' | 'dome' | 'flat';
/** Plinth and ground floor stone (docs/ARCHITECTURE_SPEC.md section 4). */
export type BaseStone = 'riverstone' | 'fieldstone' | 'ashlar';
/** Upper floors: wattle and daub, timber frame with plaster infill, or stone. */
export type UpperWall = 'daub' | 'timberPlaster' | 'stone';

export interface Building {
  a: number;
  c: number;
  /** Width along the local x (frontage), depth along local z. */
  w: number;
  d: number;
  /** Rotation about up, relative to the town frame (0 = frontage along +a, facing -c toward the river). */
  rot: number;
  floors: number;
  kind: BuildingKind;
  roof: RoofKind;
  district: District;
  /** Palette/decoration seed. */
  seed: number;
  mural: boolean;
  waterDoor: boolean;
  sunken: boolean;
  tower: boolean;
  /** Decoration density 0.2..1, from wealth and district (spec 6). */
  deco: number;
  /** 0 new .. 1 ancient: moss, rising damp, repairs, faded paint (spec 5). */
  age: number;
  base: BaseStone;
  upper: UpperWall;
  /** A railed lookout platform on the roof (spec 5). */
  lookout: boolean;
  /** Faces water across the quay or a canal walk: it gets a drip porch (spec 3). */
  wet: boolean;
}

/** Placeholder parameters, set properly by `dress` once a bank is laid out. */
const UNDRESSED = { deco: 0.5, age: 0.5, base: 'fieldstone', upper: 'timberPlaster', lookout: false, wet: false } as const satisfies Partial<Building>;

export interface Rect {
  a0: number;
  a1: number;
  c0: number;
  c1: number;
}

export type PathKind = 'main' | 'lane' | 'canalwalk' | 'track';
export type Paving = 'cobble' | 'stone' | 'earth';

/** A footpath: its centre line, points about 3 m apart. */
export interface Path {
  pts: P2[];
  width: number;
  kind: PathKind;
  paving: Paving;
}

/** market: mosaic; commons: cobbles; green: trodden earth; quad and amph: not paved. */
export type PlazaKind = 'market' | 'commons' | 'green' | 'quad' | 'amph';

/** An open square: centre, mean radius and outline (counter-clockwise in a, c). */
export interface Plaza {
  a: number;
  c: number;
  r: number;
  rim: P2[];
  kind: PlazaKind;
}

export interface Pier {
  a: number;
  /** Length into the river (positive, towards the channel centre). */
  len: number;
  width: number;
  stone: boolean;
}

export interface Bridge {
  a: number;
  c: number;
  /** Direction of the span in the (a, c) plane (0 = along +a). */
  rot: number;
  span: number;
  width: number;
}

/**
 * A slipway: a worn stone ramp down into the water (1:6), built against a
 * waterside wall on its water side. Public ones have a flight of steps
 * beside the ramp (spec 2: a ramp beside every stair).
 */
export interface Slipway {
  /** Top end, on the wall line. */
  a: number;
  c: number;
  /** Downhill direction along the wall (unit). */
  ua: number;
  uc: number;
  /** Out over the water (unit). */
  na: number;
  nc: number;
  len: number;
  width: number;
  steps: boolean;
}

/** An underwater door in a waterside wall (spec 2: 1.0 x 0.9 m, its top 0.3 m below the water). */
export interface WaterDoor {
  a: number;
  c: number;
  /** Out over the water (unit). */
  na: number;
  nc: number;
}

export interface Statue {
  a: number;
  c: number;
  rot: number;
  kind: 'quinlan' | 'fish' | 'flow' | 'otter' | 'singers';
  scale: number;
  seed: number;
  plinth: number;
}

export interface Fountain {
  a: number;
  c: number;
  r: number;
}

export interface Stall {
  a: number;
  c: number;
  rot: number;
  seed: number;
}

export interface Tree {
  a: number;
  c: number;
  scale: number;
  type: number;
}

export interface Mooring {
  a: number;
  c: number;
  rot: number;
  len: number;
  seed: number;
}

export interface WallSeg {
  a0: number;
  c0: number;
  a1: number;
  c1: number;
  gate: boolean;
}

export interface BankLayout {
  side: 1 | -1;
  buildings: Building[];
  paths: Path[];
  plazas: Plaza[];
  /** Width of the stone quay along the river (0: no quay). */
  quayW: number;
  piers: Pier[];
  bridges: Bridge[];
  statues: Statue[];
  fountains: Fountain[];
  pools: Rect[];
  stalls: Stall[];
  trees: Tree[];
  moorings: Mooring[];
  walls: WallSeg[];
  racks: { a: number; c: number; rot: number }[];
  slips: Slipway[];
  waterDoors: WaterDoor[];
  /** Vegetable plots behind houses. */
  gardens: OBB[];
  basins: Rect[];
  /** Bounds of the market square. */
  market: Rect | null;
  amphitheater: { a: number; c: number; r: number } | null;
  dock: { a: number; c: number };
  signpost: { a: number; c: number };
  /** Open ground in the main square or green (meeting point). */
  spot: { a: number; c: number };
}

export interface TownLayout {
  site: TownSite;
  banks: BankLayout[];
  /** Cross-river bridges (cities). */
  riverBridges: { a: number; width: number }[];
  buildingCount: number;
}

const TAU = Math.PI * 2;
const wrapAngle = (t: number) => t - TAU * Math.round(t / TAU);
const STATUES = ['quinlan', 'fish', 'otter', 'flow', 'singers'] as const;

// ---------------------------------------------------------------------------
// geometry helpers

function rectGap(r: Rect, a: number, c: number): number {
  const da = Math.max(r.a0 - a, 0, a - r.a1);
  const dc = Math.max(r.c0 - c, 0, c - r.c1);
  if (da > 0 || dc > 0) return Math.hypot(da, dc);
  return -Math.min(a - r.a0, r.a1 - a, c - r.c0, r.c1 - c);
}

const rectObb = (r: Rect): OBB => ({ a: (r.a0 + r.a1) / 2, c: (r.c0 + r.c1) / 2, hw: (r.a1 - r.a0) / 2, hd: (r.c1 - r.c0) / 2, rot: 0 });
const obbOf = (b: Building): OBB => ({ a: b.a, c: b.c, hw: b.w / 2, hd: b.d / 2, rot: b.rot });

/** Distance from a point to an oriented rectangle (0 inside). */
function obbPointDist(o: OBB, a: number, c: number): number {
  const cr = Math.cos(o.rot);
  const sr = Math.sin(o.rot);
  const da = a - o.a;
  const dc = c - o.c;
  const x = da * cr + dc * sr;
  const z = -da * sr + dc * cr;
  return Math.hypot(Math.max(0, Math.abs(x) - o.hw), Math.max(0, Math.abs(z) - o.hd));
}

/** Signed distance to a closed outline (negative inside). */
function polyGap(rim: P2[], a: number, c: number): number {
  let d = Infinity;
  let inside = false;
  const p: P2 = [a, c];
  for (let i = 0, j = rim.length - 1; i < rim.length; j = i++) {
    const [xi, yi] = rim[i];
    const [xj, yj] = rim[j];
    if (yi > c !== yj > c && a < ((xj - xi) * (c - yi)) / (yj - yi) + xi) inside = !inside;
    d = Math.min(d, pointSegDist(p, rim[j], rim[i]));
  }
  return inside ? -d : d;
}

function bbox(pts: P2[]): Rect {
  const r: Rect = { a0: Infinity, a1: -Infinity, c0: Infinity, c1: -Infinity };
  for (const [a, c] of pts) {
    r.a0 = Math.min(r.a0, a);
    r.a1 = Math.max(r.a1, a);
    r.c0 = Math.min(r.c0, c);
    r.c1 = Math.max(r.c1, c);
  }
  return r;
}

/** Offset a polyline sideways (positive = to the left of its direction). */
function offsetLine(pts: P2[], off: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[Math.max(0, i - 1)];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    let nx = -(q[1] - p[1]) / l;
    let nz = (q[0] - p[0]) / l;
    // keep the offset constant from each segment at a bend (miter)
    if (i > 0 && i < pts.length - 1) {
      const s = pts[i];
      const e = pts[i + 1];
      const ls = Math.hypot(e[0] - s[0], e[1] - s[1]) || 1;
      const k = nx * (-(e[1] - s[1]) / ls) + nz * ((e[0] - s[0]) / ls);
      nx /= Math.max(0.5, k);
      nz /= Math.max(0.5, k);
    }
    out.push([pts[i][0] + nx * off, pts[i][1] + nz * off]);
  }
  return out;
}

/** Arc-length sampling of a polyline. */
function sampler(pts: P2[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const pos = (s: number): P2 => {
    s = Math.max(0, Math.min(total, s));
    let lo = 1;
    let hi = cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cum[m] < s) lo = m + 1;
      else hi = m;
    }
    const i = lo;
    const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const tan = (s: number): P2 => {
    const p = pos(s - 2);
    const q = pos(s + 2);
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  };
  return { total, pos, tan };
}

/** Runs of consecutive kept samples; on a closed ring the last run joins the first. */
function runsOf(samples: (P2 | null)[], closed: boolean): P2[][] {
  const runs: P2[][] = [];
  let cur: P2[] = [];
  for (const p of samples) {
    if (p) cur.push(p);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  if (closed && runs.length) {
    if (runs.length === 1 && runs[0].length === samples.length) return [[...runs[0], runs[0][0]]];
    if (samples[0] && samples[samples.length - 1] && runs.length > 1) {
      const last = runs.pop()!;
      runs[0] = [...last, ...runs[0]];
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// planning state: open water, paths, squares and footprints placed so far

class Water {
  private boxes: Rect[];
  constructor(
    readonly canals: CanalDef[],
    readonly basins: Rect[],
  ) {
    this.boxes = canals.map((cn) => {
      const r = bbox(cn.pts);
      const h = cn.width / 2;
      return { a0: r.a0 - h, a1: r.a1 + h, c0: r.c0 - h, c1: r.c1 + h };
    });
  }

  /** Signed distance to open water (negative in it). */
  gap(a: number, c: number): number {
    let d = Infinity;
    const p: P2 = [a, c];
    for (let k = 0; k < this.canals.length; k++) {
      const g = rectGap(this.boxes[k], a, c);
      if (g > d) continue;
      const cn = this.canals[k];
      for (let i = 0; i < cn.pts.length - 1; i++) d = Math.min(d, pointSegDist(p, cn.pts[i], cn.pts[i + 1]) - cn.width / 2);
    }
    for (const b of this.basins) d = Math.min(d, rectGap(b, a, c));
    return d;
  }

  /** Does a footprint come within `margin` of open water? */
  near(o: OBB, margin: number): boolean {
    const ro = obbRadius(o);
    for (let k = 0; k < this.canals.length; k++) {
      if (rectGap(this.boxes[k], o.a, o.c) > ro + margin) continue;
      const cn = this.canals[k];
      for (let i = 0; i < cn.pts.length - 1; i++) if (segObbDist(cn.pts[i], cn.pts[i + 1], o) < cn.width / 2 + margin) return true;
    }
    for (const b of this.basins) if (rectGap(b, o.a, o.c) < ro + margin && obbOverlap(o, rectObb(b), margin / 2)) return true;
    return false;
  }
}

interface Seg {
  p0: P2;
  p1: P2;
  hw: number;
  main: boolean;
  dir: P2;
}

class Plan {
  readonly segs = new Hash2<Seg>(12);
  readonly obs = new Hash2<OBB>(16);
  readonly plz: { p: Plaza; rMax: number }[] = [];
  private plzHash = new Hash2<{ p: Plaza; rMax: number }>(40);
  /** Kept free of paths as well as buildings (the hall site). */
  readonly reserved: OBB[] = [];
  /** Kept free of buildings. */
  readonly keep: { a: number; c: number; r: number }[] = [];

  constructor(
    readonly B: BankLayout,
    readonly L: number,
    readonly D: number,
    /** Inland edge of the quay. */
    readonly c0: number,
    readonly water: Water,
    /** Radius of the rounded inland corners of the town. */
    readonly corner: number,
  ) {}

  inBounds(a: number, c: number, m: number): boolean {
    if (Math.abs(a) > this.L - m || c > this.D - m) return false;
    const ca = this.L - this.corner;
    const cc = this.D - this.corner;
    return !(Math.abs(a) > ca && c > cc && Math.hypot(Math.abs(a) - ca, c - cc) > this.corner - m);
  }

  addPath(p: Path) {
    if (p.pts.length < 2) return;
    this.B.paths.push(p);
    const hw = p.width / 2;
    for (let i = 0; i < p.pts.length - 1; i++) {
      const p0 = p.pts[i];
      const p1 = p.pts[i + 1];
      const l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      const s: Seg = { p0, p1, hw, main: p.kind === 'main' || p.kind === 'canalwalk', dir: [(p1[0] - p0[0]) / l, (p1[1] - p0[1]) / l] };
      this.segs.add(s, (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, l / 2 + hw);
    }
  }

  addPlaza(p: Plaza) {
    this.B.plazas.push(p);
    let rMax = 0;
    for (const [a, c] of p.rim) rMax = Math.max(rMax, Math.hypot(a - p.a, c - p.c));
    this.plz.push({ p, rMax });
    this.plzHash.add(this.plz[this.plz.length - 1], p.a, p.c, rMax + 30);
  }

  addObstacle(o: OBB) {
    this.obs.add(o, o.a, o.c, obbRadius(o));
  }

  /** Taverns, the watch house and the civic hall placed so far. */
  readonly n: Counters = { tavern: 0, watch: false, civic: false };

  addBuilding(b: Building) {
    this.B.buildings.push(b);
    this.addObstacle(obbOf(b));
    if (b.kind === 'tavern') this.n.tavern++;
    else if (b.kind === 'watch') this.n.watch = true;
    else if (b.kind === 'civic') this.n.civic = true;
  }

  /** Distance from a point to the nearest path edge (negative on a path). */
  pathGap(a: number, c: number): number {
    let d = Infinity;
    const p: P2 = [a, c];
    this.segs.each(a, c, 8, (s) => {
      d = Math.min(d, pointSegDist(p, s.p0, s.p1) - s.hw);
    });
    return d;
  }

  /** Is there a main path running alongside (not across) this point? */
  alongMain(a: number, c: number, t: P2, hw: number, gap: number): boolean {
    const p: P2 = [a, c];
    return this.segs.each(a, c, hw + gap + 3, (s) => s.main && Math.abs(t[0] * s.dir[0] + t[1] * s.dir[1]) > 0.7 && pointSegDist(p, s.p0, s.p1) - s.hw - hw <= gap);
  }

  /** Signed distance to the nearest square (negative inside). */
  plazaGap(a: number, c: number, skip: (Plaza | null)[] = []): number {
    let d = Infinity;
    this.plzHash.each(a, c, 0, ({ p, rMax }) => {
      if (skip.includes(p)) return;
      const r = Math.hypot(a - p.a, c - p.c) - rMax;
      if (r > d || r > 30) d = Math.min(d, r);
      else d = Math.min(d, polyGap(p.rim, a, c));
    });
    return d;
  }

  private plazaClear(o: OBB, margin: number): boolean {
    const ro = obbRadius(o);
    return !this.plzHash.each(o.a, o.c, ro, ({ p, rMax }) => {
      if (Math.hypot(o.a - p.a, o.c - p.c) > rMax + ro + margin) return false;
      if (polyGap(p.rim, o.a, o.c) < 0) return true;
      for (let i = 0, j = p.rim.length - 1; i < p.rim.length; j = i++) if (segObbDist(p.rim[j], p.rim[i], o) < margin) return true;
      return false;
    });
  }

  /** Can a footprint go here without touching paths, squares, water or other footprints? */
  fits(o: OBB, pad = 0.25, margin = 0.5, wet = 3.2): boolean {
    for (const [a, c] of obbCorners(o)) if (c < this.c0 + 0.3 || !this.inBounds(a, c, 2.5)) return false;
    if (wet > 0 && this.water.near(o, wet)) return false;
    for (const k of this.keep) if (obbPointDist(o, k.a, k.c) < k.r) return false;
    for (const r of this.reserved) if (obbOverlap(o, r, 0.5)) return false;
    const ro = obbRadius(o);
    const p: P2 = [o.a, o.c];
    if (this.segs.each(o.a, o.c, ro + margin, (s) => pointSegDist(p, s.p0, s.p1) < ro + s.hw + margin && segObbDist(s.p0, s.p1, o) < s.hw + margin)) return false;
    if (!this.plazaClear(o, 0.8)) return false;
    return !this.obs.each(o.a, o.c, ro + pad, (q) => obbOverlap(o, q, pad));
  }

  /**
   * Is a planned path clear? It may start and end inside its own squares and
   * cross canals only at its bridges; it must not run along another main path.
   */
  pathOk(pieces: P2[][], hw: number, o: { own?: (Plaza | null)[]; bridges?: Bridge[]; cMin?: number; cMax?: number } = {}): boolean {
    let n = 0;
    let along = 0;
    for (const pc of pieces) {
      for (let i = 0; i < pc.length; i++) {
        const [a, c] = pc[i];
        if (c < (o.cMin ?? this.c0 - 1.5)) return false;
        if (o.cMax !== undefined ? Math.abs(a) > this.L - 3 || c > o.cMax : !this.inBounds(a, c, 3)) return false;
        const onBridge = o.bridges?.some((b) => Math.hypot(a - b.a, c - b.c) < b.span / 2 + 3);
        if (!onBridge && this.water.gap(a, c) < hw + 0.9) return false;
        if (this.plazaGap(a, c, o.own) < hw + 1) return false;
        for (const r of this.reserved) if (obbPointDist(r, a, c) < hw + 1) return false;
        n++;
        if (i > 3 && i < pc.length - 4) {
          const p = pc[i - 1];
          const q = pc[i + 1];
          const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
          if (this.alongMain(a, c, [(q[0] - p[0]) / l, (q[1] - p[1]) / l], hw, 1.2)) along++;
        }
      }
    }
    return along <= n * 0.12;
  }
}

/**
 * A curving route from p0 to p1 (bowed by up to `bow` of its length) that
 * crosses any canal square-on over a footbridge. Returns the path pieces
 * between bridges, or null if a canal is crossed too obliquely or too close
 * to either end.
 */
function route(P: Plan, rng: Rng, p0: P2, p1: P2, width: number, bow: number): { pieces: P2[][]; bridges: Bridge[] } | null {
  const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (d < 4) return null;
  const u: P2 = [(p1[0] - p0[0]) / d, (p1[1] - p0[1]) / d];
  const xs: { t: number; X: P2; n: P2; cn: CanalDef }[] = [];
  for (const cn of P.water.canals) {
    for (let i = 0; i < cn.pts.length - 1; i++) {
      const t = segCross(p0, p1, cn.pts[i], cn.pts[i + 1]);
      if (t < 0) continue;
      const q0 = cn.pts[i];
      const q1 = cn.pts[i + 1];
      const ql = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
      const cu: P2 = [(q1[0] - q0[0]) / ql, (q1[1] - q0[1]) / ql];
      if (Math.abs(cu[0] * u[0] + cu[1] * u[1]) > 0.72) return null;
      let n: P2 = [-cu[1], cu[0]];
      if (n[0] * u[0] + n[1] * u[1] < 0) n = [-n[0], -n[1]];
      xs.push({ t, X: [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t], n, cn });
    }
  }
  xs.sort((x, y) => x.t - y.t);
  const pieces: P2[][] = [];
  const bridges: Bridge[] = [];
  let cur: P2[] = [p0];
  let from = p0;
  const ahead = (q: P2) => (q[0] - from[0]) * u[0] + (q[1] - from[1]) * u[1];
  const bend = (to: P2) => {
    const l = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (l < 30 || bow <= 0) return;
    const nx = -(to[1] - from[1]) / l;
    const nz = (to[0] - from[0]) / l;
    const mids = l > 90 ? [1 / 3, 2 / 3] : [0.5];
    let o = rng.range(-1, 1) * bow * l;
    for (const f of mids) {
      cur.push([from[0] + (to[0] - from[0]) * f + nx * o, from[1] + (to[1] - from[1]) * f + nz * o]);
      o = o * rng.range(-0.6, 1) + rng.range(-0.3, 0.3) * bow * l;
    }
  };
  for (const x of xs) {
    const hs = (x.cn.width + 1) / 2 + 1.5; // half the deck length (see buildFootBridge)
    const at = (k: number): P2 => [x.X[0] + x.n[0] * k, x.X[1] + x.n[1] * k];
    const a0 = at(-(hs + 8));
    if (ahead(a0) < 4) return null;
    bend(a0);
    cur.push(a0, at(-(hs - 0.4)));
    pieces.push(cur);
    bridges.push({ a: x.X[0], c: x.X[1], rot: Math.atan2(x.n[1], x.n[0]), span: x.cn.width + 1, width: Math.min(width + 0.6, 4.2) });
    cur = [at(hs - 0.4), at(hs + 8)];
    from = cur[1];
  }
  if (ahead(p1) < 4) return null;
  bend(p1);
  cur.push(p1);
  pieces.push(cur);
  return { pieces: pieces.map((pc) => resample(smooth(pc, 6), 3)), bridges };
}

// ---------------------------------------------------------------------------
// neighbourhood centres

interface Centre {
  a: number;
  c: number;
  /** Reach: ground belongs to the centre with the least distance / w. */
  w: number;
  /** Radius of the open space at angle t. */
  rim: (t: number) => number;
  rMax: number;
  kind: 'market' | 'commons' | 'quad' | 'amph';
  district: District;
  plaza: Plaza;
  feature: 'fountain' | 'statue' | 'grove' | 'well' | 'none';
  /** Angles at which paths leave. */
  exits: number[];
  paving: Paving;
}

function roundPlaza(a: number, c: number, rim: (t: number) => number, kind: PlazaKind, r: number, n = 28): Plaza {
  const pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    pts.push([a + Math.cos(t) * rim(t), c + Math.sin(t) * rim(t)]);
  }
  return { a, c, r, rim: pts, kind };
}

function commons(rng: Rng, a: number, c: number, w: number, r0: number, kind: Centre['kind'], plazaKind: PlazaKind): Centre {
  const ph1 = rng.range(0, TAU);
  const ph2 = rng.range(0, TAU);
  const wob = kind === 'amph' ? 0 : 1;
  const rim = (t: number) => r0 * (1 + wob * (0.09 * Math.sin(2 * t + ph1) + 0.06 * Math.sin(3 * t + ph2)));
  return {
    a,
    c,
    w,
    rim,
    rMax: r0 * 1.15,
    kind,
    district: 'residential',
    plaza: roundPlaza(a, c, rim, plazaKind, r0),
    feature: kind === 'commons' ? rng.weighted(['fountain', 'statue', 'grove', 'well'] as const, [0.3, 0.25, 0.25, 0.2]) : kind === 'quad' ? 'statue' : 'none',
    exits: [],
    paving: 'cobble',
  };
}

// ---------------------------------------------------------------------------
// building choice

interface Counters {
  tavern: number;
  watch: boolean;
  civic: boolean;
}

type Spec = Omit<Building, 'a' | 'c' | 'rot' | 'seed' | 'sunken'>;

/** Roofs by tier (spec 4): tile and shingle in towns, tile and slate in cities. */
const ROOFS_TOWN: RoofKind[] = ['tile', 'tile', 'tile', 'shingle', 'shingle', 'thatch'];
const ROOFS_CITY: RoofKind[] = ['tile', 'tile', 'tile', 'slate', 'slate', 'shingle'];

/**
 * What to build at a spot, from the building catalogue (spec 7; sizes are
 * frontage x depth). `core`: the packed, cobbled old town.
 */
function specFor(rng: Rng, district: District, waterfront: boolean, city: boolean, core: boolean, n: Counters): Spec {
  const roofs = city ? ROOFS_CITY : ROOFS_TOWN;
  const mk = (kind: BuildingKind, w: number, d: number, floors: number, roof: RoofKind = rng.pick(roofs), mural = false, tower = false): Spec => ({
    ...UNDRESSED,
    kind,
    w,
    d,
    floors,
    roof,
    district,
    mural,
    waterDoor: false,
    tower,
  });
  const maxTav = city ? 8 : 3;
  const tavern = () => mk('tavern', rng.range(12, 14), rng.range(9, 10.5), 2, rng.pick(roofs), rng.chance(0.5));
  // narrow end to the lane, two or three floors (a shop at street level for shops)
  const townhouse = (kind: BuildingKind = 'townhouse') => mk(kind, rng.range(5.2, 6.8), rng.range(9, 11), rng.chance(0.6) ? 2 : 3);
  const house = () => mk('house', rng.range(7, 10), rng.range(6.5, 9), rng.chance(0.5) ? 2 : 1);
  const cottage = () => mk('cottage', rng.range(7.5, 9), rng.range(5.5, 6.5), 1, rng.chance(city ? 0.2 : 0.5) ? 'thatch' : rng.pick(roofs));
  let s: Spec;
  if (waterfront) {
    const r = rng.next();
    if (r < (city ? 0.4 : 0.3)) s = mk('warehouse', rng.range(22, 27), rng.range(11, 13), 2, 'tile', rng.chance(0.75));
    else if (r < (city ? 0.52 : 0.45) && n.tavern < maxTav) s = tavern();
    else s = rng.chance(0.5) ? townhouse() : house();
  } else if (district === 'market') {
    const r = rng.next();
    s = r < 0.2 && n.tavern < maxTav ? tavern() : r < 0.75 ? townhouse('shop') : townhouse();
  } else if (district === 'craft') {
    s = rng.chance(0.7) ? mk('workshop', rng.range(8, 10), rng.range(6, 7), 1, rng.chance(0.5) ? 'shingle' : 'tile') : house();
  } else if (district === 'university') {
    s = mk('university', rng.range(20, 30), 16, 3, 'slate', true);
  } else if (district === 'edge') {
    const r = rng.next();
    s = r < 0.3 ? mk('burrow', rng.range(5, 6.5), rng.range(5.5, 7), 1, 'turf') : r < 0.8 ? cottage() : house();
  } else {
    s = core ? (rng.chance(0.5) ? townhouse() : house()) : rng.chance(0.4) ? cottage() : house();
  }
  if (!n.watch && rng.chance(0.03)) s = mk('watch', 8, 10, 2, 'tile', false, true);
  if (city && district === 'market' && !n.civic && rng.chance(0.05)) s = mk('civic', 30, 20, 3, 'dome', true, true);
  if (!s.mural) s.mural = rng.chance(0.1) && s.floors >= 2;
  return s;
}

/** How much each district spends on decoration (spec 6), before the town's tier. */
const WEALTH: Record<District, number> = { civic: 0.95, university: 0.85, market: 0.72, waterfront: 0.6, residential: 0.45, craft: 0.4, mill: 0.38, edge: 0.3 };

/**
 * Settle each building's decoration, age and materials (spec 4, 6, 9) once a
 * bank is laid out: wealth from district and tier, age from distance to the
 * oldest part of town (the quay by the market), materials from both.
 */
function dress(B: BankLayout, tier: TownSite['kind'], oldest: P2, reach: number, seed: number) {
  const rng = new Rng(seedFor(seed, `dress${B.side}`));
  const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
  for (const b of B.buildings) {
    const d = Math.hypot((b.a - oldest[0]) * 0.7, b.c - oldest[1]);
    b.age = clamp(0.2 + 0.7 * Math.max(0, 1 - d / reach) + rng.range(-0.15, 0.15), 0.05, 1);
    const wealth = WEALTH[b.district] + (tier === 'city' ? 0.1 : tier === 'hamlet' ? -0.15 : 0) - (b.kind === 'burrow' ? 0.08 : 0);
    b.deco = clamp(wealth + rng.range(-0.15, 0.15), 0.2, 1);
    const rich = b.deco > 0.68;
    b.base = tier === 'hamlet' || b.district === 'edge' ? 'riverstone' : rich && tier === 'city' ? 'ashlar' : 'fieldstone';
    b.upper = tier === 'hamlet' || b.district === 'edge' ? 'daub' : rich && tier === 'city' && rng.chance(0.45) ? 'stone' : 'timberPlaster';
    b.lookout = b.floors >= 2 && b.w * b.d > 130 && b.kind !== 'civic' && b.kind !== 'university' && rng.chance(tier === 'city' ? 0.3 : 0.15);
    // the largest, richest walls are painted
    if (!b.mural && b.deco > 0.82 && b.floors >= 2 && b.w >= 9) b.mural = rng.chance(0.5);
  }
}

interface LineOpts {
  /** Gap between the path edge and the house front. */
  set: [number, number];
  /** Gap between neighbours (or per spot). */
  gap: [number, number] | ((a: number, c: number) => [number, number]);
  /** Random twist (radians). */
  jit?: number;
  /** The line is a waterside (quay or canal walk): these houses get a drip porch. */
  wet?: boolean;
  after?: (b: Building) => void;
}

/**
 * Stand houses along a line, fronts facing it, on one side (+1 left of the
 * line's direction, -1 right). `pick` chooses what to build at a spot.
 */
function lineUp(P: Plan, rng: Rng, pts: P2[], hw: number, side: 1 | -1, pick: (a: number, c: number) => Spec | null, o: LineOpts) {
  const sm = sampler(pts);
  let s = rng.range(0, 3);
  while (s < sm.total - 4) {
    const p0 = sm.pos(s);
    const sp = pick(p0[0], p0[1]);
    if (!sp) {
      s += 5;
      continue;
    }
    if (s + sp.w > sm.total + 1) break;
    const p = sm.pos(s + sp.w / 2);
    const t = sm.tan(s + sp.w / 2);
    const off = hw + rng.range(o.set[0], o.set[1]) + sp.d / 2;
    const a = p[0] - side * t[1] * off;
    const c = p[1] + side * t[0] * off;
    const rot = Math.atan2(side * t[1], side * t[0]) + (o.jit ? rng.range(-o.jit, o.jit) : 0);
    const b: Building = { ...sp, a, c, rot, seed: rng.int(0, 1e9), sunken: sp.kind === 'burrow', wet: !!o.wet };
    if (P.fits(obbOf(b))) {
      P.addBuilding(b);
      o.after?.(b);
      const g = typeof o.gap === 'function' ? o.gap(a, c) : o.gap;
      s += sp.w + rng.range(g[0], g[1]);
    } else s += 2.6;
  }
}

/** A vegetable plot behind a house (sometimes). */
function gardenBehind(P: Plan, rng: Rng, b: Building, chance: number) {
  if ((b.kind !== 'house' && b.kind !== 'burrow') || !rng.chance(chance)) return;
  const gd = rng.range(4, 7);
  const k = b.d / 2 + 0.8 + gd / 2;
  const g: OBB = { a: b.a - Math.sin(b.rot) * k, c: b.c + Math.cos(b.rot) * k, hw: Math.max(1.6, b.w / 2 - 0.6), hd: gd / 2, rot: b.rot };
  if (P.fits(g, 0.2, 0.3)) {
    P.B.gardens.push(g);
    P.addObstacle(g);
  }
}

/** Trees in the gaps: yards, verges, corners (own random stream). */
function yardTrees(P: Plan, trng: Rng, cMin: number, step: number, density: number) {
  const B = P.B;
  const near = new Hash2<Tree>(12);
  for (const t of B.trees) near.add(t, t.a, t.c, 0);
  for (let a = -P.L; a < P.L; a += step) {
    for (let c = cMin; c < P.D; c += step) {
      if (!trng.chance(density)) continue;
      const ta = a + trng.range(0, step);
      const tc = c + trng.range(0, step);
      if (!P.inBounds(ta, tc, 3) || P.water.gap(ta, tc) < 3.5 || P.pathGap(ta, tc) < 1.4 || P.plazaGap(ta, tc) < 1.5) continue;
      if (P.obs.near(ta, tc, 2.2).some((o) => obbPointDist(o, ta, tc) < 2.2)) continue;
      if (P.keep.some((k) => Math.hypot(ta - k.a, tc - k.c) < k.r + 1.5)) continue;
      if (near.near(ta, tc, 4.5).some((t) => Math.hypot(t.a - ta, t.c - tc) < 4.5)) continue;
      const t: Tree = { a: ta, c: tc, scale: trng.range(0.5, 0.95), type: trng.chance(0.3) ? 3 : 0 };
      B.trees.push(t);
      near.add(t, ta, tc, 0);
    }
  }
}

// ---------------------------------------------------------------------------

export function generateTownLayout(site: TownSite): TownLayout {
  const banks: BankLayout[] = [];
  const primary = site.kind === 'hamlet' ? hamletBank(site, site.side) : townBank(site, site.side, true);
  banks.push(primary);
  const riverBridges: { a: number; width: number }[] = [];
  if (site.bothBanks) {
    banks.push(townBank(site, (-site.side) as 1 | -1, false));
    const rng = new Rng(seedFor(site.seed, 'bridges'));
    const n = rng.int(2, 4);
    const water = new Water(site.canals, primary.basins);
    const avoid = (a: number) =>
      primary.market && a > primary.market.a0 - 45 && a < primary.market.a1 + 45
        ? true
        : primary.basins.some((b) => a > b.a0 - 40 && a < b.a1 + 40) || primary.piers.some((p) => Math.abs(p.a - a) < 20) || water.gap(a, 20) < 20;
    for (let i = 0; i < n; i++) {
      let a = -site.halfLen * 0.75 + (site.halfLen * 1.5 * (i + 0.5)) / n + rng.range(-60, 60);
      for (let k = 0; k < 12 && avoid(a); k++) a += 35 * (k % 2 ? -k : k);
      if (avoid(a) || Math.abs(a) > site.halfLen - 40) continue;
      const width = rng.range(9, 14);
      riverBridges.push({ a, width });
      for (const b of banks) bridgeHead(b, a, width);
    }
  }
  let count = 0;
  for (const b of banks) count += b.buildings.length;
  return { site, banks, riverBridges, buildingCount: count };
}

/** Clear the ramp of a river bridge and lead a path from its head into the town. */
function bridgeHead(B: BankLayout, a: number, width: number) {
  const ramp = rectObb({ a0: a - width / 2 - 3, a1: a + width / 2 + 3, c0: 0, c1: 34 });
  const inRamp = (o: OBB) => obbOverlap(o, ramp, 0);
  const head: P2 = [a, 32];
  let best: P2 | null = null;
  let bd = 70;
  for (const p of B.paths)
    for (const q of p.pts) {
      const d = Math.hypot(q[0] - head[0], q[1] - head[1]);
      if (q[1] > 36 && d < bd) {
        bd = d;
        best = q;
      }
    }
  const link: P2[] = best ? resample([head, best], 3) : [];
  const hw = 1.8;
  const lb = bbox(link.length ? link : [head]);
  const onLink = (o: OBB) => link.length > 1 && rectGap(lb, o.a, o.c) < obbRadius(o) + hw + 1 && link.some((p, i) => i > 0 && segObbDist(link[i - 1], p, o) < hw + 0.5);
  B.buildings = B.buildings.filter((x) => !inRamp(obbOf(x)) && !onLink(obbOf(x)));
  B.gardens = B.gardens.filter((g) => !inRamp(g) && !onLink(g));
  B.trees = B.trees.filter((t) => !(Math.abs(t.a - a) < width / 2 + 3 && t.c < 36) && !(link.length > 1 && link.some((p, i) => i > 0 && pointSegDist([t.a, t.c], link[i - 1], p) < hw + 1.2)));
  B.moorings = B.moorings.filter((m) => Math.abs(m.a - a) > width + 14);
  B.stalls = B.stalls.filter((s) => Math.abs(s.a - a) > width);
  B.statues = B.statues.filter((s) => !(Math.abs(s.a - a) < width / 2 + 2 && s.c < 34));
  if (link.length > 1) B.paths.push({ pts: link, width: hw * 2, kind: 'main', paving: 'cobble' });
}

function emptyBank(side: 1 | -1): BankLayout {
  return {
    side,
    buildings: [],
    paths: [],
    plazas: [],
    quayW: 0,
    piers: [],
    bridges: [],
    statues: [],
    fountains: [],
    pools: [],
    stalls: [],
    trees: [],
    moorings: [],
    walls: [],
    racks: [],
    slips: [],
    waterDoors: [],
    gardens: [],
    basins: [],
    market: null,
    amphitheater: null,
    dock: { a: 0, c: 0 },
    signpost: { a: 0, c: 0 },
    spot: { a: 0, c: 0 },
  };
}

function townBank(site: TownSite, side: 1 | -1, primary: boolean): BankLayout {
  const rng = new Rng(seedFor(site.seed, `bank${side}`));
  const B = emptyBank(side);
  const city = site.kind === 'city';
  const L = site.halfLen;
  const D = site.depthInland * (primary ? 1 : 0.8);
  const quayW = city ? 9 : 7;
  B.quayW = quayW;
  B.basins = primary ? site.basins.map((b) => ({ ...b })) : [];
  const canals = primary ? site.canals : [];
  const water = new Water(canals, B.basins);
  const P = new Plan(B, L, D, quayW, water, Math.min(city ? 130 : 100, D * 0.4));
  const mainW = city ? 3.4 : 3.0;

  // ---- the market square, opening onto the quay by the main dock
  const Rm = city ? 40 : 26;
  const ra = Rm * 1.3;
  const rcm = Rm * 0.85;
  const ph = [rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU)];
  const mRim = (t: number) =>
    (1 / Math.hypot(Math.cos(t) / ra, Math.sin(t) / rcm)) * (1 + 0.07 * Math.sin(2 * t + ph[0]) + 0.05 * Math.sin(3 * t + ph[1]) + 0.03 * Math.sin(5 * t + ph[2]));
  const mC = quayW + rcm * 0.5;
  const target = primary ? 0 : rng.range(-L * 0.3, L * 0.3);
  const dryAt = (a: number) => {
    if (Math.abs(a) > L - ra * 1.25 - 15) return false;
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * TAU;
      const r = mRim(t) * 1.2 + 8;
      if (water.gap(a + Math.cos(t) * r, Math.max(quayW, mC + Math.sin(t) * r)) < 4) return false;
    }
    return true;
  };
  let mA = target;
  for (let k = 0; k < 80; k++) {
    const a = target + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 15;
    if (dryAt(a)) {
      mA = a;
      break;
    }
  }
  const mRimPts: P2[] = [];
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * TAU;
    mRimPts.push([mA + Math.cos(t) * mRim(t), Math.max(quayW, mC + Math.sin(t) * mRim(t))]);
  }
  const M: Centre = {
    a: mA,
    c: mC,
    w: Rm * 2.3,
    rim: mRim,
    rMax: ra * 1.15,
    kind: 'market',
    district: 'market',
    plaza: { a: mA, c: mC, r: Rm, rim: mRimPts, kind: 'market' },
    feature: 'fountain',
    // no lanes off the quay side
    exits: [-Math.PI / 2, -Math.PI / 4, (-3 * Math.PI) / 4],
    paving: 'cobble',
  };
  P.addPlaza(M.plaza);
  B.market = bbox(mRimPts);
  B.dock = { a: mA, c: 0 };
  B.signpost = { a: mA + 6, c: quayW + 1 };
  P.keep.push({ a: B.signpost.a, c: B.signpost.c, r: 2 });
  // the hall at its head, facing the river
  const hall: Building = {
    a: mA,
    c: mC + mRim(Math.PI / 2) + 1.5 + (city ? 13 : 8),
    w: city ? 40 : 24,
    d: city ? 26 : 16,
    rot: 0,
    floors: city ? 3 : 2,
    kind: city ? 'civic' : 'hall',
    roof: city ? 'dome' : 'tile',
    district: 'civic',
    seed: rng.int(0, 1e9),
    mural: true,
    waterDoor: false,
    sunken: false,
    tower: city,
    ...UNDRESSED,
  };
  const hallOk = P.fits(obbOf(hall));
  if (hallOk) P.reserved.push(obbOf(hall));

  // ---- the amphitheatre (cities) sits on the waterfront with the river
  // behind its stage (spec 7)
  const cents: Centre[] = [M];
  if (city && primary) {
    const r = rng.range(30, 36);
    const ac = quayW + r * 0.3 + 2;
    const sgn = rng.sign();
    for (let k = 0; k < 24; k++) {
      const a = sgn * (k % 2 ? -1 : 1) * L * (0.62 - 0.03 * Math.floor(k / 2));
      if (Math.abs(a) > L - r - 25 || Math.abs(a - mA) < ra + r + 60) continue;
      let dry = true;
      for (let i = 0; i < 16 && dry; i++) {
        const t = (i / 16) * Math.PI;
        if (water.gap(a + Math.cos(t) * (r + 10), ac + Math.sin(t) * (r + 10)) < 6 || water.gap(a + Math.cos(t) * (r + 10), quayW + 2) < 6) dry = false;
      }
      if (!dry || (hallOk && obbPointDist(obbOf(hall), a, ac) < r + 25)) continue;
      cents.push(commons(rng, a, ac, r * 2.2, r + 4, 'amph', 'amph'));
      B.amphitheater = { a, c: ac, r };
      break;
    }
  }

  // ---- neighbourhood centres, scattered like old village cores
  const S = city ? 126 : 100;
  for (let k = 0; k < 6000; k++) {
    const sp = S * rng.range(0.85, 1.2);
    const a = rng.range(-L + sp * 0.3, L - sp * 0.3);
    const c = rng.range(quayW + sp * 0.38, D - sp * 0.3);
    if (!P.inBounds(a, c, sp * 0.3) || water.gap(a, c) < 20) continue;
    if (cents.some((q) => Math.hypot(q.a - a, q.c - c) < (q.w + sp / 2) * 0.95)) continue;
    if (hallOk && obbPointDist(obbOf(hall), a, c) < 30) continue;
    cents.push(commons(rng, a, c, sp / 2, city ? rng.range(7.5, 12) : rng.range(6.5, 10.5), 'commons', 'commons'));
  }
  // the university takes over one quarter (cities)
  if (city && primary) {
    const uni = cents.filter((q) => q.kind === 'commons' && q.c > D * 0.3 && q.c < D * 0.8 && Math.abs(q.a) < L * 0.75 && Math.hypot(q.a - mA, q.c - mC) > 160 && water.gap(q.a, q.c) > 40);
    if (uni.length) {
      const q = rng.pick(uni);
      const i = cents.indexOf(q);
      cents[i] = commons(rng, q.a, q.c, q.w * 1.1, rng.range(22, 27), 'quad', 'quad');
      cents[i].district = 'university';
    }
  }
  const cobbleR = city ? 320 : 240;
  for (const q of cents) {
    if (q.kind !== 'market') P.addPlaza(q.plaza);
    if (q.kind === 'commons') q.district = q.c > D - 80 || Math.abs(q.a) > L - 70 ? 'edge' : rng.chance(0.28) ? 'craft' : 'residential';
    q.paving = Math.hypot(q.a - mA, q.c - mC) < cobbleR ? 'cobble' : 'earth';
    if (q.kind === 'commons' && q.paving === 'earth') q.plaza.kind = 'green';
  }
  const cgrid = new Hash2<number>(60);
  cents.forEach((q, i) => cgrid.add(i, q.a, q.c, 0));
  const owner = (a: number, c: number) => {
    let best = -1;
    let bd = Infinity;
    const scan = (i: number) => {
      const d = Math.hypot(a - cents[i].a, c - cents[i].c) / cents[i].w;
      if (d < bd) {
        bd = d;
        best = i;
      }
    };
    cgrid.each(a, c, 150, scan);
    if (best < 0 || bd * 92 > 150) for (let i = 0; i < cents.length; i++) scan(i);
    return best;
  };

  // ---- winding paths between the centres: a spanning tree plus some loops
  const link = (A: Centre, C: Centre, width: number): boolean => {
    const d = Math.hypot(C.a - A.a, C.c - A.c);
    const ux = (C.a - A.a) / d;
    const uz = (C.c - A.c) / d;
    const rA = A.rim(Math.atan2(uz, ux)) - 1;
    const rC = C.rim(Math.atan2(-uz, -ux)) - 1;
    const p0: P2 = [A.a + ux * rA, A.c + uz * rA];
    const p1: P2 = [C.a - ux * rC, C.c - uz * rC];
    for (const bow of [0.13, 0.07, 0]) {
      const r = route(P, rng, p0, p1, width, bow);
      if (!r || !P.pathOk(r.pieces, width / 2, { own: [A.plaza, C.plaza], bridges: r.bridges })) continue;
      for (const pc of r.pieces) P.addPath({ pts: pc, width, kind: 'main', paving: 'cobble' });
      B.bridges.push(...r.bridges);
      const f = r.pieces[0];
      const l = r.pieces[r.pieces.length - 1];
      A.exits.push(Math.atan2(f[1][1] - A.c, f[1][0] - A.a));
      C.exits.push(Math.atan2(l[l.length - 2][1] - C.c, l[l.length - 2][0] - C.a));
      return true;
    }
    return false;
  };
  const edges: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < cents.length; i++)
    for (let j = i + 1; j < cents.length; j++) {
      const d = Math.hypot(cents[i].a - cents[j].a, cents[i].c - cents[j].c);
      if (d < 1.9 * (cents[i].w + cents[j].w)) edges.push({ i, j, d });
    }
  edges.sort((x, y) => x.d - y.d);
  const planar: typeof edges = [];
  const at = (i: number): P2 => [cents[i].a, cents[i].c];
  for (const e of edges) {
    const p0 = at(e.i);
    const p1 = at(e.j);
    if (cents.some((q, k) => k !== e.i && k !== e.j && pointSegDist([q.a, q.c], p0, p1) < q.rMax + 12)) continue;
    if (planar.some((f) => f.i !== e.i && f.i !== e.j && f.j !== e.i && f.j !== e.j && segCross(p0, p1, at(f.i), at(f.j)) >= 0)) continue;
    let dry = true;
    for (let t = 0; t <= 1 && dry; t += 4 / e.d) for (const bs of B.basins) if (rectGap(bs, p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t) < 5) dry = false;
    if (dry) planar.push(e);
  }
  const parent = cents.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of planar) {
    const tree = find(e.i) !== find(e.j);
    if (!tree && e.i !== 0 && !rng.chance(city ? 0.42 : 0.36)) continue;
    if (link(cents[e.i], cents[e.j], mainW)) parent[find(e.i)] = find(e.j);
  }

  // ---- paths down to the quay from the neighbourhoods beside it
  for (let i = 1; i < cents.length; i++) {
    const q = cents[i];
    let mine = true;
    for (let c = q.c - q.rMax; c > quayW + 10 && mine; c -= 6) if (owner(q.a, c) !== i) mine = false;
    if (!mine) continue;
    const r0 = q.rim(-Math.PI / 2) - 1;
    const p0: P2 = [q.a, q.c - r0];
    const p1: P2 = [q.a + rng.range(-12, 12), quayW - 1];
    for (const bow of [0.1, 0]) {
      const r = route(P, rng, p0, p1, mainW - 0.4, bow);
      if (!r || r.bridges.length || !P.pathOk(r.pieces, mainW / 2, { own: [q.plaza], cMin: quayW - 2 })) continue;
      P.addPath({ pts: r.pieces[0], width: mainW - 0.4, kind: 'main', paving: q.paving });
      q.exits.push(-Math.PI / 2);
      break;
    }
  }

  // ---- roads out of a city, through gates in its wall
  if (city) {
    const outer = cents.filter((q) => q.kind === 'commons' && q.c > D - 1.7 * S).sort((x, y) => x.a - y.a);
    const roads: number[] = [];
    for (const q of outer) {
      if (roads.some((g) => Math.abs(g - q.a) < 260)) continue;
      const r0 = q.rim(Math.PI / 2) - 1;
      const r = route(P, rng, [q.a, q.c + r0], [q.a + rng.range(-25, 25), D + 70], mainW, 0.08);
      if (!r || r.bridges.length || !P.pathOk(r.pieces, mainW / 2, { own: [q.plaza], cMax: D + 80 })) continue;
      P.addPath({ pts: r.pieces[0], width: mainW, kind: 'main', paving: 'cobble' });
      q.exits.push(Math.PI / 2);
      roads.push(q.a);
    }
  }

  // ---- walks along the canals and around the harbour basin
  const walkW = 2.8;
  const walkRuns = (pts: P2[], w: number) => {
    const s = resample(pts, 3).map((p): P2 | null =>
      Math.abs(p[0]) < L - 3 && p[1] > quayW - 1 && P.inBounds(p[0], p[1], 5) && water.gap(p[0], p[1]) > w / 2 + 0.6 && P.plazaGap(p[0], p[1]) > w / 2 + 0.8 ? p : null,
    );
    for (const run of runsOf(s, false)) if (polyLength(run) > 12) P.addPath({ pts: run, width: w, kind: 'canalwalk', paving: 'stone' });
  };
  for (const cn of canals) for (const sgn of [-1, 1]) walkRuns(offsetLine(cn.pts, sgn * (cn.width / 2 + 2.3)), walkW);
  for (const bs of B.basins)
    walkRuns(
      [
        [bs.a0 - 2.6, quayW - 1],
        [bs.a0 - 2.6, bs.c1 + 2.6],
        [bs.a1 + 2.6, bs.c1 + 2.6],
        [bs.a1 + 2.6, quayW - 1],
      ],
      3.4,
    );

  // the quay crosses each canal mouth on a bridge
  for (const cn of canals) {
    const cq = quayW * 0.5 + 0.3;
    for (let i = 0; i < cn.pts.length - 1; i++) {
      const t = segCross(cn.pts[i], cn.pts[i + 1], [-L - 50, cq], [L + 50, cq]);
      if (t < 0) continue;
      const q0 = cn.pts[i];
      const q1 = cn.pts[i + 1];
      const l = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
      B.bridges.push({ a: q0[0] + (q1[0] - q0[0]) * t, c: cq, rot: Math.atan2(-(q1[0] - q0[0]) / l, (q1[1] - q0[1]) / l), span: cn.width + 1, width: quayW - 1.5 });
    }
  }

  // ---- lanes: partial rings around each centre and spokes out from it
  for (let i = 0; i < cents.length; i++) {
    const q = cents[i];
    if (q.kind === 'amph') continue;
    const laneW = rng.range(2.2, 2.8);
    const hw = laneW / 2;
    const paving = q.paving;
    const laneOk = (p: P2, t: P2, strict: boolean) =>
      owner(p[0], p[1]) === i &&
      P.inBounds(p[0], p[1], 7) &&
      p[1] > quayW + (strict ? 15 : 3) &&
      water.gap(p[0], p[1]) > hw + 1.8 &&
      P.plazaGap(p[0], p[1], [q.plaza]) > hw + 1.4 &&
      !P.reserved.some((r) => obbPointDist(r, p[0], p[1]) < hw + 1.5) &&
      !P.alongMain(p[0], p[1], t, hw, 1.8);
    const ph1 = rng.range(0, TAU);
    const ph2 = rng.range(0, TAU);
    let off = rng.range(13, 16) + (q.kind === 'market' ? 3 : 0) + (q.kind === 'quad' ? 4 : 0);
    // the old core is packed; further out the rings thin into orchards and yards
    const reach = q.w * (paving === 'cobble' ? 1.7 : 1.4);
    for (let ring = 0; ring < 6 && off < reach; ring++, off += rng.range(31, 40)) {
      if (ring > 0 && paving === 'earth' && rng.chance(0.4)) continue;
      const R = (t: number) => (q.rim(t) + off) * (1 + 0.04 * Math.sin(2 * t + ph1 + ring) + 0.03 * Math.sin(3 * t + ph2 - ring));
      const n = Math.max(24, Math.ceil((TAU * (q.rMax + off)) / 2.5));
      const samples: (P2 | null)[] = [];
      for (let k = 0; k < n; k++) {
        const t = (k / n) * TAU;
        const r = R(t);
        const p: P2 = [q.a + Math.cos(t) * r, q.c + Math.sin(t) * r];
        samples.push(laneOk(p, [-Math.sin(t), Math.cos(t)], true) ? p : null);
      }
      for (const run of runsOf(samples, true)) {
        const parts: P2[][] = [run];
        if (polyLength(run) > 70 && rng.chance(0.45)) {
          const k = rng.int(Math.floor(run.length * 0.3), Math.floor(run.length * 0.7));
          const gap = rng.int(4, 7);
          parts[0] = run.slice(0, k);
          parts.push(run.slice(k + gap));
        }
        for (const part of parts) if (part.length > 1 && polyLength(part) >= 18) P.addPath({ pts: resample(part, 3), width: laneW, kind: 'lane', paving });
      }
    }
    // spokes into the widest gaps between the paths already leaving
    const nSp = rng.int(1, 5);
    for (let s = 0; s < nSp; s++) {
      let bestT = 0;
      let bestGap = -1;
      for (let k = 0; k < 48; k++) {
        const t = (k / 48) * TAU;
        const g = q.exits.length ? Math.min(...q.exits.map((e) => Math.abs(wrapAngle(t - e)))) : Math.PI;
        if (g > bestGap) {
          bestGap = g;
          bestT = t;
        }
      }
      if (bestGap < 0.55) break;
      bestT += rng.range(-0.1, 0.1);
      q.exits.push(bestT);
      const curl = rng.range(-0.3, 0.3);
      const pts: P2[] = [];
      for (let r = q.rim(bestT) - 0.8, k = 0; k < 90; k++, r += 3) {
        const t = bestT + (curl * Math.max(0, r - q.rMax)) / 40;
        const p: P2 = [q.a + Math.cos(t) * r, q.c + Math.sin(t) * r];
        if (k > 0 && !laneOk(p, [Math.cos(t), Math.sin(t)], false)) break;
        pts.push(p);
      }
      if (pts.length > 1 && polyLength(pts) >= 16) P.addPath({ pts, width: laneW, kind: 'lane', paving });
    }
  }

  // ---- city walls with gates where the roads out cross them
  if (city) {
    const wc = D + 8;
    const rc = P.corner + 9;
    const ctrl: P2[] = [[-L - 10, -1]];
    for (let k = 0; k <= 6; k++) {
      const t = Math.PI - (k / 6) * (Math.PI / 2);
      ctrl.push([-L - 10 + rc + Math.cos(t) * rc, wc - rc + Math.sin(t) * rc]);
    }
    for (let a = -L - 10 + rc + 120; a < L + 10 - rc - 60; a += 120) ctrl.push([a, wc + rng.range(-5, 5)]);
    for (let k = 0; k <= 6; k++) {
      const t = Math.PI / 2 - (k / 6) * (Math.PI / 2);
      ctrl.push([L + 10 - rc + Math.cos(t) * rc, wc - rc + Math.sin(t) * rc]);
    }
    ctrl.push([L + 10, -1]);
    const line = resample(smooth(ctrl, 4), 2);
    const sm = sampler(line);
    const cum: number[] = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const gates: number[] = [];
    for (const p of B.paths)
      for (let i = 1; i < p.pts.length; i++) {
        if (P.inBounds(p.pts[i][0], p.pts[i][1], -5) && P.inBounds(p.pts[i - 1][0], p.pts[i - 1][1], -5)) continue;
        for (let k = 1; k < line.length; k++) {
          const t = segCross(line[k - 1], line[k], p.pts[i - 1], p.pts[i]);
          if (t >= 0) gates.push(cum[k - 1] + (cum[k] - cum[k - 1]) * t);
        }
      }
    // the quay passes through at both ends
    for (const s of [quayW * 0.5 + 1, sm.total - quayW * 0.5 - 1]) gates.push(s);
    gates.sort((x, y) => x - y);
    let s = 0;
    const seg = (s0: number, s1: number, gate: boolean) => {
      const p = sm.pos(s0);
      const q = sm.pos(s1);
      B.walls.push({ a0: p[0], c0: p[1], a1: q[0], c1: q[1], gate });
    };
    for (const g of gates) {
      const g0 = Math.max(s, g - 11);
      if (g0 < s + 0.5 && g0 > 0) continue; // overlapping gate
      while (g0 - s > 26) {
        const n = Math.ceil((g0 - s) / 24);
        const s1 = s + (g0 - s) / n;
        seg(s, s1, false);
        s = s1;
      }
      if (g0 - s > 1) seg(s, g0, false);
      seg(g0, g + 11, true);
      s = g + 11;
    }
    while (sm.total - s > 1) {
      const s1 = Math.min(sm.total, s + 24);
      seg(s, s1, false);
      s = s1;
    }
  }

  // ---- buildings
  const n = P.n;
  n.civic = city;
  if (hallOk) {
    P.reserved.length = 0;
    P.addBuilding(hall);
  }
  // mills where canals end inland
  for (const cn of canals) {
    if (cn.pts.length < 3) continue;
    const last = cn.pts[cn.pts.length - 1];
    const prev = cn.pts[cn.pts.length - 2];
    const l = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1;
    const u: P2 = [(last[0] - prev[0]) / l, (last[1] - prev[1]) / l];
    const m: Building = {
      a: last[0] + u[0] * 7.5,
      c: last[1] + u[1] * 7.5,
      w: 12,
      d: 11,
      rot: Math.atan2(-u[0], u[1]),
      floors: 2,
      kind: 'mill',
      roof: 'shingle',
      district: 'mill',
      seed: rng.int(0, 1e9),
      mural: false,
      waterDoor: true,
      sunken: false,
      tower: false,
      ...UNDRESSED,
      wet: true,
    };
    if (P.fits(obbOf(m), 0.25, 0.3, 0)) P.addBuilding(m);
  }
  const pickAt = (set: 'water' | 'path') => (a: number, c: number) => {
    const q = cents[owner(a, c)];
    return set === 'water' ? specFor(rng, 'waterfront', true, city, q.paving === 'cobble', n) : specFor(rng, q.district, false, city, q.paving === 'cobble', n);
  };
  const yard = (b: Building) => gardenBehind(P, rng, b, b.district === 'edge' ? 0.35 : b.district === 'residential' ? 0.2 : 0.08);
  // terraces in the old core, detached houses with yards further out
  const spacing = (tight: [number, number], loose: [number, number]) => (a: number, c: number) => (cents[owner(a, c)].paving === 'cobble' ? tight : loose);
  // round the market, then the university quad, then along the main paths
  lineUp(P, rng, [...mRimPts, mRimPts[0]], 0, -1, () => specFor(rng, 'market', false, city, true, n), { set: [0.8, 1.6], gap: [0.2, 0.8] });
  for (const q of cents) if (q.kind === 'quad') lineUp(P, rng, [...q.plaza.rim, q.plaza.rim[0]], 0, -1, () => specFor(rng, 'university', false, city, true, n), { set: [1, 2], gap: [1, 4] });
  const mains = B.paths.filter((p) => p.kind === 'main');
  const walks = B.paths.filter((p) => p.kind === 'canalwalk');
  const lanes = B.paths.filter((p) => p.kind === 'lane');
  for (const p of mains) for (const sd of [1, -1] as const) lineUp(P, rng, p.pts, p.width / 2, sd, pickAt('path'), { set: [0.6, 1.8], gap: spacing([0.3, 2.5], [4, 11]), after: yard });
  for (const p of walks) for (const sd of [1, -1] as const) lineUp(P, rng, p.pts, p.width / 2, sd, pickAt('path'), { set: [0.5, 1.2], gap: [0.2, 1.5], wet: true });
  // the waterfront row faces the river across the quay
  lineUp(P, rng, resample([[-L, quayW], [L, quayW]], 3), 0, 1, pickAt('water'), { set: [0.4, 1.4], gap: [0.3, 2], wet: true });
  // round the commons, then along the lanes
  for (const q of cents) if (q.kind === 'commons') lineUp(P, rng, [...q.plaza.rim, q.plaza.rim[0]], 0, -1, pickAt('path'), { set: [0.8, 2.2], gap: spacing([0.4, 2.5], [1.5, 5]), after: yard });
  for (const p of lanes)
    for (const sd of [1, -1] as const) lineUp(P, rng, p.pts, p.width / 2, sd, pickAt('path'), p.paving === 'cobble' ? { set: [0.4, 1.5], gap: [0.3, 3], jit: 0.04, after: yard } : { set: [0.8, 3], gap: [5, 15], jit: 0.08, after: yard });

  // ---- the market: fountain, stalls in rings, a bathing pool, statues and shade trees
  const fr = city ? 7 : 4.5;
  B.fountains.push({ a: mA, c: mC, r: fr });
  B.statues.push({ a: mA, c: mC, rot: rng.range(0, TAU), kind: rng.pick(['quinlan', 'singers', 'flow'] as const), scale: city ? 2.6 : 1.8, seed: rng.int(0, 1e9), plinth: city ? 2.2 : 1.5 });
  const aisles = [...M.exits.filter((e) => Math.sin(e) > -0.2), -Math.PI / 2];
  const inAisle = (t: number, r: number) => aisles.some((e) => Math.abs(wrapAngle(t - e)) * r < 3.4);
  const inside = (a: number, c: number, m: number) => polyGap(mRimPts, a, c) < -m;
  let pool: Rect | null = null;
  if (rng.chance(city ? 1 : 0.55)) {
    const pw = city ? 22 : 12;
    const pd = pw * 0.6;
    for (let k = 0; k < 16 && !pool; k++) {
      const t = rng.range(0, TAU);
      const r = fr + 4 + pw * 0.45 + rng.range(0, 8);
      const pa = mA + Math.cos(t) * r;
      const pc = mC + Math.sin(t) * r;
      const cand: Rect = { a0: pa - pw / 2, a1: pa + pw / 2, c0: pc - pd / 2, c1: pc + pd / 2 };
      const ok = [
        [cand.a0, cand.c0],
        [cand.a1, cand.c0],
        [cand.a1, cand.c1],
        [cand.a0, cand.c1],
      ].every(([a, c]) => inside(a, c, 3));
      if (ok && !aisles.some((e) => pointSegDist([pa, pc], [mA, mC], [mA + Math.cos(e) * 80, mC + Math.sin(e) * 80]) < pw * 0.6)) pool = cand;
    }
    if (pool) B.pools.push(pool);
  }
  for (let k = 0; k < (city ? 3 : 2); k++) {
    const r = fr + 5 + k * 5.5;
    const cnt = Math.floor((TAU * r) / 4.3);
    for (let j = 0; j < cnt; j++) {
      const t = (j / cnt) * TAU + k * 0.3;
      const sa = mA + Math.cos(t) * r;
      const sc = mC + Math.sin(t) * r;
      if (inAisle(t, r) || !inside(sa, sc, 3.5) || rng.chance(0.2)) continue;
      if ((pool && rectGap(pool, sa, sc) < 2.5) || Math.hypot(sa - B.signpost.a, sc - B.signpost.c) < 3) continue;
      B.stalls.push({ a: sa, c: sc, rot: t + Math.PI / 2, seed: rng.int(0, 1e9) });
    }
  }
  const nStat = city ? 4 : rng.int(1, 4);
  for (let i = 0; i < nStat; i++) {
    const t = Math.PI * (0.15 + (0.7 * (i + 0.5)) / nStat);
    const r = mRim(t) - 3.5;
    const sa = mA + Math.cos(t) * r;
    const sc = mC + Math.sin(t) * r;
    if (inAisle(t, r)) continue;
    B.statues.push({ a: sa, c: sc, rot: Math.atan2(Math.cos(t), -Math.sin(t)), kind: rng.pick(['quinlan', 'fish', 'otter', 'flow'] as const), scale: rng.range(1.1, 1.6), seed: rng.int(0, 1e9), plinth: rng.range(0.8, 1.4) });
  }
  const trng = new Rng(seedFor(site.seed, `trees${side}`));
  for (let t = -0.2; t < Math.PI + 0.2; t += 14 / Rm) {
    const r = mRim(t) - 2.4;
    const ta = mA + Math.cos(t) * r;
    const tc = mC + Math.sin(t) * r;
    if (inAisle(t, r) || !inside(ta, tc, 1.2) || B.statues.some((s) => Math.hypot(s.a - ta, s.c - tc) < 4)) continue;
    B.trees.push({ a: ta, c: tc, scale: trng.range(0.65, 0.9), type: 0 });
  }
  B.spot = { a: mA, c: Math.max(3, mC - fr - 7.5) };

  // ---- the commons: fountains, wells, statues and groves
  for (const q of cents) {
    const r0 = q.plaza.r;
    if (q.kind === 'quad') {
      B.statues.push({ a: q.a, c: q.c, rot: rng.range(0, TAU), kind: rng.pick(STATUES), scale: 2, seed: rng.int(0, 1e9), plinth: 1.8 });
      for (let t = 0; t < TAU; t += 9 / r0) if (!q.exits.some((e) => Math.abs(wrapAngle(t - e)) * r0 < 4)) B.trees.push({ a: q.a + Math.cos(t) * r0 * 0.82, c: q.c + Math.sin(t) * r0 * 0.82, scale: trng.range(0.8, 1.05), type: 0 });
      continue;
    }
    if (q.kind !== 'commons') continue;
    const statue = () => B.statues.push({ a: q.a, c: q.c, rot: rng.range(0, TAU), kind: rng.pick(STATUES), scale: rng.range(1.2, 1.7), seed: rng.int(0, 1e9), plinth: rng.range(0.9, 1.5) });
    if (q.feature === 'fountain') {
      B.fountains.push({ a: q.a, c: q.c, r: Math.min(3.6, r0 * 0.35) });
      if (rng.chance(0.5)) statue();
    } else if (q.feature === 'well') B.fountains.push({ a: q.a, c: q.c, r: 1.5 });
    else if (q.feature === 'statue') statue();
    else {
      for (let k = trng.int(4, 8), tries = 0; k > 0 && tries < 30; tries++) {
        const t = trng.range(0, TAU);
        const r = trng.range(0, r0 * 0.55);
        const ta = q.a + Math.cos(t) * r;
        const tc = q.c + Math.sin(t) * r;
        if (B.trees.some((x) => Math.hypot(x.a - ta, x.c - tc) < 3.6)) continue;
        B.trees.push({ a: ta, c: tc, scale: trng.range(0.75, 1.05), type: trng.chance(0.2) ? 3 : 0 });
        k--;
      }
      continue;
    }
    for (let k = trng.int(0, 4); k > 0; k--) {
      const t = trng.range(0, TAU);
      if (q.exits.some((e) => Math.abs(wrapAngle(t - e)) * r0 < 3)) continue;
      B.trees.push({ a: q.a + Math.cos(t) * r0 * 0.74, c: q.c + Math.sin(t) * r0 * 0.74, scale: trng.range(0.6, 0.9), type: trng.chance(0.3) ? 3 : 0 });
    }
  }

  // ---- piers at the main dock, barges along the quay, statues on it
  const mouth = (a: number, r: number) => water.gap(a, quayW * 0.5) < r;
  const nPiers = city ? rng.int(4, 7) : rng.int(2, 4);
  for (let i = 0; i < nPiers; i++) {
    const a = mA + (i - (nPiers - 1) / 2) * rng.range(26, 38);
    if (a < -L + 10 || a > L - 10 || mouth(a, 12)) continue;
    const len = rng.range(18, city ? 45 : 30);
    B.piers.push({ a, len, width: rng.range(3.5, 5.5), stone: city && rng.chance(0.4) });
    if (rng.chance(0.8)) B.moorings.push({ a: a + 6.5, c: -len * 0.55, rot: Math.PI / 2, len: rng.range(12, 18), seed: rng.int(0, 1e9) });
    if (rng.chance(0.5)) B.moorings.push({ a: a - 6.5, c: -len * 0.5, rot: Math.PI / 2, len: rng.range(10, 16), seed: rng.int(0, 1e9) });
  }
  for (let a = -L + 20; a < L - 20; a += rng.range(22, 55)) {
    if (Math.abs(a - mA) < nPiers * 20 || mouth(a, 10)) continue;
    if (rng.chance(0.45)) B.moorings.push({ a, c: -8, rot: 0, len: rng.range(10, 16), seed: rng.int(0, 1e9) });
  }
  for (let i = 0; i < (city ? 5 : 2); i++) {
    const a = -L * 0.8 + rng.range(0, L * 1.6);
    if (mouth(a, 6) || B.piers.some((p) => Math.abs(p.a - a) < 4)) continue;
    B.statues.push({ a, c: quayW - 2, rot: Math.PI, kind: rng.pick(['fish', 'otter', 'flow', 'quinlan'] as const), scale: rng.range(1, 1.4), seed: rng.int(0, 1e9), plinth: 1 });
  }

  // ---- ways down into the water (spec 3 and 8)
  placeSlipways(B, site, rng, water, canals, quayW);

  // ---- trees in the yards and verges
  yardTrees(P, trng, quayW + 3, 11, city ? 0.6 : 0.66);
  dress(B, site.kind, [mA, quayW], Math.max(L * 0.7, D), site.seed);
  return B;
}

/**
 * Public water stairs where lanes come down to the quay and every ~120 m
 * along it; a slipway at the door of each house on the water, or an
 * underwater door when there is no room for one; public slipways along the
 * canals. Everything runs along the waterside walls, on their water side.
 */
function placeSlipways(B: BankLayout, site: TownSite, rng: Rng, water: Water, canals: CanalDef[], quayW: number) {
  const L = site.halfLen;
  const len = 6 * (site.level - site.waterLevel + 0.85); // 1:6 (spec 2)
  interface Run {
    pts: P2[];
    cum: number[];
    quay: boolean;
    taken: [number, number][];
  }
  const mkRun = (pts: P2[], quay: boolean): Run => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return { pts, cum, quay, taken: [] };
  };
  const quay = mkRun(resample([[-L, -WALL_INSET], [L, -WALL_INSET]], 2), true);
  const runs: Run[] = [quay];
  for (const cn of canals) for (const wall of canalWallLines(cn.pts, cn.width, WALL_INSET, -WALL_INSET)) runs.push(mkRun(resample(wall, 2), false));
  const at = (R: Run, s: number): { p: P2; u: P2 } => {
    let i = 1;
    while (i < R.cum.length - 1 && R.cum[i] < s) i++;
    const p0 = R.pts[i - 1];
    const p1 = R.pts[i];
    const l = R.cum[i] - R.cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (s - R.cum[i - 1]) / l));
    return { p: [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t], u: [(p1[0] - p0[0]) / l, (p1[1] - p0[1]) / l] };
  };
  // out over the water: the quay faces the river; canal walls have the water on their left
  const outOf = (R: Run, u: P2): P2 => (R.quay ? [0, -1] : [-u[1], u[0]]);
  const blocked = (R: Run, p: P2) =>
    (R.quay ? water.gap(p[0], quayW * 0.5) < 1.5 || B.piers.some((q) => Math.abs(q.a - p[0]) < q.width / 2 + 2) : p[1] < quayW + 4) ||
    B.bridges.some((br) => Math.hypot(p[0] - br.a, p[1] - br.c) < br.span / 2 + br.width / 2 + 3);
  const free = (R: Run, s0: number, s1: number, pad: number) => !R.taken.some(([t0, t1]) => s1 > t0 - pad && s0 < t1 + pad);
  const slip = (R: Run, s: number, width: number, steps: boolean): boolean => {
    for (const dir of rng.chance(0.5) ? [1, -1] : [-1, 1]) {
      const s0 = dir > 0 ? s : s - len;
      const s1 = dir > 0 ? s + len : s;
      if (s0 < 2 || s1 > R.cum[R.cum.length - 1] - 2 || !free(R, s0, s1, 3)) continue;
      const u0 = at(R, s0).u;
      let ok = true;
      for (let x = s0; x <= s1 && ok; x += 2) {
        const { p, u } = at(R, x);
        if (blocked(R, p) || u[0] * u0[0] + u[1] * u0[1] < 0.985) ok = false;
      }
      if (!ok) continue;
      R.taken.push([s0, s1]);
      const top = at(R, s);
      const [na, nc] = outOf(R, top.u);
      B.slips.push({ a: top.p[0], c: top.p[1], ua: top.u[0] * dir, uc: top.u[1] * dir, na, nc, len, width, steps });
      return true;
    }
    return false;
  };
  // public water stairs where lanes come down to the quay, then every ~120 m
  for (const p of B.paths) {
    const e = p.pts[p.pts.length - 1];
    if (p.kind === 'main' && e[1] < quayW) slip(quay, e[0] + L, 3.0, true);
  }
  for (let a = -L + 60; a < L - 60; a += 120) if (free(quay, a + L - 60, a + L + 60, 0)) slip(quay, a + L + rng.range(-20, 20), 3.0, true);
  // a slipway at the door of each house on the water, or else an underwater door
  for (const b of B.buildings) {
    if (!b.wet || b.kind === 'mill') continue;
    const dx = frontDoorX(b);
    const da = b.a + dx * Math.cos(b.rot);
    const dc = b.c + dx * Math.sin(b.rot);
    let best: { R: Run; s: number; d: number } | null = null;
    for (const R of runs) {
      for (let i = 0; i < R.pts.length; i++) {
        const d = Math.hypot(R.pts[i][0] - da, R.pts[i][1] - dc);
        if (!best || d < best.d) best = { R, s: R.cum[i], d };
      }
    }
    if (!best || best.d > (best.R.quay ? quayW + 8 : 12)) continue;
    if (rng.chance(0.75) && slip(best.R, best.s, rng.range(1.2, 2.0), false)) continue;
    const { p, u } = at(best.R, best.s);
    if (!free(best.R, best.s - 1, best.s + 1, 1.5) || blocked(best.R, p)) continue;
    const [na, nc] = outOf(best.R, u);
    B.waterDoors.push({ a: p[0], c: p[1], na, nc });
    best.R.taken.push([best.s - 1, best.s + 1]);
  }
  // public slipways along the canals
  for (const R of runs) if (!R.quay) for (let s = 30; s < R.cum[R.cum.length - 1] - 30; s += 70) slip(R, s + rng.range(-10, 10), 1.8, false);
  // no barge moored stern-in across a slipway
  B.moorings = B.moorings.filter((m) => m.rot !== 0 || !B.slips.some((sl) => sl.nc < -0.9 && Math.abs(m.a - (sl.a + (sl.ua * sl.len) / 2)) < sl.len / 2 + 6));
}

// ---------------------------------------------------------------------------
// Hamlets: dwellings and burrows round a village green, a track along the
// bank, jetties, fishing racks, a shrine, garden plots and a boathouse.

function hamletBank(site: TownSite, side: 1 | -1): BankLayout {
  const rng = new Rng(seedFor(site.seed, `hamlet${side}`));
  const B = emptyBank(side);
  const L = site.halfLen;
  const D = site.depthInland;
  const P = new Plan(B, L, D, 3, new Water([], []), Math.min(45, D * 0.35));
  const n = rng.int(20, 60);

  // boathouse, jetties and small boats
  const ba = rng.range(-L * 0.6, L * 0.6);
  const nj = rng.int(1, 5);
  for (let i = 0; i < nj; i++) {
    const a = -L * 0.7 + (L * 1.4 * (i + 0.5)) / nj + rng.range(-10, 10);
    if (Math.abs(a - ba) < 10) continue;
    const len = rng.range(8, 20);
    B.piers.push({ a, len, width: 2, stone: false });
    if (rng.chance(0.6)) B.moorings.push({ a: a + 3, c: -len * 0.6, rot: Math.PI / 2, len: rng.range(5, 8), seed: rng.int(0, 1e9) });
  }
  B.dock = { a: B.piers[0]?.a ?? 0, c: 0 };
  // fishing racks near the water
  for (let i = rng.int(2, 7); i > 0; i--) {
    const r = { a: rng.range(-L + 5, L - 5), c: 3.3, rot: rng.range(-0.3, 0.3) };
    B.racks.push(r);
    P.keep.push({ a: r.a, c: r.c, r: 2.4 });
  }

  // a track along the bank
  const ctrl: P2[] = [];
  for (let a = -L - 6; a < L + 6; a += rng.range(22, 34)) ctrl.push([a, rng.range(7.5, 10.5)]);
  ctrl.push([L + 6, rng.range(7.5, 10.5)]);
  const bank = resample(smooth(ctrl, 6), 3);
  P.addPath({ pts: bank, width: 2.6, kind: 'track', paving: 'earth' });
  const bankC = (a: number) => bank.reduce((best, p) => (Math.abs(p[0] - a) < Math.abs(best[0] - a) ? p : best))[1];
  B.signpost = { a: B.dock.a + 5, c: bankC(B.dock.a + 5) + 2.6 };
  P.keep.push({ a: B.signpost.a, c: B.signpost.c, r: 2.4 }, { a: B.dock.a + 8, c: 10, r: 3.5 });

  // the village green with its shrine
  const gA = Math.max(-L * 0.5, Math.min(L * 0.5, B.dock.a + rng.range(-35, 35)));
  const gC = rng.range(24, Math.max(26, Math.min(38, D * 0.32)));
  const G = commons(rng, gA, gC, 60, rng.range(7, 10), 'commons', 'green');
  P.addPlaza(G.plaza);
  B.statues.push({ a: gA, c: gC, rot: Math.PI, kind: rng.pick(['otter', 'fish', 'flow', 'quinlan'] as const), scale: 1, seed: rng.int(0, 1e9), plinth: 0.9 });
  B.spot = { a: gA, c: gC - G.plaza.r * 0.6 };
  const laneW = 2.2;
  const toBank = route(P, rng, [gA, gC - G.rim(-Math.PI / 2) + 1], [B.dock.a + rng.range(-6, 6), bankC(B.dock.a) + 0.5], laneW, 0.12);
  if (toBank) {
    P.addPath({ pts: toBank.pieces[0], width: laneW, kind: 'track', paving: 'earth' });
    const f = toBank.pieces[0];
    G.exits.push(Math.atan2(f[1][1] - gC, f[1][0] - gA));
  }
  // lanes wandering off from the green
  for (let k = rng.int(2, 5); k > 0; k--) {
    let bestT = 0;
    let bestGap = -1;
    for (let j = 0; j < 36; j++) {
      const t = (j / 36) * TAU;
      const g = G.exits.length ? Math.min(...G.exits.map((e) => Math.abs(wrapAngle(t - e)))) : Math.PI;
      if (g > bestGap) {
        bestGap = g;
        bestT = t;
      }
    }
    if (bestGap < 0.7) break;
    G.exits.push(bestT);
    const curl = rng.range(-0.5, 0.5);
    const len = rng.range(30, 80);
    const pts: P2[] = [];
    for (let r = G.rim(bestT) - 0.8; r < G.plaza.r + len; r += 3) {
      const t = bestT + (curl * Math.max(0, r - G.rMax)) / 30;
      const p: P2 = [gA + Math.cos(t) * r, gC + Math.sin(t) * r];
      if (pts.length && (!P.inBounds(p[0], p[1], 8) || p[1] < 14 || P.pathGap(p[0], p[1]) < 2)) break;
      pts.push(p);
    }
    if (pts.length > 4) P.addPath({ pts, width: laneW, kind: 'track', paving: 'earth' });
  }

  // dwellings round the green, along the lanes and the bank, then scattered
  const dwelling = (_a: number, c: number): Spec | null => {
    if (B.buildings.length >= n) return null;
    const burrow = rng.chance(c < 40 ? 0.65 : 0.35);
    return {
      ...UNDRESSED,
      w: burrow ? rng.range(6, 9) : rng.range(6, 10),
      d: burrow ? rng.range(6, 8) : rng.range(6, 9),
      kind: burrow ? 'burrow' : 'house',
      floors: 1,
      roof: burrow ? 'turf' : 'thatch',
      district: 'residential',
      mural: rng.chance(0.08),
      waterDoor: false,
      tower: false,
    };
  };
  const yard = (b: Building) => gardenBehind(P, rng, b, 0.5);
  lineUp(P, rng, [...G.plaza.rim, G.plaza.rim[0]], 0, -1, dwelling, { set: [2, 4.5], gap: [2, 6], jit: 0.12, after: yard });
  for (const p of B.paths.slice(1)) for (const sd of [1, -1] as const) lineUp(P, rng, p.pts, p.width / 2, sd, dwelling, { set: [1.5, 4], gap: [3, 10], jit: 0.15, after: yard });
  lineUp(P, rng, bank, 1.3, 1, dwelling, { set: [2, 6], gap: [5, 16], jit: 0.18, after: yard });
  for (let k = 0; k < n * 6 && B.buildings.length < n; k++) {
    const a = rng.range(-L + 6, L - 6);
    const c = 12 + Math.pow(rng.next(), 1.6) * (D - 20);
    const sp = dwelling(a, c)!;
    const b: Building = { ...sp, a, c, rot: rng.range(-0.3, 0.3) + (rng.chance(0.15) ? Math.PI / 2 : 0), seed: rng.int(0, 1e9), sunken: sp.kind === 'burrow' };
    if (!P.fits(obbOf(b), 1.5, 1.5)) continue;
    P.addBuilding(b);
    yard(b);
  }
  B.buildings.push({ ...UNDRESSED, a: ba, c: 2, w: 8, d: 9, rot: 0, floors: 1, kind: 'boathouse', roof: 'thatch', district: 'waterfront', seed: rng.int(0, 1e9), mural: false, waterDoor: true, sunken: false, tower: false, wet: true });

  // trees (own random stream: the rest of the hamlet stays the same)
  const trng = new Rng(seedFor(site.seed, `hamletTrees${side}`));
  for (let k = trng.int(1, 4); k > 0; k--) {
    const t = trng.range(0, TAU);
    B.trees.push({ a: gA + Math.cos(t) * G.plaza.r * 0.7, c: gC + Math.sin(t) * G.plaza.r * 0.7, scale: trng.range(0.8, 1.1), type: 0 });
  }
  yardTrees(P, trng, 11, 9, 0.5);
  dress(B, 'hamlet', [B.dock.a, 0], Math.max(L, D) * 0.9, site.seed);
  return B;
}
