// Town layout generation (spec 7.1 / 7.2). Everything is planned in the
// town frame (a, c): a = metres along the river (axial), c = metres inland
// from the channel edge on one bank. The river is the main street: a quay runs
// along the bank, streets grow perpendicular to and parallel with the water,
// canals cut through blocks, the market square sits near the main dock, and
// blocks are filled with buildings by district.

import { Rng, seedFor } from '../core/rng';
import type { TownSite } from '../world/gen/settlements';

export type District = 'waterfront' | 'market' | 'craft' | 'residential' | 'civic' | 'university' | 'mill' | 'edge';
export type BuildingKind =
  | 'house'
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
  | 'shrine';
export type RoofKind = 'thatch' | 'tile' | 'shingle' | 'slate' | 'turf' | 'dome' | 'flat';

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
}

export interface Rect {
  a0: number;
  a1: number;
  c0: number;
  c1: number;
}

export interface Street extends Rect {
  kind: 'quay' | 'main' | 'lane' | 'plaza' | 'path' | 'canalwalk';
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
  /** Direction: 'a' spans along a (over a cross canal), 'c' spans along c (over a parallel canal). */
  dir: 'a' | 'c';
  span: number;
  width: number;
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
  streets: Street[];
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
  gardens: Rect[];
  quay: boolean;
  basins: Rect[];
  market: Rect | null;
  amphitheater: { a: number; c: number; r: number } | null;
  dock: { a: number; c: number };
  signpost: { a: number; c: number };
}

export interface TownLayout {
  site: TownSite;
  banks: BankLayout[];
  /** Cross-river bridges (cities). */
  riverBridges: { a: number; width: number }[];
  buildingCount: number;
}

// ---------------------------------------------------------------------------

function overlaps(r: Rect, q: Rect, pad = 0): boolean {
  return r.a0 < q.a1 + pad && r.a1 > q.a0 - pad && r.c0 < q.c1 + pad && r.c1 > q.c0 - pad;
}

function canalRects(site: TownSite): { rect: Rect; dir: 'a' | 'c' }[] {
  const out: { rect: Rect; dir: 'a' | 'c' }[] = [];
  for (const cn of site.canals) {
    for (let i = 0; i < cn.pts.length - 1; i++) {
      const [a0, c0] = cn.pts[i];
      const [a1, c1] = cn.pts[i + 1];
      const hw = cn.width / 2 + 2.5; // canal + stone edge
      out.push({
        rect: { a0: Math.min(a0, a1) - hw, a1: Math.max(a0, a1) + hw, c0: Math.min(c0, c1) - hw, c1: Math.max(c0, c1) + hw },
        dir: Math.abs(a1 - a0) > Math.abs(c1 - c0) ? 'a' : 'c',
      });
    }
  }
  return out;
}

export function generateTownLayout(site: TownSite): TownLayout {
  const banks: BankLayout[] = [];
  const primary = site.kind === 'hamlet' ? hamletBank(site, site.side) : townBank(site, site.side, true);
  banks.push(primary);
  const riverBridges: { a: number; width: number }[] = [];
  if (site.bothBanks) {
    banks.push(townBank(site, (-site.side) as 1 | -1, false));
    const rng = new Rng(seedFor(site.seed, 'bridges'));
    const n = rng.int(2, 4);
    const avoid = (a: number) =>
      primary.market && a > primary.market.a0 - 45 && a < primary.market.a1 + 45
        ? true
        : primary.basins.some((b) => a > b.a0 - 40 && a < b.a1 + 40) || primary.piers.some((p) => Math.abs(p.a - a) < 20);
    for (let i = 0; i < n; i++) {
      let a = -site.halfLen * 0.75 + (site.halfLen * 1.5 * (i + 0.5)) / n + rng.range(-60, 60);
      for (let k = 0; k < 12 && avoid(a); k++) a += 35 * (k % 2 ? -k : k);
      if (avoid(a) || Math.abs(a) > site.halfLen - 40) continue;
      const width = rng.range(9, 14);
      riverBridges.push({ a, width });
      // clear buildings and moorings from the ramp corridor on both banks
      for (const b of banks) {
        b.buildings = b.buildings.filter((x) => !(Math.abs(x.a - a) < width / 2 + x.w / 2 + 3 && x.c < 45));
        b.moorings = b.moorings.filter((m) => Math.abs(m.a - a) > width + 14);
        b.stalls = b.stalls.filter((s) => Math.abs(s.a - a) > width);
      }
    }
  }
  let count = 0;
  for (const b of banks) count += b.buildings.length;
  return { site, banks, riverBridges, buildingCount: count };
}

