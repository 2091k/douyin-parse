/**
 * douyin-parse — Cloudflare Worker
 *
 * Server-side port of the parse pipeline from the `douyin-material-saver`
 * Android project (com.local.douyinmaterials). It reproduces the same rules so a
 * share text / douyin.com URL can be turned into the "highest available clean
 * media sources" the public page currently offers:
 *
 *   1. ShareLinkParser   -> find the douyin URL in share text, then the aweme id.
 *   2. DouyinInspector   -> fetch the public aweme detail JSON
 *                           (GET /aweme/v1/web/aweme/detail/?aweme_id=...), with a
 *                           page-hydration fallback (RENDER_DATA / __pace_f / inline
 *                           JSON) exactly like the WebView page-probe in the app.
 *   3. MediaSelector     -> deterministic media plan (video vs gallery/live photo),
 *                           quality & watermark ordering ported 1:1 from the app.
 *   4. DownloadPreview   -> items with clean ordered mirror lists ready to download.
 *
 * Privacy: signed media URLs are only returned to the caller and are never logged.
 *
 * Endpoints
 *   GET  /                       built-in web UI (same as /app, /index.html)
 *   GET  /help                   JSON API help
 *   GET  /api/parse?text=...     parse share text (GET convenience)
 *   GET  /api/parse?url=...      parse a douyin URL (same pipeline)
 *   POST /api/parse              {"text": "..."} or {"url": "..."}
 *   GET  /api/thumb?url=...      image proxy for page previews
 *   GET  /api/probe?url=...      remote size probe (Range bytes=0-0, like the app)
 *   GET  /dl?url=...             302 redirect to a validated clean media mirror
 *   GET  /api/selftest           deterministic selector unit checks (no network)
 */

// ---------------------------------------------------------------------------
// Constants ported from ShareLinkParser / DouyinInspector / MediaSelector
// ---------------------------------------------------------------------------

const WATERMARK_HINTS = [
  'tplv-dy-water',
  'dy-water',
  'owner_watermark',
  'watermark_image',
  'watermark=1',
  'playwm',
];

const GALLERY_AWEME_TYPES = new Set([2, 68, 150]);

const PLAY_ADDR_KEYS = [
  'play_addr_h264', 'playAddrH264',
  'play_addr_265', 'playAddrH265',
  'play_addr_256', 'playAddr256',
  'play_addr', 'playAddr',
];

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;   // DouyinInspector.MAX_RESPONSE_BYTES
const MAX_PAGE_DETAIL_CHARS = 8 * 1024 * 1024; // DouyinInspector.MAX_PAGE_DETAIL_CHARS
const MAX_SEARCH_DEPTH = 16;                   // DownloadJobStore.MAX_SEARCH_DEPTH
const MAX_SCRIPT_CHARS = 4 * 1024 * 1024;      // per-script page-probe cap

// DouyinInspector.desktopUserAgent() style desktop Chrome UA.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Search-engine crawler UA. Douyin serves its public /aweme/v1/web/aweme/detail/
// JSON to SEO crawlers without the byted_acrawler JS challenge or a_bogus
// signatures — same endpoint + validation the Android app replays after its
// WebView captures the request.
const CRAWLER_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// Mobile Safari UA used for the iesdouyin share landing fallback.
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const REFERER = 'https://www.douyin.com/';

const GALLERY_TITLE_HINT_KEYS = [
  'aweme_detail', 'awemeDetail', 'detail', 'data',
];

// Headers the Android app is willing to replay for the native detail fetch.
const REPLAY_HEADERS = [
  'Accept',
  'Accept-Language',
  'Referer',
  'User-Agent',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'uifid',
];

// ---------------------------------------------------------------------------
// Small JSON helpers (mirror org.json semantics used by the app)
// ---------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** obj.optEither(snake, camel): snake wins unless null/absent. */
function pick(obj, snake, camel) {
  if (!isObj(obj)) return undefined;
  const s = obj[snake];
  if (s !== undefined && s !== null) return s;
  if (camel !== undefined) {
    const c = obj[camel];
    if (c !== undefined && c !== null) return c;
  }
  return undefined;
}

const optObj = (obj, snake, camel) => {
  const v = pick(obj, snake, camel);
  return isObj(v) ? v : null;
};

const optArr = (obj, snake, camel) => {
  const v = pick(obj, snake, camel);
  return Array.isArray(v) ? v : null;
};

const asObj = (v) => (isObj(v) ? v : null);

function strTrim(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function positiveInt(value) {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

function positiveLong(value) {
  const n = positiveInt(value);
  return n; // ids/durations here stay well inside Number.MAX_SAFE_INTEGER
}

function mediaDurationMillis(obj) {
  if (!isObj(obj)) return 0;
  const keys = ['duration', 'duration_ms', 'durationMs', 'video_duration', 'videoDuration'];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// ShareLinkParser port
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s\u0000-\u001f<>"']+/gi;
const PATH_AWEME_RE = /\/(?:video|note|slides|shipin)\/(\d{8,})/i;
const JSON_AWEME_RE = /["']aweme_id["']\s*[:=]\s*["']?(\d{8,})/i;

function isDouyinHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === 'douyin.com'
    || h.endsWith('.douyin.com')
    || h === 'iesdouyin.com'
    || h.endsWith('.iesdouyin.com');
}

function trimTrailingPunctuation(value) {
  let end = value.length;
  while (end > 0) {
    const c = value.charAt(end - 1);
    if ('. , ; : ! ? ) ] } ， 。 ； ： ！ ？ ） 】 》'.includes(c)) {
      end--;
    } else {
      break;
    }
  }
  return value.substring(0, end);
}

/** ShareLinkParser.extractDouyinUrl — first douyin URL in text, https-normalized. */
function extractDouyinUrl(text) {
  if (!text) return null;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    const candidate = trimTrailingPunctuation(m[0]);
    const parsed = parseUrl(candidate);
    if (parsed && isHttp(parsed) && isDouyinHost(parsed.hostname)) {
      return parsed.protocol === 'http:' ? 'https:' + candidate.slice(4) : candidate;
    }
  }
  return null;
}

function looksLikeAwemeId(v) {
  return typeof v === 'string' && /^\d{8,}$/.test(v);
}

/**
 * ShareLinkParser.extractAwemeId — query param, then /video|note|slides/<id> path,
 * then "aweme_id" inside embedded JSON.
 */
function extractAwemeId(value) {
  if (!value) return null;
  const parsed = parseUrl(value);
  if (parsed) {
    const qid = parsed.searchParams.get('aweme_id');
    if (looksLikeAwemeId(qid)) return qid;
    const pm = PATH_AWEME_RE.exec(parsed.pathname || '');
    if (pm) return pm[1];
  }
  const jm = JSON_AWEME_RE.exec(value);
  return jm ? jm[1] : null;
}

function pathOnly(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname || '/';
  } catch (_) {
    return '/';
  }
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (_) {
    return null;
  }
}

function isHttp(parsed) {
  return parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
}

function isTrustedHttpsDouyinUrl(parsed) {
  return !!parsed && parsed.protocol === 'https:' && isDouyinHost(parsed.hostname);
}

// ---------------------------------------------------------------------------
// DouyinInspector helpers (validation + page-hydration probe)
// ---------------------------------------------------------------------------

/** isExpectedDetailJson: status_code==0 && root.aweme_detail.aweme_id matches. */
function expectedDetail(root, expectedAwemeId) {
  if (!isObj(root)) return null;
  let statusCode = -1;
  if (typeof root.status_code === 'number') statusCode = root.status_code;
  else if (typeof root.statusCode === 'number') statusCode = root.statusCode;
  else if (root.status_code !== undefined) statusCode = Number(root.status_code);
  else statusCode = 0; // like JSONObject.optInt fallback to 0 when absent
  if (!Number.isFinite(statusCode) || statusCode !== 0) return null;

  let detail = optObj(root, 'aweme_detail', 'awemeDetail');
  if (!detail) return null;
  const actual = String(
    detail.aweme_id !== undefined && detail.aweme_id !== null
      ? detail.aweme_id
      : detail.awemeId ?? '',
  ).trim();
  return expectedAwemeId == null || expectedAwemeId === actual ? detail : null;
}

