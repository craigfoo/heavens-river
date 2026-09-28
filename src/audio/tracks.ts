// Recorded music: the tracks in public/music, each placed by what its file
// name says (see classify): the start sequence, the map, a barge, a town (a
// tavern tune by night) or the open fields, where a track is followed by a
// spell of just wind and birds. Two <audio> players stream the tracks into
// the WebAudio graph, so the volume setting, menus and water muffle them like
// the rest of the sound, and they crossfade as the scene changes. A track
// left off for a moment (a look at the map) picks up where it was.

import files from 'virtual:music-files';
import { bq, gn } from './synth';
import { SmoothParam, clamp01, expLerp, rand } from './util';

export type MusicScene = 'start' | 'map' | 'barge' | 'village' | 'fields';

/** What the game is doing, as far as the music cares ('hold': a cutscene, keep playing). */
export type MusicCue = 'intro' | 'map' | 'barge' | 'world' | 'hold';

interface Track {
  url: string;
  scene: MusicScene;
  /** true: night only, false: day only, null: any time. */
  night: boolean | null;
  failed: boolean;
  /** Where it was left off, and when (it resumes if it comes back soon). */
  pos: number;
  left: number;
}

interface Slot {
  el: HTMLAudioElement;
  gain: GainNode;
  track: Track | null;
  /** Fading out: pause once this audio time has passed. */
  stopAt: number;
}

/** Level of the music bus at full volume: under the world, over the wind. */
const BASE = 0.5;
/** Menus (not the map, which has its own music) turn the music down to this. */
const DUCK = 0.45;
/** A track left off less than this long ago (s) resumes where it was. */
const RESUME = 150;

/**
 * Where a file plays, from its name: "...Fields-Daytime", "...Fields-Night",
 * "...on-barge", "...on-barge-night", "...Village", "...Tavern...", "...Map",
 * "Start...". Anything unrecognised is left out.
 */
export function classify(file: string): Pick<Track, 'scene' | 'night'> | null {
  const n = file.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const word = (w: string) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(n);
  const night = /night/.test(n) ? true : /day/.test(n) ? false : null;
  if (word('start') || /intro|title/.test(n)) return { scene: 'start', night: null };
  if (word('map')) return { scene: 'map', night: null };
  if (/barge|boat/.test(n)) return { scene: 'barge', night };
  if (/field/.test(n)) return { scene: 'fields', night };
  if (/tavern/.test(n)) return { scene: 'village', night: true };
  if (/village|town|city/.test(n)) return { scene: 'village', night };
  return null;
}

/** A few samples of silence, played inside the first gesture to unlock the players (iOS). */
function silence(): string {
  const n = 64;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const s = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i);
  };
  s(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  s(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  s(36, 'data');
  v.setUint32(40, n, true);
  b.fill(128, 44);
  return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...b));
}

export class MusicPlayer {
  /** The music bus, after its level and underwater muffling. */
  readonly out: GainNode;
  private readonly level: SmoothParam;
  private readonly muffle: SmoothParam;
  private readonly tracks: Track[] = [];
  private readonly slots: Slot[] = [];
  private active: Slot | null = null;
  private volume = 0.7;
  /** The scene the music is in (playing, or resting between fields tracks). */
  private scene: MusicScene | null = null;
  private readonly restUntil: Record<MusicScene, number> = { start: 0, map: 0, barge: 0, village: 0, fields: 0 };
  private inTown = false;
  private night = false;
  private last: Track | null = null;
  private retryAt = 0;
  private hidden = false;

