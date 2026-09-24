// Shot 3: Spin Transfer. Inside the outer shell a vehicle accelerates along a
// circumferential track until it matches the inner shell's ~805 m/s spin. Two
// surfaces scroll with exact box-filtered motion blur: the track tunnel (the
// stationary outer shell, streaming past faster and faster) and, through the
// slot overhead, the underside of the inner shell: a blur at first, slowing
// to stillness as the speeds match, until the docking collar glides into
// place and the clamps engage. The tunnel bends gently "up" toward the axis
// (track radius ~91 km), which hides its far end like a horizon.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Mesh,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import { IntroSet, SHAKE, ViewInfo, clamp01, disposeTree, fitFov, lerp, smoothstep } from './common';
import { F_POST, F_PRE, NOISE, PULSE, V_POST, V_PRE } from './glsl';

/** Inner shell surface speed (m/s): 805 m/s at 90 km gives ~0.73 g. */
export const SPIN_SPEED = 805;
const RC = 91_000;
const SHUTTER = 1 / 40;
const Z_COLLAR = 14;
const INNER_Y = 10.8;

/** Local times (s). */
export const TRANSFER = {
  duration: 16,
  rampStart: 1.4,
  rampLen: 11.2,
  tiltStart: 9.6,
  tiltEnd: 12.2,
  clampStart: 12.75,
  clunk: 13.35,
};

const rampX = (t: number) => clamp01((t - TRANSFER.rampStart) / TRANSFER.rampLen);

/** Vehicle speed along the track: jerk-free start, long gentle convergence. */
export function transferSpeed(t: number) {
  const x = rampX(t);
  const z = 1 - x;
  return SPIN_SPEED * (1 - z * z * z * z * (1 + 4 * x));
}
/** Distance travelled by the vehicle (m). */
function vehicleDist(t: number) {
  const x = rampX(t);
  const z = 1 - x;
  let d = SPIN_SPEED * TRANSFER.rampLen * (x - (1 / 3 - Math.pow(z, 5) + (2 / 3) * Math.pow(z, 6)));
  const end = TRANSFER.rampStart + TRANSFER.rampLen;
  if (t > end) d += SPIN_SPEED * (t - end);
  return d;
}
/** Inner-shell travel relative to the vehicle still to come before the match (m). */
function collarOffset(t: number) {
  if (t < TRANSFER.rampStart) return SPIN_SPEED * (TRANSFER.rampStart - t + TRANSFER.rampLen / 3);
  const z = 1 - rampX(t);
  return SPIN_SPEED * TRANSFER.rampLen * (Math.pow(z, 5) - (2 / 3) * Math.pow(z, 6));
}

const bendVert = /* glsl */ `
${V_PRE}
attribute float aPart;
varying vec3 vP;
varying vec3 vN;
varying float vPart;
void main() {
  vP = position;
  vN = normal;
  vPart = aPart;
  vec3 p = position;
  p.y += p.z * p.z / ${(2 * RC).toFixed(1)};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  ${V_POST}
}
`;

/** Light level along the tunnel: bumps under each wall lamp (period 15 m). */
const tunnelCommon = /* glsl */ `
uniform float uOff;
uniform float uBlur;
uniform float uTime;
float lampLight(float u, float r) {
  float x = u / 15.0;
  float rr = r / 15.0;
  return 0.25 + 0.45 * hr_bar(x, 0.5, rr) + 0.3 * hr_bar(x, 0.22, rr);
}
`;

