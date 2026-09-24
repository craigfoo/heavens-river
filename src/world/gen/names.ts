// Invented Quinlan-flavoured names from a syllable table (no names from the book).

import { Rng } from '../../core/rng';

const ONSETS = ['b', 'd', 'g', 'k', 'm', 'n', 'r', 's', 't', 'v', 'hr', 'qu', 'th', 'br', 'gr', 'kr', 'dr', 'sk', 'z', 'w', 'l', 'f', 'h', 'ch', 'y', 'p'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'aa', 'ei', 'ou', 'ai', 'uu', 'a', 'o', 'e'];
const CODAS = ['', '', '', 'n', 'r', 'm', 'k', 'sh', 'th', 'l', 'rn', 'st', 'rr', 'nd'];
const TOWN_SUFFIX = ['', '', '', 'ek', 'hol', 'anu', 'dar', 'um', 'ith', 'essa', 'ouk', 'arr', 'enni'];
const RIVER_SUFFIX = ['', '', 'aun', 'ul', 'e', 'orr', 'ai'];

function syllable(rng: Rng, first: boolean): string {
  const onset = first || rng.chance(0.8) ? rng.pick(ONSETS) : '';
  return onset + rng.pick(VOWELS) + rng.pick(CODAS);
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clean(s: string): string {
  // avoid triple letters and awkward clusters
  return s.replace(/(.)\1\1+/g, '$1$1').replace(/([^aeiou])([^aeiou])([^aeiou])([^aeiou])/g, '$1$2$4');
}

export function townName(rng: Rng): string {
  const n = rng.weighted([1, 2, 3], [3, 6, 2]);
  let s = '';
  for (let i = 0; i < n; i++) s += syllable(rng, i === 0);
  s += rng.pick(TOWN_SUFFIX);
  s = clean(s);
  if (s.length > 11) s = s.slice(0, 11);
  if (rng.chance(0.08)) s += ' ' + capital(clean(syllable(rng, true)));
  return capital(s);
}

export function riverName(rng: Rng): string {
  const n = rng.weighted([1, 2], [4, 5]);
  let s = '';
  for (let i = 0; i < n; i++) s += syllable(rng, i === 0);
  s += rng.pick(RIVER_SUFFIX);
  return capital(clean(s));
}

/** Quinlan-flavoured section numbering (base 8 with named digits). */
const DIGITS = ['nul', 'ek', 'dau', 'tri', 'kov', 'pim', 'shek', 'sev'];
export function quinlanNumber(n: number): string {
  if (n === 0) return DIGITS[0];
  const parts: string[] = [];
  let x = Math.floor(Math.abs(n));
  while (x > 0) {
    parts.unshift(DIGITS[x % 8]);
    x = Math.floor(x / 8);
  }
  return parts.join('-');
}

export function octal(n: number): string {
  return Math.floor(Math.abs(n)).toString(8);
}
