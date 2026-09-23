// River tunnel portals. Each main river emerges from a great arch at the head
// of its upstream gorge and vanishes into another at the downstream end; the
// tunnels run beneath the barrier crest into the neighbouring section.
// (Not canon: the books leave river behaviour at the barriers unspecified.)

import { BufferAttribute, BufferGeometry, Group, Mesh } from 'three';
import { frame, wrapS } from '../coords/cylinder';
import { clamp } from '../core/math';
import { lin, MeshBuilder, SURF, type V3 } from '../towns/meshBuilder';
import { createTownMaterial } from '../towns/townMaterial';
import type { WorldGen } from './gen/world';

export interface Portal {
  river: number;
  /** +1: the portal at the section's far end (z = zEnd), -1: near end. */
  end: 1 | -1;
  s: number;
  z: number;
  level: number;
  width: number;
}

const STONE: V3 = lin('#8e8a84');
const DARKSTONE: V3 = lin('#5e5a56');
const TRIM: V3 = lin('#c8a860');
const VOID: V3 = [0.004, 0.004, 0.006];

export class Portals {
  readonly group = new Group();
  list: Portal[] = [];
  private material = createTownMaterial();

  build(gen: WorldGen) {
    for (const m of this.group.children as Mesh[]) {
      frame.unregister(m);
      m.geometry.dispose();
    }
    this.group.clear();
    this.list = [];
    for (const rv of gen.rivers) {
      for (const end of [-1, 1] as const) {
        const zEdge = end < 0 ? rv.zStart : rv.zEnd;
        const z = zEdge + end * 150;
        const s = rv.channelAt(zEdge);
        const width = rv.widthAt(zEdge) * 1.25 + 30;
        const level = rv.levelAt(zEdge);
        this.list.push({ river: rv.index, end, s, z, level, width });
        const mesh = this.makeArch(width, level, end, gen, s, z);
        frame.register(mesh, s, z);
        this.group.add(mesh);
      }
    }
  }

