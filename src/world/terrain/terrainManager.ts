// Chunked quadtree LOD over the unrolled (s, z) section, streamed from workers.
// Near root tiles are refined by distance; everything further is covered by a
// single low-resolution "far shell" mesh that discards fragments inside the
// near block.

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Material,
  Mesh,
  MeshLambertMaterial,
  Sphere,
  Vector2,
  Vector3,
} from 'three';
import { CHUNK_N, CIRC, MAX_LEVEL, R, ROOT_TILE_S, ROOT_TILE_Z, ROOT_TILES_S, Z_MAX, Z_MIN } from '../../config';
import { frame, wrapS } from '../../coords/cylinder';
import { makeBentDepthMaterial, patchWorldMaterial } from '../../render/bend';
import type { ChunkRequest, ChunkResult, FarShellResult } from './chunkTypes';
import { createTerrainMaterial } from './terrainMaterial';
import { TerrainWorkerPool } from './workerPool';
import { createWaterMaterial } from '../water/waterMaterial';
import { TreeRenderer } from '../vegetation/trees';

const ROOT_ROWS = Math.round((Z_MAX - Z_MIN) / ROOT_TILE_Z);

export interface CameraState {
  s: number;
  z: number;
  h: number;
}

class TNode {
  key: string;
  level: number;
  is: number;
  iz: number;
  s0: number;
  z0: number;
  sizeS: number;
  sizeZ: number;
  ready = false;
  mesh: Mesh | null = null;
  water: Mesh | null = null;
  trees: InstancedMesh | null = null;
  hMin = 0;
  hMax = 3000;
  touched = 0;
  visible = false;
  constructor(level: number, is: number, iz: number) {
    this.level = level;
    this.is = is;
    this.iz = iz;
    this.key = `${level}:${is}:${iz}`;
    const k = 1 << level;
    this.sizeS = ROOT_TILE_S / k;
    this.sizeZ = ROOT_TILE_Z / k;
    this.s0 = is * this.sizeS;
    this.z0 = Z_MIN + iz * this.sizeZ;
  }
  get size() {
    return Math.max(this.sizeS, this.sizeZ);
  }
}

export class TerrainManager {
  readonly group = new Group();
  readonly pool: TerrainWorkerPool;
  private nodes = new Map<string, TNode>();
  private material: MeshLambertMaterial;
  private depthMaterial: Material;
  private waterMaterial: Material;
  private index: BufferAttribute;
  private frameNo = 0;
  private visibleSet: TNode[] = [];
  /** Split when distance < K * node size. */
  lodK = 1.2;
  /** Finest level allowed (lowered while travelling fast). */
  maxLevel = MAX_LEVEL;
  nearBlock = 2;
  maxCached = 900;
  vegetation = true;
  farShell: Mesh | null = null;
  private farMaterial: MeshLambertMaterial;
  readonly trees: TreeRenderer;
  stats = { visible: 0, cached: 0, pending: 0, triangles: 0 };
  section = 0;
  seed = 0;

  constructor(workers: number) {
    this.pool = new TerrainWorkerPool(workers);
    this.pool.onChunk = (r) => this.onChunk(r);
    this.pool.onFarShell = (r) => this.onFarShell(r);
    this.material = createTerrainMaterial();
    this.depthMaterial = makeBentDepthMaterial('terrain');
    this.waterMaterial = createWaterMaterial();
    this.index = buildGridIndex(CHUNK_N);
    this.farMaterial = createFarShellMaterial();
    this.trees = new TreeRenderer();
    this.group.add(this.trees.group);
    this.group.name = 'terrain';
  }

  setSection(section: number, seed: number) {
    this.section = section;
    this.seed = seed;
    for (const n of this.nodes.values()) this.disposeNode(n);
    this.nodes.clear();
    this.visibleSet = [];
    if (this.farShell) {
      this.group.remove(this.farShell);
      frame.unregister(this.farShell);
      this.farShell.geometry.dispose();
      this.farShell = null;
    }
    this.pool.init(section, seed);
    this.pool.requestFarShell(256, 440);
  }

  private node(level: number, is: number, iz: number): TNode {
    const key = `${level}:${is}:${iz}`;
    let n = this.nodes.get(key);
    if (!n) {
      n = new TNode(level, is, iz);
      // inherit height bounds from the parent for distance estimates
      if (level > 0) {
        const p = this.nodes.get(`${level - 1}:${is >> 1}:${iz >> 1}`);
        if (p) {
          n.hMin = p.hMin;
          n.hMax = p.hMax;
        }
      }
      this.nodes.set(key, n);
    }
    return n;
  }

