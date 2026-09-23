// The section map (M): a Quinlan painted chart of the unrolled section —
// a long strip with the four rivers running its length, towns as little
// illustrated icons, barrier ranges at either end. Pan with drag, zoom with
// the wheel; hover a town for details, click it to travel.

import { CIRC, L, Z_MAX, Z_MIN } from '../config';
import { wrapS } from '../coords/cylinder';
import type { MapResult } from '../world/terrain/chunkTypes';
import type { TownSite } from '../world/gen/settlements';
import type { WorldGen } from '../world/gen/world';
import { quinlanNumber } from '../world/gen/names';
import { drawNumeral, glyphImage } from './glyphs';

export interface MapContext {
  gen: WorldGen;
  section: number;
  player: { s: number; z: number; yaw: number };
  isKnown: (site: TownSite) => boolean;
  destination: number | null;
  currentTown: number | null;
}

export interface MapActions {
  float(site: TownSite): void;
  travel(site: TownSite): void;
  destination(site: TownSite): void;
  close(): void;
  canFloat(site: TownSite): { ok: boolean; note: string };
}

const INK = '#3b2a1a';
const INK_SOFT = 'rgba(59,42,26,0.55)';
const RIVER = '#2e5d86';
const PAPER = [233, 220, 190];

export class MapScreen {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private tooltip: HTMLDivElement;
  private panel: HTMLDivElement;
  private relief: HTMLCanvasElement | null = null;
  private paper: HTMLCanvasElement;
  private ctx: MapContext | null = null;
  private actions: MapActions;
  private scale = 1; // px per metre
  private ox = 0;
  private oy = 0;
  private drag: { x: number; y: number; ox: number; oy: number } | null = null;
  private hover: TownSite | null = null;
  private selected: TownSite | null = null;
  private dpr = 1;
  isOpen = false;

  constructor(parent: HTMLElement, actions: MapActions) {
    this.actions = actions;
    this.root = document.createElement('div');
    this.root.className = 'screen map-screen';
    parent.appendChild(this.root);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.root.appendChild(this.canvas);
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'map-tip';
    this.root.appendChild(this.tooltip);
    this.panel = document.createElement('div');
    this.panel.className = 'map-panel';
    this.root.appendChild(this.panel);
    const help = document.createElement('div');
    help.className = 'map-help';
    help.innerHTML = 'Drag to pan · Wheel to zoom · Click a town · <span class="key">M</span> close';
    this.root.appendChild(help);
    const close = document.createElement('button');
    close.className = 'btn map-close';
    close.textContent = 'Close';
    close.onclick = () => this.actions.close();
    this.root.appendChild(close);
    this.paper = this.makePaper();
    this.bind();
    window.addEventListener('resize', () => this.isOpen && this.resize());
  }

