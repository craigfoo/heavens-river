// Heads-up display: compass with markers, section card, clock, arrival
// banners, interaction prompts, breath meter, toasts and control hints.

import { formatClock } from '../sky/daynight';
import { quinlanNumber, octal } from '../world/gen/names';
import { drawNumeral, glyphImage } from './glyphs';

export interface CompassMarker {
  bearing: number; // degrees, 0 = +z (Fore), 90 = +s (Spin)
  kind: 'dest' | 'town' | 'sun';
  label?: string;
}

const CARD = [
  { b: 0, t: 'Fore' },
  { b: 90, t: 'Spin' },
  { b: 180, t: 'Aft' },
  { b: 270, t: 'Anti' },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

export class Hud {
  readonly root: HTMLDivElement;
  private compass: HTMLDivElement;
  private compassItems: HTMLDivElement;
  private destDist: HTMLDivElement;
  private sectionCard: HTMLDivElement;
  private sectionCanvas: HTMLCanvasElement;
  private sectionT1: HTMLDivElement;
  private sectionT2: HTMLDivElement;
  private clock: HTMLDivElement;
  private clockSun: HTMLDivElement;
  private clockText: HTMLSpanElement;
  private banner: HTMLDivElement;
  private prompt: HTMLDivElement;
  private breath: HTMLCanvasElement;
  private toasts: HTMLDivElement;
  private hints: HTMLDivElement;
  readonly fade: HTMLDivElement;
  private bannerTimer = 0;
  private lastSection = -1;
  private promptText = '';
  visible = true;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.compass = el('div', 'compass', this.root);
    this.compassItems = el('div', '', this.compass);
    el('div', 'center', this.compass);
    this.destDist = el('div', 'dest-dist', this.root);
    this.sectionCard = el('div', 'section-card', this.root);
    this.sectionCanvas = el('canvas', '', this.sectionCard);
    this.sectionCanvas.width = 64;
    this.sectionCanvas.height = 40;
    this.sectionCanvas.style.width = '32px';
    this.sectionCanvas.style.height = '20px';
    const txt = el('div', '', this.sectionCard);
    this.sectionT1 = el('div', 't1', txt);
    this.sectionT2 = el('div', 't2', txt);
    this.clock = el('div', 'clock', this.root);
    this.clockSun = el('div', 'sun', this.clock);
    this.clockText = el('span', '', this.clock);
    this.banner = el('div', 'banner', this.root);
    this.prompt = el('div', 'prompt', this.root);
    this.breath = el('canvas', 'breath', this.root);
    this.breath.width = 108;
    this.breath.height = 108;
    this.toasts = el('div', 'toasts', this.root);
    this.hints = el('div', 'hints', this.root);
    this.hints.innerHTML =
      '<b>WASD</b> move · <b>Mouse</b> look · <b>Shift</b> all fours · <b>Space</b> jump / surface · <b>C</b> dive<br>' +
      '<b>E</b> interact · <b>M</b> map · <b>J</b> journal · <b>T</b> time · <b>B</b> Bob mode · <b>V</b> Quinlan vision · <b>Tab</b> photo · <b>Esc</b> menu';
    el('div', 'crosshair', this.root);
    this.fade = el('div', 'fade', parent);
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.root.classList.toggle('hidden-soft', !v);
  }

  hideHintsSoon() {
    setTimeout(() => (this.hints.style.opacity = '0'), 20000);
  }

  toggleHints() {
    this.hints.style.opacity = this.hints.style.opacity === '0' ? '1' : '0';
  }

  toast(text: string) {
    const t = el('div', 'toast', this.toasts);
    t.textContent = text;
    setTimeout(() => t.remove(), 3800);
  }

  setSection(section: number, river: string) {
    if (section !== this.lastSection) {
      this.lastSection = section;
      const ctx = this.sectionCanvas.getContext('2d')!;
      ctx.clearRect(0, 0, 64, 40);
      drawNumeral(ctx, section, 4, 34, 22, '#e8b460');
      this.sectionT1.textContent = `Section ${quinlanNumber(section)}`;
    }
    this.sectionT2.textContent = `${octal(section)}₈ · the ${river}`;
  }

  setClock(t: number, night: number) {
    this.clockText.textContent = formatClock(t);
    this.clockSun.classList.toggle('night', night > 0.5);
  }

  showBanner(name: string, sub: string, seconds = 6) {
    this.banner.innerHTML = '';
    const img = el('img', 'glyphs', this.banner);
    img.src = glyphImage(name, 34, '#f2dcae', 'rgba(232,180,96,.8)');
    const n = el('div', 'name', this.banner);
    n.textContent = name;
    const s = el('div', 'sub', this.banner);
    s.textContent = sub;
    this.banner.classList.add('show');
    this.bannerTimer = seconds;
  }

  setPrompt(text: string) {
    if (text === this.promptText) return;
    this.promptText = text;
    this.prompt.innerHTML = text;
    this.prompt.classList.toggle('show', !!text);
  }

  setBreath(frac: number, show: boolean) {
    this.breath.classList.toggle('show', show);
    if (!show) return;
    const ctx = this.breath.getContext('2d')!;
    ctx.clearRect(0, 0, 108, 108);
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath();
    ctx.arc(54, 54, 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = frac > 0.3 ? '#9fe0e0' : '#ff8a6a';
    ctx.beginPath();
    ctx.arc(54, 54, 40, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
    ctx.fillStyle = 'rgba(244,234,216,.85)';
    ctx.font = '600 18px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.ceil(frac * 90)}`, 54, 61);
  }

  /** heading in degrees (0 = Fore/+z, 90 = Spin/+s). */
  updateCompass(heading: number, markers: CompassMarker[], destText: string) {
    const w = this.compass.clientWidth || 560;
    const pxPerDeg = w / 150;
    let html = '';
    for (let d = -80; d <= 80; d += 5) {
      const b = Math.round((heading + d) / 5) * 5;
      const off = ((b - heading + 540) % 360) - 180;
      const x = w / 2 + off * pxPerDeg;
      if (x < 0 || x > w) continue;
      const bn = ((b % 360) + 360) % 360;
      const major = bn % 45 === 0;
      html += `<div class="tick${major ? ' major' : ''}" style="left:${x.toFixed(1)}px"></div>`;
      const card = CARD.find((c) => c.b === bn);
      if (card) html += `<div class="lbl" style="left:${x.toFixed(1)}px">${card.t}</div>`;
      else if (bn % 45 === 0) html += `<div class="lbl minor" style="left:${x.toFixed(1)}px">${bn}</div>`;
    }
    for (const m of markers) {
      const off = ((m.bearing - heading + 540) % 360) - 180;
      if (Math.abs(off) > 75) continue;
      const x = w / 2 + off * pxPerDeg;
      if (m.kind === 'dest') html += `<div class="mk dest" style="left:${x.toFixed(1)}px">◆</div>`;
      else if (m.kind === 'sun') html += `<div class="mk" style="left:${x.toFixed(1)}px;color:#ffd890">☼</div>`;
      else html += `<div class="mk town" style="left:${x.toFixed(1)}px">▾ ${m.label ?? ''}</div>`;
    }
    this.compassItems.innerHTML = html;
    this.destDist.textContent = destText;
  }

  update(dt: number) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    }
  }

  setFade(v: number, color = '#000') {
    this.fade.style.background = color;
    this.fade.style.opacity = String(v);
  }
}
