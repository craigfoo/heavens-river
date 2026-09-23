// Streams settlements in and out around the camera, swaps per-tile LODs, and
// answers collision / floor / point-of-interest queries for gameplay.

import { BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3, type Material } from 'three';
import { frame, wrapS } from '../coords/cylinder';
import type { TownSite } from '../world/gen/settlements';
import type { WorldGen } from '../world/gen/world';
import type { TerrainWorkerPool } from '../world/terrain/workerPool';
import type { Collider } from '../world/worldQuery';
import type { TownMesh, TownPoi, TownResult } from './townBuilder';
import { createTownDepthMaterial, createTownMaterial } from './townMaterial';

interface TileMeshes {
  near: Mesh;
  far: Mesh;
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

export interface LoadedTown {
  site: TownSite;
  anchorS: number;
  anchorZ: number;
  tiles: TileMeshes[];
  colliders: Float32Array;
  floors: Float32Array;
  waypoints: Float32Array;
  perches: Float32Array;
  poi: TownPoi;
  colGrid: Map<number, number[]>;
  floorGrid: Map<number, number[]>;
  buildingCount: number;
  lastUsed: number;
}

const GRID = 16;
const key = (i: number, j: number) => (i + 50_000) * 100_000 + (j + 50_000);

/** Distance (m) at which each kind of settlement is loaded and drawn. */
const LOAD_DIST = { hamlet: 2600, town: 6500, city: 12000 };
const NEAR_DIST = 520;

export class TownManager implements Collider {
  readonly group = new Group();
  private material: Material;
  private depth: Material;
  private loaded = new Map<number, LoadedTown>();
  private pool: TerrainWorkerPool;
  gen: WorldGen;
  private frameNo = 0;
  onLoaded: ((t: LoadedTown) => void)[] = [];
  onUnloaded: ((t: LoadedTown) => void)[] = [];
  stats = { loaded: 0, tris: 0 };

  constructor(pool: TerrainWorkerPool, gen: WorldGen) {
    this.pool = pool;
    this.gen = gen;
    this.material = createTownMaterial();
    this.depth = createTownDepthMaterial();
    this.pool.onTown = (r) => this.onResult(r);
    this.group.name = 'towns';
  }

  setGen(gen: WorldGen) {
    for (const t of [...this.loaded.values()]) this.unload(t);
    this.gen = gen;
  }

  get(siteId: number): LoadedTown | undefined {
    return this.loaded.get(siteId);
  }

  isLoaded(siteId: number) {
    return this.loaded.has(siteId);
  }

  /** Ask for a town now (e.g. before a cutscene arrival). */
  request(siteId: number) {
    if (!this.loaded.has(siteId)) this.pool.requestTown(siteId, true);
  }

  update(camS: number, camZ: number, camRender: Vector3) {
    this.frameNo++;
    // which towns should be resident
    if (this.frameNo % 15 === 1) {
      const want = new Set<number>();
      const cand: { id: number; d: number }[] = [];
      for (const site of this.gen.towns) {
        const dz = Math.abs(site.z - camZ);
        const lim = LOAD_DIST[site.kind] + site.radius;
        if (dz > lim) continue;
        const d = Math.hypot(wrapS(site.s - camS), dz) - site.radius;
        if (d < LOAD_DIST[site.kind]) {
          want.add(site.id);
          if (!this.loaded.has(site.id)) cand.push({ id: site.id, d });
        }
      }
      cand.sort((a, b) => a.d - b.d);
      for (const c of cand.slice(0, 6)) this.pool.requestTown(c.id, c.d < 800);
      this.pool.pruneTowns((id) => want.has(id));
      for (const t of this.loaded.values()) if (want.has(t.site.id)) t.lastUsed = this.frameNo;
      // unload stale towns (keep a little hysteresis)
      for (const t of [...this.loaded.values()]) if (this.frameNo - t.lastUsed > 600) this.unload(t);
    }
    // per-tile LOD
    let tris = 0;
    for (const t of this.loaded.values()) {
      const dsA = wrapS(t.anchorS - frame.originS);
      const dzA = t.anchorZ - frame.originZ;
      for (const tile of t.tiles) {
        // approximate render-frame position of the tile centre (flat approx is fine for LOD)
        const dx = dsA + tile.cx - camRender.x;
        const dz = dzA + tile.cz - camRender.z;
        const d = Math.max(0, Math.hypot(dx, dz) - tile.radius * 0.5);
        const near = d < NEAR_DIST;
        const vis = d < LOAD_DIST[t.site.kind] + 1500;
        tile.near.visible = vis && near;
        tile.far.visible = vis && !near;
        if (tile.near.visible) tris += (tile.near.geometry.index?.count ?? 0) / 3;
        else if (tile.far.visible) tris += (tile.far.geometry.index?.count ?? 0) / 3;
      }
    }
    this.stats.loaded = this.loaded.size;
    this.stats.tris = tris;
  }

