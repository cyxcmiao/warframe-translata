/** 通用工具 */

export function sha256hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  return crypto.subtle.digest('SHA-256', data).then(buf => {
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** base64 → UTF-8 文本（Gitee contents API 返回的文件内容用此解码；兼容带换行的 base64） */
export function b64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
