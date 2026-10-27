// zcode 源适配器：会话正文唯一完整存储在 ~/.zcode/cli/db/db.sqlite
// （rollout jsonl 只保留最近 3 个会话，不能当历史源）。三步还原：
//   ① session 筛目录（interactive / 未软删 / 与窗口重叠）
//   ② message 按窗口过滤 + 真人输入判别（semantics.kind=user_prompt 且 origin=real_user，
//     其余 user 消息是 todo_reminder/system_reminder 等合成注入，占六成以上）
//   ③ part 取正文（type=text → $.text；type=tool → 「[工具名] 参数摘要」行；
//     reasoning / step-* 跳过——thinking 类内容体积是正文十几倍且对汇报无益）
// 时间字段全部是 unix 毫秒整数（与秒混用会查不到任何数据）。
import os from 'node:os';
import path from 'node:path';
import { querySqlite } from '../sqlite.mjs';
import { LIMITS } from '../../report-prompts.mjs';

// db 内部 id 白名单：sqlite3 CLI 无参数绑定，字符串必须过正则才能内联
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const num = (n) => Math.trunc(Number(n)); // 时间参数只允许内联数字

function dbPath() {
  return process.env.CANNBOT_ZCODE_DB || path.join(os.homedir(), '.zcode/cli/db/db.sqlite');
}

// 码位截断（Array.from 按码位拆，emoji 代理对不劈半）
function cut(s, max) {
  const cps = Array.from(String(s ?? ''));
  return cps.length <= max ? cps.join('') : cps.slice(0, max).join('') + '…';
}

export async function listSessions({ startMs, endMs }) {
  const s = num(startMs);
  const e = num(endMs);
  const db = dbPath();
  // ① 会话：task_type='interactive'（一半会话是子代理，会话数虚高一倍且内容重复）
  const sessions = await querySqlite(db, `
    SELECT id, title, directory, time_created FROM session
    WHERE time_updated >= ${s} AND time_created < ${e}
      AND time_deleted IS NULL AND task_type = 'interactive'
    ORDER BY time_created`);
  const out = [];
  for (const row of sessions) {
    if (typeof row.id !== 'string' || !ID_RE.test(row.id)) continue;
    // ② 消息：窗口内 + 真人判别
    const messages = await querySqlite(db, `
      SELECT id, sequence, time_created,
             json_extract(data,'$.role') AS role,
             json_extract(data,'$.semantics.kind') AS kind,
             json_extract(data,'$.semantics.origin') AS origin
      FROM message
      WHERE session_id = '${row.id}' AND time_created >= ${s} AND time_created < ${e}
      ORDER BY sequence`);
    const msgs = [];
    for (const m of messages) {
      if (typeof m.id !== 'string' || !ID_RE.test(m.id)) continue;
      const isUser = m.role === 'user';
      if (isUser && !(m.kind === 'user_prompt' && m.origin === 'real_user')) continue; // 合成注入
      if (!isUser && m.role !== 'assistant') continue;
      // ③ 正文在 part 不在 message（message.data 只有元数据）
      const parts = await querySqlite(db, `
        SELECT sequence, json_extract(data,'$.type') AS ptype,
               json_extract(data,'$.text') AS text,
               json_extract(data,'$.tool') AS tool,
               json_extract(data,'$.state.input') AS tool_input
        FROM part WHERE message_id = '${m.id}' ORDER BY sequence`);
      const texts = [];
      for (const p of parts) {
        if (p.ptype === 'text' && p.text) {
          texts.push(String(p.text));
        } else if (p.ptype === 'tool' && p.tool) {
          const args = typeof p.tool_input === 'string' ? p.tool_input : JSON.stringify(p.tool_input ?? '');
          texts.push(`[${p.tool}] ${cut(args, LIMITS.toolArgsChars)}`);
        }
      }
      if (!texts.length) continue; // 只有 step-start/reasoning 的中断消息：正常现象，跳过
      msgs.push({ role: isUser ? 'user' : 'assistant', time: m.time_created, text: texts.join('\n') });
    }
    if (!msgs.length) continue; // 会话与窗口重叠但窗口内无有效消息 → 不产出
    out.push({
      source: 'zcode',
      sessionId: row.id,
      project: row.directory ? String(row.directory) : '',
      title: row.title ? String(row.title) : '',
      startTime: msgs[0].time,
      endTime: msgs[msgs.length - 1].time,
      messages: msgs,
    });
  }
  return out;
}
