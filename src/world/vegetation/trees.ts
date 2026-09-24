// Instanced trees per terrain chunk (and in towns). One base mesh per detail
// level (a tapered trunk with branches, a solid inner canopy, and crossed
// cards of leaves around it) is reshaped per instance in the vertex shader:
// broadleaf, poplar, willow and orchard trees share one draw call per chunk.
// The bark and leaf texture is painted on a canvas at startup.

import {
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { frame } from '../../coords/cylinder';
import { makeBentDepthMaterial, patchWorldMaterial } from '../../render/bend';
import { TREE_STRIDE } from '../terrain/chunkTypes';
import type { CameraState } from '../terrain/terrainManager';

// aPart: 0 trunk, 0.5 branch (reshaped with the crown, coloured as bark), 1 foliage
const shapeGlsl = /* glsl */ `
attribute float aPart;
attribute vec4 aTree; // type, colour variation, phase, unused
varying float vTreePart;
varying vec3 vTreeTint;
varying float vTreeAO;
// light reaching the inside and the underside of the crown (base mesh position)
float treeAO(vec3 p) {
  vec3 d = (p - vec3(0.0, 6.1, 0.0)) / vec3(3.1, 2.7, 3.1);
  float ao = mix(0.45, 1.0, smoothstep(0.3, 0.95, length(d)));
  return ao * mix(0.72, 1.0, smoothstep(-1.0, 0.4, d.y));
}
vec3 treeShape(vec3 p) {
  float type = aTree.x;
  if (aPart > 0.25) {
    // crown centred at y = 6 in the base mesh
    vec3 c = vec3(0.0, 6.0, 0.0);
    vec3 d = p - c;
    if (type < 0.5) { d *= vec3(1.0, 0.95, 1.0); }
    else if (type < 1.5) { d *= vec3(0.42, 1.75, 0.42); c.y = 7.5; }
    else if (type < 2.5) { d.y *= 0.75; d.xz *= 1.25; d.y -= max(0.0, length(d.xz) - 1.5) * 0.55; c.y = 5.0; }
    else { d *= vec3(0.62, 0.55, 0.62); c.y = 3.3; }
    p = c + d;
    // gentle wind sway, stronger at the top, plus a flutter of the outer leaves
    float sway = sin(uTime * 1.3 + aTree.z * 6.28) * 0.12 + sin(uTime * 2.9 + aTree.z * 17.0) * 0.05;
    p.x += sway * (p.y / 8.0);
    float outer = smoothstep(1.2, 3.0, length(d)) * step(0.75, aPart);
    p += outer * 0.05 * vec3(sin(uTime * 5.3 + p.y * 2.1 + aTree.z * 40.0), sin(uTime * 4.1 + p.x * 1.7), cos(uTime * 4.7 + p.z * 1.9));
  } else {
    if (type > 0.5 && type < 1.5) p.y *= 1.1;
    if (type > 2.5) { p.y *= 0.55; p.xz *= 0.7; }
  }
  return p;
}
vec3 treeTint() {
  float type = aTree.x;
  vec3 c = vec3(0.19, 0.30, 0.09);
  if (type > 0.5 && type < 1.5) c = vec3(0.10, 0.20, 0.10);
  else if (type > 1.5 && type < 2.5) c = vec3(0.30, 0.38, 0.12);
  else if (type > 2.5) c = vec3(0.26, 0.40, 0.12);
  c *= 0.75 + 0.5 * aTree.y;
  c = mix(c, c * vec3(1.3, 1.05, 0.6), step(0.82, aTree.y) * 0.6);
  // blossom: many orchard trees and the odd broadleaf flower pink or white
  float pick = fract(aTree.z * 7.31 + aTree.y * 3.17);
  float bloom = type > 2.5 ? step(0.45, pick) : (type < 0.5 ? step(0.9, pick) : 0.0);
  vec3 petal = mix(vec3(0.86, 0.46, 0.58), vec3(0.88, 0.80, 0.80), step(0.8, fract(pick * 5.7)));
  c = mix(c, petal * (0.85 + 0.3 * aTree.y), bloom * 0.85);
  return c;
}
`;

const vertexBegin = /* glsl */ `
vTreeAO = aPart > 0.75 ? treeAO(transformed) : 1.0;
transformed = treeShape(transformed);
vTreePart = step(0.75, aPart);
vTreeTint = treeTint();
`;

const depthBegin = /* glsl */ `
transformed = treeShape(transformed);
`;

// ---------------------------------------------------------------------------
// Texture atlas (v = 0 at the top): leaves 0..0.75, bark u 0..0.5 and dense
// canopy u 0.5..1 in 0.75..1.
// ---------------------------------------------------------------------------

const ATLAS = 512;
const LEAF_V = 0.75;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Leaves, bark and canopy painted in near-white greys: the shader tints them per tree. */
function paintAtlas(): DataTexture {
  const S = ATLAS;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const r = rng(0x7ee5);
  const TAU = Math.PI * 2;
  const leafH = S * LEAF_V;
  // twigs under the leaves
  g.strokeStyle = 'rgb(70,58,44)';
  for (let i = 0; i < 14; i++) {
    const a = r() * TAU;
    g.lineWidth = 1.5 + r() * 2;
    g.beginPath();
    g.moveTo(S / 2 + Math.cos(a) * 20, leafH / 2 + Math.sin(a) * 20);
    g.lineTo(S / 2 + Math.cos(a) * 180, leafH / 2 + Math.sin(a) * 150);
    g.stroke();
  }
  // leaves: a loose, ragged disc of them
  for (let i = 0; i < 420; i++) {
    const a = r() * TAU;
    const d = Math.pow(r(), 0.6);
    const x = S / 2 + Math.cos(a) * d * (S * 0.44);
    const y = leafH / 2 + Math.sin(a) * d * (leafH * 0.44);
    const len = 16 + r() * 18;
    const wid = len * (0.36 + r() * 0.16);
    // lighter towards the rim (sunlit), with a warm or cool cast
    const l = 150 + r() * 70 + d * 35;
    const warm = (r() - 0.5) * 30;
    g.save();
    g.translate(x, y);
    g.rotate(r() * TAU);
    g.fillStyle = `rgb(${Math.min(255, l + warm)},${Math.min(255, l + 8)},${Math.max(0, l - 20 - warm)})`;
    g.beginPath();
    g.ellipse(0, 0, len / 2, wid / 2, 0, 0, TAU);
    g.fill();
    g.strokeStyle = `rgba(0,0,0,0.18)`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.lineTo(len / 2, 0);
    g.stroke();
    g.restore();
  }
  // bark: vertical fissures
  const by = Math.round(leafH) + 4;
  const bh = S - by - 4;
  g.fillStyle = 'rgb(150,140,128)';
  g.fillRect(0, by, S / 2 - 4, bh);
  for (let i = 0; i < 90; i++) {
    const x = r() * (S / 2 - 4);
    const l = 80 + r() * 100;
    g.fillStyle = `rgb(${l},${l - 6},${l - 14})`;
    g.fillRect(x, by + r() * bh * 0.3, 1 + r() * 3, bh * (0.4 + r() * 0.6));
  }
  // dense canopy: overlapping leaf blobs, fully opaque
  g.fillStyle = 'rgb(120,126,104)';
  g.fillRect(S / 2 + 4, by, S / 2 - 4, bh);
  for (let i = 0; i < 700; i++) {
    const x = S / 2 + 4 + r() * (S / 2 - 8);
    const y = by + r() * bh;
    const l = 110 + r() * 110;
    g.fillStyle = `rgb(${l + 6},${l + 10},${l - 22})`;
    g.beginPath();
    g.ellipse(x, y, 5 + r() * 6, 3 + r() * 3, r() * TAU, 0, TAU);
    g.fill();
  }
  // Read back and give fully transparent texels the leaves' colour, so the
  // filtered edges don't pick up a dark fringe.
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < S * Math.round(leafH) * 4; i += 4) {
    if (d[i + 3] > 250) {
      sr += d[i];
      sg += d[i + 1];
      sb += d[i + 2];
      n++;
    }
  }
  const avg = [sr / Math.max(1, n), sg / Math.max(1, n), sb / Math.max(1, n)];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] !== 0) continue;
    d[i] = avg[0];
    d[i + 1] = avg[1];
    d[i + 2] = avg[2];
  }
  const tex = new DataTexture(new Uint8Array(d.buffer.slice(0)), S, S, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

class TreeBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  part: number[] = [];
  idx: number[] = [];

  vertex(p: V3, n: V3, u: number, v: number, part: number): number {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.part.push(part);
    return this.pos.length / 3 - 1;
  }

  /** Tapered tube along a path; bark texture wraps once around it. */
  tube(path: V3[], radius: (t: number) => number, sides: number, part: number) {
    const base = this.pos.length / 3;
    const len = path.length;
    let acc = 0;
    for (let i = 0; i < len; i++) {
      if (i > 0) acc += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
      const a = path[Math.max(0, i - 1)], b = path[Math.min(len - 1, i + 1)];
      const T = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      const ref: V3 = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const U = norm(cross(T, ref));
      const W = cross(T, U);
      const r = radius(i / (len - 1));
      for (let k = 0; k <= sides; k++) {
        const th = (k / sides) * Math.PI * 2;
        const n: V3 = [U[0] * Math.cos(th) + W[0] * Math.sin(th), U[1] * Math.cos(th) + W[1] * Math.sin(th), U[2] * Math.cos(th) + W[2] * Math.sin(th)];
        const p: V3 = [path[i][0] + n[0] * r, path[i][1] + n[1] * r, path[i][2] + n[2] * r];
        // bark region: u 0.01..0.48, v 0.76..0.99 (repeats every 2 m along the tube)
        const v = 0.76 + (((acc / 2) % 1) + 1) % 1 * 0.23;
        this.vertex(p, n, 0.01 + (k / sides) * 0.47, v, part);
      }
    }
    const ring = sides + 1;
    for (let i = 0; i + 1 < len; i++) {
      for (let k = 0; k < sides; k++) {
        const a = base + i * ring + k, b = a + 1, c = a + ring, d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }

  /** Two crossed cards of leaves centred on `c`, with normals bent towards the crown's outside. */
  cluster(c: V3, size: number, yaw: number, tilt: number, crown: V3) {
    const out = norm([c[0] - crown[0], (c[1] - crown[1]) * 0.8, c[2] - crown[2]]);
    for (let q = 0; q < 2; q++) {
      const a = yaw + (q * Math.PI) / 2;
      const X: V3 = [Math.cos(a), 0, Math.sin(a)];
      const Y: V3 = norm([-Math.sin(a) * Math.sin(tilt), Math.cos(tilt), Math.cos(a) * Math.sin(tilt)]);
      const N = norm(cross(X, Y));
      const n = norm([N[0] * 0.25 + out[0] * 0.75, N[1] * 0.25 + out[1] * 0.75 + 0.15, N[2] * 0.25 + out[2] * 0.75]);
      const h = size / 2;
      const i0 = this.pos.length / 3;
      const corners: [number, number, number, number][] = [
        [-1, -1, 0.01, LEAF_V - 0.01],
        [1, -1, 0.99, LEAF_V - 0.01],
        [1, 1, 0.99, 0.01],
        [-1, 1, 0.01, 0.01],
      ];
      for (const [sx, sy, u, v] of corners) {
        const p: V3 = [c[0] + (X[0] * sx + Y[0] * sy * 0.75) * h, c[1] + (X[1] * sx + Y[1] * sy * 0.75) * h, c[2] + (X[2] * sx + Y[2] * sy * 0.75) * h];
        this.vertex(p, n, u, v, 1);
      }
      this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }
  }

  /** Solid inner canopy so a tree never looks see-through. */
  core(c: V3, r: V3, detail: number) {
    const g = new IcosahedronGeometry(1, detail);
    const p = g.getAttribute('position');
    const i0 = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      const v: V3 = [p.getX(i), p.getY(i), p.getZ(i)];
      const lump = 1 + (Math.sin(v[0] * 7.1 + v[1] * 3.3) * Math.cos(v[2] * 5.7 - v[1] * 2.1)) * 0.12;
      const pp: V3 = [c[0] + v[0] * r[0] * lump, c[1] + v[1] * r[1] * lump, c[2] + v[2] * r[2] * lump];
      const u = 0.52 + (0.5 + Math.atan2(v[2], v[0]) / (Math.PI * 2)) * 0.46;
      const vv = 0.76 + (0.5 - Math.asin(Math.max(-1, Math.min(1, v[1]))) / Math.PI) * 0.23;
      this.vertex(pp, norm(v), u, vv, 1);
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) this.idx.push(i0 + ix.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(i0 + i);
    g.dispose();
  }

  finish(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aPart', new Float32BufferAttribute(this.part, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function buildTreeGeometry(detail: 'high' | 'low'): BufferGeometry {
  const hi = detail === 'high';
  const B = new TreeBuilder();
  const r = rng(hi ? 11 : 12);
  const crown: V3 = [0, 6.1, 0];
  const radii: V3 = [3.1, 2.7, 3.1];
  // trunk with a slight lean and taper
  const trunk: V3[] = [];
  for (let i = 0; i <= (hi ? 4 : 1); i++) {
    const t = i / (hi ? 4 : 1);
    trunk.push([0.12 * Math.sin(t * 2.2), t * 4.6, 0.08 * Math.sin(t * 3.1)]);
  }
  B.tube(trunk, (t) => 0.32 - 0.14 * t, hi ? 8 : 4, 0);
  if (hi) {
    // main branches into the crown
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + r() * 0.8;
      const y0 = 3.2 + r() * 1.1;
      const reach = 1.6 + r() * 0.9;
      const p0: V3 = [0.05 * Math.cos(a), y0, 0.05 * Math.sin(a)];
      const p1: V3 = [Math.cos(a) * reach * 0.55, y0 + 1.0, Math.sin(a) * reach * 0.55];
      const p2: V3 = [Math.cos(a) * reach, y0 + 1.9 + r() * 0.6, Math.sin(a) * reach];
      B.tube([p0, p1, p2], (t) => 0.13 - 0.09 * t, 5, 0.5);
    }
  }
  B.core(crown, [radii[0] * 0.66, radii[1] * 0.68, radii[2] * 0.66], hi ? 1 : 0);
  // leaf clusters over the crown, mostly towards its surface
  const clusters = hi ? 30 : 9;
  for (let i = 0; i < clusters; i++) {
    // even-ish spread over the sphere (golden spiral), jittered
    const fy = 1 - (2 * (i + 0.5)) / clusters;
    const ring = Math.sqrt(1 - fy * fy);
    const th = i * 2.39996 + r() * 0.5;
    const s = 0.62 + r() * 0.32;
    const c: V3 = [crown[0] + Math.cos(th) * ring * radii[0] * s, crown[1] + fy * radii[1] * s * 0.95, crown[2] + Math.sin(th) * ring * radii[2] * s];
    B.cluster(c, hi ? 2.2 + r() * 0.6 : 3.4, r() * Math.PI, (r() - 0.5) * 0.9, crown);
  }
  return B.finish();
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _up = new Vector3(0, 1, 0);

export class TreeRenderer {
  readonly group = new Group();
  private geoHigh = buildTreeGeometry('high');
  private geoLow = buildTreeGeometry('low');
  private atlas = paintAtlas();
  private material: MeshLambertMaterial;
  private depth = makeBentDepthMaterial('tree', { vertexPars: shapeGlsl, vertexBegin: depthBegin }, { map: this.atlas, alphaTest: 0.45, side: DoubleSide });
  count = 0;

  constructor() {
    // alphaToCoverage smooths the leaf edges when MSAA is on
    this.material = new MeshLambertMaterial({ map: this.atlas, alphaTest: 0.45, side: DoubleSide, alphaToCoverage: true });
    patchWorldMaterial(this.material, {
      key: 'tree',
      bend: true,
      noNormalFlip: true,
      vertexPars: shapeGlsl,
      vertexBegin,
      fragmentPars: `varying float vTreePart; varying vec3 vTreeTint; varying float vTreeAO;`,
      fragmentColor: `
        {
          vec3 trunkC = vec3(0.30, 0.22, 0.15);
          diffuseColor.rgb *= mix(trunkC, vTreeTint * 1.75, vTreePart) * vTreeAO;
        }
      `,
    });
    this.group.name = 'trees';
  }

  add(data: Float32Array, anchorS: number, anchorZ: number, level: number): InstancedMesh | null {
    const n = Math.floor(data.length / TREE_STRIDE);
    if (n === 0) return null;
    const geo = level >= 8 ? this.geoHigh : this.geoLow;
    const mesh = new InstancedMesh(geo, this.material, n);
    const tree = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const b = i * TREE_STRIDE;
      _p.set(data[b], data[b + 1], data[b + 2]);
      _q.setFromAxisAngle(_up, data[b + 4]);
      const sc = data[b + 3];
      _s.set(sc, sc * (0.85 + 0.3 * data[b + 6]), sc);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      tree[i * 4] = data[b + 5];
      tree[i * 4 + 1] = data[b + 6];
      tree[i * 4 + 2] = (data[b + 6] * 7.13) % 1;
      tree[i * 4 + 3] = 0;
    }
    // share the base vertex buffers; only the per-instance attribute is new
    const g = new BufferGeometry();
    for (const name of ['position', 'normal', 'uv', 'aPart']) g.setAttribute(name, geo.getAttribute(name));
    g.setIndex(geo.getIndex());
    g.boundingSphere = geo.boundingSphere;
    g.setAttribute('aTree', new InstancedBufferAttribute(tree, 4));
    mesh.geometry = g;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.customDepthMaterial = this.depth;
    mesh.castShadow = level >= 7;
    mesh.receiveShadow = true;
    frame.register(mesh, anchorS, anchorZ);
    this.group.add(mesh);
    this.count += n;
    return mesh;
  }

  remove(mesh: InstancedMesh) {
    this.group.remove(mesh);
    frame.unregister(mesh);
    this.count -= mesh.count;
    mesh.geometry.dispose();
    mesh.dispose();
  }

  update(_cam: CameraState) {}
}
