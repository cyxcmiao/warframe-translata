# translataWiki 隐私政策 / Privacy Policy

最后更新 / Last updated: 2026-11-21

本扩展（translataWiki，"Warframe Wiki 精准翻译"）不设开发者自己的服务器，不做任何用户行为跟踪。以下说明全部数据流向。

English summary follows the Chinese section.

## 中文

### 扩展在本地存储什么（仅存于你自己的浏览器，浏览器用户配置内）

- **设置项**：OpenAI 兼容接口的 Base URL、API Key、模型名、快捷键等偏好。API Key 仅存本地 `storage.local`，不进入任何请求（发给 AI 接口的是标准 `Authorization` 头，不含第三方转发）。
- **翻译缓存**：已翻译文本 + 命中词条的缓存（IndexedDB），用于重复内容免重翻与离线还原。
- **AI 用量统计**：按月累计的 token 计数（本地），仅用于在设置页展示消耗。

### 数据发送到哪里

1. **你自填的 OpenAI 兼容 AI 接口**：为翻译当前页面，wiki 页面的文本内容（术语、句子）会发送至该接口。选择哪个接口、哪个服务商完全由你决定，密钥由你自己填写；开发者不经手任何翻译请求。
2. **词表镜像源（只读下载）**：官方译名词表从以下公开镜像拉取——`github.com` / `raw.githubusercontent.com` / `cdn.jsdelivr.net` / `statically.io` / `gitee.com`（可选兜底）。仅下载公开的词表文件，不上传任何用户数据。
3. **wiki.warframe.com**：扩展只在该站点页面内运行，页面内容不会被发送至该站点以外的任何开发者控制的服务器。

### 我们不做什么

- 不收集、不上传任何个人身份数据；
- 无内建遥测、无统计上报、无广告；
- 不出售任何数据。

### 数据保留与删除

所有本地数据（设置 / 缓存 / 用量）随浏览器存续；移除扩展或在设置页清空缓存即全部删除。

---

## English

### What the extension stores locally (in your browser profile only)

- **Settings**: base URL, API key, and model name of an OpenAI-compatible endpoint you configure, plus preferences such as shortcut keys. The API key is kept in local `storage.local` only.
- **Translation cache**: translated text and matched-term metadata (IndexedDB), so repeated content is not re-translated.
- **AI usage counters**: monthly token totals, shown on the settings page.

### Where data is sent

1. **The OpenAI-compatible AI endpoint you configure**: text content of wiki pages (terms and sentences) is sent there for translation. You choose the provider and supply your own key; the developer never sees translation requests.
2. **Glossary mirrors (read-only downloads)**: the official term glossary is fetched from public mirrors — `github.com`, `raw.githubusercontent.com`, `cdn.jsdelivr.net`, `statically.io`, and optionally `gitee.com`. Only public glossary files are downloaded; no user data is uploaded.
3. **wiki.warframe.com**: the extension runs on pages of that site only; page content is never sent to any developer-operated server.

### What we do NOT do

- No personal identity data is collected or uploaded;
- No built-in telemetry, analytics, or ads;
- No data is sold.

### Retention & deletion

All local data (settings / cache / usage) lives with your browser profile; it is deleted when you remove the extension or clear the cache on the settings page.
