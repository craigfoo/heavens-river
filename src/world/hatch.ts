// The hillside maintenance hatch at the arrival point (spec 8.5): a weathered
// concrete portal block half-buried in a turf berm, sliding steel doors, a
// warm lamp, a keypad and a plaque. The intro hands control over here.

import { BufferAttribute, BufferGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, SRGBColorSpace, type Material } from 'three';
import { frame, wrapS } from '../coords/cylinder';
import { clamp, damp } from '../core/math';
import { patchWorldMaterial } from '../render/bend';
import { lin, MeshBuilder, SURF, type V3 } from '../towns/meshBuilder';
import { createTownDepthMaterial, createTownMaterial } from '../towns/townMaterial';
import { drawGlyphWord } from '../ui/glyphs';
import { HATCH, type WorldGen } from './gen/world';

const CONCRETE: V3 = lin('#b4aea2');
const CONCRETE_DARK: V3 = lin('#8e887d');
const STEEL: V3 = lin('#46505c');
const PANEL: V3 = lin('#c9c6bf');
const YELLOW: V3 = lin('#d6a22a');
const BLACK: V3 = lin('#1c1b1a');

const DOOR_W = 1.3; // half width of the opening
const DOOR_H = 2.8;

export class Hatch {
  readonly group = new Group();
  private meshes: Mesh[] = [];
  private leaves: Mesh[] = [];
  private material = createTownMaterial();
  private depth = createTownDepthMaterial();
  private glowMat: Material;
  private signMat: MeshBasicMaterial | null = null;
  s = 0;
  z = 0;
  yaw = 0;
  base = 0;
  active = false;
  /** 0 closed .. 1 open. */
  open = 0;
  openTarget = 0;

  constructor() {
    this.glowMat = patchWorldMaterial(new MeshBasicMaterial({ vertexColors: true }), { key: 'hatch-glow', bend: true });
  }

