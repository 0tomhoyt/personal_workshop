// 报告生成：collect 素材 → 逐项目一级总结（并发，失败重试一次）→ 二级汇总成稿 →
// reports.json 原子存档（上限 200 份）。同进程内单任务串行（在跑时再启动 → 409）。
//
// 模型解析兜底链（目标：升级后不配置也能点出第一份报告）：
//   ① workbench.reportModel → resolveModelRoute（享受别名 / 显式 pid/model 机制）
//   ② provider = workbench.reportProvider || defaultProvider；
//      model = 静态 models.list 第一个；api source 则拉聚合目录取该 provider 第一个
//   ③ 仍失败 → job failed，error 指引配置 workbench 节
//
// 上游调用复用 requestUpstream（内部直连，不走 HTTP 自环；不经代理管道，不进 stats——
// 保持 stats「真实外部流量」口径纯净）。按 provider.protocol 分支组包：anthropic 上游
// 走 /v1/messages 且 max_tokens 必填；openai 走 /v1/chat/completions。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError, randHex, readBodyLimited } from '../util.mjs';
import { log } from '../log.mjs';
import { getConfig, getProvider } from '../config.mjs';
import { resolveModelRoute, defaultProvider, listModels } from '../models.mjs';
import { requestUpstream } from '../upstream.mjs';
import { PROMPTS } from '../report-prompts.mjs';
import { collectMaterials } from './collect.mjs';

// 注意目录深度：本文件在 lib/report/ 下，要回到服务根需三层 dirname
// （todos/stats 在 lib/ 顶层两层即可——曾因少算一层把存档落进 lib/ 子目录，
//  且会被 install.sh 的 cp -R lib/. 用调试存档覆盖运行时真实报告）
const SCRIPT_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const REPORTS_FILE = process.env.CANNBOT_REPORTS_FILE || path.join(SCRIPT_DIR, 'reports.json');
const REPORTS_CAP = 200; // 存档上限，超出删最旧
const MAX_WINDOW_MS = 92 * 24 * 3600_000; // 时间窗上限：约一个季度
const UPSTREAM_TIMEOUT_MS = 120_000; // 只约束「发请求 → 收到响应头」
const RESPONSE_LIMIT = 512 * 1024; // 单次总结响应体上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p2 = (n) => String(n).padStart(2, '0');
const fmtTime = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

// ── 报告存档 ────────────────────────────────────────────────────────────────
let reports = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.reports)) return { version: 1, reports: raw.reports };
  } catch (e) {
    if (e.code !== 'ENOENT') log(`reports.json 读取失败，按空存档起步: ${e.message}`);
  }
  return { version: 1, reports: [] };
})();

