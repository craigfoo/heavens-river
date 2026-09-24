// Shots 4-5: the elevator through the shell and the doors. The camera rides a
// small glass-roofed cab at Quinlan eye height (1.1 m), looking up the shaft
// while ring lights stream past, faster and then slower. The cab stops, the
// view settles on the doors and they slide open onto warm golden light: a
// short hatch passage and a glimpse of the valley at golden hour, where the
// land curves up at the horizon. Dust hangs in the light.

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import { IntroSet, SHAKE, ViewInfo, clamp01, disposeTree, fitFov, lerp, mulberry32, smoothstep, smootherstep } from './common';
import { F_POST, F_PRE, NOISE, PULSE, V_POST, V_PRE } from './glsl';

/** Local times (s). */
export const ELEVATOR = {
  duration: 16,
  moveStart: 0.3,
  moveEnd: 8.8,
  vmax: 40,
  tiltStart: 5.9,
  tiltEnd: 9.0,
  leak: 8.4,
  doorsOpen: 9.6,
  doorsLen: 2.3,
};

const SHAFT_R = 4.4;
/** Ring light spacing (m): at 40 m/s peak they pass ~2.5 times a second (below the 3 Hz flash guideline). */
const RING = 16;
const SHUTTER = 1 / 40;
const EYE = 1.1; // Quinlan standing eye height
const CAB = { half: 1.5, height: 2.7, doorHalf: 0.8, doorH: 2.15, glass0: 0.95, glass1: 2.45 };
const CORRIDOR = { half: 1.0, height: 2.4, z0: -CAB.half, z1: -7.2 };

/** Cab speed (m/s): sin² profile, so the lights pass faster, then slower. */
export function elevatorSpeed(t: number) {
  const x = (t - ELEVATOR.moveStart) / (ELEVATOR.moveEnd - ELEVATOR.moveStart);
  if (x <= 0 || x >= 1) return 0;
  const s = Math.sin(Math.PI * x);
  return ELEVATOR.vmax * s * s;
}
function descent(t: number) {
  const T = ELEVATOR.moveEnd - ELEVATOR.moveStart;
  const x = clamp01((t - ELEVATOR.moveStart) / T);
  return ELEVATOR.vmax * T * (x / 2 - Math.sin(2 * Math.PI * x) / (4 * Math.PI));
}

const worldVert = /* glsl */ `
${V_PRE}
varying vec3 vW;
varying vec3 vN;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
  ${V_POST}
}
`;

/** Light from the shaft's rings reaching height y (shaft coordinate Y = y + descent). */
const ringCommon = /* glsl */ `
uniform float uDepth;
uniform float uBlur;
uniform float uGold;
uniform float uTime;
float ringLight(float Y, float r) {
  float x = Y / ${RING.toFixed(1)};
  float rr = r / ${RING.toFixed(1)};
  return 0.2 + 0.5 * hr_bar(x, 0.45, rr) + 0.5 * hr_bar(x, 0.18, rr);
}
`;

