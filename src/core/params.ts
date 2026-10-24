export interface TerrainParams {
  seed: number;
  mountainHeight: number;
  ruggedness: number;
  ridgeSharpness: number;
  featureScale: number;
  flatland: number;
  erosionStrength: number;
  erosionDuration: number;
  sedimentDeposition: number;
  thermalSmoothing: number;
  rainfall: number;
  riverWidth: number;
  lakeFill: number;
  minLakeSize: number;
  seaLevel: number;
  island: boolean;
  coastlineWidth: number;
  baseQuality: 2048 | 4096;
  outputSpacing: 1 | 2;
  tileSize: 512 | 1024 | 2048;
  heightFormat: 'exr' | 'r16';
}

export const DEFAULT_PARAMS: TerrainParams = {
  seed: 1,
  mountainHeight: 1200,
  ruggedness: 0.5,
  ridgeSharpness: 0.6,
  featureScale: 3,
  flatland: 0.3,
  erosionStrength: 0.5,
  erosionDuration: 0.5,
  sedimentDeposition: 0.5,
  thermalSmoothing: 0.4,
  rainfall: 0.5,
  riverWidth: 1,
  lakeFill: 0.5,
  minLakeSize: 5000,
  seaLevel: 0.05,
  island: false,
  coastlineWidth: 1,
  baseQuality: 2048,
  outputSpacing: 1,
  tileSize: 1024,
  heightFormat: 'exr',
};

export const PARAM_RANGES = {
  seed: { min: 0, max: 4294967295 },
  mountainHeight: { min: 100, max: 3000 },
  ruggedness: { min: 0, max: 1 },
  ridgeSharpness: { min: 0, max: 1 },
  featureScale: { min: 0.5, max: 10 },
  flatland: { min: 0, max: 1 },
  erosionStrength: { min: 0, max: 1 },
  erosionDuration: { min: 0, max: 1 },
  sedimentDeposition: { min: 0, max: 1 },
  thermalSmoothing: { min: 0, max: 1 },
  rainfall: { min: 0, max: 1 },
  riverWidth: { min: 0.25, max: 3 },
  lakeFill: { min: 0, max: 1 },
  minLakeSize: { min: 500, max: 200000 },
  seaLevel: { min: 0, max: 0.5 },
  coastlineWidth: { min: 0.2, max: 3 },
} as const;

const ENUMS = {
  baseQuality: [2048, 4096],
  outputSpacing: [1, 2],
  tileSize: [512, 1024, 2048],
  heightFormat: ['exr', 'r16'],
} as const;

export class PresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetError';
  }
}

const STORAGE_KEY = 'terrain-gen:params';
const PRESET_VERSION = 1;

export function clampParams(p: Partial<TerrainParams>): TerrainParams {
  const out: Record<string, unknown> = { ...DEFAULT_PARAMS };
  const src = p as Record<string, unknown>;
  for (const key of Object.keys(PARAM_RANGES) as (keyof typeof PARAM_RANGES)[]) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const { min, max } = PARAM_RANGES[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  out.seed = Math.floor(out.seed as number);
  for (const key of Object.keys(ENUMS) as (keyof typeof ENUMS)[]) {
    if ((ENUMS[key] as readonly unknown[]).includes(src[key])) out[key] = src[key];
  }
  if (typeof src.island === 'boolean') out.island = src.island;
  // 2048 px tiles do not divide the 5120 px map at 2 m spacing.
  if (out.outputSpacing === 2 && out.tileSize === 2048) out.tileSize = 1024;
  return out as unknown as TerrainParams;
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function encodePreset(p: TerrainParams): string {
  return toBase64Url(JSON.stringify({ v: PRESET_VERSION, ...p }));
}

export function decodePreset(s: string): TerrainParams {
  let obj: unknown;
  try {
    if (!s) throw new Error('empty');
    obj = JSON.parse(fromBase64Url(s));
  } catch {
    throw new PresetError('Preset is not valid');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new PresetError('Preset is not valid');
  }
  const { v, ...rest } = obj as Record<string, unknown>;
  if (v !== PRESET_VERSION) throw new PresetError(`Unsupported preset version: ${String(v)}`);
  return clampParams(rest as Partial<TerrainParams>);
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSavedParams(storage?: Storage | null): { params: TerrainParams; warning?: string } {
  const st = storage === undefined ? defaultStorage() : storage;
  if (!st) return { params: { ...DEFAULT_PARAMS } };
  let raw: string | null;
  try {
    raw = st.getItem(STORAGE_KEY);
  } catch {
    return { params: { ...DEFAULT_PARAMS }, warning: 'Saved settings are unavailable (storage access denied).' };
  }
  if (raw === null) return { params: { ...DEFAULT_PARAMS } };
  try {
    return { params: decodePreset(raw) };
  } catch {
    return { params: { ...DEFAULT_PARAMS }, warning: 'Saved settings were corrupt and were reset to defaults.' };
  }
}

export function saveParams(p: TerrainParams, storage?: Storage | null): void {
  const st = storage === undefined ? defaultStorage() : storage;
  if (!st) return;
  try {
    st.setItem(STORAGE_KEY, encodePreset(p));
  } catch {
    // storage unavailable or full: saving is best-effort
  }
}
