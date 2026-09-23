// Terrain surface material: Lambert lighting (patched for the cylinder), with
// world-anchored procedural detail — grass tones, rock strata, crop fields
// with furrows and hedgerows, snow, and underwater caustics.

import { MeshLambertMaterial } from 'three';
import { makeBentDepthMaterial, patchWorldMaterial } from '../../render/bend';
import { U } from '../../render/uniforms';

export const terrainNoiseGlsl = /* glsl */ `
#ifndef HR_TNOISE
#define HR_TNOISE
float tHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float tNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = tHash(i);
  float b = tHash(i + vec2(1.0, 0.0));
  float c = tHash(i + vec2(0.0, 1.0));
  float d = tHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// world (s, z) of a render-frame point, modulo P
vec2 hrWorldSZ(vec3 p, vec2 originMod, float P) {
  float ds = uR * atan(p.x, uR - p.y);
  return mod(originMod + vec2(ds, p.z), P);
}
#endif
`;

const vertexPars = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aMat;
attribute float aUnder;
varying vec4 vTColor;
varying vec4 vTMat;
varying float vTUnder;
`;

const vertexBegin = /* glsl */ `
vTColor = vec4(pow(aColor.rgb, vec3(2.2)), aColor.a);
vTMat = aMat;
vTUnder = aUnder;
`;

const fragmentPars = /* glsl */ `
uniform vec2 uOriginMod;
uniform vec2 uOriginModBig;
varying vec4 vTColor;
varying vec4 vTMat;
varying float vTUnder;
${terrainNoiseGlsl}

vec3 cropColor(float h) {
  if (h < 0.18) return vec3(0.62, 0.50, 0.20);      // ripe wheat
  if (h < 0.32) return vec3(0.44, 0.52, 0.16);      // young barley
  if (h < 0.44) return vec3(0.40, 0.30, 0.18);      // ploughed earth
  if (h < 0.55) return vec3(0.52, 0.44, 0.30);      // stubble
  if (h < 0.64) return vec3(0.46, 0.36, 0.52);      // flowering crop
  if (h < 0.78) return vec3(0.30, 0.46, 0.14);      // green crop
  if (h < 0.88) return vec3(0.70, 0.58, 0.22);      // golden crop
  return vec3(0.36, 0.40, 0.18);                    // pasture
}

vec3 fields(vec2 wb, float dist, vec3 base) {
  vec2 cs = vec2(118.0, 164.0);
  vec2 c = floor(wb / cs);
  vec2 f = fract(wb / cs);
  // jitter internal boundaries a little per row of fields
  float hh = tHash(c + 17.0);
  float h = tHash(c);
  vec3 crop = pow(cropColor(h), vec3(1.6)) * 1.25;
  crop *= 0.9 + 0.2 * tNoise(wb * 0.05);
  float along = hh > 0.5 ? wb.x : wb.y;
  float rowC = along / 0.95;
  float aa = fwidth(rowC);
  float rows = 0.5 + 0.5 * sin(rowC * 6.2831853);
  float rowFade = (1.0 - smoothstep(30.0, 160.0, dist)) * (1.0 - smoothstep(0.25, 0.6, aa));
  float furrow = (h < 0.5 || (h > 0.55 && h < 0.88)) ? 0.35 : 0.12;
  crop *= 1.0 - furrow * rows * rowFade;
  vec2 edge = min(f, 1.0 - f) * cs;
  float border = 1.0 - smoothstep(0.6, 2.2 + dist * 0.004, min(edge.x, edge.y));
  vec3 hedge = vec3(0.10, 0.16, 0.05) * (0.8 + 0.4 * tNoise(wb * 0.7));
  crop = mix(crop, hedge, border * step(0.35, hh));
  return crop;
}

float caustics(vec2 p, float t) {
  vec2 q = p * 0.55;
  float a = tNoise(q + vec2(t * 0.35, t * 0.21));
  float b = tNoise(q * 1.37 - vec2(t * 0.27, -t * 0.19) + 5.1);
  return pow(1.0 - abs(a - b), 9.0);
}
`;

const fragmentColor = /* glsl */ `
{
  vec3 wpos = vHrWorld;
  float dist = length(wpos - cameraPosition);
  vec2 w = hrWorldSZ(wpos, uOriginMod, 4096.0);
  vec3 col = vTColor.rgb;
  float grass = vTMat.x;
  float rock = vTMat.y;
  float sand = vTMat.z;
  float farm = vTMat.w;
  float fine = 1.0 - smoothstep(18.0, 110.0, dist);
  float mid = 1.0 - smoothstep(120.0, 1800.0, dist);
  float n0 = tNoise(w * 0.011);
  float n1 = tNoise(w * 0.083);
  float n2 = tNoise(w * 0.61);
  float n3 = tNoise(w * 3.7);
  float gv = (n0 - 0.5) * 0.34 + (n1 - 0.5) * 0.26 * mid + (n2 - 0.5) * 0.24 * fine + (n3 - 0.5) * 0.18 * fine;
  col *= 1.0 + grass * gv;
  col = mix(col, col * vec3(1.18, 1.04, 0.66), grass * smoothstep(0.58, 0.82, n0) * 0.55);
  col = mix(col, col * vec3(0.8, 0.95, 0.7), grass * smoothstep(0.6, 0.85, n1) * 0.35 * mid);
  // rock strata and speckle
  float strata = 0.5 + 0.5 * sin(wpos.y * 0.9 + n1 * 4.0);
  col *= 1.0 + rock * ((strata - 0.5) * 0.25 * mid + (n2 - 0.5) * 0.3 * fine + (n0 - 0.5) * 0.2);
  // sand / mud speckle
  col *= 1.0 + sand * ((n3 - 0.5) * 0.25 * fine + (n1 - 0.5) * 0.15);
  if (farm > 0.02) {
    vec2 wb = hrWorldSZ(wpos, uOriginModBig, 65536.0);
    col = mix(col, fields(wb, dist, col), farm);
  }
  // snow
  float snow = vTColor.a;
  if (snow > 0.0) col = mix(col, vec3(0.88, 0.9, 0.95) * (0.92 + 0.1 * n1), snow);
  // under water: darker, greener, with dancing caustics near the surface
  if (vTUnder > 0.02) {
    float dep = vTUnder;
    col *= mix(vec3(1.0), vec3(0.42, 0.55, 0.5), smoothstep(0.0, 4.0, dep));
    col += vec3(0.5, 0.6, 0.45) * caustics(w, uTime) * (1.0 - smoothstep(0.5, 6.0, dep)) * fine * 0.5;
  }
  diffuseColor.rgb *= col;
}
`;

export function createTerrainMaterial(): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ color: 0xffffff });
  patchWorldMaterial(m, {
    key: 'terrain',
    bend: true,
    uniforms: {
      uOriginMod: U.uOriginMod,
      uOriginModBig: U.uOriginModBig,
    },
    vertexPars,
    vertexBegin,
    fragmentPars,
    fragmentColor,
  });
  return m;
}

export function createTerrainDepthMaterial() {
  return makeBentDepthMaterial('terrain');
}
