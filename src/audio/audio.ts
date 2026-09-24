// Procedural audio engine (spec 9, "Life and sound" in 7.1, barge ambience in
// 7.4). There are no audio files: every sound is synthesized with WebAudio
// from oscillators, a few shared looping noise buffers and filters.
//
//   ambience beds (river, wind, wildlife, town, barge) ─ stall ─┐
//   world one-shots (steps, Anek's bird, splashes), reverb ─────┴─ world
//   world ─ underwater low-pass ─ air ─┐
//   underwater bed (rumble, bubbles) ──┼─ duck (menus) ─┐
//   direct one-shots (splash, dive) ───┘                ├─ master ─ compressor ─ soft clip ─ out
//   ui (click, chime, whoosh), intro machines ──────────┘
//
// The game calls update() every frame with an AudioState. Parameters are
// smoothed and written at ~30 Hz; musical and random events are scheduled a
// few hundred ms ahead on the audio clock. Heavy layers (town singing, barge
// crew, crickets, intro machines) build their nodes on demand and release
// them when silent; transient voices are capped by a pool and disconnect
// themselves when done. Every public method is a no-op before start() (or
// after dispose()) and never throws.

import { RiverLayer, UnderwaterLayer, WindLayer } from './ambience';
import { BargeLayer } from './barge';
import { Elevator, SpinTransfer } from './machines';
import { NatureLayer } from './nature';
import { Sfx, type Surface } from './sfx';
import { bq, gn, makeImpulse, makeNoiseBank, makeVoiceWave, type Kit } from './synth';
import { TownLayer } from './town';
import { SmoothParam, VoicePool, clamp, clamp01, expLerp, fin, smoothstep } from './util';

export interface AudioState {
  /** 0..1, 1 = standing at/in the river. */
  waterProximity: number;
  /** m/s current speed of the nearest water. */
  waterSpeed: number;
  /** 0..1 */
  underwater: number;
  /** Metres above the local valley floor (wind grows with it). */
  altitude: number;
  /** 0..1 extra wind (near barrier mountains). */
  windExposure: number;
  /** Player speed m/s. */
  speed: number;
  /** 0..1 proximity to a town centre (0 = far away). */
  townSinging: number;
  /** 0..1 (hamlet .. river city). */
  townSize: number;
  /** On a river barge: crew work songs. */
  onBarge: boolean;
  /** 0..1 (0 = midnight, 0.5 = noon). */
  timeOfDay: number;
  /** Menus open: duck everything. */
  paused: boolean;
}

/** Max concurrent transient voices. */
const MAX_VOICES = 96;
/** Seconds between parameter writes. */
const CTL_INTERVAL = 1 / 30;
/** Master gain at full volume (the compressor adds a few dB of make-up). */
const HEADROOM = 0.85;
/** Duck level while menus are open. */
const DUCK = 0.2;

const SURFACES: readonly Surface[] = ['grass', 'stone', 'wood', 'water'];

interface Graph {
  ctx: AudioContext;
  kit: Kit;
  level: SmoothParam;
  duck: SmoothParam;
  stall: SmoothParam;
  lowpass: SmoothParam;
  air: SmoothParam;
  river: RiverLayer;
  wind: WindLayer;
  under: UnderwaterLayer;
  nature: NatureLayer;
  town: TownLayer;
  barge: BargeLayer;
  sfx: Sfx;
  spin: SpinTransfer;
  lift: Elevator;
  /** Output gains of everything the water volume scales. */
  water: SmoothParam[];
  taps: Record<string, AudioNode>;
  analysers: Map<string, AnalyserNode>;
}

