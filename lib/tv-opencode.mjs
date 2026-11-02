// 电视 OpenCode 战况墙快照：把本机 OpenCode 最近会话裁成「够用的一小份 JSON」，
// 供客厅电视屏保 / 指挥台轮询（GET /tv/v1/opencode，契约见 aerial-tv docs/opencode-console.md）。
//
// 数据源优先读 ~/.local/share/opencode/opencode.db 的 session_v2 + session_message
// （与报告适配器同库；新版会话在 session_v2，正文嵌在 session_message.data.content）。
// 没有会话 / 读库失败时仍回 online=true + status=idle 的合法帧——电视要能画「等待会话」，
// 不能把网关离线与「OpenCode 没在跑」混为一谈。
//
// 纯函数 [buildOpenCodeSnapshot] 可注入，便于单测；网络 / 子进程只出现在 [opencodeSnapshotNow]。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { querySqlite } from './report/sqlite.mjs';
import { clip } from './tv-snapshot.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TOOLS = 8;
const MAX_TASKS = 8;
const TITLE_MAX = 80;
const STEP_MAX = 80;
const PROJECT_MAX = 40;
const MODEL_MAX = 48;
const TARGET_MAX = 80;
const BRANCH_MAX = 40;
const AGENT_MAX = 24;

const STATUSES = new Set(['idle', 'running', 'waiting', 'done', 'failed']);
const TASK_STATES = new Set(['done', 'running', 'pending']);
const TOOL_STATES = new Set(['running', 'ok', 'failed']);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const basename = (p) => {
  const s = String(p || '').replace(/\/+$/, '');
  if (!s) return undefined;
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return clip(i >= 0 ? s.slice(i + 1) : s, PROJECT_MAX);
};

function dbPath() {
  return process.env.CANNBOT_OPENCODE_DB
    || path.join(os.homedir(), '.local/share/opencode/opencode.db');
}

/** 工具状态：OpenCode 流式中间态 pending/running → running；error → failed；其余已结束按 ok。 */
export function mapToolStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'pending' || s === 'running' || s === 'in_progress') return 'running';
  if (s === 'error' || s === 'failed' || s === 'cancelled' || s === 'canceled') return 'failed';
  return 'ok';
}

/** 计划行状态：OpenCode todo.status → TV state。 */
export function mapTaskState(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'completed' || s === 'done' || s === 'cancelled' || s === 'canceled') return 'done';
  if (s === 'in_progress' || s === 'running' || s === 'active') return 'running';
  return 'pending';
}

/**
 * 会话级 status：
 *   - 有未完成工具 → running（比 idle_outcome 更即时）
 *   - time_busy 新于 time_idle（或尚无 idle）→ running
 *   - idle_outcome=failed → failed；succeeded → done
 *   - 其余 → idle（绝不把未知值装成 running）
 */
export function deriveStatus({ idleOutcome, timeBusy, timeIdle, now, tools = [] } = {}) {
  if (tools.some((t) => t?.status === 'running')) return 'running';
  const busy = num(timeBusy);
  const idle = num(timeIdle);
  if (busy > 0 && (idle <= 0 || busy > idle)) return 'running';
  // 刚 busy 过、但消息还没落到 idle 行：用「最近 90 秒内更新」兜一层，避免闪 idle
  if (busy > 0 && idle <= 0 && now - busy < 90_000) return 'running';
  const out = String(idleOutcome || '').toLowerCase();
  if (out === 'failed' || out === 'error') return 'failed';
  if (out === 'succeeded' || out === 'completed' || out === 'done') return 'done';
  return 'idle';
}

function toolTarget(input) {
  if (!input || typeof input !== 'object') return undefined;
  for (const k of ['path', 'filePath', 'file', 'command', 'pattern', 'query', 'url', 'target']) {
    if (input[k] != null && String(input[k]).trim()) return clip(String(input[k]), TARGET_MAX);
  }
  return undefined;
}

function parseModel(raw) {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return clip(raw, MODEL_MAX); }
  }
  if (typeof raw !== 'object') return undefined;
  const id = raw.id || raw.model || raw.name;
  const provider = raw.providerID || raw.provider || raw.providerId;
  if (id && provider) return clip(`${provider}/${id}`, MODEL_MAX);
  if (id) return clip(id, MODEL_MAX);
  return undefined;
}

