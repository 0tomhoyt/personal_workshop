// Mac↔Mac 同步客户端（gateway.syncClient）：本机当 spoke，同进程轮询枢纽。
// 不另起 HTTP 监听；每轮：① 拉 GET /sync/v1/health + snapshot ②（可选）把本机更新推到枢纽。
// 合并：远端 rev 严格更大才 apply；推送：本机 updated_at > 已知枢纽 rev，或枢纽尚无此 id。
// 防回环：applyRemoteTodo 后刷新 knownHubRev；推送成功后用响应 rev 对齐；不在合并写入后再立刻当「本地新改动」推回。
import { tryGetConfig } from './config.mjs';
import { listTodos, applyRemoteTodo } from './todos.mjs';
import { toSyncTodo } from './sync-snapshot.mjs';
import { log } from './log.mjs';

/**
 * 纯合并决策（单测用）：给定本地列表与远端 todos[]，返回应 apply 的远端条目。
 * 规则：无本地 id → apply；有本地且 remote.rev > local.updated_at → apply；否则跳过。
 */
export function planRemoteMerges(localTodos, remoteTodos) {
  const byId = new Map((localTodos || []).map((t) => [String(t.id), t]));
  const apply = [];
  const skip = [];
  for (const r of Array.isArray(remoteTodos) ? remoteTodos : []) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    const rev = Number(r.rev ?? r.updated_at) || 0;
    const local = byId.get(id);
    if (!local || rev > (Number(local.updated_at) || 0)) apply.push(r);
    else skip.push(id);
  }
  return { apply, skip };
}

/**
 * 纯推送决策：对照「已知枢纽 rev」决定 POST（枢纽没有）或 PATCH（本地更新）。
 * hubRevs: Map|Record id → 枢纽上次见到的 rev；缺省 id 视为枢纽没有 → post。
 * 相等不推（防把刚拉下来的再推回去）。
 */
export function planLocalPushes(localTodos, hubRevs) {
  const revs = hubRevs instanceof Map
    ? hubRevs
    : new Map(Object.entries(hubRevs || {}).map(([k, v]) => [String(k), Number(v) || 0]));
  const post = [];
  const patch = [];
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
  return { post, patch };
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
  // POST/PATCH 体：带 id/rev 供枢纽落库；PATCH 时 rev 另作乐观锁（调用方覆盖）
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
  let hubCatalogReady = false; // 至少成功拉过一次全量/增量后才允许按「缺 id → POST」推
  const base = cfg.url.replace(/\/+$/, '');
  const token = cfg.token;
  const intervalMs = Math.max(5, cfg.intervalSec || 15) * 1000;
  const doPush = cfg.push !== false;

  function rememberHubTodo(r) {
    if (!r || r.id == null) return;
    const id = String(r.id);
    const rev = Number(r.rev ?? r.updated_at) || 0;
    const prev = knownHubRev.has(id) ? knownHubRev.get(id) : -1;
    if (rev >= prev) knownHubRev.set(id, rev);
  }

  async function pullOnce() {
    const health = await fetchJson(`${base}/sync/v1/health`, { token });
    if (!health.ok) {
      log(`sync-client health → ${health.status}`);
      return { ok: false };
    }
    const sinceQ = cursor > 0 ? `?since=${cursor}` : '';
    const snap = await fetchJson(`${base}/sync/v1/snapshot${sinceQ}`, { token });
    if (!snap.ok) {
      log(`sync-client snapshot → ${snap.status}`);
      return { ok: false };
    }
    const remoteTodos = Array.isArray(snap.body?.todos) ? snap.body.todos : [];
    // 先记 rev（含即将 skip 的），再 merge——避免刚 apply 的又被当成本地新改动推回
    for (const r of remoteTodos) rememberHubTodo(r);
    // 无 since 的首拉：快照即全量目录；有 since 时未出现的 id 保持 knownHubRev 旧值
    if (cursor === 0) hubCatalogReady = true;

    const plan = planRemoteMerges(listTodos(), remoteTodos);
    let inserted = 0;
    let updated = 0;
    for (const r of plan.apply) {
      try {
        const rlt = applyRemoteTodo(r);
        rememberHubTodo(r); // apply 后本地 rev == 远端
        if (rlt.action === 'insert') inserted++;
        else if (rlt.action === 'update') updated++;
      } catch (e) {
        log(`sync-client 合并 ${r?.id}: ${e.message}`);
      }
    }
    const nextCursor = Number(snap.body?.cursor);
    if (Number.isFinite(nextCursor) && nextCursor > cursor) cursor = nextCursor;
    // 空库首拉也算目录就绪
    if (!hubCatalogReady) hubCatalogReady = true;

    if (inserted || updated || remoteTodos.length) {
      log(`sync-client 拉取 ok：远端 ${remoteTodos.length} 条，插入 ${inserted}，更新 ${updated}，跳过 ${plan.skip.length}；cursor=${cursor}`);
    } else {
      log(`sync-client 拉取 ok：无变更；cursor=${cursor}`);
    }
    return { ok: true, inserted, updated, remoteCount: remoteTodos.length };
  }

  async function pushOnePost(todo) {
    const body = pushBodyFromLocal(todo);
    if (!body) return;
    const res = await fetchJson(`${base}/sync/v1/todos`, { token, method: 'POST', body });
    if (res.status === 201 && res.body?.id) {
      if (String(res.body.id) !== String(todo.id)) {
        // 旧枢纽 createTodo 会丢 id；若照单 apply 会在本机分出第二条
        log(`sync-client 推送 POST ${todo.id}：枢纽返回不同 id ${res.body.id}，跳过本地对齐（请升级枢纽）`);
        return { ok: false };
      }
      rememberHubTodo(res.body);
      // 枢纽若改了 rev，对齐本地避免下一轮又 PATCH
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
    body.rev = rev; // 乐观锁：枢纽当前 known rev
    delete body.id; // id 在路径上
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

  async function pushResolveConflict(localTodo, hubTodo, via, allowRetry = true) {
    const decision = planAfterConflict(localTodo, hubTodo);
    rememberHubTodo(hubTodo);
    if (decision.action === 'apply' || decision.action === 'align') {
      try { applyRemoteTodo(hubTodo); } catch (e) {
        log(`sync-client 冲突合并 ${localTodo.id}: ${e.message}`);
      }
      log(`sync-client 冲突(${via}) ${localTodo.id}：${decision.action} hubRev=${decision.hubRev}`);
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

  async function pushOnce() {
    if (!doPush || !hubCatalogReady) return { posted: 0, patched: 0 };
    const { post, patch } = planLocalPushes(listTodos(), knownHubRev);
    let posted = 0;
    let patched = 0;
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
    if (posted || patched || post.length || patch.length) {
      log(`sync-client 推送 ok：POST ${posted}/${post.length}，PATCH ${patched}/${patch.length}`);
    }
    return { posted, patched };
  }

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const pulled = await pullOnce();
      if (pulled?.ok) await pushOnce();
    } catch (e) {
      log(`sync-client 轮询失败: ${e.message}`);
    } finally {
      inFlight = false;
    }
  }

  log(`同步客户端就绪: ${base}/sync/v1/* 每 ${cfg.intervalSec}s 拉${doPush ? '+推' : ''}`);
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
