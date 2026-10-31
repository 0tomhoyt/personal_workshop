// Mac↔Mac 同步监听（gateway.sync，同进程第二/第三监听，默认关闭）。
//
// 与主监听（8484）/ 电视监听（8490）的关系：
//   - 主监听与 TV 一行不动；本口永不挂 /admin/*、/v1/* 代理；
//   - 只认 /sync/v1/* 白名单；数据同进程调 listTodos / createTodo / updateTodo / deleteTodo。
//
// 请求顺序：
//   ① Host 反 rebinding（复用 tv-net.hostAllowed）
//   ② 来源 IP ∈ gateway.sync.allowedCidrs（默认私网 + 回环 + Tailscale CGNAT）
//   ③ 路由白名单
//   ④ Authorization: Bearer 或 X-Workshop-Token（timingSafeEqual；与 clientToken / TV token 互不复用）
//   ⑤ 每 token 限速
import http from 'node:http';
import { URL } from 'node:url';
import { normalizeAddress, inCidrs, hostAllowed } from './tv-net.mjs';
import { safeEqual } from './gwauth.mjs';
import { tryGetConfig } from './config.mjs';
import { listTodos, createTodo, updateTodo, deleteTodo } from './todos.mjs';
import { buildSyncSnapshot } from './sync-snapshot.mjs';
import { createRateLimiter, bucketKey } from './tv-server.mjs';
import { log } from './log.mjs';
import { sendJson, httpError } from './util.mjs';

const HEALTH = '/sync/v1/health';
const SNAPSHOT = '/sync/v1/snapshot';
const TODOS = '/sync/v1/todos';

const tokenLabel = (name) => (name ? String(name).slice(0, 40) : '-');

/** 从 Authorization Bearer 或 X-Workshop-Token 取出明文；命中则返回 token 名。 */
export function matchSyncToken(req, tokens) {
  const h = req.headers || {};
  const bearer = /^Bearer\s+(.+)$/i.exec(String(h.authorization || ''));
  const presented = String((bearer?.[1] ?? h['x-workshop-token'] ?? '')).trim();
  if (!presented) return null;
  for (const t of tokens) {
    if (safeEqual(presented, t.token)) return t.name;
  }
  return null;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error(`请求体超上限 ${limit} 字节`), { status: 413, code: 'body_too_large' }));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseTodoId(urlPath) {
  // /sync/v1/todos/<id> —— id 不允许再含 /
  const m = /^\/sync\/v1\/todos\/([^/]+)$/.exec(urlPath);
  return m ? decodeURIComponent(m[1]) : null;
}

function isWhitelisted(urlPath, method) {
  if (urlPath === HEALTH || urlPath === SNAPSHOT) {
    return method === 'GET' || method === 'HEAD';
  }
  if (urlPath === TODOS) return method === 'POST';
  const id = parseTodoId(urlPath);
  if (id) return method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  return false;
}

