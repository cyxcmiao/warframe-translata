/** background 入口 — 消息路由 / 词表定时更新 */
import { ensureGlossary, glossaryMeta, updateGlossary, updateRemoteLayers, UpdateResult } from './glossary';
import { translateBlocks, aiTest, cacheStats, cacheClear } from './translate';
import { getSettings } from './settings';
import { api } from '../shared/api';
import type { Settings } from '../shared/types';

async function scheduleGlossaryCheck() {
  const s = await getSettings();
  api.alarms.create('glossaryCheck', {
    periodInMinutes: Math.max(60, s.glossaryCheckHours * 60),
    delayInMinutes: 1,
  });
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
  // 语言层 + 人工层：GitHub 托管仓库按 sha 增量拉取。
  // 自动失败不主动打扰（设置页"上次拉取"时间侧面体现），手动检查失败才在设置页提示。
  updateRemoteLayers(false)
    .then(r => {
      if (r.updated) console.log('remote layers auto-updated:', r.changed.join('/'));
      else if (r.error) console.warn('remote layers update failed:', r.error);
    })
    .catch(e => console.warn('remote layers update crashed:', e));
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
        // 不把明文 aiKey 发给 content script（隔离世界仍属不必要暴露面），只给布尔位
        const safe: Settings = { ...settings, aiKey: '', hasKey: !!settings.aiKey };
        sendResponse({ settings: safe, glossary: glossaryMeta(), ready: true });
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
        const [r, remote] = await Promise.all([updateGlossary(msg.force ?? true), updateRemoteLayers(msg.force ?? true)]);
        const res: UpdateResult & { remote?: { updated: boolean; changed: string[]; error?: string } } = { ...r, remote };
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
