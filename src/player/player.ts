// The Quinlan controller. State lives in cylinder coordinates (s, z, h) as
// doubles; the unrolled (s, z) plane is intrinsically flat, so walking with a
// constant heading traces a geodesic (a helix) around the cylinder.

import { CIRC, OMEGA, PLAYER, gravityAt } from '../config';
import { clamp, damp, lerp, mod } from '../core/math';
import type { InputFrame } from './input';
import type { WorldQuery } from '../world/worldQuery';
import { newSample } from '../world/gen/world';

export type MoveMode = 'walk' | 'swim' | 'dive' | 'fly' | 'ride';

export interface PlayerEvents {
  onSplash?: (speed: number) => void;
  onSurface?: () => void;
  onDive?: () => void;
  onLand?: (speed: number) => void;
  onStep?: (quad: boolean) => void;
}

export class Player {
  s = 0;
  z = 0;
  h = 0; // feet height
  vs = 0;
  vz = 0;
  vh = 0;
  yaw = 0; // 0 looks toward -z
  pitch = 0;
  mode: MoveMode = 'walk';
  quad = false;
  onGround = false;
  eyeHeight = PLAYER.eyeStand;
  breath = PLAYER.breath;
  waterLevel = -1e9;
  groundH = 0;
  flowS = 0;
  flowZ = 0;
  coriolis = false;
  noclipSpeed = 60;
  events: PlayerEvents = {};
  /** Extra camera dip after a splash (m). */
  dip = 0;
  private burstT = 0;
  private burstCD = 0;
  private stepPhase = 0;
  bob = 0;
  speed = 0;
  private sample = newSample();
  /** Optional moving platform (barge deck): ground override. */
  platform: { floor: (s: number, z: number) => number | null; vs: number; vz: number } | null = null;

  get eyeH(): number {
    return this.h + this.eyeHeight + this.bob - this.dip;
  }

  /** Forward unit vector in (s, z) for the current yaw. */
  forward(): [number, number] {
    return [-Math.sin(this.yaw), -Math.cos(this.yaw)];
  }

  teleport(s: number, z: number, world: WorldQuery, yaw = this.yaw) {
    this.s = mod(s, CIRC);
    this.z = z;
    this.yaw = yaw;
    this.groundH = world.groundHeight(this.s, this.z);
    const w = world.sampleAt(this.s, this.z, this.sample);
    this.waterLevel = w.water;
    this.h = Math.max(this.groundH, w.water > this.groundH ? w.water - 0.6 : this.groundH);
    this.vs = this.vz = this.vh = 0;
    this.mode = w.water > this.groundH + 0.9 ? 'swim' : 'walk';
  }