  private meshFrom(m: TownMesh, t: TownResult, tile: { cx: number; cy: number; cz: number; radius: number }): Mesh {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.position, 3));
    g.setAttribute('normal', new BufferAttribute(m.normal, 4, true));
    g.setAttribute('aColor', new BufferAttribute(m.color, 4, true));
    g.setAttribute('aSurf', new BufferAttribute(m.surf, 4));
    g.setIndex(new BufferAttribute(m.index, 1));
    g.boundingSphere = new Sphere(new Vector3(tile.cx, tile.cy, tile.cz), tile.radius);
    const mesh = new Mesh(g, this.material);
    mesh.customDepthMaterial = this.depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    frame.register(mesh, t.anchorS, t.anchorZ);
    this.group.add(mesh);
    return mesh;
  }

  private onResult(r: TownResult) {
    const site = this.gen.towns.find((s) => s.id === r.siteId);
    if (!site || this.loaded.has(r.siteId)) return;
    const tiles: TileMeshes[] = r.tiles.map((tile) => {
      const near = this.meshFrom(tile.near, r, tile);
      const far = tile.far === tile.near ? near : this.meshFrom(tile.far, r, tile);
      near.name = `town ${site.name} near`;
      far.name = `town ${site.name} far`;
      return { near, far, cx: tile.cx, cy: tile.cy, cz: tile.cz, radius: tile.radius };
    });
    const colGrid = new Map<number, number[]>();
    for (let i = 0; i < r.colliders.length / 10; i++) {
      let mnx = Infinity;
      let mxx = -Infinity;
      let mnz = Infinity;
      let mxz = -Infinity;
      for (let k = 0; k < 4; k++) {
        const x = r.colliders[i * 10 + k * 2];
        const z = r.colliders[i * 10 + k * 2 + 1];
        mnx = Math.min(mnx, x);
        mxx = Math.max(mxx, x);
        mnz = Math.min(mnz, z);
        mxz = Math.max(mxz, z);
      }
      for (let gi = Math.floor(mnx / GRID); gi <= Math.floor(mxx / GRID); gi++)
        for (let gj = Math.floor(mnz / GRID); gj <= Math.floor(mxz / GRID); gj++) {
          const k = key(gi, gj);
          let l = colGrid.get(k);
          if (!l) colGrid.set(k, (l = []));
          l.push(i);
        }
    }
    const floorGrid = new Map<number, number[]>();
    for (let i = 0; i < r.floors.length / 12; i++) {
      let mnx = Infinity;
      let mxx = -Infinity;
      let mnz = Infinity;
      let mxz = -Infinity;
      for (let k = 0; k < 4; k++) {
        const x = r.floors[i * 12 + k * 2];
        const z = r.floors[i * 12 + k * 2 + 1];
        mnx = Math.min(mnx, x);
        mxx = Math.max(mxx, x);
        mnz = Math.min(mnz, z);
        mxz = Math.max(mxz, z);
      }
      for (let gi = Math.floor(mnx / GRID); gi <= Math.floor(mxx / GRID); gi++)
        for (let gj = Math.floor(mnz / GRID); gj <= Math.floor(mxz / GRID); gj++) {
          const k = key(gi, gj);
          let l = floorGrid.get(k);
          if (!l) floorGrid.set(k, (l = []));
          l.push(i);
        }
    }
    const t: LoadedTown = {
      site,
      anchorS: r.anchorS,
      anchorZ: r.anchorZ,
      tiles,
      colliders: r.colliders,
      floors: r.floors,
      waypoints: r.waypoints,
      perches: r.perches,
      poi: r.poi,
      colGrid,
      floorGrid,
      buildingCount: r.buildingCount,
      lastUsed: this.frameNo,
    };
    this.loaded.set(r.siteId, t);
    for (const f of this.onLoaded) f(t);
  }

  private unload(t: LoadedTown) {
    for (const tile of t.tiles) {
      for (const m of new Set([tile.near, tile.far])) {
        this.group.remove(m);
        frame.unregister(m);
        m.geometry.dispose();
      }
    }
    this.loaded.delete(t.site.id);
    for (const f of this.onUnloaded) f(t);
  }

  // ------------------------------------------------------------ gameplay queries

  private local(t: LoadedTown, s: number, z: number) {
    return { x: wrapS(s - t.anchorS), z: z - t.anchorZ };
  }

  /** Push a circle out of building footprints (Collider interface). */
  resolve(s: number, z: number, h: number, radius: number, out: { s: number; z: number; floor: number }) {
    for (const t of this.loaded.values()) {
      if (Math.abs(z - t.site.z) > t.site.radius + 200) continue;
      const p = this.local(t, s, z);
      if (Math.abs(p.x) > t.site.radius + 400) continue;
      const list = t.colGrid.get(key(Math.floor(p.x / GRID), Math.floor(p.z / GRID)));
      if (!list) continue;
      let px = p.x;
      let pz = p.z;
      for (const i of list) {
        const c = t.colliders;
        const b = i * 10;
        if (h > c[b + 9] || h + 1.0 < c[b + 8]) continue;
        const r = pushOutQuad(c, b, px, pz, radius);
        if (r) {
          px = r[0];
          pz = r[1];
        }
      }
      out.s = t.anchorS + px;
      out.z = t.anchorZ + pz;
      s = out.s;
      z = out.z;
    }
  }

  /** Highest walkable structure surface under (s, z) that is not above h + step. */
  floorAt(s: number, z: number, h: number, step = 0.6): number | null {
    let best: number | null = null;
    for (const t of this.loaded.values()) {
      if (Math.abs(z - t.site.z) > t.site.radius + 200) continue;
      const p = this.local(t, s, z);
      const list = t.floorGrid.get(key(Math.floor(p.x / GRID), Math.floor(p.z / GRID)));
      if (!list) continue;
      for (const i of list) {
        const y = floorHeight(t.floors, i * 12, p.x, p.z);
        if (y !== null && y <= h + step && (best === null || y > best)) best = y;
      }
    }
    return best;
  }

  /** World position of a town's point of interest. */
  poiWorld(t: LoadedTown, which: keyof TownPoi): { s: number; z: number; h: number; yaw: number } {
    const p = t.poi[which];
    return { s: t.anchorS + p[0], z: t.anchorZ + p[1], h: p[2], yaw: p.length > 3 ? (p as number[])[3] : 0 };
  }

  /** Nearest loaded or unloaded settlement to (s, z). */
  nearest(s: number, z: number): { site: TownSite; dist: number } | null {
    let best: { site: TownSite; dist: number } | null = null;
    for (const site of this.gen.towns) {
      const dz = site.z - z;
      if (best && Math.abs(dz) > best.dist + site.radius) continue;
      const d = Math.hypot(wrapS(site.s - s), dz);
      if (!best || d < best.dist) best = { site, dist: d };
    }
    return best;
  }

  loadedTowns() {
    return this.loaded.values();
  }
}

