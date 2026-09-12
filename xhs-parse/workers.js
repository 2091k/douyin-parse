/**
 * xhs-parse — Cloudflare Worker
 *
 * Server-side port of the parse pipeline from the `XHS-Downloader` project
 * (github.com/JoeanAmier/XHS-Downloader, GNU GPL v3.0). It reproduces the same
 * rules so a share text / xiaohongshu.com URL can be turned into the note
 * metadata plus the media sources the public page currently offers:
 *
 *   XHS.extract_links        -> extractXhsLinks  : pull xiaohongshu/rednote URLs
 *                                                  out of share text, resolving
 *                                                  xhslink.com short links first.
 *   Converter.run            -> parseInitialState: find the `window.__INITIAL_STATE__`
 *                                                  script and decode it, then pick the
 *                                                  note object (phone or PC shape).
 *   Explore.run              -> exploreRun       : note fields (标题/描述/作者/时间/
 *                                                  互动数/标签/作品类型).
 *   Image.get_image_link     -> getImagePlan     : build image URLs from the image
 *                                                  token, in the requested format.
 *   Video.deal_video_link    -> getVideoPlan     : originVideoKey first, otherwise the
 *                                                  best `video.media.stream.*` entry.
 *
 * Faithfulness notes (deliberate, documented deviations):
 *   - Python loads `__INITIAL_STATE__` through PyYAML after blank-replacing
 *     `undefined`. This port parses it with a tolerant JS-object reader, so
 *     `undefined` inside strings is no longer corrupted.
 *   - `note.noteDetailMap` may hold several notes; the original always takes the
 *     last entry. This port prefers the entry keyed by the requested note id and
 *     falls back to the last one, so a recommended note can never shadow the target.
 *   - Timestamps: the original used the machine's local timezone. This port defaults
 *     to UTC+8 (Asia/Shanghai, the platform's home timezone) and accepts `tz_offset`
 *     in minutes, so output matches the desktop tool for its usual audience.
 *   - `Image.__get_live_link` crashed on a stream entry with neither `backupUrls`
 *     nor `masterUrl`; this port treats it as "no live photo".
 *   - A `proxy` parameter is accepted for API compatibility but ignored: the Workers
 *     runtime has no per-request proxy option and egress is Cloudflare's.
 *
 * Privacy: signed media URLs are only returned to the caller and are never logged.
 *
 * Endpoints
 *   GET  /                        built-in web UI (same as /app, /index.html)
 *   GET  /help                    JSON API help
 *   GET  /api/sample              a fresh, currently valid explore link from the feed
 *   GET  /api/parse?url=…         parse a xiaohongshu / rednote / xhslink URL
 *   GET  /api/parse?text=…        parse share text (same pipeline)
 *   POST /api/parse               {"text": "…"} or {"url": "…"} + options
 *   GET  /api/thumb?url=…         image proxy for page previews
 *   GET  /api/probe?url=…         remote size + real file type probe (Range bytes=0-31)
 *   GET  /dl?url=…                302 redirect to a validated media URL
 *   GET  /api/selftest            deterministic pipeline unit checks (no network)
 */

// ---------------------------------------------------------------------------
// Constants ported from source/module/static.py and source/application/app.py
// ---------------------------------------------------------------------------

const XHS_ORIGIN = 'https://www.xiaohongshu.com';
const REDNOTE_ORIGIN = 'https://www.rednote.com';

// Image.get_image_link() link templates.
const SNS_IMG_BASE = 'https://sns-img-bd.xhscdn.com';
const CI_IMG_BASE = 'https://ci.xiaohongshu.com';
// Video.generate_video_link() link template.
const SNS_VIDEO_BASE = 'https://sns-video-bd.xhscdn.com';

// XHS class regexes (app.py). Case-insensitivity is a deliberate relaxation of
// the Python originals: it can only match more inputs, never fewer.
const RE_SHARE_XHS = /(?:https?:\/\/)?www\.xiaohongshu\.com\/discovery\/item\/\S+/i;
const RE_SHARE_RN = /(?:https?:\/\/)?www\.rednote\.com\/discovery\/item\/\S+/i;
const RE_LINK_XHS = /(?:https?:\/\/)?www\.xiaohongshu\.com\/explore\/\S+/i;
const RE_LINK_RN = /(?:https?:\/\/)?www\.rednote\.com\/explore\/\S+/i;
const RE_USER_XHS = /(?:https?:\/\/)?www\.xiaohongshu\.com\/user\/profile\/[a-z0-9]+\/\S+/i;
const RE_USER_RN = /(?:https?:\/\/)?www\.rednote\.com\/user\/profile\/[a-z0-9]+\/\S+/i;
const RE_SHORT = /(?:https?:\/\/)?xhslink\.(?:com|cn)\/[^\s"<>\\^`{|}，。；！？、【】《》]+/i;
const RE_ID = /(?:explore|item)\/(\S+)?\?/;
const RE_ID_USER = /user\/profile\/[a-z0-9]+\/(\S+)?\?/;

const DEFAULT_NAME_FORMAT = '发布时间 作者昵称 作品标题';
const NAME_KEYS = [
  '收藏数量', '评论数量', '分享数量', '点赞数量', '作品标签', '作品ID',
  '作品标题', '作品描述', '作品类型', '发布时间', '最后更新时间',
  '作者昵称', '作者ID',
];
const NAME_SEPARATOR = '_';

// Manager.NAME: characters kept when filtering an author nickname.
const AUTHOR_NAME_RE = /[^\u4e00-\u9fffa-zA-Z0-9\-_！？，。；：“”（）《》]/g;

const IMAGE_FORMATS = new Set(['auto', 'png', 'webp', 'jpeg', 'heic', 'avif']);
const VIDEO_PREFERENCES = new Set(['resolution', 'bitrate', 'size']);

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;   // page HTML cap
const MAX_INPUT_CHARS = 16384;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRY = 2;

// curl_cffi impersonates chrome146 in static.py; a current desktop Chrome UA is
// the closest fetch() equivalent.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// static.py HEADERS
const HEADERS = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
    'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'user-agent': DESKTOP_UA,
};

// static.py FILE_SIGNATURES (offset, hex, suffix) — used by /api/probe to report
// the real container of a media file instead of trusting Content-Type.
const FILE_SIGNATURES = [
  [0, 'ffd8ff', 'jpeg'],
  [0, '89504e470d0a1a0a', 'png'],
  [4, '6674797061766966', 'avif'],
  [4, '6674797068656963', 'heic'],
  [8, '57454250', 'webp'],
  [4, '667479704d534e56', 'mp4'],
  [4, '6674797069736f6d', 'mp4'],
  [4, '667479706d703432', 'm4v'],
  [4, '6674797071742020', 'mov'],
  [0, '1a45dfa3', 'mkv'],
  [0, '000001b3', 'mpg'],
  [0, '000001ba', 'mpg'],
  [0, '464c5601', 'flv'],
  [8, '41564920', 'avi'],
  [0, '474946383761', 'gif'],
  [0, '474946383961', 'gif'],
];
const SIGNATURE_PROBE_BYTES = 32;

// Suffixes that count as an image for /api/thumb, with the MIME to report when
// the upstream served a generic content type.
const IMAGE_SUFFIXES = new Set(['png', 'jpeg', 'webp', 'avif', 'heic', 'gif']);
const IMAGE_MIME_BY_SUFFIX = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  gif: 'image/gif',
};

// Only these hosts may be reached through /dl, /api/probe and /api/thumb.
const MEDIA_HOST_SUFFIXES = ['xhscdn.com', 'xiaohongshu.com', 'rednote.com'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Python `Namespace.safe_extract`: dotted chain with `[n]` list indices. */
function safeExtract(root, chain, def = '') {
  if (root === null || root === undefined) return def;
  let cur = root;
  for (const raw of String(chain).split('.')) {
    if (raw === '') continue;
    let attr = raw;
    let index = null;
    const bracket = raw.indexOf('[');
    if (bracket >= 0 && raw.endsWith(']')) {
      attr = raw.slice(0, bracket);
      const parsed = Number.parseInt(raw.slice(bracket + 1, -1), 10);
      if (!Number.isFinite(parsed)) return def;
      index = parsed;
    }
    if (attr) {
      if (cur === null || typeof cur !== 'object') return def;
      cur = cur[attr];
      // Mirrors the Python `if not data: return default` short circuit.
      if (!cur) return def;
    }
    if (index !== null) {
      if (cur === null || typeof cur !== 'object') return def;
      cur = cur[index];
      if (cur === undefined || cur === null) return def;
    }
  }
  return cur || def;
}

const objectExtract = safeExtract;

/** Python `Converter.safe_get`: index a dict by value order, or a list by index. */
function safeIndexGet(container, index) {
  if (Array.isArray(container)) return container.at(index);
  if (container !== null && typeof container === 'object') {
    const values = Object.values(container);
    return index < 0 ? values[values.length + index] : values[index];
  }
  throw new TypeError('safe_get: unsupported container type');
}

/** Python `Converter.deep_get`: plain keys, `[-1]` means "last value of the map". */
function deepGet(data, keys, def = undefined) {
  if (!data) return def;
  let cur = data;
  try {
    for (const key of keys) {
      if (key.startsWith('[') && key.endsWith(']')) {
        cur = safeIndexGet(cur, Number.parseInt(key.slice(1, -1), 10));
      } else {
        if (cur === null || typeof cur !== 'object') return def;
        cur = cur[key];
      }
      if (cur === undefined || cur === null) return def;
    }
    return cur;
  } catch (_) {
    return def;
  }
}

/**
 * Html.format_url: Python decodes `\uXXXX` escapes that xiaohongshu leaves in
 * some URLs. Only those escapes are rewritten (the Python `unicode_escape` pass
 * also mangles non-ASCII, which is never desirable here).
 */
function decodeUnicodeEscapes(value) {
  if (typeof value !== 'string' || value.indexOf('\\u') < 0) return value;
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)));
}

function formatTimestamp(ms, tzOffsetMinutes) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '未知';
  const shifted = new Date(value + tzOffsetMinutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    shifted.getUTCFullYear() + '-' + p(shifted.getUTCMonth() + 1) + '-' +
    p(shifted.getUTCDate()) + '_' + p(shifted.getUTCHours()) + ':' +
    p(shifted.getUTCMinutes()) + ':' + p(shifted.getUTCSeconds())
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return bytes + 'B';
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + 'KB';
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + 'MB';
  return (mb / 1024).toFixed(2) + 'GB';
}

function normalizeUrl(raw) {
  const value = String(raw == null ? '' : raw).trim();
  return /^https?:\/\//i.test(value) ? value : 'https://' + value;
}

