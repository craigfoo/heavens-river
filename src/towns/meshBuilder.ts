// Growable mesh builder working in the town frame (a, h, c). Every vertex
// carries a surface type and surface-space (u, v) metres so the town shader
// can draw masonry, timber framing, tiles, thatch, murals... procedurally.

export const SURF = {
  plain: 0,
  stone: 1,
  plaster: 2,
  timber: 3,
  thatch: 4,
  tile: 5,
  shingle: 6,
  slate: 7,
  wood: 8,
  mural: 9,
  turf: 10,
  gold: 11,
  cobble: 12,
  mosaic: 13,
  cloth: 14,
  dark: 15,
  water: 16,
  statue: 17,
  halftimber: 18,
  bronze: 19,
  flags: 20,
} as const;

export type V3 = [number, number, number];

export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  surf: number[] = [];
  idx: number[] = [];
  // current local transform: origin + rotation about up
  private ox = 0;
  private oh = 0;
  private oc = 0;
  private cr = 1;
  private sr = 0;

  get vertexCount() {
    return this.pos.length / 3;
  }

  /** Set the local frame: origin (a, h, c) and rotation about up. */
  frame(a: number, h: number, c: number, rot: number) {
    this.ox = a;
    this.oh = h;
    this.oc = c;
    this.cr = Math.cos(rot);
    this.sr = Math.sin(rot);
  }

  resetFrame() {
    this.frame(0, 0, 0, 0);
  }

  /** Local (x, y, z) -> town frame (a, h, c). */
  private tx(x: number, y: number, z: number, out: V3): V3 {
    out[0] = this.ox + x * this.cr - z * this.sr;
    out[1] = this.oh + y;
    out[2] = this.oc + x * this.sr + z * this.cr;
    return out;
  }

  private tn(x: number, y: number, z: number, out: V3): V3 {
    out[0] = x * this.cr - z * this.sr;
    out[1] = y;
    out[2] = x * this.sr + z * this.cr;
    return out;
  }

  vertex(p: V3, n: V3, rgb: V3, surf: number, u: number, v: number, param: number): number {
    this.tx(p[0], p[1], p[2], _p);
    this.tn(n[0], n[1], n[2], _n);
    this.pos.push(_p[0], _p[1], _p[2]);
    this.nrm.push(_n[0], _n[1], _n[2]);
    this.col.push(rgb[0], rgb[1], rgb[2]);
    this.surf.push(surf, u, v, param);
    return this.pos.length / 3 - 1;
  }

  /**
   * Quad p0 p1 p2 p3, counter-clockwise seen from the front (normal = (p1-p0) x (p3-p0)).
   * UV in metres along p0->p1 and p0->p3.
   */
  quad(p0: V3, p1: V3, p2: V3, p3: V3, rgb: V3, surf: number, param = 0, uv?: [number, number, number, number]) {
    const e1 = sub(p1, p0);
    const e2 = sub(p3, p0);
    const n = norm(cross(e1, e2));
    if (uv) {
      const [u0, v0, u1, v1] = uv;
      const a = this.vertex(p0, n, rgb, surf, u0, v0, param);
      const b = this.vertex(p1, n, rgb, surf, u1, v0, param);
      const c = this.vertex(p2, n, rgb, surf, u1, v1, param);
      const d = this.vertex(p3, n, rgb, surf, u0, v1, param);
      this.idx.push(a, b, c, a, c, d);
      return;
    }
    // planar projection onto the face (keeps patterns straight on trapezoids)
    const ua = norm(e1);
    const va = norm(cross(n, ua));
    const proj = (p: V3): [number, number] => {
      const d = sub(p, p0);
      return [dot(d, ua), dot(d, va)];
    };
    const q = [proj(p0), proj(p1), proj(p2), proj(p3)];
    const a = this.vertex(p0, n, rgb, surf, q[0][0], q[0][1], param);
    const b = this.vertex(p1, n, rgb, surf, q[1][0], q[1][1], param);
    const c = this.vertex(p2, n, rgb, surf, q[2][0], q[2][1], param);
    const d = this.vertex(p3, n, rgb, surf, q[3][0], q[3][1], param);
    this.idx.push(a, b, c, a, c, d);
  }

  tri(p0: V3, p1: V3, p2: V3, rgb: V3, surf: number, param = 0) {
    const e1 = sub(p1, p0);
    const e2 = sub(p2, p0);
    const n = norm(cross(e1, e2));
    const lu = len(e1);
    const t = dot(e2, e1) / Math.max(lu, 1e-6);
    const hgt = len(sub(e2, scale(e1, t / Math.max(lu, 1e-6))));
    const a = this.vertex(p0, n, rgb, surf, 0, 0, param);
    const b = this.vertex(p1, n, rgb, surf, lu, 0, param);
    const c = this.vertex(p2, n, rgb, surf, t, hgt, param);
    this.idx.push(a, b, c);
  }

  /** Axis-aligned box in the local frame; faces: +x -x +y -y +z -z (bottom skipped by default). */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    rgb: V3,
    surfSides: number,
    surfTop = surfSides,
    param = 0,
    bottom = false,
    rgbTop: V3 = rgb,
  ) {
    // front (-z)
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], rgb, surfSides, param);
    // back (+z)
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], rgb, surfSides, param);
    // left (-x)
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], rgb, surfSides, param);
    // right (+x)
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], rgb, surfSides, param);
    // top
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], rgbTop, surfTop, param);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], rgb, surfSides, param);
  }

  /** Vertical cylinder / cone frustum around (x, z). */
  cylinder(x: number, z: number, y0: number, y1: number, r0: number, r1: number, seg: number, rgb: V3, surf: number, param = 0, cap = true) {
    const circ = 2 * Math.PI * Math.max(r0, r1);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const n0: V3 = [c0, (r0 - r1) / Math.max(y1 - y0, 1e-3), s0];
      const n1: V3 = [c1, (r0 - r1) / Math.max(y1 - y0, 1e-3), s1];
      const u0 = (i / seg) * circ;
      const u1 = ((i + 1) / seg) * circ;
      const A = this.vertex([x + c0 * r0, y0, z + s0 * r0], norm(n0), rgb, surf, u0, 0, param);
      const B = this.vertex([x + c1 * r0, y0, z + s1 * r0], norm(n1), rgb, surf, u1, 0, param);
      const C = this.vertex([x + c1 * r1, y1, z + s1 * r1], norm(n1), rgb, surf, u1, y1 - y0, param);
      const D = this.vertex([x + c0 * r1, y1, z + s0 * r1], norm(n0), rgb, surf, u0, y1 - y0, param);
      this.idx.push(A, C, B, A, D, C);
      if (cap && r1 > 0.001) {
        const ctr = this.vertex([x, y1, z], [0, 1, 0], rgb, surf, 0, 0, param);
        const e = this.vertex([x + c0 * r1, y1, z + s0 * r1], [0, 1, 0], rgb, surf, c0 * r1, s0 * r1, param);
        const f = this.vertex([x + c1 * r1, y1, z + s1 * r1], [0, 1, 0], rgb, surf, c1 * r1, s1 * r1, param);
        this.idx.push(ctr, f, e);
      }
    }
  }

  /** Dome (hemisphere-ish) centred at (x, y, z). */
  dome(x: number, y: number, z: number, r: number, hScale: number, seg: number, rings: number, rgb: V3, surf: number, param = 0) {
    const base = this.vertexCount;
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * (Math.PI / 2);
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const nx = Math.cos(th) * Math.cos(phi);
        const ny = Math.sin(phi);
        const nz = Math.sin(th) * Math.cos(phi);
        this.vertex([x + nx * r, y + ny * r * hScale, z + nz * r], norm([nx, ny / Math.max(hScale, 0.2), nz]), rgb, surf, (i / seg) * r * 6.28, phi * r, param);
      }
    }
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i;
        const b = a + 1;
        const c = a + seg + 1;
        const d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
  }

  /** Ellipsoid (for statues, fish, fruit) — full sphere scaled. */
  ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number, seg: number, rgb: V3, surf: number, param = 0) {
    const base = this.vertexCount;
    const rings = Math.max(3, Math.floor(seg / 2));
    for (let j = 0; j <= rings; j++) {
      const phi = -Math.PI / 2 + (j / rings) * Math.PI;
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const nx = Math.cos(th) * Math.cos(phi);
        const ny = Math.sin(phi);
        const nz = Math.sin(th) * Math.cos(phi);
        this.vertex([x + nx * rx, y + ny * ry, z + nz * rz], norm([nx / rx, ny / ry, nz / rz]), rgb, surf, i / seg, j / rings, param);
      }
    }
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i;
        const b = a + 1;
        const c = a + seg + 1;
        const d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
  }

  /** Extrude a 2D profile (in local x/y) along z from z0 to z1 (e.g. arches, gables). */
  extrudePolygon(pts: [number, number][], z0: number, z1: number, rgb: V3, surfSides: number, surfCaps: number, param = 0) {
    const n = pts.length;
    // side walls
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      // profile points are counter-clockwise seen from +z
      this.quad([x1, y1, z1], [x0, y0, z1], [x0, y0, z0], [x1, y1, z0], rgb, surfSides, param);
    }
    // caps (fan; profile assumed convex or star-shaped around the centroid)
    let cx = 0;
    let cy = 0;
    for (const [x, y] of pts) {
      cx += x / n;
      cy += y / n;
    }
    for (const [zz, dir] of [
      [z0, -1],
      [z1, 1],
    ] as const) {
      const c = this.vertex([cx, cy, zz], [0, 0, dir], rgb, surfCaps, cx, cy, param);
      const ids = pts.map(([x, y]) => this.vertex([x, y, zz], [0, 0, dir], rgb, surfCaps, x, y, param));
      for (let i = 0; i < n; i++) {
        if (dir > 0) this.idx.push(c, ids[i], ids[(i + 1) % n]);
        else this.idx.push(c, ids[(i + 1) % n], ids[i]);
      }
    }
  }

  merge(o: MeshBuilder) {
    const base = this.vertexCount;
    for (const v of o.pos) this.pos.push(v);
    for (const v of o.nrm) this.nrm.push(v);
    for (const v of o.col) this.col.push(v);
    for (const v of o.surf) this.surf.push(v);
    for (const i of o.idx) this.idx.push(i + base);
  }
}

const _p: V3 = [0, 0, 0];
const _n: V3 = [0, 0, 0];

export function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function len(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function norm(a: V3): V3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** sRGB hex -> linear rgb triple. */
export function lin(hex: string): V3 {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [f(r), f(g), f(b)];
}
