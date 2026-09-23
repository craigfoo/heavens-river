// DOM captions for the arrival sequence: elegant serif titles, the Spin
// Transfer speed readout and the skip hint. Opacities are driven from the
// timeline every frame (no CSS transitions) so seeking stays deterministic.
// A gold veil matching the final frame fades out on its own after the intro
// ends, so the world is revealed from gold whatever the host does next.

const CSS = /* css */ `
.hri-root { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 40;
  font-family: 'Cormorant Garamond', 'Iowan Old Style', 'Palatino Linotype', Georgia, serif; color: #f7eedc; }
.hri-cap { position: absolute; left: max(24px, 6.5vw); bottom: max(34px, 10vh); max-width: min(760px, 86vw);
  opacity: 0; will-change: opacity, transform; text-shadow: 0 1px 2px rgba(0,0,0,.4), 0 2px 22px rgba(0,0,0,.6); }
.hri-cap::before { content: ''; position: absolute; z-index: -1; left: -14%; right: -18%; top: -40%; bottom: -45%;
  background: radial-gradient(closest-side, rgba(0,0,0,.34), rgba(0,0,0,0)); pointer-events: none; }
.hri-title { font-weight: 500; font-size: clamp(38px, 5.6vw, 82px); line-height: .95; letter-spacing: .015em; }
.hri-rule { width: 72px; height: 1px; margin: 18px 0 14px; background: linear-gradient(90deg, rgba(232,180,96,.95), rgba(232,180,96,0)); }
.hri-sub { font-style: italic; font-weight: 500; font-size: clamp(17px, 1.75vw, 26px); line-height: 1.3; color: rgba(247,238,220,.86); }
.hri-line { font-weight: 500; font-size: clamp(22px, 2.5vw, 36px); line-height: 1.15; letter-spacing: .01em; }
.hri-line em { font-style: italic; color: rgba(247,238,220,.78); }
.hri-kicker { font-family: Inter, system-ui, -apple-system, sans-serif; font-weight: 500; font-size: 11px; line-height: 1;
  letter-spacing: .34em; text-transform: uppercase; color: rgba(247,238,220,.66); margin-bottom: 12px; }
.hri-speed { font-family: Inter, system-ui, -apple-system, sans-serif; font-weight: 400; font-variant-numeric: tabular-nums;
  font-size: clamp(30px, 3.6vw, 50px); line-height: 1; letter-spacing: .01em; }
.hri-speed small { font-size: .4em; letter-spacing: .08em; margin-left: .4em; color: rgba(247,238,220,.7); }
.hri-bar { position: relative; width: min(300px, 56vw); height: 1px; margin: 14px 0 12px; background: rgba(247,238,220,.2); }
.hri-bar i { position: absolute; left: 0; top: -1px; height: 3px; width: 0; background: linear-gradient(90deg, rgba(232,180,96,.5), #f0c070); }
.hri-note { font-style: italic; font-weight: 500; font-size: clamp(15px, 1.4vw, 20px); color: rgba(247,238,220,.8); }
.hri-skip { position: absolute; right: max(18px, 3.2vw); bottom: max(18px, 3.6vh); opacity: 0;
  font-family: Inter, system-ui, -apple-system, sans-serif; font-weight: 500; font-size: 10.5px; letter-spacing: .26em;
  text-transform: uppercase; color: rgba(247,238,220,.55); text-shadow: 0 1px 8px rgba(0,0,0,.6); }
.hri-veil { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
@media (max-width: 560px) { .hri-cap { bottom: max(64px, 12vh); } }
`;

/** Final colour of the intro (sRGB); the veil and the last frame match it. */
export const INTRO_END_COLOR = '#ffe7bf';

export class IntroOverlay {
  readonly root: HTMLDivElement;
  private style: HTMLStyleElement;
  private title: HTMLDivElement;
  private port: HTMLDivElement;
  private spin: HTMLDivElement;
  private elev: HTMLDivElement;
  private skip: HTMLDivElement;
  private veil: HTMLDivElement;
  private speed: HTMLSpanElement;
  private bar: HTMLElement;
  private note: HTMLDivElement;
  private cache = new Map<HTMLElement, string>();
  private lastSpeed = -1;
  private lastNote = '';
  private released = false;

