/** 每站启用状态（storage.local 直接读写，content 与 popup 共用） */
import { api } from './api';
import { STORAGE_KEYS } from './const';

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
