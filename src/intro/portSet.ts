// Shot 2b: Spaceport 4 of 9 on the rocky, non-rotating outer shell. A real-scale
// patch of the 96 km shell cylinder (the camera flies along the strand's axis,
// so the ground runs straight to the horizon ahead and falls away to the
// sides), an approach trench cut down into the shell, the hangar mouth with
// docking lights, and the rest of the strand arching across the black sky.

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Uint32BufferAttribute,
  Vector3,
} from 'three';
import {
  IntroSet,
  LightSpec,
  ViewInfo,
  clamp01,
  disposeTree,
  fitFov,
  lerp,
  makeLights,
  makeStarfield,
  smoothstep,
  tickLights,
} from './common';
import { F_POST, F_PRE, NOISE, PULSE, V_POST, V_PRE } from './glsl';
import { makeShellMaterial, skyFrag } from './spaceSet';

const RS = 96_000; // outer shell radius (m)
/** Trench and hangar layout (m). The trench runs from z = 0 down to the mouth at z = -LEN. */
const TR = { len: 1400, top: 150, floor: 100, depth: 200, mouthHalf: 82, mouthTop: -112, hangarEnd: -2300 };
const MOUTH = new Vector3(0, -156, -TR.len);
const MASTS: [number, number][] = [[-320, -900], [330, -1250], [-300, -200], [310, 300]];

export const PORT = {
  /** Shot length (s); the camera enters the hangar mouth at the end. */
  duration: 7.6,
};

const trenchDepth = (z: number) => TR.depth * clamp01(-z / TR.len);

const structVert = /* glsl */ `
${V_PRE}
attribute float aKind;
varying vec3 vW;
varying vec3 vN;
varying float vKind;
void main() {
  vKind = aKind;
  vN = normal;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  ${V_POST}
}
`;
const structFrag = /* glsl */ `
${F_PRE}
${NOISE}
${PULSE}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
varying float vKind;
void main() {
  vec3 N = normalize(vN);
  vec2 uv = abs(N.y) > 0.6 ? vW.xz : (abs(N.x) > 0.6 ? vW.zy : vW.xy);
  vec2 fw = fwidth(uv) + 1e-4;
  // world-space derivatives for the per-kind details, taken outside those branches
  float fxW = fwidth(vW.x) + 1e-4;
  float fyW = fwidth(vW.y) + 1e-4;
  // large cast panels with fine seams and vertical weathering
  float seams = max(hr_bar(uv.x / 48.0, 0.01, fw.x / 48.0), hr_bar(uv.y / 24.0, 0.018, fw.y / 24.0));
  float grime = hr_vn2(uv / 57.0, 0.0).x * 0.6 + hr_vn2(uv / 9.0, 0.0).x * 0.4;
  float streak = hr_vn2(vec2(uv.x / 6.0, uv.y / 90.0), 0.0).x;
  float wall = 1.0 - abs(N.y);
  vec3 alb = vec3(0.14, 0.14, 0.15) * (0.7 + 0.45 * grime) * (1.0 + 0.22 * (streak - 0.5) * wall) * (1.0 - 0.4 * seams);
  // sunlight gets into the open trench only through its opening
  float vis = 1.0;
  if (vW.y < -0.5) {
    float t = -vW.y / max(uSunDir.y, 0.02);
    vec3 e = vW + uSunDir * t;
    vis = step(abs(e.x), ${TR.top.toFixed(1)}) * step(e.z, 0.0) * step(${(-TR.len).toFixed(1)}, e.z);
    if (vW.z < ${(-TR.len - 0.5).toFixed(1)}) vis = 0.0;
  }
  vec3 col = alb * uSunColor * max(dot(N, uSunDir), 0.0) * vis;
  col += alb * vec3(0.01, 0.011, 0.014);
  // warm spill from the hangar mouth
  vec3 m = vec3(0.0, -150.0, ${(-TR.len + 30).toFixed(1)});
  vec3 dm = m - vW;
  float dl = length(dm);
  col += alb * vec3(1.0, 0.7, 0.4) * 1.6 * exp(-dl / 260.0) * max(dot(N, dm / dl), 0.0);
  if (vKind < 0.5) {
    // trench floor: faint painted edge lines
    float edge = hr_box(abs(vW.x), 86.0, 87.2, fw.x);
    col += vec3(0.9, 0.7, 0.35) * 0.05 * edge;
  } else if (vKind < 2.5 && vKind > 1.5) {
    // end wall: a lit frame around the mouth
    float fx = fxW;
    float fy = fyW;
    float dx = max(abs(vW.x) - ${TR.mouthHalf.toFixed(1)}, 0.0);
    float dy = max(vW.y - ${TR.mouthTop.toFixed(1)}, 0.0);
    float dd = length(vec2(dx, dy));
    float band = hr_box(dd, 0.0, 3.0, max(fx, fy)) * (0.55 + 0.45 * hr_pulse((vW.x + vW.y) / 12.0, 0.7, max(fx, fy) / 12.0));
    col += vec3(0.7, 0.85, 1.0) * (2.2 * band + 0.5 * exp(-dd / 9.0));
  } else if (vKind > 2.5) {
    // hangar: dark bay lit by ceiling strips, warm haze deepening with distance
    float bay = hr_pulse(vW.z / 40.0, 0.7, fw.y / 40.0);
    float ax = abs(vW.x);
    float strip = hr_box(ax, 20.0, 23.0, fw.x) + hr_box(ax, 52.0, 55.0, fw.x);
    vec3 warm = vec3(1.0, 0.76, 0.46);
    if (N.y < -0.5) col += warm * 7.0 * bay * strip;
    float pool = exp(-pow(min(abs(ax - 21.5), abs(ax - 53.5)) / 14.0, 2.0));
    float ribs = hr_bar(vW.z / 40.0 + 0.5, 0.05, fw.y / 40.0);
    vec3 inner = alb * 0.6 * (1.0 - 0.5 * ribs);
    col = inner * warm * (0.12 + (N.y > 0.5 ? 0.9 * pool : 0.35 * smoothstep(-200.0, -112.0, vW.y)));
    if (vKind > 3.5) {
      // bay doors to the transfer tracks: a lit outline and amber beacons
      float fx = fxW;
      float fy = fyW;
      float door = max(hr_box(ax, 38.0, 39.0, fx) * step(vW.y, -140.0), hr_box(vW.y, -141.0, -140.0, fy) * step(ax, 39.0));
      col += warm * 3.0 * door;
    }
    float d = length(vW - cameraPosition);
    col = mix(col, vec3(0.2, 0.13, 0.07), 1.0 - exp(-d / 1400.0));
  }
  gl_FragColor = vec4(col, 1.0);
  ${F_POST}
}
`;

