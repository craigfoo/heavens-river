// Final pass of the intro: each shot renders into an HDR multisampled target;
// this pass adds a cheap bloom from that target's mip chain, crossfades from
// the previous shot, applies ACES, vignette and grain, and fades to black or
// gold in display space. The host's tone mapping settings are never touched.

import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { NOISE, TONE } from './glsl';

const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const frag = /* glsl */ `
${NOISE}
${TONE}
uniform sampler2D tA;
uniform sampler2D tB;
uniform float uMix;
uniform vec2 uRes;
uniform vec2 uResB;
uniform float uExposure;
uniform float uBloom;
uniform float uBloomThr;
uniform float uBlack;
uniform vec3 uFadeColor;
uniform float uFade;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
varying vec2 vUv;

vec3 tapLod(sampler2D t, vec2 uv, float lod, vec2 res) {
  vec2 px = exp2(max(lod, 0.0)) / res;
  vec3 c = textureLod(t, uv + px * vec2(-0.7, -0.7), lod).rgb;
  c += textureLod(t, uv + px * vec2(0.7, -0.7), lod).rgb;
  c += textureLod(t, uv + px * vec2(-0.7, 0.7), lod).rgb;
  c += textureLod(t, uv + px * vec2(0.7, 0.7), lod).rgb;
  return c * 0.25;
}
// 3x3 tent over a coarse mip: wide and smooth, no blocky upsampling
vec3 tentLod(sampler2D t, vec2 uv, float lod, vec2 res) {
  vec2 px = exp2(max(lod, 0.0)) / res * 1.25;
  vec3 c = textureLod(t, uv, lod).rgb * 4.0;
  c += (textureLod(t, uv + vec2(px.x, 0.0), lod).rgb + textureLod(t, uv - vec2(px.x, 0.0), lod).rgb
      + textureLod(t, uv + vec2(0.0, px.y), lod).rgb + textureLod(t, uv - vec2(0.0, px.y), lod).rgb) * 2.0;
  c += textureLod(t, uv + px, lod).rgb + textureLod(t, uv - px, lod).rgb
     + textureLod(t, uv + vec2(px.x, -px.y), lod).rgb + textureLod(t, uv + vec2(-px.x, px.y), lod).rgb;
  return c / 16.0;
}
// glow from the mip chain: a tight halo plus progressively wider, softer ones
vec3 bloomOf(sampler2D t, vec2 uv, vec2 res, float bias) {
  vec3 b = tapLod(t, uv, 1.0 + bias, res) * 0.25
         + tapLod(t, uv, 3.0 + bias, res) * 0.3
         + tentLod(t, uv, 4.5 + bias, res) * 0.27
         + tentLod(t, uv, 6.0 + bias, res) * 0.18;
  // threshold on luminance so halos keep the source's hue
  float l = dot(b, vec3(0.2126, 0.7152, 0.0722));
  return b * (max(l - uBloomThr, 0.0) / max(l, 1e-4));
}

void main() {
  vec3 c = texture2D(tA, vUv).rgb + bloomOf(tA, vUv, uRes, 0.0) * uBloom;
  if (uMix < 0.999) {
    vec3 b = texture2D(tB, vUv).rgb + bloomOf(tB, vUv, uResB, -1.0) * uBloom;
    c = mix(b, c, uMix);
  }
  c = hr_aces(c * uExposure);
  vec2 q = vUv - 0.5;
  q.x *= uRes.x / uRes.y;
  float vig = 1.0 - smoothstep(0.35, 1.2, length(q) * 1.15);
  c *= mix(1.0, vig, uVignette);
  vec3 s = hr_toSRGB(c) * (1.0 - uBlack);
  float n = hr_h21(gl_FragCoord.xy + fract(uTime * 7.31) * 311.0) + hr_h21(gl_FragCoord.yx * 1.31 + fract(uTime * 3.7) * 97.0) - 1.0;
  s += n * uGrain * (1.0 - uFade);
  s = mix(s, uFadeColor, uFade);
  gl_FragColor = vec4(hr_toLinear(clamp(s, 0.0, 1.0)), 1.0);
  #include <colorspace_fragment>
}
`;

export interface PostParams {
  mix: number;
  exposure: number;
  bloom: number;
  bloomThr: number;
  black: number;
  fade: number;
  vignette: number;
  grain: number;
  time: number;
}

export class PostPass {
  readonly rt: WebGLRenderTarget;
  readonly rtB: WebGLRenderTarget;
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: ShaderMaterial;
  private w = 0;
  private h = 0;

  constructor(fadeColor: string) {
    const opts = {
      type: HalfFloatType,
      format: RGBAFormat,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
    };
    this.rt = new WebGLRenderTarget(4, 4, { ...opts, samples: 4 });
    this.rtB = new WebGLRenderTarget(4, 4, { ...opts, samples: 0 });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    // the fade colour is mixed in display space, so keep its sRGB value as authored
    const fade = new Color().setStyle(fadeColor, LinearSRGBColorSpace);
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        tA: { value: this.rt.texture },
        tB: { value: this.rtB.texture },
        uMix: { value: 1 },
        uRes: { value: new Vector2(4, 4) },
        uResB: { value: new Vector2(4, 4) },
        uExposure: { value: 1 },
        uBloom: { value: 1 },
        uBloomThr: { value: 1 },
        uBlack: { value: 0 },
        uFadeColor: { value: fade },
        uFade: { value: 0 },
        uVignette: { value: 0.3 },
        uGrain: { value: 0.015 },
        uTime: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  setSize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.rt.setSize(w, h);
    const wb = Math.max(1, Math.ceil(w / 2));
    const hb = Math.max(1, Math.ceil(h / 2));
    this.rtB.setSize(wb, hb);
    (this.mat.uniforms.uRes.value as Vector2).set(w, h);
    (this.mat.uniforms.uResB.value as Vector2).set(wb, hb);
  }

  set(p: PostParams) {
    const u = this.mat.uniforms;
    u.uMix.value = p.mix;
    u.uExposure.value = p.exposure;
    u.uBloom.value = p.bloom;
    u.uBloomThr.value = p.bloomThr;
    u.uBlack.value = p.black;
    u.uFade.value = p.fade;
    u.uVignette.value = p.vignette;
    u.uGrain.value = p.grain;
    u.uTime.value = p.time;
  }

  dispose() {
    this.rt.dispose();
    this.rtB.dispose();
    this.mat.dispose();
    for (const c of this.scene.children) (c as Mesh).geometry.dispose();
  }
}
