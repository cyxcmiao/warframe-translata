# translataWiki — Warframe 英文 Wiki 精准翻译扩展

用 **Warframe 官方简中数据导出**的词表 + AI 整句增强精准翻译英文 Wiki：术语 100% 采用游戏内官方译名。双语对照呈现（沉浸式翻译风格），支持 Chrome/Edge 与 Firefox。需在设置中填写 OpenAI 兼容接口，未配置 Key 时不翻译。

## 核心机制

1. **官方词表**（9700+ 条 en→zh）来自 DE 官方导出（游戏内实际显示文本），按 `uniqueName` 配对生成；另有两个补充层：**机制术语表**（wiki 用语，人工维护）与**游戏语言文件挖掘层**（`build_lang_terms.js` 从 `/Lotus/Language/*Name` 展示名 key 挖出 ~1.7 万条，覆盖官方导出缺的 UI 复合词如 Tether-Flechette Orb→桎梏飞掷丸；优先级 官方 > 语言层 > 机制表）：
   - 官方未译名的条目（Excalibur、Saryn 等战甲名）不进表，另记入 `retained`（保留英文原名，约 270 条）→ 译文中保留英文，与官方惯例一致；
   - 泛词停用表（`data/stoplist.json`）拦截 Fire/Bow/Boot 等恰好是物品名的常见英文单词，避免误伤普通句子；
   - **机制术语表**（`data/mechanism_terms.json`）补充官方导出没有的 wiki 用语（Damage Falloff / Status Effect / proc 等），语言文件层则自动覆盖游戏 UI 复合词；两层优先级均低于官方词表、retained 名不翻译。
   - **悬浮提示**：wiki Tooltip 扩展的隐藏仓库（`#tooltip-storage`）不参与初始扫描，悬停触发、站点 JS 把内容移入浮层时按需增量翻译——不预翻用户没悬停过的提示。
   - **搜索框中文术语**（`shared/zhmatch.ts` 反向匹配器 zh→en，20272 个中文 key）：搜索框输入官方中文译名时，前缀/包含候选注入站点自带的 Codex 建议下拉（复用原生样式，借壳不另建 UI；词根输入如 布拉玛 → 赤毒·布拉玛，混合查询如 布拉玛 mod 按最长中文段匹配）；提交时完整术语改写为英文再发（包含改写取最短包含词条）（`zhSuggest`/`zhResolve` 消息，content 侧缓存热路径同步改写、未命中走后台）。纯词表反向查询，不依赖 AI Key。
2. **AI 增强翻译**（OpenAI 兼容自填接口，未配置 Key 时不翻译并在页面弹提示）：词表 Trie 匹配（最长优先 + 复数 `Primes`/所有格 `Saryn's`/大小写/跨空白）先行，**只把当前块命中的术语**注入 prompt（词表译名最高优先级）；译后校验强制回填漏译术语、校验链接占位符完整性；AI 原样回显视为假译文不落缓存；请求失败按类型提示（Key 无效 / 限流 / 超时 / 网络），页面顶部弹自动消散的提醒。**失败块显式标记**（不落缓存）：整批失败弹提醒，单块校验失败（缺行/占位符损坏/回显）静默——两者都不渲染误导性的"原文+译名链接"半翻译，滚动放行新内容时搭车自动补翻一次（仍失败即静默），快捷键重新显示时全部补翻重试（已成功块走缓存瞬时还原）。
   - 省 token：词典已给出终局译文的块（纯链接文本、官方保留英文名、官方中文名里自带的英文如"猛虎 Prime"、纯数字/单位单元格 `36 m`、占位词 `None`/`N/A`）**不发 AI**，直接采用词典结果；请求带 `max_tokens` 兜底，输出被截断时丢弃末尾行。
   - **视口懒翻译**：只立即翻译首屏附近的块，视口外挂起，滚动接近时由 IntersectionObserver 放行——不翻用户没读到的部分，首屏出译文更快。
