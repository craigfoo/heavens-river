// Gameplay glue: states, key bindings, discovery, travel, save, HUD updates.

import { R } from '../config';
import { wrapS } from '../coords/cylinder';
import { clamp, damp, mod } from '../core/math';
import type { App } from '../app';
import { U } from '../render/uniforms';
import { loadSettings, type Settings } from '../settings';
import { clearSave, loadSave, newSave, writeSave, type SaveData } from './save';
import { TravelDirector } from './travel';
import { BargeJourney } from './barge';
import { PhotoMode } from './photo';
import { AudioBridge } from './audioBridge';
import { IntroSequence } from '../intro/intro';
import { glyphImage } from '../ui/glyphs';
import { TouchControls } from '../ui/touchControls';
import { DebugPanel } from '../ui/debugPanel';
import { describeMural } from '../ui/murals';
import { Hud, type CompassMarker } from '../ui/hud';
import { MapScreen } from '../ui/mapScreen';
import { Menu } from '../ui/menu';
import { Journal } from '../ui/journal';
import type { TownSite } from '../world/gen/settlements';
import { quinlanNumber } from '../world/gen/names';
import { L, SECTION_COUNT } from '../config';

export type GameState = 'boot' | 'intro' | 'explore' | 'map' | 'menu' | 'journal' | 'cutscene' | 'barge' | 'photo';

export class Game {
  readonly app: App;
  readonly hud: Hud;
  readonly map: MapScreen;
  readonly menu: Menu;
  readonly journal: Journal;
  readonly travel: TravelDirector;
  readonly barge: BargeJourney;
  readonly photo: PhotoMode;
  readonly audio: AudioBridge;
  private intro: IntroSequence | null = null;
  private lookHint: HTMLDivElement;
  private touch: TouchControls;
  private debug = new DebugPanel(this);
  private promptText = '';
  private photoReturn: GameState = 'explore';
  private visionBeforePhoto: 'off' | 'panorama' | 'split' = 'off';
  save: SaveData;
  settings: Settings;
  state: GameState = 'boot';
  private heard = new Set<number>();
  private currentTown: TownSite | null = null;
  private lastDiscoveryCheck = 0;
  private lastSave = 0;
  private holoTarget = 1;
  private scrub = 0;
  private lastPos = { s: 0, z: 0 };
  private overlay: HTMLElement;
  private wasUnder = false;
  /** Hooks for systems added later (barge, vision, photo, audio...). */
  onUpdate: ((dt: number) => void)[] = [];
  interactions: { test: () => string | null; run: () => void }[] = [];

