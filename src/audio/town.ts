// Distant Quinlan town life.
//  Singing: Quinlans sing two melodies at once, so a town is heard through a
//    duet of two persistent FormantVoices performing procedurally written
//    songs (music.ts) whose lines move independently. Bigger towns bring in
//    chorus doublers (unison and octave oscillators inside each voice) more
//    often, so the sound fills out from a lone singer to a small choir.
//  Crowd: three voiced "talkers" babbling syllables with speech-like pitch,
//    over a blurred "aah" hum of many voices.
//  Arguments: very occasionally a shouting match flares up (Quinlans are loud
//    and quick to anger): two voices trading short, falling shouts.
// Everything passes a distance low-pass and a reverb send that grows as the
// town recedes, so far-off singing drifts in soft and roomy. The whole graph
// is built when a town comes within earshot and released when it fades out.

import { Song } from './music';
import { AMBIENT_RESERVE, bq, gn, loopSource, poisson, type Kit } from './synth';
import { FormantVoice, VOWELS, bandsFor, singLine, syllable } from './voice';
import { SmoothParam, chance, expLerp, pick, rand, release } from './util';

const LVL = { song: 0.32, murmur: 0.3, hum: 0.2, shout: 0.45 };
const LOOKAHEAD = 0.35;

interface Talker {
  osc: OscillatorNode;
  f1: BiquadFilterNode;
  f2: BiquadFilterNode;
  g: GainNode;
  base: number;
  scale: number;
  left: number;
  next: number;
}

interface Built {
  nodes: AudioNode[];
  voices: FormantVoice[];
  talkers: Talker[];
  tone: SmoothParam;
  murmur: SmoothParam;
  hum: SmoothParam;
  shoutBus: GainNode;
}

export class TownLayer {
  /** Layer output (after distance filtering and level). */
  readonly out: GainNode;
  private readonly level: SmoothParam;
  private readonly wet: SmoothParam;
  private b: Built | null = null;
  private song: Song | null = null;
  private nextPhrase = 0;
  private nextShout = 0;
  private quietFor = 0;
  private size = 0;

  constructor(
    private readonly k: Kit,
    dest: AudioNode,
    reverb: AudioNode,
    private readonly wave: PeriodicWave,
  ) {
    const ctx = k.ctx;
    this.out = gn(ctx, 0);
    this.out.connect(dest);
    const wet = gn(ctx, 0.4);
    this.out.connect(wet);
    wet.connect(reverb);
    this.level = new SmoothParam(this.out.gain, 0.3);
    this.wet = new SmoothParam(wet.gain, 0.5);
  }

  update(now: number, dt: number, ctl: boolean, near: number, size: number): void {
    if (near > 0.003) {
      this.quietFor = 0;
      if (!this.b) this.build(now);
    } else if (this.b && (this.quietFor += dt) > 5) this.teardown(now);
    const b = this.b;
    if (!b) return;
    this.size = size;
    if (ctl) {
      this.level.set(Math.pow(near, 1.4) * (0.55 + 0.45 * size), now);
      this.wet.set(0.3 + 0.6 * (1 - near), now);
      b.tone.set(expLerp(1000, 7000, Math.pow(near, 0.8)), now);
      // chatter only carries when close; singing carries far
      b.murmur.set(Math.pow(near, 1.6) * (0.3 + 0.7 * size) * LVL.murmur, now);
      b.hum.set(Math.pow(near, 1.2) * (0.25 + 0.75 * size) * LVL.hum, now);
    }
    this.scheduleSong(now, b);
    this.scheduleTalk(now, b);
    this.scheduleShouts(now, near, b);
  }

