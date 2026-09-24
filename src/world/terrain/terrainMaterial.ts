// Terrain surface material: Lambert lighting (patched for the cylinder), with
// world-anchored procedural detail — grass tones, rock strata, crop fields
// with furrows and hedgerows, snow, and under water the colour absorption
// and caustics of the river optics (water/waterTextures.ts).

import { MeshLambertMaterial } from 'three';
import { makeBentDepthMaterial, patchWorldMaterial } from '../../render/bend';
import { U } from '../../render/uniforms';
import { waterOpticsGlsl, waterTextures } from '../water/waterTextures';

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
uniform sampler2D uCaustics;
varying vec4 vTColor;
varying vec4 vTMat;
varying float vTUnder;
${terrainNoiseGlsl}
${waterOpticsGlsl}

vec3 cropColor(float h) {
  if (h < 0.18) return vec3(0.62, 0.50, 0.20);      // ripe wheat
  if (h < 0.32) return vec3(0.44, 0.52, 0.16);      // young barley
  if (h < 0.44) return vec3(0.40, 0.30, 0.18);      // ploughed earth
  if (h < 0.56) return vec3(0.52, 0.44, 0.30);      // stubble
  if (h < 0.61) return vec3(0.50, 0.42, 0.50);      // flowering crop
  if (h < 0.78) return vec3(0.30, 0.46, 0.14);      // green crop
  if (h < 0.88) return vec3(0.70, 0.58, 0.22);      // golden crop
  return vec3(0.36, 0.40, 0.18);                    // pasture
}

// Fields are laid out per farm region (jittered ~1.1 km Voronoi cells): each
// region has its own orientation and plot size, some are long strip fields,
// and hedges run along both plot and region boundaries.
// dwx / dwy: screen-space derivatives of wb, taken by the caller outside any
// per-pixel branch (derivatives inside divergent branches are undefined, and
// some GPU drivers return Inf/NaN there)
vec3 fields(vec2 wb, vec2 dwx, vec2 dwy, float dist, vec3 base) {
  const float RC = 1100.0;
  vec2 rc = floor(wb / RC);
  float d1 = 1e12;
  float d2 = 1e12;
  vec2 rid = rc;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cc = rc + vec2(float(i), float(j));
      vec2 p = (cc + 0.15 + 0.7 * vec2(tHash(cc + 1.3), tHash(cc + 4.7))) * RC;
      float d = dot(wb - p, wb - p);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        rid = cc;
      } else if (d < d2) d2 = d;
    }
  }
  float regionEdge = (sqrt(d2) - sqrt(d1)) * 0.5;
  float ra = (tHash(rid + 7.0) - 0.5) * 1.3;
  vec2 cs = vec2(mix(70.0, 170.0, tHash(rid + 11.0)), mix(110.0, 260.0, tHash(rid + 13.0)));
  if (tHash(rid + 19.0) > 0.72) cs.x *= 0.32; // strip fields
  float ca = cos(ra);
  float sa = sin(ra);
  vec2 q = vec2(ca * wb.x - sa * wb.y, sa * wb.x + ca * wb.y) + rid * 37.0;
  vec2 c = floor(q / cs);
  vec2 f = fract(q / cs);
  float hh = tHash(c + rid * 3.1 + 17.0);
  float h = tHash(c + rid * 5.3);
  vec3 crop = pow(cropColor(h), vec3(1.6)) * 1.25;
  crop *= 0.9 + 0.2 * tNoise(wb * 0.05);
  float along = hh > 0.5 ? q.x : q.y;
  float rowC = along / 0.95;
  // derivative of 'along' from the rotation applied to wb
  vec2 ax = hh > 0.5 ? vec2(ca, -sa) : vec2(sa, ca);
  float aa = (abs(dot(ax, dwx)) + abs(dot(ax, dwy))) / 0.95;
  float rows = 0.5 + 0.5 * sin(rowC * 6.2831853);
  float rowFade = (1.0 - smoothstep(30.0, 160.0, dist)) * (1.0 - smoothstep(0.25, 0.6, aa));
  float furrow = (h < 0.5 || (h > 0.56 && h < 0.88)) ? 0.35 : 0.12;
  crop *= 1.0 - furrow * rows * rowFade;
  vec2 edge = min(f, 1.0 - f) * cs;
  float bw = 2.2 + dist * 0.004;
  float border = (1.0 - smoothstep(0.6, bw, min(edge.x, edge.y))) * step(0.35, hh);
  border = max(border, 1.0 - smoothstep(1.0, bw + 1.5, regionEdge));
  vec3 hedge = vec3(0.10, 0.16, 0.05) * (0.8 + 0.4 * tNoise(wb * 0.7));
  crop = mix(crop, hedge, border);
  return crop;
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
  vec2 wb = hrWorldSZ(wpos, uOriginModBig, 65536.0);
  vec2 wbx = dFdx(wb);
  vec2 wby = dFdy(wb);
  // the 65 km pattern wrap makes one huge derivative; ignore it
  if (dot(wbx, wbx) > 1e6) wbx = vec2(0.0);
  if (dot(wby, wby) > 1e6) wby = vec2(0.0);
  if (farm > 0.02) col = mix(col, fields(wb, wbx, wby, dist, col), farm);
  // snow
  float snow = vTColor.a;
  if (snow > 0.0) col = mix(col, vec3(0.88, 0.9, 0.95) * (0.92 + 0.1 * n1), snow);
  // under water (Clearwater's optics): sunlight on its way down to the bed and
  // back up loses red first, and the waves above focus it into caustics
  vec2 cu1 = w / W_TILE + uTime * vec2(0.021, 0.013);
  vec2 cu2 = (W_ROT1 * w) / (W_TILE * 0.8) - uTime * vec2(0.017, 0.026);
  if (vTUnder > 0.02) {
    float dep = vTUnder;
    float thB = atan(wpos.x, uR - wpos.y);
    float cB = cos(thB);
    float sB = sin(thB);
    float sunUpB = max(sB * uSunDir.x + cB * uSunDir.y, 0.0);
    float legs = 1.0 / max(wCosInside(sunUpB), 0.25);
    if (uUnderwater < 0.5) {
      float cosV = clamp(dot(normalize(cameraPosition - wpos), vec3(-sB, cB, 0.0)), 0.0, 1.0);
      legs += 1.0 / max(wCosInside(cosV), 0.25);
    }
    col *= exp(-W_SIG_T * dep * legs);
    // explicit gradients: this branch differs between neighbouring pixels
    vec3 k1 = textureGrad(uCaustics, cu1, wbx / W_TILE, wby / W_TILE).rgb;
    vec3 k2 = textureGrad(uCaustics, cu2, (W_ROT1 * wbx) / (W_TILE * 0.8), (W_ROT1 * wby) / (W_TILE * 0.8)).rgb;
    vec3 caus = min(k1, k2) * (255.0 / 64.0) * 1.3;
    float k = smoothstep(0.02, 0.3, sunUpB) * 0.8 * (1.0 - smoothstep(1.5, 7.0, dep)) * (1.0 - smoothstep(25.0, 120.0, dist));
    col *= mix(vec3(1.0), caus, k);
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
      uCaustics: { value: waterTextures().caustics },
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
