// Journal (J): discovered places, field notes on the megastructure and the
// Quinlans, and a few statistics of your journey.

import { wrapS } from '../coords/cylinder';
import type { TownSite } from '../world/gen/settlements';
import type { WorldGen } from '../world/gen/world';
import { quinlanNumber } from '../world/gen/names';

export interface JournalContext {
  gen: WorldGen;
  section: number;
  isKnown: (t: TownSite) => boolean;
  player: { s: number; z: number };
  stats: { distance: number; swims: number; trips: number; played: number };
  travel: (t: TownSite) => void;
  destination: (t: TownSite) => void;
}

const NOTES: [string, string][] = [
  ['The strand', "Heaven's River is a topopolis: an O'Neill cylinder stretched into a closed loop, a billion miles long, wrapping the star Eta Leporis three times in loose loops."],
  ['Scale', 'The inner cylinder has a 56-mile (90 km) radius. It spins at about 1,800 mph (805 m/s), a turn every eleven and a half minutes, giving roughly 0.73 of a standard gravity. "Up" is toward the axis.'],
  ['Sections', 'The strand is built from 560-mile sections, each capped by barriers disguised as mountains that can seal the section in a blowout. Four main rivers run the length of each section, flowing in alternating directions, meandering to maximise shoreline.'],
  ['The sky', 'A fusion-powered light runs down the central axis. By day a diffuse hologram hides the shaft and the far side of the world; at night it projects constellations. Switch it off (B) and you will see the land curving right over your head, rivers like silver threads 180 km up.'],
  ['The ground', 'The terrain is formed into the shell itself. Hollow spaces beneath the hills hold infrastructure and maintenance centres. Nine spaceports dot the non-rotating outer shell.'],
  ['Anek', 'The structure is run by an AI, Anek, which watches through fusion-powered robotic birds and moves populations between segments in "Scatterings". Look for its birds on rooftops.'],
  ['Quinlans', 'About four feet tall, stocky and furry, with an otter-like face and a beaky, toothed snout (the houra). Their eyes sit on the sides of their heads and move independently. They swim superbly, run fastest on all fours, and rub their jaws side to side when they smile.'],
  ['Society', 'Iron Age, agricultural and trade-based, paying in coppers and irons. Everything is decorated. Quinlans are great singers — they can sing two melodies at once — poor dancers, loud, social and quick to anger.'],
];

export class Journal {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  private ctx: JournalContext | null = null;
  private tab: 'places' | 'notes' | 'journey' = 'places';
  isOpen = false;
  onClose: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'screen journal-screen';
    this.root.innerHTML = `
      <div class="book">
        <div class="book-head">
          <div class="title">Journal</div>
          <div class="tabs"><button data-t="places" class="on">Places</button><button data-t="notes">Field notes</button><button data-t="journey">Journey</button></div>
          <button class="btn close">Close <span class="key">J</span></button>
        </div>
        <div class="book-body"></div>
      </div>`;
    parent.appendChild(this.root);
    this.body = this.root.querySelector('.book-body') as HTMLDivElement;
    (this.root.querySelector('.close') as HTMLButtonElement).onclick = () => this.onClose();
    this.root.querySelectorAll<HTMLButtonElement>('[data-t]').forEach((b) => {
      b.onclick = () => {
        this.tab = b.dataset.t as 'places';
        this.root.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b));
        this.render();
      };
    });
  }

  open(ctx: JournalContext) {
    this.ctx = ctx;
    this.isOpen = true;
    this.root.classList.add('open');
    this.render();
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  private render() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.tab === 'notes') {
      this.body.innerHTML = NOTES.map(([h, p]) => `<h3>${h}</h3><p>${p}</p>`).join('');
      return;
    }
    if (this.tab === 'journey') {
      const known = ctx.gen.towns.filter(ctx.isKnown).length;
      const st = ctx.stats;
      this.body.innerHTML = `
        <h3>Section ${quinlanNumber(ctx.section)} (${ctx.section})</h3>
        <p>You have come to know <b>${known}</b> of the ${ctx.gen.towns.length} settlements in this section.</p>
        <p>Distance walked and swum: <b>${(st.distance / 1000).toFixed(1)} km</b> · river journeys: <b>${st.trips}</b> · dives: <b>${st.swims}</b></p>
        <p>Time spent on the River: <b>${Math.floor(st.played / 60)} min</b></p>
        <p class="dim">The section is 901 km long and 566 km around. At a Quinlan's quadruped gallop of 7 m/s, walking it end to end would take about a day and a half without rest.</p>`;
      return;
    }
    // places, grouped by river
    let html = '';
    for (const rv of ctx.gen.rivers) {
      const towns = ctx.gen.towns.filter((t) => t.river === rv.index && ctx.isKnown(t)).sort((a, b) => (a.z - b.z) * rv.flow);
      html += `<h3>The ${rv.name} <span class="dim">· flows ${rv.flow > 0 ? 'Fore' : 'Aft'} · ${towns.length} known</span></h3>`;
      if (!towns.length) {
        html += `<p class="dim">No settlements known yet.</p>`;
        continue;
      }
      html += '<ul class="places">';
      for (const t of towns) {
        const d = Math.hypot(wrapS(t.s - ctx.player.s), t.z - ctx.player.z) / 1000;
        html += `<li><span class="nm">${t.name}</span> <span class="dim">${t.kind === 'city' ? 'river city' : t.kind} · ${d < 10 ? d.toFixed(1) : Math.round(d)} km</span>
          <button class="btn sm" data-go="${t.id}">Travel</button><button class="btn sm" data-dest="${t.id}">Destination</button></li>`;
      }
      html += '</ul>';
    }
    this.body.innerHTML = html;
    this.body.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => {
      b.onclick = () => {
        const t = ctx.gen.towns.find((x) => x.id === Number(b.dataset.go));
        if (t) ctx.travel(t);
      };
    });
    this.body.querySelectorAll<HTMLButtonElement>('[data-dest]').forEach((b) => {
      b.onclick = () => {
        const t = ctx.gen.towns.find((x) => x.id === Number(b.dataset.dest));
        if (t) ctx.destination(t);
      };
    });
  }
}
