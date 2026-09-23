// Core constants for the Heaven's River topopolis. 1 world unit = 1 metre.
// Canon values from Dennis E. Taylor's description; derived values noted.

/** Inner cylinder radius: 56 miles. */
export const R = 90_123;
/** Section length: 560 miles (10 x radius). */
export const L = 901_232;
/** Circumference of the inner cylinder. */
export const CIRC = 2 * Math.PI * R;
/** Surface pseudo-gravity (derived from radius and ~805 m/s spin speed): ~0.73 g. */
export const G_SURFACE = 7.18;
/** Spin rate so that omega^2 * R = G_SURFACE. */
export const OMEGA = Math.sqrt(G_SURFACE / R);
/** Rotation period in seconds (~11.7 minutes). */
export const SPIN_PERIOD = (2 * Math.PI) / OMEGA;
/** Spin speed at the surface (~805 m/s). */
export const SPIN_SPEED = OMEGA * R;

/** Pseudo-gravity at height h (toward the axis): centrifugal ω²r. */
export function gravityAt(h: number): number {
  return OMEGA * OMEGA * (R - h);
}

// ---------------------------------------------------------------------------
// Terrain quadtree layout. Root tiles tile the unrolled (s, z) section.
export const ROOT_TILES_S = 16;
export const ROOT_TILE_S = CIRC / ROOT_TILES_S; // ~35.4 km
export const ROOT_TILES_Z_INNER = 25;
export const ROOT_TILE_Z = L / ROOT_TILES_Z_INNER; // ~36.0 km
/** One extra root row beyond each section end so barrier crests are not a cliff. */
export const Z_EXT = ROOT_TILE_Z;
export const Z_MIN = -Z_EXT;
export const Z_MAX = L + Z_EXT;
/** Quads per chunk edge. */
export const CHUNK_N = 64;
/** Deepest quadtree level (level 9 => ~1.1 m vertex spacing). */
export const MAX_LEVEL = 9;

// ---------------------------------------------------------------------------
// Player tuning (section 6 of the spec)
export const PLAYER = {
  eyeStand: 1.1,
  eyeQuad: 0.6,
  radius: 0.32,
  walk: 1.5,
  run: 3.5,
  quadRun: 7.0,
  swimSurface: 3.0,
  swimUnder: 5.0,
  tailBurst: 9.0,
  breath: 90,
  jumpHeight: 0.85,
  stepHeight: 0.45,
  maxSlope: 0.8, // ~39 deg: steeper slopes make you slide
};

// ---------------------------------------------------------------------------
// Atmosphere. Density follows hydrostatic equilibrium in a spinning habitat:
// rho(r)/rho(R) = exp(-k (R² - r²)), k = ω² / (2 R_air T).
export const ATMO = {
  kRayleigh: (OMEGA * OMEGA) / (2 * 287 * 288), // ~4.8e-10 m^-2
  kMie: 1 / (2 * R * 1600), // haze scale height ~1.6 km near the surface
  betaRayleigh: [5.8e-6, 13.5e-6, 33.1e-6] as [number, number, number],
  betaMie: 2.4e-5,
  hologramHeight: 24_000, // hologram shell height above the base shell
  hologramSoftness: 5_000,
};

// ---------------------------------------------------------------------------
// Day / night
export const DAY = {
  defaultCycleMinutes: 20,
};

export const SECTION_COUNT = 1_800_000; // ~1 billion miles / 560 miles
