// Life under the surface: drifting motes that give the water depth and motion,
// and small schools of silver fish that circle nearby and scatter when you
// swim at them. Everything lives in render-frame metres around the camera and
// only exists while the camera is under water.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { Rng } from '../core/rng';
import { patchWorldMaterial } from '../render/bend';
import { U } from '../render/uniforms';

const MOTES = 700;
const BOX = 14;
const SCHOOLS = 4;
const PER_SCHOOL = 14;

const moteVertex = /* glsl */ `
uniform vec3 uCam;
uniform float uTime;
uniform float uBox;
uniform vec3 uDrift;
attribute float aSeed;
varying float vA;
void main() {
  // wrap each mote into a box centred on the camera, drifting with the current
  vec3 p = position + uDrift + vec3(sin(uTime * 0.3 + aSeed * 6.0), sin(uTime * 0.23 + aSeed * 9.0), cos(uTime * 0.27 + aSeed * 4.0)) * 0.3;
  p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  gl_PointSize = clamp(90.0 / max(d, 0.3), 1.0, 7.0);
  vA = (1.0 - smoothstep(uBox * 0.25, uBox * 0.5, length(p - uCam))) * (0.35 + 0.65 * fract(aSeed * 13.7));
}
`;

const moteFragment = /* glsl */ `
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = 1.0 - smoothstep(0.2, 0.5, length(c));
  gl_FragColor = vec4(vec3(0.55, 0.8, 0.72) * 0.7 * r * vA, 1.0);
}
`;

function fishGeometry(): BufferGeometry {
  // a slim diamond body with a forked tail, nose toward -z
  const L = 0.42;
  const P = (x: number, y: number, z: number) => [x, y, z];
  const nose = P(0, 0, -L * 0.5);
  const top = P(0, 0.075, -L * 0.05);
  const bot = P(0, -0.065, -L * 0.05);
  const left = P(-0.035, 0, -L * 0.08);
  const right = P(0.035, 0, -L * 0.08);
  const tail = P(0, 0, L * 0.3);
  const t1 = P(0, 0.08, L * 0.5);
  const t2 = P(0, -0.08, L * 0.5);
  const tris = [
    nose, left, top, nose, top, right, nose, bot, left, nose, right, bot,
    top, left, tail, right, top, tail, left, bot, tail, bot, right, tail,
    tail, t1, t2, tail, t2, t1,
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(tris.flat()), 3));
  g.computeVertexNormals();
  return g;
}

interface School {
  cx: number;
  cy: number;
  cz: number;
  r: number;
  ang: number;
  speed: number;
  dir: number;
  scatter: number;
  sx: number;
  sz: number;
}

export class UnderwaterLife {
  readonly group = new Group();
  private motes: Points;
  private moteMat: ShaderMaterial;
  private fish: InstancedMesh;
  private schools: School[] = [];
  private offsets: Vector3[] = [];
  private rng = new Rng(0xf15);
  private wasUnder = false;
  private drift = new Vector3();

