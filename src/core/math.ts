export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const saturate = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number) => (x - a) / (b - a);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function smootherstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Polynomial smooth minimum with blend radius k. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = saturate(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** Positive modulo. */
export function mod(x: number, m: number): number {
  const r = x % m;
  return r < 0 ? r + m : r;
}

/** Wrap a value into [-m/2, m/2). */
export function wrapCentered(x: number, m: number): number {
  return mod(x + m / 2, m) - m / 2;
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Shortest signed angle difference a - b in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  return wrapCentered(a - b, Math.PI * 2);
}
