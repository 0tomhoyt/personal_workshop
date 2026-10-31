// Mac↔Mac 同步客户端（gateway.syncClient）：本机当 spoke，同进程轮询枢纽。
// 不另起 HTTP 监听；每轮：
//   ① 推本机 stats 设备切片（replace-by-device，防双计）
//   ② 拉 snapshot（todos + 墓碑 + config + 跨设备 stats sum）
//   ③ 合并 todos（含按墓碑删除）；按 rev 应用 config（保留本机 sync/syncClient/tv）；写入 stats-sync.json
//   ④ 推 todos（POST/PATCH/DELETE）；若本机 shareable config 比枢纽新则 PUT config
// 合并：远端 rev 严格更大才 apply，不新于本地墓碑的远端拒之门外（防重启全量拉取复活）；
// 推送：本机 updated_at > 已知枢纽 rev → PATCH，枢纽尚无此 id → POST，本机墓碑比枢纽
// 已知 rev 新 → DELETE（404 视为删成——另一台 spoke 可能先到了）。
import fs from 'node:fs';
import os from 'node:os';
import { tryGetConfig, CONFIG_FILE, validateRawConfig } from './config.mjs';
import { listTodos, applyRemoteTodo, applyRemoteTombstone, listTombstones } from './todos.mjs';
import { toSyncTodo } from './sync-snapshot.mjs';
import {
  extractShareableConfig,
  applyShareableToRaw,
  configContentRev,
  wrapConfigForSync,
} from './sync-config.mjs';
import { getLocalStatsDays, writeSyncedStatsDays } from './stats.mjs';
import { sanitizeDaysForSync } from './sync-stats.mjs';
import { log } from './log.mjs';

/**
 * 纯合并决策（单测用）：给定本地列表与远端 todos[]，返回应 apply 的远端条目。
 * 规则：无本地 id → apply；有本地且 remote.rev > local.updated_at → apply；否则跳过。
 * localTombstones：本地墓碑（本机删过的 id）。不新于墓碑的远端一律跳过——这是
 * 「已删待办在 spoke 重启全量拉取后复活」的关键防线；新于墓碑的远端胜出（别机
 * 在删除后又编辑过，LWW 让编辑复活，applyRemoteTodo 会清掉本地墓碑）。
 */
export function planRemoteMerges(localTodos, remoteTodos, localTombstones = []) {
  const byId = new Map((localTodos || []).map((t) => [String(t.id), t]));
  const tombRev = new Map((localTombstones || []).map((t) => [String(t.id), Number(t.rev) || 0]));
  const apply = [];
  const skip = [];
  for (const r of Array.isArray(remoteTodos) ? remoteTodos : []) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    const rev = Number(r.rev ?? r.updated_at) || 0;
    const tb = tombRev.get(id);
    if (tb != null && rev <= tb) { skip.push(id); continue; }
    const local = byId.get(id);
    if (!local || rev > (Number(local.updated_at) || 0)) apply.push(r);
    else skip.push(id);
  }
  return { apply, skip };
}

/**
 * 纯删除决策（单测用）：远端墓碑对照本地列表，返回本机该删的条目。
 * 只删「本地存在且比墓碑旧」的——本地更新说明别机在删除后又编辑过且本机已收到，
 * 留给推送端以更高 rev 复活枢纽（LWW）。本地没有的 id 无事可做。
 */
export function planRemoteDeletes(remoteTombstones, localTodos) {
  const byId = new Map((localTodos || []).map((t) => [String(t.id), t]));
  const del = [];
  const skip = [];
  for (const t of Array.isArray(remoteTombstones) ? remoteTombstones : []) {
    if (!t || t.id == null) continue;
    const id = String(t.id);
    const rev = Number(t.rev ?? t.updated_at) || 0;
    const local = byId.get(id);
    if (local && rev > (Number(local.updated_at) || 0)) del.push({ id, rev });
    else skip.push(id);
  }
  return { delete: del, skip };
}

