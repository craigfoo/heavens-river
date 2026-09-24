// Life around the river, following the day/night cycle.
//  Birds (day, densest in the dawn chorus, a smaller evening peak): a few
//    "resident" birds, each with its own species pattern, pitch and position,
//    sing short procedural songs (whistles, trills, warbles, two-tone calls,
//    chips, soft coos). A whole song is one oscillator with scheduled pitch
//    and amplitude automation.
//  Crickets (dusk and night): three persistent sine oscillators pulsed into
//    chirp trains, each insect with its own pitch, tempo and pauses. Built
//    lazily and torn down in daylight.
//  Frogs (dusk and night, more near water): pulse-train "ribbits" through a
//    resonance, soft low croaks and the odd peeper.

import { AMBIENT_RESERVE, PoissonClock, bq, gn, type Kit } from './synth';
import { SmoothParam, clamp01, rand, release, smoothstep, weighted } from './util';

const LVL = { bird: 0.09, cricket: 0.03, frog: 0.065 };
const LOOKAHEAD = 0.25;

type Species = 'whistle' | 'trill' | 'warble' | 'twoTone' | 'chip' | 'coo';
const SPECIES: readonly Species[] = ['whistle', 'trill', 'warble', 'twoTone', 'chip', 'coo'];
const PITCH: Record<Species, [number, number]> = {
  whistle: [2200, 3400],
  trill: [3500, 5000],
  warble: [2500, 4200],
  twoTone: [3000, 4200],
  chip: [4500, 6500],
  coo: [420, 620],
};

interface Bird {
  species: Species;
  pitch: number;
  pan: number;
  /** Distance attenuation 0.25..1. */
  near: number;
}

interface Syl {
  t: number;
  dur: number;
  f0: number;
  f1: number;
  amp: number;
}

function newBird(): Bird {
  const species = weighted(SPECIES, [3, 2, 3, 2, 2, 1]);
  const [lo, hi] = PITCH[species];
  return { species, pitch: rand(lo, hi), pan: rand(-0.9, 0.9), near: rand(0.25, 1) };
}

/** The syllables of one song for a bird (times relative to the song start). */
function pattern(b: Bird): Syl[] {
  const p = b.pitch * rand(0.97, 1.03);
  const out: Syl[] = [];
  let t = 0;
  switch (b.species) {
    case 'whistle': {
      const up = Math.random() < 0.4;
      for (let i = 0, n = 2 + Math.floor(Math.random() * 3); i < n; i++) {
        const dur = rand(0.22, 0.4);
        out.push({ t, dur, f0: p * rand(1, 1.08), f1: p * (up ? 1.15 : 0.82), amp: 1 - i * 0.1 });
        t += dur + rand(0.12, 0.25);
      }
      break;
    }
    case 'trill': {
      const rate = rand(12, 18);
      const n = Math.floor(rand(0.6, 1.2) * rate);
      for (let i = 0; i < n; i++) {
        const x = i / Math.max(1, n - 1);
        out.push({ t, dur: 0.6 / rate, f0: p * 1.15, f1: p * 0.9, amp: 0.5 + 0.5 * Math.sin(Math.PI * x) });
        t += 1 / rate;
      }
      break;
    }
    case 'warble': {
      for (let i = 0, n = 5 + Math.floor(Math.random() * 5); i < n; i++) {
        const dur = rand(0.06, 0.12);
        const f0 = p * rand(0.8, 1.35);
        out.push({ t, dur, f0, f1: f0 * rand(0.85, 1.2), amp: rand(0.6, 1) });
        t += dur + rand(0.01, 0.04);
      }
      break;
    }
    case 'twoTone':
      out.push({ t: 0, dur: 0.35, f0: p * 1.18, f1: p * 1.15, amp: 1 });
      out.push({ t: 0.43, dur: 0.4, f0: p * 0.98, f1: p * 0.95, amp: 0.85 });
      break;
    case 'chip':
      for (let i = 0, n = 3 + Math.floor(Math.random() * 4); i < n; i++) {
        out.push({ t, dur: rand(0.025, 0.04), f0: p * 1.3, f1: p * 0.8, amp: rand(0.7, 1) });
        t += rand(0.2, 0.35);
      }
      break;
    case 'coo':
      for (let i = 0, n = 3 + Math.floor(Math.random() * 3); i < n; i++) {
        const dur = i === 1 ? rand(0.45, 0.6) : rand(0.25, 0.4);
        out.push({ t, dur, f0: p * 0.95, f1: p * (i === 1 ? 1.06 : 1.0), amp: i === 1 ? 1 : 0.7 });
        t += dur + rand(0.15, 0.35);
      }
      break;
  }
  return out;
}

interface Cricket {
  gain: GainNode;
  amp: number;
  period: number;
  pulses: number;
  pulseRate: number;
  next: number;
}