  private build(now: number): void {
    const ctx = this.k.ctx;
    const nodes: AudioNode[] = [];
    const dist = bq(ctx, 'lowpass', 3000, 0.5);
    dist.connect(this.out);
    const songBus = gn(ctx, LVL.song);
    songBus.connect(dist);
    const shoutBus = gn(ctx, 1);
    shoutBus.connect(dist);
    nodes.push(dist, songBus, shoutBus);
    // the duet: an upper and a lower line, each able to swell into a chorus
    const voices = [
      new FormantVoice(ctx, songBus, this.wave, {
        pan: -0.25,
        formantScale: rand(1.05, 1.15),
        doublers: [
          { mult: 1, cents: 9, delay: 0.025 },
          { mult: 0.5, cents: -6, delay: 0.04 },
        ],
      }),
      new FormantVoice(ctx, songBus, this.wave, {
        pan: 0.25,
        formantScale: rand(1.0, 1.1),
        doublers: [
          { mult: 1, cents: -10, delay: 0.03 },
          { mult: 1, cents: 14, delay: 0.045 },
        ],
      }),
    ];
    // crowd murmur: voiced talkers through two formants each
    const murmurG = gn(ctx);
    murmurG.connect(dist);
    nodes.push(murmurG);
    const talkers: Talker[] = [];
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(this.wave);
      const base = rand(140, 260);
      osc.frequency.value = base;
      const f1 = bq(ctx, 'bandpass', 600, 3);
      const f2 = bq(ctx, 'bandpass', 1500, 5);
      const g = gn(ctx);
      const pan = ctx.createStereoPanner();
      pan.pan.value = rand(-0.7, 0.7);
      osc.connect(f1);
      osc.connect(f2);
      f1.connect(g);
      f2.connect(g);
      g.connect(pan);
      pan.connect(murmurG);
      osc.start();
      nodes.push(osc, f1, f2, g, pan);
      talkers.push({ osc, f1, f2, g, base, scale: rand(1.0, 1.25), left: 0, next: now + rand(0, 1) });
    }
    // the blur of many voices: noise through an "aah" formant pair
    const src = loopSource(ctx, this.k.noise.pink, 0.97);
    const h1 = bq(ctx, 'bandpass', 560, 2);
    const h2 = bq(ctx, 'bandpass', 1350, 3);
    const humG = gn(ctx);
    src.connect(h1);
    src.connect(h2);
    h1.connect(humG);
    h2.connect(humG);
    humG.connect(dist);
    nodes.push(src, h1, h2, humG);
    this.b = {
      nodes,
      voices,
      talkers,
      tone: new SmoothParam(dist.frequency, 0.3, 0.01),
      murmur: new SmoothParam(murmurG.gain, 0.4),
      hum: new SmoothParam(humG.gain, 0.4),
      shoutBus,
    };
    this.song = null;
    this.nextPhrase = now + rand(0.3, 2);
    this.nextShout = now + rand(40, 90);
  }

  private teardown(now: number): void {
    const b = this.b;
    if (!b) return;
    for (const v of b.voices) v.dispose(now);
    release(b.nodes, now + 0.3);
    this.b = null;
    this.song = null;
  }

  private scheduleSong(now: number, b: Built): void {
    if (this.nextPhrase < now) this.nextPhrase = now + 0.05;
    if (this.nextPhrase > now + LOOKAHEAD) return;
    const t0 = this.nextPhrase;
    if (!this.song) this.song = new Song({ tonic: 48 + Math.floor(rand(0, 8)), bpm: rand(66, 100) });
    const d = this.song.next();
    if (!d) {
      this.song = null; // song over: a breather before the next one
      this.nextPhrase = t0 + rand(3, 9);
      return;
    }
    const spb = this.song.secondsPerBeat;
    const [upper, lower] = b.voices;
    const dyn = rand(0.75, 1);
    singLine(upper, d.upper, t0, spb, dyn * 0.9, 24);
    singLine(lower, d.lower, t0, spb, dyn, 20);
    // chorus doubling: more likely, and fuller, in bigger towns
    const p = 0.15 + 0.55 * this.size;
    for (const v of b.voices) {
      v.doubling(t0, chance(p) ? [rand(0.5, 0.9), chance(this.size) ? rand(0.3, 0.6) : 0] : [0, 0]);
    }
    this.nextPhrase = t0 + d.beats * spb;
  }

  private scheduleTalk(now: number, b: Built): void {
    const horizon = now + LOOKAHEAD;
    for (const tk of b.talkers) {
      if (tk.next < now) tk.next = now;
      while (tk.next < horizon) {
        if (tk.left <= 0) {
          tk.left = 3 + Math.floor(Math.random() * 10); // a new sentence after a pause
          tk.next += rand(0.3, 1.6);
          continue;
        }
        const t = tk.next;
        const dur = rand(0.07, 0.2);
        const f = bandsFor(pick(VOWELS), tk.scale);
        const fall = 0.9 + 0.1 * Math.min(1, tk.left / 6); // intonation drops at the end
        tk.osc.frequency.setTargetAtTime(tk.base * rand(0.88, 1.22) * fall, t, 0.03);
        tk.f1.frequency.setTargetAtTime(f[0].f, t, 0.02);
        tk.f2.frequency.setTargetAtTime(f[1].f, t, 0.02);
        tk.g.gain.setTargetAtTime(rand(0.35, 1), t, 0.012);
        tk.g.gain.setTargetAtTime(0, t + dur * 0.75, 0.025);
        tk.next += dur + rand(0.015, 0.07);
        tk.left--;
      }
    }
  }

  private scheduleShouts(now: number, near: number, b: Built): void {
    const rate = near > 0.2 ? (near * (0.3 + 0.7 * this.size)) / 100 : 0;
    if (rate <= 0) {
      this.nextShout = Math.max(this.nextShout, now + 20);
      return;
    }
    if (this.nextShout > now + LOOKAHEAD) return;
    this.argument(Math.max(now, this.nextShout), b.shoutBus);
    this.nextShout = now + 30 + poisson(rate);
  }

  /** Two voices trading shouted syllables, escalating a little. */
  private argument(t0: number, bus: AudioNode): void {
    const who = [
      { base: rand(260, 360), pan: rand(-0.6, -0.1), scale: rand(1.1, 1.2) },
      { base: rand(200, 300), pan: rand(0.1, 0.6), scale: rand(1.0, 1.1) },
    ];
    let t = t0;
    const turns = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < turns; i++) {
      const w = who[i % 2];
      const heat = 0.7 + (0.3 * i) / turns;
      for (let j = 0, n = 1 + Math.floor(Math.random() * 3); j < n; j++) {
        const dur = rand(0.14, 0.32);
        const hz = w.base * rand(1.0, 1.25) * (0.9 + 0.2 * heat);
        syllable(this.k, bus, this.wave, {
          t,
          hz,
          hzEnd: hz * rand(0.7, 0.85),
          dur,
          vowel: pick(['a', 'e', 'o'] as const),
          peak: LVL.shout * heat * rand(0.7, 1),
          pan: w.pan,
          scale: w.scale,
          reserve: AMBIENT_RESERVE,
        });
        t += dur + rand(0.03, 0.09);
      }
      t += rand(0.12, 0.5);
    }
  }

  dispose(now: number): void {
    this.teardown(now);
  }
}