3. **持久化 + 增量更新**：词表存 IndexedDB，扩展内置快照兜底；后台每 24h 只拉官方索引（~500B×2 压缩），hash 变了才下载对应文件重建；**语言层词条**由 GitHub Actions 每日从游戏语言文件重建并提交到托管仓库（[cyxcmiao/warframe-translata](https://github.com/cyxcmiao/warframe-translata)），后台同一检查周期按内容 sha 增量拉取（raw + jsDelivr 三入口 + statically 五源回退，全部失败静默降级到当前生效层——GitHub 不可达只延迟新词条，不影响翻译）；缓存 key = 提示词版本+模型+文本哈希；**词表更新按条目精准失效**——更新落地后逐条重匹配源文本，命中词条有增/删/译名变化的条目才清理，用户下次访问该页自然重翻（无词条命中的块永不误伤）；改 prompt 时 bump `PROMPT_VERSION` 全量失效；设置页可查看缓存容量并一键清空；AI 用量（接口响应自带 usage）按月累计，设置页展示。
4. **呈现**：段落/标题译文插在原文正下方（页面大标题 `h1#firstHeading` 在正文根之外，显式补采后同样紧贴标题渲染），表格单元格/信息框内追加译文（ability-box 类"标题内联 + 描述 p"的单元格，行内前奏译文插到首个 `<p>` 之前紧贴标题，且不再被单元格级翻译整段复读）；行内链接在译文中还原（链接文字也翻译）；长段落逐句对应。

## 目录

```
tools/build_de_map.js    # 拉官方导出生成 data/de_names.json（npm run build:data）
tools/build_lang_terms.js # 从游戏语言文件挖掘补充词条 data/lang_terms.json（Name 结尾 key，~1.7 万条）
tools/build_ext.js       # esbuild 构建三端产物 dist/chrome + dist/edge + dist/firefox（npm run build）
tools/gen_icons.js       # 生成扩展图标 16/32/48/128 + Edge 商店 logo 300（npm run icons，需 Playwright Chromium）
tools/pack.js            # 三端上架 zip（纯 stdlib 实现 zip 容器，npm run pack；manifest 在 zip 根、正斜杠条目，符合 AMO/Edge 要求）
tools/test_pack.js       # 上架包结构回归：manifest 根布局 / 无反斜杠条目 / icons 齐全 / 三端 manifest 差异点
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
tools/test_cache.js      # 缓存/懒翻译专项：版本前缀、回显不落缓存、单位跳过、视口挂起、用量统计、失败块搭车补翻只重发失败行
tools/test_ai_failure.js # AI 失败块回归：假译文回显静默不渲染（不做"原文+译名链接"误导呈现）、滚动搭车补翻、恢复后快捷键重试
tools/probe_steel_path.js # The Steel Path 快照页四反馈点探针（Enemy Health 修饰 li / 长段落 / 商店物品名 / Missions navbox）
tools/probe_atomi_title.js # Atomi-Boost 快照页标题探针（页面大标题 h1 译文、ability-box 标题紧贴渲染、无整段复读）
tools/test_navbox.js     # navbox 列表单元格回归：<td><div>链接•链接</div></td> 包装不再丢失（Auxiliary Power 反馈）
tools/test_zh_search.js  # ZhMatcher（zh→en 反向匹配器）单元测试：前缀/包含候选/一对多碰撞/括号变体/混合查询/resolve 改写（npm test）
tools/test_searchbox.js  # 搜索框中文术语 e2e：L1 注入站点下拉 / L2 点选桥接 / L3 提交改写（同步缓存 + 后台异步路径）
tools/probe_searchbox.js # 真站搜索框探针：Codex TypeaheadSearch DOM 结构、中/英文输入的下拉行为
tools/measure_saving.js  # 用真实页面快照测量省下的 AI 行数/字符数
extension/src/           # 扩展源码（shared/background/content/options/popup）
```

## 开发

```bash
npm install
npm run build:data   # 重新生成词表（官方导出 + 语言文件层；tools/cache 有缓存，增量下载）
npm run build        # 构建扩展（esbuild 不做类型检查，改完源码先跑 typecheck）
npm run icons        # 重新生成扩展图标（改了 tools/gen_icons.js 的 SVG 设计后）
npm run pack         # 三端上架/分发 zip → dist/pack/（打 v* tag 时 CI 自动构建并发布 Release）
node tools/test_pack.js  # 上架包结构回归
npm run typecheck    # TypeScript 类型检查（extension/src 全量）
npm test             # 匹配器单元测试
node tools/test_browser.js "https://wiki.warframe.com/w/Tigris_Prime"
node tools/test_ai.js
node tools/test_options.js
```

浏览器测试需要 Playwright Chromium（`npx playwright-core install chromium`；本机 Chrome/Edge ≥137 已移除 `--load-extension` 支持）。fandom.com 在部分网络不通，测试用官方镜像 `wiki.warframe.com`（URL 短格式为 `/w/词条名`）。

## 术语维护

**官方词表与语言文件层全自动**（24h 拉取，GitHub 托管仓 + 多镜像）。手动维护涉及两个文件，且**修改后 push 即免发版流转**——扩展后台 24h 内自动拉取全部三个远程层（机制表/语言层/覆盖层），无需发布新扩展版本：

1. **修正已有译名 / 强制保留英文 / 删除词条** → `data/manual_overrides.json`（人工覆盖层，优先级最高，可覆盖官方与 retained 锁定；值补映射、`zh===en` 锁保留英文、**空串 `""` = 从生效词表删除该词条**——人工裁决不收录的争议词不强制译名，交 AI 语境兜底）：
   ```json
   { "Flechette Orb": "飞掷丸", "Excalibur Umbra": "Excalibur Umbra", "NAME": "" }
   ```
2. **新增 wiki 用语** → `data/mechanism_terms.json`（机制术语表；`zh===en` = 锁定保留英文）
3. **拆词表补裸名** → `python -I tools/split_terms.py` 生成 `glossary_split_candidates.csv` 审核清单。词表按游戏实体整名收录（Anti Moa Purple / Demolisher Anti Moa / Vapos Anti Moa），Wiki 页面却常出现裸名（Anti Moa）无词条不翻译；工具枚举多词条目的连续词子序列（排除已有 key 与 retained），取出现在 ≥2 个条目中的候选，建议译名 = 各宿主条目译名的公共子串（LCS），与更长候选同建议的短者（Anti/Moa 相对 Anti Moa）及复数候选自动剔除。审核通过的行写 `data/manual_overrides.json` 即生效（新增 key 直接入生效词表）。

改完必做：

- **先 push 再重载**——运行时以托管仓库为准拉取人工层（未 push 的本地改动会被 24h 检查回退成仓库版本）；
- `npm run build` 重构建 + 重载扩展（本地立即可见）；
- **`PROMPT_VERSION` bump 规则**：新翻译立即用新词条；已缓存的旧译文在下次 bump（随重要修订的扩展版本发布时）或用户清缓存时刷新。日常小修不必 bump（避免全量缓存重翻烧 token），重要译名纠错随版本发布 bump 一次。

注意：**不要直接改 `data/lang_terms.json`**（Actions 每日重建会覆盖回去）；语言文件源头译名有误时走 manual_overrides 修正。

### Gitee 兜底源配置（可选，GitHub/jsDelivr 全不可达时的国内直连备份）

运行时拉取顺序：**GitHub raw → jsDelivr 三入口 → statically → Gitee（兜底）**。启用 Gitee 兜底源：

1. 注册 Gitee 并完成实名认证 → 创建**空**仓库 `warframe-translata`（不要初始化 README/任何文件）；
2. Gitee → 设置 → 私人令牌：生成 token（勾选 projects 读写权限）；
3. GitHub 仓库 → Settings → Secrets and variables → Actions，添加 `GITEE_USER`（Gitee 用户名）和 `GITEE_TOKEN`（令牌值）；
4. GitHub Actions 手动触发一次 update-lang-terms → 完整历史强制镜像到 Gitee。

未配置 Secrets 时 workflow 自动跳过镜像步骤，运行时拉取回退 GitHub 系镜像，功能不受影响。**Gitee 仓库是只读镜像**（Actions 强制覆盖），不要在 Gitee 上直接修改内容。manifest 需含 `gitee.com` / `raw.giteeusercontent.com` 域名权限（已加），上架数据披露需列明词表镜像下载源。

## 安装使用

### Chrome / Edge（GitHub Release 分发，不走商店）

1. 到本仓库 [Releases](../../releases) 下载最新 `translatawiki-chrome-v*.zip`（Edge 同用此包）并**解压**；
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选解压出的目录；
3. 每次启动浏览器可能提示「停用开发者模式扩展」，选保留即可——未签名扩展在 Windows 下浏览器无商店安装途径，此提示属正常现象。

### Firefox

- 开发预览：`npx web-ext run --source-dir dist/firefox`（临时加载，文件变化自动重载）
- 手动临时加载：about:debugging → 此 Firefox → 临时载入附加组件 → 选 `dist/firefox/manifest.json`（重启 Firefox 失效）
- 正式版 Firefox 不允许未签名扩展常驻；自用长期方案是 Firefox Developer Edition / Nightly（`xpinstall.signatures.required=false`）或 AMO 签名（见 [store/listing-amo.md](store/listing-amo.md)）

### 使用

1. 右下角悬浮按钮开关；未配置 API Key 时不翻译，页面顶部会弹自动消散的提示；翻译进行中页顶居中显示灵动岛式进度胶囊（毛玻璃，缓存瞬时完成时不显示）。
2. **快捷键 Ctrl+Alt+D**（默认）：在 wiki 页面切换 翻译/隐藏译文——隐藏为 CSS 隐藏（DOM 保留），重新显示瞬时恢复，只补翻新增内容和失败块，不重发已缓存请求；在设置页「快捷键」区点击输入框按下新组合键即可改键（Backspace 清除禁用），立即生效。
3. 在 options 页填 OpenAI 兼容接口（Base URL + Key + 模型名），首次需点"授权接口域名"；填好后立即生效。
4. **搜索框中文术语**（默认开，不依赖 AI Key）：在 wiki 搜索框直接输入词表里的官方中文译名——下拉顶部出现词表候选（蓝左条 + 「词表 · 英文名」，同名多译名如 电击 → Electricity/Shock 全部列出），**点候选直接跳转**（改写为英文后走站点原生 Go 搜索，精确命中页面即直接进页；Ctrl/中键新标签打开），回车/搜索按钮提交时完整中文术语也会自动改写为英文（toast 提示映射，纯前缀歧义如「电」不改写放行）。站点自己的中文重定向候选保持原样，设置页可关。

## 发布渠道（三端）

| 端 | 渠道 | 包 | 材料 |
| --- | --- | --- | --- |
| Chrome | **GitHub Release**（不打开发者账号，用户自行下载加载） | `dist/pack/translatawiki-chrome-v*.zip` | Release 说明（workflow 自动生成） |
| Edge | Edge Add-ons 商店（Partner Center） | `translatawiki-edge-v*.zip` | [store/listing-edge.md](store/listing-edge.md)（含数据披露表单答案 + 300×300 logo） |
| Firefox | AMO（listed 或 unlisted 自签） | `translatawiki-firefox-v*.zip` | [store/listing-amo.md](store/listing-amo.md)（含数据申报表单答案） |

隐私政策（Edge/AMO 必填 URL）：`https://github.com/cyxcmiao/warframe-translata/blob/main/store/privacy-policy.md`。

发版流程：bump `package.json` version → `git tag vX.Y.Z` → push tag → CI 自动 build + pack + 结构校验 + 发布 Release（[.github/workflows/release.yml](.github/workflows/release.yml)）。

## 上架前待办

- [x] Firefox 实测（2026-11-20 通过：web-ext 装载 + 真页面词典模式渲染验证，AMO lint 0 错误）
- [x] `mechanism_terms.json` 机制术语表（官方导出无词条的 wiki 机制用语 + 游戏语言文件复合词如 桎梏飞掷丸，57 条；zh===en 条目=锁定保留英文；复数由匹配器自动处理，无需单列）
- [x] 扩展图标 16/32/48/128 + Edge 商店 logo 300（`npm run icons` 生成，三 manifest 已挂）
- [x] 三端上架包 + 结构校验（npm run pack + tools/test_pack.js；AMO 硬性要求 manifest 在 zip 根 + 正斜杠条目已满足）
- [ ] Edge Partner Center / AMO 实际提交（文案与表单答案已备好：store/listing-edge.md、store/listing-amo.md；隐私政策 URL 已定于仓库 store/privacy-policy.md）
- [ ] 商店截图（手动截：双语对照页面 + 搜索框中文候选，1280×800）
- [ ] AI 请求频控调优（当前每块 ≤16 段/1600 字符一批，单标签页串行；多标签页无全局并发闸）