/**
 * 纯推送决策：对照「已知枢纽 rev」决定 POST（枢纽没有）或 PATCH（本地更新）。
 * hubRevs: Map|Record id → 枢纽上次见到的 rev；缺省 id 视为枢纽没有 → post。
 * 相等不推（防把刚拉下来的再推回去）。
 * localTombstones：本机删过的 id。墓碑 rev > 已知枢纽 rev → 进 deletes（枢纽还留着
 * 旧版，该 DELETE）；「枢纽不认识该 id」无需删（从未推上去过）；「枢纽 rev 更新」
 * 不删——枢纽在删除后有更新（本机尚未拉到），拉取会用新 rev 复活本机（LWW）。
 */
export function planLocalPushes(localTodos, hubRevs, localTombstones = []) {
  const revs = hubRevs instanceof Map
    ? hubRevs
    : new Map(Object.entries(hubRevs || {}).map(([k, v]) => [String(k), Number(v) || 0]));
  const post = [];
  const patch = [];
  const deletes = [];
  for (const t of localTodos || []) {
    if (!t || t.id == null) continue;
    const id = String(t.id);
    const localRev = Number(t.updated_at) || 0;
    if (!revs.has(id)) {
      post.push(t);
      continue;
    }
    const hubRev = Number(revs.get(id)) || 0;
    if (localRev > hubRev) patch.push({ id, rev: hubRev, todo: t });
  }
  for (const t of localTombstones || []) {
    if (!t || t.id == null) continue;
    const id = String(t.id);
    const tombRev = Number(t.rev) || 0;
    if (revs.has(id) && tombRev > (Number(revs.get(id)) || 0)) deletes.push({ id, rev: tombRev });
  }
  return { post, patch, deletes };
}

/**
 * 409 冲突后怎么处理（纯函数）：用枢纽当前 todo 的 rev 与本地比。
 * - 枢纽更新 → apply 远端，不重试
 * - 本地仍更新 → 用新 hubRev 再 PATCH 一次
 * - 相等 → 对齐 rev，不重试
 */
export function planAfterConflict(localTodo, hubTodo) {
  if (!localTodo?.id || !hubTodo?.id) return { action: 'log', retry: false };
  const localRev = Number(localTodo.updated_at) || 0;
  const hubRev = Number(hubTodo.rev ?? hubTodo.updated_at) || 0;
  if (hubRev > localRev) return { action: 'apply', retry: false, hubRev, hubTodo };
  if (localRev > hubRev) return { action: 'retry', retry: true, hubRev, hubTodo };
  return { action: 'align', retry: false, hubRev, hubTodo };
}

/**
 * 配置同步决策（纯函数）：
 * - hubRev !== lastApplied → applyHub（拉下来的优先）
 * - localRev !== hubRev 且 localUpdatedAt > lastPullAt → pushLocal
 * - 否则 noop
 */
export function planConfigSync({ hubRev, localRev, lastAppliedRev, localUpdatedAt, lastPullAt }) {
  const hub = hubRev != null ? String(hubRev) : null;
  const local = localRev != null ? String(localRev) : null;
  const applied = lastAppliedRev != null ? String(lastAppliedRev) : null;
  if (hub && hub !== applied) return { action: 'applyHub' };
  if (local && hub && local !== hub) {
    const lu = Number(localUpdatedAt) || 0;
    const lp = Number(lastPullAt) || 0;
    if (lu > lp) return { action: 'pushLocal' };
  }
  return { action: 'noop' };
}

async function fetchJson(url, { token, method = 'GET', body = undefined, timeoutMs = 12_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: ac.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(t);
  }
}

function pushBodyFromLocal(todo) {
  const row = toSyncTodo(todo);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    urgency: row.urgency,
    project: row.project,
    note: row.note,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    rev: row.rev,
    ...(row.items ? { items: row.items } : {}),
  };
}

function resolveDeviceId(cfg) {
  if (cfg?.deviceId) return cfg.deviceId;
  try {
    return os.hostname().replace(/\.local$/i, '') || 'spoke';
  } catch {
    return 'spoke';
  }
}

