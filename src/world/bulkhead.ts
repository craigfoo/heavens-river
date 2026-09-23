// Debug x-ray of the structural bulkheads inside the barrier mountains
// (spec 4.3): an annulus across the cylinder at each section end, from the
// base shell up to the high barrier core, drawn through the terrain.

import { AdditiveBlending, Group, Mesh, RingGeometry, ShaderMaterial } from 'three';
import { L, R } from '../config';
import { frame } from '../coords/cylinder';

const HEIGHT = 9_000;

const vertex = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragment = /* glsl */ `
uniform float uR;
uniform float uTime;
varying vec2 vP;
void main() {
  float r = length(vP);
  float a = atan(vP.y, vP.x);
  float h = uR - r; // height above the base shell
  float fr = fwidth(h);
  float fa = fwidth(a) * r;
  // girders every 500 m of height and every ~2 km around
  float ring = 1.0 - smoothstep(0.0, fr * 1.5, abs(fract(h / 500.0 + 0.5) - 0.5) * 500.0);
  float spoke = 1.0 - smoothstep(0.0, fa * 1.5, abs(fract(a * uR / 2000.0 + 0.5) - 0.5) * 2000.0);
  float edge = 1.0 - smoothstep(0.0, fr * 3.0, min(h, ${HEIGHT.toFixed(1)} - h));
  float pulse = 0.75 + 0.25 * sin(uTime * 1.5 - h * 0.002);
  vec3 col = vec3(0.35, 0.8, 1.0) * (max(ring, spoke) * 0.55 + edge) * pulse + vec3(0.03, 0.08, 0.12);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Bulkheads {
  readonly group = new Group();
  private rings: Mesh[] = [];
  private material: ShaderMaterial;

  constructor(uTime: { value: number }) {
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uR: { value: R }, uTime },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const g = new RingGeometry(R - HEIGHT, R, 720, 12);
    for (let i = 0; i < 2; i++) {
      const m = new Mesh(g, this.material);
      m.frustumCulled = false;
      m.renderOrder = 2_000_000;
      this.rings.push(m);
      this.group.add(m);
    }
    this.group.visible = false;
    this.group.name = 'bulkheads (debug)';
  }

  get visible() {
    return this.group.visible;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  /** Keep the rings centred on the axis in the current render frame. */
  update() {
    if (!this.group.visible) return;
    const zs = [0, L];
    this.rings.forEach((m, i) => {
      m.position.set(0, R, zs[i] - frame.originZ);
      m.updateMatrixWorld();
    });
  }
}
