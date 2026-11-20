# translataWiki — Warframe 英文 Wiki 精准翻译扩展

用 **Warframe 官方简中数据导出**的词表 + AI 整句增强精准翻译英文 Wiki：术语 100% 采用游戏内官方译名。双语对照呈现（沉浸式翻译风格），支持 Chrome/Edge 与 Firefox。需在设置中填写 OpenAI 兼容接口，未配置 Key 时不翻译。

## 核心机制

1. **官方词表**（9700+ 条 en→zh）来自 DE 官方导出（游戏内实际显示文本），按 `uniqueName` 配对生成；另有两个补充层：**机制术语表**（wiki 用语，人工维护）与**游戏语言文件挖掘层**（`build_lang_terms.js` 从 `/Lotus/Language/*Name` 展示名 key 挖出 ~1.7 万条，覆盖官方导出缺的 UI 复合词如 Tether-Flechette Orb→桎梏飞掷丸；优先级 官方 > 语言层 > 机制表）：
   - 官方未译名的条目（Excalibur、Saryn 等战甲名）不进表，另记入 `retained`（保留英文原名，约 270 条）→ 译文中保留英文，与官方惯例一致；
   - 泛词停用表（`data/stoplist.json`）拦截 Fire/Bow/Boot 等恰好是物品名的常见英文单词，避免误伤普通句子；
   - **机制术语表**（`data/mechanism_terms.json`）补充官方导出没有的 wiki 用语（Damage Falloff / Status Effect / proc 等），语言文件层则自动覆盖游戏 UI 复合词；两层优先级均低于官方词表、retained 名不翻译。
   - **悬浮提示**：wiki Tooltip 扩展的隐藏仓库（`#tooltip-storage`）不参与初始扫描，悬停触发、站点 JS 把内容移入浮层时按需增量翻译——不预翻用户没悬停过的提示。
2. **AI 增强翻译**（OpenAI 兼容自填接口，未配置 Key 时不翻译并在页面弹提示）：词表 Trie 匹配（最长优先 + 复数 `Primes`/所有格 `Saryn's`/大小写/跨空白）先行，**只把当前块命中的术语**注入 prompt（词表译名最高优先级）；译后校验强制回填漏译术语、校验链接占位符完整性；AI 原样回显视为假译文不落缓存；请求失败按类型提示（Key 无效 / 限流 / 超时 / 网络），失败块保留原文（不落缓存），页面顶部弹自动消散的提醒。
   - 省 token：词典已给出终局译文的块（纯链接文本、官方保留英文名、官方中文名里自带的英文如"猛虎 Prime"、纯数字/单位单元格 `36 m`、占位词 `None`/`N/A`）**不发 AI**，直接采用词典结果；请求带 `max_tokens` 兜底，输出被截断时丢弃末尾行。
   - **视口懒翻译**：只立即翻译首屏附近的块，视口外挂起，滚动接近时由 IntersectionObserver 放行——不翻用户没读到的部分，首屏出译文更快。