  private makePaper(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const g = c.getContext('2d')!;
    const img = g.createImageData(512, 512);
    for (let i = 0; i < 512 * 512; i++) {
      const n = (Math.random() + Math.random() + Math.random()) / 3;
      const fiber = Math.random() < 0.004 ? -30 : 0;
      img.data[i * 4] = PAPER[0] - 18 + n * 36 + fiber;
      img.data[i * 4 + 1] = PAPER[1] - 18 + n * 36 + fiber;
      img.data[i * 4 + 2] = PAPER[2] - 18 + n * 36 + fiber;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /** Paint the relief layer from worker data (watercolour on parchment). */
  setData(d: MapResult) {
    const c = document.createElement('canvas');
    c.width = d.nz;
    c.height = d.ns;
    const g = c.getContext('2d')!;
    const img = g.createImageData(d.nz, d.ns);
    const H = d.height;
    for (let j = 0; j < d.ns; j++)
      for (let i = 0; i < d.nz; i++) {
        const k = j * d.nz + i;
        const hx = H[j * d.nz + Math.min(i + 1, d.nz - 1)] - H[j * d.nz + Math.max(i - 1, 0)];
        const hy = H[Math.min(j + 1, d.ns - 1) * d.nz + i] - H[Math.max(j - 1, 0) * d.nz + i];
        const shade = Math.max(0.55, Math.min(1.25, 1 - (hx + hy) / 2600));
        let r = d.color[k * 4];
        let gg = d.color[k * 4 + 1];
        let b = d.color[k * 4 + 2];
        const forest = d.color[k * 4 + 3] / 255;
        // watercolour: desaturate and wash toward the paper tone
        const l = (r + gg + b) / 3;
        r = l + (r - l) * 0.75;
        gg = l + (gg - l) * 0.75;
        b = l + (b - l) * 0.75;
        const wash = 0.52 - forest * 0.1;
        r = r * (1 - wash) + PAPER[0] * wash;
        gg = gg * (1 - wash) + PAPER[1] * wash;
        b = b * (1 - wash) + PAPER[2] * wash;
        // high ground goes to umber, barrier peaks to grey-blue ink
        const h = H[k];
        if (h > 2500) {
          const t = Math.min(1, (h - 2500) / 9000);
          r = r * (1 - t) + 150 * t;
          gg = gg * (1 - t) + 150 * t;
          b = b * (1 - t) + 165 * t;
        }
        const w = d.water[k] / 255;
        r = r * (1 - w * 0.35) + 150 * w * 0.35;
        gg = gg * (1 - w * 0.35) + 185 * w * 0.35;
        b = b * (1 - w * 0.35) + 200 * w * 0.35;
        img.data[k * 4] = Math.min(255, r * shade);
        img.data[k * 4 + 1] = Math.min(255, gg * shade);
        img.data[k * 4 + 2] = Math.min(255, b * shade);
        img.data[k * 4 + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    this.relief = c;
    if (this.isOpen) this.draw();
  }

  open(ctx: MapContext) {
    this.ctx = ctx;
    this.isOpen = true;
    this.root.classList.add('open');
    this.selected = null;
    this.panel.classList.remove('show');
    this.resize();
    this.fit();
    // centre near the player
    this.centreOn(ctx.player.s, ctx.player.z, Math.max(this.scale, this.fitScale() * 3.2));
    this.draw();
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.tooltip.style.display = 'none';
  }

  private resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(window.innerWidth * this.dpr);
    this.canvas.height = Math.floor(window.innerHeight * this.dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
  }

  private fitScale() {
    const W = window.innerWidth;
    const Hh = window.innerHeight;
    return Math.min((W * 0.9) / (Z_MAX - Z_MIN), (Hh * 0.8) / CIRC);
  }

  private fit() {
    this.scale = this.fitScale();
    this.ox = (window.innerWidth - (Z_MAX - Z_MIN) * this.scale) / 2;
    this.oy = (window.innerHeight - CIRC * this.scale) / 2;
  }

  private centreOn(s: number, z: number, scale: number) {
    this.scale = scale;
    this.ox = window.innerWidth / 2 - (z - Z_MIN) * scale;
    this.oy = window.innerHeight / 2 - s * scale;
    this.clampView();
  }

  private clampView() {
    const W = window.innerWidth;
    const Hh = window.innerHeight;
    const mw = (Z_MAX - Z_MIN) * this.scale;
    const mh = CIRC * this.scale;
    this.ox = mw < W ? (W - mw) / 2 : Math.min(40, Math.max(W - mw - 40, this.ox));
    this.oy = mh < Hh ? (Hh - mh) / 2 : Math.min(40, Math.max(Hh - mh - 40, this.oy));
  }

  private toScreen(s: number, z: number): [number, number] {
    return [this.ox + (z - Z_MIN) * this.scale, this.oy + s * this.scale];
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag) {
        this.ox = this.drag.ox + e.clientX - this.drag.x;
        this.oy = this.drag.oy + e.clientY - this.drag.y;
        this.clampView();
        this.draw();
      } else {
        const t = this.pick(e.clientX, e.clientY);
        if (t !== this.hover) {
          this.hover = t;
          this.draw();
        }
        this.showTip(t, e.clientX, e.clientY);
      }
    });
    c.addEventListener('pointerup', (e) => {
      const moved = this.drag ? Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) : 0;
      this.drag = null;
      if (moved < 4) {
        const t = this.pick(e.clientX, e.clientY);
        this.select(t);
      }
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const k = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(0.08, Math.max(this.fitScale() * 0.9, this.scale * k));
        const mx = e.clientX;
        const my = e.clientY;
        const wz = (mx - this.ox) / this.scale;
        const ws = (my - this.oy) / this.scale;
        this.scale = ns;
        this.ox = mx - wz * ns;
        this.oy = my - ws * ns;
        this.clampView();
        this.draw();
      },
      { passive: false },
    );
  }

