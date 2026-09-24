// River journeys (spec 7.4). A Quinlan barge carries you from one town's dock
// to another along the river spline. Time is compressed so any trip lasts
// 60-180 s: the barge glides slowly past towns (with name captions) and races
// between them, while the day turns over at the compressed rate. You can walk
// the deck, look around, switch on Quinlan vision or Bob mode, or jump
// overboard (which ends the ride mid-river).

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import { frame, wrapS } from '../coords/cylinder';
import { clamp, damp, lerp, mod, smoothstep } from '../core/math';
import { MeshBuilder } from '../towns/meshBuilder';
import { buildBarge } from '../towns/props';
import { createTownMaterial } from '../towns/townMaterial';
import type { TownSite } from '../world/gen/settlements';
import type { MainRiver } from '../world/gen/rivers';
import type { InputFrame } from '../player/input';
import { createQuinlanGeometry, createQuinlanInstancedGeometry, quinlanFurPalette, QUINLAN_GAIT } from '../npc/quinlanModel';
import { quinlanDepthMaterial, quinlanWorldMaterial } from '../npc/quinlanMaterials';

const BARGE_LEN = 17;

export interface BargeHost {
  river(i: number): MainRiver;
  towns(): TownSite[];
  requestTown(id: number): void;
  setMaxLevel(l: number): void;
  caption(name: string, sub: string): void;
  toast(t: string): void;
  heard(site: TownSite): void;
  addTime(dayFraction: number): void;
  settleWorld(): boolean;
  fade(v: number): void;
  onFinish(site: TownSite, completed: boolean): void;
  sing?(on: boolean): void;
}

interface PathSample {
  z: number;
  x: number; // arc length
}

export class BargeJourney {
  readonly group = new Group();
  private mesh: Mesh;
  private host: BargeHost;
  active = false;
  from!: TownSite;
  to!: TownSite;
  private rv!: MainRiver;
  private dir = 1; // +1 along +z
  private path: PathSample[] = [];
  private length = 0;
  private knotsT: number[] = [];
  private knotsX: number[] = [];
  private tangents: number[] = [];
  private t = 0;
  duration = 120;
  private downstream = true;
  private realSeconds = 0;
  private passed = new Set<number>();
  // barge pose
  s = 0;
  z = 0;
  h = 0;
  yaw = 0;
  private prevYaw = 0;
  speed = 0;
  // player on deck (barge-local)
  localX = 0;
  localZ = 3;
  private bob = 0;
  private sideFrom = 1;
  private sideTo = 1;
  private arriveBtn: HTMLButtonElement;
  private skipping = false;
  private crew: InstancedMesh;
  private crewAnim: InstancedBufferAttribute;

