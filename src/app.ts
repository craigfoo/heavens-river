// Application: owns the renderer, the world streaming and the game loop.

import { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { CIRC, R, Z_MAX, Z_MIN } from './config';
import { frame } from './coords/cylinder';
import { mod } from './core/math';
import { Pipeline } from './render/pipeline';
import { U } from './render/uniforms';
import { Lighting } from './sky/lighting';
import { SkyBackground } from './sky/sky';
import { Input } from './player/input';
import { Player } from './player/player';
import { WorldGen } from './world/gen/world';
import { WorldQuery } from './world/worldQuery';
import { TerrainManager } from './world/terrain/terrainManager';

export const WORLD_SEED = 0x5eed;

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly pipeline: Pipeline;
  readonly lighting = new Lighting();
  readonly sky = new SkyBackground();
  readonly input: Input;
  readonly player = new Player();
  terrain: TerrainManager;
  gen: WorldGen;
  world: WorldQuery;
  section = 0;
  timeOfDay = 0.68;
  dayMinutes = 20;
  timeFrozen = false;
  private last = performance.now();
  elapsed = 0;
  fps = 60;
  private frameCount = 0;
  private fpsTimer = 0;
  private camQ = new Quaternion();
  private tmpQ = new Quaternion();
  private axisZ = new Vector3(0, 0, 1);
  private axisY = new Vector3(0, 1, 0);
  private axisX = new Vector3(1, 0, 0);
  onFrame: ((dt: number) => void)[] = [];
  readonly testMode: boolean;
  debugText: HTMLDivElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 4.0e6);
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const test = new URLSearchParams(location.search).has('test');
    this.testMode = test;
    this.pipeline = new Pipeline(canvas, this.scene, this.camera, {
      msaa: test ? 0 : mobile ? 0 : 4,
      pixelRatio: test ? 1 : Math.min(window.devicePixelRatio, mobile ? 1.5 : 2),
      shadows: true,
    });
    this.pipeline.setHorizontalFov(100);
    this.input = new Input(canvas);
    this.gen = new WorldGen(this.section, WORLD_SEED);
    this.world = new WorldQuery(this.gen);
    const workers = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    this.terrain = new TerrainManager(workers);
    if (mobile) this.terrain.lodK = 1.6;
    this.terrain.setSection(this.section, WORLD_SEED);
    this.scene.add(this.terrain.group);
    this.scene.add(this.sky.mesh);
    this.scene.add(this.lighting.sun, this.lighting.target, this.lighting.hemi);
    this.debugText = document.createElement('div');
    this.debugText.style.cssText =
      'position:fixed;left:8px;bottom:8px;font:11px/1.35 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.35);padding:6px 8px;border-radius:6px;white-space:pre;pointer-events:none;z-index:50';
    document.body.appendChild(this.debugText);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    this.pipeline.resize(window.innerWidth, window.innerHeight);
  }

  /** Put the player somewhere and make the render frame follow. */
  spawn(s: number, z: number, yaw = 0) {
    this.player.teleport(s, z, this.world, yaw);
    frame.maybeRebase(this.player.s, this.player.z, true);
  }

  updateCamera() {
    const p = this.player;
    const eye = p.eyeH;
    frame.maybeRebase(p.s, p.z);
    frame.toRender(p.s, p.z, eye, this.camera.position);
    const th = frame.thetaAt(p.s);
    this.camQ.setFromAxisAngle(this.axisZ, th);
    this.tmpQ.setFromAxisAngle(this.axisY, p.yaw);
    this.camQ.multiply(this.tmpQ);
    this.tmpQ.setFromAxisAngle(this.axisX, p.pitch);
    this.camQ.multiply(this.tmpQ);
    this.camera.quaternion.copy(this.camQ);
    this.camera.updateMatrixWorld();
    // world-anchored pattern offsets
    U.uOriginMod.value.set(mod(frame.originS, 4096), mod(frame.originZ, 4096));
    U.uOriginModBig.value.set(mod(frame.originS, 65536), mod(frame.originZ, 65536));
  }

  tick() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.step(dt);
    requestAnimationFrame(() => this.tick());
  }

  /** Advance the simulation by dt and render one frame. */
  step(dt: number, render = true) {
    this.elapsed += dt;
    U.uTime.value = this.elapsed;
    if (!this.timeFrozen) this.timeOfDay = mod(this.timeOfDay + dt / (this.dayMinutes * 60), 1);
    const inp = this.input.poll();
    this.player.update(dt, inp, this.world);
    for (const f of this.onFrame) f(dt);
    this.updateCamera();
    this.lighting.update(this.timeOfDay, this.camera.position);
    U.uStarRot.value = this.timeOfDay * Math.PI * 2 * 0.25;
    // underwater state for all materials
    const wl = this.player.waterLevel;
    const eye = this.player.eyeH;
    const under = eye < wl - 0.02;
    U.uUnderwater.value = under ? 1 : 0;
    U.uWaterY.value = under ? frame.toRender(this.player.s, this.player.z, wl, _v).y : -1e9;
    this.pipeline.grading.u('underwater').value = under ? 1 : 0;
    this.pipeline.grading.u('time').value = this.elapsed;
    this.pipeline.grading.u('exposure').value = this.lighting.state.exposure;
    this.terrain.update({ s: this.player.s, z: this.player.z, h: eye });
    this.sky.update(this.camera, Z_MIN - frame.originZ, Z_MAX - frame.originZ);
    if (render) this.pipeline.render(dt);
    this.stats(dt);
  }

  private stats(dt: number) {
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer > 0.5) {
      this.fps = this.frameCount / this.fpsTimer;
      this.frameCount = 0;
      this.fpsTimer = 0;
      const info = this.pipeline.renderer.info;
      const t = this.terrain.stats;
      const p = this.player;
      this.debugText.textContent =
        `${this.fps.toFixed(0)} fps  draws ${info.render.calls}  tris ${(info.render.triangles / 1e6).toFixed(2)}M\n` +
        `chunks ${t.visible}/${t.cached} pending ${t.pending}  trees ${this.terrain.trees.count}\n` +
        `s ${p.s.toFixed(1)}  z ${p.z.toFixed(1)}  h ${p.h.toFixed(2)}  ${p.mode}${p.quad ? ' (quad)' : ''}\n` +
        `water ${p.waterLevel > -1e8 ? p.waterLevel.toFixed(2) : '-'}  θ ${((p.s / R) * 180 / Math.PI).toFixed(3)}°  circ ${(CIRC / 1000).toFixed(0)} km`;
    }
  }

  start() {
    this.last = performance.now();
    requestAnimationFrame(() => this.tick());
  }
}

const _v = new Vector3();
