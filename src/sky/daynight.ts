// Day/night model for a light tube running down the axis.
//
// Canon: the tube dims and colour-shifts; light comes from overhead, so most of
// the day shadows point straight down. Artistic liberty (documented in the
// settings panel): at dawn and dusk the tube's emission gathers into a bright
// zone far along the axis, giving low-angle golden light along ±z.

import { Color, Vector3 } from 'three';
import { clamp, lerp, smoothstep } from '../core/math';

export interface SkyState {
  /** Elevation of the light above the local horizon (radians). */
  elevation: number;
  /** +1 if the light zone lies toward +z, -1 toward -z. */
  azimuthSign: number;
  sunColor: Color;
  sunIntensity: number;
  zenith: Color;
  horizon: Color;
  glow: Color;
  ambientScatter: Color;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  night: number;
  tube: Color;
  exposure: number;
}

interface Key {
  t: number;
  elev: number; // degrees
  sun: string;
  sunI: number;
  zenith: string;
  horizon: string;
  glow: string;
  amb: string;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  night: number;
  tube: string;
  exposure: number;
}

// t: 0 = midnight, 0.5 = midday.
const KEYS: Key[] = [
  { t: 0.0, elev: 90, sun: '#8fa6d8', sunI: 0.12, zenith: '#050a1c', horizon: '#141c34', glow: '#1a2440', amb: '#0b1226', hemiSky: '#29365e', hemiGround: '#0c0d14', hemiI: 0.35, night: 1, tube: '#39486e', exposure: 1.9 },
  { t: 0.19, elev: 90, sun: '#8fa6d8', sunI: 0.12, zenith: '#060b1e', horizon: '#18203a', glow: '#1c2848', amb: '#0c1328', hemiSky: '#29365e', hemiGround: '#0c0d14', hemiI: 0.35, night: 1, tube: '#39486e', exposure: 1.9 },
  { t: 0.235, elev: 1.2, sun: '#c86a5a', sunI: 0.6, zenith: '#1a2350', horizon: '#b4687a', glow: '#e07a58', amb: '#3a3050', hemiSky: '#4c4a78', hemiGround: '#231a1c', hemiI: 0.5, night: 0.55, tube: '#b76e6a', exposure: 1.5 },
  { t: 0.27, elev: 5, sun: '#ffa060', sunI: 2.3, zenith: '#2c4a8c', horizon: '#f0a878', glow: '#ffb070', amb: '#8a7690', hemiSky: '#7f93c6', hemiGround: '#4a3526', hemiI: 0.75, night: 0.0, tube: '#ffc890', exposure: 1.15 },
  { t: 0.34, elev: 18, sun: '#ffd09a', sunI: 3.2, zenith: '#3a68b8', horizon: '#e8c8a8', glow: '#ffd8a0', amb: '#98a6c0', hemiSky: '#9fb8e0', hemiGround: '#5a4630', hemiI: 0.9, night: 0, tube: '#ffe6c0', exposure: 1.0 },
  { t: 0.42, elev: 60, sun: '#fff0dc', sunI: 3.6, zenith: '#4a7ccc', horizon: '#c8d8ea', glow: '#fff4dc', amb: '#a8bcd8', hemiSky: '#b0c8ea', hemiGround: '#5e5038', hemiI: 1.0, night: 0, tube: '#fff6e8', exposure: 0.95 },
  { t: 0.5, elev: 90, sun: '#fff4e6', sunI: 3.7, zenith: '#4b7fd0', horizon: '#c6d6ea', glow: '#fff6e6', amb: '#aac0dc', hemiSky: '#b4ccee', hemiGround: '#605238', hemiI: 1.0, night: 0, tube: '#fff8ee', exposure: 0.95 },
  { t: 0.58, elev: 60, sun: '#fff0dc', sunI: 3.6, zenith: '#4a7ccc', horizon: '#c8d8ea', glow: '#fff4dc', amb: '#a8bcd8', hemiSky: '#b0c8ea', hemiGround: '#5e5038', hemiI: 1.0, night: 0, tube: '#fff6e8', exposure: 0.95 },
  { t: 0.66, elev: 18, sun: '#ffd09c', sunI: 3.2, zenith: '#3a64b0', horizon: '#ecc4a0', glow: '#ffd090', amb: '#9ea2bc', hemiSky: '#a0b4dc', hemiGround: '#5c4430', hemiI: 0.9, night: 0, tube: '#ffe0b0', exposure: 1.0 },
  { t: 0.73, elev: 5, sun: '#ff9650', sunI: 2.4, zenith: '#2a4284', horizon: '#f29a6a', glow: '#ffa860', amb: '#8e7088', hemiSky: '#7c88be', hemiGround: '#4a3222', hemiI: 0.75, night: 0.0, tube: '#ffb880', exposure: 1.15 },
  { t: 0.765, elev: 1.2, sun: '#c0585a', sunI: 0.6, zenith: '#18204a', horizon: '#a85a74', glow: '#d86a52', amb: '#382c4c', hemiSky: '#4a4674', hemiGround: '#21181c', hemiI: 0.5, night: 0.55, tube: '#a8606a', exposure: 1.5 },
  { t: 0.81, elev: 90, sun: '#8fa6d8', sunI: 0.12, zenith: '#060b1e', horizon: '#18203a', glow: '#1c2848', amb: '#0c1328', hemiSky: '#29365e', hemiGround: '#0c0d14', hemiI: 0.35, night: 1, tube: '#39486e', exposure: 1.9 },
  { t: 1.0, elev: 90, sun: '#8fa6d8', sunI: 0.12, zenith: '#050a1c', horizon: '#141c34', glow: '#1a2440', amb: '#0b1226', hemiSky: '#29365e', hemiGround: '#0c0d14', hemiI: 0.35, night: 1, tube: '#39486e', exposure: 1.9 },
];

