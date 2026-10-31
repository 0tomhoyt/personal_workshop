// 报告生成：collect 素材 → 逐项目一级总结（并发）→ 二级汇总成稿（两级同纪律：
// 失败或空响应自动重试一次）→ reports.json 原子存档（上限 200 份）。
// 同进程内单任务串行（在跑时再启动 → 409）。
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
import { httpError, randHex, readBodyLimited, backupBadFile } from '../util.mjs';
import { log } from '../log.mjs';
import { getConfig, getProvider } from '../config.mjs';
import { resolveModelRoute, defaultProvider, listModels } from '../models.mjs';
import { requestUpstream } from '../upstream.mjs';
import { PROMPTS } from '../report-prompts.mjs';
import { collectMaterials } from './collect.mjs';
import { ATTRIBUTE_PROMPT, userAttribute, parseAttribution, isRemoteTodo } from './attribute.mjs';
import { listTodos } from '../todos.mjs';

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
    log(`reports.json 结构异常，按空存档起步: ${REPORTS_FILE}`);
    backupBadFile(REPORTS_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log(`reports.json 读取失败，按空存档起步: ${e.message}`);
      backupBadFile(REPORTS_FILE);
    }
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
  try {
    persistReports();
  } catch (e) {
    // 落盘失败回滚内存：避免「任务 failed 但报告出现在历史里」的幽灵态
    // （jobs/todos 的先内存后落盘失败只是丢一次写、状态自洽；报告场景任务会转
    //  failed，成品却留在列表里会自相矛盾，且可能被下一个成功任务悄悄持久化）
    reports.reports = reports.reports.filter((r) => r !== report);
    throw e;
  }
}

// materials.todos：三类计数（新增/更新/完成），供汇报页元数据行展示。
// updated 与新增/完成互斥（口径见 lib/todos.mjs todosInWindow 头注释）。
const todoCounts = (todos) => ({
  created: todos?.created?.length ?? 0,
  updated: todos?.updated?.length ?? 0,
  completed: todos?.completed?.length ?? 0,
});

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
// 解析失败的真实原因（目录拉取失败等）留存于此，供 runJob 的失败文案带出——
// 否则「已配置 workbench 但上游目录挂了」会被误报成「请去配置 workbench」。
let lastResolveError = null;

async function resolveReportModel() {
  const cfg = getConfig();
  const wb = cfg.workbench ?? {};
  lastResolveError = null;
  if (wb.reportModel) {
    const r = await resolveModelRoute(wb.reportModel);
    if (r) return r;
  }
  // 显式指定的 reportProvider：找到就尊重（哪怕停用）；配了但不存在 → 直接失败
  // （静默回落会让「配错的 provider」永远不被发现）。兜底路径与代理同语义：
  // defaultProvider() 会跳过停用、回退首个已启用，避免「聊天正常、报告失败」。
  let provider = null;
  if (wb.reportProvider) {
    provider = getProvider(wb.reportProvider);
    // 配了但不存在：写入解析失败原因，否则兜底文案会误导用户去「配置」——其实已配、只是配错
    if (!provider) {
      lastResolveError = `workbench.reportProvider 指向的 provider「${wb.reportProvider}」不存在`;
      return null;
    }
  } else {
    provider = defaultProvider();
  }
  if (!provider) return null;
  const targetPid = provider.id;
  if (provider.models.source === 'static' && provider.models.list.length) {
    // models.list 同时支持对象与纯字符串条目（与 lib/models.mjs staticModels 同口径）
    const first = provider.models.list[0];
    return { provider, model: typeof first === 'string' ? first : first.id };
  }
  // api source：拉聚合目录取该 provider 第一个（目录 id 有 pid/ 消歧前缀时剥掉）
  try {
    const catalog = await listModels();
    const hit = (catalog.data ?? []).find((m) => m.owned_by === targetPid);
    if (hit) {
      const model = hit.id.startsWith(`${targetPid}/`) ? hit.id.slice(targetPid.length + 1) : hit.id;
      return { provider, model };
    }
  } catch (e) {
    lastResolveError = String(e.message ?? e).slice(0, 150);
  }
  return null;
}