export function createSyncHandler({ now = () => Date.now(), limiter } = {}) {
  return async function handle(req, res) {
    const started = Date.now();
    const ip = normalizeAddress(req.socket?.remoteAddress);
    let tokenName = null;
    const finish = (status) => log(`sync ${req.method} ${(req.url || '').split('?')[0]} ${ip} token=${tokenLabel(tokenName)} → ${status} ${Date.now() - started}ms`);

    try {
      const config = tryGetConfig();
      const sync = config.sync ?? { enabled: false, tokens: [], allowedCidrs: [], maxPerMinute: 120 };

      if (!hostAllowed(req.headers.host)) {
        finish(403);
        return sendJson(res, 403, { error: { message: 'Host 不被接受', type: 'forbidden' } });
      }
      if (!inCidrs(ip, sync.allowedCidrs)) {
        finish(403);
        return sendJson(res, 403, { error: { message: '来源地址不在允许的网段内', type: 'forbidden' } });
      }

      const rawUrl = req.url || '/';
      const urlPath = rawUrl.split('?')[0];
      if (!isWhitelisted(urlPath, req.method)) {
        // 方法不对但路径像白名单：给 405；完全陌生路径 404（不泄露 /admin 是否存在）
        if ((urlPath === HEALTH || urlPath === SNAPSHOT || urlPath === TODOS || parseTodoId(urlPath))
          && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST'
          && req.method !== 'PATCH' && req.method !== 'PUT' && req.method !== 'DELETE') {
          res.setHeader('allow', 'GET, HEAD, POST, PATCH, PUT, DELETE');
          finish(405);
          return sendJson(res, 405, { error: { message: '方法不允许', type: 'method_not_allowed' } });
        }
        finish(404);
        return sendJson(res, 404, { error: { message: '未知路径', type: 'not_found' } });
      }

      if (!sync.tokens?.length) {
        finish(401);
        return sendJson(res, 401, { error: { message: '同步 token 未配置', type: 'unauthorized' } });
      }

      const max = sync.maxPerMinute ?? 120;
      const name = matchSyncToken(req, sync.tokens);
      tokenName = name;
      if (!name) {
        if (!limiter.take(`fail:${ip}`, max * 3)) {
          res.setHeader('retry-after', '60');
          finish(429);
          return sendJson(res, 429, { error: { message: '请求过于频繁', type: 'rate_limited' } });
        }
        finish(401);
        return sendJson(res, 401, { error: { message: '缺少或错误的同步 token（Authorization: Bearer 或 X-Workshop-Token）', type: 'unauthorized' } });
      }
      if (!limiter.take(bucketKey(`sync:${name}`), max)) {
        res.setHeader('retry-after', '60');
        finish(429);
        return sendJson(res, 429, { error: { message: '请求过于频繁', type: 'rate_limited' } });
      }

      if (urlPath === HEALTH) {
        finish(200);
        return sendJson(res, 200, {
          ok: true,
          service: 'gateway-sync',
          version: 1,
          now: now(),
          uptimeSec: Math.round(process.uptime()),
          role: 'hub',
        });
      }

      if (urlPath === SNAPSHOT) {
        let since = null;
        try {
          const u = new URL(rawUrl, 'http://sync.local');
          const s = u.searchParams.get('since');
          if (s != null && s !== '') since = Number(s);
        } catch {}
        const snap = buildSyncSnapshot({ todos: listTodos(), now: now(), since });
        finish(200);
        return sendJson(res, 200, snap);
      }

      if (urlPath === TODOS && req.method === 'POST') {
        const bodyBuf = await readBody(req);
        let input = {};
        if (bodyBuf.length) {
          try { input = JSON.parse(bodyBuf.toString('utf8')); }
          catch { throw httpError(400, '请求体不是合法 JSON', 'invalid_json'); }
        }
        const todo = createTodo(input);
        finish(201);
        return sendJson(res, 201, buildSyncSnapshot({ todos: [todo], now: now() }).todos[0]);
      }

      const id = parseTodoId(urlPath);
      if (id && (req.method === 'PATCH' || req.method === 'PUT')) {
        const bodyBuf = await readBody(req);
        let patch = {};
        if (bodyBuf.length) {
          try { patch = JSON.parse(bodyBuf.toString('utf8')); }
          catch { throw httpError(400, '请求体不是合法 JSON', 'invalid_json'); }
        }
        // 乐观锁：若带 rev 且与当前 updated_at 不一致 → 409
        if (patch.rev != null) {
          const cur = listTodos().find((t) => t.id === id);
          if (cur && Number(patch.rev) !== Number(cur.updated_at)) {
            finish(409);
            return sendJson(res, 409, {
              error: { message: 'rev 过期', type: 'conflict' },
              todo: buildSyncSnapshot({ todos: [cur], now: now() }).todos[0],
            });
          }
          delete patch.rev;
        }
        const todo = updateTodo(id, patch);
        finish(200);
        return sendJson(res, 200, buildSyncSnapshot({ todos: [todo], now: now() }).todos[0]);
      }

      if (id && req.method === 'DELETE') {
        deleteTodo(id);
        finish(204);
        res.writeHead(204);
        return res.end();
      }

      finish(404);
      return sendJson(res, 404, { error: { message: '未知路径', type: 'not_found' } });
    } catch (e) {
      const status = e.status ?? 500;
      finish(status);
      if (!res.headersSent) {
        return sendJson(res, status, { error: { message: e.message, type: e.code ?? 'internal_error' } });
      }
      try { res.end(); } catch {}
    }
  };
}

/**
 * 起同步监听。返回 { server, port } 或 null（未启用 / 未配 token / 起不来）。
 */
export async function startSyncServer() {
  const sync = tryGetConfig().sync;
  if (!sync?.enabled) return null;
  if (!sync.tokens?.length) {
    log('gateway.sync.enabled 为 true 但没有配置 tokens：不启动同步监听');
    return null;
  }
  const limiter = createRateLimiter();
  const server = http.createServer((req, res) => {
    Promise.resolve(createSyncHandler({ limiter })(req, res)).catch((e) => {
      log(`sync handler 未捕获: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal_error', type: 'internal_error' } });
    });
  });
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });
  server.on('error', (e) => log(`同步监听错误: ${e.message}`));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sync.port, sync.bind, () => { server.off('error', reject); resolve(); });
    });
  } catch (e) {
    log(`同步监听 ${sync.bind}:${sync.port} 启动失败: ${e.message}`);
    try { server.close(); } catch {}
    return null;
  }
  log(`同步监听就绪: http://${sync.bind}:${sync.port}/sync/v1/health`
    + `（${sync.tokens.length} 个 token；来源 ${sync.allowedCidrs.join(', ')}；每 token ${sync.maxPerMinute}/分钟）`);
  return { server, port: sync.port };
}