function isJsonText(text) {
  const t = (text || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

/** DownloadJobStore.looksLikeDetail */
function looksLikeDetail(obj, wantedId) {
  if (!isObj(obj)) return false;
  const id = obj.aweme_id !== undefined && obj.aweme_id !== null
    ? String(obj.aweme_id).trim()
    : obj.awemeId !== undefined && obj.awemeId !== null
      ? String(obj.awemeId).trim()
      : '';
  if (!id || (wantedId != null && id !== wantedId)) return false;
  return obj.video !== undefined
    || obj.images !== undefined
    || obj.image_list !== undefined
    || obj.imageList !== undefined
    || obj.image_post_info !== undefined
    || obj.imagePostInfo !== undefined
    || obj.aweme_type !== undefined
    || obj.awemeType !== undefined;
}

/** DownloadJobStore.findDetail — recursive search for the wanted aweme_detail. */
function findDetail(value, wantedId, depth, seen) {
  if (value === null || value === undefined || typeof value !== 'object' || depth > MAX_SEARCH_DEPTH) {
    return null;
  }
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const child of value) {
      const hit = findDetail(child, wantedId, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  if (looksLikeDetail(value, wantedId)) return value;

  for (const key of GALLERY_TITLE_HINT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const hit = findDetail(value[key], wantedId, depth + 1, seen);
      if (hit) return hit;
    }
  }
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child !== null && child !== undefined && typeof child === 'object') {
      const hit = findDetail(child, wantedId, depth + 1, seen);
      if (hit) return hit;
    } else if (typeof child === 'string' && (key === 'content' || key === 'json')) {
      const nested = tryParseNestedString(child, wantedId, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function tryParseNestedString(text, wantedId, depth) {
  const t = (text || '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    return findDetail(JSON.parse(t), wantedId, depth, new WeakSet());
  } catch (_) {
    return null;
  }
}

/** Try to interpret one <script> body as JSON candidates, then search them. */
function probeScriptText(body, wantedId) {
  const t = (body || '').trim();
  if (!t.includes(wantedId) || t.length > MAX_SCRIPT_CHARS) return null;

  const attempts = [];

  // window.__pace_f.push({...}) — exactly what DouyinInspector handles.
  const marker = '__pace_f.push(';
  const markerAt = t.indexOf(marker);
  if (markerAt >= 0 && markerAt < 16) {
    const open = markerAt + marker.length - 1;
    const close = t.lastIndexOf(')');
    if (close > open) attempts.push(t.slice(open + 1, close));
  }

  // window._ROUTER_DATA = {...}; / window.__INITIAL_STATE__ = {...}; etc.
  const assign = /^window\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/.exec(t);
  if (assign) {
    let rest = t.slice(assign[0].length).trim();
    if (rest.endsWith(';')) rest = rest.slice(0, -1).trim();
    if (rest.startsWith('{')) attempts.push(rest);
  } else {
    // A bare JSON object literal script (some old pages).
    if (t.startsWith('{')) attempts.push(t);
  }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      const hit = findDetail(parsed, wantedId, 0, new WeakSet());
      if (hit) return hit;
    } catch (_) {
      /* try next candidate */
    }
  }
  return null;
}

/** DouyinInspector page-probe over raw HTML: RENDER_DATA + inline JSON scripts. */
function extractDetailFromHtml(html, wantedId) {
  if (!html || !html.includes(wantedId)) return null;

  const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    let body = m[2] || '';

    if (/\bid\s*=\s*["']RENDER_DATA["']/i.test(attrs)) {
      try {
        const decoded = decodeURIComponent(body);
        const parsed = JSON.parse(decoded);
        const hit = findDetail(parsed, wantedId, 0, new WeakSet());
        if (hit) return hit;
      } catch (_) {
        /* continue with other scripts */
      }
      continue;
    }

    const hit = probeScriptText(body, wantedId);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tiny cookie jar (Workers fetch does not persist cookies on its own).
// ---------------------------------------------------------------------------

class CookieJar {
  constructor() {
    this.entries = new Map(); // host(lower) -> [{name,value,domain,hostOnly}]
  }

  addSetCookie(host, headerValues) {
    for (const header of headerValues || []) {
      for (const part of header.split(',')) {
        const segments = part.split(';');
        const first = segments[0] || '';
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        let domain = null;
        let hostOnly = true;
        for (const seg of segments.slice(1)) {
          const kv = seg.split('=');
          if (kv[0].trim().toLowerCase() === 'domain' && kv[1]) {
            domain = kv[1].trim().toLowerCase().replace(/^\./, '');
            hostOnly = false;
          }
        }
        if (!domain) domain = host.toLowerCase();
        const key = domain;
        if (!this.entries.has(key)) this.entries.set(key, []);
        const list = this.entries.get(key);
        const idx = list.findIndex((e) => e.name === name);
        if (idx >= 0) list.splice(idx, 1);
        list.push({ name, value, hostOnly });
        this.entries.set(key, list);
      }
    }
  }

  cookieHeaderFor(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    const parts = [];
    for (const [domain, list] of this.entries) {
      const matches = domain === host || host.endsWith('.' + domain);
      if (!matches) continue;
      for (const e of list) {
        if (!e.hostOnly || domain === host) parts.push(`${e.name}=${e.value}`);
      }
    }
    return parts.length ? parts.join('; ') : null;
  }
}

// ---------------------------------------------------------------------------
// Douyin HTTP access (native detail fetch + page fallback), app-like headers.
// ---------------------------------------------------------------------------

function buildHeaders(jar, url, extra = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: REFERER,
    'User-Agent': DESKTOP_UA,
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...extra,
  };
  const cookie = jar ? jar.cookieHeaderFor(url) : null;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function httpGet(jar, url, extraHeaders = {}, maxBytes = MAX_RESPONSE_BYTES) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: buildHeaders(jar, url, extraHeaders),
  });
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (jar && setCookie.length) {
    try {
      jar.addSetCookie(new URL(response.url || url).hostname, setCookie);
    } catch (_) { /* ignore */ }
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    return { status: response.status, location, body: '', contentType: null, finalUrl: response.url };
  }
  const contentType = response.headers.get('content-type');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ParseError('response_too_large', `响应超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 安全限制`);
  }
  const body = new TextDecoder().decode(buffer);
  return { status: response.status, location: null, body, contentType, finalUrl: response.url };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** DouyinInspector.performNativeFetch primary source: /aweme/v1/web/aweme/detail/. */
async function fetchDetailApi(jar, awemeId) {
  const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(awemeId)}`;
  const { status, body } = await httpGet(jar, url, {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': CRAWLER_UA,
    Referer: 'https://www.douyin.com/',
  });
  if (status !== 200 || !isJsonText(body)) return null;
  let root;
  try {
    root = JSON.parse(body);
  } catch (_) {
    return null;
  }
  const detail = expectedDetail(root, awemeId);
  if (detail) return { detail, source: 'detail_api' };

  // DouyinInspector.isFilteredDetailJson: status 0 + null aweme_detail +
  // filter_detail — gallery posts get filtered out of the video API (fall back
  // to the page), but some reasons mean the post is really not public.
  const filterDetail = asObj(root.filter_detail) || asObj(root.filterDetail);
  const reason = filterDetail
    ? strTrim(pick(filterDetail, 'filter_reason', 'filterReason'))
    : null;
  if (reason && UNAVAILABLE_REASONS.has(reason)) {
    throw new ParseError('item_unavailable', `作品不可见：${reasonLabel(reason)}`);
  }
  return null;
}

// Public-availability boundary (same spirit as the app's "需验证" notice):
// these filter_reason values mean the page genuinely has no media to offer.
const UNAVAILABLE_REASONS = new Set([
  'status_audit_self_see',
  'status_audit_fail',
  'status_audit',
  'status_delete',
  'status_removed',
  'self_see',
  'only_friend_see',
  'only_self_see',
  'privacy',
]);

function reasonLabel(reason) {
  const labels = {
    status_audit_self_see: '作品审核中或仅作者自己可见',
    status_audit_fail: '作品未通过审核',
    status_audit: '作品审核中',
    status_delete: '作品已删除',
    status_removed: '作品已删除',
    self_see: '仅作者自己可见',
    only_friend_see: '仅粉丝可见',
    only_self_see: '仅作者自己可见',
    privacy: '作品设为私密',
  };
  return labels[reason] || `平台返回 filter_reason=${reason}`;
}

/**
 * Prime a trusted cookie session before the detail API: one lightweight fetch of
 * the mobile share landing (same item) makes douyin's Argus WAF accept the
 * subsequent crawler-UA API call — without any cookies the API is often 403.
 */
async function primeSession(jar, awemeId) {
  try {
    await httpGet(jar,
      `https://www.iesdouyin.com/share/video/${awemeId}/?region=CN&mid=${awemeId}`,
      { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'User-Agent': MOBILE_UA },
      MAX_PAGE_DETAIL_CHARS,
    );
  } catch (err) {
    if (err instanceof ParseError) throw err;
    // a failed prime is not fatal; the API may still succeed
  }
}

/** DouyinInspector page-probe fallback across douyin page hosts. */
async function fetchDetailFromPages(jar, awemeId) {
  // The desktop SPA serves only a JS/acrawler shell, so try the SEO-crawler
  // page and the mobile share landing; both may carry hydration JSON.
  const pageTargets = [
    { url: `https://www.douyin.com/video/${awemeId}`, ua: CRAWLER_UA },
    { url: `https://www.iesdouyin.com/share/video/${awemeId}/?region=CN&mid=${awemeId}`, ua: MOBILE_UA },
  ];
  for (const target of pageTargets) {
    try {
      const { status, body, finalUrl } = await httpGet(
        jar, target.url,
        { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'User-Agent': target.ua },
        MAX_PAGE_DETAIL_CHARS,
      );
      if (status !== 200 || !body) continue;
      const detail = extractDetailFromHtml(body, awemeId);
      if (detail) return { detail, source: 'page_embed', finalUrl };
    } catch (err) {
      if (err instanceof ParseError) throw err;
      // try the next page on transient network errors
    }
  }
  return null;
}

/**
 * Live-photo (实况) mp4 + BGM mp3 only exist in the web-app params payload
 * (the bare endpoint refuses image posts with filter_reason=images_base, and
 * the page hydration exposes stills only). Fetch it for gallery works and merge
 * the motion/music into the already-selected plan — video and plain-image
 * behaviour stay untouched (nothing is added when there is no live item).
 */
async function fetchWebLiveDetail(jar, awemeId) {
  const url = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id='
    + encodeURIComponent(awemeId)
    + '&aid=6383&device_platform=webapp&channel=channel_pc_web&pc_client_type=1';
  try {
    const { status, body } = await httpGet(jar, url, {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': CRAWLER_UA,
      Referer: 'https://www.douyin.com/',
    });
    if (status !== 200 || !isJsonText(body)) return null;
    const root = JSON.parse(body);
    return expectedDetail(root, awemeId); // null when filtered/absent
  } catch (_) {
    return null;
  }
}

async function enrichLiveFromWeb(jar, awemeId, plan) {
  try {
    // Ride through transient 403 jitter like the main endpoint retry.
    let detail = null;
    for (let attempt = 0; attempt < 2 && !detail; attempt++) {
      detail = await fetchWebLiveDetail(jar, awemeId);
      if (!detail && attempt === 0) await sleep(1000);
    }
    if (!detail) return;
    const w = selectMedia(detail);
    if (!w.isGallery) return;
    const max = Math.min(plan.galleryItems.length, w.galleryItems.length);
    let mergedMotion = false;
    for (let i = 0; i < max; i++) {
      const live = plan.galleryItems[i].liveCandidates;
      const have = new Set(live.map((c) => (c.urls.length ? c.urls[0] : c.uri)));
      for (const cand of w.galleryItems[i].liveCandidates) {
        const key = cand.urls.length ? cand.urls[0] : cand.uri;
        if (key && !have.has(key)) {
          live.push(cand);
          have.add(key);
          mergedMotion = true;
        }
      }
    }
    if (mergedMotion) {
      const audio = collectMusicMirrors(detail);
      if (audio.length) plan.audioMirrors = audio;
    }
  } catch (_) {
    // best-effort; never fail or alter a parse because of the enrich request
  }
}

/** Resolve a short share link (v.douyin.com/...) to its final douyin page. */
async function resolveShortLink(jar, url) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const { status, location, finalUrl } = await httpGet(jar, current, {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'User-Agent': CRAWLER_UA,
    });
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    const settled = status >= 300 && status < 400 ? current : finalUrl || current;
    return { finalUrl: settled, status };
  }
  return { finalUrl: current, status: 302 };
}

// ---------------------------------------------------------------------------
// MediaSelector port (org.json shapes are plain JS objects/arrays here).
// ---------------------------------------------------------------------------

class VideoCandidate {
  constructor(urls, uri, sourcePath, bitrate, width, height, shortEdge, pixels, durationMs, traversalOrder) {
    this.urls = [...new Set(urls)];
    this.uri = uri;
    this.sourcePath = sourcePath;
    this.bitrate = bitrate;
    this.width = width;
    this.height = height;
    this.shortEdge = shortEdge;
    this.pixels = pixels;
    this.durationMs = durationMs;
    this.traversalOrder = traversalOrder;
  }

  hasCleanUrl() {
    return this.urls.some((u) => !isWatermarkedMediaUrl(u));
  }

  get isWatermarkedFallbackOnly() {
    return this.uri == null && this.urls.length > 0 && !this.hasCleanUrl();
  }
}

