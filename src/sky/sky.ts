// Background: everything a ray sees when no geometry is drawn — the diffuse
// hologram, the haze toward the section ends, and (in Bob mode) the light
// tube running down the axis. Drawn after opaque geometry at depth = 1 so
// early-z skips covered pixels.

import {
  BufferGeometry,
  Float32BufferAttribute,
  LessEqualDepth,
  Mesh,
  ShaderMaterial,
  Vector2,
} from 'three';
import { atmosphereParsGlsl } from '../render/atmosphereGlsl';
import { U } from '../render/uniforms';

const vertex = /* glsl */ `
varying vec3 vDir;
void main() {
  // ray from the projection scale factors (unprojecting the far plane is
  // numerically unstable with a 0.05 m .. 4000 km depth range)
  vec3 view = vec3(position.x / projectionMatrix[0][0], position.y / projectionMatrix[1][1], -1.0);
  // camera-to-world rotation from the view matrix (works for any camera
  // rendering the scene, e.g. the Quinlan-vision sub-views)
  vDir = transpose(mat3(viewMatrix)) * view;
  gl_Position = vec4(position.xy, 0.999999, 1.0);
}
`;

const fragment = /* glsl */ `
${atmosphereParsGlsl}
uniform vec2 uZRange;
uniform vec3 uTubeColor;
uniform float uTubeRadius;
uniform vec2 uTubeZone;
uniform vec3 uFarLand;
uniform float uPixelAngle;
varying vec3 vDir;

void main() {
  vec3 c = cameraPosition;
  vec3 d = normalize(vDir);
  // exit through the cylinder wall r = R
  vec2 q0 = vec2(c.x, c.y - uR);
  float A = dot(d.xy, d.xy);
  float B = dot(q0, d.xy);
  float C = dot(q0, q0) - uR * uR;
  float tWall = 4.0e6;
  if (A > 1e-9) {
    float disc = max(B * B - A * C, 0.0);
    tWall = (-B + sqrt(disc)) / A;
  }
  float tEnd = 4.0e6;
  if (d.z > 1e-6) tEnd = (uZRange.y - c.z) / d.z;
  else if (d.z < -1e-6) tEnd = (uZRange.x - c.z) / d.z;
  bool hitsWall = tWall < tEnd;
  float D = min(min(tWall, tEnd), 4.0e6);
  vec3 p = c + d * D;
  vec3 base = hitsWall ? uFarLand * (0.35 + 0.65 * uSunColor * 0.3) : uAmbientScatter;
  vec3 col = hrComposite(base, p, c);

  // light tube along the axis (visible only when the hologram is off; the
  // axis lies inside the hologram shell). No derivatives in here: they are
  // undefined inside per-pixel branches and some drivers return Inf/NaN.
  if (A > 1e-9 && uHoloOn < 0.999) {
    vec2 toAxis = vec2(0.0, uR) - c.xy;
    float tc = dot(toAxis, d.xy) / A;
    if (tc > 0.0 && tc < D) {
      vec3 pc = c + d * tc;
      float dist = length(pc.xy - vec2(0.0, uR));
      float px = max(tc * uPixelAngle * 1.5, 1.0);
      float core = smoothstep(uTubeRadius + px, uTubeRadius - px, dist);
      float halo = exp(-dist / (uTubeRadius * 10.0)) * 0.25 + exp(-dist / (uTubeRadius * 60.0)) * 0.05;
      float zq = (pc.z - uTubeZone.x) / 60000.0;
      float zone = 1.0 + uTubeZone.y * exp(-zq * zq);
      vec2 od = hrOpticalDepth(c, pc);
      vec3 T = exp(-(uBetaR * od.x + vec3(uBetaM * od.y)));
      // the axis lies inside the hologram shell, so the hologram always hides it
      float vis = 1.0 - uHoloOn;
      col += uTubeColor * (core * 6.0 + halo) * zone * T * vis;
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export class SkyBackground {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  constructor() {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        ...U,
        uZRange: { value: new Vector2(-1e7, 1e7) },
        uFarLand: { value: U.uHemiGround.value.clone().multiplyScalar(0.8) },
        uPixelAngle: { value: 0.001 },
      },
      depthWrite: false,
      depthTest: true,
      depthFunc: LessEqualDepth,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1_000_000;
  }

  /** pixelAngle: angle subtended by one screen pixel (radians), for anti-aliasing the tube. */
  update(zMinRender: number, zMaxRender: number, pixelAngle = 0.001) {
    this.material.uniforms.uZRange.value.set(zMinRender, zMaxRender);
    this.material.uniforms.uPixelAngle.value = pixelAngle;
  }
}
