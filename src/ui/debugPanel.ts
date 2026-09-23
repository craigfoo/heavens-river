// Developer panel (F3): live tuning of time, atmosphere, rendering budgets and
// quick teleports. lil-gui is loaded on first use so it stays out of the main
// bundle for players.

import type GUI from 'lil-gui';
import type { App } from '../app';
import type { Game } from '../gameplay/game';
import { U } from '../render/uniforms';
import { R } from '../config';

export class DebugPanel {
  private gui: GUI | null = null;
  private loading = false;
  private game: Game;
  private stats = { fps: '', draws: '', tris: '', chunks: '', quinlans: '' };

  constructor(game: Game) {
    this.game = game;
  }

  toggle() {
    if (this.gui) {
      const el = this.gui.domElement;
      el.style.display = el.style.display === 'none' ? '' : 'none';
      return;
    }
    if (this.loading) return;
    this.loading = true;
    void import('lil-gui').then(({ default: GUIClass }) => this.build(GUIClass));
  }

  private build(GUIClass: typeof GUI) {
    const game = this.game;
    const app: App = game.app;
    const gui = new GUIClass({ title: 'Heaven’s River · debug' });
    gui.domElement.style.zIndex = '60';
    gui.domElement.style.top = '64px';
    this.gui = gui;

    const st = gui.addFolder('Stats');
    for (const k of Object.keys(this.stats) as (keyof DebugPanel['stats'])[]) st.add(this.stats, k).disable().listen();

    const world = gui.addFolder('Time & sky');
    world.add(app, 'timeOfDay', 0, 1, 0.001).name('time of day').listen();
    world.add(app, 'timeFrozen').name('freeze time').listen();
    world.add(app, 'dayMinutes', 1, 120, 1).name('day length (min)');
    world.add(U.uHoloOn, 'value', 0, 1, 0.01).name('hologram').listen();
    const holo = { km: (R - U.uHoloR.value) / 1000 };
    world.add(holo, 'km', 2, 60, 0.5).name('hologram height km').onChange((v: number) => (U.uHoloR.value = R - v * 1000));
    world.add(U.uFogScale, 'value', 0, 4, 0.05).name('haze');
    world.add(app.lighting, 'liberty').name('golden light zone');

    const render = gui.addFolder('Rendering');
    render.add(app.pipeline.bloom, 'intensity', 0, 3, 0.01).name('bloom');
    render.add(app.terrain, 'lodK', 0.5, 2.5, 0.05).name('terrain LOD');
    render.add(app.terrain, 'maxLevel', 4, 9, 1).name('max terrain level');
    render.add(app.grass, 'enabled').name('grass');
    render.add(app.pipeline.renderer.shadowMap, 'enabled').name('shadows');
    const vis = { mode: app.pipeline.visionMode as string };
    render
      .add(vis, 'mode', ['off', 'panorama', 'split'])
      .name('Quinlan vision')
      .onChange((m: string) => game.setVision(m as 'off' | 'panorama' | 'split'));
    render.add(app.pipeline.vision, 'resolutionScale', 0.3, 1, 0.05).name('vision resolution').onChange((v: number) => app.pipeline.vision.setResolutionScale(v));

    const player = gui.addFolder('Player');
    const fly = { fly: false };
    player.add(fly, 'fly').name('fly mode').onChange((v: boolean) => (app.player.mode = v ? 'fly' : 'walk'));
    player.add(app.player, 'noclipSpeed', 5, 3000, 5).name('fly speed');
    player.add(app.player, 'coriolis').name('Coriolis');

    const go = gui.addFolder('Travel');
    const towns = Object.fromEntries(app.gen.towns.map((t) => [`${t.name} (${t.kind})`, t.id]));
    const pick = { town: app.gen.towns[0]?.id ?? 0, section: app.section };
    go.add(pick, 'town', towns).name('town');
    go.add({ travel: () => game.travelToId(pick.town) }, 'travel').name('travel there');
    go.add(pick, 'section', 0, 1_799_999, 1).name('section');
    go.add(
      {
        jump: () => {
          const d = pick.section - app.section;
          if (d !== 0) void game.crossSection(Math.sign(d) as 1 | -1);
        },
      },
      'jump',
    ).name('step toward section');
    gui.close();
    st.open();
    this.loading = false;
    setInterval(() => this.refresh(), 500);
  }

  private refresh() {
    const app = this.game.app;
    const info = app.pipeline.renderer.info.render;
    this.stats.fps = app.fps.toFixed(0);
    this.stats.draws = String(info.calls);
    this.stats.tris = `${(info.triangles / 1e6).toFixed(2)} M`;
    this.stats.chunks = `${app.terrain.stats.visible} / ${app.terrain.stats.cached} (${app.terrain.stats.pending} pending)`;
    this.stats.quinlans = `${app.life.stats.drawn} drawn / ${app.life.stats.active} active`;
  }
}
