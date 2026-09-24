// Builds the game's rigged Quinlan from a textured source model (a Meshy GLB).
//
//   node tools/quinlan/build.mjs [source.glb] [--debug]
//
// Output (public/models/, loaded by src/npc/quinlanAsset.ts):
//   quinlan.bin         three LODs with the rig attributes the vertex-shader
//                       animation in src/npc/quinlanModel.ts reads
//   quinlan-albedo.jpg  colour texture for the near LOD
//
// How the source is rigged
//   The mesh is rotated into Quinlan model space (metres, feet on y = 0, snout
//   towards -Z, +X = the Quinlan's right) and scaled to QUINLAN.height. Bones are
//   hand-placed line segments (BONES below, in that space). Every vertex gets
//   "bone heat" weights (Baran and Popovic 2007): heat flows over the surface
//   from the nearest bone that a straight line inside the body can reach, which
//   keeps a belly from following the hand that hangs in front of it. The shader
//   rotates each vertex with one part (arm, leg, head...) blended with that
//   part's parent, so the weights are folded into (part, weight) pairs.
//   Parts that are separate pieces of mesh (whiskers, some gear) follow the
//   part they touch.
//
//   The colour texture is Meshy's tightly packed atlas; its mipmaps bleed across
//   island edges, so only the near LOD samples it. The mid and far LODs carry the
//   texture's colours baked into their vertices.
//
// If the source model changes, check the bones and joints against the debug
// renders (--debug writes coloured PLY files to tools/quinlan/out/).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const SRC = path.resolve(ROOT, args.find((a) => !a.startsWith('--')) ?? 'art/quinlan/quilan.glb');
const DEBUG = args.includes('--debug');
const OUT = path.join(ROOT, 'public/models');
const DBG = path.join(HERE, 'out');

// ---------------------------------------------------------------------------
// Configuration (Quinlan model space, metres)
// ---------------------------------------------------------------------------

const QUINLAN = {
  height: 1.2, // ear tips
  /** The source faces +Z (glTF convention); turn it to face -Z. */
  turn: true,
  /** Shift along Z after scaling, so the origin sits under the body. */
  shiftZ: 0.15,
};

/** Part indices (must match QUINLAN_PARTS in src/npc/quinlanModel.ts). */
const PART = { body: 0, head: 1, jaw: 2, armL: 3, armR: 4, legL: 5, legR: 6, tail: 7 };

/** Joint pivots written to the runtime file (R side; L mirrors X). */
const JOINTS = {
  hip: [0, 0.3, 0.03], // whole-body pitch pivot
  spine: [0, 0.5, -0.03], // upper-body bend pivot
  neck: [0, 0.95, -0.21],
  jaw: [0, 0.975, -0.47],
  shoulder: [0.22, 0.72, -0.19],
  elbow: [0.28, 0.5, -0.28],
  legHip: [0.13, 0.25, 0.07],
  tail: [0, 0.32, 0.33],
  eye: [0.095, 1.1, -0.43],
};

/**
 * How the procedural poses adapt to this body (see QuinlanRigPose in
 * src/npc/quinlanModel.ts): it leans forward and carries its tail high at rest.
 */
const POSE = { lean: 0.35, tailUp: 0.85, runY: 0.08, swimY: 0.03, sitBack: 0.2, jaw: 0.6 };

/**
 * Bones for the heat weights: [name, part, points (a polyline), reach]. The torso is
 * wide and the arms are fused to its sides, so several body bones fill it;
 * otherwise the arms and legs would claim the chest and belly. Points that end
 * up outside the mesh (or very close to its surface) are moved to the middle
 * of the part they are in. A bone with a reach only heats vertices within that
 * distance, so a fused upper arm doesn't take the whole side of the chest.
 */
const BONES_R = [
  ['spineLow', PART.body, [[0, 0.15, 0.1], [0, 0.46, -0.05]]],
  ['spineUp', PART.body, [[0, 0.46, -0.05], [0, 0.86, -0.15]]],
  ['front', PART.body, [[0, 0.24, -0.08], [0, 0.5, -0.24], [0, 0.78, -0.28]]],
  ['back', PART.body, [[0, 0.36, 0.18], [0, 0.62, 0.15], [0, 0.88, 0.03]]],
  ['head', PART.head, [[0, 0.95, -0.21], [0, 1.08, -0.37], [0, 1.06, -0.45], [0, 1.01, -0.66]], 0.2],
  ['jaw', PART.jaw, [[0, 0.955, -0.49], [0, 0.945, -0.6]]],
  ['upperArmR', PART.armR, [[0.25, 0.74, -0.2], [0.27, 0.5, -0.29]], 0.07],
  ['foreArmR', PART.armR, [[0.27, 0.5, -0.29], [0.26, 0.32, -0.35]], 0.07],
  ['thighR', PART.legR, [[0.12, 0.26, 0.05], [0.125, 0.1, 0.1], [0.155, 0.05, 0.06]], 0.1],
  ['footR', PART.legR, [[0.16, 0.025, 0.02], [0.3, 0.012, -0.28]], 0.1],
  ['tail', PART.tail, [[0, 0.32, 0.3], [0, 0.31, 0.6], [0, 0.42, 0.75], [0, 0.5, 0.85], [0, 0.62, 0.95], [0, 0.75, 1.01]], 0.15],
];

/** Width of the blend between parts at the joints (m). */
const BLEND = 0.035;

/** The lower jaw: in front of the hinge, below the bill (y of the mouth line at depth z). */
const inJaw = (x, y, z) => z < -0.5 && z > -0.7 && y > 0.86 && y < 1.0 + (z + 0.56) * 0.5 - 0.004;

