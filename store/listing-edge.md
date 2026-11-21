# Edge Add-ons 提交清单（Partner Center）

包: `dist/pack/translatawiki-edge-v{版本}.zip`（`npm run build && npm run pack`，CI 在打 `v*` tag 时自动产出并附到 GitHub Release）。

> Edge 与 Chrome 共用 MV3 service worker 代码，`manifest.edge.json` 与 chrome 版一致（无 `browser_specific_settings`，无商店 update_url 字段）。

## 提交步骤

1. 注册 [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)（开发者账户一次性 $19，2026 年价以官网为准）；
2. 「创建新扩展」→ 上传 zip 包；
3. 填写商店信息（见下）→ 提交审核（首次审核一般 1–7 天）。

## 商店信息填写

| 字段 | 内容 |
| --- | --- |
| 显示名称 | Warframe Wiki 精准翻译 |
| 简短说明 | 官方词表锁术语 + AI 整句翻译 WARFRAME 英文 Wiki，双语对照。 |
| 描述（长） | 用 Warframe 官方简中词表锁定术语，AI 整句增强翻译英文 Wiki，双语对照呈现（沉浸式翻译风格）。术语 100% 采用游戏内官方译名；未配置 AI Key 时仍可用官方词表与搜索框中文直达。数据仅存本地，见隐私政策。 |
| 类别 | 效率 (Productivity) |
| 语言 | 中文（简体）为主，补充 English |
| 网站 | 扩展仓库 GitHub 地址 |
| 隐私政策 URL | `https://github.com/cyxcmiao/warframe-translata/blob/main/store/privacy-policy.md` |
| 搜索关键词 | warframe, wiki, 翻译, translation, 双语 |
| 商店 logo 300×300 | `store/store_logo_300.png`（已生成） |
| 截图（≥1 张） | 手动截：开启翻译后的 wiki 页面（双语对照效果），建议 1280×800 或 3000×2000，PNG/JPG |

## 数据披露表单（Partner Center「Web 应用隐私」问卷）

| 问题 | 回答 |
| --- | --- |
| 是否收集个人数据？ | 否 |
| 是否收集浏览/网站内容数据？ | 否（页面文本只发往**用户自配**的 AI 接口，不回传开发者；表单备注写明） |
| 是否显示广告？ | 否 |
| 是否有网站链接外部传输？ | 是——仅: 用户自配的 OpenAI 兼容接口（页面文本，用于翻译）；公开词表镜像 github.com / raw.githubusercontent.com / cdn.jsdelivr.net / statically.io / gitee.com（只读下载词表） |

## 上架后

- 版本更新: bump `package.json` version → tag `v*` → CI 产 zip → Partner Center 更新包；
- manifest 版本号必须严格递增（Edge 审核同 AMO 要求）。
