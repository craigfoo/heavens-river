// Shots 1-2a: Eta Leporis and the strand. The topopolis loops the star three
// times as a (3,8) torus knot (the image the author endorsed), drawn with
// THREE.TorusKnotGeometry and a (hugely exaggerated) tube radius: a dark,
// cratered outer shell with a lit rim on the star side, radiator fins glinting
// on the night side and the nine spaceports as faint beacons. Then the camera
// dives toward Spaceport 4, where a finely tessellated local tube takes over
// from the knot mesh so the close-up stays smooth.

import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  TorusKnotGeometry,
  Uint32BufferAttribute,
  Vector3,
  Vector4,
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
  mulberry32,
  pxScale,
  smootherstep,
  smoothstep,
  tickLights,
} from './common';
import { F_POST, F_PRE, NOISE, PULSE, SHELL, V_POST, V_PRE } from './glsl';

const KR = 100; // knot radius (scene units); the star sits at the origin
const TUBE = 0.45; // strand radius: ~1/220 of the knot radius
const SHELL_KM = 96; // outer shell radius (km); the inner cylinder is 90 km
export const KM_PER_UNIT = SHELL_KM / TUBE;
const P = 3;
const Q = 8;
const U_MAX = P * Math.PI * 2;
const STAR_R = 4.2;
/** The fine local tube covers this many radians either side of the port. */
const DETAIL_HALF_ANGLE = 1.9;
const STAR_COLOR = new Color(1.0, 0.95, 0.86); // hot F-type: white with a hint of yellow

/** Local times (s) of the shot. */
export const SPACE = {
  diveStart: 16,
  diveEnd: 23.6,
  /** Camera end pose relative to the port: height above the shell and distance behind it. */
  endHeight: 0.006,
  endBack: 0.02,
  endAhead: 0.008,
};

// ---------------------------------------------------------------------------
// Knot curve and frames, identical to THREE.TorusKnotGeometry but rotated so
// the knot's symmetry axis is world +Y (the geometry gets the same rotation).

const _p2 = new Vector3();
function knotCurve(u: number, out: Vector3) {
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const qu = (Q / P) * u;
  const cs = Math.cos(qu);
  const x = KR * (2 + cs) * 0.5 * cu;
  const y = KR * (2 + cs) * su * 0.5;
  const z = KR * Math.sin(qu) * 0.5;
  return out.set(x, z, -y);
}
function knotFrame(u: number, p: Vector3, t: Vector3, n: Vector3, b: Vector3) {
  knotCurve(u, p);
  knotCurve(u + 0.01, _p2);
  t.subVectors(_p2, p);
  n.addVectors(_p2, p);
  b.crossVectors(t, n);
  n.crossVectors(b, t);
  b.normalize();
  n.normalize();
  t.normalize();
}
/** Surface point direction for tube angle v (same convention as the three.js geometry). */
function tubeDir(v: number, n: Vector3, b: Vector3, out: Vector3) {
  return out.copy(n).multiplyScalar(-Math.cos(v)).addScaledVector(b, Math.sin(v));
}

class ArcTable {
  private s: Float64Array;
  readonly length: number;
  constructor(private n = 40000) {
    this.s = new Float64Array(n + 1);
    const a = new Vector3();
    const b = new Vector3();
    knotCurve(0, a);
    for (let i = 1; i <= n; i++) {
      knotCurve((i / n) * U_MAX, b);
      this.s[i] = this.s[i - 1] + a.distanceTo(b);
      a.copy(b);
    }
    this.length = this.s[n];
  }
  at(u: number) {
    const x = ((((u / U_MAX) % 1) + 1) % 1) * this.n;
    const i = Math.min(Math.floor(x), this.n - 1);
    return this.s[i] + (this.s[i + 1] - this.s[i]) * (x - i);
  }
  /** Arc length relative to s0, wrapped into [-L/2, L/2). */
  rel(u: number, s0: number) {
    let d = this.at(u) - s0;
    d -= Math.round(d / this.length) * this.length;
    return d;
  }
}

// ---------------------------------------------------------------------------
// Shaders

