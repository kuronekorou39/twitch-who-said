import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  retentionDays: 365,
  maxPerUser: 2000,
  maxTotal: 2_000_000,
  excludeUsers: [],
  excludeSelf: false,
  knownBotsPreset: true,
  showOnModView: false,
};

/** knownBotsPreset が ON のとき除外する既知ボット(login 名) */
export const KNOWN_BOTS: readonly string[] = [
  'nightbot',
  'streamelements',
  'fossabot',
  'moobot',
  'streamlabs',
  'wizebot',
  'sery_bot',
  'soundalerts',
  'commanderroot',
  'botrixoficial',
];

const STORAGE_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = normalize({ ...current, ...patch });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** 除外対象の login 名集合(設定 + プリセット)を作る */
export function buildExcludeSet(settings: Settings, selfLogin?: string | null): Set<string> {
  const set = new Set(settings.excludeUsers.map((u) => u.toLowerCase()));
  if (settings.knownBotsPreset) for (const b of KNOWN_BOTS) set.add(b);
  if (settings.excludeSelf && selfLogin) set.add(selfLogin.toLowerCase());
  return set;
}

function normalize(s: Settings): Settings {
  const nonNeg = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback);
  return {
    retentionDays: nonNeg(s.retentionDays, DEFAULT_SETTINGS.retentionDays),
    maxPerUser: nonNeg(s.maxPerUser, DEFAULT_SETTINGS.maxPerUser),
    maxTotal: nonNeg(s.maxTotal, DEFAULT_SETTINGS.maxTotal),
    excludeUsers: [...new Set(s.excludeUsers.map((u) => u.trim().toLowerCase()).filter(Boolean))],
    excludeSelf: !!s.excludeSelf,
    knownBotsPreset: !!s.knownBotsPreset,
    showOnModView: !!s.showOnModView,
  };
}
