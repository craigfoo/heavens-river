// Uniforms shared by every world material. Updated once per frame by the
// day/night model, the camera rig and the water system.

import { Color, Vector2, Vector3 } from 'three';
import { ATMO, R } from '../config';

export const U = {
  uR: { value: R },
  uTime: { value: 0 },
  /** Direction toward the light in the render frame (local frame of the frame origin). */
  uSunDir: { value: new Vector3(0, 1, 0) },
  /** Directional light radiance used for in-scattering. */
  uSunColor: { value: new Color(1, 1, 1) },
  /** Isotropic in-scatter radiance from the whole bright tube / hologram. */
  uAmbientScatter: { value: new Color(0.5, 0.6, 0.8) },
  uBetaR: { value: new Vector3(...ATMO.betaRayleigh) },
  uBetaM: { value: ATMO.betaMie },
  /** Density constants (Rayleigh, Mie) for rho = exp(-k (R² - r²)). */
  uAtmoK: { value: new Vector2(ATMO.kRayleigh, ATMO.kMie) },
  /** Extra user fog multiplier. */
  uFogScale: { value: 1 },
  uHoloR: { value: R - ATMO.hologramHeight },
  uHoloSoft: { value: ATMO.hologramSoftness },
  uHoloOn: { value: 1 },
  /** Hologram sky colours. */
  uSkyZenith: { value: new Color(0.25, 0.45, 0.85) },
  uSkyHorizon: { value: new Color(0.75, 0.8, 0.9) },
  uSunGlow: { value: new Color(1, 0.8, 0.5) },
  uNight: { value: 0 },
  uStarRot: { value: 0 },
  /** Light tube emission (for Bob mode & sky). */
  uTubeColor: { value: new Color(1, 0.95, 0.85) },
  uTubeRadius: { value: 350 },
  uTubeZone: { value: new Vector2(0, 1) }, // (bright zone z in render frame, strength)
  /** Underwater state of the camera. */
  uUnderwater: { value: 0 },
  uWaterY: { value: -1e9 },
  uWaterFog: { value: new Color(0.05, 0.22, 0.2) },
  /** Ambient light for custom shaders. */
  uHemiSky: { value: new Color(0.6, 0.7, 0.9) },
  uHemiGround: { value: new Color(0.3, 0.25, 0.2) },
  uLightColor: { value: new Color(1, 1, 1) },
  /** Section-periodic detail offsets: (s mod P, z mod P) of the frame origin, P = 4096. */
  uOriginMod: { value: new Vector2(0, 0) },
  /** Same with P = 65536 (for large-scale hashed patterns like fields). */
  uOriginModBig: { value: new Vector2(0, 0) },
  uExposureBoost: { value: 1 },
};

export type SharedUniforms = typeof U;
