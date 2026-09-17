# 抖音素材解析 —— 真正的 Node 运行时镜像
#
# 用途一：Cloudflare Containers（worker.container.js 把请求转发进来）
# 用途二：任何支持 Docker 或 Node 的平台（Render / Railway / Fly.io / Koyeb / 自己的 VPS）
#
# 这条路径的关键：请求由 Node 自己的 HTTPS 客户端发出，
# 而不是 workerd，因此抖音详情接口不会被风控拒绝。

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

# 运行期零依赖：worker.js 与 server.mjs 只用 Node 内置能力，无需 npm install。
COPY package.json ./
COPY server.mjs worker.js ./

EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
