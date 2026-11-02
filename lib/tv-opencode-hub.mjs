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

/** @type {Map<string, { frame: object, receivedAt: number, tokenName: string|null }>} */
const spokeFrames = new Map();

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

function stripIngressMeta(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const out = { ...frame };
  delete out.source;
  delete out.deviceId;
  delete out.host;
  delete out.spokeId;
  return out;
}

function sanitizeSessionBrief(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const str = (v, n) => (v == null ? undefined : String(v).slice(0, n) || undefined);
  const st = String(r.status || 'idle').toLowerCase();
  const out = { status: STATUSES.has(st) ? st : 'idle', at: Number.isFinite(Number(r.at)) ? Number(r.at) : 0 };
  const id = str(r.id, 128); if (id) out.id = id;
  const title = str(r.title, 60); if (title) out.title = title;
  const project = str(r.project, 40); if (project) out.project = project;
  const step = str(r.step, 60); if (step) out.step = step;
  return out;
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
  spokeFrames.set(id, {
    frame: stripIngressMeta(frame) || { online: true, status: 'idle', now: receivedAt },
    receivedAt: Number(receivedAt) || Date.now(),
    tokenName: tokenName ? String(tokenName).slice(0, 40) : null,
  });
  return true;
}

export function getSpokeOpenCodeFrame(deviceId) {
  return spokeFrames.get(String(deviceId || '')) || null;
}

export function listSpokeOpenCodeFrames({ now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const out = [];
  for (const [id, row] of spokeFrames.entries()) {
    const ageMs = Math.max(0, now - (row.receivedAt || 0));
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
