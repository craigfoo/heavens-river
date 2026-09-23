// Shared GLSL for the arrival sequence: log-depth wrappers (the host renderer
// uses a logarithmic depth buffer, so every custom shader must write the same
// kind of depth), hashes and value noise, exact box-filtered pulse trains
// (anti-aliasing and motion blur of scrolling light strips in one formula),
// and the cratered rock of the non-rotating outer shell.

export const V_PRE = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
`;
export const V_POST = /* glsl */ `
#include <logdepthbuf_vertex>
`;
export const F_PRE = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
`;
export const F_POST = /* glsl */ `
#include <logdepthbuf_fragment>
`;

/** Hashes without sine (Dave Hoskins) and value noise. */
export const NOISE = /* glsl */ `
float hr_h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hr_h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hr_h22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hr_h31(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hr_h33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }

// 2D value noise with analytic derivatives: (value in [0,1], d/dx, d/dy).
// per > 0 wraps the lattice in y with that many cells.
vec3 hr_vn2(vec2 x, float per) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float y0 = i.y;
  float y1 = i.y + 1.0;
  if (per > 0.0) { y0 = mod(y0, per); y1 = mod(y1, per); }
  float a = hr_h21(vec2(i.x, y0));
  float b = hr_h21(vec2(i.x + 1.0, y0));
  float c = hr_h21(vec2(i.x, y1));
  float d = hr_h21(vec2(i.x + 1.0, y1));
  float k1 = b - a;
  float k2 = c - a;
  float k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}

float hr_vn3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hr_h31(i), hr_h31(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hr_h31(i + vec3(0.0, 1.0, 0.0)), hr_h31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hr_h31(i + vec3(0.0, 0.0, 1.0)), hr_h31(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hr_h31(i + vec3(0.0, 1.0, 1.0)), hr_h31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
`;

/**
 * Exact box filter of a unit-period pulse train. Filtering over the pixel
 * footprint plus the distance travelled while the "shutter" is open gives
 * anti-aliasing and physically plausible motion blur with no extra taps.
 */
export const PULSE = /* glsl */ `
// Integral over [0, x] of a unit-period train that is 1 on [0, w).
float hr_pulseI(float x, float w) { return floor(x) * w + min(fract(x), w); }
// Mean of that train over [x - r, x + r] (all in periods).
float hr_pulse(float x, float w, float r) {
  r = max(r, 1e-3);
  return (hr_pulseI(x + r, w) - hr_pulseI(x - r, w)) / (2.0 * r);
}
// Same, with the pulses centred on the integers.
float hr_bar(float x, float w, float r) { return hr_pulse(x + 0.5 * w, w, r); }
// A single box [a, b] filtered over [x - r, x + r].
float hr_box(float x, float a, float b, float r) {
  r = max(r, 1e-3);
  return clamp((min(x + r, b) - max(x - r, a)) / (2.0 * r), 0.0, 1.0);
}
`;

/**
 * The outer shell's rock: several octaves of craters (bowl + rim + bright
 * ejecta, with the sun-side rim casting an analytic shadow into the bowl) and
 * gentle ridged undulation. p is in km (x along the strand, y around it);
 * fp is the pixel footprint in km, used to fade octaves that would alias.
 * sun = (unit direction in the surface plane, tan(elevation)).
 */
