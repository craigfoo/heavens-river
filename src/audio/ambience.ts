// Continuous ambient beds built on the shared noise loops.
//  River: an airy rush (louder and brighter with current speed), soft lapping
//    wavelets (a noise band swelled by scheduled events) and droplet plips
//    that become a babble on fast streams. Slow water (the big rivers,
//    canals) is nearly silent: a faint bed, gentle lapping seconds apart and
//    the odd drop. Everything stays out of the low end, where noise reads as
//    traffic rather than water; only fast, heavy water adds a low body roar.
//  Wind: band-passed noise whose level and centre follow a random gust
//    process, tonal whistling over ridges when exposure is high, and low
//    buffeting in strong gusts.
//  Underwater: muffled rumble, a pressure hush and bursts of rising bubbles.
//    This bed bypasses the master low-pass: it is what you hear head-under.

import { AMBIENT_RESERVE, PoissonClock, bq, bubble, gn, loopSource, poisson, type Kit } from './synth';
import { SmoothParam, clamp01, expLerp, rand, smoothstep } from './util';

/**
 * Level trims (linear), calibrated by measuring in a headless browser. Keep
 * the river a soft background: A-weighted, standing at the water's edge it
 * sits about 10 dB under a town's singing, and it has faded out ~60 m away.
 */
const LVL = {
  rush: 0.12,
  body: 0.15,
  lap: 0.42,
  plip: 0.025,
  wind: 0.6,
  whistle: 0.5,
  buffet: 0.6,
  rumble: 0.2,
  hush: 0.08,
  bubble: 0.06,
};

const LOOKAHEAD = 0.2;

export class RiverLayer {
  readonly out: GainNode;
  private readonly rush: SmoothParam;
  private readonly rushTone: SmoothParam;
  private readonly body: SmoothParam;
  private readonly lapLevel: SmoothParam;
  private readonly lapGain: GainNode;
  private readonly lapBand: BiquadFilterNode;
  private nextLap = 0;
  private readonly plips = new PoissonClock();
  private wander = 0.5;
  private wanderTarget = 0.5;
  private prox = 0;
  private bright = 0;
  private calm = 1;

  constructor(
    private readonly k: Kit,
    dest: AudioNode,
  ) {
    const ctx = k.ctx;
    this.out = gn(ctx, 1);
    this.out.connect(dest);
    const pink = loopSource(ctx, k.noise.pink, 1);
    const brown = loopSource(ctx, k.noise.brown, 0.9);
    // rush: the airy hiss of moving water, kept above the rumble range
    const hp = bq(ctx, 'highpass', 400, 0.6);
    const lp = bq(ctx, 'lowpass', 2000, 0.5);
    const rushG = gn(ctx);
    pink.connect(hp);
    hp.connect(lp);
    lp.connect(rushG);
    rushG.connect(this.out);
    // body: the low roar of fast, heavy water (none below 60 Hz)
    const bhp = bq(ctx, 'highpass', 60, 0.6);
    const blp = bq(ctx, 'lowpass', 300, 0.6);
    const bodyG = gn(ctx);
    brown.connect(bhp);
    bhp.connect(blp);
    blp.connect(bodyG);
    bodyG.connect(this.out);
    // lapping: a noise band swelled by scheduled wavelets
    this.lapBand = bq(ctx, 'bandpass', 700, 0.9);
    this.lapGain = gn(ctx);
    const lapLevel = gn(ctx);
    pink.connect(this.lapBand);
    this.lapBand.connect(this.lapGain);
    this.lapGain.connect(lapLevel);
    lapLevel.connect(this.out);
    this.rush = new SmoothParam(rushG.gain, 0.3);
    this.rushTone = new SmoothParam(lp.frequency, 0.3, 0.01);
    this.body = new SmoothParam(bodyG.gain, 0.3);
    this.lapLevel = new SmoothParam(lapLevel.gain, 0.3);
  }