/** LOD targets (triangles). LOD 0 is textured, 1 and 2 use baked vertex colours. */
const LODS = [
  { tris: 9000, textured: true, whiskers: true },
  { tris: 2200, textured: false, whiskers: false },
  { tris: 560, textured: false, whiskers: false },
];
const ALBEDO_SIZE = 2048;
const ALBEDO_QUALITY = 82;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...a) => console.log('[quinlan]', ...a);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function mirrorBones(bones) {
  const out = [];
  for (const [name, part, pts, reach] of bones) {
    out.push([name, part, pts, reach]);
    if (part === PART.armR || part === PART.legR) {
      const lp = part === PART.armR ? PART.armL : PART.legL;
      out.push([name.replace(/R$/, 'L'), lp, pts.map((p) => [-p[0], p[1], p[2]]), reach]);
    }
  }
  return out;
}

/** Split polylines into segments: {bone index, a, b}. */
function boneSegments(bones) {
  const segs = [];
  bones.forEach(([, , pts], bi) => {
    for (let i = 0; i + 1 < pts.length; i++) segs.push({ bone: bi, a: pts[i], b: pts[i + 1] });
  });
  return segs;
}

function closestOnSegment(p, a, b, out) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out[0] = a[0] + abx * t;
  out[1] = a[1] + aby * t;
  out[2] = a[2] + abz * t;
  return t;
}

// ---------------------------------------------------------------------------
// GLB input
// ---------------------------------------------------------------------------

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const bin = buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart));
  const types = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const accessor = (i) => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const T = types[a.componentType];
    const n = sizes[a.type];
    if (bv.byteStride && bv.byteStride !== n * T.BYTES_PER_ELEMENT) throw new Error('interleaved buffers are not supported');
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const bytes = bin.subarray(start, start + a.count * n * T.BYTES_PER_ELEMENT);
    return new T(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const image = (i) => {
    const bv = json.bufferViews[json.images[i].bufferView];
    return bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  };
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error('expected one mesh with one primitive');
  const prim = json.meshes[0].primitives[0];
  const mat = json.materials[prim.material];
  const tex = mat.pbrMetallicRoughness.baseColorTexture.index;
  return {
    position: accessor(prim.attributes.POSITION),
    normal: accessor(prim.attributes.NORMAL),
    uv: accessor(prim.attributes.TEXCOORD_0),
    index: Uint32Array.from(accessor(prim.indices)),
    albedo: image(json.textures[tex].source),
  };
}

// ---------------------------------------------------------------------------
// Model space
// ---------------------------------------------------------------------------

function toModelSpace(src) {
  const P = src.position, N = src.normal;
  const n = P.length / 3;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, P[i * 3]);
    maxX = Math.max(maxX, P[i * 3]);
    minY = Math.min(minY, P[i * 3 + 1]);
    maxY = Math.max(maxY, P[i * 3 + 1]);
  }
  const s = QUINLAN.height / (maxY - minY);
  const cx = (minX + maxX) / 2;
  const sg = QUINLAN.turn ? -1 : 1;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = sg * (P[i * 3] - cx) * s;
    pos[i * 3 + 1] = (P[i * 3 + 1] - minY) * s;
    pos[i * 3 + 2] = sg * P[i * 3 + 2] * s + QUINLAN.shiftZ;
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
    if (l < 1e-6) {
      nrm[i * 3 + 1] = 1; // degenerate source normal
      continue;
    }
    nrm[i * 3] = (sg * N[i * 3]) / l;
    nrm[i * 3 + 1] = N[i * 3 + 1] / l;
    nrm[i * 3 + 2] = (sg * N[i * 3 + 2]) / l;
  }
  log(`scale ${s.toFixed(4)}, ${n} vertices, ${src.index.length / 3} triangles`);
  return { pos, nrm, uv: src.uv, index: src.index, n };
}

/** Weld vertices split by UV seams: map[i] = welded id. */
function weld(pos, n) {
  const map = new Uint32Array(n);
  const ids = new Map();
  const first = [];
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * 1e5)},${Math.round(pos[i * 3 + 1] * 1e5)},${Math.round(pos[i * 3 + 2] * 1e5)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = first.length;
      ids.set(k, id);
      first.push(i);
    }
    map[i] = id;
  }
  const m = first.length;
  const wpos = new Float32Array(m * 3);
  first.forEach((i, id) => wpos.set(pos.subarray(i * 3, i * 3 + 3), id * 3));
  return { map, m, wpos, first };
}

function shells(m, tris) {
  const parent = new Int32Array(m).map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let t = 0; t < tris.length; t += 3) {
    for (const [x, y] of [[tris[t], tris[t + 1]], [tris[t + 1], tris[t + 2]]]) {
      const rx = find(x), ry = find(y);
      if (rx !== ry) parent[rx] = ry;
    }
  }
  const root = new Int32Array(m);
  const count = new Map();
  for (let i = 0; i < m; i++) {
    root[i] = find(i);
    count.set(root[i], (count.get(root[i]) ?? 0) + 1);
  }
  const order = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  const id = new Map(order.map((r, k) => [r, k]));
  const shell = new Int32Array(m);
  for (let i = 0; i < m; i++) shell[i] = id.get(root[i]);
  return { shell, count: order.map((r) => count.get(r)) };
}

function vertexNormals(m, pos, tris) {
  const nrm = new Float32Array(m * 3);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      nrm[k] += nx;
      nrm[k + 1] += ny;
      nrm[k + 2] += nz;
    }
  }
  for (let i = 0; i < m; i++) {
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    if (l < 1e-12) {
      // degenerate: a zero normal would turn into NaN in the shader
      nrm[i * 3] = 0;
      nrm[i * 3 + 1] = 1;
      nrm[i * 3 + 2] = 0;
      continue;
    }
    nrm[i * 3] /= l;
    nrm[i * 3 + 1] /= l;
    nrm[i * 3 + 2] /= l;
  }
  return nrm;
}

// ---------------------------------------------------------------------------
// Bone heat weights
// ---------------------------------------------------------------------------

