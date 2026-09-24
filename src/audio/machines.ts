// Intro machinery (spec 8 and 9).
//  Spin Transfer: a continuous rising mechanical whine as the vehicle ramps to
//    the inner shell's ~805 m/s: a geared whine (two inharmonic partials) that
//    climbs about four octaves, a sub-octave turbine tone, track rumble whose
//    brightness follows speed, and rail-joint clatter whose rate rises until it
//    blurs into a buzz. A cinematic rush of the passing inner surface fades as
//    the speeds match. At progress 1 the clamps engage (a heavy double clunk)
//    and everything falls silent. If updates stop short of 1 (intro skipped),
//    a dead-man timeout fades it out.
//  Elevator: a motor hum with a slow wobble, cable whirr and soft thumps as
//    shaft segments pass; it spins down with a settling clunk.

import { blip, bq, gn, knock, loopSource, noiseBurst, type Kit } from './synth';
import { SmoothParam, clamp01, rand, release, smoothstep } from './util';

const LVL = { whine: 0.07, sub: 0.1, rumble: 0.5, clatter: 0.09, rush: 0.2, hum: 0.12, cable: 0.3 };

interface SpinNodes {
  nodes: AudioNode[];
  out: GainNode;
  whine: OscillatorNode;
  gear: OscillatorNode;
  sub: OscillatorNode;
  clock: OscillatorNode;
  params: Record<'whineG' | 'gearG' | 'subG' | 'rumbleG' | 'rumbleTone' | 'clatterG' | 'rushG', SmoothParam>;
}

export class SpinTransfer {
  readonly out: GainNode;
  private s: SpinNodes | null = null;
  private lastCall = 0;

  constructor(
    private readonly k: Kit,
    dest: AudioNode,
  ) {
    this.out = gn(k.ctx, 1);
    this.out.connect(dest);
  }

  set(progress: number, now: number): void {
    const p = clamp01(progress);
    if (p >= 0.999 || p <= 0) {
      // docked (clamp, then silence) or reset
      if (this.s) {
        if (p >= 0.999) this.clamp(now);
        this.stop(now, 0.08);
      }
      return;
    }
    if (!this.s) this.build(now);
    const s = this.s;
    if (!s) return;
    this.lastCall = now;
    const f = 70 * Math.pow(2, 4.1 * p); // ~70 Hz -> ~1.2 kHz
    s.whine.frequency.setTargetAtTime(f, now, 0.05);
    s.gear.frequency.setTargetAtTime(f * 2.41, now, 0.05);
    s.sub.frequency.setTargetAtTime(f * 0.5, now, 0.05);
    s.clock.frequency.setTargetAtTime(3 + 60 * p * p, now, 0.05);
    const up = smoothstep(0, 0.35, p);
    const P = s.params;
    P.whineG.set((0.35 + 0.65 * up) * LVL.whine, now);
    P.gearG.set(up * 0.4 * LVL.whine, now);
    P.subG.set((0.5 + 0.5 * up) * LVL.sub, now);
    P.rumbleG.set((0.25 + 0.75 * p) * LVL.rumble, now);
    P.rumbleTone.set(80 + 900 * p * p, now);
    P.clatterG.set((0.3 + 0.7 * up) * (1 - 0.5 * p) * LVL.clatter, now);
    P.rushG.set(Math.pow(1 - p, 1.5) * smoothstep(0, 0.05, p) * LVL.rush, now);
  }

  /** Housekeeping: fade out if the caller stopped updating mid-ramp. */
  tick(now: number): void {
    if (this.s && now - this.lastCall > 0.6) this.stop(now, 0.25);
  }

  private build(now: number): void {
    const ctx = this.k.ctx;
    const out = gn(ctx, 1);
    out.connect(this.out);
    const nodes: AudioNode[] = [out];
    const osc = (type: OscillatorType, f: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.start(now);
      nodes.push(o);
      return o;
    };
    // geared whine through a gentle low-pass so the top never gets shrill
    const soft = bq(ctx, 'lowpass', 3500, 0.5);
    soft.connect(out);
    const whine = osc('sawtooth', 70);
    const gear = osc('triangle', 170);
    const sub = osc('sine', 35);
    const whineG = gn(ctx);
    const gearG = gn(ctx);
    const subG = gn(ctx);
    whine.connect(whineG);
    gear.connect(gearG);
    whineG.connect(soft);
    gearG.connect(soft);
    sub.connect(subG);
    subG.connect(out);
    // track rumble
    const brown = loopSource(ctx, this.k.noise.brown, 1);
    const rlp = bq(ctx, 'lowpass', 80, 0.8);
    const rumbleG = gn(ctx);
    brown.connect(rlp);
    rlp.connect(rumbleG);
    rumbleG.connect(out);
    // rail-joint clatter: noise gated by a square "clock" whose rate climbs
    const white = loopSource(ctx, this.k.noise.white, 1);
    const cbp = bq(ctx, 'bandpass', 1600, 0.9);
    const vca = gn(ctx, 0.5);
    const clock = osc('square', 3);
    const depth = gn(ctx, 0.5);
    clock.connect(depth);
    depth.connect(vca.gain);
    const clatterG = gn(ctx);
    white.connect(cbp);
    cbp.connect(vca);
    vca.connect(clatterG);
    clatterG.connect(out);
    // the inner surface rushing past, fading as the speeds match
    const pink = loopSource(ctx, this.k.noise.pink, 1);
    const pbp = bq(ctx, 'bandpass', 700, 0.6);
    const rushG = gn(ctx);
    pink.connect(pbp);
    pbp.connect(rushG);
    rushG.connect(out);
    nodes.push(soft, whineG, gearG, subG, brown, rlp, rumbleG, white, cbp, vca, depth, clatterG, pink, pbp, rushG);
    this.s = {
      nodes,
      out,
      whine,
      gear,
      sub,
      clock,
      params: {
        whineG: new SmoothParam(whineG.gain, 0.08),
        gearG: new SmoothParam(gearG.gain, 0.08),
        subG: new SmoothParam(subG.gain, 0.08),
        rumbleG: new SmoothParam(rumbleG.gain, 0.1),
        rumbleTone: new SmoothParam(rlp.frequency, 0.1, 0.01),
        clatterG: new SmoothParam(clatterG.gain, 0.08),
        rushG: new SmoothParam(rushG.gain, 0.1),
      },
    };
    this.lastCall = now;
  }