const sunVert = /* glsl */ `
${V_PRE}
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${V_POST}
}
`;
/** The star seen from the shell: limb-darkened disk plus a corona. */
const sunFrag = /* glsl */ `
${F_PRE}
${NOISE}
uniform float uScale;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uScale;
  float r = length(p);
  vec3 col;
  if (r < 1.0) {
    float mu = sqrt(1.0 - r * r);
    col = mix(vec3(1.0, 0.6, 0.32), vec3(1.0, 0.95, 0.86), smoothstep(0.0, 0.55, pow(mu, 0.45))) * (0.4 + 0.6 * pow(mu, 0.45)) * 16.0;
  } else {
    float a = atan(p.y, p.x) / 6.2831853 + 0.5;
    float s1 = hr_vn2(vec2(r * 0.55 - uTime * 0.02, a * 14.0), 14.0).x;
    float I = exp(-(r - 1.0) * 3.2) * mix(0.6, 1.4, s1) * 2.0 + 0.35 / (1.0 + pow(r * 0.6, 2.4));
    I *= 1.0 - smoothstep(0.6 * uScale, uScale, r);
    col = vec3(1.0, 0.9, 0.74) * I;
  }
  gl_FragColor = vec4(col, 1.0);
  ${F_POST}
}
`;

const lineVert = /* glsl */ `
${V_PRE}
attribute float aLit;
varying float vLit;
void main() {
  vLit = aLit;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${V_POST}
}
`;
const lineFrag = /* glsl */ `
${F_PRE}
uniform vec3 uColor;
varying float vLit;
void main() {
  gl_FragColor = vec4(uColor * vLit, 1.0);
  ${F_POST}
}
`;

export class PortSet implements IntroSet {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(46, 16 / 9, 1, 2e6);
  private shellMat: ShaderMaterial;
  private structMat: ShaderMaterial;
  private sky: Mesh;
  private stars: Points;
  private sun: Mesh;
  private strand: LineSegments | null = null;
  private lights: Points;
  private sunDir = new Vector3(0.4, 0.2, -0.9).normalize();
  private look = new Vector3();

