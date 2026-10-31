// 个人工作台 · 待办数据层：人（工作台网页）与各 agent（REST）共用的任务中枢。
// 数据文件 todos.json（env CANNBOT_TODOS_FILE 覆盖，测试隔离用），写频低——每次变更
// 即原子写穿（tmp + rename，0600），不做 stats 那种防抖。结构 { todos, tombstones }：
// tombstones 是删除的墓碑记录（跨设备同步用，见下方 TOMBSTONE_TTL_MS 处注释）。
// 坏文件 / 首次运行：空列表起步（下次写盘自动修复文件），绝不阻塞网关主业务；
// 坏文件先备份为 .bad 再起步，避免下次写盘静默覆盖用户数据。
//
// 子项（checklist）：todo.items = [{ id, title, done, done_at }]，数组序即展示序。
// 每次子项变更后跑 deriveFromItems 派生父状态（规则见
// docs/superpowers/specs/2026-10-28-todo-subitems-design.md §三）：
//   非空且全 done → 父 done（completed_at 原为空才盖，不重盖）；
//   有未完成且父 done → 父 in_progress（取消完成 = 工作重新开始）并清章；
//   空清单 / 无清单 → 不派生（父状态纯手动）。
// note 即「可编辑详情」——**给自己看的备忘**（上下文、链接、待核对的事），
// agent 来源（source ≠ 'user'）硬上限 300 码位（可读性：标题一行可扫、详情要短），
// 用户网页路径 2000。旧数据无 items 字段零迁移。
// 汇报时 note 会交给模型过滤（备忘改写成给上级看的结论、私人待办略去），
// 但不直接进正文——见 lib/report-prompts.mjs 的 systemFinal。
//
// 时段（spans）：todo.spans = [{ id, start, end }]，end === null 表示进行中（未闭合）。
//
// **这不是给汇报用的**（那次试过又撤了，理由见 docs/superpowers/specs/
// 2026-10-29-todo-time-spans-design.md §九：时段曾是汇报质量的隐藏前置条件，不填就
// 悄悄变差）。这里的用途是**产出日历事件**——每段 → 日历一条事件 start~end。
// 同一个字段、完全不同的失败模式：不填 = 没有事件（看得见的空白），而不是
// 汇报里悄悄丢掉一段工作。汇报的归属仍由模型按内容判断，不读 spans。
//
// 记录方式两种都支持：① 行内「▸ 开始 / ✓ 完成」自动开段闭段（状态切换顺带）；
// ② 直接 PATCH spans 整组替换（外部同步程序/agent 按自己的时间线写入）。
// 允许多段、允许重叠——用户来回切是常态，硬校验只会碍事。
//
// 状态变化既包括显式 PATCH status，也包括**子项派生**（勾完最后一个子项 → 父 done）：
// 两条路径共用 syncSpansToStatus，否则派生出的 done 会留下一条永不结束的日历事件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';
import { httpError, randHex, backupBadFile } from './util.mjs';

const SCRIPT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TODOS_FILE = process.env.CANNBOT_TODOS_FILE || path.join(SCRIPT_DIR, 'todos.json');

export const TODO_STATUSES = ['pending', 'in_progress', 'done']; // 待办 / 进行中 / 完成
export const TODO_URGENCIES = ['urgent', 'normal', 'someday']; // 紧急 / 普通 / 不急

// 字段长度上限（码位计，防滥用写爆）
const FIELD_LIMITS = { title: 500, note: 2000, project: 60, source: 60, itemTitle: 200 };
const AGENT_NOTE_LIMIT = 300; // agent 来源 note（详情）上限：更严，防长文灌入
const ITEMS_MAX = 50; // 单条待办子项数上限
const SPANS_MAX = 500; // 单条待办时段数上限（一段一次「开始/完成」，一年也到不了）