  private dist(n: TNode, cam: CameraState): number {
    const sc = n.s0 + n.sizeS / 2;
    const zc = n.z0 + n.sizeZ / 2;
    const dsRaw = Math.max(0, Math.abs(wrapS(cam.s - sc)) - n.sizeS / 2);
    const ds = 2 * R * Math.sin(Math.min(dsRaw, Math.PI * R) / (2 * R));
    const dz = Math.max(0, Math.abs(cam.z - zc) - n.sizeZ / 2);
    const dh = Math.max(0, n.hMin - cam.h, cam.h - n.hMax);
    return Math.sqrt(ds * ds + dz * dz + dh * dh);
  }

  private collect(n: TNode, cam: CameraState, out: TNode[], req: TNode[]): boolean {
    n.touched = this.frameNo;
    const split = n.level < this.maxLevel && this.dist(n, cam) < this.lodK * n.size;
    if (split) {
      const tmp: TNode[] = [];
      let ok = true;
      const l = n.level + 1;
      for (let c = 0; c < 4; c++) {
        const child = this.node(l, n.is * 2 + (c & 1), n.iz * 2 + (c >> 1));
        ok = this.collect(child, cam, tmp, req) && ok;
      }
      if (ok) {
        for (const t of tmp) out.push(t);
        return true;
      }
    }
    if (n.ready) {
      out.push(n);
      return true;
    }
    if (!this.pool.isPending(n.key)) req.push(n);
    return false;
  }

  /** Root-tile block around the camera (tile-aligned), used by the far shell discard. */
  nearBounds(cam: CameraState) {
    const cis = Math.floor(cam.s / ROOT_TILE_S);
    const ciz = Math.floor((cam.z - Z_MIN) / ROOT_TILE_Z);
    const nb = this.nearBlock;
    const iz0 = Math.max(0, ciz - nb);
    const iz1 = Math.min(ROOT_ROWS - 1, ciz + nb);
    return { cis, ciz, iz0, iz1, nb };
  }

  update(cam: CameraState) {
    this.frameNo++;
    const out: TNode[] = [];
    const req: TNode[] = [];
    const { cis, iz0, iz1, nb } = this.nearBounds(cam);
    for (let dis = -nb; dis <= nb; dis++) {
      const is = (((cis + dis) % ROOT_TILES_S) + ROOT_TILES_S) % ROOT_TILES_S;
      for (let iz = iz0; iz <= iz1; iz++) this.collect(this.node(0, is, iz), cam, out, req);
    }
    // visibility
    for (const n of this.visibleSet) n.visible = false;
    for (const n of out) n.visible = true;
    for (const n of this.visibleSet) if (!n.visible) this.setVisible(n, false);
    let tris = 0;
    for (const n of out) {
      this.setVisible(n, true);
      tris += CHUNK_N * CHUNK_N * 2;
    }
    this.visibleSet = out;
    // requests: coarse first, then nearest
    const reqs: ChunkRequest[] = req
      .map((n) => ({ n, d: this.dist(n, cam) }))
      .sort((a, b) => a.n.level - b.n.level || a.d - b.d)
      .slice(0, 64)
      .map(({ n }) => ({
        type: 'chunk' as const,
        key: n.key,
        level: n.level,
        s0: n.s0,
        z0: n.z0,
        sizeS: n.sizeS,
        sizeZ: n.sizeZ,
        n: CHUNK_N,
        veg: this.vegetation && n.level >= 6,
      }));
    this.pool.setQueue(reqs);
    // far shell discard block (offsets relative to the frame origin)
    const s0 = (((cis - nb) % ROOT_TILES_S) + ROOT_TILES_S) % ROOT_TILES_S * ROOT_TILE_S;
    const blockW = (2 * nb + 1) * ROOT_TILE_S;
    const off0 = wrapS(s0 - frame.originS);
    farUniforms.uNearS.value.set(off0, off0 + blockW);
    farUniforms.uNearZ.value.set(Z_MIN + iz0 * ROOT_TILE_Z - frame.originZ, Z_MIN + (iz1 + 1) * ROOT_TILE_Z - frame.originZ);
    // evict stale nodes
    if (this.nodes.size > this.maxCached) this.evict();
    this.trees.update(cam);
    this.stats.visible = out.length;
    this.stats.cached = this.nodes.size;
    this.stats.pending = this.pool.pending;
    this.stats.triangles = tris;
  }