export class NatureLayer {
  readonly birdsOut: GainNode;
  readonly nightOut: GainNode;
  private readonly birds: Bird[] = [newBird(), newBird(), newBird(), newBird()];
  private readonly birdClock = new PoissonClock();
  private readonly frogClock = new PoissonClock();
  private crickets: Cricket[] = [];
  private cricketNodes: AudioNode[] = [];
  private readonly cricketBus: GainNode;
  private readonly cricketLevel: SmoothParam;
  private quietFor = 0;

  constructor(
    private readonly k: Kit,
    dest: AudioNode,
    reverb: AudioNode,
  ) {
    const ctx = k.ctx;
    this.birdsOut = gn(ctx, 1);
    this.nightOut = gn(ctx, 1);
    this.birdsOut.connect(dest);
    this.nightOut.connect(dest);
    // distant birds and frogs get a little air
    const send = gn(ctx, 0.3);
    this.birdsOut.connect(send);
    this.nightOut.connect(send);
    send.connect(reverb);
    this.cricketBus = gn(ctx, 0);
    this.cricketBus.connect(this.nightOut);
    this.cricketLevel = new SmoothParam(this.cricketBus.gain, 0.6);
  }

  update(
    now: number,
    dt: number,
    ctl: boolean,
    s: { timeOfDay: number; waterProximity: number; underwater: number; altitude: number; townSinging: number },
  ): void {
    const t = s.timeOfDay;
    const high = smoothstep(700, 2500, s.altitude);
    const day = smoothstep(0.235, 0.27, t) * (1 - smoothstep(0.735, 0.77, t));
    const dawn = Math.exp(-(((t - 0.29) / 0.035) ** 2));
    const dusk = Math.exp(-(((t - 0.715) / 0.025) ** 2));
    const dry = 1 - smoothstep(0.6, 0.95, s.underwater);
    const birdRate = day * (0.08 + 0.35 * dawn + 0.12 * dusk) * (1 - 0.7 * high) * (1 - 0.5 * s.townSinging) * dry;
    const crick = clamp01(1 - smoothstep(0.22, 0.27, t) + smoothstep(0.71, 0.78, t)) * (1 - high);
    const frogs = clamp01(1 - smoothstep(0.21, 0.25, t) + smoothstep(0.73, 0.8, t)) * (1 - high) * dry;
    const horizon = now + LOOKAHEAD;

    // birds
    for (let bt = 0; (bt = this.birdClock.due(now, horizon, birdRate, 0.4)) >= 0; ) {
      const i = Math.floor(Math.random() * this.birds.length);
      if (Math.random() < 0.1) this.birds[i] = newBird(); // someone new arrives
      this.song(this.birds[i], bt);
    }

    // crickets: persistent while it is dark, released after a quiet spell
    if (crick > 0.02) {
      this.quietFor = 0;
      if (!this.crickets.length) this.buildCrickets();
    } else if (this.crickets.length && (this.quietFor += dt) > 6) this.dropCrickets(now);
    if (ctl) this.cricketLevel.set(crick * LVL.cricket, now);
    for (const c of this.crickets) {
      if (c.next < now) c.next = now + rand(0, 0.3);
      while (c.next < horizon) {
        if (Math.random() < 0.05) {
          c.next += rand(2, 6); // falls silent for a while
          continue;
        }
        const pp = 1 / c.pulseRate;
        for (let i = 0; i < c.pulses; i++) {
          const pt = c.next + i * pp;
          c.gain.gain.setTargetAtTime(c.amp * (i === 0 ? 0.7 : 1), pt, 0.002);
          c.gain.gain.setTargetAtTime(0, pt + pp * 0.55, 0.003);
        }
        c.next += c.period * rand(0.95, 1.05);
      }
    }

    // frogs: more of them near water
    const frogRate = frogs * (0.08 + 0.9 * s.waterProximity) * 0.45;
    for (let ft = 0; (ft = this.frogClock.due(now, horizon, frogRate, 0.2)) >= 0; ) {
      this.frog(ft, 0.4 + 0.6 * s.waterProximity);
    }
  }

