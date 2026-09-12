<?php
/**
 * ============================================================================
 * xhs-parse — 小红书（XiaoHongShu / RedNote）作品解析器 · PHP 单文件版
 * ============================================================================
 *
 * 由 Cloudflare Worker 版 `workers.js` 完整移植：路由、解析管线、内置网页 UI、
 * 确定性自测全部保留在这一个 PHP 文件里，零第三方依赖（仅建议开启 curl 扩展，
 * 没有 curl 时自动回退到 stream 包装器）。
 *
 * 运行方式（任选其一）：
 *   php -S 0.0.0.0:8080 index.php     # PHP 内置服务器（路由器模式，推荐）
 *   php index.php                     # 命令行：只跑确定性自测并打印 JSON
 *   Apache/Nginx + PHP-FPM            # 直接把文件放到站点目录即可
 *
 * 部署位置随意：站点根目录，或 /api/xhs/ 这类子目录都行，**不需要 rewrite**。
 *   - 挂载路径由 SCRIPT_NAME 自动推断（推断不准时可改 BASE_PATH_OVERRIDE）；
 *   - 内置网页始终通过本文件自己的地址调用接口（index.php?route=/api/parse），
 *     所以在子目录下也不会出现 404；
 *   - 传统接口路径同时保留，四种写法都可用：
 *       /api/parse                           （站点根目录部署 + rewrite）
 *       /api/xhs/api/parse                   （子目录部署 + rewrite/别名）
 *       /api/xhs/index.php/api/parse         （PATH_INFO，Apache/FPM 常见支持）
 *       /api/xhs/index.php?route=/api/parse  （任何服务器都能用，网页用的就是这种）
 *     前三种要求服务器把这些路径交给本文件（rewrite / alias / 路由器模式）；
 *     第四种只是普通文件请求，所以零配置即可用。
 *
 * 接口与原版完全一致：
 *   GET  /                    内置网页 UI（同 /app、/index.html）
 *   GET  /help                JSON 帮助
 *   GET  /api/sample          从首页推荐流取一条当前有效的示例作品链接
 *   GET  /api/parse?url=…     解析作品链接
 *   GET  /api/parse?text=…    解析分享文案
 *   POST /api/parse           JSON 请求体（支持全部参数）
 *   GET  /api/thumb?url=…     图片代理（带 Referer/UA）
 *   GET  /api/probe?url=…     探测远端大小 + 真实文件类型（Range bytes=0-31）
 *   GET  /dl?url=…            脚本调用 302 / 浏览器打开时代理
 *   GET  /api/selftest        解析管线确定性自测（不联网）
 *
 * 解析规则移植自 JoeanAmier/XHS-Downloader（GNU GPL v3.0），本文件同样以
 * GPL-3.0 分发，使用与再分发请遵守原项目 LICENSE 的要求并注明出处。
 *
 * 与原 Worker 版的差异（仅运行时相关，行为保持一致）：
 *   - `proxy` 参数同样被忽略（PHP 也没有单请求代理开关），保留只为兼容 API。
 *   - fetch 换成 curl（缺失时用 stream），重定向跟随、超时、重试语义一致。
 *   - JSON 响应同样是 2 空格缩进（把 PHP 的 4 空格缩进折半），字段与取值不变。
 *   - `new URL(x)` 换成 parse_url + parse_str；`decodeURIComponent` 换成
 *     rawurldecode（同样不把 `+` 解成空格）。
 *   - 输入长度按 UTF-8 字符数统计，与 JS 的 text.length 对齐。
 * ============================================================================
 */

error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
@set_time_limit(300);

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
const RE_SHARE_XHS = '~(?:https?://)?www\.xiaohongshu\.com/discovery/item/\S+~i';
const RE_SHARE_RN  = '~(?:https?://)?www\.rednote\.com/discovery/item/\S+~i';
const RE_LINK_XHS  = '~(?:https?://)?www\.xiaohongshu\.com/explore/\S+~i';
const RE_LINK_RN   = '~(?:https?://)?www\.rednote\.com/explore/\S+~i';
const RE_USER_XHS  = '~(?:https?://)?www\.xiaohongshu\.com/user/profile/[a-z0-9]+/\S+~i';
const RE_USER_RN   = '~(?:https?://)?www\.rednote\.com/user/profile/[a-z0-9]+/\S+~i';
const RE_SHORT     = '~(?:https?://)?xhslink\.(?:com|cn)/[^\s"<>\\\\^`{|}，。；！？、【】《》]+~i';
const RE_ID        = '~(?:explore|item)/(\S+)?\?~';
const RE_ID_USER   = '~user/profile/[a-z0-9]+/(\S+)?\?~';

const DEFAULT_NAME_FORMAT = '发布时间 作者昵称 作品标题';
const NAME_KEYS = [
    '收藏数量', '评论数量', '分享数量', '点赞数量', '作品标签', '作品ID',
    '作品标题', '作品描述', '作品类型', '发布时间', '最后更新时间',
    '作者昵称', '作者ID',
];
const NAME_SEPARATOR = '_';

// Manager.NAME: characters kept when filtering an author nickname.
const AUTHOR_NAME_RE = '~[^\x{4E00}-\x{9FFF}a-zA-Z0-9\-_！？，。；：“”（）《》]~u';

const IMAGE_FORMATS = ['auto', 'png', 'webp', 'jpeg', 'heic', 'avif'];
const VIDEO_PREFERENCES = ['resolution', 'bitrate', 'size'];

const MAX_RESPONSE_BYTES = 8388608;    // page HTML cap (8 MiB)
const THUMB_MAX_BYTES = 20971520;      // /api/thumb buffer cap (20 MiB)
const MAX_INPUT_CHARS = 16384;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRY = 2;

// curl_cffi impersonates chrome146 in static.py; a current desktop Chrome UA is
// the closest equivalent.
const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' .
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// static.py HEADERS
const HEADERS = [
    'accept' =>
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' .
        'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language' => 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'user-agent' => DESKTOP_UA,
];

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
const IMAGE_SUFFIXES = ['png', 'jpeg', 'webp', 'avif', 'heic', 'gif'];
const IMAGE_MIME_BY_SUFFIX = [
    'png' => 'image/png',
    'jpeg' => 'image/jpeg',
    'webp' => 'image/webp',
    'avif' => 'image/avif',
    'heic' => 'image/heic',
    'gif' => 'image/gif',
];

// Only these hosts may be reached through /dl, /api/probe and /api/thumb.
const MEDIA_HOST_SUFFIXES = ['xhscdn.com', 'xiaohongshu.com', 'rednote.com'];

const CORS_HEADERS = [
    'Access-Control-Allow-Origin' => '*',
    'Access-Control-Allow-Methods' => 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers' => 'Content-Type',
];

// Deployment: put this file anywhere — the site root, or a subdirectory such as
// /api/xhs/. The mount path is detected from SCRIPT_NAME, and the built-in page
// always calls the front controller through its own URL (`index.php?route=…`),
// so no rewrite rule is needed. Only set this when auto-detection cannot work
// (for example a rewrite that reports SCRIPT_NAME as the host root's index.php):
//   const BASE_PATH_OVERRIDE = '/api/xhs';
const BASE_PATH_OVERRIDE = '';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The Worker port's `ParseError` carries a machine-readable code plus optional
 * detail. PHP already has a built-in \ParseError class, hence the prefixed name.
 */
class XhsParseError extends Exception
{
    /** @var string */
    public $errorCode;
    /** @var mixed */
    public $detail;

    public function __construct($code, $message, $detail = null)
    {
        parent::__construct((string)$message);
        $this->errorCode = (string)$code;
        $this->detail = $detail;
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** JS truthiness (`[]` and `{}` are truthy in JS, `"0"` is not falsy). */
function jsTruthy($v)
{
    if ($v === null || $v === false) return false;
    if ($v === '' || $v === 0 || $v === 0.0) return false;
    if (is_float($v) && is_nan($v)) return false;
    return true;
}

/** JS `a || b` (keeps `"0"` and empty arrays). */
function jsOr($a, $b)
{
    return jsTruthy($a) ? $a : $b;
}

/** A PHP list (JSON array) vs a PHP map (JSON object). */
function isListArr($v)
{
    if (!is_array($v)) return false;
    if ($v === []) return true;
    return array_keys($v) === range(0, count($v) - 1);
}

/** JS `isObj`: an object that is not an array. */
function isObjMap($v)
{
    return is_array($v) && ($v === [] || !isListArr($v));
}

/** JS number semantics: integral floats become ints so JSON stays `1`, not `1.0`. */
function floatToNum($f)
{
    if (!is_finite($f)) return $f;
    if (floor($f) === $f && abs($f) < 9007199254740992.0) return (int)$f;
    return $f;
}

/** JS `Number(value)`, with `$fallback` when the value is not numeric. */
function numOr($value, $fallback)
{
    if (is_int($value)) return $value;
    if (is_float($value)) {
        if (is_nan($value) || is_infinite($value)) return $fallback;
        return $value;
    }
    if (is_bool($value)) return $value ? 1 : 0;
    if (is_string($value)) {
        $trimmed = trim($value);
        if ($trimmed === '') return 0;
        if (is_numeric($trimmed)) return floatToNum((float)$trimmed);
        return $fallback;
    }
    return $fallback;
}

/** JS `String(value)` for the scalar cases this pipeline actually meets. */
function jsString($v)
{
    if ($v === null) return '';
    if (is_bool($v)) return $v ? 'true' : 'false';
    if (is_scalar($v)) return (string)$v;
    if (is_array($v)) return isListArr($v) ? implode(',', array_map('jsString', $v)) : '[object Object]';
    return '[object Object]';
}

/** Split a UTF-8 string into characters (JS `for (const ch of str)`). */
function utf8Chars($value)
{
    $chars = preg_split('//u', (string)$value, -1, PREG_SPLIT_NO_EMPTY);
    if ($chars === false || $chars === null) {
        return str_split((string)$value === '' ? '' : (string)$value, 1) ?: [];
    }
    return $chars;
}

/** `str.length` as JS sees it (UTF-16 code units) — used for the step counters. */
function jsStrLen($value)
{
    $value = (string)$value;
    if (function_exists('mb_strlen')) {
        $chars = mb_strlen($value, 'UTF-8');
        // Count astral characters twice, like JS UTF-16 length does.
        $astral = preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $value);
        return $chars + ($astral === false ? 0 : $astral);
    }
    return strlen($value);
}

/** `String(text).slice(0, n)` — n counted in JS code units. */
function jsStrSlice($value, $limit)
{
    $value = (string)$value;
    if (jsStrLen($value) <= $limit) return $value;
    $out = '';
    $count = 0;
    foreach (utf8Chars($value) as $ch) {
        $count += (strlen($ch) > 3) ? 2 : 1;
        if ($count > $limit) break;
        $out .= $ch;
    }
    return $out;
}

/** Encode one Unicode code point as UTF-8 (no mbstring dependency). */
function utf8FromCodepoint($cp)
{
    $cp = (int)$cp;
    if ($cp < 0) return '';
    if ($cp < 0x80) return chr($cp);
    if ($cp < 0x800) {
        return chr(0xC0 | ($cp >> 6)) . chr(0x80 | ($cp & 0x3F));
    }
    if ($cp < 0x10000) {
        return chr(0xE0 | ($cp >> 12)) . chr(0x80 | (($cp >> 6) & 0x3F)) . chr(0x80 | ($cp & 0x3F));
    }
    if ($cp < 0x110000) {
        return chr(0xF0 | ($cp >> 18)) . chr(0x80 | (($cp >> 12) & 0x3F)) .
            chr(0x80 | (($cp >> 6) & 0x3F)) . chr(0x80 | ($cp & 0x3F));
    }
    return '';
}

/** preg_replace that never returns null (invalid UTF-8 input keeps the original). */
function reReplace($pattern, $replacement, $subject)
{
    if ($replacement === '') {
        $result = preg_replace($pattern, '', (string)$subject);
    } else {
        $result = preg_replace_callback($pattern, function () use ($replacement) {
            return $replacement;
        }, (string)$subject);
    }
    return $result === null ? (string)$subject : $result;
}

/** Python `Namespace.safe_extract`: dotted chain with `[n]` list indices. */
function safeExtract($root, $chain, $def = '')
{
    if ($root === null) return $def;
    $cur = $root;
    foreach (explode('.', (string)$chain) as $raw) {
        if ($raw === '') continue;
        $attr = $raw;
        $index = null;
        $bracket = strpos($raw, '[');
        if ($bracket !== false && substr($raw, -1) === ']') {
            $attr = substr($raw, 0, $bracket);
            $inner = substr($raw, $bracket + 1, -1);
            if (!preg_match('/^-?\d+$/', $inner)) return $def;
            $index = (int)$inner;
        }
        if ($attr !== '') {
            if (!is_array($cur)) return $def;
            if (!array_key_exists($attr, $cur)) return $def;
            $cur = $cur[$attr];
            // Mirrors the Python `if not data: return default` short circuit.
            if (!jsTruthy($cur)) return $def;
        }
        if ($index !== null) {
            if (!is_array($cur)) return $def;
            if (!array_key_exists($index, $cur)) return $def;
            $cur = $cur[$index];
            if ($cur === null) return $def;
        }
    }
    return jsTruthy($cur) ? $cur : $def;
}

function objectExtract($root, $chain, $def = '')
{
    return safeExtract($root, $chain, $def);
}

/**
 * Python `Converter.safe_get`: a list by index (negative counts from the end),
 * a map by value order. PHP keeps JSON insertion order, so one path covers both.
 */
function safeIndexGet($container, $index)
{
    if (is_array($container)) {
        $values = array_values($container);
        $n = count($values);
        $i = $index < 0 ? $n + $index : $index;
        return array_key_exists($i, $values) ? $values[$i] : null;
    }
    throw new Exception('safe_get: unsupported container type');
}

/** Python `Converter.deep_get`: plain keys, `[-1]` means "last value of the map". */
function deepGet($data, $keys, $def = null)
{
    if (!jsTruthy($data)) return $def;
    $cur = $data;
    try {
        foreach ($keys as $key) {
            if (substr($key, 0, 1) === '[' && substr($key, -1) === ']') {
                $cur = safeIndexGet($cur, (int)substr($key, 1, -1));
            } else {
                if (!is_array($cur)) return $def;
                if (!array_key_exists($key, $cur)) return $def;
                $cur = $cur[$key];
            }
            if ($cur === null) return $def;
        }
        return $cur;
    } catch (Throwable $e) {
        return $def;
    }
}

/**
 * Html.format_url: Python decodes `\uXXXX` escapes that xiaohongshu leaves in
 * some URLs. Only those escapes are rewritten (the Python `unicode_escape` pass
 * also mangles non-ASCII, which is never desirable here).
 */
function decodeUnicodeEscapes($value)
{
    if (!is_string($value) || strpos($value, '\\u') === false) return $value;
    // Surrogate pairs first, so an emoji survives as one code point.
    $value = preg_replace_callback(
        '/\\\\u(D[89abAB][0-9a-fA-F]{2})\\\\u(D[C-Fc-f][0-9a-fA-F]{2})/',
        function ($m) {
            $hi = hexdec($m[1]);
            $lo = hexdec($m[2]);
            return utf8FromCodepoint(0x10000 + (($hi - 0xD800) << 10) + ($lo - 0xDC00));
        },
        $value
    );
    return preg_replace_callback('/\\\\u([0-9a-fA-F]{4})/', function ($m) {
        return utf8FromCodepoint(hexdec($m[1]));
    }, $value);
}

function formatTimestamp($ms, $tzOffsetMinutes)
{
    $value = $ms;
    if (is_string($value) && is_numeric($value)) $value = (float)$value;
    if (!is_int($value) && !is_float($value)) return '未知';
    if (is_float($value) && (!is_finite($value))) return '未知';
    // JS builds `new Date(value + tz*60000)` and reads the UTC fields back.
    $shifted = ($value + $tzOffsetMinutes * 60000) / 1000;
    return gmdate('Y-m-d_H:i:s', (int)floor($shifted));
}

function formatBytes($bytes)
{
    if (!is_int($bytes) && !is_float($bytes)) return '大小未知';
    if (is_float($bytes) && (!is_finite($bytes))) return '大小未知';
    if ($bytes < 0) return '大小未知';
    if ($bytes < 1024) return $bytes . 'B';
    $kb = $bytes / 1024;
    if ($kb < 1024) return number_format($kb, 1, '.', '') . 'KB';
    $mb = $kb / 1024;
    if ($mb < 1024) return number_format($mb, 1, '.', '') . 'MB';
    return number_format($mb / 1024, 2, '.', '') . 'GB';
}

function normalizeUrl($raw)
{
    $value = trim(jsString($raw === null ? '' : $raw));
    return preg_match('~^https?://~i', $value) ? $value : 'https://' . $value;
}

/** tools.get_site_referer */
function siteReferer($url)
{
    return strpos(strtolower(jsString($url)), 'rednote') !== false
        ? REDNOTE_ORIGIN . '/'
        : XHS_ORIGIN . '/';
}

// ---------------------------------------------------------------------------
// Tolerant JSON / JS-object reader
//
// `window.__INITIAL_STATE__` is a JS object literal: bare keys, single quotes,
// `undefined`, stray and trailing commas. The Python project rewrites it into
// YAML and lets PyYAML absorb all of that; this reader does the same job without
// rewriting text inside string values.
// ---------------------------------------------------------------------------

final class JsonLikeParser
{
    private $s = '';
    private $n = 0;
    private $i = 0;