  private visibleKind(site: TownSite): boolean {
    const px = site.radius * this.scale;
    if (site.kind === 'city') return true;
    if (site.kind === 'town') return this.scale > this.fitScale() * 1.6 || px > 2;
    return this.scale > this.fitScale() * 4.5;
  }

  private pick(x: number, y: number): TownSite | null {
    if (!this.ctx) return null;
    let best: TownSite | null = null;
    let bd = 14;
    for (const t of this.ctx.gen.towns) {
      if (!this.visibleKind(t)) continue;
      const [px, py] = this.toScreen(t.s, t.z);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  private riverInfo(site: TownSite): string {
    const ctx = this.ctx!;
    const rv = ctx.gen.rivers[site.river];
    const dir = rv.flow > 0 ? 'Fore' : 'Aft';
    const pr = ctx.gen.nearestRiver(ctx.player.s, ctx.player.z);
    let rel = '';
    if (pr.index === site.river) {
      const down = (site.z - ctx.player.z) * rv.flow > 0;
      rel = down ? ' · downstream of you' : ' · upstream of you';
    }
    return `the ${rv.name}, flowing ${dir}${rel}`;
  }

  private distanceKm(site: TownSite): string {
    const p = this.ctx!.player;
    const d = Math.hypot(wrapS(site.s - p.s), site.z - p.z) / 1000;
    return d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`;
  }

  private kindLabel(site: TownSite) {
    return site.kind === 'city' ? 'River city' : site.kind === 'town' ? 'Town' : 'Hamlet';
  }

  private showTip(t: TownSite | null, x: number, y: number) {
    if (!t) {
      this.tooltip.style.display = 'none';
      return;
    }
    const known = this.ctx!.isKnown(t);
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${x + 14}px`;
    this.tooltip.style.top = `${y + 10}px`;
    this.tooltip.innerHTML = known
      ? `<div class="n">${t.name}</div><div class="k">${this.kindLabel(t)} · ${this.distanceKm(t)}</div><div class="r">${this.riverInfo(t)}</div>`
      : `<div class="n">Unknown ${t.kind === 'hamlet' ? 'hamlet' : 'settlement'}</div><div class="k">${this.distanceKm(t)} · not yet visited</div><div class="r">${this.riverInfo(t)}</div>`;
  }

  private select(t: TownSite | null) {
    this.selected = t;
    this.draw();
    if (!t) {
      this.panel.classList.remove('show');
      return;
    }
    const known = this.ctx!.isKnown(t);
    const fl = this.actions.canFloat(t);
    this.panel.innerHTML = '';
    if (known) {
      const img = document.createElement('img');
      img.className = 'glyphs';
      img.src = glyphImage(t.name, 26, '#4a3220');
      this.panel.appendChild(img);
    }
    const h = document.createElement('div');
    h.className = 'n';
    h.textContent = known ? t.name : 'Unknown settlement';
    this.panel.appendChild(h);
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = `${this.kindLabel(t)} · ${this.distanceKm(t)} away`;
    this.panel.appendChild(k);
    const r = document.createElement('div');
    r.className = 'r';
    r.textContent = `On ${this.riverInfo(t)}.`;
    this.panel.appendChild(r);
    const btns = document.createElement('div');
    btns.className = 'btns';
    const mk = (label: string, cls: string, fn: () => void, disabled = false, title = '') => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.disabled = disabled;
      if (title) b.title = title;
      b.onclick = fn;
      btns.appendChild(b);
    };
    mk('Float downriver', 'primary', () => this.actions.float(t), !known || !fl.ok, fl.note);
    mk('Travel', '', () => this.actions.travel(t), !known, known ? '' : 'Visit or hear of this place first');
    mk(this.ctx!.destination === t.id ? 'Destination set' : 'Set as destination', '', () => {
      this.actions.destination(t);
      this.select(t);
    });
    this.panel.appendChild(btns);
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = !known ? 'Undiscovered: walk there, or read signposts to learn its name.' : fl.note;
    this.panel.appendChild(note);
    this.panel.classList.add('show');
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const g = this.canvas.getContext('2d')!;
    const W = window.innerWidth;
    const Hh = window.innerHeight;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // table + parchment
    g.fillStyle = '#1b1510';
    g.fillRect(0, 0, W, Hh);
    const mw = (Z_MAX - Z_MIN) * this.scale;
    const mh = CIRC * this.scale;
    g.save();
    g.shadowColor = 'rgba(0,0,0,.6)';
    g.shadowBlur = 30;
    g.fillStyle = `rgb(${PAPER.join(',')})`;
    g.fillRect(this.ox - 26, this.oy - 26, mw + 52, mh + 52);
    g.restore();
    g.save();
    g.beginPath();
    g.rect(this.ox - 26, this.oy - 26, mw + 52, mh + 52);
    g.clip();
    const pat = g.createPattern(this.paper, 'repeat')!;
    g.fillStyle = pat;
    g.fillRect(this.ox - 26, this.oy - 26, mw + 52, mh + 52);
    if (this.relief) {
      g.globalAlpha = 0.92;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(this.relief, this.ox, this.oy, mw, mh);
      g.globalAlpha = 0.22;
      g.fillStyle = pat;
      g.globalCompositeOperation = 'multiply';
      g.fillRect(this.ox, this.oy, mw, mh);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    } else {
      g.fillStyle = INK_SOFT;
      g.font = 'italic 16px "Cormorant Garamond", serif';
      g.fillText('The cartographer is still painting…', this.ox + 30, this.oy + 40);
    }
    // section ends: barrier ranges
    g.strokeStyle = INK;
    g.lineWidth = 1.5;
    for (const zEnd of [0, L]) {
      const x = this.ox + (zEnd - Z_MIN) * this.scale;
      g.setLineDash([6, 5]);
      g.beginPath();
      g.moveTo(x, this.oy);
      g.lineTo(x, this.oy + mh);
      g.stroke();
      g.setLineDash([]);
      // painted peaks
      const n = Math.max(6, Math.floor(mh / 18));
      g.fillStyle = 'rgba(90,86,96,0.55)';
      for (let i = 0; i < n; i++) {
        const y = this.oy + (i + 0.5) * (mh / n);
        const hgt = 7 + ((i * 37) % 9);
        g.beginPath();
        g.moveTo(x - 8, y + 5);
        g.lineTo(x, y - hgt);
        g.lineTo(x + 8, y + 5);
        g.closePath();
        g.fill();
      }
    }
    // tributaries: tapering, gently wandering hand-drawn strokes
    g.lineCap = 'round';
    for (const d of ctx.gen.tribDescs) {
      const rv = ctx.gen.rivers[d.river];
      const s0 = rv.channelAt(d.zc);
      const segs = 7;
      const bend = (((d.seed >>> 3) & 255) / 255 - 0.5) * 0.5;
      let [px, py] = this.toScreen(s0, d.zc);
      for (let i = 1; i <= segs; i++) {
        const f = i / segs;
        const wob = Math.sin(f * Math.PI * 2 + (d.seed & 7)) * 0.05 + bend * f;
        const ang = Math.abs(d.angle) + wob;
        const s1 = s0 + d.side * Math.cos(ang) * d.length * f;
        const z1 = d.zc + Math.sign(d.angle) * Math.sin(ang) * d.length * f;
        const [x1, y1] = this.toScreen(s1, z1);
        g.strokeStyle = `rgba(46,93,134,${0.5 - f * 0.3})`;
        g.lineWidth = Math.max(0.5, d.mouthWidth * this.scale * 1.6 * (1 - f * 0.7));
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(x1, y1);
        g.stroke();
        px = x1;
        py = y1;
      }
    }
    // main rivers
    for (const rv of ctx.gen.rivers) {
      const step = Math.max(5, Math.floor(40 / (this.scale * 10)));
      for (const pass of [0, 1]) {
        g.strokeStyle = pass === 0 ? RIVER : 'rgba(170,205,225,0.65)';
        g.beginPath();
        for (let i = 0; i < rv.n; i += step) {
          const z = rv.zStart + i * 10;
          const [x, y] = this.toScreen(rv.s[i], z);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.lineWidth = pass === 0 ? Math.max(2, rv.widthAt(L / 2) * this.scale * 2.2) : Math.max(0.6, rv.widthAt(L / 2) * this.scale * 0.6);
        g.stroke();
      }
      // river name + flow arrows
      const [lx, ly] = this.toScreen(rv.valleyAt(L * 0.5) - 5000, L * 0.5);
      g.fillStyle = RIVER;
      g.font = `italic ${Math.max(12, Math.min(22, this.scale * 2500))}px "Cormorant Garamond", serif`;
      g.fillText(`the ${rv.name}`, lx, ly - 4);
      for (let k = 1; k < 8; k++) {
        const z = rv.zStart + ((rv.zEnd - rv.zStart) * k) / 8;
        const [ax, ay] = this.toScreen(rv.channelAt(z) + 6000, z);
        g.save();
        g.translate(ax, ay);
        if (rv.flow < 0) g.scale(-1, 1);
        g.strokeStyle = 'rgba(46,93,134,0.7)';
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(-9, 0);
        g.lineTo(7, 0);
        g.moveTo(3, -3.5);
        g.lineTo(7, 0);
        g.lineTo(3, 3.5);
        g.stroke();
        g.restore();
      }
    }
    // towns
    const fs = this.fitScale();
    for (const t of ctx.gen.towns) {
      if (!this.visibleKind(t)) continue;
      const [x, y] = this.toScreen(t.s, t.z);
      if (x < -40 || y < -40 || x > W + 40 || y > Hh + 40) continue;
      const known = ctx.isKnown(t);
      const hot = t === this.hover || t === this.selected;
      this.drawTownIcon(g, t, x, y, known, hot);
      const showName = t.kind === 'city' || (t.kind === 'town' && this.scale > fs * 2.5) || (t.kind === 'hamlet' && this.scale > fs * 9) || hot;
      if (showName) {
        g.fillStyle = known ? INK : INK_SOFT;
        g.font = `${t.kind === 'city' ? '600 ' : ''}${t.kind === 'city' ? 15 : t.kind === 'town' ? 13 : 11}px "Cormorant Garamond", serif`;
        g.fillText(known ? t.name : '?', x + 9, y - 7);
      }
      if (ctx.destination === t.id) {
        g.strokeStyle = '#c98a1a';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, 12, 0, Math.PI * 2);
        g.stroke();
      }
    }
    // player marker
    const [px, py] = this.toScreen(ctx.player.s, ctx.player.z);
    const fwdS = -Math.sin(ctx.player.yaw);
    const fwdZ = -Math.cos(ctx.player.yaw);
    const ang = Math.atan2(fwdS, fwdZ);
    g.save();
    g.translate(px, py);
    g.rotate(ang);
    g.fillStyle = '#b8321e';
    g.strokeStyle = '#fff4dc';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(10, 0);
    g.lineTo(-7, -6);
    g.lineTo(-3, 0);
    g.lineTo(-7, 6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.fillStyle = '#b8321e';
    g.font = 'italic 12px "Cormorant Garamond", serif';
    g.fillText('you are here', px + 12, py + 14);
    g.restore();
    this.drawCartouche(g, W, Hh);
  }

  private drawTownIcon(g: CanvasRenderingContext2D, t: TownSite, x: number, y: number, known: boolean, hot: boolean) {
    g.save();
    g.translate(x, y);
    const k = hot ? 1.35 : 1;
    g.scale(k, k);
    g.strokeStyle = INK;
    g.fillStyle = known ? '#b8563a' : 'rgba(120,100,80,0.5)';
    g.lineWidth = 1.1;
    if (!known) {
      g.beginPath();
      g.arc(0, 0, t.kind === 'hamlet' ? 3 : 5, 0, Math.PI * 2);
      g.fillStyle = 'rgba(233,220,190,0.9)';
      g.fill();
      g.stroke();
      g.fillStyle = INK;
      g.font = '600 9px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText('?', 0, 3.2);
    } else if (t.kind === 'hamlet') {
      g.beginPath();
      g.moveTo(-3, 2);
      g.lineTo(-3, -1);
      g.lineTo(0, -4);
      g.lineTo(3, -1);
      g.lineTo(3, 2);
      g.closePath();
      g.fill();
      g.stroke();
    } else if (t.kind === 'town') {
      for (const [dx, dy] of [
        [-4, 1],
        [3, 2],
        [0, -2],
      ]) {
        g.beginPath();
        g.moveTo(dx - 3, dy + 2);
        g.lineTo(dx - 3, dy - 1);
        g.lineTo(dx, dy - 4);
        g.lineTo(dx + 3, dy - 1);
        g.lineTo(dx + 3, dy + 2);
        g.closePath();
        g.fill();
        g.stroke();
      }
    } else {
      g.beginPath();
      g.arc(0, 0, 8, 0, Math.PI * 2);
      g.fillStyle = 'rgba(233,220,190,0.95)';
      g.fill();
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = '#d4a032';
      g.beginPath();
      g.arc(0, 1, 4, Math.PI, 0);
      g.fill();
      g.lineWidth = 1;
      g.stroke();
      g.beginPath();
      g.moveTo(0, -3);
      g.lineTo(0, -6);
      g.stroke();
    }
    g.restore();
  }

  private drawCartouche(g: CanvasRenderingContext2D, W: number, _H: number) {
    const ctx = this.ctx!;
    const x = 22;
    const y = 22;
    g.save();
    g.fillStyle = 'rgba(233,220,190,0.94)';
    g.strokeStyle = INK;
    g.lineWidth = 1.2;
    g.beginPath();
    g.roundRect(x, y, 300, 86, 8);
    g.fill();
    g.stroke();
    g.strokeRect(x + 5, y + 5, 290, 76);
    g.fillStyle = INK;
    g.font = '600 22px "Cormorant Garamond", serif';
    g.fillText("Heaven's River", x + 16, y + 34);
    g.font = 'italic 14px "Cormorant Garamond", serif';
    g.fillText(`Section ${quinlanNumber(ctx.section)} · ${ctx.section}`, x + 16, y + 56);
    g.font = '11px Inter, sans-serif';
    g.fillStyle = INK_SOFT;
    g.fillText('Fore →   ·   Spin ↓   ·   560 miles × 352 miles', x + 16, y + 74);
    drawNumeral(g, ctx.section, x + 240, y + 48, 26, '#8a4a1a');
    // scale bar
    const km = this.scale * 1000;
    let len = 50;
    for (const c of [1, 2, 5, 10, 20, 50, 100, 200]) if (c * km > 60) {
      len = c;
      break;
    }
    const bx = W - 40 - len * km;
    const by = window.innerHeight - 40;
    g.fillStyle = INK;
    g.fillRect(bx, by, len * km, 3);
    g.fillRect(bx, by - 4, 1.5, 11);
    g.fillRect(bx + len * km - 1.5, by - 4, 1.5, 11);
    g.font = '12px "Cormorant Garamond", serif';
    g.fillText(`${len} km`, bx, by - 8);
    g.restore();
  }
}