const shellVert = /* glsl */ `
${V_PRE}
attribute vec2 aSurf;
attribute vec3 aTan;
uniform float uTube;
uniform float uPxScale;
uniform float uMinPx;
varying vec3 vW;
varying vec3 vN;
varying vec3 vT;
varying vec2 vSurf;
varying float vCover;
void main() {
  vec3 p = position;
  vCover = 1.0;
  if (uTube > 0.0) {
    // never let the strand get thinner than ~uMinPx: inflate and fade instead
    vec3 c = position - normal * uTube;
    vec4 mc = modelViewMatrix * vec4(c, 1.0);
    float minR = uMinPx * uPxScale * max(-mc.z, 1e-6);
    float r = max(uTube, minR);
    vCover = uTube / r;
    p = c + normal * r;
  }
  vec4 w = modelMatrix * vec4(p, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vT = normalize(mat3(modelMatrix) * aTan);
  vSurf = aSurf;
  gl_Position = projectionMatrix * viewMatrix * w;
  ${V_POST}
}
`;

/** Shared by the knot, the local detail tube and (with a sun direction) the port close-up. */
export const shellFrag = /* glsl */ `
${F_PRE}
${NOISE}
${PULSE}
${SHELL}
uniform vec3 uSun;       // point-light position (uPoint = 1) or direction toward the sun
uniform float uPoint;
uniform vec3 uSunColor;
uniform float uFluxR2;   // distance at which the star's flux is 1 (squared)
uniform float uKmPerUnit;
uniform vec3 uAmbient;
uniform float uRim;
uniform vec4 uHole;      // (x0, x1, half width, on) km: cut-out for the port trench
uniform vec4 uApron;     // (x0, x1, half width, falloff) km: smoothed engineered ground
uniform vec4 uHide;      // coarse knot hidden where the fine tube takes over: (arc half length, centre arc, half width, circumference) around
varying vec3 vW;
varying vec3 vN;
varying vec3 vT;
varying vec2 vSurf;
varying float vCover;
void main() {
  vec2 p = vSurf * uKmPerUnit;
  // derivatives before the discards (they are undefined after divergent control flow)
  float fp = max(fwidth(p.x), fwidth(p.y));
  if (uHide.x > 0.0 && abs(vSurf.x) < uHide.x) {
    float dc = mod(vSurf.y - uHide.y + 0.5 * uHide.w, uHide.w) - 0.5 * uHide.w;
    if (abs(dc) < uHide.z) discard;
  }
  if (uHole.w > 0.0 && p.x > uHole.x && p.x < uHole.y && abs(p.y) < uHole.z) discard;
  vec3 Ng = normalize(vN);
  vec3 T = normalize(vT - Ng * dot(vT, Ng));
  vec3 B = cross(Ng, T);
  vec3 toSun = uPoint > 0.5 ? uSun - vW : uSun;
  float flux = uPoint > 0.5 ? uFluxR2 / max(dot(toSun, toSun), 1e-6) : 1.0;
  flux = pow(flux, 0.7);
  vec3 L = normalize(toSun);
  vec3 V = normalize(cameraPosition - vW);
  vec2 lt = vec2(dot(L, T), dot(L, B));
  float lh = max(length(lt), 1e-4);
  vec3 sunT = vec3(lt / lh, dot(L, Ng) / lh);
  HrShell s = hr_shell(p, fp, sunT);
  // flattened apron around the port
  float ap = 1.0;
  if (uApron.w > 0.0) {
    vec2 dd = vec2(max(max(uApron.x - p.x, p.x - uApron.y), 0.0), max(abs(p.y) - uApron.z, 0.0));
    ap = smoothstep(0.0, uApron.w, length(dd));
  }
  vec2 g = s.g * ap;
  vec3 N = normalize(Ng - T * g.x - B * g.y);
  float lit = hr_regolith(N, L, V) * mix(1.0, s.sh, ap) * smoothstep(-0.02, 0.05, dot(Ng, L));
  vec3 rock = vec3(0.13, 0.122, 0.112) * max(s.alb, 0.25);
  // the apron: dusty cast slabs with painted guide lines
  vec3 slab = vec3(0.125, 0.122, 0.118) * (0.8 + 0.4 * hr_h21(floor(p / 0.06))) * (0.85 + 0.3 * hr_vn2(p / 0.4, 0.0).x);
  slab *= 1.0 - 0.15 * max(hr_bar(p.x / 0.06, 0.02, fp / 0.06), hr_bar(p.y / 0.06, 0.02, fp / 0.06));
  slab = mix(slab, rock, 0.5);
  float guide = hr_box(abs(p.y), 0.105, 0.108, fp);
  slab += vec3(0.5, 0.42, 0.25) * 0.1 * guide * step(0.0, p.x);
  vec3 alb = mix(slab, rock, ap);
  vec3 col = alb * uSunColor * lit * flux;
  col += alb * uAmbient;
  // thin lit rim on the star side
  float nv = clamp(dot(Ng, V), 0.0, 1.0); // pow() of a negative base is NaN on Direct3D
  float far = smoothstep(1.5, 14.0, length(cameraPosition - vW));
  col += uSunColor * flux * uRim * far * pow(1.0 - nv, 6.0) * smoothstep(-0.12, 0.3, dot(Ng, L));
  gl_FragColor = vec4(col, vCover);
  ${F_POST}
}
`;

