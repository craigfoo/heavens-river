// One-shot sound effects, all synthesized from blips, filtered noise bursts
// and bubbles (synth.ts). Routing matters:
//  - `world`: footsteps and Anek's bird; muffled underwater and ducked in menus.
//    Other people's splashes go through `far`, the world bus plus a reverb
//    send, so they sit back in the scene.
//  - `direct`: splash, dive and the surfacing gasp; bypass the underwater
//    low-pass so they stay crisp at the moment the head crosses the surface.
//  - `ui`: clicks, the arrival chime and the cutscene whoosh; never ducked.

import { AMBIENT_RESERVE, blip, bubble, gn, knock, noiseBurst, type Kit } from './synth';
import { syllable } from './voice';
import { clamp, clamp01, mtof, pick, rand } from './util';

export type Surface = 'grass' | 'stone' | 'wood' | 'water';

export class Sfx {
  private readonly chimeBus: GainNode;
  private readonly far: GainNode;

  constructor(
    private readonly k: Kit,
    private readonly world: AudioNode,
    private readonly direct: AudioNode,
    private readonly ui: AudioNode,
    reverb: AudioNode,
    private readonly wave: PeriodicWave,
  ) {
    // the chime rings into the reverb a little
    this.chimeBus = gn(k.ctx, 1);
    this.chimeBus.connect(ui);
    const send = gn(k.ctx, 0.35);
    this.chimeBus.connect(send);
    send.connect(reverb);
    this.far = gn(k.ctx, 1);
    this.far.connect(world);
    const farSend = gn(k.ctx, 0.6);
    this.far.connect(farSend);
    farSend.connect(reverb);
  }

  private get now(): number {
    return this.k.ctx.currentTime + 0.005;
  }

  splash(intensity: number): void {
    const k = this.k;
    const t = this.now;
    const i = clamp01(intensity);
    const s = 0.35 + 0.65 * i;
    // impact: bright noise dropping in pitch, plus a soft plunge (kept light:
    // a sharp low sweep here sounds like a kick drum, not water)
    noiseBurst(k, this.direct, { t, filter: 'bandpass', f0: 1800, f1: 500, glide: 0.25, q: 0.7, peak: 0.35 * s, attack: 0.008, decay: 0.2 + 0.5 * i });
    blip(k, this.direct, { t, f0: 200, f1: 90, glide: 0.2, peak: 0.02 + 0.06 * i, attack: 0.015, decay: 0.25 });
    // spray hiss
    noiseBurst(k, this.direct, { t: t + 0.02, filter: 'highpass', f0: 3000, q: 0.5, peak: 0.12 * s, attack: 0.02, decay: 0.3 + 0.6 * i, pan: rand(-0.3, 0.3) });
    // bubbles around you, then droplets falling back
    for (let n = 0, c = 4 + Math.round(10 * i); n < c; n++)
      bubble(k, this.direct, t + rand(0.05, 0.6), rand(300, 1200), rand(0.02, 0.06) * s, rand(-0.7, 0.7));
    for (let n = 0, c = 2 + Math.round(6 * i); n < c; n++)
      bubble(k, this.direct, t + rand(0.2, 1.1), rand(1200, 3000), rand(0.01, 0.03) * s, rand(-0.8, 0.8));
  }

  /**
   * Someone else's splash (a kid diving off a pier) heard from where you
   * stand: a soft wash of spray and a few droplets, with no low thump.
   * level 0..1 is already scaled for distance; pan -1 (left) .. 1 (right).
   */
  splashAway(level: number, pan: number): void {
    const k = this.k;
    const g = clamp01(level);
    if (g < 0.02) return;
    const t = this.now;
    const p = clamp(pan, -1, 1) * 0.8;
    noiseBurst(k, this.far, { t, filter: 'bandpass', f0: 1600, f1: 700, glide: 0.3, q: 0.8, peak: 0.36 * g, attack: 0.025, decay: 0.5, pan: p, reserve: AMBIENT_RESERVE });
    noiseBurst(k, this.far, { t: t + 0.04, filter: 'highpass', f0: 2800, q: 0.5, peak: 0.12 * g, attack: 0.05, decay: 0.7, pan: p, reserve: AMBIENT_RESERVE });
    for (let n = 0, c = 3 + Math.round(4 * g); n < c; n++)
      bubble(k, this.far, t + rand(0.15, 0.9), rand(900, 2600), rand(0.02, 0.05) * g, clamp(p + rand(-0.25, 0.25), -1, 1), AMBIENT_RESERVE);
  }

