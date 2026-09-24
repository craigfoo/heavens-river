// Subtle screen-space god rays (spec 5.3): march from each pixel toward the
// sun's screen position, gathering bright sky (pixels with no geometry in the
// depth buffer). Hills, trees and roofs occlude the sky and cut shafts into
// the glow. Strongest at golden hour, off at night and underwater.

import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Vector2, Vector3, type PerspectiveCamera } from 'three';

const frag = /* glsl */ `
uniform vec2 sunUv;
uniform float strength;
uniform vec3 tint;

float shaftHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// This pass also guards the HDR frame: a NaN or Inf from any shader (some GPU
// drivers produce them where others do not) would otherwise be smeared into
// flickering black blocks by the bloom's mip chain and this ray march.
vec3 shaftClean(vec3 c) {
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
  return clamp(c, vec3(0.0), vec3(512.0));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 base = shaftClean(inputColor.rgb);
  if (strength < 0.001) {
    outputColor = vec4(base, 1.0);
    return;
  }
  vec2 d = sunUv - uv;
  float dist = length(d * vec2(aspect, 1.0));
  vec2 stepv = d / float(SHAFT_SAMPLES) * 0.85;
  vec2 p = uv + stepv * shaftHash(uv * resolution + time);
  float acc = 0.0;
  float w = 1.0;
  for (int i = 0; i < SHAFT_SAMPLES; i++) {
    p += stepv;
    vec2 q = clamp(p, vec2(0.001), vec2(0.999));
    float sky = step(0.99999, texture2D(depthBuffer, q).r);
    vec3 c = shaftClean(texture2D(inputBuffer, q).rgb);
    float b = min(max(max(c.r, c.g), c.b), 6.0);
    acc += sky * b * w;
    w *= 0.955;
  }
  acc /= float(SHAFT_SAMPLES);
  float fall = exp(-dist * 1.6);
  outputColor = vec4(base + tint * acc * strength * fall, 1.0);
}
`;

export class SunShaftsEffect extends Effect {
  /** Rays off (the pass still guards the frame), e.g. in Quinlan vision whose composite has no matching depth. */
  suppressed = false;
  /** Player / debug switch for the rays themselves. */
  raysEnabled = true;

  constructor() {
    super('SunShaftsEffect', frag, {
      blendFunction: BlendFunction.SET,
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      defines: new Map([['SHAFT_SAMPLES', '36']]),
      uniforms: new Map<string, Uniform>([
        ['sunUv', new Uniform(new Vector2(0.5, 0.5))],
        ['strength', new Uniform(0)],
        ['tint', new Uniform(new Vector3(1, 0.8, 0.6))],
      ]),
    });
  }

  /** Update from the sun direction (render frame) and the camera. */
  setSun(camera: PerspectiveCamera, sunDir: Vector3, amount: number, tint: { r: number; g: number; b: number }) {
    const fwd = _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const facing = fwd.dot(sunDir);
    _p.copy(sunDir).multiplyScalar(1e4).add(camera.position).project(camera);
    (this.uniforms.get('sunUv')!.value as Vector2).set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
    // fade out as the sun swings behind the camera
    const k = Math.max(0, Math.min(1, (facing - 0.05) / 0.35));
    this.uniforms.get('strength')!.value = this.suppressed || !this.raysEnabled || !Number.isFinite(_p.x + _p.y) ? 0 : amount * k;
    const t = this.uniforms.get('tint')!.value as Vector3;
    const m = Math.max(tint.r, tint.g, tint.b, 1e-3);
    t.set(tint.r / m, tint.g / m, tint.b / m);
  }
}

const _f = new Vector3();
const _p = new Vector3();