export function makeShellMaterial(extra: Record<string, { value: unknown }> = {}) {
  return new ShaderMaterial({
    vertexShader: shellVert,
    fragmentShader: shellFrag,
    uniforms: {
      uTube: { value: 0 },
      uPxScale: { value: 0.001 },
      uMinPx: { value: 1.25 },
      uSun: { value: new Vector3() },
      uPoint: { value: 1 },
      uSunColor: { value: STAR_COLOR.clone().multiplyScalar(2.4) },
      uFluxR2: { value: KR * KR },
      uKmPerUnit: { value: KM_PER_UNIT },
      uCircKm: { value: 2 * Math.PI * SHELL_KM },
      uAmbient: { value: new Color(0.004, 0.0045, 0.006) },
      uRim: { value: 1.2 },
      uHole: { value: [0, 0, 0, 0] },
      uApron: { value: [0, 0, 0, 0] },
      uHide: { value: new Vector4() },
      ...extra,
    },
  });
}

const starVert = /* glsl */ `
${V_PRE}
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vP = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  ${V_POST}
}
`;
const starFrag = /* glsl */ `
${F_PRE}
${NOISE}
uniform float uTime;
uniform vec3 uColor;
uniform float uI;
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;
void main() {
  float mu = max(dot(normalize(vN), normalize(cameraPosition - vW)), 0.0);
  float limb = pow(mu, 0.45);
  float g = hr_vn3(vP * 2.4 + vec3(0.0, uTime * 0.04, 0.0)) * 0.55 + hr_vn3(vP * 7.0 - vec3(uTime * 0.06)) * 0.45;
  vec3 c = mix(vec3(1.0, 0.6, 0.32), uColor, smoothstep(0.0, 0.55, limb));
  c *= (0.4 + 0.6 * limb) * (0.88 + 0.24 * g);
  gl_FragColor = vec4(c * uI, 1.0);
  ${F_POST}
}
`;

const coronaVert = /* glsl */ `
${V_PRE}
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${V_POST}
}
`;
const coronaFrag = /* glsl */ `
${F_PRE}
${NOISE}
uniform float uScale; // quad half-size in star radii
uniform float uTime;
uniform vec3 uColor;
uniform float uI;
varying vec2 vUv;
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uScale;
  float r = length(p);
  float a = atan(p.y, p.x) / 6.2831853 + 0.5;
  float s1 = hr_vn2(vec2(r * 0.55 - uTime * 0.02, a * 14.0), 14.0).x;
  float s2 = hr_vn2(vec2(r * 1.4 - uTime * 0.05, a * 38.0 + 3.0), 38.0).x;
  float inner = exp(-(r - 1.0) * 2.2) * mix(0.5, 1.6, s1 * s2 + 0.2);
  float outer = exp(-(r - 1.0) * 0.5) * 0.4 + exp(-(r - 1.0) * 0.14) * 0.035;
  float I = inner * 1.3 + outer * mix(0.8, 1.2, s1);
  I *= smoothstep(0.97, 1.03, r);
  I *= 1.0 - smoothstep(0.6 * uScale, uScale, r);
  gl_FragColor = vec4(uColor * I * uI, 1.0);
  ${F_POST}
}
`;

const skyVert = /* glsl */ `
${V_PRE}
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${V_POST}
}
`;
/** Faint Milky Way band with dust lanes. */
export const skyFrag = /* glsl */ `
${F_PRE}
${NOISE}
uniform vec3 uBand;
uniform vec3 uCore;
uniform float uI;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float lat = dot(d, uBand);
  float band = exp(-lat * lat / 0.018) + 0.35 * exp(-lat * lat / 0.1);
  float n = hr_vn3(d * 3.0) * 0.5 + hr_vn3(d * 8.0) * 0.3 + hr_vn3(d * 19.0) * 0.2;
  float dust = smoothstep(0.42, 0.72, hr_vn3(d * 6.0 + 3.0) * 0.6 + hr_vn3(d * 14.0) * 0.4);
  float core = pow(max(dot(d, uCore), 0.0), 6.0);
  vec3 c = mix(vec3(0.45, 0.52, 0.7), vec3(0.95, 0.78, 0.58), core);
  float I = band * (0.35 + 0.9 * n * n) * (1.0 - 0.75 * dust * exp(-lat * lat / 0.01)) * (1.0 + 2.5 * core);
  gl_FragColor = vec4(c * I * uI, 1.0);
  ${F_POST}
}
`;

