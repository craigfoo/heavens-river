// Sung voices. A FormantVoice is a glottal-pulse oscillator (plus optional
// detuned or octave "doublers" that turn one singer into a small chorus)
// feeding a parallel bank of three band-pass formant filters. Pitch moves with
// portamento, vowels morph by gliding the formant centres, and every
// oscillator has its own delayed vibrato. Voices are persistent: a phrase is
// written as automation on long-lived nodes (no nodes created per note), and
// each phrase ends in a release, so nothing can hang if scheduling stops.

import type { Kit } from './synth';
import { clamp, mtof, rand, release } from './util';

export type Vowel = 'a' | 'e' | 'i' | 'o' | 'u';
export const VOWELS: readonly Vowel[] = ['a', 'o', 'e', 'u', 'i'];

/** One note of a written line. Times are in beats from the phrase start. */
export interface SongNote {
  beat: number;
  dur: number;
  deg: number;
  midi: number;
  vowel: Vowel;
  /** Glide into this note from the previous one instead of re-articulating. */
  slur: boolean;
}

// [centre Hz, level dB, bandwidth Hz] for F1..F3 (classic alto table).
const FORMANTS: Record<Vowel, [number, number, number][]> = {
  a: [[800, 0, 80], [1150, -4, 90], [2800, -20, 120]],
  e: [[400, 0, 60], [1600, -24, 80], [2700, -30, 120]],
  i: [[350, 0, 50], [1700, -20, 100], [2700, -30, 120]],
  o: [[450, 0, 70], [800, -9, 80], [2830, -16, 100]],
  u: [[325, 0, 50], [700, -12, 60], [2530, -30, 170]],
};

interface Band {
  f: number;
  q: number;
  g: number;
}

/**
 * Filter settings for a vowel. `scale` > 1 raises the formants (Quinlans are
 * small: shorter vocal tract). Band gains compensate the source's ~1/k
 * harmonic roll-off so the table's relative formant levels come through;
 * bandwidths are widened a little for a softer, less whistly sound.
 */
export function bandsFor(v: Vowel, scale: number): Band[] {
  const t = FORMANTS[v];
  const f1 = t[0][0];
  return t.map(([f, dB, bw]) => ({
    f: f * scale,
    q: f / (bw * 1.7),
    g: Math.pow(10, dB / 20) * Math.pow(f / f1, 0.7),
  }));
}

export interface Doubler {
  /** Frequency multiplier (1 = unison, 0.5 = octave below). */
  mult: number;
  /** Static detune in cents. */
  cents: number;
  /** Timing offset in seconds (ensemble looseness). */
  delay: number;
}

export interface VoiceOpts {
  doublers?: Doubler[];
  pan?: number;
  formantScale?: number;
}

export class FormantVoice {
  /** Phrase envelope / voice level. */
  readonly out: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly oscs: OscillatorNode[] = [];
  private readonly mults: number[] = [];
  private readonly delays: number[] = [];
  private readonly vib: GainNode[] = [];
  private readonly dbl: GainNode[] = [];
  private readonly bands: BiquadFilterNode[] = [];
  private readonly bandGains: GainNode[] = [];
  private readonly table: Record<Vowel, Band[]>;

  constructor(ctx: BaseAudioContext, dest: AudioNode, wave: PeriodicWave, o: VoiceOpts = {}) {
    const scale = o.formantScale ?? 1.1;
    this.table = { a: bandsFor('a', scale), e: bandsFor('e', scale), i: bandsFor('i', scale), o: bandsFor('o', scale), u: bandsFor('u', scale) };
    const mix = ctx.createGain();
    const specs: Doubler[] = [{ mult: 1, cents: 0, delay: 0 }, ...(o.doublers ?? [])];
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = 220 * s.mult;
      osc.detune.value = s.cents;
      // vibrato in cents on the detune param, depth automated per note
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rand(4.7, 6.1);
      const depth = ctx.createGain();
      depth.gain.value = 0;
      lfo.connect(depth);
      depth.connect(osc.detune);
      if (i === 0) osc.connect(mix);
      else {
        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(mix);
        this.dbl.push(g);
        this.nodes.push(g);
      }
      osc.start();
      lfo.start();
      this.oscs.push(osc);
      this.mults.push(s.mult);
      this.delays.push(s.delay);
      this.vib.push(depth);
      this.nodes.push(osc, lfo, depth);
    }
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    for (const b of this.table.a) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = b.f;
      f.Q.value = b.q;
      const g = ctx.createGain();
      g.gain.value = b.g;
      mix.connect(f);
      f.connect(g);
      g.connect(this.out);
      this.bands.push(f);
      this.bandGains.push(g);
      this.nodes.push(f, g);
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(o.pan ?? 0, -1, 1);
    this.out.connect(pan);
    pan.connect(dest);
    this.nodes.push(mix, this.out, pan);
  }

  /** Glide to `hz` at time t; `scoop` < 1 starts the note slightly flat. */
  pitch(t: number, hz: number, glide: number, scoop = 0): void {
    for (let i = 0; i < this.oscs.length; i++) {
      const f = this.oscs[i].frequency;
      const ti = t + this.delays[i];
      const target = hz * this.mults[i];
      if (scoop > 0) f.setValueAtTime(target * scoop, ti);
      f.setTargetAtTime(target, ti, glide);
    }
  }

  vowel(t: number, v: Vowel, tau = 0.035): void {
    const b = this.table[v];
    for (let i = 0; i < 3; i++) {
      this.bands[i].frequency.setTargetAtTime(b[i].f, t, tau);
      this.bands[i].Q.setTargetAtTime(b[i].q, t, tau);
      this.bandGains[i].gain.setTargetAtTime(b[i].g, t, tau);
    }
  }

  /** Vibrato that blooms on longer notes, as trained singers do. */
  vibrato(t: number, dur: number, cents: number): void {
    for (const d of this.vib) {
      d.gain.setTargetAtTime(cents * 0.2, t, 0.03);
      if (dur > 0.45) d.gain.setTargetAtTime(cents, t + 0.22, 0.12);
    }
  }

  /** Presence (0..1) of each doubler oscillator. */
  doubling(t: number, amounts: readonly number[]): void {
    for (let i = 0; i < this.dbl.length; i++) this.dbl[i].gain.setTargetAtTime(amounts[i] ?? 0, t, 0.2);
  }

  dispose(at: number): void {
    this.out.gain.cancelScheduledValues(at);
    this.out.gain.setTargetAtTime(0, at, 0.05);
    release(this.nodes, at + 0.3);
  }
}

