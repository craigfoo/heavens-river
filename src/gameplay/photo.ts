// Photo mode (Tab): a free camera tethered to the player, depth of field with
// manual or automatic focus, roll, zoom, time freeze, avatar poses, and PNG
// capture of the current frame.

import { CIRC } from '../config';
import { wrapS } from '../coords/cylinder';
import { clamp, damp, mod } from '../core/math';
import type { App } from '../app';
import { AVATAR_POSES } from '../npc/avatar';

const TETHER = 150;

export class PhotoMode {
  active = false;
  private app: App;
  private pose = { s: 0, z: 0, h: 0, yaw: 0, pitch: 0, roll: 0 };
  private vel = { s: 0, z: 0, h: 0 };
  focus = 6;
  aperture = 1;
  autofocus = true;
  private fov = 70;
  private savedFov = 100;
  private panel: HTMLDivElement;
  private status: HTMLDivElement;
  private flash: HTMLDivElement;
  private panelTimer = 0;
  private wheel = 0;
  private sayTimer = 0;

  constructor(app: App, overlay: HTMLElement) {
    this.app = app;
    this.panel = document.createElement('div');
    this.panel.className = 'photo-panel';
    this.panel.innerHTML =
      '<b>Photo mode</b><br>' +
      '<b>WASD</b> move · <b>Space/C</b> up/down · <b>Shift</b> fast · <b>Q/E</b> roll<br>' +
      '<b>Wheel</b> focus · <b>F</b> autofocus · <b>[ ]</b> blur · <b>− =</b> zoom<br>' +
      '<b>X</b> freeze time · <b>P</b> pose · <b>Enter</b> save photo · <b>H</b> hide help · <b>Tab</b> exit';
    this.status = document.createElement('div');
    this.status.className = 'photo-status';
    this.flash = document.createElement('div');
    this.flash.className = 'photo-flash';
    for (const e of [this.panel, this.status, this.flash]) {
      e.style.display = 'none';
      overlay.appendChild(e);
    }
    app.canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
    const inp = app.input;
    inp.on('KeyF', () => {
      if (!this.active) return;
      this.autofocus = !this.autofocus;
      this.showStatus();
    });
    inp.on('BracketLeft', () => this.active && ((this.aperture = clamp(this.aperture / 1.35, 0.15, 6)), this.showStatus()));
    inp.on('BracketRight', () => this.active && ((this.aperture = clamp(this.aperture * 1.35, 0.15, 6)), this.showStatus()));
    inp.on('Minus', () => this.active && ((this.fov = clamp(this.fov + 8, 20, 130)), this.showStatus()));
    inp.on('Equal', () => this.active && ((this.fov = clamp(this.fov - 8, 20, 130)), this.showStatus()));
    inp.on('KeyX', () => {
      if (!this.active) return;
      app.simFrozen = !app.simFrozen;
      app.avatar.frozen = app.simFrozen;
      this.say(app.simFrozen ? 'Time frozen' : 'Time running');
    });
    inp.on('KeyP', () => {
      if (!this.active) return;
      app.avatar.pose = (app.avatar.pose + 1) % AVATAR_POSES.length;
      this.say(`Pose: ${AVATAR_POSES[app.avatar.pose].name}`);
    });
    inp.on('KeyH', () => {
      if (!this.active) return;
      this.panel.style.display = this.panel.style.display === 'none' ? 'block' : 'none';
    });
    inp.on('Enter', () => this.active && this.capture());
  }

  enter() {
    const app = this.app;
    const c = app.cameraPose();
    this.pose = { s: c.s, z: c.z, h: c.h, yaw: c.yaw, pitch: c.pitch, roll: 0 };
    // start just behind and above the player so their Quinlan is in frame
    const back = 3.2;
    this.pose.s = mod(c.s + Math.sin(c.yaw) * back, CIRC);
    this.pose.z = c.z + Math.cos(c.yaw) * back;
    this.pose.h = Math.max(c.h + 0.5, app.world.groundHeight(this.pose.s, this.pose.z) + 0.4);
    this.pose.pitch = -0.18;
    this.vel = { s: 0, z: 0, h: 0 };
    this.savedFov = app.pipeline.hfovDeg;
    this.fov = Math.min(this.savedFov, 80);
    app.cameraOverride = this.pose;
    app.paused = true;
    app.avatar.setVisible(true);
    app.pipeline.setVision('off');
    app.pipeline.setDof(true);
    this.active = true;
    this.panel.style.display = 'block';
    this.panelTimer = 8;
    this.showStatus();
  }

  exit() {
    const app = this.app;
    app.cameraOverride = null;
    app.paused = false;
    app.simFrozen = false;
    app.avatar.frozen = false;
    app.avatar.pose = 0;
    app.avatar.setVisible(false);
    app.pipeline.setDof(false);
    app.pipeline.setHorizontalFov(this.savedFov);
    this.active = false;
    for (const e of [this.panel, this.status, this.flash]) e.style.display = 'none';
  }

