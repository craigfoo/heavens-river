// Cutscene travel (spec 7.5): fade to a painted title card with the
// destination in Quinlan glyphs, stream the destination behind it, optionally
// sweep over the town from the air, then fade in at the town's landing.

import { wrapS } from '../coords/cylinder';
import { Rng } from '../core/rng';
import type { TownSite } from '../world/gen/settlements';
import { glyphImage } from '../ui/glyphs';

export interface TravelHost {
  hudFade(v: number, color?: string): void;
  overlay: HTMLElement;
  /** Place the player (frozen) at a world position. */
  place(s: number, z: number, yaw: number): void;
  /** Camera override for the flyover (null = follow the player). */
  setCamera(c: { s: number; z: number; h: number; yaw: number; pitch: number } | null): void;
  requestTown(id: number): void;
  townPoi(id: number): { s: number; z: number; h: number; yaw: number } | null;
  terrainSettled(): boolean;
  groundAt(s: number, z: number): number;
  riverName(site: TownSite): string;
  anekStyle: boolean;
  flyover: boolean;
  sound?: { whoosh(): void; chime(): void; birdChirp(): void };
  onArrive(site: TownSite): void;
  wait(ms: number): Promise<void>;
}

const FLAVOUR = [
  (n: string, r: string) => `You follow the towpath along the ${r}, past mills and orchards, until the roofs of ${n} rise out of the haze.`,
  (n: string, r: string) => `A trading barge carries you down the ${r}. The crew sings in two voices the whole way to ${n}.`,
  (n: string) => `The road winds through wheat and reed beds, over little stone bridges, and on to ${n}.`,
  (n: string, r: string) => `You swim the last stretch of the ${r} for the joy of it, and climb out dripping on the quay at ${n}.`,
  (n: string) => `Carters, pilgrims and a very loud family of potters keep you company all the way to ${n}.`,
];

export class TravelDirector {
  private host: TravelHost;
  active = false;
  private card: HTMLDivElement;

  constructor(host: TravelHost) {
    this.host = host;
    this.card = document.createElement('div');
    this.card.className = 'titlecard';
    host.overlay.appendChild(this.card);
  }

  async travelTo(site: TownSite, from: { s: number; z: number }) {
    if (this.active) return;
    this.active = true;
    const h = this.host;
    const rng = new Rng(site.seed ^ Math.floor(performance.now()));
    const distKm = Math.hypot(wrapS(site.s - from.s), site.z - from.z) / 1000;
    h.sound?.whoosh();
    if (h.anekStyle) await this.anekBird();
    h.hudFade(1);
    await h.wait(650);
    // title card
    const kind = site.kind === 'city' ? 'River city' : site.kind === 'town' ? 'Town' : 'Hamlet';
    const river = h.riverName(site);
    const flav = h.anekStyle
      ? `A shadow crosses the sun. When you open your eyes you are somewhere else entirely — ${Math.round(distKm)} km away. Somewhere, Anek takes note.`
      : rng.pick(FLAVOUR)(site.name, river);
    this.card.innerHTML = `
      <div class="card">
        <img class="glyph" src="${glyphImage(site.name, 44, '#4a3220')}" alt="" />
        <div class="name">${site.name}</div>
        <div class="kind">${kind} on the ${river} · ${distKm < 10 ? distKm.toFixed(1) : Math.round(distKm)} km</div>
        <div class="flavour">${flav}</div>
        <div class="loading">…</div>
      </div>`;
    this.card.classList.add('show');
    const loading = this.card.querySelector('.loading') as HTMLDivElement;
    // stream the destination behind the card
    const rv = site.riverRef;
    const zc = site.z;
    const sc = rv.channelAt(zc) + site.side * (rv.widthAt(zc) * 0.5 + site.depthInland * 0.3);
    h.place(sc, zc, 0);
    h.requestTown(site.id);
    const t0 = performance.now();
    let poi: ReturnType<TravelHost['townPoi']> = null;
    while (performance.now() - t0 < 16000) {
      poi = h.townPoi(site.id);
      const minShown = performance.now() - t0 > 2800;
      if (poi && h.terrainSettled() && minShown) break;
      loading.textContent = poi ? 'arriving…' : 'travelling…';
      if (poi) h.place(poi.s, poi.z, poi.yaw);
      await h.wait(120);
    }
    if (!poi) poi = { s: sc, z: zc, h: h.groundAt(sc, zc), yaw: 0 };
    h.place(poi.s, poi.z, poi.yaw);
    this.card.classList.remove('show');
    // aerial sweep over the town
    if (h.flyover) {
      const dur = 2600;
      const start = performance.now();
      const dirS = Math.sin(poi.yaw);
      const dirZ = Math.cos(poi.yaw);
      h.hudFade(0);
      while (performance.now() - start < dur) {
        const t = (performance.now() - start) / dur;
        const e = t * t * (3 - 2 * t);
        const back = 420 - e * 520;
        const s = poi.s - dirS * back + (1 - e) * 120;
        const z = poi.z - dirZ * back;
        h.setCamera({ s, z, h: poi.h + 120 - e * 70, yaw: poi.yaw + Math.PI + (1 - e) * 0.4, pitch: -0.32 - e * 0.15 });
        await h.wait(16);
      }
      h.hudFade(1);
      await h.wait(450);
      h.setCamera(null);
    }
    h.place(poi.s, poi.z, poi.yaw + Math.PI);
    await h.wait(200);
    h.hudFade(0);
    h.sound?.chime();
    h.onArrive(site);
    this.active = false;
  }

  /** "Anek style": a surveillance bird swoops in and the scene cuts. */
  private async anekBird() {
    const bird = document.createElement('div');
    bird.className = 'anek-bird';
    bird.innerHTML = `<svg viewBox="0 0 180 90" width="180" height="90"><path d="M5 50 Q40 20 80 42 L92 36 Q100 30 108 36 L118 44 Q150 22 176 30 Q150 44 122 56 Q104 70 90 60 Q60 72 5 50 Z" fill="#0c0c10"/><circle cx="104" cy="40" r="2.2" fill="#ff3a2a"/></svg>`;
    this.host.overlay.appendChild(bird);
    this.host.sound?.birdChirp();
    requestAnimationFrame(() => bird.classList.add('fly'));
    await this.host.wait(900);
    setTimeout(() => bird.remove(), 1200);
  }
}
