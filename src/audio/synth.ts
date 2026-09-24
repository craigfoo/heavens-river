// Procedural building blocks. Looping noise buffers (white, pink, brown) are
// generated once per AudioContext and shared by every layer; there is also a
// synthetic reverb impulse and a glottal-pulse wavetable for sung voices. The
// one-shot builders (tone blips, filtered noise bursts, water bubbles) register
// with a VoicePool so their nodes are released as soon as they finish.

import { VoicePool, clamp, rand } from './util';

export interface NoiseBank {
  /** Mono, for transients. */
  white: AudioBuffer;
  /** Stereo (decorrelated channels), for ambient beds. */
  pink: AudioBuffer;
  /** Stereo, for rumbles. */
  brown: AudioBuffer;
}

/** Pool slots ambient schedulers leave free for player-triggered one-shots. */
export const AMBIENT_RESERVE = 24;

/** Everything a one-shot builder needs. */
export interface Kit {
  ctx: BaseAudioContext;
  pool: VoicePool;
  noise: NoiseBank;
}

const whiteGen = () => () => Math.random() * 2 - 1;

// Paul Kellet's refined pink-noise filter.
function pinkGen(): () => number {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const o = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return o;
  };
}

// Leaky integrator: -6 dB/octave above ~150 Hz, flat (no DC drift) below.
function brownGen(): () => number {
  let b = 0;
  return () => (b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02);
}

/** Fill a channel with a seamless loop of noise normalised to RMS 0.25. */
function fillLoop(out: Float32Array, gen: () => number): void {
  const n = out.length;
  const fade = Math.min(4096, n >> 3);
  const tmp = new Float32Array(n + fade);
  for (let i = 0; i < tmp.length; i++) tmp[i] = gen();
  for (let i = 0; i < n; i++) out[i] = tmp[i];
  // equal-power crossfade of the overhang into the head: sample n-1 flows
  // straight into sample 0, so the loop point has no click
  for (let i = 0; i < fade; i++) {
    const x = (i / fade) * Math.PI * 0.5;
    out[i] = tmp[i] * Math.sin(x) + tmp[n + i] * Math.cos(x);
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += out[i] * out[i];
  const k = 0.25 / Math.sqrt(s / n || 1);
  for (let i = 0; i < n; i++) out[i] = clamp(out[i] * k, -1, 1);
}

export function makeNoiseBank(ctx: BaseAudioContext): NoiseBank {
  const sr = ctx.sampleRate;
  const mk = (channels: number, seconds: number, gen: () => () => number) => {
    const buf = ctx.createBuffer(channels, Math.floor(sr * seconds), sr);
    for (let c = 0; c < channels; c++) fillLoop(buf.getChannelData(c), gen());
    return buf;
  };
  // odd lengths so layers sharing a buffer never loop in step
  return { white: mk(1, 2.1, whiteGen), pink: mk(2, 4.7, pinkGen), brown: mk(2, 5.3, brownGen) };
}

/** Start a looping noise source at a random offset. */
export function loopSource(ctx: BaseAudioContext, buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(ctx.currentTime, Math.random() * buf.duration * 0.9);
  return s;
}

/** Stereo reverb impulse: diffuse noise, exponential decay, darkening tail. */
export function makeImpulse(ctx: BaseAudioContext, seconds = 2.6, rt60 = 2.2): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env =
        Math.exp((-6.9 * t) / rt60) * Math.min(1, t / 0.018) * Math.min(1, (n - i) / (sr * 0.1));
      // one-pole low-pass whose cutoff closes over time: highs die first
      const k = 0.72 - 0.62 * (i / n);
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * env;
    }
  }
  return buf;
}

/** Band-limited glottal-pulse-like wave (roughly 1/k harmonics, softened evens). */
export function makeVoiceWave(ctx: BaseAudioContext): PeriodicWave {
  const N = 40;
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);
  for (let k = 1; k <= N; k++) imag[k] = (k % 2 ? 1 : 0.7) / Math.pow(k, 1.05);
  return ctx.createPeriodicWave(real, imag);
}

function panTo(ctx: BaseAudioContext, from: AudioNode, dest: AudioNode, pan: number | undefined, nodes: AudioNode[]) {
  if (pan !== undefined && Math.abs(pan) > 0.01) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    from.connect(p);
    p.connect(dest);
    nodes.push(p);
  } else from.connect(dest);
}

export interface BlipOpts {
  t: number;
  f0: number;
  /** Optional end frequency, reached exponentially after `glide` seconds. */
  f1?: number;
  glide?: number;
  type?: OscillatorType;
  peak: number;
  attack?: number;
  /** Time to fall ~50 dB after the attack. */
  decay: number;
  pan?: number;
  /** Pool slots to leave free (ambient sounds yield to one-shots). */
  reserve?: number;
}