  private setVisible(n: TNode, v: boolean) {
    if (n.mesh) n.mesh.visible = v;
    if (n.water) n.water.visible = v;
    if (n.trees) n.trees.visible = v;
  }

  private evict() {
    const arr = [...this.nodes.values()].filter((n) => !n.visible).sort((a, b) => a.touched - b.touched);
    const drop = this.nodes.size - Math.floor(this.maxCached * 0.85);
    for (let i = 0; i < drop && i < arr.length; i++) {
      this.disposeNode(arr[i]);
      this.nodes.delete(arr[i].key);
    }
  }

  private disposeNode(n: TNode) {
    for (const m of [n.mesh, n.water]) {
      if (!m) continue;
      this.group.remove(m);
      frame.unregister(m);
      m.geometry.dispose();
    }
    if (n.trees) {
      this.trees.remove(n.trees);
      n.trees = null;
    }
    n.mesh = null;
    n.water = null;
    n.ready = false;
  }

  private onChunk(r: ChunkResult) {
    const n = this.nodes.get(r.key);
    if (!n) return;
    if (n.mesh) this.disposeNode(n);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(r.position, 3));
    g.setAttribute('normal', new BufferAttribute(r.normal, 4, true));
    g.setAttribute('aColor', new BufferAttribute(r.color, 4, true));
    g.setAttribute('aMat', new BufferAttribute(r.mat, 4, true));
    g.setAttribute('aUnder', new BufferAttribute(r.under, 1));
    g.setIndex(this.index);
    g.boundingSphere = new Sphere(new Vector3(r.sphere[0], r.sphere[1], r.sphere[2]), r.sphere[3]);
    const mesh = new Mesh(g, this.material);
    mesh.customDepthMaterial = this.depthMaterial;
    mesh.castShadow = n.level >= 7;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.name = `chunk ${r.key}`;
    frame.register(mesh, r.anchorS, r.anchorZ);
    this.group.add(mesh);
    n.mesh = mesh;
    if (r.water) {
      const wg = new BufferGeometry();
      wg.setAttribute('position', new BufferAttribute(r.water.position, 3));
      wg.setAttribute('aFlow', new BufferAttribute(r.water.flow, 2));
      wg.setAttribute('aDepth', new BufferAttribute(r.water.depth, 1));
      wg.setAttribute('aKind', new BufferAttribute(r.water.kind, 1));
      wg.setIndex(new BufferAttribute(r.water.index, 1));
      wg.boundingSphere = g.boundingSphere.clone();
      const wm = new Mesh(wg, this.waterMaterial);
      wm.visible = false;
      wm.renderOrder = 10;
      wm.name = `water ${r.key}`;
      frame.register(wm, r.anchorS, r.anchorZ);
      this.group.add(wm);
      n.water = wm;
    }
    if (r.trees && r.trees.length > 0) {
      n.trees = this.trees.add(r.trees, r.anchorS, r.anchorZ, r.level);
      if (n.trees) n.trees.visible = false;
    }
    n.hMin = r.hMin;
    n.hMax = r.hMax;
    n.ready = true;
  }

  private onFarShell(r: FarShellResult) {
    const { ns, nz } = r;
    const dS = CIRC / ns;
    const dZ = (Z_MAX - Z_MIN) / nz;
    const count = (ns + 1) * (nz + 1);
    const pos = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i <= ns; i++) {
        const k = j * (ns + 1) + i;
        pos[k * 3] = i * dS;
        pos[k * 3 + 1] = Math.max(r.height[k], r.water[k]) - 6;
        pos[k * 3 + 2] = j * dZ;
      }
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i <= ns; i++) {
        const k = j * (ns + 1) + i;
        const il = i > 0 ? k - 1 : k + ns - 1;
        const ir = i < ns ? k + 1 : k - ns + 1;
        const jd = j > 0 ? k - (ns + 1) : k;
        const ju = j < nz ? k + (ns + 1) : k;
        const gx = (pos[ir * 3 + 1] - pos[il * 3 + 1]) / (2 * dS);
        const gz = (pos[ju * 3 + 1] - pos[jd * 3 + 1]) / (dZ * (j > 0 && j < nz ? 2 : 1));
        const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
        nrm[k * 3] = -gx * inv;
        nrm[k * 3 + 1] = inv;
        nrm[k * 3 + 2] = -gz * inv;
      }
    const idx = new Uint32Array(ns * nz * 6);
    let p = 0;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < ns; i++) {
        const a = j * (ns + 1) + i;
        const b = a + 1;
        const c = a + ns + 1;
        const d = c + 1;
        idx[p++] = a;
        idx[p++] = c;
        idx[p++] = d;
        idx[p++] = a;
        idx[p++] = d;
        idx[p++] = b;
      }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setAttribute('aColor', new BufferAttribute(r.color, 4, true));
    g.setIndex(new BufferAttribute(idx, 1));
    g.boundingSphere = new Sphere(new Vector3(0, R, 0), R * 8);
    const mesh = new Mesh(g, this.farMaterial);
    mesh.frustumCulled = false;
    mesh.name = 'far shell';
    frame.register(mesh, 0, Z_MIN);
    this.group.add(mesh);
    this.farShell = mesh;
  }

  /** Vertex arrays of a ready finest-level chunk (for grass). */
  fineChunk(is: number, iz: number) {
    const n = this.nodes.get(`${MAX_LEVEL}:${is}:${iz}`);
    if (!n || !n.ready || !n.mesh) return null;
    const g = n.mesh.geometry;
    return {
      pos: g.getAttribute('position').array,
      color: g.getAttribute('aColor').array,
      mat: g.getAttribute('aMat').array,
    };
  }

  /** True once the chunks around the camera are ready to show. */
  isSettled(cam: CameraState): boolean {
    const { cis, ciz } = this.nearBounds(cam);
    const root = this.nodes.get(`0:${cis}:${ciz}`);
    if (!root || !root.ready) return false;
    // is the finest level under the camera ready?
    return this.pool.pending === 0 || this.visibleSet.some((n) => n.level >= MAX_LEVEL - 1 && this.dist(n, cam) < 1);
  }
}