function emptyBank(side: 1 | -1): BankLayout {
  return {
    side,
    buildings: [],
    streets: [],
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
    gardens: [],
    quay: false,
    basins: [],
    market: null,
    amphitheater: null,
    dock: { a: 0, c: 0 },
    signpost: { a: 0, c: 0 },
  };
}

const ROOFS_TOWN: RoofKind[] = ['tile', 'tile', 'tile', 'shingle', 'shingle', 'thatch', 'slate'];

function townBank(site: TownSite, side: 1 | -1, primary: boolean): BankLayout {
  const rng = new Rng(seedFor(site.seed, `bank${side}`));
  const B = emptyBank(side);
  const city = site.kind === 'city';
  const L = site.halfLen;
  const D = site.depthInland * (primary ? 1 : 0.8);
  B.quay = true;
  const canals = primary ? canalRects(site) : [];
  const basins = primary ? site.basins.map((b) => ({ a0: b.a0 - 3, a1: b.a1 + 3, c0: b.c0, c1: b.c1 + 3 })) : [];
  const blocked = (r: Rect, pad = 0) => canals.some((c) => overlaps(r, c.rect, pad)) || basins.some((b) => overlaps(r, b, pad));
  B.basins = basins;

  // ---- quay and waterfront street
  const quayW = city ? 12 : 9;
  const frontW = city ? 8 : 6;
  B.streets.push({ a0: -L, a1: L, c0: 0, c1: quayW, kind: 'quay' });
  B.streets.push({ a0: -L, a1: L, c0: quayW, c1: quayW + frontW, kind: 'main' });
  const c0Blocks = quayW + frontW;

  // ---- cross streets (perpendicular to the river)
  const canalA = site.canals.filter(() => primary).map((cn) => cn.pts[0][0]);
  const crossA: number[] = [];
  const stepMin = city ? 44 : 36;
  const stepMax = city ? 78 : 66;
  for (let a = -L + rng.range(10, 30); a < L - 15; a += rng.range(stepMin, stepMax)) {
    if (canalA.some((ca) => Math.abs(ca - a) < 16)) continue;
    crossA.push(a);
  }
  // canals act as cross separators too
  const separators = [...crossA.map((a) => ({ a, canal: false })), ...canalA.map((a) => ({ a, canal: true }))].sort((p, q) => p.a - q.a);
  for (const a of crossA) {
    const w = rng.chance(0.3) ? rng.range(6, 8) : rng.range(3.5, 5);
    B.streets.push({ a0: a - w / 2, a1: a + w / 2, c0: c0Blocks, c1: D, kind: w > 5.5 ? 'main' : 'lane' });
  }
  // canal-side walks
  for (const c of canals) {
    if (c.dir === 'c') {
      B.streets.push({ a0: c.rect.a0 - 3, a1: c.rect.a0, c0: Math.max(c.rect.c0, c0Blocks), c1: c.rect.c1, kind: 'canalwalk' });
      B.streets.push({ a0: c.rect.a1, a1: c.rect.a1 + 3, c0: Math.max(c.rect.c0, c0Blocks), c1: c.rect.c1, kind: 'canalwalk' });
    } else {
      B.streets.push({ a0: c.rect.a0, a1: c.rect.a1, c0: c.rect.c0 - 3, c1: c.rect.c0, kind: 'canalwalk' });
      B.streets.push({ a0: c.rect.a0, a1: c.rect.a1, c0: c.rect.c1, c1: c.rect.c1 + 3, kind: 'canalwalk' });
    }
  }

  // ---- parallel streets
  const parC: number[] = [];
  for (let c = c0Blocks + rng.range(38, 60); c < D - 22; c += rng.range(city ? 48 : 40, city ? 80 : 68)) parC.push(c);
  for (const c of parC) {
    const w = rng.range(4, 6.5);
    B.streets.push({ a0: -L, a1: L, c0: c - w / 2, c1: c + w / 2, kind: w > 5.5 ? 'main' : 'lane' });
  }
  // bridges where streets meet canals
  for (const cn of canals) {
    if (cn.dir === 'c') {
      const ca = (cn.rect.a0 + cn.rect.a1) / 2;
      const span = cn.rect.a1 - cn.rect.a0;
      B.bridges.push({ a: ca, c: quayW + frontW / 2, dir: 'a', span, width: frontW });
      for (const c of parC) if (c > cn.rect.c0 && c < cn.rect.c1) B.bridges.push({ a: ca, c, dir: 'a', span, width: 5 });
    } else {
      for (const a of crossA)
        if (a > cn.rect.a0 && a < cn.rect.a1) B.bridges.push({ a, c: (cn.rect.c0 + cn.rect.c1) / 2, dir: 'c', span: cn.rect.c1 - cn.rect.c0, width: 4.5 });
    }
  }

  // ---- market square near the main dock (centre of the primary bank)
  const edges = [-L, ...separators.map((s) => s.a), L];
  let mIdx = 0;
  let best = Infinity;
  const target = primary ? 0 : rng.range(-L * 0.3, L * 0.3);
  for (let i = 0; i < edges.length - 1; i++) {
    const mid = (edges[i] + edges[i + 1]) / 2;
    const d = Math.abs(mid - target);
    if (basins.some((b) => edges[i + 1] > b.a0 - 30 && edges[i] < b.a1 + 30)) continue;
    if (d < best && edges[i + 1] - edges[i] > 30) {
      best = d;
      mIdx = i;
    }
  }
  const mDepth = Math.min(city ? 90 : 55, (parC[0] ?? D) - c0Blocks - 4);
  const market: Rect = { a0: edges[mIdx] + 4, a1: edges[mIdx + 1] - 4, c0: c0Blocks, c1: c0Blocks + mDepth };
  if (market.a1 - market.a0 > 60) {
    const mid = (market.a0 + market.a1) / 2;
    const half = city ? 55 : 32;
    market.a0 = mid - half;
    market.a1 = mid + half;
  }
  B.market = market;
  B.streets.push({ ...market, kind: 'plaza' });
  const mA = (market.a0 + market.a1) / 2;
  const mC = (market.c0 + market.c1) / 2;
  B.dock = { a: mA, c: 0 };
  B.signpost = { a: mA + 6, c: quayW + frontW + 1 };
  B.fountains.push({ a: mA, c: mC, r: city ? 7 : 4.5 });
  B.statues.push({ a: mA, c: mC, rot: rng.range(0, 6.28), kind: rng.pick(['quinlan', 'singers', 'flow'] as const), scale: city ? 2.6 : 1.8, seed: rng.int(0, 1e9), plinth: city ? 2.2 : 1.5 });
  // extra statues around the square
  const nStat = city ? 4 : rng.int(1, 3);
  for (let i = 0; i < nStat; i++) {
    const t = (i + 0.5) / nStat;
    B.statues.push({
      a: market.a0 + 5 + (market.a1 - market.a0 - 10) * t,
      c: market.c1 - 5,
      rot: Math.PI,
      kind: rng.pick(['quinlan', 'fish', 'otter', 'flow'] as const),
      scale: rng.range(1.1, 1.6),
      seed: rng.int(0, 1e9),
      plinth: rng.range(0.8, 1.4),
    });
  }
  // public bathing pool (sometimes) and stalls
  if (rng.chance(city ? 1 : 0.55)) {
    const pw = city ? 22 : 12;
    B.pools.push({ a0: market.a0 + 6, a1: market.a0 + 6 + pw, c0: market.c0 + 6, c1: market.c0 + 6 + pw * 0.6 });
  }
  const nStalls = city ? 26 : 12;
  for (let i = 0; i < nStalls; i++) {
    const onEdge = rng.chance(0.5);
    const a = onEdge ? market.a0 + 4 + rng.range(0, market.a1 - market.a0 - 8) : mA + rng.range(-1, 1) * (market.a1 - market.a0) * 0.35;
    const c = onEdge ? (rng.chance(0.5) ? market.c0 + 4 : market.c1 - 4) : mC + rng.range(-1, 1) * (market.c1 - market.c0) * 0.35;
    if (Math.hypot(a - mA, c - mC) < (city ? 12 : 8)) continue;
    if (B.pools.some((p) => a > p.a0 - 3 && a < p.a1 + 3 && c > p.c0 - 3 && c < p.c1 + 3)) continue;
    B.stalls.push({ a, c, rot: rng.chance(0.5) ? 0 : Math.PI / 2, seed: rng.int(0, 1e9) });
  }
  // square trees
  for (let i = 0; i < (city ? 10 : 4); i++) {
    B.trees.push({ a: market.a0 + 3 + rng.range(0, market.a1 - market.a0 - 6), c: rng.chance(0.5) ? market.c0 + 2 : market.c1 - 2, scale: rng.range(0.6, 0.9), type: 0 });
  }

  // ---- piers at the main dock + moorings along the quay
  const nPiers = city ? rng.int(4, 7) : rng.int(2, 4);
  for (let i = 0; i < nPiers; i++) {
    const a = mA + (i - (nPiers - 1) / 2) * rng.range(26, 38);
    if (a < -L + 10 || a > L - 10) continue;
    if (canalA.some((ca) => Math.abs(ca - a) < 14)) continue;
    if (basins.some((b) => a > b.a0 - 10 && a < b.a1 + 10)) continue;
    const len = rng.range(18, city ? 45 : 30);
    B.piers.push({ a, len, width: rng.range(3.5, 5.5), stone: city && rng.chance(0.4) });
    // barges moored along the pier
    if (rng.chance(0.8)) B.moorings.push({ a: a + 6.5, c: -len * 0.55, rot: Math.PI / 2, len: rng.range(12, 18), seed: rng.int(0, 1e9) });
    if (rng.chance(0.5)) B.moorings.push({ a: a - 6.5, c: -len * 0.5, rot: Math.PI / 2, len: rng.range(10, 16), seed: rng.int(0, 1e9) });
  }
  // barges moor stern-in along the long quay
  for (let a = -L + 20; a < L - 20; a += rng.range(22, 55)) {
    if (Math.abs(a - mA) < nPiers * 20) continue;
    if (basins.some((b) => a > b.a0 - 8 && a < b.a1 + 8)) continue;
    if (rng.chance(0.45)) B.moorings.push({ a, c: -8, rot: 0, len: rng.range(10, 16), seed: rng.int(0, 1e9) });
  }
  // quay statues
  for (let i = 0; i < (city ? 5 : 2); i++) {
    const a = -L * 0.8 + rng.range(0, L * 1.6);
    if (basins.some((b) => a > b.a0 - 5 && a < b.a1 + 5)) continue;
    B.statues.push({ a, c: quayW - 2, rot: Math.PI, kind: rng.pick(['fish', 'otter', 'flow', 'quinlan'] as const), scale: rng.range(1, 1.4), seed: rng.int(0, 1e9), plinth: 1 });
  }

  // ---- blocks and lots
  const cEdges = [c0Blocks, ...parC, D];
  let tavernCount = 0;
  let hallPlaced = false;
  let watchPlaced = false;
  let civicPlaced = false;
  const uniA = city ? rng.range(-L * 0.8, L * 0.4) : 1e9;
  for (let i = 0; i < edges.length - 1; i++) {
    for (let j = 0; j < cEdges.length - 1; j++) {
      const block: Rect = {
        a0: edges[i] + 3,
        a1: edges[i + 1] - 3,
        c0: cEdges[j] + (j === 0 ? 1 : 3.2),
        c1: cEdges[j + 1] - 3.2,
      };
      if (block.a1 - block.a0 < 10 || block.c1 - block.c0 < 9) continue;
      if (overlaps(block, market)) {
        // head of the square: the singing hall / civic hall
        if (!hallPlaced && j === 0) {
          hallPlaced = true;
          const hw = Math.min(city ? 40 : 26, market.a1 - market.a0 - 6);
          B.buildings.push({
            a: mA,
            c: market.c1 + (city ? 16 : 11),
            w: hw,
            d: city ? 26 : 18,
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
          });
          civicPlaced = city;
        }
        continue;
      }
      // parks and open greens break up the grid
      if (j > 0 && rng.chance(city ? 0.2 : 0.08)) {
        B.gardens.push({ a0: block.a0 + 2, a1: block.a1 - 2, c0: block.c0 + 2, c1: block.c1 - 2 });
        for (let k = 0; k < 4; k++)
          B.trees.push({ a: block.a0 + rng.range(3, block.a1 - block.a0 - 3), c: block.c0 + rng.range(3, block.c1 - block.c0 - 3), scale: rng.range(0.7, 1.1), type: 0 });
        continue;
      }
      const inUni = city && Math.abs((block.a0 + block.a1) / 2 - uniA) < 110 && j >= 1 && j <= 2;
      const district: District =
        j === 0 ? 'waterfront' : inUni ? 'university' : Math.abs((block.a0 + block.a1) / 2 - mA) < 90 && j <= 1 ? 'market' : rng.chance(0.3) ? 'craft' : j >= cEdges.length - 2 ? 'edge' : 'residential';
      fillBlock(B, block, district, rng, {
        blocked,
        city,
        onTavern: () => tavernCount++ < (city ? 8 : 3),
        onWatch: () => (watchPlaced ? false : (watchPlaced = true)),
        onCivic: () => (civicPlaced ? false : (civicPlaced = true)),
      });
    }
  }

  // mills where canals end inland
  for (const cn of primary ? site.canals : []) {
    const last = cn.pts[cn.pts.length - 1];
    if (cn.pts.length < 3) continue;
    const r: Rect = { a0: last[0] - 7, a1: last[0] + 7, c0: last[1] + 1, c1: last[1] + 13 };
    if (blocked(r, -2)) continue;
    B.buildings.push({ a: last[0], c: last[1] + 7, w: 12, d: 11, rot: 0, floors: 2, kind: 'mill', roof: 'shingle', district: 'mill', seed: rng.int(0, 1e9), mural: false, waterDoor: true, sunken: false, tower: false });
  }

  // amphitheatre and walls for river cities
  if (city && primary) {
    B.amphitheater = { a: rng.chance(0.5) ? -L * 0.62 : L * 0.62, c: D * 0.72, r: rng.range(32, 44) };
    const am = B.amphitheater;
    B.buildings = B.buildings.filter((b) => Math.hypot(b.a - am.a, b.c - am.c) > am.r + 6);
  }
  if (city) {
    const wc = D + 8;
    const gates = [...crossA.filter((a) => rng.chance(0.25)), 0];
    for (let a = -L - 10; a < L + 10; a += 40) {
      const a1 = Math.min(a + 40, L + 10);
      B.walls.push({ a0: a, c0: wc, a1, c1: wc, gate: gates.some((g) => g > a && g < a1) });
    }
    for (const sgn of [-1, 1]) {
      for (let c = 0; c < wc; c += 40) B.walls.push({ a0: sgn * (L + 10), c0: c, a1: sgn * (L + 10), c1: Math.min(c + 40, wc), gate: c < 1 });
    }
  }
  // trees in back gardens
  for (const g of B.gardens) {
    if (rng.chance(0.55)) B.trees.push({ a: (g.a0 + g.a1) / 2 + rng.range(-2, 2), c: (g.c0 + g.c1) / 2, scale: rng.range(0.5, 0.85), type: rng.chance(0.5) ? 3 : 0 });
  }
  return B;
}

