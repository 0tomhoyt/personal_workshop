// Mac↔Mac 同步监听（gateway.sync，同进程第二/第三监听，默认关闭）。
//
// 与主监听（8484）/ 电视监听（8490）的关系：
//   - 主监听与 TV 一行不动；本口永不挂 /admin/*、/v1/* 代理；
//   - 只认 /sync/v1/* 白名单；数据同进程调 listTodos / createTodo / updateTodo / deleteTodo，
//     以及可共享 config、按设备分桶的 stats。
//
// 请求顺序：
//   ① Host 反 rebinding（复用 tv-net.hostAllowed）
//   ② 来源 IP ∈ gateway.sync.allowedCidrs（默认私网 + 回环 + Tailscale CGNAT）
//   ③ 路由白名单
//   ④ Authorization: Bearer 或 X-Workshop-Token（timingSafeEqual；与 clientToken / TV token 互不复用）
//   ⑤ 每 token 限速
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import { normalizeAddress, inCidrs, hostAllowed } from './tv-net.mjs';
import { safeEqual } from './gwauth.mjs';
import { tryGetConfig, CONFIG_FILE, validateRawConfig } from './config.mjs';
import { listTodos, createTodo, updateTodo, deleteTodo, applyRemoteTodo } from './todos.mjs';
import { buildSyncSnapshot } from './sync-snapshot.mjs';
import { wrapConfigForSync, applyShareableToRaw, configContentRev, extractShareableConfig } from './sync-config.mjs';
import {
  migrateHubStatsStore,
  replaceDeviceDays,
  wrapStatsForSync,
  sanitizeDaysForSync,
} from './sync-stats.mjs';
import { getLocalStatsDays, writeSyncedStatsDays } from './stats.mjs';
import { createRateLimiter, bucketKey } from './tv-server.mjs';
import { log } from './log.mjs';
import { sendJson, httpError } from './util.mjs';

const HEALTH = '/sync/v1/health';
const SNAPSHOT = '/sync/v1/snapshot';
const TODOS = '/sync/v1/todos';
const CONFIG_PATH = '/sync/v1/config';
const STATS_PATH = '/sync/v1/stats';

const SCRIPT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HUB_STATS_FILE = process.env.CANNBOT_SYNC_STATS_FILE
  || path.join(SCRIPT_DIR, 'stats-sync-hub.json');

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

function readBody(req, limit = 2 * 1024 * 1024) {
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
  const m = /^\/sync\/v1\/todos\/([^/]+)$/.exec(urlPath);
  return m ? decodeURIComponent(m[1]) : null;
}

function isWhitelisted(urlPath, method) {
  if (urlPath === HEALTH || urlPath === SNAPSHOT) {
    return method === 'GET' || method === 'HEAD';
  }
  if (urlPath === TODOS) return method === 'POST';
  if (urlPath === CONFIG_PATH) return method === 'PUT' || method === 'PATCH' || method === 'GET';
  if (urlPath === STATS_PATH) return method === 'POST' || method === 'GET';
  const id = parseTodoId(urlPath);
  if (id) return method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  return false;
}

function hubDeviceId() {
  const cfg = tryGetConfig().syncClient;
  if (cfg?.deviceId) return cfg.deviceId;
  try { return os.hostname().replace(/\.local$/i, '') || 'hub'; } catch { return 'hub'; }
}

function readRawProviders() {
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { raw: JSON.parse(text), mtimeMs: fs.statSync(CONFIG_FILE).mtimeMs };
  } catch (e) {
    if (e.code === 'ENOENT') return { raw: null, mtimeMs: null, missing: true };
    throw httpError(500, `providers.json 读取失败: ${e.message}`, 'config_read_failed');
  }
}

function atomicWriteProviders(raw) {
  validateRawConfig(raw);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw httpError(500, `providers.json 写入失败: ${e.message}`, 'config_write_failed');
  }
}

function loadHubStatsStore() {
  try {
    const d = JSON.parse(fs.readFileSync(HUB_STATS_FILE, 'utf8'));
    return migrateHubStatsStore(d);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`stats-sync-hub.json 读取失败（空仓起步）: ${e.message}`);
    return migrateHubStatsStore(null);
  }
}