function persistReports() {
  const tmpF = `${REPORTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpF, JSON.stringify(reports, null, 2));
  fs.chmodSync(tmpF, 0o600);
  fs.renameSync(tmpF, REPORTS_FILE);
}

function appendReport(report) {
  reports.reports.push(report);
  reports.reports.sort((a, b) => a.generated_at - b.generated_at);
  while (reports.reports.length > REPORTS_CAP) reports.reports.shift();
  persistReports();
}

export function listReports() {
  // 元数据列表（不带 report 正文，省流量；正文走 GET /:id）
  return reports.reports.map(({ id, range, generated_at, model, provider, materials }) => ({
    id, range, generated_at, model, provider, materials,
  }));
}

export function getReport(id) {
  const r = reports.reports.find((x) => x.id === id);
  if (!r) throw httpError(404, `报告 ${id} 不存在`, 'not_found');
  return r;
}

export function deleteReport(id) {
  const idx = reports.reports.findIndex((x) => x.id === id);
  if (idx < 0) throw httpError(404, `报告 ${id} 不存在`, 'not_found');
  reports.reports.splice(idx, 1);
  persistReports();
}

// ── 模型解析兜底链 ──────────────────────────────────────────────────────────
async function resolveReportModel() {
  const cfg = getConfig();
  const wb = cfg.workbench ?? {};
  if (wb.reportModel) {
    const r = await resolveModelRoute(wb.reportModel);
    if (r) return r;
  }
  const pid = wb.reportProvider || cfg.routing?.defaultProvider;
  const provider = pid ? getProvider(pid) : null;
  if (!provider) return null;
  if (provider.models.source === 'static' && provider.models.list.length) {
    // models.list 同时支持对象与纯字符串条目（与 lib/models.mjs staticModels 同口径）
    const first = provider.models.list[0];
    return { provider, model: typeof first === 'string' ? first : first.id };
  }
  // api source：拉聚合目录取该 provider 第一个（目录 id 有 pid/ 消歧前缀时剥掉）
  try {
    const catalog = await listModels();
    const hit = (catalog.data ?? []).find((m) => m.owned_by === pid);
    if (hit) {
      const model = hit.id.startsWith(`${pid}/`) ? hit.id.slice(pid.length + 1) : hit.id;
      return { provider, model };
    }
  } catch { /* 目录拉取失败 → 继续走失败路径 */ }
  return null;
}

// ── 上游调用（按协议分支）───────────────────────────────────────────────────
async function callSummaryModel(route, system, user) {
  const { provider, model } = route;
  const isAnthropic = provider.protocol === 'anthropic';
  const body = isAnthropic
    ? { model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }
    : { model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const up = await requestUpstream(provider, isAnthropic ? '/v1/messages' : '/v1/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: UPSTREAM_TIMEOUT_MS,
  });
  if (!up.ok) {
    // 错误体同样有界读（其余上游读回全走 readBodyLimited，这里保持同一纪律）
    let detail = '';
    try { detail = (await readBodyLimited(up, 64 * 1024)).toString('utf8'); } catch {}
    throw new Error(`上游 ${provider.id} 返回 ${up.status}: ${detail.slice(0, 150)}`);
  }
  const buf = await readBodyLimited(up, RESPONSE_LIMIT);
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`上游 ${provider.id} 响应不是合法 JSON`); }
  if (isAnthropic) {
    const text = (j.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    if (!text) throw new Error(`上游 ${provider.id} 响应无文本内容`);
    return text;
  }
  const text = j.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) throw new Error(`上游 ${provider.id} 响应无文本内容`);
  return text;
}

// 一级总结失败重试一次；二级失败则整个任务失败
async function withRetry(fn) {
  try { return await fn(); }
  catch { await sleep(300); return await fn(); }
}

// ── 任务状态机（模块级单任务）───────────────────────────────────────────────
let job = null; // { id, state, progress, error, reportId, startMs, endMs, startedAt }

export function getReportJob() {
  if (!job) return { state: 'idle' };
  return {
    state: job.state,
    progress: job.progress,
    error: job.error ?? null,
    reportId: job.reportId ?? null,
    startMs: job.startMs,
    endMs: job.endMs,
  };
}

export function startReportJob({ startMs, endMs }) {
  const s = Number(startMs);
  const e = Number(endMs);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
    throw httpError(400, '时间窗非法：start/end 需为 epoch 毫秒且 end > start', 'bad_window');
  }
  if (e - s > MAX_WINDOW_MS) throw httpError(400, `时间窗过长（上限 ${MAX_WINDOW_MS / 24 / 3600_000} 天）`, 'bad_window');
  if (job && job.state === 'running') {
    throw httpError(409, '已有报告生成任务在进行中，请稍后再试', 'job_busy');
  }
  job = {
    id: `r${randHex(5)}`,
    state: 'running',
    progress: { phase: 'collect', projectsDone: 0, projectsTotal: 0 },
    startMs: s, endMs: e, startedAt: Date.now(),
  };
  // 同步置 running 后再异步执行：POST 返回的瞬间状态可见（409 判定稳定）
  runJob(job).catch((e2) => log(`报告任务异常逃逸: ${e2.message}`));
  return { jobId: job.id };
}

async function runJob(j) {
  try {
    const route = await resolveReportModel();
    if (!route) {
      throw new Error('未找到可用的报告生成模型：请在 providers.json 的 workbench 节配置 reportProvider / reportModel');
    }
    log(`报告任务 ${j.id} 开始：${route.provider.id}/${route.model}，窗口 ${fmtTime(j.startMs)} ~ ${fmtTime(j.endMs)}`);

    // ① 素材收集（单源故障已在 collect 内降级，不令任务失败）
    const m = await collectMaterials({ startMs: j.startMs, endMs: j.endMs });

    // ② 一级：逐项目小结（并发；单项目失败重试一次，仍失败则该级整体失败）
    j.progress = { phase: 'summarize', projectsDone: 0, projectsTotal: m.projects.length };
    const summaries = await Promise.all(m.projects.map(async (p) => {
      const summary = await withRetry(() => callSummaryModel(route, PROMPTS.systemProject, PROMPTS.userProject(p)));
      j.progress.projectsDone++;
      return { name: p.name, summaryText: summary };
    }));

    // ③ 二级：汇总成稿
    j.progress = { phase: 'final', projectsDone: m.projects.length, projectsTotal: m.projects.length };
    const rangeText = `${fmtTime(j.startMs)} ~ ${fmtTime(j.endMs)}`;
    const final = await callSummaryModel(route, PROMPTS.systemFinal, PROMPTS.userFinal({
      rangeText, projects: summaries, todos: m.todos, usage: m.usage, sourcesFailed: m.sourcesFailed,
    }));

    const sessionsTotal = Object.values(m.sources).reduce((a, b) => a + b, 0);
    const report = {
      id: j.id,
      range: { start: j.startMs, end: j.endMs },
      generated_at: Date.now(),
      model: route.model,
      provider: route.provider.id,
      materials: {
        sessions: sessionsTotal,
        projects: m.projects.length,
        chars: m.chars,
        sources: m.sources,
        sourcesFailed: m.sourcesFailed,
      },
      report: final,
    };
    appendReport(report);
    j.state = 'done';
    j.reportId = report.id;
    log(`报告任务 ${j.id} 完成：${m.projects.length} 项目 / ${sessionsTotal} 会话 / ${m.chars} 字素材`);
  } catch (e) {
    j.state = 'failed';
    j.error = String(e.message ?? e).slice(0, 300);
    log(`报告任务 ${j.id} 失败: ${j.error}`);
  }
}
