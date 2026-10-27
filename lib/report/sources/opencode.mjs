// opencode 源适配器：单文件 SQLite（~/.local/share/opencode/opencode.db，drizzle schema）。
// 会话正文拆在 message + part 两表：message.data 是 JSON 元数据（含 role；user 首条
// 消息的 data 里内嵌数十 KB system prompt——只 json_extract 需要的字段），part.data
// 是内容块（type=text 的正文在 $.text；part.id 是 ULID，字典序=创建序）。
//
// 双路查询（缺一不可）：session 表只剩未删会话，被删会话（约九成历史）只存活在
// event 事件溯源表——part 事件是全量快照非增量（流式期间每个 part 产生
// pending→completed 多条），必须按 part.id 取 seq 最大的最终态，否则中间态重复拼接。
// 补路只补 session 表里不存在的会话 id，live 会话以主路为准。
//
// 注意：Apple 定制 sqlite3 3.54 不支持 GROUP_CONCAT(x ORDER BY y)——拼装全部在 JS 侧。
// 同目录的 auth.json / session.json 是凭证文件，本适配器只访问 db 本身。
import os from 'node:os';
import path from 'node:path';
import { querySqlite } from '../sqlite.mjs';
import { LIMITS } from '../../report-prompts.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // db 内 id 白名单（CLI 无参数绑定）
const num = (n) => Math.trunc(Number(n));
// OpsTeam 多 agent 插件注入的合成 user 提示（非真人输入）
const SYNTHETIC_RE = /^你是多\s*agent/;

function dbPath() {
  return process.env.CANNBOT_OPENCODE_DB || path.join(os.homedir(), '.local/share/opencode/opencode.db');
}

function cut(s, max) {
  const cps = Array.from(String(s ?? ''));
  return cps.length <= max ? cps.join('') : cps.slice(0, max).join('') + '…';
}

// 一条消息的 parts → 文本数组（text 正文 + tool 摘要行）
function partsToTexts(parts) {
  const texts = [];
  for (const p of parts) {
    if (p.ptype === 'text' && p.text) {
      texts.push(String(p.text));
    } else if (p.ptype === 'tool' && p.tool) {
      const args = typeof p.tool_input === 'string' ? p.tool_input : JSON.stringify(p.tool_input ?? '');
      texts.push(`[${p.tool}] ${cut(args, LIMITS.toolArgsChars)}`);
    }
  }
  return texts;
}

