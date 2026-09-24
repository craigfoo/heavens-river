// Application: owns the renderer, the world streaming and the game loop.

import { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { CIRC, R, Z_MAX, Z_MIN } from './config';
import { frame } from './coords/cylinder';
import { mod, smoothstep } from './core/math';
import { Pipeline } from './render/pipeline';
import { U } from './render/uniforms';
import { Lighting } from './sky/lighting';
import { SkyBackground } from './sky/sky';
import { Input } from './player/input';
import { Player } from './player/player';
import { WorldGen } from './world/gen/world';
import { WorldQuery } from './world/worldQuery';
import { TerrainManager } from './world/terrain/terrainManager';
import { GrassField } from './world/vegetation/grass';
import { TownManager } from './towns/townManager';
import { Portals } from './world/portals';
import { Hatch } from './world/hatch';
import { Bulkheads } from './world/bulkhead';
import { UnderwaterLife } from './world/underwater';
import { TownLife } from './npc/townLife';
import { loadQuinlanAsset } from './npc/quinlanAsset';
import { PlayerAvatar } from './npc/avatar';
import { SurveillanceBirds } from './npc/birds';
import { newSample } from './world/gen/world';
import { SECTION_COUNT } from './config';

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
  readonly grass = new GrassField();
  towns: TownManager;
  readonly portals = new Portals();
  readonly hatch = new Hatch();
  readonly bulkheads = new Bulkheads(U.uTime);
  readonly underwater = new UnderwaterLife();
  readonly life: TownLife;
  readonly avatar = new PlayerAvatar();
  readonly birds: SurveillanceBirds;
  private camSample = newSample();
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
  /** When set, the camera shows this pose instead of the player's eyes. */
  cameraOverride: { s: number; z: number; h: number; yaw: number; pitch: number; roll?: number } | null = null;
  /** Stop world time (photo mode): NPCs, water and the clock hold still. */
  simFrozen = false;
  /** Called right after a frame is rendered (e.g. to capture the canvas). */
  afterRender: (() => void)[] = [];
  /** When set, draws the frame instead of the world pipeline (the intro). */
  renderOverride: ((dt: number) => void) | null = null;
  onResize: ((w: number, h: number) => void)[] = [];
  /** Freeze player simulation (menus, cutscenes). */
  paused = false;
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
    this.terrain.setRivers(this.gen.rivers);
    this.scene.add(this.terrain.group);
    this.scene.add(this.grass.group);
    this.towns = new TownManager(this.terrain.pool, this.gen);
    this.scene.add(this.towns.group);
    this.world.colliders.push(this.towns);
    this.life = new TownLife(this.towns, this.world);
    this.scene.add(this.life.group);
    this.scene.add(this.avatar.mesh);
    // the textured Quinlan replaces the procedural one once it has loaded
    void loadQuinlanAsset().then((asset) => {
      if (!asset) return;
      this.life.useAsset(asset);
      this.avatar.useAsset(asset);
    });
    this.birds = new SurveillanceBirds(this.towns);
    this.scene.add(this.birds.group);
    this.portals.build(this.gen);
    this.scene.add(this.portals.group);
    this.hatch.build(this.gen);
    this.scene.add(this.hatch.group);
    this.scene.add(this.bulkheads.group);
    this.scene.add(this.underwater.group);
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
    for (const f of this.onResize) f(window.innerWidth, window.innerHeight);
  }

  /** Switch to another section of the strand (regenerates the world). */
  setSection(n: number) {
    this.section = mod(n, SECTION_COUNT);
    this.gen = new WorldGen(this.section, WORLD_SEED);
    this.world.setGen(this.gen);
    this.terrain.setSection(this.section, WORLD_SEED);
    this.terrain.setRivers(this.gen.rivers);
    this.towns.setGen(this.gen);
    this.portals.build(this.gen);
    this.hatch.build(this.gen);
  }

  /** Apply a graphics quality preset. */
  setQuality(q: 'low' | 'medium' | 'high') {
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    this.terrain.lodK = q === 'low' ? 0.9 : q === 'medium' ? 1.05 : 1.2;
    this.lighting.setShadowQuality(q === 'low' ? 1024 : 2048, q === 'low' ? 60 : 90);
    this.grass.setDensity(q === 'low' ? 0.35 : q === 'medium' ? 0.65 : 1);
    this.pipeline.vision.setResolutionScale(q === 'low' ? 0.5 : q === 'medium' ? 0.6 : 0.75);
    const pr = Math.min(window.devicePixelRatio, q === 'high' && !mobile ? 2 : q === 'medium' ? 1.5 : 1);
    this.maxPixelRatio = pr;
    this.pixelRatio = pr;
    if (!this.testMode) {
      this.pipeline.renderer.setPixelRatio(pr);
      this.resize();
    }
  }

  /** Put the player somewhere and make the render frame follow. */
  spawn(s: number, z: number, yaw = 0) {
    this.player.teleport(s, z, this.world, yaw);
    frame.maybeRebase(this.player.s, this.player.z, true);
  }

  /** Camera pose in cylinder coordinates (player eyes unless overridden). */
  cameraPose() {
    const o = this.cameraOverride;
    if (o) return o;
    const p = this.player;
    return { s: p.s, z: p.z, h: p.eyeH, yaw: p.yaw, pitch: p.pitch };
  }

  updateCamera() {
    const c = this.cameraPose();
    frame.maybeRebase(c.s, c.z);
    frame.toRender(c.s, c.z, c.h, this.camera.position);
    const th = frame.thetaAt(c.s);
    this.camQ.setFromAxisAngle(this.axisZ, th);
    this.tmpQ.setFromAxisAngle(this.axisY, c.yaw);
    this.camQ.multiply(this.tmpQ);
    this.tmpQ.setFromAxisAngle(this.axisX, c.pitch);
    this.camQ.multiply(this.tmpQ);
    if ('roll' in c && c.roll) {
      this.tmpQ.setFromAxisAngle(this.axisZ, c.roll);
      this.camQ.multiply(this.tmpQ);
    }
    this.camera.quaternion.copy(this.camQ);
    this.camera.updateMatrixWorld();
    // world-anchored pattern offsets
    U.uOriginMod.value.set(mod(frame.originS, 4096), mod(frame.originZ, 4096));
    U.uOriginModBig.value.set(mod(frame.originS, 65536), mod(frame.originZ, 65536));
  }

  tick() {
    const now = performance.now();
    const raw = now - this.last;
    const dt = Math.min(raw / 1000, 0.1);
    this.last = now;
    // resize (if at all) before drawing: resizing the canvas clears it, and a
    // resize after the frame was drawn would present an empty black frame
    this.adaptResolution(raw);
    this.step(dt);
    requestAnimationFrame(() => this.tick());
  }

  // ---- adaptive resolution: trade pixels for frame rate on slower GPUs
  adaptiveRes = true;
  private maxPixelRatio = 1;
  private pixelRatio = 1;
  private frameAcc = 0;
  private frameN = 0;
  private fastWindows = 0;

  private slowWindows = 0;
  private resCooldown = 0;
  /** Resolution steps taken so far (each change reallocates the frame buffers). */
  resolutionChanges = 0;

  private adaptResolution(ms: number) {
    if (!this.adaptiveRes || this.testMode || this.renderOverride || this.simFrozen || document.hidden) return;
    if (ms > 250) return; // tab switches and hitches
    this.frameAcc += ms;
    this.frameN++;
    this.resCooldown -= ms;
    if (this.frameAcc < 2000) return;
    const avg = this.frameAcc / this.frameN;
    this.frameAcc = 0;
    this.frameN = 0;
    if (this.resCooldown > 0) return;
    const minPr = Math.max(0.6, this.maxPixelRatio * 0.5);
    let pr = this.pixelRatio;
    // step down only after two slow windows in a row, step back up only after
    // sustained headroom, and never change more than once every few seconds
    if (avg > 26) {
      this.fastWindows = 0;
      if (++this.slowWindows >= 2 && pr > minPr) pr = Math.max(minPr, pr * 0.8);
    } else if (avg < 17.4) {
      this.slowWindows = 0;
      if (++this.fastWindows >= 4 && pr < this.maxPixelRatio) pr = Math.min(this.maxPixelRatio, pr * 1.15);
    } else {
      this.slowWindows = 0;
      this.fastWindows = 0;
    }
    if (Math.abs(pr - this.pixelRatio) > 0.01) {
      this.pixelRatio = pr;
      this.slowWindows = 0;
      this.fastWindows = 0;
      this.resCooldown = 6000;
      this.resolutionChanges++;
      this.pipeline.renderer.setPixelRatio(pr);
      this.resize();
    }
  }

  /** Advance the simulation by dt and render one frame. */
  step(dt: number, render = true) {
    const simDt = this.simFrozen ? 0 : dt;
    this.elapsed += simDt;
    U.uTime.value = this.elapsed;
    if (!this.timeFrozen) this.timeOfDay = mod(this.timeOfDay + simDt / (this.dayMinutes * 60), 1);
    const inp = this.input.poll();
    if (!this.paused) this.player.update(dt, inp, this.world);
    for (const f of this.onFrame) f(dt);
    this.updateCamera();
    this.lighting.update(this.timeOfDay, this.camera.position);
    U.uStarRot.value = this.timeOfDay * Math.PI * 2 * 0.25;
    // underwater state for all materials
    const cam = this.cameraPose();
    const wl = this.cameraOverride ? this.world.sampleAt(cam.s, cam.z, this.camSample).water : this.player.waterLevel;
    const eye = cam.h;
    const under = eye < wl - 0.02;
    U.uUnderwater.value = under ? 1 : 0;
    U.uWaterY.value = under ? frame.toRender(cam.s, cam.z, wl, _v).y : -1e9;
    this.pipeline.grading.u('underwater').value = under ? 1 : 0;
    if (under) {
      const floorY = frame.toRender(cam.s, cam.z, this.world.groundHeight(cam.s, cam.z), _v2).y;
      const flow = this.cameraOverride ? 0 : 1;
      this.underwater.update(simDt, this.camera.position, true, floorY, U.uWaterY.value, this.player.flowS * flow, this.player.flowZ * flow);
    } else this.underwater.update(simDt, this.camera.position, false, 0, 0, 0, 0);
    this.pipeline.grading.u('time').value = this.elapsed;
    this.pipeline.grading.u('exposure').value = this.lighting.state.exposure;
    // god rays: strongest with a low golden sun, gone at night and underwater
    const sd = U.uSunDir.value;
    const low = 1 - smoothstep(0.2, 0.75, sd.y);
    const shafts = under ? 0 : 0.42 * (1 - U.uNight.value) * (0.25 + 0.75 * low) * U.uHoloOn.value;
    this.pipeline.shafts.setSun(this.camera, sd, shafts, U.uSunColor.value);
    this.terrain.update({ s: cam.s, z: cam.z, h: eye });
    this.grass.update(cam.s, cam.z, this.terrain);
    this.towns.update(cam.s, cam.z, this.camera.position);
    this.life.update(simDt, cam, this.player, this.timeOfDay);
    this.avatar.update(simDt, this.player);
    this.birds.update(simDt, cam, this.player);
    this.hatch.update(dt, this.player.s, this.player.z);
    this.bulkheads.update();
    const pixelAngle = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, this.pipeline.renderer.domElement.height);
    this.sky.update(Z_MIN - frame.originZ, Z_MAX - frame.originZ, pixelAngle);
    if (render) {
      if (this.renderOverride) this.renderOverride(dt);
      else this.pipeline.render(dt);
      for (const f of this.afterRender.splice(0)) f();
    }
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
        `chunks ${t.visible}/${t.cached} pending ${t.pending}  trees ${this.terrain.trees.count}  towns ${this.towns.stats.loaded} (${(this.towns.stats.tris / 1e3).toFixed(0)}k tris)\n` +
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
const _v2 = new Vector3();