  update(dt: number, inp: InputFrame, world: WorldQuery) {
    dt = Math.min(dt, 0.05);
    this.yaw -= inp.lookX;
    this.pitch = clamp(this.pitch - inp.lookY, -1.52, 1.52);
    if (this.mode === 'fly') return this.fly(dt, inp, world);
    if (this.mode === 'ride') return;

    const g = gravityAt(this.h);
    const [fs, fz] = this.forward();
    const rs = -fz; // right vector (s, z) = (cos yaw, -sin yaw)
    const rz = fs;
    let ws = fs * inp.moveY + rs * inp.moveX;
    let wz = fz * inp.moveY + rz * inp.moveX;

    // environment under the player
    this.groundH = world.groundHeight(this.s, this.z);
    let floor = this.groundH;
    if (this.platform) {
      const pf = this.platform.floor(this.s, this.z);
      if (pf !== null) floor = Math.max(floor, pf);
    }
    const w = world.sampleAt(this.s, this.z, this.sample);
    this.waterLevel = w.water;
    this.flowS = w.flowS;
    this.flowZ = w.flowZ;
    const depthHere = w.water - floor;

    // ---- mode transitions
    if (this.mode === 'walk') {
      if (depthHere > 0.95 && this.h < w.water - 0.5) {
        this.mode = 'swim';
        this.events.onSplash?.(Math.hypot(this.vs, this.vz, this.vh));
        this.dip = 0.35;
      }
    } else if (depthHere < 0.75 && this.h <= floor + 0.3) {
      this.mode = 'walk';
    }

    if (this.mode === 'walk') {
      this.quad = inp.quad;
      const speed = this.quad ? PLAYER.quadRun : inp.walkSlow ? PLAYER.walk : PLAYER.run;
      ws *= speed;
      wz *= speed;
      const accel = this.onGround ? 14 : 2.2;
      const baseS = this.platform && this.onGround ? this.platform.vs : 0;
      const baseZ = this.platform && this.onGround ? this.platform.vz : 0;
      this.vs = damp(this.vs, ws + baseS, accel, dt);
      this.vz = damp(this.vz, wz + baseZ, accel, dt);
      // wading slows you down
      if (depthHere > 0.2) {
        const drag = clamp(depthHere / 1.0, 0, 1) * 0.55;
        this.vs *= 1 - drag * dt * 6;
        this.vz *= 1 - drag * dt * 6;
      }
      this.vh -= g * dt;
      if (this.onGround && inp.jumpPressed) {
        this.vh = Math.sqrt(2 * g * PLAYER.jumpHeight) * (this.quad ? 1.15 : 1);
        this.onGround = false;
      }
      this.integrate(dt, world);
      const newFloor = this.floorAt(world);
      if (this.h <= newFloor) {
        if (!this.onGround && this.vh < -3.5) this.events.onLand?.(-this.vh);
        this.h = newFloor;
        this.vh = 0;
        this.onGround = true;
        // steep slopes: slide
        const n = world.groundNormal(this.s, this.z, _n);
        if (n.y < PLAYER.maxSlope && !this.platform) {
          this.vs += n.x * g * dt * 1.6;
          this.vz += n.z * g * dt * 1.6;
        }
      } else if (this.h > newFloor + 0.25) {
        this.onGround = false;
      } else if (this.onGround) {
        this.h = newFloor; // stick to the ground when walking downhill
      }
      const targetEye = this.quad ? PLAYER.eyeQuad : PLAYER.eyeStand;
      this.eyeHeight = damp(this.eyeHeight, targetEye, 10, dt);
      // head bob & footsteps
      const sp = Math.hypot(this.vs - baseS, this.vz - baseZ);
      this.speed = sp;
      if (this.onGround && sp > 0.3) {
        const freq = this.quad ? 3.2 : 2.1;
        const prev = this.stepPhase;
        this.stepPhase += dt * freq * (0.6 + sp * 0.12);
        if (Math.floor(prev * 2) !== Math.floor(this.stepPhase * 2)) this.events.onStep?.(this.quad);
        this.bob = Math.sin(this.stepPhase * Math.PI * 2) * (this.quad ? 0.025 : 0.035) * clamp(sp / 3, 0, 1);
      } else {
        this.bob = damp(this.bob, 0, 8, dt);
      }
      this.breath = Math.min(PLAYER.breath, this.breath + dt * 8);
    } else {
      this.swim(dt, inp, world, w.water, floor);
    }
    this.dip = damp(this.dip, 0, 3, dt);
  }

  private floorAt(world: WorldQuery): number {
    let f = world.groundHeight(this.s, this.z);
    if (this.platform) {
      const pf = this.platform.floor(this.s, this.z);
      if (pf !== null && pf > f && this.h > pf - 0.6) f = pf;
    }
    return f;
  }

  private integrate(dt: number, world: WorldQuery) {
    if (this.coriolis) {
      // rotating-frame Coriolis: a_s = +2ω v_h, a_h = -2ω v_s
      this.vs += 2 * OMEGA * this.vh * dt;
      this.vh -= 2 * OMEGA * this.vs * dt;
    }
    let ns = this.s + this.vs * dt;
    let nz = this.z + this.vz * dt;
    // structures
    if (world.colliders.length) {
      const out = _col;
      for (const c of world.colliders) {
        out.s = ns;
        out.z = nz;
        out.floor = -1e9;
        c.resolve(ns, nz, this.h, PLAYER.radius, out);
        ns = out.s;
        nz = out.z;
      }
    }
    this.s = mod(ns, CIRC);
    this.z = nz;
    this.h += this.vh * dt;
  }

