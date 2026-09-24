// Quinlan vision (spec 6.1). Quinlans have eyes on the sides of their heads.
// 'panorama': a 270° cylindrical projection stitched from three 90° renders.
// 'split': each eye's view side by side, each steerable independently.

import { Pass } from 'postprocessing';
import {
  HalfFloatType,
  LinearFilter,
  PerspectiveCamera,
  Quaternion,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type Scene,
  type WebGLRenderer,
} from 'three';

const composite = /* glsl */ `
uniform sampler2D t0;
uniform sampler2D t1;
uniform sampler2D t2;
uniform int uMode;
uniform float uHalfSpan;
uniform float uTanV;
uniform vec2 uSubTan;
varying vec2 vUv;
const float PI = 3.14159265;

vec4 subSample(sampler2D t, vec3 d, float a) {
  float c = cos(a);
  float s = sin(a);
  vec3 q = vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
  vec2 p = vec2(q.x, q.y) / max(-q.z, 1e-4);
  vec2 uv = p / uSubTan * 0.5 + 0.5;
  return textureLod(t, clamp(uv, 0.0, 1.0), 0.0);
}

void main() {
  if (uMode == 1) {
    // independent eyes: left eye on the left half
    vec2 uv = vUv;
    vec4 c = uv.x < 0.5 ? textureLod(t0, vec2(uv.x * 2.0, uv.y), 0.0) : textureLod(t1, vec2(uv.x * 2.0 - 1.0, uv.y), 0.0);
    float edge = abs(uv.x - 0.5);
    c.rgb *= smoothstep(0.0, 0.006, edge);
    gl_FragColor = c;
    return;
  }
  float phi = (vUv.x - 0.5) * 2.0 * uHalfSpan;
  float th = atan((vUv.y - 0.5) * 2.0 * uTanV);
  vec3 d = vec3(sin(phi) * cos(th), sin(th), -cos(phi) * cos(th));
  float k = clamp(floor((phi + PI * 0.25) / (PI * 0.5)), -1.0, 1.0);
  vec4 c;
  if (k < -0.5) c = subSample(t0, d, -PI * 0.5);
  else if (k > 0.5) c = subSample(t2, d, PI * 0.5);
  else c = subSample(t1, d, 0.0);
  // soft vignette at the far edges of vision
  c.rgb *= mix(0.55, 1.0, smoothstep(uHalfSpan, uHalfSpan * 0.72, abs(phi)));
  gl_FragColor = c;
}
`;

export class VisionPass extends Pass {
  private world: Scene;
  private main: PerspectiveCamera;
  private cams: PerspectiveCamera[] = [];
  private rts: WebGLRenderTarget[] = [];
  private mat: ShaderMaterial;
  mode: 'panorama' | 'split' = 'panorama';
  /** Independent eye offsets in split mode (radians; yaw + = further outward, pitch + = up). */
  eyes = { lYaw: 0, lPitch: 0, rYaw: 0, rPitch: 0 };
  resolutionScale = 0.7;
  private w = 1;
  private h = 1;

  constructor(world: Scene, main: PerspectiveCamera, samples = 0) {
    super('VisionPass');
    this.world = world;
    this.main = main;
    this.needsSwap = false;
    for (let i = 0; i < 3; i++) {
      this.cams.push(new PerspectiveCamera(90, 1, main.near, main.far));
      this.rts.push(new WebGLRenderTarget(4, 4, { type: HalfFloatType, magFilter: LinearFilter, minFilter: LinearFilter, depthBuffer: true, samples }));
    }
    this.mat = new ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }',
      fragmentShader: composite,
      uniforms: {
        t0: { value: this.rts[0].texture },
        t1: { value: this.rts[1].texture },
        t2: { value: this.rts[2].texture },
        uMode: { value: 0 },
        uHalfSpan: { value: (135 * Math.PI) / 180 },
        uTanV: { value: 1.3 },
        uSubTan: { value: new Vector3(1, 1, 0) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.mat;
  }

  setSize(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.configure();
  }

  private configure() {
    const W = this.w;
    const H = this.h;
    const A = W / Math.max(1, H);
    if (this.mode === 'panorama') {
      const span = (270 * Math.PI) / 180;
      // square pixels on the horizon line; portrait screens get stretched instead
      const tanV = Math.min(span / (2 * A), 1.6);
      const thMax = Math.atan(tanV);
      const tanH = Math.tan(((90 + 4) / 2) * (Math.PI / 180));
      // vertical coverage needed at the sub-view edges
      const needV = Math.tan(thMax) / Math.cos(Math.PI / 4) * 1.03;
      for (const c of this.cams) {
        c.fov = (2 * Math.atan(needV) * 180) / Math.PI;
        c.aspect = tanH / needV;
        c.updateProjectionMatrix();
      }
      const rtW = Math.max(64, Math.round(((W / span) * 2 * tanH) * this.resolutionScale));
      const rtH = Math.max(64, Math.round(rtW / (tanH / needV)));
      for (const rt of this.rts) rt.setSize(rtW, rtH);
      this.mat.uniforms.uTanV.value = tanV;
      (this.mat.uniforms.uSubTan.value as Vector3).set(tanH, needV, 0);
      this.mat.uniforms.uMode.value = 0;
    } else {
      const eyeAspect = W / 2 / Math.max(1, H);
      const hfov = (118 * Math.PI) / 180;
      const v = 2 * Math.atan(Math.tan(hfov / 2) / eyeAspect);
      for (const c of this.cams) {
        c.fov = (v * 180) / Math.PI;
        c.aspect = eyeAspect;
        c.updateProjectionMatrix();
      }
      for (const rt of this.rts) rt.setSize(Math.max(64, Math.round((W / 2) * this.resolutionScale * 1.2)), Math.max(64, Math.round(H * this.resolutionScale * 1.2)));
      this.mat.uniforms.uMode.value = 1;
    }
  }

  setResolutionScale(v: number) {
    this.resolutionScale = v;
    this.configure();
  }

  setMode(m: 'panorama' | 'split') {
    this.mode = m;
    this.configure();
  }

  render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget) {
    const main = this.main;
    main.updateMatrixWorld();
    const e = this.eyes;
    const eye = (75 * Math.PI) / 180;
    const yaws = this.mode === 'panorama' ? [Math.PI / 2, 0, -Math.PI / 2] : [eye + e.lYaw, -eye - e.rYaw];
    const pitches = this.mode === 'panorama' ? [0, 0, 0] : [e.lPitch, e.rPitch];
    // the shadow map only needs rendering once per frame
    const autoShadow = renderer.shadowMap.autoUpdate;
    for (let i = 0; i < yaws.length; i++) {
      const cam = this.cams[i];
      cam.position.copy(main.position);
      _q.setFromAxisAngle(_y, yaws[i]);
      cam.quaternion.copy(main.quaternion).multiply(_q);
      _q.setFromAxisAngle(_x, pitches[i]);
      cam.quaternion.multiply(_q);
      cam.near = main.near;
      cam.far = main.far;
      cam.updateMatrixWorld();
      renderer.setRenderTarget(this.rts[i]);
      renderer.clear();
      renderer.render(this.world, cam);
      renderer.shadowMap.autoUpdate = false;
    }
    renderer.shadowMap.autoUpdate = autoShadow;
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const rt of this.rts) rt.dispose();
    this.mat.dispose();
    super.dispose();
  }
}

const _q = new Quaternion();
const _y = new Vector3(0, 1, 0);
const _x = new Vector3(1, 0, 0);