  constructor() {
    this.scene.background = new Color(0, 0, 0);
    const band = new Vector3(0.35, 0.8, -0.48).normalize();
    this.sky = new Mesh(
      new SphereGeometry(90000, 48, 24),
      new ShaderMaterial({
        vertexShader: /* glsl */ `
          ${V_PRE}
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            ${V_POST}
          }`,
        fragmentShader: skyFrag,
        uniforms: {
          uBand: { value: band },
          uCore: { value: new Vector3(-0.8, 0.1, -0.6).normalize() },
          uI: { value: 0.015 },
        },
        side: BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.stars = makeStarfield(7000, 80000, 11, band);
    (this.stars.material as ShaderMaterial).uniforms.uGain.value = 0.55;
    this.scene.add(this.stars);

    this.sun = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
        vertexShader: sunVert,
        fragmentShader: sunFrag,
        uniforms: { uScale: { value: 14 }, uTime: { value: 0 } },
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.sun.renderOrder = -8;
    this.sun.frustumCulled = false;
    this.scene.add(this.sun);

    this.shellMat = makeShellMaterial({
      uPoint: { value: 0 },
      uKmPerUnit: { value: 0.001 },
      uCircKm: { value: 0 },
      uRim: { value: 0 },
      uAmbient: { value: new Color(0.006, 0.0065, 0.008) },
      uHole: { value: [-TR.len / 1000, 0, TR.top / 1000, 1] },
      uApron: { value: [-1.5, 0.2, 0.22, 0.3] },
    });
    this.shellMat.uniforms.uSun.value = this.sunDir;
    const shell = new Mesh(this.buildShell(), this.shellMat);
    shell.frustumCulled = false;
    this.scene.add(shell);

    this.structMat = new ShaderMaterial({
      vertexShader: structVert,
      fragmentShader: structFrag,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uSunColor: this.shellMat.uniforms.uSunColor,
        uTime: { value: 0 },
      },
    });
    const struct = new Mesh(this.buildStructure(), this.structMat);
    struct.frustumCulled = false;
    this.scene.add(struct);
    // lattice masts beside the trench (their red lights are in lightSpecs)
    for (const [x, z] of MASTS) {
      const mast = new Mesh(new BoxGeometry(2.4, 140, 2.4), this.structMat);
      mast.geometry.setAttribute('aKind', new Float32BufferAttribute(new Float32Array(24).fill(1), 1));
      mast.position.set(x, 70, z);
      this.scene.add(mast);
    }

    this.lights = makeLights(this.lightSpecs());
    this.scene.add(this.lights);
  }

  /** Sun direction (world) chosen to match the end of the space shot. */
  setSun(dir: Vector3, angularRadius: number) {
    this.sunDir.copy(dir).normalize();
    const d = 60000;
    const u = this.sun.material as ShaderMaterial;
    const scale = u.uniforms.uScale.value as number;
    this.sun.scale.setScalar(Math.tan(angularRadius) * d * scale);
    this.sun.userData.dist = d;
  }

  /** The rest of the strand seen from the port: directions (world) with a lit factor. */
  setStrand(pts: { dir: Vector3; lit: number }[]) {
    const pos = new Float32Array(pts.length * 3);
    const lit = new Float32Array(pts.length);
    pts.forEach((p, i) => {
      pos[i * 3] = p.dir.x * 70000;
      pos[i * 3 + 1] = p.dir.y * 70000;
      pos[i * 3 + 2] = p.dir.z * 70000;
      lit[i] = p.lit;
    });
    // break the polyline where consecutive samples jump (gaps near the port)
    const idx: number[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      if (pts[i].dir.distanceTo(pts[i + 1].dir) < 0.05) idx.push(i, i + 1);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aLit', new Float32BufferAttribute(lit, 1));
    geo.setIndex(idx);
    const mat = new ShaderMaterial({
      vertexShader: lineVert,
      fragmentShader: lineFrag,
      uniforms: { uColor: { value: new Color(1.0, 0.93, 0.82).multiplyScalar(0.7) } },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    if (this.strand) {
      this.scene.remove(this.strand);
      this.strand.geometry.dispose();
      (this.strand.material as ShaderMaterial).dispose();
    }
    this.strand = new LineSegments(geo, mat);
    this.strand.renderOrder = -7;
    this.strand.frustumCulled = false;
    this.scene.add(this.strand);
  }

  private buildShell() {
    const NA = 360;
    const A = 0.5;
    const zs: number[] = [];
    for (let i = 0; i <= 60; i++) {
      const x = i / 60;
      zs.push(40000 - 840000 * Math.pow(x, 3));
    }
    const nz = zs.length;
    const pos = new Float32Array((NA + 1) * nz * 3);
    const nor = new Float32Array(pos.length);
    const tan = new Float32Array(pos.length);
    const surf = new Float32Array((NA + 1) * nz * 2);
    for (let i = 0; i < nz; i++) {
      for (let j = 0; j <= NA; j++) {
        const th = ((j / NA) * 2 - 1) * A;
        const k = i * (NA + 1) + j;
        pos[k * 3] = RS * Math.sin(th);
        pos[k * 3 + 1] = RS * Math.cos(th) - RS;
        pos[k * 3 + 2] = zs[i];
        nor[k * 3] = Math.sin(th);
        nor[k * 3 + 1] = Math.cos(th);
        tan[k * 3 + 2] = 1;
        surf[k * 2] = zs[i];
        surf[k * 2 + 1] = RS * th;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < nz - 1; i++) {
      for (let j = 0; j < NA; j++) {
        const a = i * (NA + 1) + j;
        const c = a + NA + 1;
        idx.push(a, a + 1, c, c, a + 1, c + 1);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geo.setAttribute('aTan', new Float32BufferAttribute(tan, 3));
    geo.setAttribute('aSurf', new Float32BufferAttribute(surf, 2));
    geo.setIndex(new Uint32BufferAttribute(new Uint32Array(idx), 1));
    return geo;
  }

  /** Trench floor and walls, the end wall with the mouth, and the hangar box. */
  private buildStructure() {
    const pos: number[] = [];
    const nor: number[] = [];
    const kind: number[] = [];
    const idx: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[], k: number) => {
      const e1 = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const e2 = new Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
      const n = e1.cross(e2).normalize();
      const base = pos.length / 3;
      for (const v of [a, b, c, d]) {
        pos.push(v[0], v[1], v[2]);
        nor.push(n.x, n.y, n.z);
        kind.push(k);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const steps = 28;
    for (let i = 0; i < steps; i++) {
      const z0 = -(i / steps) * TR.len;
      const z1 = -((i + 1) / steps) * TR.len;
      const d0 = -trenchDepth(z0);
      const d1 = -trenchDepth(z1);
      // floor (normal up)
      quad([-TR.floor, d0, z0], [TR.floor, d0, z0], [TR.floor, d1, z1], [-TR.floor, d1, z1], 0);
      // left wall (faces +x), right wall (faces -x)
      quad([-TR.top, 0, z0], [-TR.floor, d0, z0], [-TR.floor, d1, z1], [-TR.top, 0, z1], 1);
      quad([TR.floor, d0, z0], [TR.top, 0, z0], [TR.top, 0, z1], [TR.floor, d1, z1], 1);
    }
    // end wall around the mouth (faces +z)
    const z = -TR.len;
    const yb = -TR.depth;
    const mh = TR.mouthHalf;
    const mt = TR.mouthTop;
    quad([-TR.floor, yb, z], [-mh, yb, z], [-mh, 0, z], [-TR.top, 0, z], 2);
    quad([mh, yb, z], [TR.floor, yb, z], [TR.top, 0, z], [mh, 0, z], 2);
    quad([-mh, mt, z], [mh, mt, z], [mh, 0, z], [-mh, 0, z], 2);
    // hangar interior (normals face inward)
    const he = TR.hangarEnd;
    quad([-mh, yb, z], [mh, yb, z], [mh, yb, he], [-mh, yb, he], 3); // floor (up)
    quad([-mh, mt, z], [-mh, mt, he], [mh, mt, he], [mh, mt, z], 3); // ceiling (down)
    quad([-mh, yb, z], [-mh, yb, he], [-mh, mt, he], [-mh, mt, z], 3); // left (+x)
    quad([mh, yb, he], [mh, yb, z], [mh, mt, z], [mh, mt, he], 3); // right (-x)
    quad([-mh, yb, he], [mh, yb, he], [mh, mt, he], [-mh, mt, he], 4); // back (+z)
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geo.setAttribute('aKind', new Float32BufferAttribute(kind, 1));
    geo.setIndex(idx);
    return geo;
  }

  private lightSpecs(): LightSpec[] {
    const L: LightSpec[] = [];
    const warm: [number, number, number] = [9, 7, 4.5];
    // trench rim lights
    for (let z = 0; z >= -TR.len; z -= 70) {
      L.push({ p: [-TR.top - 2, 1, z], c: [3.5, 3.7, 4], size: 3 });
      L.push({ p: [TR.top + 2, 1, z], c: [3.5, 3.7, 4], size: 3 });
    }
    // floor edge lights
    for (let z = -20; z >= -TR.len; z -= 40) {
      const y = -trenchDepth(z) + 0.6;
      L.push({ p: [-TR.floor + 6, y, z], c: [5, 6, 8], size: 2.2 });
      L.push({ p: [TR.floor - 6, y, z], c: [5, 6, 8], size: 2.2 });
    }
    // "rabbit": a pulse running toward the mouth along the centre line
    let k = 0;
    for (let z = 2400; z >= -TR.len + 20; z -= 60, k++) {
      const y = z > 0 ? 0.8 : -trenchDepth(z) + 0.8;
      L.push({ p: [0, y, z], c: [14, 12, 9], size: 4, blink: [1.6, -k * 0.028, 0.06, 0] });
    }
    // approach markers on the surface
    for (let z = 3200; z >= 0; z -= 160) {
      L.push({ p: [-230, 1, z], c: [1.5, 7, 3], size: 4 });
      L.push({ p: [230, 1, z], c: [1.5, 7, 3], size: 4 });
    }
    // threshold lights across the mouth floor
    for (let x = -TR.mouthHalf + 6; x <= TR.mouthHalf - 6; x += 12) {
      L.push({ p: [x, -TR.depth + 1, -TR.len + 4], c: warm, size: 2.4 });
    }
    // corner beacons and obstruction lights
    L.push({ p: [-TR.mouthHalf - 6, TR.mouthTop + 6, -TR.len + 3], c: [16, 8, 1.5], size: 7, blink: [1.2, 0, 0.35, 0.05] });
    L.push({ p: [TR.mouthHalf + 6, TR.mouthTop + 6, -TR.len + 3], c: [16, 8, 1.5], size: 7, blink: [1.2, 0.5, 0.35, 0.05] });
    for (const x of [-TR.top, TR.top]) {
      L.push({ p: [x, 3, -TR.len], c: [18, 1.8, 1], size: 8, blink: [2.0, x > 0 ? 0.5 : 0, 0.4, 0.05] });
      L.push({ p: [x, 3, 0], c: [18, 1.8, 1], size: 8, blink: [2.0, x > 0 ? 0 : 0.5, 0.4, 0.05] });
    }
    // masts beside the trench
    for (const [x, z] of MASTS) {
      L.push({ p: [x, 140, z], c: [20, 2, 1], size: 6, blink: [2.4, (x + z) * 0.001, 0.3, 0.02] });
      L.push({ p: [x, 1, z], c: [4, 4.2, 5], size: 3 });
    }
    // hangar interior rows
    for (let z = -TR.len - 30; z >= TR.hangarEnd + 20; z -= 40) {
      for (const x of [-60, -30, 30, 60]) L.push({ p: [x, TR.mouthTop - 1.5, z], c: [5, 3.9, 2.5], size: 1.4 });
    }
    return L;
  }

  /** Camera flight: over the shell, down into the trench and into the mouth. */
  pose(t: number, pos: Vector3, look: Vector3) {
    const x = clamp01(t / PORT.duration);
    const f = x * (1.3 - 0.3 * x);
    const z = lerp(3400, -1700, f);
    let y: number;
    if (z > 0) y = 40 + 920 * Math.pow(smoothstep(0, 3400, z), 0.6);
    else y = lerp(40, MOUTH.y, smoothstep(0, -TR.len, z));
    pos.set(Math.sin(t * 0.35) * 6, y, z);
    // look at the mouth, then straight down the hangar once inside
    const inside = smoothstep(-TR.len + 350, -TR.len - 50, z);
    look.copy(MOUTH).lerp(new Vector3(0, MOUTH.y, z - 400), inside);
    look.y += 25 * (1 - inside);
  }

  update(t: number, view: ViewInfo) {
    const cam = this.camera;
    fitFov(cam, 46, view.aspect, 64);
    this.pose(t, cam.position, this.look);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    cam.near = 1;
    cam.far = 2e6;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.sky.position.copy(cam.position);
    this.stars.position.copy(cam.position);
    const su = (this.stars.material as ShaderMaterial).uniforms;
    su.uPx.value = view.pxRatio;
    su.uTime.value = view.time;
    const d = (this.sun.userData.dist as number) ?? 60000;
    this.sun.position.copy(cam.position).addScaledVector(this.sunDir, d);
    this.sun.quaternion.copy(cam.quaternion);
    (this.sun.material as ShaderMaterial).uniforms.uTime.value = view.time;
    if (this.strand) this.strand.position.copy(cam.position);
    this.structMat.uniforms.uTime.value = view.time;
    tickLights(this.lights, cam, view, view.time);
  }

  dispose() {
    disposeTree(this.scene);
  }
}