// 墓碑（tombstone）：删除同步的事实记录。删除曾是同步盲区——待办一删就离开
// listTodos()，推送端再无机会告知枢纽；快照由 listTodos() 现算，「没了」不可表达，
// A 机删除后 B 机永远留着，且 spoke 重启（cursor 归零全量拉取）时已删待办还会复活。
// 记 { id, rev, deleted_at }，rev 参与全协议统一的 LWW 仲裁（与 updated_at 同一口径），
// 30 天后清理（离线超过 TTL 的设备可能看到已删待办复活——可接受，胜过永久膨胀）。
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sanitizeTombstones(input, now = Date.now()) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && t.id
      && Number.isFinite(Number(t.rev)) && Number(t.rev) > 0)
    .map((t) => ({ id: t.id, rev: Number(t.rev), deleted_at: Number(t.deleted_at) || Number(t.rev) }))
    .filter((t) => now - t.rev < TOMBSTONE_TTL_MS);
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.todos)) {
      const todos = raw.todos.filter((t) => t && typeof t === 'object' && typeof t.id === 'string');
      return { version: 1, todos, tombstones: sanitizeTombstones(raw.tombstones) };
    }
    log(`todos.json 结构异常，按空列表起步: ${TODOS_FILE}`);
    backupBadFile(TODOS_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log(`todos.json 读取失败，按空列表起步: ${e.message}`);
      backupBadFile(TODOS_FILE);
    }
  }
  return { version: 1, todos: [], tombstones: [] };
}

const state = loadState();