const tunnelFrag = /* glsl */ `
${F_PRE}
${NOISE}
${PULSE}
${tunnelCommon}
varying vec3 vP;
varying vec3 vN;
varying float vPart;
void main() {
  float u = -vP.z + uOff;
  float fu = fwidth(u);
  float r = uBlur + 0.6 * fu;
  float part = floor(vPart + 0.5);
  // derivatives outside the per-part branches (undefined inside them on some drivers)
  float fxP = fwidth(vP.x) + 1e-4;
  float fyP = fwidth(vP.y) + 1e-4;
  vec3 lampC = vec3(0.72, 0.86, 1.0);
  float light = lampLight(u, r);
  float dist = length(vP);
  vec3 col = vec3(0.0);
  if (part == 0.0) {
    // floor: transverse grooves, reflector studs
    float fx = fxP;
    vec3 alb = vec3(0.04, 0.043, 0.048);
    alb *= 1.0 - 0.5 * hr_bar(u / 3.0, 0.08, r / 3.0);
    float wallGlow = smoothstep(4.0, 9.0, abs(vP.x));
    col = alb * lampC * light * (0.3 + 1.4 * wallGlow);
    float stud = hr_box(abs(vP.x), 5.0, 5.3, fx) * hr_bar(u / 6.0, 0.05, r / 6.0);
    col += vec3(1.0, 0.5, 0.12) * 6.0 * stud;
  } else if (part == 1.0) {
    // guideway sides: a continuous running light
    float fy = fyP;
    col = vec3(0.03) * light;
    col += vec3(0.25, 0.55, 1.0) * 2.5 * hr_box(vP.y, -1.95, -1.87, fy);
  } else if (part == 2.0) {
    // guideway top: polished rails reflecting the lamps, joints and centre dashes
    float fx = fxP;
    vec3 alb = vec3(0.06, 0.062, 0.07) * (1.0 - 0.6 * hr_bar(u / 18.0, 0.03, r / 18.0));
    col = alb * lampC * light * 0.8;
    float rail = hr_box(abs(vP.x), 1.15, 1.45, fx);
    float refl = lampLight(u * 0.5 + 3.0, r * 0.5);
    col += lampC * rail * (0.1 + 2.6 * refl * refl * refl);
    float dash = hr_box(vP.x, -0.1, 0.1, fx) * hr_pulse(u / 9.0, 0.22, r / 9.0);
    col += vec3(1.0, 0.75, 0.4) * 1.2 * dash;
  } else if (part == 3.0) {
    // walls: panels, ribs, glowing lamp strips, an amber stripe, distance boards
    float fy = fyP;
    float y = vP.y;
    vec3 alb = vec3(0.05, 0.053, 0.06);
    float seam = max(hr_bar(u / 3.0, 0.03, r / 3.0), hr_box(y, 0.45, 0.55, fy) + hr_box(y, 4.9, 5.0, fy));
    float rib = hr_bar(u / 15.0 + 0.5, 0.06, r / 15.0);
    alb *= (1.0 - 0.45 * seam) * (1.0 + 1.2 * rib);
    float lampRow = hr_pulse(u / 15.0, 0.34, r / 15.0);
    col = alb * lampC * light * (0.5 + 1.2 * exp(-abs(y - 2.55) * 0.5));
    col += lampC * 16.0 * hr_box(y, 2.35, 2.75, fy) * lampRow;
    col += lampC * 0.5 * exp(-abs(y - 2.55) * 1.6) * lampRow;
    float stripe = hr_box(y, -1.05, -0.85, fy);
    col += vec3(1.0, 0.55, 0.15) * 0.5 * stripe * (0.4 + light);
    float board = hr_box(y, 5.6, 7.0, fy) * hr_pulse(u / 150.0, 0.03, r / 150.0);
    col += vec3(0.9, 0.95, 1.0) * 1.2 * board;
  } else if (part == 4.0) {
    // chamfer: small downlights
    float fy = fyP;
    col = vec3(0.04) * lampC * light;
    col += lampC * 7.0 * hr_pulse(u / 15.0 + 0.25, 0.05, r / 15.0) * hr_box(vP.y, 8.25, 8.55, fy);
  } else if (part == 5.0) {
    // ceiling beside the slot: dark panels and ribs
    vec3 alb = vec3(0.035, 0.037, 0.042) * (1.0 + 1.2 * hr_bar(u / 15.0 + 0.5, 0.06, r / 15.0));
    col = alb * lampC * light;
  } else {
    // slot edges: magnetic bearing strips
    float fy = fyP;
    col = vec3(0.025) * light;
    col += vec3(0.45, 0.5, 1.0) * 3.5 * hr_box(vP.y, 9.75, 9.88, fy);
    col += vec3(0.45, 0.5, 1.0) * 1.4 * hr_box(vP.y, 10.25, 10.32, fy);
  }
  // the far end dissolves into a faint cool haze
  float fog = 1.0 - exp(-dist / 700.0);
  col = mix(col, vec3(0.02, 0.028, 0.04), fog);
  gl_FragColor = vec4(col, 1.0);
  ${F_POST}
}
`;

