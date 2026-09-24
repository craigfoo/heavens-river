// On-screen controls for touch devices: a floating movement stick on the left
// (drag anywhere on the left side), look by dragging on the right, and a
// cluster of buttons that press the same keys as the keyboard.

import type { Input } from '../player/input';

interface Btn {
  el: HTMLButtonElement;
  code: string;
  hold: boolean;
  when?: () => boolean;
}

export class TouchControls {
  private root: HTMLDivElement;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private buttons: Btn[] = [];
  private input: Input;
  private shown = false;
  /** Extra visibility rule for context buttons (e.g. interact only with a prompt). */
  context: { interact: () => boolean; swimming: () => boolean; playing: () => boolean } = {
    interact: () => false,
    swimming: () => false,
    playing: () => true,
  };

  constructor(overlay: HTMLElement, input: Input) {
    this.input = input;
    this.root = document.createElement('div');
    this.root.className = 'touch-ui';
    this.base = document.createElement('div');
    this.base.className = 'tstick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'tstick-knob';
    this.root.append(this.base, this.knob);
    const add = (label: string, code: string, cls: string, hold = false, when?: () => boolean) => {
      const el = document.createElement('button');
      el.className = `tbtn ${cls}`;
      el.textContent = label;
      el.setAttribute('aria-label', label);
      const down = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('on');
        input.virtualDown(code);
        if (!hold) setTimeout(() => {
          input.virtualUp(code);
          el.classList.remove('on');
        }, 90);
      };
      const up = (e: Event) => {
        e.preventDefault();
        if (!hold) return;
        el.classList.remove('on');
        input.virtualUp(code);
      };
      el.addEventListener('touchstart', down, { passive: false });
      el.addEventListener('touchend', up, { passive: false });
      el.addEventListener('touchcancel', up, { passive: false });
      this.root.appendChild(el);
      this.buttons.push({ el, code, hold, when });
    };
    add('Jump', 'Space', 'b-jump', true);
    add('Dive', 'KeyC', 'b-dive', true, () => this.context.swimming());
    add('Run', 'ShiftLeft', 'b-run', true);
    add('Use', 'KeyE', 'b-use', false, () => this.context.interact());
    add('Map', 'KeyM', 'b-map');
    add('Eyes', 'KeyV', 'b-eyes');
    add('Sky', 'KeyB', 'b-sky');
    add('Photo', 'Tab', 'b-photo');
    add('☰', 'Escape', 'b-menu');
    overlay.appendChild(this.root);
    this.root.style.display = 'none';
  }

  update() {
    const show = this.input.touchActive && this.context.playing();
    if (show !== this.shown) {
      this.shown = show;
      this.root.style.display = show ? 'block' : 'none';
    }
    if (!show) return;
    const st = this.input.stick;
    this.base.style.opacity = this.knob.style.opacity = st.active ? '1' : '0';
    if (st.active) {
      const dx = st.x - st.x0;
      const dy = st.y - st.y0;
      const l = Math.hypot(dx, dy);
      const k = l > 60 ? 60 / l : 1;
      this.base.style.transform = `translate(${st.x0 - 60}px, ${st.y0 - 60}px)`;
      this.knob.style.transform = `translate(${st.x0 + dx * k - 26}px, ${st.y0 + dy * k - 26}px)`;
    }
    for (const b of this.buttons) if (b.when) b.el.style.display = b.when() ? 'block' : 'none';
  }
}