  constructor(private parent: HTMLElement) {
    this.style = document.createElement('style');
    this.style.textContent = CSS;
    document.head.appendChild(this.style);
    this.root = document.createElement('div');
    this.root.className = 'hri-root';
    this.title = this.block(
      `<div class="hri-title">Eta Leporis</div><div class="hri-rule"></div>` +
        `<div class="hri-sub">Heaven's River — a topopolis one billion miles long</div>`,
    );
    this.port = this.block(`<div class="hri-line">Spaceport 4 of 9 <em>— outer shell (non-rotating)</em></div>`);
    this.spin = this.block(
      `<div class="hri-kicker">Spin Transfer</div><div class="hri-speed"><span>0</span><small>m/s</small></div>` +
        `<div class="hri-bar"><i></i></div><div class="hri-note"></div>`,
    );
    this.elev = this.block(`<div class="hri-line"><em>Descending through the shell</em></div>`);
    this.speed = this.spin.querySelector('.hri-speed span') as HTMLSpanElement;
    this.bar = this.spin.querySelector('.hri-bar i') as HTMLElement;
    this.note = this.spin.querySelector('.hri-note') as HTMLDivElement;
    this.skip = document.createElement('div');
    this.skip.className = 'hri-skip';
    this.skip.textContent = 'Press Enter / tap to skip';
    this.root.appendChild(this.skip);
    this.veil = document.createElement('div');
    this.veil.className = 'hri-veil';
    this.veil.style.background = INTRO_END_COLOR;
    this.root.appendChild(this.veil);
    parent.appendChild(this.root);
  }

  private block(html: string) {
    const d = document.createElement('div');
    d.className = 'hri-cap';
    d.innerHTML = html;
    this.root.appendChild(d);
    return d;
  }

  private set(el: HTMLElement, opacity: number, rise = 0) {
    const o = Math.max(0, Math.min(1, opacity));
    const key = `${o.toFixed(3)}|${rise.toFixed(1)}`;
    if (this.cache.get(el) === key) return;
    this.cache.set(el, key);
    el.style.opacity = o.toFixed(3);
    el.style.transform = rise ? `translate3d(0, ${rise.toFixed(1)}px, 0)` : '';
    el.style.visibility = o > 0 ? 'visible' : 'hidden';
  }

  /** Caption opacities (0..1); each rises gently while fading in. */
  setCaptions(c: { title: number; port: number; spin: number; elev: number; skip: number }) {
    this.set(this.title, c.title, (1 - c.title) * 10);
    this.set(this.port, c.port, (1 - c.port) * 8);
    this.set(this.spin, c.spin, (1 - c.spin) * 8);
    this.set(this.elev, c.elev, (1 - c.elev) * 8);
    this.set(this.skip, c.skip);
  }

  setSpeed(v: number, matched: boolean, docked: boolean) {
    const s = Math.round(v);
    if (s !== this.lastSpeed) {
      this.lastSpeed = s;
      this.speed.textContent = String(s);
      this.bar.style.width = `${Math.min(100, (v / 805) * 100).toFixed(2)}%`;
    }
    const note = docked
      ? 'Speeds matched — clamped and docked'
      : matched
        ? 'Speeds matched'
        : 'Accelerating to match the inner shell · 805 m/s';
    if (note !== this.lastNote) {
      this.lastNote = note;
      this.note.textContent = note;
    }
  }

  /**
   * Show the gold veil fully, then fade it out over ~1.6 s and remove it. It
   * outlives dispose(), so the world is revealed from gold whenever the host
   * starts drawing it.
   */
  release() {
    if (this.released) return;
    this.released = true;
    for (const el of [this.title, this.port, this.spin, this.elev, this.skip]) el.remove();
    const v = this.veil;
    // move the veil to the host's overlay (inline styles only) so dispose() can drop our root
    v.className = '';
    v.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:41;opacity:1;background:${INTRO_END_COLOR}`;
    this.parent.appendChild(v);
    const done = () => v.remove();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        v.style.transition = 'opacity 1.6s cubic-bezier(.4,0,.2,1) .15s';
        v.style.opacity = '0';
        v.addEventListener('transitionend', done, { once: true });
        setTimeout(done, 2400);
      }),
    );
  }

  dispose() {
    this.root.remove();
    this.style.remove();
    if (!this.released) this.veil.remove();
  }
}