/** Cotangent Laplacian (clamped to non-negative weights) in CSR form, plus lumped areas. */
function laplacian(m, pos, tris, active) {
  const edges = new Map();
  const area = new Float64Array(m);
  const addW = (i, j, w) => {
    const k = i < j ? i * m + j : j * m + i;
    edges.set(k, (edges.get(k) ?? 0) + w);
  };
  const cot = (o, p, q) => {
    const ux = pos[p * 3] - pos[o * 3], uy = pos[p * 3 + 1] - pos[o * 3 + 1], uz = pos[p * 3 + 2] - pos[o * 3 + 2];
    const vx = pos[q * 3] - pos[o * 3], vy = pos[q * 3 + 1] - pos[o * 3 + 1], vz = pos[q * 3 + 2] - pos[o * 3 + 2];
    const d = ux * vx + uy * vy + uz * vz;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return d / Math.max(Math.hypot(cx, cy, cz), 1e-12);
  };
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    if (!active[a]) continue;
    addW(b, c, 0.5 * cot(a, b, c));
    addW(c, a, 0.5 * cot(b, c, a));
    addW(a, b, 0.5 * cot(c, a, b));
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    area[a] += ar / 3;
    area[b] += ar / 3;
    area[c] += ar / 3;
  }
  // clamp: obtuse triangles give negative cotangents, which break the maximum principle
  let mean = 0;
  for (const w of edges.values()) mean += Math.abs(w);
  mean /= Math.max(1, edges.size);
  const deg = new Int32Array(m);
  for (const k of edges.keys()) {
    deg[Math.floor(k / m)]++;
    deg[k % m]++;
  }
  const rowPtr = new Int32Array(m + 1);
  for (let i = 0; i < m; i++) rowPtr[i + 1] = rowPtr[i] + deg[i];
  const col = new Int32Array(rowPtr[m]);
  const val = new Float64Array(rowPtr[m]);
  const fill = rowPtr.slice(0, m);
  const diag = new Float64Array(m);
  for (const [k, w0] of edges) {
    const i = Math.floor(k / m), j = k % m;
    const w = Math.max(w0, 0.01 * mean);
    col[fill[i]] = j;
    val[fill[i]++] = -w;
    col[fill[j]] = i;
    val[fill[j]++] = -w;
    diag[i] += w;
    diag[j] += w;
  }
  return { rowPtr, col, val, diag, area };
}

/** Jacobi-preconditioned conjugate gradients for (L + diag(h)) x = b. */
function pcg(L, h, b, x, active, tol = 1e-7, maxIt = 4000) {
  const m = b.length;
  const r = new Float64Array(m), z = new Float64Array(m), p = new Float64Array(m), q = new Float64Array(m);
  const D = new Float64Array(m);
  for (let i = 0; i < m; i++) D[i] = active[i] ? L.diag[i] + h[i] : 1;
  const mul = (v, out) => {
    for (let i = 0; i < m; i++) {
      if (!active[i]) {
        out[i] = 0;
        continue;
      }
      let s = (L.diag[i] + h[i]) * v[i];
      for (let k = L.rowPtr[i]; k < L.rowPtr[i + 1]; k++) s += L.val[k] * v[L.col[k]];
      out[i] = s;
    }
  };
  mul(x, q);
  let bn = 0;
  for (let i = 0; i < m; i++) {
    r[i] = active[i] ? b[i] - q[i] : 0;
    z[i] = r[i] / D[i];
    p[i] = z[i];
    bn += b[i] * b[i];
  }
  bn = Math.sqrt(bn) || 1;
  let rz = 0;
  for (let i = 0; i < m; i++) rz += r[i] * z[i];
  let it = 0;
  for (; it < maxIt; it++) {
    mul(p, q);
    let pq = 0;
    for (let i = 0; i < m; i++) pq += p[i] * q[i];
    const a = rz / pq;
    let rn = 0;
    for (let i = 0; i < m; i++) {
      x[i] += a * p[i];
      r[i] -= a * q[i];
      rn += r[i] * r[i];
    }
    if (Math.sqrt(rn) / bn < tol) break;
    let rz2 = 0;
    for (let i = 0; i < m; i++) {
      z[i] = r[i] / D[i];
      rz2 += r[i] * z[i];
    }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < m; i++) p[i] = z[i] + beta * p[i];
  }
  return it;
}