  constructor(
    private readonly ctx: AudioContext,
    dest: AudioNode,
  ) {
    const bus = gn(ctx, 1);
    const lp = bq(ctx, 'lowpass', 20000, 0.7);
    const out = gn(ctx, 0);
    bus.connect(lp);
    lp.connect(out);
    out.connect(dest);
    this.out = out;
    this.level = new SmoothParam(out.gain, 0.25);
    this.muffle = new SmoothParam(lp.frequency, 0.08, 0.01);
    const base = new URL('music/', document.baseURI);
    for (const f of files) {
      const c = classify(f);
      if (c) this.tracks.push({ url: new URL(encodeURIComponent(f), base).href, ...c, failed: false, pos: 0, left: -1e9 });
    }
    if (!this.tracks.length) return;
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.preload = 'auto';
      const gain = gn(ctx, 0);
      ctx.createMediaElementSource(el).connect(gain);
      gain.connect(bus);
      const slot: Slot = { el, gain, track: null, stopAt: Infinity };
      el.addEventListener('error', () => {
        // a missing or unplayable file: drop it (its scene falls back to the sung songs)
        if (slot.track && el.src === slot.track.url) slot.track.failed = true;
        if (this.active === slot) this.active = null;
      });
      this.slots.push(slot);
    }
    // inside the gesture that started the audio: let the players play later
    const quiet = silence();
    for (const s of this.slots) {
      s.el.src = quiet;
      void s.el.play().catch(() => undefined);
    }
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.visibilityState === 'hidden';
      const a = this.active;
      if (!a) return;
      if (this.hidden) a.el.pause();
      else void a.el.play().catch(() => undefined);
    });
  }

  /** Is there music for a scene (so its sung songs can rest)? */
  has(scene: MusicScene): boolean {
    return this.tracks.some((t) => t.scene === scene && !t.failed);
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
  }

  /**
   * cue: what the game is doing; town: 0..1 how far into a town the listener
   * is; timeOfDay: 0 midnight .. 0.5 noon; duck: a menu is open.
   */
  update(now: number, cue: MusicCue, town: number, timeOfDay: number, duck: boolean, underwater: number): void {
    if (!this.slots.length) return;
    // levels: the volume setting (squared, like the others), menus, water
    this.level.set(this.volume * this.volume * BASE * (duck && cue !== 'map' ? DUCK : 1) * (1 - 0.4 * underwater), now);
    this.muffle.set(expLerp(20000, 600, underwater), now);
    // day or night, and in a town or not, each with a margin so they don't flicker
    if (this.night ? timeOfDay > 0.255 && timeOfDay < 0.76 : timeOfDay < 0.225 || timeOfDay > 0.79) this.night = !this.night;
    if (this.inTown ? town < 0.25 : town > 0.6) this.inTown = !this.inTown;

    for (const s of this.slots) if (s !== this.active && now > s.stopAt && !s.el.paused) s.el.pause();
    const a = this.active;
    // a track that played to its end: the fields rest a while, the rest play on
    if (a && a.el.ended) {
      if (a.track) a.track.pos = 0;
      this.active = null;
      if (this.scene === 'fields') this.restUntil.fields = now + rand(45, 110);
    }

    let want: MusicScene | null =
      cue === 'hold' ? this.scene : cue === 'intro' ? 'start' : cue === 'map' ? 'map' : cue === 'barge' ? 'barge' : this.inTown ? 'village' : 'fields';
    // the start sequence plays on into the world until it ends
    if (cue === 'world' && this.scene === 'start' && this.active) want = 'start';
    if (want && !this.has(want)) want = null;

    if (want !== this.scene) {
      const from = this.scene;
      this.scene = want;
      this.fadeOut(now, from === 'map' || want === 'map' ? 1.2 : 3);
      // a breath of quiet before the fields music, unless just back from the map
      if (want === 'fields' && from && from !== 'map') this.restUntil.fields = Math.max(this.restUntil.fields, now + rand(6, 12));
    } else if (this.active?.track && want && !this.suits(this.active.track)) {
      // dusk or dawn: over to the other time of day's track, slowly
      this.fadeOut(now, 6);
      if (want === 'fields') this.restUntil.fields = Math.max(this.restUntil.fields, now + rand(15, 30));
    }
    if (!this.active && want && !this.hidden && now >= this.restUntil[want] && now >= this.retryAt) {
      const t = this.pick(want, now);
      if (t) this.play(t, now);
    }
  }

  /** Debug: what's playing. */
  debug(): { scene: MusicScene | null; track: string | null; time: number; night: boolean; inTown: boolean } {
    const a = this.active;
    return { scene: this.scene, track: a?.track ? decodeURIComponent(a.track.url.split('/').pop() ?? '') : null, time: a ? a.el.currentTime : 0, night: this.night, inTown: this.inTown };
  }

  /** The tracks that suit a scene now: this time of day's, else any time's, else any. */
  private pool(scene: MusicScene): Track[] {
    const all = this.tracks.filter((t) => t.scene === scene && !t.failed);
    const exact = all.filter((t) => t.night === this.night);
    if (exact.length) return exact;
    const any = all.filter((t) => t.night === null);
    return any.length ? any : all;
  }

  private suits(t: Track): boolean {
    return this.pool(t.scene).includes(t);
  }

  private pick(scene: MusicScene, now: number): Track | null {
    const pool = this.pool(scene);
    if (!pool.length) return null;
    const resume = pool.find((t) => t.pos > 0 && now - t.left < RESUME);
    if (resume) return resume;
    const fresh = pool.length > 1 ? pool.filter((t) => t !== this.last) : pool;
    return fresh[Math.floor(Math.random() * fresh.length)];
  }

  private play(t: Track, now: number): void {
    // the player already holding this track (fading out) takes it back; else the quieter one
    const s = this.slots.find((x) => x.track === t && !x.el.ended) ?? (this.slots[0].gain.gain.value <= this.slots[1].gain.gain.value ? this.slots[0] : this.slots[1]);
    const g = s.gain.gain;
    let from = g.value;
    if (s.track !== t) {
      s.track = t;
      s.el.src = t.url;
      from = 0;
      const at = t.pos > 0 && now - t.left < RESUME ? t.pos : 0;
      if (at > 0) s.el.addEventListener('loadedmetadata', () => (s.el.currentTime = at), { once: true });
    }
    s.stopAt = Infinity;
    g.cancelScheduledValues(now);
    g.setValueAtTime(from, now);
    g.linearRampToValueAtTime(1, now + (t.pos > 0 ? 2 : 1.2));
    this.active = s;
    this.last = t;
    s.el.play().catch((e: unknown) => {
      // not allowed yet, or still loading: try again shortly
      if (this.active === s && (e as { name?: string })?.name !== 'AbortError') {
        this.active = null;
        this.retryAt = this.ctx.currentTime + 2;
      }
    });
  }

  private fadeOut(now: number, dur: number): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (a.track) {
      a.track.pos = a.el.currentTime;
      a.track.left = now;
    }
    const g = a.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + dur);
    a.stopAt = now + dur + 0.1;
  }
}
