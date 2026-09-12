# xhs-parse (Cloudflare Worker)

小红书（XiaoHongShu / RedNote）作品解析器：把分享文案或作品链接变成 **作品信息 + 可直接下载的图片/视频地址**。

代码是 [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader)（作者 JoeanAmier，GNU GPL v3.0）解析管线的
**服务端移植版**，结构与同目录的 `douyin-parse` 保持一致：单个 `workers.js`、零依赖、内置网页 UI、确定性自测。
原项目需要 Python ≥ 3.12 + curl_cffi + lxml，无法部署到边缘运行时；本移植版没有这些依赖。

```
xhs-parse/
├── workers.js       Worker 主程序（路由 + 解析管线 + 内置 UI + 自测）
├── wrangler.toml    Cloudflare Workers 配置
├── package.json     type: module（让 Node 也能直接 import 做测试）
├── test-local.mjs   本地测试脚本（离线自测 / 实时解析）
└── README.md
```

## 快速开始

```bash
# 本地跑测试（Node 18+，无需 wrangler）
node test-local.mjs              # 离线自测：8 组确定性检查 + 路由检查
node test-local.mjs --live       # 再取一条最新作品做实时解析，并探测媒体地址
node test-local.mjs "<作品链接>"  # 指定链接实时解析

# 本地开发
npx wrangler dev

# 部署
npx wrangler deploy
```

打开部署后的地址即可使用内置网页：粘贴分享文案 → 解析 → 预览图片、在线播放视频、复制或代理下载地址。

## ⚠️ 部署到 Cloudflare 后被风控（重要）

**症状**：本地解析正常，部署到 Workers 后报 `未在输入中找到小红书作品链接`，步骤里能看到：

```
解析短链接：https://xhslink.cn/o/xxxxxxxx
短链接跳转至：https://www.xiaohongshu.com/website-login/captcha?redirectPath=…&verifyUuid=…&verifyType=217
```

**原因**：不是代码 bug，而是**出口 IP 的信誉差异**。Cloudflare Worker 从 Cloudflare 自己的数据中心 IP 段出网，
小红书对这类 IP 的风控比家用宽带严格得多，于是把短链跳转答成了「安全验证」页。你本地是住宅 IP，所以不触发。

**已经做的两件事**：

1. **自动还原真实链接。** 验证页虽然拦了跳转，但真实作品链接就放在 `redirectPath` 参数里。现在会把它解出来
   直接请求作品页，**不再依赖短链那一跳成功**——所以你这次的输入很可能直接就通了。
2. **说清楚失败原因。** 如果作品页也被拦，不再报含糊的「未找到链接」，而是返回 `risk_control`，并在页面步骤里
   给出验证页地址。

**如果仍然失败**：给 Worker 加 Cookie，这是最有效的办法：

- 网页 UI 底部有「可选：小红书网页版 Cookie」输入框，**填一次就保存在浏览器 localStorage 里，刷新或重开页面都自动带上**
  （折叠标题下会显示「已保存在本机浏览器（N 字符）」，旁边可「清除本机保存」）；同页还会记住「图片格式」和「视频偏好」的选择；
- 或用参数：`GET /api/parse?url=…&cookie=<urlencoded>` / `POST {"url":"…","cookie":"…"}`；
- Cookie 获取：浏览器打开 `https://www.xiaohongshu.com/explore` → F12 → 网络 → 任意请求 → 复制 `Cookie` 整行。

> 实现细节：输入时逐字保存，并在点击「解析」「取一条最新示例」前再存一次。只监听 `change` 是不够的——
> 它要等到失焦才触发，粘贴后直接刷新会丢。