// ---------------------------------------------------------------------------

/** Shared grid index: (N+1)² grid, then 4 skirt strips (both windings). */
function buildGridIndex(N: number): BufferAttribute {
  const V = (N + 1) * (N + 1);
  const tris: number[] = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + (N + 1);
      const d = c + 1;
      tris.push(a, c, d, a, d, b);
    }
  // skirts: edge lists in the same order as chunkBuilder
  const edges: number[][] = [[], [], [], []];
  for (let i = 0; i <= N; i++) edges[0].push(i);
  for (let i = 0; i <= N; i++) edges[1].push(N * (N + 1) + i);
  for (let j = 0; j <= N; j++) edges[2].push(j * (N + 1));
  for (let j = 0; j <= N; j++) edges[3].push(j * (N + 1) + N);
  let sv = V;
  for (const e of edges) {
    for (let k = 0; k < e.length - 1; k++) {
      const t0 = e[k];
      const t1 = e[k + 1];
      const b0 = sv + k;
      const b1 = sv + k + 1;
      tris.push(t0, b0, b1, t0, b1, t1);
      tris.push(t0, b1, b0, t0, t1, b1);
    }
    sv += e.length;
  }
  return new BufferAttribute(new Uint16Array(tris), 1);
}

const farUniforms = {
  uNearS: { value: new Vector2() },
  uNearZ: { value: new Vector2() },
};

function createFarShellMaterial(): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ color: 0xffffff });
  patchWorldMaterial(m, {
    key: 'farshell',
    bend: true,
    uniforms: farUniforms,
    vertexPars: `attribute vec4 aColor; varying vec4 vFColor;`,
    vertexBegin: `vFColor = vec4(pow(aColor.rgb, vec3(2.2)), aColor.a);`,
    fragmentPars: `uniform vec2 uNearS; uniform vec2 uNearZ; varying vec4 vFColor;`,
    fragmentColor: `
      {
        float dsf = uR * atan(vHrWorld.x, uR - vHrWorld.y);
        if (dsf > uNearS.x && dsf < uNearS.y && vHrWorld.z > uNearZ.x && vHrWorld.z < uNearZ.y) discard;
        diffuseColor.rgb *= vFColor.rgb;
      }
    `,
  });
  return m;
}