function boneHeat(W, nrm, tris, bones, main, allowed) {
  const { m, wpos } = W;
  const nb = bones.length;
  // BVH over the whole mesh for the visibility tests
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(wpos, 3));
  g.setIndex(new BufferAttribute(tris, 1));
  const bvh = new MeshBVH(g);
  const ray = new Ray();
  const inside = (p) => {
    let hits = 0;
    ray.origin.set(p[0], p[1], p[2]);
    ray.direction.set(0.3, 1, 0.2).normalize();
    for (const hit of bvh.raycast(ray, DoubleSide)) if (hit) hits++;
    return hits % 2 === 1;
  };
  // Move bone points that are outside, or close to the surface, to the middle
  // of the part: cast from the nearest surface point straight through it.
  const v = new Vector3();
  const centre = (p) => {
    v.set(p[0], p[1], p[2]);
    const c = bvh.closestPointToPoint(v, {});
    const isIn = inside(p);
    if (!c || (isIn && c.distance > 0.03)) return p;
    const f = c.faceIndex * 3;
    const A = tris[f] * 3, B = tris[f + 1] * 3, C = tris[f + 2] * 3;
    const ux = wpos[B] - wpos[A], uy = wpos[B + 1] - wpos[A + 1], uz = wpos[B + 2] - wpos[A + 2];
    const vx = wpos[C] - wpos[A], vy = wpos[C + 1] - wpos[A + 1], vz = wpos[C + 2] - wpos[A + 2];
    const n = new Vector3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
    for (const sg of [-1, 1]) {
      ray.origin.copy(c.point).addScaledVector(n, sg * 1e-4);
      ray.direction.copy(n).multiplyScalar(sg);
      const hit = bvh.raycastFirst(ray, DoubleSide, 0, 0.5);
      if (!hit) continue;
      const mid = c.point.clone().addScaledVector(n, (sg * hit.distance) / 2);
      const q = [mid.x, mid.y, mid.z];
      if (inside(q)) return q;
    }
    return p;
  };
  for (const bone of bones) {
    const before = bone[2];
    bone[2] = before.map(centre);
    const moved = bone[2].filter((q, k) => q !== before[k]).length;
    const out = bone[2].filter((q) => !inside(q)).length;
    if (moved || out) log(`  bone ${bone[0]}: ${moved} points centred${out ? `, ${out} still outside` : ''}`);
  }
  const segs = boneSegments(bones);
  const active = new Uint8Array(m);
  for (let i = 0; i < m; i++) active[i] = main[i];
  const h = new Float64Array(m);
  const nearest = new Int32Array(m).fill(-1);
  const q = [0, 0, 0];
  const p = [0, 0, 0];
  const dist = new Float64Array(nb);
  let invisible = 0;
  for (let i = 0; i < m; i++) {
    if (!active[i]) continue;
    p[0] = wpos[i * 3] - nrm[i * 3] * 0.002;
    p[1] = wpos[i * 3 + 1] - nrm[i * 3 + 1] * 0.002;
    p[2] = wpos[i * 3 + 2] - nrm[i * 3 + 2] * 0.002;
    dist.fill(Infinity);
    const best = new Array(nb);
    for (const s of segs) {
      closestOnSegment(p, s.a, s.b, q);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (d < dist[s.bone]) {
        dist[s.bone] = d;
        best[s.bone] = [q[0], q[1], q[2]];
      }
    }
    const order = [...dist.keys()].sort((a, b) => dist[a] - dist[b]);
    for (const bi of order) {
      if (!allowed(i, bi)) continue;
      const t = best[bi];
      const d = dist[bi];
      if (bones[bi][3] && d > bones[bi][3]) continue;
      ray.origin.set(p[0], p[1], p[2]);
      ray.direction.set(t[0] - p[0], t[1] - p[1], t[2] - p[2]).normalize();
      const hit = d > 1e-6 ? bvh.raycastFirst(ray, DoubleSide, 0, d * 0.999) : null;
      if (!hit) {
        // uniform source strength: joints blend over about BLEND metres. (The
        // original 1/d^2 lets thin limbs, close to their bones, flood the torso.)
        nearest[i] = bi;
        h[i] = 1 / (BLEND * BLEND);
        break;
      }
    }
    if (nearest[i] < 0) invisible++;
  }
  log(`  heat sources: ${m - invisible} of ${m} vertices see a bone`);
  const L = laplacian(m, wpos, tris, active);
  const hA = new Float64Array(m);
  for (let i = 0; i < m; i++) hA[i] = h[i] * L.area[i];
  const weights = [];
  for (let bi = 0; bi < nb; bi++) {
    const b = new Float64Array(m);
    const x = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      if (nearest[i] === bi) {
        b[i] = hA[i];
        x[i] = 1;
      }
    }
    const it = pcg(L, hA, b, x, active);
    for (let i = 0; i < m; i++) x[i] = clamp01(x[i]);
    weights.push(x);
    log(`  bone ${bones[bi][0]}: ${it} iterations`);
  }
  // normalise
  for (let i = 0; i < m; i++) {
    if (!active[i]) continue;
    let s = 0;
    for (let bi = 0; bi < nb; bi++) s += weights[bi][i];
    if (s < 1e-9) {
      weights[0][i] = 1;
      continue;
    }
    for (let bi = 0; bi < nb; bi++) weights[bi][i] /= s;
  }
  return { weights, bvh };
}

// ---------------------------------------------------------------------------
// Rig attributes
// ---------------------------------------------------------------------------

/**
 * Fold bone weights into what the shader uses:
 *   part, w       the dominant part and its weight against its parent
 *   elbow         forearm share of an arm vertex
 */
function foldWeights(m, weights, bones, active) {
  const part = new Uint8Array(m);
  const w = new Float32Array(m);
  const elbow = new Float32Array(m);
  const byPart = (i, p) => {
    let s = 0;
    bones.forEach(([, bp], bi) => {
      if (bp === p) s += weights[bi][i];
    });
    return s;
  };
  const bone = (i, name) => weights[bones.findIndex((b) => b[0] === name)][i];
  for (let i = 0; i < m; i++) {
    if (!active[i]) continue;
    const body = byPart(i, PART.body);
    const head = byPart(i, PART.head);
    const jaw = byPart(i, PART.jaw);
    let best = PART.body, bw = 0;
    for (const p of [PART.head, PART.armL, PART.armR, PART.legL, PART.legR, PART.tail]) {
      const s = p === PART.head ? head + jaw : byPart(i, p);
      if (s > bw) {
        bw = s;
        best = p;
      }
    }
    if (best === PART.head && jaw > head) {
      // the jaw rides on the head: weigh it against the head only
      part[i] = PART.jaw;
      w[i] = jaw / Math.max(jaw + head, 1e-9);
      continue;
    }
    if (bw < 0.05) {
      part[i] = PART.body;
      w[i] = 1;
      continue;
    }
    part[i] = best;
    w[i] = bw / Math.max(bw + body, 1e-9);
    if (best === PART.armR || best === PART.armL) {
      const side = best === PART.armR ? 'R' : 'L';
      const up = bone(i, `upperArm${side}`), fo = bone(i, `foreArm${side}`);
      elbow[i] = fo / Math.max(up + fo, 1e-9);
    }
  }
  return { part, w, elbow };
}

/** Separate pieces of mesh follow the main-mesh vertex they are closest to. */
function attachShells(W, shellInfo, main, rig) {
  const { m, wpos } = W;
  const nShells = shellInfo.count.length;
  for (let s = 1; s < nShells; s++) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < m; i++) {
      if (shellInfo.shell[i] !== s) continue;
      for (let j = 0; j < m; j++) {
        if (!main[j]) continue;
        const d = (wpos[i * 3] - wpos[j * 3]) ** 2 + (wpos[i * 3 + 1] - wpos[j * 3 + 1]) ** 2 + (wpos[i * 3 + 2] - wpos[j * 3 + 2]) ** 2;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
    }
    for (let i = 0; i < m; i++) {
      if (shellInfo.shell[i] !== s) continue;
      rig.part[i] = rig.part[best];
      rig.w[i] = rig.w[best];
      rig.elbow[i] = rig.elbow[best];
    }
  }
}

