# 抖音素材解析 douyin-parse

把抖音分享文案（`https://v.douyin.com/xxx/`）解析成可直接下载的无水印媒体地址：
视频、图集、实况图（静态图 + 动态视频 + 背景音乐 mp3）。

代码只有一份（`worker.js`），三种运行方式：

| 方式 | 运行时 | 出站请求由谁发出 | 实际效果 |
|---|---|---|---|
| `wrangler dev` / 普通 Worker | workerd | workerd（Cordis/BoringSSL 指纹） | ❌ 详情接口被抖音风控 403，实况动态视频与 mp3 拿不到 |
| **本地 / 云上的 Node** | **Node.js** | **Node 的 HTTPS 客户端** | ✅ 完整数据（4 条原始镜像 / 实况三件套） |
| Cloudflare Containers | 容器里的 Node | 同 Node | ⚠️ 取决于 Cloudflare 出口 IP 是否被抖音放行，需实测 |

> 结论先说：**Cloudflare 的 GitHub 集成只是「构建」，它不会把运行时变成 Node。**
> 想让运行时变成 Node，只有 Containers（付费套餐）或把服务部署到 Node 平台。

---

## 一、本地用 Node 跑（推荐先跑通这个）

环境要求：Node.js ≥ 18（推荐 22）。

```powershell
cd D:\bt\x86\ai-agent
node server.mjs
```

浏览器打开 <http://127.0.0.1:8787>。其他方式：

```powershell
npm start                                  # 等价
$env:PORT=9000; node server.mjs            # 换端口
$env:HOST='0.0.0.0'; node server.mjs       # 局域网可访问
$env:HOST='0.0.0.0'; $env:PORT=8080; node server.mjs   # 容器/平台用的形态
```

运行期零依赖，不需要 `npm install`。控制台会打印每个请求的状态码：

```
13:39:33  POST /api/parse  ->  200  (1460ms)
```

## 二、上传到 GitHub

本机需要装 Git（当前这台机器上没装）。

```powershell
cd D:\bt\x86\ai-agent
git init
git add .
git commit -m "douyin-parse: worker + node host + container"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

`.gitignore` 已排除 `node_modules/`、`.wrangler/`、`.dev.vars`。`备份/` 目录不会被提交（如果不想传，加进 `.gitignore`）。

---

## 三、Cloudflare 接 GitHub —— 三条路线

### 路线 A：普通 Worker（Workers Builds）

Dashboard → **Workers & Pages → Create → Connect to Git** → 选仓库，然后：

- Build command：`npm ci`（零依赖，留空也行）
- Deploy command：`npx wrangler deploy`（用默认的 `wrangler.toml`）

**能自动构建部署，但运行时还是 workerd** —— 抖音详情接口仍然 403。
这条路线只适合当作「线上界面」，拿不到实况动态视频和 mp3。

### 路线 B：Cloudflare Containers（真 Node）

需要 **Workers Paid 套餐**（约 $5/月起，容器按实例计费）。

1. 仓库里已经准备好：
   - `Dockerfile` —— `FROM node:22-alpine`，`CMD ["node", "server.mjs"]`
   - `worker.container.js` —— Worker 只做转发，把请求交给容器
   - `wrangler.container.toml` —— `[[containers]]` + Durable Object 绑定
2. 依赖装一下（`worker.container.js` 需要 `@cloudflare/containers`）：`npm install`
3. 本地有 Docker 的话可以先验：`npx wrangler dev -c wrangler.container.toml`
4. 部署：`npx wrangler deploy -c wrangler.container.toml`
   - 或在 GitHub 集成的 **Deploy command** 里填 `npx wrangler deploy -c wrangler.container.toml`
   - 镜像由 Cloudflare 按 `Dockerfile` 构建，本机不需要 Docker
5. `sleepAfter = '10m'`：10 分钟无请求自动休眠，避免持续计费

### 路线 C：Node 平台 + GitHub（最省事，和本地行为完全一致）

不需要写任何适配代码，仓库里的 `server.mjs` 直接就是入口：

- **Render**：New → Web Service → 连仓库 → Runtime `Node` → Build Command 留空或 `npm ci` → Start Command `node server.mjs`。平台会注入 `PORT`
- **Railway / Koyeb**：连仓库，自动识别，或指定 Dockerfile
- **Fly.io**：`fly launch`（会读 `Dockerfile`）→ `fly deploy`
- **自己的 VPS / 家里的小主机**：`node server.mjs` + systemd/pm2

这条路线是**真的 Node 进程**，行为和你在本地跑出来的结果一致。

---

## 四、必须实测的一点（重要）

我验证过的对照实验：**同一台机器、同一个 IP、同一时刻、完全相同的请求头和 URL**

| 客户端 | 详情接口 |
|---|---|
| Node（undici） | **200 + 完整 JSON** |
| workerd（`wrangler dev`） | **403** |

差异在 TLS 指纹：workerd 的 JA3 只有 9 个 cipher 且没有 ALPN，Node 有 52 个且带 ALPN。

**但部署到云上以后，出口 IP 也变了**（从你家宽/办公网变成 IDC，通常是境外）。
抖音对 IDC IP 可能判得更严 —— 所以「本地 Node 能通」**不能**推出「云端 Node 一定能通」。
部署后打开页面点解析，看错误卡片里的 `steps`：

```
详情接口返回 HTTP 200 …   → 成功，完整数据
详情接口返回 HTTP 403 …   → 出口 IP 也被拦了，这条路走不通
```

## 五、接口

| 路径 | 说明 |
|---|---|
| `GET /` | 内置网页（粘贴分享文案即可解析、预览、复制链接） |
| `GET /help` | JSON 接口说明 |
| `GET /api/parse?text=…` | 解析（GET 便捷形式） |
| `POST /api/parse` | `{"text": "分享文案"}` 或 `{"url": "链接"}` |
| `GET /api/selftest` | 确定性自测（不需要网络），7 项 |
| `GET /api/thumb?url=…` | 图片代理（网页预览用） |
| `GET /api/probe?url=…` | 探测媒体远端大小（Range 探测，不下载正文） |
| `GET /dl?url=…` | 302 跳到校验过的镜像；浏览器请求会走无 Referer 桥页，需 Referer 的 CDN 自动改为流式转发 |

## 六、免责

仅用于解析你有权处理的内容。带签名的媒体地址只返回给调用方，不写入日志
（`server.mjs` 的日志里带 query 的路径统一显示为 `?…`）。