/** Circle vs convex quad (corners at c[b..b+7]); returns pushed centre or null. */
function pushOutQuad(c: Float32Array, b: number, x: number, z: number, r: number): [number, number] | null {
  let inside = true;
  let bestD = Infinity;
  let bx = 0;
  let bz = 0;
  // orientation of the quad
  const ax = c[b + 2] - c[b];
  const az = c[b + 3] - c[b + 1];
  const cx = c[b + 6] - c[b];
  const cz = c[b + 7] - c[b + 1];
  const orient = Math.sign(ax * cz - az * cx) || 1;
  for (let k = 0; k < 4; k++) {
    const x0 = c[b + k * 2];
    const z0 = c[b + k * 2 + 1];
    const x1 = c[b + ((k + 1) % 4) * 2];
    const z1 = c[b + ((k + 1) % 4) * 2 + 1];
    const ex = x1 - x0;
    const ez = z1 - z0;
    const side = (ex * (z - z0) - ez * (x - x0)) * orient;
    if (side < 0) inside = false;
    const l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? ((x - x0) * ex + (z - z0) * ez) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = x0 + ex * t;
    const qz = z0 + ez * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < bestD) {
      bestD = d;
      bx = qx;
      bz = qz;
    }
  }
  if (inside) {
    // push out through the nearest edge
    const dx = bx - x;
    const dz = bz - z;
    const l = Math.hypot(dx, dz) || 1;
    return [bx + (dx / l) * r, bz + (dz / l) * r];
  }
  if (bestD < r) {
    const dx = x - bx;
    const dz = z - bz;
    const l = bestD || 1;
    return [bx + (dx / l) * r, bz + (dz / l) * r];
  }
  return null;
}

/** Barycentric height inside a floor quad (two triangles), or null if outside. */
function floorHeight(f: Float32Array, b: number, x: number, z: number): number | null {
  const P = [0, 1, 2, 3].map((k) => [f[b + k * 2], f[b + k * 2 + 1], f[b + 8 + k]]);
  for (const [i, j, k] of [
    [0, 1, 2],
    [0, 2, 3],
  ]) {
    const [x0, z0, h0] = P[i];
    const [x1, z1, h1] = P[j];
    const [x2, z2, h2] = P[k];
    const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(det) < 1e-9) continue;
    const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / det;
    const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / det;
    const l2 = 1 - l0 - l1;
    if (l0 >= -1e-4 && l1 >= -1e-4 && l2 >= -1e-4) return l0 * h0 + l1 * h1 + l2 * h2;
  }
  return null;
}
