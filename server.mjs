/**
 * Local Node host for the douyin-parse Worker.
 *
 *   node server.mjs                  -> http://127.0.0.1:8787
 *   PORT=9000 node server.mjs        -> custom port
 *   HOST=0.0.0.0 node server.mjs     -> also reachable from the LAN
 *
 * Why bother: `wrangler dev` runs worker.js inside Cloudflare's workerd, whose
 * TLS ClientHello fingerprint is classified as a bot by douyin's WAF — the
 * detail API answers 403 and live-photo motion/mp3 are lost. Plain Node.js uses
 * its own HTTPS client, which douyin accepts, so this host sees the full data.
 *
 * The Worker module itself is unchanged: its `fetch(request, env, ctx)` handler
 * is simply driven by a node:http server, with responses streamed back.
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import worker from './worker.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// The Worker only uses `ctx` in its signature; provide harmless stubs.
const ENV = {};
const CTX = { waitUntil() {}, passThroughOnException() {} };

// Headers node:http manages itself — copying them into a fetch Request either
// throws or corrupts the body framing.
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-length', 'expect', 'te', 'trailer', 'proxy-connection',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}

async function toRequest(req) {
  const url = `http://${req.headers.host || `${HOST}:${PORT}`}${req.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = (req.method || 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  return new Request(url, { method, headers, body });
}

async function send(req, res, response) {
  res.statusCode = response.status;
  // getSetCookie() keeps multiple Set-Cookie headers apart.
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'set-cookie') continue;
    res.setHeader(name, value);
  }
  if (setCookies.length) res.setHeader('set-cookie', setCookies);

  const isHead = (req.method || 'GET').toUpperCase() === 'HEAD';
  if (isHead || !response.body) {
    res.end();
    return;
  }
  // Stream, so /dl can pass a whole video through without buffering it.
  await pipeline(Readable.fromWeb(response.body), res);
}

// Query strings carry signed media URLs — never log them in full.
function logLine(req, status, ms) {
  let path = req.url || '/';
  try {
    const parsed = new URL(`http://localhost${req.url}`);
    path = parsed.pathname + (parsed.search ? '?…' : '');
  } catch (_) { /* keep raw */ }
  const stamp = new Date().toTimeString().slice(0, 8);
  console.log(`${stamp}  ${(req.method || 'GET').padEnd(4)} ${path}  ->  ${status}  (${ms}ms)`);
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    const request = await toRequest(req);
    const response = await worker.fetch(request, ENV, CTX);
    await send(req, res, response);
    logLine(req, response.status, Date.now() - started);
  } catch (err) {
    console.error('请求处理失败:', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: { code: 'node_host_error', message: String(err && err.message ? err.message : err) } }));
    } else {
      res.destroy();
    }
    logLine(req, 500, Date.now() - started);
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log('抖音素材解析 — 本地 Node 版');
  console.log(`  地址: http://${HOST}:${PORT}`);
  console.log('  运行中请在浏览器打开上面的地址；Ctrl+C 退出');
  console.log('  说明: 该进程直接用 Node 的 HTTPS 客户端访问抖音，');
  console.log('        因此详情接口不会被风控拒绝，视频/图集/实况都能拿到完整数据。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在退出…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝:', reason);
});
