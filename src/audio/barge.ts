// Life aboard a river barge.
//  Work song: call and response in 4/4. A leader sings a two-bar call (a few
//    calls per song, cycled), then the crew answers with the refrain in two
//    parts (Quinlans sing two melodies at once), several throats per part via
//    doublers. A pole knock marks beats 1 and 3 and the crew sometimes barks a
//    "hup!" in the gap at the end of the refrain.
//  Hull: water sloshing along the planks (low-passed noise with slow swells)
//    and wave slaps against the bow (short band-passed bursts).
//  Timber: creaks rendered once into buffers (a stick-slip click train through
//    wooden resonances) and replayed at random rates and positions.
// The graph is built when the player boards and released after leaving.

import { Key, MODES, writeDuet, writeLine, type Duet } from './music';
import { AMBIENT_RESERVE, bq, gn, knock, loopSource, noiseBurst, poisson, type Kit } from './synth';
import { FormantVoice, singLine, syllable, type SongNote } from './voice';
import { SmoothParam, chance, clamp, pick, rand, release, weighted } from './util';

const LVL = { song: 0.35, knock: 0.1, slosh: 0.45, slap: 0.16, creak: 0.12 };
const LOOKAHEAD = 0.35;

/** How many creak variations to render. */
const CREAKS = 4;

/** Render one creak: an irregular click train through wood modes (~2-5 ms). */
function makeCreak(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * rand(0.35, 0.8));
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  // excitation: stick-slip clicks whose rate glides as the load shifts
  const exc = new Float32Array(n);
  const r0 = rand(25, 60);
  const r1 = r0 * rand(0.6, 1.8);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (r0 + ((r1 - r0) * i) / n) / sr;
    if (phase >= 1) {
      phase -= 1 + (Math.random() - 0.5) * 0.3;
      exc[i] = rand(0.5, 1);
    }
  }
  // three two-pole resonators (plank modes)
  const modes = [rand(380, 520), rand(700, 950), rand(1200, 1700)];
  for (let m = 0; m < 3; m++) {
    const r = 0.994 - m * 0.002;
    const w = (2 * Math.PI * modes[m]) / sr;
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    const amp = [1, 0.6, 0.3][m];
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = exc[i] + a1 * y1 + a2 * y2;
      y2 = y1;
      y1 = y;
      d[i] += y * amp;
    }
  }
  // swell-and-fade envelope, peak-normalised
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    d[i] *= Math.sqrt(Math.sin((Math.PI * i) / n));
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
  }
  const k = 0.8 / peak;
  for (let i = 0; i < n; i++) d[i] *= k;
  return buf;
}

interface WorkSong {
  key: Key;
  bpm: number;
  calls: SongNote[][];
  refrain: Duet;
  section: number;
  sections: number;
}

function newWorkSong(): WorkSong {
  const key = new Key(45 + Math.floor(rand(0, 8)), weighted(MODES, [4, 3, 2, 2]));
  const n = key.n;
  const calls: SongNote[][] = [];
  for (let i = 0; i < 3; i++) {
    calls.push(writeLine(key, { beats: 8, lo: n - 2, hi: 2 * n - 1, start: n + pick(key.mode.stable), busy: 0.6, restEnd: 1 }));
  }
  return {
    key,
    bpm: rand(76, 92),
    calls,
    refrain: writeDuet(key, 8, { homophonic: true, busy: 0.55 }),
    section: 0,
    sections: 2 * (4 + Math.floor(Math.random() * 4)),
  };
}

interface Built {
  nodes: AudioNode[];
  leader: FormantVoice;
  crew: FormantVoice[];
  fx: GainNode;
  slosh: SmoothParam;
}

export class BargeLayer {
  readonly out: GainNode;
  private readonly level: SmoothParam;
  private b: Built | null = null;
  private readonly creaks: AudioBuffer[] = [];
  private song: WorkSong | null = null;
  private nextSection = 0;
  private nextSlap = 0;
  private nextCreak = 0;
  private quietFor = 0;
  private swell = 0.5;
  private swellTarget = 0.5;

  constructor(
    private readonly k: Kit,
    dest: AudioNode,
    private readonly reverb: AudioNode,
    private readonly wave: PeriodicWave,
  ) {
    this.out = gn(k.ctx, 0);
    this.out.connect(dest);
    this.level = new SmoothParam(this.out.gain, 0.6);
  }

  /**
   * Idle work after start: render one creak variation per call, so boarding
   * never pays for it inside a frame. Returns true while more are needed.
   */
  prepare(): boolean {
    if (this.creaks.length < CREAKS) this.creaks.push(makeCreak(this.k.ctx));
    return this.creaks.length < CREAKS;
  }

  update(now: number, dt: number, ctl: boolean, on: boolean, waterSpeed: number): void {
    if (on) {
      this.quietFor = 0;
      if (!this.b) this.build(now);
    } else if (this.b && (this.quietFor += dt) > 4) this.teardown(now);
    const b = this.b;
    if (!b) return;
    this.swell += (this.swellTarget - this.swell) * Math.min(1, dt * 0.5);
    if (Math.abs(this.swell - this.swellTarget) < 0.03) this.swellTarget = rand(0.2, 1);
    if (ctl) {
      this.level.set(on ? 1 : 0, now);
      b.slosh.set((0.5 + 0.5 * this.swell) * (0.6 + 0.4 * clamp(waterSpeed / 2, 0, 1)) * LVL.slosh, now);
    }
    if (!on) return; // let what is scheduled ring out while fading
    this.scheduleSong(now, b);
    this.scheduleHull(now, b);
  }

