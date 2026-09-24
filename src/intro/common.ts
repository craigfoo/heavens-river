// Shared plumbing for the intro "sets" (one per shot): the set interface,
// easing helpers, a procedural starfield, blinking light points and cleanup.

import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Material,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Texture,
  Vector3,
} from 'three';
import { F_POST, F_PRE, V_POST, V_PRE } from './glsl';

export interface ViewInfo {
  aspect: number;
  /** Render-target height in device pixels. */
  heightPx: number;
  /** Device pixels per CSS pixel of the render target (point sprite sizing). */
  pxRatio: number;
  /** Seconds covered by this frame (motion-blur length). */
  dt: number;
  /** Seconds since start() (for shimmer/twinkle). */
  time: number;
}

export interface IntroSet {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Pose the camera and animate for set-local time t (seconds). */
  update(t: number, view: ViewInfo): void;
  dispose(): void;
}

/** Users who ask for reduced motion get no camera shake or vibration. */
export const SHAKE =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(a: number, b: number, x: number) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
export function smootherstep(a: number, b: number, x: number) {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
/** Fade in over [a, b], hold, fade out over [c, d]. */
export function window4(t: number, a: number, b: number, c: number, d: number) {
  return smoothstep(a, b, t) * (1 - smoothstep(c, d, t));
}

/** Vertical FOV (deg) that still shows at least minHfov (deg) horizontally on narrow screens. */
export function fitFov(cam: PerspectiveCamera, vfov: number, aspect: number, minHfov: number) {
  const need = (2 * Math.atan(Math.tan((minHfov * Math.PI) / 360) / aspect) * 180) / Math.PI;
  cam.fov = Math.max(vfov, Math.min(need, 120));
  cam.aspect = aspect;
}

/** World size of one pixel at unit view distance. */
export function pxScale(cam: PerspectiveCamera, heightPx: number) {
  return (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(heightPx, 1);
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Free every geometry, material and uniform texture under root. */
export function disposeTree(root: Object3D) {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as Material | Material[] | undefined;
    if (!mat) return;
    for (const x of Array.isArray(mat) ? mat : [mat]) {
      const u = (x as ShaderMaterial).uniforms;
      if (u) {
        for (const k in u) {
          const v = u[k].value as Texture | null;
          if (v && (v as Texture).isTexture) v.dispose();
        }
      }
      x.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Starfield: points on a sphere that follows the camera, many faint and a few
// bright, tinted by temperature, concentrated toward a galactic band.

const starVert = /* glsl */ `
${V_PRE}
attribute float aSize;
attribute vec3 aColor;
attribute float aSeed;
uniform float uPx;
uniform float uTime;
uniform float uGain;
varying vec3 vColor;
void main() {
  float tw = 1.0 + 0.18 * sin(uTime * (1.3 + aSeed * 3.0) + aSeed * 40.0);
  vColor = aColor * tw * uGain;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPx;
  ${V_POST}
}
`;
const starFrag = /* glsl */ `
${F_PRE}
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(c, c) * 3.5);
  gl_FragColor = vec4(vColor * a, 1.0);
  ${F_POST}
}
`;

export function makeStarfield(count: number, radius: number, seed: number, band: Vector3): Points {
  const rng = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seeds = new Float32Array(count);
  const bn = band.clone().normalize();
  const t1 = new Vector3(1, 0, 0).cross(bn);
  if (t1.lengthSq() < 1e-4) t1.set(0, 0, 1).cross(bn);
  t1.normalize();
  const t2 = bn.clone().cross(t1);
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    if (rng() < 0.42) {
      // galactic band: gaussian latitude around the band plane
      const lon = rng() * Math.PI * 2;
      const g = (rng() + rng() + rng() - 1.5) * 0.22;
      v.copy(t1).multiplyScalar(Math.cos(lon)).addScaledVector(t2, Math.sin(lon)).addScaledVector(bn, g).normalize();
    } else {
      const z = rng() * 2 - 1;
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      v.set(r * Math.cos(a), z, r * Math.sin(a));
    }
    pos[i * 3] = v.x * radius;
    pos[i * 3 + 1] = v.y * radius;
    pos[i * 3 + 2] = v.z * radius;
    const m = Math.pow(rng(), 9); // many faint, few bright
    const b = 0.1 + 5.5 * m;
    const temp = rng();
    // blue-white .. white .. orange
    const r = temp < 0.3 ? 0.72 : temp < 0.8 ? 1.0 : 1.0;
    const gg = temp < 0.3 ? 0.82 : temp < 0.8 ? 0.97 : 0.8;
    const bb = temp < 0.3 ? 1.0 : temp < 0.8 ? 0.92 : 0.58;
    col[i * 3] = r * b;
    col[i * 3 + 1] = gg * b;
    col[i * 3 + 2] = bb * b;
    size[i] = 1.6 + 2.2 * Math.sqrt(m);
    seeds[i] = rng();
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new Float32BufferAttribute(col, 3));
  geo.setAttribute('aSize', new Float32BufferAttribute(size, 1));
  geo.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1));
  const mat = new ShaderMaterial({
    vertexShader: starVert,
    fragmentShader: starFrag,
    uniforms: { uPx: { value: 1 }, uTime: { value: 0 }, uGain: { value: 1 } },
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const pts = new Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -9;
  return pts;
}

// ---------------------------------------------------------------------------
// Light points: small emissive sprites with a real-world size, a minimum pixel
// size (distant lights stay visible) and blink/sequence patterns.

export interface LightSpec {
  p: [number, number, number];
  /** HDR colour (linear). */
  c: [number, number, number];
  /** Diameter in world units. */
  size: number;
  /** Blink: period (s, 0 = steady), phase (0..1), duty (0..1), level when off. */
  blink?: [number, number, number, number];
}

const lightVert = /* glsl */ `
${V_PRE}
attribute vec3 aColor;
attribute float aSize;
attribute vec4 aBlink;
uniform float uTime;
uniform float uPxScale;
uniform float uMinPx;
uniform float uPx;
uniform float uGain;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 1e-6);
  float px = aSize / (depth * uPxScale);
  float shown = max(px, uMinPx * uPx);
  float on = 1.0;
  if (aBlink.x > 0.0) {
    float ph = fract(uTime / aBlink.x + aBlink.y);
    float edge = 0.04;
    on = mix(aBlink.w, 1.0, smoothstep(0.0, edge, ph) * (1.0 - smoothstep(aBlink.z, aBlink.z + edge, ph)));
  }
  // keep energy roughly constant when a light is drawn larger than it is
  float k = clamp(px / shown, 0.0, 1.0);
  vColor = aColor * on * uGain * mix(0.35, 1.0, k * k);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = shown * 2.4;
  if (on * uGain <= 0.001) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  ${V_POST}
}
`;
const lightFrag = /* glsl */ `
${F_PRE}
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float core = exp(-r2 * 9.0);
  float halo = exp(-r2 * 2.5) * 0.25;
  gl_FragColor = vec4(vColor * (core + halo), 1.0);
  ${F_POST}
}
`;

export function makeLights(specs: LightSpec[]): Points {
  const n = specs.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const blink = new Float32Array(n * 4);
  specs.forEach((s, i) => {
    pos.set(s.p, i * 3);
    col.set(s.c, i * 3);
    size[i] = s.size;
    blink.set(s.blink ?? [0, 0, 1, 1], i * 4);
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new Float32BufferAttribute(col, 3));
  geo.setAttribute('aSize', new Float32BufferAttribute(size, 1));
  geo.setAttribute('aBlink', new Float32BufferAttribute(blink, 4));
  const mat = new ShaderMaterial({
    vertexShader: lightVert,
    fragmentShader: lightFrag,
    uniforms: {
      uTime: { value: 0 },
      uPxScale: { value: 0.001 },
      uMinPx: { value: 1.6 },
      uPx: { value: 1 },
      uGain: { value: 1 },
    },
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const pts = new Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  return pts;
}

/** Update the per-frame uniforms of a light-point cloud. */
export function tickLights(pts: Points, cam: PerspectiveCamera, view: ViewInfo, time: number, gain = 1) {
  const u = (pts.material as ShaderMaterial).uniforms;
  u.uTime.value = time;
  u.uPxScale.value = pxScale(cam, view.heightPx);
  u.uPx.value = view.pxRatio;
  u.uGain.value = gain;
}
