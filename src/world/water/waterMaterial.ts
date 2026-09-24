// River water. The look follows Clearwater by Aurélien / Lumaris
// (https://github.com/Aureliengmz/clearwater, MIT), adapted to rivers on the
// cylinder:
//  - ripples: three layers of a wave slope texture built from an ocean
//    spectrum (waterTextures.ts), carried by each channel's current with a
//    two-phase flow map; the slope variance the mipmaps average away widens
//    the sun glint with distance (LEAN), so far water turns glossy, not noisy
//  - exact dielectric Fresnel, a Beckmann sun glint
//  - Clearwater's absorption and scattering: the bed (terrain) absorbs its
//    own light on the way up and down, and the surface adds the light the
//    water column scatters toward you. Blending with alpha = Fresnel lets
//    the bed show through exactly by (1 - F)
//  - a thin foam line at the water's edge, and Snell's window from below

import { DoubleSide, ShaderMaterial } from 'three';
import { atmosphereParsGlsl } from '../../render/atmosphereGlsl';
import { bendParsVertex } from '../../render/bend';
import { U } from '../../render/uniforms';
import { terrainNoiseGlsl } from '../terrain/terrainMaterial';
import { waterOpticsGlsl, waterTextures } from './waterTextures';

const vertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${bendParsVertex}
attribute vec2 aFlow;
attribute float aDepth;
attribute float aKind;
varying vec2 vFlow;
varying float vDepth;
varying float vKind;
varying float vDist;
void main() {
  vec3 p = position;
  vec4 wp0 = modelMatrix * vec4(hrBend(p), 1.0);
  float d = length(wp0.xyz - cameraPosition);
  // lift distant water so it stays visible above coarse terrain LODs
  p.y += max(0.0, d - 1200.0) * 0.0011;
  vec4 hrLocal = vec4(hrBend(p), 1.0);
  vec4 mvPosition = modelViewMatrix * hrLocal;
  gl_Position = projectionMatrix * mvPosition;
  vHrWorld = (modelMatrix * hrLocal).xyz;
  vFlow = aFlow;
  vDepth = aDepth;
  vKind = aKind;
  vDist = d;
  #include <logdepthbuf_vertex>
}
`;

const fragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${atmosphereParsGlsl}
uniform vec2 uOriginMod;
uniform sampler2D uWaves;
varying vec3 vHrWorld;
varying vec2 vFlow;
varying float vDepth;
varying float vKind;
varying float vDist;
${terrainNoiseGlsl}
${waterOpticsGlsl}

void main() {
  #ifdef WATER_SKIRT
  // seam curtains are only for looking down through gaps between tiles
  if (uUnderwater > 0.5) discard;
  #endif
  #include <logdepthbuf_fragment>
  vec3 cam = cameraPosition;
  vec3 wpos = vHrWorld;
  // local frame of this fragment: rotation about the axis
  float th = atan(wpos.x, uR - wpos.y);
  float c = cos(th);
  float s = sin(th);
  vec2 w = hrWorldSZ(wpos, uOriginMod, 4096.0);
  bool canal = vKind > 1.5 && vKind < 2.5;
  float speed = length(vFlow);

  // ---- ripples: every texture read up here, outside any branch (Direct3D)
  float T = 3.0;
  float ph0 = fract(uTime / T);
  float ph1 = fract(uTime / T + 0.5);
  float wgt = abs(ph0 - 0.5) * 2.0;
  vec2 drift = vec2(0.045, 0.03) * uTime;
  vec2 o0 = w - vFlow * ph0 * T + drift;
  vec2 o1 = w - vFlow * ph1 * T + drift + vec2(1.37, 2.71);
  vec4 S = mix(texture(uWaves, (W_ROT1 * o0) / (W_TILE * 2.5) + 0.19), texture(uWaves, (W_ROT1 * o1) / (W_TILE * 2.5) + 0.19), wgt);
  vec4 A = mix(texture(uWaves, o0 / W_TILE), texture(uWaves, o1 / W_TILE), wgt);
  vec4 B = mix(texture(uWaves, (W_ROT1 * o0) / (W_TILE * 0.32) + 0.37), texture(uWaves, (W_ROT1 * o1) / (W_TILE * 0.32) + 0.37), wgt);
  vec2 oc = w - vFlow * ph0 * T * 1.3 - drift * 1.7;
  vec2 oc1 = w - vFlow * ph1 * T * 1.3 - drift * 1.7;
  vec4 C = mix(texture(uWaves, (W_ROT2 * oc) / (W_TILE * 0.128) + 0.71), texture(uWaves, (W_ROT2 * oc1) / (W_TILE * 0.128) + 0.71), wgt);
  // canals are sheltered and still; the fine layer only matters up close.
  // Drifting patches of calmer and choppier water (wind slicks) and softer
  // ripples in the middle distance keep the tiles from showing.
  float amp = canal ? 0.45 : (vKind < 0.5 ? 0.9 : 0.8);
  amp *= 0.35 + 0.9 * smoothstep(0.2, 0.8, tNoise(w * 0.031 + drift * 0.2));
  amp *= 1.0 - 0.45 * smoothstep(25.0, 250.0, vDist);
  const float WS = 0.55;
  const float WB = 0.45;
  float WC = 0.35 * (1.0 - smoothstep(6.0, 40.0, vDist));
  vec2 slope = (WS * (transpose(W_ROT1) * S.xy) + A.xy + WB * (transpose(W_ROT1) * B.xy) + WC * (transpose(W_ROT2) * C.xy)) * amp;
  float varS = (WS * WS * max(S.w - dot(S.xy, S.xy), 0.0) + max(A.w - dot(A.xy, A.xy), 0.0) + WB * WB * max(B.w - dot(B.xy, B.xy), 0.0) + WC * WC * max(C.w - dot(C.xy, C.xy), 0.0)) * amp * amp;
  // noise for the waterline foam, carried by the same flow map
  float fn = mix(tNoise(o0 * 1.7), tNoise(o1 * 1.7), wgt);

  vec3 nl = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 n = vec3(c * nl.x - s * nl.y, s * nl.x + c * nl.y, nl.z);
  vec3 up = vec3(-s, c, 0.0);
  vec3 sun = vec3(c * uSunDir.x - s * uSunDir.y, s * uSunDir.x + c * uSunDir.y, uSunDir.z);
  vec3 sunW = normalize(uSunDir);
  vec3 V = normalize(cam - wpos);
  bool below = !gl_FrontFacing;
  #ifdef WATER_SKIRT
  below = false;
  #endif
  if (below) {
    // under the surface: Snell's window
    vec3 nb = -n;
    float cosI = dot(V, nb);
    float win = smoothstep(0.62, 0.72, cosI);
    vec3 skyv = hrHoloSky(normalize(vec3(-V.x, abs(V.y), -V.z)));
    vec3 col = mix(uWaterFog * 1.6, skyv * 0.9, win);
    col = hrUnderwater(col, cam, wpos);
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  float NdV = clamp(dot(n, V), 0.0, 1.0);
  if (NdV < 0.02) {
    n = normalize(n + V * (0.02 - NdV));
    NdV = clamp(dot(n, V), 0.0, 1.0);
  }
  float F = wFresnel(NdV, W_IOR);

  // ---- reflection of the hologram sky
  vec3 r = reflect(-V, n);
  vec3 rl = vec3(c * r.x + s * r.y, -s * r.x + c * r.y, r.z);
  rl.y = max(rl.y, 0.02);
  vec3 refl = hrHoloSkyRefl(normalize(rl));

  // ---- sun glint: Beckmann, widened by the slope variance the distance hides
  float day = smoothstep(-0.02, 0.04, sun.y);
  float a2 = min(0.0005 + 2.0 * varS, 0.5);
  vec3 hv = V + sunW; // zero only exactly opposite the sun: guard the normalize (NaN on Direct3D)
  vec3 h = hv * inversesqrt(max(dot(hv, hv), 1e-8));
  float nh = max(dot(n, h), 0.0);
  float nls = max(dot(n, sunW), 0.0);
  float c2 = max(nh * nh, 1e-4);
  float tan2 = (1.0 - c2) / c2;
  float D = exp(-tan2 / a2) / (3.14159265 * a2 * c2 * c2);
  float vis = 0.5 / (nls * sqrt(NdV * NdV * (1.0 - a2) + a2) + NdV * sqrt(nls * nls * (1.0 - a2) + a2) + 1e-5);
  float Fh = wFresnel(max(dot(h, V), 0.0), W_IOR);
  vec3 spec = uSunColor * min(D * vis * Fh * nls, 300.0) * day;

  // ---- light the water column scatters toward you (Clearwater's model)
  float depth = max(vDepth, 0.0);
  float ctV = max(wCosInside(NdV), 0.25);
  vec3 Tv = exp(-W_SIG_T * depth / ctV);
  float sunUp = max(sun.y, 0.0);
  float ctS = max(wCosInside(sunUp), 0.25);
  float Ts = 1.0 - wFresnel(sunUp, W_IOR);
  // forward-scattering phase between the refracted sun and view rays
  vec3 tS = refract(-sunW, n, 1.0 / W_IOR);
  vec3 tV = refract(-V, n, 1.0 / W_IOR);
  float cosS = clamp(dot(tS, -tV), -1.0, 1.0);
  const float G = 0.8;
  float ph = (1.0 - G * G) / (12.566 * pow(max(1.0 + G * G - 2.0 * G * cosS, 1e-3), 1.5));
  vec3 Lsun = uSunColor * Ts * sunUp * exp(-W_SIG_T * depth * 0.5 / ctS) * (ph + 0.02) * day;
  vec3 Lsky = uAmbientScatter * 0.22 * exp(-W_SIG_A * depth * 0.6);
  vec3 Lin = W_SIG_S / W_SIG_T * (Lsun + Lsky) * (1.0 - Tv) * 3.2;
  if (canal) Lin *= vec3(0.9, 1.05, 0.85); // a touch of green in still town water

  // ---- a thin, broken foam line where the water meets the bank
  float edge = 1.0 - smoothstep(0.02, 0.16, depth);
  float foam = edge * smoothstep(0.35, 0.8, fn) * 0.55;
  foam += smoothstep(1.4, 2.2, speed) * smoothstep(0.7, 0.95, fn) * 0.25;
  vec3 foamCol = uSunColor * max(sun.y, 0.15) * 0.35 + uAmbientScatter * 0.4;

  // blending with alpha a leaves (1 - a) of the bed, which has already been
  // absorbed on its way to the surface; dividing by a keeps the composited
  // colour exact (the aerial perspective is affine)
  float a = 1.0 - (1.0 - foam) * (1.0 - F);
  vec3 x = (1.0 - foam) * (F * refl + (1.0 - F) * Lin + spec) + foam * foamCol;
  vec3 rgb = hrComposite(x / max(a, 0.02), wpos, cam);
  gl_FragColor = vec4(rgb, clamp(a, 0.0, 1.0));
}
`;

/** skirt: the variant for the seam curtains (always shaded as seen from above). */
export function createWaterMaterial(skirt = false): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    defines: skirt ? { WATER_SKIRT: '' } : {},
    uniforms: { ...U, uWaves: { value: waterTextures().waves } },
    transparent: true,
    depthWrite: true,
    side: DoubleSide,
  });
}