  update(dt: number) {
    const app = this.app;
    const inp = app.input.last;
    const k = app.input;
    const P = this.pose;
    // look (mouse / right stick) and roll
    P.yaw -= inp.lookX * (this.fov / 90);
    P.pitch = clamp(P.pitch - inp.lookY * (this.fov / 90), -1.55, 1.55);
    const roll = (k.isDown('KeyQ') ? 1 : 0) - (k.isDown('KeyE') ? 1 : 0);
    P.roll = clamp(P.roll + roll * dt * 0.8, -0.8, 0.8);
    // fly
    const fast = k.isDown('ShiftLeft') || k.isDown('ShiftRight') ? 5 : 1;
    const slow = k.isDown('ControlLeft') || k.isDown('AltLeft') ? 0.25 : 1;
    const speed = 3.5 * fast * slow;
    const fs = -Math.sin(P.yaw);
    const fz = -Math.cos(P.yaw);
    const cp = Math.cos(P.pitch);
    const sp = Math.sin(P.pitch);
    const up = (k.isDown('Space') ? 1 : 0) - (k.isDown('KeyC') ? 1 : 0);
    const ws = (fs * cp * inp.moveY + -fz * inp.moveX) * speed;
    const wz = (fz * cp * inp.moveY + fs * inp.moveX) * speed;
    const wh = (sp * inp.moveY + up) * speed;
    this.vel.s = damp(this.vel.s, ws, 6, dt);
    this.vel.z = damp(this.vel.z, wz, 6, dt);
    this.vel.h = damp(this.vel.h, wh, 6, dt);
    P.s = mod(P.s + this.vel.s * dt, CIRC);
    P.z += this.vel.z * dt;
    P.h += this.vel.h * dt;
    // stay near the player and above the ground
    const p = app.player;
    const ds = wrapS(P.s - p.s);
    const dz = P.z - p.z;
    const d = Math.hypot(ds, dz);
    if (d > TETHER) {
      P.s = mod(p.s + (ds / d) * TETHER, CIRC);
      P.z = p.z + (dz / d) * TETHER;
    }
    const g = app.world.groundHeight(P.s, P.z);
    P.h = clamp(P.h, g + 0.15, p.h + 400);
    // zoom
    app.pipeline.setHorizontalFov(damp(app.pipeline.hfovDeg, this.fov, 8, dt));
    // focus
    if (this.wheel !== 0) {
      this.autofocus = false;
      this.focus = clamp(this.focus * Math.pow(1.12, this.wheel), 0.3, 5000);
      this.wheel = 0;
      this.showStatus();
    }
    if (this.autofocus) this.focus = damp(this.focus, this.autoFocusDistance(), 6, dt);
    const dof = app.pipeline.dof;
    dof.cocMaterial.focusDistance = this.focus;
    dof.cocMaterial.focusRange = Math.max(0.15, this.focus * 0.5) / this.aperture;
    dof.bokehScale = clamp(1.2 + this.aperture * 1.6, 0.5, 8);
    if (this.sayTimer > 0) {
      this.sayTimer -= dt;
      if (this.sayTimer <= 0) this.showStatus();
    }
    // help fades after a while
    if (this.panelTimer > 0) {
      this.panelTimer -= dt;
      if (this.panelTimer <= 0) this.panel.style.display = 'none';
    }
  }

  /** Distance to what is under the screen centre: the avatar if framed, else the terrain. */
  private autoFocusDistance(): number {
    const app = this.app;
    const P = this.pose;
    const p = app.player;
    const fs = -Math.sin(P.yaw) * Math.cos(P.pitch);
    const fz = -Math.cos(P.yaw) * Math.cos(P.pitch);
    const fh = Math.sin(P.pitch);
    // the player's avatar (chest height)
    const as = wrapS(p.s - P.s);
    const az = p.z - P.z;
    const ah = p.h + 0.7 - P.h;
    const ad = Math.hypot(as, az, ah);
    const along = as * fs + az * fz + ah * fh;
    if (along > 0 && Math.acos(clamp(along / ad, -1, 1)) < 0.2) return along;
    // march the terrain along the view ray
    let t = 0.5;
    for (let i = 0; i < 90; i++) {
      const s = P.s + fs * t;
      const z = P.z + fz * t;
      const h = P.h + fh * t;
      if (h < app.world.groundHeight(s, z)) return t;
      t *= 1.08;
      if (t > 4000) break;
    }
    return 4000;
  }

  private showStatus() {
    if (this.sayTimer > 0) return;
    this.status.style.display = 'block';
    const f = this.focus < 10 ? this.focus.toFixed(1) : Math.round(this.focus).toString();
    this.status.textContent = `focus ${this.autofocus ? 'auto' : `${f} m`} · f/${(2.8 / this.aperture).toFixed(1)} · ${Math.round(this.fov)}°`;
  }

  /** Short message in the status line (the HUD is hidden in photo mode). */
  private say(msg: string) {
    this.status.style.display = 'block';
    this.status.textContent = msg;
    this.sayTimer = 1.8;
  }

  capture() {
    const app = this.app;
    app.afterRender.push(() => {
      app.canvas.toBlob((b) => {
        if (!b) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        const t = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        a.download = `heavens-river-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }, 'image/png');
      this.flash.style.display = 'block';
      this.flash.classList.remove('go');
      void this.flash.offsetWidth;
      this.flash.classList.add('go');
      this.say('Photo saved');
    });
  }
}