  constructor(host: BargeHost, overlay: HTMLElement) {
    this.host = host;
    const mb = new MeshBuilder();
    buildBarge(mb, 0, 0, 0, 0, BARGE_LEN, 0x5ba2e, true);
    const n = mb.vertexCount;
    const g = new BufferGeometry();
    const pos = new Float32Array(mb.pos);
    const nrm = new Float32Array(mb.nrm);
    const col = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) col[i * 4 + k] = Math.round(Math.pow(clamp(mb.col[i * 3 + k], 0, 1), 1 / 2.2) * 255);
      col[i * 4 + 3] = 255;
    }
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setAttribute('aColor', new BufferAttribute(col, 4, true));
    g.setAttribute('aSurf', new BufferAttribute(new Float32Array(mb.surf), 4));
    g.setIndex(mb.idx);
    g.computeBoundingSphere();
    this.mesh = new Mesh(g, createTownMaterial(false));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
    this.group.add(this.mesh);
    // the crew: two singers facing each other, a steersman, a passenger at the bow
    const cg = createQuinlanInstancedGeometry(createQuinlanGeometry('high'), CREW.length);
    this.crew = new InstancedMesh(cg, quinlanWorldMaterial(), CREW.length);
    this.crew.customDepthMaterial = quinlanDepthMaterial();
    this.crew.castShadow = true;
    this.crew.frustumCulled = false;
    this.crew.matrixAutoUpdate = false;
    this.crew.matrixWorldAutoUpdate = false;
    this.crew.matrixWorld.identity();
    this.crew.instanceMatrix.setUsage(DynamicDrawUsage);
    this.crewAnim = cg.getAttribute('aAnim') as InstancedBufferAttribute;
    CREW.forEach((c, i) => {
      this.crew.setColorAt(i, quinlanFurPalette(c.variant, new Color()));
      this.crewAnim.setXYZW(i, c.gait, i * 0.37, 1, c.variant);
    });
    this.group.add(this.crew);
    this.group.visible = false;
    this.arriveBtn = document.createElement('button');
    this.arriveBtn.className = 'btn arrive-now';
    this.arriveBtn.innerHTML = 'Arrive now <span class="key">Enter</span>';
    this.arriveBtn.style.cssText = 'position:absolute;right:18px;bottom:18px;display:none;pointer-events:auto';
    this.arriveBtn.onclick = () => this.arriveNow();
    overlay.appendChild(this.arriveBtn);
  }

  /** Plan the trip and put the player aboard at the origin's dock. */
  start(from: TownSite, to: TownSite, tripSeconds: number) {
    this.from = from;
    this.to = to;
    this.rv = this.host.river(from.river);
    this.dir = to.z > from.z ? 1 : -1;
    this.downstream = this.dir === this.rv.flow;
    this.sideFrom = from.side;
    this.sideTo = to.side;
    // path table along z
    const z0 = from.z;
    const z1 = to.z;
    const n = Math.max(20, Math.ceil(Math.abs(z1 - z0) / 20));
    this.path = [];
    let x = 0;
    let prevS = this.laneS(z0, 0);
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n;
      const s = this.laneS(z, i / n);
      if (i > 0) x += Math.hypot(wrapS(s - prevS), (z1 - z0) / n);
      prevS = s;
      this.path.push({ z, x });
    }
    this.length = x;
    // trip duration: longer trips use more of the budget; upstream is slower
    const km = this.length / 1000;
    this.duration = clamp(lerp(60, tripSeconds, Math.min(1, km / 60)) * (this.downstream ? 1 : 1.35), 60, 180);
    this.realSeconds = this.length / (this.downstream ? 2.6 : 1.1);
    this.planProfile();
    this.t = 0;
    this.passed.clear();
    // start forward of the singers, looking over the bow
    this.localX = -0.5;
    this.localZ = -BARGE_LEN * 0.2;
    this.active = true;
    this.skipping = false;
    this.group.visible = true;
    this.arriveBtn.style.display = 'inline-flex';
    this.updatePose(0);
    this.prevYaw = this.yaw;
    this.host.toast(this.downstream ? `Floating down the ${this.rv.name} to ${to.name}` : `Poling up the ${this.rv.name} to ${to.name} — slower going`);
    this.host.sing?.(true);
  }

  /** Lateral lane: moves from the origin's bank to mid-river and on to the destination's bank. */
  private laneS(z: number, f: number): number {
    const rv = this.rv;
    const half = rv.widthAt(z) * 0.5;
    const cStart = this.sideFrom * (half + -6) * 1; // moored just off the origin quay
    const cEnd = this.sideTo * (half - 6);
    const lane = (this.downstream ? 0.15 : 0.55) * half * (f < 0.5 ? this.sideFrom : this.sideTo);
    const a = smoothstep(0, 0.02, f);
    const b = smoothstep(0.98, 1, f);
    const off = lerp(lerp(cStart, lane, a), cEnd, b);
    return rv.channelAt(z) + off;
  }

  /** Time-compressed speed profile: glide past towns, race between them. */
  private planProfile() {
    const D = this.length;
    const T = this.duration;
    const zAt = (x: number) => this.zAtX(x);
    const xAtZ = (z: number) => {
      const f = (z - this.path[0].z) / (this.path[this.path.length - 1].z - this.path[0].z);
      const i = clamp(Math.floor(f * (this.path.length - 1)), 0, this.path.length - 2);
      const p0 = this.path[i];
      const p1 = this.path[i + 1];
      return lerp(p0.x, p1.x, clamp((z - p0.z) / (p1.z - p0.z || 1), 0, 1));
    };
    void zAt;
    // attention zones along the path
    const zones: { x0: number; x1: number; w: number }[] = [];
    zones.push({ x0: 0, x1: Math.min(D * 0.2, 120), w: 9 });
    zones.push({ x0: Math.max(D * 0.8, D - 140), x1: D, w: 10 });
    const lo = Math.min(this.from.z, this.to.z);
    const hi = Math.max(this.from.z, this.to.z);
    const passing = this.host
      .towns()
      .filter((t) => t.river === this.rv.index && t.z > lo && t.z < hi && t.id !== this.from.id && t.id !== this.to.id)
      .sort((a, b) => (a.z - b.z) * this.dir);
    const budget = T * 0.45;
    const per = Math.min(7, budget / Math.max(1, passing.length));
    for (const t of passing) {
      const xc = xAtZ(t.z);
      const r = t.kind === 'city' ? t.halfLen + 150 : t.kind === 'town' ? t.halfLen + 100 : 220;
      zones.push({ x0: Math.max(0, xc - r), x1: Math.min(D, xc + r), w: per * (t.kind === 'hamlet' ? 0.5 : t.kind === 'town' ? 1 : 1.6) });
    }
    zones.sort((a, b) => a.x0 - b.x0);
    // merge overlaps
    const merged: { x0: number; x1: number; w: number }[] = [];
    for (const z of zones) {
      const last = merged[merged.length - 1];
      if (last && z.x0 <= last.x1) {
        last.x1 = Math.max(last.x1, z.x1);
        last.w += z.w;
      } else merged.push({ ...z });
    }
    let zoneTime = merged.reduce((a, z) => a + z.w, 0);
    if (zoneTime > T * 0.85) {
      const k = (T * 0.85) / zoneTime;
      for (const z of merged) z.w *= k;
      zoneTime = T * 0.85;
    }
    const zoneLen = merged.reduce((a, z) => a + (z.x1 - z.x0), 0);
    const freeLen = Math.max(1, D - zoneLen);
    const freeTime = Math.max(1, T - zoneTime);
    // knots
    const kt: number[] = [0];
    const kx: number[] = [0];
    let tt = 0;
    let xx = 0;
    for (const z of merged) {
      if (z.x0 > xx) {
        tt += ((z.x0 - xx) / freeLen) * freeTime;
        xx = z.x0;
        kt.push(tt);
        kx.push(xx);
      }
      tt += z.w;
      xx = z.x1;
      kt.push(tt);
      kx.push(xx);
    }
    if (xx < D) {
      tt += ((D - xx) / freeLen) * freeTime;
      kt.push(tt);
      kx.push(D);
    }
    const scale = T / tt;
    this.knotsT = kt.map((v) => v * scale);
    this.knotsX = kx;
    // Fritsch-Carlson monotone tangents
    const m: number[] = [];
    const n = kt.length;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) d.push((kx[i + 1] - kx[i]) / Math.max(1e-6, this.knotsT[i + 1] - this.knotsT[i]));
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) m.push(0); // start and end at rest
      else if (d[i - 1] * d[i] <= 0) m.push(0);
      else m.push((2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]));
    }
    this.tangents = m;
  }

  private xAtT(t: number): number {
    const T = this.knotsT;
    const X = this.knotsX;
    if (t <= 0) return 0;
    if (t >= T[T.length - 1]) return X[X.length - 1];
    let i = 0;
    while (i < T.length - 2 && T[i + 1] < t) i++;
    const h = T[i + 1] - T[i];
    const u = (t - T[i]) / h;
    const h00 = 2 * u * u * u - 3 * u * u + 1;
    const h10 = u * u * u - 2 * u * u + u;
    const h01 = -2 * u * u * u + 3 * u * u;
    const h11 = u * u * u - u * u;
    return h00 * X[i] + h10 * h * this.tangents[i] + h01 * X[i + 1] + h11 * h * this.tangents[i + 1];
  }

  private zAtX(x: number): number {
    const p = this.path;
    let lo = 0;
    let hi = p.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p[mid].x < x) lo = mid;
      else hi = mid;
    }
    const a = p[lo];
    const b = p[hi];
    return lerp(a.z, b.z, clamp((x - a.x) / (b.x - a.x || 1), 0, 1));
  }

  private updatePose(dt: number) {
    const x = this.xAtT(this.t);
    const z = this.zAtX(x);
    const f = (z - this.from.z) / (this.to.z - this.from.z || 1);
    const s = this.laneS(z, clamp(f, 0, 1));
    const zA = this.zAtX(Math.min(this.length, x + 6));
    const sA = this.laneS(zA, clamp((zA - this.from.z) / (this.to.z - this.from.z || 1), 0, 1));
    const dS = wrapS(sA - s);
    const dZ = zA - z;
    // bow points along travel direction (barge model's bow is at local -z)
    const yaw = Math.atan2(-dS, -dZ);
    const prev = this.speed;
    this.speed = dt > 0 ? Math.hypot(wrapS(s - this.s), z - this.z) / dt : 0;
    if (!isFinite(this.speed) || this.speed > 5000) this.speed = prev;
    this.s = s;
    this.z = z;
    this.h = this.rv.levelAt(z);
    this.yaw = Math.abs(dS) + Math.abs(dZ) > 1e-3 ? yaw : this.yaw;
  }

  /** Deck height at a barge-local position (null when off the deck). */
  deckAt(lx: number, lz: number): number | null {
    const hw = BARGE_LEN * 0.15 + 0.15;
    const hl = BARGE_LEN * 0.45;
    if (Math.abs(lx) > hw || Math.abs(lz) > hl) return null;
    return this.h + 0.55;
  }

  /** Called each frame while riding. Returns the player's world pose. */
  update(dt: number, inp: InputFrame, playerYaw: number): { s: number; z: number; h: number; yawDelta: number; overboard: boolean } {
    if (this.skipping) dt = 0;
    this.t += dt;
    this.updatePose(dt);
    this.bob += dt;
    // compressed time of day
    this.host.addTime((this.realSeconds / 86400) * (dt / this.duration));
    // LOD budget by speed
    this.host.setMaxLevel(this.speed > 400 ? 6 : this.speed > 120 ? 7 : this.speed > 30 ? 8 : 9);
    // prefetch towns ahead, captions for towns passing by
    for (const t of this.host.towns()) {
      if (t.river !== this.rv.index) continue;
      const ahead = (t.z - this.z) * this.dir;
      if (ahead > -2000 && ahead < 14000) this.host.requestTown(t.id);
      if (Math.abs(t.z - this.z) < (t.kind === 'hamlet' ? 250 : t.halfLen) && !this.passed.has(t.id) && t.id !== this.from.id) {
        this.passed.add(t.id);
        this.host.heard(t);
        if (t.id !== this.to.id) this.host.caption(t.name, `${t.kind === 'city' ? 'river city' : t.kind} · ${t.side === 1 ? 'spinward' : 'antispin'} bank`);
      }
    }
    // walk the deck (barge-local)
    const rel = playerYaw - this.yaw;
    const fX = -Math.sin(rel);
    const fZ = -Math.cos(rel);
    const sp = inp.quad ? 3.2 : 1.6;
    const nx = this.localX + (fX * inp.moveY - fZ * inp.moveX) * sp * dt;
    const nz = this.localZ + (fZ * inp.moveY + fX * inp.moveX) * sp * dt;
    const hw = BARGE_LEN * 0.15 + 0.1;
    const hl = BARGE_LEN * 0.44;
    let overboard = false;
    // the stern deckhouse blocks the rear of the deck
    const inHouse = (x: number, z: number) => Math.abs(x) < hw * 0.8 && z > hl * 0.5 && z < hl;
    if (!inHouse(nx, nz)) {
      this.localX = nx;
      this.localZ = nz;
    }
    if (Math.abs(this.localX) > hw || Math.abs(this.localZ) > hl) overboard = true;
    if (inp.jumpPressed && Math.abs(this.localX) > hw * 0.75) overboard = true;
    // world pose of the player
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    const wx = this.localX * c + this.localZ * sn;
    const wz = -this.localX * sn + this.localZ * c;
    const yawDelta = mod(this.yaw - this.prevYaw + Math.PI, Math.PI * 2) - Math.PI;
    this.prevYaw = this.yaw;
    // barge matrix
    const m = frame.rigidMatrix(this.s, this.z, this.h + Math.sin(this.bob * 1.3) * 0.04, this.yaw, _m);
    const roll = Math.sin(this.bob * 0.9) * 0.012;
    _r.makeRotationZ(roll);
    this.mesh.matrixWorld.copy(m).multiply(_r);
    this.mesh.matrixWorldNeedsUpdate = false;
    this.placeCrew(this.h + 0.55 + Math.sin(this.bob * 1.3) * 0.04);
    if (this.t >= this.duration) this.finish(true);
    return { s: this.s + wx, z: this.z + wz, h: this.h + 0.55, yawDelta, overboard };
  }

  private async arriveNow() {
    if (!this.active || this.skipping) return;
    this.skipping = true;
    this.host.fade(1);
    // advance the day by the remaining compressed time
    const rem = Math.max(0, this.duration - this.t);
    this.host.addTime((this.realSeconds / 86400) * (rem / this.duration));
    await new Promise((r) => setTimeout(r, 600));
    this.t = this.duration - 0.001;
    this.updatePose(0);
    this.skipping = false;
    this.finish(true);
    setTimeout(() => this.host.fade(0), 400);
  }

  skip() {
    this.arriveNow();
  }

  finish(completed: boolean) {
    if (!this.active) return;
    this.active = false;
    this.arriveBtn.style.display = 'none';
    this.host.setMaxLevel(9);
    this.host.sing?.(false);
    this.host.onFinish(this.to, completed);
    // leave the barge moored at the destination for a while
    setTimeout(() => {
      if (!this.active) this.group.visible = false;
    }, 60_000);
  }

  /** Keep the moored barge placed correctly after frame rebases. */
  refresh() {
    if (!this.group.visible || this.active) return;
    const m = frame.rigidMatrix(this.s, this.z, this.h, this.yaw, _m);
    this.mesh.matrixWorld.copy(m);
    this.placeCrew(this.h + 0.55);
  }

  /** Crew poses in world space (bent Quinlan instances anchored at the frame origin). */
  private placeCrew(deck: number) {
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    const poling = this.active && !this.downstream;
    CREW.forEach((m, i) => {
      let lx = m.x;
      let lz = m.z;
      let gait: number = m.gait;
      if (poling && i === 2) {
        // upstream: the steersman walks the side deck, poling
        const ph = (this.bob * 0.12) % 1;
        const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
        lx = BARGE_LEN * 0.15 - 0.35;
        lz = -BARGE_LEN * 0.3 + tri * BARGE_LEN * 0.5;
        gait = QUINLAN_GAIT.walk;
      }
      const wx = lx * c + lz * sn;
      const wz = -lx * sn + lz * c;
      _q.setFromAxisAngle(_up, this.yaw + m.yaw + (poling && i === 2 ? (((this.bob * 0.12) % 1) < 0.5 ? Math.PI : 0) : 0));
      _p.set(wrapS(this.s + wx - frame.originS), deck, this.z + wz - frame.originZ);
      _mc.compose(_p, _q, _one);
      this.crew.setMatrixAt(i, _mc);
      this.crewAnim.setX(i, gait);
    });
    this.crew.instanceMatrix.needsUpdate = true;
    this.crewAnim.needsUpdate = true;
  }

  get progress() {
    return clamp(this.t / this.duration, 0, 1);
  }

  get damping() {
    return damp;
  }
}

const _m = new Matrix4();
const _r = new Matrix4();
const _mc = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _one = new Vector3(1, 1, 1);
const _up = new Vector3(0, 1, 0);

/** Crew stations in barge-local metres (bow at -z); yaw relative to the barge. */
const CREW: { x: number; z: number; yaw: number; gait: number; variant: number }[] = [
  { x: -1.15, z: 1.3, yaw: -Math.PI / 2, gait: QUINLAN_GAIT.sing, variant: 311 },
  { x: 1.15, z: 1.0, yaw: Math.PI / 2, gait: QUINLAN_GAIT.sing, variant: 5120 },
  { x: 0.2, z: BARGE_LEN * 0.22, yaw: 0, gait: QUINLAN_GAIT.idle, variant: 77 },
  { x: 1.1, z: -BARGE_LEN * 0.38, yaw: -Math.PI / 2, gait: QUINLAN_GAIT.idle, variant: 9021 },
];