const shaftFrag = /* glsl */ `
${F_PRE}
${NOISE}
${PULSE}
${ringCommon}
uniform float uLanding;
varying vec3 vW;
varying vec3 vN;
varying vec2 vUv;
void main() {
  float Y = vW.y + uDepth;
  float fy = fwidth(Y);
  float ang = atan(vW.z, vW.x) * ${SHAFT_R.toFixed(1)};
  float fa = fwidth(ang) + 1e-4;
  // the landing opening toward the hatch passage, once the cab has arrived
  // (after the derivatives, which are undefined after a divergent discard)
  if (uLanding > 0.5 && abs(vW.x) < ${(CORRIDOR.half + 0.05).toFixed(2)} && vW.z < 0.0 && vW.y > -0.05 && vW.y < ${(CORRIDOR.height + 0.05).toFixed(2)}) discard;
  float r = uBlur + 0.6 * fy;
  vec3 lampC = vec3(1.0, 0.88, 0.7);
  vec3 alb = vec3(0.055, 0.055, 0.06);
  float seam = max(hr_bar(Y / 3.0, 0.04, r / 3.0), hr_bar(ang / 2.5, 0.025, fa / 2.5));
  float rib = hr_bar(Y / 6.0 + 0.5, 0.08, r / 6.0);
  alb *= (1.0 - 0.5 * seam) * (1.0 + 1.2 * rib);
  float light = ringLight(Y, r);
  vec3 col = alb * lampC * light * 0.5;
  // paired ring lights with a soft glow on the wall, and guide rails with position lights
  float x = Y / ${RING.toFixed(1)};
  float rr = r / ${RING.toFixed(1)};
  col += lampC * 3.5 * (hr_bar(x, 0.014, rr) + hr_bar(x + 0.04, 0.014, rr));
  col += lampC * 0.2 * hr_bar(x + 0.02, 0.16, rr);
  float rails = hr_bar(ang / (6.2831853 * ${SHAFT_R.toFixed(1)} / 4.0) + 0.125, 0.025, fa / (6.2831853 * ${SHAFT_R.toFixed(1)} / 4.0));
  col = mix(col, vec3(0.2, 0.21, 0.23) * light, rails);
  float pos = rails * hr_bar(Y / 24.0 + 0.5, 0.03, r / 24.0);
  col += vec3(0.3, 0.6, 1.0) * 5.0 * pos;
  // fade into the dark far up the shaft
  col *= exp(-max(vW.y - 2.0, 0.0) / 220.0);
  gl_FragColor = vec4(col, 1.0);
  ${F_POST}
}
`;

/** Cab, doors and hatch passage: lit by passing rings, a cool downlight and the golden flood. */
const cabFrag = /* glsl */ `
${F_PRE}
${NOISE}
${PULSE}
${ringCommon}
uniform vec3 uAlb;
uniform float uMetal;
uniform float uKind; // 0 cab, 1 door, 2 passage
uniform float uLeak;
uniform float uGap;
varying vec3 vW;
varying vec3 vN;
varying vec2 vUv;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  vec3 alb = uAlb;
  // brushed metal: fine vertical grain
  float grain = hr_vn2(vec2(vW.x * 60.0 + vW.z * 60.0, vW.y * 1.5), 0.0).x;
  alb *= 0.9 + 0.16 * grain * uMetal;
  // rings passing outside the glass sweep light through the cab
  float ring = ringLight(vW.y + uDepth, uBlur + 0.3);
  float upper = smoothstep(0.6, 2.4, vW.y);
  vec3 lampC = vec3(1.0, 0.92, 0.8);
  vec3 col = alb * lampC * ring * (0.1 + 0.5 * upper) * (0.4 + 0.6 * max(N.y, 0.0) + 0.4 * abs(N.x));
  col += lampC * fres * ring * 0.08 * uMetal;
  // dim cool downlight inside the cab, from a strip under the roof band
  col += alb * vec3(0.5, 0.6, 0.75) * 0.1 * (0.3 + 0.7 * max(N.y, 0.0));
  if (uKind < 0.5) {
    float fy = fwidth(vW.y) + 1e-4;
    col += vec3(0.55, 0.7, 1.0) * 0.7 * hr_box(vW.y, 2.47, 2.52, fy) * step(${(CAB.half - 0.1).toFixed(2)}, max(abs(vW.x), abs(vW.z)));
  }
  // gold light pouring in from the passage
  vec3 gold = vec3(1.0, 0.72, 0.38);
  vec3 src = vec3(0.0, 1.1, ${(CORRIDOR.z1 - 3.0).toFixed(1)});
  vec3 ld = src - vW;
  float dl = length(ld);
  float face = max(dot(N, ld / dl), 0.0);
  float reach = exp(-max(vW.z - ${CORRIDOR.z1.toFixed(1)}, 0.0) / 3.0);
  float cabSide = smoothstep(${(-CAB.half + 0.2).toFixed(2)}, ${(-CAB.half - 0.2).toFixed(2)}, -vW.z);
  float beam = 1.0 - smoothstep(uGap * 1.0 + 0.2, uGap * 1.0 + 1.4, abs(vW.x));
  float inCab = step(${(-CAB.half).toFixed(2)}, vW.z);
  float lightIn = mix(1.0, beam, inCab * cabSide);
  col += alb * gold * uGold * 3.5 * reach * (0.3 + 0.7 * face) * lightIn;
  if (uKind > 1.5) {
    // passage: a few structural ribs toward the hatch
    float seam = hr_bar(vW.z / 2.4, 0.04, fwidth(vW.z) / 2.4);
    col *= 1.0 - 0.3 * seam;
  }
  if (uKind > 0.5 && uKind < 1.5) {
    // door panels: light leaking through the seam and edges
    float fx = fwidth(vW.x) + 1e-4;
    float edge = 1.0 - smoothstep(0.0, 0.012 + fx, abs(abs(vW.x) - uGap));
    float closing = 1.0 - smoothstep(0.0, 0.12, uGap);
    col += gold * uLeak * closing * 16.0 * edge * smoothstep(0.02, 0.2, vW.y) * (1.0 - smoothstep(1.95, 2.15, vW.y));
  }
  gl_FragColor = vec4(col, 1.0);
  ${F_POST}
}
`;

