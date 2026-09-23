// Small helpers shared by the audio layers: input sanitising, random choice,
// musical maths, AudioParam smoothing that does not flood automation
// timelines, and a bounded pool for transient (one-shot) voices.

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Exponential interpolation (for frequencies): a at t=0, b at t=1. */
export const expLerp = (a: number, b: number, t: number) => a * Math.pow(b / a, t);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** A finite number, or `def` (guards the engine against NaN / undefined input). */
export function fin(x: unknown, def = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : def;
}

export const rand = (a: number, b: number) => a + (b - a) * Math.random();
export const chance = (p: number) => Math.random() < p;
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length) % arr.length];
}
export function weighted<T>(items: readonly T[], weights: readonly number[]): T {
  let total = 0;
  for (const w of weights) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** MIDI note number to Hz. */
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
/** Decibels to linear gain. */
export const db = (d: number) => Math.pow(10, d / 20);

/**
 * Drives an AudioParam toward per-frame targets with setTargetAtTime, but only
 * writes when the target moved noticeably, so calling it at frame rate keeps
 * the param's automation list short.
 */
export class SmoothParam {
  private last = Number.NaN;
  constructor(
    readonly param: AudioParam,
    public tau = 0.08,
    private rel = 0.004,
    private abs = 1e-4,
  ) {}

  set(v: number, now: number, tau = this.tau): void {
    if (!Number.isFinite(v)) return;
    const d = Math.abs(v - this.last);
    if (d <= this.abs || d <= Math.abs(v) * this.rel) return;
    this.last = v;
    this.param.setTargetAtTime(v, now, Math.max(0.001, tau));
  }

  /** Jump immediately (used when a layer is (re)built). */
  jump(v: number, now: number): void {
    if (!Number.isFinite(v)) return;
    this.last = v;
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(v, now);
  }
}

/**
 * Bookkeeping for transient voices. Every one-shot registers its source node
 * and the nodes it owns; they are disconnected when the source ends, and new
 * one-shots are refused while `max` are still sounding.
 */
export class VoicePool {
  active = 0;
  constructor(readonly max: number) {}

  /** True if another voice may start (`reserve` keeps room for important sounds). */
  ok(reserve = 0): boolean {
    return this.active < this.max - reserve;
  }

  track(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    this.active++;
    src.onended = () => {
      this.active = Math.max(0, this.active - 1);
      src.onended = null;
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    };
  }
}

/** Stop and disconnect nodes owned by a persistent layer that is being torn down. */
export function release(nodes: AudioNode[], stopAt: number): void {
  for (const n of nodes) {
    if (n instanceof AudioScheduledSourceNode) {
      try {
        n.stop(stopAt);
      } catch {
        /* not started or already stopped */
      }
    }
  }
  // disconnect a little after the stop so the fade-out is not cut
  const delayMs = Math.max(0, (stopAt - (nodes[0]?.context.currentTime ?? 0)) * 1000) + 50;
  setTimeout(() => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }, delayMs);
}
