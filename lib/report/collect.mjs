// 素材收集：并发跑 4 个源适配器 → 按项目归并 → 三级压缩 → 脱敏，
// 并附上佐证数据（待办变动 + 网关用量）。任何单源故障只降级不失败
// （sourcesFailed 记原因，最终报告如实标注「源 X 不可用」）。
import path from 'node:path';
import { LIMITS, redact } from '../report-prompts.mjs';
import { todosInWindow } from '../todos.mjs';
import { statsSnapshot } from '../stats.mjs';
import { listSessions as ccSessions } from './sources/claude-code.mjs';
import { listSessions as zcodeSessions } from './sources/zcode.mjs';
import { listSessions as opencodeSessions } from './sources/opencode.mjs';
import { listSessions as cursorSessions } from './sources/cursor.mjs';

const SOURCE_LIST = [
  ['claude-code', ccSessions],
  ['zcode', zcodeSessions],
  ['opencode', opencodeSessions],
  ['cursor', cursorSessions],
];

// 码位截断（Array.from 按码位拆，emoji 代理对不劈半）
function cut(s, max) {
  const cps = Array.from(String(s ?? ''));
  return cps.length <= max ? cps.join('') : cps.slice(0, max).join('') + '…';
}
const cpLen = (s) => Array.from(String(s ?? '')).length;

const p2 = (n) => String(n).padStart(2, '0');
const fmtTime = (ms) => {
  const d = new Date(ms);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

// 单会话压缩：真人输入/助手文本各自截断 + 会话总预算。
// tailOnly 会话（Cursor 无窗口内标签）从尾往前取——最近的内容最可能是窗口内工作。
function compressSession(s) {
  const order = s.tailOnly ? [...s.messages].reverse() : s.messages;
  const out = [];
  let total = 0;
  for (const m of order) {
    const perMsg = m.role === 'user' ? LIMITS.userMsgChars : LIMITS.assistantChars;
    let text = cut(m.text, perMsg);
    const remain = LIMITS.sessionChars - total;
    if (remain <= 0) break; // 预算耗尽：cut(…,0) 会返回孤立「…」伪消息，先短路
    if (cpLen(text) > remain) text = cut(text, remain);
    if (!text) break;
    total += cpLen(text);
    out.push(`[${m.role === 'user' ? '用户' : '助手'}] ${text}`);
    if (total >= LIMITS.sessionChars) break;
  }
  if (s.tailOnly) out.reverse();
  const head = `### ${s.title || '（无标题会话）'} ${fmtTime(s.startTime)}–${fmtTime(s.endTime)}`;
  return `${head}\n${out.join('\n')}`;
}

// 项目短名：路径 basename（/Users/x/proj-a → proj-a）；空路径归「未分类」
function shortName(project) {
  const base = path.basename(String(project || '').replace(/\/+$/, ''));
  return base || '未分类';
}

// 网关用量：stats 按天分桶（只保留近 30 天），取窗口覆盖的本地日聚合。
// 窗口完全早于统计保留期时如实标注 outOfRange。
function collectUsage(startMs, endMs) {
  const dayKeyOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  const startKey = dayKeyOf(startMs);
  const endKey = dayKeyOf(Math.max(startMs, endMs - 1));
  const snap = statsSnapshot();
  const usage = { totalRequests: 0, totalTokens: 0, totalCost: 0, byProvider: {} };
  for (const day of snap.days ?? []) {
    if (day.date < startKey || day.date > endKey) continue;
    const t = day.total ?? {};
    usage.totalRequests += t.req ?? 0;
    usage.totalTokens += (t.tin ?? 0) + (t.tout ?? 0);
    usage.totalCost += t.cost ?? 0;
    for (const [pidModel, b] of Object.entries(day.models ?? {})) {
      const pid = pidModel.split(':')[0];
      const pv = (usage.byProvider[pid] ??= { requests: 0, tokens: 0, cost: 0 });
      pv.requests += b.req ?? 0;
      pv.tokens += (b.tin ?? 0) + (b.tout ?? 0);
      pv.cost += b.cost ?? 0;
    }
  }
  const earliest = (snap.days ?? [])[0]?.date;
  if (earliest && endKey < earliest) usage.outOfRange = true; // 窗口在统计保留期之前
  return usage;
}

export async function collectMaterials({ startMs, endMs }) {
  const sources = Object.fromEntries(SOURCE_LIST.map(([n]) => [n, 0]));
  const sourcesFailed = [];
  const results = await Promise.allSettled(SOURCE_LIST.map(([, fn]) => fn({ startMs, endMs })));
  const sessions = [];
  results.forEach((r, i) => {
    const name = SOURCE_LIST[i][0];
    if (r.status === 'fulfilled') {
      sources[name] = r.value.length;
      sessions.push(...r.value);
    } else {
      sourcesFailed.push(`${name}: ${String(r.reason?.message ?? r.reason).slice(0, 100)}`);
    }
  });

  // 项目归并：短名同名合并；会话按开始时间排序
  const byProject = new Map();
  for (const s of sessions) {
    const name = shortName(s.project);
    if (!byProject.has(name)) byProject.set(name, []);
    byProject.get(name).push(s);
  }

  const projects = [];
  for (const [name, list] of byProject) {
    list.sort((a, b) => a.startTime - b.startTime);
    const kept = list.slice(0, LIMITS.sessionsPerProject);
    const dropped = list.length - kept.length;
    const parts = kept.map(compressSession);
    if (dropped > 0) parts.push(`（另有 ${dropped} 个会话未展开）`);
    projects.push({ name, sessions: list.length, summaryText: redact(parts.join('\n\n')) });
  }
  projects.sort((a, b) => b.sessions - a.sessions); // 会话多的项目排前

  const chars = projects.reduce((n, p) => n + cpLen(p.summaryText), 0);
  return {
    projects,
    sources,
    sourcesFailed,
    chars,
    todos: todosInWindow(startMs, endMs),
    usage: collectUsage(startMs, endMs),
  };
}
