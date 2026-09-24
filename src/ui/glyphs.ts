// Invented Quinlan script: one flowing glyph per syllable, strung along a
// "river line". Glyph shapes are derived deterministically from a hash of the
// syllable, so every town name always looks the same.

import { hash2 } from '../core/rng';

export function syllables(word: string): string[] {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  const out: string[] = [];
  const re = /[^aeiou]*[aeiou]+(?:[^aeiou](?![aeiou]))?/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(w))) {
    out.push(m[0]);
    last = re.lastIndex;
    if (m[0].length === 0) break;
  }
  if (last < w.length) {
    if (out.length) out[out.length - 1] += w.slice(last);
    else out.push(w.slice(last));
  }
  return out.length ? out : [w || '?'];
}

function strHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return hash2(h, s.length, 77);
}

type Pt = [number, number];

function glyphStrokes(syl: string): { pts: Pt[]; w: number }[] {
  const h = strHash(syl);
  const r = (k: number) => ((h >>> (k * 3)) & 7) / 7;
  const strokes: { pts: Pt[]; w: number }[] = [];
  const kind = h % 6;
  const N = 18;
  const main: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let x = 0;
    let y = 0;
    switch (kind) {
      case 0: {
        // loop rising from the river line
        const a = t * Math.PI * 2 * 0.9 - Math.PI / 2;
        x = 0.5 + Math.cos(a) * (0.32 + r(1) * 0.1);
        y = 0.55 + Math.sin(a) * (0.35 + r(2) * 0.12);
        break;
      }
      case 1: {
        // hook
        x = 0.25 + t * 0.35 + Math.sin(t * Math.PI) * 0.25;
        y = 0.1 + t * 0.9 - Math.pow(t, 3) * 0.4 * r(3);
        break;
      }
      case 2: {
        // wave
        x = 0.1 + t * 0.8;
        y = 0.5 + Math.sin(t * Math.PI * 2 + r(1) * 2) * (0.25 + r(2) * 0.1);
        break;
      }
      case 3: {
        // chevron with curled tail
        x = 0.15 + t * 0.7;
        y = t < 0.5 ? 0.2 + t * 1.4 : 0.9 - (t - 0.5) * 1.1 + Math.sin(t * 12) * 0.03;
        break;
      }
      case 4: {
        // spiral
        const a = t * Math.PI * 3.2;
        const rr = 0.42 * (1 - t * 0.75);
        x = 0.5 + Math.cos(a) * rr;
        y = 0.55 + Math.sin(a) * rr;
        break;
      }
      default: {
        // tall stroke with a flick
        x = 0.45 + Math.sin(t * 2.2) * 0.12 * (r(4) - 0.5) * 2;
        y = 0.05 + t * 1.0;
        if (t > 0.8) x += (t - 0.8) * 1.5;
      }
    }
    main.push([x, y]);
  }
  strokes.push({ pts: main, w: 1 });
  // secondary mark
  const mk = (h >>> 12) % 5;
  if (mk === 0) strokes.push({ pts: [[0.72 + r(5) * 0.1, 1.15], [0.74 + r(5) * 0.1, 1.17]], w: 1.6 });
  else if (mk === 1) strokes.push({ pts: [[0.15, 0.95], [0.4, 1.1]], w: 0.7 });
  else if (mk === 2) {
    const b: Pt[] = [];
    for (let i = 0; i <= 8; i++) b.push([0.2 + i * 0.075, 0.28 + Math.sin(i * 0.9) * 0.05]);
    strokes.push({ pts: b, w: 0.6 });
  } else if (mk === 3) strokes.push({ pts: [[0.8, 0.3], [0.8, 0.85]], w: 0.8 });
  // vowel marks from the syllable's vowel
  const v = syl.match(/[aeiou]+/)?.[0] ?? '';
  if (v.includes('o') || v.includes('u')) strokes.push({ pts: [[0.5, -0.12], [0.52, -0.1]], w: 1.4 });
  if (v.length > 1) strokes.push({ pts: [[0.3, -0.14], [0.6, -0.16]], w: 0.6 });
  return strokes;
}

export interface GlyphStyle {
  color: string;
  size: number;
  riverLine?: boolean;
  glow?: string;
}

/** Draw a word in Quinlan glyphs; returns the drawn width. Baseline at y (river line). */
export function drawGlyphWord(ctx: CanvasRenderingContext2D, word: string, x: number, y: number, st: GlyphStyle, measureOnly = false): number {
  const syl = syllables(word);
  const s = st.size;
  const adv = s * 0.95;
  const width = syl.length * adv + s * 0.2;
  if (measureOnly) return width;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = st.color;
  if (st.glow) {
    ctx.shadowColor = st.glow;
    ctx.shadowBlur = s * 0.25;
  }
  if (st.riverLine !== false) {
    // the river line: a single flowing stroke under the whole word
    ctx.lineWidth = s * 0.07;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const px = x - s * 0.1 + t * width;
      const py = y + Math.sin(t * Math.PI * syl.length * 0.9) * s * 0.05;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  syl.forEach((sy, i) => {
    const ox = x + i * adv;
    for (const stroke of glyphStrokes(sy)) {
      ctx.lineWidth = s * 0.085 * stroke.w;
      ctx.beginPath();
      stroke.pts.forEach(([gx, gy], k) => {
        const px = ox + gx * s * 0.8;
        const py = y - gy * s * 0.9;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  });
  ctx.restore();
  return width;
}

/** Base-8 Quinlan numerals (used for section numbers). */
export function drawNumeral(ctx: CanvasRenderingContext2D, n: number, x: number, y: number, size: number, color: string): number {
  const digits = Math.max(0, Math.floor(n)).toString(8).split('').map(Number);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = size * 0.1;
  digits.forEach((d, i) => {
    const ox = x + i * size * 0.75;
    ctx.beginPath();
    // base stroke: a small arc (the river), plus d marks
    ctx.arc(ox + size * 0.3, y - size * 0.1, size * 0.28, Math.PI * 0.1, Math.PI * 0.9);
    ctx.stroke();
    for (let k = 0; k < d; k++) {
      const a = Math.PI * (1.15 + (k / Math.max(1, d - 1 || 1)) * 0.7);
      ctx.beginPath();
      ctx.moveTo(ox + size * 0.3 + Math.cos(a) * size * 0.3, y - size * 0.1 + Math.sin(a) * size * 0.3);
      ctx.lineTo(ox + size * 0.3 + Math.cos(a) * size * 0.5, y - size * 0.1 + Math.sin(a) * size * 0.5);
      ctx.stroke();
    }
    if (d === 0) {
      ctx.beginPath();
      ctx.moveTo(ox + size * 0.05, y - size * 0.42);
      ctx.lineTo(ox + size * 0.55, y - size * 0.42);
      ctx.stroke();
    }
  });
  ctx.restore();
  return digits.length * size * 0.75;
}

/** Render a word to a data URL (for DOM use). */
export function glyphImage(word: string, size: number, color: string, glow?: string): string {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const w = drawGlyphWord(ctx, word, 0, 0, { size, color }, true);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.ceil((w + size * 0.6) * dpr);
  c.height = Math.ceil(size * 1.6 * dpr);
  ctx.scale(dpr, dpr);
  drawGlyphWord(ctx, word, size * 0.3, size * 1.25, { size, color, glow });
  return c.toDataURL();
}