const glintVert = /* glsl */ `
${V_PRE}
attribute vec3 aFin;
attribute float aSeed;
uniform float uTime;
uniform float uGain;
uniform float uPx;
uniform float uFluxR2;
uniform vec3 uColor;
varying vec3 vC;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec3 L = normalize(-w.xyz);
  vec3 V = normalize(cameraPosition - w.xyz);
  vec3 H = normalize(L + V);
  // radiator fins are mirror-like plates: a flash when the star reflects into the eye
  float g = pow(abs(dot(H, normalize(aFin))), 1000.0);
  g *= 0.5 + 0.5 * sin(uTime * (0.5 + aSeed * 1.6) + aSeed * 60.0);
  float flux = uFluxR2 / dot(w.xyz, w.xyz);
  float I = g * flux * uGain;
  vC = uColor * I;
  vec4 mv = viewMatrix * w;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPx * (2.0 + 16.0 * clamp(sqrt(I) * 0.12, 0.0, 1.0));
  if (I < 0.03) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  ${V_POST}
}
`;
const glintFrag = /* glsl */ `
${F_PRE}
varying vec3 vC;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float core = exp(-dot(c, c) * 16.0);
  float cr = exp(-abs(c.x) * 22.0) * exp(-abs(c.y) * 3.0) + exp(-abs(c.y) * 22.0) * exp(-abs(c.x) * 3.0);
  gl_FragColor = vec4(vC * (core + 0.45 * cr), 1.0);
  ${F_POST}
}
`;

// ---------------------------------------------------------------------------

export interface PortFrame {
  /** Surface point on the strand (world). */
  S: Vector3;
  /** Surface normal. */
  n: Vector3;
  /** Flight direction along the strand. */
  fwd: Vector3;
  /** Camera right when flying along fwd with n up. */
  right: Vector3;
  u: number;
  v: number;
}

export class SpaceSet implements IntroSet {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(34, 16 / 9, 0.5, 1e5);
  readonly port: PortFrame;
  private arc = new ArcTable();
  private knotMat: ShaderMaterial;
  private detailMat: ShaderMaterial;
  private detail: Mesh;
  private starMat: ShaderMaterial;
  private corona: Mesh;
  private sky: Mesh;
  private stars: Points;
  private glints: Points;
  private beacons: Points;
  private portLights: Points;
  private look = new Vector3();
  private up = new Vector3();
  private tmp = new Vector3();
  private m4 = new Matrix4();

