// Directional "tube" light + hemisphere ambient, driven by the day/night model.
// Light directions live in the local unrolled frame (see render/bend.ts):
// every surface is shaded as if the tube were directly above it.

import { Color, DirectionalLight, HemisphereLight, Object3D, Vector3 } from 'three';
import { U } from '../render/uniforms';
import { computeSky, type SkyState, sunDirection } from './daynight';

export class Lighting {
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly target = new Object3D();
  state: SkyState;
  readonly sunDir = new Vector3(0, 1, 0);
  shadowRange = 90;
  /** Golden-hour artistic liberty: light zone along the axis at dawn/dusk. */
  liberty = true;
  private tmp = new Vector3();

  constructor() {
    this.sun = new DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowRange;
    cam.right = this.shadowRange;
    cam.top = this.shadowRange;
    cam.bottom = -this.shadowRange;
    cam.near = 1;
    cam.far = 1200;
    this.sun.target = this.target;
    this.hemi = new HemisphereLight(0xb0c8ea, 0x5e5038, 1);
    this.state = computeSky(0.68);
  }

  setShadowQuality(size: number, range: number) {
    this.shadowRange = range;
    this.sun.shadow.mapSize.set(size, size);
    const cam = this.sun.shadow.camera;
    cam.left = -range;
    cam.right = range;
    cam.top = range;
    cam.bottom = -range;
    cam.updateProjectionMatrix();
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as never;
  }

  update(timeOfDay: number, camPos: Vector3) {
    const st = computeSky(timeOfDay, this.state);
    if (!this.liberty) st.elevation = Math.PI / 2;
    sunDirection(st, this.sunDir);
    // Shadow frustum follows the camera, snapped to texels to avoid shimmer.
    const texel = (2 * this.shadowRange) / this.sun.shadow.mapSize.x;
    this.tmp.copy(camPos);
    this.tmp.x = Math.round(this.tmp.x / texel) * texel;
    this.tmp.y = Math.round(this.tmp.y / texel) * texel;
    this.tmp.z = Math.round(this.tmp.z / texel) * texel;
    this.target.position.copy(this.tmp);
    this.target.updateMatrixWorld();
    this.sun.position.copy(this.tmp).addScaledVector(this.sunDir, 500);
    this.sun.color.copy(st.sunColor);
    this.sun.intensity = st.sunIntensity * 2.8;
    this.sun.castShadow = st.sunIntensity > 0.3;
    this.hemi.color.copy(st.hemiSky);
    this.hemi.groundColor.copy(st.hemiGround);
    this.hemi.intensity = st.hemiIntensity * 2.0;
    // shared shader uniforms
    U.uSunDir.value.copy(this.sunDir);
    U.uSunColor.value.copy(st.sunColor).multiplyScalar(st.sunIntensity * 0.16);
    U.uAmbientScatter.value.copy(st.ambientScatter).multiplyScalar(0.62);
    U.uSkyZenith.value.copy(st.zenith).multiplyScalar(0.8);
    U.uSkyHorizon.value.copy(st.horizon).multiplyScalar(0.75);
    U.uSunGlow.value.copy(st.glow).multiplyScalar(0.35 + st.sunIntensity * 0.08);
    U.uNight.value = st.night;
    U.uTubeColor.value.copy(st.tube).multiplyScalar(1.5 + st.sunIntensity);
    U.uHemiSky.value.copy(st.hemiSky);
    U.uHemiGround.value.copy(st.hemiGround);
    U.uWaterFog.value.copy(_wf.set(0.03, 0.14, 0.13).multiplyScalar(0.4 + st.sunIntensity * 0.25));
    return st;
  }
}

const _wf = new Color();