  update(now: number, dt: number, ctl: boolean, prox: number, speed: number): void {
    this.prox = prox;
    this.bright = smoothstep(0.6, 3.5, speed);
    // slow water (the big rivers, canals) is nearly silent: no hiss to speak
    // of, just unhurried lapping at the bank and the odd drop
    this.calm = 1 - smoothstep(1.4, 2.8, speed);
    // slow random "breathing" of the current
    this.wander += (this.wanderTarget - this.wander) * Math.min(1, dt * 0.4);
    if (Math.abs(this.wander - this.wanderTarget) < 0.02) this.wanderTarget = Math.random();
    if (ctl) {
      const rush = smoothstep(0.05, 2.5, speed);
      // a soft background: it falls away quickly as you walk off from the water,
      // and only a current you could see is heard as a hiss
      const flow = smoothstep(1.4, 3.5, speed);
      this.rush.set(prox * prox * (0.06 + 0.94 * flow) * (0.85 + 0.3 * this.wander) * LVL.rush, now);
      this.rushTone.set(expLerp(1400, 6000, this.bright * 0.8 + this.wander * 0.2), now);
      // the roar only where the water is really moving (rapids, fast streams)
      this.body.set(prox * prox * smoothstep(1.8, 4.5, speed) * LVL.body, now);
      this.lapLevel.set(Math.pow(prox, 2.5) * (1 - 0.5 * rush) * (1 - 0.3 * this.calm) * LVL.lap, now);
    }
    this.schedule(now);
  }

  private schedule(now: number): void {
    const horizon = now + LOOKAHEAD;
    if (this.prox < 0.02) {
      this.nextLap = now + 0.1;
      this.plips.due(now, horizon, 0);
      return;
    }
    if (this.nextLap < now) this.nextLap = now;
    // wavelets: soft swells; on slow water they are gentler, lower and seconds apart
    const k = this.calm;
    while (this.nextLap < horizon) {
      const t = this.nextLap;
      const rise = rand(0.15, 0.35) + k * rand(0.1, 0.35);
      this.lapBand.frequency.setTargetAtTime(rand(500, 1100) * (1 - 0.3 * k), t, 0.15);
      this.lapGain.gain.setTargetAtTime(rand(0.35, 1) * (1 - 0.35 * k), t, rise / 3);
      this.lapGain.gain.setTargetAtTime(0.04, t + rise, rand(0.2, 0.45) + 0.4 * k);
      this.nextLap += rise + rand(0.35, 1.1) + k * rand(0.6, 2.2);
    }
    // droplets: the odd drop beside slow water, a busy babble on fast streams
    const rate = this.prox * this.prox * (0.2 + 5 * this.bright * (1 - 0.8 * k));
    for (let t = 0; (t = this.plips.due(now, horizon, rate)) >= 0; ) {
      const f = rand(600, 2600) * (0.8 + 0.4 * this.bright) * (1 - 0.25 * k);
      bubble(this.k, this.out, t, f, rand(0.3, 1) * LVL.plip * this.prox * (1 - 0.4 * k), rand(-0.8, 0.8), AMBIENT_RESERVE);
    }
  }
}

export class WindLayer {
  readonly out: GainNode;
  private readonly body: SmoothParam;
  private readonly bodyTone: SmoothParam;
  private readonly whistle: SmoothParam;
  private readonly whistleTone: SmoothParam;
  private readonly buffet: SmoothParam;
  private gust = 0.4;
  private gustTarget = 0.4;
  private gustTime = 0;
  private flutter = 0;
  private drift = 0.5;
  private driftTarget = 0.5;