class ImageCandidate {
  constructor(url, sourcePath, sourceRank, watermarked, width, height, resolutionScore, extensionHint, traversalOrder) {
    this.url = url;
    this.sourcePath = sourcePath;
    this.sourceRank = sourceRank;
    this.watermarked = watermarked;
    this.width = width;
    this.height = height;
    this.resolutionScore = resolutionScore;
    this.extensionHint = extensionHint;
    this.formatRank = urlPath(url).toLowerCase().includes('.webp') ? 1 : 0;
    this.traversalOrder = traversalOrder;
  }
}

class GalleryItemPlan {
  constructor(itemIndex, imageCandidates, liveCandidates) {
    this.itemIndex = itemIndex;
    this.imageCandidates = imageCandidates;
    this.liveCandidates = liveCandidates;
  }
}

class WorkPlan {
  constructor(mediaType, awemeId, title, author, createTime, publishDate,
    videoCandidates, previewImageCandidates, galleryItems, gallerySourcePath) {
    this.mediaType = mediaType; // 'VIDEO' | 'GALLERY'
    this.awemeId = awemeId;
    this.title = title;
    this.author = author;
    this.createTimeEpochSeconds = createTime;
    this.publishDate = publishDate;
    this.videoCandidates = videoCandidates;
    this.previewImageCandidates = previewImageCandidates;
    this.galleryItems = galleryItems;
    this.gallerySourcePath = gallerySourcePath;
    this.audioMirrors = []; // mp3 BGM mirrors (live-photo), filled later when present
  }

  get isGallery() {
    return this.mediaType === 'GALLERY';
  }
}

function isWatermarkedMediaUrl(url) {
  if (!url) return false;
  const normalized = url.toLowerCase();
  return WATERMARK_HINTS.some((h) => normalized.includes(h));
}

/** orderedVideoUrls: watermark=0 clean URLs, then clean, then watermarked last. */
function orderedVideoUrls(sourceUrls) {
  const explicitNoWatermark = [];
  const clean = [];
  const watermarked = [];
  for (const url of sourceUrls) {
    if (url.includes('watermark=0') && !isWatermarkedMediaUrl(url)) explicitNoWatermark.push(url);
    else if (isWatermarkedMediaUrl(url)) watermarked.push(url);
    else clean.push(url);
  }
  return [...explicitNoWatermark, ...clean, ...watermarked];
}

function extractUrls(source) {
  const urls = new Set();
  collectUrls(source, urls, 0);
  return [...urls];
}

function collectUrls(source, urls, depth) {
  if (source === null || source === undefined || depth > 4) return;
  if (Array.isArray(source)) {
    for (const child of source) collectUrls(child, urls, depth + 1);
    return;
  }
  if (isObj(source)) {
    let actual = source.url_list;
    if (actual === undefined || actual === null || (Array.isArray(actual) && actual.length === 0)) {
      actual = source.urlList;
    }
    if (actual !== undefined && actual !== null) {
      collectUrls(actual, urls, depth + 1);
      return;
    }
    collectUrls(source.url, urls, depth + 1);
    collectUrls(source.src, urls, depth + 1);
    collectUrls(source.download_url, urls, depth + 1);
    collectUrls(source.downloadUrl, urls, depth + 1);
    return;
  }
  const s = strTrim(source);
  if (s && (s.startsWith('https://') || s.startsWith('http://'))) urls.add(s);
}

function urlPath(url) {
  const parsed = parseUrl(url);
  if (parsed) return parsed.pathname || '';
  const q = url.indexOf('?');
  const f = url.indexOf('#');
  let end = url.length;
  if (q >= 0) end = Math.min(end, q);
  if (f >= 0) end = Math.min(end, f);
  return url.slice(0, end);
}

