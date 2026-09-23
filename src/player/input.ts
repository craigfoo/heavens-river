// Keyboard, mouse (pointer lock), gamepad and touch input, merged into one
// per-frame snapshot.

export interface InputFrame {
  moveX: number; // strafe -1..1 (right +)
  moveY: number; // forward -1..1
  lookX: number; // yaw delta (radians)
  lookY: number; // pitch delta (radians)
  quad: boolean;
  walkSlow: boolean;
  jump: boolean; // held
  jumpPressed: boolean;
  dive: boolean;
  burst: boolean;
  eyeL: number; // independent-eye steering (Q / LB held)
  eyeR: number; // (E / RB held)
  /** Look delta diverted to the steered eye(s) when eye steering is active. */
  eyeDX: number;
  eyeDY: number;
}

const IDLE: InputFrame = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, quad: false, walkSlow: false, jump: false, jumpPressed: false, dive: false, burst: false, eyeL: 0, eyeR: 0, eyeDX: 0, eyeDY: 0 };

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  sensitivity = 0.0022;
  invertY = false;
  locked = false;
  enabled = true;
  private element: HTMLElement;
  private handlers = new Map<string, ((e: KeyboardEvent) => void)[]>();
  private upHandlers = new Map<string, ((e: KeyboardEvent) => void)[]>();
  /** When set, holding Q/E diverts mouse look to the independent eyes. */
  eyeSteering = false;
  // touch
  private touchMove = { id: -1, x0: 0, y0: 0, x: 0, y: 0 };
  private touchLook = { id: -1, x: 0, y: 0 };
  touchActive = false;
  private touchJump = false;
  /** Most recent polled frame (for systems updated after the player). */
  last: InputFrame = { ...IDLE };

  constructor(element: HTMLElement) {
    this.element = element;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      for (const h of this.handlers.get(e.code) ?? []) h(e);
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (!this.keys.has(e.code)) return;
      this.keys.delete(e.code);
      for (const h of this.upHandlers.get(e.code) ?? []) h(e);
    });
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    this.setupTouch();
  }

  /** Register a key handler (fires on keydown). */
  on(code: string, fn: (e: KeyboardEvent) => void) {
    const list = this.handlers.get(code) ?? [];
    list.push(fn);
    this.handlers.set(code, list);
  }

  /** Register a key-release handler. */
  onUp(code: string, fn: (e: KeyboardEvent) => void) {
    const list = this.upHandlers.get(code) ?? [];
    list.push(fn);
    this.upHandlers.set(code, list);
  }

  requestLock() {
    if (this.touchActive) return;
    const el = this.element as HTMLElement & { requestPointerLock: (o?: object) => Promise<void> | void };
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => el.requestPointerLock());
    } catch {
      el.requestPointerLock();
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string) {
    return this.keys.has(code);
  }

  private setupTouch() {
    const el = this.element;
    el.addEventListener(
      'touchstart',
      (e) => {
        this.touchActive = true;
        for (const t of Array.from(e.changedTouches)) {
          if (t.clientX < window.innerWidth * 0.45 && this.touchMove.id < 0) {
            this.touchMove = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY };
          } else if (this.touchLook.id < 0) {
            this.touchLook = { id: t.identifier, x: t.clientX, y: t.clientY };
          }
        }
        e.preventDefault();
      },
      { passive: false },
    );
    el.addEventListener(
      'touchmove',
      (e) => {
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier === this.touchMove.id) {
            this.touchMove.x = t.clientX;
            this.touchMove.y = t.clientY;
          } else if (t.identifier === this.touchLook.id) {
            this.mouseDX += (t.clientX - this.touchLook.x) * 2.2;
            this.mouseDY += (t.clientY - this.touchLook.y) * 2.2;
            this.touchLook.x = t.clientX;
            this.touchLook.y = t.clientY;
          }
        }
        e.preventDefault();
      },
      { passive: false },
    );
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.touchMove.id) this.touchMove.id = -1;
        if (t.identifier === this.touchLook.id) this.touchLook.id = -1;
      }
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  /** Virtual stick state for the touch HUD. */
  get stick() {
    const m = this.touchMove;
    return { active: m.id >= 0, x0: m.x0, y0: m.y0, x: m.x, y: m.y };
  }

  setTouchJump(v: boolean) {
    this.touchJump = v;
  }

  poll(): InputFrame {
    const k = this.keys;
    let mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let my = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let lx = this.mouseDX * this.sensitivity;
    let ly = this.mouseDY * this.sensitivity * (this.invertY ? -1 : 1);
    this.mouseDX = 0;
    this.mouseDY = 0;
    let quad = k.has('ShiftLeft') || k.has('ShiftRight');
    let jump = k.has('Space') || this.touchJump;
    let jumpPressed = this.pressed.has('Space');
    let dive = k.has('KeyC');
    let eyeL = (k.has('KeyQ') ? 1 : 0);
    let eyeR = (k.has('KeyE') ? 1 : 0);
    // touch stick
    if (this.touchMove.id >= 0) {
      const dx = (this.touchMove.x - this.touchMove.x0) / 60;
      const dy = (this.touchMove.y - this.touchMove.y0) / 60;
      mx += Math.max(-1, Math.min(1, dx));
      my -= Math.max(-1, Math.min(1, dy));
      if (Math.hypot(dx, dy) > 1.6) quad = true;
    }
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
      mx += dz(p.axes[0] ?? 0);
      my -= dz(p.axes[1] ?? 0);
      lx += dz(p.axes[2] ?? 0) * 0.045;
      ly += dz(p.axes[3] ?? 0) * 0.035;
      if (p.buttons[0]?.pressed) {
        if (!jump) jumpPressed = true;
        jump = true;
      }
      if (p.buttons[1]?.pressed) dive = true;
      if (p.buttons[10]?.pressed || p.buttons[6]?.pressed) quad = true;
      if (p.buttons[4]?.pressed) eyeL = 1;
      if (p.buttons[5]?.pressed) eyeR = 1;
    }
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    let eyeDX = 0;
    let eyeDY = 0;
    if (this.eyeSteering && (eyeL || eyeR)) {
      eyeDX = lx;
      eyeDY = ly;
      lx = 0;
      ly = 0;
    }
    this.pressed.clear();
    if (!this.enabled) {
      this.last = { ...IDLE };
      return this.last;
    }
    return (this.last = {
      moveX: mx,
      moveY: my,
      lookX: lx,
      lookY: ly,
      quad,
      walkSlow: k.has('ControlLeft') || k.has('AltLeft'),
      jump,
      jumpPressed,
      dive,
      burst: quad,
      eyeL,
      eyeR,
      eyeDX,
      eyeDY,
    });
  }
}