/** tools.get_site_referer */
function siteReferer(url) {
  return String(url || '').toLowerCase().includes('rednote')
    ? REDNOTE_ORIGIN + '/'
    : XHS_ORIGIN + '/';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Tolerant JSON / JS-object reader
//
// `window.__INITIAL_STATE__` is a JS object literal: bare keys, single quotes,
// `undefined`, stray and trailing commas. The Python project rewrites it into
// YAML and lets PyYAML absorb all of that. Workers cannot use eval/new Function,
// so this small reader does the same job — and unlike the YAML detour it never
// rewrites text inside string values.
// ---------------------------------------------------------------------------

function parseJsonLike(text) {
  const s = String(text);
  const n = s.length;
  let i = 0;

  const fail = (msg) => {
    throw new SyntaxError('JSON-like parse error: ' + msg + ' @' + i);
  };

  function skipWs() {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) i++;
      else break;
    }
  }

  function parseString(quote) {
    i++;
    let out = '';
    while (i < n) {
      const ch = s[i];
      if (ch === '\\') {
        i++;
        const esc = s[i];
        if (esc === undefined) fail('unterminated escape');
        switch (esc) {
          case 'n': out += '\n'; i++; break;
          case 't': out += '\t'; i++; break;
          case 'r': out += '\r'; i++; break;
          case 'b': out += '\b'; i++; break;
          case 'f': out += '\f'; i++; break;
          case 'v': out += '\v'; i++; break;
          case '0': out += '\0'; i++; break;
          case 'u': {
            const hex = s.slice(i + 1, i + 5);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              out += String.fromCharCode(Number.parseInt(hex, 16));
              i += 5;
            } else {
              out += 'u';
              i++;
            }
            break;
          }
          case 'x': {
            const hex = s.slice(i + 1, i + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              out += String.fromCharCode(Number.parseInt(hex, 16));
              i += 3;
            } else {
              out += 'x';
              i++;
            }
            break;
          }
          default: out += esc; i++; break;
        }
        continue;
      }
      if (ch === quote) {
        i++;
        return out;
      }
      out += ch;
      i++;
    }
    fail('unterminated string');
    return out;
  }

  function parseBareKey() {
    const start = i;
    while (i < n) {
      const ch = s[i];
      if (ch === ':' || ch === ',' || ch === '}' || ch === '{' || ch === '[' ||
          ch === ']' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
      i++;
    }
    return s.slice(start, i).trim();
  }

  function parseNumber() {
    const start = i;
    if (s[i] === '+' || s[i] === '-') i++;
    while (i < n && /[0-9eE+\-.]/.test(s[i])) i++;
    const parsed = Number(s.slice(start, i));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseIdentifier() {
    const start = i;
    while (i < n && /[A-Za-z0-9_$]/.test(s[i])) i++;
    const id = s.slice(start, i);
    if (id === 'true') return true;
    if (id === 'false') return false;
    // null / undefined / NaN / Infinity / any other JS identifier -> null,
    // matching what the YAML detour produced for `undefined`.
    return null;
  }

  function parseValue() {
    skipWs();
    if (i >= n) fail('unexpected end of input');
    const ch = s[i];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"' || ch === "'") return parseString(ch);
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) return parseNumber();
    if (/[A-Za-z_$]/.test(ch)) return parseIdentifier();
    fail('unexpected character ' + JSON.stringify(ch));
    return null;
  }

  function parseObject() {
    i++;
    const out = {};
    for (;;) {
      skipWs();
      if (i >= n) fail('unterminated object');
      if (s[i] === '}') { i++; return out; }
      if (s[i] === ',') { i++; continue; }   // stray / trailing comma
      const key = (s[i] === '"' || s[i] === "'") ? parseString(s[i]) : parseBareKey();
      skipWs();
      if (s[i] === ':') {
        i++;
        out[key] = parseValue();
      } else if (s[i] === ',' || s[i] === '}' || i >= n) {
        out[key] = null;                     // `{a, b}` shorthand
      } else {
        fail('expected ":" after key ' + JSON.stringify(key));
      }
      skipWs();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return out; }
      if (i >= n) fail('unterminated object');
      fail('expected "," or "}"');
    }
  }

  function parseArray() {
    i++;
    const out = [];
    for (;;) {
      skipWs();
      if (i >= n) fail('unterminated array');
      if (s[i] === ']') { i++; return out; }
      if (s[i] === ',') { i++; continue; }   // stray / trailing comma
      out.push(parseValue());
      skipWs();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return out; }
      if (i >= n) fail('unterminated array');
      fail('expected "," or "]"');
    }
  }

  return parseValue();
}

// ---------------------------------------------------------------------------
// Converter.run — HTML -> note object
// ---------------------------------------------------------------------------

const PHONE_KEYS_LINK = ['noteData', 'data', 'noteData'];
const PC_KEYS_LINK = ['note', 'noteDetailMap', '[-1]', 'note'];

/** All `<script>` bodies, in document order (the lxml `//script/text()` result). */
function extractScriptTexts(html) {
  const scripts = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) scripts.push(match[1]);
  return scripts;
}

/** `Converter.get_script`: the last script that starts with the state marker. */
function pickInitialStateScript(html) {
  const scripts = extractScriptTexts(html);
  for (let i = scripts.length - 1; i >= 0; i--) {
    const text = scripts[i].trim();
    if (text.startsWith('window.__INITIAL_STATE__')) return text;
  }
  return '';
}

/** `Converter._convert_object` + `_extract_object` for one HTML document. */
function parseInitialState(html) {
  const script = pickInitialStateScript(html);
  if (!script) return null;
  let body = script.replace(/^window\.__INITIAL_STATE__\s*=\s*/, '');
  body = body.replace(/;+\s*$/, '');
  // Python: .replace("new Map([])", "[]") — regex form also covers `new Map()`.
  body = body.replace(/new Map\(\s*\[\s*\]\s*\)/g, '[]').replace(/new Map\(\s*\)/g, '[]');
  try {
    return JSON.parse(body);
  } catch (_) {
    return parseJsonLike(body);
  }
}

/**
 * `Converter._filter_object`: phone shape, then PC shape.
 * Improvement over the original: when the requested note id is present in
 * `noteDetailMap`, that exact entry wins instead of blindly taking the last one.
 */
function filterNoteObject(state, preferredNoteId) {
  const phone = deepGet(state, PHONE_KEYS_LINK);
  if (phone && isObj(phone) && Object.keys(phone).length) return phone;
  if (preferredNoteId && state && isObj(state.note) && isObj(state.note.noteDetailMap)) {
    const hit = state.note.noteDetailMap[preferredNoteId];
    if (hit && isObj(hit.note)) return hit.note;
  }
  const pc = deepGet(state, PC_KEYS_LINK);
  return pc && isObj(pc) ? pc : null;
}

// ---------------------------------------------------------------------------
// Explore.run — note object -> the Chinese-keyed data dict
// ---------------------------------------------------------------------------

function classifyWorks(data) {
  const type = safeExtract(data, 'type');
  const list = safeExtract(data, 'imageList', []);
  const items = Array.isArray(list) ? list : [];
  if ((type !== 'video' && type !== 'normal') || items.length === 0) return '未知';
  if (type === 'video') return items.length === 1 ? '视频' : '图集';
  return '图文';
}

function exploreRun(data, tzOffsetMinutes = 480) {
  if (!data || !isObj(data) || Object.keys(data).length === 0) return {};
  const result = {};

  // __extract_interact_info
  result['收藏数量'] = safeExtract(data, 'interactInfo.collectedCount', '-1');
  result['评论数量'] = safeExtract(data, 'interactInfo.commentCount', '-1');
  result['分享数量'] = safeExtract(data, 'interactInfo.shareCount', '-1');
  result['点赞数量'] = safeExtract(data, 'interactInfo.likedCount', '-1');

  // __extract_tags
  const tags = safeExtract(data, 'tagList', []);
  result['作品标签'] = (Array.isArray(tags) ? tags : [])
    .map((tag) => objectExtract(tag, 'name'))
    .join(' ');

  // __extract_info
  result['作品ID'] = safeExtract(data, 'noteId');
  result['作品链接'] = XHS_ORIGIN + '/explore/' + result['作品ID'];
  result['作品标题'] = safeExtract(data, 'title');
  result['作品描述'] = safeExtract(data, 'desc');
  result['作品类型'] = classifyWorks(data);

  // __extract_time
  const time = safeExtract(data, 'time');
  const lastUpdate = safeExtract(data, 'lastUpdateTime');
  result['发布时间'] = time ? formatTimestamp(time, tzOffsetMinutes) : '未知';
  result['最后更新时间'] = lastUpdate ? formatTimestamp(lastUpdate, tzOffsetMinutes) : '未知';
  result['时间戳'] = time ? time / 1000 : null;

  // __extract_user
  result['作者昵称'] =
    safeExtract(data, 'user.nickname') || safeExtract(data, 'user.nickName');
  result['作者ID'] = safeExtract(data, 'user.userId');
  result['作者链接'] = XHS_ORIGIN + '/user/profile/' + result['作者ID'];

  return result;
}

// ---------------------------------------------------------------------------
// Image.get_image_link
// ---------------------------------------------------------------------------

/** `Image.__extract_image_token`: keep path segments from the 6th on, drop `!…`. */
function extractImageToken(url) {
  if (typeof url !== 'string' || url === '') return '';
  return url.split('/').slice(5).join('/').split('!')[0];
}

const generateAutoImageLink = (token) => SNS_IMG_BASE + '/' + token;
const generateFixedImageLink = (token, format) =>
  CI_IMG_BASE + '/' + token + '?imageView2/format/' + format;

/** `Image.__get_live_link`: per-image livePhoto URL (backupUrls[0] or masterUrl). */
function getLiveLinks(items) {
  const result = [];
  for (const item of items) {
    let url = null;
    const stream = objectExtract(item, 'stream', {});
    const keys = isObj(stream) ? Object.keys(stream) : [];
    for (const key of keys) {
      const candidate =
        objectExtract(stream, key + '[0].backupUrls[0]') ||
        objectExtract(stream, key + '[0].masterUrl');
      const formatted = candidate ? decodeUnicodeEscapes(candidate) : '';
      if (formatted) {
        url = formatted;
        break;
      }
      url = null;
    }
    result.push(url);
  }
  return result;
}

function getImagePlan(data, imageFormat) {
  const list = safeExtract(data, 'imageList', []);
  const items = Array.isArray(list) ? list : [];
  const liveLinks = getLiveLinks(items);
  let tokens = items.map((item) => extractImageToken(objectExtract(item, 'urlDefault')));
  if (!tokens.some(Boolean)) {
    tokens = items.map((item) => extractImageToken(objectExtract(item, 'url')));
  }
  const urls = tokens.map((token) =>
    decodeUnicodeEscapes(
      imageFormat === 'auto'
        ? generateAutoImageLink(token)
        : generateFixedImageLink(token, imageFormat),
    ));
  return { urls, liveLinks, tokens };
}

// ---------------------------------------------------------------------------
// Video.deal_video_link
// ---------------------------------------------------------------------------

const VIDEO_LINK_KEYS = 'video.consumer.originVideoKey';

function numOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const videoHeight = (item) => numOr(item.height, -Infinity);
const videoBitrate = (item) =>
  numOr(item.videoBitrate !== undefined ? item.videoBitrate : item.video_bitrate, -Infinity);
const videoSize = (item) =>
  numOr(item.size !== undefined ? item.size : item.fileSize, -Infinity);

/** `Video.generate_video_link`: the original master file, when the page exposes it. */
function generateVideoLink(data) {
  const key = safeExtract(data, VIDEO_LINK_KEYS);
  return key ? [decodeUnicodeEscapes(SNS_VIDEO_BASE + '/' + key)] : [];
}

/** `Video.get_video_items`: flatten every `video.media.stream.<codec>[]` entry. */
function getVideoItems(data) {
  const stream = safeExtract(data, 'video.media.stream');
  if (!isObj(stream)) return [];
  const items = [];
  for (const key of Object.keys(stream)) {
    const group = safeExtract(data, 'video.media.stream.' + key, []);
    if (Array.isArray(group)) items.push(...group);
  }
  return items;
}

