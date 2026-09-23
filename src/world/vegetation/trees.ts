// Instanced trees per terrain chunk. One base mesh (trunk + crown blobs) is
// reshaped per instance in the vertex shader: broadleaf, poplar, willow and
// orchard trees share a single draw call per chunk.

import {
  BufferGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  CylinderGeometry,
  Quaternion,
  Vector3,
  Group,
} from 'three';
import { frame } from '../../coords/cylinder';
import { hash01 } from '../../core/rng';
import { makeBentDepthMaterial, patchWorldMaterial } from '../../render/bend';
import { TREE_STRIDE } from '../terrain/chunkTypes';
import type { CameraState } from '../terrain/terrainManager';

const shapeGlsl = /* glsl */ `
attribute float aPart;
attribute vec4 aTree; // type, colour variation, phase, unused
varying float vTreePart;
varying vec3 vTreeTint;
vec3 treeShape(vec3 p) {
  float type = aTree.x;
  if (aPart > 0.5) {
    // crown centred at y = 6 in the base mesh
    vec3 c = vec3(0.0, 6.0, 0.0);
    vec3 d = p - c;
    if (type < 0.5) { d *= vec3(1.0, 0.95, 1.0); }
    else if (type < 1.5) { d *= vec3(0.42, 1.75, 0.42); c.y = 7.5; }
    else if (type < 2.5) { d.y *= 0.75; d.xz *= 1.25; d.y -= max(0.0, length(d.xz) - 1.5) * 0.45; c.y = 5.0; }
    else { d *= vec3(0.62, 0.55, 0.62); c.y = 3.3; }
    p = c + d;
    // gentle wind sway, stronger at the top
    float sway = sin(uTime * 1.3 + aTree.z * 6.28) * 0.12 + sin(uTime * 2.9 + aTree.z * 17.0) * 0.05;
    p.x += sway * (p.y / 8.0);
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
  return c;
}
`;

const vertexBegin = /* glsl */ `
transformed = treeShape(transformed);
vTreePart = aPart;
vTreeTint = treeTint();
`;

const depthBegin = /* glsl */ `
transformed = treeShape(transformed);
`;

function buildTreeGeometry(detail: 'high' | 'low'): BufferGeometry {
  const parts: { g: BufferGeometry; part: number }[] = [];
  const trunk = new CylinderGeometry(0.18, 0.32, 4.2, detail === 'high' ? 7 : 4, 1, true);
  trunk.translate(0, 2.1, 0);
  parts.push({ g: trunk, part: 0 });
  const blobs: [number, number, number, number][] =
    detail === 'high'
      ? [
          [0, 6.2, 0, 3.0],
          [1.4, 5.3, 0.6, 2.2],
          [-1.2, 5.6, -0.8, 2.3],
          [0.2, 7.6, -0.3, 1.9],
        ]
      : [[0, 6, 0, 3.3]];
  for (const [x, y, z, r] of blobs) {
    const g = new IcosahedronGeometry(r, detail === 'high' ? 1 : 0);
    // lumpy
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const v = new Vector3().fromBufferAttribute(pos, i);
      const k = 1 + (hash01(Math.round(v.x * 10), Math.round(v.y * 10), Math.round(v.z * 10), 5) - 0.5) * 0.25;
      v.multiplyScalar(k);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.translate(x, y, z);
    const ng = g.toNonIndexed();
    // soft, rounded foliage shading: normals from the blob and crown centres
    const pp = ng.getAttribute('position');
    const nn = new Float32Array(pp.count * 3);
    for (let i = 0; i < pp.count; i++) {
      const v = new Vector3().fromBufferAttribute(pp, i);
      const a = v.clone().sub(new Vector3(x, y, z)).normalize();
      const b = v.clone().sub(new Vector3(0, 6, 0)).normalize();
      const n = a.multiplyScalar(0.45).add(b.multiplyScalar(0.55)).normalize();
      nn[i * 3] = n.x;
      nn[i * 3 + 1] = n.y;
      nn[i * 3 + 2] = n.z;
    }
    ng.setAttribute('normal', new Float32BufferAttribute(nn, 3));
    parts.push({ g: ng, part: 1 });
  }
  // merge
  for (const p of parts) if (p.g.index) p.g = p.g.toNonIndexed();
  let count = 0;
  for (const p of parts) count += p.g.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const part = new Float32Array(count);
  let o = 0;
  for (const p of parts) {
    const g = p.g;
    const pa = g.getAttribute('position');
    const na = g.getAttribute('normal');
    for (let i = 0; i < pa.count; i++) {
      pos[(o + i) * 3] = pa.getX(i);
      pos[(o + i) * 3 + 1] = pa.getY(i);
      pos[(o + i) * 3 + 2] = pa.getZ(i);
      nrm[(o + i) * 3] = na.getX(i);
      nrm[(o + i) * 3 + 1] = na.getY(i);
      nrm[(o + i) * 3 + 2] = na.getZ(i);
      part[o + i] = p.part;
    }
    o += pa.count;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new Float32BufferAttribute(part, 1));
  g.computeBoundingSphere();
  return g;
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
  private material: MeshLambertMaterial;
  private depth = makeBentDepthMaterial('tree', { vertexPars: shapeGlsl, vertexBegin: depthBegin });
  count = 0;

  constructor() {
    this.material = new MeshLambertMaterial({ color: 0xffffff });
    patchWorldMaterial(this.material, {
      key: 'tree',
      bend: true,
      vertexPars: shapeGlsl,
      vertexBegin,
      fragmentPars: `varying float vTreePart; varying vec3 vTreeTint;`,
      fragmentColor: `
        {
          vec3 trunkC = vec3(0.16, 0.11, 0.07);
          diffuseColor.rgb *= mix(trunkC, vTreeTint, vTreePart);
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
    for (const name of ['position', 'normal', 'aPart']) g.setAttribute(name, geo.getAttribute(name));
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
