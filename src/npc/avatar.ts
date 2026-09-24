// The player's own Quinlan body. In first person it only casts a shadow (so
// you see yourself walking in the low sun); in photo mode it is drawn.

import { Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three';
import { frame, wrapS } from '../coords/cylinder';
import { damp } from '../core/math';
import type { Player } from '../player/player';
import { patchWorldMaterial } from '../render/bend';
import { U } from '../render/uniforms';
import { createQuinlanGeometry, createQuinlanInstancedGeometry, quinlanAnimGlsl, quinlanAnimParsGlsl, quinlanFurPalette, QUINLAN_GAIT, QUINLAN_NOMINAL_SPEED } from './quinlanModel';
import { quinlanDepthMaterial, quinlanWorldMaterial } from './quinlanMaterials';

/** Poses selectable in photo mode (null = follow the player's movement). */
export const AVATAR_POSES: { name: string; gait: number }[] = [
  { name: 'Natural', gait: -1 },
  { name: 'Idle', gait: QUINLAN_GAIT.idle },
  { name: 'Smile', gait: QUINLAN_GAIT.smile },
  { name: 'Sing', gait: QUINLAN_GAIT.sing },
  { name: 'Walk', gait: QUINLAN_GAIT.walk },
  { name: 'Run', gait: QUINLAN_GAIT.run },
  { name: 'Swim', gait: QUINLAN_GAIT.swim },
];

export class PlayerAvatar {
  readonly mesh: InstancedMesh;
  private anim: InstancedBufferAttribute;
  private shadowOnly: MeshLambertMaterial;
  private visibleMat: MeshLambertMaterial;
  private gait = 0;
  private clock = 0;
  readonly variant = 4242;
  /** Pose override index into AVATAR_POSES (0 = natural). */
  pose = 0;
  /** Freeze the animation clock (photo mode time freeze). */
  frozen = false;

  constructor() {
    const geo = createQuinlanInstancedGeometry(createQuinlanGeometry('high'), 1);
    this.visibleMat = quinlanWorldMaterial();
    this.shadowOnly = patchWorldMaterial(new MeshLambertMaterial({ vertexColors: true, colorWrite: false, depthWrite: false }), {
      key: 'quinlan',
      bend: true,
      vertexPars: quinlanAnimParsGlsl,
      vertexBegin: quinlanAnimGlsl,
    });
    this.mesh = new InstancedMesh(geo, this.shadowOnly, 1);
    this.mesh.name = 'player avatar';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = quinlanDepthMaterial();
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.matrixWorld.identity();
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, quinlanFurPalette(this.variant, new Color()));
    this.anim = geo.getAttribute('aAnim') as InstancedBufferAttribute;
    this.anim.setUsage(DynamicDrawUsage);
  }

  setVisible(v: boolean) {
    this.mesh.material = v ? this.visibleMat : this.shadowOnly;
  }

  update(dt: number, p: Player) {
    let target: number = QUINLAN_GAIT.idle;
    let rate = 1;
    let h = p.h;
    if (p.mode === 'swim' || p.mode === 'dive') {
      target = QUINLAN_GAIT.swim;
      rate = Math.max(0.35, p.speed / QUINLAN_NOMINAL_SPEED.swim);
      h = p.mode === 'swim' && p.waterLevel > -1e8 ? p.waterLevel : p.h + 0.6;
    } else if (p.mode === 'walk' && p.speed > 0.25) {
      target = p.quad ? QUINLAN_GAIT.run : QUINLAN_GAIT.walk;
      rate = p.speed / (p.quad ? QUINLAN_NOMINAL_SPEED.run : QUINLAN_NOMINAL_SPEED.walk);
    }
    const forced = AVATAR_POSES[this.pose]?.gait ?? -1;
    if (forced >= 0) {
      target = forced;
      rate = 1;
    }
    if (Math.abs(target - this.gait) > 1.01) this.gait = target;
    else this.gait = damp(this.gait, target, 8, dt);
    // drive the animation clock ourselves so speed changes never make the cycle jump
    if (!this.frozen) this.clock += dt * rate;
    const t = Math.max(1e-3, U.uTime.value);
    const a = this.anim.array as Float32Array;
    a[0] = this.gait;
    a[1] = 0;
    a[2] = this.clock / t;
    a[3] = this.variant;
    this.anim.needsUpdate = true;
    _q.setFromAxisAngle(_up, p.yaw);
    _p.set(wrapS(p.s - frame.originS), h, p.z - frame.originZ);
    _m.compose(_p, _q, _one);
    this.mesh.setMatrixAt(0, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _one = new Vector3(1, 1, 1);
const _up = new Vector3(0, 1, 0);