function getVideoPlan(data, preference) {
  const generated = generateVideoLink(data);
  if (generated.length) {
    return { urls: generated, strategy: 'originVideoKey', chosen: null, candidates: [] };
  }
  const items = getVideoItems(data);
  if (!items.length) return { urls: [], strategy: 'none', chosen: null, candidates: [] };
  const keyFn =
    preference === 'bitrate' ? videoBitrate : preference === 'size' ? videoSize : videoHeight;
  const sorted = items.slice().sort((a, b) => keyFn(a) - keyFn(b));
  const best = sorted[sorted.length - 1];
  const backup = best.backupUrls;
  const urls = Array.isArray(backup) && backup.length
    ? [decodeUnicodeEscapes(backup[0])]
    : (best.masterUrl ? [decodeUnicodeEscapes(best.masterUrl)] : []);
  return {
    urls,
    strategy: 'media.stream',
    preference,
    chosen: {
      codec: best.videoCodec || best.codec || '',
      width: numOr(best.width, 0),
      height: numOr(best.height, 0),
      videoBitrate: videoBitrate(best) === -Infinity ? null : videoBitrate(best),
      size: videoSize(best) === -Infinity ? null : videoSize(best),
    },
    candidates: sorted.map((item) => ({
      codec: item.videoCodec || item.codec || '',
      width: numOr(item.width, 0),
      height: numOr(item.height, 0),
      videoBitrate: videoBitrate(item) === -Infinity ? null : videoBitrate(item),
      size: videoSize(item) === -Infinity ? null : videoSize(item),
    })),
  };
}

// ---------------------------------------------------------------------------
// Cleaner / Manager name handling and app naming rules
// ---------------------------------------------------------------------------

const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;
const ILLEGAL_NAME_CHARS = ['/', '\\', '|', '<', '>', '"', '?', ':', '*', '\x00'];
// string.whitespace[1:] — the newline-ish characters folded into the rule dict.
const WHITESPACE_ILLEGAL = ['\t', '\n', '\r', '\x0b', '\x0c'];

// Approximation of `emoji.replace_emoji` (the RGI emoji blocks plus the common
// symbol ranges and the joiners).
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{2122}\u{00A9}\u{00AE}\u{2139}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

