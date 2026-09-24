// The textured Quinlan model, built from the Meshy source by
// tools/quinlan/build.mjs into public/models/. It has three LODs that carry the
// rig attributes the vertex-shader animation reads (see quinlanModel.ts,
// QUINLAN_RIG): LOD 0 samples the colour texture, the mid and far LODs have the
// texture's colours baked into their vertices.
//
// Loading is asynchronous and optional: until it arrives (or if it fails) the
// procedural model stands in.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
  Sphere,
  TextureLoader,
  Vector3,
  type Texture,
  type TypedArray,
} from 'three';
import type { QuinlanRigInfo } from './quinlanModel';

export interface QuinlanAsset {
  rig: QuinlanRigInfo;
  /** Nearest first. */
  lods: BufferGeometry[];
  /** Whether each LOD samples the albedo texture (otherwise vertex colours). */
  textured: boolean[];
  albedo: Texture;
}

interface AttrInfo {
  offset: number;
  type: 'f32' | 'i8n' | 'u8n' | 'u16n';
  size: number;
}

interface FileMeta {
  version: number;
  joints: QuinlanRigInfo['joints'];
  pose?: QuinlanRigInfo['pose'];
  albedo: string;
  lods: {
    vertices: number;
    triangles: number;
    textured: boolean;
    attributes: Record<string, AttrInfo>;
    index: { offset: number; type: 'u16' | 'u32'; count: number };
  }[];
}

/** Attribute names in the file -> geometry attribute names. */
const NAMES: Record<string, string> = { position: 'position', normal: 'normal', uv: 'uv', color: 'color', rig0: 'aQ0', rig1: 'aQ1' };

let pending: Promise<QuinlanAsset | null> | null = null;

/** Start (or join) loading the model. Resolves to null if it can't be loaded. */
export function loadQuinlanAsset(): Promise<QuinlanAsset | null> {
  if (!pending) {
    pending = load().catch((e) => {
      console.warn('Quinlan model could not be loaded; using the procedural one.', e);
      return null;
    });
  }
  return pending;
}

async function load(): Promise<QuinlanAsset> {
  const base = `${import.meta.env.BASE_URL}models/`;
  const res = await fetch(`${base}quinlan.bin`);
  if (!res.ok) throw new Error(`quinlan.bin: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'QNL1') throw new Error('quinlan.bin: not a Quinlan model file');
  const jsonLength = new DataView(buf).getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jsonLength))) as FileMeta;
  if (meta.version !== 1) throw new Error(`quinlan.bin: unsupported version ${meta.version}`);
  const bin = 8 + jsonLength;

  const lods = meta.lods.map((L, k) => {
    const g = new BufferGeometry();
    for (const [name, a] of Object.entries(L.attributes)) {
      const n = L.vertices * a.size;
      const at = bin + a.offset;
      let arr: TypedArray;
      if (a.type === 'f32') arr = new Float32Array(buf, at, n);
      else if (a.type === 'i8n') arr = new Int8Array(buf, at, n);
      else if (a.type === 'u8n') arr = new Uint8Array(buf, at, n);
      else arr = new Uint16Array(buf, at, n);
      g.setAttribute(NAMES[name] ?? name, new BufferAttribute(arr, a.size, a.type !== 'f32'));
    }
    const ix = L.index;
    g.setIndex(new BufferAttribute(ix.type === 'u16' ? new Uint16Array(buf, bin + ix.offset, ix.count) : new Uint32Array(buf, bin + ix.offset, ix.count), 1));
    // generous bounds that cover every animated pose (the tail and bill reach far)
    g.boundingBox = new Box3(new Vector3(-1.2, -0.9, -1.6), new Vector3(1.2, 1.6, 1.5));
    g.boundingSphere = new Sphere(new Vector3(0, 0.35, 0), 1.75);
    g.name = `quinlan-mesh-lod${k}`;
    g.userData.triangles = L.triangles;
    return g;
  });

  const albedo = await new TextureLoader().loadAsync(`${base}${meta.albedo}`);
  albedo.colorSpace = SRGBColorSpace;
  albedo.flipY = false; // glTF texture coordinates
  albedo.minFilter = LinearMipmapLinearFilter;
  albedo.anisotropy = 4;
  albedo.needsUpdate = true;

  return { rig: { joints: meta.joints, pose: meta.pose }, lods, textured: meta.lods.map((L) => L.textured), albedo };
}