  constructor(k: Kit, dest: AudioNode) {
    const ctx = k.ctx;
    this.out = gn(ctx, 1);
    this.out.connect(dest);
    const src = loopSource(ctx, k.noise.pink, 0.93);
    const bp = bq(ctx, 'bandpass', 450, 0.8);
    const bodyG = gn(ctx);
    src.connect(bp);
    bp.connect(bodyG);
    bodyG.connect(this.out);
    const wbp = bq(ctx, 'bandpass', 1200, 11);
    const whistleG = gn(ctx);
    src.connect(wbp);
    wbp.connect(whistleG);
    whistleG.connect(this.out);
    const low = loopSource(ctx, k.noise.brown, 1.07);
    const lp = bq(ctx, 'lowpass', 140, 0.7);
    const buffetG = gn(ctx);
    low.connect(lp);
    lp.connect(buffetG);
    buffetG.connect(this.out);
    this.body = new SmoothParam(bodyG.gain, 0.12);
    this.bodyTone = new SmoothParam(bp.frequency, 0.15, 0.01);
    this.whistle = new SmoothParam(whistleG.gain, 0.2);
    this.whistleTone = new SmoothParam(wbp.frequency, 0.4, 0.005);
    this.buffet = new SmoothParam(buffetG.gain, 0.08);
  }

  update(now: number, dt: number, ctl: boolean, amount: number): void {
    // gust process: glide toward a random strength re-drawn every few seconds
    this.gustTime -= dt;
    if (this.gustTime <= 0) {
      this.gustTarget = Math.pow(Math.random(), 0.7);
      this.gustTime = rand(1.2, 5);
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.8);
    this.flutter = this.flutter * Math.exp(-dt * 4) + (Math.random() - 0.5) * dt * 6;
    this.drift += (this.driftTarget - this.drift) * Math.min(1, dt * 0.15);
    if (Math.abs(this.drift - this.driftTarget) < 0.03) this.driftTarget = Math.random();
    if (!ctl) return;
    const g = clamp01(this.gust + this.flutter * 0.25);
    const w = amount;
    this.body.set(Math.pow(w, 1.2) * (0.3 + 0.7 * g) * LVL.wind, now);
    this.bodyTone.set(220 + 750 * g * (0.4 + 0.6 * w), now);
    this.whistle.set(smoothstep(0.35, 1, w) * g * g * LVL.whistle, now);
    this.whistleTone.set(700 + 900 * this.drift + 300 * g, now);
    this.buffet.set(w * w * g * g * LVL.buffet, now);
  }
}

export class UnderwaterLayer {
  readonly out: GainNode;
  private readonly rumble: SmoothParam;
  private readonly hush: SmoothParam;
  private nextBurst = 0;

  constructor(
    private readonly k: Kit,
    dest: AudioNode,
  ) {
    const ctx = k.ctx;
    this.out = gn(ctx, 1);
    this.out.connect(dest);
    const brown = loopSource(ctx, k.noise.brown, 0.8);
    const lp = bq(ctx, 'lowpass', 160, 0.9);
    const rumbleG = gn(ctx);
    brown.connect(lp);
    lp.connect(rumbleG);
    rumbleG.connect(this.out);
    const pink = loopSource(ctx, k.noise.pink, 0.85);
    const bp = bq(ctx, 'bandpass', 380, 0.8);
    const hushG = gn(ctx);
    pink.connect(bp);
    bp.connect(hushG);
    hushG.connect(this.out);
    this.rumble = new SmoothParam(rumbleG.gain, 0.15);
    this.hush = new SmoothParam(hushG.gain, 0.15);
  }

  update(now: number, ctl: boolean, u: number, speed: number): void {
    const move = Math.min(1, speed / 5);
    if (ctl) {
      this.rumble.set(u * (0.8 + 0.4 * move) * LVL.rumble, now);
      this.hush.set(u * (0.7 + 0.6 * move) * LVL.hush, now);
    }
    if (u < 0.3) {
      this.nextBurst = now + rand(0.2, 0.8);
      return;
    }
    while (this.nextBurst < now + LOOKAHEAD) {
      // a burst of rising bubbles; more of them when swimming hard
      const n = 1 + Math.floor(Math.random() * (2 + 3 * move));
      let t = Math.max(this.nextBurst, now);
      for (let i = 0; i < n; i++) {
        bubble(this.k, this.out, t, rand(300, 1300), rand(0.4, 1) * LVL.bubble * u, rand(-0.6, 0.6), AMBIENT_RESERVE);
        t += rand(0.03, 0.14);
      }
      this.nextBurst = t + poisson(0.5 + 0.3 * speed);
    }
  }
}
