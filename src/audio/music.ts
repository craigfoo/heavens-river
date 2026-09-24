// Procedural song writing. Quinlans sing two melodies at once, so a phrase is
// a duet of two independent lines with contrasting rhythm and contour. Pitches
// are chosen note by note (stepwise motion preferred, leaps turn back, long
// notes and phrase ends land on stable degrees); the second line is chosen
// against the first, then a resolve pass nudges any remaining clash a scale
// step away. Songs repeat and vary their phrases (A B A' C ...) so they sound
// composed rather than random. Pure logic: no WebAudio here.

import type { SongNote, Vowel } from './voice';
import { chance, pick, rand, weighted } from './util';

export interface Mode {
  name: string;
  steps: readonly number[];
  /** Scale degrees that make restful phrase endings (tonic, third, fifth). */
  stable: readonly number[];
}

export const MODES: readonly Mode[] = [
  { name: 'major pentatonic', steps: [0, 2, 4, 7, 9], stable: [0, 2, 3] },
  { name: 'minor pentatonic', steps: [0, 3, 5, 7, 10], stable: [0, 1, 3] },
  { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10], stable: [0, 2, 4] },
  { name: 'mixolydian', steps: [0, 2, 4, 5, 7, 9, 10], stable: [0, 2, 4] },
];

export class Key {
  constructor(
    readonly tonic: number,
    readonly mode: Mode,
  ) {}
  get n(): number {
    return this.mode.steps.length;
  }
  midi(deg: number): number {
    const n = this.n;
    const o = Math.floor(deg / n);
    return this.tonic + 12 * o + this.mode.steps[deg - o * n];
  }
  pc(deg: number): number {
    const n = this.n;
    return ((deg % n) + n) % n;
  }
  isStable(deg: number): boolean {
    return this.mode.stable.includes(this.pc(deg));
  }
}

/** Consonance of an interval class (semitones mod 12): > 0 sweet, < -2 harsh. */
const CONS = [-0.6, -3, -1.2, 1, 1, 0.2, -3, 0.8, 0.9, 0.9, -1.2, -3];
const cons = (semis: number) => CONS[Math.abs(Math.round(semis)) % 12];

interface Slot {
  beat: number;
  dur: number;
}

export interface LineSpec {
  beats: number;
  lo: number;
  hi: number;
  start: number;
  /** 0..1 rhythmic density. */
  busy: number;
  /** First onset in beats. */
  offset?: number;
  /** Silence at the end of the phrase, in beats. */
  restEnd?: number;
  /** This is the lower line: stay under the line it is written against. */
  below?: boolean;
  /** Reuse this rhythm instead of writing a new one (homophonic lines). */
  rhythm?: readonly Slot[];
}

const BUSY = [0.5, 0.5, 1, 1, 1, 1.5];
const CALM = [1, 1, 1.5, 2, 2, 3];

function writeRhythm(s: LineSpec): Slot[] {
  const out: Slot[] = [];
  const end = s.beats - (s.restEnd ?? 1);
  let beat = s.offset ?? 0;
  while (beat < end - 0.25) {
    let dur = Math.random() < s.busy ? pick(BUSY) : pick(CALM);
    const left = end - beat;
    const last = left <= dur + 0.5 || (left <= 3 && out.length > 2 && chance(0.35));
    if (last) dur = left;
    else if (out.length > 0 && chance(0.08)) {
      beat += 0.5; // catch a breath
      continue;
    }
    out.push({ beat, dur });
    beat += dur;
  }
  return out;
}

function pickVowel(long: boolean): Vowel {
  return long
    ? weighted<Vowel>(['a', 'o', 'e'], [5, 4, 1])
    : weighted<Vowel>(['a', 'o', 'e', 'u', 'i'], [4, 3, 2.5, 1.5, 1]);
}

const overlaps = (a: Slot, b: Slot) => a.beat < b.beat + b.dur - 1e-6 && b.beat < a.beat + a.dur - 1e-6;
const strongBeat = (b: number) => Math.abs(b % 2) < 0.01;

/** How badly a pitch for note x clashes with the other line (0 = clean). */
function clash(x: Slot, midi: number, other: readonly SongNote[], xIsUpper: boolean): number {
  let bad = 0;
  for (const y of other) {
    if (!overlaps(x, y)) continue;
    const iv = xIsUpper ? midi - y.midi : y.midi - midi;
    if (iv < 1) bad += 2; // crossing or unison: the two melodies stop being two
    const c = cons(iv);
    if (c <= -2) bad += 3;
    else if (c < 0) bad += strongBeat(Math.max(x.beat, y.beat)) ? 1.5 : 0.3;
  }
  return bad;
}