  build(gen: WorldGen) {
    for (const m of this.meshes) {
      frame.unregister(m);
      m.geometry.dispose();
    }
    this.meshes = [];
    this.leaves = [];
    this.group.clear();
    const hc = gen.hatch;
    this.active = !!hc;
    if (!hc) return;
    this.s = hc.s;
    this.z = hc.z;
    this.yaw = hc.yaw;
    this.base = hc.base;
    const rot = -hc.yaw;
    const W = HATCH.halfW;
    const D = HATCH.depth;
    const H = HATCH.height;

    // ---- the block
    const mb = new MeshBuilder();
    mb.frame(0, hc.base, 0, rot);
    mb.box(-W, -3, 0, -DOOR_W, H, D, CONCRETE, SURF.plain, SURF.turf, 0.3, false, lin('#4f6a2e'));
    mb.box(DOOR_W, -3, 0, W, H, D, CONCRETE, SURF.plain, SURF.turf, 0.3, false, lin('#4f6a2e'));
    mb.box(-DOOR_W, DOOR_H, 0, DOOR_W, H, D, CONCRETE, SURF.plain, SURF.turf, 0.3, false, lin('#4f6a2e'));
    // cornice and door frame
    mb.box(-W - 0.3, H - 0.35, -0.35, W + 0.3, H + 0.05, D + 0.3, CONCRETE_DARK, SURF.plain, SURF.turf, 0.3, false, lin('#56702f'));
    mb.box(-DOOR_W - 0.25, 0, -0.12, -DOOR_W, DOOR_H + 0.25, 0, CONCRETE_DARK, SURF.plain, SURF.plain, 0.3);
    mb.box(DOOR_W, 0, -0.12, DOOR_W + 0.25, DOOR_H + 0.25, 0, CONCRETE_DARK, SURF.plain, SURF.plain, 0.3);
    mb.box(-DOOR_W - 0.25, DOOR_H, -0.12, DOOR_W + 0.25, DOOR_H + 0.25, 0, CONCRETE_DARK, SURF.plain, SURF.plain, 0.3);
    // hazard stripes along the lintel
    for (let i = 0; i < 10; i++) {
      const x0 = -DOOR_W + (i / 10) * DOOR_W * 2;
      const x1 = -DOOR_W + ((i + 1) / 10) * DOOR_W * 2;
      mb.quad([x1, DOOR_H + 0.02, -0.125], [x0, DOOR_H + 0.02, -0.125], [x0, DOOR_H + 0.23, -0.125], [x1, DOOR_H + 0.23, -0.125], i % 2 ? BLACK : YELLOW, SURF.plain, 0.2);
    }
    // threshold, floor, inner walls and the inner door of the airlock
    mb.box(-DOOR_W, -3, -0.1, DOOR_W, 0.06, D, CONCRETE_DARK, SURF.plain, SURF.plain, 0.3);
    mb.box(-DOOR_W, 0.06, 2.7, DOOR_W, DOOR_H, D, PANEL, SURF.plain, SURF.plain, 0.2);
    mb.box(-0.6, 0.06, 2.62, 0.6, 2.25, 2.7, STEEL, SURF.plain, SURF.plain, 0.2);
    // apron slab and the retaining wing walls that hold back the berm
    mb.box(-W + 0.4, -0.5, -4.2, W - 0.4, 0.07, 0, CONCRETE_DARK, SURF.plain, SURF.plain, 0.25);
    for (const sx of [-1, 1]) {
      const x0 = sx * W;
      const x1 = sx * (W + 6.2);
      const t0 = HATCH.berm + 0.5;
      const t1 = 0.2;
      const zf = -0.45;
      const zb = 0.35;
      const a = sx < 0;
      // front face, top and end cap (a prism with a sloping top)
      const P = (x: number, y: number, z: number): V3 => [x, y, z];
      const f0 = P(x0, -2, zf);
      const f1 = P(x1, -2, zf);
      const f2 = P(x1, t1, zf);
      const f3 = P(x0, t0, zf);
      const b0 = P(x0, -2, zb);
      const b1 = P(x1, -2, zb);
      const b2 = P(x1, t1, zb);
      const b3 = P(x0, t0, zb);
      if (a) {
        mb.quad(f0, f1, f2, f3, CONCRETE, SURF.plain, 0.3);
        mb.quad(f3, f2, b2, b3, CONCRETE_DARK, SURF.plain, 0.3);
        mb.quad(f2, f1, b1, b2, CONCRETE, SURF.plain, 0.3);
        mb.quad(b1, b0, b3, b2, CONCRETE, SURF.plain, 0.3);
      } else {
        mb.quad(f1, f0, f3, f2, CONCRETE, SURF.plain, 0.3);
        mb.quad(f3, b3, b2, f2, CONCRETE_DARK, SURF.plain, 0.3);
        mb.quad(f1, f2, b2, b1, CONCRETE, SURF.plain, 0.3);
        mb.quad(b0, b1, b2, b3, CONCRETE, SURF.plain, 0.3);
      }
    }
    this.add(this.meshFrom(mb), hc.s, hc.z);

    // ---- sliding door leaves (separate so they can move)
    for (const sx of [-1, 1]) {
      const d = new MeshBuilder();
      d.frame(0, hc.base, 0, rot);
      const x0 = sx < 0 ? -DOOR_W : 0;
      const x1 = sx < 0 ? 0 : DOOR_W;
      d.box(x0, 0.06, 0.3, x1, DOOR_H, 0.45, STEEL, SURF.plain, SURF.plain, 0.3);
      for (let i = 0; i < 6; i++) {
        const a0 = x0 + ((x1 - x0) * i) / 6;
        const a1 = x0 + ((x1 - x0) * (i + 1)) / 6;
        d.quad([a1, 0.1, 0.295], [a0, 0.1, 0.295], [a0, 0.4, 0.295], [a1, 0.4, 0.295], i % 2 ? BLACK : YELLOW, SURF.plain, 0.2);
      }
      // a narrow viewing slit
      const cx = sx * DOOR_W * 0.5;
      d.quad([cx + 0.08, 1.5, 0.295], [cx - 0.08, 1.5, 0.295], [cx - 0.08, 2.1, 0.295], [cx + 0.08, 2.1, 0.295], BLACK, SURF.dark, 0.1);
      const leaf = this.meshFrom(d);
      this.leaves.push(leaf);
      this.add(leaf, hc.s, hc.z);
    }

    // ---- glowing bits: lamp over the door, keypad light, airlock ceiling strip
    const g = new MeshBuilder();
    g.frame(0, hc.base, 0, rot);
    g.box(-0.45, DOOR_H + 0.4, -0.3, 0.45, DOOR_H + 0.62, -0.05, [6, 3.8, 1.6], SURF.plain);
    g.box(DOOR_W + 0.45, 1.25, -0.08, DOOR_W + 0.62, 1.42, 0, [0.3, 3.2, 0.6], SURF.plain);
    g.box(-0.9, DOOR_H - 0.06, 0.8, 0.9, DOOR_H - 0.02, 2.4, [3.2, 3.4, 3.6], SURF.plain);
    this.add(this.glowFrom(g), hc.s, hc.z);

    // ---- the plaque
    const sign = this.signMesh(rot);
    this.add(sign, hc.s, hc.z);
    this.open = this.openTarget;
    this.placeLeaves();
  }