/**
 * 从 session_message 行抽出工具事件（最新优先）。data 可能已是对象（测试注入）或 JSON 字符串。
 */
export function extractTools(messages, { limit = MAX_TOOLS } = {}) {
  const out = [];
  for (const m of messages || []) {
    let data = m?.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { continue; }
    }
    const content = Array.isArray(data?.content) ? data.content
      : Array.isArray(m?.content) ? m.content
        : [];
    for (const p of content) {
      if (!p || p.type !== 'tool' || !p.name) continue;
      const st = p.state || {};
      out.push({
        id: String(p.id || `${m.id || 'm'}:${out.length}`),
        name: clip(p.name, 40) ?? String(p.name),
        target: toolTarget(st.input),
        status: mapToolStatus(st.status),
        at: num(m.time_updated || m.time_created || data?.time?.completed || data?.time?.created),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** OpenCode todo 表行 → plan.tasks。 */
export function extractTasks(todos, { limit = MAX_TASKS } = {}) {
  const rows = Array.isArray(todos) ? todos : [];
  return rows.slice(0, limit).map((t, i) => {
    const title = clip(t.content ?? t.title, TITLE_MAX);
    if (!title) return null;
    return {
      id: String(t.id ?? t.position ?? i),
      title,
      state: mapTaskState(t.status),
    };
  }).filter(Boolean);
}

/**
 * 组装一帧。入参可注入：
 *   session  最新会话元数据（session_v2 形状或精简对象）
 *   messages 同会话 session_message 行（seq 降序，最新在前）
 *   todos    同会话 todo 行
 *   branch   可选 git 分支名
 *   demo     演示帧标记（默认 false）
 *   now      毫秒时间戳
 */
export function buildOpenCodeSnapshot({
  session = null,
  messages = [],
  todos = [],
  branch,
  demo = false,
  now = Date.now(),
} = {}) {
  if (!session || typeof session !== 'object') {
    return { now, online: true, demo: !!demo, status: 'idle' };
  }

  const tools = extractTools(messages);
  const tasks = extractTasks(todos);
  const status = deriveStatus({
    idleOutcome: session.idle_outcome ?? session.idleOutcome ?? session.outcome,
    timeBusy: session.time_busy ?? session.timeBusy,
    timeIdle: session.time_idle ?? session.timeIdle,
    now,
    tools,
  });

  const created = num(session.time_created ?? session.timeCreated);
  const updated = num(session.time_updated ?? session.timeUpdated) || now;
  const idleAt = num(session.time_idle ?? session.timeIdle);
  const end = status === 'running' ? now : (idleAt || updated);
  const elapsedMs = created > 0 ? Math.max(0, Math.round(end - created)) : 0;
  const tokens = Math.max(0, Math.round(
    num(session.tokens_input) + num(session.tokens_output) + num(session.tokens_reasoning)
    || num(session.tokens),
  ));

  const runningTask = tasks.find((t) => t.state === 'running');
  const pendingTask = tasks.find((t) => t.state === 'pending');
  const doneCount = tasks.filter((t) => t.state === 'done').length;
  const stepIndex = runningTask
    ? tasks.indexOf(runningTask)
    : (status === 'done' ? Math.max(tasks.length - 1, 0) : doneCount);
  const stepTotal = tasks.length;
  let progress;
  if (status === 'done') progress = 1;
  else if (stepTotal > 0) progress = Math.max(0, Math.min(1, stepIndex / stepTotal));

  const step = clip(
    runningTask?.title
      || pendingTask?.title
      || tools[0]?.target
      || tools[0]?.name
      || undefined,
    STEP_MAX,
  );

  const directory = session.directory || session.location?.directory || '';

  // 从最近的消息补 agent / model（session_v2.agent 经常为空）
  let agent = clip(session.agent, AGENT_MAX);
  let model = parseModel(session.model);
  for (const m of messages) {
    let d = m?.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { continue; } }
    if (!d || typeof d !== 'object') continue;
    if (!agent && d.agent) agent = clip(d.agent, AGENT_MAX);
    if (!model && d.model) model = parseModel(d.model);
    if (agent && model) break;
  }

  const title = clip(session.title, TITLE_MAX);
  const project = basename(directory);
  const sessionId = session.id ? String(session.id) : undefined;

  const out = {
    now,
    online: true,
    demo: !!demo,
    status: STATUSES.has(status) ? status : 'idle',
    elapsedMs,
    tokens,
    stepIndex: Math.max(0, stepIndex),
    stepTotal: Math.max(0, stepTotal),
  };
  if (title) out.title = title;
  if (step) out.step = step;
  if (progress != null) out.progress = progress;

  const sess = {};
  if (sessionId) sess.id = sessionId;
  if (project) sess.project = project;
  const br = clip(branch, BRANCH_MAX);
  if (br) sess.branch = br;
  if (model) sess.model = model;
  if (agent) sess.agent = agent;
  if (Object.keys(sess).length) out.session = sess;

  if (tasks.length) out.plan = { tasks };
  if (tools.length) {
    out.tools = tools.map((t) => {
      const row = {
        id: t.id,
        name: t.name,
        status: TOOL_STATES.has(t.status) ? t.status : 'ok',
        at: t.at,
      };
      if (t.target) row.target = t.target;
      return row;
    });
  }
  return out;
}

/** 演示帧：网关联调开关 CANNBOT_OPENCODE_TV_DEMO=1 时用；形状与契约一致。 */
export function buildDemoOpenCodeSnapshot(now = Date.now()) {
  const cycle = 72_000;
  const t = ((now % cycle) + cycle) % cycle;
  const phase = t < 18_000 ? 0 : t < 36_000 ? 1 : t < 54_000 ? 2 : 3;
  const tasks = [
    { id: 't1', title: '梳理数据与入口', state: phase > 0 ? 'done' : 'running' },
    { id: 't2', title: '实现战况墙', state: phase === 1 ? 'running' : phase > 1 ? 'done' : 'pending' },
    { id: 't3', title: '网关联调与真机', state: phase === 2 ? 'running' : phase > 2 ? 'done' : 'pending' },
    { id: 't4', title: '补测试并提交', state: phase === 3 ? 'running' : 'pending' },
  ];
  const status = phase === 3 && t > 66_000 ? 'done' : 'running';
  return buildOpenCodeSnapshot({
    now,
    demo: true,
    branch: 'feat/workbench-dashboard',
    session: {
      id: 'ses_demo_tv',
      title: 'OpenCode 战况墙联调',
      directory: '/Users/tom/Desktop/project/aerial-tv',
      agent: 'build',
      model: { id: 'deepseek-v4.1-flash', providerID: 'pg' },
      time_created: now - t,
      time_updated: now,
      time_busy: status === 'running' ? now - 1_000 : now - 10_000,
      time_idle: status === 'done' ? now : 0,
      idle_outcome: status === 'done' ? 'succeeded' : null,
      tokens_input: 12000,
      tokens_output: 3000,
      tokens_reasoning: 800,
    },
    todos: tasks.map((x, i) => ({
      position: i,
      content: x.title,
      status: x.state === 'done' ? 'completed' : x.state === 'running' ? 'in_progress' : 'pending',
    })),
    messages: [{
      id: 'msg_demo',
      time_updated: now,
      data: {
        content: [
          {
            type: 'tool',
            id: 'call_demo_1',
            name: phase < 2 ? 'edit' : 'shell',
            state: {
              status: status === 'running' ? 'running' : 'completed',
              input: { path: 'lib/tv-opencode.mjs', command: './install.sh' },
            },
          },
          {
            type: 'tool',
            id: 'call_demo_0',
            name: 'read',
            state: { status: 'completed', input: { path: 'docs/opencode-console.md' } },
          },
        ],
      },
    }],
  });
}

async function readLatestSession(db) {
  if (!fs.existsSync(db)) return null;
  const rows = await querySqlite(db, `
    SELECT id, title, directory, agent, model,
           tokens_input, tokens_output, tokens_reasoning,
           time_created, time_updated, time_busy, time_idle, idle_outcome, time_archived
    FROM session_v2
    WHERE time_archived IS NULL
    ORDER BY time_updated DESC
    LIMIT 1`);
  return rows[0] || null;
}

async function readMessages(db, sessionId) {
  if (!sessionId || !ID_RE.test(sessionId)) return [];
  return querySqlite(db, `
    SELECT id, type, time_created, time_updated, data
    FROM session_message
    WHERE session_id = '${sessionId}' AND type IN ('assistant','user','idle')
    ORDER BY seq DESC
    LIMIT 40`);
}

async function readTodos(db, sessionId) {
  if (!sessionId || !ID_RE.test(sessionId)) return [];
  try {
    return await querySqlite(db, `
      SELECT position, content, status, priority
      FROM todo WHERE session_id = '${sessionId}'
      ORDER BY position ASC LIMIT ${MAX_TASKS}`);
  } catch {
    return [];
  }
}

function gitBin() {
  for (const c of ['/opt/homebrew/bin/git', '/usr/bin/git', 'git']) {
    try { if (c === 'git' || fs.existsSync(c)) return c; } catch {}
  }
  return 'git';
}

function gitBranch(directory) {
  return new Promise((resolve) => {
    if (!directory || !fs.existsSync(directory)) return resolve(undefined);
    execFile(gitBin(), ['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 800,
      maxBuffer: 1024,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
    }, (e, stdout) => {
      if (e) return resolve(undefined);
      const b = String(stdout || '').trim();
      resolve(b && b !== 'HEAD' ? b : undefined);
    });
  });
}

/**
 * 现读一帧。CANNBOT_OPENCODE_TV_DEMO=1（或 'true'）时强制演示帧；
 * 读库失败时回 idle 帧（online 仍为 true），不抛——电视端把抛错当离线。
 */
export async function opencodeSnapshotNow({ now = Date.now(), demo } = {}) {
  const forceDemo = demo === true
    || /^(1|true|yes)$/i.test(String(process.env.CANNBOT_OPENCODE_TV_DEMO || ''));
  if (forceDemo) return buildDemoOpenCodeSnapshot(now);

  const db = dbPath();
  try {
    const session = await readLatestSession(db);
    if (!session) return buildOpenCodeSnapshot({ now, demo: false });
    const [messages, todos, branch] = await Promise.all([
      readMessages(db, session.id),
      readTodos(db, session.id),
      gitBranch(session.directory),
    ]);
    return buildOpenCodeSnapshot({ session, messages, todos, branch, now, demo: false });
  } catch (e) {
    // 库损坏 / sqlite 挂了：仍宣告网关在线，只是没有会话可跟。
    return buildOpenCodeSnapshot({ now, demo: false });
  }
}

/**
 * OpenCode 帧的 ETag：去掉 now / elapsedMs（随秒走），保留 status/plan/tools。
 * running 时工具 at 会变，正常换 ETag；idle/done 稳态应尽量 304。
 */
export function etagOfOpenCode(body) {
  let stable = body;
  try {
    const obj = JSON.parse(body);
    delete obj.now;
    delete obj.elapsedMs;
    // tools[].at 是事件时间戳：演示帧每秒重算 now 会拖着它变，把 304 毁掉；
    // 真实帧里 at 只在新工具出现时变——那时 name/target/status 也会变，照样换 ETag。
    if (Array.isArray(obj.tools)) {
      obj.tools = obj.tools.map(({ at, ...rest }) => rest);
    }
    stable = JSON.stringify(obj);
  } catch { /* 非 JSON 原样 */ }
  return '"' + createHash('sha1').update(stable).digest('base64url').slice(0, 20) + '"';
}

export const OPENCODE_MAX_BYTES = 6 * 1024;

/** 字节兜底：先砍 tools，再砍 plan.tasks，再缩短 step/title。 */
export function fitOpenCodeToLimit(snapshot) {
  const bytes = (s) => Buffer.byteLength(JSON.stringify(s));
  const out = structuredClone(snapshot);
  if (bytes(out) <= OPENCODE_MAX_BYTES) return out;
  while (Array.isArray(out.tools) && out.tools.length > 1 && bytes(out) > OPENCODE_MAX_BYTES) {
    out.tools.pop();
  }
  while (out.plan?.tasks?.length > 1 && bytes(out) > OPENCODE_MAX_BYTES) {
    out.plan.tasks.pop();
  }
  if (bytes(out) > OPENCODE_MAX_BYTES && out.step) out.step = clip(out.step, 24);
  if (bytes(out) > OPENCODE_MAX_BYTES && out.title) out.title = clip(out.title, 24);
  if (bytes(out) > OPENCODE_MAX_BYTES) delete out.tools;
  if (bytes(out) > OPENCODE_MAX_BYTES) delete out.plan;
  return out;
}