  /** One bird song: a single oscillator with the whole pattern automated. */
  private song(b: Bird, t0: number): void {
    const k = this.k;
    if (!k.pool.ok(AMBIENT_RESERVE)) return;
    const ctx = k.ctx;
    const syl = pattern(b);
    const osc = ctx.createOscillator();
    const g = gn(ctx);
    const pan = ctx.createStereoPanner();
    pan.pan.value = b.pan;
    osc.connect(g);
    g.connect(pan);
    pan.connect(this.birdsOut);
    const nodes: AudioNode[] = [osc, g, pan];
    if (b.species === 'twoTone' || b.species === 'trill') {
      // a fast flutter on the pitch
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rand(24, 40);
      const depth = gn(ctx, b.pitch * 0.025);
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(t0);
      nodes.push(lfo, depth);
    }
    const level = LVL.bird * b.near;
    let end = t0;
    for (const s of syl) {
      const t = t0 + s.t;
      const a = Math.min(0.012, s.dur * 0.25);
      osc.frequency.setValueAtTime(s.f0, t);
      osc.frequency.exponentialRampToValueAtTime(s.f1, t + s.dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(s.amp * level, t + a);
      g.gain.setTargetAtTime(0, t + s.dur * 0.75, s.dur * 0.08 + 0.004);
      end = t + s.dur;
    }
    osc.start(t0);
    osc.stop(end + 0.1);
    for (const n of nodes) if (n instanceof OscillatorNode && n !== osc) n.stop(end + 0.1);
    k.pool.track(osc, nodes);
  }

  private buildCrickets(): void {
    const ctx = this.k.ctx;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.frequency.value = rand(4200, 5200);
      const gain = gn(ctx);
      const pan = ctx.createStereoPanner();
      pan.pan.value = rand(-0.85, 0.85);
      osc.connect(gain);
      gain.connect(pan);
      pan.connect(this.cricketBus);
      osc.start();
      this.cricketNodes.push(osc, gain, pan);
      this.crickets.push({
        gain,
        amp: rand(0.4, 1),
        period: rand(0.45, 0.95),
        pulses: 3 + Math.floor(Math.random() * 3),
        pulseRate: rand(26, 36),
        next: 0,
      });
    }
  }

  private dropCrickets(now: number): void {
    release(this.cricketNodes, now + 0.1);
    this.cricketNodes = [];
    this.crickets = [];
  }

  /** One frog call (a ribbit pair, a low croak, or a peeper series). */
  private frog(t0: number, near: number): void {
    const k = this.k;
    if (!k.pool.ok(AMBIENT_RESERVE)) return;
    const ctx = k.ctx;
    const kind = weighted(['ribbit', 'croak', 'peep'] as const, [6, 2.5, 1.5]);
    const osc = ctx.createOscillator();
    const g = gn(ctx);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.9, 0.9);
    const nodes: AudioNode[] = [osc, g, pan];
    const level = LVL.frog * near * rand(0.5, 1);
    let end = t0;
    const env = (t: number, dur: number, amp: number, atk = 0.012) => {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + atk);
      g.gain.setTargetAtTime(0, t + dur * 0.7, dur * 0.1);
      end = Math.max(end, t + dur);
    };
    if (kind === 'peep') {
      osc.connect(g);
      const f = rand(2800, 3300);
      let t = t0;
      for (let i = 0, n = 3 + Math.floor(Math.random() * 4); i < n; i++) {
        osc.frequency.setValueAtTime(f * 0.9, t);
        osc.frequency.exponentialRampToValueAtTime(f, t + 0.1);
        env(t, 0.12, level * 0.35);
        t += rand(0.5, 1);
      }
    } else {
      // a pulse train (sawtooth at the pulse rate) exciting a throat resonance
      osc.type = 'sawtooth';
      const croak = kind === 'croak';
      const rf = croak ? rand(260, 340) : rand(1300, 2000);
      const res = bq(ctx, 'bandpass', rf, croak ? 2 : 5);
      osc.connect(res);
      res.connect(g);
      nodes.push(res);
      const rate = croak ? rand(70, 95) : rand(55, 85);
      let t = t0;
      for (let r = 0, reps = 1 + Math.floor(Math.random() * 3); r < reps; r++) {
        if (croak) {
          for (let i = 0; i < 3; i++) {
            const d = rand(0.15, 0.24);
            osc.frequency.setValueAtTime(rate * (i === 2 ? 0.9 : 1), t);
            env(t, d, level * 0.9, 0.03);
            t += d + 0.04;
          }
        } else {
          const d1 = rand(0.09, 0.12);
          osc.frequency.setValueAtTime(rate, t);
          res.frequency.setValueAtTime(rf, t);
          env(t, d1, level);
          const t2 = t + d1 + rand(0.05, 0.08);
          osc.frequency.setValueAtTime(rate * 1.12, t2);
          res.frequency.setValueAtTime(rf * 1.08, t2);
          env(t2, rand(0.1, 0.14), level * 0.9);
          t = t2 + 0.15;
        }
        t += rand(0.5, 1.0);
      }
    }
    g.connect(pan);
    pan.connect(this.nightOut);
    osc.start(t0);
    osc.stop(end + 0.1);
    k.pool.track(osc, nodes);
  }

  /** Stop persistent nodes (engine shutdown). */
  dispose(now: number): void {
    this.dropCrickets(now);
  }
}
