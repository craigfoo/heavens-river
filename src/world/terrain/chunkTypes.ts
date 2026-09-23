// Messages exchanged with terrain workers.

export interface ChunkRequest {
  type: 'chunk';
  key: string;
  level: number;
  s0: number;
  z0: number;
  sizeS: number;
  sizeZ: number;
  n: number;
  /** Generate vegetation instances (fine levels only). */
  veg: boolean;
}

export interface ChunkResult {
  type: 'chunk';
  key: string;
  level: number;
  anchorS: number;
  anchorZ: number;
  hMin: number;
  hMax: number;
  /** Bounding sphere in the anchor's bent local frame. */
  sphere: [number, number, number, number];
  position: Float32Array; // (ds, h, dz) grid + skirt
  normal: Int8Array; // xyz + pad
  color: Uint8Array; // sRGB rgb + snow/wet flag
  mat: Uint8Array; // grass, rock, sand, farm weights
  under: Float32Array; // water depth above ground (0 when dry)
  water: WaterData | null;
  trees: Float32Array | null; // per tree: ds, h, dz, scale, rot, type, colorVar, tilt
  genMs: number;
}

export interface WaterData {
  position: Float32Array; // (ds, W, dz)
  flow: Float32Array; // (fs, fz) m/s
  depth: Float32Array; // W - ground
  kind: Uint8Array; // river class
  index: Uint16Array | Uint32Array;
}

export interface InitMessage {
  type: 'init';
  section: number;
  seed: number;
}

export interface FarShellRequest {
  type: 'farshell';
  ns: number;
  nz: number;
}

export interface FarShellResult {
  type: 'farshell';
  ns: number;
  nz: number;
  height: Float32Array;
  color: Uint8Array;
  water: Float32Array;
}

import type { TownRequest, TownResult } from '../../towns/townBuilder';

export interface MapRequest {
  type: 'map';
  nz: number;
  ns: number;
}

export interface MapResult {
  type: 'map';
  nz: number;
  ns: number;
  /** Row-major (s rows, z columns): height, then RGBA colour. */
  height: Float32Array;
  color: Uint8Array;
  water: Uint8Array;
}

export type WorkerRequest = ChunkRequest | InitMessage | FarShellRequest | TownRequest | MapRequest;
export type WorkerResult = ChunkResult | FarShellResult | TownResult | MapResult | { type: 'ready' };

export const TREE_STRIDE = 8;
