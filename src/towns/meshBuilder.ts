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
  ashlar: 21,
  fieldstone: 22,
  lattice: 23,
  mica: 24,
  copper: 25,
} as const;

/**
 * `param` codes that weather a wall (stone, fieldstone, ashlar, plaster,
 * half-timbering): 3 + age (0..1) for building walls, whose surface v runs
 * up from the foot of the wall; 5 + v of the waterline for waterside walls.
 */
export const wallAge = (age: number) => 3 + Math.min(0.999, Math.max(0, age));
export const waterline = (v: number) => 5 + v;

export type V3 = [number, number, number];

function grown<T extends Float32Array | Uint32Array>(a: T, need: number): T {
  let n = a.length;
  while (n < need) n *= 2;
  const b = new (a.constructor as { new (n: number): T })(n);
  b.set(a);
  return b;
}

export class MeshBuilder {
  // growable typed storage: vertices (position, normal, colour, surface) and indices
  private P = new Float32Array(3 * 1024);
  private N = new Float32Array(3 * 1024);
  private C = new Float32Array(3 * 1024);
  private S = new Float32Array(4 * 1024);
  private I = new Uint32Array(3 * 1024);
  private nV = 0;
  private nI = 0;
  // current local transform: origin + rotation about up
  private ox = 0;
  private oh = 0;
  private oc = 0;
  private cr = 1;
  private sr = 0;

  get vertexCount() {
    return this.nV;
  }

  // Views of what has been built so far (they go stale once more is added).
  get pos(): Float32Array {
    return this.P.subarray(0, this.nV * 3);
  }
  get nrm(): Float32Array {
    return this.N.subarray(0, this.nV * 3);
  }
  get col(): Float32Array {
    return this.C.subarray(0, this.nV * 3);
  }
  get surf(): Float32Array {
    return this.S.subarray(0, this.nV * 4);
  }
  get idx(): Uint32Array {
    return this.I.subarray(0, this.nI);
  }

  /** Add a triangle by vertex index. */
  index(a: number, b: number, c: number) {
    if (this.nI + 3 > this.I.length) this.I = grown(this.I, this.nI + 3);
    const I = this.I;
    I[this.nI] = a;
    I[this.nI + 1] = b;
    I[this.nI + 2] = c;
    this.nI += 3;
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

  /** Add a vertex, given in the local frame (position and normal are carried into the town frame). */
  vertex(p: V3, n: V3, rgb: V3, surf: number, u: number, v: number, param: number): number {
    const i = this.nV;
    if ((i + 1) * 4 > this.S.length) {
      this.P = grown(this.P, (i + 1) * 3);
      this.N = grown(this.N, (i + 1) * 3);
      this.C = grown(this.C, (i + 1) * 3);
      this.S = grown(this.S, (i + 1) * 4);
    }
    const cr = this.cr;
    const sr = this.sr;
    const j = i * 3;
    this.P[j] = this.ox + p[0] * cr - p[2] * sr;
    this.P[j + 1] = this.oh + p[1];
    this.P[j + 2] = this.oc + p[0] * sr + p[2] * cr;
    this.N[j] = n[0] * cr - n[2] * sr;
    this.N[j + 1] = n[1];
    this.N[j + 2] = n[0] * sr + n[2] * cr;
    this.C[j] = rgb[0];
    this.C[j + 1] = rgb[1];
    this.C[j + 2] = rgb[2];
    const k = i * 4;
    this.S[k] = surf;
    this.S[k + 1] = u;
    this.S[k + 2] = v;
    this.S[k + 3] = param;
    this.nV = i + 1;
    return i;
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
      this.index(a, b, c);
      this.index(a, c, d);
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
    this.index(a, b, c);
    this.index(a, c, d);
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
    this.index(a, b, c);
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
      this.index(A, C, B);
      this.index(A, D, C);
      if (cap && r1 > 0.001) {
        const ctr = this.vertex([x, y1, z], [0, 1, 0], rgb, surf, 0, 0, param);
        const e = this.vertex([x + c0 * r1, y1, z + s0 * r1], [0, 1, 0], rgb, surf, c0 * r1, s0 * r1, param);
        const f = this.vertex([x + c1 * r1, y1, z + s1 * r1], [0, 1, 0], rgb, surf, c1 * r1, s1 * r1, param);
        this.index(ctr, f, e);
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
        this.index(a, c, b);
        this.index(b, c, d);
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
        this.index(a, c, b);
        this.index(b, c, d);
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
        if (dir > 0) this.index(c, ids[i], ids[(i + 1) % n]);
        else this.index(c, ids[(i + 1) % n], ids[i]);
      }
    }
  }

  merge(o: MeshBuilder) {
    const base = this.vertexCount;
    const n = o.nV;
    if ((base + n) * 4 > this.S.length) {
      this.P = grown(this.P, (base + n) * 3);
      this.N = grown(this.N, (base + n) * 3);
      this.C = grown(this.C, (base + n) * 3);
      this.S = grown(this.S, (base + n) * 4);
    }
    this.P.set(o.pos, base * 3);
    this.N.set(o.nrm, base * 3);
    this.C.set(o.col, base * 3);
    this.S.set(o.surf, base * 4);
    this.nV = base + n;
    const idx = o.idx;
    for (let i = 0; i < idx.length; i += 3) this.index(idx[i] + base, idx[i + 1] + base, idx[i + 2] + base);
  }
}


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
