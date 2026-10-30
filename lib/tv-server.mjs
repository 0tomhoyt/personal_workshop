// 电视工作台的 LAN 监听（设计稿 §6.2 B1：同进程第二监听）。
//
// 与主监听（8484，只绑 127.0.0.1）的关系：
//   - 主监听一行不动，/v1/* 与 /admin/* 的威胁模型完全不变；
//   - 这里只认三个白名单路由，其余（含 /admin/*、/v1/*）一律 404——连「路径存在与否」
//     都不告诉未授权方以外的任何人；
//   - 数据由同进程直接调 listTodos() / statsSnapshot()，不走回环 HTTP。
//
// 请求顺序（后一步只在前一步通过后才做）：
//   ① Host 反 rebinding（只接受 IP 字面量、.local、localhost）
//   ② 来源 IP 必须落在 gateway.tv.allowedCidrs（默认三个私网段 + 回环）
//   ③ 路由白名单（/tv/v1/snapshot、/tv/v1/health；GET only）
//   ④ X-Aerial-Token（每台电视一枚，timingSafeEqual；与 clientToken 互不复用）
//   ⑤ 每 token 每分钟限速（默认 30）
//
// 日志只记 token 名 + 前缀 + 来源 IP + 状态码，绝不记全文——客厅电视的 token 会
// 随明文 HTTP 在 LAN 上可见，日志里再存一份只会扩大泄漏面。
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { normalizeAddress, inCidrs, hostAllowed } from './tv-net.mjs';
import { safeEqual } from './gwauth.mjs';
import { tryGetConfig } from './config.mjs';
import { listTodos } from './todos.mjs';
import { statsSnapshot } from './stats.mjs';
import { authStatus } from './upstream.mjs';
import { buildSnapshot, etagOf, etagMatches, fitToLimit } from './tv-snapshot.mjs';
import { log } from './log.mjs';
import { sendJson } from './util.mjs';

const ROUTES = new Set(['/tv/v1/snapshot', '/tv/v1/health']);

// 地址、CIDR、Host 的解析在 lib/tv-net.mjs（config.mjs 校验 allowedCidrs 时用同一套）。
export { normalizeAddress, inCidrs, hostAllowed, parseCidr } from './tv-net.mjs';

// ── 限速：一个 60 s 滑动窗口，键由调用方给 ─────────────────────────────────
// 上限每次现读配置（改 maxPerMinute 不用重启）。成功请求按 token 计数；**失败请求按来源
// IP 计数**——不然明文 LAN 上的 token 可以无限次猜，限速形同虚设。
export function createRateLimiter(windowMs = 60_000) {
  const hits = new Map(); // key → 时间戳数组
  return {
    /** 记一次并返回是否放行；被拒时不记（否则持续轮询会把窗口一直撑满）。 */
    take(key, max, now = Date.now()) {
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      return true;
    },
    /** 测试用：清空窗口。 */
    reset() { hits.clear(); },
  };
}

// ── 鉴权：X-Aerial-Token → 命中的 token 名（绝不返回 token 本身）─────────────
export function matchTvToken(req, tokens) {
  const presented = String(req.headers['x-aerial-token'] || '').trim();
  if (!presented) return null;
  for (const t of tokens) {
    if (safeEqual(presented, t.token)) return t.name;
  }
  return null;
}

/**
 * 限速的桶键：token 名的短哈希，而不是名字本身。
 * 名字由用户填、可以重名（两台都叫「客厅」），按名字分桶等于让两台电视共用一个额度；
 * 哈希既能把它们分开，也不把名字放进内存键里。
 */
export function bucketKey(name) {
  return createHash('sha1').update(String(name)).digest('base64url').slice(0, 12);
}

/**
 * 日志里的 token 标识：**不**记请求方提交的 token（那在成功时就是真 token 的前几位），
 * 只记配置里这个 token 的名字。未通过鉴权时记 `-`——栏位保留，便于对状态码。
 */
const tokenLabel = (name) => (name ? String(name).slice(0, 40) : '-');

// ── 快照 ────────────────────────────────────────────────────────────────────
// 只回「是否都正常」，不回 provider id：电视不需要知道这台 Mac 订了哪些服务，
// 而这些名字本身是配置信息，没必要在 LAN 上多给一份。
function providerHealth() {
  const config = tryGetConfig();
  const providers = (config.providers ?? []).filter((p) => p.enabled);
  let ok = providers.length > 0;
  for (const p of providers) {
    try { if (!(authStatus(p)?.ok ?? authStatus(p)?.jwt?.ok)) ok = false; } catch { ok = false; }
    if (!ok) break;
  }
  return { ok };
}

export function snapshotNow(now = Date.now()) {
  return fitToLimit(buildSnapshot({ todos: listTodos(), stats: statsSnapshot(), now, health: providerHealth() }));
}

function writeJson(req, res, status, obj, { etag, cacheSeconds = 0 } = {}) {
  return writeBody(req, res, status, Buffer.from(JSON.stringify(obj)), { etag, cacheSeconds });
}