function videoResolution(width, height) {
  if (width > 0 && height > 0) {
    return { shortEdge: Math.min(width, height), pixels: width * height };
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= 0) return { shortEdge: 0, pixels: 0 };
  const longEdges = [2560, 1920, 1280, 960, 854, 640];
  const shortEdges = [1440, 1080, 720, 540, 480, 360];
  let best = 0;
  let bestDistance = Math.abs(longEdge - longEdges[0]);
  for (let index = 1; index < longEdges.length; index++) {
    const distance = Math.abs(longEdge - longEdges[index]);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return { shortEdge: shortEdges[best], pixels: longEdge * shortEdges[best] };
}

function imageResolutionScore(width, height) {
  if (width > 0 && height > 0) return width * height;
  return Math.max(width, height);
}

function addDistinctVideoCandidate(output, candidate) {
  if (!candidate) return;
  const identity = candidate.urls.length ? candidate.urls[0] : candidate.uri;
  for (const existing of output) {
    const existingIdentity = existing.urls.length ? existing.urls[0] : existing.uri;
    if (identity !== null && identity === existingIdentity) return;
  }
  output.push(candidate);
}

function dimsFrom(addressObj, metadata, entry) {
  let width = addressObj ? positiveInt(addressObj.width) : 0;
  let height = addressObj ? positiveInt(addressObj.height) : 0;
  if (metadata) {
    if (!width) width = positiveInt(metadata.width);
    if (!height) height = positiveInt(metadata.height);
  }
  if (entry) {
    if (!width) width = positiveInt(entry.width);
    if (!height) height = positiveInt(entry.height);
  }
  return { width, height };
}

/**
 * videoCandidateFromSource: address may be an object, an array of {src}, a string
 * (extractUrls handles all shapes), with metadata/entry for dims and bitrate.
 */
function videoCandidateFromSource(address, metadata, entry, sourcePath, traversalOrder) {
  if (address === undefined || address === null) return null;
  const urls = orderedVideoUrls(extractUrls(address));
  const addressObj = asObj(address);
  let uri = addressObj ? strTrim(addressObj.uri) : null;
  if (uri == null && metadata) uri = strTrim(metadata.uri);
  if (urls.length === 0 && uri == null) return null;

  const { width, height } = dimsFrom(addressObj, metadata, entry);
  const resolution = videoResolution(width, height);
  let durationMs = mediaDurationMillis(addressObj);
  if (!durationMs && metadata) durationMs = mediaDurationMillis(metadata);
  if (!durationMs && entry) durationMs = mediaDurationMillis(entry);
  const bitrate = entry ? Math.max(0, positiveInt(pick(entry, 'bit_rate', 'bitRate'))) : 0;

  return new VideoCandidate(urls, uri, sourcePath, bitrate, width, height,
    resolution.shortEdge, resolution.pixels, durationMs, traversalOrder);
}

function videoCandidateFromAnySource(source, sourcePath, traversalOrder) {
  return videoCandidateFromSource(source, asObj(source), null, sourcePath, traversalOrder);
}

function nestedUri(obj) {
  return obj ? strTrim(obj.uri) : null;
}

function firstNonBlank(first, second) {
  return first == null ? second : first;
}

function collectQualityCandidates(video, videoPath) {
  const bitRates = optArr(video, 'bit_rate', 'bitRateList');
  if (!bitRates || bitRates.length === 0) return [];
  const candidates = [];
  const globalDurationMs = mediaDurationMillis(video);
  for (let index = 0; index < bitRates.length; index++) {
    const entry = bitRates[index];
    if (!isObj(entry)) continue;
    let candidate = videoCandidateFromSource(
      pick(entry, 'play_addr', 'playAddr'),
      entry,
      entry,
      `${videoPath}.bit_rate[${index}].play_addr`,
      index,
    );
    if (!candidate) continue;
    if (candidate.durationMs === 0 && globalDurationMs > 0) {
      candidate = new VideoCandidate(candidate.urls, candidate.uri, candidate.sourcePath,
        candidate.bitrate, candidate.width, candidate.height, candidate.shortEdge,
        candidate.pixels, globalDurationMs, candidate.traversalOrder);
    }
    candidates.push(candidate);
  }
  candidates.sort(videoQualityComparator);
  return candidates;
}

function withUri(candidate, uri) {
  return new VideoCandidate(candidate.urls, uri, candidate.sourcePath, candidate.bitrate,
    candidate.width, candidate.height, candidate.shortEdge, candidate.pixels,
    candidate.durationMs, candidate.traversalOrder);
}

/** collectNormalVideoCandidates: bit_rate quality ladder first, fallback key scan. */
function collectNormalVideoCandidates(video, videoPath) {
  if (!video) return [];

  const qualityCandidates = collectQualityCandidates(video, videoPath);
  if (qualityCandidates.length) {
    const globalUri = firstNonBlank(
      strTrim(video.vid),
      nestedUri(optObj(video, 'download_addr', 'downloadAddr')),
    );
    if (qualityCandidates[0].uri == null && globalUri) {
      qualityCandidates[0] = withUri(qualityCandidates[0], globalUri);
    }
    return qualityCandidates;
  }

  const candidates = [];
  let traversalOrder = 0;
  addDistinctVideoCandidate(candidates, videoCandidateFromSource(
    pick(video, 'play_addr', 'playAddr'), video, null,
    `${videoPath}.play_addr`, traversalOrder++));
  for (const key of PLAY_ADDR_KEYS) {
    addDistinctVideoCandidate(candidates, videoCandidateFromSource(
      video[key], video, null, `${videoPath}.${key}`, traversalOrder++));
  }

  const videoVid = strTrim(video.vid);
  const globalUri = firstNonBlank(videoVid, nestedUri(optObj(video, 'download_addr', 'downloadAddr')));
  if (candidates.length === 0 && globalUri) {
    candidates.push(new VideoCandidate([], globalUri,
      videoVid ? `${videoPath}.vid` : `${videoPath}.download_addr.uri`,
      0, 0, 0, 0, 0, mediaDurationMillis(video), traversalOrder));
  } else if (candidates.length && candidates[0].uri == null && globalUri) {
    candidates[0] = withUri(candidates[0], globalUri);
  }
  return candidates;
}

function collectLiveCandidates(item, itemPath) {
  const candidates = [];
  let traversalOrder = 0;
  const video = asObj(item.video);
  if (video) {
    const qualityCandidates = collectQualityCandidates(video, `${itemPath}.video`);
    for (const candidate of qualityCandidates) {
      addDistinctVideoCandidate(candidates, candidate);
    }
    if (qualityCandidates.length === 0) {
      addDistinctVideoCandidate(candidates, videoCandidateFromSource(
        pick(video, 'play_addr', 'playAddr'), video, null,
        `${itemPath}.video.play_addr`, traversalOrder++));
    }
    for (const key of PLAY_ADDR_KEYS) {
      addDistinctVideoCandidate(candidates, videoCandidateFromSource(
        video[key], video, null, `${itemPath}.video.${key}`, traversalOrder++));
    }
    addDistinctVideoCandidate(candidates, videoCandidateFromSource(
      pick(video, 'download_addr', 'downloadAddr'), video, null,
      `${itemPath}.video.download_addr`, traversalOrder++));
  }

  addDistinctVideoCandidate(candidates, videoCandidateFromAnySource(
    pick(item, 'video_play_addr', 'videoPlayAddr'), `${itemPath}.video_play_addr`, traversalOrder++));
  addDistinctVideoCandidate(candidates, videoCandidateFromAnySource(
    pick(item, 'video_download_addr', 'videoDownloadAddr'), `${itemPath}.video_download_addr`, traversalOrder));
  return candidates;
}

function videoQualityComparator(left, right) {
  return (right.pixels - left.pixels)
    || (right.bitrate - left.bitrate)
    || (right.shortEdge - left.shortEdge)
    || (left.traversalOrder - right.traversalOrder);
}

function imageComparator(left, right) {
  return ((left.watermarked ? 1 : 0) - (right.watermarked ? 1 : 0))
    || (right.resolutionScore - left.resolutionScore)
    || (left.sourceRank - right.sourceRank)
    || (left.formatRank - right.formatRank)
    || (left.traversalOrder - right.traversalOrder);
}

function sortedDeduplicatedImages(candidates) {
  candidates.sort(imageComparator);
  const seen = new Set();
  const deduplicated = [];
  for (const candidate of candidates) {
    if (!seen.has(candidate.url)) {
      seen.add(candidate.url);
      deduplicated.push(candidate);
    }
  }
  return deduplicated;
}

function addImageSource(output, source, metadata, sourceRank, sourcePath, traversalState) {
  let width = metadata ? positiveInt(metadata.width) : 0;
  let height = metadata ? positiveInt(metadata.height) : 0;
  if (metadata) {
    if (!width) width = positiveInt(metadata.w);
    if (!height) height = positiveInt(metadata.h);
  }
  const resolutionScore = imageResolutionScore(width, height);
  for (const url of extractUrls(source)) {
    output.push(new ImageCandidate(
      url, sourcePath, sourceRank,
      sourceRank === 7 || isWatermarkedMediaUrl(url),
      width, height, resolutionScore,
      null, traversalState[0]++,
    ));
  }
}

const IMAGE_SOURCE_RANKS = [
  { key: ['watermark_free_download_url_list', 'watermarkFreeDownloadUrlList'], rank: 0, meta: 'item' },
  { key: ['origin_image', 'originImage'], rank: 1, meta: 'source' },
  { key: ['display_image', 'displayImage'], rank: 2, meta: 'source' },
  { key: ['url_list', 'urlList'], rank: 3, meta: 'item' },
  { key: ['download_url', 'downloadUrl'], rank: 4, meta: 'source' },
  { key: ['download_addr', 'downloadAddr'], rank: 5, meta: 'source' },
  { key: ['download_url_list', 'downloadUrlList'], rank: 6, meta: 'item' },
  { key: ['owner_watermark_image', 'ownerWatermarkImage'], rank: 7, meta: 'source' },
];

function collectImageCandidates(item, itemPath) {
  const candidates = [];
  const traversalState = [0];
  for (const spec of IMAGE_SOURCE_RANKS) {
    const source = pick(item, spec.key[0], spec.key[1]);
    const metadata = spec.meta === 'item' ? item : asObj(source);
    addImageSource(candidates, source, metadata, spec.rank,
      `${itemPath}.${spec.key[0]}`, traversalState);
  }
  return sortedDeduplicatedImages(candidates);
}

function collectPreviewImageCandidates(video, videoPath) {
  if (!video) return [];
  const candidates = [];
  const traversalState = [0];
  const keys = [
    ['cover', 'cover'],
    ['origin_cover', 'originCover'],
    ['dynamic_cover', 'dynamicCover'],
    ['animated_cover', 'animatedCover'],
  ];
  for (let rank = 0; rank < keys.length; rank++) {
    const source = pick(video, keys[rank][0], keys[rank][1]);
    addImageSource(candidates, source, asObj(source), rank,
      `${videoPath}.${keys[rank][0]}`, traversalState);
  }
  return sortedDeduplicatedImages(candidates);
}

function findGalleryArray(awemeDetail) {
  const imagePostInfo = optObj(awemeDetail, 'image_post_info', 'imagePostInfo');
  if (imagePostInfo) {
    const images = imagePostInfo.images;
    if (Array.isArray(images) && images.length > 0) {
      return { items: images, path: 'image_post_info.images' };
    }
    const imageList = optArr(imagePostInfo, 'image_list', 'imageList');
    if (imageList && imageList.length > 0) return { items: imageList, path: 'image_post_info.image_list' };
  }
  const images = awemeDetail.images;
  if (Array.isArray(images) && images.length > 0) return { items: images, path: 'images' };
  const imageList = optArr(awemeDetail, 'image_list', 'imageList');
  if (imageList && imageList.length > 0) return { items: imageList, path: 'image_list' };
  return null;
}

function epochSecondsToMillis(epochSeconds, fallbackMillis) {
  if (epochSeconds <= 0 || epochSeconds > Number.MAX_SAFE_INTEGER / 1000) return fallbackMillis;
  return epochSeconds * 1000;
}

/** MediaSelector.select(awemeDetail) port. */
function selectMedia(awemeDetail) {
  if (!isObj(awemeDetail)) throw new ParseError('bad_detail', 'aweme_detail 缺失');

  const awemeIdRaw = pick(awemeDetail, 'aweme_id', 'awemeId');
  const awemeId = strTrim(awemeIdRaw == null ? null : String(awemeIdRaw));
  if (!awemeId) throw new ParseError('bad_detail', 'aweme_detail.aweme_id 缺失');

  let title = strTrim(awemeDetail.desc);
  if (title == null) title = 'no_title';

  const authorObject = optObj(awemeDetail, 'author', 'authorInfo');
  let author = authorObject ? strTrim(authorObject.nickname) : null;
  if (author == null && authorObject) author = strTrim(authorObject.name);
  if (author == null) author = 'unknown';

  const createTime = positiveLong(pick(awemeDetail, 'create_time', 'createTime'));
  const dateEpochMillis = epochSecondsToMillis(createTime, Date.now());
  const publishDate = new Date(dateEpochMillis).toISOString().slice(0, 10);

  const galleryArray = findGalleryArray(awemeDetail);
  const video = asObj(awemeDetail.video);
  const normalVideoCandidates = collectNormalVideoCandidates(video, 'video');
  const previewImageCandidates = collectPreviewImageCandidates(video, 'video');

  let mediaType;
  if (galleryArray) {
    mediaType = 'GALLERY';
  } else {
    const awemeTypeRaw = pick(awemeDetail, 'aweme_type', 'awemeType');
    let awemeType = -2147483648;
    if (typeof awemeTypeRaw === 'number') awemeType = Math.trunc(awemeTypeRaw);
    else if (awemeTypeRaw !== undefined && awemeTypeRaw !== null) {
      const n = Number(String(awemeTypeRaw).trim());
      if (Number.isFinite(n)) awemeType = Math.trunc(n);
    }
    if (GALLERY_AWEME_TYPES.has(awemeType)) {
      mediaType = normalVideoCandidates.length === 0 ? 'GALLERY' : 'VIDEO';
    } else {
      mediaType = 'VIDEO';
    }
  }

  const galleryItems = [];
  let gallerySourcePath = null;
  if (mediaType === 'GALLERY' && galleryArray) {
    gallerySourcePath = galleryArray.path;
    for (let itemIndex = 0; itemIndex < galleryArray.items.length; itemIndex++) {
      const item = galleryArray.items[itemIndex];
      const itemPath = `${galleryArray.path}[${itemIndex}]`;
      const images = isObj(item) ? collectImageCandidates(item, itemPath) : [];
      const live = isObj(item) ? collectLiveCandidates(item, itemPath) : [];
      galleryItems.push(new GalleryItemPlan(itemIndex, images, live));
    }
  }

  const plan = new WorkPlan(
    mediaType,
    awemeId,
    title,
    author,
    createTime,
    publishDate,
    mediaType === 'VIDEO' ? normalVideoCandidates : [],
    mediaType === 'VIDEO' ? previewImageCandidates : [],
    galleryItems,
    gallerySourcePath,
  );
  plan.audioMirrors = collectMusicMirrors(awemeDetail);
  return plan;
}

/** Clean mp3 BGM mirrors from aweme_detail.music (only used for live-photo). */
function collectMusicMirrors(awemeDetail) {
  if (!isObj(awemeDetail)) return [];
  const music = asObj(awemeDetail.music) || asObj(awemeDetail.Music);
  if (!music) return [];
  const seen = new Set();
  const out = [];
  const add = (u) => {
    if (u && !seen.has(u) && !isWatermarkedMediaUrl(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  const addNode = (node) => {
    if (!isObj(node)) return;
    for (const u of extractUrls(node)) add(u);
    const uri = strTrim(node.uri);
    if (uri && /\.mp3(\?|$)/i.test(uri) && out.length === 0) add(uri);
  };
  addNode(asObj(music.play_url) || asObj(music.playUrl));
  addNode(asObj(music.play_addr) || asObj(music.playAddr));
  return out;
}

// ---------------------------------------------------------------------------
// MediaPlanUtils / DownloadPreview ports — the "what can I save" view.
// ---------------------------------------------------------------------------

/**
 * www.douyin.com/aweme/v1/play… needs a logged-in cookie session and stays 403
 * even with a douyin Referer, so it is unopenable in a browser — drop it so the
 * listed mirrors are all openable (via /dl's no-referrer bridge or proxy).
 */
function isDeadMediaLink(url) {
  try {
    const p = new URL(url);
    return p.hostname === 'www.douyin.com' && /^\/aweme\/v1\/play/.test(p.pathname);
  } catch (_) {
    return false;
  }
}

function cleanUrls(values) {
  const clean = new Set();
  for (const value of values || []) {
    if (value && !isWatermarkedMediaUrl(value) && !isDeadMediaLink(value)) clean.add(value);
  }
  return [...clean];
}

/** First video candidate (quality order) that has any clean URL; its clean mirrors. */
function bestCleanVideoMirrors(candidates) {
  for (const candidate of candidates) {
    const clean = cleanUrls(candidate.urls);
    if (clean.length) return clean;
  }
  return [];
}

function bestCleanVideoCandidate(candidates) {
  for (const candidate of candidates) {
    if (cleanUrls(candidate.urls).length) return candidate;
  }
  return null;
}

function cleanImageMirrors(candidates) {
  const clean = new Set();
  for (const candidate of candidates) {
    if (!candidate.watermarked && candidate.url && !isWatermarkedMediaUrl(candidate.url)) {
      clean.add(candidate.url);
    }
  }
  return [...clean];
}

function firstCleanImageUrl(candidates) {
  const mirrors = cleanImageMirrors(candidates);
  return mirrors.length ? mirrors[0] : null;
}

function firstCleanImageCandidate(candidates) {
  for (const candidate of candidates) {
    if (!candidate.watermarked && candidate.url && !isWatermarkedMediaUrl(candidate.url)) {
      return candidate;
    }
  }
  return null;
}

function formatBytes(bytes) {
  if (bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes}B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)}KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)}MB`;
  return `${(mib / 1024).toFixed(2)}GB`;
}

function formatDuration(durationMs) {
  if (durationMs <= 0) return '时长未知';
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** DownloadPreview.from(plan): display-only summary with clean ordered mirrors. */
function buildPreview(plan) {
  const items = [];
  let assetCount = 0;
  let liveItemCount = 0;

  if (!plan.isGallery) {
    const videoMirrors = bestCleanVideoMirrors(plan.videoCandidates);
    if (videoMirrors.length) {
      const video = bestCleanVideoCandidate(plan.videoCandidates);
      items.push({
        galleryItemIndex: -1,
        label: '视频',
        previewImageUrl: firstCleanImageUrl(plan.previewImageCandidates),
        assets: [{
          label: '视频',
          width: video ? video.width : 0,
          height: video ? video.height : 0,
          durationMs: video ? video.durationMs : 0,
          mirrors: videoMirrors,
        }],
      });
      assetCount = 1;
    }
    return {
      awemeId: plan.awemeId,
      title: plan.title,
      author: plan.author,
      kindLabel: '视频',
      gallery: false,
      assetCount,
      liveItemCount: 0,
      items,
    };
  }

  for (const galleryItem of plan.galleryItems) {
    const stillMirrors = cleanImageMirrors(galleryItem.imageCandidates);
    const motionMirrors = bestCleanVideoMirrors(galleryItem.liveCandidates);
    const hasStill = stillMirrors.length > 0;
    const hasMotion = motionMirrors.length > 0;
    if (!hasStill && !hasMotion) continue;

    assetCount += (hasStill ? 1 : 0) + (hasMotion ? 1 : 0);
    if (hasMotion) liveItemCount++;

    const still = firstCleanImageCandidate(galleryItem.imageCandidates);
    const motion = bestCleanVideoCandidate(galleryItem.liveCandidates);
    const label = hasMotion
      ? `实况 ${galleryItem.itemIndex + 1}`
      : `图片 ${galleryItem.itemIndex + 1}`;

    const assets = [];
    if (hasStill) {
      assets.push({
        label: '静态图',
        width: still ? still.width : 0,
        height: still ? still.height : 0,
        durationMs: -1,
        mirrors: stillMirrors,
      });
    }
    if (hasMotion) {
      assets.push({
        label: '动态视频',
        width: motion ? motion.width : 0,
        height: motion ? motion.height : 0,
        durationMs: motion ? motion.durationMs : 0,
        mirrors: motionMirrors,
      });
    }
    items.push({
      galleryItemIndex: galleryItem.itemIndex,
      label,
      previewImageUrl: hasStill ? stillMirrors[0] : null,
      assets,
    });
  }

  const kindLabel = liveItemCount === 0
    ? '图集'
    : liveItemCount === items.length ? '实况图' : '图集（含实况）';
  const result = {
    awemeId: plan.awemeId,
    title: plan.title,
    author: plan.author,
    kindLabel,
    gallery: true,
    assetCount,
    liveItemCount,
    items,
  };
  // BGM mp3 belongs to live-photo posts only (still + motion + music).
  if (liveItemCount > 0 && plan.audioMirrors && plan.audioMirrors.length) {
    result.music = { label: '背景音乐 (mp3)', mirrors: plan.audioMirrors };
  }
  return result;
}

// ---------------------------------------------------------------------------
// MediaStoreDownloader-ish URL validation for /dl and /api/probe
// ---------------------------------------------------------------------------

function isPrivateHost(host) {
  const h = (host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0') return true;
  // IPv4 literals
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
  }
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }
  return false;
}

function validateMediaUrl(raw) {
  const parsed = parseUrl(raw);
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new ParseError('bad_media_url', '媒体地址不是标准 HTTPS 地址');
  }
  if (parsed.username || parsed.password) {
    throw new ParseError('bad_media_url', '媒体地址不允许携带用户信息');
  }
  if (parsed.port !== '' && Number(parsed.port) !== 443) {
    throw new ParseError('bad_media_url', '媒体地址端口不是 443');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new ParseError('bad_media_url', '媒体地址指向本地或私有网络');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Orchestration: the app's openText() -> inspector.start() pipeline, no WebView.
// ---------------------------------------------------------------------------

class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function errorBody(code, message, detail) {
  const body = { ok: false, error: { code, message } };
  if (detail !== undefined) body.error.detail = detail;
  return body;
}

async function runParse(text) {
  const steps = [];
  const jar = new CookieJar();
  try {
    return await doParse(text, steps, jar);
  } catch (err) {
    if (err instanceof ParseError) {
      err.steps = steps;
      throw err;
    }
    throw err;
  }
}

async function doParse(text, steps, jar) {

  steps.push('正在从输入中识别抖音链接');
  const douyinUrl = extractDouyinUrl(text);
  if (!douyinUrl) {
    throw new ParseError('no_douyin_link', '未找到 douyin.com 链接；请粘贴抖音分享文案或 douyin.com 链接');
  }
  steps.push(`已提取链接 ${douyinUrl}`);

  let awemeId = extractAwemeId(douyinUrl);
  let pageUrl = douyinUrl;

  if (!awemeId) {
    steps.push('短链未带作品 ID，正在展开短链');
    const resolved = await resolveShortLink(jar, douyinUrl);
    pageUrl = resolved.finalUrl;
    steps.push(`短链已展开为 ${pageUrl}`);
    awemeId = extractAwemeId(pageUrl);
    if (!awemeId) {
      const fromHtml = await fetchIdFromPageHtml(jar, pageUrl);
      awemeId = fromHtml;
    }
  }
  if (!awemeId) {
    throw new ParseError('no_aweme_id', '未能从链接中识别作品 ID');
  }
  steps.push(`作品 ID：${awemeId}`);

  // 1) Prime a trusted cookie session, then replay the native detail endpoint
  //    (DouyinInspector.performNativeFetch). Without the prime, Argus WAF often
  //    answers 403 to cookie-less crawler requests. A short automatic retry
  //    rides through douyin's transient per-IP 403 windows (no behaviour change).
  steps.push('正在建立会话并读取详情接口 JSON');
  let result = null;
  try {
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      await primeSession(jar, awemeId);
      result = await fetchDetailApi(jar, awemeId);
      if (!result && attempt < 2) {
        await sleep(900 * (attempt + 1));
      }
    }
  } catch (err) {
    if (!(err instanceof ParseError)) result = null;
    else throw err;
  }
  let source = null;
  if (!result) {
    // 2) Page-hydration probe fallback (DouyinInspector page probe).
    steps.push('详情接口未返回当前作品，正在读取作品页面数据');
    result = await fetchDetailFromPages(jar, awemeId);
  }
  if (!result) {
    throw new ParseError(
      'parse_failed',
      '未能读取当前作品。页面可能需要验证码或登录，或平台结构已变化',
    );
  }
  source = result.source;
  steps.push(`已从${source === 'detail_api' ? '详情接口' : '作品页面'}读取当前作品媒体信息`);

  const plan = selectMedia(result.detail);
  if (plan.isGallery) {
    // 3) Live-photo (实况) only: merge motion mp4 + BGM mp3 from the web-app
    //    detail when the current item actually has a live clip. Plain-image
    //    galleries and videos are left exactly as before.
    await enrichLiveFromWeb(jar, awemeId, plan);
  }
  const preview = buildPreview(plan);
  if (preview.assetCount <= 0) {
    throw new ParseError(
      'no_clean_assets',
      '详情中没有可用的无明确水印媒体地址（公开页面可能只提供水印源，或详情不完整）',
    );
  }
  steps.push(`已选择最高可用源（${preview.kindLabel}，共 ${preview.assetCount} 个素材）`);

  const output = {
    ok: true,
    source,
    aweme_id: plan.awemeId,
    awemeId: plan.awemeId,
    title: plan.title,
    author: plan.author,
    publish_date: plan.publishDate,
    gallery: preview.gallery,
    kind_label: preview.kindLabel,
    asset_count: preview.assetCount,
    live_item_count: preview.liveItemCount,
    items: preview.items,
    steps,
  };
  if (preview.music) output.music = preview.music;
  return output;
}

/** Last resort: fetch the aweme page itself and regex-hunt the id from its JSON. */
async function fetchIdFromPageHtml(jar, pageUrl) {
  try {
    const { status, body } = await httpGet(jar, pageUrl, {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    }, MAX_PAGE_DETAIL_CHARS);
    if (status !== 200) return null;
    // Direct "aweme_id": digits in raw HTML JSON.
    const direct = JSON_AWEME_RE.exec(body);
    return direct ? direct[1] : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Built-in web UI (served at "/", /app, /index.html). The same /api/parse
// endpoint is used by the page itself, so both standalone API and in-browser
// parsing stay in sync. Plain ES5-ish inline JS (no template-literal nesting).
// ---------------------------------------------------------------------------

const PAGE_HTML = '<!DOCTYPE html>' +
'<html lang="zh-CN"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>抖音素材解析 douyin-parse</title>' +
'<style>' +
':root{--bg:#0f1115;--card:#171a21;--line:#262b36;--tx:#e8eaf0;--dim:#9aa3b2;' +
'--acc:#3d7eff;--ok:#2ec27e;--err:#f0645a;--mono:ui-monospace,Consolas,monospace}' +
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);' +
'font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",Roboto,sans-serif}' +
'.wrap{max-width:960px;margin:0 auto;padding:20px 16px 80px}' +
'h1{font-size:20px;margin:6px 0 2px}h1 small{color:var(--dim);font-weight:400;font-size:13px}' +
'p.sub{color:var(--dim);margin:0 0 14px}' +
'textarea{width:100%;min-height:96px;resize:vertical;background:#10131a;color:var(--tx);' +
'border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit}' +
'textarea:focus{outline:none;border-color:var(--acc)}' +
'.row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}' +
'button{appearance:none;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;' +
'font:inherit;background:#252b38;color:var(--tx)}' +
'button.primary{background:var(--acc);font-weight:600}' +
'button:disabled{opacity:.5;cursor:wait}' +
'button.sm{padding:3px 10px;font-size:12px;border-radius:6px}' +
'button.ok{background:var(--ok);color:#062b18;font-weight:600}' +
'a{color:var(--acc);text-decoration:none}.btn{display:inline-block;padding:3px 10px;' +
'border-radius:6px;background:#252b38;font-size:12px;color:var(--tx)}' +
'.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:14px}' +
'.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:14px}' +
'.kv b{color:var(--dim);font-weight:400;white-space:nowrap}' +
'.kv div{word-break:break-word}' +
'.items{margin-top:14px}.item{border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px}' +
'.item h3{margin:0 0 8px;font-size:15px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
'.tag{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:0 8px}' +
'.asset{margin-top:2px;padding-top:0}' +
'.asset-head{color:var(--dim);font-size:12px;margin-top:10px;border-top:1px dashed var(--line);padding-top:8px}' +
'.asset .meta{color:var(--dim);font-size:13px;margin:2px 0 6px}' +
'.linkrow{display:flex;align-items:center;gap:8px;margin:5px 0}' +
'.linkrow .lbox{flex:1;min-width:0;border:1px solid var(--line);border-radius:8px;' +
'background:#0e1117;overflow-x:auto;overflow-y:hidden;white-space:nowrap;cursor:copy;' +
'font-family:var(--mono);font-size:12px;color:#cfdcff;padding:6px 10px;' +
'scrollbar-width:none;-ms-overflow-style:none}' +
'video.lplay{display:block;max-width:100%;max-height:300px;margin:8px 0;border-radius:10px;' +
'background:#000;border:1px solid var(--line)}' +
'.linkrow .lbox::-webkit-scrollbar{width:0;height:0;display:none}' +
'.linkrow .lbox:hover{background:#131823}' +
'.linkrow .lact{flex:0 0 auto;display:inline-flex;gap:6px}' +
'.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:14px}' +
'.photo-cell{position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;' +
'background:#0e1117;cursor:zoom-in}' +
'.photo-cell img{display:block;width:100%;height:190px;object-fit:cover}' +
'.photo-cell figcaption{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);' +
'color:#fff;font-size:12px;padding:2px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
'.links{margin-top:18px}.link-group{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:10px}' +
'.link-group h3{margin:0 0 6px;font-size:15px}' +
'.lb{position:fixed;inset:0;background:rgba(0,0,0,.93);display:none;align-items:center;' +
'justify-content:center;z-index:99}' +
'.lb.open{display:flex}' +
'.lb img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:6px;' +
'transform-origin:center center;transition:transform .12s ease;' +
'box-shadow:0 6px 40px rgba(0,0,0,.6)}' +
'.lb .cap{position:fixed;bottom:12px;left:0;right:0;text-align:center;color:#cfd6e4;font-size:13px}' +
'.lb .close{position:fixed;top:10px;right:12px;background:none;border:0;color:#fff;' +
'font-size:22px;cursor:pointer;line-height:1;padding:6px}' +
'.lb .nav{position:fixed;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;' +
'font-size:34px;cursor:pointer;line-height:1;padding:8px 14px;opacity:.75}' +
'.lb .nav:hover{opacity:1}.lb .prev{left:6px}.lb .next{right:6px}' +
'.err{border-color:#5b2a26;background:#1c1416}.steps{color:var(--dim);font-size:12px;' +
'white-space:pre-wrap;font-family:var(--mono)}#status{color:var(--dim);font-size:13px;min-height:20px}' +
'.size{color:var(--ok);font-size:12px;margin-left:6px}.muted{color:var(--dim);font-size:12px}' +
'footer{margin-top:30px;color:#66707f;font-size:12px;line-height:1.8}' +
'</style></head><body><div class="wrap">' +
'<h1>抖音素材解析 <small>douyin-parse · 视频 / 图集 / 实况</small></h1>' +
'<p class="sub">粘贴抖音分享文案或 douyin.com 链接，解析当前公开页面提供的最高可用无水印源。</p>' +
'<textarea id="in" placeholder="示例：8.88 复制打开抖音 https://v.douyin.com/xxxxxx/ 复制此链接，打开Dou音搜索…"></textarea>' +
'<div class="row"><button class="primary" id="run">解析</button>' +
'<button id="sample">填入示例</button>' +
'<span id="status" style="align-self:center"></span></div>' +
'<div id="result"></div>' +
'<div id="error" class="card err" style="display:none"></div>' +
'<div id="lb" class="lb" onclick="lbClose()" role="dialog" aria-label="图片放大预览">' +
'<button type="button" class="close" onclick="event.stopPropagation();lbClose()" title="关闭">✕</button>' +
'<button type="button" class="nav prev" onclick="event.stopPropagation();lbStep(-1)" title="上一张">‹</button>' +
'<img id="lbImg" alt="放大查看" onclick="event.stopPropagation()">' +
'<button type="button" class="nav next" onclick="event.stopPropagation();lbStep(1)" title="下一张">›</button>' +
'<div id="lbCap" class="cap"></div>' +
'</div>' +
'<footer>隐私：带签名的媒体地址只在你浏览器与抖音 CDN 之间使用，本服务不记录任何分享内容。' +
'<br>仅用于解析你有权处理的内容；抖音对详情接口按 IP 限流，失败时的步骤会显示在错误卡片中。</footer>' +
'</div>' +
'<script>' +
'var inEl=document.getElementById("in"),runEl=document.getElementById("run"),' +
'statusEl=document.getElementById("status"),resEl=document.getElementById("result"),' +
'errEl=document.getElementById("error");' +
'function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}' +
'function setStatus(t){statusEl.textContent=t||"";}' +
'function onErr(body){errEl.style.display="block";errEl.innerHTML="";' +
'var h=document.createElement("h3");h.textContent="解析失败："+(body&&body.error&&body.error.message?body.error.message:"未知错误");' +
'errEl.appendChild(h);if(body&&body.error&&body.error.detail&&body.error.detail.steps){' +
'var p=document.createElement("p");p.className="steps";p.textContent=body.error.detail.steps.join("\\n");errEl.appendChild(p);}' +
'errEl.scrollIntoView({behavior:"smooth"});}' +
'function onErrText(t){errEl.style.display="block";errEl.innerHTML="";' +
'var h=document.createElement("h3");h.textContent=t;errEl.appendChild(h);}' +
'async function post(){var t=inEl.value.trim();if(!t){onErrText("请先粘贴分享文案或链接");return;}' +
'runEl.disabled=true;errEl.style.display="none";resEl.innerHTML="";setStatus("解析中…");' +
'try{var r=await fetch("/api/parse",{method:"POST",headers:{"Content-Type":"application/json"},' +
'body:JSON.stringify({text:t})});var j=await r.json();' +
'if(!r.ok||!j.ok){onErr(j);return;}' +
'if(j.error){onErr(j);return;}' +
'render(j);setStatus("完成："+(j.steps?j.steps[j.steps.length-1]:""));}' +
'catch(e){onErrText("网络错误："+e);}' +
'finally{runEl.disabled=false;}}' +
'function render(j){resEl.innerHTML="";' +
'var card=document.createElement("div");card.className="card";' +
'var kv=document.createElement("div");kv.className="kv";' +
'addRow(kv,"标题",j.title);addRow(kv,"作者",j.author);addRow(kv,"发布时间",j.publish_date);' +
'addRow(kv,"类型",j.kind_label+"（共 "+j.asset_count+" 个素材）");' +
'addRow(kv,"作品 ID",j.aweme_id);addRow(kv,"数据来源",j.source);' +
'card.appendChild(kv);resEl.appendChild(card);' +
'var pbox=photosBlock(j.items);if(pbox){resEl.appendChild(pbox);}' +
'resEl.appendChild(linksBlock(j.items));' +
'if(j.music){var mb=musicBlock(j.music);if(mb){resEl.appendChild(mb);}}' +
'resEl.scrollIntoView({behavior:"smooth"});' +
'probeSizes(j.items);}' +
'function addRow(kv,k,v){var b=document.createElement("b");b.textContent=k;' +
'var d=document.createElement("div");d.textContent=v;kv.appendChild(b);kv.appendChild(d);}' +
'function photosBlock(items){var photos=[];for(var i=0;i<items.length;i++){' +
'if(items[i].previewImageUrl){photos.push({url:items[i].previewImageUrl,label:items[i].label});}}' +
'if(!photos.length)return null;window.__photos=photos;' +
'var wrap=document.createElement("div");wrap.className="photos";' +
'for(var p=0;p<photos.length;p++){(function(ph,idx){' +
'var cell=document.createElement("figure");cell.className="photo-cell";' +
'var im=document.createElement("img");im.loading="lazy";im.decoding="async";im.alt=ph.label;' +
'im.referrerPolicy="no-referrer";im.src=ph.url;' +
'im.onerror=function(){im.onerror=null;im.src="/api/thumb?url="+encodeURIComponent(ph.url);};' +
'var cap=document.createElement("figcaption");cap.textContent=ph.label;' +
'cell.appendChild(im);cell.appendChild(cap);' +
'cell.onclick=function(){openLightbox(idx);};wrap.appendChild(cell);' +
'})(photos[p],p);}' +
'return wrap;}' +
'function linksBlock(items){var wrap=document.createElement("div");wrap.className="links";' +
'for(var i=0;i<items.length;i++){var it=items[i];' +
'var g=document.createElement("div");g.className="link-group";' +
'var h=document.createElement("h3");h.textContent=(it.label?it.label:"作品")+" 的链接";g.appendChild(h);' +
'for(var a=0;a<it.assets.length;a++){g.appendChild(assetBlock(it.assets[a]));}' +
'wrap.appendChild(g);}return wrap;}' +
'function musicBlock(m){if(!m||!m.mirrors||!m.mirrors.length)return null;' +
'var g=document.createElement("div");g.className="link-group";' +
'var h=document.createElement("h3");h.textContent=(m.label?m.label:"背景音乐")+" 的链接";g.appendChild(h);' +
'var blk=assetBlock({label:"音频 mp3",width:0,height:0,durationMs:-1,mirrors:m.mirrors});' +
'var sz=blk.querySelector(".size");if(sz){sz.textContent="";}g.appendChild(blk);return g;}' +
'function openLightbox(idx){var ph=window.__photos;if(!ph||!ph.length)return;' +
'var lb=document.getElementById("lb");var img=document.getElementById("lbImg");' +
'var cap=document.getElementById("lbCap");window.__lbIdx=idx;' +
'function show(){var cur=ph[window.__lbIdx];img.src=cur.url;' +
'window.__zoom=1;img.style.transform="";' +
'img.onerror=function(){img.onerror=null;img.src="/api/thumb?url="+encodeURIComponent(cur.url);};' +
'cap.textContent=cur.label+"（"+(window.__lbIdx+1)+"/"+ph.length+"）· 滚轮缩放图片";}' +
'window.__lbShow=show;show();lb.classList.add("open");}' +
'function lbClose(){document.getElementById("lb").classList.remove("open");}' +
'function lbStep(d){if(!window.__photos||!window.__photos.length)return;' +
'window.__lbIdx=(window.__lbIdx+d+window.__photos.length)%window.__photos.length;' +
'if(window.__lbShow){window.__lbShow();}}' +
'function assetBlock(as){var w=document.createElement("div");w.className="asset";' +
'var meta=document.createElement("div");meta.className="meta";' +
'meta.textContent=as.label+(as.width>0&&as.height>0?" · "+as.width+"×"+as.height:"")+' +
'(as.durationMs>0?" · "+dur(as.durationMs):"");' +
'var size=document.createElement("span");size.className="size";size.textContent="大小探测中…";' +
'meta.appendChild(size);w.appendChild(meta);' +
'if(as.label==="动态视频"&&as.mirrors.length){' +
'var v=document.createElement("video");v.className="lplay";v.controls=true;' +
'v.playsInline=true;v.preload="metadata";' +
'v.src="/dl?url="+encodeURIComponent(as.mirrors[0]);' +
'v.title="在线播放（经 /dl 代理，抖音防盗链源无法浏览器直连）";w.appendChild(v);}' +
'for(var m=0;m<as.mirrors.length;m++){w.appendChild(linkRow(as.mirrors[m]));}' +
'return w;}' +
'function linkRow(url){var row=document.createElement("div");row.className="linkrow";' +
'var bx=document.createElement("div");bx.className="lbox";bx.textContent=url;' +
'bx.title="双击复制该链接";bx.ondblclick=function(ev){ev.preventDefault();copyText(url);};' +
'bx.addEventListener("wheel",function(e){' +
'if(bx.scrollWidth>bx.clientWidth){e.preventDefault();' +
'bx.scrollLeft+=(e.deltaY||e.deltaX||0);}},{passive:false});' +
'row.appendChild(bx);' +
'var act=document.createElement("span");act.className="lact";' +
'var a=document.createElement("a");a.className="btn";a.href=url;' +
'a.target="_blank";a.rel="noreferrer";a.textContent="打开";act.appendChild(a);' +
'var p=document.createElement("a");p.className="btn";p.href="/dl?url="+encodeURIComponent(url);' +
'p.target="_blank";p.rel="noreferrer";p.title="抖音防盗链（需站内 Referer）导致直开 403 时，用代理打开";' +
'p.textContent="代理";act.appendChild(p);' +
'var b=document.createElement("button");b.className="sm";b.textContent="复制";' +
'b.onclick=function(ev){ev.stopPropagation();copyText(url);};act.appendChild(b);' +
'row.appendChild(act);return row;}' +
'function copyText(t){var done=function(){setStatus("已复制到剪贴板");};' +
'if(navigator.clipboard&&navigator.clipboard.writeText){' +
'navigator.clipboard.writeText(t).then(done,function(){fallbackCopy(t,done);});}' +
'else{fallbackCopy(t,done);}}' +
'function fallbackCopy(t,done){var ta=document.createElement("textarea");ta.value=t;' +
'ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();' +
'try{document.execCommand("copy");done();}catch(e){setStatus("复制失败，请手动选择地址");}' +
'document.body.removeChild(ta);}' +
'function dur(ms){var s=Math.max(1,Math.round(ms/1000));var h=Math.floor(s/3600);' +
'var m=Math.floor(s%3600/60);var x=s%60;function p(n){return (n<10?"0":"")+n;}' +
'return h>0?h+":"+p(m)+":"+p(x):p(m)+":"+p(x);}' +
'function human(n){if(n<0)return "大小未知";if(n<1024)return n+"B";' +
'var k=n/1024;if(k<1024)return k.toFixed(1)+"KB";var m=k/1024;' +
'if(m<1024)return m.toFixed(1)+"MB";return (m/1024).toFixed(2)+"GB";}' +
'function probeSizes(items){var marks=document.querySelectorAll(".asset .size");var idx=0;' +
'for(var i=0;i<items.length;i++){for(var a=0;a<items[i].assets.length;a++){' +
'if(idx>=marks.length)return;(function(mark,url){' +
'fetch("/api/probe?url="+encodeURIComponent(url)).then(function(r){return r.json();})' +
'.then(function(j){mark.textContent=j&&j.ok?("约 "+human(j.bytes)):"大小未知";})' +
'.catch(function(){mark.textContent="大小未知";});' +
'})(marks[idx],items[i].assets[a].mirrors[0]);idx++;}}}' +
'document.getElementById("sample").addEventListener("click",function(){' +
'inEl.value="7.43 复制打开抖音，看看【示例作品】https://www.douyin.com/video/7556500752194178343 复制此链接，打开Dou音搜索，直接观看视频！";' +
'setStatus("已填入示例，点击解析");});' +
'runEl.addEventListener("click",post);' +
'inEl.addEventListener("keydown",function(e){if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();post();}});' +
'document.addEventListener("keydown",function(e){var lb=document.getElementById("lb");' +
'if(!lb.classList.contains("open"))return;' +
'if(e.key==="Escape"){lbClose();}else if(e.key==="ArrowLeft"){lbStep(-1);}' +
'else if(e.key==="ArrowRight"){lbStep(1);}});' +
'document.getElementById("lb").addEventListener("wheel",function(e){' +
'var lb=document.getElementById("lb");if(!lb.classList.contains("open"))return;' +
'e.preventDefault();var img=document.getElementById("lbImg");' +
'var z=(window.__zoom||1);z=e.deltaY<0?Math.min(10,z*1.2):Math.max(1,z/1.2);' +
'window.__zoom=z;img.style.transform="scale("+z+")";},{passive:false});' +
'</script></body></html>';


const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function readTextParam(url, request) {
  const fromQuery = url.searchParams.get('text') ?? url.searchParams.get('url');
  return fromQuery;
}

async function readBodyText(request, url) {
  if (request.method !== 'POST' && request.method !== 'PUT') return null;
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      throw new ParseError('bad_input', '请求体不是合法 JSON');
    }
    if (payload && typeof payload === 'object') {
      const value = payload.text ?? payload.url;
      if (value !== undefined && value !== null) return String(value);
    }
    throw new ParseError('bad_input', 'JSON 中需要 text 或 url 字段');
  }
  // text/plain or anything else -> raw share text
  const raw = await request.text();
  return raw;
}

async function handleParse(request, url) {
  const fromBody = await readBodyText(request, url);
  let text = fromBody;
  if (text == null || text.trim() === '') text = readTextParam(url, request);
  if (text == null || text.trim() === '') {
    return jsonResponse(400, errorBody(
      'bad_input',
      '缺少输入：GET /api/parse?text=… 或 POST {"text": "分享文案/链接"}',
    ));
  }
  try {
    const result = await runParse(String(text).slice(0, 16384));
    return jsonResponse(200, result);
  } catch (err) {
    if (err instanceof ParseError) {
      const detail = err.steps && err.steps.length ? { steps: err.steps } : undefined;
      const status = err.code === 'no_douyin_link' || err.code === 'bad_input'
        ? 400
        : err.code === 'no_aweme_id' || err.code === 'item_unavailable'
          ? 404
          : 502;
      return jsonResponse(status, errorBody(err.code, err.message, detail));
    }
    return jsonResponse(502, errorBody('internal', `解析异常：${err && err.message ? err.message : err}`));
  }
}

async function handleProbe(url) {
  const raw = url.searchParams.get('url');
  if (!raw) return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
  try {
    validateMediaUrl(raw);
    // probeRemoteSize: 1-byte range, no body download.
    const response = await fetch(raw, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': DESKTOP_UA,
        Referer: REFERER,
        Accept: '*/*',
      },
    });
    const status = response.status;
    let bytes = -1;
    if (status === 206) {
      const contentRange = response.headers.get('content-range');
      if (contentRange) {
        const slash = contentRange.lastIndexOf('/');
        const total = slash >= 0 ? contentRange.slice(slash + 1).trim() : '';
        if (total && total !== '*') {
          const n = Number(total);
          if (Number.isFinite(n) && n > 0) bytes = n;
        }
      }
    } else if (status === 200) {
      const len = Number(response.headers.get('content-length') || '-1');
      if (Number.isFinite(len) && len > 0) bytes = len;
    }
    return jsonResponse(200, {
      ok: true,
      status,
      bytes,
      human: formatBytes(bytes),
    });
  } catch (err) {
    if (err instanceof ParseError) return jsonResponse(400, errorBody(err.code, err.message));
    return jsonResponse(502, errorBody('probe_failed', '大小探测失败'));
  }
}

async function handleDownload(url, request) {
  const raw = url.searchParams.get('url');
  if (!raw) return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
  try {
    const validated = validateMediaUrl(raw);
    if (isWatermarkedMediaUrl(validated.toString())) {
      return jsonResponse(400, errorBody('watermarked', '该地址带明确水印标记，已拒绝'));
    }
    const target = validated.toString();
    // Browsers: most CDNs open fine with an empty Referer via the no-referrer
    // bridge page; douyinvod-web media (live-photo mp4) answers 403 without a
    // douyin Referer, so those are streamed through this Worker with one.
    // Scripts/tools keep the plain 302 either way.
    const accept = (request ? request.headers.get('accept') : '') || '';
    if (accept.toLowerCase().includes('text/html')) {
      if (hostNeedsReferer(validated.hostname)) {
        return await proxyMedia(target, request);
      }
      return noReferrerBridge(target);
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: target,
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    if (err instanceof ParseError) return jsonResponse(400, errorBody(err.code, err.message));
    return jsonResponse(400, errorBody('bad_media_url', '媒体地址校验失败'));
  }
}

/** Hosts that answer 403 without a douyin Referer (douyinvod web CDN …). */
function hostNeedsReferer(host) {
  const h = (host || '').toLowerCase();
  return h.endsWith('.douyinvod.com')
    || h === 'douyinvod.com'
    || h === 'www.douyin.com'
    || h.endsWith('.douyin.com')
    || h === 'douyin.com'
    || h.endsWith('.amemv.com')
    || h === 'amemv.com'
    || h.endsWith('.snssdk.com')
    || h.endsWith('.iesdouyin.com');
}

/** Stream media through this Worker with a douyin Referer (+ Range passthrough). */
async function proxyMedia(target, request) {
  try {
    const headers = {
      'User-Agent': DESKTOP_UA,
      Referer: REFERER,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    };
    const range = request ? request.headers.get('range') : null;
    if (range) headers.Range = range;
    const upstream = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers,
    });
    if (!upstream.ok) {
      return jsonResponse(502, errorBody('media_failed', '媒体源返回 HTTP ' + upstream.status));
    }
    const outHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Cache-Control': 'private, no-store',
      ...CORS_HEADERS,
    };
    for (const name of ['content-range', 'content-length']) {
      const value = upstream.headers.get(name);
      if (value) outHeaders[name] = value;
    }
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  } catch (err) {
    return jsonResponse(502, errorBody('media_failed', '媒体转发失败'));
  }
}

/** Tiny HTML page that opens the media with an empty Referer. */
function noReferrerBridge(target) {
  const esc = target
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const jsLit = JSON.stringify(target).replace(/<\//g, '<\\/');
  const html =
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>正在打开媒体…</title></head>' +
    '<body style="margin:0;font-family:-apple-system,\'Segoe UI\',\'Microsoft YaHei\',sans-serif;' +
    'background:#0f1115;color:#e8eaf0;min-height:100vh;display:flex;align-items:center;justify-content:center">' +
    '<div style="text-align:center;padding:20px">' +
    '<p>正在打开媒体文件…</p>' +
    '<p><a href="' + esc + '" rel="noreferrer" style="color:#6ea8ff">若未自动跳转，请点击这里</a></p>' +
    '</div>' +
    '<script>location.replace(' + jsLit + ');</script>' +
    '</body></html>';
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      ...CORS_HEADERS,
    },
  });
}

function handlePage() {
  return new Response(PAGE_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

/** Thumbnail proxy: douyin image CDN previews may hotlink-protect. */
async function handleThumb(url) {
  const raw = url.searchParams.get('url');
  if (!raw) return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
  try {
    validateMediaUrl(raw);
    const response = await fetch(raw, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': DESKTOP_UA,
        Referer: REFERER,
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!response.ok) {
      return jsonResponse(502, errorBody('thumb_failed', '缩略图源返回 HTTP ' + response.status));
    }
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) {
      return jsonResponse(502, errorBody('thumb_failed', '响应不是图片'));
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 20 * 1024 * 1024) {
      return jsonResponse(502, errorBody('thumb_failed', '图片超过 20 MiB 安全限制'));
    }
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'public, max-age=3600',
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    if (err instanceof ParseError) return jsonResponse(400, errorBody(err.code, err.message));
    return jsonResponse(502, errorBody('thumb_failed', '缩略图获取失败'));
  }
}

const HELP = {
  name: 'douyin-parse',
  description: '抖音分享链接解析（移植 douyin-material-saver 的解析规则）：返回当前公开页面最高可用、无明确水印的媒体源镜像列表。',
  endpoints: {
    'GET /（或 /app、/index.html）': '内置网页：粘贴分享文案直接解析、预览缩略图与大小、打开/复制镜像',
    'GET /help': '本帮助（JSON）',
    'GET /api/parse?text=…': '解析分享文案（URL 编码）',
    'GET /api/parse?url=…': '解析 douyin.com / v.douyin.com 链接',
    'POST /api/parse': 'JSON 请求体 {"text": "分享文案"} 或 {"url": "链接"}',
    'GET /api/thumb?url=…': '图片代理缩略图（带 Referer/UA，供网页预览）',
    'GET /api/probe?url=…': '探测媒体地址远端大小（Range bytes=0-0，不下载正文）',
    'GET /dl?url=…': '302 跳转到通过校验（HTTPS + 公网 + 无水印标记）的镜像',
    'GET /api/selftest': '选择器确定性自测（不需要网络）',
  },
  response: {
    ok: true,
    source: "'detail_api' | 'page_embed'",
    aweme_id: '作品 ID',
    title: '标题',
    author: '作者',
    publish_date: '发布日期 yyyy-MM-dd',
    gallery: '是否为图集',
    kind_label: '视频 / 图集 / 实况图 / 图集（含实况）',
    asset_count: '素材文件数',
    items: '每项含 assets[].mirrors（可直接下载的干净镜像列表，按优先级排序）',
  },
  notes: [
    '仅用于你有权处理的内容；平台页面结构、验证状态或地区差异都可能影响结果。',
    '带签名的媒体地址只返回给调用方，不会写入日志。',
  ],
};

function handleHelp() {
  return jsonResponse(200, HELP);
}

// ---------------------------------------------------------------------------
// Deterministic self-test (no network): mirrors MediaSelectorTest expectations.
// ---------------------------------------------------------------------------

function selftestVideoQuality() {
  const play = (url, uri, w, h) => {
    const o = { width: w, height: h };
    if (url) o.url_list = [url];
    if (uri) o.uri = uri;
    return o;
  };
  const entry = (bitrate, w, h, url, uri) => ({
    bit_rate: bitrate,
    play_addr: play(url, uri, w, h),
  });
  const detail = {
    aweme_id: 'video-1',
    desc: ' test title ',
    create_time: 1700000000,
    author: { nickname: 'test author' },
    aweme_type: 4,
    video: {
      bit_rate: [
        entry(9000000, 3840, 2160, null, null), // fake: no url/uri -> filtered
        entry(8000000, 1080, 1920, 'https://cdn.example/1080.mp4', null),
        entry(3000000, 1440, 2560, 'https://cdn.example/1440.mp4', '1440-uri'),
      ],
    },
  };
  const plan = selectMedia(detail);
  if (plan.mediaType !== 'VIDEO') throw new Error('video quality: mediaType');
  if (plan.videoCandidates.length !== 2) throw new Error('video quality: count');
  const first = plan.videoCandidates[0];
  if (first.urls[0] !== 'https://cdn.example/1440.mp4') throw new Error('video quality: order');
  if (first.shortEdge !== 1440) throw new Error('video quality: shortEdge');
  if (first.uri !== '1440-uri') throw new Error('video quality: uri');
  if (plan.videoCandidates[1].urls[0] !== 'https://cdn.example/1080.mp4') throw new Error('video quality: 2nd');
  return 'video_quality_ok';
}

function selftestUrlOrdering() {
  const detail = {
    aweme_id: 'video-3',
    desc: 't',
    video: {
      play_addr: {
        uri: 'clean-uri',
        url_list: [
          'https://cdn.example/playwm/a.mp4?watermark=1',
          'https://cdn.example/direct.mp4',
          'https://www.douyin.com/play?watermark=0',
        ],
      },
    },
  };
  const plan = selectMedia(detail);
  const urls = plan.videoCandidates[0].urls;
  const expect = [
    'https://www.douyin.com/play?watermark=0',
    'https://cdn.example/direct.mp4',
    'https://cdn.example/playwm/a.mp4?watermark=1',
  ];
  if (JSON.stringify(urls) !== JSON.stringify(expect)) throw new Error('url ordering mismatch: ' + JSON.stringify(urls));
  const preview = buildPreview(plan);
  if (preview.items.length !== 1 || preview.items[0].assets[0].mirrors.length !== 2) {
    throw new Error('url ordering: clean mirrors');
  }
  return 'url_ordering_ok';
}

function selftestGallery() {
  const imageSource = (url, w, h) => ({ url_list: [url], width: w, height: h });
  const first = { video: { dynamic_cover: { url_list: ['https://cdn.example/not-live.mp4'] } } };
  const second = { display_image: imageSource('https://cdn.example/real.webp', 1080, 1920) };
  const detail = {
    aweme_id: 'gallery-1',
    aweme_type: 68,
    video: { play_addr: { url_list: ['https://cdn.example/audio-ish.mp4'] } },
    image_post_info: { images: [first, second] },
  };
  const plan = selectMedia(detail);
  if (plan.mediaType !== 'GALLERY') throw new Error('gallery: mediaType');
  if (plan.galleryItems.length !== 2) throw new Error('gallery: item count');
  if (plan.galleryItems[0].imageCandidates.length !== 0) throw new Error('gallery: first clean');
  if (plan.galleryItems[1].imageCandidates[0].url !== 'https://cdn.example/real.webp') {
    throw new Error('gallery: second url');
  }
  const preview = buildPreview(plan);
  if (preview.kindLabel !== '图集') throw new Error('gallery: kindLabel');
  if (preview.assetCount !== 1) throw new Error('gallery: assetCount');
  return 'gallery_ok';
}

function selftestImageRanking() {
  const item = {
    watermark_free_download_url_list: ['https://cdn.example/clean-free-720.jpg'],
    width: 720,
    height: 1280,
    origin_image: { url_list: ['https://cdn.example/origin-1440.jpg'], width: 1440, height: 2560 },
    display_image: { url_list: ['https://cdn.example/display-1080.jpg'], width: 1080, height: 1920 },
    download_url_list: [
      'https://cdn.example/fallback.webp',
      'https://cdn.example/fallback.jpeg',
    ],
    owner_watermark_image: { url_list: ['https://cdn.example/owner_watermark_image-2160.jpg'], width: 2160, height: 3840 },
  };
  const plan = selectMedia({ aweme_id: 'gallery-2', desc: 'x', images: [item] });
  const urls = plan.galleryItems[0].imageCandidates.map((c) => c.url);
  const expect = [
    'https://cdn.example/origin-1440.jpg',
    'https://cdn.example/display-1080.jpg',
    'https://cdn.example/clean-free-720.jpg',
    'https://cdn.example/fallback.jpeg',
    'https://cdn.example/fallback.webp',
    'https://cdn.example/owner_watermark_image-2160.jpg',
  ];
  if (JSON.stringify(urls) !== JSON.stringify(expect)) {
    throw new Error('image ranking mismatch: ' + JSON.stringify(urls));
  }
  return 'image_ranking_ok';
}

function selftestExtractors() {
  const share = '7.43 复制打开抖音，看看【xx的作品】 https://v.douyin.com/iAbCdEf/ 复制此链接，打开Dou音搜索，直接观看视频！';
  const url = extractDouyinUrl(share);
  if (url !== 'https://v.douyin.com/iAbCdEf/') throw new Error('extract url: ' + url);
  const direct = 'https://www.douyin.com/video/7166733828659637512?previous_page=app_code_link';
  if (extractAwemeId(direct) !== '7166733828659637512') throw new Error('extract path id');
  if (extractAwemeId('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7166733828659637512&a=1') !== '7166733828659637512') {
    throw new Error('extract query id');
  }
  if (extractAwemeId('{"aweme_id":"12345678901","x":1}') !== '12345678901') throw new Error('extract json id');
  if (extractDouyinUrl('see https://example.com/x and https://www.iesdouyin.com/share/video/1234567890') !== 'https://www.iesdouyin.com/share/video/1234567890') {
    throw new Error('extract iesdouyin host');
  }
  if (!isWatermarkedMediaUrl('https://x/a?watermark=1')) throw new Error('watermark hint');
  if (!isWatermarkedMediaUrl('https://www.douyin.com/aweme/v1/playwm/?video_id=x')) throw new Error('playwm hint');
  if (isWatermarkedMediaUrl('https://cdn.example/clean.mp4')) throw new Error('clean url flagged');
  return 'extractors_ok';
}

function handleSelfTest() {
  const checks = [];
  try {
    checks.push(selftestVideoQuality());
    checks.push(selftestUrlOrdering());
    checks.push(selftestGallery());
    checks.push(selftestImageRanking());
    checks.push(selftestExtractors());
    return jsonResponse(200, { ok: true, checks });
  } catch (err) {
    return jsonResponse(500, errorBody('selftest_failed', err && err.message ? err.message : String(err), { checks }));
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/' || path === '/app' || path === '/index.html') return handlePage();
      if (path === '/help' || path === '/api') return handleHelp();
      if (path === '/api/parse' || path === '/parse') return await handleParse(request, url);
      if (path === '/api/probe' || path === '/probe') return await handleProbe(url);
      if (path === '/api/thumb' || path === '/thumb') return await handleThumb(url);
      if (path === '/dl' || path === '/api/dl' || path === '/download') return handleDownload(url, request);
      if (path === '/api/selftest' || path === '/selftest') return handleSelfTest();
      return jsonResponse(404, errorBody('not_found', `未知路径 ${request.url}`));
    } catch (err) {
      return jsonResponse(500, errorBody('internal', err && err.message ? err.message : String(err)));
    }
  },
};
