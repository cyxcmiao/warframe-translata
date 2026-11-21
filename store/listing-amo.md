# Firefox Add-ons (AMO) 提交清单

包: `dist/pack/translatawiki-firefox-v{版本}.zip`（`npm run build && npm run pack`；打 `v*` tag 时 CI 自动产出并附到 GitHub Release）。

Manifest 已满足 AMO 2025-11 起的硬性要求:
- `browser_specific_settings.gecko.id` + `strict_min_version: 140.0`；
- `data_collection_permissions.required: ["websiteContent"]`（翻译需读取页面文本并发往用户自配 AI 接口，属如实申报）；
- MV3 event page（`background.scripts`），Firefox 原生 `browser.*` Promise API（`shared/api.ts` 别名）。

`npx web-ext lint --source-dir dist/firefox` 当前 0 errors / 1 warning（仅提示 Firefox for Android 最低版本不支持 data_collection_permissions——本扩展为桌面端用途，不受影响）。

## 提交步骤

1. 注册 [addons.mozilla.org](https://addons.mozilla.org/developers/)（AMO 账户免费，无需付费）；
2. 「Submit a New Add-on」二选一:
   - **Listed（公开上架）**: 上传 zip → 填写 listing（见下）→ 人工审核（一般 1–7 天）；
   - **Unlisted（自签名自用）**: 上传 zip 直接签名，链接仅自己可见，审核宽松——自用长期方案推荐此通道；
3. 或命令行签名（配 AMO API key: 账户设置 → API Keys）:
   ```bash
   npx web-ext sign --source-dir dist/firefox --api-key <KEY> --api-secret <SECRET> --channel unlisted
   ```

> 正式版 Firefox 不允许未签名扩展常驻；不想走 AMO 时长期方案是 Firefox Developer Edition / Nightly（`xpinstall.signatures.required=false`）。

## Listed 商店信息填写

| 字段 | 内容 |
| --- | --- |
| 名称 | Warframe Wiki 精准翻译 |
| 摘要（≤250 字符） | 官方词表锁术语 + AI 整句翻译 WARFRAME 英文 Wiki，双语对照。 |
| 详细描述 | 用 Warframe 官方简中词表锁定术语，AI 整句增强翻译英文 Wiki，双语对照呈现（沉浸式翻译风格）。术语 100% 采用游戏内官方译名；未配置 AI Key 时仍可用官方词表与搜索框中文直达。数据仅存本地，见隐私政策。 |
| 类别 | Accessibility（无障碍辅助阅读）或 Productivity |
| 标签 | warframe, wiki, translation, 翻译, game |
| 许可证 | 建议选 MIT / 或按你的开源意图选择（AMO listing 必填） |
| 隐私政策 URL | 同 Edge 清单: https://github.com/cyxcmiao/warframe-translata/blob/main/store/privacy-policy.md |
| 截图（≥1 张） | 建议 1280×800：开启翻译后的双语对照页面 + 搜索框中文候选各一张 |

## 数据申报（AMO「Add-on Data Collection」表单）

| 问题 | 回答 |
| --- | --- |
| 收集/传输哪些数据？ | Website content（页面文本）——发送至**用户自配**的 AI 接口用于翻译，不回传开发者 |
| 数据是否出售/共享给第三方？ | 否 |
| 个人身份数据 / 财务数据 / 健康数据？ | 否 |

（manifest 的 `data_collection_permissions` 与此表单必须一致。）

## 源码审查备注

dist 包内 JS 由 esbuild 打包压缩（构建产物），AMO 审核对 minified 代码可能发起源码请求——扩展源码公开在同仓库（`extension/src/`，构建脚本 `tools/build_ext.js`），上传时或收到审核请求时直接给仓库链接即可，无需额外准备。

## 版本纪律

- bump `package.json` version → tag `v*` → CI 产 zip → AMO 上传新版本；
- manifest 版本必须严格递增，重传同版本会被拒。
