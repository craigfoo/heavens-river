// Scratch preview for the intro (open /src/intro/preview.html). The renderer is
// set up like the host's. Add ?manual to drive frames by hand, e.g. from a
// headless browser: window.__intro.snap(t) renders time t and returns a PNG.

import { NoToneMapping, SRGBColorSpace, WebGLRenderer } from 'three';
import { IntroSequence } from './intro';

const params = new URLSearchParams(location.search);
const manual = params.has('manual');
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  stencil: false,
  depth: true,
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(manual ? 1 : Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.autoClear = false; // the host's EffectComposer leaves it like this

const log: string[] = [];
let spin = 0;
const intro = new IntroSequence(renderer, document.getElementById('ui') as HTMLElement, {
  onPhase: (p) => log.push(`phase:${p}`),
  onSpinProgress: (p) => (spin = p),
  onElevator: (on) => log.push(`elevator:${on}`),
  onDock: () => log.push('dock'),
  onSkip: () => log.push('skip'),
});

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  intro.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

let done = false;
intro.start(() => {
  done = true;
  log.push('done');
});
if (params.has('t')) intro.seek(Number(params.get('t')));

if (!manual) {
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    intro.update((now - last) / 1000);
    last = now;
    intro.render();
    hud.textContent = `${intro.elapsed.toFixed(2)} s  spin ${spin.toFixed(3)}  ${done ? 'DONE' : ''}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

(window as unknown as { __intro: unknown }).__intro = {
  intro,
  log,
  get spin() {
    return spin;
  },
  get done() {
    return done;
  },
  /** Render time t (with a 1/60 s frame for motion blur) and return the canvas as a PNG data URL. */
  snap(t: number, dt = 1 / 60) {
    intro.seek(Math.max(0, t - dt));
    intro.update(dt);
    intro.render();
    return canvas.toDataURL('image/png');
  },
  seek(t: number) {
    intro.seek(t);
    intro.render();
  },
  /** A fresh sequence with logging hooks, for API tests (the preview's own loop keeps using `intro`). */
  make() {
    const events: string[] = [];
    const seq = new IntroSequence(renderer, document.getElementById('ui') as HTMLElement, {
      onPhase: (p) => events.push(`phase:${p}`),
      onSpinProgress: (p) => events.push(`spin:${p.toFixed(2)}`),
      onElevator: (on) => events.push(`elevator:${on}`),
      onDock: () => events.push('dock'),
      onSkip: () => events.push('skip'),
    });
    return { seq, events, renderer };
  },
};
