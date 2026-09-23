// Arrival sequence (spec section 8): Eta Leporis and the strand as a (3,8)
// torus knot, the dive to Spaceport 4 on the non-rotating outer shell, the
// Spin Transfer up to the inner shell's 805 m/s, the elevator down through
// the shell and the doors opening onto golden light. About a minute long and
// skippable at any point.
//
// The host owns the renderer and the loop: start(onDone), then update(dt) and
// render() every frame. Each shot draws its own Scene + PerspectiveCamera into
// an HDR multisampled target, and a final pass (ACES, glow, fades) draws that
// to the canvas. The renderer's tone mapping and clear colour are not
// modified; autoClear and the render target are restored after every render().

import { Matrix4, Quaternion, Vector2, Vector3, WebGLRenderer } from 'three';
import { IntroSet, ViewInfo, clamp01, lerp, smoothstep, window4 } from './common';
import { ELEVATOR, ElevatorSet } from './elevatorSet';
import { INTRO_END_COLOR, IntroOverlay } from './overlay';
import { PortSet } from './portSet';
import { PostPass } from './post';
import { SPACE, SpaceSet } from './spaceSet';
import { SPIN_SPEED, TRANSFER, TransferSet, transferSpeed } from './transferSet';

export { INTRO_END_COLOR };

export type IntroPhase = 'space' | 'approach' | 'spin' | 'elevator' | 'doors';

export interface IntroHooks {
  onPhase?: (name: IntroPhase) => void;
  /** 0..1 during the Spin Transfer (vehicle speed / 805 m/s), every update until the clamps bite. */
  onSpinProgress?: (p: number) => void;
  /** true while the elevator cab is moving. */
  onElevator?: (on: boolean) => void;
  /** Optional: the clamps bite at the end of the Spin Transfer (clunk; silence the whine). */
  onDock?: () => void;
  /** Optional: skip() was called; stop intro audio now (onDone follows after a ~0.6 s fade). */
  onSkip?: () => void;
  /** Optional: bind Enter / Space / Escape and taps to skip() (default true). */
  bindSkipInput?: boolean;
}

/** Start times (s from start()) of each phase, and the end. */
export const INTRO_TIMELINE = {
  space: 0,
  approach: SPACE.diveStart, // 16
  spin: 30,
  elevator: 46,
  doors: 46 + ELEVATOR.doorsOpen, // 55.6
  end: 62,
} as const;

const TL = INTRO_TIMELINE;
/** The dive dissolves into the port close-up over XFADE seconds from PORT_CUT. */
const PORT_CUT = 22.6;
const XFADE = 0.9;
const SKIP_FADE = 0.6;
/** Render-target budget (pixels) before the intro renders below native resolution. */
const MAX_PIXELS = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 1.1e6 : 2.4e6;

interface Grade {
  exposure: number;
  bloom: number;
  bloomThr: number;
}

function phaseAt(t: number): IntroPhase {
  if (t < TL.approach) return 'space';
  if (t < TL.spin) return 'approach';
  if (t < TL.elevator) return 'spin';
  if (t < TL.doors) return 'elevator';
  return 'doors';
}

/** Dip to black: fade out over [a, b], cut at b, fade in over [b, c]. */
function dip(t: number, a: number, b: number, c: number) {
  return t < b ? smoothstep(a, b, t) : 1 - smoothstep(b, c, t);
}

export class IntroSequence {
  private readonly renderer: WebGLRenderer;
  private readonly hooks: IntroHooks;
  private readonly overlay: IntroOverlay;
  private readonly post: PostPass;
  private readonly space: SpaceSet;
  private readonly port: PortSet;
  private readonly transfer: TransferSet;
  private readonly elevator: ElevatorSet;
  private time = 0;
  private dt = 1 / 60;
  private started = false;
  private finished = false;
  private disposed = false;
  private skipAt = -1;
  private onDone: (() => void) | null = null;
  private phase: IntroPhase | null = null;
  private elevatorOn = false;
  private docked = false;
  private aspect = 0;
  private size = new Vector2();
  private inputBound = false;

  constructor(renderer: WebGLRenderer, overlay: HTMLElement, hooks: IntroHooks = {}) {
    this.renderer = renderer;
    this.hooks = hooks;
    this.overlay = new IntroOverlay(overlay);
    this.post = new PostPass(INTRO_END_COLOR);
    this.space = new SpaceSet();
    this.port = new PortSet();
    this.transfer = new TransferSet();
    this.elevator = new ElevatorSet();
    this.matchPortToDive();
    this.precompile();
  }

