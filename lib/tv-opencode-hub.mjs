// 电视 OpenCode 多源枢纽：本机帧 + spoke（如 MacBook）经 sync 投稿的缓存帧。
// 电视永远只拉本机 /tv/v1/opencode；哪台 Mac 上墙由 gateway.tv.opencodeSource 决定。
//
// source 取值：
//   local              → 永远本机
//   auto               → 最近 staleMs 内有 spoke 且 status=running 则用最新 running spoke，否则本机
//   spoke:<deviceId>   → 锁定某 spoke；帧过期则回落本机（不让电视空白）
//
// 出口 JSON 总带 source：{ kind: 'local'|'spoke', id?, host? }，供指挥台/战况墙展示。
import os from 'node:os';
import { OPENCODE_MAX_BYTES, OPENCODE_RICH_MAX_BYTES, fitOpenCodeToLimit } from './tv-opencode.mjs';

const DEFAULT_STALE_MS = 45_000;
const DEVICE_ID_RE = /^[a-zA-Z0-9._:-]{1,80}$/;
const STATUSES = new Set(['idle', 'running', 'waiting', 'done', 'failed']);
// spoke 投稿缓存的有界性：条目按时间淘汰（超过 staleMs 的 10 倍视为僵尸）、设备数设上限。
// 枢纽进程与 8484 主监听共存，无界 Map 会把整个网关一起拖垮；持合法 token 的 spoke
// 每轮换一个 deviceId 就能每分钟涨几十条 32KB 帧，必须收敛。
const SPOKE_EVICT_MS = DEFAULT_STALE_MS * 10;
const SPOKE_MAX_DEVICES = 16;

/** @type {Map<string, { frame: object, receivedAt: number, tokenName: string|null }>} */
const spokeFrames = new Map();
// deviceId → 首个认领它的 token 名：防持他 token 的设备冒名覆盖（与 spokeFrames 同生命周期）
const spokeOwners = new Map();

function localHostLabel() {
  try { return os.hostname().replace(/\.local$/i, '') || 'local'; } catch { return 'local'; }
}

/** 解析配置字符串 → { mode: 'local'|'auto'|'spoke', deviceId?: string } */
export function parseOpenCodeSource(raw) {
  const s = String(raw ?? 'local').trim().toLowerCase();
  if (!s || s === 'local' || s === 'mini' || s === 'hub') return { mode: 'local' };
  if (s === 'auto') return { mode: 'auto' };
  const m = /^spoke:(.+)$/i.exec(String(raw ?? '').trim());
  if (m) {
    const deviceId = m[1].trim();
    if (DEVICE_ID_RE.test(deviceId)) return { mode: 'spoke', deviceId };
  }
  // 非法值安全回落 local（不阻塞电视）
  return { mode: 'local' };
}

export function normalizeOpenCodeSource(raw) {
  const p = parseOpenCodeSource(raw);
  if (p.mode === 'spoke') return `spoke:${p.deviceId}`;
  return p.mode;
}

// 投稿帧允许的顶层键＝buildOpenCodeSnapshot 出口契约（tv-opencode.mjs）。
// 投稿端是别的机器，白名单外一律不收：此前只删 source/deviceId/host/spokeId 四键，
// 能过 fit 的未知 junk 键会原样透传到电视出口（新增契约键时要同步这里）
const INGRESS_ALLOWED_KEYS = new Set([
  'now', 'online', 'demo', 'status', 'elapsedMs', 'tokens', 'stepIndex', 'stepTotal',
  'title', 'step', 'progress', 'session', 'sessions', 'plan', 'tools',
]);

function stripIngressMeta(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const out = {};
  for (const k of Object.keys(frame)) {
    if (INGRESS_ALLOWED_KEYS.has(k)) out[k] = frame[k];
  }
  return out;
}

