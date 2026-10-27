// Cursor 源适配器：~/.cursor/projects/<项目编码目录>/agent-transcripts/<uuid>/<uuid>.jsonl
// 只读这个精确路径模式（浅层）——<uuid>/subagents/ 是子代理记录，与 Claude Code 同理排除；
// 无 agent-transcripts 子目录的顶层目录（纯数字时间戳、empty-window 等）自然跳过。
//
// 行格式：{"role":"user"|"assistant","message":{"content":[{"type":"text","text":…}]}}。
// 时间归因（实测确认，builder check 定案）：
//   - 仅 user 行 text 内嵌 <timestamp>Monday, Oct 26, 2026, 7:24 PM (UTC+8)</timestamp>
//     且不全；assistant 行（多数素材）完全无时间字段
//   - 会话选中 = 任一标签落在窗口，或文件 mtime 落在窗口（新近写入信号）
//   - 锚点 = 最后一个窗口内标签行，保留锚点到会话尾（assistant 回复紧跟其后产生）
//   - 无窗口内标签但会话被选中（靠 mtime）→ 整会话保留并标 tailOnly:true
//     （collect 层据此从尾往前截断——最近的内容最可能是窗口内工作）
//   - 无标签行的行时间沿用最近一次标签时间，从无标签则用文件 mtime
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TAG_RE = /<timestamp>([^<]+)<\/timestamp>/;
// 尾部时区标注：(UTC+8) / (UTC-5:30)
const ZONE_RE = /\s*\(UTC([+-])(\d{1,2})(?::(\d{2}))?\)\s*$/;

function rootDir() {
  return process.env.CANNBOT_CURSOR_DIR || path.join(os.homedir(), '.cursor/projects');
}

// 解析 Cursor 内嵌时间戳 → epoch ms。带时区标注：按 UTC 解析再减偏移（UTC+8 的
// 19:24 本地 = 11:24 UTC）；无标注：按本机时区。解析失败返回 null。
function parseTagTime(str) {
  const m = TAG_RE.exec(str);
  if (!m) return null;
  let base = m[1].trim();
  const zm = ZONE_RE.exec(base);
  let offsetMs = null;
  if (zm) {
    base = base.slice(0, zm.index).trim();
    const sign = zm[1] === '-' ? -1 : 1;
    offsetMs = sign * (Number(zm[2]) * 3600_000 + Number(zm[3] ?? 0) * 60_000);
  }
  let ts = zm ? Date.parse(`${base} UTC`) : Date.parse(base);
  if (!Number.isFinite(ts)) return null;
  if (offsetMs != null) ts -= offsetMs;
  return ts;
}

// 单 transcript 解析：返回 session（含 tailOnly 标记）或 null
function parseSessionFile(file, startMs, endMs) {
  let raw;
  let st;
  try {
    raw = fs.readFileSync(file, 'utf8');
    st = fs.statSync(file);
  } catch { return null; } // 该 uuid 目录下无同名 jsonl（空 transcript）
  const mtime = Math.trunc(st.mtimeMs);
  const lines = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const content = j.message?.content;
    const blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    if (!text) continue; // 其他 content 块类型不进素材
    lines.push({
      role: j.role === 'user' ? 'user' : 'assistant',
      text: text.replace(TAG_RE, '').trim(), // 时间戳标签剥掉，正文留给素材
      tagTime: parseTagTime(text),
    });
  }
  if (!lines.length) return null;
  const tagTimes = lines.map((l) => l.tagTime).filter((t) => t != null);
  const inWinTag = tagTimes.some((t) => t >= startMs && t < endMs);
  const mtimeInWin = mtime >= startMs && mtime < endMs;
  if (!inWinTag && !mtimeInWin) return null; // 与窗口无重叠
  // 锚点 = 最后一个窗口内标签行；找不到（靠 mtime 选中的会话）→ 整会话保留
  let anchorIdx = 0;
  if (inWinTag) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].tagTime != null && lines[i].tagTime >= startMs && lines[i].tagTime < endMs) anchorIdx = i;
    }
  }
  const msgs = [];
  let lastTime = null;
  for (const l of lines.slice(anchorIdx)) {
    if (l.tagTime != null) lastTime = l.tagTime;
    if (!l.text) continue;
    msgs.push({ role: l.role, time: lastTime ?? mtime, text: l.text });
  }
  if (!msgs.length) return null;
  return {
    source: 'cursor',
    sessionId: path.basename(file, '.jsonl'),
    project: '',
    title: '',
    startTime: msgs[0].time,
    endTime: msgs[msgs.length - 1].time,
    messages: msgs,
    tailOnly: !inWinTag,
  };
}

export async function listSessions({ startMs, endMs }) {
  const root = rootDir();
  let projDirs;
  try {
    projDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    throw new Error(`Cursor 记录目录不可读: ${e.message}`);
  }
  const out = [];
  for (const pd of projDirs) {
    const atDir = path.join(root, pd.name, 'agent-transcripts');
    let uuidDirs;
    try {
      uuidDirs = fs.readdirSync(atDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch { continue; }
    for (const ud of uuidDirs) {
      const session = parseSessionFile(path.join(atDir, ud.name, `${ud.name}.jsonl`), startMs, endMs);
      if (!session) continue;
      // 项目路径由目录名还原（Users-x-proj → /Users/x/proj；与 Claude Code 不同，这里编码可逆）
      session.project = `/${pd.name.replace(/-/g, '/')}`;
      out.push(session);
    }
  }
  return out;
}
