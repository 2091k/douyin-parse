/**
 * Cloudflare Containers entry — 把请求转发进真正的 Node 容器。
 *
 * 只有选择「Cloudflare + Containers」这条路时才用到这个文件（配合
 * wrangler.container.toml）。它自己仍然跑在 workerd 上，但只做转发，
 * 真正的解析在容器里的 `node server.mjs` 中执行 —— 那里才是 Node 的 HTTPS 客户端。
 *
 * 需要 Workers Paid 套餐，并且要先安装依赖：npm install
 */
import { Container, getContainer } from '@cloudflare/containers';

export class DouyinParser extends Container {
  defaultPort = 8080;      // 与 Dockerfile 的 ENV PORT 一致
  sleepAfter = '10m';      // 10 分钟无请求即休眠，避免持续计费
}

export default {
  async fetch(request, env) {
    // 固定实例名 "main"：个人使用足够。
    // 想扩容就把 'main' 换成按请求区分的 id（例如客户端 IP 的哈希），
    // 并调大 wrangler.container.toml 里的 max_instances。
    return getContainer(env.DOUYIN_PARSER, 'main').fetch(request);
  },
};
