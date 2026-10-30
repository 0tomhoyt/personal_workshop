// 电视工作台快照：把待办（lib/todos.mjs）与今日流量（lib/stats.mjs）裁剪成
// 「够用的一小份 JSON」，供客厅电视的屏保每分钟拉一次（2–6 KB，ETag 命中时 304）。
//
// 裁剪纪律（与设计稿 §2.1/3.2 一致）：
//   - 不出现 spans / perf / days[] / prices——电视不参与汇报、不看延迟直方图；
//   - note（详情）截 ~80 码位，标题同样截断（标题上限 500，原样下发能独自撑爆体积）；
//   - runningMs / doneToday 由服务端算好，电视不做时间戳推导（两端时钟不必一致）；
//   - 费用、tokens 由 Mac 按自己的记账口径汇总，电视只显示。
//
// 这里全是纯函数：入参就是 listTodos() / statsSnapshot() 的返回值，便于单测；
// 不读全局状态、不碰网络。
import { createHash } from 'node:crypto';

/** 快照契约版本：电视端解析时校验，字段变动时 +1（不兼容改动另起端点版本）。 */
export const TV_SNAPSHOT_VERSION = 1;

const MAX_TODOS = 6;
const TITLE_MAX = 80;
const NOTE_MAX = 80;
const PROJECT_MAX = 24;
const MODEL_MAX = 40;

const STATUS_RANK = { in_progress: 0, pending: 1, done: 2 };
const URGENCY_RANK = { urgent: 0, normal: 1, someday: 2 };

/** 码位截断：不劈开 emoji 代理对；超长补一个省略号。空值返回 undefined。 */
export function clip(value, max) {
  if (value == null) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('') + '…';
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(num(v) * f) / f;
};

/** 某待办的累计进行时长：所有时段（end=null 视为到现在）之和；负值/坏段跳过。 */
export function runningMs(todo, now) {
  const spans = Array.isArray(todo?.spans) ? todo.spans : [];
  let total = 0;
  for (const s of spans) {
    const start = num(s?.start);
    const end = s?.end == null ? now : num(s.end);
    if (!(start > 0) || !(end >= start)) continue;
    total += end - start;
  }
  return Math.round(total);
}

/** 本地时区当天 0 点（与 lib/stats.mjs 的按天分桶口径一致）。 */
export function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todoRow(todo, now) {
  const items = Array.isArray(todo.items) ? todo.items : [];
  const row = {
    id: String(todo.id || ''),
    title: clip(todo.title, TITLE_MAX) ?? '',
    status: todo.status === 'in_progress' || todo.status === 'done' ? todo.status : 'pending',
    urgency: todo.urgency === 'urgent' || todo.urgency === 'someday' ? todo.urgency : 'normal',
    runningMs: runningMs(todo, now),
    updatedAt: num(todo.updated_at),
  };
  // 可选字段缺省时整个键不出现：电视台端按「有没有这个键」决定画不画 chip / 备注行
  const project = clip(todo.project, PROJECT_MAX);
  if (project) row.project = project;
  const note = clip(todo.note, NOTE_MAX);
  if (note) row.note = note;
  if (items.length) row.items = { done: items.filter((it) => it?.done).length, total: items.length };
  return row;
}

/**
 * 电视上的排序：进行中 → 待办；同状态内 紧急 → 普通 → 不急；再按最近更新。
 * 完成项不进列表（只在 doneToday 里计数）；最多 MAX_TODOS 条。
 */
export function orderTodos(todos) {
  return [...todos].sort((a, b) => {
    const sa = STATUS_RANK[a.status] ?? 1;
    const sb = STATUS_RANK[b.status] ?? 1;
    if (sa !== sb) return sa - sb;
    const ua = URGENCY_RANK[a.urgency] ?? 1;
    const ub = URGENCY_RANK[b.urgency] ?? 1;
    if (ua !== ub) return ua - ub;
    return num(b.updated_at) - num(a.updated_at);
  });
}

/**
 * 今日用量：只取 requests / tokens / cost 与轻量的 24 根柱、Top 3 模型。
 * statsSnapshot() 的 today 是 { req, err, tin, tout, cost, ... }，hours[24] 是
 * { req, tin, tout, cost }，models[] 已按 req 降序。
 */
export function usageToday(stats) {
  const today = stats?.today ?? {};
  const totalReq = num(today.req);
  const hours = Array.from({ length: 24 }, (_, i) => num(stats?.hours?.[i]?.req));
  const models = (Array.isArray(stats?.models) ? stats.models : [])
    .filter((m) => m && num(m.req) > 0)
    .slice(0, 3)
    .map((m) => ({
      model: clip(m.model, MODEL_MAX) ?? '-',
      req: num(m.req),
      share: totalReq > 0 ? round(num(m.req) / totalReq, 2) : 0,
    }));
  return {
    requests: totalReq,
    tokens: num(today.tin) + num(today.tout),
    costUsd: round(today.cost, 4),
    hours,
    topModels: models,
  };
}

