/**
 * mock_ai.js — 测试共用: 本地 mock OpenAI 兼容接口 + AI 设置注入
 *
 * mock 为回声式: 按编号行原样返回（保留 ⟦n⟧ 链接占位符），故意不做术语替换，
 * 让 enforceTerms 译后校验负责回填官方译名（与真实 AI 不听话的场景一致）。
 */
'use strict';
const http = require('http');

/** 启动 mock 接口，返回 Promise<server>；delayMs 可选，模拟慢接口（如进度条测试） */
function startMockAI(port, delayMs = 0) {
  let chatRequests = 0; // chat/completions 请求数（server.chatRequests() 读取，供测试断言）
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.url.endsWith('/chat/completions')) {
      chatRequests++;
      let data = '';
      req.on('data', c => (data += c));
      req.on('end', () => {
        try {
          const body = JSON.parse(data);
          const user = body.messages.find(m => m.role === 'user')?.content || '';
          const numbered = user.split(/文本：\n/)[1] || '';
          const out = numbered.split('\n').map(line => {
            const m = line.match(/^\[(\d+)\] (.*)$/);
            return m ? `[${m[1]}] 【AI】${m[2]}` : line;
          }).join('\n');
          const reply = () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: out }, finish_reason: 'stop' }] }));
          };
          if (delayMs > 0) setTimeout(reply, delayMs);
          else reply();
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.chatRequests = () => chatRequests;
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

/** 向扩展 SW 注入指向 mock 接口的 AI 设置（extra 合并进 settings） */
async function injectAISettings(sw, port, extra = {}) {
  await sw.evaluate(async ({ port, extra }) => {
    const settings = {
      aiBaseUrl: `http://127.0.0.1:${port}/v1`,
      aiKey: 'mock-key',
      aiModel: 'mock-1',
      autoTranslate: true,
      fontSize: 14,
      color: '#4a90d9',
      glossaryCheckHours: 24,
      ...extra,
    };
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  }, { port, extra });
}

module.exports = { startMockAI, injectAISettings };
