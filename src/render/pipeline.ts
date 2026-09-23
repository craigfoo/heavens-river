// Renderer + post-processing chain: HDR scene → bloom → grading → ACES → vignette.

import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  DepthOfFieldEffect,
} from 'postprocessing';
import {
  HalfFloatType,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Uniform,
  Vector3,
  WebGLRenderer,
  PCFSoftShadowMap,
} from 'three';
import { VisionPass } from './vision';
import { SunShaftsEffect } from './sunShafts';

const gradingFrag = /* glsl */ `
uniform float exposure;
uniform float underwater;
uniform float saturation;
uniform float warmth;
uniform float fade;
uniform float time;
uniform vec3 fadeColor;

void mainUv(inout vec2 uv) {
  if (underwater > 0.0) {
    uv += underwater * 0.0035 * vec2(sin(uv.y * 38.0 + time * 2.1), cos(uv.x * 31.0 + time * 1.7));
  }
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * exposure;
  if (underwater > 0.0) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 uw = vec3(0.12, 0.42, 0.40) * (l * 1.4 + 0.02);
    c = mix(c, uw + c * vec3(0.25, 0.55, 0.5), underwater * 0.75);
  }
  c *= mix(vec3(1.0), vec3(1.06, 1.0, 0.92), warmth);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c = mix(c, fadeColor, fade);
  outputColor = vec4(c, inputColor.a);
}
`;

export class GradingEffect extends Effect {
  constructor() {
    super('GradingEffect', gradingFrag, {
      blendFunction: BlendFunction.SET,
      uniforms: new Map<string, Uniform>([
        ['exposure', new Uniform(1)],
        ['underwater', new Uniform(0)],
        ['saturation', new Uniform(1.08)],
        ['warmth', new Uniform(0.3)],
        ['fade', new Uniform(0)],
        ['time', new Uniform(0)],
        ['fadeColor', new Uniform(new Vector3(0, 0, 0))],
      ]),
    });
  }
  u(name: string) {
    return this.uniforms.get(name)!;
  }
}

export interface PipelineOptions {
  msaa: number;
  pixelRatio: number;
  shadows: boolean;
}

export class Pipeline {
  readonly renderer: WebGLRenderer;
  readonly composer: EffectComposer;
  readonly grading: GradingEffect;
  readonly bloom: BloomEffect;
  readonly dof: DepthOfFieldEffect;
  readonly renderPass: RenderPass;
  readonly vision: VisionPass;
  readonly shafts = new SunShaftsEffect();
  private shaftsPass: EffectPass;
  private effectPass: EffectPass;
  private dofPass: EffectPass;
  private smaaPass: EffectPass | null = null;
  camera: PerspectiveCamera;
  scene: Scene;
  hfovDeg = 100;

  constructor(canvas: HTMLCanvasElement, scene: Scene, camera: PerspectiveCamera, opts: PipelineOptions) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      stencil: false,
      depth: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(opts.pixelRatio);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.shadowMap.enabled = opts.shadows;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: HalfFloatType,
      multisampling: opts.msaa,
    });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.vision = new VisionPass(scene, camera, opts.msaa);
    this.vision.enabled = false;
    this.composer.addPass(this.vision);
    this.shaftsPass = new EffectPass(camera, this.shafts);
    this.composer.addPass(this.shaftsPass);
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 1.1,
      luminanceSmoothing: 0.3,
      intensity: 0.55,
      radius: 0.72,
    });
    this.grading = new GradingEffect();
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ darkness: 0.38, offset: 0.32 });
    this.dof = new DepthOfFieldEffect(camera, { focusDistance: 0.02, focalLength: 0.05, bokehScale: 3 });
    this.dofPass = new EffectPass(camera, this.dof);
    this.dofPass.enabled = false;
    this.composer.addPass(this.dofPass);
    this.effectPass = new EffectPass(camera, this.bloom, this.grading, tone, vignette);
    this.composer.addPass(this.effectPass);
    if (opts.msaa === 0) {
      this.smaaPass = new EffectPass(camera, new SMAAEffect());
      this.composer.addPass(this.smaaPass);
    }
  }

  setDof(on: boolean) {
    this.dofPass.enabled = on;
  }

  /** Quinlan vision: replaces the normal scene render with a multi-view composite. */
  setVision(mode: 'off' | 'panorama' | 'split') {
    const on = mode !== 'off';
    this.renderPass.enabled = !on;
    this.vision.enabled = on;
    // the multi-view composite has no matching depth buffer for the shafts
    this.shaftsPass.enabled = !on;
    if (on) this.vision.setMode(mode);
  }

  get visionMode(): 'off' | 'panorama' | 'split' {
    return this.vision.enabled ? this.vision.mode : 'off';
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyFov();
  }

  /** Horizontal FOV in degrees (Quinlans have very wide vision). */
  setHorizontalFov(deg: number) {
    this.hfovDeg = deg;
    this.applyFov();
  }

  private applyFov() {
    const h = (this.hfovDeg * Math.PI) / 180;
    const v = 2 * Math.atan(Math.tan(h / 2) / this.camera.aspect);
    this.camera.fov = Math.min(150, (v * 180) / Math.PI);
    this.camera.updateProjectionMatrix();
  }

  render(dt: number) {
    this.renderer.info.reset();
    this.composer.render(dt);
  }
}
