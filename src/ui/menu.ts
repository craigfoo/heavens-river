// Pause menu with settings, controls and credits.

import type { Settings } from '../settings';

type Opt =
  | { kind: 'range'; key: keyof Settings; label: string; min: number; max: number; step: number; fmt?: (v: number) => string }
  | { kind: 'toggle'; key: keyof Settings; label: string; hint?: string }
  | { kind: 'select'; key: keyof Settings; label: string; options: [string, string][] };

const GROUPS: { title: string; opts: Opt[] }[] = [
  {
    title: 'Graphics',
    opts: [
      { kind: 'select', key: 'quality', label: 'Quality', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
      { kind: 'toggle', key: 'adaptiveRes', label: 'Adaptive resolution', hint: 'Renders fewer pixels when the frame rate drops, and more when there is headroom.' },
      { kind: 'range', key: 'fov', label: 'Field of view', min: 60, max: 140, step: 1, fmt: (v) => `${v}°` },
      { kind: 'toggle', key: 'grass', label: 'Grass' },
      { kind: 'toggle', key: 'shadows', label: 'Shadows' },
    ],
  },
  {
    title: 'World',
    opts: [
      { kind: 'range', key: 'dayMinutes', label: 'Day length', min: 4, max: 60, step: 1, fmt: (v) => `${v} min` },
      { kind: 'toggle', key: 'freezeTime', label: 'Freeze time of day' },
      { kind: 'toggle', key: 'goldenLiberty', label: 'Golden-hour light zone', hint: 'Artistic liberty: at dawn and dusk the tube light gathers into a bright zone far along the axis, giving low-angle golden light. Canon: the tube dims overhead.' },
      { kind: 'range', key: 'hologramHeight', label: 'Hologram sky height', min: 10, max: 40, step: 1, fmt: (v) => `${v} km` },
      { kind: 'range', key: 'fog', label: 'Haze', min: 0.3, max: 2, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
      { kind: 'toggle', key: 'coriolis', label: 'Physics nerd: Coriolis', hint: 'Adds the rotating-frame Coriolis force to your jumps and falls (ω ≈ 0.0089 rad/s).' },
    ],
  },
  {
    title: 'Travel',
    opts: [
      { kind: 'toggle', key: 'allTowns', label: 'All towns unlocked' },
      { kind: 'toggle', key: 'anekCutscenes', label: 'Anek-style cutscenes', hint: 'A surveillance bird swoops in and the scene cuts — a wink at the Scatterings.' },
      { kind: 'range', key: 'tripSeconds', label: 'Barge trip length', min: 60, max: 180, step: 5, fmt: (v) => `${v} s` },
    ],
  },
  {
    title: 'Controls & sound',
    opts: [
      { kind: 'range', key: 'sensitivity', label: 'Mouse sensitivity', min: 0.2, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
      { kind: 'toggle', key: 'invertY', label: 'Invert look' },
      { kind: 'select', key: 'visionMode', label: 'First Quinlan view (V)', options: [['panorama', 'Panorama (270°)'], ['split', 'Independent eyes']] },
      { kind: 'range', key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
      { kind: 'range', key: 'waterVolume', label: 'Water sounds', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
      { kind: 'toggle', key: 'muted', label: 'Mute' },
      { kind: 'toggle', key: 'showDebug', label: 'Show performance stats' },
    ],
  },
];

export interface MenuActions {
  resume(): void;
  change(s: Settings, key: keyof Settings): void;
  openMap(): void;
  openJournal(): void;
  resetSave(): void;
  replayIntro(): void;
}

export class Menu {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  private settings: Settings;
  private actions: MenuActions;
  isOpen = false;
  private tab: 'settings' | 'controls' | 'about' = 'settings';

  constructor(parent: HTMLElement, settings: Settings, actions: MenuActions) {
    this.settings = settings;
    this.actions = actions;
    this.root = document.createElement('div');
    this.root.className = 'screen menu-screen';
    this.root.innerHTML = `
      <div class="menu-card">
        <div class="menu-head">
          <div class="title">Heaven's River</div>
          <div class="sub">a Quinlan's-eye explorer</div>
        </div>
        <div class="menu-actions">
          <button class="btn primary" data-a="resume">Resume</button>
          <button class="btn" data-a="map">Map <span class="key">M</span></button>
          <button class="btn" data-a="journal">Journal <span class="key">J</span></button>
        </div>
        <div class="menu-tabs">
          <button data-t="settings" class="on">Settings</button>
          <button data-t="controls">Controls</button>
          <button data-t="about">About</button>
        </div>
        <div class="menu-body"></div>
      </div>`;
    parent.appendChild(this.root);
    this.body = this.root.querySelector('.menu-body') as HTMLDivElement;
    this.root.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        if (a === 'resume') this.actions.resume();
        else if (a === 'map') this.actions.openMap();
        else if (a === 'journal') this.actions.openJournal();
      };
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-t]').forEach((b) => {
      b.onclick = () => {
        this.tab = b.dataset.t as 'settings';
        this.root.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b));
        this.render();
      };
    });
    this.render();
  }

  open() {
    this.isOpen = true;
    this.root.classList.add('open');
    this.render();
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  private render() {
    if (this.tab === 'controls') {
      this.body.innerHTML = `<table class="controls">
        ${[
          ['WASD / stick', 'Move'],
          ['Mouse / right stick', 'Look'],
          ['Shift', 'Drop to all fours (faster, lower) · tail burst when swimming'],
          ['Ctrl / Alt', 'Walk slowly'],
          ['Space', 'Jump · surface when swimming'],
          ['C', 'Dive when swimming'],
          ['E', 'Interact: read signposts, board barges'],
          ['V', 'Toggle Quinlan vision (Q/E steer independent eyes)'],
          ['B', 'Bob mode: switch the hologram sky off'],
          ['M', 'Map: pick a town to float to or travel to'],
          ['J', 'Journal'],
          ['T / Shift+T', 'Scrub time of day forward / back'],
          ['Tab', 'Photo mode (free camera, depth of field)'],
          ['F', 'Fly (debug)'],
          ['H', 'Toggle hints'],
          ['Esc', 'Menu'],
        ]
          .map(([k, v]) => `<tr><td><span class="key">${k}</span></td><td>${v}</td></tr>`)
          .join('')}
      </table>`;
      return;
    }
    if (this.tab === 'about') {
      this.body.innerHTML = `<div class="about">
        <p><b>Heaven's River Explorer</b> is a non-commercial fan project set in <i>Heaven's River</i> (Bobiverse, Book 4) by <b>Dennis E. Taylor</b>. Please read the books.</p>
        <p>There is no official concept art for the Quinlans or the megastructure; everything here is derived from the text and the author's notes: a topopolis looping Eta Leporis three times, 56-mile radius, 560-mile sections, four alternating rivers per section, a light tube down the axis hidden by a diffuse hologram sky, and barrier mountains at each section end.</p>
        <p>Scale is honest: you are walking the inside of a 90 km radius cylinder spinning at ~805 m/s (0.73 g). Look along the spin and the land curves up into the haze.</p>
        <p class="dim">Built with three.js. All geometry, textures and sounds are procedural.</p>
        <p><button class="btn" data-x="intro">Replay the arrival</button> <button class="btn" data-x="reset">Reset saved game</button></p>
      </div>`;
      (this.body.querySelector('[data-x="intro"]') as HTMLButtonElement).onclick = () => this.actions.replayIntro();
      (this.body.querySelector('[data-x="reset"]') as HTMLButtonElement).onclick = () => {
        if (confirm('Forget every discovered town and start over?')) this.actions.resetSave();
      };
      return;
    }
    const s = this.settings;
    this.body.innerHTML = '';
    for (const g of GROUPS) {
      const sec = document.createElement('div');
      sec.className = 'group';
      sec.innerHTML = `<div class="gt">${g.title}</div>`;
      for (const o of g.opts) {
        const row = document.createElement('label');
        row.className = 'row';
        const lbl = document.createElement('span');
        lbl.className = 'lbl';
        lbl.textContent = o.label;
        if (o.kind === 'toggle' && o.hint) lbl.title = o.hint;
        row.appendChild(lbl);
        if (o.kind === 'range') {
          const input = document.createElement('input');
          input.type = 'range';
          input.min = String(o.min);
          input.max = String(o.max);
          input.step = String(o.step);
          input.value = String(s[o.key]);
          const val = document.createElement('span');
          val.className = 'val';
          val.textContent = o.fmt ? o.fmt(Number(s[o.key])) : String(s[o.key]);
          input.oninput = () => {
            (s as unknown as Record<string, number>)[o.key] = Number(input.value);
            val.textContent = o.fmt ? o.fmt(Number(input.value)) : input.value;
            this.actions.change(s, o.key);
          };
          row.append(input, val);
        } else if (o.kind === 'toggle') {
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = Boolean(s[o.key]);
          input.onchange = () => {
            (s as unknown as Record<string, boolean>)[o.key] = input.checked;
            this.actions.change(s, o.key);
          };
          row.appendChild(input);
        } else {
          const sel = document.createElement('select');
          for (const [v, t] of o.options) {
            const op = document.createElement('option');
            op.value = v;
            op.textContent = t;
            sel.appendChild(op);
          }
          sel.value = String(s[o.key]);
          sel.onchange = () => {
            (s as unknown as Record<string, string>)[o.key] = sel.value;
            this.actions.change(s, o.key);
          };
          row.appendChild(sel);
        }
        sec.appendChild(row);
      }
      this.body.appendChild(sec);
    }
  }
}