  get active(): boolean {
    return this.started && !this.finished && !this.disposed;
  }

  /** Current time (s) since start(). */
  get elapsed() {
    return this.time;
  }

  start(onDone: () => void) {
    if (this.started || this.disposed) return;
    this.started = true;
    this.onDone = onDone;
    this.time = 0;
    if (this.hooks.bindSkipInput !== false) {
      window.addEventListener('keydown', this.onKey);
      window.addEventListener('pointerdown', this.onPointer);
      this.inputBound = true;
    }
    this.advance();
  }

  update(dt: number) {
    if (!this.active) return;
    this.dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += this.dt;
    this.advance();
  }

  /** Jump to time t (s). For previews and debugging; hooks fire for the new state. */
  seek(t: number) {
    if (!this.active) return;
    this.time = Math.max(0, Math.min(t, TL.end - 1e-3));
    this.skipAt = -1;
    if (this.time < TL.spin + TRANSFER.clunk) this.docked = false;
    this.advance();
  }

  skip() {
    if (!this.active || this.skipAt >= 0) return;
    this.skipAt = this.time;
    this.hooks.onSkip?.();
    if (this.elevatorOn) {
      this.elevatorOn = false;
      this.hooks.onElevator?.(false);
    }
    this.advance();
  }

  resize(w: number, h: number) {
    if (w > 0 && h > 0) this.aspect = w / h;
  }

