// User settings (persisted with the save).

export interface Settings {
  quality: 'low' | 'medium' | 'high';
  fov: number; // horizontal degrees, 100 default, up to 140
  sensitivity: number;
  invertY: boolean;
  dayMinutes: number;
  freezeTime: boolean;
  goldenLiberty: boolean; // bright zone along the axis at dawn/dusk (artistic liberty)
  hologramHeight: number; // km above the base shell
  fog: number;
  coriolis: boolean; // "physics nerd" setting
  allTowns: boolean; // all towns unlocked on the map
  anekCutscenes: boolean; // surveillance-bird cutscene flavour
  tripSeconds: number; // barge trip length (60..180)
  volume: number;
  muted: boolean;
  visionMode: 'panorama' | 'split';
  showDebug: boolean;
  grass: boolean;
  shadows: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  fov: 100,
  sensitivity: 1,
  invertY: false,
  dayMinutes: 20,
  freezeTime: false,
  goldenLiberty: true,
  hologramHeight: 24,
  fog: 1,
  coriolis: false,
  allTowns: false,
  anekCutscenes: false,
  tripSeconds: 120,
  volume: 0.7,
  muted: false,
  visionMode: 'panorama',
  showDebug: false,
  grass: true,
  shadows: true,
};

export function loadSettings(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (v !== undefined && typeof v === typeof DEFAULT_SETTINGS[k]) (s as Record<string, unknown>)[k] = v;
    }
  }
  s.fov = Math.min(140, Math.max(60, s.fov));
  s.tripSeconds = Math.min(180, Math.max(60, s.tripSeconds));
  return s;
}
