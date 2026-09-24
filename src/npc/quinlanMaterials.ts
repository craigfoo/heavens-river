// Shared world materials for animated Quinlans (crowds, the player's avatar):
// Lambert, bent onto the cylinder, animated in the vertex shader. The
// procedural model uses vertex colours; the textured model (quinlanAsset.ts)
// has its own set.

import { MeshDepthMaterial, MeshLambertMaterial } from 'three';
import { makeBentDepthMaterial, patchWorldMaterial } from '../render/bend';
import type { QuinlanAsset } from './quinlanAsset';
import { quinlanAnimGlsl, quinlanAnimParsGlsl, quinlanRigAnimParsGlsl } from './quinlanModel';

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

export interface QuinlanRigMaterials {
  /** The near LOD: albedo texture. */
  textured: MeshLambertMaterial;
  /** Mid and far LODs: baked vertex colours. */
  plain: MeshLambertMaterial;
  /** Casts a shadow but draws nothing (the player's body in first person). */
  shadowOnly: MeshLambertMaterial;
  depth: MeshDepthMaterial;
}

let rig: QuinlanRigMaterials | null = null;

export function quinlanRigMaterials(asset: QuinlanAsset): QuinlanRigMaterials {
  if (!rig) {
    const pars = quinlanRigAnimParsGlsl(asset.rig);
    const make = (m: MeshLambertMaterial, key: string, textured: boolean) =>
      patchWorldMaterial(m, {
        key,
        bend: true,
        vertexPars: `${textured ? '#define QUINLAN_TEXTURED\n' : ''}${pars}`,
        vertexBegin: quinlanAnimGlsl,
      });
    rig = {
      textured: make(new MeshLambertMaterial({ vertexColors: true, map: asset.albedo }), 'quinlan-rig-map', true),
      plain: make(new MeshLambertMaterial({ vertexColors: true }), 'quinlan-rig', false),
      shadowOnly: make(new MeshLambertMaterial({ vertexColors: true, colorWrite: false, depthWrite: false }), 'quinlan-rig', false),
      depth: makeBentDepthMaterial('quinlan-rig', { vertexPars: pars, vertexBegin: quinlanAnimGlsl }),
    };
  }
  return rig;
}