/** Upper-body bend weight, belly and breathing weights (geometric). */
function bodyWeights(m, wpos, rig) {
  const spine = new Float32Array(m), belly = new Float32Array(m), chest = new Float32Array(m);
  const a = [0, 0.15, 0.1], b = [0, 0.86, -0.15];
  const q = [0, 0, 0];
  for (let i = 0; i < m; i++) {
    const p = [wpos[i * 3], wpos[i * 3 + 1], wpos[i * 3 + 2]];
    const t = closestOnSegment(p, a, b, q);
    spine[i] = sstep(0.3, 0.78, t);
    const onBody = rig.part[i] === PART.body ? 1 : rig.part[i] === PART.armL || rig.part[i] === PART.armR ? 1 - rig.w[i] : 0;
    belly[i] = onBody * sstep(0.02, 0.2, t) * (1 - sstep(0.55, 0.85, t));
    chest[i] = onBody * sstep(0.45, 0.62, t) * (1 - sstep(0.85, 0.98, t));
  }
  return { spine, belly, chest };
}

// ---------------------------------------------------------------------------
// Texture: colours, fur and gear masks
// ---------------------------------------------------------------------------

function decodeAlbedo(bytes) {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return { w: img.width, h: img.height, data: img.data };
}

/** Linear RGB box-filtered to `size` (power-of-two downscale). */
function downsampleLinear(img, size) {
  const f = img.w / size;
  const out = new Float32Array(size * size * 3);
  const lut = new Float32Array(256).map((_, i) => srgbToLinear(i / 255));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const k = ((y * f + dy) * img.w + x * f + dx) * 4;
          r += lut[img.data[k]];
          g += lut[img.data[k + 1]];
          b += lut[img.data[k + 2]];
        }
      }
      const o = (y * size + x) * 3;
      out[o] = r / (f * f);
      out[o + 1] = g / (f * f);
      out[o + 2] = b / (f * f);
    }
  }
  return { size, data: out };
}

function sampleLinear(tex, u, v, out) {
  const s = tex.size;
  const x = Math.min(s - 1, Math.max(0, Math.floor(u * s)));
  const y = Math.min(s - 1, Math.max(0, Math.floor(v * s)));
  const k = (y * s + x) * 3;
  out[0] = tex.data[k];
  out[1] = tex.data[k + 1];
  out[2] = tex.data[k + 2];
}

/**
 * Average linear colour of every welded vertex over its surrounding triangles,
 * sampled at several points per triangle (so small vertices see their patch).
 */
function vertexColours(W, S, tex) {
  const { m, map } = W;
  const col = new Float64Array(m * 3);
  const wsum = new Float64Array(m);
  const c = [0, 0, 0];
  const bary = [[1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2], [0.8, 0.1], [0.1, 0.8], [0.1, 0.1]];
  const idx = S.index, uv = S.uv, pos = S.pos;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], cc = idx[t + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[cc * 3] - pos[a * 3], vy = pos[cc * 3 + 1] - pos[a * 3 + 1], vz = pos[cc * 3 + 2] - pos[a * 3 + 2];
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    let r = 0, g = 0, bl = 0;
    for (const [s, q] of bary) {
      const u = uv[a * 2] * (1 - s - q) + uv[b * 2] * s + uv[cc * 2] * q;
      const v = uv[a * 2 + 1] * (1 - s - q) + uv[b * 2 + 1] * s + uv[cc * 2 + 1] * q;
      sampleLinear(tex, u, v, c);
      r += c[0];
      g += c[1];
      bl += c[2];
    }
    for (const k of [a, b, cc]) {
      const wv = map[k];
      col[wv * 3] += (r / bary.length) * area;
      col[wv * 3 + 1] += (g / bary.length) * area;
      col[wv * 3 + 2] += (bl / bary.length) * area;
      wsum[wv] += area;
    }
  }
  const out = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) {
    const s = wsum[i] || 1;
    out[i * 3] = col[i * 3] / s;
    out[i * 3 + 1] = col[i * 3 + 1] / s;
    out[i * 3 + 2] = col[i * 3 + 2] / s;
  }
  return out;
}

/** HSV (0..1) of an sRGB triple. */
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let hh = 0;
  if (d > 1e-6) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh /= 6;
    if (hh < 0) hh += 1;
  }
  return [hh, mx > 0 ? d / mx : 0, mx];
}

/**
 * How much the per-Quinlan fur tint applies (fur 1, dark hide 0.5, bill, teeth,
 * whiskers and gear 0) and how much the gear dye applies (olive webbing 1).
 */
function masks(m, colLin) {
  const fur = new Float32Array(m), gear = new Float32Array(m);
  const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  for (let i = 0; i < m; i++) {
    const [h, s, v] = hsv(enc(colLin[i * 3]), enc(colLin[i * 3 + 1]), enc(colLin[i * 3 + 2]));
    const hueDeg = h * 360;
    // olive / khaki webbing: yellow-green hues, muted
    const olive = sstep(38, 48, hueDeg) * (1 - sstep(95, 110, hueDeg)) * sstep(0.1, 0.2, s) * (1 - sstep(0.6, 0.75, s));
    // fur: warm orange-brown hues, saturated
    const warm = (1 - sstep(38, 48, hueDeg)) * sstep(0.28, 0.4, s) * (hueDeg < 300 ? 1 : 0);
    const dark = 1 - sstep(0.12, 0.22, v);
    gear[i] = olive * (1 - dark);
    fur[i] = Math.max(warm * (1 - dark), 0.5 * dark) * (1 - gear[i]);
  }
  return { fur, gear };
}

// ---------------------------------------------------------------------------
// LODs
// ---------------------------------------------------------------------------

function simplify(indices, positions, attrs, stride, weights, target, lock) {
  const [out, err] = MeshoptSimplifier.simplifyWithAttributes(
    indices,
    positions,
    3,
    attrs,
    stride,
    weights,
    lock,
    Math.min(indices.length, target * 3),
    0.08,
    [],
  );
  return { index: out, error: err };
}