  /** Arch geometry in the portal's anchor frame; faces the section interior. */
  private makeArch(width: number, level: number, end: 1 | -1, gen: WorldGen, s: number, z: number): Mesh {
    const mb = new MeshBuilder();
    // local frame: x across the river, z along it; the section interior is toward -end*z
    const rot = end > 0 ? 0 : Math.PI;
    mb.frame(0, 0, 0, rot);
    const hw = width / 2;
    const archR = hw;
    const pier = clamp(width * 0.12, 14, 60);
    const depth = 40;
    const base = level - 12;
    const spring = level + 6;
    const top = spring + archR + pier * 0.8;
    const ground = Math.max(gen.heightAt(s + hw + pier, z), gen.heightAt(s - hw - pier, z));
    const crown = Math.max(top + 30, ground + 20);
    // piers
    mb.box(-hw - pier, base, -depth / 2, -hw, crown, depth / 2, STONE, SURF.stone, SURF.stone, 0.31);
    mb.box(hw, base, -depth / 2, hw + pier, crown, depth / 2, STONE, SURF.stone, SURF.stone, 0.31);
    // arch ring (voussoirs) and the wall above it
    const n = 28;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI * (i / n);
      const a1 = Math.PI * ((i + 1) / n);
      const x0 = Math.cos(a0) * archR;
      const y0 = spring + Math.sin(a0) * archR;
      const x1 = Math.cos(a1) * archR;
      const y1 = spring + Math.sin(a1) * archR;
      const r2 = archR + pier * 0.55;
      const X0 = Math.cos(a0) * r2;
      const Y0 = spring + Math.sin(a0) * r2;
      const X1 = Math.cos(a1) * r2;
      const Y1 = spring + Math.sin(a1) * r2;
      const zf = -depth / 2;
      // front face of the ring (toward -z local)
      mb.quad([x0, y0, zf], [x1, y1, zf], [X1, Y1, zf], [X0, Y0, zf], i % 2 ? STONE : DARKSTONE, SURF.stone, 0.37);
      // intrados (underside, facing the opening)
      mb.quad([x1, y1, zf], [x0, y0, zf], [x0, y0, depth / 2], [x1, y1, depth / 2], DARKSTONE, SURF.stone, 0.39);
      // spandrel wall up to the crown
      mb.quad([X0, Y0, zf], [X1, Y1, zf], [X1, crown, zf], [X0, crown, zf], STONE, SURF.stone, 0.31);
    }
    // gilded keystone band and cornice
    mb.box(-hw - pier - 2, crown - 3, -depth / 2 - 2, hw + pier + 2, crown, depth / 2, TRIM, SURF.gold, SURF.stone, 0.5);
    mb.box(-6, spring + archR - 2, -depth / 2 - 1.5, 6, spring + archR + pier * 0.6, -depth / 2 + 1, TRIM, SURF.gold, SURF.gold, 0.5);
    // the tunnel: a dark receding vault
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI * (i / n);
      const a1 = Math.PI * ((i + 1) / n);
      const x0 = Math.cos(a0) * archR * 0.98;
      const y0 = spring + Math.sin(a0) * archR * 0.98;
      const x1 = Math.cos(a1) * archR * 0.98;
      const y1 = spring + Math.sin(a1) * archR * 0.98;
      mb.quad([x1, y1, depth / 2], [x0, y0, depth / 2], [x0, y0, depth / 2 + 900], [x1, y1, depth / 2 + 900], VOID, SURF.dark, 0.1);
    }
    mb.quad([-archR, base, depth / 2 + 900], [-archR, base, depth / 2], [-archR, spring, depth / 2], [-archR, spring, depth / 2 + 900], VOID, SURF.dark, 0.1);
    mb.quad([archR, base, depth / 2], [archR, base, depth / 2 + 900], [archR, spring, depth / 2 + 900], [archR, spring, depth / 2], VOID, SURF.dark, 0.1);
    // end wall of the tunnel, far inside
    mb.quad([archR, base, depth / 2 + 900], [-archR, base, depth / 2 + 900], [-archR, spring + archR, depth / 2 + 900], [archR, spring + archR, depth / 2 + 900], VOID, SURF.dark, 0.1);
    // flank walls tying into the gorge sides
    mb.box(-hw - pier - 120, base, -depth / 2 + 5, -hw - pier, crown - 10, depth / 2 + 30, DARKSTONE, SURF.stone, SURF.stone, 0.33);
    mb.box(hw + pier, base, -depth / 2 + 5, hw + pier + 120, crown - 10, depth / 2 + 30, DARKSTONE, SURF.stone, SURF.stone, 0.33);
    const g = new BufferGeometry();
    const nV = mb.vertexCount;
    const col = new Uint8Array(nV * 4);
    for (let i = 0; i < nV; i++) {
      for (let k = 0; k < 3; k++) col[i * 4 + k] = Math.round(Math.pow(clamp(mb.col[i * 3 + k], 0, 1), 1 / 2.2) * 255);
      col[i * 4 + 3] = 255;
    }
    // (a, h, c) builder frame -> anchor-local unrolled (x = s, y = h, z = z): identity
    g.setAttribute('position', new BufferAttribute(new Float32Array(mb.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(mb.nrm), 3));
    g.setAttribute('aColor', new BufferAttribute(col, 4, true));
    g.setAttribute('aSurf', new BufferAttribute(new Float32Array(mb.surf), 4));
    g.setIndex(mb.idx);
    g.computeBoundingSphere();
    const mesh = new Mesh(g, this.material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'river portal';
    return mesh;
  }

  /** Nearest portal within range of (s, z). */
  near(s: number, z: number, range: number): Portal | null {
    let best: Portal | null = null;
    let bd = range;
    for (const p of this.list) {
      const d = Math.hypot(wrapS(s - p.s), z - p.z);
      if (d < bd + p.width / 2) {
        bd = d;
        best = p;
      }
    }
    return best;
  }
}
