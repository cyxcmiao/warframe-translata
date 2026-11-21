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