/** Remove unused vertices and optimise for the vertex cache; returns the kept source ids. */
function compact(index) {
  const idx = Uint32Array.from(index);
  const [remap, unique] = MeshoptEncoder.reorderMesh(idx, true, false);
  const src = new Uint32Array(unique);
  for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) src[remap[i]] = i;
  return { index: idx, src };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

class BinWriter {
  constructor() {
    this.parts = [];
    this.offset = 0;
  }
  add(typed) {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const off = this.offset;
    this.parts.push(bytes);
    this.offset += bytes.length;
    const pad = (4 - (this.offset % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.offset += pad;
    }
    return off;
  }
}

function writeRuntime(lods, albedoFile) {
  const bw = new BinWriter();
  const meta = {
    version: 1,
    height: QUINLAN.height,
    joints: JOINTS,
    pose: POSE,
    albedo: albedoFile,
    lods: [],
  };
  for (const L of lods) {
    const n = L.pos.length / 3;
    const entry = { vertices: n, triangles: L.index.length / 3, textured: L.textured, attributes: {} };
    const add = (name, arr, type, size) => {
      entry.attributes[name] = { offset: bw.add(arr), type, size };
    };
    add('position', L.pos, 'f32', 3);
    add('normal', L.nrm, 'i8n', 3);
    if (L.uv) add('uv', L.uv, 'u16n', 2);
    if (L.col) add('color', L.col, 'u16n', 3);
    add('rig0', L.rig0, 'u8n', 4);
    add('rig1', L.rig1, 'u8n', 4);
    const idx = n < 65536 ? Uint16Array.from(L.index) : L.index;
    entry.index = { offset: bw.add(idx), type: n < 65536 ? 'u16' : 'u32', count: L.index.length };
    meta.lods.push(entry);
  }
  const json = Buffer.from(JSON.stringify(meta));
  const jpad = (4 - ((json.length + 8) % 4)) % 4;
  const head = Buffer.alloc(8);
  head.write('QNL1', 0, 'ascii');
  head.writeUInt32LE(json.length + jpad, 4);
  const file = Buffer.concat([head, json, Buffer.alloc(jpad, 0x20), ...bw.parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))]);
  fs.writeFileSync(path.join(OUT, 'quinlan.bin'), file);
  return file.length;
}