  step(surface: Surface, quad: boolean): void {
    const k = this.k;
    const t = this.now;
    const v = rand(0.85, 1.18);
    // paws: a lighter front-then-back pair; feet: one firmer step
    const taps = quad ? [0, rand(0.06, 0.1)] : [0];
    for (let i = 0; i < taps.length; i++) {
      const tt = t + taps[i];
      const g = (quad ? 0.6 : 1) * (i ? 0.7 : 1) * rand(0.8, 1.1);
      switch (surface) {
        case 'grass':
          noiseBurst(k, this.world, { t: tt, filter: 'bandpass', f0: 2600 * v, f1: 1800 * v, q: 0.9, peak: 0.05 * g, attack: 0.015, decay: 0.12 });
          blip(k, this.world, { t: tt, f0: 90 * v, f1: 60, peak: 0.05 * g, decay: 0.07 });
          break;
        case 'stone':
          noiseBurst(k, this.world, { t: tt, filter: 'highpass', f0: 2500 * v, q: 0.7, peak: 0.05 * g, attack: 0.001, decay: 0.035 });
          blip(k, this.world, { t: tt, f0: 170 * v, f1: 110, peak: 0.08 * g, attack: 0.002, decay: 0.06 });
          break;
        case 'wood':
          knock(k, this.world, tt, 210 * v, 0.07 * g);
          break;
        case 'water':
          noiseBurst(k, this.world, { t: tt, filter: 'bandpass', f0: 1400 * v, f1: 700, q: 1, peak: 0.14 * g, attack: 0.006, decay: 0.18 });
          bubble(k, this.world, tt + 0.03, rand(500, 1100), 0.04 * g, rand(-0.3, 0.3));
          break;
      }
    }
  }

  dive(): void {
    const k = this.k;
    const t = this.now;
    // the surface closing overhead, then a swirl of bubbles
    noiseBurst(k, this.direct, { t, filter: 'lowpass', f0: 2500, f1: 300, glide: 0.35, q: 1.5, peak: 0.25, attack: 0.01, decay: 0.45 });
    blip(k, this.direct, { t, f0: 220, f1: 70, glide: 0.25, peak: 0.18, attack: 0.01, decay: 0.3 });
    let bt = t + 0.05;
    for (let i = 0; i < 12; i++) {
      bubble(k, this.direct, bt, rand(250, 1100), rand(0.02, 0.05), rand(-0.6, 0.6));
      bt += rand(0.03, 0.08);
    }
  }

  surfaceBreath(): void {
    const k = this.k;
    const t = this.now;
    // water sheeting off the head
    noiseBurst(k, this.direct, { t, filter: 'bandpass', f0: 2500, f1: 1200, q: 0.8, peak: 0.1, attack: 0.01, decay: 0.35 });
    // the gasp: breath through an opening throat, a sharp inhale...
    const g = t + 0.06;
    noiseBurst(k, this.direct, { t: g, buf: 'pink', filter: 'bandpass', f0: 900, f1: 1700, glide: 0.3, q: 1.6, peak: 0.4, attack: 0.2, hold: 0.05, decay: 0.12 });
    noiseBurst(k, this.direct, { t: g, filter: 'bandpass', f0: 2600, f1: 3200, glide: 0.3, q: 2.5, peak: 0.12, attack: 0.2, hold: 0.05, decay: 0.1 });
    syllable(k, this.direct, this.wave, { t: g + 0.2, hz: 330, hzEnd: 290, dur: 0.08, vowel: 'a', peak: 0.06 });
    // ...and a relieved exhale
    noiseBurst(k, this.direct, { t: g + 0.7, buf: 'pink', filter: 'bandpass', f0: 1100, f1: 700, glide: 0.5, q: 1.2, peak: 0.13, attack: 0.05, hold: 0.1, decay: 0.45 });
    for (let i = 0; i < 5; i++) bubble(k, this.direct, t + rand(0.1, 1.2), rand(1400, 3000), rand(0.01, 0.025), rand(-0.6, 0.6));
  }

  uiClick(): void {
    const t = this.now;
    blip(this.k, this.ui, { t, f0: 1320, f1: 1180, glide: 0.03, peak: 0.06, attack: 0.001, decay: 0.06 });
    blip(this.k, this.ui, { t, f0: 2650, peak: 0.02, attack: 0.001, decay: 0.03 });
  }

