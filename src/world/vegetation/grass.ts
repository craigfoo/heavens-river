// GPU grass around the camera. Tufts live on a world-anchored grid of cells
// that wraps toroidally around the camera, so blades stay put in the world as
// you walk. Heights/colours come from a small heightmap texture copied out of
// the finest terrain chunks, so every blade sits exactly on the rendered ground.

import {
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  InstancedMesh,
  MeshLambertMaterial,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector4,
  Group,
} from 'three';
import { CHUNK_N, CIRC, MAX_LEVEL, ROOT_TILE_S, ROOT_TILE_Z, Z_MIN } from '../../config';
import { frame, wrapS } from '../../coords/cylinder';
import { mod } from '../../core/math';
import { patchWorldMaterial } from '../../render/bend';

const DS = ROOT_TILE_S / (1 << MAX_LEVEL) / CHUNK_N;
const DZ = ROOT_TILE_Z / (1 << MAX_LEVEL) / CHUNK_N;
const TEX = 112; // heightmap texels per side (~121 m)
const NS_CELLS = Math.round(CIRC / DS);

export interface FineChunkSource {
  /** Vertex data of a ready finest-level chunk, or null. */
  fineChunk(is: number, iz: number): { pos: ArrayLike<number>; color: ArrayLike<number>; mat: ArrayLike<number> } | null;
}