  constructor() {
    this.scene.background = new Color(0, 0, 0);
    // --- background
    const band = new Vector3(0.35, 0.8, -0.48).normalize();
    this.sky = new Mesh(
      new SphereGeometry(40000, 48, 24),
      new ShaderMaterial({
        vertexShader: skyVert,
        fragmentShader: skyFrag,
        uniforms: {
          uBand: { value: band },
          uCore: { value: new Vector3(-0.8, 0.1, -0.6).normalize() },
          uI: { value: 0.03 },
        },
        side: BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.stars = makeStarfield(9000, 30000, 7, band);
    this.scene.add(this.stars);

    // --- the star
    this.starMat = new ShaderMaterial({
      vertexShader: starVert,
      fragmentShader: starFrag,
      uniforms: { uTime: { value: 0 }, uColor: { value: STAR_COLOR }, uI: { value: 26 } },
    });
    this.scene.add(new Mesh(new SphereGeometry(STAR_R, 64, 32), this.starMat));
    const cs = 26;
    this.corona = new Mesh(
      new PlaneGeometry(2 * STAR_R * cs, 2 * STAR_R * cs),
      new ShaderMaterial({
        vertexShader: coronaVert,
        fragmentShader: coronaFrag,
        uniforms: { uScale: { value: cs }, uTime: { value: 0 }, uColor: { value: new Color(1.0, 0.88, 0.7) }, uI: { value: 2.0 } },
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.corona.renderOrder = 4;
    this.scene.add(this.corona);

    // --- the strand
    this.port = this.choosePort(this.driftPos(SPACE.diveStart, new Vector3()));
    const s0 = this.arc.at(this.port.u);
    const knotGeo = new TorusKnotGeometry(KR, TUBE, 3600, 16, P, Q);
    knotGeo.rotateX(-Math.PI / 2);
    this.addSurfaceAttributes(knotGeo, 3600, 16, s0);
    this.knotMat = makeShellMaterial();
    this.knotMat.uniforms.uTube.value = TUBE;
    this.knotMat.uniforms.uFluxR2.value = this.port.S.lengthSq();
    this.knotMat.transparent = true;
    const knot = new Mesh(knotGeo, this.knotMat);
    knot.renderOrder = 1;
    knot.frustumCulled = false;
    this.scene.add(knot);
    // local detail tube around the port (shares the knot's uniforms, no inflation)
    this.detailMat = makeShellMaterial({ ...this.knotMat.uniforms, uTube: { value: 0 }, uHide: { value: new Vector4() } });
    this.detail = new Mesh(this.buildDetailTube(s0), this.detailMat);
    this.detail.renderOrder = 2;
    this.detail.frustumCulled = false;
    this.scene.add(this.detail);

    this.glints = this.makeGlints();
    this.scene.add(this.glints);
    this.beacons = this.makeBeacons(s0);
    this.scene.add(this.beacons);
    this.portLights = this.makePortLights();
    this.scene.add(this.portLights);
  }

  /** Establishing drift: a slow orbit and push-in, always looking at the star. */
  private driftPos(t: number, out: Vector3) {
    const k = clamp01(t / SPACE.diveStart);
    const az = lerp(0.15, 0.5, k);
    const el = lerp(0.98, 0.84, k);
    const d = lerp(650, 520, smoothstep(0, 1, k));
    return out.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
  }

  /**
   * Pick Spaceport 4: a spot on the strand, visible from where the dive
   * starts, where the star hangs low (~9°) about 30° off the flight line of a
   * camera skimming along the strand (so the close-up is side-lit with long
   * shadows), and where the strand curves away below the horizon.
   */
  private choosePort(cam: Vector3): PortFrame {
    const p = new Vector3();
    const t = new Vector3();
    const n = new Vector3();
    const b = new Vector3();
    const d = new Vector3();
    const S = new Vector3();
    const L = new Vector3();
    const fwd = new Vector3();
    const right = new Vector3();
    const dir0 = new Vector3();
    const dirEnd = new Vector3();
    const ca = new Vector3();
    const cb = new Vector3();
    const kappa = new Vector3();
    let best: PortFrame | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 1500; i++) {
      const u = (i / 1500) * U_MAX;
      knotFrame(u, p, t, n, b);
      // curvature vector of the strand (the surface ahead should fall away, not rise)
      const hh = 1e-3;
      knotCurve(u - hh, ca);
      knotCurve(u + hh, cb);
      const speed2 = ca.distanceToSquared(cb) / (4 * hh * hh);
      kappa.copy(ca).add(cb).addScaledVector(p, -2).divideScalar(hh * hh);
      kappa.addScaledVector(t, -kappa.dot(t)).divideScalar(speed2);
      for (let j = 0; j < 72; j++) {
        const v = (j / 72) * Math.PI * 2;
        tubeDir(v, n, b, d);
        S.copy(p).addScaledVector(d, TUBE);
        L.copy(S).negate().normalize();
        const elev = Math.asin(L.dot(d));
        if (elev < 0.05 || elev > 0.35) continue;
        dir0.subVectors(cam, S);
        const dist = dir0.length();
        dir0.divideScalar(dist);
        const vis = dir0.dot(d);
        if (vis < 0.3) continue;
        for (const sg of [1, -1]) {
          fwd.copy(t).multiplyScalar(sg);
          right.crossVectors(fwd, d);
          const az = Math.atan2(L.dot(right), L.dot(fwd));
          dirEnd.copy(d).multiplyScalar(SPACE.endHeight).addScaledVector(fwd, -SPACE.endBack).normalize();
          const bend = kappa.dot(d);
          const score =
            -8 * Math.abs(elev - 0.16) -
            3 * Math.abs(az - 0.5) +
            1.2 * vis +
            1.5 * dir0.dot(dirEnd) -
            dist / 500 -
            150 * Math.max(bend, -0.01);
          if (score > bestScore) {
            bestScore = score;
            best = { S: S.clone(), n: d.clone(), fwd: fwd.clone(), right: right.clone(), u, v };
          }
        }
      }
    }
    return best!;
  }

  /** aSurf (arc length along the strand relative to the port, arc around it) and aTan. */
  private addSurfaceAttributes(geo: BufferGeometry, tubular: number, radial: number, s0: number) {
    const count = (tubular + 1) * (radial + 1);
    const surf = new Float32Array(count * 2);
    const tan = new Float32Array(count * 3);
    const p = new Vector3();
    const t = new Vector3();
    const n = new Vector3();
    const b = new Vector3();
    for (let i = 0; i <= tubular; i++) {
      const u = (i / tubular) * U_MAX;
      knotFrame(u, p, t, n, b);
      const s = this.arc.rel(u, s0);
      for (let j = 0; j <= radial; j++) {
        const k = i * (radial + 1) + j;
        surf[k * 2] = s;
        surf[k * 2 + 1] = (j / radial) * Math.PI * 2 * TUBE;
        tan[k * 3] = t.x;
        tan[k * 3 + 1] = t.y;
        tan[k * 3 + 2] = t.z;
      }
    }
    geo.setAttribute('aSurf', new Float32BufferAttribute(surf, 2));
    geo.setAttribute('aTan', new Float32BufferAttribute(tan, 3));
  }

  /** Finely tessellated tube around the port (dense near it, coarser away). */
  private buildDetailTube(s0: number) {
    const NU = 240;
    const NV = 320;
    const port = this.port;
    const p = new Vector3();
    const t = new Vector3();
    const n = new Vector3();
    const b = new Vector3();
    const d = new Vector3();
    knotFrame(port.u, p, t, n, b);
    knotCurve(port.u + 1e-4, _p2);
    const dsdu = _p2.distanceTo(p) / 1e-4;
    const du = 26 / dsdu;
    const r = TUBE * 1.003;
    const pos = new Float32Array((NU + 1) * (NV + 1) * 3);
    const nor = new Float32Array(pos.length);
    const tan = new Float32Array(pos.length);
    const surf = new Float32Array((NU + 1) * (NV + 1) * 2);
    for (let i = 0; i <= NU; i++) {
      const x = (i / NU) * 2 - 1;
      const u = port.u + du * Math.sign(x) * Math.pow(Math.abs(x), 2.6);
      knotFrame(u, p, t, n, b);
      const s = this.arc.rel(u, s0);
      for (let j = 0; j <= NV; j++) {
        const v = port.v + ((j / NV) * 2 - 1) * DETAIL_HALF_ANGLE;
        tubeDir(v, n, b, d);
        const k = i * (NV + 1) + j;
        pos[k * 3] = p.x + d.x * r;
        pos[k * 3 + 1] = p.y + d.y * r;
        pos[k * 3 + 2] = p.z + d.z * r;
        nor[k * 3] = d.x;
        nor[k * 3 + 1] = d.y;
        nor[k * 3 + 2] = d.z;
        tan[k * 3] = t.x;
        tan[k * 3 + 1] = t.y;
        tan[k * 3 + 2] = t.z;
        surf[k * 2] = s;
        surf[k * 2 + 1] = v * TUBE;
      }
    }
    const idx = new Uint32Array(NU * NV * 6);
    let o = 0;
    for (let i = 0; i < NU; i++) {
      for (let j = 0; j < NV; j++) {
        const a = i * (NV + 1) + j;
        const c = a + NV + 1;
        idx[o++] = a;
        idx[o++] = c;
        idx[o++] = a + 1;
        idx[o++] = c;
        idx[o++] = c + 1;
        idx[o++] = a + 1;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geo.setAttribute('aTan', new Float32BufferAttribute(tan, 3));
    geo.setAttribute('aSurf', new Float32BufferAttribute(surf, 2));
    geo.setIndex(new Uint32BufferAttribute(idx, 1));
    return geo;
  }

  /** Radiator fins on the night side: tiny mirrors that flash when they catch the star. */
  private makeGlints() {
    const N = 26000;
    const rng = mulberry32(99);
    const pos = new Float32Array(N * 3);
    const fin = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const p = new Vector3();
    const t = new Vector3();
    const n = new Vector3();
    const b = new Vector3();
    const d = new Vector3();
    const f = new Vector3();
    for (let i = 0; i < N; i++) {
      knotFrame(rng() * U_MAX, p, t, n, b);
      // angle around the tube measured from the night-side centre line
      const a = (rng() + rng() + rng() - 1.5) * 1.5;
      d.copy(n).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
      const h = TUBE * (1.02 + 0.08 * rng());
      pos[i * 3] = p.x + d.x * h;
      pos[i * 3 + 1] = p.y + d.y * h;
      pos[i * 3 + 2] = p.z + d.z * h;
      // plates run along the strand and stick straight out: normal = t x d, plus a tilt
      f.crossVectors(t, d).normalize();
      f.x += (rng() - 0.5) * 0.9;
      f.y += (rng() - 0.5) * 0.9;
      f.z += (rng() - 0.5) * 0.9;
      f.normalize();
      fin[i * 3] = f.x;
      fin[i * 3 + 1] = f.y;
      fin[i * 3 + 2] = f.z;
      seed[i] = rng();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aFin', new Float32BufferAttribute(fin, 3));
    geo.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
    const mat = new ShaderMaterial({
      vertexShader: glintVert,
      fragmentShader: glintFrag,
      uniforms: {
        uTime: { value: 0 },
        uGain: { value: 55 },
        uPx: { value: 1 },
        uFluxR2: { value: this.port.S.lengthSq() },
        uColor: { value: STAR_COLOR },
      },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const pts = new Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    return pts;
  }

  /** The nine spaceports, evenly spaced along the strand; Spaceport 4 is the target. */
  private makeBeacons(s0: number) {
    const specs: LightSpec[] = [];
    const p = new Vector3();
    const t = new Vector3();
    const n = new Vector3();
    const b = new Vector3();
    const d = new Vector3();
    // invert arc length by marching (fine enough for placement)
    for (let k = 0; k < 9; k++) {
      const target = ((k - 3) / 9) * this.arc.length;
      let u = this.port.u;
      for (let it = 0; it < 60; it++) {
        const err = this.arc.rel(u, s0) - target;
        const wrapped = err - Math.round(err / this.arc.length) * this.arc.length;
        if (Math.abs(wrapped) < 1e-3) break;
        knotCurve(u, p);
        knotCurve(u + 1e-4, _p2);
        u -= wrapped / (_p2.distanceTo(p) / 1e-4);
      }
      knotFrame(u, p, t, n, b);
      tubeDir(this.port.v, n, b, d);
      p.addScaledVector(d, TUBE * 1.002);
      specs.push({ p: [p.x, p.y, p.z], c: [3.5, 4.2, 5.5], size: 0.01, blink: [2.6, k * 0.11, 0.35, 0.3] });
    }
    return makeLights(specs);
  }

  /** Runway-like lights of Spaceport 4 itself, seen during the last seconds of the dive. */
  private makePortLights() {
    const { S, n, fwd, right } = this.port;
    const specs: LightSpec[] = [];
    const q = new Vector3();
    const put = (a: number, s: number, c: [number, number, number], size: number, blink?: [number, number, number, number]) => {
      q.copy(S).addScaledVector(fwd, a).addScaledVector(right, s).addScaledVector(n, 0.00005);
      specs.push({ p: [q.x, q.y, q.z], c, size, blink });
    };
    for (let i = 0; i < 14; i++) {
      const a = 0.012 + i * 0.0022;
      put(a, -0.0016, [6, 6.4, 7], 0.00004);
      put(a, 0.0016, [6, 6.4, 7], 0.00004);
      put(a, 0, [9, 8, 6], 0.00005, [1.1, -i * 0.045, 0.1, 0]);
    }
    put(0.0435, -0.0022, [12, 1.5, 0.8], 0.00008, [1.4, 0, 0.3, 0.05]);
    put(0.0435, 0.0022, [12, 1.5, 0.8], 0.00008, [1.4, 0.5, 0.3, 0.05]);
    return makeLights(specs);
  }

  /** Camera position and look target at local time t. */
  pose(t: number, pos: Vector3, look: Vector3, up: Vector3) {
    const { S, n, fwd } = this.port;
    const origin = this.tmp.set(0, -6, 0);
    if (t <= SPACE.diveStart) {
      this.driftPos(t, pos);
      look.copy(origin);
      up.set(0, 1, 0);
      return;
    }
    const e = clamp01((t - SPACE.diveStart) / (SPACE.diveEnd - SPACE.diveStart));
    const p0 = this.driftPos(SPACE.diveStart, new Vector3());
    const rel0 = p0.sub(S);
    const d0 = rel0.length();
    const dir0 = rel0.divideScalar(d0);
    const endOff = new Vector3().copy(n).multiplyScalar(SPACE.endHeight).addScaledVector(fwd, -SPACE.endBack);
    const dEnd = endOff.length();
    const dirEnd = endOff.divideScalar(dEnd);
    // distance falls exponentially (a steady "zoom"), still moving at the end
    const fd = smootherstep(0, 1.18, e) / smootherstep(0, 1.18, 1);
    const dist = Math.exp(lerp(Math.log(d0), Math.log(dEnd), fd));
    const q = new Quaternion().setFromUnitVectors(dir0, dirEnd);
    const qi = new Quaternion().slerp(q, smoothstep(0.0, 0.82, e));
    const dir = dir0.clone().applyQuaternion(qi);
    pos.copy(S).addScaledVector(dir, dist);
    // look: star → port → ahead along the strand
    const wFar = smoothstep(0.02, 0.35, e);
    const wNear = smoothstep(Math.log(1.5), Math.log(dEnd * 1.2), Math.log(dist));
    look.copy(origin).lerp(S, wFar).addScaledVector(fwd, SPACE.endAhead * wNear);
    const wUp = smoothstep(Math.log(4), Math.log(0.15), Math.log(dist));
    up.set(0, 1, 0).lerp(n, wUp).normalize();
  }

  /** Camera orientation (world) at local time t, for matching the next shot. */
  orientationAt(t: number, out: Quaternion) {
    const pos = new Vector3();
    const look = new Vector3();
    const up = new Vector3();
    this.pose(t, pos, look, up);
    this.m4.lookAt(pos, look, up);
    return out.setFromRotationMatrix(this.m4);
  }

  /** Directions (world) from the port to points along the rest of the strand, for the next shot's sky. */
  strandDirections(count: number, minDist: number) {
    const out: { dir: Vector3; lit: number }[] = [];
    const p = new Vector3();
    const t = new Vector3();
    const n = new Vector3();
    const b = new Vector3();
    for (let i = 0; i < count; i++) {
      const u = (i / count) * U_MAX;
      knotFrame(u, p, t, n, b);
      const rel = p.clone().sub(this.port.S);
      const dist = rel.length();
      if (dist < minDist) continue;
      // how much of the tube's lit side faces the port
      const L = p.clone().negate().normalize();
      const V = rel.clone().negate().normalize();
      const lit = clamp01(0.5 + 0.5 * L.dot(V)) * Math.min(1, 60 / dist);
      out.push({ dir: rel.divideScalar(dist), lit });
    }
    return out;
  }

  update(t: number, view: ViewInfo) {
    const cam = this.camera;
    fitFov(cam, lerp(34, 46, smoothstep(SPACE.diveStart + 2, SPACE.diveEnd - 1, t)), view.aspect, 40);
    this.pose(t, cam.position, this.look, this.up);
    cam.up.copy(this.up);
    cam.lookAt(this.look);
    // near plane from the altitude above the strand around the port
    const { S, n, fwd } = this.port;
    const c0 = this.tmp.copy(S).addScaledVector(n, -TUBE);
    const rel = new Vector3().subVectors(cam.position, c0);
    rel.addScaledVector(fwd, -rel.dot(fwd));
    const alt = Math.min(rel.length() - TUBE, cam.position.distanceTo(S));
    cam.near = Math.min(0.5, Math.max(2e-5, alt * 0.3));
    cam.far = 1e5;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    this.sky.position.copy(cam.position);
    this.stars.position.copy(cam.position);
    const su = (this.stars.material as ShaderMaterial).uniforms;
    su.uPx.value = view.pxRatio;
    su.uTime.value = view.time;
    this.corona.quaternion.copy(cam.quaternion);
    (this.corona.material as ShaderMaterial).uniforms.uTime.value = view.time;
    this.starMat.uniforms.uTime.value = view.time;

    const ku = this.knotMat.uniforms;
    ku.uPxScale.value = pxScale(cam, view.heightPx);
    this.detail.visible = cam.position.distanceTo(S) < 3;
    (ku.uHide.value as Vector4).set(this.detail.visible ? 24 : 0, this.port.v * TUBE, (DETAIL_HALF_ANGLE - 0.05) * TUBE, 2 * Math.PI * TUBE);
    const gu = (this.glints.material as ShaderMaterial).uniforms;
    gu.uTime.value = view.time;
    gu.uPx.value = view.pxRatio;
    const dS = cam.position.distanceTo(S);
    tickLights(this.beacons, cam, view, view.time, smoothstep(4, 12, dS));
    tickLights(this.portLights, cam, view, view.time, smoothstep(2.5, 0.25, dS));
  }

  dispose() {
    disposeTree(this.scene);
  }
}