  private build(now: number): void {
    const ctx = this.k.ctx;
    const nodes: AudioNode[] = [];
    const songBus = gn(ctx, LVL.song);
    songBus.connect(this.out);
    const send = gn(ctx, 0.25);
    songBus.connect(send);
    send.connect(this.reverb);
    const fx = gn(ctx, 1);
    fx.connect(this.out);
    // water along the hull
    const src = loopSource(ctx, this.k.noise.pink, 0.9);
    const lp = bq(ctx, 'lowpass', 650, 0.6);
    const sloshG = gn(ctx);
    src.connect(lp);
    lp.connect(sloshG);
    sloshG.connect(fx);
    nodes.push(songBus, send, fx, src, lp, sloshG);
    this.b = {
      nodes,
      leader: new FormantVoice(ctx, songBus, this.wave, { pan: -0.2, formantScale: 1.06 }),
      crew: [
        new FormantVoice(ctx, songBus, this.wave, {
          pan: 0.3,
          formantScale: 1.12,
          doublers: [
            { mult: 1, cents: 10, delay: 0.03 },
            { mult: 1, cents: -12, delay: 0.05 },
          ],
        }),
        new FormantVoice(ctx, songBus, this.wave, {
          pan: 0.1,
          formantScale: 1.02,
          doublers: [
            { mult: 1, cents: -9, delay: 0.035 },
            { mult: 0.5, cents: 5, delay: 0.02 },
          ],
        }),
      ],
      fx,
      slosh: new SmoothParam(sloshG.gain, 0.4),
    };
    this.song = null;
    this.nextSection = now + rand(0.5, 2.5);
    this.nextSlap = now + rand(0.3, 1.5);
    this.nextCreak = now + rand(0.5, 3);
  }

  private teardown(now: number): void {
    const b = this.b;
    if (!b) return;
    b.leader.dispose(now);
    for (const v of b.crew) v.dispose(now);
    release(b.nodes, now + 0.3);
    this.b = null;
    this.song = null;
  }

  private scheduleSong(now: number, b: Built): void {
    if (this.nextSection < now) this.nextSection = now + 0.05;
    if (this.nextSection > now + LOOKAHEAD) return;
    const t0 = this.nextSection;
    if (!this.song) this.song = newWorkSong();
    const s = this.song;
    if (s.section >= s.sections) {
      this.song = null; // the crew rests between songs
      this.nextSection = t0 + rand(6, 14);
      return;
    }
    const spb = 60 / s.bpm;
    if (s.section % 2 === 0) {
      // the call: a fresh line from the leader
      singLine(b.leader, s.calls[(s.section / 2) % s.calls.length], t0, spb, rand(0.85, 1), 18);
    } else {
      // the response: the refrain, two melodies from the whole crew
      const [hi, lo] = b.crew;
      hi.doubling(t0, [0.8, 0.6]);
      lo.doubling(t0, [0.8, 0.5]);
      singLine(hi, s.refrain.upper, t0, spb, 0.9, 14);
      singLine(lo, s.refrain.lower, t0, spb, 1, 12);
      if (chance(0.45)) {
        const t = t0 + 7.25 * spb;
        for (let i = 0; i < 3; i++) {
          syllable(this.k, b.fx, this.wave, {
            t: t + rand(0, 0.03),
            hz: rand(200, 300),
            hzEnd: rand(160, 200),
            dur: 0.14,
            vowel: 'u',
            peak: 0.12,
            pan: rand(-0.5, 0.5),
          });
        }
      }
    }
    // the pole strikes on beats 1 and 3 keep the work in time
    for (let beat = 0; beat < 8; beat += 2) {
      const accent = beat % 4 === 0 ? 1 : 0.7;
      knock(this.k, b.fx, t0 + beat * spb + rand(0, 0.012), rand(150, 190), LVL.knock * accent, rand(-0.3, 0.3), AMBIENT_RESERVE);
    }
    s.section++;
    this.nextSection = t0 + 8 * spb;
  }

  private scheduleHull(now: number, b: Built): void {
    const horizon = now + LOOKAHEAD;
    if (this.nextSlap < now) this.nextSlap = now + rand(0.1, 0.5);
    while (this.nextSlap < horizon) {
      noiseBurst(this.k, b.fx, {
        t: this.nextSlap,
        buf: 'brown',
        filter: 'bandpass',
        f0: rand(250, 420),
        f1: rand(160, 240),
        q: 1.2,
        peak: LVL.slap * rand(0.4, 1),
        attack: rand(0.015, 0.04),
        decay: rand(0.25, 0.5),
        pan: rand(-0.7, 0.7),
        reserve: AMBIENT_RESERVE,
      });
      this.nextSlap += rand(1, 3.5);
    }
    if (this.nextCreak < now) this.nextCreak = now + rand(0.5, 2);
    if (this.nextCreak < horizon && this.creaks.length && this.k.pool.ok(AMBIENT_RESERVE)) {
      const ctx = this.k.ctx;
      const src = ctx.createBufferSource();
      src.buffer = pick(this.creaks);
      src.playbackRate.value = rand(0.8, 1.25);
      const g = gn(ctx, LVL.creak * rand(0.4, 1));
      const pan = ctx.createStereoPanner();
      pan.pan.value = rand(-0.8, 0.8);
      src.connect(g);
      g.connect(pan);
      pan.connect(b.fx);
      src.start(this.nextCreak);
      this.k.pool.track(src, [src, g, pan]);
      this.nextCreak += rand(1.5, 6) + poisson(0.3);
    }
  }

  dispose(now: number): void {
    this.teardown(now);
  }
}