/** Choose pitches for a rhythm: a directed random walk, scored note by note. */
export function writeLine(key: Key, s: LineSpec, against?: readonly SongNote[]): SongNote[] {
  const slots = s.rhythm ? s.rhythm.map((r) => ({ ...r })) : writeRhythm(s);
  const out: SongNote[] = [];
  let deg = s.start;
  let dir = chance(0.5) ? 1 : -1;
  for (let i = 0; i < slots.length; i++) {
    const { beat, dur } = slots[i];
    const first = i === 0;
    const last = i === slots.length - 1;
    let best = deg;
    let bestScore = -Infinity;
    for (let d = -4; d <= 4; d++) {
      const c = deg + d;
      if (c < s.lo || c > s.hi) continue;
      const ad = Math.abs(d);
      let sc = first ? (d === 0 ? 1.5 : 0.3 - ad * 0.3) : [0.35, 1, 0.7, 0.3, 0.12][ad];
      if (!first && d !== 0 && Math.sign(d) === dir) sc += 0.3;
      if (last || dur >= 2) sc += key.isStable(c) ? 1.5 : -0.5;
      if (last && key.pc(c) === 0) sc += 0.6;
      if (against) sc -= clash({ beat, dur }, key.midi(c), against, !s.below) * 1.3;
      sc += Math.random() * 0.7;
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    const d = best - deg;
    if (d !== 0) dir = Math.sign(d);
    if (Math.abs(d) >= 3 || chance(0.15)) dir = -dir; // after a leap, turn back
    if (best <= s.lo) dir = 1;
    if (best >= s.hi) dir = -1;
    deg = best;
    out.push({ beat, dur, deg, midi: key.midi(deg), vowel: pickVowel(dur >= 2), slur: !first && chance(0.3) });
  }
  return out;
}

/** Nudge notes that still clash with the other line by a scale step or two. */
export function resolve(key: Key, upper: SongNote[], lower: SongNote[]): void {
  const lines: [SongNote[], SongNote[], boolean][] = [
    [upper, lower, true],
    [lower, upper, false],
  ];
  for (let pass = 0; pass < 2; pass++) {
    for (const [line, other, isUpper] of lines) {
      for (const x of line) {
        const cur = clash(x, x.midi, other, isUpper);
        if (cur < 1) continue;
        let best = 0;
        let bestBad = cur;
        for (const d of [1, -1, 2, -2]) {
          const bad = clash(x, key.midi(x.deg + d), other, isUpper) + Math.abs(d) * 0.2;
          if (bad < bestBad) {
            bestBad = bad;
            best = d;
          }
        }
        if (best) {
          x.deg += best;
          x.midi = key.midi(x.deg);
        }
      }
    }
  }
}

export interface Duet {
  upper: SongNote[];
  lower: SongNote[];
  beats: number;
}

/**
 * Two melodies at once. By default the lines are rhythmically independent
 * (the second often enters late, with a contrasting density); `homophonic`
 * shares the rhythm but still picks an independent contour (work-song style).
 */
export function writeDuet(key: Key, beats: number, opts: { busy?: number; homophonic?: boolean } = {}): Duet {
  const n = key.n;
  const busy = opts.busy ?? rand(0.35, 0.8);
  const restEnd = pick([1, 1, 1.5, 2]);
  const upper = writeLine(key, { beats, lo: n - 1, hi: 2 * n - 1, start: n + pick(key.mode.stable), busy, restEnd });
  const lower = writeLine(
    key,
    opts.homophonic
      ? { beats, lo: -3, hi: n + 2, start: pick(key.mode.stable), busy, below: true, rhythm: upper }
      : {
          beats,
          lo: -3,
          hi: n + 2,
          start: pick(key.mode.stable),
          busy: 1 - busy * 0.8,
          offset: pick([0, 0.5, 1, 2]),
          restEnd: pick([0.5, 1, 1.5]),
          below: true,
        },
    upper,
  );
  resolve(key, upper, lower);
  return { upper, lower, beats };
}

/** A varied repeat: shift both lines a scale step, or rewrite the cadence. */
export function varyDuet(key: Key, d: Duet): Duet {
  const copy = (l: SongNote[]) => l.map((x) => ({ ...x }));
  const upper = copy(d.upper);
  const lower = copy(d.lower);
  if (chance(0.5)) {
    const s = pick([-1, 1]);
    for (const x of [...upper, ...lower]) {
      x.deg += s;
      x.midi = key.midi(x.deg);
    }
  } else if (upper.length > 1) {
    const endNote = upper[upper.length - 1];
    const stables = key.mode.stable.map((p) => p + key.n);
    endNote.deg = pick(stables);
    endNote.midi = key.midi(endNote.deg);
    endNote.vowel = pick(['a', 'o'] as const);
  }
  resolve(key, upper, lower);
  return { upper, lower, beats: d.beats };
}

/** A whole song: a key, a tempo and a form of repeated/varied duet phrases. */
export class Song {
  readonly key: Key;
  readonly bpm: number;
  readonly beats: number;
  private readonly parts: Duet[] = [];
  private readonly form: string;
  private i = 0;

  constructor(opts: { tonic: number; bpm: number; beats?: number; mode?: Mode; homophonic?: boolean }) {
    this.key = new Key(opts.tonic, opts.mode ?? weighted(MODES, [4, 3, 2, 2]));
    this.bpm = opts.bpm;
    this.beats = opts.beats ?? 8;
    this.form = pick(['ABAC', 'AABA', 'ABAB', 'ABCA', 'ABCB']);
    for (let p = 0; p < 3; p++) this.parts.push(writeDuet(this.key, this.beats, { homophonic: opts.homophonic }));
  }

  get secondsPerBeat(): number {
    return 60 / this.bpm;
  }

  /** The next phrase, or null when the song is over. */
  next(): Duet | null {
    if (this.i >= this.form.length) return null;
    const idx = this.form.charCodeAt(this.i) - 65;
    const seenBefore = this.form.indexOf(this.form[this.i]) < this.i;
    this.i++;
    const part = this.parts[idx];
    return seenBefore && chance(0.6) ? varyDuet(this.key, part) : part;
  }
}