/** Transparent below 0.7, then a smooth knee that never exceeds ~0.93. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = Math.sign(x) * (a < 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3));
  }
  return c;
}

export class AudioEngine {
  private g: Graph | null = null;
  private volume = 0.8;
  private waterVolume = 1;
  private muted = false;
  private disposed = false;
  private ctlAcc = 0;
  private lastNow = 0;
  private lastUpdateWall = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;
  private wasRunning = false;
  private lastResumeTry = 0;
  private readonly st: AudioState = {
    waterProximity: 0,
    waterSpeed: 0,
    underwater: 0,
    altitude: 0,
    windExposure: 0,
    speed: 0,
    townSinging: 0,
    townSize: 0,
    onBarge: false,
    timeOfDay: 0.5,
    paused: false,
  };

  constructor() {}

  get started(): boolean {
    return this.g !== null && !this.disposed;
  }

  /** Create or resume the AudioContext. Call from a user gesture. */
  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.g) {
      let ctx: AudioContext | null = null;
      try {
        const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (!Ctor) return Promise.resolve();
        ctx = new Ctor({ latencyHint: 'interactive' });
        this.g = this.build(ctx);
        this.lastNow = ctx.currentTime;
        this.unlock(ctx);
        this.applyVolume();
        this.applyWaterVolume();
        this.timer = setInterval(() => this.tick(), 250);
        // idle work off the frame path: render barge creaks one at a time
        const idle = () => this.fx((g) => g.barge.prepare() && setTimeout(idle, 120));
        setTimeout(idle, 1000);
      } catch (e) {
        this.fail(e);
        this.g = null;
        if (ctx) void ctx.close().catch(() => undefined);
        return Promise.resolve();
      }
    }
    return this.resume();
  }

  setMasterVolume(v: number): void {
    this.volume = clamp01(fin(v, this.volume));
    this.applyVolume();
  }

  /** Water sounds (rivers, streams, underwater, others' splashes) relative to the master, 0..1. */
  setWaterVolume(v: number): void {
    this.waterVolume = clamp01(fin(v, this.waterVolume));
    this.applyWaterVolume();
  }

  setMuted(m: boolean): void {
    this.muted = !!m;
    this.applyVolume();
  }

  /** Per-frame state. Cheap: a few comparisons, params written at ~30 Hz. */
  update(s: AudioState, dt: number): void {
    const g = this.g;
    if (!g || this.disposed) return;
    try {
      const now = g.ctx.currentTime;
      const clockDt = clamp(now - this.lastNow, 0, 0.25);
      this.lastNow = now;
      const step = fin(dt, 0) > 0 ? clamp(dt, 0, 0.25) : clockDt;
      const st = this.sanitize(s);
      this.lastUpdateWall = performance.now();
      this.ctlAcc += step;
      const ctl = this.ctlAcc >= CTL_INTERVAL;
      if (ctl) {
        this.ctlAcc = 0;
        g.duck.set(st.paused ? DUCK : 1, now);
        g.stall.set(1, now);
        g.lowpass.set(expLerp(20000, 500, st.underwater), now);
        g.air.set(1 - 0.5 * st.underwater, now);
      }
      // wind: nothing on the valley floor, strong above ~800 m, more by the
      // barrier ranges, and a little from your own speed
      const wind = clamp01(
        smoothstep(20, 900, st.altitude) * 0.85 + st.windExposure * 0.6 + Math.min(st.speed / 15, 1) * 0.25,
      );
      g.river.update(now, step, ctl, st.waterProximity, st.waterSpeed);
      g.wind.update(now, step, ctl, wind);
      g.under.update(now, ctl, st.underwater, st.speed);
      g.nature.update(now, step, ctl, st);
      g.town.update(now, step, ctl, st.townSinging, st.townSize);
      g.barge.update(now, step, ctl, st.onBarge, st.waterSpeed);
    } catch (e) {
      this.fail(e);
    }
  }

  // ---- one-shots -----------------------------------------------------------

  splash(intensity: number): void {
    this.fx((g) => g.sfx.splash(fin(intensity, 0.5)));
  }

  /** Someone else's splash: level 0..1 (scaled for distance), pan -1..1. */
  splashAway(level: number, pan: number): void {
    this.fx((g) => g.sfx.splashAway(fin(level, 0), fin(pan, 0)));
  }

  step(surface: 'grass' | 'stone' | 'wood' | 'water', quad: boolean): void {
    this.fx((g) => g.sfx.step(SURFACES.includes(surface) ? surface : 'grass', !!quad));
  }

  dive(): void {
    this.fx((g) => g.sfx.dive());
  }

  surfaceBreath(): void {
    this.fx((g) => g.sfx.surfaceBreath());
  }

  uiClick(): void {
    this.fx((g) => g.sfx.uiClick());
  }

  chime(): void {
    this.fx((g) => g.sfx.chime());
  }

  whoosh(): void {
    this.fx((g) => g.sfx.whoosh());
  }

  birdChirp(): void {
    this.fx((g) => g.sfx.birdChirp());
  }

  /** 0..1 continuous: rising whine as the transfer ramps up; silence at 1 (docked). */
  spinTransfer(progress: number): void {
    this.fx((g) => g.spin.set(fin(progress, 0), g.ctx.currentTime));
  }

  /** Hum while the elevator descends. */
  elevator(on: boolean): void {
    this.fx((g) => g.lift.set(!!on, g.ctx.currentTime));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      const g = this.g;
      this.g = null;
      if (g) void g.ctx.close().catch(() => undefined);
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Debug metering: an AnalyserNode tapping a named output, or null before
   * start(). Names: master, river, wind, underwater, birds, night, town,
   * barge, sfx, direct, ui, machines, reverb.
   */
  debugTap(name = 'master'): AnalyserNode | null {
    const g = this.g;
    if (!g) return null;
    try {
      let a = g.analysers.get(name);
      if (!a) {
        const node = g.taps[name];
        if (!node) return null;
        a = g.ctx.createAnalyser();
        a.fftSize = 2048;
        node.connect(a);
        g.analysers.set(name, a);
      }
      return a;
    } catch {
      return null;
    }
  }

  /** Transient voices currently sounding (debug). */
  get activeVoices(): number {
    return this.g?.kit.pool.active ?? 0;
  }

  // ---- internals -----------------------------------------------------------

  private build(ctx: AudioContext): Graph {
    const kit: Kit = { ctx, pool: new VoicePool(MAX_VOICES), noise: makeNoiseBank(ctx) };
    const wave = makeVoiceWave(ctx);

    // master: gentle glue compression, then a soft clipper as the limiter
    const master = gn(ctx, 0);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.3;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    master.connect(comp);
    comp.connect(clip);
    clip.connect(ctx.destination);

    const duck = gn(ctx, 1);
    duck.connect(master);
    const air = gn(ctx, 1);
    air.connect(duck);
    const lowpass = bq(ctx, 'lowpass', 20000, 0.7);
    lowpass.connect(air);
    const world = gn(ctx, 1);
    world.connect(lowpass);
    const amb = gn(ctx, 1);
    amb.connect(world);
    const uwBus = gn(ctx, 1);
    uwBus.connect(duck);
    const direct = gn(ctx, 1);
    direct.connect(duck);
    const sfxWorld = gn(ctx, 1);
    sfxWorld.connect(world);
    const ui = gn(ctx, 1);
    ui.connect(master);
    const machines = gn(ctx, 1);
    machines.connect(master);

    // one shared synthetic reverb; its return is part of the world
    const verbIn = gn(ctx, 1);
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx);
    const verbOut = gn(ctx, 0.5);
    verbIn.connect(verb);
    verb.connect(verbOut);
    verbOut.connect(world);

    const river = new RiverLayer(kit, amb);
    const wind = new WindLayer(kit, amb);
    const under = new UnderwaterLayer(kit, uwBus);
    const nature = new NatureLayer(kit, amb, verbIn);
    const town = new TownLayer(kit, amb, verbIn, wave);
    const barge = new BargeLayer(kit, amb, verbIn, wave);
    const sfx = new Sfx(kit, sfxWorld, direct, ui, verbIn, wave);
    const spin = new SpinTransfer(kit, machines);
    const lift = new Elevator(kit, machines);

    return {
      ctx,
      kit,
      level: new SmoothParam(master.gain, 0.05),
      duck: new SmoothParam(duck.gain, 0.12),
      stall: new SmoothParam(amb.gain, 0.3),
      lowpass: new SmoothParam(lowpass.frequency, 0.05, 0.01),
      air: new SmoothParam(air.gain, 0.08),
      river,
      wind,
      under,
      nature,
      town,
      barge,
      sfx,
      spin,
      lift,
      water: [river.out, under.out, sfx.far].map((n) => new SmoothParam(n.gain, 0.1)),
      taps: {
        master: clip,
        river: river.out,
        wind: wind.out,
        underwater: under.out,
        birds: nature.birdsOut,
        night: nature.nightOut,
        town: town.out,
        barge: barge.out,
        sfx: sfxWorld,
        direct,
        ui,
        machines,
        reverb: verbOut,
      },
      analysers: new Map(),
    };
  }

  /** Copy the caller's state into our own object, clamped and NaN-free. */
  private sanitize(s: Partial<AudioState> | null | undefined): AudioState {
    const o = s ?? {};
    const st = this.st;
    st.waterProximity = clamp01(fin(o.waterProximity));
    st.waterSpeed = clamp(Math.abs(fin(o.waterSpeed)), 0, 30);
    st.underwater = clamp01(fin(o.underwater));
    st.altitude = clamp(fin(o.altitude), -1000, 50000);
    st.windExposure = clamp01(fin(o.windExposure));
    st.speed = clamp(Math.abs(fin(o.speed)), 0, 2000);
    st.townSinging = clamp01(fin(o.townSinging));
    st.townSize = clamp01(fin(o.townSize));
    st.onBarge = !!o.onBarge;
    st.timeOfDay = ((fin(o.timeOfDay, 0.5) % 1) + 1) % 1;
    st.paused = !!o.paused;
    return st;
  }

  private applyVolume(): void {
    const g = this.g;
    if (!g) return;
    try {
      // squared: a perceptually even slider
      g.level.set(this.muted ? 0 : this.volume * this.volume * HEADROOM, g.ctx.currentTime);
    } catch (e) {
      this.fail(e);
    }
  }

  private applyWaterVolume(): void {
    const g = this.g;
    if (!g) return;
    try {
      // squared, like the master: a perceptually even slider
      const v = this.waterVolume * this.waterVolume;
      for (const p of g.water) p.set(v, g.ctx.currentTime);
    } catch (e) {
      this.fail(e);
    }
  }

  private resume(): Promise<void> {
    const ctx = this.g?.ctx;
    if (!ctx || ctx.state === 'running') return Promise.resolve();
    // resume() can stay pending outside a user gesture: never block on it
    const timeout = new Promise<void>((r) => setTimeout(r, 800));
    return Promise.race([ctx.resume().catch(() => undefined), timeout]).then(() => undefined);
  }

  /** Play one silent sample inside the gesture (older iOS needs this). */
  private unlock(ctx: AudioContext): void {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
      src.onended = () => src.disconnect();
    } catch {
      /* ignore */
    }
  }

  /** Housekeeping at 4 Hz: machine watchdogs, stalls, OS interruptions. */
  private tick(): void {
    const g = this.g;
    if (!g) return;
    try {
      const now = g.ctx.currentTime;
      const wall = performance.now();
      g.spin.tick(now);
      g.lift.tick(now);
      // no update() for a while (hidden tab, long load): fade the ambience
      if (wall - this.lastUpdateWall > 1500) g.stall.set(0, now);
      // the OS suspended a context that was running (e.g. a call on iOS): retry
      const state = g.ctx.state as string;
      if (state === 'running') this.wasRunning = true;
      else if (this.wasRunning && state !== 'closed' && wall - this.lastResumeTry > 2000) {
        this.lastResumeTry = wall;
        void g.ctx.resume().catch(() => undefined);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private fx(fn: (g: Graph) => void): void {
    const g = this.g;
    if (!g || this.disposed) return;
    try {
      fn(g);
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn('[audio] error ignored (further audio errors are silent):', e);
  }
}
