// Town surface shader. Geometry is simple (boxes, prisms, domes); each vertex
// carries a surface type and surface-space metres, and this shader paints the
// detail procedurally: fitted river stone, half-timbering, clay tile rows,
// thatch, shingles, slate, planks, murals (waves, spirals, fish, the endless
// river), mosaics, cobbles, striped cloth, gold leaf and bronze.

import { MeshStandardMaterial } from 'three';
import { makeBentDepthMaterial, patchWorldMaterial } from '../render/bend';
import { terrainNoiseGlsl } from '../world/terrain/terrainMaterial';

const vertexPars = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aSurf;
varying vec3 vTCol;
varying vec4 vTSurf;
`;
const vertexBegin = /* glsl */ `
vTCol = pow(aColor.rgb, vec3(2.2));
vTSurf = aSurf;
`;

const fragmentPars = /* glsl */ `
varying vec3 vTCol;
varying vec4 vTSurf;
${terrainNoiseGlsl}
float tRough = 0.85;
float tMetal = 0.0;
float tEmit = 0.0;

vec3 palette(float k) {
  int i = int(mod(floor(k), 8.0));
  if (i == 0) return vec3(0.72, 0.42, 0.12);  // ochre
  if (i == 1) return vec3(0.62, 0.20, 0.10);  // terracotta
  if (i == 2) return vec3(0.06, 0.20, 0.42);  // deep river blue
  if (i == 3) return vec3(0.10, 0.34, 0.24);  // river green
  if (i == 4) return vec3(0.85, 0.62, 0.18);  // gold
  if (i == 5) return vec3(0.88, 0.80, 0.64);  // cream
  if (i == 6) return vec3(0.12, 0.42, 0.46);  // teal
  return vec3(0.44, 0.16, 0.30);              // plum
}

float lineAA(float d, float w, float fw) { return 1.0 - smoothstep(w - fw, w + fw, d); }

vec3 muralPaint(vec2 uv, float seed, float fw) {
  float k = floor(seed * 97.0);
  vec3 bg = palette(k);
  vec3 c1 = palette(k + 2.0);
  vec3 c2 = palette(k + 4.0);
  vec3 c3 = palette(k + 5.0);
  int motif = int(mod(k, 4.0));
  vec3 col = bg;
  if (motif == 0) {
    // rolling waves
    float y = uv.y * 1.3 + 0.35 * sin(uv.x * 1.6 + floor(uv.y * 1.3) * 1.7);
    float band = fract(y);
    col = mix(bg, c1, step(0.5, band));
    float crest = abs(band - 0.5);
    col = mix(col, c3, lineAA(crest, 0.05, fw * 1.3));
  } else if (motif == 1) {
    // spirals in a lattice
    vec2 cell = floor(uv / 1.4);
    vec2 f = fract(uv / 1.4) - 0.5;
    float r = length(f);
    float a = atan(f.y, f.x);
    float sp = fract(a / 6.2831853 + r * 3.2 + tHash(cell) * 0.5);
    col = mix(bg, c1, step(0.5, sp) * step(r, 0.47));
    col = mix(col, c3, lineAA(abs(r - 0.47), 0.025, fw));
  } else if (motif == 2) {
    // shoals of fish swimming along the wall
    vec2 cell = floor(vec2(uv.x / 1.6, uv.y / 0.9));
    vec2 f = vec2(fract(uv.x / 1.6), fract(uv.y / 0.9)) - 0.5;
    float dir = mod(cell.y, 2.0) < 1.0 ? 1.0 : -1.0;
    f.x *= dir;
    float body = length(f * vec2(1.0, 2.2)) - 0.26;
    float tail = max(abs(f.y) - (-0.2 - f.x) * 0.9, max(f.x + 0.2, -0.45 - f.x));
    float fish = min(body, tail);
    col = mix(bg, mix(c1, c2, tHash(cell)), 1.0 - smoothstep(-fw, fw, fish));
    col = mix(col, c3, lineAA(length(f - vec2(0.12, 0.03)), 0.03, fw));
  } else {
    // the river as a line with no ends
    float y = uv.y - 1.2 - 0.6 * sin(uv.x * 0.9) - 0.25 * sin(uv.x * 2.3 + 1.0);
    col = mix(bg, c1, lineAA(abs(y), 0.35, fw));
    col = mix(col, c3, lineAA(abs(abs(y) - 0.35), 0.04, fw));
    col = mix(col, c2, lineAA(abs(y + 1.1 - 0.3 * sin(uv.x * 1.7)), 0.12, fw));
  }
  // weathering
  col *= 0.82 + 0.18 * tNoise(uv * 3.0);
  return col;
}

