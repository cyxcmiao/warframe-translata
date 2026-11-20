/** background 入口 — 消息路由 / 词表定时更新 */
import { ensureGlossary, glossaryMeta, updateGlossary, updateLangTerms, UpdateResult } from './glossary';
import { translateBlocks, aiTest, cacheStats, cacheClear } from './translate';
import { getSettings } from './settings';
import { api } from '../shared/api';

async function scheduleGlossaryCheck() {
  const s = await getSettings();
  api.alarms.create('glossaryCheck', {
    periodInMinutes: Math.max(60, s.glossaryCheckHours * 60),
    delayInMinutes: 1,
  });
}

/**
 * 语言层拉取结果的用户可见反馈：连续失败 ≥3 次（≈3 天）在扩展图标上打橙色 ! 角标，
 * 成功即清除。自动失败不打断用户（不弹 toast），角标 + popup 警示 + 设置页状态行三层呈现。
 */
const LANG_FAIL_KEY = 'langFailCount';

async function noteLangResult(r: { error?: string }): Promise<void> {
  if (!r.error) {
    await api.storage.local.set({ [LANG_FAIL_KEY]: 0 });
    await api.action.setBadgeText({ text: '' });
    await api.action.setTitle({ title: 'Warframe Wiki 精准翻译' });
    return;
  }
  const o = await api.storage.local.get(LANG_FAIL_KEY);
  const n = ((o[LANG_FAIL_KEY] as number) || 0) + 1;
  await api.storage.local.set({ [LANG_FAIL_KEY]: n });
  if (n >= 3) {
    await api.action.setBadgeBackgroundColor({ color: '#e67e22' });
    await api.action.setBadgeText({ text: '!' });
    await api.action.setTitle({ title: 'Warframe Wiki 精准翻译\n⚠ 语言层词条更新失败（GitHub 不可达？）——翻译仍可用内置词条' });
  }
}

api.runtime.onInstalled.addListener(() => {
  ensureGlossary().catch(console.error);
  scheduleGlossaryCheck();
});

api.runtime.onStartup.addListener(() => {
  ensureGlossary().catch(console.error);
  scheduleGlossaryCheck();
});

api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'glossaryCheck') return;
  updateGlossary(false).then(r => {
    if (r.updated) console.log('glossary auto-updated, count=', r.count);
  });
  // 语言文件层：GitHub Actions 每日重建产物，这里按 sha 增量拉取（失败静默降级 + 角标提示）
  updateLangTerms(false)
    .then(r => {
      if (r.updated) console.log('lang terms auto-updated, count=', r.count);
      if (!r.skipped) void noteLangResult(r);
    })
    .catch(e => console.warn('lang terms update crashed:', e));
});

// 设置变化 → 重排词表检查周期
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  scheduleGlossaryCheck();
});

type Msg = { type: string; blocks?: Array<{ id: string; text: string }>; force?: boolean };

api.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'bootstrap': {
        await ensureGlossary();
        const settings = await getSettings();
        sendResponse({ settings, glossary: glossaryMeta(), ready: true });
        break;
      }
      case 'translate': {
        const settings = await getSettings();
        const r = await translateBlocks(msg.blocks || [], settings);
        sendResponse({ results: r.results, aiFailed: r.aiFailed, aiError: r.aiError });
        break;
      }
      case 'openOptions': {
        void api.runtime.openOptionsPage();
        sendResponse({ ok: true });
        break;
      }
      case 'cacheStats': {
        sendResponse(await cacheStats());
        break;
      }
      case 'cacheClear': {
        sendResponse(await cacheClear());
        break;
      }
      case 'glossaryStatus': {
        await ensureGlossary();
        sendResponse(glossaryMeta());
        break;
      }
      case 'glossaryUpdate': {
        const [r, lang] = await Promise.all([updateGlossary(msg.force ?? true), updateLangTerms(msg.force ?? true)]);
        if (!lang.skipped) void noteLangResult(lang);
        const res: UpdateResult & { lang?: { updated: boolean; count: number; error?: string } } = { ...r, lang };
        sendResponse(res);
        break;
      }
      case 'aiTest': {
        const s = await getSettings();
        sendResponse(await aiTest(s));
        break;
      }
      default:
        sendResponse({ error: `unknown message type: ${msg.type}` });
    }
  })().catch(e => {
    console.error('background handler error:', e);
    sendResponse({ error: String(e) });
  });
  return true; // 异步 sendResponse
});