function persist() {
  const tmpF = `${TODOS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpF, JSON.stringify(state, null, 2));
  fs.chmodSync(tmpF, 0o600);
  fs.renameSync(tmpF, TODOS_FILE);
}

// 码位计数：Array.from 按 Unicode 码位拆分，emoji 代理对不会算成 2
const cpLen = (s) => Array.from(s).length;

// 文本字段校验：trim、必填、码位上限。返回 trim 后的值；可选字段空值返回 undefined
function assertText(value, field, max, { required = false } = {}) {
  if (value == null) {
    if (required) throw httpError(400, `缺少必填字段 ${field}`, 'invalid_todo');
    return undefined;
  }
  if (typeof value !== 'string') throw httpError(400, `${field} 必须是字符串`, 'invalid_todo');
  const v = value.trim();
  if (required && !v) throw httpError(400, `${field} 不能为空`, 'invalid_todo');
  if (cpLen(v) > max) throw httpError(400, `${field} 超过 ${max} 字上限`, 'invalid_todo');
  return v || undefined;
}

function assertEnum(value, field, allowed) {
  if (!allowed.includes(value)) throw httpError(400, `${field} 只能是 ${allowed.join(' / ')}`, 'invalid_todo');
}

// note（详情）分级上限：agent 来源 300、用户 2000。上限不同且文案要点明分级，
// 不走 assertText 通用文案
const noteLimitFor = (source) => (source && source !== 'user' ? AGENT_NOTE_LIMIT : FIELD_LIMITS.note);
function assertNote(value, source) {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw httpError(400, 'note 必须是字符串', 'invalid_todo');
  const v = value.trim();
  const max = noteLimitFor(source);
  if (cpLen(v) > max) {
    throw httpError(400, `note 超过 ${max} 字上限${max === AGENT_NOTE_LIMIT ? '（agent 来源详情上限 300 码位、用户 2000——请精简长文）' : ''}`, 'invalid_todo');
  }
  return v || undefined;
}

// 子项归一化（create 的初始清单 / update 的整组替换共用）：
// title 必填 ≤200 码位；done 可选布尔；id 留则保留（整组替换不换锚点），缺省/重复则新派。
// 整组替换时沿用旧子项的 done_at（保留完成时刻，供后续按子项归因时间）。
function normalizeItems(input, existing = []) {
  if (!Array.isArray(input)) throw httpError(400, 'items 必须是数组', 'invalid_todo');
  if (input.length > ITEMS_MAX) throw httpError(400, `子项最多 ${ITEMS_MAX} 条`, 'invalid_todo');
  const prevById = new Map(existing.map((it) => [it.id, it]));
  const usedIds = new Set();
  const freshId = () => { let x; do { x = randHex(4); } while (usedIds.has(x)); usedIds.add(x); return x; };
  return input.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, `items[${i}] 必须是对象`, 'invalid_todo');
    const title = assertText(raw.title, `items[${i}].title`, FIELD_LIMITS.itemTitle, { required: true });
    if (raw.done !== undefined && typeof raw.done !== 'boolean') throw httpError(400, `items[${i}].done 必须是布尔`, 'invalid_todo');
    const done = raw.done === true;
    let id = typeof raw.id === 'string' && raw.id && !usedIds.has(raw.id) ? raw.id : null;
    if (id) usedIds.add(id); else id = freshId();
    const done_at = done ? (prevById.get(id)?.done_at ?? Date.now()) : null;
    return { id, title, done, done_at };
  });
}

// 状态变化顺带管时段——与页面「▸ 开始 / ✓ 完成」同一语义，也适用于直接调 API 的外部
// 同步程序：进 in_progress 开一段、进 done 闭所有未闭合段。状态没变什么都不做（幂等）。
//
// **父状态由子项派生时也必须走这里**：勾完最后一个子项会让父变 done，若只闭「显式
// PATCH status=done」那一条路径，日历里就会留一条永不结束的事件（实测：子项全勾后
// status=done 但 spans[0].end 仍是 null）。所以派生点统一调本函数，而不是各处各写一遍。
//
// 调用方显式给了 spans 时不调本函数：调用方既然给了时间线，就不该被我们改写。
function syncSpansToStatus(todo, prevStatus) {
  if (todo.status === prevStatus) return;
  if (todo.status === 'in_progress') openSpan(todo);
  else if (todo.status === 'done') closeSpans(todo);
}

// 子项变更后的父状态派生（规则见文件头注释）。
// opts.prevStatus 传入时，派生导致的父状态变化同样开/闭时段（见 syncSpansToStatus）；
// opts.syncSpans=false 用于调用方显式带了 spans 的情形。
function deriveFromItems(todo, { prevStatus, syncSpans = true } = {}) {
  const items = todo.items;
  if (!Array.isArray(items) || items.length === 0) return; // 空清单：不派生
  if (items.every((it) => it.done)) {
    if (todo.status !== 'done') todo.status = 'done';
    if (todo.completed_at == null) todo.completed_at = Date.now(); // 已有章不重盖
  } else if (todo.status === 'done') {
    todo.status = 'in_progress';
    todo.completed_at = null;
  }
  if (syncSpans && prevStatus !== undefined) syncSpansToStatus(todo, prevStatus);
}

// 时段归一化（create / PATCH 整组替换 / 单段端点共用）：
// start 必填正整数 epoch 毫秒；end 可 null（进行中）或 ≥ start。
// id 留则保留（整组替换不换锚点，外部同步程序靠它认事件），缺省/重复则新派。
// **不校验跨待办重叠**：用户来回切是常态，且不同待办的时间本来就可能交叠。
function normalizeSpans(input) {
  if (!Array.isArray(input)) throw httpError(400, 'spans 必须是数组', 'invalid_todo');
  if (input.length > SPANS_MAX) throw httpError(400, `时段最多 ${SPANS_MAX} 段`, 'invalid_todo');
  const usedIds = new Set();
  const freshId = () => { let x; do { x = randHex(4); } while (usedIds.has(x)); usedIds.add(x); return x; };
  return input.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, `spans[${i}] 必须是对象`, 'invalid_todo');
    const start = Number(raw.start);
    if (!Number.isFinite(start) || start <= 0) throw httpError(400, `spans[${i}].start 必须是正的 epoch 毫秒`, 'invalid_todo');
    let end = null;
    if (raw.end !== null && raw.end !== undefined) {
      end = Number(raw.end);
      if (!Number.isFinite(end) || end <= 0) throw httpError(400, `spans[${i}].end 必须是正的 epoch 毫秒或 null`, 'invalid_todo');
      if (end < start) throw httpError(400, `spans[${i}].end 不能早于 start`, 'invalid_todo');
    }
    let id = typeof raw.id === 'string' && raw.id && !usedIds.has(raw.id) ? raw.id : null;
    if (id) usedIds.add(id); else id = freshId();
    return { id, start, end };
  });
}

// 给待办开一段（end=null）。已有未闭合段则幂等返回——连点两下不该多出一段。
// 不做「全局单运行段」约束：日历场景下并行的两件事（开会 + 顺手改代码）是真实的，
// 强行只允许一段会把用户逼去手动改时间。
function openSpan(todo, at = Date.now()) {
  const spans = todo.spans ?? (todo.spans = []);
  const running = spans.find((s) => s.end === null);
  if (running) return running;
  if (spans.length >= SPANS_MAX) throw httpError(400, `时段最多 ${SPANS_MAX} 段`, 'invalid_todo');
  let id = randHex(4);
  while (spans.some((s) => s.id === id)) id = randHex(4);
  const span = { id, start: at, end: null };
  spans.push(span);
  return span;
}

// 闭合待办的所有未闭合段（正常只有一段）。没有未闭合段时什么都不做。
function closeSpans(todo, at = Date.now()) {
  let touched = false;
  for (const s of todo.spans ?? []) {
    if (s.end === null) { s.end = Math.max(at, s.start); touched = true; }
  }
  return touched;
}

// 出参深一层拷贝：items / spans 是数组，浅拷贝会把内存态数组（及其元素）暴露给调用方
const copyTodo = (t) => ({
  ...t,
  ...(Array.isArray(t.items) ? { items: t.items.map((it) => ({ ...it })) } : {}),
  ...(Array.isArray(t.spans) ? { spans: t.spans.map((s) => ({ ...s })) } : {}),
});

// 404 提示里的 id 展示：剥掉控制字符（%00 等在 JSON 文案里显示为空白），剥完为空则给可读占位
const showId = (id) => String(id).replace(/[\x00-\x1f\x7f]/g, '').trim() || '（含不可显示字符）';

function findTodo(id) {
  const todo = state.todos.find((t) => t.id === id);
  if (!todo) throw httpError(404, `待办 ${showId(id)} 不存在`, 'not_found');
  return todo;
}

// 列表（可按 status 过滤）；返回拷贝，调用方改不动内存态
export function listTodos(filter = {}) {
  let todos = state.todos;
  if (filter.status != null) {
    assertEnum(filter.status, 'status', TODO_STATUSES);
    todos = todos.filter((t) => t.status === filter.status);
  }
  return todos.map(copyTodo);
}

export function createTodo(input = {}) {
  // source 先解析（note 上限按来源分级）
  let source = 'user';
  if (input.source != null) {
    const s = assertText(input.source, 'source', FIELD_LIMITS.source);
    if (s !== undefined) source = s;
  }
  const todo = {
    id: randHex(6),
    title: assertText(input.title, 'title', FIELD_LIMITS.title, { required: true }),
    status: 'pending',
    urgency: 'normal',
    project: assertText(input.project, 'project', FIELD_LIMITS.project),
    source,
    note: assertNote(input.note, source),
    created_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
  };
  if (input.urgency != null) {
    assertEnum(input.urgency, 'urgency', TODO_URGENCIES);
    todo.urgency = input.urgency;
  }
  if (input.items !== undefined) todo.items = normalizeItems(input.items);
  if (input.spans !== undefined) todo.spans = normalizeSpans(input.spans);
  deriveFromItems(todo); // 创建即全 done 的清单同样派生
  state.todos.push(todo);
  persist();
  return copyTodo(todo);
}

// 部分更新：只动 patch 里出现的字段；status 置 done 盖 completed_at、离开 done 撤章。
// 携带 items 时为整组替换（id 留则保留），且替换后派生优先于同次显式 status。
//
// **状态切换顺带管时段**（与页面「▸ 开始 / ✓ 完成」同一语义，也适用于直接调 API 的
// 外部同步程序）：进 in_progress 开一段；进 done 闭所有段。patch 里显式带 spans 时
// 以它为准，不再自动开闭——调用方既然给了时间线，就不该被我们改写。
export function updateTodo(id, patch = {}) {
  const todo = findTodo(id);
  const prevStatus = todo.status;
  const next = {};
  if (patch.title !== undefined) next.title = assertText(patch.title, 'title', FIELD_LIMITS.title, { required: true });
  if (patch.project !== undefined) next.project = assertText(patch.project, 'project', FIELD_LIMITS.project);
  if (patch.note !== undefined) next.note = assertNote(patch.note, todo.source);
  if (patch.urgency !== undefined) {
    assertEnum(patch.urgency, 'urgency', TODO_URGENCIES);
    next.urgency = patch.urgency;
  }
  if (patch.status !== undefined) {
    assertEnum(patch.status, 'status', TODO_STATUSES);
    next.status = patch.status;
  }
  if (patch.items !== undefined) next.items = normalizeItems(patch.items, todo.items ?? []);
  if (patch.spans !== undefined) next.spans = normalizeSpans(patch.spans);
  Object.assign(todo, next, { updated_at: Date.now() });
  if (todo.status === 'done' && todo.completed_at == null) todo.completed_at = Date.now();
  if (todo.status !== 'done') todo.completed_at = null;
  // 时段自动开闭：显式传了 spans 就交给调用方；否则按状态变化补。派生（子项全勾 →
  // done）引起的变化也算，所以带 prevStatus 一起交给 deriveFromItems。
  const syncSpans = patch.spans === undefined;
  if (patch.items !== undefined) deriveFromItems(todo, { prevStatus, syncSpans });
  else if (syncSpans) syncSpansToStatus(todo, prevStatus);
  persist();
  return copyTodo(todo);
}

// ── 时段端点（路由见 server.mjs /v1/todos/:id/spans）────────────────────────
// 单段粒度：外部同步程序可以只补一段、只改一段的结束时间，不必整组替换
// （整组替换在并发下会覆盖掉同期另一端写进来的段）。
export function addTodoSpan(todoId, input = {}) {
  const todo = findTodo(todoId);
  const spans = todo.spans ?? (todo.spans = []);
  if (spans.length >= SPANS_MAX) throw httpError(400, `时段最多 ${SPANS_MAX} 段`, 'invalid_todo');
  const [norm] = normalizeSpans([{ ...input, id: undefined }]);
  let id = randHex(4);
  while (spans.some((s) => s.id === id)) id = randHex(4);
  spans.push({ ...norm, id });
  todo.updated_at = Date.now();
  persist();
  return copyTodo(todo);
}

export function updateTodoSpan(todoId, spanId, patch = {}) {
  const todo = findTodo(todoId);
  const span = (todo.spans ?? []).find((s) => s.id === spanId);
  if (!span) throw httpError(404, `时段 ${showId(spanId)} 不存在`, 'not_found');
  const next = { start: span.start, end: span.end };
  if (patch.start !== undefined) {
    const v = Number(patch.start);
    if (!Number.isFinite(v) || v <= 0) throw httpError(400, 'start 必须是正的 epoch 毫秒', 'invalid_todo');
    next.start = v;
  }
  if (patch.end !== undefined) {
    if (patch.end === null) next.end = null;
    else {
      const v = Number(patch.end);
      if (!Number.isFinite(v) || v <= 0) throw httpError(400, 'end 必须是正的 epoch 毫秒或 null', 'invalid_todo');
      next.end = v;
    }
  }
  if (next.end !== null && next.end < next.start) throw httpError(400, 'end 不能早于 start', 'invalid_todo');
  Object.assign(span, next);
  todo.updated_at = Date.now();
  persist();
  return copyTodo(todo);
}

export function deleteTodoSpan(todoId, spanId) {
  const todo = findTodo(todoId);
  const spans = todo.spans ?? [];
  const idx = spans.findIndex((s) => s.id === spanId);
  if (idx < 0) throw httpError(404, `时段 ${showId(spanId)} 不存在`, 'not_found');
  spans.splice(idx, 1);
  todo.updated_at = Date.now();
  persist();
}

// 显式开/闭段：给「⏸ 暂停」这种不改状态的场景用（暂停 ≠ 完成）。
// open：开一段；close：闭所有未闭合段。返回整只父待办，前端据此重绘。
export function openTodoSpan(todoId, at = Date.now()) {
  const todo = findTodo(todoId);
  openSpan(todo, at);
  todo.updated_at = Date.now();
  persist();
  return copyTodo(todo);
}

export function closeTodoSpans(todoId, at = Date.now()) {
  const todo = findTodo(todoId);
  if (closeSpans(todo, at)) { todo.updated_at = Date.now(); persist(); }
  return copyTodo(todo);
}

export function deleteTodo(id) {
  const idx = state.todos.findIndex((t) => t.id === id);
  if (idx < 0) throw httpError(404, `待办 ${showId(id)} 不存在`, 'not_found');
  const [gone] = state.todos.splice(idx, 1);
  // 墓碑 rev ≥ 原 updated_at（时钟略回拨也不该让删除输给它自己删掉的那个 rev）；
  // 顺带清掉过期墓碑（无新删除时残留的旧墓碑只在下次删除时才清，方向安全——
  // 多留一天只是多守一天「不复活」）
  const now = Math.max(Date.now(), Number(gone.updated_at) || 0);
  state.tombstones = sanitizeTombstones(
    [{ id, rev: now, deleted_at: Date.now() }, ...state.tombstones.filter((t) => t.id !== id)],
    now,
  );
  persist();
}

/** 墓碑清单（拷贝）；供同步快照下发与推送端决策。 */
export function listTombstones() {
  return state.tombstones.map((t) => ({ ...t }));
}

// 同步客户端写入：按远端 id 插入或覆盖。仅当远端 rev（=updated_at）严格更新时覆盖；
// 保留远端时间戳，避免本机 Date.now() 把 rev 抬高后反向「盖掉」枢纽。
// 返回 { action: 'insert'|'update'|'skip', id }。
export function applyRemoteTodo(remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return { action: 'skip', id: null };
  const id = typeof remote.id === 'string' ? remote.id.trim() : '';
  if (!id) return { action: 'skip', id: null };
  const rev = Number(remote.rev ?? remote.updated_at) || 0;
  // 墓碑守门：本机删过且墓碑不更旧 → 远端旧版不得穿过墓碑复活（重启全量拉取的
  // 关键防线）。远端确实更新（别机在删除后又编辑过）则清墓碑放行——编辑胜出，
  // 这次复活会随 PATCH 推回枢纽，删除在所有机器上一致失效
  const tomb = state.tombstones.find((t) => t.id === id);
  if (tomb && rev <= tomb.rev) return { action: 'skip', id };
  if (tomb) state.tombstones = state.tombstones.filter((t) => t.id !== id);
  const existing = state.todos.find((t) => t.id === id);
  if (existing && !(rev > (Number(existing.updated_at) || 0))) {
    return { action: 'skip', id };
  }

  let source = existing?.source || 'user';
  if (remote.source != null) {
    const s = assertText(remote.source, 'source', FIELD_LIMITS.source);
    if (s !== undefined) source = s;
  }
  const title = assertText(remote.title, 'title', FIELD_LIMITS.title, { required: true });
  let status = existing?.status || 'pending';
  if (remote.status != null) {
    assertEnum(remote.status, 'status', TODO_STATUSES);
    status = remote.status;
  }
  let urgency = existing?.urgency || 'normal';
  if (remote.urgency != null) {
    assertEnum(remote.urgency, 'urgency', TODO_URGENCIES);
    urgency = remote.urgency;
  }
  const project = remote.project !== undefined
    ? assertText(remote.project, 'project', FIELD_LIMITS.project)
    : existing?.project;
  const note = remote.note !== undefined
    ? assertNote(remote.note, source)
    : existing?.note;
  const created_at = Number(remote.created_at) || existing?.created_at || rev || Date.now();
  const updated_at = rev || Date.now();
  let completed_at = remote.completed_at != null ? Number(remote.completed_at) : (status === 'done' ? (existing?.completed_at ?? updated_at) : null);
  if (status !== 'done') completed_at = null;

  let items;
  if (remote.items !== undefined) {
    items = normalizeItems(remote.items, existing?.items ?? []);
  } else if (existing?.items) {
    items = existing.items;
  }

  if (existing) {
    const prevStatus = existing.status;
    Object.assign(existing, {
      title, status, urgency, project, source, note, created_at, updated_at, completed_at,
      ...(items !== undefined ? { items } : {}),
    });
    if (items !== undefined) deriveFromItems(existing, { prevStatus });
    // 远端 rev 优先：派生可能改 status，但 updated_at 仍用远端
    existing.updated_at = updated_at;
    if (existing.status === 'done' && existing.completed_at == null) existing.completed_at = completed_at ?? updated_at;
    if (existing.status !== 'done') existing.completed_at = null;
    // 时段的开/闭**本地判断**：同步快照不下发 spans（另一台机器的时段对这台没有意义，
    // 且段 id 会撞）。但状态从远端变化过来时，本机正在跑的段该跟着关——否则本机日历
    // 里会留一条永不结束的事件。只能由收到状态变更的这一侧自己补。
    syncSpansToStatus(existing, prevStatus);
    persist();
    return { action: 'update', id };
  }

  const todo = {
    id,
    title,
    status,
    urgency,
    project,
    source,
    note,
    created_at,
    updated_at,
    completed_at,
  };
  if (items !== undefined) todo.items = items;
  deriveFromItems(todo);
  // 新建：远端已是 done 时没有本机段需要闭；已是 in_progress 则开一段（本机开始计时，
  // 与「PATCH status=in_progress」同一语义），pending 什么都不做。
  if (todo.status === 'in_progress') openSpan(todo);
  todo.updated_at = updated_at; // 派生后仍钉死远端 rev
  if (todo.status !== 'done') todo.completed_at = null;
  state.todos.push(todo);
  persist();
  return { action: 'insert', id };
}

/** 纯函数：远端 rev 是否应覆盖本地 updated_at（严格大于）。 */
export function remoteTodoWins(localUpdatedAt, remoteRev) {
  return (Number(remoteRev) || 0) > (Number(localUpdatedAt) || 0);
}

// 同步写入：应用远端墓碑（枢纽上有待办被删的事实）。仅当墓碑 rev ≥ 本地
// updated_at 时删除——墓碑赢平局，与 planRemoteMerges 守门、applyRemoteTodo
// 守门（rev ≤ 墓碑即拒）同一口径；本地更新的待办跳过，留给推送端以更高的 rev
// PATCH 复活枢纽（LWW：编辑胜过更早的删除）。
// **不落本机墓碑**：枢纽保留着它，重启全量拉取还会再下发；本机再记一份反而让
// 推送端以为「枢纽还有旧版」而反复 DELETE。返回 { action: 'delete'|'skip', id }。
export function applyRemoteTombstone(remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return { action: 'skip', id: null };
  const id = typeof remote.id === 'string' ? remote.id.trim() : '';
  if (!id) return { action: 'skip', id: null };
  const rev = Number(remote.rev ?? remote.updated_at) || 0;
  const existing = state.todos.find((t) => t.id === id);
  if (!existing) return { action: 'skip', id };
  if (rev < (Number(existing.updated_at) || 0)) return { action: 'skip', id };
  state.todos.splice(state.todos.indexOf(existing), 1);
  persist();
  return { action: 'delete', id };
}

// ── 子项端点的数据层（路由见 server.mjs /v1/todos/:id/items） ───────────────
// 单子项操作只动目标子项与父的派生状态——并发场景（agent 勾子项 × 网页编辑其他
// 字段）互不整组覆盖；整组编辑走 updateTodo 的 items 替换。

export function createTodoItem(todoId, input = {}) {
  const todo = findTodo(todoId);
  const prevStatus = todo.status;
  const items = todo.items ?? (todo.items = []);
  if (items.length >= ITEMS_MAX) throw httpError(400, `子项最多 ${ITEMS_MAX} 条`, 'invalid_todo');
  const title = assertText(input.title, 'title', FIELD_LIMITS.itemTitle, { required: true });
  if (input.done !== undefined && typeof input.done !== 'boolean') throw httpError(400, 'done 必须是布尔', 'invalid_todo');
  let id = randHex(4);
  while (items.some((it) => it.id === id)) id = randHex(4); // 父内唯一
  const done = input.done === true;
  items.push({ id, title, done, done_at: done ? Date.now() : null });
  todo.updated_at = Date.now();
  deriveFromItems(todo, { prevStatus });
  persist();
  return copyTodo(todo);
}

export function updateTodoItem(todoId, itemId, patch = {}) {
  const todo = findTodo(todoId);
  const prevStatus = todo.status;
  const item = (todo.items ?? []).find((it) => it.id === itemId);
  if (!item) throw httpError(404, `子项 ${showId(itemId)} 不存在`, 'not_found');
  const next = {};
  if (patch.title !== undefined) next.title = assertText(patch.title, 'title', FIELD_LIMITS.itemTitle, { required: true });
  if (patch.done !== undefined) {
    if (typeof patch.done !== 'boolean') throw httpError(400, 'done 必须是布尔', 'invalid_todo');
    next.done = patch.done;
    next.done_at = patch.done ? (item.done_at ?? Date.now()) : null;
  }
  Object.assign(item, next);
  todo.updated_at = Date.now();
  deriveFromItems(todo, { prevStatus });
  persist();
  return copyTodo(todo);
}

export function deleteTodoItem(todoId, itemId) {
  const todo = findTodo(todoId);
  const prevStatus = todo.status;
  const items = todo.items ?? [];
  const idx = items.findIndex((it) => it.id === itemId);
  if (idx < 0) throw httpError(404, `子项 ${showId(itemId)} 不存在`, 'not_found');
  items.splice(idx, 1);
  todo.updated_at = Date.now();
  deriveFromItems(todo, { prevStatus });
  persist();
}

// 报告素材：时间窗内新增 / 更新 / 完成的待办。
// updated 与其余两类**互斥**（新增/完成各自按自己的时间戳判定，本窗新建又本窗完成的
// 会同时出现在 created 与 completed——如实呈现「建了也结了」）：
//   created    created_at 在窗内；
//   completed  completed_at 在窗内；
//   updated    其余情况下 updated_at 在窗内——即「窗口前就存在、窗口内被推进、但没在本窗
//              新建也没在本窗完成」的存量待办。因此「刚创建就编辑」不会重复进 updated，
//              「本窗完成」也不会：一条待办在汇报里最多出现两次（新建+完成），不会三次。
export function todosInWindow(startMs, endMs) {
  const inWin = (ms) => ms != null && ms >= startMs && ms < endMs;
  const created = state.todos.filter((t) => inWin(t.created_at));
  const completed = state.todos.filter((t) => inWin(t.completed_at));
  const updated = state.todos.filter((t) => inWin(t.updated_at) && !inWin(t.created_at) && !inWin(t.completed_at));
  return {
    created: created.map(copyTodo),
    updated: updated.map(copyTodo),
    completed: completed.map(copyTodo),
  };
}
