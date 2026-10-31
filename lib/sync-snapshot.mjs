// Mac↔Mac 同步快照（纯函数）：把 listTodos() 收成带 rev 的增量友好形状。
// rev 暂用 updated_at（毫秒）；后续若要字段级合并再升版本。
// since = 客户端游标：只回 updated_at > since 的条目（含新建与删除后的「墓碑」留给后续）。
// 本骨架不下发 spans（日历事件本地即可），不下发 API key / 用量明细。

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
 * @param {{ todos?: object[], now?: number, since?: number|null }} opts
 * @returns {{ version: number, now: number, cursor: number, todos: object[] }}
 */
export function buildSyncSnapshot({ todos = [], now = Date.now(), since = null } = {}) {
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
  // 稳定序：updated_at 降序，同刻按 id
  mapped.sort((a, b) => (b.updated_at - a.updated_at) || String(a.id).localeCompare(String(b.id)));
  return {
    version: 1,
    now,
    cursor: cursor || now,
    todos: mapped,
  };
}