/** Painted golden-hour valley seen through the hatch: the land curves up at the horizon. */
const vistaFrag = /* glsl */ `
${F_PRE}
${NOISE}
uniform float uI;
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
varying vec2 vUv;
void main() {
  vec2 p = vUv;
  float hz = 0.46;
  vec3 skyHz = vec3(1.0, 0.6, 0.26);
  vec3 skyTop = vec3(0.7, 0.6, 0.5);
  vec3 col = mix(skyHz, skyTop, smoothstep(hz, 1.0, p.y));
  vec2 sp = vec2(0.585, 0.5);
  float d = length((p - sp) * vec2(1.6, 1.0));
  col += vec3(1.0, 0.8, 0.5) * (exp(-d * 12.0) * 3.0 + exp(-d * 3.0) * 0.9);
  // ridges from far to near; the far ones bend upward toward both edges
  vec3 haze = vec3(0.95, 0.58, 0.28);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float x = p.x * (2.5 + fi * 1.7) + fi * 7.3;
    float h = hz + 0.02 - fi * 0.07;
    h += 0.045 * (hr_vn2(vec2(x, fi), 0.0).x - 0.5) + 0.02 * (hr_vn2(vec2(x * 3.1, fi + 9.0), 0.0).x - 0.5);
    h += (0.5 - fi * 0.12) * (p.x - 0.5) * (p.x - 0.5) * (fi < 2.0 ? 1.0 : 0.3);
    float m = 1.0 - smoothstep(h - 0.004, h + 0.004, p.y);
    vec3 hill = mix(haze, vec3(0.24, 0.15, 0.07), fi / 3.0);
    hill = mix(hill, vec3(0.22, 0.24, 0.08), 0.3 * fi / 3.0);
    col = mix(col, hill, m);
  }
  // the river catching the light in the valley floor
  float rv = 0.2 + 0.035 * sin(p.x * 9.0 + 1.2) + 0.02 * sin(p.x * 23.0);
  float river = (1.0 - smoothstep(0.004, 0.012, abs(p.y - rv))) * smoothstep(0.1, 0.4, p.x) * (1.0 - smoothstep(0.75, 0.95, p.x));
  col = mix(col, vec3(1.0, 0.85, 0.55) * 1.8, river * 0.9);
  gl_FragColor = vec4(col * uI, 1.0);
  ${F_POST}
}
`;

const shaftBeamFrag = /* glsl */ `
${F_PRE}
${NOISE}
uniform float uI;
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
varying vec2 vUv;
void main() {
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = smoothstep(0.0, 1.0, across);
  float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
  float n = 0.75 + 0.5 * hr_vn2(vec2(vUv.x * 6.0, vUv.y * 3.0 - uTime * 0.08), 0.0).x;
  gl_FragColor = vec4(vec3(1.0, 0.78, 0.45) * uI * a * a * along * n, 1.0);
  ${F_POST}
}
`;

