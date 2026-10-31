// Mac↔Mac 同步客户端（gateway.syncClient）：本机当 spoke，同进程轮询枢纽。
// 不另起 HTTP 监听；只拉 GET /sync/v1/health + /sync/v1/snapshot?since=，
// 按 id/rev 合并进本机 todos（远端更新赢；本机独有 id 暂不删——骨架无墓碑）。
import { tryGetConfig } from './config.mjs';
import { listTodos, applyRemoteTodo } from './todos.mjs';
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

async function fetchJson(url, token, timeoutMs = 12_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      signal: ac.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
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
  const base = cfg.url.replace(/\/+$/, '');
  const token = cfg.token;
  const intervalMs = Math.max(5, cfg.intervalSec || 15) * 1000;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const health = await fetchJson(`${base}/sync/v1/health`, token);
      if (!health.ok) {
        log(`sync-client health → ${health.status}`);
        return;
      }
      const sinceQ = cursor > 0 ? `?since=${cursor}` : '';
      const snap = await fetchJson(`${base}/sync/v1/snapshot${sinceQ}`, token);
      if (!snap.ok) {
        log(`sync-client snapshot → ${snap.status}`);
        return;
      }
      const remoteTodos = Array.isArray(snap.body?.todos) ? snap.body.todos : [];
      const plan = planRemoteMerges(listTodos(), remoteTodos);
      let inserted = 0;
      let updated = 0;
      for (const r of plan.apply) {
        try {
          const rlt = applyRemoteTodo(r);
          if (rlt.action === 'insert') inserted++;
          else if (rlt.action === 'update') updated++;
        } catch (e) {
          log(`sync-client 合并 ${r?.id}: ${e.message}`);
        }
      }
      const nextCursor = Number(snap.body?.cursor);
      if (Number.isFinite(nextCursor) && nextCursor > cursor) cursor = nextCursor;
      if (inserted || updated || remoteTodos.length) {
        log(`sync-client 拉取 ok：远端 ${remoteTodos.length} 条，插入 ${inserted}，更新 ${updated}，跳过 ${plan.skip.length}；cursor=${cursor}`);
      } else {
        log(`sync-client 拉取 ok：无变更；cursor=${cursor}`);
      }
    } catch (e) {
      log(`sync-client 轮询失败: ${e.message}`);
    } finally {
      inFlight = false;
    }
  }

  log(`同步客户端就绪: ${base}/sync/v1/* 每 ${cfg.intervalSec}s 拉取`);
  // 立即拉一次，再按间隔
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