  constructor() {
    const pos = new Float32Array(MOTES * 3);
    const seed = new Float32Array(MOTES);
    for (let i = 0; i < MOTES; i++) {
      pos[i * 3] = (this.rng.next() - 0.5) * BOX;
      pos[i * 3 + 1] = (this.rng.next() - 0.5) * BOX;
      pos[i * 3 + 2] = (this.rng.next() - 0.5) * BOX;
      seed[i] = this.rng.next();
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new BufferAttribute(seed, 1));
    this.moteMat = new ShaderMaterial({
      vertexShader: moteVertex,
      fragmentShader: moteFragment,
      uniforms: { uCam: { value: new Vector3() }, uTime: U.uTime, uBox: { value: BOX }, uDrift: { value: this.drift } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.motes = new Points(g, this.moteMat);
    this.motes.frustumCulled = false;
    this.group.add(this.motes);
    const mat = patchWorldMaterial(new MeshLambertMaterial({ color: 0xd0dade, emissive: 0x3a5054 }), { key: 'fish', bend: false });
    this.fish = new InstancedMesh(fishGeometry(), mat, SCHOOLS * PER_SCHOOL);
    this.fish.frustumCulled = false;
    this.group.add(this.fish);
    for (let i = 0; i < SCHOOLS * PER_SCHOOL; i++) {
      this.offsets.push(new Vector3((this.rng.next() - 0.5) * 1.6, (this.rng.next() - 0.5) * 0.7, (this.rng.next() - 0.5) * 1.6));
    }
    this.group.visible = false;
  }

  /**
   * cam: camera position (render frame); floorY / surfaceY bound the water
   * column under the camera; flow is the current (m/s) in render-frame x/z.
   */
  update(dt: number, cam: Vector3, under: boolean, floorY: number, surfaceY: number, flowX: number, flowZ: number) {
    this.group.visible = under;
    if (!under) {
      this.wasUnder = false;
      return;
    }
    (this.moteMat.uniforms.uCam.value as Vector3).copy(cam);
    this.drift.x += flowX * dt;
    this.drift.z += flowZ * dt;
    if (!this.wasUnder) {
      // new dive: place schools around the swimmer
      this.wasUnder = true;
      this.schools = [];
      for (let k = 0; k < SCHOOLS; k++) {
        const a = this.rng.range(0, Math.PI * 2);
        const d = this.rng.range(3, 8);
        this.schools.push({
          cx: cam.x + Math.sin(a) * d,
          cy: 0,
          cz: cam.z + Math.cos(a) * d,
          r: this.rng.range(1.5, 4),
          ang: this.rng.range(0, Math.PI * 2),
          speed: this.rng.range(0.5, 1.1),
          dir: this.rng.sign(),
          scatter: 0,
          sx: 0,
          sz: 0,
        });
      }
    }
    let n = 0;
    const depth = Math.max(0.6, surfaceY - floorY);
    for (const sc of this.schools) {
      // keep schools within reach of the swimmer
      const dx = sc.cx - cam.x;
      const dz = sc.cz - cam.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 26) {
        const a = Math.atan2(dx, dz) + Math.PI + this.rng.range(-0.8, 0.8);
        sc.cx = cam.x + Math.sin(a) * 12;
        sc.cz = cam.z + Math.cos(a) * 12;
      }
      sc.cy = floorY + Math.min(depth * 0.45, 1.6) + 0.4;
      sc.ang += (sc.speed / sc.r) * sc.dir * dt * (1 + sc.scatter * 3);
      // scatter away from a swimmer who comes too close
      const fx = sc.cx + Math.sin(sc.ang) * sc.r;
      const fz = sc.cz + Math.cos(sc.ang) * sc.r;
      const pd = Math.hypot(fx - cam.x, fz - cam.z, sc.cy - cam.y);
      if (pd < 2.2) {
        sc.scatter = 1;
        sc.sx = (fx - cam.x) / Math.max(pd, 0.1);
        sc.sz = (fz - cam.z) / Math.max(pd, 0.1);
      }
      sc.cx += sc.sx * sc.scatter * 4 * dt;
      sc.cz += sc.sz * sc.scatter * 4 * dt;
      sc.scatter = Math.max(0, sc.scatter - dt * 0.6);
      const heading = sc.ang + (sc.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      for (let i = 0; i < PER_SCHOOL; i++, n++) {
        const o = this.offsets[n];
        const wig = Math.sin(U.uTime.value * 9 + n * 1.7) * 0.18;
        _q.setFromAxisAngle(_up, heading + Math.PI + wig);
        _p.set(fx + o.x, Math.min(sc.cy + o.y, surfaceY - 0.3), fz + o.z);
        _m.compose(_p, _q, _s.setScalar(0.8 + 0.4 * ((n * 0.618) % 1)));
        this.fish.setMatrixAt(n, _m);
      }
    }
    this.fish.count = n;
    this.fish.instanceMatrix.needsUpdate = true;
  }
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _up = new Vector3(0, 1, 0);
