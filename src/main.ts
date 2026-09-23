import { App } from './app';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const app = new App(canvas);
(window as unknown as { __hr: App }).__hr = app;

// Spawn on the bank near the first river city, looking along the river.
const city = app.gen.towns.find((t) => t.kind === 'city') ?? app.gen.towns[0];
const rv = app.gen.rivers[city.river];
const z = city.z - city.halfLen - 600;
const bank = rv.channelAt(z) + city.side * (rv.widthAt(z) * 0.5 + 25);
app.spawn(bank, z, rv.flow > 0 ? Math.PI : 0);

canvas.addEventListener('click', () => app.input.requestLock());
if (!app.testMode) app.start();