  private add(m: Mesh, s: number, z: number) {
    frame.register(m, s, z);
    this.meshes.push(m);
    this.group.add(m);
  }

  private meshFrom(mb: MeshBuilder): Mesh {
    const g = new BufferGeometry();
    const nV = mb.vertexCount;
    const col = new Uint8Array(nV * 4);
    for (let i = 0; i < nV; i++) {
      for (let k = 0; k < 3; k++) col[i * 4 + k] = Math.round(Math.pow(clamp(mb.col[i * 3 + k], 0, 1), 1 / 2.2) * 255);
      col[i * 4 + 3] = 255;
    }
    // builder (a, h, c) -> anchor-local unrolled (x = s, y = h, z = z): identity
    g.setAttribute('position', new BufferAttribute(new Float32Array(mb.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(mb.nrm), 3));
    g.setAttribute('aColor', new BufferAttribute(col, 4, true));
    g.setAttribute('aSurf', new BufferAttribute(new Float32Array(mb.surf), 4));
    g.setIndex(mb.idx);
    g.computeBoundingSphere();
    const m = new Mesh(g, this.material);
    m.castShadow = true;
    m.receiveShadow = true;
    m.customDepthMaterial = this.depth;
    m.name = 'maintenance hatch';
    return m;
  }

  private glowFrom(mb: MeshBuilder): Mesh {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(mb.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(mb.col), 3));
    g.setIndex(mb.idx);
    g.computeBoundingSphere();
    return new Mesh(g, this.glowMat);
  }

  private signMesh(rot: number): Mesh {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#2a2f36';
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = '#c9a24a';
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, 492, 236);
    drawGlyphWord(ctx, 'kelanumeri', 40, 100, { color: '#e8d6a8', size: 58, riverLine: true });
    ctx.fillStyle = '#e8d6a8';
    ctx.font = '600 34px Inter, system-ui, sans-serif';
    ctx.fillText('MAINTENANCE 07', 40, 170);
    ctx.font = '500 24px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#b8ad96';
    ctx.fillText('Crew access only · by order of Anek', 40, 214);
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    this.signMat = patchWorldMaterial(new MeshBasicMaterial({ map: tex }), { key: 'hatch-sign', bend: true });
    // plane on the facade, right of the door (texture v runs up)
    const mb = new MeshBuilder();
    mb.frame(0, this.base, 0, rot);
    const x0 = DOOR_W + 0.55;
    const x1 = x0 + 2.0;
    mb.quad([x1, 1.75, -0.02], [x0, 1.75, -0.02], [x0, 2.75, -0.02], [x1, 2.75, -0.02], [1, 1, 1], SURF.plain, 0, [0, 0, 1, 1]);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(mb.pos), 3));
    const uv = new Float32Array((mb.pos.length / 3) * 2);
    for (let i = 0; i < mb.pos.length / 3; i++) {
      uv[i * 2] = mb.surf[i * 4 + 1];
      uv[i * 2 + 1] = mb.surf[i * 4 + 2];
    }
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    g.setIndex(mb.idx);
    g.computeBoundingSphere();
    return new Mesh(g, this.signMat);
  }

  private placeLeaves() {
    // slide each leaf along the facade (local x) into the piers
    const lx = Math.cos(this.yaw);
    const lz = -Math.sin(this.yaw);
    const d = this.open * (DOOR_W - 0.05);
    this.leaves.forEach((m, i) => {
      const sx = i === 0 ? -1 : 1;
      frame.register(m, this.s + lx * d * sx, this.z + lz * d * sx);
    });
  }

  /** Door-front position and facing, for spawning and interaction. */
  doorstep(dist = 2.5): { s: number; z: number; yaw: number } {
    const fs = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    return { s: this.s + fs * dist, z: this.z + fz * dist, yaw: this.yaw };
  }

  /** Metres from (s, z) to the door. */
  distance(s: number, z: number): number {
    const p = this.doorstep(0.3);
    return Math.hypot(wrapS(s - p.s), z - p.z);
  }

  update(dt: number, playerS: number, playerZ: number) {
    if (!this.active) return;
    // the doors close behind you once you have stepped out
    if (this.openTarget > 0 && this.distance(playerS, playerZ) > 7) this.openTarget = 0;
    const o = damp(this.open, this.openTarget, 2.2, dt);
    if (Math.abs(o - this.open) > 1e-4) {
      this.open = Math.abs(o - this.openTarget) < 0.002 ? this.openTarget : o;
      this.placeLeaves();
    }
  }
}
