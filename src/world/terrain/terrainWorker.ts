// Terrain worker: owns a WorldGen for the current section and builds chunks.

import { CIRC, Z_MAX, Z_MIN } from '../../config';
import { newSample, WorldGen } from '../gen/world';
import { biomeColor, buildChunk, type BiomeOut } from './chunkBuilder';
import type { ChunkResult, FarShellResult, WorkerRequest } from './chunkTypes';

let gen: WorldGen | null = null;

function transferablesOf(r: ChunkResult): Transferable[] {
  const t: Transferable[] = [r.position.buffer, r.normal.buffer, r.color.buffer, r.mat.buffer, r.under.buffer];
  if (r.water) t.push(r.water.position.buffer, r.water.flow.buffer, r.water.depth.buffer, r.water.kind.buffer, r.water.index.buffer);
  if (r.trees) t.push(r.trees.buffer);
  return t;
}

function farShell(ns: number, nz: number): FarShellResult {
  const g = gen!;
  const height = new Float32Array((ns + 1) * (nz + 1));
  const color = new Uint8Array((ns + 1) * (nz + 1) * 4);
  const water = new Float32Array((ns + 1) * (nz + 1));
  const o = newSample();
  const bo: BiomeOut = { rgb: [0, 0, 0], grass: 0, rock: 0, sand: 0, farm: 0, snow: 0 };
  const dS = CIRC / ns;
  const dZ = (Z_MAX - Z_MIN) / nz;
  const H = new Float32Array((ns + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= ns; i++) {
      const s = (i % ns) * dS;
      const z = Z_MIN + j * dZ;
      g.sample(s, z, Math.max(dS, dZ) * 2, o);
      H[j * (ns + 1) + i] = o.h;
    }
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= ns; i++) {
      const k = j * (ns + 1) + i;
      const s = (i % ns) * dS;
      const z = Z_MIN + j * dZ;
      g.sample(s, z, Math.max(dS, dZ) * 2, o);
      const il = i > 0 ? k - 1 : k;
      const ir = i < ns ? k + 1 : k;
      const jd = j > 0 ? k - (ns + 1) : k;
      const ju = j < nz ? k + (ns + 1) : k;
      const gx = (H[ir] - H[il]) / (dS * (ir - il || 1));
      const gz = (H[ju] - H[jd]) / (dZ * ((ju - jd) / (ns + 1) || 1));
      const ny = 1 / Math.sqrt(1 + gx * gx + gz * gz);
      biomeColor(o, ny, s, z, bo);
      height[k] = o.h;
      water[k] = o.water;
      color[k * 4] = bo.rgb[0];
      color[k * 4 + 1] = bo.rgb[1];
      color[k * 4 + 2] = bo.rgb[2];
      color[k * 4 + 3] = Math.round(bo.snow * 255);
    }
  return { type: 'farshell', ns, nz, height, color, water };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    gen = new WorldGen(msg.section, msg.seed);
    (self as unknown as Worker).postMessage({ type: 'ready' });
  } else if (msg.type === 'chunk') {
    const res = buildChunk(gen!, msg);
    (self as unknown as Worker).postMessage(res, transferablesOf(res));
  } else if (msg.type === 'farshell') {
    const res = farShell(msg.ns, msg.nz);
    (self as unknown as Worker).postMessage(res, [res.height.buffer, res.color.buffer, res.water.buffer]);
  }
};
