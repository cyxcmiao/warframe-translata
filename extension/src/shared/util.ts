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