  render() {
    if (!this.started || this.disposed) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    r.getDrawingBufferSize(this.size);
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, this.size.x * this.size.y)));
    const w = Math.max(1, Math.round(this.size.x * scale));
    const h = Math.max(1, Math.round(this.size.y * scale));
    this.post.setSize(w, h);
    const t = this.time;
    const view: ViewInfo = {
      aspect: this.aspect || this.size.x / Math.max(1, this.size.y),
      heightPx: h,
      pxRatio: r.getPixelRatio() * scale,
      dt: this.dt,
      time: t,
    };

    // which shot(s) to draw
    let main: IntroSet;
    let local: number;
    let prev: IntroSet | null = null;
    let prevLocal = 0;
    let mix = 1;
    let grade: Grade;
    if (t < PORT_CUT) {
      main = this.space;
      local = t;
      grade = { exposure: 1.0, bloom: 0.65, bloomThr: 0.9 };
    } else if (t < TL.spin) {
      main = this.port;
      local = t - PORT_CUT;
      grade = { exposure: 1.15, bloom: 0.8, bloomThr: 0.8 };
      mix = smoothstep(PORT_CUT, PORT_CUT + XFADE, t);
      if (mix < 1) {
        prev = this.space;
        prevLocal = t;
        grade.exposure = lerp(1.0, 1.15, mix);
      }
    } else if (t < TL.elevator) {
      main = this.transfer;
      local = t - TL.spin;
      grade = { exposure: 1.3, bloom: 0.8, bloomThr: 0.9 };
    } else {
      main = this.elevator;
      local = t - TL.elevator;
      const flood = smoothstep(TL.doors, TL.end, t);
      grade = { exposure: lerp(1.15, 1.5, flood), bloom: lerp(0.8, 1.3, flood), bloomThr: lerp(0.9, 0.6, flood) };
    }
    if (!this.finished) {
      if (prev) {
        prev.update(prevLocal, view);
        r.setRenderTarget(this.post.rtB);
        r.render(prev.scene, prev.camera);
      }
      main.update(local, view);
      r.setRenderTarget(this.post.rt);
      r.render(main.scene, main.camera);
    }

    // fades: in from black, dips between shots, out to gold at the end or on skip
    let black = 1 - smoothstep(0, 3.0, t);
    black = Math.max(black, dip(t, 29.2, TL.spin, TL.spin + 0.8));
    black = Math.max(black, dip(t, 45.2, TL.elevator, TL.elevator + 0.7));
    let gold = smoothstep(TL.end - 2.4, TL.end - 0.2, t);
    if (this.skipAt >= 0) gold = Math.max(gold, smoothstep(this.skipAt, this.skipAt + SKIP_FADE - 0.05, t));
    if (this.finished) gold = 1;
    this.post.set({
      mix,
      exposure: grade.exposure,
      bloom: grade.bloom,
      bloomThr: grade.bloomThr,
      black,
      fade: gold,
      vignette: 0.42,
      grain: 0.016,
      time: t,
    });
    r.setRenderTarget(null);
    r.render(this.post.scene, this.post.camera);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindInput();
    this.space.dispose();
    this.port.dispose();
    this.transfer.dispose();
    this.elevator.dispose();
    this.post.dispose();
    this.overlay.dispose();
    this.onDone = null;
  }

  // -------------------------------------------------------------------------

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat || !this.active || this.time < 0.5) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
      e.preventDefault();
      this.skip();
    }
  };

  private onPointer = () => {
    if (this.active && this.time >= 0.5) this.skip();
  };

  private unbindInput() {
    if (!this.inputBound) return;
    this.inputBound = false;
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointerdown', this.onPointer);
  }

  /** Phase hooks, audio hooks, captions and the end of the sequence. */
  private advance() {
    const t = this.time;
    const h = this.hooks;
    const ph = phaseAt(t);
    if (ph !== this.phase && this.skipAt < 0) {
      this.phase = ph;
      h.onPhase?.(ph);
    }
    if (this.skipAt < 0) {
      if (ph === 'spin') {
        const lt = t - TL.spin;
        if (lt < TRANSFER.clunk) h.onSpinProgress?.(clamp01(transferSpeed(lt) / SPIN_SPEED));
        else if (!this.docked) {
          this.docked = true;
          h.onSpinProgress?.(1);
          h.onDock?.();
        }
      }
      const moving = t >= TL.elevator + ELEVATOR.moveStart && t < TL.elevator + ELEVATOR.moveEnd;
      if (moving !== this.elevatorOn) {
        this.elevatorOn = moving;
        h.onElevator?.(moving);
      }
    }

    // captions
    const out = this.skipAt >= 0 ? 1 - smoothstep(this.skipAt, this.skipAt + 0.3, t) : 1;
    const spinT = t - TL.spin;
    this.overlay.setCaptions({
      title: window4(t, 2.6, 4.4, 12.2, 13.8) * out,
      port: window4(t, 24.0, 25.0, 28.4, 29.2) * out,
      spin: window4(t, 30.6, 31.4, 44.8, 45.5) * out,
      elev: window4(t, 47.0, 48.0, 53.6, 54.6) * out,
      skip: window4(t, 1.2, 2.4, TL.end - 3.2, TL.end - 2.4) * out * 0.9,
    });
    if (ph === 'spin') {
      const matchT = TRANSFER.rampStart + TRANSFER.rampLen - 0.9;
      this.overlay.setSpeed(transferSpeed(spinT), spinT >= matchT, spinT >= TRANSFER.clunk);
    }

    const end = this.skipAt >= 0 ? this.skipAt + SKIP_FADE : TL.end;
    if (t >= end) this.finish();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.elevatorOn) {
      this.elevatorOn = false;
      this.hooks.onElevator?.(false);
    }
    this.unbindInput();
    this.overlay.release();
    const cb = this.onDone;
    this.onDone = null;
    cb?.();
  }

  /**
   * Light the port close-up like the end of the dive: the star keeps its
   * place on screen across the dissolve, and the rest of the strand arcs
   * across the port's sky where it really is.
   */
  private matchPortToDive() {
    const tMid = PORT_CUT + XFADE * 0.5;
    const qSpace = this.space.orientationAt(tMid, new Quaternion());
    const pos = new Vector3();
    const look = new Vector3();
    this.port.pose(tMid - PORT_CUT, pos, look);
    const qPort = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(pos, look, new Vector3(0, 1, 0)));
    // world(space) -> camera -> world(port)
    const R = qPort.clone().multiply(qSpace.clone().invert());
    const S = this.space.port.S;
    const sunDir = S.clone().negate().normalize().applyQuaternion(R);
    this.port.setSun(sunDir, 0.028);
    const strand = this.space.strandDirections(6000, 3).map((p) => ({ dir: p.dir.applyQuaternion(R), lit: p.lit }));
    this.port.setStrand(strand);
  }

  /** Compile every shot's shaders up front (for the intro's render target) to avoid hitches. */
  private precompile() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    try {
      this.post.setSize(4, 4);
      r.setRenderTarget(this.post.rt);
      for (const s of [this.space, this.port, this.transfer, this.elevator] as IntroSet[]) {
        void r.compileAsync(s.scene, s.camera).catch(() => undefined);
      }
      r.setRenderTarget(null);
      void r.compileAsync(this.post.scene, this.post.camera).catch(() => undefined);
    } finally {
      r.setRenderTarget(prev);
    }
  }
}
