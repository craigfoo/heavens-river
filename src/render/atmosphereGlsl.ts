// Analytic aerial perspective for the inside of a spinning cylinder, plus the
// diffuse hologram sky and underwater absorption. Shared by every material.
//
// Air density follows hydrostatic equilibrium in the rotating frame:
//   rho(r) = rho0 · exp(-k (R² - r²))
// Along a straight segment r²(t) is quadratic in t, so the optical depth is a
// Gaussian integral with a *positive* quadratic term. It is evaluated with the
// Dawson function F(x) = e^{-x²}∫₀ˣ e^{y²}dy, which keeps it bounded:
//   ∫₀¹ e^{u(t)} dt = [e^{u(1)} F(X1) - e^{u(0)} F(X0)] / √c
// The axis sits at (x = 0, y = R) in the render frame, parallel to Z.

export const atmosphereParsGlsl = /* glsl */ `
#ifndef HR_ATMO_PARS
#define HR_ATMO_PARS
uniform float uR;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbientScatter;
uniform vec3 uBetaR;
uniform float uBetaM;
uniform vec2 uAtmoK;
uniform float uFogScale;
uniform float uHoloR;
uniform float uHoloSoft;
uniform float uHoloOn;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunGlow;
uniform float uNight;
uniform float uStarRot;
uniform float uUnderwater;
uniform float uWaterY;
uniform vec3 uWaterFog;

float hrDawson(float x) {
  float ax = abs(x);
  if (ax > 10.0) {
    float i = 1.0 / x;
    float i2 = i * i;
    return i * (0.5 + i2 * (0.25 + 0.375 * i2));
  }
  float x2 = x * x;
  float num = 1.0 + x2 * (0.1049934947 + x2 * (0.0424060604 + x2 * (0.0072644182 + x2 * (0.0005064034 + x2 * 0.0001789971))));
  float den = 1.0 + x2 * (0.7715471019 + x2 * (0.2909738639 + x2 * (0.0694555761 + x2 * (0.0140005442 + x2 * (0.0008327945 + x2 * 0.0003579942)))));
  return x * num / den;
}

// ∫₀¹ exp(u0 + b t + c t²) dt with c >= 0
float hrExpQuad(float u0, float b, float c) {
  float u1 = u0 + b + c;
  if (c < 1e-4 * abs(b) || c < 1e-6) {
    float beta = u1 - u0;
    if (abs(beta) < 1e-3) return exp(0.5 * (u0 + u1));
    return (exp(u1) - exp(u0)) / beta;
  }
  float sc = sqrt(c);
  float ts = -b / (2.0 * c);
  float X0 = -sc * ts;
  float X1 = sc * (1.0 - ts);
  return max((exp(u1) * hrDawson(X1) - exp(u0) * hrDawson(X0)) / sc, 0.0);
}

// Optical depth (Rayleigh-equivalent metres, Mie-equivalent metres) from a to b.
vec2 hrOpticalDepth(vec3 a, vec3 b) {
  vec2 q0 = vec2(a.x, a.y - uR);
  vec3 d = b - a;
  float D = length(d);
  float r0 = length(q0);
  float h0 = max(uR - r0, 0.0);
  float qd = dot(q0, d.xy);
  float dd = dot(d.xy, d.xy);
  float base = h0 * (2.0 * uR - h0);
  float kR = uAtmoK.x;
  float kM = uAtmoK.y;
  float iR = hrExpQuad(-kR * base, 2.0 * kR * qd, kR * dd);
  float iM = hrExpQuad(-kM * base, 2.0 * kM * qd, kM * dd);
  return vec2(iR, iM) * D * uFogScale;
}

float hrPhaseR(float mu) { return 0.0596831 * (1.0 + mu * mu); }
float hrPhaseM(float mu) {
  const float g = 0.72;
  const float g2 = g * g;
  float den = pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5);
  return 0.1193662 * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * den);
}

// Apply extinction + in-scattering for a segment a -> b to colour col.
vec3 hrAerial(vec3 col, vec3 a, vec3 b) {
  vec2 od = hrOpticalDepth(a, b);
  vec3 tauR = uBetaR * od.x;
  float tauM = uBetaM * od.y;
  vec3 tau = tauR + vec3(tauM);
  vec3 T = exp(-tau);
  vec3 v = normalize(b - a);
  float mu = dot(v, uSunDir);
  vec3 phase = (tauR * hrPhaseR(mu) + vec3(tauM * hrPhaseM(mu))) / max(tau, vec3(1e-6));
  vec3 inscat = (1.0 - T) * (uAmbientScatter + uSunColor * phase * 4.0);
  return col * T + inscat;
}

// ---- hologram sky -------------------------------------------------------
float hrHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hrHash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float hrVNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hrHash13(vec3(i, 1.7));
  float b = hrHash13(vec3(i + vec2(1.0, 0.0), 1.7));
  float c = hrHash13(vec3(i + vec2(0.0, 1.0), 1.7));
  float d = hrHash13(vec3(i + vec2(1.0, 1.0), 1.7));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float hrClouds(vec2 p) {
  float s = 0.0;
  float a = 0.55;
  for (int i = 0; i < 5; i++) {
    s += a * hrVNoise2(p);
    p = p * 2.07 + vec2(13.1, 7.7);
    a *= 0.5;
  }
  return s;
}
vec3 hrStars(vec3 v) {
  float c = cos(uStarRot);
  float s = sin(uStarRot);
  v = vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z);
  vec3 col = vec3(0.0);
  const float N = 140.0;
  vec3 cell = floor(v * N);
  vec3 h = hrHash33(cell);
  if (h.x > 0.62) {
    vec3 sp = normalize(cell + 0.25 + 0.5 * hrHash33(cell + 17.0));
    float d = length(v - sp) * N;
    float bright = pow(h.y, 6.0) * 5.0 + 0.25;
    float tw = 0.75 + 0.25 * sin(uTime * (1.0 + 4.0 * h.z) + h.x * 60.0);
    vec3 tint = mix(vec3(1.0, 0.8, 0.6), vec3(0.7, 0.85, 1.0), h.z);
    col += tint * bright * tw * smoothstep(0.5, 0.0, d);
  }
  // faint galactic band
  float bd = dot(v, normalize(vec3(0.3, 0.2, 0.93))) * 5.0;
  float band = exp(-bd * bd);
  col += vec3(0.08, 0.09, 0.14) * band * (0.5 + hrClouds(v.xz * 9.0 + v.y * 3.0));
  return col;
}

vec3 hrHoloSky(vec3 v) {
  float e = clamp(v.y, 0.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(e, 0.45));
  float mu = max(dot(v, uSunDir), 0.0);
  col += uSunGlow * (0.35 * pow(mu, 6.0) + 0.9 * pow(mu, 48.0) + 3.0 * pow(mu, 900.0));
  // projected clouds drifting slowly across the hologram
  if (v.y > 0.02) {
    vec2 cp = v.xz / (v.y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0013);
    float cl = hrClouds(cp);
    float cover = smoothstep(0.5, 0.78, cl) * smoothstep(0.02, 0.25, v.y);
    float lit = 0.6 + 0.4 * dot(normalize(vec3(v.x, 0.3, v.z)), uSunDir);
    vec3 ccol = mix(uSkyHorizon * 0.85, vec3(1.0) * (uAmbientScatter * 0.7 + uSunGlow * 0.35 * lit), 0.7);
    col = mix(col, ccol, cover * (1.0 - 0.85 * uNight));
  }
  if (uNight > 0.01) col += hrStars(v) * uNight;
  return col;
}

// Fraction of the segment a -> b hidden by the hologram shell, and where it is crossed.
float hrHologram(vec3 a, vec3 b, out float tHit) {
  tHit = 1.0;
  if (uHoloOn < 0.001) return 0.0;
  vec2 q0 = vec2(a.x, a.y - uR);
  vec2 d = (b - a).xy;
  float dd = dot(d, d);
  if (dd < 100.0) return 0.0;
  float B = dot(q0, d);
  float tm = clamp(-B / dd, 0.0, 1.0);
  float rmin = length(q0 + d * tm);
  float cover = smoothstep(uHoloR + uHoloSoft, uHoloR - uHoloSoft, rmin);
  if (cover <= 0.0) return 0.0;
  float Rin = uHoloR + uHoloSoft;
  float C = dot(q0, q0) - Rin * Rin;
  float disc = B * B - dd * C;
  tHit = disc > 0.0 ? clamp((-B - sqrt(disc)) / dd, 0.0, tm) : tm;
  return cover * uHoloOn;
}

vec3 hrUnderwater(vec3 col, vec3 a, vec3 b) {
  if (uUnderwater < 0.5) return col;
  float D = length(b - a);
  float Lw = D;
  if (b.y > uWaterY) Lw = D * clamp((uWaterY - a.y) / max(b.y - a.y, 1e-4), 0.0, 1.0);
  vec3 T = exp(-Lw * vec3(0.34, 0.1, 0.13));
  return col * T + uWaterFog * (1.0 - T);
}

// Final composite for any surface at render-frame position p seen from the camera.
vec3 hrComposite(vec3 col, vec3 p, vec3 cam) {
  float tHit;
  float holo = hrHologram(cam, p, tHit);
  vec3 outc = hrAerial(col, cam, p);
  if (holo > 0.0) {
    vec3 ph = mix(cam, p, tHit);
    vec3 sky = hrAerial(hrHoloSky(normalize(p - cam)), cam, ph);
    outc = mix(outc, sky, holo);
  }
  return hrUnderwater(outc, cam, p);
}
#endif
`;
