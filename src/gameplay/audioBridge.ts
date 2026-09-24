// Feeds the procedural audio engine from the world: water, wind, underwater,
// towns, barges, time of day, plus one-shot events (steps, splashes, dives,
// discoveries, travel whooshes, Anek's birds, the intro machinery).

import { AudioEngine, type AudioState } from '../audio/audio';
import { L } from '../config';
import { wrapS } from '../coords/cylinder';
import { clamp, damp, smoothstep } from '../core/math';
import type { App } from '../app';
import { newSample } from '../world/gen/world';
import { RIVER_MAIN } from '../world/gen/rivers';

export class AudioBridge {
  readonly engine = new AudioEngine();
  private app: App;
  private sample = newSample();
  private t = 0;
  private state: AudioState = {
    waterProximity: 0,
    waterSpeed: 0,
    underwater: 0,
    altitude: 0,
    windExposure: 0,
    speed: 0,
    townSinging: 0,
    townSize: 0,
    onBarge: false,
    timeOfDay: 0.5,
    paused: false,
  };
  private target = { water: 0, speed: 0, alt: 0, wind: 0, town: 0, size: 0 };
  private surface: 'grass' | 'stone' | 'wood' | 'water' = 'grass';

  constructor(app: App) {
    this.app = app;
    const p = app.player;
    const e = this.engine;
    p.events.onSplash = (v) => e.splash(clamp(v / 7, 0.25, 1));
    p.events.onDive = () => e.dive();
    p.events.onSurface = () => e.surfaceBreath();
    p.events.onLand = (v) => {
      e.step(this.surface, true);
      if (v > 7) e.step(this.surface, false);
    };
    p.events.onStep = (quad) => e.step(this.surface, quad);
    // townsfolk diving in: a soft splash that fades with distance, placed
    // left or right (never the full splash of your own jump)
    app.life.onSplash = (s, z) => {
      const c = app.cameraPose();
      const ds = wrapS(s - c.s);
      const dz = z - c.z;
      const d = Math.hypot(ds, dz);
      if (d >= 55) return;
      const pan = d > 0.5 ? (ds * Math.cos(c.yaw) - dz * Math.sin(c.yaw)) / d : 0;
      e.splashAway((1 - d / 55) ** 2, pan);
    };
    app.birds.onTakeoff = (s, z) => {
      const c = app.cameraPose();
      if (Math.hypot(wrapS(s - c.s), z - c.z) < 60) e.birdChirp();
    };
    // any button in the UI clicks
    document.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement | null)?.closest?.('#ui button')) e.uiClick();
    });
  }

  /** Start on a user gesture (browsers keep audio suspended until then). */
  start() {
    if (!this.engine.started) void this.engine.start();
  }

  setVolume(v: number, muted: boolean) {
    this.engine.setMasterVolume(v);
    this.engine.setMuted(muted);
  }

  update(dt: number, opts: { paused: boolean; onBarge: boolean }) {
    const app = this.app;
    const st = this.state;
    const cam = app.cameraPose();
    const p = app.player;
    this.t -= dt;
    if (this.t <= 0) {
      this.t = 0.2;
      const o = app.world.sampleAt(cam.s, cam.z, this.sample);
      const edge = o.edge;
      // water is heard close by: fading out over ~70 m from a main river, ~40 m from streams
      this.target.water = o.water > -1e8 && cam.h < o.water + 0.2 ? 1 : 1 - smoothstep(1, o.riverClass === RIVER_MAIN || o.mainEdge < edge + 1 ? 70 : 40, Math.max(0, edge));
      const flow = Math.hypot(o.flowS, o.flowZ);
      this.target.speed = flow > 0.01 ? flow : o.mainEdge <= edge + 1 ? 0.9 : 1.6;
      this.target.alt = Math.max(0, cam.h - Math.max(o.baseLevel, o.water > -1e8 ? o.water : o.baseLevel));
      this.target.wind = clamp(o.ridge * 0.5 + o.hill * 0.25 + (cam.z < 25_000 || cam.z > L - 25_000 ? 0.4 : 0), 0, 1);
      // towns: proximity to the centre and how big the place is
      const near = app.towns.nearest(cam.s, cam.z);
      if (near) {
        const r = near.site.radius;
        this.target.town = 1 - smoothstep(r * 0.35, r * 1.25 + 250, near.dist);
        this.target.size = near.site.kind === 'city' ? 1 : near.site.kind === 'town' ? 0.55 : 0.2;
      } else this.target.town = 0;
      this.target.town = Math.max(this.target.town, app.life.singing);
      // what the feet are on
      const inTown = o.town > 0.4;
      const wet = o.water > -1e8 && p.h < o.water + 0.15;
      this.surface = wet ? 'water' : p.platform || (inTown && p.h > o.h + 0.3) ? 'wood' : inTown ? 'stone' : 'grass';
    }
    st.waterProximity = damp(st.waterProximity, this.target.water, 3, dt);
    st.waterSpeed = damp(st.waterSpeed, this.target.speed, 2, dt);
    st.underwater = damp(st.underwater, app.pipeline.grading.u('underwater').value as number, 8, dt);
    st.altitude = damp(st.altitude, this.target.alt, 2, dt);
    st.windExposure = damp(st.windExposure, this.target.wind, 1, dt);
    st.speed = app.cameraOverride ? 0 : p.speed;
    st.townSinging = damp(st.townSinging, this.target.town, 1.2, dt);
    st.townSize = this.target.size;
    st.onBarge = opts.onBarge;
    st.timeOfDay = app.timeOfDay;
    st.paused = opts.paused;
    this.engine.update(st, dt);
  }
}