其他缓解手段（按有效性排序）：换成带住宅出口的服务端（VPS + 代理）、降低请求频率、使用自建域名的 Worker
（共享 IP 段被刷得越狠越容易被拦）。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /`（`/app`、`/index.html`） | 内置网页 UI |
| `GET /help` | JSON 帮助（含参数与响应说明） |
| `GET /api/sample` | 从首页推荐流取一条**当前有效**的示例作品链接 |
| `GET /api/parse?url=…` / `?text=…` | 解析链接或分享文案 |
| `POST /api/parse` | JSON 请求体，支持下方全部参数 |
| `GET /api/thumb?url=…` | 图片代理（带 Referer/UA，供网页预览绕过防盗链） |
| `GET /api/probe?url=…` | 探测媒体远端大小 + **真实文件类型**（Range `bytes=0-31` + 文件头签名） |
| `GET /dl?url=…` | 脚本调用返回 302 跳转；浏览器打开时经 Worker 代理并补上 Referer |
| `GET /api/selftest` | 解析管线确定性自测（不联网） |

### 请求参数（`POST /api/parse`）

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` / `text` | str | — | 作品链接或分享文案，二选一（必需） |
| `image_format` | str | `jpeg` | `auto`/`png`/`webp`/`jpeg`/`heic`/`avif`，仅图文/图集生效 |
| `video_preference` | str | `resolution` | `resolution`/`bitrate`/`size`，仅视频生效 |
| `name_format` | str | `发布时间 作者昵称 作品标题` | 文件名字段；含未知字段时回退默认值 |
| `tz_offset` | int | `480` | 发布时间时区偏移（分钟），默认 UTC+8 |
| `cookie` | str | — | 小红书网页版 Cookie；非必需，高画质与风控场景建议提供 |
| `verify` | bool | `false` | 顺带探测媒体地址，结果放入 `media.verification` |
| `proxy` | str | — | 仅为兼容原项目 API 保留，**Worker 运行时忽略**（见下） |

### 响应

```jsonc
{
  "ok": true,
  "steps": ["输入长度：140 字符", "作品 ID：…", "作品类型：图文", "…"],
  "source": { "url": "…", "finalUrl": "…", "noteId": "…", "htmlChars": 62158, "elapsedMs": 1122 },
  "data": {
    "作品ID": "…", "作品链接": "…", "作品标题": "…", "作品描述": "…", "作品类型": "图文",
    "作品标签": "…", "收藏数量": "…", "评论数量": "…", "分享数量": "…", "点赞数量": "…",
    "发布时间": "2026-08-07_12:53:36", "最后更新时间": "…", "时间戳": 1785615635,
    "作者昵称": "…", "作者ID": "…", "作者链接": "…",
    "下载地址": ["https://…"], "动图地址": [null], "文件名": "…"
  },
  "media": {
    "kind": "image", "imageFormat": "jpeg", "imageCount": 3, "liveCount": 0,
    "verification": [{ "ok": true, "status": 200, "detected": "jpeg", "bytes": 99484, "human": "97.2KB" }]
  }
}
```

`data` 的字段名与 XHS-Downloader 完全一致，方便直接复用原有下游逻辑。

## 移植映射

| XHS-Downloader（Python） | xhs-parse（JavaScript） |
| --- | --- |
| `XHS.extract_links` | `extractXhsLinks`（先解析 xhslink 短链再匹配 6 条正则） |
| `Converter.run` / `_convert_object` / `_filter_object` | `parseInitialState` / `filterNoteObject`（手机版与 PC 版两种结构） |
| `Namespace.safe_extract` / `object_extract` | `safeExtract` / `objectExtract`（`a.b[0].c` 链式取值，falsy 走默认值） |
| `Explore.run` | `exploreRun`（互动数、标签、标题、描述、作品类型、时间、作者） |
| `Explore.__classify_works` | `classifyWorks`（`未知`/`视频`/`图集`/`图文`） |
| `Image.get_image_link` / `__extract_image_token` / `__get_live_link` | `getImagePlan` / `extractImageToken` / `getLiveLinks` |
| `Video.deal_video_link` / `get_video_items` | `getVideoPlan` / `getVideoItems` |
| `Html.request_url` + `tools.retry` | `requestUrl`（超时 + 重试 + 大小上限） |
| `Html.format_url` | `decodeUnicodeEscapes` |
| `Cleaner.filter_name` / `Manager.filter_name` | `cleanerFilterName` / `managerFilterName` |
| `truncate.beautify_string` | `beautifyString` |
| `XHS.__naming_rules` | `buildFileName` |
| `module/static.py` `FILE_SIGNATURES` | `FILE_SIGNATURES` + `detectFileType`（用于 `/api/probe`） |

## 与原项目的差异（有意为之）

1. **`__INITIAL_STATE__` 解析方式不同。** 原项目先盲替换 `undefined` → `null` 再用 PyYAML 解析，字符串里的
   `undefined` 也会被改掉。本移植版用一个容错的 JS 对象读取器（`parseJsonLike`），支持裸键、单引号、
   `undefined`、多余逗号，且**不修改字符串内容**。
2. **`noteDetailMap` 取值更准。** 原项目固定取 `[-1]`（最后一个）。本移植版优先取请求的作品 ID 对应的条目，
   取不到才回退到最后一个，避免推荐流里的其他作品“顶替”目标作品。
3. **时区默认 UTC+8。** 原项目用机器本地时区；这里默认 `480` 分钟（Asia/Shanghai），可用 `tz_offset` 覆盖，
   以便和桌面版输出一致。
