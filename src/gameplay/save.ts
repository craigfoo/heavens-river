// Autosave to localStorage (spec 7.7): player (s, z, h), current town,
// discovered towns, time of day, settings, and a few journal stats.

import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../settings';

const KEY = 'heavens-river-explorer:save:v1';

export interface SaveData {
  version: 1;
  section: number;
  s: number;
  z: number;
  h: number;
  yaw: number;
  pitch: number;
  timeOfDay: number;
  currentTown: number | null;
  discovered: string[]; // `${section}:${siteId}`
  destination: { section: number; siteId: number } | null;
  settings: Settings;
  stats: { distance: number; swims: number; trips: number; played: number };
  introSeen: boolean;
  /** Player-chosen town names, `${section}:${siteId}` -> name. */
  names: Record<string, string>;
}

export function newSave(): SaveData {
  return {
    version: 1,
    section: 0,
    s: 0,
    z: 0,
    h: 0,
    yaw: 0,
    pitch: 0,
    timeOfDay: 0.68,
    currentTown: null,
    discovered: [],
    destination: null,
    settings: { ...DEFAULT_SETTINGS },
    stats: { distance: 0, swims: 0, trips: 0, played: 0 },
    introSeen: false,
    names: {},
  };
}

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const t = '__hr_test__';
    s.setItem(t, '1');
    s.removeItem(t);
    return s;
  } catch {
    return null;
  }
}

export function loadSave(): SaveData | null {
  const st = storage();
  if (!st) return null;
  try {
    const raw = st.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SaveData>;
    if (d.version !== 1 || typeof d.s !== 'number' || typeof d.z !== 'number') return null;
    const base = newSave();
    return {
      ...base,
      ...d,
      settings: loadSettings(d.settings),
      stats: { ...base.stats, ...(d.stats ?? {}) },
      discovered: Array.isArray(d.discovered) ? d.discovered.filter((x) => typeof x === 'string') : [],
      names: sanitizeNames(d.names),
    } as SaveData;
  } catch {
    return null;
  }
}

function sanitizeNames(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^\d+:\d+$/.test(k) && typeof v === 'string') {
      const name = cleanTownName(v);
      if (name) out[k] = name;
    }
  }
  return out;
}

/** Letters, spaces, apostrophes and hyphens; 1 to 28 characters. */
export function cleanTownName(v: string): string {
  return v
    .replace(/[^\p{L}\p{M} '\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);
}

export function writeSave(d: SaveData): boolean {
  const st = storage();
  if (!st) return false;
  try {
    st.setItem(KEY, JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

export function clearSave() {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
