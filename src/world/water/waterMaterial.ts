// River water: flow-mapped ripples that follow each channel's current,
// Fresnel sky reflection, depth-based absorption/transparency, shore foam,
// sun glints, and Snell's window when seen from below.

import { DoubleSide, ShaderMaterial } from 'three';
import { atmosphereParsGlsl } from '../../render/atmosphereGlsl';
import { bendParsVertex } from '../../render/bend';
import { U } from '../../render/uniforms';
import { terrainNoiseGlsl } from '../terrain/terrainMaterial';

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
varying vec3 vHrWorld;
varying vec2 vFlow;
varying float vDepth;
varying float vKind;
varying float vDist;
${terrainNoiseGlsl}

float wHeight(vec2 p, float fine) {
  return tNoise(p * 0.16) * 0.55 + tNoise(p * 0.47 + 3.1) * 0.3 + tNoise(p * 1.35 + 7.7) * 0.15 * fine;
}
vec3 wNormal(vec2 p, float amp, float fine) {
  const float e = 0.12;
  float h0 = wHeight(p, fine);
  float hx = wHeight(p + vec2(e, 0.0), fine);
  float hz = wHeight(p + vec2(0.0, e), fine);
  return normalize(vec3(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));
}

void main() {
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
  float amp = canal ? 0.06 : (vKind < 0.5 ? 0.16 : 0.12);
  amp *= 1.0 - smoothstep(10.0, 400.0, vDist) * 0.8;
  float fine = 1.0 - smoothstep(8.0, 60.0, vDist);
  // two-phase flow map
  float T = 3.0;
  float ph0 = fract(uTime / T);
  float ph1 = fract(uTime / T + 0.5);
  float wgt = abs(ph0 - 0.5) * 2.0;
  vec2 uv0 = w - vFlow * ph0 * T;
  vec2 uv1 = w - vFlow * ph1 * T + vec2(0.37, 0.71);
  vec2 drift = vec2(uTime * 0.05, uTime * 0.035);
  vec3 nl = normalize(mix(wNormal(uv0 + drift, amp, fine), wNormal(uv1 - drift, amp, fine), wgt));
  // broad slow swell
  nl = normalize(nl + vec3(tNoise(w * 0.03 + uTime * 0.02) - 0.5, 0.0, tNoise(w * 0.03 + 9.0 - uTime * 0.02) - 0.5) * 0.15);
  vec3 n = vec3(c * nl.x - s * nl.y, s * nl.x + c * nl.y, nl.z);
  vec3 up = vec3(-s, c, 0.0);
  vec3 sun = vec3(c * uSunDir.x - s * uSunDir.y, s * uSunDir.x + c * uSunDir.y, uSunDir.z);
  vec3 V = normalize(cam - wpos);
  if (!gl_FrontFacing) {
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
  // clamp to 1 as well: rounding can push the dot a hair above 1, and pow() of
  // a negative base is NaN on Direct3D
  float NdV = clamp(dot(n, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 r = reflect(-V, n);
  vec3 rl = vec3(c * r.x + s * r.y, -s * r.x + c * r.y, r.z);
  rl.y = max(rl.y, 0.02);
  vec3 refl = hrHoloSkyRefl(normalize(rl));
  // water body
  float cosV = max(dot(V, up), 0.08);
  float path = max(vDepth, 0.0) / cosV;
  vec3 sigma = canal ? vec3(0.45, 0.2, 0.26) : vec3(0.38, 0.13, 0.16);
  vec3 Tw = exp(-path * sigma);
  float alpha = clamp(1.0 - dot(Tw, vec3(0.3333)), 0.0, 1.0);
  alpha = max(alpha, smoothstep(0.0, 0.25, vDepth) * 0.25);
  vec3 lightI = uSunColor * max(sun.y, 0.0) * 0.25 + uAmbientScatter * 0.35;
  vec3 scatter = (canal ? vec3(0.06, 0.12, 0.09) : vec3(0.04, 0.11, 0.11)) * lightI * 2.2;
  // shore foam
  float foam = (1.0 - smoothstep(0.02, 0.35, vDepth)) * smoothstep(0.35, 0.75, tNoise(uv0 * 1.3 + uTime * 0.2));
  foam += smoothstep(1.2, 2.0, speed) * smoothstep(0.62, 0.9, tNoise(uv0 * 0.8)) * 0.3;
  vec3 foamCol = (uSunColor * max(sun.y, 0.2) * 0.3 + uAmbientScatter * 0.5) * 0.9;
  // sun glint
  float spec = pow(max(dot(r, sun), 0.0), 420.0) * 30.0 + pow(max(dot(r, sun), 0.0), 40.0) * 0.25;
  vec3 glint = uSunColor * spec * smoothstep(0.0, 0.05, sun.y);
  vec3 rgb = F * refl + (1.0 - F) * alpha * scatter;
  float a = 1.0 - (1.0 - F) * (1.0 - alpha);
  rgb = rgb / max(a, 1e-3);
  rgb = mix(rgb, foamCol, foam * 0.7);
  a = max(a, foam * 0.7);
  rgb += glint / max(a, 0.2);
  rgb = hrComposite(rgb, wpos, cam);
  gl_FragColor = vec4(rgb, clamp(a, 0.0, 1.0));
}
`;

export function createWaterMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: { ...U },
    transparent: true,
    depthWrite: true,
    side: DoubleSide,
  });
}