function readLocalRawConfig() {
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    const st = fs.statSync(CONFIG_FILE);
    return { raw: JSON.parse(text), mtimeMs: st.mtimeMs };
  } catch (e) {
    if (e.code === 'ENOENT') return { raw: null, mtimeMs: 0, missing: true };
    throw e;
  }
}

function atomicWriteLocalConfig(raw) {
  validateRawConfig(raw);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * 起同步客户端轮询。返回 { stop } 或 null（未启用 / 缺 url|token）。
 */
export function startSyncClient() {
  const cfg = tryGetConfig().syncClient;
  if (!cfg?.enabled) return null;
  if (!cfg.url || !cfg.token) {
    log('gateway.syncClient.enabled 为 true 但 url 或 token 为空：不启动同步客户端');
    return null;
  }

  let cursor = 0;
  let stopped = false;
  let inFlight = false;
  let timer = null;
  /** @type {Map<string, number>} id → 枢纽已知 rev */
  const knownHubRev = new Map();
  let hubCatalogReady = false;
  let lastAppliedConfigRev = null;
  let lastPullAt = 0;
  let lastStatsRev = -1;
  const base = cfg.url.replace(/\/+$/, '');
  const token = cfg.token;
  const intervalMs = Math.max(5, cfg.intervalSec || 15) * 1000;
  const doPush = cfg.push !== false;
  const deviceId = resolveDeviceId(cfg);

  function rememberHubTodo(r) {
    if (!r || r.id == null) return;
    const id = String(r.id);
    const rev = Number(r.rev ?? r.updated_at) || 0;
    const prev = knownHubRev.has(id) ? knownHubRev.get(id) : -1;
    if (rev >= prev) knownHubRev.set(id, rev);
  }

  function applyHubConfig(hubConfig) {
    if (!hubConfig || !Array.isArray(hubConfig.providers) || !hubConfig.providers.length) return false;
    const { raw: localRaw, missing } = readLocalRawConfig();
    const baseRaw = missing || !localRaw
      ? { version: 1, gateway: {}, providers: hubConfig.providers }
      : localRaw;
    // 不带 monitors：显示器拓扑是本机事实（见 sync-config.mjs 的 SYNC_LOCAL_ONLY_KEYS）。
    // 枢纽即使下发了也不采用——applyShareableToRaw 会显式保留本机值。
    const shared = {
      providers: hubConfig.providers,
      routing: hubConfig.routing,
      pricing: hubConfig.pricing,
      workbench: hubConfig.workbench,
      gateway: hubConfig.gateway,
    };
    const merged = applyShareableToRaw(baseRaw, shared);
    // 校验角色键仍在
    const g = merged.gateway || {};
    if (baseRaw.gateway?.sync && !g.sync) throw new Error('apply 丢失 gateway.sync');
    if (baseRaw.gateway?.syncClient && !g.syncClient) throw new Error('apply 丢失 gateway.syncClient');
    atomicWriteLocalConfig(merged);
    lastAppliedConfigRev = String(hubConfig.rev || configContentRev(extractShareableConfig(merged)));
    log(`sync-client 已应用枢纽 config rev=${lastAppliedConfigRev}`);
    return true;
  }

  async function pushStatsOnce() {
    if (!doPush) return { ok: false };
    const days = sanitizeDaysForSync(getLocalStatsDays());
    const res = await fetchJson(`${base}/sync/v1/stats`, {
      token,
      method: 'POST',
      body: { deviceId, days },
      timeoutMs: 20_000,
    });
    if (!res.ok) {
      log(`sync-client 推送 stats → ${res.status}`);
      return { ok: false };
    }
    const rev = Number(res.body?.stats?.rev);
    if (Number.isFinite(rev)) lastStatsRev = rev;
    // 响应里已有求和视图：可先落盘，随后 pull 再对齐
    if (res.body?.stats?.days) {
      writeSyncedStatsDays(res.body.stats.days, { rev: res.body.stats.rev || 0 });
    }
    return { ok: true, changed: !!res.body?.changed };
  }

  async function pushConfigOnce(hubRev) {
    if (!doPush) return { ok: false };
    const { raw, mtimeMs, missing } = readLocalRawConfig();
    if (missing || !raw) return { ok: false };
    const wrapped = wrapConfigForSync(raw, { mtimeMs });
    if (String(wrapped.rev) === String(hubRev)) return { ok: true, skipped: true };
    // 同样不推 monitors：wrapped 来自 extractShareableConfig，本来就不含它
    const body = {
      rev: hubRev,
      providers: wrapped.providers,
      routing: wrapped.routing,
      pricing: wrapped.pricing,
      workbench: wrapped.workbench,
      gateway: wrapped.gateway,
    };
    const res = await fetchJson(`${base}/sync/v1/config`, { token, method: 'PUT', body, timeoutMs: 20_000 });
    if (res.status === 200 && res.body?.rev) {
      lastAppliedConfigRev = String(res.body.rev);
      log(`sync-client 推送 config ok rev=${res.body.rev}`);
      return { ok: true };
    }
    if (res.status === 409 && res.body?.config) {
      log(`sync-client 推送 config 冲突，改应用枢纽`);
      try { applyHubConfig(res.body.config); } catch (e) {
        log(`sync-client 冲突应用 config: ${e.message}`);
      }
      return { ok: true, conflict: true };
    }
    log(`sync-client 推送 config → ${res.status}`);
    return { ok: false };
  }

  async function pullOnce() {
    const health = await fetchJson(`${base}/sync/v1/health`, { token });
    if (!health.ok) {
      log(`sync-client health → ${health.status}`);
      return { ok: false };
    }
    const sinceQ = cursor > 0 ? `?since=${cursor}` : '';
    const snap = await fetchJson(`${base}/sync/v1/snapshot${sinceQ}`, { token, timeoutMs: 20_000 });
    if (!snap.ok) {
      log(`sync-client snapshot → ${snap.status}`);
      return { ok: false };
    }
    lastPullAt = Date.now();
    const remoteTodos = Array.isArray(snap.body?.todos) ? snap.body.todos : [];
    const remoteTombs = Array.isArray(snap.body?.tombstones) ? snap.body.tombstones : [];
    for (const r of remoteTodos) rememberHubTodo(r);
    for (const tb of remoteTombs) rememberHubTodo(tb); // 记住墓碑 rev：防重推 DELETE、防旧版复活
    if (cursor === 0) hubCatalogReady = true;

    const plan = planRemoteMerges(listTodos(), remoteTodos, listTombstones());
    let inserted = 0;
    let updated = 0;
    for (const r of plan.apply) {
      try {
        const rlt = applyRemoteTodo(r);
        rememberHubTodo(r);
        if (rlt.action === 'insert') inserted++;
        else if (rlt.action === 'update') updated++;
      } catch (e) {
        log(`sync-client 合并 ${r?.id}: ${e.message}`);
      }
    }
    // 墓碑删除放在合并**之后**：同一轮里「复活的新版 + 旧墓碑」不该出现（枢纽复活
    // 时已清墓碑），但顺序上仍保证删除裁决看的是合并后的本地状态
    let deleted = 0;
    const delPlan = planRemoteDeletes(remoteTombs, listTodos());
    for (const d of delPlan.delete) {
      try {
        const rlt = applyRemoteTombstone(d);
        if (rlt.action === 'delete') deleted++;
      } catch (e) {
        log(`sync-client 应用墓碑 ${d?.id}: ${e.message}`);
      }
    }
    const nextCursor = Number(snap.body?.cursor);
    if (Number.isFinite(nextCursor) && nextCursor > cursor) cursor = nextCursor;
    if (!hubCatalogReady) hubCatalogReady = true;

    // config / stats：交给 tick 决策（避免先 apply 枢纽盖掉本机未推改动）
    const hubConfig = snap.body?.config ?? null;
    const hubStats = snap.body?.stats;
    if (hubStats?.days) {
      writeSyncedStatsDays(hubStats.days, { rev: hubStats.rev || 0, pulledAt: lastPullAt });
      lastStatsRev = Number(hubStats.rev) || lastStatsRev;
    }

    if (inserted || updated || deleted || remoteTodos.length || remoteTombs.length) {
      log(`sync-client 拉取 ok：远端 ${remoteTodos.length} 条（墓碑 ${remoteTombs.length}），插入 ${inserted}，更新 ${updated}，删除 ${deleted}，跳过 ${plan.skip.length}；cursor=${cursor}`);
    } else {
      log(`sync-client 拉取 ok：无待办变更；cursor=${cursor}`);
    }
    return {
      ok: true,
      inserted,
      updated,
      deleted,
      remoteCount: remoteTodos.length,
      hubConfig,
      hubConfigRev: hubConfig?.rev ?? null,
      hubStatsRev: hubStats?.rev ?? null,
    };
  }

  async function pushOnePost(todo) {
    const body = pushBodyFromLocal(todo);
    if (!body) return;
    const res = await fetchJson(`${base}/sync/v1/todos`, { token, method: 'POST', body });
    if (res.status === 201 && res.body?.id) {
      if (String(res.body.id) !== String(todo.id)) {
        log(`sync-client 推送 POST ${todo.id}：枢纽返回不同 id ${res.body.id}，跳过本地对齐（请升级枢纽）`);
        return { ok: false };
      }
      rememberHubTodo(res.body);
      try { applyRemoteTodo(res.body); } catch {}
      return { ok: true, action: 'post' };
    }
    if (res.status === 409 && res.body?.todo) {
      return pushResolveConflict(todo, res.body.todo, 'post');
    }
    log(`sync-client 推送 POST ${todo.id} → ${res.status}`);
    return { ok: false };
  }

  async function pushOnePatch(item, { allowRetry = true } = {}) {
    const { id, rev, todo } = item;
    const body = pushBodyFromLocal(todo);
    if (!body) return;
    body.rev = rev;
    delete body.id;
    const res = await fetchJson(`${base}/sync/v1/todos/${encodeURIComponent(id)}`, {
      token,
      method: 'PATCH',
      body,
    });
    if (res.status === 200 && res.body?.id) {
      rememberHubTodo(res.body);
      try { applyRemoteTodo(res.body); } catch {}
      return { ok: true, action: 'patch' };
    }
    if (res.status === 409 && res.body?.todo) {
      return pushResolveConflict(todo, res.body.todo, 'patch', allowRetry);
    }
    log(`sync-client 推送 PATCH ${id} → ${res.status}`);
    return { ok: false };
  }

  // 推送删除：本机墓碑 rev 比枢纽已知的新才到这（planLocalPushes 已滤）。
  // 204/200 = 删成；404 = 枢纽已经没有（另一台先删了）——同样是目的达成。
  // 成功后把枢纽已知 rev 抬到墓碑 rev，下一轮不再重发。
  async function pushOneDelete(item) {
    const { id, rev } = item;
    const res = await fetchJson(`${base}/sync/v1/todos/${encodeURIComponent(id)}`, { token, method: 'DELETE' });
    if (res.status === 204 || res.status === 200 || res.status === 404) {
      rememberHubTodo({ id, rev });
      return { ok: true, action: 'delete' };
    }
    log(`sync-client 推送 DELETE ${id} → ${res.status}`);
    return { ok: false };
  }

  async function pushResolveConflict(localTodo, hubTodo, via, allowRetry = true) {
    const decision = planAfterConflict(localTodo, hubTodo);
    rememberHubTodo(hubTodo);
    if (decision.action === 'apply' || decision.action === 'align') {
      try {
        // 枢纽回的是墓碑（编辑撞上删除且删除不更旧）→ 删本机副本，别当待办写回
        if (hubTodo?.deleted) applyRemoteTombstone(hubTodo);
        else applyRemoteTodo(hubTodo);
      } catch (e) {
        log(`sync-client 冲突合并 ${localTodo.id}: ${e.message}`);
      }
      log(`sync-client 冲突(${via}) ${localTodo.id}：${decision.action}${hubTodo?.deleted ? '(墓碑)' : ''} hubRev=${decision.hubRev}`);
      return { ok: true, action: 'conflict-' + decision.action };
    }
    if (decision.action === 'retry' && allowRetry) {
      log(`sync-client 冲突(${via}) ${localTodo.id}：重试 PATCH hubRev=${decision.hubRev}`);
      return pushOnePatch(
        { id: String(localTodo.id), rev: decision.hubRev, todo: localTodo },
        { allowRetry: false },
      );
    }
    log(`sync-client 冲突(${via}) ${localTodo.id}：放弃重试`);
    return { ok: false };
  }

  async function pushTodosOnce() {
    if (!doPush || !hubCatalogReady) return { posted: 0, patched: 0, deleted: 0 };
    const { post, patch, deletes } = planLocalPushes(listTodos(), knownHubRev, listTombstones());
    let posted = 0;
    let patched = 0;
    let deleted = 0;
    for (const t of post) {
      try {
        const r = await pushOnePost(t);
        if (r?.ok && r.action === 'post') posted++;
      } catch (e) {
        log(`sync-client 推送 POST ${t?.id}: ${e.message}`);
      }
    }
    for (const item of patch) {
      try {
        const r = await pushOnePatch(item);
        if (r?.ok && r.action === 'patch') patched++;
      } catch (e) {
        log(`sync-client 推送 PATCH ${item?.id}: ${e.message}`);
      }
    }
    for (const d of deletes) {
      try {
        const r = await pushOneDelete(d);
        if (r?.ok) deleted++;
      } catch (e) {
        log(`sync-client 推送 DELETE ${d?.id}: ${e.message}`);
      }
    }
    if (posted || patched || deleted || post.length || patch.length || deletes.length) {
      log(`sync-client 推送 todos ok：POST ${posted}/${post.length}，PATCH ${patched}/${patch.length}，DELETE ${deleted}/${deletes.length}`);
    }
    return { posted, patched, deleted };
  }

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      // 先推 stats，再拉（快照 sum 含本机最新切片）
      try { await pushStatsOnce(); } catch (e) { log(`sync-client stats: ${e.message}`); }

      // 拉之前看本机 shareable 是否相对 lastApplied 变脏（用户在 spoke 改过）
      let localDirty = false;
      try {
        const { raw, mtimeMs } = readLocalRawConfig();
        if (raw && lastAppliedConfigRev != null) {
          const localRev = wrapConfigForSync(raw, { mtimeMs }).rev;
          localDirty = String(localRev) !== String(lastAppliedConfigRev);
        }
      } catch {}

      const pulled = await pullOnce();
      if (pulled?.ok) {
        // 配置：本机脏 → 推到枢纽；否则枢纽 rev 新 → 拉下来 apply（保留角色键）
        try {
          if (doPush && localDirty && pulled.hubConfigRev != null) {
            await pushConfigOnce(pulled.hubConfigRev);
          } else if (pulled.hubConfig && String(pulled.hubConfig.rev) !== String(lastAppliedConfigRev)) {
            applyHubConfig(pulled.hubConfig);
          }
        } catch (e) {
          log(`sync-client config: ${e.message}`);
        }
        await pushTodosOnce();
      }
    } catch (e) {
      log(`sync-client 轮询失败: ${e.message}`);
    } finally {
      inFlight = false;
    }
  }

  log(`同步客户端就绪: ${base}/sync/v1/* 每 ${cfg.intervalSec}s 拉${doPush ? '+推' : ''}（deviceId=${deviceId}）`);
  Promise.resolve(tick()).catch(() => {});
  timer = setInterval(() => { Promise.resolve(tick()).catch(() => {}); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