function writePly(file, pos, tris, col) {
  const n = pos.length / 3;
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${tris.length / 3}\nproperty list uchar int vertex_indices\nend_header\n`;
  const vb = Buffer.alloc(n * 15);
  for (let i = 0; i < n; i++) {
    vb.writeFloatLE(pos[i * 3], i * 15);
    vb.writeFloatLE(pos[i * 3 + 1], i * 15 + 4);
    vb.writeFloatLE(pos[i * 3 + 2], i * 15 + 8);
    vb[i * 15 + 12] = col[i * 3];
    vb[i * 15 + 13] = col[i * 3 + 1];
    vb[i * 15 + 14] = col[i * 3 + 2];
  }
  const fb = Buffer.alloc((tris.length / 3) * 13);
  for (let t = 0; t < tris.length / 3; t++) {
    fb[t * 13] = 3;
    fb.writeInt32LE(tris[t * 3], t * 13 + 1);
    fb.writeInt32LE(tris[t * 3 + 1], t * 13 + 5);
    fb.writeInt32LE(tris[t * 3 + 2], t * 13 + 9);
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(head), vb, fb]));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  fs.mkdirSync(OUT, { recursive: true });
  if (DEBUG) fs.mkdirSync(DBG, { recursive: true });
  log(`source ${path.relative(ROOT, SRC)}`);
  const src = readGlb(SRC);
  const S = toModelSpace(src);
  const W = weld(S.pos, S.n);
  const wtris = new Uint32Array(S.index.length);
  for (let i = 0; i < S.index.length; i++) wtris[i] = W.map[S.index[i]];
  const sh = shells(W.m, wtris);
  log(`${W.m} welded vertices, ${sh.count.length} separate pieces: ${sh.count.join(', ')}`);
  const main = new Uint8Array(W.m);
  for (let i = 0; i < W.m; i++) main[i] = sh.shell[i] === 0 ? 1 : 0;
  const wnrm = vertexNormals(W.m, W.wpos, wtris);

  log('texture');
  const albedo = decodeAlbedo(src.albedo);
  const tex = downsampleLinear(albedo, 512);
  const colLin = vertexColours(W, S, tex);
  const mk = masks(W.m, colLin);
  // whiskers: the small separate pieces (thin strands under the bill)
  const whisker = new Uint8Array(W.m);
  for (let i = 0; i < W.m; i++) {
    const s = sh.shell[i];
    if (s > 0 && sh.count[s] < 1000) whisker[i] = 1;
  }

  const bones = mirrorBones(BONES_R);
  const bodyBone = bones.map((bn) => bn[1] === PART.body);
  const jawBone = bones.map((bn) => bn[1] === PART.jaw);
  const jawZone = new Uint8Array(W.m);
  for (let i = 0; i < W.m; i++) jawZone[i] = inJaw(W.wpos[i * 3], W.wpos[i * 3 + 1], W.wpos[i * 3 + 2]) ? 1 : 0;
  // gear (webbing, pouches, pack, bedroll) is carried by the body; only the lower jaw takes the jaw
  const allowed = (i, bi) => (mk.gear[i] > 0.5 ? bodyBone[bi] : jawBone[bi] ? jawZone[i] === 1 : true);
  log('bone heat');
  const { weights } = boneHeat(W, wnrm, wtris, bones, main, allowed);
  // heat leaks past the lips: outside the lower jaw, jaw weight belongs to the head
  const headBone = bones.findIndex((bn) => bn[1] === PART.head);
  bones.forEach((bn, bi) => {
    if (!jawBone[bi]) return;
    for (let i = 0; i < W.m; i++) {
      if (jawZone[i]) continue;
      weights[headBone][i] += weights[bi][i];
      weights[bi][i] = 0;
    }
  });
  const rig = foldWeights(W.m, weights, bones, main);
  attachShells(W, sh, main, rig);
  for (let i = 0; i < W.m; i++) {
    if (!whisker[i]) continue;
    rig.part[i] = PART.head;
    rig.w[i] = 1;
  }
  const body = bodyWeights(W.m, W.wpos, rig);
  for (const [name, part] of Object.entries(PART)) {
    let n = 0, firm = 0;
    for (let i = 0; i < W.m; i++) {
      if (rig.part[i] !== part) continue;
      n++;
      if (rig.w[i] > 0.5) firm++;
    }
    log(`  ${name}: ${n} vertices (${firm} with weight > 0.5)`);
  }

  // per welded vertex rig attributes (bytes)
  const rig0 = new Uint8Array(W.m * 4), rig1 = new Uint8Array(W.m * 4);
  const b = (x) => Math.round(clamp01(x) * 255);
  for (let i = 0; i < W.m; i++) {
    rig0[i * 4] = rig.part[i];
    rig0[i * 4 + 1] = b(rig.w[i]);
    rig0[i * 4 + 2] = b(whisker[i] ? 0 : mk.fur[i]);
    rig0[i * 4 + 3] = b(whisker[i] ? 0 : mk.gear[i]);
    rig1[i * 4] = b(body.spine[i]);
    rig1[i * 4 + 1] = b(rig.elbow[i]);
    rig1[i * 4 + 2] = b(body.belly[i]);
    rig1[i * 4 + 3] = b(body.chest[i]);
  }

  if (DEBUG) {
    const partCol = [[200, 200, 200], [230, 60, 60], [250, 200, 40], [60, 120, 250], [40, 200, 230], [60, 200, 80], [160, 230, 60], [200, 80, 220]];
    const col = new Uint8Array(W.m * 3);
    for (let i = 0; i < W.m; i++) {
      const pc = partCol[rig.part[i]];
      const k = rig.part[i] === PART.body ? 0 : rig.w[i];
      for (let c = 0; c < 3; c++) col[i * 3 + c] = Math.round(200 + (pc[c] - 200) * k);
    }
    writePly(path.join(DBG, 'parts.ply'), W.wpos, wtris, col);
    const mcol = new Uint8Array(W.m * 3);
    for (let i = 0; i < W.m; i++) {
      mcol[i * 3] = b(mk.fur[i]);
      mcol[i * 3 + 1] = b(mk.gear[i]);
      mcol[i * 3 + 2] = b(rig.elbow[i]);
    }
    writePly(path.join(DBG, 'masks.ply'), W.wpos, wtris, mcol);
    const scol = new Uint8Array(W.m * 3);
    for (let i = 0; i < W.m; i++) {
      scol[i * 3] = b(body.spine[i]);
      scol[i * 3 + 1] = b(body.belly[i]);
      scol[i * 3 + 2] = b(body.chest[i]);
    }
    writePly(path.join(DBG, 'body.ply'), W.wpos, wtris, scol);
    const ccol = new Uint8Array(W.m * 3);
    const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
    for (let i = 0; i < W.m * 3; i++) ccol[i] = b(enc(colLin[i]));
    writePly(path.join(DBG, 'colour.ply'), W.wpos, wtris, ccol);
  }

  // ---- LODs
  log('LODs');
  const lods = [];
  // attributes steering the simplifier: normal, and the rig weights (keeps joints)
  const attrStride = 6;
  for (const spec of LODS) {
    let L;
    if (spec.textured) {
      // split vertices (UV seams kept)
      const n = S.n;
      const attrs = new Float32Array(n * attrStride);
      for (let i = 0; i < n; i++) {
        const wv = W.map[i];
        attrs.set(S.nrm.subarray(i * 3, i * 3 + 3), i * attrStride);
        attrs[i * attrStride + 3] = rig.w[wv];
        attrs[i * attrStride + 4] = rig.part[wv] / 7;
        attrs[i * attrStride + 5] = mk.gear[wv];
      }
      const keep = [];
      for (let t = 0; t < S.index.length; t += 3) {
        const wv = W.map[S.index[t]];
        if (spec.whiskers || !whisker[wv]) keep.push(S.index[t], S.index[t + 1], S.index[t + 2]);
      }
      const { index, error } = simplify(Uint32Array.from(keep), S.pos, attrs, attrStride, [0.5, 0.5, 0.5, 1, 2, 0.3], spec.tris, null);
      const c = compact(index);
      const nv = c.src.length;
      L = { textured: true, index: c.index, pos: new Float32Array(nv * 3), nrm: new Int8Array(nv * 3), uv: new Uint16Array(nv * 2), rig0: new Uint8Array(nv * 4), rig1: new Uint8Array(nv * 4) };
      for (let k = 0; k < nv; k++) {
        const i = c.src[k];
        const wv = W.map[i];
        L.pos.set(S.pos.subarray(i * 3, i * 3 + 3), k * 3);
        for (let a = 0; a < 3; a++) L.nrm[k * 3 + a] = Math.round(S.nrm[i * 3 + a] * 127);
        L.uv[k * 2] = Math.round(clamp01(S.uv[i * 2]) * 65535);
        L.uv[k * 2 + 1] = Math.round(clamp01(S.uv[i * 2 + 1]) * 65535);
        L.rig0.set(rig0.subarray(wv * 4, wv * 4 + 4), k * 4);
        L.rig1.set(rig1.subarray(wv * 4, wv * 4 + 4), k * 4);
      }
      log(`  LOD ${lods.length}: ${L.index.length / 3} triangles, ${nv} vertices, error ${error.toFixed(4)} (textured)`);
    } else {
      // welded vertices (no UVs): seams don't hold the simplifier back
      const m = W.m;
      const attrs = new Float32Array(m * attrStride);
      for (let i = 0; i < m; i++) {
        attrs.set(wnrm.subarray(i * 3, i * 3 + 3), i * attrStride);
        attrs[i * attrStride + 3] = rig.w[i];
        attrs[i * attrStride + 4] = rig.part[i] / 7;
        attrs[i * attrStride + 5] = mk.gear[i];
      }
      const keep = [];
      for (let t = 0; t < wtris.length; t += 3) if (spec.whiskers || !whisker[wtris[t]]) keep.push(wtris[t], wtris[t + 1], wtris[t + 2]);
      const { index, error } = simplify(Uint32Array.from(keep), W.wpos, attrs, attrStride, [0.5, 0.5, 0.5, 1, 2, 0.3], spec.tris, null);
      const c = compact(index);
      const nv = c.src.length;
      L = { textured: false, index: c.index, pos: new Float32Array(nv * 3), nrm: new Int8Array(nv * 3), col: new Uint16Array(nv * 3), rig0: new Uint8Array(nv * 4), rig1: new Uint8Array(nv * 4) };
      const col = lodColours(W, wnrm, colLin, c.src, index, spec.tris);
      for (let k = 0; k < nv; k++) {
        const i = c.src[k];
        L.pos.set(W.wpos.subarray(i * 3, i * 3 + 3), k * 3);
        for (let a = 0; a < 3; a++) {
          L.nrm[k * 3 + a] = Math.round(wnrm[i * 3 + a] * 127);
          L.col[k * 3 + a] = Math.round(clamp01(col[k * 3 + a]) * 65535);
        }
        L.rig0.set(rig0.subarray(i * 4, i * 4 + 4), k * 4);
        L.rig1.set(rig1.subarray(i * 4, i * 4 + 4), k * 4);
      }
      log(`  LOD ${lods.length}: ${L.index.length / 3} triangles, ${nv} vertices, error ${error.toFixed(4)} (vertex colours)`);
    }
    lods.push(L);
  }

  // ---- albedo for the near LOD
  const albedoFile = 'quinlan-albedo.jpg';
  const scaled = ALBEDO_SIZE === albedo.w ? albedo : resizeRGBA(albedo, ALBEDO_SIZE);
  const jpg = jpeg.encode({ data: scaled.data, width: scaled.w, height: scaled.h }, ALBEDO_QUALITY);
  fs.writeFileSync(path.join(OUT, albedoFile), jpg.data);
  const size = writeRuntime(lods, albedoFile);
  log(`wrote public/models/quinlan.bin (${(size / 1024).toFixed(0)} KB) and ${albedoFile} (${(jpg.data.length / 1024).toFixed(0)} KB)`);
  if (DEBUG) {
    lods.forEach((L, k) => {
      const n = L.pos.length / 3;
      const c = new Uint8Array(n * 3);
      const pc = [[200, 200, 200], [230, 60, 60], [250, 200, 40], [60, 120, 250], [40, 200, 230], [60, 200, 80], [160, 230, 60], [200, 80, 220]];
      const enc = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
      for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) c[i * 3 + a] = L.col ? Math.round(enc(L.col[i * 3 + a] / 65535) * 255) : pc[L.rig0[i * 4]][a];
      }
      writePly(path.join(DBG, `lod${k}.ply`), L.pos, L.index, c);
    });
  }
}

/** Colour of each LOD vertex: the average over the source vertices near it that face the same way. */
function lodColours(W, wnrm, colLin, src, index, tris) {
  const nv = src.length;
  // radius ~ half the typical LOD edge
  let el = 0, ec = 0;
  for (let t = 0; t < index.length; t += 3) {
    for (const [a, b] of [[index[t], index[t + 1]], [index[t + 1], index[t + 2]]]) {
      el += Math.hypot(W.wpos[a * 3] - W.wpos[b * 3], W.wpos[a * 3 + 1] - W.wpos[b * 3 + 1], W.wpos[a * 3 + 2] - W.wpos[b * 3 + 2]);
      ec++;
    }
  }
  const r = (0.6 * el) / Math.max(1, ec);
  const cell = r;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < W.m; i++) {
    const k = key(W.wpos[i * 3], W.wpos[i * 3 + 1], W.wpos[i * 3 + 2]);
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  }
  const out = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) {
    const i = src[k];
    const px = W.wpos[i * 3], py = W.wpos[i * 3 + 1], pz = W.wpos[i * 3 + 2];
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
    let r0 = 0, g0 = 0, b0 = 0, ws = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const l = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!l) continue;
          for (const j of l) {
            const d = Math.hypot(W.wpos[j * 3] - px, W.wpos[j * 3 + 1] - py, W.wpos[j * 3 + 2] - pz);
            if (d > r) continue;
            const facing = wnrm[i * 3] * wnrm[j * 3] + wnrm[i * 3 + 1] * wnrm[j * 3 + 1] + wnrm[i * 3 + 2] * wnrm[j * 3 + 2];
            if (facing < 0.3) continue;
            const w = (1 - d / r) * facing;
            r0 += colLin[j * 3] * w;
            g0 += colLin[j * 3 + 1] * w;
            b0 += colLin[j * 3 + 2] * w;
            ws += w;
          }
        }
    if (ws < 1e-9) {
      out.set(colLin.subarray(i * 3, i * 3 + 3), k * 3);
    } else {
      out[k * 3] = r0 / ws;
      out[k * 3 + 1] = g0 / ws;
      out[k * 3 + 2] = b0 / ws;
    }
  }
  return out;
}

/** Box-filter an RGBA image down to size x size (power-of-two ratio). */
function resizeRGBA(img, size) {
  const f = img.w / size;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let dy = 0; dy < f; dy++)
        for (let dx = 0; dx < f; dx++) {
          const k = ((y * f + dy) * img.w + x * f + dx) * 4;
          acc[0] += img.data[k];
          acc[1] += img.data[k + 1];
          acc[2] += img.data[k + 2];
        }
      const o = (y * size + x) * 4;
      data[o] = acc[0] / (f * f);
      data[o + 1] = acc[1] / (f * f);
      data[o + 2] = acc[2] / (f * f);
      data[o + 3] = 255;
    }
  return { w: size, h: size, data };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