  /** Arrival / discovery: a rising pentatonic arpeggio of soft bells. */
  chime(): void {
    const t = this.now;
    const base = pick([62, 64, 65, 67]);
    const shape = pick([
      [0, 4, 7, 12],
      [0, 7, 12, 16],
      [0, 2, 7, 14],
      [0, 4, 9, 16],
    ]);
    for (let i = 0; i < shape.length; i++) this.bell(t + i * 0.11, mtof(base + shape[i]), 0.08 * (1 - i * 0.1));
  }

  private bell(t: number, f: number, peak: number): void {
    const partials: [number, number, number][] = [
      [1, 1, 2.2],
      [2.0, 0.4, 1.2],
      [3.01, 0.2, 0.7],
      [4.2, 0.08, 0.4],
    ];
    for (const [m, a, d] of partials) blip(this.k, this.chimeBus, { t, f0: f * m, peak: peak * a, attack: 0.003, decay: d });
  }

  /** Cutscene transition: air sweeping past from left to right. */
  whoosh(): void {
    const k = this.k;
    if (!k.pool.ok()) return;
    const ctx = k.ctx;
    const t = this.now;
    const src = ctx.createBufferSource();
    src.buffer = k.noise.pink;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(250, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + 0.65);
    bp.frequency.exponentialRampToValueAtTime(450, t + 1.4);
    const g = gn(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.62);
    g.gain.setTargetAtTime(0, t + 0.7, 0.2);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(-0.8, t);
    pan.pan.linearRampToValueAtTime(0.8, t + 1.4);
    src.connect(bp);
    bp.connect(g);
    g.connect(pan);
    pan.connect(this.ui);
    src.start(t, Math.random() * 3);
    src.stop(t + 1.9);
    k.pool.track(src, [src, bp, g, pan]);
    blip(k, this.ui, { t: t + 0.3, f0: 70, f1: 40, glide: 0.8, peak: 0.12, attack: 0.3, decay: 0.7 });
  }

  /**
   * Anek's surveillance bird: bird-like, but not quite right. A servo whirr,
   * three ring-modulated chirps at quantized pitches, a stepped falling sweep
   * and a tiny mechanical click.
   */
  birdChirp(): void {
    const k = this.k;
    if (!k.pool.ok(4)) return;
    const ctx = k.ctx;
    const t = this.now;
    const pan = rand(-0.6, 0.6);
    // servo whirr
    noiseBurst(k, this.world, { t, filter: 'bandpass', f0: 900, f1: 1500, glide: 0.12, q: 4, peak: 0.05, attack: 0.02, hold: 0.06, decay: 0.05, pan });
    blip(k, this.world, { t, f0: 180, f1: 320, glide: 0.12, type: 'sawtooth', peak: 0.015, attack: 0.02, decay: 0.12, pan });
    // chirps: square carrier ring-modulated by a sine for metallic sidebands
    const car = ctx.createOscillator();
    car.type = 'square';
    const mod = ctx.createOscillator();
    mod.frequency.value = rand(430, 560);
    const ring = gn(ctx, 0);
    mod.connect(ring.gain);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const env = gn(ctx, 0);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    car.connect(ring);
    ring.connect(hp);
    hp.connect(env);
    env.connect(p);
    p.connect(this.world);
    const peak = 0.07;
    const steps = [2400, 2800, 3200, 3600];
    let c = t + 0.17;
    for (let i = 0; i < 3; i++) {
      car.frequency.setValueAtTime(pick(steps), c);
      env.gain.setValueAtTime(0, c);
      env.gain.linearRampToValueAtTime(peak, c + 0.005);
      env.gain.setValueAtTime(peak, c + 0.04);
      env.gain.linearRampToValueAtTime(0, c + 0.05);
      c += 0.09;
    }
    // stepped falling sweep, like a bird call played on a counter
    c += 0.06;
    env.gain.setValueAtTime(0, c);
    env.gain.linearRampToValueAtTime(peak * 0.8, c + 0.01);
    for (let i = 0; i < 8; i++) car.frequency.setValueAtTime(3600 - i * 230, c + i * 0.025);
    env.gain.setValueAtTime(peak * 0.8, c + 0.2);
    env.gain.linearRampToValueAtTime(0, c + 0.22);
    car.start(t);
    mod.start(t);
    car.stop(c + 0.3);
    mod.stop(c + 0.3);
    k.pool.track(car, [car, mod, ring, hp, env, p]);
    noiseBurst(k, this.world, { t: c + 0.26, filter: 'highpass', f0: 5000, q: 0.7, peak: 0.04, attack: 0.001, decay: 0.012, pan });
  }
}
