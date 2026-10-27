// 个人工作台 · 待办数据层：人（工作台网页）与各 agent（REST）共用的任务中枢。
// 数据文件 todos.json（env CANNBOT_TODOS_FILE 覆盖，测试隔离用），写频低——每次变更
// 即原子写穿（tmp + rename，0600），不做 stats 那种防抖。
// 坏文件 / 首次运行：空列表起步（下次写盘自动修复文件），绝不阻塞网关主业务；
// 坏文件先备份为 .bad 再起步，避免下次写盘静默覆盖用户数据。
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
const FIELD_LIMITS = { title: 500, note: 2000, project: 60, source: 60 };

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

// 列表（可按 status 过滤）；返回浅拷贝，调用方改不动内存态
export function listTodos(filter = {}) {
  let todos = state.todos;
  if (filter.status != null) {
    assertEnum(filter.status, 'status', TODO_STATUSES);
    todos = todos.filter((t) => t.status === filter.status);
  }
  return todos.map((t) => ({ ...t }));
}

export function createTodo(input = {}) {
  const todo = {
    id: randHex(6),
    title: assertText(input.title, 'title', FIELD_LIMITS.title, { required: true }),
    status: 'pending',
    urgency: 'normal',
    project: assertText(input.project, 'project', FIELD_LIMITS.project),
    source: 'user',
    note: assertText(input.note, 'note', FIELD_LIMITS.note),
    created_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
  };
  if (input.urgency != null) {
    assertEnum(input.urgency, 'urgency', TODO_URGENCIES);
    todo.urgency = input.urgency;
  }
  if (input.source != null) {
    const s = assertText(input.source, 'source', FIELD_LIMITS.source);
    if (s !== undefined) todo.source = s;
  }
  state.todos.push(todo);
  persist();
  return { ...todo };
}

// 部分更新：只动 patch 里出现的字段；status 置 done 盖 completed_at、离开 done 撤章
export function updateTodo(id, patch = {}) {
  const todo = state.todos.find((t) => t.id === id);
  if (!todo) throw httpError(404, `待办 ${id} 不存在`, 'not_found');
  const next = {};
  if (patch.title !== undefined) next.title = assertText(patch.title, 'title', FIELD_LIMITS.title, { required: true });
  if (patch.project !== undefined) next.project = assertText(patch.project, 'project', FIELD_LIMITS.project);
  if (patch.note !== undefined) next.note = assertText(patch.note, 'note', FIELD_LIMITS.note);
  if (patch.urgency !== undefined) {
    assertEnum(patch.urgency, 'urgency', TODO_URGENCIES);
    next.urgency = patch.urgency;
  }
  if (patch.status !== undefined) {
    assertEnum(patch.status, 'status', TODO_STATUSES);
    next.status = patch.status;
  }
  Object.assign(todo, next, { updated_at: Date.now() });
  if (todo.status === 'done' && todo.completed_at == null) todo.completed_at = Date.now();
  if (todo.status !== 'done') todo.completed_at = null;
  persist();
  return { ...todo };
}

export function deleteTodo(id) {
  const idx = state.todos.findIndex((t) => t.id === id);
  if (idx < 0) throw httpError(404, `待办 ${id} 不存在`, 'not_found');
  state.todos.splice(idx, 1);
  persist();
}

// 报告素材：时间窗内新增 / 完成的待办（created_at / completed_at 落在窗口）
export function todosInWindow(startMs, endMs) {
  const createdIn = (t) => t.created_at >= startMs && t.created_at < endMs;
  const completedIn = (t) => t.completed_at != null && t.completed_at >= startMs && t.completed_at < endMs;
  return {
    created: state.todos.filter(createdIn).map((t) => ({ ...t })),
    completed: state.todos.filter(completedIn).map((t) => ({ ...t })),
  };
}