export async function listSessions({ startMs, endMs }) {
  const s = num(startMs);
  const e = num(endMs);
  const db = dbPath();
  const out = [];

  // ── 主路：session JOIN message JOIN part（live 会话；按 message.time_created 滤窗口）──
  const liveRows = await querySqlite(db, `
    SELECT s.id AS sid, m.id AS mid,
           json_extract(m.data,'$.role') AS role, m.time_created AS time_created
    FROM session s JOIN message m ON m.session_id = s.id
    WHERE m.time_created >= ${s} AND m.time_created < ${e}
    ORDER BY m.time_created, m.id`);
  const bySession = new Map(); // sid -> msgs[]
  for (const r of liveRows) {
    if (typeof r.mid !== 'string' || !ID_RE.test(r.mid) || typeof r.sid !== 'string' || !ID_RE.test(r.sid)) continue;
    const parts = await querySqlite(db, `
      SELECT json_extract(data,'$.type') AS ptype, json_extract(data,'$.text') AS text,
             json_extract(data,'$.tool') AS tool, json_extract(data,'$.state.input') AS tool_input
      FROM part WHERE message_id = '${r.mid}' ORDER BY id`);
    const texts = partsToTexts(parts);
    if (!texts.length) continue;
    const text = texts.join('\n');
    if (r.role === 'user' && SYNTHETIC_RE.test(text)) continue; // 合成注入
    if (!bySession.has(r.sid)) bySession.set(r.sid, []);
    bySession.get(r.sid).push({ role: r.role === 'user' ? 'user' : 'assistant', time: r.time_created, text });
  }
  for (const [sid, msgs] of bySession) {
    if (!msgs.length) continue;
    const srow = await querySqlite(db, `SELECT directory, title FROM session WHERE id = '${sid}' LIMIT 1`);
    out.push({
      source: 'opencode',
      sessionId: sid,
      project: srow[0]?.directory ? String(srow[0].directory) : '',
      title: srow[0]?.title ? String(srow[0].title) : '',
      startTime: msgs[0].time,
      endTime: msgs[msgs.length - 1].time,
      messages: msgs,
    });
  }

  // ── 补路：event 事件溯源（session 表里不存在的会话）──
  const sessionIds = new Set((await querySqlite(db, `SELECT id FROM session`)).map((r) => r.id));
  const eventSids = await querySqlite(db, `SELECT DISTINCT aggregate_id AS sid FROM event WHERE type = 'session.created.1'`);
  for (const { sid } of eventSids) {
    if (typeof sid !== 'string' || !ID_RE.test(sid) || sessionIds.has(sid)) continue;
    const meta = await querySqlite(db, `
      SELECT json_extract(data,'$.info.directory') AS directory, json_extract(data,'$.info.title') AS title
      FROM event WHERE aggregate_id = '${sid}' AND type IN ('session.created.1','session.updated.1')
      ORDER BY seq DESC LIMIT 1`);
    // 消息最终态（按 $.info.id 取 seq 最大；时间埋在 $.info.time.created，毫秒）
    const msgRows = await querySqlite(db, `
      SELECT info_id, role, time_created FROM (
        SELECT json_extract(data,'$.info.id') AS info_id,
               json_extract(data,'$.info.role') AS role,
               json_extract(data,'$.info.time.created') AS time_created,
               ROW_NUMBER() OVER (PARTITION BY json_extract(data,'$.info.id') ORDER BY seq DESC) AS rn
        FROM event WHERE aggregate_id = '${sid}' AND type = 'message.updated.1'
      ) WHERE rn = 1 AND time_created >= ${s} AND time_created < ${e} ORDER BY time_created`);
    if (!msgRows.length) continue;
    // part 最终态（按 $.part.id 取 seq 最大——全量快照，不取最后一条会把流式中间态重复拼入）
    const partRows = await querySqlite(db, `
      SELECT part_id, message_id, ptype, text FROM (
        SELECT json_extract(data,'$.part.id') AS part_id,
               json_extract(data,'$.part.messageID') AS message_id,
               json_extract(data,'$.part.type') AS ptype,
               json_extract(data,'$.part.text') AS text,
               json_extract(data,'$.part.tool') AS tool,
               json_extract(data,'$.part.state.input') AS tool_input,
               ROW_NUMBER() OVER (PARTITION BY json_extract(data,'$.part.id') ORDER BY seq DESC) AS rn
        FROM event WHERE aggregate_id = '${sid}' AND type = 'message.part.updated.1'
      ) WHERE rn = 1`);
    const partsByMsg = new Map();
    for (const p of partRows) {
      if (typeof p.message_id !== 'string') continue;
      if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
      partsByMsg.get(p.message_id).push(p);
    }
    const msgs = [];
    for (const m of msgRows) {
      const parts = (partsByMsg.get(m.info_id) ?? []).sort((a, b) => String(a.part_id).localeCompare(String(b.part_id)));
      const texts = partsToTexts(parts);
      if (!texts.length) continue;
      const text = texts.join('\n');
      if (m.role === 'user' && SYNTHETIC_RE.test(text)) continue;
      msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', time: m.time_created, text });
    }
    if (!msgs.length) continue;
    out.push({
      source: 'opencode',
      sessionId: sid,
      project: meta[0]?.directory ? String(meta[0].directory) : '',
      title: meta[0]?.title ? String(meta[0].title) : '',
      startTime: msgs[0].time,
      endTime: msgs[msgs.length - 1].time,
      messages: msgs,
    });
  }
  return out;
}