function saveHubStatsStore(store) {
  const tmp = `${HUB_STATS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, HUB_STATS_FILE);
}

function buildConfigSection() {
  const { raw, mtimeMs, missing } = readRawProviders();
  if (missing || !raw) {
    return wrapConfigForSync({ providers: tryGetConfig().providers || [], gateway: {}, routing: {}, pricing: {}, monitors: {}, workbench: {} }, { mtimeMs: null });
  }
  return wrapConfigForSync(raw, { mtimeMs });
}

function buildStatsSection(now) {
  const store = loadHubStatsStore();
  let hubLocal = null;
  try { hubLocal = getLocalStatsDays(); } catch { hubLocal = null; }
  const section = wrapStatsForSync(store, { hubLocalDays: hubLocal, hubDeviceId: hubDeviceId(), now });
  // 枢纽本机无 syncClient，不会像 spoke 那样拉快照写 stats-sync.json；
  // 这里把跨设备 sum（含 hubLocal overlay）写给 statsSnapshot 展示，避免工作台只见本机空用量。
  try {
    writeSyncedStatsDays(section.days, { rev: section.rev || 0 });
  } catch (e) {
    log(`枢纽用量展示文件写入失败: ${e.message}`);
  }
  return section;
}

/** 刷新枢纽本机工作台用量展示（写 stats-sync.json）；供启动与定时器调用。 */
export function refreshHubStatsDisplay(now = Date.now()) {
  return buildStatsSection(now);
}

function fullSnapshot(now, since) {
  return buildSyncSnapshot({
    todos: listTodos(),
    now,
    since,
    config: buildConfigSection(),
    stats: buildStatsSection(now),
  });
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
        if ((urlPath === HEALTH || urlPath === SNAPSHOT || urlPath === TODOS || urlPath === CONFIG_PATH
          || urlPath === STATS_PATH || parseTodoId(urlPath))
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
          version: 2,
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
        const snap = fullSnapshot(now(), since);
        finish(200);
        return sendJson(res, 200, snap);
      }

      if (urlPath === CONFIG_PATH && req.method === 'GET') {
        finish(200);
        return sendJson(res, 200, buildConfigSection());
      }

      if (urlPath === CONFIG_PATH && (req.method === 'PUT' || req.method === 'PATCH')) {
        const bodyBuf = await readBody(req);
        let input = {};
        if (bodyBuf.length) {
          try { input = JSON.parse(bodyBuf.toString('utf8')); }
          catch { throw httpError(400, '请求体不是合法 JSON', 'invalid_json'); }
        }
        const current = buildConfigSection();
        const clientRev = input.rev != null ? String(input.rev) : null;
        // 乐观锁：带了 rev 且与当前不一致 → 409（除非 force）
        if (clientRev != null && clientRev !== String(current.rev) && input.force !== true) {
          finish(409);
          return sendJson(res, 409, {
            error: { message: 'config rev 过期', type: 'conflict' },
            config: current,
          });
        }
        const shared = {
          providers: input.providers,
          routing: input.routing,
          pricing: input.pricing,
          monitors: input.monitors,
          workbench: input.workbench,
          gateway: input.gateway,
        };
        if (!Array.isArray(shared.providers) || shared.providers.length === 0) {
          throw httpError(400, 'config.providers 必须为非空数组', 'bad_request');
        }
        const { raw: localRaw, missing } = readRawProviders();
        const base = missing || !localRaw
          ? { version: 1, gateway: {}, providers: shared.providers }
          : localRaw;
        const merged = applyShareableToRaw(base, shared);
        atomicWriteProviders(merged);
        const next = buildConfigSection();
        log(`sync config 已由 ${tokenLabel(tokenName)} 更新 rev=${next.rev}`);
        finish(200);
        return sendJson(res, 200, next);
      }

      if (urlPath === STATS_PATH && req.method === 'GET') {
        finish(200);
        return sendJson(res, 200, buildStatsSection(now()));
      }

      if (urlPath === STATS_PATH && req.method === 'POST') {
        const bodyBuf = await readBody(req);
        let input = {};
        if (bodyBuf.length) {
          try { input = JSON.parse(bodyBuf.toString('utf8')); }
          catch { throw httpError(400, '请求体不是合法 JSON', 'invalid_json'); }
        }
        const deviceId = String(input.deviceId || tokenName || 'unknown').trim() || 'unknown';
        const days = sanitizeDaysForSync(input.days || {});
        const store = loadHubStatsStore();
        const { store: next, changed } = replaceDeviceDays(store, deviceId, days, { now: now() });
        if (changed) saveHubStatsStore(next);
        // 统一走 buildStatsSection：重读仓 + hubLocal overlay，并写 stats-sync.json 供本机工作台展示
        const section = buildStatsSection(now());
        finish(200);
        return sendJson(res, 200, {
          ok: true,
          changed,
          deviceId,
          stats: section,
        });
      }

      if (urlPath === TODOS && req.method === 'POST') {
        const bodyBuf = await readBody(req);
        let input = {};
        if (bodyBuf.length) {
          try { input = JSON.parse(bodyBuf.toString('utf8')); }
          catch { throw httpError(400, '请求体不是合法 JSON', 'invalid_json'); }
        }
        const clientId = typeof input.id === 'string' ? input.id.trim() : '';
        if (clientId) {
          const cur = listTodos().find((t) => t.id === clientId);
          if (cur) {
            finish(409);
            return sendJson(res, 409, {
              error: { message: 'id 已存在', type: 'conflict' },
              todo: buildSyncSnapshot({ todos: [cur], now: now() }).todos[0],
            });
          }
          applyRemoteTodo({
            ...input,
            id: clientId,
            rev: input.rev ?? input.updated_at ?? Date.now(),
          });
          const todo = listTodos().find((t) => t.id === clientId);
          finish(201);
          return sendJson(res, 201, buildSyncSnapshot({ todos: [todo], now: now() }).todos[0]);
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
  // 枢纽无 syncClient：启动即刷一次展示文件，再按与 spoke 同量级间隔刷新（叠本机 live）
  const HUB_STATS_DISPLAY_MS = 15_000;
  try { refreshHubStatsDisplay(); } catch (e) { log(`枢纽用量展示首次刷新失败: ${e.message}`); }
  const hubStatsTimer = setInterval(() => {
    try { refreshHubStatsDisplay(); } catch (e) { log(`枢纽用量展示定时刷新失败: ${e.message}`); }
  }, HUB_STATS_DISPLAY_MS);
  if (typeof hubStatsTimer.unref === 'function') hubStatsTimer.unref();
  server.on('close', () => { clearInterval(hubStatsTimer); });
  log(`同步监听就绪: http://${sync.bind}:${sync.port}/sync/v1/health`
    + `（${sync.tokens.length} 个 token；来源 ${sync.allowedCidrs.join(', ')}；每 token ${sync.maxPerMinute}/分钟）`);
  return { server, port: sync.port };
}