/**
 * 组装快照。入参可注入（测试用）：
 *   todos  listTodos() 的结果；stats  statsSnapshot() 的结果；
 *   now    毫秒时间戳（默认 Date.now()）；
 *   health { ok, providers, uptimeSec }（默认从 enabled providers 与进程 uptime 推）。
 */
export function buildSnapshot({ todos = [], stats = {}, now = Date.now(), health } = {}) {
  const rows = orderTodos((Array.isArray(todos) ? todos : []).filter((t) => t && typeof t === 'object' && t.status !== 'done'));
  const todayStart = startOfLocalDay(now);
  const doneToday = (Array.isArray(todos) ? todos : [])
    .filter((t) => t?.status === 'done' && num(t.completed_at) >= todayStart).length;
  const inProgress = rows.filter((t) => t.status === 'in_progress').length;
  const pending = rows.length - inProgress;
  return {
    version: TV_SNAPSHOT_VERSION,
    now,
    online: true,
    health: health ?? { ok: true },
    todos: {
      inProgress,
      pending,
      doneToday,
      items: rows.slice(0, MAX_TODOS).map((t) => todoRow(t, now)),
    },
    usage: usageToday(stats),
  };
}

/**
 * 快照 ETag：内容哈希（引号包裹，符合 RFC 9110 的 entity-tag 形态）。
 *
 * `now` 每次请求都变，直接哈希整份正文会让 304 永远不命中、把「每分钟近乎零流量」
 * 的意义抹掉。所以 ETag 只覆盖**数据本身**。
 *
 * runningMs 是随时钟走的派生量：整个剔掉会让「进行中 1h20m」在电视上永远停在首次拉取
 * 的值（客户端拿到 304 就不重画），与「runningMs 由服务端算好」自相矛盾。折中是按
 * [RUNNING_BUCKET_MS] 分桶再哈希——同一份数据下每分钟仍是 304，每 10 分钟因时长进位
 * 重画一次。对一句话的时长显示，10 分钟的粒度足够，也不会把 304 的意义毁掉。
 */
export const RUNNING_BUCKET_MS = 10 * 60_000;

export function etagOf(body) {
  let stable = body;
  try {
    const obj = JSON.parse(body);
    delete obj.now;
    if (obj.todos?.items) {
      obj.todos.items = obj.todos.items.map(({ runningMs, ...rest }) => (
        runningMs ? { ...rest, runningBucket: Math.floor(runningMs / RUNNING_BUCKET_MS) } : rest
      ));
    }
    stable = JSON.stringify(obj);
  } catch { /* 不是 JSON 就照原样哈希 */ }
  return '"' + createHash('sha1').update(stable).digest('base64url').slice(0, 20) + '"';
}

/** 字节级上限兜底：见 [fitToLimit]。契约是 2–6 KB，超了电视也读不完。 */
export const MAX_BYTES = 6 * 1024;

/**
 * 把过大的快照压回 [MAX_BYTES] 以内。JSON 转义让「N 个码位」不等于「N 字节」——
 * 80 个 `\u0001` 的标题转义后是 480 字节，所以按码位截断挡不住。逐级收紧：先砍待办条数，
 * 再砍 Top 模型，最后缩短备注；每步都重新测量。真到极端输入也只是少几行，不会超契约。
 */
export function fitToLimit(snapshot) {
  const bytes = (s) => Buffer.byteLength(JSON.stringify(s));
  const out = structuredClone(snapshot);
  if (bytes(out) <= MAX_BYTES) return out;
  while (out.todos.items.length > 1 && bytes(out) > MAX_BYTES) out.todos.items.pop();
  while (out.usage.topModels.length > 0 && bytes(out) > MAX_BYTES) out.usage.topModels.pop();
  for (const t of out.todos.items) {
    if (bytes(out) <= MAX_BYTES) break;
    if (t.note) delete t.note;
  }
  for (const t of out.todos.items) {
    if (bytes(out) <= MAX_BYTES) break;
    if (t.title) t.title = clip(t.title, 24);
    t.project = clip(t.project, 12);
  }
  return out;
}

/** If-None-Match 判定：支持列表与弱校验前缀，`*` 命中任何现有表示。 */
export function etagMatches(header, etag) {
  if (!header || !etag) return false;
  return String(header).split(',').some((raw) => {
    const tag = raw.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}