// Weathering on roofs at the scale of metres, which (unlike the tiles and
// straw) stays visible from a distance: lichen and soot patches, sun bleaching.
vec3 roofWeather(vec3 col, vec2 uv) {
  float wn = tNoise(uv * 0.21 + 17.0);
  float wn2 = tNoise(uv * 0.07 + 3.0);
  col *= 0.8 + 0.3 * wn;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum) * vec3(1.03, 1.0, 0.93), 0.12 + 0.22 * wn2);
  col = mix(col, col * vec3(0.72, 0.8, 0.58), smoothstep(0.62, 0.82, tNoise(uv * 0.33 + 5.0)) * 0.45);
  return col;
}

vec3 townSurface(float type, vec2 uv, float param, vec3 base, float dist) {
  vec2 fw2 = fwidth(uv);
  float fw = max(fw2.x, fw2.y);
  float detail = 1.0 - smoothstep(0.08, 0.5, fw);
  int t = int(type + 0.5);
  vec3 col = base;
  tRough = 0.85;
  tMetal = 0.0;
  if (t == 1) {
    // fitted river stone: courses of varying height, rounded irregular stones
    float cy = uv.y / 0.33;
    float row = floor(cy + 0.25 * tNoise(vec2(uv.x * 0.7, 0.0)));
    float rh = 0.75 + 0.5 * tHash(vec2(row, 5.3));
    float off = tHash(vec2(row, 3.1)) * 3.0;
    float sx = (uv.x + off) / (0.42 + 0.3 * tHash(vec2(row, 7.7)));
    float cx = floor(sx + 0.3 * tNoise(vec2(uv.y * 3.0, row)));
    float fx = fract(sx + 0.3 * tNoise(vec2(uv.y * 3.0, row)));
    float fy = fract(cy + 0.25 * tNoise(vec2(uv.x * 0.7, 0.0)));
    float h = tHash(vec2(cx, row));
    vec2 q = vec2(fx - 0.5, (fy - 0.5) / rh) * 2.0;
    float edge = 1.0 - pow(max(abs(q.x), abs(q.y)), 6.0 + 4.0 * h);
    col = base * (0.7 + 0.45 * h) * (0.9 + 0.2 * tNoise(uv * 7.0));
    col = mix(col, col * vec3(1.06, 1.0, 0.9), step(0.7, tHash(vec2(cx + 3.0, row))));
    col = mix(base * 0.42, col, mix(1.0, smoothstep(0.0, 0.35, edge), detail));
    tRough = 0.9;
  } else if (t == 2 || t == 18) {
    // plaster (weathered), optionally half-timbered
    col = base * (0.94 + 0.1 * tNoise(uv * 2.0) - 0.06 * tNoise(uv * 11.0) * detail);
    col *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 1.2, uv.y)) * tNoise(vec2(uv.x * 3.0, 0.5));
    if (t == 18) {
      vec3 wood = vec3(0.075, 0.045, 0.025);
      float px = abs(fract(uv.x / 1.25 + 0.5) - 0.5) * 1.25;
      float beamY = abs(fract(uv.y / 2.5) - 0.5) * 2.5;
      float lower = abs(uv.y - 0.1);
      float frame = min(px - 0.09, min(beamY - 1.14, lower - 0.1));
      // diagonal braces in alternating panels
      vec2 cell = floor(vec2(uv.x / 1.25, uv.y / 2.5));
      vec2 pf = vec2(fract(uv.x / 1.25), fract(uv.y / 2.5));
      float diag = abs(pf.y - (mod(cell.x, 2.0) < 1.0 ? pf.x : 1.0 - pf.x)) * 1.25 - 0.06;
      if (tHash(cell) > 0.55) frame = min(frame, diag);
      col = mix(col, wood * (0.8 + 0.4 * tNoise(uv * 8.0)), 1.0 - smoothstep(-fw, fw, frame));
    }
    tRough = 0.92;
  } else if (t == 3) {
    col = base * (0.7 + 0.5 * tNoise(vec2(uv.x * 30.0, uv.y * 2.0)));
    tRough = 0.8;
  } else if (t == 4) {
    // thatch: bundled straw in courses along the slope
    float course = fract(uv.y / 0.32);
    float strands = tNoise(vec2(uv.x * 40.0, uv.y * 3.0));
    col = base * (0.7 + 0.35 * strands * detail + 0.15 * tNoise(uv * 1.5)) * (0.85 + 0.2 * smoothstep(0.0, 0.8, course));
    col = mix(col, col * vec3(0.7, 0.72, 0.6), smoothstep(0.55, 0.85, tNoise(uv * 0.6)) * 0.5);
    tRough = 1.0;
    col = roofWeather(col, uv);
  } else if (t == 5) {
    // clay roof tiles: rows with curved tile tops
    float row = floor(uv.y / 0.26);
    float x = uv.x / 0.24 + mod(row, 2.0) * 0.5;
    float fx = fract(x) - 0.5;
    float fy = fract(uv.y / 0.26);
    float curve = 1.0 - 4.0 * fx * fx;
    float h = tHash(vec2(floor(x), row));
    col = base * (0.72 + 0.28 * curve) * (0.85 + 0.3 * h);
    col = mix(col, base * 0.45, (1.0 - smoothstep(0.0, 0.14 + fw * 3.0, fy)) * detail);
    col = mix(col, col * vec3(0.8, 0.85, 0.7), smoothstep(0.6, 0.9, tNoise(uv * 0.7)) * 0.6);
    tRough = 0.7;
    col = roofWeather(col, uv);
  } else if (t == 6 || t == 7) {
    // wooden shingles / slate
    float rh = t == 6 ? 0.22 : 0.2;
    float row = floor(uv.y / rh);
    float wdt = t == 6 ? 0.18 + 0.12 * tHash(vec2(row, 1.0)) : 0.3;
    float x = uv.x / wdt + tHash(vec2(row, 2.0));
    float h = tHash(vec2(floor(x), row));
    col = base * (0.75 + 0.4 * h);
    float gap = min(fract(x), 1.0 - fract(x)) * wdt;
    col = mix(col, base * 0.35, (1.0 - smoothstep(0.004, 0.012 + fw, gap)) * detail);
    col = mix(col, base * 0.5, (1.0 - smoothstep(0.0, 0.1 + fw * 3.0, fract(uv.y / rh))) * detail);
    tRough = t == 6 ? 0.85 : 0.55;
    col = roofWeather(col, uv);
  } else if (t == 8) {
    // planks; carved patterns when param > 0.5
    float plank = floor(uv.x / 0.21);
    col = base * (0.82 + 0.3 * tHash(vec2(plank, 0.0))) * (0.85 + 0.25 * tNoise(vec2(uv.x * 20.0, uv.y * 1.5)));
    col = mix(col, base * 0.4, (1.0 - smoothstep(0.004, 0.012 + fw, min(fract(uv.x / 0.21), 1.0 - fract(uv.x / 0.21)) * 0.21)) * detail);
    if (fract(param) > 0.45 && fract(param) < 0.55 || param > 1.0) {
      // carved zig-zag and spiral bands, gilded grooves
      float z = abs(fract(uv.y * 3.0 + abs(fract(uv.x * 3.0) - 0.5)) - 0.5);
      col = mix(col, vec3(0.72, 0.5, 0.12), lineAA(z, 0.08, fw * 3.0) * detail);
    }
    tRough = 0.75;
  } else if (t == 9) {
    col = muralPaint(uv, param, fw);
    tRough = 0.9;
  } else if (t == 10) {
    col = base * (0.7 + 0.45 * tNoise(uv * 4.0) * detail + 0.2 * tNoise(uv * 0.8));
    col = mix(col, col * vec3(1.3, 1.15, 0.6), smoothstep(0.6, 0.85, tNoise(uv * 1.3)) * 0.5);
    tRough = 1.0;
  } else if (t == 11) {
    col = vec3(1.0, 0.72, 0.28) * (0.85 + 0.25 * tNoise(uv * 5.0));
    tRough = 0.28;
    tMetal = 1.0;
  } else if (t == 12) {
    // cobblestones: small, irregular setts
    vec2 g = uv / vec2(0.19, 0.16);
    float row = floor(g.y);
    g.x += tHash(vec2(row, 9.0)) * 3.0;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    f += (vec2(tHash(cell + 3.1), tHash(cell + 7.9)) - 0.5) * 0.18;
    float h = tHash(cell);
    float stone = pow(pow(abs(f.x) * 1.9, 3.0) + pow(abs(f.y) * 1.9, 3.0), 1.0 / 3.0);
    col = base * (0.68 + 0.45 * h) * (0.9 + 0.12 * tNoise(uv * 11.0));
    col = mix(col, base * 0.4, smoothstep(0.78, 0.98 + fw * 4.0, stone) * detail);
    tRough = 0.8;
  } else if (t == 13) {
    // mosaic: tesserae in concentric wave rings
    vec2 tile = floor(uv / 0.09);
    vec2 tf = fract(uv / 0.09);
    vec2 c = floor(uv / 7.0) * 7.0 + 3.5;
    float r = length((tile * 0.09) - c);
    float ring = floor(r / 0.55 + 0.3 * sin(atan(tile.y * 0.09 - c.y, tile.x * 0.09 - c.x) * 6.0));
    float k = floor(param * 17.0) + ring;
    vec3 tc = mix(palette(k), palette(k + 3.0), step(0.5, fract(ring * 0.5)));
    tc = mix(tc, base, 0.35) * (0.85 + 0.3 * tHash(tile));
    float grout = min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y));
    col = mix(base * 0.9, tc, detail);
    col = mix(col, base * 0.55, (1.0 - smoothstep(0.05, 0.15, grout)) * detail);
    tRough = 0.6;
  } else if (t == 14) {
    float stripe = step(0.5, fract(uv.x / 0.5));
    col = mix(base, vec3(0.86, 0.8, 0.66), stripe * 0.8) * (0.9 + 0.1 * tNoise(uv * 10.0));
    tRough = 0.95;
  } else if (t == 15) {
    col = vec3(0.03, 0.022, 0.018);
    tRough = 1.0;
    tEmit = 1.0;
  } else if (t == 16) {
    float rip = tNoise(uv * 3.0 + uTime * 0.6) + tNoise(uv * 5.0 - uTime * 0.8);
    col = base * (0.8 + 0.3 * rip);
    tRough = 0.08;
  } else if (t == 17) {
    col = base * (0.9 + 0.12 * tNoise(uv * 12.0) + 0.06 * tNoise(uv * 40.0) * detail);
    tRough = 0.5;
  } else if (t == 19) {
    float pat = tNoise(uv * 14.0);
    col = mix(vec3(0.55, 0.34, 0.16), vec3(0.22, 0.42, 0.32), smoothstep(0.55, 0.8, pat));
    tRough = 0.45;
    tMetal = 0.8;
  } else if (t == 20) {
    // banners: bold vertical stripes with a woven river emblem
    float k = floor(param * 23.0);
    vec3 a = palette(k);
    vec3 b = palette(k + 4.0);
    col = mix(a, b, step(0.5, fract(uv.x / 0.47)));
    float e = length(vec2(uv.x - 0.7, fract(uv.y / 2.2) * 2.2 - 1.1)) - 0.35;
    col = mix(col, vec3(0.9, 0.7, 0.2), lineAA(abs(e), 0.06, fw));
    tRough = 0.9;
  }
  return col;
}
`;

const fragmentColor = /* glsl */ `
{
  float dist = length(vHrWorld - cameraPosition);
  diffuseColor.rgb = townSurface(vTSurf.x, vTSurf.yz, vTSurf.w, vTCol, dist);
}
`;

const fragmentMat = /* glsl */ `
roughnessFactor = tRough;
metalnessFactor = tMetal;
`;

export function createTownMaterial(bend = true): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  patchWorldMaterial(m, {
    key: bend ? 'town' : 'town-rigid',
    bend,
    vertexPars,
    vertexBegin,
    fragmentPars,
    fragmentColor,
  });
  const inner = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    inner.call(m, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${fragmentMat}`);
    // dark doorways glow faintly with hearth light at night
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.9, 0.45, 0.15) * tEmit * uNight * 0.6;`,
    );
  };
  return m;
}

export function createTownDepthMaterial() {
  return makeBentDepthMaterial('town');
}