// Approximation of `is_chinese_char` (unicodedata name containing "CJK"), which
// counts a character as two units when truncating file names.
const WIDE_CHAR_RE =
  /[\u2E80-\u2EFF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;

function removeControlCharacters(text) {
  return String(text == null ? '' : text).replace(CONTROL_CHARS_RE, '');
}

function clearSpaces(text) {
  return String(text).split(/\s+/).filter(Boolean).join(' ');
}

/** Cleaner.filter_name */
function cleanerFilterName(text, replace = '', def = '') {
  let value = String(text == null ? '' : text).replace(/:/g, '.');
  value = removeControlCharacters(value);
  for (const ch of ILLEGAL_NAME_CHARS) value = value.split(ch).join('');
  for (const ch of WHITESPACE_ILLEGAL) value = value.split(ch).join('');
  value = value.replace(EMOJI_RE, replace);
  value = clearSpaces(value);
  value = value.trim().replace(/^\.+/, '').replace(/\.+$/, '');
  value = value.replace(/^_+/, '').replace(/_+$/, '');
  return value || def;
}

/** Manager.filter_name (author nickname → folder-safe token) */
function managerFilterName(name) {
  const value = String(name == null ? '' : name).replace(AUTHOR_NAME_RE, '_');
  return value.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function isWideChar(ch) {
  return WIDE_CHAR_RE.test(ch);
}

function truncateString(value, length = 64) {
  let count = 0;
  let result = '';
  for (const ch of String(value)) {
    count += isWideChar(ch) ? 2 : 1;
    if (count > length) break;
    result += ch;
  }
  return result;
}

/** truncate.beautify_string */
function beautifyString(value, length = 64) {
  const str = String(value == null ? '' : value);
  let count = 0;
  let fits = true;
  for (const ch of str) {
    count += isWideChar(ch) ? 2 : 1;
    if (count > length) {
      fits = false;
      break;
    }
  }
  if (fits) return str;
  const half = Math.floor(length / 2);
  const start = truncateString(str, half);
  const reversed = [...str].reverse().join('');
  const end = [...truncateString(reversed, half)].reverse().join('');
  return start + '...' + end;
}

function normalizeNameFormat(value) {
  const format = typeof value === 'string' && value.trim() ? value : DEFAULT_NAME_FORMAT;
  const keys = format.split(/\s+/).filter(Boolean);
  if (keys.some((key) => !NAME_KEYS.includes(key))) return DEFAULT_NAME_FORMAT;
  return format;
}

const normalizeImageFormat = (value) => {
  const format = String(value == null ? '' : value).toLowerCase();
  return IMAGE_FORMATS.has(format) ? format : 'jpeg';
};

const normalizeVideoPreference = (value) => {
  const pref = String(value == null ? '' : value).toLowerCase();
  return VIDEO_PREFERENCES.has(pref) ? pref : 'resolution';
};

/** XHS.__naming_rules + update_author_nickname's defaulting behaviour. */
function buildFileName(data, nameFormat) {
  const keys = String(nameFormat).split(/\s+/).filter(Boolean);
  const values = keys.map((key) => {
    if (key === '发布时间') return String(data['发布时间'] || '').replace(/:/g, '.');
    if (key === '作品标题') {
      return beautifyString(cleanerFilterName(data['作品标题'] || ''), 64) || data['作品ID'];
    }
    return data[key];
  });
  const fallback = [data['作者ID'], data['作品ID']].join(NAME_SEPARATOR);
  return beautifyString(
    cleanerFilterName(values.join(NAME_SEPARATOR), '', fallback),
    128,
  );
}

// ---------------------------------------------------------------------------
// Link extraction and HTTP
// ---------------------------------------------------------------------------

class ParseError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Risk control (风控)
//
// xiaohongshu answers datacenter IPs — Cloudflare Worker egress included — with a
// verification hop instead of the note page. The good news: the short-link
// redirect still carries the real target inside `redirectPath`, so the note URL
// can be recovered from it. When the platform keeps demanding verification, a
// specific `risk_control` error is returned instead of a confusing "no link".
// ---------------------------------------------------------------------------

const RISK_CONTROL_PATTERNS = [
  '/website-login/captcha',
  '/website-login',
  'verifyuuid=',
  'verifytype=',
];

const RISK_CONTROL_HINT =
  '请求被小红书风控拦截（要求安全验证）。Cloudflare Worker 的出口是数据中心 IP，比家用宽带更容易被拦截。' +
  '请在下方 Cookie 输入框粘贴小红书网页版 Cookie 后重试，或改用带 Cookie 的服务端环境请求。';

function isRiskControlUrl(raw) {
  const value = String(raw || '').toLowerCase();
  if (!value) return false;
  return RISK_CONTROL_PATTERNS.some((pattern) => value.includes(pattern));
}

function looksLikeRiskControlHtml(html) {
  const value = String(html || '');
  if (!value) return false;
  return value.includes('/website-login/captcha') ||
    value.includes('verifyUuid') ||
    value.includes('请完成安全验证');
}

/** The note-URL regexes, applied to one candidate string. */
function matchNoteUrl(candidate) {
  const value = String(candidate || '');
  if (!value) return null;
  return RE_SHARE_XHS.exec(value) || RE_SHARE_RN.exec(value) ||
    RE_LINK_XHS.exec(value) || RE_LINK_RN.exec(value) ||
    RE_USER_XHS.exec(value) || RE_USER_RN.exec(value) ||
    null;
}

/** Pull the real note URL out of a `website-login/captcha?redirectPath=…` hop. */
function recoverNoteUrlFromRedirect(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch (_) {
    return '';
  }
  for (const key of ['redirectPath', 'redirect_url', 'redirectUrl', 'redirect', 'url']) {
    let value = parsed.searchParams.get(key);
    if (!value) continue;
    // The target is sometimes double-encoded (`%253D` for `%3D`).
    for (let round = 0; round < 3; round++) {
      const match = matchNoteUrl(value);
      if (match) return match[0];
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch (_) {
        break;
      }
      if (decoded === value) break;
      value = decoded;
    }
  }
  return '';
}

/** Note pages are served over https; skip the extra http -> https hop. */
function preferHttpsForSite(rawUrl) {
  const value = String(rawUrl || '');
  if (!/^http:\/\/(www\.)?(xiaohongshu|rednote)\.com\//i.test(value)) return value;
  return value.replace(/^http:\/\//i, 'https://');
}

function extractLinkId(rawUrl) {
  try {
    const parsed = new URL(normalizeUrl(rawUrl));
    return parsed.pathname.replace(/\/+$/, '').split('/').pop() || '';
  } catch (_) {
    return '';
  }
}

function extractIds(links) {
  const ids = [];
  for (const link of links) {
    const byShare = RE_ID.exec(link);
    if (byShare) {
      ids.push(byShare[1]);
      continue;
    }
    const byUser = RE_ID_USER.exec(link);
    if (byUser) ids.push(byUser[1]);
  }
  return ids;
}

function cookieStrToDict(cookieString) {
  const out = {};
  for (const part of String(cookieString || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Html.request_url with the tools.retry wrapper: retries on failure and returns
 * the final URL when `content` is false (used to resolve xhslink short links).
 */
async function requestUrl(rawUrl, options = {}) {
  const target = normalizeUrl(rawUrl);
  const headers = { ...HEADERS, referer: siteReferer(target) };
  if (options.cookie) headers.cookie = options.cookie;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let lastError = null;
  const attempts = (options.maxRetry === undefined ? DEFAULT_MAX_RETRY : options.maxRetry) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, {
        method: 'GET',
        redirect: 'follow',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = new Error('HTTP ' + response.status + ' ' + response.statusText);
        continue;
      }
      if (options.content === false) return { url: response.url, text: '' };
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new ParseError('response_too_large', '页面响应超过安全上限（8 MiB）');
      }
      return { url: response.url, text };
    } catch (error) {
      if (error instanceof ParseError) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < attempts) await sleep(300 * (attempt + 1));
  }
  throw new ParseError(
    'request_failed',
    '网络异常，请求失败：' + (lastError && lastError.message ? lastError.message : '未知错误'),
  );
}

/** XHS.extract_links — resolve short links, then pick out supported note URLs. */
async function extractXhsLinks(input, steps, options = {}) {
  const urls = [];
  for (const token of String(input).split(/\s+/)) {
    if (!token) continue;
    let current = token;
    const short = RE_SHORT.exec(current);
    if (short) {
      steps.push('解析短链接：' + short[0]);
      const resolved = await requestUrl(short[0], { ...options, content: false });
      current = resolved.url || '';
      steps.push('短链接跳转至：' + current);
    }
    let match = matchNoteUrl(current);
    if (!match && isRiskControlUrl(current)) {
      // A verification hop: the real target rides along inside `redirectPath`.
      const recovered = recoverNoteUrlFromRedirect(current);
      if (recovered) {
        steps.push('跳转被风控拦截（要求安全验证），已从 redirectPath 还原作品链接：' + recovered);
        current = recovered;
        match = matchNoteUrl(current);
      } else {
        steps.push('跳转被风控拦截（要求安全验证），redirectPath 中未找到作品链接');
      }
    }
    // Also covers a pasted verification URL that wraps the note link.
    if (!match) match = matchNoteUrl(recoverNoteUrlFromRedirect(token));
    if (match) urls.push(match[0]);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Media URL validation + probing
// ---------------------------------------------------------------------------

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '[::]' || h === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  return false;
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  return MEDIA_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

function validateMediaUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch (_) {
    throw new ParseError('bad_media_url', '地址不是合法 URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ParseError('bad_media_url', '仅支持 http/https 地址');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new ParseError('bad_media_url', '拒绝访问内网地址');
  }
  if (!hostAllowed(parsed.hostname)) {
    throw new ParseError('bad_media_url', '仅允许小红书媒体域名：' + parsed.hostname);
  }
  return parsed;
}

function detectFileType(bytes) {
  for (const [offset, hex, suffix] of FILE_SIGNATURES) {
    const signature = hex.match(/../g).map((pair) => Number.parseInt(pair, 16));
    if (signature.length + offset > bytes.length) continue;
    let same = true;
    for (let i = 0; i < signature.length; i++) {
      if (bytes[offset + i] !== signature[i]) {
        same = false;
        break;
      }
    }
    if (same) return suffix;
  }
  return '';
}

/**
 * Remote size + real container probe. Reads the first 32 bytes with a Range
 * request so the file signature can confirm the actual type (static.py
 * FILE_SIGNATURES), instead of trusting Content-Type.
 */
async function probeMedia(rawUrl) {
  const parsed = validateMediaUrl(rawUrl);
  const response = await fetch(parsed.toString(), {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': DESKTOP_UA,
      referer: XHS_ORIGIN + '/',
      accept: '*/*',
      range: 'bytes=0-' + (SIGNATURE_PROBE_BYTES - 1),
      'accept-encoding': 'identity',
    },
  });
  const status = response.status;
  let total = -1;
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    const slash = contentRange.lastIndexOf('/');
    const value = slash >= 0 ? contentRange.slice(slash + 1).trim() : '';
    if (value && value !== '*') {
      const parsedTotal = Number(value);
      if (Number.isFinite(parsedTotal) && parsedTotal > 0) total = parsedTotal;
    }
  } else if (status === 200) {
    const len = Number(response.headers.get('content-length') || '-1');
    if (Number.isFinite(len) && len > 0) total = len;
  }
  let detected = '';
  let sample = -1;
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer.slice(0, SIGNATURE_PROBE_BYTES));
  sample = bytes.length;
  if (bytes.length) detected = detectFileType(bytes);
  return {
    ok: true,
    status,
    bytes: total,
    human: formatBytes(total),
    contentType: response.headers.get('content-type') || '',
    detected,
    sampled: sample,
  };
}

// ---------------------------------------------------------------------------
// The parse pipeline
// ---------------------------------------------------------------------------

async function runParse(input, options = {}) {
  const started = Date.now();
  const steps = [];
  const imageFormat = normalizeImageFormat(options.imageFormat ?? options.image_format);
  const videoPreference =
    normalizeVideoPreference(options.videoPreference ?? options.video_preference);
  const nameFormat = normalizeNameFormat(options.nameFormat ?? options.name_format);
  const tzOffsetRaw = options.tzOffset ?? options.tz_offset;
  const tzOffset = Number.isFinite(Number(tzOffsetRaw)) && tzOffsetRaw !== null &&
    tzOffsetRaw !== undefined && tzOffsetRaw !== ''
    ? Number(tzOffsetRaw)
    : 480;
  const cookie = typeof options.cookie === 'string' ? options.cookie.trim() : '';
  const text = String(input == null ? '' : input).slice(0, MAX_INPUT_CHARS);
  if (!text.trim()) {
    throw new ParseError('bad_input', '输入为空');
  }
  steps.push('输入长度：' + text.length + ' 字符');
  if (cookie) steps.push('已使用调用方提供的 Cookie');

  const links = await extractXhsLinks(text, steps, { cookie });
  if (!links.length) {
    const blocked = steps.some((step) => step.includes('风控'));
    throw new ParseError(
      blocked ? 'risk_control' : 'no_xhs_link',
      blocked ? RISK_CONTROL_HINT : '未在输入中找到小红书作品链接',
      { steps },
    );
  }
  const target = preferHttpsForSite(normalizeUrl(links[0]));
  const noteId = extractLinkId(target);
  steps.push('作品链接：' + target);
  steps.push('作品 ID：' + noteId);

  const page = await requestUrl(target, { cookie });
  steps.push('页面大小：' + page.text.length + ' 字符');
  if (isRiskControlUrl(page.url) || looksLikeRiskControlHtml(page.text)) {
    steps.push('作品页返回安全验证页：' + page.url);
    throw new ParseError('risk_control', RISK_CONTROL_HINT, { steps });
  }
  const state = parseInitialState(page.text);
  if (!state) {
    throw new ParseError(
      'no_initial_state',
      '页面中未找到 window.__INITIAL_STATE__（可能被风控拦截或页面结构已变化）',
      { steps },
    );
  }
  steps.push('已解析 window.__INITIAL_STATE__');

  const noteObject = filterNoteObject(state, noteId);
  if (!noteObject || !Object.keys(noteObject).length) {
    throw new ParseError(
      'no_note_data',
      '页面未返回作品数据：链接可能已过期（xsec_token 失效）或被风控，可尝试传入 Cookie',
      { steps },
    );
  }
  steps.push('已定位作品数据对象（字段 ' + Object.keys(noteObject).length + ' 个）');

  const data = exploreRun(noteObject, tzOffset);
  if (!data['作品ID']) {
    throw new ParseError('no_note_id', '作品数据缺少 noteId', { steps });
  }
  steps.push('作品类型：' + data['作品类型']);

  const media = {
    type: data['作品类型'],
    imageFormat,
    videoPreference,
    tzOffset,
  };

  if (data['作品类型'] === '视频') {
    const plan = getVideoPlan(noteObject, videoPreference);
    data['下载地址'] = plan.urls;
    data['动图地址'] = [null];
    media.kind = 'video';
    media.strategy = plan.strategy;
    media.video = plan.chosen;
    media.videoCandidates = plan.candidates;
    steps.push('视频地址策略：' + plan.strategy + '，候选 ' + plan.candidates.length + ' 个');
  } else if (data['作品类型'] === '图文' || data['作品类型'] === '图集') {
    const plan = getImagePlan(noteObject, imageFormat);
    data['下载地址'] = plan.urls;
    data['动图地址'] = plan.liveLinks;
    media.kind = 'image';
    media.imageCount = plan.urls.length;
    media.liveCount = plan.liveLinks.filter(Boolean).length;
    steps.push(
      '图片地址 ' + plan.urls.length + ' 个（格式 ' + imageFormat + '），动图 ' +
      media.liveCount + ' 个',
    );
  } else {
    data['下载地址'] = [];
    data['动图地址'] = [];
    media.kind = 'unknown';
    steps.push('未知的作品类型，未生成下载地址');
  }

  data['文件名'] = buildFileName(data, nameFormat);
  data['图片来源'] = page.url;

  const mediaUrls = (data['下载地址'] || []).filter(Boolean);
  steps.push('媒体地址 ' + mediaUrls.length + ' 个');

  let verification = null;
  if (options.verify && mediaUrls.length) {
    const limit = Math.min(mediaUrls.length, Number(options.verifyLimit) || 3);
    verification = [];
    for (let i = 0; i < limit; i++) {
      try {
        const probe = await probeMedia(mediaUrls[i]);
        verification.push({ url: mediaUrls[i], ...probe });
      } catch (error) {
        verification.push({
          url: mediaUrls[i],
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      }
    }
    steps.push('已探测 ' + verification.length + ' 个媒体地址');
    const reachable = verification.filter((item) => item.ok && item.status >= 200 && item.status < 300);
    media.verified = reachable.length;
    media.verification = verification;
  }

  return {
    ok: true,
    steps,
    source: {
      input: text,
      url: target,
      finalUrl: page.url,
      noteId,
      htmlChars: page.text.length,
      elapsedMs: Date.now() - started,
    },
    data,
    media,
  };
}

// ---------------------------------------------------------------------------
// A fresh sample link, so the UI's "example" button never goes stale
// ---------------------------------------------------------------------------

async function fetchSampleLink(cookie) {
  const steps = [];
  const page = await requestUrl(XHS_ORIGIN + '/explore', { cookie });
  if (isRiskControlUrl(page.url) || looksLikeRiskControlHtml(page.text)) {
    steps.push('首页返回安全验证页：' + page.url);
    throw new ParseError('risk_control', RISK_CONTROL_HINT, { steps });
  }
  const state = parseInitialState(page.text);
  if (!state) throw new ParseError('no_initial_state', '未能在首页找到 __INITIAL_STATE__', { steps });
  let found = null;
  const walk = (node, depth) => {
    if (found || depth > 12 || node === null || typeof node !== 'object') return;
    if (!Array.isArray(node) && typeof node.id === 'string' &&
        /^[0-9a-f]{24}$/.test(node.id) && typeof node.xsecToken === 'string') {
      found = { id: node.id, token: node.xsecToken };
      return;
    }
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };
  walk(state, 0);
  if (!found) throw new ParseError('no_sample', '推荐流中未找到可用的作品链接');
  const url = XHS_ORIGIN + '/explore/' + found.id +
    '?xsec_token=' + encodeURIComponent(found.token) + '&xsec_source=pc_feed';
  steps.push('取自首页推荐流');
  return { ok: true, url, noteId: found.id, steps };
}

// ---------------------------------------------------------------------------
// Built-in web UI (served at "/", /app, /index.html). The page uses the same
// /api/parse endpoint, so the API and the UI can never drift apart. Client JS is
// plain ES5-ish concatenation: no template literals, no backticks.
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小红书作品解析 xhs-parse</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--tx:#e8eaf0;--dim:#9aa3b2;
--acc:#ff2e4d;--ok:#2ec27e;--err:#f0645a;--mono:ui-monospace,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);
font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:20px 16px 80px}
h1{font-size:20px;margin:6px 0 2px}h1 small{color:var(--dim);font-weight:400;font-size:13px}
p.sub{color:var(--dim);margin:0 0 14px}
textarea{width:100%;min-height:92px;resize:vertical;background:#10131a;color:var(--tx);
border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit}
textarea:focus{outline:none;border-color:var(--acc)}
.row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center}
button{appearance:none;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;
font:inherit;background:#252b38;color:var(--tx)}
button.primary{background:var(--acc);font-weight:600}
button:disabled{opacity:.5;cursor:wait}
button.sm{padding:3px 10px;font-size:12px;border-radius:6px}
select{background:#10131a;color:var(--tx);border:1px solid var(--line);border-radius:8px;
padding:8px 10px;font:inherit}
details.cook{margin-top:10px;border:1px solid var(--line);border-radius:10px;
padding:8px 12px;background:#131721}
details.cook summary{cursor:pointer;color:var(--dim);font-size:13px}
.cookrow{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px}
#cookie{width:100%;margin-top:8px;background:#10131a;color:var(--tx);border:1px solid var(--line);
border-radius:8px;padding:8px 10px;font-family:var(--mono);font-size:12px}
#cookie:focus{outline:none;border-color:var(--acc)}
label.opt{color:var(--dim);font-size:13px;display:inline-flex;gap:6px;align-items:center}
a{color:var(--acc);text-decoration:none}.btn{display:inline-block;padding:3px 10px;
border-radius:6px;background:#252b38;font-size:12px;color:var(--tx)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:14px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:14px}
.kv b{color:var(--dim);font-weight:400;white-space:nowrap}
.kv div{word-break:break-word}
.tag{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:0 8px}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:14px}
.photo-cell{position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;
background:#0e1117;cursor:zoom-in}
.photo-cell img{display:block;width:100%;height:190px;object-fit:cover}
.photo-cell figcaption{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);
color:#fff;font-size:12px;padding:2px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.linkrow{display:flex;align-items:center;gap:8px;margin:5px 0}
.linkrow .lbox{flex:1;min-width:0;border:1px solid var(--line);border-radius:8px;
background:#0e1117;overflow-x:auto;overflow-y:hidden;white-space:nowrap;cursor:copy;
font-family:var(--mono);font-size:12px;color:#cfdcff;padding:6px 10px;
scrollbar-width:none;-ms-overflow-style:none}
.linkrow .lbox::-webkit-scrollbar{width:0;height:0;display:none}
.linkrow .lbox:hover{background:#131823}
.linkrow .lact{flex:0 0 auto;display:inline-flex;gap:6px}
video.lplay{display:block;max-width:100%;max-height:320px;margin:8px 0;border-radius:10px;
background:#000;border:1px solid var(--line)}
h3.sec{font-size:15px;margin:16px 0 6px}
.lb{position:fixed;inset:0;background:rgba(0,0,0,.93);display:none;align-items:center;
justify-content:center;z-index:99}
.lb.open{display:flex}
.lb img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:6px;
transform-origin:center center;transition:transform .12s ease}
.lb .cap{position:fixed;bottom:12px;left:0;right:0;text-align:center;color:#cfd6e4;font-size:13px}
.lb .close{position:fixed;top:10px;right:12px;background:none;border:0;color:#fff;
font-size:22px;cursor:pointer;line-height:1;padding:6px}
.lb .nav{position:fixed;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;
font-size:34px;cursor:pointer;line-height:1;padding:8px 14px;opacity:.75}
.lb .nav:hover{opacity:1}.lb .prev{left:6px}.lb .next{right:6px}
.err{border-color:#5b2a26;background:#1c1416}.steps{color:var(--dim);font-size:12px;
white-space:pre-wrap;font-family:var(--mono)}
#status{color:var(--dim);font-size:13px;min-height:20px}
.size{color:var(--ok);font-size:12px;margin-left:6px}.muted{color:var(--dim);font-size:12px}
footer{margin-top:30px;color:#66707f;font-size:12px;line-height:1.8}
</style></head><body><div class="wrap">
<h1>小红书作品解析 <small>xhs-parse · 视频 / 图文 / 图集</small></h1>
<p class="sub">粘贴小红书分享文案或链接（explore / discovery/item / xhslink 短链），解析作品信息与媒体地址。</p>
<textarea id="in" placeholder="示例：复制打开小红书，看看【标题】 https://www.xiaohongshu.com/explore/xxxxxxxxxxxxxxxxxxxxxxxx?xsec_token=..."></textarea>
<div class="row">
<button class="primary" id="run">解析</button>
<button id="sample">取一条最新示例</button>
<button id="clear">清空</button>
<label class="opt">图片格式
<select id="fmt">
<option value="jpeg" selected>JPEG</option>
<option value="png">PNG</option>
<option value="webp">WEBP</option>
<option value="heic">HEIC</option>
<option value="avif">AVIF</option>
<option value="auto">AUTO</option>
</select></label>
<label class="opt">视频偏好
<select id="pref">
<option value="resolution" selected>分辨率优先</option>
<option value="bitrate">码率优先</option>
<option value="size">文件大小优先</option>
</select></label>
<span id="status"></span>
</div>
<details class="cook" id="cookbox">
<summary>可选：小红书网页版 Cookie（部署在 Cloudflare 上被风控要求安全验证时填写）</summary>
<input id="cookie" type="text" autocomplete="off" spellcheck="false"
placeholder="web_session=…; a1=…; webId=…（F12 → 网络 → 任意请求 → 复制 Cookie）">
<div class="cookrow">
<span class="muted" id="cookstate">未填写</span>
<button type="button" class="sm" id="cookclear">清除本机保存</button>
</div>
<p class="muted">Cookie 保存在你浏览器的 localStorage，<b>刷新或重开页面都会自动带上</b>；解析时随请求发给本 Worker，不会被记录或转发到别处。</p>
</details>
<div id="result"></div>
<div id="error" class="card err" style="display:none"></div>
<div id="lb" class="lb" onclick="lbClose()" role="dialog" aria-label="图片放大预览">
<button type="button" class="close" onclick="event.stopPropagation();lbClose()" title="关闭">✕</button>
<button type="button" class="nav prev" onclick="event.stopPropagation();lbStep(-1)" title="上一张">‹</button>
<img id="lbImg" alt="放大查看" onclick="event.stopPropagation()">
<button type="button" class="nav next" onclick="event.stopPropagation();lbStep(1)" title="下一张">›</button>
<div id="lbCap" class="cap"></div>
</div>
<footer>移植自 XHS-Downloader（GNU GPL v3.0）的解析规则：链接提取 → __INITIAL_STATE__ 解析 → 作品信息与媒体地址选择。
<br>隐私：带签名的媒体地址只在你的浏览器与小红书 CDN 之间使用，本服务不记录分享内容。
<br>仅用于解析你有权处理的内容；未配置 Cookie 时视频可能只有较低画质，链接过期会导致解析失败。</footer>
</div>
<script>
var inEl=document.getElementById("in"),runEl=document.getElementById("run"),
fmtEl=document.getElementById("fmt"),prefEl=document.getElementById("pref"),
cookieEl=document.getElementById("cookie"),cookBoxEl=document.getElementById("cookbox"),
cookStateEl=document.getElementById("cookstate"),
statusEl=document.getElementById("status"),resEl=document.getElementById("result"),
errEl=document.getElementById("error");
function getCookie(){return cookieEl.value.trim();}
function loadPref(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function savePref(k,v){try{if(v){localStorage.setItem(k,v);}else{localStorage.removeItem(k);}}catch(e){}}
// The Cookie is kept in this browser (localStorage), so a refresh never loses it.
// It is saved on every keystroke and again right before a parse, because the
// change event alone only fires on blur -- paste-then-refresh used to drop it.
function saveCookiePref(){
var v=getCookie();
savePref("xhs_cookie",v);
cookStateEl.textContent=v?("已保存在本机浏览器（"+v.length+" 字符），刷新后会自动带上"):"未填写";
}
var savedCookie=loadPref("xhs_cookie");
if(savedCookie){cookieEl.value=savedCookie;cookBoxEl.open=true;}
var savedFmt=loadPref("xhs_image_format");if(savedFmt){fmtEl.value=savedFmt;}
var savedPref2=loadPref("xhs_video_preference");if(savedPref2){prefEl.value=savedPref2;}
saveCookiePref();
cookieEl.addEventListener("input",saveCookiePref);
cookBoxEl.addEventListener("toggle",function(){if(cookBoxEl.open){saveCookiePref();}});
fmtEl.addEventListener("change",function(){savePref("xhs_image_format",fmtEl.value);});
prefEl.addEventListener("change",function(){savePref("xhs_video_preference",prefEl.value);});
document.getElementById("cookclear").addEventListener("click",function(){
cookieEl.value="";saveCookiePref();setStatus("已清除本机保存的 Cookie");});
function setStatus(t){statusEl.textContent=t||"";}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;
if(text!==undefined&&text!==null)e.textContent=String(text);return e;}
function onErr(body){
errEl.style.display="block";errEl.innerHTML="";
var msg=body&&body.error&&body.error.message?body.error.message:"未知错误";
errEl.appendChild(el("h3",null,"解析失败："+msg));
var d=body&&body.error?body.error.detail:null;
if(d&&d.steps){errEl.appendChild(el("p","steps",d.steps.join("\\n")));}
errEl.scrollIntoView({behavior:"smooth"});}
function onErrText(t){errEl.style.display="block";errEl.innerHTML="";
errEl.appendChild(el("h3",null,t));}
async function post(){
var t=inEl.value.trim();
if(!t){onErrText("请先粘贴分享文案或链接");return;}
saveCookiePref();
runEl.disabled=true;errEl.style.display="none";resEl.innerHTML="";setStatus("解析中…");
try{
var r=await fetch("/api/parse",{method:"POST",headers:{"Content-Type":"application/json"},
body:JSON.stringify({text:t,image_format:fmtEl.value,video_preference:prefEl.value,
cookie:getCookie()})});
var j=await r.json();
if(!r.ok||!j.ok){onErr(j);return;}
render(j);setStatus("完成，用时 "+j.source.elapsedMs+" ms");
}catch(e){onErrText("网络错误："+e);}
finally{runEl.disabled=false;}}
function addRow(kv,k,v){kv.appendChild(el("b",null,k));kv.appendChild(el("div",null,v));}
function render(j){
resEl.innerHTML="";
var d=j.data,m=j.media;
var card=el("div","card");var kv=el("div","kv");
addRow(kv,"作品标题",d["作品标题"]||"（无标题）");
addRow(kv,"作品描述",(d["作品描述"]||"").slice(0,300));
addRow(kv,"作者",(d["作者昵称"]||"")+"  ("+(d["作者ID"]||"")+")");
addRow(kv,"作品类型",d["作品类型"]);
addRow(kv,"发布时间",d["发布时间"]);
addRow(kv,"互动","赞 "+(d["点赞数量"]||"-")+" · 藏 "+(d["收藏数量"]||"-")+
" · 评 "+(d["评论数量"]||"-")+" · 分享 "+(d["分享数量"]||"-"));
addRow(kv,"作品标签",d["作品标签"]||"（无）");
addRow(kv,"作品 ID",d["作品ID"]);
addRow(kv,"文件名",d["文件名"]);
card.appendChild(kv);resEl.appendChild(card);
if(m.kind==="video"&&m.video){
var vc=el("div","card");
var head="视频 · 策略 "+m.strategy;
if(m.video.width&&m.video.height){head+=" · "+m.video.width+"×"+m.video.height;}
vc.appendChild(el("h3","sec",head));
var urls=d["下载地址"]||[];
if(urls.length){
var v=document.createElement("video");v.className="lplay";v.controls=true;
v.playsInline=true;v.preload="metadata";
v.src="/dl?url="+encodeURIComponent(urls[0]);
v.title="在线播放（经 /dl 代理，防盗链源无法浏览器直连）";
vc.appendChild(v);}
addLinks(vc,urls);
if(m.videoCandidates&&m.videoCandidates.length){
vc.appendChild(el("p","muted","共 "+m.videoCandidates.length+" 个清晰度候选，已按「"+
prefEl.value+"」排序取最优。"));}
resEl.appendChild(vc);
}
if(m.kind==="image"){
var urls2=d["下载地址"]||[];var lives=d["动图地址"]||[];
if(urls2.length){
window.__photos=urls2.map(function(u,i){return {url:u,label:"第 "+(i+1)+" 张"};});
var wrap=el("div","photos");
for(var i=0;i<urls2.length;i++){(function(u,idx){
var cell=el("figure","photo-cell");
var im=document.createElement("img");im.loading="lazy";im.decoding="async";
im.referrerPolicy="no-referrer";im.alt="第 "+(idx+1)+" 张";im.src=u;
im.onerror=function(){im.onerror=null;im.src="/api/thumb?url="+encodeURIComponent(u);};
var cap=el("figcaption",null,"第 "+(idx+1)+" 张");
cell.appendChild(im);cell.appendChild(cap);
cell.onclick=function(){openLightbox(idx);};
wrap.appendChild(cell);})(urls2[i],i);}
resEl.appendChild(wrap);}
var ic=el("div","card");
ic.appendChild(el("h3","sec","图片地址（格式 "+m.imageFormat+"）"));
addLinks(ic,urls2);
if(m.liveCount){ic.appendChild(el("h3","sec","动图（livePhoto）"));
addLinks(ic,lives.filter(Boolean));}
resEl.appendChild(ic);
}
if(m.verification&&m.verification.length){
var t=el("div","card");t.appendChild(el("h3","sec","媒体地址探测"));
for(var k=0;k<m.verification.length;k++){(function(v){
var line=v.ok?("HTTP "+v.status+" · "+(v.detected||v.contentType||"?")+" · "+
(v.human||"")+" （采样 "+v.sampled+" 字节）"):("失败："+v.error);
t.appendChild(el("div","muted",line));})(m.verification[k]);}
resEl.appendChild(t);
}
var sc=el("div","card");sc.appendChild(el("h3","sec","处理步骤"));
sc.appendChild(el("p","steps",j.steps.join("\\n")));
resEl.appendChild(sc);
resEl.scrollIntoView({behavior:"smooth"});
probeSizes(d["下载地址"]||[]);}
function addLinks(container,urls){
if(!urls||!urls.length){container.appendChild(el("p","muted","（无地址）"));return;}
for(var i=0;i<urls.length;i++){container.appendChild(linkRow(urls[i],i));}}
function linkRow(url,i){var row=el("div","linkrow");
var bx=el("div","lbox",url);bx.title="双击复制该链接";
bx.ondblclick=function(ev){ev.preventDefault();copyText(url);};
bx.addEventListener("wheel",function(e){
if(bx.scrollWidth>bx.clientWidth){e.preventDefault();
bx.scrollLeft+=(e.deltaY||e.deltaX||0);}},{passive:false});
row.appendChild(bx);
var act=el("span","lact");
var a=el("a","btn","打开");a.href=url;a.target="_blank";a.rel="noreferrer";act.appendChild(a);
var p=el("a","btn","代理");p.href="/dl?url="+encodeURIComponent(url);
p.target="_blank";p.rel="noreferrer";p.title="防盗链导致直开失败时用代理打开";act.appendChild(p);
var b=el("button","sm","复制");b.textContent="复制";
b.onclick=function(ev){ev.stopPropagation();copyText(url);};act.appendChild(b);
row.appendChild(act);
var sz=el("span","size","");sz.setAttribute("data-pr","1");row.appendChild(sz);
return row;}
function copyText(t){var done=function(){setStatus("已复制到剪贴板");};
if(navigator.clipboard&&navigator.clipboard.writeText){
navigator.clipboard.writeText(t).then(done,function(){fallbackCopy(t,done);});}
else{fallbackCopy(t,done);}}
function fallbackCopy(t,done){var ta=document.createElement("textarea");ta.value=t;
ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();
try{document.execCommand("copy");done();}catch(e){setStatus("复制失败，请手动选择地址");}
document.body.removeChild(ta);}
function human(n){if(n<0)return "大小未知";if(n<1024)return n+"B";
var k=n/1024;if(k<1024)return k.toFixed(1)+"KB";var m=k/1024;
if(m<1024)return m.toFixed(1)+"MB";return (m/1024).toFixed(2)+"GB";}
function probeSizes(urls){var marks=document.querySelectorAll(".lbox+.lact+.size");
for(var i=0;i<urls.length&&i<marks.length;i++){(function(mark,url){
mark.textContent="…";
fetch("/api/probe?url="+encodeURIComponent(url)).then(function(r){return r.json();})
.then(function(j){if(j&&j.ok){mark.textContent=j.human+" · "+(j.detected||j.contentType||"?");}
else{mark.textContent="";}}).catch(function(){mark.textContent="";});})(marks[i],urls[i]);}}
function openLightbox(idx){var ph=window.__photos;if(!ph||!ph.length)return;
var lb=document.getElementById("lb");var img=document.getElementById("lbImg");
var cap=document.getElementById("lbCap");window.__lbIdx=idx;
function show(){var cur=ph[window.__lbIdx];img.src=cur.url;window.__zoom=1;
img.style.transform="";img.onerror=function(){img.onerror=null;
img.src="/api/thumb?url="+encodeURIComponent(cur.url);};
cap.textContent=cur.label+"（"+(window.__lbIdx+1)+"/"+ph.length+"）· 滚轮缩放";}
window.__lbShow=show;show();lb.classList.add("open");}
function lbClose(){document.getElementById("lb").classList.remove("open");}
function lbStep(d){if(!window.__photos||!window.__photos.length)return;
window.__lbIdx=(window.__lbIdx+d+window.__photos.length)%window.__photos.length;
if(window.__lbShow){window.__lbShow();}}
document.getElementById("sample").addEventListener("click",async function(){
setStatus("获取示例中…");
saveCookiePref();
try{var r=await fetch("/api/sample?cookie="+encodeURIComponent(getCookie()));var j=await r.json();
if(!j.ok){onErr(j);return;}
inEl.value=j.url;setStatus("已填入最新示例链接，点击解析");}
catch(e){onErrText("示例获取失败："+e);}});
document.getElementById("clear").addEventListener("click",function(){
inEl.value="";resEl.innerHTML="";errEl.style.display="none";setStatus("");});
runEl.addEventListener("click",post);
inEl.addEventListener("keydown",function(e){
if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();post();}});
document.addEventListener("keydown",function(e){var lb=document.getElementById("lb");
if(!lb.classList.contains("open"))return;
if(e.key==="Escape"){lbClose();}else if(e.key==="ArrowLeft"){lbStep(-1);}
else if(e.key==="ArrowRight"){lbStep(1);}});
document.getElementById("lb").addEventListener("wheel",function(e){
var lb=document.getElementById("lb");if(!lb.classList.contains("open"))return;
e.preventDefault();var img=document.getElementById("lbImg");
var z=(window.__zoom||1);z=e.deltaY<0?Math.min(10,z*1.2):Math.max(1,z/1.2);
window.__zoom=z;img.style.transform="scale("+z+")";},{passive:false});
</script></body></html>`;

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

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

function errorBody(code, message, detail) {
  const body = { ok: false, error: { code, message } };
  if (detail) body.error.detail = detail;
  return body;
}

function statusForCode(code) {
  if (code === 'bad_input' || code === 'no_xhs_link' || code === 'bad_media_url') return 400;
  if (code === 'no_note_data' || code === 'no_note_id' || code === 'no_initial_state') return 404;
  // 'risk_control' and network failures: the upstream refused to serve us.
  return 502;
}

async function readBodyOptions(request) {
  if (request.method !== 'POST' && request.method !== 'PUT') return null;
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      throw new ParseError('bad_input', '请求体不是合法 JSON');
    }
    if (isObj(payload)) return payload;
    throw new ParseError('bad_input', 'JSON 请求体必须是对象');
  }
  const raw = await request.text();
  return { text: raw };
}

async function handleParse(request, url) {
  const bodyOptions = await readBodyOptions(request);
  const source = bodyOptions || {};
  const text = source.text ?? source.url ?? url.searchParams.get('text') ??
    url.searchParams.get('url');
  if (text === null || text === undefined || String(text).trim() === '') {
    return jsonResponse(400, errorBody(
      'bad_input',
      '缺少输入：GET /api/parse?url=… 或 POST {"url": "…"}',
    ));
  }
  const options = {
    imageFormat: source.image_format ?? source.imageFormat ?? url.searchParams.get('image_format'),
    videoPreference: source.video_preference ?? source.videoPreference ??
      url.searchParams.get('video_preference'),
    nameFormat: source.name_format ?? source.nameFormat ?? url.searchParams.get('name_format'),
    tzOffset: source.tz_offset ?? source.tzOffset ?? url.searchParams.get('tz_offset'),
    cookie: source.cookie ?? url.searchParams.get('cookie'),
    verify: source.verify === true || url.searchParams.get('verify') === '1' ||
      url.searchParams.get('verify') === 'true',
  };
  try {
    const result = await runParse(String(text), options);
    return jsonResponse(200, result);
  } catch (error) {
    if (error instanceof ParseError) {
      return jsonResponse(
        statusForCode(error.code),
        errorBody(error.code, error.message, error.detail),
      );
    }
    return jsonResponse(502, errorBody(
      'internal',
      '解析异常：' + (error && error.message ? error.message : String(error)),
    ));
  }
}

async function handleSample(url) {
  try {
    const cookie = url ? url.searchParams.get('cookie') : null;
    return jsonResponse(200, await fetchSampleLink(cookie));
  } catch (error) {
    if (error instanceof ParseError) {
      return jsonResponse(
        statusForCode(error.code),
        errorBody(error.code, error.message, error.detail),
      );
    }
    return jsonResponse(502, errorBody('sample_failed', '示例链接获取失败'));
  }
}

async function handleProbe(url) {
  const raw = url.searchParams.get('url');
  if (!raw) return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
  try {
    return jsonResponse(200, await probeMedia(raw));
  } catch (error) {
    if (error instanceof ParseError) {
      return jsonResponse(400, errorBody(error.code, error.message));
    }
    return jsonResponse(502, errorBody('probe_failed', '大小探测失败'));
  }
}

/** Hosts that answer 403 without a xiaohongshu Referer. */
function hostNeedsReferer(host) {
  const h = String(host || '').toLowerCase();
  return hostAllowed(h) || h === 'xhscdn.com';
}

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
    '<p><a href="' + esc + '" rel="noreferrer" style="color:#ff8095">若未自动跳转，请点击这里</a></p>' +
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

/** Stream media through this Worker with a xiaohongshu Referer (+ Range passthrough). */
async function proxyMedia(target, request) {
  try {
    const headers = {
      'user-agent': DESKTOP_UA,
      referer: XHS_ORIGIN + '/',
      accept: '*/*',
      'accept-encoding': 'identity',
    };
    const range = request ? request.headers.get('range') : null;
    if (range) headers.range = range;
    const upstream = await fetch(target, { method: 'GET', redirect: 'follow', headers });
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
  } catch (_) {
    return jsonResponse(502, errorBody('media_failed', '媒体转发失败'));
  }
}

async function handleDownload(url, request) {
  const raw = url.searchParams.get('url');
  if (!raw) return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
  try {
    const target = validateMediaUrl(raw).toString();
    const accept = (request ? request.headers.get('accept') : '') || '';
    if (accept.toLowerCase().includes('text/html')) {
      if (hostNeedsReferer(new URL(target).hostname)) return await proxyMedia(target, request);
      return noReferrerBridge(target);
    }
    return new Response(null, {
      status: 302,
      headers: { Location: target, ...CORS_HEADERS },
    });
  } catch (error) {
    if (error instanceof ParseError) {
      return jsonResponse(400, errorBody(error.code, error.message));
    }
    return jsonResponse(400, errorBody('bad_media_url', '媒体地址校验失败'));
  }
}

async function handleThumb(url) {
  const raw = url.searchParams.get('url');
  if (!raw) return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
  try {
    const target = validateMediaUrl(raw).toString();
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': DESKTOP_UA,
        referer: XHS_ORIGIN + '/',
        accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!response.ok) {
      return jsonResponse(502, errorBody('thumb_failed', '缩略图源返回 HTTP ' + response.status));
    }
    const type = (response.headers.get('content-type') || '').toLowerCase();
    // Refuse obvious non-images up front so a video URL never gets buffered here.
    if (type.startsWith('video/') || type.startsWith('audio/')) {
      return jsonResponse(502, errorBody('thumb_failed', '响应不是图片（' + type + '）'));
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 20 * 1024 * 1024) {
      return jsonResponse(502, errorBody('thumb_failed', '图片超过 20 MiB 安全限制'));
    }
    const detected = detectFileType(new Uint8Array(buffer.slice(0, SIGNATURE_PROBE_BYTES)));
    if (!type.startsWith('image/') && !IMAGE_SUFFIXES.has(detected)) {
      return jsonResponse(502, errorBody('thumb_failed', '响应不是图片'));
    }
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': type.startsWith('image/')
          ? type
          : (IMAGE_MIME_BY_SUFFIX[detected] || 'application/octet-stream'),
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'public, max-age=3600',
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    if (error instanceof ParseError) {
      return jsonResponse(400, errorBody(error.code, error.message));
    }
    return jsonResponse(502, errorBody('thumb_failed', '缩略图获取失败'));
  }
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

const HELP = {
  name: 'xhs-parse',
  description:
    '小红书作品解析（移植 XHS-Downloader 的解析规则）：链接提取 → window.__INITIAL_STATE__ 解析 → ' +
    '作品信息、图片/视频媒体地址选择。',
  endpoints: {
    'GET /（或 /app、/index.html）': '内置网页：粘贴分享文案解析、预览图片、在线播放视频、复制/代理下载地址',
    'GET /help': '本帮助（JSON）',
    'GET /api/sample': '从首页推荐流取一条当前有效的示例作品链接',
    'GET /api/parse?url=…': '解析 explore / discovery/item / xhslink 链接',
    'GET /api/parse?text=…': '解析分享文案（同一流程）',
    'POST /api/parse': 'JSON 请求体，见下方 options',
    'GET /api/thumb?url=…': '图片代理（带 Referer/UA，供网页预览）',
    'GET /api/probe?url=…': '探测媒体远端大小 + 真实文件类型（Range bytes=0-31）',
    'GET /dl?url=…': '302 跳转到通过校验的小红书媒体地址（浏览器打开时经代理加 Referer）',
    'GET /api/selftest': '解析管线确定性自测（不需要网络）',
  },
  options: {
    image_format: 'auto | png | webp | jpeg | heic | avif，默认 jpeg（仅图文/图集生效）',
    video_preference: 'resolution | bitrate | size，默认 resolution（仅视频生效）',
    name_format: '文件名字段，空格分隔；含未知字段时回退默认值',
    tz_offset: '发布时间时区偏移（分钟），默认 480（UTC+8）',
    cookie: '小红书网页版 Cookie；非必需，视频高画质与风控场景建议提供',
    verify: 'true 时顺带探测媒体地址，结果放在 media.verification',
    proxy: '仅为兼容原项目 API 保留，Worker 运行时忽略',
  },
  response: {
    ok: '是否成功',
    steps: '处理步骤（失败时用于定位）',
    source: '输入、最终 URL、作品 ID、页面大小、耗时',
    data: 'XHS-Downloader 原始字段：作品ID/标题/描述/类型/标签/互动数/时间/作者/下载地址/动图地址/文件名',
    media: '归一化媒体块：kind、video（分辨率等）、imageCount、verified',
  },
  errors: {
    bad_input: '输入为空或格式不对（400）',
    no_xhs_link: '输入里没有小红书作品链接（400）',
    bad_media_url: '媒体地址不在允许的小红书域名内（400）',
    no_note_data: '页面没返回作品数据，通常是 xsec_token 已过期（404）',
    no_initial_state: '页面被风控或结构变化，未找到 __INITIAL_STATE__（404）',
    risk_control: '被要求安全验证，通常是数据中心 IP 风控；填 Cookie 后重试（502）',
    request_failed: '网络请求失败（502）',
  },
  notes: [
    '仅用于你有权处理的内容；平台页面结构、风控与地区差异都可能影响结果。',
    '作品链接携带日期信息，旧链接的 xsec_token 会失效，解析失败时请重新获取链接。',
    'Cloudflare Worker 的出口是数据中心 IP，比家用宽带更容易被要求安全验证；遇到 risk_control 请填入小红书网页版 Cookie。',
    '未设置 Cookie 时视频可能只能取到较低画质；本服务不记录你的 Cookie。',
  ],
};

function handleHelp() {
  return jsonResponse(200, HELP);
}

// ---------------------------------------------------------------------------
// Deterministic self-test (no network): the pipeline rules from the Python
// project, checked against synthetic fixtures.
// ---------------------------------------------------------------------------

function selftestJsonLike() {
  const text = "{a:1, b:'x', c:[1,2,], d:undefined, e:{f:true,}, g:null, h:1.5e3}";
  const parsed = parseJsonLike(text);
  if (parsed.a !== 1) throw new Error('json-like: bare key');
  if (parsed.b !== 'x') throw new Error('json-like: single quotes');
  if (parsed.c.length !== 2) throw new Error('json-like: trailing comma in array');
  if (parsed.d !== null) throw new Error('json-like: undefined -> null');
  if (parsed.e.f !== true) throw new Error('json-like: nested object');
  if (parsed.g !== null) throw new Error('json-like: null literal');
  if (parsed.h !== 1500) throw new Error('json-like: exponent');
  const str = parseJsonLike('{"a":"und\\u0065fined and undefined"}');
  if (str.a !== 'undefined and undefined') {
    throw new Error('json-like: string content must not be rewritten');
  }
  return 'json_like_ok';
}

function selftestInitialState() {
  const html =
    '<html><head><script>var x=1;</script></head><body>' +
    '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"aaa":{"note":{"noteId":"aaa"}},' +
    '"bbb":{"note":{"noteId":"bbb"}}}},"other":undefined};</script>' +
    '<script>window.__OTHER__={};</script></body></html>';
  const state = parseInitialState(html);
  if (!state) throw new Error('initial state: not found');
  if (state.other !== null) throw new Error('initial state: undefined not normalised');
  if (filterNoteObject(state, 'aaa').noteId !== 'aaa') {
    throw new Error('initial state: preferred note id must win');
  }
  if (filterNoteObject(state, 'zzz').noteId !== 'bbb') {
    throw new Error('initial state: [-1] must fall back to last entry');
  }
  const phone =
    'window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"noteId":"phone-1"}}}}';
  const phoneState = parseInitialState('<script>' + phone + '</script>');
  if (filterNoteObject(phoneState, 'x').noteId !== 'phone-1') {
    throw new Error('initial state: phone shape');
  }
  if (parseInitialState('<html><script>var a=1;</script></html>') !== null) {
    throw new Error('initial state: must return null when absent');
  }
  return 'initial_state_ok';
}

function selftestExtractLinks() {
  const cases = [
    ['看这个 https://www.xiaohongshu.com/explore/abc123?xsec_token=TOK 不错',
      'https://www.xiaohongshu.com/explore/abc123?xsec_token=TOK'],
    ['https://www.xiaohongshu.com/discovery/item/def456?xsec_token=T2',
      'https://www.xiaohongshu.com/discovery/item/def456?xsec_token=T2'],
    ['https://www.xiaohongshu.com/user/profile/user1/ghi789?xsec_token=T3',
      'https://www.xiaohongshu.com/user/profile/user1/ghi789?xsec_token=T3'],
    ['https://www.rednote.com/explore/rn000?a=1', 'https://www.rednote.com/explore/rn000?a=1'],
    ['www.xiaohongshu.com/explore/nohost?a=1', 'www.xiaohongshu.com/explore/nohost?a=1'],
  ];
  for (const [input, expected] of cases) {
    const match = RE_SHARE_XHS.exec(input) || RE_SHARE_RN.exec(input) ||
      RE_LINK_XHS.exec(input) || RE_LINK_RN.exec(input) ||
      RE_USER_XHS.exec(input) || RE_USER_RN.exec(input);
    const actual = match ? match[0] : '';
    if (actual !== expected) throw new Error('extract link: ' + input + ' -> ' + actual);
  }
  const short = RE_SHORT.exec('复制 http://xhslink.com/aBcD3f 打开小红书');
  if (!short || short[0] !== 'http://xhslink.com/aBcD3f') {
    throw new Error('extract link: short url');
  }
  const id = extractLinkId('https://www.xiaohongshu.com/explore/64f0c1a2000000001203abcd?x=1');
  if (id !== '64f0c1a2000000001203abcd') throw new Error('extract id: ' + id);
  const ids = extractIds(['https://www.xiaohongshu.com/explore/abc?t=1']);
  if (ids[0] !== 'abc') throw new Error('extract ids: ' + JSON.stringify(ids));
  return 'extract_links_ok';
}

function selftestExplore() {
  const note = {
    noteId: 'note-1',
    title: '标题',
    desc: '描述',
    type: 'normal',
    time: 1700000000000,
    lastUpdateTime: 1700000100000,
    user: { nickname: '昵称', userId: 'uid-1' },
    interactInfo: { collectedCount: '10', commentCount: '2', shareCount: '3', likedCount: '' },
    tagList: [{ name: '标签A' }, { name: '标签B' }],
    imageList: [{ urlDefault: 'x' }],
  };
  // likedCount is empty -> safe_extract must fall back to "-1"
  const data = exploreRun(note, 480);
  if (data['作品ID'] !== 'note-1') throw new Error('explore: id');
  if (data['点赞数量'] !== '-1') throw new Error('explore: falsy -> default, got ' + data['点赞数量']);
  if (data['收藏数量'] !== '10') throw new Error('explore: collected');
  if (data['作品标签'] !== '标签A 标签B') throw new Error('explore: tags');
  if (data['作品类型'] !== '图文') throw new Error('explore: type normal, got ' + data['作品类型']);
  if (data['作者链接'] !== 'https://www.xiaohongshu.com/user/profile/uid-1') {
    throw new Error('explore: author link');
  }
  if (data['发布时间'] !== '2023-11-15_06:13:20') {
    throw new Error('explore: publish time (UTC+8), got ' + data['发布时间']);
  }
  if (data['时间戳'] !== 1700000000) throw new Error('explore: epoch seconds');
  if (exploreRun({}, 480)['作品ID'] !== undefined) throw new Error('explore: empty -> {}');
  // type classification
  const video = { type: 'video', imageList: [{}], noteId: 'v' };
  if (classifyWorks(video) !== '视频') throw new Error('explore: video with 1 image');
  if (classifyWorks({ type: 'video', imageList: [{}, {}] }) !== '图集') {
    throw new Error('explore: video with 2 images -> 图集');
  }
  if (classifyWorks({ type: 'normal', imageList: [] }) !== '未知') {
    throw new Error('explore: empty imageList -> 未知');
  }
  if (classifyWorks({ type: 'other', imageList: [{}] }) !== '未知') {
    throw new Error('explore: unknown type -> 未知');
  }
  return 'explore_ok';
}

function selftestImage() {
  const url = 'http://sns-webpic-qc.xhscdn.com/202609121319/7309997bcd7772dd4dbf13ac2d7d1847/' +
    'spectrum/1040g0k0323be3pj86u005oih1hak0k3a94udfog!nd_dft_wlteh_jpg_3';
  const token = extractImageToken(url);
  if (token !== 'spectrum/1040g0k0323be3pj86u005oih1hak0k3a94udfog') {
    throw new Error('image: token -> ' + token);
  }
  if (generateFixedImageLink(token, 'png') !==
      'https://ci.xiaohongshu.com/spectrum/1040g0k0323be3pj86u005oih1hak0k3a94udfog?imageView2/format/png') {
    throw new Error('image: fixed link');
  }
  if (generateAutoImageLink(token) !==
      'https://sns-img-bd.xhscdn.com/spectrum/1040g0k0323be3pj86u005oih1hak0k3a94udfog') {
    throw new Error('image: auto link');
  }
  // urlDefault wins; url is only the fallback when no urlDefault yields a token.
  const withDefault = getImagePlan({ imageList: [{ urlDefault: url, url: 'https://a/b/c/d/e/f!x' }] }, 'jpeg');
  if (!withDefault.urls[0].includes('1040g0k0323be3pj86u005oih1hak0k3a94udfog')) {
    throw new Error('image: urlDefault preferred');
  }
  const fallback = getImagePlan({ imageList: [{ url: url }] }, 'auto');
  if (!fallback.urls[0].startsWith('https://sns-img-bd.xhscdn.com/')) {
    throw new Error('image: url fallback -> ' + fallback.urls[0]);
  }
  const live = getImagePlan({
    imageList: [{ urlDefault: url, stream: { h264: [{ backupUrls: ['https://cdn/live.mp4'] }] } }],
  }, 'jpeg');
  if (live.liveLinks[0] !== 'https://cdn/live.mp4') throw new Error('image: live backupUrls');
  const master = getImagePlan({
    imageList: [{ urlDefault: url, stream: { h264: [{ masterUrl: 'https://cdn/m.mp4' }] } }],
  }, 'jpeg');
  if (master.liveLinks[0] !== 'https://cdn/m.mp4') throw new Error('image: live masterUrl');
  // missing stream must not throw (the Python original raised here)
  const none = getImagePlan({ imageList: [{ urlDefault: url, stream: { h264: [{}] } }] }, 'jpeg');
  if (none.liveLinks[0] !== null) throw new Error('image: no stream -> null');
  return 'image_ok';
}

function selftestVideo() {
  const data = {
    video: {
      media: {
        stream: {
          h264: [
            { height: 720, videoBitrate: 1000, size: 100, backupUrls: ['https://cdn/720.mp4'] },
            { height: 1080, videoBitrate: 2000, size: 300, backupUrls: ['https://cdn/1080.mp4'] },
            { height: 480, videoBitrate: 500, size: 50, backupUrls: ['https://cdn/480.mp4'] },
          ],
          h265: [
            { height: 1440, videoBitrate: 3000, size: 500, backupUrls: ['https://cdn/1440.mp4'] },
          ],
        },
      },
    },
  };
  if (getVideoPlan(data, 'resolution').urls[0] !== 'https://cdn/1440.mp4') {
    throw new Error('video: resolution preference');
  }
  if (getVideoPlan(data, 'bitrate').urls[0] !== 'https://cdn/1440.mp4') {
    throw new Error('video: bitrate preference');
  }
  if (getVideoPlan(data, 'size').urls[0] !== 'https://cdn/1440.mp4') {
    throw new Error('video: size preference');
  }
  const sizeCase = {
    video: { media: { stream: { h264: [
      { height: 1080, size: 10, backupUrls: ['https://cdn/small.mp4'] },
      { height: 480, size: 900, backupUrls: ['https://cdn/big.mp4'] },
    ] } } },
  };
  if (getVideoPlan(sizeCase, 'size').urls[0] !== 'https://cdn/big.mp4') {
    throw new Error('video: size preference picks largest file');
  }
  if (getVideoPlan(sizeCase, 'resolution').urls[0] !== 'https://cdn/small.mp4') {
    throw new Error('video: resolution ignores size');
  }
  // masterUrl fallback when backupUrls is empty
  const master = {
    video: { media: { stream: { h264: [{ height: 1, masterUrl: 'https://cdn/master.mp4' }] } } },
  };
  if (getVideoPlan(master, 'resolution').urls[0] !== 'https://cdn/master.mp4') {
    throw new Error('video: masterUrl fallback');
  }
  // originVideoKey wins over the stream list
  const origin = {
    video: {
      consumer: { originVideoKey: 'abc/def.mp4' },
      media: { stream: { h264: [{ height: 9, backupUrls: ['https://cdn/x.mp4'] }] } },
    },
  };
  const plan = getVideoPlan(origin, 'resolution');
  if (plan.strategy !== 'originVideoKey') throw new Error('video: originVideoKey strategy');
  if (plan.urls[0] !== 'https://sns-video-bd.xhscdn.com/abc/def.mp4') {
    throw new Error('video: originVideoKey url -> ' + plan.urls[0]);
  }
  if (getVideoPlan({}, 'resolution').urls.length !== 0) throw new Error('video: empty -> []');
  return 'video_ok';
}

function selftestNaming() {
  if (decodeUnicodeEscapes('https://a/\\u002Fb') !== 'https://a//b') {
    throw new Error('naming: unicode escape');
  }
  const data = {
    作品ID: 'nid',
    作品标题: '标题:带/非法*字符',
    作品描述: '',
    作品类型: '图文',
    发布时间: '2023-11-15_06:13:20',
    最后更新时间: '2023-11-15_06:13:20',
    作者昵称: '某人',
    作者ID: 'uid',
    收藏数量: '1', 评论数量: '2', 分享数量: '3', 点赞数量: '4',
    作品标签: 'a b',
  };
  // ':' -> '.', illegal chars removed, default format is 发布时间 作者昵称 作品标题
  const name = buildFileName(data, normalizeNameFormat(undefined));
  if (name !== '2023-11-15_06.13.20_某人_标题.带非法字符') {
    throw new Error('naming: default format -> ' + name);
  }
  // an unknown key resets the format to the default
  if (normalizeNameFormat('无效字段 作品标题') !== DEFAULT_NAME_FORMAT) {
    throw new Error('naming: invalid key must fall back');
  }
  if (normalizeNameFormat('作品ID 作品标题') !== '作品ID 作品标题') {
    throw new Error('naming: valid key must pass through');
  }
  if (managerFilterName('a/b:c*d') !== 'a_b_c_d') {
    throw new Error('naming: managerFilterName -> ' + managerFilterName('a/b:c*d'));
  }
  if (beautifyString('short', 64) !== 'short') throw new Error('naming: beautify short');
  const long = 'a'.repeat(200);
  const trimmed = beautifyString(long, 10);
  if (!trimmed.includes('...')) throw new Error('naming: beautify ellipsis');
  if (cleanerFilterName('  空 白  ') !== '空 白') {
    throw new Error('naming: collapse spaces -> ' + cleanerFilterName('  空 白  '));
  }
  if (cleanerFilterName('', '', 'fallback') !== 'fallback') {
    throw new Error('naming: default value');
  }
  return 'naming_ok';
}

function selftestMediaGuard() {
  for (const host of ['sns-img-bd.xhscdn.com', 'ci.xiaohongshu.com', 'www.rednote.com']) {
    if (!hostAllowed(host)) throw new Error('guard: should allow ' + host);
  }
  for (const host of ['evil.com', 'xhscdn.com.evil.com']) {
    if (hostAllowed(host)) throw new Error('guard: should reject ' + host);
  }
  const cases = [
    ['http://127.0.0.1/x', 'private'],
    ['http://169.254.169.254/latest/meta-data', 'link-local'],
    ['http://10.0.0.1/x', 'rfc1918'],
  ];
  for (const [url, label] of cases) {
    if (!isPrivateHost(new URL(url).hostname)) throw new Error('guard: missed ' + label);
  }
  let rejected = false;
  try {
    validateMediaUrl('https://example.com/x.mp4');
  } catch (error) {
    rejected = error instanceof ParseError && error.code === 'bad_media_url';
  }
  if (!rejected) throw new Error('guard: foreign host must be rejected');
  if (validateMediaUrl('https://sns-img-bd.xhscdn.com/a').hostname !== 'sns-img-bd.xhscdn.com') {
    throw new Error('guard: allowed host must parse');
  }
  // static.py file signatures
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  if (detectFileType(png) !== 'png') throw new Error('guard: png signature');
  const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  if (detectFileType(mp4) !== 'mp4') throw new Error('guard: mp4 signature');
  if (detectFileType(new Uint8Array([1, 2, 3])) !== '') throw new Error('guard: unknown signature');
  // /api/thumb must classify by real bytes, never by a fabricated MIME.
  if (!IMAGE_SUFFIXES.has(detectFileType(png))) throw new Error('guard: png must be an image');
  if (!IMAGE_SUFFIXES.has(detectFileType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])))) {
    throw new Error('guard: gif must be an image');
  }
  if (IMAGE_SUFFIXES.has(detectFileType(mp4))) {
    throw new Error('guard: mp4 must not be treated as an image');
  }
  if (IMAGE_MIME_BY_SUFFIX.png !== 'image/png') throw new Error('guard: png mime');
  return 'media_guard_ok';
}

function selftestRiskControl() {
  // Real verification hop observed when this Worker ran on Cloudflare: the short
  // link resolved, but xiaohongshu answered with a captcha page on a datacenter IP.
  const captcha =
    'https://www.xiaohongshu.com/website-login/captcha?redirectPath=http%3A%2F%2Fwww.xiaohongshu.com' +
    '%2Fdiscovery%2Fitem%2F6a068472000000000803f503%3Fapp_platform%3Dandroid%26ignoreEngage%3Dtrue' +
    '%26app_version%3D9.45.1%26share_from_user_hidden%3Dtrue%26xsec_source%3Dapp_share%26type%3Dvideo' +
    '%26xsec_token%3DCBiCODxBwN-F0910X2rFedvHyPMEPPeCY-NQxidj4_tJM%253D%26author_share%3D1' +
    '%26xhsshare%3DCopyLink%26shareRedId%3DODo7RUk2Skw2NzUyOTgwNjhEOTo7PT86%26apptime%3D1789134927' +
    '%26share_id%3Dad8feb7f06194a01b472a8aba4a830a6%26share_channel%3Dcopy_link' +
    '%26track_code%3D1j2tUD6RufO%26exSource%3Dnull&verifyUuid=6dd5d8b4-768c-466e-ba75-823be230caf6' +
    '&verifyType=217&verifyBiz=461&verifyMsg=null';

  if (!isRiskControlUrl(captcha)) throw new Error('risk: captcha url not detected');
  if (isRiskControlUrl('https://www.xiaohongshu.com/explore/abc?xsec_token=T')) {
    throw new Error('risk: note url wrongly flagged');
  }
  if (isRiskControlUrl('')) throw new Error('risk: empty url wrongly flagged');

  const recovered = recoverNoteUrlFromRedirect(captcha);
  if (!recovered) throw new Error('risk: failed to recover note url from redirectPath');
  if (!recovered.includes('/discovery/item/6a068472000000000803f503')) {
    throw new Error('risk: recovered wrong target -> ' + recovered);
  }
  const noteId = extractLinkId(recovered);
  if (noteId !== '6a068472000000000803f503') {
    throw new Error('risk: recovered note id -> ' + noteId);
  }
  // the recovered target is http:// and must be upgraded for the site hosts
  if (!recovered.startsWith('http://')) throw new Error('risk: expected http redirect target');
  if (!preferHttpsForSite(recovered).startsWith('https://www.xiaohongshu.com/')) {
    throw new Error('risk: site url not upgraded to https');
  }
  // media URLs must not be rewritten by the site upgrade
  const media = 'http://sns-bak-v1.xhscdn.com/stream/1/110/258/x.mp4';
  if (preferHttpsForSite(media) !== media) throw new Error('risk: media url must stay untouched');

  if (recoverNoteUrlFromRedirect('https://www.xiaohongshu.com/explore/abc?x=1') !== '') {
    throw new Error('risk: non-captcha url must not yield a target');
  }
  if (recoverNoteUrlFromRedirect('not a url') !== '') {
    throw new Error('risk: invalid url must not throw');
  }
  if (!looksLikeRiskControlHtml('<html>/website-login/captcha</html>')) {
    throw new Error('risk: html detection');
  }
  if (looksLikeRiskControlHtml('<html>normal note page</html>')) {
    throw new Error('risk: normal html wrongly flagged');
  }
  return 'risk_control_ok';
}

function handleSelfTest() {
  const checks = [];
  try {
    checks.push(selftestJsonLike());
    checks.push(selftestInitialState());
    checks.push(selftestExtractLinks());
    checks.push(selftestExplore());
    checks.push(selftestImage());
    checks.push(selftestVideo());
    checks.push(selftestNaming());
    checks.push(selftestMediaGuard());
    checks.push(selftestRiskControl());
    return jsonResponse(200, { ok: true, checks });
  } catch (error) {
    return jsonResponse(500, errorBody(
      'selftest_failed',
      error && error.message ? error.message : String(error),
      { checks },
    ));
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
      if (path === '/api/sample' || path === '/sample') return await handleSample(url);
      if (path === '/api/parse' || path === '/parse') return await handleParse(request, url);
      if (path === '/api/probe' || path === '/probe') return await handleProbe(url);
      if (path === '/api/thumb' || path === '/thumb') return await handleThumb(url);
      if (path === '/dl' || path === '/api/dl' || path === '/download') {
        return await handleDownload(url, request);
      }
      if (path === '/api/selftest' || path === '/selftest') return handleSelfTest();
      return jsonResponse(404, errorBody('not_found', '未知路径 ' + request.url));
    } catch (error) {
      return jsonResponse(500, errorBody(
        'internal',
        error && error.message ? error.message : String(error),
      ));
    }
  },
};