// ── 上游调用（按协议分支）───────────────────────────────────────────────────
async function callSummaryModel(route, system, user) {
  const { provider, model } = route;
  const isAnthropic = provider.protocol === 'anthropic';
  const body = isAnthropic
    ? { model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }
    : { model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const up = await (async () => {
    try {
      return await requestUpstream(provider, isAnthropic ? '/v1/messages' : '/v1/chat/completions', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });
    } catch (e) {
      // 超时（等待响应头被 abort）单独成口径：英文 AbortError 文案对用户不可读
      if (e?.name === 'AbortError' || /aborted/i.test(e?.message || ''))
        throw new Error(`上游 ${provider.id} 请求超时（${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s）`);
      // 连接层失败（DNS/拒绝等）：fetch 只给 "fetch failed"，cause 里才有真因
      const cause = e?.cause?.code || e?.cause?.message || '';
      throw new Error(`上游 ${provider.id} 连接失败${cause ? `（${cause}）` : ''}: ${e.message}`);
    }
  })();
  if (!up.ok) {
    // 错误体同样有界读（其余上游读回全走 readBodyLimited，这里保持同一纪律）
    let detail = '';
    try { detail = (await readBodyLimited(up, 64 * 1024)).toString('utf8'); } catch {}
    throw new Error(`上游 ${provider.id} 返回 HTTP ${up.status}: ${detail.slice(0, 150)}`);
  }
  const buf = await readBodyLimited(up, RESPONSE_LIMIT);
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`上游 ${provider.id} 响应不是合法 JSON`); }
  if (isAnthropic) {
    const text = (j.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    if (!text.trim()) throw new Error(`上游 ${provider.id} 响应无文本内容`);
    return text;
  }
  const text = j.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`上游 ${provider.id} 响应无文本内容`);
  return text;
}

// 一级与二级同纪律：失败（含空/纯空白响应）自动重试一次，仍失败才向上抛。
// 重试间隔默认 1.5s（给偶发空响应的上游一点喘息），可经 CANNBOT_REPORT_RETRY_DELAY_MS
// 覆盖（smoke 注入 0 加速）。
const RETRY_DELAY_MS = Math.max(0, Number(process.env.CANNBOT_REPORT_RETRY_DELAY_MS ?? 1500) || 0);
async function withRetry(fn, label = '') {
  try { return await fn(); }
  catch (e1) {
    if (RETRY_DELAY_MS) log(`报告总结调用失败（${String(e1.message ?? e1).slice(0, 120)}）${label ? `［${label}］` : ''}，${RETRY_DELAY_MS}ms 后重试一次`);
    await sleep(RETRY_DELAY_MS);
    return await fn();
  }
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
    startedAt: job.startedAt, // 前端据此显示「已 Ns」——长调用（归属/二级汇总）期间页面要有活的迹象
  };
}

