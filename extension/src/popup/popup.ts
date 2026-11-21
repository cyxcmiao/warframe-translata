/** popup 逻辑 */
import { api } from '../shared/api';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/const';
import type { Settings, GlossaryMeta } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function init(): Promise<void> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;
  const isWiki = !!url && /https:\/\/wiki\.warframe\.com\//.test(url);
  if (!isWiki) $('msg').textContent = '本页不是 Warframe Wiki';

  const o = await api.storage.local.get(STORAGE_KEYS.settings);
  const s: Settings = { ...DEFAULT_SETTINGS, ...(o[STORAGE_KEYS.settings] as Partial<Settings> | undefined) };
  $('modeBadge').textContent = s.aiKey ? `AI 模式 · ${s.aiModel}` : '未配置 API Key（翻译未启用）';
  $('scHint').textContent = s.toggleShortcut
    ? `快捷键 ${s.toggleShortcut} 可在 wiki 页面直接切换 翻译/隐藏译文`
    : '';

  const meta = (await api.runtime.sendMessage({ type: 'glossaryStatus' }).catch(() => null)) as GlossaryMeta | null;
  if (meta) {
    const last = meta.lastCheck ? new Date(meta.lastCheck).toLocaleString() : '从未';
    $('gloss').textContent = `词表 v${meta.version} · ${meta.count} 条 · 上次检查 ${last}`;
  }
}

$('translateNow').addEventListener('click', async () => {
  await api.tabs.sendMessage(await activeTabId(), { type: 'translateNow' });
  window.close();
});

$('restore').addEventListener('click', async () => {
  await api.tabs.sendMessage(await activeTabId(), { type: 'restore' });
  window.close();
});

$('glossUpdate').addEventListener('click', async () => {
  $('msg').textContent = '检查更新中…';
  const r = (await api.runtime.sendMessage({ type: 'glossaryUpdate', force: true })) as {
    updated: boolean;
    count: number;
    error?: string;
  };
  $('msg').textContent = r.error
    ? `失败: ${r.error}`
    : r.updated
      ? `词表已更新（${r.count} 条）`
      : `已是最新（${r.count} 条）`;
  void init();
});

$('openOptions').addEventListener('click', () => void api.runtime.openOptionsPage());

function activeTabId(): Promise<number> {
  return api.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.id ?? -1);
}

void init();