interface FillOpts {
  blocked: (r: Rect, pad?: number) => boolean;
  city: boolean;
  onTavern: () => boolean;
  onWatch: () => boolean;
  onCivic: () => boolean;
}

function fillBlock(B: BankLayout, block: Rect, district: District, rng: Rng, o: FillOpts) {
  const firstBuilding = B.buildings.length;
  const depth = block.c1 - block.c0;
  const rows = depth > 26 ? 2 : 1;
  for (let r = 0; r < rows; r++) {
    // front row faces the lower-c (river-side) street, back row the upper street
    const facingRiver = r === 0;
    const rowDepth = rows === 2 ? depth / 2 - 1 : depth;
    let a = block.a0;
    while (a < block.a1 - 6) {
      let w: number;
      let kind: BuildingKind = 'house';
      let floors = rng.chance(0.55) ? 2 : 1;
      let roof: RoofKind = rng.pick(ROOFS_TOWN);
      let mural = false;
      let waterDoor = false;
      let tower = false;
      const wide = district === 'waterfront' && facingRiver && rng.chance(0.4);
      if (wide) {
        kind = 'warehouse';
        w = rng.range(16, 28);
        floors = 2;
        roof = 'tile';
        mural = rng.chance(0.75);
      } else if (district === 'waterfront' && facingRiver && rng.chance(0.18) && o.onTavern()) {
        kind = 'tavern';
        w = rng.range(12, 18);
        floors = 2;
        mural = rng.chance(0.5);
      } else if (district === 'waterfront' && facingRiver && rng.chance(0.12)) {
        kind = 'boathouse';
        w = rng.range(9, 13);
        floors = 1;
        roof = 'shingle';
        waterDoor = true;
      } else if (district === 'market') {
        kind = rng.chance(0.25) && o.onTavern() ? 'tavern' : 'shop';
        w = rng.range(8, 14);
        floors = rng.chance(0.7) ? 2 : 3;
      } else if (district === 'craft') {
        kind = 'workshop';
        w = rng.range(9, 15);
        floors = rng.chance(0.6) ? 1 : 2;
        roof = rng.chance(0.5) ? 'shingle' : 'tile';
      } else if (district === 'university') {
        kind = 'university';
        w = rng.range(20, 34);
        floors = 3;
        roof = 'slate';
        mural = true;
      } else if (district === 'edge') {
        kind = rng.chance(0.35) ? 'burrow' : 'house';
        w = rng.range(7, 11);
        roof = kind === 'burrow' ? 'turf' : rng.chance(0.4) ? 'thatch' : roof;
      } else {
        w = rng.range(7, 12.5);
      }
      if (rng.chance(0.03) && o.onWatch()) {
        kind = 'watch';
        tower = true;
        w = 8;
        floors = 3;
        roof = 'tile';
      }
      if (o.city && district === 'market' && rng.chance(0.05) && o.onCivic()) {
        kind = 'civic';
        w = 30;
        floors = 3;
        roof = 'dome';
        tower = true;
        mural = true;
      }
      w = Math.min(w, block.a1 - a);
      if (w < 6) break;
      const d = Math.min(rowDepth - rng.range(0, 3), kind === 'warehouse' ? rng.range(13, 18) : kind === 'university' ? 16 : rng.range(8, 13));
      const cFront = facingRiver ? block.c0 : block.c1;
      const c = facingRiver ? cFront + d / 2 : cFront - d / 2;
      const rect: Rect = { a0: a, a1: a + w, c0: c - d / 2, c1: c + d / 2 };
      if (!o.blocked(rect, 1.5) && d > 5) {
        B.buildings.push({
          a: a + w / 2,
          c,
          w: w - rng.range(0, 1.2),
          d,
          rot: facingRiver ? 0 : Math.PI,
          floors,
          kind,
          roof,
          district,
          seed: rng.int(0, 1e9),
          mural: mural || (rng.chance(0.1) && floors >= 2),
          waterDoor,
          sunken: kind === 'burrow',
          tower,
        });
        // back garden plot behind front-row houses
        if (rows === 1 && kind === 'house' && rng.chance(0.4)) B.gardens.push({ a0: a + 1, a1: a + w - 1, c0: c + d / 2 + 1, c1: Math.min(block.c1, c + d / 2 + 8) });
      }
      a += w + (rng.chance(0.25) ? rng.range(1.5, 4) : 0.3);
    }
  }
  // trees in the yards and gaps between houses (fruit trees in some), from
  // their own random stream so the buildings of later blocks stay the same
  if (district === 'residential' || district === 'edge' || district === 'craft') {
    const trng = new Rng(seedFor(Math.round(block.a0 * 16) ^ (Math.round(block.c0 * 16) << 12), `yard${B.side}`));
    const tries = Math.round(((block.a1 - block.a0) * depth) / 260);
    const mine = B.buildings.slice(firstBuilding);
    for (let k = 0; k < tries; k++) {
      const a = trng.range(block.a0 + 2.5, block.a1 - 2.5);
      const c = trng.range(block.c0 + 2.5, block.c1 - 2.5);
      const clear = mine.every((b) => Math.abs(a - b.a) > b.w / 2 + 2.6 || Math.abs(c - b.c) > b.d / 2 + 2.6);
      if (!clear || B.trees.some((t) => Math.hypot(t.a - a, t.c - c) < 5)) continue;
      B.trees.push({ a, c, scale: trng.range(0.5, 0.95), type: trng.chance(0.35) ? 3 : 0 });
    }
  }
}

