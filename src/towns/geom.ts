// 2D geometry for town layouts, in the town frame (a, c): oriented building
// footprints, footpaths as polylines, curve smoothing and a spatial hash.

export type P2 = [number, number];

/**
 * Oriented rectangle: centre, half width along its local x (frontage), half
 * depth along its local z, rotation about up. Same convention as
 * MeshBuilder.frame: local x -> (cos r, sin r), local z -> (-sin r, cos r).
 */
export interface OBB {
  a: number;
  c: number;
  hw: number;
  hd: number;
  rot: number;
}

export function obbCorners(o: OBB): P2[] {
  const cr = Math.cos(o.rot);
  const sr = Math.sin(o.rot);
  const out: P2[] = [];
  for (const [x, z] of [
    [-o.hw, -o.hd],
    [o.hw, -o.hd],
    [o.hw, o.hd],
    [-o.hw, o.hd],
  ]) {
    out.push([o.a + x * cr - z * sr, o.c + x * sr + z * cr]);
  }
  return out;
}

/** Bounding radius of a footprint. */
export const obbRadius = (o: OBB) => Math.hypot(o.hw, o.hd);

/** Separating-axis test; `pad` grows both rectangles. */
export function obbOverlap(p: OBB, q: OBB, pad = 0): boolean {
  if (Math.hypot(p.a - q.a, p.c - q.c) > obbRadius(p) + obbRadius(q) + 2 * pad) return false;
  const P = obbCorners({ ...p, hw: p.hw + pad, hd: p.hd + pad });
  const Q = obbCorners({ ...q, hw: q.hw + pad, hd: q.hd + pad });
  for (const o of [p, q]) {
    for (const ang of [o.rot, o.rot + Math.PI / 2]) {
      const ax = Math.cos(ang);
      const az = Math.sin(ang);
      let pMin = Infinity, pMax = -Infinity, qMin = Infinity, qMax = -Infinity;
      for (const v of P) {
        const d = v[0] * ax + v[1] * az;
        pMin = Math.min(pMin, d);
        pMax = Math.max(pMax, d);
      }
      for (const v of Q) {
        const d = v[0] * ax + v[1] * az;
        qMin = Math.min(qMin, d);
        qMax = Math.max(qMax, d);
      }
      if (pMax < qMin || qMax < pMin) return false;
    }
  }
  return true;
}

export function pointSegDist(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
}

/** Do segments p0-p1 and q0-q1 cross? Returns the parameter along p, or -1. */
export function segCross(p0: P2, p1: P2, q0: P2, q1: P2): number {
  const rx = p1[0] - p0[0], rz = p1[1] - p0[1];
  const sx = q1[0] - q0[0], sz = q1[1] - q0[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((q0[0] - p0[0]) * sz - (q0[1] - p0[1]) * sx) / den;
  const u = ((q0[0] - p0[0]) * rz - (q0[1] - p0[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Distance from a segment to an oriented rectangle (0 if they touch). */
export function segObbDist(p0: P2, p1: P2, o: OBB): number {
  // into the rectangle's frame
  const cr = Math.cos(o.rot), sr = Math.sin(o.rot);
  const loc = (p: P2): P2 => {
    const da = p[0] - o.a, dc = p[1] - o.c;
    return [da * cr + dc * sr, -da * sr + dc * cr];
  };
  const a = loc(p0), b = loc(p1);
  const inside = (p: P2) => Math.abs(p[0]) <= o.hw && Math.abs(p[1]) <= o.hd;
  if (inside(a) || inside(b)) return 0;
  const R: P2[] = [
    [-o.hw, -o.hd],
    [o.hw, -o.hd],
    [o.hw, o.hd],
    [-o.hw, o.hd],
  ];
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const r0 = R[i], r1 = R[(i + 1) % 4];
    if (segCross(a, b, r0, r1) >= 0) return 0;
    d = Math.min(d, pointSegDist(r0, a, b), pointSegDist(a, r0, r1), pointSegDist(b, r0, r1));
  }
  return d;
}

/** Catmull-Rom through the points, `n` samples per span. */
export function smooth(pts: P2[], n = 6): P2[] {
  if (pts.length < 3) return pts.slice();
  const out: P2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function polyLength(pts: P2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** Points spaced about `step` apart along a polyline (ends included). */
export function resample(pts: P2[], step: number): P2[] {
  if (pts.length < 2) return pts.slice();
  const out: P2[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t < seg) {
      out.push([a[0] + ((b[0] - a[0]) * t) / seg, a[1] + ((b[1] - a[1]) * t) / seg]);
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > step * 0.35) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Uniform grid of items with bounding circles, for neighbourhood queries. */
export class Hash2<T> {
  private cells = new Map<number, { v: T; q: number }[]>();
  private stamp = 0;
  constructor(private cell: number) {}
  private key(i: number, j: number) {
    return (i + 32768) * 65536 + (j + 32768);
  }
  add(item: T, a: number, c: number, r: number) {
    const s = this.cell;
    const e = { v: item, q: 0 };
    for (let i = Math.floor((a - r) / s); i <= Math.floor((a + r) / s); i++)
      for (let j = Math.floor((c - r) / s); j <= Math.floor((c + r) / s); j++) {
        const k = this.key(i, j);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(e);
      }
  }
  /** Items whose cells touch the circle (may repeat; dedupe if it matters). */
  near(a: number, c: number, r: number): T[] {
    const out: T[] = [];
    this.each(a, c, r, (v) => {
      out.push(v);
    });
    return out;
  }
  /** Visit each item whose cells touch the circle once; stop when `fn` returns true. */
  each(a: number, c: number, r: number, fn: (item: T) => boolean | void): boolean {
    const s = this.cell;
    const q = ++this.stamp;
    for (let i = Math.floor((a - r) / s); i <= Math.floor((a + r) / s); i++)
      for (let j = Math.floor((c - r) / s); j <= Math.floor((c + r) / s); j++) {
        const l = this.cells.get(this.key(i, j));
        if (!l) continue;
        for (const e of l) {
          if (e.q === q) continue;
          e.q = q;
          if (fn(e.v)) return true;
        }
      }
    return false;
  }
}