const innerFrag = /* glsl */ `
${F_PRE}
${NOISE}
${PULSE}
uniform float uInnerOff;
uniform float uCollarOff;
uniform float uIBlur;
uniform float uDock;
uniform float uTime;
varying vec3 vP;
varying vec3 vN;
varying float vPart;
void main() {
  float q = -vP.z + uInnerOff;
  float qc = -vP.z + uCollarOff;
  float fq = fwidth(q);
  float r = uIBlur + 0.6 * fq;
  float x = vP.x;
  float fx = fwidth(x) + 1e-4;
  // warm-lit plating: the inner shell carries the world
  vec3 alb = vec3(0.16, 0.13, 0.1);
  float seam = max(hr_bar(q / 6.0, 0.04, r / 6.0), hr_box(abs(x), 1.9, 2.0, fx));
  float rivets = hr_box(abs(x), 3.2, 3.35, fx) * hr_bar(q / 1.5, 0.2, r / 1.5);
  float grime = hr_vn2(vec2(x * 0.8, q * 0.08), 0.0).x;
  float grimeBlur = 1.0 / (1.0 + r * 0.25);
  alb *= (1.0 - 0.55 * seam) * (0.8 + 0.4 * mix(0.5, grime, grimeBlur)) + 0.2 * rivets;
  vec3 col = alb * vec3(0.55, 0.6, 0.7) * 0.9;
  // amber running lights and the central clamp rail
  float lamp = hr_box(abs(x), 2.4, 2.9, fx) * hr_pulse(q / 24.0, 0.12, r / 24.0);
  col += vec3(1.0, 0.62, 0.22) * 9.0 * lamp;
  col += vec3(0.8, 0.8, 0.85) * 0.6 * hr_box(x, -0.3, 0.3, fx);
  // docking collar: a heavy dark ring with a glowing hatch rim, frame lights and latch sockets
  float c0 = ${(Z_COLLAR - 6).toFixed(1)};
  float c1 = ${(Z_COLLAR + 6).toFixed(1)};
  float inC = hr_box(qc, c0, c1, r) * hr_box(x, -3.8, 3.8, fx);
  if (inC > 0.0) {
    float blink = 0.3 + 0.7 * step(0.5, fract(uTime * 1.4));
    vec3 lc = mix(vec3(1.0, 0.5, 0.08) * blink, vec3(0.15, 1.0, 0.4), uDock);
    float lit = 0.5 + 0.5 * hr_pulse(q / 24.0 + 0.1, 0.5, r / 24.0);
    // frame: a raised band around the edge with a bright machined lip
    float edge = min(min(qc - c0, c1 - qc), 3.8 - abs(x));
    float frame = 1.0 - smoothstep(0.9, 1.1, edge);
    float lip = hr_box(edge, 0.9, 1.05, max(r, fx));
    vec3 cc = mix(vec3(0.05, 0.05, 0.055), vec3(0.16, 0.15, 0.14), frame) * lit;
    cc += vec3(0.7, 0.72, 0.75) * 0.35 * lip;
    // hazard marks on the frame ends only
    float chev = step(0.5, fract((qc + abs(x)) * 0.6)) * frame * (1.0 - hr_box(x, -2.8, 2.8, fx));
    cc = mix(cc, vec3(0.3, 0.2, 0.03) * lit, chev * 0.7);
    // hatch with a glowing rim
    vec2 hp = vec2(abs(x) / 1.7, abs(qc - ${Z_COLLAR.toFixed(1)}) / 3.2);
    float hd = length(max(hp - 0.6, 0.0)) + min(max(hp.x, hp.y) - 0.6, 0.0);
    float hatch = 1.0 - smoothstep(0.38, 0.42, hd);
    cc = mix(cc, vec3(0.012), hatch);
    cc += lc * 2.2 * (1.0 - smoothstep(0.0, 0.035, abs(hd - 0.4)));
    col = mix(col, cc, inC);
    // frame lights
    float lq = hr_pulse((qc - c0) / 3.0 + 0.45, 0.1, r / 3.0) * hr_box(abs(x), 3.3, 3.5, fx) * inC;
    col += lc * 12.0 * lq;
    // latch sockets
    float sock = hr_box(qc, ${(Z_COLLAR - 1.0).toFixed(2)}, ${(Z_COLLAR + 1.0).toFixed(2)}, r) * hr_box(abs(x), 2.1, 2.7, fx);
    col = mix(col, vec3(0.005), sock);
    col += lc * 4.0 * sock * (hr_box(abs(x), 2.1, 2.18, fx) + hr_box(abs(x), 2.62, 2.7, fx));
  }
  gl_FragColor = vec4(col, 1.0);
  ${F_POST}
}
`;