export const SHELL = /* glsl */ `
uniform float uCircKm; // wrap the pattern around the strand (0: no wrap)

struct HrShell { float h; vec2 g; float alb; float sh; };

float hr_lod(float cell, float fp) { return 1.0 - smoothstep(0.1, 0.35, fp / cell); }

vec2 hr_cellSize(float cell, out float per) {
  per = 0.0;
  if (uCircKm > 0.0) {
    per = max(floor(uCircKm / cell + 0.5), 1.0);
    return vec2(cell, uCircKm / per);
  }
  return vec2(cell);
}

void hr_craters(vec2 p, float cell, float dens, float seed, vec3 sun, float w, inout HrShell s) {
  if (w <= 0.0) return;
  float per;
  vec2 cs = hr_cellSize(cell, per);
  vec2 q = p / cs;
  vec2 ip = floor(q);
  vec2 fq = q - ip;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 c = ip + o;
      if (per > 0.0) c.y = mod(c.y, per);
      vec3 r = hr_h33(vec3(c, seed));
      if (r.x > dens) continue;
      vec2 ctr = o + 0.15 + 0.7 * hr_h22(c + seed * 7.13);
      float rad = mix(0.1, 0.46, r.y * r.y);
      vec2 d = fq - ctr;
      float dist = length(d);
      float x = dist / rad;
      if (x > 2.4) continue;
      float depth = 0.42 * rad;
      float rim = 0.085 * rad;
      float h;
      float dh;
      if (x < 1.0) {
        h = depth * (x * x - 1.0) + rim;
        dh = 2.0 * depth * x;
      } else {
        float e = exp(-(x - 1.0) * (x - 1.0) * 4.0);
        h = rim * e;
        dh = -8.0 * rim * (x - 1.0) * e;
      }
      vec2 dir = d / max(dist, 1e-5);
      s.h += h * cell * w;
      s.g += dir * (dh / rad) * w;
      // fresh craters keep bright ejecta; old floors are darker
      float fresh = step(0.62, r.z);
      s.alb += w * fresh * 0.28 * exp(-(x - 1.05) * (x - 1.05) * 5.0);
      s.alb -= w * 0.06 * (1.0 - smoothstep(0.2, 1.0, x));
      // the sun-side rim shades the bowl
      if (x < 1.0 && sun.z > 0.0) {
        float b = dot(d, sun.xy);
        float tr = -b + sqrt(max(b * b - dist * dist + rad * rad, 0.0));
        float slope = (rim - h) / max(tr, 1e-4);
        s.sh = min(s.sh, mix(1.0, 1.0 - smoothstep(0.8, 1.25, slope / sun.z), w));
      }
    }
  }
}

void hr_undulate(vec2 p, float cell, float amp, float fp, inout HrShell s) {
  for (int o = 0; o < 5; o++) {
    float w = hr_lod(cell, fp);
    if (w <= 0.0) break;
    float per;
    vec2 cs = hr_cellSize(cell, per);
    vec3 n = hr_vn2(p / cs + float(o) * 17.13, per);
    s.h += (n.x - 0.5) * amp * cell * w;
    s.g += n.yz * (cell / cs) * amp * w;
    cell *= 0.5;
  }
}

HrShell hr_shell(vec2 p, float fp, vec3 sun) {
  HrShell s = HrShell(0.0, vec2(0.0), 0.0, 1.0);
  float per;
  vec2 c1 = hr_cellSize(46.0, per);
  float m1 = hr_vn2(p / c1, per).x;
  vec2 c2 = hr_cellSize(11.0, per);
  float m2 = hr_vn2(p / c2 + 5.3, per).x;
  s.alb = mix(0.68, 1.1, smoothstep(0.2, 0.8, m1 * 0.65 + m2 * 0.35));
  hr_craters(p, 34.0, 0.32, 1.0, sun, hr_lod(34.0, fp), s);
  hr_craters(p, 8.0, 0.5, 2.0, sun, hr_lod(8.0, fp), s);
  hr_craters(p, 2.0, 0.55, 3.0, sun, hr_lod(2.0, fp), s);
  hr_craters(p, 0.5, 0.6, 4.0, sun, hr_lod(0.5, fp), s);
  hr_craters(p, 0.13, 0.6, 5.0, sun, hr_lod(0.13, fp), s);
  hr_undulate(p, 16.0, 0.07, fp, s);
  return s;
}

// Regolith: half Lambert, half Lommel-Seeliger (the flat lunar look).
float hr_regolith(vec3 N, vec3 L, vec3 V) {
  float nl = max(dot(N, L), 0.0);
  float nv = max(dot(N, V), 0.05);
  return mix(nl, 2.0 * nl / (nl + nv), 0.5);
}
`;

/** ACES filmic fit (same curve as three.js) and sRGB helpers for the final pass. */
export const TONE = /* glsl */ `
vec3 hr_rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 hr_aces(vec3 c) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c = IN * (c / 0.6);
  c = hr_rrtOdt(c);
  return clamp(OUT * c, 0.0, 1.0);
}
vec3 hr_toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 hr_toLinear(vec3 c) {
  return mix(c / 12.92, pow((max(c, vec3(0.0)) + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
`;