const PARSED = KEYS.map((k) => ({
  ...k,
  cSun: new Color(k.sun),
  cZen: new Color(k.zenith),
  cHor: new Color(k.horizon),
  cGlow: new Color(k.glow),
  cAmb: new Color(k.amb),
  cHS: new Color(k.hemiSky),
  cHG: new Color(k.hemiGround),
  cTube: new Color(k.tube),
}));

export function computeSky(t: number, out?: SkyState): SkyState {
  t = ((t % 1) + 1) % 1;
  let i = 0;
  while (i < PARSED.length - 2 && PARSED[i + 1].t <= t) i++;
  const a = PARSED[i];
  const b = PARSED[i + 1];
  const f = smoothstep(0, 1, clamp((t - a.t) / (b.t - a.t), 0, 1));
  const s: SkyState = out ?? {
    elevation: 0,
    azimuthSign: 1,
    sunColor: new Color(),
    sunIntensity: 0,
    zenith: new Color(),
    horizon: new Color(),
    glow: new Color(),
    ambientScatter: new Color(),
    hemiSky: new Color(),
    hemiGround: new Color(),
    hemiIntensity: 0,
    night: 0,
    tube: new Color(),
    exposure: 1,
  };
  // Elevation: at night the dim tube lights from straight overhead.
  s.elevation = (lerp(a.elev, b.elev, f) * Math.PI) / 180;
  s.azimuthSign = t < 0.5 ? -1 : 1;
  s.sunColor.copy(a.cSun).lerp(b.cSun, f);
  s.sunIntensity = lerp(a.sunI, b.sunI, f);
  s.zenith.copy(a.cZen).lerp(b.cZen, f);
  s.horizon.copy(a.cHor).lerp(b.cHor, f);
  s.glow.copy(a.cGlow).lerp(b.cGlow, f);
  s.ambientScatter.copy(a.cAmb).lerp(b.cAmb, f);
  s.hemiSky.copy(a.cHS).lerp(b.cHS, f);
  s.hemiGround.copy(a.cHG).lerp(b.cHG, f);
  s.hemiIntensity = lerp(a.hemiI, b.hemiI, f);
  s.night = lerp(a.night, b.night, f);
  s.tube.copy(a.cTube).lerp(b.cTube, f);
  s.exposure = lerp(a.exposure, b.exposure, f);
  return s;
}

/** Direction toward the light in the local frame (x = +s, y = up, z = +z). */
export function sunDirection(state: SkyState, out: Vector3): Vector3 {
  const e = Math.max(state.elevation, 0.02);
  return out.set(0.0, Math.sin(e), Math.cos(e) * state.azimuthSign).normalize();
}

export function formatClock(t: number): string {
  const hours = (((t % 1) + 1) % 1) * 24;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