function writeBody(req, res, status, raw, { etag, cacheSeconds = 0 } = {}) {
  let body = raw;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheSeconds > 0 ? `private, max-age=${cacheSeconds}` : 'no-store',
    'x-content-type-options': 'nosniff',
    vary: 'Accept-Encoding',
  };
  // One strong ETag for both encodings: the entity is the JSON, and gzip is a transfer coding;
  // Vary: Accept-Encoding keeps caches from mixing them.
  if (etag) headers.etag = etag;
  if (/gzip/i.test(String(req.headers['accept-encoding'] || '')) && body.length > 512) {
    body = gzipSync(body);
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createTvHandler({ now = () => Date.now(), limiter } = {}) {
  return function handle(req, res) {
    const started = Date.now();
    const ip = normalizeAddress(req.socket?.remoteAddress);
    let tokenName = null;
    const finish = (status) => log(`tv ${req.method} ${(req.url || '').split('?')[0]} ${ip} token=${tokenLabel(tokenName)} → ${status} ${Date.now() - started}ms`);

    const config = tryGetConfig();
    const tv = config.tv ?? { enabled: false, tokens: [], allowedCidrs: [], cacheSeconds: 5, maxPerMinute: 30 };

    if (!hostAllowed(req.headers.host)) {
      finish(403);
      return sendJson(res, 403, { error: { message: 'Host 不被接受', type: 'forbidden' } });
    }
    if (!inCidrs(ip, tv.allowedCidrs)) {
      finish(403);
      return sendJson(res, 403, { error: { message: '来源地址不在允许的私网段内', type: 'forbidden' } });
    }

    // 入口剥掉 query，与主监听同口径；白名单外一律 404（不区分路由是否存在）
    const url = (req.url || '/').split('?')[0];
    if (!ROUTES.has(url)) {
      finish(404);
      return sendJson(res, 404, { error: { message: '未知路径', type: 'not_found' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      finish(405);
      return sendJson(res, 405, { error: { message: '此端点仅支持 GET', type: 'method_not_allowed' } });
    }

    // 没配 token 时（理论上不会监听）也不放行：默认拒绝
    if (!tv.tokens?.length) {
      finish(401);
      return sendJson(res, 401, { error: { message: '电视 token 未配置', type: 'unauthorized' } });
    }
    // 失败尝试按来源 IP 计数：401 也要限速，否则明文 LAN 上的 token 可以无限次猜。
    // 上限取 maxPerMinute 的 3 倍（成功轮询 1 次/分钟，正常用户永远碰不到）。
    const max = tv.maxPerMinute ?? 30;
    const name = matchTvToken(req, tv.tokens);
    tokenName = name;
    if (!name) {
      if (!limiter.take(`fail:${ip}`, max * 3)) {
        res.setHeader('retry-after', '60');
        finish(429);
        return sendJson(res, 429, { error: { message: '请求过于频繁', type: 'rate_limited' } });
      }
      finish(401);
      return sendJson(res, 401, { error: { message: '缺少或错误的 X-Aerial-Token', type: 'unauthorized' } });
    }
    if (!limiter.take(bucketKey(name), max)) {
      res.setHeader('retry-after', '60');
      finish(429);
      return sendJson(res, 429, { error: { message: '请求过于频繁', type: 'rate_limited' } });
    }

    if (url === '/tv/v1/health') {
      finish(200);
      return writeJson(req, res, 200, {
        ok: true,
        service: 'gateway-tv',
        version: 1,
        now: now(),
        uptimeSec: Math.round(process.uptime()),
      }, { cacheSeconds: 0 });
    }

    const snapshot = snapshotNow(now());
    const body = JSON.stringify(snapshot);
    const etag = etagOf(body);
    const cacheSeconds = tv.cacheSeconds ?? 5;
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag, 'cache-control': `private, max-age=${cacheSeconds}`, vary: 'Accept-Encoding' });
      finish(304);
      return res.end();
    }
    finish(200);
    return writeBody(req, res, 200, Buffer.from(body), { etag, cacheSeconds });
  };
}

/**
 * 起 LAN 监听。返回 { server, port } 或 null（未启用 / 未配 token / 起不来）。
 * 调用方只负责在进程退出时 close。
 */
export async function startTvServer() {
  const tv = tryGetConfig().tv;
  if (!tv?.enabled) return null;
  if (!tv.tokens?.length) {
    log('gateway.tv.enabled 为 true 但没有配置 tokens：不启动电视监听');
    return null;
  }
  const limiter = createRateLimiter();
  const server = http.createServer(createTvHandler({ limiter }));
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });
  // 运行期的 error 必须有监听者：没有就会抛未捕获异常，把 8484 主进程一起带走。
  server.on('error', (e) => log(`电视监听错误: ${e.message}`));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(tv.port, tv.bind, () => { server.off('error', reject); resolve(); });
    });
  } catch (e) {
    log(`电视监听 ${tv.bind}:${tv.port} 启动失败: ${e.message}`);
    try { server.close(); } catch {}
    return null;
  }
  log(`电视工作台监听就绪: http://${tv.bind}:${tv.port}/tv/v1/snapshot`
    + `（${tv.tokens.length} 个 token；来源 ${tv.allowedCidrs.join(', ')}；每 token ${tv.maxPerMinute}/分钟）`);
  return { server, port: tv.port };
}