4. **修掉了 `Image.__get_live_link` 的一个崩溃点。** 某条 stream 既没有 `backupUrls` 也没有 `masterUrl` 时
   原项目会抛 `TypeError`，这里按“无动图”处理。
5. **`proxy` 参数被忽略。** Workers 运行时的 `fetch` 没有单请求代理选项，出口固定为 Cloudflare 网络。
   参数保留只是为了兼容原项目 API 的调用方。
6. **新增安全边界。** `/dl`、`/api/probe`、`/api/thumb` 只允许小红书媒体域名（`xhscdn.com`、`xiaohongshu.com`、
   `rednote.com`），并拒绝私网/回环地址，避免这个 Worker 被当成 SSRF 跳板。
7. **新增风控兜底。** 短链跳转被答成 `website-login/captcha` 时，从 `redirectPath` 还原真实作品链接；
   仍被拦截时返回 `risk_control` 错误码而不是含糊的「未找到链接」。详见上文风控章节。

## 测试结果

`node --check workers.js` 通过；`node test-local.mjs` 全部通过（8 组离线自测 + 6 项路由检查）。

实时解析（2026 年，本机直连小红书，未配置 Cookie）：

| 用例 | 结果 |
| --- | --- |
| `GET /api/sample` 取示例链接 | ✅ 拿到首页推荐流的有效链接 |
| 图文作品解析 | ✅ 标题/作者/时间/互动数/标签全部正确 |
| 视频作品解析 | ✅ `media.stream` 选优，选出 924×720 h264，约 2–20 MB |
| 图片地址可用性 | ✅ `HTTP 200 jpeg 239.7KB`（`/api/probe` 按文件头确认为真 JPEG） |
| 视频地址可用性 | ✅ `HTTP 206 mp4 2.0MB` |
| 图文格式矩阵 | ✅ jpeg / png / webp / heic 均返回真实对应格式；`avif` 回退为 webp |
| 动图（livePhoto） | ✅ `backupUrls[0]` → `masterUrl` 回退逻辑有单测覆盖 |
| `/dl` 代理与 302 | ✅ 浏览器 Accept 走代理返回 `video/mp4`；脚本 Accept 返回 302 |
| 域名白名单 / SSRF | ✅ 外域与 `127.0.0.1` 均被 400 拒绝 |
| xhslink 短链 | ✅ 重定向跟随与最终 URL 提取已实测；无效短码会给出 `no_xhs_link` 与完整步骤 |
| 风控跳转还原 | ✅ 用真实的 `website-login/captcha?redirectPath=…` URL 做单测，能还原出作品链接与作品 ID；被拦时返回 `risk_control` |
| Cookie 本地持久化 | ✅ 打桩模拟「填 Cookie → 刷新页面」：input 自动回填、折叠块自动展开、解析请求确实带上完整 Cookie；清除后刷新为空 |
| 内置 UI 脚本 | ✅ 语法检查通过；用 DOM 打桩跑通 `render()`（视频/图文/图集）与 `post()` 正常、报错、断网三条路径 |

测试过程中修掉的两个真实缺陷：`/api/thumb` 会把视频当图片并以 `image/mp4` 返回；内置 UI 脚本少一个右括号
会导致整页脚本报错。

## 已知限制

- **链接会过期。** 作品链接携带日期信息，`xsec_token` 失效后必须重新获取；解析失败时会返回
  `no_note_data` 并附完整 `steps`。
- **数据中心 IP 风控。** 部署在 Cloudflare 上比本地更容易被要求安全验证（返回 `risk_control`）；
  填写 Cookie 可大幅提高成功率。详见上文风控章节。
- **未配置 Cookie 时视频可能只有较低画质**，与大分辨率流相关的行为由平台决定。
- **平台风控。** 请求频率过高可能触发验证页，此时返回 `no_initial_state`；本移植版内置了重试与请求头，
  但没有原项目的随机延时（`sleep_time`），因为 Worker 请求有 CPU/时长预算。
- **时区**：`发布时间` 依赖 `tz_offset`，不是从数据里读出来的。
- 内置 UI 脚本只做了语法与 DOM 打桩级验证，未在真实浏览器里跑端到端交互。

## 版权

解析规则移植自 [JoeanAmier/XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader)（GNU General Public
License v3.0）。本项目同样以 **GPL-3.0** 分发，使用与再分发请遵守原项目 LICENSE 的要求并注明出处。

仅用于解析你有权处理的内容；请遵守目标平台的服务条款与所在地法律法规。