  private swim(dt: number, inp: InputFrame, world: WorldQuery, level: number, floor: number) {
    const [fs, fz] = this.forward();
    const rs = -fz;
    const rz = fs;
    this.quad = false;
    const under = this.mode === 'dive';
    this.burstCD -= dt;
    if (inp.burst && this.burstCD <= 0 && (inp.moveY !== 0 || inp.moveX !== 0)) {
      this.burstT = 0.55;
      this.burstCD = 1.3;
    }
    this.burstT = Math.max(0, this.burstT - dt);
    const burst = this.burstT > 0 ? PLAYER.tailBurst : 0;
    if (!under) {
      const sp = Math.max(PLAYER.swimSurface, burst * 0.7);
      const ws = (fs * inp.moveY + rs * inp.moveX) * sp;
      const wz = (fz * inp.moveY + rz * inp.moveX) * sp;
      this.vs = damp(this.vs, ws + this.flowS, 4, dt);
      this.vz = damp(this.vz, wz + this.flowZ, 4, dt);
      // float with the head above water
      const target = level - 0.62;
      this.vh = damp(this.vh, (target - this.h) * 4, 6, dt);
      if (inp.dive || (this.pitch < -0.6 && inp.moveY > 0.5)) {
        this.mode = 'dive';
        this.vh = -2.5;
        this.events.onDive?.();
      }
      if (inp.jumpPressed) this.vh = 3.4; // hop out / porpoise
      this.breath = Math.min(PLAYER.breath, this.breath + dt * 12);
      this.eyeHeight = damp(this.eyeHeight, 0.85, 6, dt);
    } else {
      // 3D swimming along the look direction
      const cp = Math.cos(this.pitch);
      const sp = Math.max(PLAYER.swimUnder, burst);
      const dirS = fs * cp;
      const dirZ = fz * cp;
      const dirH = Math.sin(this.pitch);
      let ws = (dirS * inp.moveY + rs * inp.moveX) * sp;
      let wz = (dirZ * inp.moveY + rz * inp.moveX) * sp;
      let wh = dirH * inp.moveY * sp;
      if (inp.jump) wh += 2.5;
      if (inp.dive) wh -= 2.5;
      ws += this.flowS * 0.8;
      wz += this.flowZ * 0.8;
      // slight buoyancy
      wh += 0.25;
      this.vs = damp(this.vs, ws, 3, dt);
      this.vz = damp(this.vz, wz, 3, dt);
      this.vh = damp(this.vh, wh, 3, dt);
      this.breath -= dt;
      if (this.breath <= 0) {
        this.breath = 0;
        this.vh = Math.max(this.vh, 3); // lungs burning: forced up
      }
      this.eyeHeight = damp(this.eyeHeight, 0.4, 6, dt);
      if (this.h + this.eyeHeight > level + 0.05 && this.vh > 0) {
        this.mode = 'swim';
        this.events.onSurface?.();
      }
    }
    this.integrate(dt, world);
    const f = Math.max(floor, world.groundHeight(this.s, this.z));
    if (this.h < f) {
      this.h = f;
      this.vh = Math.max(this.vh, 0);
    }
    this.speed = Math.hypot(this.vs - this.flowS, this.vz - this.flowZ);
    this.onGround = false;
    this.bob = Math.sin(performance.now() * 0.0021) * 0.03 * (under ? 0.3 : 1);
  }

  private fly(dt: number, inp: InputFrame, world: WorldQuery) {
    const [fs, fz] = this.forward();
    const rs = -fz;
    const rz = fs;
    const cp = Math.cos(this.pitch);
    const sp = this.noclipSpeed * (inp.quad ? 8 : 1);
    this.vs = (fs * cp * inp.moveY + rs * inp.moveX) * sp;
    this.vz = (fz * cp * inp.moveY + rz * inp.moveX) * sp;
    this.vh = (Math.sin(this.pitch) * inp.moveY + (inp.jump ? 1 : 0) - (inp.dive ? 1 : 0)) * sp;
    this.s = mod(this.s + this.vs * dt, CIRC);
    this.z += this.vz * dt;
    this.h = Math.max(this.h + this.vh * dt, world.groundHeight(this.s, this.z) + 0.3 - this.eyeHeight);
    this.speed = Math.hypot(this.vs, this.vz, this.vh);
  }

  /** Heading in degrees (0 = toward +z / "axial ahead"). */
  headingDeg(): number {
    return mod((-this.yaw * 180) / Math.PI + 180, 360);
  }

  underwaterAmount(): number {
    const eye = this.eyeH;
    return eye < this.waterLevel ? clamp((this.waterLevel - eye) * 4, 0, 1) : 0;
  }

  lerpTo(s: number, z: number, h: number, t: number) {
    this.s = lerp(this.s, s, t);
    this.z = lerp(this.z, z, t);
    this.h = lerp(this.h, h, t);
  }
}

const _n = { x: 0, y: 1, z: 0 };
const _col = { s: 0, z: 0, floor: -1e9 };