const dustVert = /* glsl */ `
${V_PRE}
attribute float aSeed;
uniform float uTime;
uniform float uI;
uniform float uPx;
varying float vA;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.21 + aSeed * 30.0) * 0.12;
  p.y += sin(uTime * 0.17 + aSeed * 17.0) * 0.1 - mod(uTime * 0.02 + aSeed, 1.0) * 0.1;
  p.z += cos(uTime * 0.13 + aSeed * 11.0) * 0.12;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // brighter inside the doorway's light
  float inBeam = 1.0 - smoothstep(0.4, 1.2, abs(p.x));
  vA = uI * inBeam * (0.4 + 0.6 * fract(aSeed * 13.7));
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPx * clamp(2.2 / max(-mv.z, 0.3), 1.0, 5.0);
  ${V_POST}
}
`;
const dustFrag = /* glsl */ `
${F_PRE}
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  gl_FragColor = vec4(vec3(1.0, 0.8, 0.5) * vA * exp(-dot(c, c) * 3.0), 1.0);
  ${F_POST}
}
`;

export class ElevatorSet implements IntroSet {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(62, 16 / 9, 0.03, 3000);
  private ring = { uDepth: { value: 0 }, uBlur: { value: 0 }, uGold: { value: 0 }, uTime: { value: 0 } };
  private shaftMat: ShaderMaterial;
  private doorMat: ShaderMaterial;
  private doors: Mesh[] = [];
  private vistaMat: ShaderMaterial;
  private beams: Mesh[] = [];
  private beamMat: ShaderMaterial;
  private dust: Points;
  private passage = new Group();
  private look = new Vector3();