    public function parse($text)
    {
        // Byte-wise scanning is safe: every structural character is ASCII and
        // UTF-8 continuation bytes are always >= 0x80.
        $this->s = (string)$text;
        $this->n = strlen($this->s);
        $this->i = 0;
        return $this->parseValue();
    }

    private function fail($msg)
    {
        throw new Exception('JSON-like parse error: ' . $msg . ' @' . $this->i);
    }

    private function skipWs()
    {
        while ($this->i < $this->n) {
            $c = ord($this->s[$this->i]);
            if ($c === 32 || $c === 9 || $c === 10 || $c === 13 || $c === 11 || $c === 12) {
                $this->i++;
            } else {
                break;
            }
        }
    }

    private function parseString($quote)
    {
        $this->i++;
        $out = '';
        while ($this->i < $this->n) {
            $ch = $this->s[$this->i];
            if ($ch === '\\') {
                $this->i++;
                if ($this->i >= $this->n) $this->fail('unterminated escape');
                $esc = $this->s[$this->i];
                switch ($esc) {
                    case 'n': $out .= "\n"; $this->i++; break;
                    case 't': $out .= "\t"; $this->i++; break;
                    case 'r': $out .= "\r"; $this->i++; break;
                    case 'b': $out .= "\x08"; $this->i++; break;
                    case 'f': $out .= "\x0C"; $this->i++; break;
                    case 'v': $out .= "\x0B"; $this->i++; break;
                    case '0': $out .= "\x00"; $this->i++; break;
                    case 'u':
                        $hex = substr($this->s, $this->i + 1, 4);
                        if (preg_match('/^[0-9a-fA-F]{4}$/', $hex)) {
                            $cp = hexdec($hex);
                            $this->i += 5;
                            if ($cp >= 0xD800 && $cp <= 0xDBFF && substr($this->s, $this->i, 2) === '\\u') {
                                $hex2 = substr($this->s, $this->i + 2, 4);
                                if (preg_match('/^[0-9a-fA-F]{4}$/', $hex2)) {
                                    $lo = hexdec($hex2);
                                    if ($lo >= 0xDC00 && $lo <= 0xDFFF) {
                                        $cp = 0x10000 + (($cp - 0xD800) << 10) + ($lo - 0xDC00);
                                        $this->i += 6;
                                    }
                                }
                            }
                            $out .= utf8FromCodepoint($cp);
                        } else {
                            $out .= 'u';
                            $this->i++;
                        }
                        break;
                    case 'x':
                        $hex = substr($this->s, $this->i + 1, 2);
                        if (preg_match('/^[0-9a-fA-F]{2}$/', $hex)) {
                            $out .= utf8FromCodepoint(hexdec($hex));
                            $this->i += 3;
                        } else {
                            $out .= 'x';
                            $this->i++;
                        }
                        break;
                    default:
                        $out .= $esc;
                        $this->i++;
                        break;
                }
                continue;
            }
            if ($ch === $quote) {
                $this->i++;
                return $out;
            }
            $out .= $ch;
            $this->i++;
        }
        $this->fail('unterminated string');
        return $out;
    }

    private function parseBareKey()
    {
        $start = $this->i;
        while ($this->i < $this->n) {
            $ch = $this->s[$this->i];
            if ($ch === ':' || $ch === ',' || $ch === '}' || $ch === '{' || $ch === '[' ||
                $ch === ']' || $ch === ' ' || $ch === "\t" || $ch === "\n" || $ch === "\r") {
                break;
            }
            $this->i++;
        }
        return trim(substr($this->s, $start, $this->i - $start));
    }

    private function parseNumber()
    {
        $start = $this->i;
        if ($this->s[$this->i] === '+' || $this->s[$this->i] === '-') $this->i++;
        while ($this->i < $this->n && preg_match('/[0-9eE+\-.]/', $this->s[$this->i])) $this->i++;
        $literal = substr($this->s, $start, $this->i - $start);
        if ($literal === '' || !is_numeric($literal)) return null;
        return floatToNum((float)$literal);
    }

    private function parseIdentifier()
    {
        $start = $this->i;
        while ($this->i < $this->n && preg_match('/[A-Za-z0-9_$]/', $this->s[$this->i])) $this->i++;
        $id = substr($this->s, $start, $this->i - $start);
        if ($id === 'true') return true;
        if ($id === 'false') return false;
        // null / undefined / NaN / Infinity / any other JS identifier -> null,
        // matching what the YAML detour produced for `undefined`.
        return null;
    }

    private function parseValue()
    {
        $this->skipWs();
        if ($this->i >= $this->n) $this->fail('unexpected end of input');
        $ch = $this->s[$this->i];
        if ($ch === '{') return $this->parseObject();
        if ($ch === '[') return $this->parseArray();
        if ($ch === '"' || $ch === "'") return $this->parseString($ch);
        if ($ch === '-' || $ch === '+' || $ch === '.' || preg_match('/[0-9]/', $ch)) {
            return $this->parseNumber();
        }
        if (preg_match('/[A-Za-z_$]/', $ch)) return $this->parseIdentifier();
        $this->fail('unexpected character ' . json_encode($ch));
        return null;
    }

    private function parseObject()
    {
        $this->i++;
        $out = [];
        for (;;) {
            $this->skipWs();
            if ($this->i >= $this->n) $this->fail('unterminated object');
            if ($this->s[$this->i] === '}') { $this->i++; return $out; }
            if ($this->s[$this->i] === ',') { $this->i++; continue; }   // stray / trailing comma
            $key = ($this->s[$this->i] === '"' || $this->s[$this->i] === "'")
                ? $this->parseString($this->s[$this->i])
                : $this->parseBareKey();
            $this->skipWs();
            if ($this->i < $this->n && $this->s[$this->i] === ':') {
                $this->i++;
                $out[$key] = $this->parseValue();
            } elseif ($this->i >= $this->n || $this->s[$this->i] === ',' || $this->s[$this->i] === '}') {
                $out[$key] = null;                     // `{a, b}` shorthand
            } else {
                $this->fail('expected ":" after key ' . json_encode($key));
            }
            $this->skipWs();
            if ($this->i < $this->n && $this->s[$this->i] === ',') { $this->i++; continue; }
            if ($this->i < $this->n && $this->s[$this->i] === '}') { $this->i++; return $out; }
            if ($this->i >= $this->n) $this->fail('unterminated object');
            $this->fail('expected "," or "}"');
        }
        return $out;
    }

