// Ambient Quinlan life in settlements (spec 7.1 "Life and sound"): walkers on
// the streets, stall keepers, dock watchers, singing circles in the squares,
// friends chatting, the odd shouting match, swimmers in the river and kids
// diving off the piers. Everyone is drawn with a few instanced meshes, one per
// level of detail (the most detailed for the nearest Quinlans), that are
// refilled every frame.

import { Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3, type BufferGeometry, type Material } from 'three';
import { frame, wrapS } from '../coords/cylinder';
import { clamp, damp, smoothstep } from '../core/math';
import { Rng, seedFor } from '../core/rng';
import type { LoadedTown, TownManager } from '../towns/townManager';
import type { TownSite } from '../world/gen/settlements';
import type { WorldQuery } from '../world/worldQuery';
import { createQuinlanGeometry, createQuinlanInstancedGeometry, quinlanFurPalette, QUINLAN_GAIT, QUINLAN_NOMINAL_SPEED } from './quinlanModel';
import type { QuinlanAsset } from './quinlanAsset';
import { quinlanDepthMaterial, quinlanRigMaterials, quinlanWorldMaterial } from './quinlanMaterials';

const RENDER_DIST = 380;
/** Towns whose edge is within this distance of the camera are simulated. */
const ACTIVE_PAD = 450;
const GRID = 32;

type Act = 'walk' | 'pause' | 'stall' | 'watch' | 'sing' | 'chat' | 'argue' | 'swim' | 'dive' | 'greet';

interface Npc {
  variant: number;
  color: Color;
  scale: number;
  kid: boolean;
  /** Town-anchor-local position (ds, dz), height, heading. */
  x: number;
  z: number;
  h: number;
  yaw: number;
  act: Act;
  /** Activity to return to after a greeting. */
  resume: Act;
  gait: number;
  gaitT: number;
  cadence: number;
  phase: number;
  timer: number;
  sub: number;
  // walking between waypoints
  wPrev: number;
  wFrom: number;
  wTo: number;
  t: number;
  len: number;
  h0: number;
  hm: number;
  h1: number;
  speed: number;
  // anchor pose of stationary activities
  ax: number;
  az: number;
  ah: number;
  ayaw: number;
  /** Partner for chats and arguments. */
  mate: Npc | null;
  // swimming / diving, in the town frame (a along the river, c inland)
  sa: number;
  sc: number;
  sdir: number;
  tipWp: number;
  presence: number;
  shown: boolean;
  greetCool: number;
  dist: number;
}

interface Pop {
  town: LoadedTown;
  site: TownSite;
  npcs: Npc[];
  wp: Float32Array;
  grid: Map<number, number[]>;
  edges: Map<number, number[]>;
  /** Waypoint indices of pier tips (quay kind, out over the water). */
  tips: Set<number>;
  rng: Rng;
}

const gkey = (i: number, j: number) => (i + 30_000) * 60_000 + (j + 30_000);
const TAU = Math.PI * 2;
const wrapAngle = (a: number) => a - TAU * Math.round(a / TAU);
const headingOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/** One level of detail: an instanced mesh refilled every frame. */
interface Tier {
  mesh: InstancedMesh;
  anim: InstancedBufferAttribute;
  /** Most Quinlans drawn at this detail. */
  max: number;
  /** Only Quinlans nearer than this (m) use this tier. */
  dist: number;
  count: number;
}

interface TierSpec {
  geometry: BufferGeometry;
  material: Material;
  max: number;
  dist: number;
}

export class TownLife {
  readonly group = new Group();
  /** Nearest first. */
  private tiers: Tier[] = [];
  private pops = new Map<number, Pop>();
  private towns: TownManager;
  private world: WorldQuery;
  /** Singers within earshot of the camera (0..1), for the audio engine. */
  singing = 0;
  /** Crowd density near the camera (0..1). */
  crowd = 0;
  stats = { active: 0, drawn: 0 };
  /** Called when a diver hits the water (world s, z). */
  onSplash: ((s: number, z: number) => void) | null = null;