const vehicleVert = /* glsl */ `
${V_PRE}
varying vec3 vP;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xyz;
  vL = position;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
  ${V_POST}
}
`;
const vehicleFrag = /* glsl */ `
${F_PRE}
${NOISE}
${PULSE}
${tunnelCommon}
uniform float uKind;  // 0 vehicle roof, 1 clamp arm
uniform float uDock;
varying vec3 vP;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  float u = -vP.z + uOff;
  vec3 lampC = vec3(0.78, 0.9, 1.0);
  vec3 col;
  if (uKind < 0.5) {
    // glossy roof: moving reflections of the wall lamps
    float refl = lampLight(u * 0.6, uBlur * 0.6 + 0.5);
    col = vec3(0.006) + lampC * (0.02 + 0.22 * fres) * refl * refl * refl;
    float fx = fwidth(vP.x) + 1e-4;
    col += vec3(1.0, 0.55, 0.15) * 2.5 * hr_box(abs(vP.x), 0.86, 0.92, fx);
  } else {
    vec3 alb = vec3(0.16, 0.16, 0.17);
    float ll = lampLight(u, uBlur);
    col = alb * (0.2 + 0.7 * max(N.z, 0.0) + 0.5 * abs(N.x)) * ll * 0.7;
    col += lampC * (0.08 + 0.5 * fres) * ll;
    float fx = fwidth(vL.x) + 1e-4;
    col += lampC * 0.25 * hr_box(abs(vL.x), 0.18, 0.21, fx);
    float fy = fwidth(vL.y) + 1e-4;
    vec3 ind = mix(vec3(1.0, 0.55, 0.1), vec3(0.2, 1.0, 0.45), uDock);
    col += ind * 4.0 * hr_box(vL.y, 0.44, 0.47, fy);
  }
  gl_FragColor = vec4(col, 1.0);
  ${F_POST}
}
`;

