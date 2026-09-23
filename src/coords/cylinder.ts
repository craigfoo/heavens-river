// Cylinder coordinates and the floating-origin render frame.
//
// Every surface point is (s, z, h): arc distance around the circumference,
// axial distance along the section, and height above the base shell toward
// the axis. World (inertial) space has the axis along Z:
//   θ = s / R, r = R - h, pos = (r cos θ, r sin θ, z), up = toward the axis.
//
// Rendering never uses absolute world positions. Instead a "render frame" is
// anchored at an origin point (s0, z0, h = 0) on the base shell:
//   +X = spinward (+s) tangent, +Y = local up (toward the axis), +Z = +z.
// A point at (s, z, h) with Δs = wrap(s - s0), Δz = z - z0, θ = Δs / R maps to
//   x = (R - h) sin θ
//   y = h + (R - h) · 2 sin²(θ/2)      (cancellation-free form of R - (R-h)cos θ)
//   z = Δz
// The frame is rebased when the camera strays too far, so every coordinate
// near the camera stays small and float32 has sub-millimetre precision.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { CIRC, R } from '../config';
import { mod } from '../core/math';

/** Wrap an arc-length difference into [-CIRC/2, CIRC/2). */
export function wrapS(ds: number): number {
  return mod(ds + CIRC / 2, CIRC) - CIRC / 2;
}

export function normS(s: number): number {
  return mod(s, CIRC);
}

/** Bend an anchor-local unrolled point (ds, h, dz) into the anchor's tangent frame. */
export function bendLocal(ds: number, h: number, dz: number, out: Vector3): Vector3 {
  const th = ds / R;
  const r = R - h;
  const sh = Math.sin(0.5 * th);
  return out.set(r * Math.sin(th), h + r * 2 * sh * sh, dz);
}

export interface CylPoint {
  s: number;
  z: number;
  h: number;
}

const _q = new Quaternion();
const _axisZ = new Vector3(0, 0, 1);

export class RenderFrame {
  originS = 0;
  originZ = 0;
  /** Incremented at every rebase; anchored objects compare against it. */
  version = 0;
  rebaseDistance = 1500;

  private anchored = new Map<object, { s: number; z: number; obj: { matrixWorld: Matrix4 } & AnchoredLike }>();

  /** Unrolled offsets from the frame origin. */
  delta(s: number, z: number): { ds: number; dz: number } {
    return { ds: wrapS(s - this.originS), dz: z - this.originZ };
  }

  /** Position of (s, z, h) in the render frame. */
  toRender(s: number, z: number, h: number, out: Vector3): Vector3 {
    return bendLocal(wrapS(s - this.originS), h, z - this.originZ, out);
  }

  /** Render frame point back to cylinder coordinates. */
  fromRender(p: Vector3, out: CylPoint = { s: 0, z: 0, h: 0 }): CylPoint {
    const qx = p.x;
    const qy = p.y - R;
    const r = Math.hypot(qx, qy);
    const th = Math.atan2(qy, qx) + Math.PI / 2;
    const thw = mod(th + Math.PI, Math.PI * 2) - Math.PI;
    out.h = R - r;
    out.s = normS(this.originS + thw * R);
    out.z = this.originZ + p.z;
    return out;
  }

  /** Angle of the local frame at s relative to the frame origin. */
  thetaAt(s: number): number {
    return wrapS(s - this.originS) / R;
  }

  /**
   * Matrix mapping an anchor's local frame (anchor on the base shell at (s, z))
   * into the render frame: translate to the bent anchor point, rotate about Z.
   */
  anchorMatrix(s: number, z: number, out: Matrix4): Matrix4 {
    const ds = wrapS(s - this.originS);
    const th = ds / R;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const sh = Math.sin(0.5 * th);
    const px = R * sn;
    const py = R * 2 * sh * sh;
    const pz = z - this.originZ;
    return out.set(c, -sn, 0, px, sn, c, 0, py, 0, 0, 1, pz, 0, 0, 0, 1);
  }

  /**
   * Rigid local frame at (s, z, h) with a heading (yaw about local up) —
   * for small objects that do not need per-vertex bending.
   */
  rigidMatrix(s: number, z: number, h: number, yaw: number, out: Matrix4, scale = 1): Matrix4 {
    const th = this.thetaAt(s);
    const p = this.toRender(s, z, h, _v);
    _q.setFromAxisAngle(_axisZ, th);
    _q2.setFromAxisAngle(_up, yaw);
    _q.multiply(_q2);
    _s.set(scale, scale, scale);
    return out.compose(p, _q, _s);
  }

  /** Local up direction at s in the render frame. */
  upAt(s: number, out: Vector3): Vector3 {
    const th = this.thetaAt(s);
    return out.set(-Math.sin(th), Math.cos(th), 0);
  }

  /** Rebase when the camera drifts; returns true if the frame moved. */
  maybeRebase(camS: number, camZ: number, force = false): boolean {
    const ds = wrapS(camS - this.originS);
    const dz = camZ - this.originZ;
    if (!force && Math.abs(ds) < this.rebaseDistance && Math.abs(dz) < this.rebaseDistance) return false;
    this.originS = normS(camS);
    this.originZ = camZ;
    this.version++;
    for (const a of this.anchored.values()) {
      this.anchorMatrix(a.s, a.z, a.obj.matrixWorld);
      a.obj.matrixWorldNeedsUpdate = false;
    }
    return true;
  }

  /** Register a bent-geometry object anchored at (s, z); keeps its matrix current. */
  register(obj: { matrixWorld: Matrix4 } & AnchoredLike, s: number, z: number): void {
    obj.matrixAutoUpdate = false;
    obj.matrixWorldAutoUpdate = false;
    this.anchorMatrix(s, z, obj.matrixWorld);
    this.anchored.set(obj, { s, z, obj });
  }

  unregister(obj: object): void {
    this.anchored.delete(obj);
  }

  get anchoredCount(): number {
    return this.anchored.size;
  }
}

interface AnchoredLike {
  matrixAutoUpdate: boolean;
  matrixWorldAutoUpdate: boolean;
  matrixWorldNeedsUpdate: boolean;
}

const _v = new Vector3();
const _q2 = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _s = new Vector3();

/** Shared singleton frame. */
export const frame = new RenderFrame();
