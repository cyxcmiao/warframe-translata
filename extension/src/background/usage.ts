/**
 * usage.ts — AI 用量统计（月度累计，存 storage.local）
 *
 * 数据来自接口响应自带的 usage 字段（不发任何额外请求）。
 * 跨月自动清零；写入经模块级 Promise 串行化，避免并发读改写丢增量。
 */
import { api } from '../shared/api';
import { STORAGE_KEYS } from '../shared/const';

export interface UsageRec {
  month: string; // "2026-11"
  prompt: number;
  completion: number;
  requests: number;
}

function monthNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function doAdd(u: { prompt: number; completion: number }): Promise<void> {
  const o = await api.storage.local.get(STORAGE_KEYS.usage);
  const cur = (o[STORAGE_KEYS.usage] as UsageRec | undefined) ?? { month: '', prompt: 0, completion: 0, requests: 0 };
  const next: UsageRec = cur.month === monthNow()
    ? { ...cur }
    : { month: monthNow(), prompt: 0, completion: 0, requests: 0 };
  next.prompt += u.prompt;
  next.completion += u.completion;
  next.requests += 1;
  await api.storage.local.set({ [STORAGE_KEYS.usage]: next });
}

let chain: Promise<void> = Promise.resolve();

/** 记录一次请求的用量（fire-and-forget，失败不影响翻译） */
export function addUsage(u: { prompt: number; completion: number } | undefined): void {
  if (!u || (!u.prompt && !u.completion)) return;
  chain = chain.then(() => doAdd(u)).catch(() => {});
}

/** 当前月份的用量；跨月或无记录返回 null（视为零） */
export async function getUsage(): Promise<UsageRec | null> {
  const o = await api.storage.local.get(STORAGE_KEYS.usage);
  const cur = o[STORAGE_KEYS.usage] as UsageRec | undefined;
  if (!cur || cur.month !== monthNow()) return null;
  return cur;
}
