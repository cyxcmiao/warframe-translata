/** popup 逻辑 */
import { api } from '../shared/api';
import { getSiteEnabled, setSiteEnabled } from '../shared/site';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/const';
import type { Settings, GlossaryMeta } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let origin = '';

async function init(): Promise<void> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;
  const isWiki = !!url && /https:\/\/wiki\.warframe\.com\//.test(url);
  if (isWiki && url) {
    origin = new URL(url).origin;
    ($('siteEnabled') as HTMLInputElement).checked = await getSiteEnabled(origin);
  } else {
    const row = $('siteEnabled') as HTMLInputElement;
    row.disabled = true;
    row.checked = false;
    $('msg').textContent = '本页不是 Warframe Wiki';
  }

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
    // 语言层陈旧警示（GitHub 不可达等）：>7 天未成功拉取时提示，翻译不受影响
    const warn = $('langWarn') as HTMLParagraphElement;
    const days = meta.langLastCheck
      ? Math.floor((Date.now() - new Date(meta.langLastCheck).getTime()) / 86400000)
      : null;
    if (days === null || days >= 7) {
      warn.textContent =
        days === null
          ? '语言层词条尚未联网拉取（刚安装或网络受限），当前使用内置词条，翻译不受影响'
          : `语言层词条已 ${days} 天未更新（GitHub 不可达？），翻译仍使用内置词条`;
      warn.style.color = '#e67e22';
      warn.style.display = 'block';
    }
  }
}

$('siteEnabled').addEventListener('change', async e => {
  if (!origin) return;
  const on = (e.target as HTMLInputElement).checked;
  await setSiteEnabled(origin, on);
  await api.tabs.sendMessage(await activeTabId(), { type: on ? 'translateNow' : 'restore' });
});

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
