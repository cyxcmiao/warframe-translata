import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/const';
import { api } from '../shared/api';
import type { Settings } from '../shared/types';

export async function getSettings(): Promise<Settings> {
  const o = await api.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(o[STORAGE_KEYS.settings] as Partial<Settings> | undefined) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await api.storage.local.set({ [STORAGE_KEYS.settings]: s });
}

/** 每站启用状态 { [origin]: boolean }，缺省视为 true */
export async function getSiteEnabled(origin: string): Promise<boolean> {
  const o = await api.storage.local.get(STORAGE_KEYS.siteEnabled);
  const map = (o[STORAGE_KEYS.siteEnabled] as Record<string, boolean> | undefined) || {};
  return map[origin] !== false;
}

export async function setSiteEnabled(origin: string, enabled: boolean): Promise<void> {
  const o = await api.storage.local.get(STORAGE_KEYS.siteEnabled);
  const map = (o[STORAGE_KEYS.siteEnabled] as Record<string, boolean> | undefined) || {};
  map[origin] = enabled;
  await api.storage.local.set({ [STORAGE_KEYS.siteEnabled]: map });
}