/**
 * Schedule one phrase on a persistent voice: pitch with portamento or a
 * consonant-like dip between notes, vowel changes, vibrato, rests, and a
 * release after the last note. `level` is the phrase loudness.
 */
export function singLine(
  v: FormantVoice,
  notes: readonly SongNote[],
  t0: number,
  spb: number,
  level: number,
  vib = 22,
): void {
  const g = v.out.gain;
  let prevEnd = -1;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const t = t0 + n.beat * spb + rand(0, 0.018); // a little human looseness
    const dur = n.dur * spb;
    const hz = mtof(n.midi);
    const accent = (Math.abs(n.beat % 2) < 0.01 ? 1 : 0.84) * level;
    const legato = prevEnd > 0 && t - prevEnd < 0.05;
    if (!legato) {
      v.pitch(t - 0.004, hz, 0.025, 0.965); // onset after silence: scoop into the note
      g.setTargetAtTime(accent, t, 0.035);
    } else if (n.slur) {
      v.pitch(t - 0.03, hz, 0.06); // portamento
      g.setTargetAtTime(accent, t, 0.05);
    } else {
      g.setTargetAtTime(accent * 0.45, t - 0.035, 0.012); // consonant dip
      v.pitch(t - 0.01, hz, 0.018);
      g.setTargetAtTime(accent, t + 0.01, 0.03);
    }
    v.vowel(t, n.vowel, legato && !n.slur ? 0.02 : 0.05);
    v.vibrato(t, dur, vib);
    const end = t0 + (n.beat + n.dur) * spb;
    const next = notes[i + 1];
    const nextT = next ? t0 + next.beat * spb : Infinity;
    if (nextT - end > 0.04) {
      g.setTargetAtTime(0, end - 0.05, 0.06); // rest or phrase end: release
      prevEnd = -1;
    } else prevEnd = end;
  }
}

/** A short shouted or called syllable (one-shot) with a falling pitch contour. */
export function syllable(
  k: Kit,
  dest: AudioNode,
  wave: PeriodicWave,
  o: { t: number; hz: number; hzEnd: number; dur: number; vowel: Vowel; peak: number; pan?: number; scale?: number; reserve?: number },
): void {
  if (!k.pool.ok(o.reserve)) return;
  const ctx = k.ctx;
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.setValueAtTime(o.hz, o.t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.hzEnd), o.t + o.dur);
  const g = ctx.createGain();
  const nodes: AudioNode[] = [osc, g];
  const bands = bandsFor(o.vowel, o.scale ?? 1.15);
  for (let i = 0; i < 2; i++) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = bands[i].f;
    f.Q.value = bands[i].q * 0.7;
    const bg = ctx.createGain();
    bg.gain.value = bands[i].g;
    osc.connect(f);
    f.connect(bg);
    bg.connect(g);
    nodes.push(f, bg);
  }
  g.gain.setValueAtTime(0, o.t);
  g.gain.linearRampToValueAtTime(o.peak, o.t + 0.02);
  g.gain.setTargetAtTime(o.peak * 0.7, o.t + 0.02, o.dur * 0.4);
  g.gain.setTargetAtTime(0, o.t + o.dur, 0.03);
  const p = ctx.createStereoPanner();
  p.pan.value = clamp(o.pan ?? 0, -1, 1);
  g.connect(p);
  p.connect(dest);
  nodes.push(p);
  osc.start(o.t);
  osc.stop(o.t + o.dur + 0.25);
  k.pool.track(osc, nodes);
}