const grassPars = /* glsl */ `
uniform sampler2D uGrassH;
uniform sampler2D uGrassC;
uniform vec4 uGrassTex;   // (texel size s, texel size z, texels, unused)
uniform vec2 uGrassCam;   // camera (ds, dz) relative to the grass anchor
uniform vec4 uGrassGrid;  // (cell size s, cell size z, grid count, unused)
uniform vec2 uGrassOff;   // anchor offset in cells (mod 8192) for stable hashing
uniform float uGrassFar;  // fade distance
attribute float aBlade;   // 0 at root, 1 at tip
varying float vGrassTip;
varying vec3 vGrassCol;
varying float vGrassFade;
float gHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// manual bilinear (float textures are not always filterable)
vec4 gFetch(sampler2D t, vec2 texel) {
  float n = uGrassTex.z;
  vec2 f = fract(texel);
  ivec2 i0 = ivec2(clamp(floor(texel), vec2(0.0), vec2(n - 1.0)));
  ivec2 i1 = ivec2(clamp(floor(texel) + 1.0, vec2(0.0), vec2(n - 1.0)));
  vec4 a = texelFetch(t, i0, 0);
  vec4 b = texelFetch(t, ivec2(i1.x, i0.y), 0);
  vec4 c = texelFetch(t, ivec2(i0.x, i1.y), 0);
  vec4 d = texelFetch(t, i1, 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

const grassBegin = /* glsl */ `
{
  float G = uGrassGrid.z;
  vec2 c = uGrassGrid.xy;
  float id = float(gl_InstanceID);
  vec2 cellI = vec2(mod(id, G), floor(id / G));
  vec2 cc = floor(uGrassCam / c);
  vec2 d = mod(cellI - cc + G * 0.5, G) - G * 0.5;
  vec2 cell = cc + d;
  vec2 wcell = mod(cell + uGrassOff, 8192.0);
  float h1 = gHash(wcell);
  float h2 = gHash(wcell + 17.3);
  float h3 = gHash(wcell + 41.1);
  vec2 local = (cell + vec2(h1, h2)) * c;
  vec2 texel = local / uGrassTex.xy;
  vec4 hC = gFetch(uGrassC, texel);
  float gh = gFetch(uGrassH, texel).r;
  float dist = length(local - uGrassCam);
  float dens = hC.a;
  float inside = step(0.0, texel.x) * step(texel.x, uGrassTex.z - 1.0) * step(0.0, texel.y) * step(texel.y, uGrassTex.z - 1.0) * step(-500.0, gh);
  float fade = (1.0 - smoothstep(uGrassFar * 0.72, uGrassFar, dist)) * inside;
  float keep = step(h3, dens * 1.15);
  float sc = keep * fade * (0.45 + 0.75 * gHash(wcell + 5.7));
  float ang = h1 * 6.2831853;
  float ca = cos(ang);
  float sa = sin(ang);
  vec3 p = transformed * vec3(1.0, sc * (0.55 + dens * 0.35), 1.0);
  p.xz *= max(sc, 0.0001);
  p = vec3(ca * p.x - sa * p.z, p.y, sa * p.x + ca * p.z);
  // wind: gusts rolling across the field
  float gust = sin(dot(local, vec2(0.21, 0.13)) - uTime * 1.9) * 0.5 + 0.5;
  float w = (0.10 + 0.22 * gust) * aBlade * aBlade;
  p.x += w * (0.8 + 0.4 * sin(uTime * 3.1 + h2 * 30.0));
  p.z += w * 0.4 * cos(uTime * 2.3 + h1 * 20.0);
  transformed = vec3(local.x, gh, local.y) + p;
  vGrassTip = aBlade;
  vGrassCol = pow(hC.rgb, vec3(2.2));
  vGrassFade = fade;
}
`;

function tuftGeometry(blades: number, segs: number, height: number, width: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const bl: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.7;
    const ox = Math.cos(a) * 0.05;
    const oz = Math.sin(a) * 0.05;
    const lean = 0.18 + (b % 3) * 0.08;
    const h = height * (0.7 + ((b * 37) % 10) / 20);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const px = -dz;
    const pz = dx;
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const w0 = width * (1 - t0);
      const w1 = width * (1 - t1);
      const y0 = h * t0;
      const y1 = h * t1;
      const l0 = lean * t0 * t0 * h;
      const l1 = lean * t1 * t1 * h;
      const v = [
        [ox + dx * l0 - px * w0, y0, oz + dz * l0 - pz * w0, t0],
        [ox + dx * l0 + px * w0, y0, oz + dz * l0 + pz * w0, t0],
        [ox + dx * l1 - px * w1, y1, oz + dz * l1 - pz * w1, t1],
        [ox + dx * l1 + px * w1, y1, oz + dz * l1 + pz * w1, t1],
      ];
      const quad = s === segs - 1 ? [0, 1, 2] : [0, 1, 3, 0, 3, 2];
      if (s === segs - 1) {
        // pointed tip
        v[2] = [ox + dx * l1, y1, oz + dz * l1, t1];
      }
      for (const k of quad) {
        pos.push(v[k][0], v[k][1], v[k][2]);
        // normals mostly up so blades shade like the ground they grow from
        nrm.push(dx * 0.25, 0.95, dz * 0.25);
        bl.push(v[k][3]);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('aBlade', new Float32BufferAttribute(bl, 1));
  return g;
}

interface Layer {
  mesh: InstancedMesh;
  grid: Vector4;
  off: Vector2;
  sub: number;
  far: { value: number };
}

export class GrassField {
  readonly group = new Group();
  private hData = new Float32Array(TEX * TEX);
  private cData = new Uint8Array(TEX * TEX * 4);
  private hTex: DataTexture;
  // (filters stay NEAREST: sampling is done manually with texelFetch)
  private cTex: DataTexture;
  private layers: Layer[] = [];
  private anchorI = 0; // fine-grid index of the texture origin
  private anchorJ = 0;
  private camU = { value: new Vector2() };
  private texU = { value: new Vector4(DS, DZ, TEX, 0) };
  private dirty = true;
  private retry = 0;
  enabled = true;
  density = 1;

  constructor() {
    this.hTex = new DataTexture(this.hData, TEX, TEX, RedFormat, FloatType);
    this.cTex = new DataTexture(this.cData, TEX, TEX, RGBAFormat, UnsignedByteType);
    // cell sizes divide the terrain grid spacing so re-anchoring keeps blades still
    this.addLayer(5, 150, 32, tuftGeometry(5, 3, 0.36, 0.016));
    this.addLayer(2, 110, 55, tuftGeometry(4, 2, 0.42, 0.028));
    this.group.name = 'grass';
  }

  private addLayer(sub: number, grid: number, far: number, geo: BufferGeometry) {
    const gridV = new Vector4(DS / sub, DZ / sub, grid, 0);
    const off = new Vector2();
    const farU = { value: far };
    const mat = new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide });
    patchWorldMaterial(mat, {
      key: `grass${grid}`,
      bend: true,
      noNormalFlip: true,
      uniforms: {
        uGrassH: { value: this.hTex },
        uGrassC: { value: this.cTex },
        uGrassTex: this.texU,
        uGrassCam: this.camU,
        uGrassGrid: { value: gridV },
        uGrassOff: { value: off },
        uGrassFar: farU,
      },
      vertexPars: grassPars,
      vertexBegin: grassBegin,
      fragmentPars: `varying float vGrassTip; varying vec3 vGrassCol; varying float vGrassFade;`,
      fragmentColor: `
        {
          if (vGrassFade < 0.01) discard;
          vec3 base = vGrassCol * 0.7;
          vec3 tip = vGrassCol * vec3(1.25, 1.3, 0.9) + vec3(0.02, 0.03, 0.0);
          diffuseColor.rgb *= mix(base, tip, vGrassTip);
        }
      `,
      fragmentEnd: `
        {
          // back-lit blade tips glow when looking toward the light
          vec3 V = normalize(cameraPosition - vHrWorld);
          float back = pow(max(dot(-V, uSunDir), 0.0), 4.0);
          gl_FragColor.rgb += vGrassCol * uSunColor * back * vGrassTip * 1.6;
        }
      `,
    });
    const mesh = new InstancedMesh(geo, mat, grid * grid);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.group.add(mesh);
    this.layers.push({ mesh, grid: gridV, off, sub, far: farU });
  }

  setDensity(d: number) {
    this.density = d;
    for (const l of this.layers) l.mesh.count = Math.floor(l.grid.z * l.grid.z * d);
  }

  /** Recentre the heightmap on the camera and copy data from fine chunks. */
  update(camS: number, camZ: number, src: FineChunkSource) {
    if (!this.enabled) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const ci = Math.floor(mod(camS, CIRC) / DS);
    const cj = Math.floor((camZ - Z_MIN) / DZ);
    const wantI = ci - (TEX >> 1);
    const wantJ = cj - (TEX >> 1);
    const di = Math.abs(((wantI - this.anchorI + NS_CELLS / 2) % NS_CELLS + NS_CELLS) % NS_CELLS - NS_CELLS / 2);
    this.retry--;
    const moved = di > 10 || Math.abs(wantJ - this.anchorJ) > 10;
    if (moved || (this.dirty && this.retry <= 0)) {
      this.anchorI = wantI;
      this.anchorJ = wantJ;
      this.dirty = !this.fill(src);
      this.retry = 8;
      const s0 = this.anchorI * DS;
      const z0 = Z_MIN + this.anchorJ * DZ;
      for (const l of this.layers) {
        frame.unregister(l.mesh);
        frame.register(l.mesh, s0, z0);
        // world cell offset of the anchor for stable hashing (exact integers)
        l.off.set(mod(this.anchorI * l.sub, 8192), mod(this.anchorJ * l.sub, 8192));
      }
    }
    const s0 = this.anchorI * DS;
    const z0 = Z_MIN + this.anchorJ * DZ;
    this.camU.value.set(wrapS(camS - s0), camZ - z0);
  }

  /** Copy heights/colours of ready level-9 chunks; returns true if complete. */
  private fill(src: FineChunkSource): boolean {
    let complete = true;
    const N = CHUNK_N;
    const perRing = (1 << MAX_LEVEL) * 16;
    for (let j = 0; j < TEX; j++) {
      const gj = this.anchorJ + j;
      const cz = Math.floor(gj / N);
      const vj = gj - cz * N;
      for (let i = 0; i < TEX; i++) {
        const gi = mod(this.anchorI + i, NS_CELLS);
        const cs = Math.floor(gi / N) % perRing;
        const vi = gi - Math.floor(gi / N) * N;
        const ch = src.fineChunk(cs, cz);
        const t = j * TEX + i;
        if (!ch) {
          this.hData[t] = -1000;
          this.cData[t * 4 + 3] = 0;
          complete = false;
          continue;
        }
        const v = vj * (N + 1) + vi;
        this.hData[t] = ch.pos[v * 3 + 1];
        this.cData[t * 4] = ch.color[v * 4];
        this.cData[t * 4 + 1] = ch.color[v * 4 + 1];
        this.cData[t * 4 + 2] = ch.color[v * 4 + 2];
        // grass on grassy ground, sparse on fields (stubble) and none under water/snow
        const grass = ch.mat[v * 4] / 255;
        const farm = ch.mat[v * 4 + 3] / 255;
        const snow = ch.color[v * 4 + 3] / 255;
        this.cData[t * 4 + 3] = Math.round(Math.max(0, grass * (1 - farm * 0.55) * (1 - snow)) * 255);
      }
    }
    this.hTex.needsUpdate = true;
    this.cTex.needsUpdate = true;
    return complete;
  }

  /** Mark for refresh (e.g. when new fine chunks arrive). */
  invalidate() {
    this.dirty = true;
  }
}