3. **持久化 + 增量更新**：词表存 IndexedDB，扩展内置快照兜底；后台每 24h 只拉官方索引（~500B×2 压缩），hash 变了才下载对应文件重建；**语言层词条**由 GitHub Actions 每日从游戏语言文件重建并提交到托管仓库（[cyxcmiao/warframe-translata](https://github.com/cyxcmiao/warframe-translata)），后台同一检查周期按内容 sha 增量拉取（raw → jsDelivr 双源回退，失败静默降级到当前层）；缓存 key = 提示词版本+词表版本+模式，改 prompt 时 bump `PROMPT_VERSION` 让旧缓存自然失效；设置页可查看缓存容量并一键清空；AI 用量（接口响应自带 usage）按月累计，设置页展示。
4. **呈现**：段落/标题译文插在原文正下方，表格单元格/信息框内追加译文；行内链接在译文中还原（链接文字也翻译）；长段落逐句对应。

## 目录

```
tools/build_de_map.js    # 拉官方导出生成 data/de_names.json（npm run build:data）
tools/build_lang_terms.js # 从游戏语言文件挖掘补充词条 data/lang_terms.json（Name 结尾 key，~1.7 万条）
tools/build_ext.js       # esbuild 构建 dist/chrome + dist/firefox（npm run build）
tools/test_matcher.js    # 匹配器单元测试（npm test）
tools/test_browser.js    # 真浏览器端到端测试（需可访问 fandom，当前环境不可达）
tools/test_ai.js         # AI 模式端到端测试（本地 mock 接口）
tools/test_options.js    # options 页 + 词表更新链路测试
tools/test_real_page.js  # 用保存的真实页面 HTML 回归（tools/.tmp/slash_dash.html）
tools/test_shortcut.js   # 快捷键切换 翻译/隐藏译文 回归（含改键/禁用）
tools/test_toast.js      # 无 Key 不翻译 + 连接失败弹提示 回归
tools/test_progress.js   # 顶部进度条回归：慢 AI 波次出现、结束消失（截图目检）
tools/test_skip.js       # 省 token 回归：终局块不进 AI 请求、请求带 max_tokens
tools/test_tooltip.js    # 悬浮提示按需翻译回归：初始跳过 #tooltip-storage，hover 移入浮层后增量翻译
tools/test_cache.js      # 缓存/懒翻译专项：版本前缀、回显不落缓存、单位跳过、视口挂起、用量统计、无 Key FAB
tools/measure_saving.js  # 用真实页面快照测量省下的 AI 行数/字符数
extension/src/           # 扩展源码（shared/background/content/options/popup）
```

## 开发

```bash
npm install
npm run build:data   # 重新生成词表（官方导出 + 语言文件层；tools/cache 有缓存，增量下载）
npm run build        # 构建扩展（esbuild 不做类型检查，改完源码先跑 typecheck）
npm run typecheck    # TypeScript 类型检查（extension/src 全量）
npm test             # 匹配器单元测试
node tools/test_browser.js "https://wiki.warframe.com/w/Tigris_Prime"
node tools/test_ai.js
node tools/test_options.js
```

浏览器测试需要 Playwright Chromium（`npx playwright-core install chromium`；本机 Chrome/Edge ≥137 已移除 `--load-extension` 支持）。fandom.com 在部分网络不通，测试用官方镜像 `wiki.warframe.com`（URL 短格式为 `/w/词条名`）。

## 安装使用

1. Chrome: 加载 `dist/chrome`（chrome://extensions → 开发者模式 → 加载已解压）；Firefox: `dist/firefox`（about:debugging → 临时载入）。
2. 右下角悬浮按钮开关；未配置 API Key 时不翻译，页面顶部会弹自动消散的提示；翻译进行中页顶居中显示灵动岛式进度胶囊（毛玻璃，缓存瞬时完成时不显示）。
3. **快捷键 Ctrl+Alt+D**（默认）：在 wiki 页面切换 翻译/隐藏译文——隐藏为 CSS 隐藏（DOM 保留），重新显示瞬时恢复，只补翻新增内容和失败块，不重发已缓存请求；在设置页「快捷键」区点击输入框按下新组合键即可改键（Backspace 清除禁用），立即生效。
4. 在 options 页填 OpenAI 兼容接口（Base URL + Key + 模型名），首次需点"授权接口域名"；填好后立即生效。

## 上架前待办

- [x] Firefox 实测（2026-11-20 通过：web-ext 装载 + 真页面词典模式渲染验证，AMO lint 0 错误）
- [x] `mechanism_terms.json` 机制术语表（官方导出无词条的 wiki 机制用语 + 游戏语言文件复合词如 桎梏飞掷丸，57 条；zh===en 条目=锁定保留英文；复数由匹配器自动处理，无需单列）
- [ ] 扩展图标（16/48/128 PNG）
- [ ] Chrome 商店：隐私政策页面 + 数据披露（页面文本发送至用户自配的第三方 AI 接口；key 仅存本地）
- [ ] AI 请求频控调优（当前每块 ≤16 段/1600 字符一批，单标签页串行；多标签页无全局并发闸）

## Firefox 安装说明

- 开发预览：`npx web-ext run --source-dir dist/firefox`（临时加载，文件变化自动重载）
- 手动临时加载：about:debugging → 此 Firefox → 临时载入附加组件 → 选 `dist/firefox/manifest.json`（重启 Firefox 失效）
- 正式版 Firefox 不允许未签名扩展常驻；自用长期方案是 Firefox Developer Edition / Nightly（`xpinstall.signatures.required=false`）或 AMO 自签发布（`npx web-ext sign`，需 AMO API key）