export class TransferSet implements IntroSet {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, 16 / 9, 0.05, 6000);
  private tunnelMat: ShaderMaterial;
  private innerMat: ShaderMaterial;
  private roofMat: ShaderMaterial;
  private armMat: ShaderMaterial;
  private arms: Mesh[] = [];
  private heads: Mesh[] = [];
  private roof: Mesh;
  private look = new Vector3();

  constructor() {
    this.scene.background = new Color(0, 0, 0);
    const shared = { uOff: { value: 0 }, uBlur: { value: 0 }, uTime: { value: 0 } };
    this.tunnelMat = new ShaderMaterial({ vertexShader: bendVert, fragmentShader: tunnelFrag, uniforms: shared });
    this.innerMat = new ShaderMaterial({
      vertexShader: bendVert,
      fragmentShader: innerFrag,
      uniforms: {
        uInnerOff: { value: 0 },
        uCollarOff: { value: 0 },
        uIBlur: { value: 0 },
        uDock: { value: 0 },
        uTime: shared.uTime,
      },
    });
    const tunnel = new Mesh(this.buildTunnel(), this.tunnelMat);
    tunnel.frustumCulled = false;
    this.scene.add(tunnel);
    const inner = new Mesh(this.buildStrip([[4.4, INNER_Y], [-4.4, INNER_Y]], 7), this.innerMat);
    inner.frustumCulled = false;
    this.scene.add(inner);

    const dock = { value: 0 };
    this.roofMat = new ShaderMaterial({
      vertexShader: vehicleVert,
      fragmentShader: vehicleFrag,
      uniforms: { ...shared, uKind: { value: 0 }, uDock: dock },
    });
    this.armMat = new ShaderMaterial({
      vertexShader: vehicleVert,
      fragmentShader: vehicleFrag,
      uniforms: { ...shared, uKind: { value: 1 }, uDock: dock },
    });
    // the vehicle's roof ahead of the cab
    this.roof = new Mesh(new BoxGeometry(2.0, 0.6, 18), this.roofMat);
    this.roof.position.set(0, -1.25, -10.5);
    this.scene.add(this.roof);
    // clamp arms: rise from the roof to the collar's latch sockets
    for (const x of [-2.4, 2.4]) {
      const g = new BoxGeometry(0.42, 1, 0.9);
      g.translate(0, 0.5, 0);
      const arm = new Mesh(g, this.armMat);
      arm.position.set(x, -1.0, -Z_COLLAR);
      this.arms.push(arm);
      this.scene.add(arm);
      const head = new Mesh(new BoxGeometry(0.8, 0.5, 1.5), this.armMat);
      head.position.set(x, -1.0, -Z_COLLAR);
      this.heads.push(head);
      this.scene.add(head);
    }
  }

  /** Extrude a cross-section polyline along the track (z), one part id per strip. */
  private buildStrip(section: [number, number][], part: number, pos: number[] = [], nor: number[] = [], prt: number[] = [], idx: number[] = []) {
    const zs: number[] = [];
    const K = 120;
    for (let k = 0; k <= K; k++) zs.push(40 - 1840 * Math.pow(k / K, 1.7));
    for (let s = 0; s + 1 < section.length; s++) {
      const [x0, y0] = section[s];
      const [x1, y1] = section[s + 1];
      // inward normal: left of the segment direction when walking the outline
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len;
      const ny = dx / len;
      const base = pos.length / 3;
      for (const z of zs) {
        pos.push(x0, y0, z, x1, y1, z);
        nor.push(nx, ny, 0, nx, ny, 0);
        prt.push(part, part);
      }
      for (let k = 0; k < K; k++) {
        const a = base + k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geo.setAttribute('aPart', new Float32BufferAttribute(prt, 1));
    geo.setIndex(idx);
    return geo;
  }

  private buildTunnel() {
    const pos: number[] = [];
    const nor: number[] = [];
    const prt: number[] = [];
    const idx: number[] = [];
    const add = (sec: [number, number][], part: number) => this.buildStrip(sec, part, pos, nor, prt, idx);
    // walked counter-clockwise (interior on the left, which is the front face)
    add([[-9, -2.2], [-2.2, -2.2]], 0);
    add([[-2.2, -2.2], [-2.2, -1.6]], 1);
    add([[-2.2, -1.6], [2.2, -1.6]], 2);
    add([[2.2, -1.6], [2.2, -2.2]], 1);
    add([[2.2, -2.2], [9, -2.2]], 0);
    add([[9, -2.2], [9, 7.6]], 3);
    add([[9, 7.6], [7.4, 9.2]], 4);
    add([[7.4, 9.2], [3.4, 9.2]], 5);
    add([[3.4, 9.2], [3.4, 10.5]], 6);
    add([[-3.4, 10.5], [-3.4, 9.2]], 6);
    add([[-3.4, 9.2], [-7.4, 9.2]], 5);
    add([[-7.4, 9.2], [-9, 7.6]], 4);
    return add([[-9, 7.6], [-9, -2.2]], 3);
  }

  update(t: number, view: ViewInfo) {
    const T = TRANSFER;
    const v = transferSpeed(t);
    const shutter = Math.max(SHUTTER, view.dt);
    const cam = this.camera;
    // speed widens the view a little; the cab tilts up to watch the collar arrive
    fitFov(cam, 58 + 8 * (v / SPIN_SPEED) * (1 - smoothstep(T.tiltStart, T.tiltEnd, t)), view.aspect, 72);
    const tilt = smoothstep(T.tiltStart, T.tiltEnd, t);
    const pitch = lerp(0.07, 0.62, tilt);
    // vibration grows with speed and acceleration; a hard clunk when the clamps bite
    const acc = (transferSpeed(t + 0.05) - transferSpeed(t - 0.05)) / 0.1;
    const vib = (0.0012 * (v / SPIN_SPEED) + 0.004 * clamp01(acc / 150)) * SHAKE;
    const tc = t - T.clunk;
    const clunk = tc > 0 ? Math.exp(-tc * 7) : 0;
    const s1 = Math.sin(view.time * 71.0) * vib + Math.sin(view.time * 13.0 + 1.3) * vib * 0.6;
    const s2 = Math.sin(view.time * 53.0 + 0.7) * vib;
    const jolt = clunk * (Math.sin(tc * 38) * 0.035) * Math.max(SHAKE, 0.25);
    const lift = smoothstep(T.clampStart, T.clunk, t) * 0.35;
    cam.position.set(-0.9 + s2 * 0.5, lift + jolt * 2.0, 0);
    this.look.set(-0.9 + 0.6 + Math.sin(s1) * 10, Math.tan(pitch + s1 + jolt) * 10 + lift, -10);
    cam.lookAt(this.look);
    cam.rotateZ(s2 * 0.6 + jolt * 0.3);
    cam.near = 0.05;
    cam.far = 6000;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const tu = this.tunnelMat.uniforms;
    tu.uOff.value = vehicleDist(t) % 1800;
    tu.uBlur.value = 0.5 * v * shutter;
    tu.uTime.value = view.time;
    const iu = this.innerMat.uniforms;
    const co = collarOffset(t);
    iu.uInnerOff.value = co % 1440;
    iu.uCollarOff.value = Math.min(co, 5000);
    iu.uIBlur.value = 0.5 * (SPIN_SPEED - v) * shutter;
    iu.uDock.value = smoothstep(T.clunk - 0.05, T.clunk + 0.25, t);
    // clamp arms extend up to the sockets
    const ext = smoothstep(T.clampStart, T.clunk, t);
    const top = INNER_Y - 0.05;
    this.roof.position.y = -1.25 + lift;
    this.arms.forEach((arm, i) => {
      arm.position.y = -1.0 + lift;
      arm.visible = ext > 0.001;
      arm.scale.y = Math.max(0.001, ext * (top - 0.5 - arm.position.y));
      const head = this.heads[i];
      head.visible = arm.visible;
      head.position.y = arm.position.y + arm.scale.y + 0.25;
    });
  }

  dispose() {
    disposeTree(this.scene);
  }
}