  constructor(towns: TownManager, world: WorldQuery) {
    this.towns = towns;
    this.world = world;
    // the procedural model until the textured one has loaded (useAsset)
    const mat = quinlanWorldMaterial();
    this.setTiers(
      [
        { geometry: createQuinlanGeometry('high'), material: mat, max: 36, dist: 26 },
        { geometry: createQuinlanGeometry('low'), material: mat, max: 700, dist: Infinity },
      ],
      quinlanDepthMaterial(),
    );
    towns.onLoaded.push((t) => this.populate(t));
    towns.onUnloaded.push((t) => this.pops.delete(t.site.id));
  }

  /** Switch everyone to the textured model: near (textured), mid and far LODs. */
  useAsset(asset: QuinlanAsset) {
    const m = quinlanRigMaterials(asset);
    const n = asset.lods.length;
    this.setTiers(
      [
        { geometry: asset.lods[0], material: m.textured, max: 30, dist: 20 },
        { geometry: asset.lods[Math.min(1, n - 1)], material: m.plain, max: 140, dist: 55 },
        { geometry: asset.lods[n - 1], material: m.plain, max: 700, dist: Infinity },
      ],
      m.depth,
    );
  }

  private setTiers(specs: TierSpec[], depth: Material) {
    for (const t of this.tiers) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.dispose();
    }
    this.tiers = specs.map((s) => {
      const geo = createQuinlanInstancedGeometry(s.geometry, s.max);
      const m = new InstancedMesh(geo, s.material, s.max);
      m.name = 'quinlans';
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.customDepthMaterial = depth;
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.setColorAt(0, new Color(1, 1, 1));
      m.instanceColor!.setUsage(DynamicDrawUsage);
      // anchored at the render-frame origin: instance positions are frame-relative
      m.matrixAutoUpdate = false;
      m.matrixWorldAutoUpdate = false;
      m.matrixWorld.identity();
      this.group.add(m);
      const anim = geo.getAttribute('aAnim') as InstancedBufferAttribute;
      anim.setUsage(DynamicDrawUsage);
      return { mesh: m, anim, max: s.max, dist: s.dist, count: 0 };
    });
  }

  // ------------------------------------------------------------------ population

  private populate(town: LoadedTown) {
    const site = town.site;
    const rng = new Rng(seedFor(site.seed, 'life'));
    const wp = town.waypoints;
    const nW = wp.length / 4;
    const pop: Pop = { town, site, npcs: [], wp, grid: new Map(), edges: new Map(), tips: new Set(), rng };
    for (let i = 0; i < nW; i++) {
      const k = gkey(Math.floor(wp[i * 4] / GRID), Math.floor(wp[i * 4 + 1] / GRID));
      const list = pop.grid.get(k) ?? [];
      list.push(i);
      pop.grid.set(k, list);
      if (wp[i * 4 + 3] === 2 && this.localC(site, town, wp[i * 4], wp[i * 4 + 1]) < -2.5) pop.tips.add(i);
    }
    const byKind = (k: number) => {
      const out: number[] = [];
      for (let i = 0; i < nW; i++) if (wp[i * 4 + 3] === k && !pop.tips.has(i)) out.push(i);
      return out;
    };
    const streets = byKind(0);
    const plazas = byKind(1);
    const quays = byKind(2);
    const stalls = byKind(4);
    const scale = site.kind === 'hamlet' ? 0.5 : site.kind === 'town' ? 0.85 : 1;
    const cap = site.kind === 'hamlet' ? 26 : site.kind === 'town' ? 170 : 300;
    const mk = (act: Act, x: number, z: number, h: number, yaw: number): Npc => {
      const variant = rng.int(0, 9999);
      const kid = rng.chance(0.14);
      const speed = kid ? rng.range(1.3, 1.9) : rng.range(1.0, 1.45);
      const n: Npc = {
        variant,
        color: quinlanFurPalette(variant),
        scale: kid ? rng.range(0.66, 0.76) : rng.range(0.94, 1.06),
        kid,
        x,
        z,
        h,
        yaw,
        act,
        resume: act,
        gait: 0,
        gaitT: 0,
        cadence: speed / QUINLAN_NOMINAL_SPEED.walk,
        phase: rng.next(),
        timer: rng.range(0, 4),
        sub: 0,
        wPrev: -1,
        wFrom: -1,
        wTo: -1,
        t: 0,
        len: 1,
        h0: h,
        hm: h,
        h1: h,
        speed,
        ax: x,
        az: z,
        ah: h,
        ayaw: yaw,
        mate: null,
        sa: 0,
        sc: 0,
        sdir: 1,
        tipWp: -1,
        presence: rng.next(),
        shown: false,
        greetCool: 0,
        dist: 1e9,
      };
      pop.npcs.push(n);
      return n;
    };
    const at = (i: number) => ({ x: wp[i * 4], z: wp[i * 4 + 1], h: wp[i * 4 + 2] });
    // stall keepers
    for (const i of stalls) {
      if (pop.npcs.length >= cap) break;
      const p = at(i);
      mk('stall', p.x, p.z, p.h, rng.range(-Math.PI, Math.PI));
    }
    // singing circles in squares (more of them in cities)
    const circles = Math.min(plazas.length, Math.round((site.kind === 'hamlet' ? 1 : site.kind === 'town' ? 3 : 7) * (0.6 + rng.next() * 0.8)));
    for (let c = 0; c < circles && pop.npcs.length < cap - 6; c++) {
      const p = at(plazas[rng.int(0, plazas.length - 1)]);
      const n = rng.int(3, 6);
      const r = 1.3 + n * 0.18;
      const a0 = rng.range(0, TAU);
      for (let k = 0; k < n; k++) {
        const a = a0 + (k / n) * TAU + rng.range(-0.15, 0.15);
        const x = p.x + Math.sin(a) * r;
        const z = p.z + Math.cos(a) * r;
        const npc = mk('sing', x, z, p.h, headingOf(p.x - x, p.z - z));
        npc.kid = false;
        npc.scale = rng.range(0.94, 1.06);
        npc.cadence = rng.range(0.85, 1.15);
      }
    }
    // friends chatting, and one or two shouting matches
    const pairs = Math.round(circles * 1.5 + 1);
    for (let c = 0; c < pairs && pop.npcs.length < cap - 2; c++) {
      const pool = rng.chance(0.5) && plazas.length ? plazas : streets;
      if (!pool.length) break;
      const p = at(pool[rng.int(0, pool.length - 1)]);
      const a = rng.range(0, TAU);
      const ox = Math.sin(a) * 0.75;
      const oz = Math.cos(a) * 0.75;
      const act: Act = c === 0 && site.kind !== 'hamlet' && rng.chance(0.7) ? 'argue' : 'chat';
      const A = mk(act, p.x + ox, p.z + oz, p.h, headingOf(-ox, -oz));
      const B = mk(act, p.x - ox, p.z - oz, p.h, headingOf(ox, oz));
      A.mate = B;
      B.mate = A;
      A.kid = B.kid = false;
      A.scale = rng.range(0.95, 1.05);
      B.scale = rng.range(0.95, 1.05);
    }
    // dock watchers and work songs on the quays
    for (let c = 0; c < Math.min(quays.length, Math.round(quays.length * 0.35 * scale) + 1) && pop.npcs.length < cap; c++) {
      const i = quays[rng.int(0, quays.length - 1)];
      const p = at(i);
      const toRiver = this.riverHeading(site, town, p.x, p.z);
      const npc = mk(rng.chance(0.3) ? 'sing' : 'watch', p.x + rng.range(-3, 3), p.z + rng.range(-3, 3), p.h, toRiver + rng.range(-0.6, 0.6));
      if (npc.act === 'sing') npc.kid = false;
    }
    // kids diving off pier tips
    for (const i of pop.tips) {
      if (pop.npcs.length >= cap || !rng.chance(0.6)) continue;
      const p = at(i);
      for (let k = rng.int(1, 3); k > 0; k--) {
        const npc = mk('dive', p.x, p.z, p.h, this.riverHeading(site, town, p.x, p.z));
        npc.kid = true;
        npc.scale = rng.range(0.64, 0.76);
        npc.tipWp = i;
        npc.timer = rng.range(1, 9);
      }
    }
    // swimmers in the river along the town
    const swimmers = Math.round((site.kind === 'hamlet' ? 3 : site.kind === 'town' ? 9 : 16) * (0.6 + rng.next() * 0.8));
    for (let c = 0; c < swimmers && pop.npcs.length < cap; c++) {
      const npc = mk('swim', 0, 0, 0, 0);
      npc.sa = rng.range(-site.halfLen * 0.85, site.halfLen * 0.85);
      npc.sc = -rng.range(4, 28);
      npc.sdir = rng.sign();
      npc.speed = rng.range(0.6, 1.4);
      npc.cadence = npc.speed / QUINLAN_NOMINAL_SPEED.swim;
      npc.sub = rng.range(0, TAU);
      this.placeSwimmer(pop, npc);
    }
    // walkers fill the rest
    const walkPool = streets.concat(plazas, quays);
    const walkers = Math.min(cap - pop.npcs.length, Math.round(walkPool.length * 0.5 * scale + 4));
    for (let c = 0; c < walkers && walkPool.length; c++) {
      const i = walkPool[rng.int(0, walkPool.length - 1)];
      const p = at(i);
      const npc = mk('pause', p.x, p.z, p.h, rng.range(-Math.PI, Math.PI));
      npc.wFrom = npc.wTo = i;
      npc.resume = 'walk';
    }
    this.pops.set(site.id, pop);
  }

  /** Town-frame inland distance of a town-anchor-local point. */
  private localC(site: TownSite, town: LoadedTown, x: number, z: number) {
    return site.toLocal(town.anchorS + x, town.anchorZ + z).c;
  }

  /** Heading (yaw) from a town-local point toward the river. */
  private riverHeading(site: TownSite, town: LoadedTown, x: number, z: number) {
    const s = town.anchorS + x;
    const wz = town.anchorZ + z;
    const ch = site.riverRef.channelAt(wz);
    return headingOf(wrapS(ch - s), 0);
  }

  private placeSwimmer(pop: Pop, n: Npc) {
    const { site, town } = pop;
    const w = site.toWorld(n.sa, n.sc, site.side);
    n.x = wrapS(w.s - town.anchorS);
    n.z = w.z - town.anchorZ;
    n.h = site.riverRef.levelAt(w.z);
  }

  // ------------------------------------------------------------------ navigation

  private neighbors(pop: Pop, i: number): number[] {
    const cached = pop.edges.get(i);
    if (cached) return cached;
    const wp = pop.wp;
    const x0 = wp[i * 4];
    const z0 = wp[i * 4 + 1];
    const out: number[] = [];
    const gi = Math.floor(x0 / GRID);
    const gj = Math.floor(z0 / GRID);
    const fromTip = pop.tips.has(i);
    for (let di = -2; di <= 2; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        const list = pop.grid.get(gkey(gi + di, gj + dj));
        if (!list) continue;
        for (const j of list) {
          if (j === i) continue;
          const d = Math.hypot(wp[j * 4] - x0, wp[j * 4 + 1] - z0);
          const maxD = fromTip || pop.tips.has(j) ? 48 : 27;
          if (d < 2.5 || d > maxD) continue;
          if (this.segmentClear(pop, i, j)) out.push(j);
        }
      }
    }
    pop.edges.set(i, out);
    return out;
  }

  private segmentClear(pop: Pop, i: number, j: number): boolean {
    const wp = pop.wp;
    const x0 = wp[i * 4];
    const z0 = wp[i * 4 + 1];
    const h0 = wp[i * 4 + 2];
    const x1 = wp[j * 4];
    const z1 = wp[j * 4 + 1];
    const h1 = wp[j * 4 + 2];
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.ceil(d / 2.2));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      if (this.towns.blockedLocal(pop.town, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, h0 + (h1 - h0) * t + 0.3, 0.35)) return false;
    }
    // no wading across water or dropping down a quay wall
    const hm = this.surfaceAt(pop, (x0 + x1) / 2, (z0 + z1) / 2, Math.max(h0, h1));
    return hm > Math.min(h0, h1) - 1.2 && hm < Math.max(h0, h1) + 1.5;
  }

  /** Walkable height under a town-local point (terrain or structure floor). */
  private surfaceAt(pop: Pop, x: number, z: number, near: number): number {
    const s = pop.town.anchorS + x;
    const wz = pop.town.anchorZ + z;
    const g = this.world.groundHeight(s, wz);
    const f = this.towns.floorAt(s, wz, near + 0.4, 1.2);
    return f !== null ? Math.max(g, f) : g;
  }

  private startWalk(pop: Pop, n: Npc) {
    const from = n.wTo;
    let options = this.neighbors(pop, from);
    // divers only walk out along their own pier; others rarely go onto piers
    options = options.filter((j) => j !== n.wPrev && (!pop.tips.has(j) || pop.rng.chance(0.08)));
    if (!options.length) options = n.wPrev >= 0 && this.neighbors(pop, from).includes(n.wPrev) ? [n.wPrev] : [];
    if (!options.length) {
      n.act = 'pause';
      n.resume = 'walk';
      n.timer = 5 + pop.rng.next() * 10;
      return;
    }
    const to = options[pop.rng.int(0, options.length - 1)];
    this.walkTo(pop, n, from, to);
  }

  private walkTo(pop: Pop, n: Npc, from: number, to: number) {
    const wp = pop.wp;
    n.wPrev = from;
    n.wFrom = from;
    n.wTo = to;
    n.t = 0;
    // walk from where we stand (not exactly the waypoint) with a little lateral jitter
    const jx = (pop.rng.next() - 0.5) * 2.2;
    const jz = (pop.rng.next() - 0.5) * 2.2;
    n.ax = n.x;
    n.az = n.z;
    n.h0 = n.h;
    const tx = wp[to * 4] + (pop.tips.has(to) ? 0 : jx);
    const tz = wp[to * 4 + 1] + (pop.tips.has(to) ? 0 : jz);
    n.h1 = wp[to * 4 + 2];
    n.sa = tx; // walking target (reusing the swim fields)
    n.sc = tz;
    n.len = Math.max(0.5, Math.hypot(tx - n.x, tz - n.z));
    n.hm = this.surfaceAt(pop, (n.x + tx) / 2, (n.z + tz) / 2, Math.max(n.h0, n.h1));
    n.act = 'walk';
    n.gaitT = QUINLAN_GAIT.walk;
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number, cam: { s: number; z: number; h: number }, player: { s: number; z: number }, timeOfDay: number) {
    const hour = timeOfDay * 24;
    const day = smoothstep(5.5, 7.5, hour) * (1 - smoothstep(20.5, 22.5, hour));
    const evening = smoothstep(17.5, 19.5, hour) * (1 - smoothstep(23.0, 24.0, hour)) + (1 - smoothstep(0.5, 1.5, hour));
    const swimTime = smoothstep(7, 9, hour) * (1 - smoothstep(18.5, 20, hour));
    const presence: Record<Act, number> = {
      walk: 0.15 + 0.85 * day,
      pause: 0.15 + 0.85 * day,
      greet: 1,
      stall: day,
      watch: 0.25 + 0.75 * day,
      sing: 0.3 + 0.35 * day + 0.6 * evening,
      chat: 0.2 + 0.8 * day,
      argue: 0.1 + 0.9 * day,
      swim: swimTime,
      dive: swimTime,
    };
    const ox0 = frame.originS;
    const oz0 = frame.originZ;
    const tiers = this.tiers;
    for (const t of tiers) t.count = 0;
    let singers = 0;
    let crowd = 0;
    let active = 0;
    for (const pop of this.pops.values()) {
      const { site, town } = pop;
      const dTown = Math.hypot(wrapS(site.s - cam.s), site.z - cam.z) - site.radius;
      if (dTown > ACTIVE_PAD) continue;
      const ax = wrapS(town.anchorS - ox0);
      const az = town.anchorZ - oz0;
      const cx = wrapS(cam.s - town.anchorS);
      const cz = cam.z - town.anchorZ;
      const px = wrapS(player.s - town.anchorS);
      const pz = player.z - town.anchorZ;
      for (const n of pop.npcs) {
        const want = n.presence < presence[n.act === 'greet' || n.act === 'pause' ? n.resume : n.act];
        if (want !== n.shown) {
          // only pop in or out of existence where nobody is looking closely
          const d = Math.hypot(n.x - cx, n.z - cz);
          if (d > 45 || !n.shown) n.shown = want;
        }
        if (!n.shown) continue;
        active++;
        this.step(pop, n, dt, px, pz);
        const d = Math.hypot(n.x - cx, n.z - cz);
        n.dist = d;
        if (d < 70) {
          if (n.act === 'sing') singers++;
          crowd++;
        }
        if (d > RENDER_DIST) continue;
        let tier: Tier | null = null;
        for (const t of tiers) {
          if (d < t.dist && t.count < t.max) {
            tier = t;
            break;
          }
        }
        if (!tier) continue;
        const slot = tier.count++;
        const arr = tier.mesh.instanceMatrix.array as Float32Array;
        const col = tier.mesh.instanceColor!.array as Float32Array;
        const anim = tier.anim.array as Float32Array;
        _q.setFromAxisAngle(_up, n.yaw);
        _p.set(ax + n.x, n.h, az + n.z);
        _s.setScalar(n.scale);
        _m.compose(_p, _q, _s);
        _m.toArray(arr, slot * 16);
        col[slot * 3] = n.color.r;
        col[slot * 3 + 1] = n.color.g;
        col[slot * 3 + 2] = n.color.b;
        anim[slot * 4] = n.gait;
        anim[slot * 4 + 1] = n.phase;
        anim[slot * 4 + 2] = n.cadence;
        anim[slot * 4 + 3] = n.variant;
      }
    }
    let drawn = 0;
    for (const t of tiers) {
      t.mesh.count = t.count;
      t.mesh.instanceMatrix.needsUpdate = true;
      t.mesh.instanceColor!.needsUpdate = true;
      t.anim.needsUpdate = true;
      drawn += t.count;
    }
    this.singing = damp(this.singing, clamp(singers / 6, 0, 1), 1.5, dt);
    this.crowd = damp(this.crowd, clamp(crowd / 25, 0, 1), 1.5, dt);
    this.stats.active = active;
    this.stats.drawn = drawn;
  }

  private step(pop: Pop, n: Npc, dt: number, px: number, pz: number) {
    n.greetCool -= dt;
    // greet the player when they come close
    const pd = Math.hypot(px - n.x, pz - n.z);
    if (pd < 3.2 && n.greetCool <= 0 && n.act !== 'swim' && n.act !== 'dive' && n.act !== 'sing' && n.act !== 'greet' && n.act !== 'argue') {
      n.greetCool = 25 + pop.rng.next() * 20;
      if (pop.rng.chance(0.75)) {
        n.resume = n.act === 'walk' ? 'walk' : n.act === 'pause' ? n.resume : n.act;
        n.act = 'greet';
        n.timer = 2.8;
      }
    }
    switch (n.act) {
      case 'walk': {
        n.t += (n.speed * dt) / n.len;
        const t = Math.min(n.t, 1);
        n.x = n.ax + (n.sa - n.ax) * t;
        n.z = n.az + (n.sc - n.az) * t;
        // quadratic through start, middle and end heights
        const a = 2 * n.h0 - 4 * n.hm + 2 * n.h1;
        const b = -3 * n.h0 + 4 * n.hm - n.h1;
        n.h = n.h0 + b * t + a * t * t;
        n.yaw += wrapAngle(headingOf(n.sa - n.ax, n.sc - n.az) - n.yaw) * Math.min(1, dt * 5);
        n.gaitT = QUINLAN_GAIT.walk;
        if (n.t >= 1) {
          if (pop.rng.chance(0.18)) {
            n.act = 'pause';
            n.resume = 'walk';
            n.timer = 1.5 + pop.rng.next() * 6;
          } else this.startWalk(pop, n);
        }
        break;
      }
      case 'pause':
        n.gaitT = QUINLAN_GAIT.idle;
        n.timer -= dt;
        if (n.timer <= 0) {
          if (n.resume === 'walk') this.startWalk(pop, n);
          else n.act = n.resume;
        }
        break;
      case 'greet': {
        n.yaw += wrapAngle(headingOf(px - n.x, pz - n.z) - n.yaw) * Math.min(1, dt * 4);
        n.gaitT = n.timer < 2.4 ? QUINLAN_GAIT.smile : QUINLAN_GAIT.idle;
        n.timer -= dt;
        if (n.timer <= 0) {
          if (n.resume === 'walk' && n.t < 1 && n.wTo >= 0 && n.wFrom !== n.wTo) {
            n.act = 'walk'; // carry on along the same street
          } else if (n.resume === 'walk') {
            n.act = 'pause';
            n.timer = 0.4;
          } else {
            n.act = n.resume;
            n.timer = 3;
          }
        }
        break;
      }
      case 'stall':
      case 'watch':
      case 'chat': {
        // idle with the occasional jaw-rub smile; chatting friends face each other
        if (n.mate) n.yaw += wrapAngle(headingOf(n.mate.x - n.x, n.mate.z - n.z) - n.yaw) * Math.min(1, dt * 3);
        n.timer -= dt;
        if (n.timer <= 0) {
          const smiling = n.gaitT === QUINLAN_GAIT.smile;
          n.gaitT = smiling ? QUINLAN_GAIT.idle : pop.rng.chance(n.act === 'chat' ? 0.5 : 0.25) ? QUINLAN_GAIT.smile : QUINLAN_GAIT.idle;
          n.timer = n.gaitT === QUINLAN_GAIT.smile ? 1.6 + pop.rng.next() * 1.4 : 3 + pop.rng.next() * 9;
        }
        break;
      }
      case 'argue': {
        // a loud quarrel: they square up, step in and back, rub jaws furiously
        const m = n.mate!;
        const dx = m.x - n.x;
        const dz = m.z - n.z;
        n.yaw += wrapAngle(headingOf(dx, dz) - n.yaw) * Math.min(1, dt * 6);
        n.timer -= dt;
        if (n.timer <= 0) {
          n.sub = (n.sub + 1) % 4;
          n.timer = 0.5 + pop.rng.next() * 1.2;
          n.gaitT = n.sub === 1 ? QUINLAN_GAIT.walk : n.sub === 3 ? QUINLAN_GAIT.idle : QUINLAN_GAIT.smile;
        }
        const d = Math.hypot(dx, dz);
        const want = n.sub === 1 ? 0.85 : 1.6;
        if (d > 1e-3) {
          const step = clamp((d - want) * dt * 1.5, -0.02, 0.02);
          n.x += (dx / d) * step;
          n.z += (dz / d) * step;
        }
        break;
      }
      case 'sing':
        n.gaitT = QUINLAN_GAIT.sing;
        break;
      case 'swim':
        this.stepSwim(pop, n, dt);
        break;
      case 'dive':
        this.stepDive(pop, n, dt);
        break;
    }
    // blend gaits (neighbouring indices cross-fade; others switch directly)
    if (Math.abs(n.gaitT - n.gait) > 1.01) n.gait = n.gaitT;
    else n.gait = damp(n.gait, n.gaitT, 7, dt);
    if (Math.abs(n.gait - n.gaitT) < 0.01) n.gait = n.gaitT;
  }

  private stepSwim(pop: Pop, n: Npc, dt: number) {
    const site = pop.site;
    n.gaitT = QUINLAN_GAIT.swim;
    n.sub += dt * 0.15;
    const lim = site.halfLen * 0.9;
    // swim along the bank, drifting in and out, turning at the ends of town
    n.sa += n.sdir * n.speed * dt;
    if (n.sa > lim) n.sdir = -1;
    if (n.sa < -lim) n.sdir = 1;
    const dc = Math.sin(n.sub) * 0.25 * dt;
    n.sc = clamp(n.sc + dc, -32, -3);
    const px = n.x;
    const pz = n.z;
    this.placeSwimmer(pop, n);
    const dx = n.x - px;
    const dz = n.z - pz;
    if (dx * dx + dz * dz > 1e-8) n.yaw += wrapAngle(headingOf(dx, dz) - n.yaw) * Math.min(1, dt * 2.5);
  }

  /** Kids: wait at the pier tip, jump, swim a loop, climb back up, run out again. */
  private stepDive(pop: Pop, n: Npc, dt: number) {
    const { site, town, wp } = pop;
    const i = n.tipWp;
    const tx = wp[i * 4];
    const tz = wp[i * 4 + 1];
    const deck = wp[i * 4 + 2];
    const tipLocal = site.toLocal(town.anchorS + tx, town.anchorZ + tz);
    n.timer -= dt;
    switch (n.sub) {
      case 0: // waiting at the tip, looking at the water
        n.gaitT = QUINLAN_GAIT.idle;
        n.x = tx;
        n.z = tz;
        n.h = deck;
        n.yaw = this.riverHeading(site, town, tx, tz);
        if (n.timer <= 0) {
          n.sub = 1;
          n.timer = 0.95;
          n.sa = tipLocal.a + pop.rng.range(-1.2, 1.2);
          n.sc = tipLocal.c;
        }
        break;
      case 1: {
        // the jump: a short arc out over the water
        const t = 1 - n.timer / 0.95;
        const w = site.toWorld(n.sa, n.sc - 3.2 * t, site.side);
        const lvl = site.riverRef.levelAt(w.z);
        n.x = wrapS(w.s - town.anchorS);
        n.z = w.z - town.anchorZ;
        n.h = deck + (lvl - 0.4 - deck) * t + 4.5 * 1.2 * t * (1 - t);
        n.gait = n.gaitT = QUINLAN_GAIT.run;
        if (n.timer <= 0) {
          n.sub = 2;
          n.timer = pop.rng.range(6, 12);
          n.sc -= 3.2;
          n.sdir = pop.rng.sign();
          this.onSplash?.(w.s, w.z);
        }
        break;
      }
      case 2: {
        // swim a lazy loop, then head for the side of the pier
        n.gaitT = QUINLAN_GAIT.swim;
        const back = n.timer < 3;
        const goalA = tipLocal.a + n.sdir * 3.2;
        const goalC = back ? tipLocal.c * 0.45 : n.sc - 1;
        const da = back ? goalA - n.sa : n.sdir * 0.5;
        const dc = goalC - n.sc;
        const l = Math.hypot(da, dc) || 1;
        const v = 1.1 * dt;
        n.sa += (da / l) * v;
        n.sc += (dc / l) * v;
        const px = n.x;
        const pz = n.z;
        const w = site.toWorld(n.sa, n.sc, site.side);
        n.x = wrapS(w.s - town.anchorS);
        n.z = w.z - town.anchorZ;
        n.h = site.riverRef.levelAt(w.z);
        const dx = n.x - px;
        const dz = n.z - pz;
        if (dx * dx + dz * dz > 1e-8) n.yaw += wrapAngle(headingOf(dx, dz) - n.yaw) * Math.min(1, dt * 3);
        if (n.timer <= 0 && Math.hypot(goalA - n.sa, goalC - n.sc) < 0.8) {
          n.sub = 3;
          n.timer = 0.8;
          n.ax = n.x;
          n.az = n.z;
          n.ah = n.h;
        } else if (n.timer < -12) {
          n.sub = 0;
          n.timer = 4;
        }
        break;
      }
      case 3: {
        // climb up onto the deck
        const t = 1 - n.timer / 0.8;
        const w = site.toWorld(tipLocal.a, n.sc, site.side);
        const dx = wrapS(w.s - town.anchorS);
        const dz = w.z - town.anchorZ;
        n.x = n.ax + (dx - n.ax) * t;
        n.z = n.az + (dz - n.az) * t;
        n.h = n.ah + (deck - n.ah) * Math.sin((t * Math.PI) / 2);
        n.gaitT = QUINLAN_GAIT.walk;
        if (n.timer <= 0) {
          n.sub = 4;
          n.ax = n.x;
          n.az = n.z;
          n.len = Math.max(0.5, Math.hypot(tx - n.x, tz - n.z));
          n.t = 0;
        }
        break;
      }
      case 4: {
        // scamper back out to the tip on all fours
        n.gaitT = QUINLAN_GAIT.run;
        n.t += (3.2 * dt) / n.len;
        const t = Math.min(1, n.t);
        n.x = n.ax + (tx - n.ax) * t;
        n.z = n.az + (tz - n.az) * t;
        n.h = deck;
        n.yaw += wrapAngle(headingOf(tx - n.ax, tz - n.az) - n.yaw) * Math.min(1, dt * 8);
        if (t >= 1) {
          n.sub = 0;
          n.timer = pop.rng.range(2, 10);
        }
        break;
      }
    }
    n.cadence = n.sub === 4 ? 3.2 / QUINLAN_NOMINAL_SPEED.run : n.sub === 2 ? 1.1 / QUINLAN_NOMINAL_SPEED.swim : 1;
  }
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _up = new Vector3(0, 1, 0);