export function startReportJob({ startMs, endMs }) {
  const s = Number(startMs);
  const e = Number(endMs);
  // 与 workbench 前端 isBadReportRange 同口径：早于 2000-01-01 视为非法（防 1970 类脏窗口）
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || s < 946684800000) {
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
    // ① 素材收集（单源故障已在 collect 内降级，不令任务失败）——先收素材再解析模型：
    //    空素材窗口无需模型即可成稿（固定「无记录」文案，不浪费上游调用、也不因未配置模型而失败）
    const m = await collectMaterials({ startMs: j.startMs, endMs: j.endMs });

    const sessionsTotal0 = Object.values(m.sources).reduce((a, b) => a + b, 0);
    // 待办也是第一等素材：窗口内有待办变动（新增/更新/完成任一）时即便会话素材为空
    // 也照常调模型出稿，不走「无记录」固定快径（快径只在会话与待办双双为空时成立）
    const todosEmpty0 = (m.todos?.created?.length ?? 0) === 0
      && (m.todos?.updated?.length ?? 0) === 0
      && (m.todos?.completed?.length ?? 0) === 0;
    if (sessionsTotal0 === 0 && m.chars === 0 && todosEmpty0) {
      const rangeText0 = `${fmtTime(j.startMs)} ~ ${fmtTime(j.endMs)}`;
      // 采集故障 ≠ 没干活：有源失败时不写「无记录」结论，改为如实标注采集失败、结论不可信
      // （与有素材时「失败源进正文附注、任务不 failed」的既有口径一致）
      const failed0 = m.sourcesFailed || [];
      const text0 = failed0.length
        ? `${rangeText0} 素材采集失败（${failed0.join('；')}）：无法确认该时段的工作记录，本结论不可作为汇报依据，请检查对应数据源后重试。`
        : `${rangeText0} 该时段未检索到可用的工作记录（四源会话素材为空），无实质性项目产出可汇报。`;
      const emptyReport = {
        id: j.id,
        range: { start: j.startMs, end: j.endMs },
        generated_at: Date.now(),
        model: 'none',
        provider: 'none',
        materials: { sessions: 0, projects: 0, chars: 0, sources: m.sources, sourcesFailed: m.sourcesFailed, todos: todoCounts(m.todos) },
        report: text0,
      };
      appendReport(emptyReport);
      j.state = 'done';
      j.reportId = emptyReport.id;
      j.progress = { phase: 'final', projectsDone: 0, projectsTotal: 0 };
      log(`报告任务 ${j.id} 完成（空素材窗口，未调模型${failed0.length ? `，${failed0.length} 源采集失败` : ''}）`);
      return;
    }

    const route = await resolveReportModel();
    if (!route) {
      throw new Error(lastResolveError
        ? `未找到可用的报告生成模型（上游目录拉取失败：${lastResolveError}）；可在 providers.json 的 workbench 节显式配置 reportProvider / reportModel`
        : '未找到可用的报告生成模型：请在 providers.json 的 workbench 节配置 reportProvider / reportModel');
    }
    log(`报告任务 ${j.id} 开始：${route.provider.id}/${route.model}，窗口 ${fmtTime(j.startMs)} ~ ${fmtTime(j.endMs)}`);

    // ② 归属：让模型把会话素材对到待办上（不再靠用户手填时段——见 attribute.mjs 头注释）。
    //    归属失败不令任务失败：退化成「全部进其他」，报告仍可成稿，只是正文按项目走。
    //    **远程待办（workbench.remoteProjects 标签）不参与归属**：它们不在本机做，
    //    本机不会有它们的会话，放进候选只会诱导模型错配同名无关会话。
    const allTodos = listTodos();
    const remoteProjects = getConfig().workbench?.remoteProjects ?? [];
    const localTodos = allTodos.filter((t) => !isRemoteTodo(t, remoteProjects));
    j.progress = { phase: 'attribute', projectsDone: 0, projectsTotal: 1 };
    let mapping = [];
    if (m.projects.length && localTodos.length) {
      try {
        const raw = await withRetry(
          () => callSummaryModel(route, ATTRIBUTE_PROMPT, userAttribute({ todos: localTodos, projects: m.projects, remoteProjects })),
          '会话归属');
        mapping = parseAttribution(raw, m.projects, localTodos);
        log(`报告任务 ${j.id}：会话归属 ${mapping.length} 条映射（${mapping.filter((x) => x.other).length} 条归「其他」）`);
      } catch (e) {
        log(`报告任务 ${j.id}：会话归属失败（${String(e.message ?? e).slice(0, 120)}），全部按「其他」处理`);
      }
    }

    // 按归属把项目素材分到各待办；同一项目被拆给多条待办时说明里指明了是哪部分，
    // 但我们拿不到更细的粒度，所以整段素材给每条命中的待办各一份（模型在二级会自己取舍）
    const groupMap = new Map(); // todoId -> { todo, projects: Set, notes: [] }
    for (const p of m.projects) {
      for (const h of mapping.filter((x) => x.project === p.name)) {
        if (h.other) continue; // 「其他」与待办归属分开算，见下面 assignedProjects
        if (!groupMap.has(h.todoId)) {
          groupMap.set(h.todoId, { todo: allTodos.find((t) => t.id === h.todoId), projects: new Set(), notes: [] });
        }
        const g = groupMap.get(h.todoId);
        g.projects.add(p.name);
        if (h.note) g.notes.push(h.note);
      }
    }
    // 「其他」只收**完全没被分给任何待办**的项目。模型对同一个项目可能既输出待办行、
    // 又输出「其他」行（一个项目里干了不同的事），此时项目已经进了正文，不能再整个算进
    // 「其他」——那会让 unassignedSessions 把已归属的会话重复计一遍（实测 3 条待办拿到
    // 素材的同时，115 个会话全被算成「其他」，数据附注自相矛盾）。
    const assignedProjects = new Set([...groupMap.values()].flatMap((g) => [...g.projects]));
    const otherProjects = new Map();
    for (const p of m.projects) {
      if (!assignedProjects.has(p.name)) otherProjects.set(p.name, p);
    }

    // ③ 一级：每个「待办 × 素材」出小结。**没有会话的待办也要出**——不依赖模型的工作
    //    （发邮件、开会、评审）材料就是待办自己的标题与详情，本来就该进正文。
    //    但「这一期没动过的待办」不能进：报告讲的是这段时间干了什么，不是当前任务清单。
    //    入场条件 = 有会话素材（模型归过来的）或本窗内有变动（todosInWindow 三列表任一）。
    const touched = new Set([
      ...(m.todos.created ?? []), ...(m.todos.updated ?? []), ...(m.todos.completed ?? []),
    ].map((t) => t.id));
    const todoUnits = allTodos.filter((t) => groupMap.has(t.id) || touched.has(t.id)).map((t) => {
      const g = groupMap.get(t.id);
      const projList = g ? m.projects.filter((p) => g.projects.has(p.name)) : [];
      const material = projList.map((p) => `〔${p.name}〕\n${p.summaryText}`).join('\n\n');
      return {
        todo: t, sessions: projList.reduce((n, p) => n + p.sessions, 0), material, notes: g?.notes ?? [],
        // 远程待办（不在本机做）：告诉成稿模型「这段没素材是应该的」，别写成「没有进展」
        remote: isRemoteTodo(t, remoteProjects),
      };
    });
    const withSessions = todoUnits.filter((u) => u.material);
    const rangeText = `${fmtTime(j.startMs)} ~ ${fmtTime(j.endMs)}`;

    j.progress = { phase: 'summarize', projectsDone: 0, projectsTotal: withSessions.length };
    const summaries = await Promise.all(withSessions.map(async (u) => {
      const summary = await withRetry(
        () => callSummaryModel(route, PROMPTS.systemProject, PROMPTS.userTodoGroup({ todo: u.todo, sessions: u.sessions, summaryText: u.material })),
        `待办 ${u.todo.title}`);
      j.progress.projectsDone++;
      return { id: u.todo.id, summaryText: summary };
    }));
    const summaryById = new Map(summaries.map((s) => [s.id, s.summaryText]));

    // 未归属素材：单独一次调用产出「## 其他」的一行条清单
    let otherLines = '';
    const otherText = [...otherProjects.values()].sort((a, b) => b.sessions - a.sessions)
      .map((p) => `〔${p.name}〕\n${p.summaryText}`).join('\n\n');
    const otherSessions = [...otherProjects.values()].reduce((n, p) => n + p.sessions, 0);
    if (otherText) {
      otherLines = await withRetry(
        () => callSummaryModel(route, PROMPTS.systemUnassigned, PROMPTS.userUnassigned({ summaryText: otherText })),
        '未归属工作');
    }

    // ④ 二级：汇总成稿（与一级同纪律重试一次——上游偶发空响应曾是整份报告失败的常见根因）
    j.progress = { phase: 'final', projectsDone: withSessions.length, projectsTotal: withSessions.length };
    const todoGroupsOut = todoUnits.map((u) => ({
      todo: { id: u.todo.id, title: u.todo.title },
      // 有会话：模型小结；无会话但有子项/详情：把待办自身的信息交给模型组织；
      // 都没有：一行「已完成/进行中：标题」，不需要模型写什么
      summaryText: summaryById.get(u.todo.id) ?? '',
      hasSessions: Boolean(u.material),
      status: u.todo.status,
      items: Array.isArray(u.todo.items) ? u.todo.items.map((it) => ({ title: it.title, done: it.done })) : [],
      note: u.todo.note ?? '',
      mappingNotes: u.notes,
      remote: u.remote,
    }));
    const final = await withRetry(() => callSummaryModel(route, PROMPTS.systemFinal, PROMPTS.userFinal({
      rangeText,
      projects: m.projects.map((p) => ({ name: p.name, summaryText: p.summaryText })), // 仅供回落/参考
      todoGroups: todoGroupsOut,
      unassigned: { sessions: otherSessions, summaryText: otherLines },
      todos: m.todos, usage: m.usage, sourcesFailed: m.sourcesFailed,
    })), '二级汇总');

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
        todos: todoCounts(m.todos),
        // 归属口径：进了正文的待办数、有会话素材的待办数、归到「其他」的会话数
        todoGroups: todoUnits.length,
        todoGroupsWithSessions: withSessions.length,
        unassignedSessions: otherSessions,
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