/** One enveloped oscillator note with an optional exponential pitch sweep. */
export function blip(k: Kit, dest: AudioNode, b: BlipOpts): void {
  if (!k.pool.ok(b.reserve) || !(b.f0 > 0) || !(b.peak > 0)) return;
  const ctx = k.ctx;
  const osc = ctx.createOscillator();
  osc.type = b.type ?? 'sine';
  const g = ctx.createGain();
  const a = b.attack ?? 0.004;
  osc.frequency.setValueAtTime(b.f0, b.t);
  if (b.f1 !== undefined)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, b.f1), b.t + (b.glide ?? a + b.decay));
  g.gain.setValueAtTime(0, b.t);
  g.gain.linearRampToValueAtTime(b.peak, b.t + a);
  g.gain.setTargetAtTime(0, b.t + a, b.decay / 6);
  osc.connect(g);
  const nodes: AudioNode[] = [osc, g];
  panTo(ctx, g, dest, b.pan, nodes);
  osc.start(b.t);
  osc.stop(b.t + a + b.decay + 0.05);
  k.pool.track(osc, nodes);
}

export interface NoiseOpts {
  t: number;
  buf?: keyof NoiseBank;
  filter: BiquadFilterType;
  f0: number;
  f1?: number;
  glide?: number;
  q?: number;
  peak: number;
  attack?: number;
  /** Seconds held at peak before the decay. */
  hold?: number;
  decay: number;
  pan?: number;
  rate?: number;
  reserve?: number;
}

/** A filtered noise burst with an optional filter sweep. */
export function noiseBurst(k: Kit, dest: AudioNode, n: NoiseOpts): void {
  if (!k.pool.ok(n.reserve) || !(n.peak > 0)) return;
  const ctx = k.ctx;
  const buf = k.noise[n.buf ?? 'white'];
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = n.rate ?? 1;
  const f = ctx.createBiquadFilter();
  f.type = n.filter;
  f.Q.value = n.q ?? 1;
  f.frequency.setValueAtTime(n.f0, n.t);
  if (n.f1 !== undefined)
    f.frequency.exponentialRampToValueAtTime(Math.max(10, n.f1), n.t + (n.glide ?? n.decay));
  const g = ctx.createGain();
  const a = n.attack ?? 0.003;
  const hold = n.hold ?? 0;
  g.gain.setValueAtTime(0, n.t);
  g.gain.linearRampToValueAtTime(n.peak, n.t + a);
  if (hold > 0) g.gain.setValueAtTime(n.peak, n.t + a + hold);
  g.gain.setTargetAtTime(0, n.t + a + hold, n.decay / 6);
  src.connect(f);
  f.connect(g);
  const nodes: AudioNode[] = [src, f, g];
  panTo(ctx, g, dest, n.pan, nodes);
  src.start(n.t, Math.random() * buf.duration * 0.8);
  src.stop(n.t + a + hold + n.decay + 0.05);
  k.pool.track(src, nodes);
}

/**
 * A water bubble or droplet: a sine that rises in pitch as it rings down
 * (Minnaert resonance of a bubble nearing the surface). Lower = bigger bubble.
 */
export function bubble(k: Kit, dest: AudioNode, t: number, f: number, peak: number, pan = 0, reserve = 0): void {
  const dur = clamp(0.02 + 28 / f, 0.025, 0.11);
  blip(k, dest, { t, f0: f, f1: f * rand(1.4, 2.3), glide: dur, peak, attack: 0.0015, decay: dur, pan, reserve });
}

/** A hollow wooden knock (deck, pole, plank). */
export function knock(k: Kit, dest: AudioNode, t: number, f: number, peak: number, pan = 0, reserve = 0): void {
  blip(k, dest, { t, f0: f * 1.25, f1: f, glide: 0.03, type: 'triangle', peak, attack: 0.002, decay: 0.12, pan, reserve });
  noiseBurst(k, dest, { t, filter: 'bandpass', f0: f * 3.2, q: 4, peak: peak * 0.9, attack: 0.001, decay: 0.05, pan, reserve });
}

/** Biquad filter factory. */
export function bq(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Gain node factory. */
export function gn(ctx: BaseAudioContext, value = 0): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** Seconds until the next event of a Poisson process with `rate` events/s. */
export function poisson(rate: number): number {
  return rate > 1e-4 ? -Math.log(1 - Math.random()) / rate : 1e9;
}

/**
 * Event times of a random (Poisson) process whose rate changes over time and
 * may be zero. Call due() in a loop each update until it returns -1.
 */
export class PoissonClock {
  private next = -1;

  due(now: number, horizon: number, rate: number, minGap = 0): number {
    if (!(rate > 1e-4)) {
      this.next = -1; // nothing pending while the rate is zero
      return -1;
    }
    if (this.next < now) this.next = now + poisson(rate); // first draw, or stale
    if (this.next >= horizon) return -1;
    const t = this.next;
    this.next += poisson(rate) + minGap;
    return t;
  }
}