  private stop(now: number, tau: number): void {
    const s = this.s;
    if (!s) return;
    s.out.gain.cancelScheduledValues(now);
    s.out.gain.setTargetAtTime(0, now, tau);
    release(s.nodes, now + tau * 8);
    this.s = null;
  }

  /** The docking clamps engage: two heavy metallic clunks. */
  private clamp(now: number): void {
    const k = this.k;
    for (const [i, dt] of [0, 0.23].entries()) {
      const t = now + 0.02 + dt;
      const g = i ? 0.7 : 1;
      blip(k, this.out, { t, f0: 85, f1: 38, glide: 0.3, peak: 0.45 * g, attack: 0.003, decay: 0.6 });
      noiseBurst(k, this.out, { t, buf: 'brown', filter: 'lowpass', f0: 600, q: 0.7, peak: 0.5 * g, attack: 0.002, decay: 0.3 });
      blip(k, this.out, { t, f0: 420 * rand(0.97, 1.03), peak: 0.05 * g, attack: 0.002, decay: 1.3 });
      blip(k, this.out, { t, f0: 1130 * rand(0.97, 1.03), peak: 0.035 * g, attack: 0.002, decay: 0.9 });
      blip(k, this.out, { t, f0: 1870 * rand(0.97, 1.03), peak: 0.02 * g, attack: 0.002, decay: 0.6 });
    }
  }
}

interface LiftNodes {
  nodes: AudioNode[];
  out: GainNode;
  motor: OscillatorNode;
}

export class Elevator {
  readonly out: GainNode;
  private l: LiftNodes | null = null;
  private nextThump = 0;
  private startedAt = 0;

  constructor(
    private readonly k: Kit,
    dest: AudioNode,
  ) {
    this.out = gn(k.ctx, 1);
    this.out.connect(dest);
  }

  set(on: boolean, now: number): void {
    if (on && !this.l) this.start(now);
    else if (!on && this.l) this.stop(now);
  }

  /** Housekeeping: passing shaft segments, and a safety stop. */
  tick(now: number): void {
    if (!this.l) return;
    if (now - this.startedAt > 90) return this.stop(now);
    if (this.nextThump < now) this.nextThump = now + 0.05; // late tick: skip, don't bunch up
    while (this.nextThump < now + 0.3) {
      knock(this.k, this.l.out, this.nextThump, rand(70, 90), 0.05, rand(-0.2, 0.2));
      this.nextThump += rand(1.1, 1.4);
    }
  }

  private start(now: number): void {
    const ctx = this.k.ctx;
    const out = gn(ctx, 0);
    out.connect(this.out);
    out.gain.setTargetAtTime(1, now, 0.4);
    const motor = ctx.createOscillator();
    motor.type = 'sawtooth';
    motor.frequency.setValueAtTime(35, now);
    motor.frequency.setTargetAtTime(50, now, 0.5);
    const lp = bq(ctx, 'lowpass', 320, 0.8);
    const hum2 = ctx.createOscillator();
    hum2.frequency.value = 100;
    const wob = ctx.createOscillator();
    wob.frequency.value = 0.4;
    const wobD = gn(ctx, 2.5);
    wob.connect(wobD);
    wobD.connect(motor.frequency);
    const humG = gn(ctx, LVL.hum);
    const hum2G = gn(ctx, LVL.hum * 0.5);
    motor.connect(lp);
    lp.connect(humG);
    humG.connect(out);
    hum2.connect(hum2G);
    hum2G.connect(out);
    const brown = loopSource(ctx, this.k.noise.brown, 1);
    const cbp = bq(ctx, 'bandpass', 160, 1.5);
    const cableG = gn(ctx, LVL.cable);
    brown.connect(cbp);
    cbp.connect(cableG);
    cableG.connect(out);
    for (const o of [motor, hum2, wob]) o.start(now);
    this.l = { nodes: [out, motor, lp, hum2, wob, wobD, humG, hum2G, brown, cbp, cableG], out, motor };
    this.startedAt = now;
    this.nextThump = now + 0.8;
    knock(this.k, this.out, now + 0.01, 60, 0.12); // brakes release
  }

  private stop(now: number): void {
    const l = this.l;
    if (!l) return;
    l.motor.frequency.cancelScheduledValues(now);
    l.motor.frequency.setTargetAtTime(30, now, 0.4);
    l.out.gain.cancelScheduledValues(now);
    l.out.gain.setTargetAtTime(0, now, 0.3);
    release(l.nodes, now + 2);
    knock(this.k, this.out, now + 0.35, 55, 0.14); // settles at the bottom
    this.l = null;
  }
}
