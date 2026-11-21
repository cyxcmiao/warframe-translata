/** options 页逻辑 */
import { api } from '../shared/api';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/const';
import { formatShortcut } from '../shared/hotkey';
import { getUsage } from '../background/usage';
import type { Settings, GlossaryMeta } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const inputs = {
  aiBaseUrl: $('aiBaseUrl') as HTMLInputElement,
  aiKey: $('aiKey') as HTMLInputElement,
  aiModel: $('aiModel') as HTMLInputElement,
  autoTranslate: $('autoTranslate') as HTMLInputElement,
  translateComments: $('translateComments') as HTMLInputElement,
  zhSearch: $('zhSearch') as HTMLInputElement,
  fontSize: $('fontSize') as HTMLInputElement,
  color: $('color') as HTMLInputElement,
  toggleShortcut: $('toggleShortcut') as HTMLInputElement,
};

async function load(): Promise<Settings> {
  const o = await api.storage.local.get(STORAGE_KEYS.settings);
  const s: Settings = { ...DEFAULT_SETTINGS, ...(o[STORAGE_KEYS.settings] as Partial<Settings> | undefined) };
  inputs.aiBaseUrl.value = s.aiBaseUrl;
  inputs.aiKey.value = s.aiKey;
  inputs.aiModel.value = s.aiModel;
  inputs.autoTranslate.checked = s.autoTranslate;
  inputs.translateComments.checked = s.translateComments;
  inputs.zhSearch.checked = s.zhSearch;
  inputs.fontSize.value = String(s.fontSize);
  inputs.color.value = s.color;
  inputs.toggleShortcut.value = s.toggleShortcut;
  return s;
}

function collect(): Settings {
  return {
    aiBaseUrl: inputs.aiBaseUrl.value.trim(),
    aiKey: inputs.aiKey.value.trim(),
    aiModel: inputs.aiModel.value.trim(),
    autoTranslate: inputs.autoTranslate.checked,
    translateComments: inputs.translateComments.checked,
    zhSearch: inputs.zhSearch.checked,
    fontSize: Math.min(20, Math.max(11, Number(inputs.fontSize.value) || DEFAULT_SETTINGS.fontSize)),
    color: inputs.color.value,
    toggleShortcut: inputs.toggleShortcut.value.trim(),
    glossaryCheckHours: DEFAULT_SETTINGS.glossaryCheckHours,
  };
}

let saveResetTimer: ReturnType<typeof setTimeout> | null = null;

async function save(): Promise<Settings> {
  const s = collect();
  await api.storage.local.set({ [STORAGE_KEYS.settings]: s });
  $('save').textContent = '已保存 ✓';
  if (saveResetTimer) clearTimeout(saveResetTimer);
  saveResetTimer = setTimeout(() => ($('save').textContent = '保存设置'), 1200);
  return s;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 输入过程中防抖自动保存（颜色拖动/文本输入等高频 input 事件） */
function scheduleSave(delayMs = 500): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), delayMs);
}

// 所有设置项变更即自动保存，无需点「保存设置」；颜色/字号立即应用到已打开的 wiki 页
for (const input of Object.values(inputs)) {
  input.addEventListener('change', () => void save());
  input.addEventListener('input', () => scheduleSave());
}

$('save').addEventListener('click', () => void save());

// ---- 快捷键录制（点击输入框 → 按下组合键，Esc 取消，Backspace 清除） ----
const scInput = inputs.toggleShortcut;
const scResult = $('shortcutResult');
let scSaved = ''; // 进入录制前的值（Esc 恢复用）

scInput.addEventListener('focus', () => {
  scSaved = scInput.value;
  scInput.value = '';
  scInput.placeholder = '按下组合键…（Esc 取消）';
  scResult.textContent = '';
});
scInput.addEventListener('blur', () => {
  scInput.placeholder = '点击后按下组合键';
});
scInput.addEventListener('keydown', e => {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    scInput.value = scSaved;
    scResult.textContent = '已取消';
    scResult.style.color = '';
    scInput.blur();
    return;
  }
  if (e.key === 'Backspace') {
    scInput.value = '';
    scResult.textContent = '快捷键已禁用';
    scResult.style.color = '#6b7280';
    void save();
    scInput.blur();
    return;
  }
  const sc = formatShortcut(e);
  if (!sc) {
    scResult.textContent = '需包含 Ctrl/Alt/Shift 修饰键（F1~F12 可单独使用）';
    scResult.style.color = '#c0392b';
    return;
  }
  scInput.value = sc;
  scResult.textContent = `已设为 ${sc}`;
  scResult.style.color = '#2a9d5c';
  void save();
  scInput.blur();
});
$('shortcutClear').addEventListener('click', () => {
  scInput.value = '';
  scResult.textContent = '快捷键已禁用';
  scResult.style.color = '#6b7280';
  void save();
});

