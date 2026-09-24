// Minimal types for the parts of N8AO (https://github.com/N8python/n8ao, ISC) used here.
declare module 'n8ao' {
  import type { Camera, Color, Scene } from 'three';
  import { Pass } from 'postprocessing';

  export type N8AOQuality = 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';

  /** Screen-space ambient occlusion pass for pmndrs/postprocessing (after a RenderPass). */
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      aoRadius: number;
      distanceFalloff: number;
      intensity: number;
      color: Color;
      halfRes: boolean;
      depthAwareUpsampling: boolean;
      screenSpaceRadius: boolean;
      transparencyAware: boolean;
      gammaCorrection: boolean;
      aoSamples: number;
      denoiseSamples: number;
      denoiseRadius: number;
      accumulate: boolean;
      biasOffset: number;
      biasMultiplier: number;
    };
    setQualityMode(mode: N8AOQuality): void;
    setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
  }
}