    private function parseArray()
    {
        $this->i++;
        $out = [];
        for (;;) {
            $this->skipWs();
            if ($this->i >= $this->n) $this->fail('unterminated array');
            if ($this->s[$this->i] === ']') { $this->i++; return $out; }
            if ($this->s[$this->i] === ',') { $this->i++; continue; }   // stray / trailing comma
            $out[] = $this->parseValue();
            $this->skipWs();
            if ($this->i < $this->n && $this->s[$this->i] === ',') { $this->i++; continue; }
            if ($this->i < $this->n && $this->s[$this->i] === ']') { $this->i++; return $out; }
            if ($this->i >= $this->n) $this->fail('unterminated array');
            $this->fail('expected "," or "]"');
        }
        return $out;
    }
}

function parseJsonLike($text)
{
    $parser = new JsonLikeParser();
    return $parser->parse($text);
}

// ---------------------------------------------------------------------------
// Converter.run — HTML -> note object
// ---------------------------------------------------------------------------

const PHONE_KEYS_LINK = ['noteData', 'data', 'noteData'];
const PC_KEYS_LINK = ['note', 'noteDetailMap', '[-1]', 'note'];

/** All `<script>` bodies, in document order (the lxml `//script/text()` result). */
function extractScriptTexts($html)
{
    $scripts = [];
    if (preg_match_all('~<script\b[^>]*>(.*?)</script>~is', (string)$html, $m)) {
        foreach ($m[1] as $body) $scripts[] = $body;
    }
    return $scripts;
}

/** `Converter.get_script`: the last script that starts with the state marker. */
function pickInitialStateScript($html)
{
    $scripts = extractScriptTexts($html);
    for ($i = count($scripts) - 1; $i >= 0; $i--) {
        $text = trim($scripts[$i]);
        if (strncmp($text, 'window.__INITIAL_STATE__', 24) === 0) return $text;
    }
    return '';
}

/** `Converter._convert_object` + `_extract_object` for one HTML document. */
function parseInitialState($html)
{
    $script = pickInitialStateScript($html);
    if ($script === '') return null;
    $body = preg_replace('~^window\.__INITIAL_STATE__\s*=\s*~', '', $script);
    $body = preg_replace('~;+\s*$~', '', $body);
    // Python: .replace("new Map([])", "[]") — regex form also covers `new Map()`.
    $body = preg_replace('~new Map\(\s*\[\s*\]\s*\)~', '[]', $body);
    $body = preg_replace('~new Map\(\s*\)~', '[]', $body);
    $decoded = json_decode($body, true);
    if (json_last_error() === JSON_ERROR_NONE) return $decoded;
    return parseJsonLike($body);
}

/**
 * `Converter._filter_object`: phone shape, then PC shape.
 * Improvement over the original: when the requested note id is present in
 * `noteDetailMap`, that exact entry wins instead of blindly taking the last one.
 */
function filterNoteObject($state, $preferredNoteId)
{
    $phone = deepGet($state, PHONE_KEYS_LINK);
    if (jsTruthy($phone) && isObjMap($phone) && count($phone)) return $phone;
    if ($preferredNoteId && is_array($state) &&
        isObjMap($state['note'] ?? null) && isObjMap($state['note']['noteDetailMap'] ?? null)) {
        $hit = $state['note']['noteDetailMap'][$preferredNoteId] ?? null;
        if (jsTruthy($hit) && isObjMap($hit['note'] ?? null)) return $hit['note'];
    }
    $pc = deepGet($state, PC_KEYS_LINK);
    return (jsTruthy($pc) && isObjMap($pc)) ? $pc : null;
}

// ---------------------------------------------------------------------------
// Explore.run — note object -> the Chinese-keyed data dict
// ---------------------------------------------------------------------------

function arraySomeTruthy($arr)
{
    foreach ($arr as $v) {
        if (jsTruthy($v)) return true;
    }
    return false;
}

function classifyWorks($data)
{
    $type = safeExtract($data, 'type');
    $list = safeExtract($data, 'imageList', []);
    $items = is_array($list) ? $list : [];
    if (($type !== 'video' && $type !== 'normal') || count($items) === 0) return '未知';
    if ($type === 'video') return count($items) === 1 ? '视频' : '图集';
    return '图文';
}

function exploreRun($data, $tzOffsetMinutes = 480)
{
    if (!jsTruthy($data) || !isObjMap($data) || count($data) === 0) return [];
    $result = [];

    // __extract_interact_info
    $result['收藏数量'] = safeExtract($data, 'interactInfo.collectedCount', '-1');
    $result['评论数量'] = safeExtract($data, 'interactInfo.commentCount', '-1');
    $result['分享数量'] = safeExtract($data, 'interactInfo.shareCount', '-1');
    $result['点赞数量'] = safeExtract($data, 'interactInfo.likedCount', '-1');

    // __extract_tags
    $tags = safeExtract($data, 'tagList', []);
    $tagNames = [];
    foreach ((is_array($tags) ? $tags : []) as $tag) {
        $tagNames[] = jsString(objectExtract($tag, 'name'));
    }
    $result['作品标签'] = implode(' ', $tagNames);

    // __extract_info
    $result['作品ID'] = safeExtract($data, 'noteId');
    $result['作品链接'] = XHS_ORIGIN . '/explore/' . $result['作品ID'];
    $result['作品标题'] = safeExtract($data, 'title');
    $result['作品描述'] = safeExtract($data, 'desc');
    $result['作品类型'] = classifyWorks($data);

    // __extract_time
    $time = safeExtract($data, 'time');
    $lastUpdate = safeExtract($data, 'lastUpdateTime');
    $result['发布时间'] = jsTruthy($time) ? formatTimestamp($time, $tzOffsetMinutes) : '未知';
    $result['最后更新时间'] = jsTruthy($lastUpdate) ? formatTimestamp($lastUpdate, $tzOffsetMinutes) : '未知';
    $result['时间戳'] = jsTruthy($time) ? floatToNum($time / 1000) : null;

    // __extract_user
    $nickname = safeExtract($data, 'user.nickname');
    if (!jsTruthy($nickname)) $nickname = safeExtract($data, 'user.nickName');
    $result['作者昵称'] = $nickname;
    $result['作者ID'] = safeExtract($data, 'user.userId');
    $result['作者链接'] = XHS_ORIGIN . '/user/profile/' . $result['作者ID'];

    return $result;
}

// ---------------------------------------------------------------------------
// Image.get_image_link
// ---------------------------------------------------------------------------

/** `Image.__extract_image_token`: keep path segments from the 6th on, drop `!…`. */
function extractImageToken($url)
{
    if (!is_string($url) || $url === '') return '';
    $parts = explode('/', $url);
    $tail = implode('/', array_slice($parts, 5));
    $bang = explode('!', $tail);
    return $bang[0];
}

function generateAutoImageLink($token)
{
    return SNS_IMG_BASE . '/' . $token;
}

function generateFixedImageLink($token, $format)
{
    return CI_IMG_BASE . '/' . $token . '?imageView2/format/' . $format;
}

/** `Image.__get_live_link`: per-image livePhoto URL (backupUrls[0] or masterUrl). */
function getLiveLinks($items)
{
    $result = [];
    foreach ($items as $item) {
        $url = null;
        $stream = objectExtract($item, 'stream', []);
        $keys = isObjMap($stream) ? array_keys($stream) : [];
        foreach ($keys as $key) {
            $candidate = jsOr(
                objectExtract($stream, $key . '[0].backupUrls[0]'),
                objectExtract($stream, $key . '[0].masterUrl')
            );
            $formatted = jsTruthy($candidate) ? decodeUnicodeEscapes($candidate) : '';
            if (jsTruthy($formatted)) {
                $url = $formatted;
                break;
            }
            $url = null;
        }
        $result[] = $url;
    }
    return $result;
}

function getImagePlan($data, $imageFormat)
{
    $list = safeExtract($data, 'imageList', []);
    $items = is_array($list) ? $list : [];
    $liveLinks = getLiveLinks($items);
    $tokens = [];
    foreach ($items as $item) {
        $tokens[] = extractImageToken(objectExtract($item, 'urlDefault'));
    }
    if (!arraySomeTruthy($tokens)) {
        $tokens = [];
        foreach ($items as $item) {
            $tokens[] = extractImageToken(objectExtract($item, 'url'));
        }
    }
    $urls = [];
    foreach ($tokens as $token) {
        $urls[] = decodeUnicodeEscapes(
            $imageFormat === 'auto'
                ? generateAutoImageLink($token)
                : generateFixedImageLink($token, $imageFormat)
        );
    }
    return ['urls' => $urls, 'liveLinks' => $liveLinks, 'tokens' => $tokens];
}

// ---------------------------------------------------------------------------
// Video.deal_video_link
// ---------------------------------------------------------------------------

const VIDEO_LINK_KEYS = 'video.consumer.originVideoKey';

function videoHeight($item)
{
    return numOr($item['height'] ?? null, -INF);
}

function videoBitrate($item)
{
    $value = array_key_exists('videoBitrate', $item) ? $item['videoBitrate'] : ($item['video_bitrate'] ?? null);
    return numOr($value, -INF);
}

function videoSize($item)
{
    $value = array_key_exists('size', $item) ? $item['size'] : ($item['fileSize'] ?? null);
    return numOr($value, -INF);
}

/** `Video.generate_video_link`: the original master file, when the page exposes it. */
function generateVideoLink($data)
{
    $key = safeExtract($data, VIDEO_LINK_KEYS);
    return jsTruthy($key) ? [decodeUnicodeEscapes(SNS_VIDEO_BASE . '/' . $key)] : [];
}

/** `Video.get_video_items`: flatten every `video.media.stream.<codec>[]` entry. */
function getVideoItems($data)
{
    $stream = safeExtract($data, 'video.media.stream');
    if (!isObjMap($stream)) return [];
    $items = [];
    foreach (array_keys($stream) as $key) {
        $group = safeExtract($data, 'video.media.stream.' . $key, []);
        if (is_array($group) && isListArr($group)) {
            foreach ($group as $entry) $items[] = $entry;
        }
    }
    return $items;
}

function videoCandidateInfo($item)
{
    $bitrate = videoBitrate($item);
    $size = videoSize($item);
    $codec = $item['videoCodec'] ?? ($item['codec'] ?? '');
    return [
        'codec' => jsString($codec),
        'width' => numOr($item['width'] ?? null, 0),
        'height' => numOr($item['height'] ?? null, 0),
        'videoBitrate' => $bitrate === -INF ? null : $bitrate,
        'size' => $size === -INF ? null : $size,
    ];
}

function getVideoPlan($data, $preference)
{
    $generated = generateVideoLink($data);
    if (count($generated)) {
        return ['urls' => $generated, 'strategy' => 'originVideoKey', 'chosen' => null, 'candidates' => []];
    }
    $items = getVideoItems($data);
    if (!count($items)) return ['urls' => [], 'strategy' => 'none', 'chosen' => null, 'candidates' => []];
    $keyFn = $preference === 'bitrate' ? 'videoBitrate' : ($preference === 'size' ? 'videoSize' : 'videoHeight');
    $sorted = array_values($items);
    usort($sorted, function ($a, $b) use ($keyFn) {
        $ka = $keyFn($a);
        $kb = $keyFn($b);
        if ($ka == $kb) return 0;
        return ($ka < $kb) ? -1 : 1;
    });
    $best = $sorted[count($sorted) - 1];
    $backup = $best['backupUrls'] ?? null;
    if (is_array($backup) && count($backup)) {
        $urls = [decodeUnicodeEscapes($backup[0])];
    } else {
        $urls = jsTruthy($best['masterUrl'] ?? null) ? [decodeUnicodeEscapes($best['masterUrl'])] : [];
    }
    $candidates = [];
    foreach ($sorted as $item) $candidates[] = videoCandidateInfo($item);
    return [
        'urls' => $urls,
        'strategy' => 'media.stream',
        'preference' => $preference,
        'chosen' => videoCandidateInfo($best),
        'candidates' => $candidates,
    ];
}

// ---------------------------------------------------------------------------
// Cleaner / Manager name handling and app naming rules
// ---------------------------------------------------------------------------

const CONTROL_CHARS_RE = '~[\x00-\x1F\x7F]~';
const ILLEGAL_NAME_CHARS = ['/', '\\', '|', '<', '>', '"', '?', ':', '*', "\x00"];
// string.whitespace[1:] — the newline-ish characters folded into the rule dict.
const WHITESPACE_ILLEGAL = ["\t", "\n", "\r", "\x0b", "\x0c"];

// Approximation of `emoji.replace_emoji` (the RGI emoji blocks plus the common
// symbol ranges and the joiners).
const EMOJI_RE =
    '~[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}\x{200D}' .
    '\x{20E3}\x{2122}\x{00A9}\x{00AE}\x{2139}\x{3030}\x{303D}\x{3297}\x{3299}]~u';

// Approximation of `is_chinese_char` (unicodedata name containing "CJK"), which
// counts a character as two units when truncating file names.
const WIDE_CHAR_RE =
    '~[\x{2E80}-\x{2EFF}\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}' .
    '\x{20000}-\x{2FA1F}]~u';

function removeControlCharacters($text)
{
    return reReplace(CONTROL_CHARS_RE, '', jsString($text === null ? '' : $text));
}

function clearSpaces($text)
{
    $parts = preg_split('/\s+/', jsString($text), -1, PREG_SPLIT_NO_EMPTY);
    return $parts === false ? '' : implode(' ', $parts);
}

/** Cleaner.filter_name */
function cleanerFilterName($text, $replace = '', $def = '')
{
    $value = str_replace(':', '.', jsString($text));
    $value = removeControlCharacters($value);
    foreach (ILLEGAL_NAME_CHARS as $ch) $value = str_replace($ch, '', $value);
    foreach (WHITESPACE_ILLEGAL as $ch) $value = str_replace($ch, '', $value);
    $value = reReplace(EMOJI_RE, $replace, $value);
    $value = clearSpaces($value);
    $value = trim($value);
    $value = reReplace('~^\.+~', '', $value);
    $value = reReplace('~\.+$~', '', $value);
    $value = reReplace('~^_+~', '', $value);
    $value = reReplace('~_+$~', '', $value);
    return jsTruthy($value) ? $value : $def;
}

/** Manager.filter_name (author nickname → folder-safe token) */
function managerFilterName($name)
{
    $value = reReplace(AUTHOR_NAME_RE, '_', jsString($name === null ? '' : $name));
    $value = reReplace('~_+~', '_', $value);
    return reReplace('~^_+|_+$~', '', $value);
}

function isWideChar($ch)
{
    return preg_match(WIDE_CHAR_RE, $ch) === 1;
}

function truncateString($value, $length = 64)
{
    $count = 0;
    $result = '';
    foreach (utf8Chars($value) as $ch) {
        $count += isWideChar($ch) ? 2 : 1;
        if ($count > $length) break;
        $result .= $ch;
    }
    return $result;
}

/** truncate.beautify_string */
function beautifyString($value, $length = 64)
{
    $str = jsString($value === null ? '' : $value);
    $count = 0;
    $fits = true;
    foreach (utf8Chars($str) as $ch) {
        $count += isWideChar($ch) ? 2 : 1;
        if ($count > $length) {
            $fits = false;
            break;
        }
    }
    if ($fits) return $str;
    $half = (int)floor($length / 2);
    $start = truncateString($str, $half);
    $reversed = implode('', array_reverse(utf8Chars($str)));
    $end = implode('', array_reverse(utf8Chars(truncateString($reversed, $half))));
    return $start . '...' . $end;
}

function normalizeNameFormat($value)
{
    $format = (is_string($value) && trim($value) !== '') ? $value : DEFAULT_NAME_FORMAT;
    $keys = preg_split('/\s+/', $format, -1, PREG_SPLIT_NO_EMPTY);
    foreach (($keys === false ? [] : $keys) as $key) {
        if (!in_array($key, NAME_KEYS, true)) return DEFAULT_NAME_FORMAT;
    }
    return $format;
}

function normalizeImageFormat($value)
{
    $format = strtolower(jsString($value === null ? '' : $value));
    return in_array($format, IMAGE_FORMATS, true) ? $format : 'jpeg';
}

function normalizeVideoPreference($value)
{
    $pref = strtolower(jsString($value === null ? '' : $value));
    return in_array($pref, VIDEO_PREFERENCES, true) ? $pref : 'resolution';
}

/** XHS.__naming_rules + update_author_nickname's defaulting behaviour. */
function buildFileName($data, $nameFormat)
{
    $keys = preg_split('/\s+/', (string)$nameFormat, -1, PREG_SPLIT_NO_EMPTY);
    if ($keys === false) $keys = [];
    $values = [];
    foreach ($keys as $key) {
        if ($key === '发布时间') {
            $values[] = str_replace(':', '.', jsString($data['发布时间'] ?? null));
            continue;
        }
        if ($key === '作品标题') {
            $title = beautifyString(cleanerFilterName($data['作品标题'] ?? ''), 64);
            $values[] = jsTruthy($title) ? $title : ($data['作品ID'] ?? null);
            continue;
        }
        $values[] = $data[$key] ?? null;
    }
    $fallback = jsString($data['作者ID'] ?? null) . NAME_SEPARATOR . jsString($data['作品ID'] ?? null);
    $joined = implode(NAME_SEPARATOR, array_map('jsString', $values));
    return beautifyString(cleanerFilterName($joined, '', $fallback), 128);
}

// ---------------------------------------------------------------------------
// Request input helpers
// ---------------------------------------------------------------------------

/** A query-string parameter, or null when absent/not a plain string. */
function getParam($name)
{
    if (!isset($_GET[$name]) || !is_string($_GET[$name])) return null;
    return $_GET[$name];
}

function requestMethod()
{
    return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
}

function requestHeader($name)
{
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if ($name === 'content-type') $key = 'CONTENT_TYPE';
    if ($name === 'content-length') $key = 'CONTENT_LENGTH';
    return isset($_SERVER[$key]) && is_string($_SERVER[$key]) ? $_SERVER[$key] : '';
}

function currentFullUrl()
{
    $https = $_SERVER['HTTPS'] ?? '';
    $scheme = ($https !== '' && strtolower($https) !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host . ($_SERVER['REQUEST_URI'] ?? '/');
}

/**
 * The URL path of this very script, e.g. `/api/xhs/index.php`.
 *
 * The built-in web page always talks to the front controller through this exact
 * URL (`...index.php?route=/api/parse`), so it keeps working when the file sits
 * in a subdirectory and no rewrite rule is available.
 */
function scriptName()
{
    foreach (['SCRIPT_NAME', 'PHP_SELF'] as $key) {
        $value = $_SERVER[$key] ?? '';
        if (is_string($value) && $value !== '') return str_replace('\\', '/', $value);
    }
    return '';
}

function endpointUrl()
{
    $script = scriptName();
    if ($script !== '' && substr($script, -4) === '.php') return $script;
    $base = basePath();
    return ($base === '' ? '' : $base) . '/index.php';
}

/**
 * The directory this script is mounted at, or '' when it owns the site root.
 * Detected from SCRIPT_NAME and only trusted when REQUEST_URI really starts with
 * it, so a front-controller rewrite at the host root never yields a bogus prefix.
 */
function basePath()
{
    static $base = null;
    if ($base !== null) return $base;
    $base = '';
    $override = trim((string)BASE_PATH_OVERRIDE);
    if ($override !== '' && $override !== '/') {
        $base = '/' . trim($override, '/');
        return $base;
    }
    $script = scriptName();
    if ($script !== '') {
        $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');
        if ($dir !== '' && $dir !== '/' && $dir !== '.') {
            $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
            if (is_string($path) && strpos($path, $dir . '/') === 0) $base = $dir;
        }
    }
    return $base;
}

function normalizeRoute($path)
{
    if (!is_string($path) || $path === '') return '/';
    $path = preg_replace('~/+$~', '', $path);
    return $path === '' ? '/' : $path;
}

/**
 * Resolve the requested route. Three shapes are accepted, so the same file works
 * at the host root, in a subdirectory, behind a rewrite, or with no rewrite at all:
 *   1. `index.php?route=/api/parse`            — works on any server (the UI uses this)
 *   2. `/dir/index.php/api/parse`              — PATH_INFO form
 *   3. `/api/parse` or `/dir/api/parse`        — plain pretty path (root or mounted)
 */
function currentPath()
{
    $route = getParam('route');
    if (is_string($route) && $route !== '' && $route[0] === '/') return normalizeRoute($route);

    $uri = $_SERVER['REQUEST_URI'] ?? '/';
    $path = parse_url($uri, PHP_URL_PATH);
    if (!is_string($path) || $path === '') $path = '/';

    // PATH_INFO: the request path starts with this script's own URL.
    $script = scriptName();
    if ($script !== '' && strpos($path, $script) === 0) {
        $rest = substr($path, strlen($script));
        if ($rest !== '' && $rest[0] === '/') return normalizeRoute($rest);
    }

    $base = basePath();
    if ($base !== '' && ($path === $base || strpos($path, $base . '/') === 0)) {
        $path = substr($path, strlen($base));
    }
    return normalizeRoute($path);
}

// ---------------------------------------------------------------------------
// Risk control (风控)
//
// xiaohongshu answers datacenter IPs with a verification hop instead of the note
// page. The good news: the short-link redirect still carries the real target
// inside `redirectPath`, so the note URL can be recovered from it. When the
// platform keeps demanding verification, a specific `risk_control` error is
// returned instead of a confusing "no link".
// ---------------------------------------------------------------------------

const RISK_CONTROL_PATTERNS = [
    '/website-login/captcha',
    '/website-login',
    'verifyuuid=',
    'verifytype=',
];

const RISK_CONTROL_HINT =
    '请求被小红书风控拦截（要求安全验证）。Cloudflare Worker 的出口是数据中心 IP，比家用宽带更容易被拦截。' .
    '请在下方 Cookie 输入框粘贴小红书网页版 Cookie 后重试，或改用带 Cookie 的服务端环境请求。';

function isRiskControlUrl($raw)
{
    $value = strtolower(jsString($raw));
    if ($value === '') return false;
    foreach (RISK_CONTROL_PATTERNS as $pattern) {
        if (strpos($value, $pattern) !== false) return true;
    }
    return false;
}

function looksLikeRiskControlHtml($html)
{
    $value = jsString($html);
    if ($value === '') return false;
    return strpos($value, '/website-login/captcha') !== false ||
        strpos($value, 'verifyUuid') !== false ||
        strpos($value, '请完成安全验证') !== false;
}

/** The note-URL regexes, applied to one candidate string. */
function matchNoteUrl($candidate)
{
    $value = jsString($candidate);
    if ($value === '') return null;
    foreach ([RE_SHARE_XHS, RE_SHARE_RN, RE_LINK_XHS, RE_LINK_RN, RE_USER_XHS, RE_USER_RN] as $re) {
        if (preg_match($re, $value, $m)) return $m[0];
    }
    return null;
}

/** Pull the real note URL out of a `website-login/captcha?redirectPath=…` hop. */
function recoverNoteUrlFromRedirect($raw)
{
    $parsed = parse_url((string)$raw);
    if ($parsed === false || !isset($parsed['scheme'], $parsed['host'])) return '';
    $query = $parsed['query'] ?? '';
    if ($query === '') return '';
    parse_str($query, $params);
    foreach (['redirectPath', 'redirect_url', 'redirectUrl', 'redirect', 'url'] as $key) {
        if (!isset($params[$key]) || !is_string($params[$key])) continue;
        $value = $params[$key];
        if ($value === '') continue;
        // The target is sometimes double-encoded (`%253D` for `%3D`).
        for ($round = 0; $round < 3; $round++) {
            $match = matchNoteUrl($value);
            if ($match) return $match;
            $decoded = rawurldecode($value);
            if ($decoded === $value) break;
            $value = $decoded;
        }
    }
    return '';
}

/** Note pages are served over https; skip the extra http -> https hop. */
function preferHttpsForSite($rawUrl)
{
    $value = jsString($rawUrl);
    if (!preg_match('~^http://(www\.)?(xiaohongshu|rednote)\.com/~i', $value)) return $value;
    return preg_replace('~^http://~i', 'https://', $value);
}

function extractLinkId($rawUrl)
{
    $parsed = parse_url(normalizeUrl($rawUrl));
    if ($parsed === false) return '';
    $path = $parsed['path'] ?? '';
    $path = preg_replace('~/+$~', '', $path);
    $parts = explode('/', $path);
    $last = end($parts);
    return ($last === false || $last === null) ? '' : $last;
}

function extractIds($links)
{
    $ids = [];
    foreach ($links as $link) {
        if (preg_match(RE_ID, $link, $m)) {
            $ids[] = $m[1] ?? null;
            continue;
        }
        if (preg_match(RE_ID_USER, $link, $m)) $ids[] = $m[1] ?? null;
    }
    return $ids;
}

function cookieStrToDict($cookieString)
{
    $out = [];
    foreach (explode(';', jsString($cookieString)) as $part) {
        $trimmed = trim($part);
        if ($trimmed === '') continue;
        $eq = strpos($trimmed, '=');
        if ($eq === false || $eq <= 0) continue;
        $out[trim(substr($trimmed, 0, $eq))] = trim(substr($trimmed, $eq + 1));
    }
    return $out;
}

// ---------------------------------------------------------------------------
// HTTP layer (curl, with a stream-wrapper fallback)
// ---------------------------------------------------------------------------

function headerLines($headers)
{
    $lines = [];
    foreach ($headers as $k => $v) $lines[] = $k . ': ' . $v;
    return $lines;
}

/**
 * Best-effort CA bundle lookup. php.ini normally sets curl.cainfo/openssl.cafile;
 * when it does not (plain PHP zip installs on Windows are the common case) HTTPS
 * would fail with "unable to get local issuer certificate". Only used to resolve
 * a path that already exists — TLS verification stays on either way.
 */
function curlCaInfo()
{
    static $done = false;
    static $path = null;
    if ($done) return $path;
    $done = true;
    foreach (['curl.cainfo', 'openssl.cafile'] as $ini) {
        $value = ini_get($ini);
        if (is_string($value) && $value !== '' && is_file($value)) {
            $path = $value;
            return $path;
        }
    }
    $candidates = [];
    foreach (['CURL_CA_BUNDLE', 'SSL_CERT_FILE'] as $env) {
        $value = getenv($env);
        if (is_string($value) && $value !== '') $candidates[] = $value;
    }
    if (DIRECTORY_SEPARATOR === '\\') {
        $candidates[] = 'C:\\Windows\\System32\\curl-ca-bundle.crt';
        $candidates[] = 'C:\\Program Files\\Git\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt';
        $candidates[] = 'C:\\Program Files\\Git\\usr\\ssl\\certs\\ca-bundle.crt';
    } else {
        $candidates[] = '/etc/ssl/certs/ca-certificates.crt';
        $candidates[] = '/etc/pki/tls/certs/ca-bundle.crt';
        $candidates[] = '/etc/ssl/cert.pem';
    }
    foreach ($candidates as $candidate) {
        if (is_string($candidate) && $candidate !== '' && is_file($candidate)) {
            $path = $candidate;
            return $path;
        }
    }
    return $path;
}

function resolveUrl($base, $ref)
{
    if (preg_match('~^https?://~i', $ref)) return $ref;
    $p = parse_url($base);
    if ($p === false || !isset($p['scheme'], $p['host'])) return $ref;
    $root = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (substr($ref, 0, 1) === '/') return $root . $ref;
    $dir = isset($p['path']) ? preg_replace('~/[^/]*$~', '/', $p['path']) : '/';
    return $root . $dir . $ref;
}

/**
 * One GET request. Returns status, the final URL after redirects, the body and
 * a lower-cased response-header map. `$opts`: headOnly (bool), maxBytes (int).
 */
function httpGet($url, $headers = [], $timeoutMs = DEFAULT_TIMEOUT_MS, $opts = [])
{
    if (function_exists('curl_init')) {
        return httpGetCurl($url, $headers, $timeoutMs, !empty($opts['headOnly']), $opts['maxBytes'] ?? null);
    }
    return httpGetStream($url, $headers, $timeoutMs);
}

function httpGetCurl($url, $headers, $timeoutMs, $headOnly, $maxBytes)
{
    $ch = curl_init();
    if ($ch === false) throw new Exception('curl_init failed');
    $respHeaders = [];
    $body = '';
    $options = [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 10,
        CURLOPT_TIMEOUT_MS => (int)$timeoutMs,
        CURLOPT_CONNECTTIMEOUT_MS => (int)min($timeoutMs, 10000),
        CURLOPT_HTTPHEADER => headerLines($headers),
        CURLOPT_NOBODY => $headOnly,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders) {
            $len = strlen($line);
            $trim = trim($line);
            if ($trim === '') return $len;
            if (stripos($trim, 'HTTP/') === 0) {
                $respHeaders = [];
                return $len;
            }
            $pos = strpos($trim, ':');
            if ($pos !== false) {
                $k = strtolower(trim(substr($trim, 0, $pos)));
                $v = trim(substr($trim, $pos + 1));
                $respHeaders[$k] = isset($respHeaders[$k]) ? $respHeaders[$k] . ', ' . $v : $v;
            }
            return $len;
        },
    ];
    if (!array_key_exists('accept-encoding', $headers)) $options[CURLOPT_ENCODING] = '';
    $caInfo = curlCaInfo();
    if ($caInfo !== null) $options[CURLOPT_CAINFO] = $caInfo;
    if ($maxBytes !== null && !$headOnly) {
        $options[CURLOPT_RETURNTRANSFER] = false;
        $options[CURLOPT_WRITEFUNCTION] = function ($ch, $chunk) use (&$body, $maxBytes) {
            $body .= $chunk;
            if (strlen($body) > $maxBytes) return 0;   // abort: over the cap
            return strlen($chunk);
        };
    }
    curl_setopt_array($ch, $options);
    $result = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $effective = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    $errno = curl_errno($ch);
    $error = curl_error($ch);
    if ($result === false && $errno && $errno !== CURLE_WRITE_ERROR) {
        throw new Exception($error !== '' ? $error : ('curl error ' . $errno));
    }
    return [
        'status' => $status,
        'url' => $effective !== '' ? $effective : $url,
        'body' => $headOnly ? '' : $body,
        'headers' => $respHeaders,
    ];
}

function httpGetStream($url, $headers, $timeoutMs)
{
    $context = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => implode("\r\n", headerLines($headers)),
            'timeout' => max(1, (int)ceil($timeoutMs / 1000)),
            'follow_location' => 1,
            'max_redirects' => 10,
            'ignore_errors' => true,
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $body = @file_get_contents($url, false, $context);
    $status = 0;
    $respHeaders = [];
    $effective = $url;
    // PHP 8.5 deprecates the magic $http_response_header local in favour of
    // http_get_last_response_headers(); get_defined_vars() keeps this file free
    // of both the direct reference and a version check on every branch.
    if (function_exists('http_get_last_response_headers')) {
        $rawHeaders = http_get_last_response_headers();
        if (!is_array($rawHeaders)) $rawHeaders = [];
    } else {
        $locals = get_defined_vars();
        $rawHeaders = isset($locals['http_response_header']) && is_array($locals['http_response_header'])
            ? $locals['http_response_header']
            : [];
    }
    if ($rawHeaders) {
        foreach ($rawHeaders as $line) {
            $trim = trim($line);
            if ($trim === '') continue;
            if (preg_match('~^HTTP/\S+\s+(\d+)~i', $trim, $m)) {
                $status = (int)$m[1];
                $respHeaders = [];
                continue;
            }
            $pos = strpos($trim, ':');
            if ($pos === false) continue;
            $k = strtolower(trim(substr($trim, 0, $pos)));
            $v = trim(substr($trim, $pos + 1));
            if ($k === 'location') $effective = resolveUrl($effective, $v);
            $respHeaders[$k] = $v;
        }
    }
    if ($body === false) throw new Exception('stream request failed');
    return ['status' => $status, 'url' => $effective, 'body' => $body, 'headers' => $respHeaders];
}

/**
 * Html.request_url with the tools.retry wrapper: retries on failure and returns
 * the final URL when `content` is false (used to resolve xhslink short links).
 */
function requestUrl($rawUrl, $options = [])
{
    $target = normalizeUrl($rawUrl);
    $headers = HEADERS;
    $headers['referer'] = siteReferer($target);
    if (!empty($options['cookie'])) $headers['cookie'] = $options['cookie'];
    $timeoutMs = $options['timeoutMs'] ?? DEFAULT_TIMEOUT_MS;
    $wantContent = !array_key_exists('content', $options) || $options['content'] !== false;
    $attempts = ((int)($options['maxRetry'] ?? DEFAULT_MAX_RETRY)) + 1;
    $lastError = null;
    for ($attempt = 0; $attempt < $attempts; $attempt++) {
        try {
            if ($wantContent) {
                $response = httpGet($target, $headers, $timeoutMs, ['maxBytes' => MAX_RESPONSE_BYTES + 1]);
            } else {
                $response = httpGet($target, $headers, $timeoutMs, ['headOnly' => true]);
                if ($response['status'] >= 400) {
                    $response = httpGet($target, $headers, $timeoutMs, ['maxBytes' => MAX_RESPONSE_BYTES + 1]);
                }
            }
            if ($response['status'] < 200 || $response['status'] >= 300) {
                $lastError = new Exception('HTTP ' . $response['status']);
            } elseif (!$wantContent) {
                return ['url' => $response['url'], 'text' => ''];
            } else {
                if (strlen($response['body']) > MAX_RESPONSE_BYTES) {
                    throw new XhsParseError('response_too_large', '页面响应超过安全上限（8 MiB）');
                }
                return ['url' => $response['url'], 'text' => $response['body']];
            }
        } catch (XhsParseError $e) {
            throw $e;
        } catch (Throwable $e) {
            $lastError = $e;
        }
        if ($attempt + 1 < $attempts) usleep(300000 * ($attempt + 1));
    }
    throw new XhsParseError(
        'request_failed',
        '网络异常，请求失败：' . ($lastError !== null ? $lastError->getMessage() : '未知错误')
    );
}

/** XHS.extract_links — resolve short links, then pick out supported note URLs. */
function extractXhsLinks($input, &$steps, $options = [])
{
    $urls = [];
    $tokens = preg_split('/\s+/', (string)$input, -1, PREG_SPLIT_NO_EMPTY);
    foreach (($tokens === false ? [] : $tokens) as $token) {
        if ($token === '') continue;
        $current = $token;
        if (preg_match(RE_SHORT, $current, $short)) {
            $steps[] = '解析短链接：' . $short[0];
            $resolveOptions = $options;
            $resolveOptions['content'] = false;
            $resolved = requestUrl($short[0], $resolveOptions);
            $current = $resolved['url'] !== '' ? $resolved['url'] : '';
            $steps[] = '短链接跳转至：' . $current;
        }
        $match = matchNoteUrl($current);
        if (!$match && isRiskControlUrl($current)) {
            // A verification hop: the real target rides along inside `redirectPath`.
            $recovered = recoverNoteUrlFromRedirect($current);
            if ($recovered !== '') {
                $steps[] = '跳转被风控拦截（要求安全验证），已从 redirectPath 还原作品链接：' . $recovered;
                $current = $recovered;
                $match = matchNoteUrl($current);
            } else {
                $steps[] = '跳转被风控拦截（要求安全验证），redirectPath 中未找到作品链接';
            }
        }
        // Also covers a pasted verification URL that wraps the note link.
        if (!$match) $match = matchNoteUrl(recoverNoteUrlFromRedirect($token));
        if ($match) $urls[] = $match;
    }
    return $urls;
}

// ---------------------------------------------------------------------------
// Media URL validation + probing
// ---------------------------------------------------------------------------

function isPrivateHost($host)
{
    $h = strtolower(jsString($host));
    if ($h === '') return true;
    if ($h === 'localhost' || substr($h, -10) === '.localhost' || substr($h, -6) === '.local') return true;
    if ($h === '0.0.0.0' || $h === '[::]' || $h === '::1') return true;
    if (preg_match('/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/', $h, $v4)) {
        $a = (int)$v4[1];
        $b = (int)$v4[2];
        if ($a === 10 || $a === 127 || $a === 0) return true;
        if ($a === 169 && $b === 254) return true;
        if ($a === 172 && $b >= 16 && $b <= 31) return true;
        if ($a === 192 && $b === 168) return true;
        return false;
    }
    return false;
}

function hostAllowed($host)
{
    $h = strtolower(jsString($host));
    foreach (MEDIA_HOST_SUFFIXES as $suffix) {
        if ($h === $suffix || substr($h, -strlen('.' . $suffix)) === '.' . $suffix) return true;
    }
    return false;
}

function validateMediaUrl($raw)
{
    $parsed = parse_url((string)$raw);
    if ($parsed === false || !isset($parsed['scheme'], $parsed['host']) || $parsed['host'] === '') {
        throw new XhsParseError('bad_media_url', '地址不是合法 URL');
    }
    $scheme = strtolower($parsed['scheme']);
    if ($scheme !== 'https' && $scheme !== 'http') {
        throw new XhsParseError('bad_media_url', '仅支持 http/https 地址');
    }
    $host = $parsed['host'];
    if (isPrivateHost($host)) {
        throw new XhsParseError('bad_media_url', '拒绝访问内网地址');
    }
    if (!hostAllowed($host)) {
        throw new XhsParseError('bad_media_url', '仅允许小红书媒体域名：' . $host);
    }
    return ['href' => (string)$raw, 'host' => $host];
}

function detectFileType($bytes)
{
    $len = strlen($bytes);
    foreach (FILE_SIGNATURES as $sig) {
        $offset = $sig[0];
        $hex = $sig[1];
        $suffix = $sig[2];
        $signature = hex2bin($hex);
        if ($signature === false) continue;
        if (strlen($signature) + $offset > $len) continue;
        if (substr($bytes, $offset, strlen($signature)) === $signature) return $suffix;
    }
    return '';
}

/**
 * Remote size + real container probe. Reads the first 32 bytes with a Range
 * request so the file signature can confirm the actual type (static.py
 * FILE_SIGNATURES), instead of trusting Content-Type.
 */
function probeMedia($rawUrl)
{
    $target = validateMediaUrl($rawUrl);
    $response = httpGet($target['href'], [
        'user-agent' => DESKTOP_UA,
        'referer' => XHS_ORIGIN . '/',
        'accept' => '*/*',
        'range' => 'bytes=0-' . (SIGNATURE_PROBE_BYTES - 1),
        'accept-encoding' => 'identity',
    ], DEFAULT_TIMEOUT_MS, ['maxBytes' => 65536]);
    $status = $response['status'];
    $total = -1;
    $contentRange = $response['headers']['content-range'] ?? '';
    if ($contentRange !== '') {
        $slash = strrpos($contentRange, '/');
        $value = $slash !== false ? trim(substr($contentRange, $slash + 1)) : '';
        if ($value !== '' && $value !== '*' && is_numeric($value) && (float)$value > 0) {
            $total = floatToNum((float)$value);
        }
    } elseif ($status === 200) {
        $len = $response['headers']['content-length'] ?? '';
        if (is_numeric($len) && (float)$len > 0) $total = floatToNum((float)$len);
    }
    $bytes = substr($response['body'], 0, SIGNATURE_PROBE_BYTES);
    $detected = strlen($bytes) ? detectFileType($bytes) : '';
    return [
        'ok' => true,
        'status' => $status,
        'bytes' => $total,
        'human' => formatBytes($total),
        'contentType' => $response['headers']['content-type'] ?? '',
        'detected' => $detected,
        'sampled' => strlen($bytes),
    ];
}

// ---------------------------------------------------------------------------
// The parse pipeline
// ---------------------------------------------------------------------------

function runParse($input, $options = [])
{
    $started = microtime(true);
    $steps = [];
    $imageFormat = normalizeImageFormat($options['imageFormat'] ?? ($options['image_format'] ?? null));
    $videoPreference = normalizeVideoPreference($options['videoPreference'] ?? ($options['video_preference'] ?? null));
    $nameFormat = normalizeNameFormat($options['nameFormat'] ?? ($options['name_format'] ?? null));
    $tzOffsetRaw = $options['tzOffset'] ?? ($options['tz_offset'] ?? null);
    $tzOffset = (is_numeric($tzOffsetRaw) && $tzOffsetRaw !== '') ? floatToNum((float)$tzOffsetRaw) : 480;
    $cookie = (isset($options['cookie']) && is_string($options['cookie'])) ? trim($options['cookie']) : '';
    $text = jsStrSlice(jsString($input === null ? '' : $input), MAX_INPUT_CHARS);
    if (trim($text) === '') {
        throw new XhsParseError('bad_input', '输入为空');
    }
    $steps[] = '输入长度：' . jsStrLen($text) . ' 字符';
    if ($cookie !== '') $steps[] = '已使用调用方提供的 Cookie';

    $links = extractXhsLinks($text, $steps, ['cookie' => $cookie]);
    if (!count($links)) {
        $blocked = false;
        foreach ($steps as $step) {
            if (strpos($step, '风控') !== false) {
                $blocked = true;
                break;
            }
        }
        throw new XhsParseError(
            $blocked ? 'risk_control' : 'no_xhs_link',
            $blocked ? RISK_CONTROL_HINT : '未在输入中找到小红书作品链接',
            ['steps' => $steps]
        );
    }
    $target = preferHttpsForSite(normalizeUrl($links[0]));
    $noteId = extractLinkId($target);
    $steps[] = '作品链接：' . $target;
    $steps[] = '作品 ID：' . $noteId;

    $page = requestUrl($target, ['cookie' => $cookie]);
    $steps[] = '页面大小：' . jsStrLen($page['text']) . ' 字符';
    if (isRiskControlUrl($page['url']) || looksLikeRiskControlHtml($page['text'])) {
        $steps[] = '作品页返回安全验证页：' . $page['url'];
        throw new XhsParseError('risk_control', RISK_CONTROL_HINT, ['steps' => $steps]);
    }
    $state = parseInitialState($page['text']);
    if (!$state) {
        throw new XhsParseError(
            'no_initial_state',
            '页面中未找到 window.__INITIAL_STATE__（可能被风控拦截或页面结构已变化）',
            ['steps' => $steps]
        );
    }
    $steps[] = '已解析 window.__INITIAL_STATE__';

    $noteObject = filterNoteObject($state, $noteId);
    if (!$noteObject || !count($noteObject)) {
        throw new XhsParseError(
            'no_note_data',
            '页面未返回作品数据：链接可能已过期（xsec_token 失效）或被风控，可尝试传入 Cookie',
            ['steps' => $steps]
        );
    }
    $steps[] = '已定位作品数据对象（字段 ' . count($noteObject) . ' 个）';

    $data = exploreRun($noteObject, $tzOffset);
    if (!jsTruthy($data['作品ID'] ?? null)) {
        throw new XhsParseError('no_note_id', '作品数据缺少 noteId', ['steps' => $steps]);
    }
    $steps[] = '作品类型：' . $data['作品类型'];

    $media = [
        'type' => $data['作品类型'],
        'imageFormat' => $imageFormat,
        'videoPreference' => $videoPreference,
        'tzOffset' => $tzOffset,
    ];

    if ($data['作品类型'] === '视频') {
        $plan = getVideoPlan($noteObject, $videoPreference);
        $data['下载地址'] = $plan['urls'];
        $data['动图地址'] = [null];
        $media['kind'] = 'video';
        $media['strategy'] = $plan['strategy'];
        $media['video'] = $plan['chosen'];
        $media['videoCandidates'] = $plan['candidates'];
        $steps[] = '视频地址策略：' . $plan['strategy'] . '，候选 ' . count($plan['candidates']) . ' 个';
    } elseif ($data['作品类型'] === '图文' || $data['作品类型'] === '图集') {
        $plan = getImagePlan($noteObject, $imageFormat);
        $data['下载地址'] = $plan['urls'];
        $data['动图地址'] = $plan['liveLinks'];
        $media['kind'] = 'image';
        $media['imageCount'] = count($plan['urls']);
        $media['liveCount'] = count(array_filter($plan['liveLinks'], 'jsTruthy'));
        $steps[] = '图片地址 ' . count($plan['urls']) . ' 个（格式 ' . $imageFormat . '），动图 ' .
            $media['liveCount'] . ' 个';
    } else {
        $data['下载地址'] = [];
        $data['动图地址'] = [];
        $media['kind'] = 'unknown';
        $steps[] = '未知的作品类型，未生成下载地址';
    }

    $data['文件名'] = buildFileName($data, $nameFormat);
    $data['图片来源'] = $page['url'];

    $mediaUrls = array_values(array_filter($data['下载地址'] ?? [], 'jsTruthy'));
    $steps[] = '媒体地址 ' . count($mediaUrls) . ' 个';

    $verification = null;
    if (!empty($options['verify']) && count($mediaUrls)) {
        $limitRaw = $options['verifyLimit'] ?? null;
        $limit = min(count($mediaUrls), (is_numeric($limitRaw) && (int)$limitRaw !== 0) ? (int)$limitRaw : 3);
        $verification = [];
        for ($i = 0; $i < $limit; $i++) {
            try {
                $probe = probeMedia($mediaUrls[$i]);
                $verification[] = array_merge(['url' => $mediaUrls[$i]], $probe);
            } catch (Throwable $error) {
                $verification[] = [
                    'url' => $mediaUrls[$i],
                    'ok' => false,
                    'error' => $error->getMessage(),
                ];
            }
        }
        $steps[] = '已探测 ' . count($verification) . ' 个媒体地址';
        $reachable = 0;
        foreach ($verification as $item) {
            if (!empty($item['ok']) && $item['status'] >= 200 && $item['status'] < 300) $reachable++;
        }
        $media['verified'] = $reachable;
        $media['verification'] = $verification;
    }

    return [
        'ok' => true,
        'steps' => $steps,
        'source' => [
            'input' => $text,
            'url' => $target,
            'finalUrl' => $page['url'],
            'noteId' => $noteId,
            'htmlChars' => jsStrLen($page['text']),
            'elapsedMs' => (int)round((microtime(true) - $started) * 1000),
        ],
        'data' => $data,
        'media' => $media,
    ];
}

// ---------------------------------------------------------------------------
// A fresh sample link, so the UI's "example" button never goes stale
// ---------------------------------------------------------------------------

function fetchSampleLink($cookie)
{
    $steps = [];
    $page = requestUrl(XHS_ORIGIN . '/explore', ['cookie' => $cookie]);
    if (isRiskControlUrl($page['url']) || looksLikeRiskControlHtml($page['text'])) {
        $steps[] = '首页返回安全验证页：' . $page['url'];
        throw new XhsParseError('risk_control', RISK_CONTROL_HINT, ['steps' => $steps]);
    }
    $state = parseInitialState($page['text']);
    if (!$state) {
        throw new XhsParseError('no_initial_state', '未能在首页找到 __INITIAL_STATE__', ['steps' => $steps]);
    }
    $found = null;
    $walk = function ($node, $depth) use (&$walk, &$found) {
        if ($found !== null || $depth > 12 || $node === null || !is_array($node)) return;
        if (!isListArr($node) && isset($node['id']) && is_string($node['id']) &&
            preg_match('/^[0-9a-f]{24}$/', $node['id']) &&
            isset($node['xsecToken']) && is_string($node['xsecToken'])) {
            $found = ['id' => $node['id'], 'token' => $node['xsecToken']];
            return;
        }
        foreach ($node as $value) $walk($value, $depth + 1);
    };
    $walk($state, 0);
    if ($found === null) {
        throw new XhsParseError('no_sample', '推荐流中未找到可用的作品链接');
    }
    $url = XHS_ORIGIN . '/explore/' . $found['id'] .
        '?xsec_token=' . rawurlencode($found['token']) . '&xsec_source=pc_feed';
    $steps[] = '取自首页推荐流';
    return ['ok' => true, 'url' => $url, 'noteId' => $found['id'], 'steps' => $steps];
}

// ---------------------------------------------------------------------------
// Built-in web UI (served at "/", /app, /index.html). The page uses the same
// /api/parse endpoint, so the API and the UI can never drift apart. Client JS is
// plain ES5-ish concatenation: no template literals, no backticks.
// ---------------------------------------------------------------------------

function pageHtml($endpoint = '/index.php')
{
    $endpoint = is_string($endpoint) && $endpoint !== '' ? $endpoint : '/index.php';
    $html = <<<'HTML'
<!DOCTYPE html>
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
<p class="muted">Cookie 保存在你浏览器的 localStorage，<b>刷新或重开页面都会自动带上</b>；解析时随请求发给本服务，不会被记录或转发到别处。</p>
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
<script>var XHS_EP=__XHS_EP__;</script>
<script>
var inEl=document.getElementById("in"),runEl=document.getElementById("run"),
fmtEl=document.getElementById("fmt"),prefEl=document.getElementById("pref"),
cookieEl=document.getElementById("cookie"),cookBoxEl=document.getElementById("cookbox"),
cookStateEl=document.getElementById("cookstate"),
statusEl=document.getElementById("status"),resEl=document.getElementById("result"),
errEl=document.getElementById("error");
// Every call goes to this very PHP file plus ?route=…, so the page keeps working
// when it is deployed in a subdirectory and no rewrite rule exists.
function api(path,qs){return XHS_EP+"?route="+path+(qs?("&"+qs):"");}
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
if(d&&d.steps){errEl.appendChild(el("p","steps",d.steps.join("\n")));}
errEl.scrollIntoView({behavior:"smooth"});}
function onErrText(t){errEl.style.display="block";errEl.innerHTML="";
errEl.appendChild(el("h3",null,t));}
async function post(){
var t=inEl.value.trim();
if(!t){onErrText("请先粘贴分享文案或链接");return;}
saveCookiePref();
runEl.disabled=true;errEl.style.display="none";resEl.innerHTML="";setStatus("解析中…");
try{
var r=await fetch(api("/api/parse"),{method:"POST",headers:{"Content-Type":"application/json"},
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
v.src=api("/dl","url="+encodeURIComponent(urls[0]));
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
im.onerror=function(){im.onerror=null;im.src=api("/api/thumb","url="+encodeURIComponent(u));};
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
sc.appendChild(el("p","steps",j.steps.join("\n")));
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
var p=el("a","btn","代理");p.href=api("/dl","url="+encodeURIComponent(url));
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
fetch(api("/api/probe","url="+encodeURIComponent(url))).then(function(r){return r.json();})
.then(function(j){if(j&&j.ok){mark.textContent=j.human+" · "+(j.detected||j.contentType||"?");}
else{mark.textContent="";}}).catch(function(){mark.textContent="";});})(marks[i],urls[i]);}}
function openLightbox(idx){var ph=window.__photos;if(!ph||!ph.length)return;
var lb=document.getElementById("lb");var img=document.getElementById("lbImg");
var cap=document.getElementById("lbCap");window.__lbIdx=idx;
function show(){var cur=ph[window.__lbIdx];img.src=cur.url;window.__zoom=1;
img.style.transform="";img.onerror=function(){img.onerror=null;
img.src=api("/api/thumb","url="+encodeURIComponent(cur.url));};
cap.textContent=cur.label+"（"+(window.__lbIdx+1)+"/"+ph.length+"）· 滚轮缩放";}
window.__lbShow=show;show();lb.classList.add("open");}
function lbClose(){document.getElementById("lb").classList.remove("open");}
function lbStep(d){if(!window.__photos||!window.__photos.length)return;
window.__lbIdx=(window.__lbIdx+d+window.__photos.length)%window.__photos.length;
if(window.__lbShow){window.__lbShow();}}
document.getElementById("sample").addEventListener("click",async function(){
setStatus("获取示例中…");
saveCookiePref();
try{var r=await fetch(api("/api/sample","cookie="+encodeURIComponent(getCookie())));var j=await r.json();
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
</script></body></html>
HTML;
    $literal = json_encode($endpoint, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if (!is_string($literal) || $literal === '') $literal = '"/index.php"';
    return str_replace('__XHS_EP__', $literal, $html);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** JSON text with the same 2-space indentation JS uses. */
function jsonText($payload)
{
    $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE;
    $json = json_encode($payload, $flags);
    if ($json === false) {
        return '{"ok":false,"error":{"code":"encode_failed","message":"响应序列化失败"}}';
    }
    $halved = preg_replace_callback('/^( +)/m', function ($m) {
        return str_repeat(' ', intdiv(strlen($m[1]), 2));
    }, $json);
    return $halved === null ? $json : $halved;
}

function jsonResponse($status, $payload)
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        foreach (CORS_HEADERS as $k => $v) header($k . ': ' . $v);
    }
    echo jsonText($payload);
    exit;
}

function errorBody($code, $message, $detail = null)
{
    $body = ['ok' => false, 'error' => ['code' => $code, 'message' => $message]];
    if ($detail) $body['error']['detail'] = $detail;
    return $body;
}

function statusForCode($code)
{
    if ($code === 'bad_input' || $code === 'no_xhs_link' || $code === 'bad_media_url') return 400;
    if ($code === 'no_note_data' || $code === 'no_note_id' || $code === 'no_initial_state') return 404;
    // 'risk_control' and network failures: the upstream refused to serve us.
    return 502;
}

function readBodyOptions()
{
    $method = requestMethod();
    if ($method !== 'POST' && $method !== 'PUT') return null;
    $raw = file_get_contents('php://input');
    if ($raw === false) $raw = '';
    $contentType = requestHeader('content-type');
    if (stripos($contentType, 'application/json') !== false) {
        $decoded = json_decode($raw);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new XhsParseError('bad_input', '请求体不是合法 JSON');
        }
        if (!is_object($decoded)) {
            throw new XhsParseError('bad_input', 'JSON 请求体必须是对象');
        }
        $payload = json_decode($raw, true);
        return is_array($payload) ? $payload : [];
    }
    return ['text' => $raw];
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleParse()
{
    $bodyOptions = readBodyOptions();
    $source = is_array($bodyOptions) ? $bodyOptions : [];
    $text = $source['text'] ?? ($source['url'] ?? (getParam('text') ?? getParam('url')));
    if ($text === null || trim(jsString($text)) === '') {
        jsonResponse(400, errorBody(
            'bad_input',
            '缺少输入：GET /api/parse?url=… 或 POST {"url": "…"}'
        ));
    }
    $verifyParam = getParam('verify');
    $options = [
        'imageFormat' => $source['image_format'] ?? ($source['imageFormat'] ?? getParam('image_format')),
        'videoPreference' => $source['video_preference'] ?? ($source['videoPreference'] ?? getParam('video_preference')),
        'nameFormat' => $source['name_format'] ?? ($source['nameFormat'] ?? getParam('name_format')),
        'tzOffset' => $source['tz_offset'] ?? ($source['tzOffset'] ?? getParam('tz_offset')),
        'cookie' => $source['cookie'] ?? getParam('cookie'),
        'verify' => (($source['verify'] ?? null) === true) || $verifyParam === '1' || $verifyParam === 'true',
    ];
    try {
        $result = runParse(jsString($text), $options);
        jsonResponse(200, $result);
    } catch (XhsParseError $error) {
        jsonResponse(
            statusForCode($error->errorCode),
            errorBody($error->errorCode, $error->getMessage(), $error->detail)
        );
    } catch (Throwable $error) {
        jsonResponse(502, errorBody('internal', '解析异常：' . $error->getMessage()));
    }
}

function handleSample()
{
    try {
        jsonResponse(200, fetchSampleLink(getParam('cookie')));
    } catch (XhsParseError $error) {
        jsonResponse(
            statusForCode($error->errorCode),
            errorBody($error->errorCode, $error->getMessage(), $error->detail)
        );
    } catch (Throwable $error) {
        jsonResponse(502, errorBody('sample_failed', '示例链接获取失败'));
    }
}

function handleProbe()
{
    $raw = getParam('url');
    if ($raw === null || $raw === '') return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
    try {
        jsonResponse(200, probeMedia($raw));
    } catch (XhsParseError $error) {
        jsonResponse(400, errorBody($error->errorCode, $error->getMessage()));
    } catch (Throwable $error) {
        jsonResponse(502, errorBody('probe_failed', '大小探测失败'));
    }
}

/** Hosts that answer 403 without a xiaohongshu Referer. */
function hostNeedsReferer($host)
{
    $h = strtolower(jsString($host));
    return hostAllowed($h) || $h === 'xhscdn.com';
}

function noReferrerBridge($target)
{
    $esc = str_replace(
        ['&', '"', '<', '>'],
        ['&amp;', '&quot;', '&lt;', '&gt;'],
        $target
    );
    $jsLit = str_replace('</', '<\\/', json_encode(
        $target,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    ));
    $html =
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' .
        '<meta name="referrer" content="no-referrer">' .
        '<meta name="viewport" content="width=device-width,initial-scale=1">' .
        '<title>正在打开媒体…</title></head>' .
        '<body style="margin:0;font-family:-apple-system,\'Segoe UI\',\'Microsoft YaHei\',sans-serif;' .
        'background:#0f1115;color:#e8eaf0;min-height:100vh;display:flex;align-items:center;justify-content:center">' .
        '<div style="text-align:center;padding:20px">' .
        '<p>正在打开媒体文件…</p>' .
        '<p><a href="' . $esc . '" rel="noreferrer" style="color:#ff8095">若未自动跳转，请点击这里</a></p>' .
        '</div>' .
        '<script>location.replace(' . $jsLit . ');</script>' .
        '</body></html>';
    if (!headers_sent()) {
        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        header('Referrer-Policy: no-referrer');
        foreach (CORS_HEADERS as $k => $v) header($k . ': ' . $v);
    }
    echo $html;
    exit;
}

function emitProxyHeaders($up, $status)
{
    if (headers_sent()) return;
    http_response_code($status);
    header('Content-Type: ' . (($up['content-type'] ?? '') !== '' ? $up['content-type'] : 'application/octet-stream'));
    header('Accept-Ranges: ' . (($up['accept-ranges'] ?? '') !== '' ? $up['accept-ranges'] : 'bytes'));
    header('Cache-Control: private, no-store');
    foreach (['content-range', 'content-length'] as $name) {
        if (isset($up[$name])) header($name . ': ' . $up[$name]);
    }
    foreach (CORS_HEADERS as $k => $v) header($k . ': ' . $v);
}

/** Stream media through this server with a xiaohongshu Referer (+ Range passthrough). */
function proxyMedia($target)
{
    try {
        if (!function_exists('curl_init')) {
            jsonResponse(502, errorBody('media_failed', '媒体转发失败'));
        }
        $headers = [
            'user-agent' => DESKTOP_UA,
            'referer' => XHS_ORIGIN . '/',
            'accept' => '*/*',
            'accept-encoding' => 'identity',
        ];
        $range = requestHeader('range');
        if ($range !== '') $headers['range'] = $range;
        $ch = curl_init();
        if ($ch === false) jsonResponse(502, errorBody('media_failed', '媒体转发失败'));
        $upHeaders = [];
        $upStatus = 0;
        $sent = false;
        $options = [
            CURLOPT_URL => $target,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 10,
            CURLOPT_TIMEOUT_MS => 60000,
            CURLOPT_CONNECTTIMEOUT_MS => 10000,
            CURLOPT_HTTPHEADER => headerLines($headers),
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$upHeaders, &$upStatus) {
                $len = strlen($line);
                $trim = trim($line);
                if ($trim === '') return $len;
                if (preg_match('~^HTTP/\S+\s+(\d+)~i', $trim, $m)) {
                    $upStatus = (int)$m[1];
                    $upHeaders = [];
                    return $len;
                }
                $pos = strpos($trim, ':');
                if ($pos !== false) {
                    $k = strtolower(trim(substr($trim, 0, $pos)));
                    $v = trim(substr($trim, $pos + 1));
                    $upHeaders[$k] = $v;
                }
                return $len;
            },
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$sent, &$upStatus, &$upHeaders) {
                if ($upStatus < 200 || $upStatus >= 300) return 0;   // abort: report the error
                if (!$sent) {
                    emitProxyHeaders($upHeaders, $upStatus);
                    $sent = true;
                }
                echo $chunk;
                @ob_flush();
                @flush();
                return strlen($chunk);
            },
        ];
        $caInfo = curlCaInfo();
        if ($caInfo !== null) $options[CURLOPT_CAINFO] = $caInfo;
        curl_setopt_array($ch, $options);
        curl_exec($ch);
        if (!$sent) {
            if ($upStatus >= 200 && $upStatus < 300) {
                emitProxyHeaders($upHeaders, $upStatus);
                exit;
            }
            // status 0 = the transport never produced a response (DNS/TLS/timeout).
            jsonResponse(502, errorBody(
                'media_failed',
                $upStatus === 0 ? '媒体转发失败' : '媒体源返回 HTTP ' . $upStatus
            ));
        }
        exit;
    } catch (Throwable $error) {
        jsonResponse(502, errorBody('media_failed', '媒体转发失败'));
    }
}

function handleDownload()
{
    $raw = getParam('url');
    if ($raw === null || $raw === '') return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
    try {
        $target = validateMediaUrl($raw);
        $accept = requestHeader('accept');
        if (stripos($accept, 'text/html') !== false) {
            if (hostNeedsReferer($target['host'])) return proxyMedia($target['href']);
            return noReferrerBridge($target['href']);
        }
        if (!headers_sent()) {
            http_response_code(302);
            header('Location: ' . $target['href']);
            foreach (CORS_HEADERS as $k => $v) header($k . ': ' . $v);
        }
        exit;
    } catch (XhsParseError $error) {
        jsonResponse(400, errorBody($error->errorCode, $error->getMessage()));
    } catch (Throwable $error) {
        jsonResponse(400, errorBody('bad_media_url', '媒体地址校验失败'));
    }
}

function handleThumb()
{
    $raw = getParam('url');
    if ($raw === null || $raw === '') return jsonResponse(400, errorBody('bad_input', '缺少 url 参数'));
    try {
        $target = validateMediaUrl($raw);
        $response = httpGet($target['href'], [
            'user-agent' => DESKTOP_UA,
            'referer' => XHS_ORIGIN . '/',
            'accept' => 'image/avif,image/webp,image/*,*/*;q=0.8',
            'accept-language' => 'zh-CN,zh;q=0.9',
        ], DEFAULT_TIMEOUT_MS, ['maxBytes' => THUMB_MAX_BYTES + 1]);
        if ($response['status'] < 200 || $response['status'] >= 300) {
            jsonResponse(502, errorBody('thumb_failed', '缩略图源返回 HTTP ' . $response['status']));
        }
        $type = strtolower($response['headers']['content-type'] ?? '');
        // Refuse obvious non-images up front so a video URL never gets buffered here.
        if (strpos($type, 'video/') === 0 || strpos($type, 'audio/') === 0) {
            jsonResponse(502, errorBody('thumb_failed', '响应不是图片（' . $type . '）'));
        }
        $buffer = $response['body'];
        if (strlen($buffer) > THUMB_MAX_BYTES) {
            jsonResponse(502, errorBody('thumb_failed', '图片超过 20 MiB 安全限制'));
        }
        $detected = detectFileType(substr($buffer, 0, SIGNATURE_PROBE_BYTES));
        if (strpos($type, 'image/') !== 0 && !in_array($detected, IMAGE_SUFFIXES, true)) {
            jsonResponse(502, errorBody('thumb_failed', '响应不是图片'));
        }
        $outType = strpos($type, 'image/') === 0
            ? $type
            : (IMAGE_MIME_BY_SUFFIX[$detected] ?? 'application/octet-stream');
        if (!headers_sent()) {
            http_response_code(200);
            header('Content-Type: ' . $outType);
            header('Content-Length: ' . strlen($buffer));
            header('Cache-Control: public, max-age=3600');
            foreach (CORS_HEADERS as $k => $v) header($k . ': ' . $v);
        }
        echo $buffer;
        exit;
    } catch (XhsParseError $error) {
        jsonResponse(400, errorBody($error->errorCode, $error->getMessage()));
    } catch (Throwable $error) {
        jsonResponse(502, errorBody('thumb_failed', '缩略图获取失败'));
    }
}

function handlePage()
{
    $html = pageHtml(endpointUrl());
    if (!headers_sent()) {
        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        foreach (CORS_HEADERS as $k => $v) header($k . ': ' . $v);
    }
    echo $html;
    exit;
}

function handleHelp()
{
    jsonResponse(200, HELP);
}

// ---------------------------------------------------------------------------
// API help
// ---------------------------------------------------------------------------

const HELP = [
    'name' => 'xhs-parse',
    'description' =>
        '小红书作品解析（移植 XHS-Downloader 的解析规则）：链接提取 → window.__INITIAL_STATE__ 解析 → ' .
        '作品信息、图片/视频媒体地址选择。',
    'endpoints' => [
        'GET /（或 /app、/index.html）' => '内置网页：粘贴分享文案解析、预览图片、在线播放视频、复制/代理下载地址',
        'GET /help' => '本帮助（JSON）',
        'GET /api/sample' => '从首页推荐流取一条当前有效的示例作品链接',
        'GET /api/parse?url=…' => '解析 explore / discovery/item / xhslink 链接',
        'GET /api/parse?text=…' => '解析分享文案（同一流程）',
        'POST /api/parse' => 'JSON 请求体，见下方 options',
        'GET /api/thumb?url=…' => '图片代理（带 Referer/UA，供网页预览）',
        'GET /api/probe?url=…' => '探测媒体远端大小 + 真实文件类型（Range bytes=0-31）',
        'GET /dl?url=…' => '302 跳转到通过校验的小红书媒体地址（浏览器打开时经代理加 Referer）',
        'GET /api/selftest' => '解析管线确定性自测（不需要网络）',
    ],
    'options' => [
        'image_format' => 'auto | png | webp | jpeg | heic | avif，默认 jpeg（仅图文/图集生效）',
        'video_preference' => 'resolution | bitrate | size，默认 resolution（仅视频生效）',
        'name_format' => '文件名字段，空格分隔；含未知字段时回退默认值',
        'tz_offset' => '发布时间时区偏移（分钟），默认 480（UTC+8）',
        'cookie' => '小红书网页版 Cookie；非必需，视频高画质与风控场景建议提供',
        'verify' => 'true 时顺带探测媒体地址，结果放在 media.verification',
        'proxy' => '仅为兼容原项目 API 保留，本服务运行时忽略',
    ],
    'response' => [
        'ok' => '是否成功',
        'steps' => '处理步骤（失败时用于定位）',
        'source' => '输入、最终 URL、作品 ID、页面大小、耗时',
        'data' => 'XHS-Downloader 原始字段：作品ID/标题/描述/类型/标签/互动数/时间/作者/下载地址/动图地址/文件名',
        'media' => '归一化媒体块：kind、video（分辨率等）、imageCount、verified',
    ],
    'errors' => [
        'bad_input' => '输入为空或格式不对（400）',
        'no_xhs_link' => '输入里没有小红书作品链接（400）',
        'bad_media_url' => '媒体地址不在允许的小红书域名内（400）',
        'no_note_data' => '页面没返回作品数据，通常是 xsec_token 已过期（404）',
        'no_initial_state' => '页面被风控或结构变化，未找到 __INITIAL_STATE__（404）',
        'risk_control' => '被要求安全验证，通常是数据中心 IP 风控；填 Cookie 后重试（502）',
        'request_failed' => '网络请求失败（502）',
    ],
    'notes' => [
        '仅用于你有权处理的内容；平台页面结构、风控与地区差异都可能影响结果。',
        '作品链接携带日期信息，旧链接的 xsec_token 会失效，解析失败时请重新获取链接。',
        '部署在数据中心 IP 上比家用宽带更容易被要求安全验证；遇到 risk_control 请填入小红书网页版 Cookie。',
        '未设置 Cookie 时视频可能只能取到较低画质；本服务不记录你的 Cookie。',
    ],
];

// ---------------------------------------------------------------------------
// Deterministic self-test (no network): the pipeline rules from the Python
// project, checked against synthetic fixtures.
// ---------------------------------------------------------------------------

function selftestJsonLike()
{
    $text = "{a:1, b:'x', c:[1,2,], d:undefined, e:{f:true,}, g:null, h:1.5e3}";
    $parsed = parseJsonLike($text);
    if (!array_key_exists('a', $parsed) || $parsed['a'] !== 1) throw new Exception('json-like: bare key');
    if (!array_key_exists('b', $parsed) || $parsed['b'] !== 'x') throw new Exception('json-like: single quotes');
    if (count($parsed['c'] ?? []) !== 2) throw new Exception('json-like: trailing comma in array');
    if (!array_key_exists('d', $parsed) || $parsed['d'] !== null) throw new Exception('json-like: undefined -> null');
    if (($parsed['e']['f'] ?? 'missing') !== true) throw new Exception('json-like: nested object');
    if (!array_key_exists('g', $parsed) || $parsed['g'] !== null) throw new Exception('json-like: null literal');
    if (!array_key_exists('h', $parsed) || $parsed['h'] !== 1500) throw new Exception('json-like: exponent');
    $str = parseJsonLike('{"a":"und\u0065fined and undefined"}');
    if (($str['a'] ?? null) !== 'undefined and undefined') {
        throw new Exception('json-like: string content must not be rewritten');
    }
    return 'json_like_ok';
}

function selftestInitialState()
{
    $html =
        '<html><head><script>var x=1;</script></head><body>' .
        '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"aaa":{"note":{"noteId":"aaa"}},' .
        '"bbb":{"note":{"noteId":"bbb"}}}},"other":undefined};</script>' .
        '<script>window.__OTHER__={};</script></body></html>';
    $state = parseInitialState($html);
    if (!$state) throw new Exception('initial state: not found');
    if (!array_key_exists('other', $state) || $state['other'] !== null) {
        throw new Exception('initial state: undefined not normalised');
    }
    if ((filterNoteObject($state, 'aaa')['noteId'] ?? null) !== 'aaa') {
        throw new Exception('initial state: preferred note id must win');
    }
    if ((filterNoteObject($state, 'zzz')['noteId'] ?? null) !== 'bbb') {
        throw new Exception('initial state: [-1] must fall back to last entry');
    }
    $phone = 'window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"noteId":"phone-1"}}}}';
    $phoneState = parseInitialState('<script>' . $phone . '</script>');
    if ((filterNoteObject($phoneState, 'x')['noteId'] ?? null) !== 'phone-1') {
        throw new Exception('initial state: phone shape');
    }
    if (parseInitialState('<html><script>var a=1;</script></html>') !== null) {
        throw new Exception('initial state: must return null when absent');
    }
    return 'initial_state_ok';
}

function selftestExtractLinks()
{
    $cases = [
        ['看这个 https://www.xiaohongshu.com/explore/abc123?xsec_token=TOK 不错',
            'https://www.xiaohongshu.com/explore/abc123?xsec_token=TOK'],
        ['https://www.xiaohongshu.com/discovery/item/def456?xsec_token=T2',
            'https://www.xiaohongshu.com/discovery/item/def456?xsec_token=T2'],
        ['https://www.xiaohongshu.com/user/profile/user1/ghi789?xsec_token=T3',
            'https://www.xiaohongshu.com/user/profile/user1/ghi789?xsec_token=T3'],
        ['https://www.rednote.com/explore/rn000?a=1', 'https://www.rednote.com/explore/rn000?a=1'],
        ['www.xiaohongshu.com/explore/nohost?a=1', 'www.xiaohongshu.com/explore/nohost?a=1'],
    ];
    foreach ($cases as $case) {
        $input = $case[0];
        $expected = $case[1];
        $actual = '';
        foreach ([RE_SHARE_XHS, RE_SHARE_RN, RE_LINK_XHS, RE_LINK_RN, RE_USER_XHS, RE_USER_RN] as $re) {
            if (preg_match($re, $input, $m)) {
                $actual = $m[0];
                break;
            }
        }
        if ($actual !== $expected) throw new Exception('extract link: ' . $input . ' -> ' . $actual);
    }
    if (!preg_match(RE_SHORT, '复制 http://xhslink.com/aBcD3f 打开小红书', $m) ||
        $m[0] !== 'http://xhslink.com/aBcD3f') {
        throw new Exception('extract link: short url');
    }
    $id = extractLinkId('https://www.xiaohongshu.com/explore/64f0c1a2000000001203abcd?x=1');
    if ($id !== '64f0c1a2000000001203abcd') throw new Exception('extract id: ' . $id);
    $ids = extractIds(['https://www.xiaohongshu.com/explore/abc?t=1']);
    if (($ids[0] ?? null) !== 'abc') throw new Exception('extract ids: ' . json_encode($ids));
    return 'extract_links_ok';
}

function selftestExplore()
{
    $note = [
        'noteId' => 'note-1',
        'title' => '标题',
        'desc' => '描述',
        'type' => 'normal',
        'time' => 1700000000000,
        'lastUpdateTime' => 1700000100000,
        'user' => ['nickname' => '昵称', 'userId' => 'uid-1'],
        'interactInfo' => ['collectedCount' => '10', 'commentCount' => '2', 'shareCount' => '3', 'likedCount' => ''],
        'tagList' => [['name' => '标签A'], ['name' => '标签B']],
        'imageList' => [['urlDefault' => 'x']],
    ];
    // likedCount is empty -> safe_extract must fall back to "-1"
    $data = exploreRun($note, 480);
    if ($data['作品ID'] !== 'note-1') throw new Exception('explore: id');
    if ($data['点赞数量'] !== '-1') throw new Exception('explore: falsy -> default, got ' . $data['点赞数量']);
    if ($data['收藏数量'] !== '10') throw new Exception('explore: collected');
    if ($data['作品标签'] !== '标签A 标签B') throw new Exception('explore: tags');
    if ($data['作品类型'] !== '图文') throw new Exception('explore: type normal, got ' . $data['作品类型']);
    if ($data['作者链接'] !== 'https://www.xiaohongshu.com/user/profile/uid-1') {
        throw new Exception('explore: author link');
    }
    if ($data['发布时间'] !== '2023-11-15_06:13:20') {
        throw new Exception('explore: publish time (UTC+8), got ' . $data['发布时间']);
    }
    if ($data['时间戳'] !== 1700000000) throw new Exception('explore: epoch seconds');
    if (array_key_exists('作品ID', exploreRun([], 480))) throw new Exception('explore: empty -> {}');
    // type classification
    $video = ['type' => 'video', 'imageList' => [[]], 'noteId' => 'v'];
    if (classifyWorks($video) !== '视频') throw new Exception('explore: video with 1 image');
    if (classifyWorks(['type' => 'video', 'imageList' => [[], []]]) !== '图集') {
        throw new Exception('explore: video with 2 images -> 图集');
    }
    if (classifyWorks(['type' => 'normal', 'imageList' => []]) !== '未知') {
        throw new Exception('explore: empty imageList -> 未知');
    }
    if (classifyWorks(['type' => 'other', 'imageList' => [[]]]) !== '未知') {
        throw new Exception('explore: unknown type -> 未知');
    }
    return 'explore_ok';
}

function selftestImage()
{
    $url = 'http://sns-webpic-qc.xhscdn.com/202609121319/7309997bcd7772dd4dbf13ac2d7d1847/' .
        'spectrum/1040g0k0323be3pj86u005oih1hak0k3a94udfog!nd_dft_wlteh_jpg_3';
    $token = extractImageToken($url);
    if ($token !== 'spectrum/1040g0k0323be3pj86u005oih1hak0k3a94udfog') {
        throw new Exception('image: token -> ' . $token);
    }
    if (generateFixedImageLink($token, 'png') !==
        'https://ci.xiaohongshu.com/spectrum/1040g0k0323be3pj86u005oih1hak0k3a94udfog?imageView2/format/png') {
        throw new Exception('image: fixed link');
    }
    if (generateAutoImageLink($token) !==
        'https://sns-img-bd.xhscdn.com/spectrum/1040g0k0323be3pj86u005oih1hak0k3a94udfog') {
        throw new Exception('image: auto link');
    }
    // urlDefault wins; url is only the fallback when no urlDefault yields a token.
    $withDefault = getImagePlan(['imageList' => [['urlDefault' => $url, 'url' => 'https://a/b/c/d/e/f!x']]], 'jpeg');
    if (strpos($withDefault['urls'][0], '1040g0k0323be3pj86u005oih1hak0k3a94udfog') === false) {
        throw new Exception('image: urlDefault preferred');
    }
    $fallback = getImagePlan(['imageList' => [['url' => $url]]], 'auto');
    if (strpos($fallback['urls'][0], 'https://sns-img-bd.xhscdn.com/') !== 0) {
        throw new Exception('image: url fallback -> ' . $fallback['urls'][0]);
    }
    $live = getImagePlan([
        'imageList' => [['urlDefault' => $url, 'stream' => ['h264' => [['backupUrls' => ['https://cdn/live.mp4']]]]]],
    ], 'jpeg');
    if ($live['liveLinks'][0] !== 'https://cdn/live.mp4') throw new Exception('image: live backupUrls');
    $master = getImagePlan([
        'imageList' => [['urlDefault' => $url, 'stream' => ['h264' => [['masterUrl' => 'https://cdn/m.mp4']]]]],
    ], 'jpeg');
    if ($master['liveLinks'][0] !== 'https://cdn/m.mp4') throw new Exception('image: live masterUrl');
    // missing stream must not throw (the Python original raised here)
    $none = getImagePlan(['imageList' => [['urlDefault' => $url, 'stream' => ['h264' => [[]]]]]], 'jpeg');
    if ($none['liveLinks'][0] !== null) throw new Exception('image: no stream -> null');
    return 'image_ok';
}

function selftestVideo()
{
    $data = [
        'video' => [
            'media' => [
                'stream' => [
                    'h264' => [
                        ['height' => 720, 'videoBitrate' => 1000, 'size' => 100, 'backupUrls' => ['https://cdn/720.mp4']],
                        ['height' => 1080, 'videoBitrate' => 2000, 'size' => 300, 'backupUrls' => ['https://cdn/1080.mp4']],
                        ['height' => 480, 'videoBitrate' => 500, 'size' => 50, 'backupUrls' => ['https://cdn/480.mp4']],
                    ],
                    'h265' => [
                        ['height' => 1440, 'videoBitrate' => 3000, 'size' => 500, 'backupUrls' => ['https://cdn/1440.mp4']],
                    ],
                ],
            ],
        ],
    ];
    if (getVideoPlan($data, 'resolution')['urls'][0] !== 'https://cdn/1440.mp4') {
        throw new Exception('video: resolution preference');
    }
    if (getVideoPlan($data, 'bitrate')['urls'][0] !== 'https://cdn/1440.mp4') {
        throw new Exception('video: bitrate preference');
    }
    if (getVideoPlan($data, 'size')['urls'][0] !== 'https://cdn/1440.mp4') {
        throw new Exception('video: size preference');
    }
    $sizeCase = [
        'video' => ['media' => ['stream' => ['h264' => [
            ['height' => 1080, 'size' => 10, 'backupUrls' => ['https://cdn/small.mp4']],
            ['height' => 480, 'size' => 900, 'backupUrls' => ['https://cdn/big.mp4']],
        ]]]],
    ];
    if (getVideoPlan($sizeCase, 'size')['urls'][0] !== 'https://cdn/big.mp4') {
        throw new Exception('video: size preference picks largest file');
    }
    if (getVideoPlan($sizeCase, 'resolution')['urls'][0] !== 'https://cdn/small.mp4') {
        throw new Exception('video: resolution ignores size');
    }
    // masterUrl fallback when backupUrls is empty
    $master = [
        'video' => ['media' => ['stream' => ['h264' => [['height' => 1, 'masterUrl' => 'https://cdn/master.mp4']]]]],
    ];
    if (getVideoPlan($master, 'resolution')['urls'][0] !== 'https://cdn/master.mp4') {
        throw new Exception('video: masterUrl fallback');
    }
    // originVideoKey wins over the stream list
    $origin = [
        'video' => [
            'consumer' => ['originVideoKey' => 'abc/def.mp4'],
            'media' => ['stream' => ['h264' => [['height' => 9, 'backupUrls' => ['https://cdn/x.mp4']]]]],
        ],
    ];
    $plan = getVideoPlan($origin, 'resolution');
    if ($plan['strategy'] !== 'originVideoKey') throw new Exception('video: originVideoKey strategy');
    if ($plan['urls'][0] !== 'https://sns-video-bd.xhscdn.com/abc/def.mp4') {
        throw new Exception('video: originVideoKey url -> ' . $plan['urls'][0]);
    }
    if (count(getVideoPlan([], 'resolution')['urls']) !== 0) throw new Exception('video: empty -> []');
    return 'video_ok';
}

function selftestNaming()
{
    if (decodeUnicodeEscapes('https://a/\u002Fb') !== 'https://a//b') {
        throw new Exception('naming: unicode escape');
    }
    $data = [
        '作品ID' => 'nid',
        '作品标题' => '标题:带/非法*字符',
        '作品描述' => '',
        '作品类型' => '图文',
        '发布时间' => '2023-11-15_06:13:20',
        '最后更新时间' => '2023-11-15_06:13:20',
        '作者昵称' => '某人',
        '作者ID' => 'uid',
        '收藏数量' => '1', '评论数量' => '2', '分享数量' => '3', '点赞数量' => '4',
        '作品标签' => 'a b',
    ];
    // ':' -> '.', illegal chars removed, default format is 发布时间 作者昵称 作品标题
    $name = buildFileName($data, normalizeNameFormat(null));
    if ($name !== '2023-11-15_06.13.20_某人_标题.带非法字符') {
        throw new Exception('naming: default format -> ' . $name);
    }
    // an unknown key resets the format to the default
    if (normalizeNameFormat('无效字段 作品标题') !== DEFAULT_NAME_FORMAT) {
        throw new Exception('naming: invalid key must fall back');
    }
    if (normalizeNameFormat('作品ID 作品标题') !== '作品ID 作品标题') {
        throw new Exception('naming: valid key must pass through');
    }
    if (managerFilterName('a/b:c*d') !== 'a_b_c_d') {
        throw new Exception('naming: managerFilterName -> ' . managerFilterName('a/b:c*d'));
    }
    if (beautifyString('short', 64) !== 'short') throw new Exception('naming: beautify short');
    $long = str_repeat('a', 200);
    $trimmed = beautifyString($long, 10);
    if (strpos($trimmed, '...') === false) throw new Exception('naming: beautify ellipsis');
    if (cleanerFilterName('  空 白  ') !== '空 白') {
        throw new Exception('naming: collapse spaces -> ' . cleanerFilterName('  空 白  '));
    }
    if (cleanerFilterName('', '', 'fallback') !== 'fallback') {
        throw new Exception('naming: default value');
    }
    return 'naming_ok';
}

function selftestMediaGuard()
{
    foreach (['sns-img-bd.xhscdn.com', 'ci.xiaohongshu.com', 'www.rednote.com'] as $host) {
        if (!hostAllowed($host)) throw new Exception('guard: should allow ' . $host);
    }
    foreach (['evil.com', 'xhscdn.com.evil.com'] as $host) {
        if (hostAllowed($host)) throw new Exception('guard: should reject ' . $host);
    }
    $cases = [
        ['http://127.0.0.1/x', 'private'],
        ['http://169.254.169.254/latest/meta-data', 'link-local'],
        ['http://10.0.0.1/x', 'rfc1918'],
    ];
    foreach ($cases as $case) {
        if (!isPrivateHost(parse_url($case[0], PHP_URL_HOST))) {
            throw new Exception('guard: missed ' . $case[1]);
        }
    }
    $rejected = false;
    try {
        validateMediaUrl('https://example.com/x.mp4');
    } catch (XhsParseError $error) {
        $rejected = ($error->errorCode === 'bad_media_url');
    }
    if (!$rejected) throw new Exception('guard: foreign host must be rejected');
    if (validateMediaUrl('https://sns-img-bd.xhscdn.com/a')['host'] !== 'sns-img-bd.xhscdn.com') {
        throw new Exception('guard: allowed host must parse');
    }
    // static.py file signatures
    $png = "\x89PNG\r\n\x1a\n" . "\x00\x00\x00\x00";
    if (detectFileType($png) !== 'png') throw new Exception('guard: png signature');
    $mp4 = "\x00\x00\x00\x20ftypisom";
    if (detectFileType($mp4) !== 'mp4') throw new Exception('guard: mp4 signature');
    if (detectFileType("\x01\x02\x03") !== '') throw new Exception('guard: unknown signature');
    // /api/thumb must classify by real bytes, never by a fabricated MIME.
    if (!in_array(detectFileType($png), IMAGE_SUFFIXES, true)) throw new Exception('guard: png must be an image');
    if (!in_array(detectFileType('GIF89a'), IMAGE_SUFFIXES, true)) {
        throw new Exception('guard: gif must be an image');
    }
    if (in_array(detectFileType($mp4), IMAGE_SUFFIXES, true)) {
        throw new Exception('guard: mp4 must not be treated as an image');
    }
    if (IMAGE_MIME_BY_SUFFIX['png'] !== 'image/png') throw new Exception('guard: png mime');
    return 'media_guard_ok';
}

function selftestRiskControl()
{
    // Real verification hop observed when this service ran on a datacenter IP:
    // the short link resolved, but xiaohongshu answered with a captcha page.
    $captcha =
        'https://www.xiaohongshu.com/website-login/captcha?redirectPath=http%3A%2F%2Fwww.xiaohongshu.com' .
        '%2Fdiscovery%2Fitem%2F6a068472000000000803f503%3Fapp_platform%3Dandroid%26ignoreEngage%3Dtrue' .
        '%26app_version%3D9.45.1%26share_from_user_hidden%3Dtrue%26xsec_source%3Dapp_share%26type%3Dvideo' .
        '%26xsec_token%3DCBiCODxBwN-F0910X2rFedvHyPMEPPeCY-NQxidj4_tJM%253D%26author_share%3D1' .
        '%26xhsshare%3DCopyLink%26shareRedId%3DODo7RUk2Skw2NzUyOTgwNjhEOTo7PT86%26apptime%3D1789134927' .
        '%26share_id%3Dad8feb7f06194a01b472a8aba4a830a6%26share_channel%3Dcopy_link' .
        '%26track_code%3D1j2tUD6RufO%26exSource%3Dnull&verifyUuid=6dd5d8b4-768c-466e-ba75-823be230caf6' .
        '&verifyType=217&verifyBiz=461&verifyMsg=null';

    if (!isRiskControlUrl($captcha)) throw new Exception('risk: captcha url not detected');
    if (isRiskControlUrl('https://www.xiaohongshu.com/explore/abc?xsec_token=T')) {
        throw new Exception('risk: note url wrongly flagged');
    }
    if (isRiskControlUrl('')) throw new Exception('risk: empty url wrongly flagged');

    $recovered = recoverNoteUrlFromRedirect($captcha);
    if ($recovered === '') throw new Exception('risk: failed to recover note url from redirectPath');
    if (strpos($recovered, '/discovery/item/6a068472000000000803f503') === false) {
        throw new Exception('risk: recovered wrong target -> ' . $recovered);
    }
    $noteId = extractLinkId($recovered);
    if ($noteId !== '6a068472000000000803f503') {
        throw new Exception('risk: recovered note id -> ' . $noteId);
    }
    // the recovered target is http:// and must be upgraded for the site hosts
    if (strpos($recovered, 'http://') !== 0) throw new Exception('risk: expected http redirect target');
    if (strpos(preferHttpsForSite($recovered), 'https://www.xiaohongshu.com/') !== 0) {
        throw new Exception('risk: site url not upgraded to https');
    }
    // media URLs must not be rewritten by the site upgrade
    $media = 'http://sns-bak-v1.xhscdn.com/stream/1/110/258/x.mp4';
    if (preferHttpsForSite($media) !== $media) throw new Exception('risk: media url must stay untouched');

    if (recoverNoteUrlFromRedirect('https://www.xiaohongshu.com/explore/abc?x=1') !== '') {
        throw new Exception('risk: non-captcha url must not yield a target');
    }
    if (recoverNoteUrlFromRedirect('not a url') !== '') {
        throw new Exception('risk: invalid url must not throw');
    }
    if (!looksLikeRiskControlHtml('<html>/website-login/captcha</html>')) {
        throw new Exception('risk: html detection');
    }
    if (looksLikeRiskControlHtml('<html>normal note page</html>')) {
        throw new Exception('risk: normal html wrongly flagged');
    }
    return 'risk_control_ok';
}

function selftestResult()
{
    $checks = [];
    try {
        $checks[] = selftestJsonLike();
        $checks[] = selftestInitialState();
        $checks[] = selftestExtractLinks();
        $checks[] = selftestExplore();
        $checks[] = selftestImage();
        $checks[] = selftestVideo();
        $checks[] = selftestNaming();
        $checks[] = selftestMediaGuard();
        $checks[] = selftestRiskControl();
        return ['ok' => true, 'checks' => $checks];
    } catch (Throwable $error) {
        return [
            'ok' => false,
            'error' => [
                'code' => 'selftest_failed',
                'message' => $error->getMessage(),
                'detail' => ['checks' => $checks],
            ],
        ];
    }
}

function handleSelfTest()
{
    $result = selftestResult();
    jsonResponse($result['ok'] ? 200 : 500, $result);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function dispatch()
{
    if (requestMethod() === 'OPTIONS') {
        if (!headers_sent()) {
            http_response_code(204);
            foreach (CORS_HEADERS as $k => $v) header($k . ': ' . $v);
        }
        exit;
    }
    try {
        $path = currentPath();
        if ($path === '/' || $path === '/app' || $path === '/index.html' || $path === '/index.php') {
            return handlePage();
        }
        if ($path === '/help' || $path === '/api') return handleHelp();
        if ($path === '/api/sample' || $path === '/sample') return handleSample();
        if ($path === '/api/parse' || $path === '/parse') return handleParse();
        if ($path === '/api/probe' || $path === '/probe') return handleProbe();
        if ($path === '/api/thumb' || $path === '/thumb') return handleThumb();
        if ($path === '/dl' || $path === '/api/dl' || $path === '/download') return handleDownload();
        if ($path === '/api/selftest' || $path === '/selftest') return handleSelfTest();
        jsonResponse(404, errorBody('not_found', '未知路径 ' . currentFullUrl()));
    } catch (XhsParseError $error) {
        jsonResponse(
            statusForCode($error->errorCode),
            errorBody($error->errorCode, $error->getMessage(), $error->detail)
        );
    } catch (Throwable $error) {
        jsonResponse(500, errorBody('internal', $error->getMessage()));
    }
}

// ---------------------------------------------------------------------------
// Entry point: CLI runs the deterministic self-test, the web SAPI routes.
// ---------------------------------------------------------------------------

if (PHP_SAPI === 'cli') {
    $result = selftestResult();
    echo jsonText($result), PHP_EOL;
    exit($result['ok'] ? 0 : 1);
}

dispatch();