  constructor(app: App) {
    this.app = app;
    this.overlay = document.getElementById('ui') as HTMLElement;
    const saved = loadSave();
    this.save = saved ?? newSave();
    this.settings = loadSettings(this.save.settings);
    this.save.settings = this.settings;
    for (const k of this.save.discovered) {
      const [sec, id] = k.split(':').map(Number);
      if (sec === app.section) this.heard.add(id);
    }
    this.hud = new Hud(this.overlay);
    this.map = new MapScreen(this.overlay, {
      float: (t) => this.startFloat(t),
      travel: (t) => this.travelTo(t),
      destination: (t) => this.setDestination(t),
      close: () => this.closeScreens(),
      canFloat: (t) => this.canFloat(t),
    });
    this.menu = new Menu(this.overlay, this.settings, {
      resume: () => this.closeScreens(),
      change: (s, k) => this.applySetting(k),
      openMap: () => this.openMap(),
      openJournal: () => this.openJournal(),
      resetSave: () => {
        clearSave();
        location.reload();
      },
      replayIntro: () => {
        this.save.introSeen = false;
        writeSave(this.save);
        location.reload();
      },
    });
    this.journal = new Journal(this.overlay);
    this.journal.onClose = () => this.closeScreens();
    this.travel = new TravelDirector({
      hudFade: (v, c) => this.hud.setFade(v, c),
      overlay: this.overlay,
      place: (s, z, yaw) => {
        this.app.spawn(s, z, yaw);
        this.app.player.pitch = 0;
      },
      setCamera: (c) => (this.app.cameraOverride = c),
      requestTown: (id) => this.app.towns.request(id),
      townPoi: (id) => {
        const t = this.app.towns.get(id);
        return t ? this.app.towns.poiWorld(t, 'gate') : null;
      },
      terrainSettled: () => this.app.terrain.stats.pending < 3,
      groundAt: (s, z) => this.app.world.groundHeight(s, z),
      riverName: (t) => this.app.gen.rivers[t.river].name,
      anekStyle: this.settings.anekCutscenes,
      flyover: true,
      onArrive: (t) => this.arrive(t),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    this.barge = new BargeJourney(
      {
        river: (i) => this.app.gen.rivers[i],
        towns: () => this.app.gen.towns,
        requestTown: (id) => this.app.towns.request(id),
        setMaxLevel: (l) => (this.app.terrain.maxLevel = l),
        caption: (name, sub) => this.hud.showBanner(name, sub, 4),
        toast: (s) => this.hud.toast(s),
        heard: (site) => this.heard.add(site.id),
        addTime: (f) => (this.app.timeOfDay = mod(this.app.timeOfDay + f, 1)),
        settleWorld: () => this.app.terrain.stats.pending < 3,
        fade: (v) => this.hud.setFade(v),
        onFinish: (site, done) => this.endFloat(site, done),
      },
      this.overlay,
    );
    app.scene.add(this.barge.group);
    this.photo = new PhotoMode(app, this.overlay);
    this.audio = new AudioBridge(app);
    this.touch = new TouchControls(this.overlay, app.input);
    if (app.input.touchActive) this.hud.useTouchHints();
    this.touch.context = {
      interact: () => this.promptText !== '',
      swimming: () => this.state === 'photo' || app.player.mode === 'swim' || app.player.mode === 'dive' || app.player.mode === 'fly',
      playing: () => this.state === 'explore' || this.state === 'barge' || this.state === 'photo',
    };
    this.lookHint = document.createElement('div');
    this.lookHint.className = 'look-hint';
    this.lookHint.textContent = 'Click to look around';
    this.overlay.appendChild(this.lookHint);
    app.pipeline.renderer.domElement.addEventListener('click', () => {
      if (this.state === 'explore' || this.state === 'barge' || this.state === 'photo') this.app.input.requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && !this.app.testMode) {
        if (this.state === 'photo') this.exitPhoto();
        if (this.state === 'explore' || this.state === 'barge') this.openMenu();
      }
    });
    window.addEventListener('beforeunload', () => this.persist());
    document.addEventListener('visibilitychange', () => document.hidden && this.persist());
    this.bindKeys();
    this.applyAllSettings();
    this.pickSpawn();
    this.installTownInteractions();
    this.interactions.push({
      test: () => (app.hatch.active && app.hatch.distance(app.player.s, app.player.z) < 3.2 ? '<span class="key">E</span>Read the plaque' : null),
      run: () => this.hud.showCard('Maintenance 07', 'Crew access only, by order of Anek. The doors have sealed behind you; somewhere below, the machinery of the world hums on.', 8),
    });
    app.terrain.pool.onMap = (d) => this.map.setData(d);
    app.terrain.pool.requestMap(840, 520);
  }

  private installTownInteractions() {
    const app = this.app;
    const near = (which: 'signpost' | 'dock', r: number) => {
      const p = app.player;
      for (const t of app.towns.loadedTowns()) {
        const q = app.towns.poiWorld(t, which);
        if (Math.hypot(wrapS(q.s - p.s), q.z - p.z) < r && Math.abs(q.h - p.h) < 4) return t;
      }
      return null;
    };
    this.interactions.push({
      test: () => (near('signpost', 3.5) ? '<span class="key">E</span>Read the signpost' : null),
      run: () => {
        const t = near('signpost', 3.5);
        if (!t) return;
        const site = t.site;
        const same = app.gen.towns.filter((x) => x.river === site.river && x.id !== site.id);
        const up = same.filter((x) => (x.z - site.z) * app.gen.rivers[site.river].flow < 0).sort((a, b) => Math.abs(a.z - site.z) - Math.abs(b.z - site.z)).slice(0, 2);
        const down = same.filter((x) => (x.z - site.z) * app.gen.rivers[site.river].flow > 0).sort((a, b) => Math.abs(a.z - site.z) - Math.abs(b.z - site.z)).slice(0, 2);
        const fresh = this.hear([...up, ...down].map((x) => x.id));
        const fmt = (x: TownSite) => `${x.name} (${(Math.abs(x.z - site.z) / 1000).toFixed(0)} km)`;
        this.hud.toast(`Upstream: ${up.map(fmt).join(', ') || '—'}`);
        this.hud.toast(`Downstream: ${down.map(fmt).join(', ') || '—'}`);
        if (fresh.length) this.hud.toast(`Added to your map: ${fresh.join(', ')}`);
        this.persist();
      },
    });
    this.interactions.push({
      test: () => (near('dock', 18) ? '<span class="key">E</span>Hire a barge — choose where to float' : null),
      run: () => this.openMap(),
    });
    // painted walls
    const nearMural = () => {
      const p = app.player;
      for (const t of app.towns.loadedTowns()) {
        const m = t.murals;
        const lx = wrapS(p.s - t.anchorS);
        const lz = p.z - t.anchorZ;
        for (let i = 0; i < m.length; i += 5) {
          if (Math.abs(lx - m[i]) > m[i + 3] || Math.abs(lz - m[i + 1]) > m[i + 3]) continue;
          if (Math.hypot(lx - m[i], lz - m[i + 1]) < m[i + 3] && Math.abs(p.h - m[i + 2]) < 3) return { town: t, seed: m[i + 4] };
        }
      }
      return null;
    };
    this.interactions.push({
      test: () => (nearMural() ? '<span class="key">E</span>Look at the mural' : null),
      run: () => {
        const m = nearMural();
        if (!m) return;
        const d = describeMural(m.seed, m.town.site.name);
        this.hud.showCard(d.title, d.text, 11);
      },
    });
    // barrier tunnel portals lead to the neighbouring sections
    this.interactions.push({
      test: () => {
        const p = app.portals.near(app.player.s, app.player.z, 260);
        if (!p) return null;
        return `<span class="key">E</span>Pass through the barrier tunnel to Section ${quinlanNumber(mod(app.section + p.end, SECTION_COUNT))}`;
      },
      run: () => {
        const p = app.portals.near(app.player.s, app.player.z, 260);
        if (p) this.crossSection(p.end, { river: p.river });
      },
    });
  }

  /** Move to the neighbouring section, either over the crest or through a river tunnel. */
  async crossSection(dir: 1 | -1, via?: { river: number }) {
    if (this.state === 'cutscene') return;
    const app = this.app;
    const prev = this.state;
    this.state = 'cutscene';
    app.paused = true;
    this.hud.setFade(1);
    await new Promise((r) => setTimeout(r, 650));
    this.persist();
    const p = app.player;
    const keepS = p.s;
    const keepZ = p.z;
    const keepH = p.h;
    app.setSection(app.section + dir);
    this.heard.clear();
    for (const k of this.save.discovered) {
      const [sec, id] = k.split(':').map(Number);
      if (sec === app.section) this.heard.add(id);
    }
    this.currentTown = null;
    app.terrain.pool.requestMap(840, 520);
    if (via) {
      // emerge from the matching portal at the opposite end of the new section
      const portal = app.portals.list.find((q) => q.river === via.river && q.end === -dir);
      if (portal) app.spawn(portal.s, portal.z - portal.end * 250, dir > 0 ? Math.PI : 0);
    } else {
      app.spawn(keepS, keepZ - dir * L, p.yaw);
      if (p.mode === 'fly') p.h = keepH;
    }
    const t0 = performance.now();
    while (app.terrain.stats.pending > 3 && performance.now() - t0 < 12_000) await new Promise((r) => setTimeout(r, 120));
    this.hud.setFade(0);
    this.hud.showBanner(`Section ${quinlanNumber(app.section)}`, `${app.section.toString(8)}₈ · ${dir > 0 ? 'Fore' : 'Aft'} of where you were`, 6);
    this.state = prev;
    app.paused = false;
    this.persist();
  }

  // ------------------------------------------------------------------ spawn & save

  private pickSpawn() {
    const app = this.app;
    const s = this.save;
    if (s.s || s.z) {
      app.timeOfDay = s.timeOfDay;
      app.spawn(s.s, s.z, s.yaw);
      app.player.pitch = s.pitch;
      return;
    }
    // first visit: a hillside overlooking a river city at golden hour
    const spot = this.heroSpot();
    app.spawn(spot.s, spot.z, spot.yaw);
    app.player.pitch = -0.02;
    app.timeOfDay = 0.69;
  }

  /** The hero valley: a rise on the valley wall with a clear view over the first river city. */
  /** The arrival point: just outside the maintenance hatch, facing the valley and the first river city. */
  heroSpot() {
    const app = this.app;
    const hc = app.gen.hatch;
    if (hc) this.heard.add(hc.city);
    if (!app.hatch.active) {
      const city = app.gen.towns.find((t) => t.kind === 'city') ?? app.gen.towns[0];
      return { s: city.s, z: city.z - city.halfLen - 400, yaw: 0 };
    }
    return app.hatch.doorstep(4.5);
  }

  persist() {
    const p = this.app.player;
    this.save.section = this.app.section;
    this.save.s = p.s;
    this.save.z = p.z;
    this.save.h = p.h;
    this.save.yaw = p.yaw;
    this.save.pitch = p.pitch;
    this.save.timeOfDay = this.app.timeOfDay;
    this.save.currentTown = this.currentTown?.id ?? null;
    this.save.discovered = [...new Set([...this.save.discovered.filter((k) => !k.startsWith(`${this.app.section}:`)), ...[...this.heard].map((id) => `${this.app.section}:${id}`)])];
    this.save.settings = this.settings;
    writeSave(this.save);
  }

  // ------------------------------------------------------------------ knowledge

  isKnown = (t: TownSite): boolean => this.settings.allTowns || t.kind === 'city' || this.heard.has(t.id);

  discover(t: TownSite, banner = true) {
    const fresh = !this.heard.has(t.id);
    this.heard.add(t.id);
    if (banner) this.hud.showBanner(t.name, `${t.kind === 'city' ? 'River city' : t.kind === 'town' ? 'Town' : 'Hamlet'} on the ${this.app.gen.rivers[t.river].name}`);
    if (fresh) {
      this.hud.toast(`Discovered ${t.name}`);
      this.audio.engine.chime();
      this.persist();
    }
  }

  private arrive(t: TownSite) {
    this.state = 'explore';
    this.app.paused = false;
    this.app.input.enabled = true;
    this.currentTown = t;
    this.discover(t, true);
    this.save.stats.trips++;
    this.persist();
    if (!this.app.testMode) this.app.input.requestLock();
  }

  // ------------------------------------------------------------------ travel

  canFloat(t: TownSite): { ok: boolean; note: string } {
    const gen = this.app.gen;
    const p = this.app.player;
    const rv = gen.nearestRiver(p.s, p.z);
    if (rv.index !== t.river) return { ok: false, note: `Rivers do not connect: ${t.name} lies on the ${gen.rivers[t.river].name}. Travel instead.` };
    const from = this.boardingTown(t.river);
    if (!from) return { ok: false, note: 'No dock nearby to hire a barge.' };
    if (from.id === t.id) return { ok: false, note: 'You are already here.' };
    const down = (t.z - from.z) * rv.flow > 0;
    return { ok: true, note: down ? `Downstream from ${from.name}: the current carries you.` : `Upstream from ${from.name}: the barge is poled and towed, and slower.` };
  }

  /** The town whose dock a barge would leave from (current town, or nearest on that river). */
  boardingTown(river: number): TownSite | null {
    if (this.currentTown && this.currentTown.river === river) return this.currentTown;
    const p = this.app.player;
    let best: TownSite | null = null;
    let bd = 12_000;
    for (const t of this.app.gen.towns) {
      if (t.river !== river) continue;
      const d = Math.hypot(wrapS(t.s - p.s), t.z - p.z);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  /** Board a barge at the nearest dock on the destination's river and float there. */
  async startFloat(t: TownSite) {
    const from = this.boardingTown(t.river);
    if (!from || from.id === t.id) return this.travelTo(t);
    this.closeScreens(false);
    this.state = 'cutscene';
    this.app.paused = true;
    this.hud.setFade(1);
    await new Promise((r) => setTimeout(r, 600));
    this.barge.start(from, t, this.settings.tripSeconds);
    const p = this.app.player;
    p.mode = 'ride';
    p.vs = p.vz = p.vh = 0;
    p.yaw = this.barge.yaw;
    p.pitch = -0.04;
    this.state = 'barge';
    this.app.paused = false;
    this.save.stats.trips++;
    // let the first chunks arrive before revealing
    const t0 = performance.now();
    while (this.app.terrain.stats.pending > 4 && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
    this.hud.setFade(0);
    if (!this.app.testMode) this.app.input.requestLock();
  }

  private endFloat(site: TownSite, completed: boolean) {
    const p = this.app.player;
    this.state = 'explore';
    if (completed) {
      const lt = this.app.towns.get(site.id);
      if (lt) {
        const g = this.app.towns.poiWorld(lt, 'gate');
        this.app.spawn(g.s, g.z, p.yaw);
      } else {
        p.mode = 'walk';
      }
      this.currentTown = site;
      this.discover(site, true);
      this.persist();
    } else {
      // overboard: into the river mid-journey
      p.mode = 'swim';
      p.vh = -1.5;
      this.hud.toast('Overboard! The barge sails on without you.');
    }
  }

  travelTo(t: TownSite) {
    this.closeScreens(false);
    this.state = 'cutscene';
    this.app.paused = true;
    this.app.input.enabled = false;
    this.app.input.exitLock();
    this.audio.engine.whoosh();
    this.travel.travelTo(t, { s: this.app.player.s, z: this.app.player.z });
  }

  /** Travel to a settlement of this section by id (debug panel). */
  travelToId(id: number) {
    const t = this.app.gen.towns.find((x) => x.id === id);
    if (t && (this.state === 'explore' || this.state === 'menu')) this.travelTo(t);
  }

  setDestination(t: TownSite) {
    this.save.destination = this.save.destination?.siteId === t.id ? null : { section: this.app.section, siteId: t.id };
    this.hud.toast(this.save.destination ? `Destination: ${this.isKnown(t) ? t.name : 'unknown settlement'}` : 'Destination cleared');
    this.persist();
  }

  // ------------------------------------------------------------------ screens

  private openMap() {
    this.menu.close();
    this.journal.close();
    this.state = 'map';
    this.app.paused = true;
    this.app.input.exitLock();
    this.map.open({
      gen: this.app.gen,
      section: this.app.section,
      player: { s: this.app.player.s, z: this.app.player.z, yaw: this.app.player.yaw },
      isKnown: this.isKnown,
      destination: this.save.destination?.siteId ?? null,
      currentTown: this.currentTown?.id ?? null,
    });
  }

  private openJournal() {
    this.menu.close();
    this.map.close();
    this.state = 'journal';
    this.app.paused = true;
    this.app.input.exitLock();
    this.journal.open({
      gen: this.app.gen,
      section: this.app.section,
      isKnown: this.isKnown,
      player: this.app.player,
      stats: this.save.stats,
      travel: (t) => this.travelTo(t),
      destination: (t) => this.setDestination(t),
    });
  }

  openMenu() {
    if (this.state === 'cutscene' || this.state === 'intro') return;
    this.map.close();
    this.journal.close();
    this.state = 'menu';
    this.app.paused = true;
    this.menu.open();
  }

  closeScreens(relock = true) {
    this.map.close();
    this.menu.close();
    this.journal.close();
    if (this.state === 'map' || this.state === 'menu' || this.state === 'journal') {
      this.state = 'explore';
      this.app.paused = false;
      if (relock && !this.app.testMode) this.app.input.requestLock();
    }
  }

  // ------------------------------------------------------------------ settings

  applySetting(k: keyof Settings) {
    const s = this.settings;
    const app = this.app;
    switch (k) {
      case 'fov':
        app.pipeline.setHorizontalFov(s.fov);
        break;
      case 'sensitivity':
        app.input.sensitivity = 0.0022 * s.sensitivity;
        break;
      case 'invertY':
        app.input.invertY = s.invertY;
        break;
      case 'dayMinutes':
        app.dayMinutes = s.dayMinutes;
        break;
      case 'freezeTime':
        app.timeFrozen = s.freezeTime;
        break;
      case 'goldenLiberty':
        app.lighting.liberty = s.goldenLiberty;
        break;
      case 'hologramHeight':
        U.uHoloR.value = R - s.hologramHeight * 1000;
        break;
      case 'fog':
        U.uFogScale.value = s.fog;
        break;
      case 'coriolis':
        app.player.coriolis = s.coriolis;
        break;
      case 'anekCutscenes':
        this.travel['host'].anekStyle = s.anekCutscenes;
        break;
      case 'grass':
        app.grass.enabled = s.grass;
        break;
      case 'shadows':
        app.pipeline.renderer.shadowMap.enabled = s.shadows;
        app.lighting.sun.castShadow = s.shadows;
        break;
      case 'quality':
        app.setQuality(s.quality);
        break;
      case 'volume':
      case 'muted':
        this.audio.setVolume(s.volume, s.muted);
        break;
      case 'visionMode':
        if (this.visionOn !== 'off') this.setVision(s.visionMode);
        break;
      case 'showDebug':
        app.debugText.style.display = s.showDebug ? 'block' : 'none';
        break;
    }
    this.persist();
  }

  private applyAllSettings() {
    for (const k of Object.keys(this.settings) as (keyof Settings)[]) this.applySetting(k);
  }

  // ------------------------------------------------------------------ keys

  private bindKeys() {
    const inp = this.app.input;
    inp.on('KeyM', () => {
      if (this.state === 'map') this.closeScreens();
      else if (this.state === 'explore' || this.state === 'menu' || this.state === 'journal') this.openMap();
    });
    inp.on('Escape', () => {
      if (this.state === 'barge') this.openMenu();
    });
    inp.on('KeyJ', () => {
      if (this.state === 'journal') this.closeScreens();
      else if (this.state === 'explore' || this.state === 'menu' || this.state === 'map') this.openJournal();
    });
    inp.on('Escape', () => {
      if (this.state === 'map' || this.state === 'journal' || this.state === 'menu') this.closeScreens();
      else if (this.state === 'explore') this.openMenu();
      else if (this.state === 'photo') this.exitPhoto();
    });
    inp.on('KeyB', () => {
      if (this.state !== 'explore' && this.state !== 'barge' && this.state !== 'photo') return;
      this.holoTarget = this.holoTarget > 0.5 ? 0 : 1;
      this.hud.toast(this.holoTarget ? 'Hologram sky on' : "Bob mode: hologram off — look up");
    });
    inp.on('KeyF', () => {
      if (this.state !== 'explore') return;
      const p = this.app.player;
      p.mode = p.mode === 'fly' ? 'walk' : 'fly';
      this.hud.toast(p.mode === 'fly' ? 'Fly mode (debug): Space up, C down, Shift fast' : 'Walking');
    });
    inp.on('KeyH', () => this.state !== 'photo' && this.hud.toggleHints());
    inp.on('F3', () => this.debug.toggle());
    inp.on('Backquote', () => this.debug.toggle());
    inp.on('Tab', () => {
      if (this.state === 'photo') this.exitPhoto();
      else if (this.state === 'explore' || this.state === 'barge') this.enterPhoto();
    });
    inp.on('Enter', () => {
      if (this.state === 'barge' && this.barge.active) this.barge.skip();
    });
    inp.on('KeyE', () => {
      if (this.state !== 'explore') return;
      // with independent eyes, E doubles as the right eye's steering key:
      // a tap interacts (or re-centres the eye), a hold steers
      if (this.visionOn === 'split') this.eyeTap.r = { t: performance.now(), moved: 0 };
      else this.interact();
    });
    inp.on('KeyQ', () => {
      if (this.visionOn === 'split') this.eyeTap.l = { t: performance.now(), moved: 0 };
    });
    const tapped = (k: 'l' | 'r') => {
      const tap = this.eyeTap[k];
      this.eyeTap[k] = null;
      return !!tap && performance.now() - tap.t < 280 && tap.moved < 0.03;
    };
    inp.onUp('KeyQ', () => {
      if (this.visionOn === 'split' && tapped('l')) this.recentreEye('l');
    });
    inp.onUp('KeyE', () => {
      if (this.visionOn !== 'split' || !tapped('r')) return;
      if (this.state !== 'explore' || !this.interact()) this.recentreEye('r');
    });
    inp.on('KeyV', () => {
      if (this.state !== 'explore' && this.state !== 'barge') return;
      const first = this.settings.visionMode;
      const second = first === 'panorama' ? 'split' : 'panorama';
      const next = this.visionOn === 'off' ? first : this.visionOn === first ? second : 'off';
      this.setVision(next);
      this.hud.toast(
        next === 'panorama'
          ? 'Quinlan vision: 270° panorama (V again for independent eyes)'
          : next === 'split'
            ? 'Independent eyes: hold Q or E and move the mouse to steer each eye; tap to re-centre'
            : 'Normal vision',
      );
    });
  }

  enterPhoto() {
    this.photoReturn = this.state;
    this.visionBeforePhoto = this.visionOn;
    this.setVision('off');
    this.state = 'photo';
    this.photo.enter();
  }

  exitPhoto() {
    this.photo.exit();
    this.state = this.photoReturn;
    this.setVision(this.visionBeforePhoto);
  }

  /** Run the first available interaction; false if there was none. */
  private interact() {
    for (const it of this.interactions) {
      if (it.test()) {
        it.run();
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ vision

  private eyeTap: { l: { t: number; moved: number } | null; r: { t: number; moved: number } | null } = { l: null, r: null };

  get visionOn() {
    return this.app.pipeline.visionMode;
  }

  setVision(mode: 'off' | 'panorama' | 'split') {
    this.app.pipeline.setVision(mode);
    this.app.input.eyeSteering = mode === 'split';
    if (mode !== 'split') {
      this.recentreEye('l');
      this.recentreEye('r');
    }
  }

  private recentreEye(k: 'l' | 'r') {
    const e = this.app.pipeline.vision.eyes;
    if (k === 'l') e.lYaw = e.lPitch = 0;
    else e.rYaw = e.rPitch = 0;
  }

  private steerEyes() {
    if (this.visionOn !== 'split') return;
    const i = this.app.input.last;
    const e = this.app.pipeline.vision.eyes;
    const moved = Math.abs(i.eyeDX) + Math.abs(i.eyeDY);
    // eyes rest 75° off the snout; each can swing to straight ahead or well behind
    if (i.eyeL) {
      e.lYaw = clamp(e.lYaw - i.eyeDX, -1.31, 1.05);
      e.lPitch = clamp(e.lPitch - i.eyeDY, -1.2, 1.2);
      if (this.eyeTap.l) this.eyeTap.l.moved += moved;
    }
    if (i.eyeR) {
      e.rYaw = clamp(e.rYaw + i.eyeDX, -1.31, 1.05);
      e.rPitch = clamp(e.rPitch - i.eyeDY, -1.2, 1.2);
      if (this.eyeTap.r) this.eyeTap.r.moved += moved;
    }
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number) {
    const app = this.app;
    const p = app.player;
    this.hud.update(dt);
    // hologram fade (Bob mode)
    U.uHoloOn.value = damp(U.uHoloOn.value, this.holoTarget, 2.2, dt);
    // time scrub (hold T; Shift+T backwards)
    const inp = app.input;
    const scrubbing = (this.state === 'explore' || this.state === 'photo') && inp.isDown('KeyT');
    this.scrub = damp(this.scrub, scrubbing ? (inp.isDown('ShiftLeft') ? -1 : 1) : 0, 6, dt);
    if (Math.abs(this.scrub) > 0.01) app.timeOfDay = mod(app.timeOfDay + this.scrub * dt * 0.06, 1);
    for (const f of this.onUpdate) f(dt);
    this.audio.update(dt, {
      paused: this.state === 'menu' || this.state === 'map' || this.state === 'journal',
      onBarge: this.state === 'barge',
    });
    this.lookHint.style.opacity = this.state === 'explore' && !app.input.locked && !app.input.touchActive && !app.testMode ? '1' : '0';
    this.steerEyes();
    this.touch.update();
    if (this.state === 'photo') this.photo.update(dt);
    if (this.state === 'barge' && this.barge.active) {
      const p = app.player;
      const r = this.barge.update(dt, app.input.last, p.yaw);
      p.s = mod(r.s, 2 * Math.PI * R);
      p.z = r.z;
      p.h = r.h;
      p.yaw += r.yawDelta;
      p.waterLevel = -1e9;
      if (r.overboard) {
        p.h = r.h - 1.2;
        this.barge.finish(false);
      }
    } else this.barge.refresh();
    if (this.state === 'explore' || this.state === 'barge') {
      // stats
      const moved = Math.hypot(wrapS(p.s - this.lastPos.s), p.z - this.lastPos.z);
      if (moved < 50) this.save.stats.distance += moved;
      this.save.stats.played += dt;
      if (p.mode === 'dive' && !this.wasUnder) this.save.stats.swims++;
      this.wasUnder = p.mode === 'dive';
    }
    this.lastPos = { s: p.s, z: p.z };
    // walking (or flying) over a barrier crest loads the next section
    if (this.state === 'explore') {
      if (p.z > L + 150) this.crossSection(1);
      else if (p.z < -150) this.crossSection(-1);
    }
    // discovery & current town (a few times per second)
    this.lastDiscoveryCheck += dt;
    if (this.lastDiscoveryCheck > 0.4 && this.state === 'explore') {
      this.lastDiscoveryCheck = 0;
      const near = app.towns.nearest(p.s, p.z);
      if (near && near.dist < near.site.radius * 0.75) {
        if (this.currentTown !== near.site) {
          this.currentTown = near.site;
          this.discover(near.site, true);
        }
      } else if (near && near.dist > near.site.radius * 1.3) {
        this.currentTown = null;
      }
    }
    // autosave
    this.lastSave += dt;
    if (this.lastSave > 45 && this.state === 'explore') {
      this.lastSave = 0;
      this.persist();
    }
    this.updateHud();
  }

  private updateHud() {
    const app = this.app;
    const p = app.player;
    const pose = app.cameraPose();
    const fS = -Math.sin(pose.yaw);
    const fZ = -Math.cos(pose.yaw);
    const heading = mod((Math.atan2(fS, fZ) * 180) / Math.PI, 360);
    const markers: CompassMarker[] = [];
    let destText = '';
    const dest = this.save.destination;
    if (dest && dest.section === app.section) {
      const t = app.gen.towns.find((x) => x.id === dest.siteId);
      if (t) {
        const dS = wrapS(t.s - p.s);
        const dZ = t.z - p.z;
        const d = Math.hypot(dS, dZ);
        markers.push({ bearing: mod((Math.atan2(dS, dZ) * 180) / Math.PI, 360), kind: 'dest' });
        destText = `${this.isKnown(t) ? t.name : 'Destination'} · ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`}`;
        if (d < t.radius * 0.6) {
          this.save.destination = null;
          this.hud.toast('You have arrived');
        }
      }
    }
    // the light zone
    const st = app.lighting.state;
    if (app.lighting.liberty && st.elevation < 1.2) markers.push({ bearing: st.azimuthSign > 0 ? 0 : 180, kind: 'sun' });
    // nearby known towns
    for (const t of app.towns.loadedTowns()) {
      const dS = wrapS(t.site.s - p.s);
      const dZ = t.site.z - p.z;
      const d = Math.hypot(dS, dZ);
      if (d < 150 || d > 6000 || !this.isKnown(t.site)) continue;
      markers.push({ bearing: mod((Math.atan2(dS, dZ) * 180) / Math.PI, 360), kind: 'town', label: t.site.name });
    }
    this.hud.updateCompass(heading, markers, destText);
    this.hud.setSection(app.section, app.gen.nearestRiver(p.s, p.z).name);
    this.hud.setClock(app.timeOfDay, st.night);
    const under = p.mode === 'dive';
    this.hud.setBreath(clamp(p.breath / 90, 0, 1), under || p.breath < 89);
    let prompt = '';
    if (this.state === 'explore') {
      for (const it of this.interactions) {
        const t = it.test();
        if (t) {
          prompt = t;
          break;
        }
      }
    }
    this.hud.setPrompt(prompt);
    this.promptText = prompt;
    this.hud.setVisible(this.state !== 'photo' && this.state !== 'intro' && this.state !== 'cutscene' && this.state !== 'boot');
  }

  /** Called when the save's town knowledge should include signpost-mentioned towns. */
  hear(ids: number[]) {
    const names: string[] = [];
    for (const id of ids) {
      const t = this.app.gen.towns.find((x) => x.id === id);
      if (!t) continue;
      if (!this.heard.has(id)) names.push(t.name);
      this.heard.add(id);
    }
    return names;
  }

  get current() {
    return this.currentTown;
  }

  /** The arrival sequence, while it plays (e.g. for tests to seek or skip). */
  get introSequence() {
    return this.intro;
  }

  start() {
    const app = this.app;
    const params = new URLSearchParams(location.search);
    if (app.testMode) {
      this.state = 'explore';
      this.hud.hideHintsSoon();
      return;
    }
    // title screen over the live world; its click is the gesture that unlocks audio
    this.state = 'boot';
    app.paused = true;
    app.input.enabled = false;
    const fresh = !this.save.introSeen;
    const el = document.createElement('div');
    el.className = 'title-screen';
    el.innerHTML = `
      <div class="tt-inner">
        <img class="tt-glyph" alt="" src="${glyphImage('Heavensriver', 64, '#f3dfb4', 'rgba(255,200,120,0.6)')}">
        <h1>Heaven's River</h1>
        <p class="tt-sub">Walk the endless river strand as a Quinlan</p>
        <button class="tt-start">${this.save.s || this.save.z ? 'Continue' : 'Begin'}</button>
        <label class="tt-opt"><input type="checkbox" ${fresh && !params.has('nointro') ? 'checked' : ''}> Play the arrival sequence</label>
        <p class="tt-credit">A non-commercial fan project set in Dennis E. Taylor's Bobiverse (<i>Heaven's River</i>). Not affiliated with the author or publisher.</p>
      </div>`;
    this.overlay.appendChild(el);
    const btn = el.querySelector('.tt-start') as HTMLButtonElement;
    const box = el.querySelector('input') as HTMLInputElement;
    btn.addEventListener('click', () => {
      this.audio.start();
      el.classList.add('out');
      setTimeout(() => el.remove(), 900);
      if (box.checked) this.startIntro();
      else this.enterWorld(true);
    });
  }

  private enterWorld(lock: boolean) {
    const app = this.app;
    this.state = 'explore';
    app.paused = false;
    app.input.enabled = true;
    this.hud.hideHintsSoon();
    if (lock && !app.testMode) app.input.requestLock();
  }

  /** Play the arrival sequence while the hatch valley streams in behind it. */
  startIntro() {
    const app = this.app;
    this.state = 'intro';
    app.paused = true;
    app.input.enabled = false;
    // stand in the hatch doorway at golden hour so the world loads during the intro
    const spot = this.heroSpot();
    const inDoor = app.hatch.active ? app.hatch.doorstep(1.6) : spot;
    app.spawn(inDoor.s, inDoor.z, inDoor.yaw);
    app.player.pitch = -0.02;
    app.timeOfDay = 0.69;
    app.hatch.open = app.hatch.openTarget = 1;
    const e = this.audio.engine;
    const intro = new IntroSequence(app.pipeline.renderer, this.overlay, {
      onSpinProgress: (p) => e.spinTransfer(p),
      onElevator: (on) => e.elevator(on),
      onSkip: () => e.elevator(false),
    });
    this.intro = intro;
    intro.resize(window.innerWidth, window.innerHeight);
    // compile the world's shaders in the background so the reveal doesn't hitch
    app.updateCamera();
    void app.pipeline.renderer.compileAsync(app.scene, app.camera).catch(() => undefined);
    const onResize = (w: number, h: number) => intro.active && intro.resize(w, h);
    app.onResize.push(onResize);
    app.renderOverride = (dt) => {
      intro.update(dt);
      intro.render();
    };
    intro.start(() => {
      app.renderOverride = null;
      app.onResize = app.onResize.filter((f) => f !== onResize);
      intro.dispose();
      this.intro = null;
      this.save.introSeen = true;
      this.persist();
      this.enterWorld(false);
      const city = app.gen.towns.find((t) => t.id === app.gen.hatch?.city);
      this.hud.showBanner(`Section ${quinlanNumber(app.section)}`, city ? `${city.name} lies below, on the ${app.gen.rivers[city.river].name}` : 'Welcome, traveller', 7);
    });
  }
}
