// 个人工作台 · 待办数据层：人（工作台网页）与各 agent（REST）共用的任务中枢。
// 数据文件 todos.json（env CANNBOT_TODOS_FILE 覆盖，测试隔离用），写频低——每次变更
// 即原子写穿（tmp + rename，0600），不做 stats 那种防抖。
// 坏文件 / 首次运行：空列表起步（下次写盘自动修复文件），绝不阻塞网关主业务；
// 坏文件先备份为 .bad 再起步，避免下次写盘静默覆盖用户数据。
//
// 子项（checklist）：todo.items = [{ id, title, done, done_at }]，数组序即展示序。
// 每次子项变更后跑 deriveFromItems 派生父状态（规则见
// docs/superpowers/specs/2026-10-28-todo-subitems-design.md §三）：
//   非空且全 done → 父 done（completed_at 原为空才盖，不重盖）；
//   有未完成且父 done → 父 in_progress（取消完成 = 工作重新开始）并清章；
//   空清单 / 无清单 → 不派生（父状态纯手动）。
// note 即「可编辑详情」；agent 来源（source ≠ 'user'）硬上限 300 码位（可读性：
// 标题一行可扫、详情要短），用户网页路径 2000。旧数据无 items 字段零迁移。
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

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.todos)) {
      const todos = raw.todos.filter((t) => t && typeof t === 'object' && typeof t.id === 'string');
      return { version: 1, todos };
    }
    log(`todos.json 结构异常，按空列表起步: ${TODOS_FILE}`);
    backupBadFile(TODOS_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log(`todos.json 读取失败，按空列表起步: ${e.message}`);
      backupBadFile(TODOS_FILE);
    }
  }
  return { version: 1, todos: [] };
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

// 子项变更后的父状态派生（规则见文件头注释）
function deriveFromItems(todo) {
  const items = todo.items;
  if (!Array.isArray(items) || items.length === 0) return; // 空清单：不派生
  if (items.every((it) => it.done)) {
    if (todo.status !== 'done') todo.status = 'done';
    if (todo.completed_at == null) todo.completed_at = Date.now(); // 已有章不重盖
  } else if (todo.status === 'done') {
    todo.status = 'in_progress';
    todo.completed_at = null;
  }
}

// 出参深一层拷贝：items 是数组，浅拷贝会把内存态的子项数组暴露给调用方
const copyTodo = (t) => ({ ...t, ...(Array.isArray(t.items) ? { items: t.items.map((it) => ({ ...it })) } : {}) });

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
  deriveFromItems(todo); // 创建即全 done 的清单同样派生
  state.todos.push(todo);
  persist();
  return copyTodo(todo);
}

// 部分更新：只动 patch 里出现的字段；status 置 done 盖 completed_at、离开 done 撤章。
// 携带 items 时为整组替换（id 留则保留），且替换后派生优先于同次显式 status
export function updateTodo(id, patch = {}) {
  const todo = findTodo(id);
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
  Object.assign(todo, next, { updated_at: Date.now() });
  if (todo.status === 'done' && todo.completed_at == null) todo.completed_at = Date.now();
  if (todo.status !== 'done') todo.completed_at = null;
  if (patch.items !== undefined) deriveFromItems(todo);
  persist();
  return copyTodo(todo);
}

export function deleteTodo(id) {
  const idx = state.todos.findIndex((t) => t.id === id);
  if (idx < 0) throw httpError(404, `待办 ${showId(id)} 不存在`, 'not_found');
  state.todos.splice(idx, 1);
  persist();
}

// 同步客户端写入：按远端 id 插入或覆盖。仅当远端 rev（=updated_at）严格更新时覆盖；
// 保留远端时间戳，避免本机 Date.now() 把 rev 抬高后反向「盖掉」枢纽。
// 返回 { action: 'insert'|'update'|'skip', id }。
export function applyRemoteTodo(remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return { action: 'skip', id: null };
  const id = typeof remote.id === 'string' ? remote.id.trim() : '';
  if (!id) return { action: 'skip', id: null };
  const rev = Number(remote.rev ?? remote.updated_at) || 0;
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
    Object.assign(existing, {
      title, status, urgency, project, source, note, created_at, updated_at, completed_at,
      ...(items !== undefined ? { items } : {}),
    });
    if (items !== undefined) deriveFromItems(existing);
    // 远端 rev 优先：派生可能改 status，但 updated_at 仍用远端
    existing.updated_at = updated_at;
    if (existing.status === 'done' && existing.completed_at == null) existing.completed_at = completed_at ?? updated_at;
    if (existing.status !== 'done') existing.completed_at = null;
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

// ── 子项端点的数据层（路由见 server.mjs /v1/todos/:id/items） ───────────────
// 单子项操作只动目标子项与父的派生状态——并发场景（agent 勾子项 × 网页编辑其他
// 字段）互不整组覆盖；整组编辑走 updateTodo 的 items 替换。

export function createTodoItem(todoId, input = {}) {
  const todo = findTodo(todoId);
  const items = todo.items ?? (todo.items = []);
  if (items.length >= ITEMS_MAX) throw httpError(400, `子项最多 ${ITEMS_MAX} 条`, 'invalid_todo');
  const title = assertText(input.title, 'title', FIELD_LIMITS.itemTitle, { required: true });
  if (input.done !== undefined && typeof input.done !== 'boolean') throw httpError(400, 'done 必须是布尔', 'invalid_todo');
  let id = randHex(4);
  while (items.some((it) => it.id === id)) id = randHex(4); // 父内唯一
  const done = input.done === true;
  items.push({ id, title, done, done_at: done ? Date.now() : null });
  todo.updated_at = Date.now();
  deriveFromItems(todo);
  persist();
  return copyTodo(todo);
}

export function updateTodoItem(todoId, itemId, patch = {}) {
  const todo = findTodo(todoId);
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
  deriveFromItems(todo);
  persist();
  return copyTodo(todo);
}

export function deleteTodoItem(todoId, itemId) {
  const todo = findTodo(todoId);
  const items = todo.items ?? [];
  const idx = items.findIndex((it) => it.id === itemId);
  if (idx < 0) throw httpError(404, `子项 ${showId(itemId)} 不存在`, 'not_found');
  items.splice(idx, 1);
  todo.updated_at = Date.now();
  deriveFromItems(todo);
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
