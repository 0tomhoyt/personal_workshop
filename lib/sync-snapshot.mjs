// Mac↔Mac 同步快照（纯函数）：todos +（v2）可共享 config + 跨设备求和 stats。
// rev 暂用 updated_at（毫秒）；since 只过滤 todos。
// 角色键 gateway.sync / syncClient / tv 永不进入 config 节（见 sync-config）。
// 本快照不下发 spans。

/** @param {object} todo listTodos() 的一条 */
export function toSyncTodo(todo) {
  if (!todo || typeof todo !== 'object') return null;
  const updated = Number(todo.updated_at) || 0;
  const out = {
    id: String(todo.id),
    title: todo.title ?? '',
    status: todo.status ?? 'pending',
    urgency: todo.urgency ?? 'normal',
    project: todo.project ?? undefined,
    note: todo.note ?? undefined,
    source: todo.source ?? 'user',
    created_at: todo.created_at ?? null,
    updated_at: updated,
    completed_at: todo.completed_at ?? null,
    rev: updated,
  };
  if (Array.isArray(todo.items)) {
    out.items = todo.items.map((it) => ({
      id: it.id,
      title: it.title,
      done: !!it.done,
      done_at: it.done_at ?? null,
    }));
  }
  return out;
}

/**
 * @param {{
 *   todos?: object[],
 *   now?: number,
 *   since?: number|null,
 *   config?: object|null,
 *   stats?: object|null,
 * }} opts
 * @returns {{ version: number, now: number, cursor: number, todos: object[], config?: object, stats?: object }}
 */
export function buildSyncSnapshot({ todos = [], now = Date.now(), since = null, config = null, stats = null } = {}) {
  const sinceN = since == null || since === '' ? null : Number(since);
  const sinceOk = sinceN != null && Number.isFinite(sinceN) ? sinceN : null;
  const mapped = [];
  let cursor = 0;
  for (const t of todos) {
    const row = toSyncTodo(t);
    if (!row) continue;
    if (row.updated_at > cursor) cursor = row.updated_at;
    if (sinceOk != null && !(row.updated_at > sinceOk)) continue;
    mapped.push(row);
  }
  mapped.sort((a, b) => (b.updated_at - a.updated_at) || String(a.id).localeCompare(String(b.id)));
  const out = {
    version: 2,
    now,
    cursor: cursor || now,
    todos: mapped,
  };
  // since 增量拉：仍附带完整 config/stats 元数据（体量可接受；客户端按 rev 跳过 apply）
  if (config != null) out.config = config;
  if (stats != null) out.stats = stats;
  return out;
}