// ---------------------------------------------------------------------------
// Hamlets: a cluster of bank dwellings, jetties, fishing racks, a shrine,
// garden plots and a boathouse.

function hamletBank(site: TownSite, side: 1 | -1): BankLayout {
  const rng = new Rng(seedFor(site.seed, `hamlet${side}`));
  const B = emptyBank(side);
  const L = site.halfLen;
  const D = site.depthInland;
  const n = rng.int(20, 60);
  const placed: Rect[] = [];
  // a winding path along the bank
  B.streets.push({ a0: -L, a1: L, c0: 6, c1: 9, kind: 'path' });
  for (let k = 0; k < n * 4 && B.buildings.length < n; k++) {
    const a = rng.range(-L + 6, L - 6);
    const c = 12 + Math.pow(rng.next(), 1.6) * (D - 20);
    const burrow = rng.chance(c < 40 ? 0.65 : 0.35);
    const w = burrow ? rng.range(6, 9) : rng.range(6, 10);
    const d = burrow ? rng.range(6, 8) : rng.range(6, 9);
    const r: Rect = { a0: a - w / 2 - 2, a1: a + w / 2 + 2, c0: c - d / 2 - 2, c1: c + d / 2 + 2 };
    if (placed.some((p) => overlaps(p, r))) continue;
    placed.push(r);
    B.buildings.push({
      a,
      c,
      w,
      d,
      rot: rng.range(-0.25, 0.25) + (rng.chance(0.15) ? Math.PI / 2 : 0),
      floors: 1,
      kind: burrow ? 'burrow' : 'house',
      roof: burrow ? 'turf' : 'thatch',
      district: 'residential',
      seed: rng.int(0, 1e9),
      mural: rng.chance(0.08),
      waterDoor: false,
      sunken: burrow,
      tower: false,
    });
    if (!burrow && rng.chance(0.5)) B.gardens.push({ a0: a - w / 2, a1: a + w / 2, c0: c + d / 2 + 1, c1: c + d / 2 + 7 });
  }
  // trees among the dwellings (own random stream: the rest of the hamlet stays the same)
  const trng = new Rng(seedFor(site.seed, `hamletTrees${side}`));
  for (let k = 0; k < n * 2; k++) {
    const a = trng.range(-L + 4, L - 4);
    const c = trng.range(11, D - 4);
    const r: Rect = { a0: a - 1.5, a1: a + 1.5, c0: c - 1.5, c1: c + 1.5 };
    if (placed.some((p) => overlaps(p, r)) || B.trees.some((t) => Math.hypot(t.a - a, t.c - c) < 6)) continue;
    B.trees.push({ a, c, scale: trng.range(0.6, 1.05), type: trng.chance(0.3) ? 3 : 0 });
  }
  // boathouse on the water
  const ba = rng.range(-L * 0.6, L * 0.6);
  B.buildings.push({ a: ba, c: 2, w: 8, d: 9, rot: 0, floors: 1, kind: 'boathouse', roof: 'thatch', district: 'waterfront', seed: rng.int(0, 1e9), mural: false, waterDoor: true, sunken: false, tower: false });
  // jetties and small boats
  const nj = rng.int(1, 4);
  for (let i = 0; i < nj; i++) {
    const a = -L * 0.7 + (L * 1.4 * (i + 0.5)) / nj + rng.range(-10, 10);
    if (Math.abs(a - ba) < 10) continue;
    const len = rng.range(8, 20);
    B.piers.push({ a, len, width: 2, stone: false });
    if (rng.chance(0.6)) B.moorings.push({ a: a + 3, c: -len * 0.6, rot: Math.PI / 2, len: rng.range(5, 8), seed: rng.int(0, 1e9) });
  }
  B.dock = { a: B.piers[0]?.a ?? 0, c: 0 };
  // fishing racks near the water
  for (let i = 0; i < rng.int(2, 6); i++) B.racks.push({ a: rng.range(-L + 5, L - 5), c: rng.range(3, 8), rot: rng.range(-0.3, 0.3) });
  // a shrine with a small statue
  const sa = rng.range(-L * 0.5, L * 0.5);
  B.statues.push({ a: sa, c: 11, rot: Math.PI, kind: rng.pick(['otter', 'fish', 'flow', 'quinlan'] as const), scale: 1, seed: rng.int(0, 1e9), plinth: 0.9 });
  B.signpost = { a: B.dock.a + 5, c: 10 };
  for (let i = 0; i < rng.int(4, 10); i++) B.trees.push({ a: rng.range(-L, L), c: rng.range(15, D), scale: rng.range(0.6, 1), type: rng.chance(0.4) ? 3 : 0 });
  return B;
}
