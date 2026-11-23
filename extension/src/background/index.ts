/** background 入口 — 消息路由 / 词表定时更新 */
import {
  ensureGlossary,
  glossaryMeta,
  getUserTerms,
  setUserTerms,
  updateGlossary,
  updateRemoteLayers,
  zhResolve,
  zhSuggest,
  UpdateResult,
} from './glossary';
import { translateBlocks, aiTest, cacheStats, cacheClear, invalidateStaleCache } from './translate';
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

/**
 * 词表任一层变化后的缓存失效清理（invalidateStaleCache）：只删受词条变化影响的条目，
 * 用户下次访问自然重翻。后台自动路径失败静默（记忆约定：后台失败不打扰），
 * 靠下一轮词表更新重试兜底。
 */
async function sweepStaleCache(remoteUpdated: boolean, officialUpdated: boolean): Promise<void> {
  if (!remoteUpdated && !officialUpdated) return;
  try {
    await invalidateStaleCache();
  } catch (e) {
    console.warn('stale cache sweep failed:', e);
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
  updateGlossary(false)
    .then(r => {
      if (r.updated) console.log('glossary auto-updated, count=', r.count);
      return sweepStaleCache(false, r.updated);
    })
    .catch(e => console.warn('glossary update failed:', e));
  // 语言层 + 人工层：GitHub 托管仓库按 sha 增量拉取。
  // 自动失败不主动打扰（设置页"上次拉取"时间侧面体现），手动检查失败才在设置页提示。
  updateRemoteLayers(false)
    .then(r => {
      if (r.updated) console.log('remote layers auto-updated:', r.changed.join('/'));
      else if (r.error) console.warn('remote layers update failed:', r.error);
      return sweepStaleCache(r.updated, false);
    })
    .catch(e => console.warn('remote layers update crashed:', e));
});

// 设置变化 → 重排词表检查周期
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  scheduleGlossaryCheck();
});

type Msg = {
  type: string;
  blocks?: Array<{ id: string; text: string }>;
  force?: boolean;
  q?: string;
  limit?: number;
  terms?: Record<string, string>;
};

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
        // 手动检查路径：更新落地后同步清理失效缓存，再回报状态
        await sweepStaleCache(remote.updated, r.updated);
        const res: UpdateResult & { remote?: { updated: boolean; changed: string[]; error?: string } } = { ...r, remote };
        sendResponse(res);
        break;
      }
      case 'aiTest': {
        const s = await getSettings();
        sendResponse(await aiTest(s));
        break;
      }
      // 搜索框中文术语支持（纯词表反向查询，不依赖 AI Key）
      case 'zhSuggest': {
        await ensureGlossary();
        sendResponse({ items: zhSuggest(msg.q ?? '', msg.limit) });
        break;
      }
      case 'zhResolve': {
        await ensureGlossary();
        sendResponse(zhResolve(msg.q ?? ''));
        break;
      }
      // 用户自定义词表（本机层，options 页读写）。保存后精准失效受影响缓存：
      // 译名改/词条增删的缓存条目被清理，用户下次访问自然重翻（词典块本地即时重算零成本）
      case 'userTermsGet': {
        sendResponse(await getUserTerms());
        break;
      }
      case 'userTermsSet': {
        const r = await setUserTerms(msg.terms ?? {});
        let swept = -1;
        try {
          swept = await invalidateStaleCache();
        } catch (e) {
          console.warn('user terms cache sweep failed:', e); // 失效清理失败由下轮词表检查兜底
        }
        sendResponse({ ...r, swept });
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
