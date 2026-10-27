// Claude Code 源适配器：~/.claude/projects/<路径编码目录>/<sessionId>.jsonl。
// 只读顶层 *.jsonl（不递归）——子代理 transcript 在 <sessionId>/subagents/ 下，天然排除。
//
// 行判别式（版本 2.1.x 实测）：
//   真人输入  type=user 且 message.content 为字符串且 promptSource=='typed' 且 !isMeta
//             （斜杠命令回显同为字符串但没有 promptSource；content 为数组的是 tool_result；
//              isMeta 行是 skill/提醒等注入上下文）
//   assistant type=assistant 取 content[].type=='text' 的 .text（thinking 块体积是正文的
//             ~16 倍，必须排除；tool_use 块不进素材）
//   标题      最后一条 ai-title 行（本版本无 summary 行）
//   项目路径  行内 cwd 字段（目录名编码有损——orca 沙箱特殊字符被压成连杠，不能反推）
//   时间      timestamp 为 ISO 8601 UTC；跨天会话存在，必须按行级过滤，不能信文件 mtime
// 逐行 parse 容错：活跃会话正在追加，尾部可能有半截 JSON。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function rootDir() {
  return process.env.CANNBOT_CC_DIR || path.join(os.homedir(), '.claude/projects');
}

// 单文件解析：返回 session 或 null（窗口内无有效消息 / 文件不可读）
function parseSessionFile(file, startMs, endMs) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const msgs = [];
  let title = '';
  let cwd = '';
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let j;
    try { j = JSON.parse(t); } catch { continue; } // 坏行/半截 JSON：跳过不崩
    if (!j || typeof j !== 'object' || j.isSidechain) continue; // 防御：主会话文件本不该有
    if (j.type === 'ai-title' && j.aiTitle) { title = String(j.aiTitle); continue; }
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    const ts = Date.parse(j.timestamp || '');
    if (!Number.isFinite(ts)) continue; // mode/last-prompt 等行无时间戳
    if (ts < startMs || ts >= endMs) continue;
    if (typeof j.cwd === 'string' && j.cwd) cwd = j.cwd;
    const content = j.message?.content;
    if (j.type === 'user') {
      if (typeof content !== 'string' || j.promptSource !== 'typed' || j.isMeta) continue;
      msgs.push({ role: 'user', time: ts, text: content });
    } else {
      if (!Array.isArray(content)) continue;
      const texts = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
      if (!texts.length) continue; // 纯 thinking / tool_use 行
      msgs.push({ role: 'assistant', time: ts, text: texts.join('\n') });
    }
  }
  if (!msgs.length) return null;
  return {
    source: 'claude-code',
    sessionId: path.basename(file, '.jsonl'),
    project: cwd,
    title,
    startTime: msgs[0].time,
    endTime: msgs[msgs.length - 1].time,
    messages: msgs,
  };
}

export async function listSessions({ startMs, endMs }) {
  const root = rootDir();
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    throw new Error(`Claude Code 记录目录不可读: ${e.message}`);
  }
  const out = [];
  for (const d of projectDirs) {
    let files;
    try {
      files = fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith('.jsonl')); // 只顶层，排除子代理
    } catch { continue; }
    for (const f of files) {
      const session = parseSessionFile(path.join(root, d.name, f), startMs, endMs);
      if (session) out.push(session);
    }
  }
  return out;
}
