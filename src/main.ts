import { App } from './app';
import { Game } from './gameplay/game';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const app = new App(canvas);
const game = new Game(app);
app.onFrame.push((dt) => game.update(dt));
(window as unknown as { __hr: App; __game: Game }).__hr = app;
(window as unknown as { __game: Game }).__game = game;
game.start();
if (!app.testMode) app.start();
