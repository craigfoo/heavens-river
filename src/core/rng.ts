// Deterministic hashing and random numbers. Everything in the world is derived
// from integer seeds so that workers and the main thread agree exactly.

/** 32-bit integer hash of up to three integers and a seed (murmur3-style finaliser). */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ Math.imul(x | 0, 0x85ebca6b), 0xc2b2ae35);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ Math.imul(y | 0, 0x27d4eb2f), 0x165667b1);
  h = (h << 17) | (h >>> 15);
  h = Math.imul(h ^ Math.imul(z | 0, 0x9e3779b1), 0x85ebca77);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash2(x: number, y: number, seed: number): number {
  return hash3(x, y, 0x51ed27, seed);
}

/** Hash to [0, 1). */
export function hash01(x: number, y: number, z: number, seed: number): number {
  return hash3(x, y, z, seed) / 4294967296;
}

/** Combine a seed with a string tag, e.g. seedFor(worldSeed, 'rivers'). */
export function seedFor(seed: number, tag: string | number): number {
  let h = seed >>> 0;
  const s = String(tag);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash3(h, s.length, 7, seed);
}

/** Small fast PRNG (mulberry32). */
export class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0 || 0x12345678;
  }
  next(): number {
    let t = (this.a = (this.a + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    // inclusive a, exclusive b
    return a + Math.floor((b - a) * this.next());
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }
  /** Approximately normal (sum of uniforms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}