  constructor() {
    this.scene.background = new Color(0, 0, 0);
    this.shaftMat = new ShaderMaterial({
      vertexShader: worldVert,
      fragmentShader: shaftFrag,
      uniforms: { ...this.ring, uLanding: { value: 0 } },
      side: BackSide,
    });
    const shaftGeo = new CylinderGeometry(SHAFT_R, SHAFT_R, 520, 96, 1, true);
    shaftGeo.translate(0, 240, 0);
    const shaft = new Mesh(shaftGeo, this.shaftMat);
    shaft.frustumCulled = false;
    this.scene.add(shaft);

    const cabMat = (alb: [number, number, number], metal: number, kind: number) =>
      new ShaderMaterial({
        vertexShader: worldVert,
        fragmentShader: cabFrag,
        uniforms: {
          ...this.ring,
          uAlb: { value: new Color(...alb) },
          uMetal: { value: metal },
          uKind: { value: kind },
          uLeak: { value: 0 },
          uGap: { value: 0 },
        },
      });
    const frame = cabMat([0.09, 0.09, 0.1], 1, 0);
    const panel = cabMat([0.16, 0.15, 0.14], 0.5, 0);
    const floorM = cabMat([0.07, 0.07, 0.075], 0.3, 0);
    this.doorMat = cabMat([0.2, 0.2, 0.21], 1, 1);
    const passM = cabMat([0.3, 0.27, 0.23], 0.2, 2);
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: ShaderMaterial, parent: Group | Scene = this.scene) => {
      const mesh = new Mesh(new BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };
    const H = CAB.half;
    // floor and the solid lower walls (sides and back)
    box(2 * H, 0.1, 2 * H, 0, -0.05, 0, floorM);
    box(0.06, CAB.glass0, 2 * H, -H, CAB.glass0 / 2, 0, panel);
    box(0.06, CAB.glass0, 2 * H, H, CAB.glass0 / 2, 0, panel);
    box(2 * H, CAB.glass0, 0.06, 0, CAB.glass0 / 2, H, panel);
    // top band and glass mullions
    box(0.08, 0.25, 2 * H, -H, CAB.height - 0.125, 0, frame);
    box(0.08, 0.25, 2 * H, H, CAB.height - 0.125, 0, frame);
    box(2 * H, 0.25, 0.08, 0, CAB.height - 0.125, H, frame);
    for (const [x, z] of [[-H, -H], [H, -H], [-H, H], [H, H], [-H, 0], [H, 0], [0, H]]) {
      box(0.07, CAB.height, 0.07, x, CAB.height / 2, z, frame);
    }
    // glass roof frame: a rim and an inner square, leaving the view up the shaft clear
    box(2 * H, 0.06, 0.08, 0, CAB.height, -H, frame);
    for (const s of [-0.78, 0.78]) {
      box(1.62, 0.05, 0.05, 0, CAB.height, s, frame);
      box(0.05, 0.05, 1.62, s, CAB.height, 0, frame);
    }
    // front wall with the door opening
    const dh = CAB.doorHalf;
    box(H - dh, CAB.height, 0.08, -(H + dh) / 2, CAB.height / 2, -H, panel);
    box(H - dh, CAB.height, 0.08, (H + dh) / 2, CAB.height / 2, -H, panel);
    box(2 * dh, CAB.height - CAB.doorH, 0.08, 0, (CAB.height + CAB.doorH) / 2, -H, panel);
    // sliding door panels
    for (const s of [-1, 1]) {
      const d = box(dh, CAB.doorH, 0.05, (s * dh) / 2, CAB.doorH / 2, -H + 0.07, this.doorMat);
      d.userData.side = s;
      this.doors.push(d);
    }

    // hatch passage beyond the landing (only shown once the cab has arrived)
    const C = CORRIDOR;
    const len = C.z0 - C.z1;
    const zc = (C.z0 + C.z1) / 2;
    box(2 * C.half, 0.1, len, 0, -0.05, zc, passM, this.passage);
    box(2 * C.half, 0.1, len, 0, C.height + 0.05, zc, passM, this.passage);
    box(0.1, C.height, len, -C.half - 0.05, C.height / 2, zc, passM, this.passage);
    box(0.1, C.height, len, C.half + 0.05, C.height / 2, zc, passM, this.passage);
    this.vistaMat = new ShaderMaterial({
      vertexShader: worldVert,
      fragmentShader: vistaFrag,
      uniforms: { uI: { value: 4 }, uTime: this.ring.uTime },
    });
    const vista = new Mesh(new PlaneGeometry(70, 34), this.vistaMat);
    vista.position.set(-3.5, 3.8, C.z1 - 34);
    this.passage.add(vista);
    this.passage.visible = false;
    this.scene.add(this.passage);

    this.beamMat = new ShaderMaterial({
      vertexShader: worldVert,
      fragmentShader: shaftBeamFrag,
      uniforms: { uI: { value: 0 }, uTime: this.ring.uTime },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    for (const [x, w] of [[-0.35, 0.7], [0.3, 0.9], [0.05, 1.4]]) {
      const g = new PlaneGeometry(1, 1);
      g.translate(0, 0.5, 0);
      const m = new Mesh(g, this.beamMat);
      m.userData.x = x;
      m.userData.w = w;
      m.renderOrder = 6;
      this.beams.push(m);
      this.passage.add(m);
    }
    this.dust = this.makeDust();
    this.passage.add(this.dust);
  }

  private makeDust() {
    const N = 420;
    const rng = mulberry32(5);
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rng() * 2 - 1) * 1.2;
      pos[i * 3 + 1] = 0.1 + rng() * 2.3;
      pos[i * 3 + 2] = lerp(0.8, CORRIDOR.z1, rng());
      seed[i] = rng();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
    const pts = new Points(
      geo,
      new ShaderMaterial({
        vertexShader: dustVert,
        fragmentShader: dustFrag,
        uniforms: { uTime: this.ring.uTime, uI: { value: 0 }, uPx: { value: 1 } },
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    return pts;
  }

  /** 0..1 door opening at local time t. */
  doorOpen(t: number) {
    return smootherstep(ELEVATOR.doorsOpen, ELEVATOR.doorsOpen + ELEVATOR.doorsLen, t);
  }

  update(t: number, view: ViewInfo) {
    const E = ELEVATOR;
    const v = elevatorSpeed(t);
    const shutter = Math.max(SHUTTER, view.dt);
    this.ring.uDepth.value = descent(t) % 480;
    this.ring.uBlur.value = 0.5 * v * shutter;
    this.ring.uTime.value = view.time;
    const arrived = t >= E.moveEnd;
    this.shaftMat.uniforms.uLanding.value = arrived ? 1 : 0;
    this.passage.visible = arrived;

    // doors: a seam of gold light, then they slide into the wall
    const open = this.doorOpen(t);
    const gap = open * CAB.doorHalf * 0.92;
    const leak = smoothstep(E.leak, E.leak + 0.8, t);
    for (const d of this.doors) {
      const s = d.userData.side as number;
      d.position.x = s * (CAB.doorHalf / 2 + gap);
    }
    const du = this.doorMat.uniforms;
    du.uLeak.value = leak * (1 - open);
    du.uGap.value = gap;
    const gold = leak * 0.12 + open * 1.0 + smoothstep(E.doorsOpen + 1.0, E.duration, t) * 1.5;
    this.ring.uGold.value = gold;
    this.vistaMat.uniforms.uI.value = 0.8 + 2.2 * smoothstep(E.doorsOpen + 1.4, E.duration, t);
    this.beamMat.uniforms.uI.value = 0.32 * open;
    const dm = this.dust.material as ShaderMaterial;
    dm.uniforms.uI.value = 1.6 * open;
    dm.uniforms.uPx.value = view.pxRatio;

    // camera: look up the shaft, settle on the doors as the cab slows, drift toward the light
    const cam = this.camera;
    fitFov(cam, 60, view.aspect, 70);
    const tilt = smootherstep(E.tiltStart, E.tiltEnd, t);
    // looking steeply up the shaft while slowly turning, then down to the doors
    const pitch = lerp(1.16, 0.02, tilt);
    const yaw = lerp(0.2 + 0.07 * Math.min(t, E.tiltEnd), 0, tilt);
    const push = smoothstep(E.doorsOpen + 0.3, E.duration, t);
    const sway = 0.004 * Math.sin(view.time * 0.9) * SHAKE;
    const bump = t > E.moveEnd ? Math.exp(-(t - E.moveEnd) * 5) * Math.sin((t - E.moveEnd) * 30) * 0.012 * SHAKE : 0;
    cam.position.set(sway, EYE + bump, lerp(0.55, -0.9, push));
    const dir = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    this.look.copy(cam.position).add(dir);
    cam.lookAt(this.look);
    cam.near = 0.03;
    cam.far = 3000;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // light shafts: cylindrical billboards from the hatch into the cab
    const src = new Vector3(0, 1.9, CORRIDOR.z1 - 1.0);
    for (const b of this.beams) {
      const x = b.userData.x as number;
      const w = b.userData.w as number;
      const end = new Vector3(x * 1.6, 0.05, 0.9);
      const start = new Vector3(x, src.y, src.z);
      const axis = end.clone().sub(start);
      const length = axis.length();
      axis.normalize();
      b.position.copy(start);
      // plane's local +Y along the beam, face turned toward the camera around it
      const toCam = cam.position.clone().sub(start);
      const side = new Vector3().crossVectors(axis, toCam).normalize();
      const normal = new Vector3().crossVectors(side, axis).normalize();
      b.matrix.makeBasis(side.multiplyScalar(w), axis.clone().multiplyScalar(length), normal);
      b.matrix.setPosition(start);
      b.matrixAutoUpdate = false;
      b.matrixWorldNeedsUpdate = true;
    }
  }

  dispose() {
    disposeTree(this.scene);
  }
}