$('test').addEventListener('click', async () => {
  const s = await save(); // 先保存再测试，后台读的是已保存配置
  $('aiResult').textContent = '测试中…';
  const r = (await api.runtime.sendMessage({ type: 'aiTest' })) as { ok: boolean; message: string };
  $('aiResult').textContent = r.message;
  $('aiResult').style.color = r.ok ? '#2a9d5c' : '#c0392b';
  void s;
});

$('perm').addEventListener('click', async () => {
  const base = inputs.aiBaseUrl.value.trim();
  if (!base) {
    $('aiResult').textContent = '请先填写接口地址';
    return;
  }
  try {
    const origin = new URL(base).origin + '/*';
    const granted = await api.permissions.request({ origins: [origin] });
    $('aiResult').textContent = granted ? `已授权 ${origin}` : `未授权 ${origin}`;
    $('aiResult').style.color = granted ? '#2a9d5c' : '#c0392b';
  } catch (e) {
    $('aiResult').textContent = `授权失败: ${e}`;
  }
});

async function refreshGlossStatus(): Promise<void> {
  const meta = (await api.runtime.sendMessage({ type: 'glossaryStatus' })) as GlossaryMeta;
  const last = meta.lastCheck ? new Date(meta.lastCheck).toLocaleString() : '从未';
  const langLast = meta.langLastCheck ? new Date(meta.langLastCheck).toLocaleString() : '从未';
  const kept = meta.retainedCount ? ` · ${meta.retainedCount} 条保留英文名` : '';
  $('glossStatus').textContent =
    `版本 ${meta.version} · ${meta.count} 条译名（官方词表 + 内置机制表）${kept} · 上次检查: ${last}；` +
    `语言层 ${meta.langCount} 条 · 上次拉取: ${langLast}`;
}

const fmtNum = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const fmtBytes = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** 本月 AI 用量（来自接口响应的 usage 字段，仅本机保存） */
async function refreshUsage(): Promise<void> {
  const el = $('usageStatus');
  try {
    const u = await getUsage();
    if (!u || (!u.prompt && !u.completion)) {
      el.textContent = '本月暂无 AI 请求记录。';
      return;
    }
    el.textContent =
      `本月（${u.month}）AI 用量：输入 ${fmtNum(u.prompt)} + 输出 ${fmtNum(u.completion)} tokens，` +
      `共 ${u.requests} 次请求。费用按你所用接口的模型计价。`;
  } catch {
    el.textContent = '用量读取失败。';
  }
}

async function refreshCache(): Promise<void> {
  const s = (await api.runtime.sendMessage({ type: 'cacheStats' })) as { count: number; bytes: number };
  $('cacheStatus').textContent = `已缓存 ${s.count} 条译文 · 约 ${fmtBytes(s.bytes)}`;
}

$('cacheClear').addEventListener('click', async () => {
  const btn = $('cacheClear') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const s = (await api.runtime.sendMessage({ type: 'cacheClear' })) as { count: number; bytes: number };
    $('cacheResult').textContent = '已清空 ✓';
    $('cacheResult').style.color = '#2a9d5c';
    $('cacheStatus').textContent = `已缓存 ${s.count} 条译文 · 约 ${fmtBytes(s.bytes)}`;
  } catch (e) {
    $('cacheResult').textContent = `清空失败: ${e}`;
    $('cacheResult').style.color = '#c0392b';
  } finally {
    btn.disabled = false;
  }
});

$('glossUpdate').addEventListener('click', async () => {
  $('glossResult').textContent = '检查中…';
  const r = (await api.runtime.sendMessage({ type: 'glossaryUpdate', force: true })) as {
    updated: boolean;
    count: number;
    error?: string;
    remote?: { updated: boolean; changed: string[]; error?: string };
  };
  const remoteNote = r.remote
    ? r.remote.error
      ? `；远程层失败: ${r.remote.error}`
      : r.remote.updated
        ? `；远程层已更新（${r.remote.changed.join('/')}）`
        : '；远程层已是最新'
    : '';
  if (r.error) {
    $('glossResult').textContent = `失败: ${r.error}${remoteNote}`;
    $('glossResult').style.color = '#c0392b';
  } else {
    $('glossResult').textContent =
      (r.updated ? `已更新，当前 ${r.count} 条` : `已是最新（${r.count} 条）`) + remoteNote;
    $('glossResult').style.color = r.remote?.error ? '#c0392b' : '#2a9d5c';
  }
  void refreshGlossStatus();
});

$('ver').textContent = api.runtime.getManifest().version;
void load().then(() => {
  void refreshGlossStatus();
  void refreshUsage();
  void refreshCache();
});
