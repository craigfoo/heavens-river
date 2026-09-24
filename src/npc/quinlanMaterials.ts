// Shared world materials for animated Quinlans (crowds, the player's avatar):
// Lambert + vertex colours, bent onto the cylinder, animated in the vertex shader.

import { MeshDepthMaterial, MeshLambertMaterial } from 'three';
import { makeBentDepthMaterial, patchWorldMaterial } from '../render/bend';
import { quinlanAnimGlsl, quinlanAnimParsGlsl } from './quinlanModel';

let material: MeshLambertMaterial | null = null;
let depth: MeshDepthMaterial | null = null;

export function quinlanWorldMaterial(): MeshLambertMaterial {
  if (!material) {
    material = patchWorldMaterial(new MeshLambertMaterial({ vertexColors: true }), {
      key: 'quinlan',
      bend: true,
      vertexPars: quinlanAnimParsGlsl,
      vertexBegin: quinlanAnimGlsl,
    });
  }
  return material;
}

export function quinlanDepthMaterial(): MeshDepthMaterial {
  if (!depth) depth = makeBentDepthMaterial('quinlan', { vertexPars: quinlanAnimParsGlsl, vertexBegin: quinlanAnimGlsl });
  return depth;
}