function sanitizeSessionBrief(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  // 按 Unicode 码位截断（Array.from）：String.slice 按 UTF-16 码元截，会把 emoji/
  // 代理对从中间劈开（tv-snapshot.clip 同口径）
  const str = (v, n) => {
    if (v == null) return undefined;
    const s = String(v);
    const cps = Array.from(s);
    return (cps.length <= n ? s : cps.slice(0, n).join('')) || undefined;
  };
  const st = String(r.status || 'idle').toLowerCase();
  const out = { status: STATUSES.has(st) ? st : 'idle', at: Number.isFinite(Number(r.at)) ? Number(r.at) : 0 };
  const id = str(r.id, 128); if (id) out.id = id;
  const title = str(r.title, 60); if (title) out.title = title;
  const project = str(r.project, 40); if (project) out.project = project;
  const step = str(r.step, 60); if (step) out.step = step;
  return out;
}

// 主卡 session 元数据（嵌套对象，白名单 + 逐字段截断）：顶层白名单管不住它，
// 一个 20KB 的 session.project 曾能原样穿透到电视出口
function sanitizeSessionMeta(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const str = (v, n) => {
    if (v == null) return undefined;
    const cps = Array.from(String(v));
    return (cps.length <= n ? String(v) : cps.slice(0, n).join('')) || undefined;
  };
  const out = {};
  for (const [k, n] of [['id', 128], ['project', 80], ['branch', 80], ['model', 120], ['agent', 80]]) {
    const v = str(s[k], n);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// 计划任务表（plan.tasks）：白名单三字段 + 截断
function sanitizePlanTasks(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!Array.isArray(p.tasks)) return null;
  const str = (v, n) => {
    if (v == null) return undefined;
    const cps = Array.from(String(v));
    return (cps.length <= n ? String(v) : cps.slice(0, n).join('')) || undefined;
  };
  const tasks = p.tasks.slice(0, 24).map((t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    const st = String(t.state || 'pending').toLowerCase();
    const out = { title: str(t.title, 200) ?? '', state: ['pending', 'running', 'done'].includes(st) ? st : 'pending' };
    const id = str(t.id, 128);
    if (id) out.id = id;
    return out;
  }).filter(Boolean);
  return { tasks };
}

// 工具时间线（tools[]）：白名单五字段 + 截断
function sanitizeToolRows(tools) {
  if (!Array.isArray(tools)) return null;
  const str = (v, n) => {
    if (v == null) return undefined;
    const cps = Array.from(String(v));
    return (cps.length <= n ? String(v) : cps.slice(0, n).join('')) || undefined;
  };
  const STATES = new Set(['ok', 'running', 'error', 'failed']);
  return tools.slice(0, 24).map((t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    const st = String(t.status || 'ok').toLowerCase();
    const out = {
      name: str(t.name, 80) ?? '',
      status: STATES.has(st) ? st : 'ok',
      at: Number.isFinite(Number(t.at)) ? Number(t.at) : 0,
    };
    const id = str(t.id, 128);
    if (id) out.id = id;
    const target = str(t.target, 200);
    if (target) out.target = target;
    return out;
  }).filter(Boolean);
}

/**
 * 校验并裁剪 spoke 投稿体。超限 / 非对象 → 抛 { status, code, message }。
 * rich（大屏监控档，32KB）只影响投稿缓存上限；电视出口仍会被 fit 到 6KB。
 * @returns {{ frame: object, deviceId: string }}
 */
export function sanitizeSpokeOpenCodePayload(input, { deviceIdFallback = 'spoke', rich = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const e = new Error('opencode 投稿体须为 JSON 对象');
    e.status = 400; e.code = 'bad_request';
    throw e;
  }
  let deviceId = String(input.deviceId || deviceIdFallback || 'spoke').trim() || 'spoke';
  if (!DEVICE_ID_RE.test(deviceId)) {
    const e = new Error('deviceId 非法');
    e.status = 400; e.code = 'bad_request';
    throw e;
  }
  const maxBytes = rich ? OPENCODE_RICH_MAX_BYTES : OPENCODE_MAX_BYTES;
  const maxSessions = rich ? 8 : 3;
  const cleaned = stripIngressMeta(input);
  // 强制 online 布尔；status 白名单
  cleaned.online = cleaned.online !== false;
  cleaned.demo = cleaned.demo === true;
  const st = String(cleaned.status || 'idle').toLowerCase();
  cleaned.status = STATUSES.has(st) ? st : 'idle';
  if (!Number.isFinite(Number(cleaned.now))) cleaned.now = Date.now();
  else cleaned.now = Number(cleaned.now);
  // 文本字段截断（与 buildOpenCodeSnapshot 的 title 160 上限同档）
  for (const [k, n] of [['title', 160], ['step', 160]]) {
    if (cleaned[k] != null) {
      const cps = Array.from(String(cleaned[k]));
      cleaned[k] = cps.length <= n ? String(cleaned[k]) : cps.slice(0, n).join('');
    }
  }
  // 数值字段强制数值；上限封顶（防伪数/天文数字进电视 UI）
  for (const k of ['elapsedMs', 'tokens', 'stepIndex', 'stepTotal']) {
    if (cleaned[k] != null) {
      const n = Number(cleaned[k]);
      cleaned[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    }
  }
  if (cleaned.progress != null) {
    const n = Number(cleaned.progress);
    cleaned.progress = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;
    if (cleaned.progress === undefined) delete cleaned.progress;
  }
  // session / plan / tools 是嵌套结构：顶层白名单管不住，逐个白名单 + 截断
  // （投稿端是别的机器，不信任形状）
  if (cleaned.session != null) {
    const s = sanitizeSessionMeta(cleaned.session);
    if (s) cleaned.session = s; else delete cleaned.session;
  }
  if (cleaned.plan != null) {
    const p = sanitizePlanTasks(cleaned.plan);
    if (p && p.tasks.length) cleaned.plan = p; else delete cleaned.plan;
  }
  if (cleaned.tools != null) {
    const t = sanitizeToolRows(cleaned.tools);
    if (t && t.length) cleaned.tools = t; else delete cleaned.tools;
  }
  // sessions 小卡数据：只收数组，每行只留白名单字段（投稿端是别的机器，不信任形状）
  if (cleaned.sessions != null) {
    cleaned.sessions = Array.isArray(cleaned.sessions)
      ? cleaned.sessions.slice(0, maxSessions).map(sanitizeSessionBrief).filter(Boolean)
      : [];
    if (!cleaned.sessions.length) delete cleaned.sessions;
  }
  if (!rich) {
    const fitted = fitOpenCodeToLimit(cleaned);
    const bytes = Buffer.byteLength(JSON.stringify(fitted));
    if (bytes > OPENCODE_MAX_BYTES) {
      const e = new Error(`opencode 帧超过 ${OPENCODE_MAX_BYTES} 字节`);
      e.status = 413; e.code = 'body_too_large';
      throw e;
    }
    return { frame: fitted, deviceId };
  }
  // rich：不跑 6KB 逐级裁剪，只做硬上限兜底（tools → sessions 截断）
  let frame = cleaned;
  const bytesOf = () => Buffer.byteLength(JSON.stringify(frame));
  if (bytesOf() > maxBytes) {
    frame = { ...cleaned, tools: Array.isArray(cleaned.tools) ? cleaned.tools.slice(0, 12) : cleaned.tools };
  }
  if (bytesOf() > maxBytes) {
    frame = { ...frame, tools: Array.isArray(frame.tools) ? frame.tools.slice(0, 6) : frame.tools,
      sessions: Array.isArray(frame.sessions) ? frame.sessions.slice(0, 3) : frame.sessions };
  }
  if (bytesOf() > maxBytes) {
    const e = new Error(`opencode 帧超过 ${maxBytes} 字节`);
    e.status = 413; e.code = 'body_too_large';
    throw e;
  }
  return { frame, deviceId };
}

export function putSpokeOpenCodeFrame(deviceId, frame, { receivedAt = Date.now(), tokenName = null } = {}) {
  const id = String(deviceId || '').trim();
  if (!DEVICE_ID_RE.test(id)) return false;
  const at = Number(receivedAt) || Date.now();
  const owner = tokenName ? String(tokenName).slice(0, 40) : null;
  // 顺手淘汰：僵尸帧（远超 stale 窗口）与超出上限的最旧设备。此前只增不删，
  // 换着 deviceId 投稿可让 Map 无界增长（每条 ≤32KB rich 帧）
  for (const [k, row] of spokeFrames) {
    if (at - (row.receivedAt || 0) > SPOKE_EVICT_MS) spokeFrames.delete(k);
  }
  // 归属检查：deviceId 一经某 token 认领，别的 token 冒名投稿一律拒（409）——
  // 否则持任一合法 token 的机器可指定别人 deviceId 顶掉其帧。帧淘汰时归属一并
  // 失效（设备长期沉默后允许重新认领）；未带 token 名的内部调用不检查
  if (owner) {
    const claimed = spokeOwners.get(id);
    if (claimed && claimed !== owner) return 'conflict';
  }
  while (spokeFrames.size >= SPOKE_MAX_DEVICES && !spokeFrames.has(id)) {
    let oldest = null;
    for (const [k, row] of spokeFrames) {
      if (!oldest || (row.receivedAt || 0) < oldest.at) oldest = { k, at: row.receivedAt || 0 };
    }
    if (!oldest) break;
    spokeFrames.delete(oldest.k);
    spokeOwners.delete(oldest.k);
  }
  spokeFrames.set(id, {
    frame: stripIngressMeta(frame) || { online: true, status: 'idle', now: at },
    receivedAt: at,
    tokenName: owner,
  });
  if (owner) spokeOwners.set(id, owner);
  return true;
}

export function getSpokeOpenCodeFrame(deviceId) {
  return spokeFrames.get(String(deviceId || '')) || null;
}

export function listSpokeOpenCodeFrames({ now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const out = [];
  for (const [id, row] of spokeFrames.entries()) {
    const ageMs = Math.max(0, now - (row.receivedAt || 0));
    // 读路径同样淘汰僵尸：写路径的清理只在有新投稿时触发，一台设备投过一次后
    // 永久停投会在管理台列表里留一行永远 stale 的陈旧条目
    if (ageMs > SPOKE_EVICT_MS) {
      spokeFrames.delete(id);
      spokeOwners.delete(id);
      continue;
    }
    out.push({
      deviceId: id,
      receivedAt: row.receivedAt,
      ageMs,
      stale: ageMs > staleMs,
      status: row.frame?.status || 'idle',
      online: row.frame?.online !== false,
      title: row.frame?.title || null,
      tokenName: row.tokenName,
    });
  }
  out.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  return out;
}

export function clearSpokeOpenCodeFrames() {
  spokeFrames.clear();
  spokeOwners.clear();
}

function annotate(frame, source) {
  const out = { ...(frame && typeof frame === 'object' ? frame : { online: true, status: 'idle' }) };
  out.source = source;
  return out;
}

function localSource() {
  return { kind: 'local', host: localHostLabel() };
}

function spokeSource(deviceId) {
  return { kind: 'spoke', id: String(deviceId), host: String(deviceId) };
}

function freshSpoke(deviceId, { now, staleMs }) {
  const row = spokeFrames.get(deviceId);
  if (!row) return null;
  if (now - (row.receivedAt || 0) > staleMs) return null;
  return row;
}

/**
 * 选定一帧并盖 source。localFrame 是本机 opencodeSnapshotNow() 结果。
 */
export function resolveOpenCodeForTv({
  opencodeSource = 'local',
  localFrame,
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  const parsed = parseOpenCodeSource(opencodeSource);
  const local = localFrame && typeof localFrame === 'object'
    ? stripIngressMeta(localFrame)
    : { now, online: true, status: 'idle' };

  if (parsed.mode === 'spoke') {
    const row = freshSpoke(parsed.deviceId, { now, staleMs });
    if (row) return annotate(row.frame, spokeSource(parsed.deviceId));
    return annotate(local, localSource()); // 过期回落，source 诚实标 local
  }

  if (parsed.mode === 'auto') {
    let best = null;
    for (const [id, row] of spokeFrames.entries()) {
      if (now - (row.receivedAt || 0) > staleMs) continue;
      if (String(row.frame?.status || '') !== 'running') continue;
      if (!best || row.receivedAt > best.receivedAt) best = { id, row };
    }
    if (best) return annotate(best.row.frame, spokeSource(best.id));
    return annotate(local, localSource());
  }

  return annotate(local, localSource());
}

export const OPENCODE_SPOKE_DEFAULT_STALE_MS = DEFAULT_STALE_MS;
