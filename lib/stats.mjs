// 流量统计（内存累计 + 30s 防抖落盘 stats.json）。
//
// v2 结构：每天的桶里按 provider 分层 ——
//   day.total                 全部上游合计
//   day.providers[pid].models[model]  按上游 × 模型分桶
//   day.hours[24]             今日按小时
// 启动加载 v1 旧数据时自动迁移（历史流量归入 cannbot）。
//
// 模型性能口径对齐 vLLM benchmark_serving / MLPerf，并补上「首包里不止 1 个 token」：
//   TTFT  发出上游请求 → 首个输出块到达（预填 + 排队 + 网络，不含本地换凭证）
//   E2E   发出上游请求 → 流结束
//   解码段 首个输出块 → 最后一个输出块（不含末尾 usage / [DONE]）
//   首包 token  把上游 completion_tokens 按字符权重摊到各块；同一时刻的块先合并
//   TPOT  解码段 / (输出 token − 首包 token)。逐 token 流式时首包 = 1，即 vLLM 的 (n−1)
//   ITL   相邻输出块的间隔 / 该块摊到的 token 数，每个 token 记一次
//   解码速度  Σ(输出 token − 首包 token) / Σ解码段，按 token 加权
// 延迟分布用直方图，跨天相加即可，不保存每次请求的原始样本。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';
import { backupBadFile } from './util.mjs';
import { costOf, resolvePrice } from './pricing.mjs';
import { tryGetConfig } from './config.mjs';

const SCRIPT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATS_FILE = process.env.CANNBOT_STATS_FILE || path.join(SCRIPT_DIR, 'stats.json');
// 同步客户端拉取的枢纽跨设备求和视图（只读展示）；recordStats 仍只写 STATS_FILE。
const STATS_SYNC_FILE = process.env.CANNBOT_STATS_SYNC_FILE || path.join(SCRIPT_DIR, 'stats-sync.json');

const LAT_EDGES = Object.freeze([1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000]);
const emptyBucket = () => ({ req: 0, err: 0, tin: 0, tout: 0, bin: 0, bout: 0, ms: 0, cost: 0 });

function emptyHist(withSamples = false) {
  const h = { n: 0, sum: 0, b: Array(LAT_EDGES.length + 1).fill(0) };
  if (withSamples) h.s = [];
  return h;
}
function emptyPerf() {
  return { ttft: emptyHist(true), tpot: emptyHist(true), itl: emptyHist(false), e2e: emptyHist(true), dtok: 0, dms: 0, dn: 0 };
}

const SAMPLE_CAP = 2000;

function histAdd(h, ms, w = 1) {
  if (!(ms >= 0) || !(w > 0) || !Number.isFinite(ms)) return;
  let i = 0;
  while (i < LAT_EDGES.length && ms > LAT_EDGES[i]) i++;
  h.b[i] += w;
  h.n += w;
  h.sum += ms * w;
  // TTFT / TPOT / E2E 每个请求一个样本，留原始值，分位数不必靠粗分桶插值
  if (Array.isArray(h.s) && w === 1) {
    if (h.s.length < SAMPLE_CAP) h.s.push(Math.round(ms * 100) / 100);
    else delete h.s;
  }
}

function mergeHist(dst, src) {
  if (!src?.n || !Array.isArray(src.b) || src.b.length !== dst.b.length) return;
  const dstOk = Array.isArray(dst.s) && dst.s.length === dst.n;
  const srcOk = Array.isArray(src.s) && src.s.length === src.n;
  dst.n += src.n;
  dst.sum += src.sum || 0;
  for (let i = 0; i < dst.b.length; i++) dst.b[i] += src.b[i] || 0;
  if (dstOk && srcOk && dst.s.length + src.s.length <= SAMPLE_CAP) dst.s = dst.s.concat(src.s);
  else if (Array.isArray(dst.s)) delete dst.s;
}

function ensurePerf(b) {
  if (!b.perf) b.perf = emptyPerf();
  for (const k of ['ttft', 'tpot', 'itl', 'e2e']) {
    const h = b.perf[k];
    if (!h || !Array.isArray(h.b) || h.b.length !== LAT_EDGES.length + 1) b.perf[k] = emptyHist(k !== 'itl');
    else if (k !== 'itl' && h.n === 0 && !Array.isArray(h.s)) h.s = [];
  }
  b.perf.dtok = b.perf.dtok || 0;
  b.perf.dms = b.perf.dms || 0;
  b.perf.dn = b.perf.dn || 0;
  return b.perf;
}

// 短 <1000、中 1000–3999、长 ≥4000。没有 prompt token 数的请求不进档。
function inputBand(tin) {
  if (!(tin >= 1)) return null;
  if (tin < 1000) return 's';
  if (tin < 4000) return 'm';
  return 'l';
}

function mergePerf(dst, src) {
  if (!src) return;
  for (const k of ['ttft', 'tpot', 'itl', 'e2e']) mergeHist(dst[k], src[k]);
  dst.dtok += src.dtok || 0;
  dst.dms += src.dms || 0;
  dst.dn += src.dn || 0;
  if (!src.bands) return;
  dst.bands ??= {};
  for (const id of ['s', 'm', 'l']) {
    if (!src.bands[id]) continue;
    if (!dst.bands[id]) dst.bands[id] = emptyPerf();
    mergePerf(dst.bands[id], src.bands[id]);
  }
}

// 同一条样本既计入总分布，也计入对应输入档。档内对象不再嵌套 bands。
function withBand(perf, tin) {
  const id = inputBand(tin);
  if (!id || !(perf?.ttft?.n)) return perf;
  const slice = emptyPerf();
  mergePerf(slice, perf);
  return { ...perf, bands: { [id]: slice } };
}

function coalesceMarks(marks) {
  const out = [];
  for (const m of marks) {
    if (!(m.w > 0)) continue;
    const prev = out[out.length - 1];
    // 同一毫秒内的块是同一次到达，拆开会记出接近 0 的假 ITL
    if (prev && m.at - prev.at < 1) prev.w += m.w;
    else out.push({ at: m.at, w: m.w });
  }
  return out;
}

// 最大余数法，使各块 token 之和等于上游 completion_tokens。首块至少 1。
function apportionTokens(weights, tout) {
  const n = weights.length;
  const tokens = Array(n).fill(0);
  if (n === 0 || !(tout >= 1)) return tokens;
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) { tokens[0] = tout; return tokens; }
  const raw = weights.map((w) => tout * w / total);
  for (let i = 0; i < n; i++) tokens[i] = Math.floor(raw[i]);
  let remain = tout - tokens.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [i, x - Math.floor(x)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (let k = 0; k < remain; k++) tokens[order[k][0]]++;
  if (tokens[0] < 1) {
    let donor = -1;
    for (let i = 1; i < n; i++) if (tokens[i] > 0 && (donor < 0 || tokens[i] > tokens[donor])) donor = i;
    if (donor > 0) { tokens[donor]--; tokens[0] = 1; }
    else tokens[0] = tout;
  }
  return tokens;
}

// marks: { at, w }[]，时间用 performance.now()，与 tFetch / tEnd 同一时钟。
export function observeStream(tFetch, marks, tout, tEnd) {
  const perf = emptyPerf();
  const merged = coalesceMarks(marks);
  if (!merged.length || !(tFetch >= 0) || !(tEnd >= tFetch)) return perf;
  const tFirst = merged[0].at;
  const tLast = merged[merged.length - 1].at;
  const ttft = tFirst - tFetch;
  const e2e = tEnd - tFetch;
  if (ttft < 0 || e2e < 0) return perf;
  histAdd(perf.ttft, ttft);
  histAdd(perf.e2e, e2e);
  const tokens = tout >= 1 ? apportionTokens(merged.map((m) => m.w), tout) : [];
  const firstTok = tokens[0] || 0;
  const decodeTok = tout - firstTok;
  const dms = tLast - tFirst;
  if (decodeTok > 0 && dms > 0) {
    histAdd(perf.tpot, dms / decodeTok);
    perf.dtok += decodeTok;
    perf.dms += dms;
    perf.dn += 1;
  }
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i].at - merged[i - 1].at;
    const n = tokens[i] || 0;
    if (n > 0 && gap >= 0) histAdd(perf.itl, gap / n, n);
  }
  return perf;
}

// 无原型对象：键来自客户端请求体（provider id / model 名），可能是 "__proto__"、
// "constructor" 这类。普通对象上 `models['__proto__'] ??= {}` 读到的是
// Object.prototype（真值 → 不赋值），随后 `b.req++` 就往原型上写，
// 污染**整个进程**里所有空对象的读数（实测：所有 {} 都长出 req: NaN）。
// 所有「以外部字符串为键」的字典都用它建：providers / models / days 的读盘路径。
const nullObj = () => Object.create(null);
// JSON.parse 出来的对象带原型，键里可能就有 "__proto__"；逐层重建为无原型字典
function hardenDays(days) {
  if (!days || typeof days !== 'object') return days;
  const out = nullObj();
  for (const [date, day] of Object.entries(days)) {
    if (!day || typeof day !== 'object') { out[date] = day; continue; }
    const provs = nullObj();
    for (const [pid, pv] of Object.entries(day.providers ?? {})) {
      if (!pv || typeof pv !== 'object') { provs[pid] = pv; continue; }
      const models = nullObj();
      for (const [m, b] of Object.entries(pv.models ?? {})) models[m] = b;
      provs[pid] = { ...pv, models };
    }
    day.providers = provs;
    out[date] = day;
  }
  return out;
}

// v1 → v2：v1 每天只有 { total, models, hours }，全部流量属于 cannbot 单上游
function migrateV1(d) {
  if (d.version !== 1 || !d.days) return d;
  for (const day of Object.values(d.days)) {
    if (day.models && !day.providers) {
      day.providers = { cannbot: { models: day.models } };
      delete day.models;
    }
    day.providers ??= {};
  }
  d.version = 2;
  return d;
}

let stats = (() => {
  try {
    const d = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (d && d.days) { d.days = hardenDays(d.days); return migrateV1(d); }
  } catch (e) {
    // 与 todos/reports 同口径：坏文件先留 .bad 备份再按空起步（统计可再生，但留现场便于排查）
    if (e.code !== 'ENOENT') backupBadFile(STATS_FILE);
  }
  return { version: 2, days: {} };
})();
let statsDirty = false;

function flushStats() {
  if (!statsDirty) return;
  try {
    const keys = Object.keys(stats.days).sort();
    while (keys.length > 30) delete stats.days[keys.shift()]; // 只保留近 30 天
    // 原子落盘（tmp + rename + 0600，与 todos/reports 同口径）：写一半被 kill 不留半截文件
    const tmpF = `${STATS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpF, JSON.stringify(stats));
    fs.chmodSync(tmpF, 0o600);
    fs.renameSync(tmpF, STATS_FILE);
    statsDirty = false;
  } catch (e) { log(`stats.json 写入失败: ${e.message}`); }
}
setInterval(flushStats, 30_000).unref();

const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// provider + model 双维度记账；provider 缺省时归入 '-'（不应发生，兜底防丢）。
// cost 为按单价表折算的等效费用（美元），在记账时点以当时生效的单价入账（账本语义）；
// 缓存 token 拆 cacheRead / cacheWrite 分别计价。费用输入口径按上游协议归一：
//   openai 上游的调用方传 tin=prompt_tokens（已含缓存命中），须先扣掉 cacheRead 再进
//   costOf，否则缓存部分被按全价输入与缓存读价各计一次（双计）；
//   anthropic 上游的 tin=input_tokens 本就不含缓存，直接用。
// 查不到协议（provider 已删/配置降级）保持原样不扣——宁可保守不漏计。
// 注意：桶内落账的 tin 仍是调用方原始值（openai 桶含缓存），前端命中率分母依赖该口径。
export function recordStats({ provider = '-', model = '-', status = 0, ms = 0, bytesIn = 0, bytesOut = 0, tin = 0, tout = 0, cacheRead = 0, cacheWrite = 0, perf = null }) {
  const now = new Date();
  let costTin = tin;
  if (cacheRead > 0) {
    const proto = tryGetConfig().providers?.find((p) => p.id === provider)?.protocol;
    if (proto === 'openai') costTin = Math.max(0, tin - cacheRead);
  }
  const cost = costOf(provider, model, costTin, tout, cacheRead, cacheWrite);
  const day = (stats.days[dayKey(now)] ??= { total: emptyBucket(), providers: nullObj(), hours: Array.from({ length: 24 }, () => ({ req: 0, tin: 0, tout: 0, cost: 0 })) });
  day.providers ??= nullObj();
  // 三处 ??= 都必须在无原型对象上做：provider / model 都来自请求体，
  // "__proto__" 会让赋值退化成读原型并写回原型（见 nullObj 注释）
  const pv = (day.providers[provider] ??= { models: nullObj() });
  pv.models ??= nullObj();
  const mb = (pv.models[model] ??= emptyBucket());
  const bad = status >= 400;
  for (const b of [day.total, mb]) {
    b.req++;
    if (bad) b.err++;
    b.tin += tin; b.tout += tout; b.bin += bytesIn; b.bout += bytesOut; b.ms += ms;
    b.cost = (b.cost || 0) + cost; // 旧数据无 cost 字段，兜底 0
    b.cread ??= 0; b.cread += cacheRead;
    b.cwrite ??= 0; b.cwrite += cacheWrite;
    // 分档/日志的输入规模同样按协议归一：costTin 已扣掉 openai 桶重复计入的缓存读，
    // 三项相加在两种协议下都等于真实的总输入 token 规模。
    if (perf?.ttft?.n) mergePerf(ensurePerf(b), withBand(perf, costTin + cacheRead + cacheWrite));
  }
  const hb = day.hours[now.getHours()] ?? (day.hours[now.getHours()] = { req: 0, tin: 0, tout: 0, cost: 0 });
  hb.req++; hb.tin += tin; hb.tout += tout; hb.cost = (hb.cost || 0) + cost;
  statsDirty = true;
  if (perf?.ttft?.n) {
    const ttft = perf.ttft.sum / perf.ttft.n;
    const band = inputBand(costTin + cacheRead + cacheWrite);
    const parts = [`perf ${provider}/${model}`, band ? `in=${band}` : 'in=-', `ttft=${Math.round(ttft)}ms`];
    if (perf.dn && perf.dms > 0) {
      const tps = perf.dtok / (perf.dms / 1000);
      parts.push(`tpot=${(perf.tpot.sum / perf.tpot.n).toFixed(1)}ms`, `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`);
    }
    if (perf.itl?.n) parts.push(`itl=${(perf.itl.sum / perf.itl.n).toFixed(1)}ms`);
    if (perf.e2e?.n) parts.push(`e2e=${Math.round(perf.e2e.sum / perf.e2e.n)}ms`);
    log(parts.join(' '));
  }
}

// /admin/stats 快照。models 以 `provider:model` 为 id 展平（跨天由前端按 id 聚合），
// 同时带 provider/model 原始字段，供管理台分列展示；prices 汇总期间出现过的
// 模型的生效单价（供管理台单价表展示）。
// days[] 剥掉 perf.s 原始延迟样本、只带直方图：趋势图只读 req/tok/cost，而同一批
// 样本已在 today/models[] 里出现过，历史天数再各带一份会在响应里被序列化约 10 次，
// 且随 30 天留存线性膨胀；剥掉后 7/30 天区间的分位数由前端直方图插值兜底（metricQ）。
// 剥掉 perf 直方图里的原始样本数组 s（保留 n/sum/b），含 bands 递归。
// 返回新对象，不触碰内存中的原始桶（落盘与今日精确分位数不受影响）。
function stripPerf(p) {
  if (!p) return p;
  const stripHist = (h) => (h && Array.isArray(h.b)) ? { n: h.n, sum: h.sum, b: h.b } : h;
  const out = { ttft: stripHist(p.ttft), tpot: stripHist(p.tpot), itl: stripHist(p.itl), e2e: stripHist(p.e2e), dtok: p.dtok, dms: p.dms, dn: p.dn };
  if (p.bands) {
    out.bands = {};
    for (const id of ['s', 'm', 'l']) if (p.bands[id]) out.bands[id] = stripPerf(p.bands[id]);
  }
  return out;
}
// 模型桶表（{ id: bucket }）剥样本版：浅拷贝桶 + 剥 perf
function stripPerfSamples(models) {
  const out = {};
  for (const [id, b] of Object.entries(models)) {
    out[id] = { ...b };
    if (b.perf) out[id].perf = stripPerf(b.perf);
  }
  return out;
}


/** 本机记账 days（供 sync 推送）；返回浅拷贝引用前先 JSON 克隆以免被改。 */
export function getLocalStatsDays() {
  try {
    return JSON.parse(JSON.stringify(stats.days || {}));
  } catch {
    return { ...(stats.days || {}) };
  }
}

/** 枢纽/spoke 写入拉取到的求和视图。days 为跨设备 sum。 */
export function writeSyncedStatsDays(days, { rev = 0, pulledAt = Date.now() } = {}) {
  const payload = {
    version: 1,
    rev: Number(rev) || 0,
    pulledAt,
    days: days && typeof days === 'object' ? days : {},
  };
  try {
    const tmpF = `${STATS_SYNC_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpF, JSON.stringify(payload));
    fs.chmodSync(tmpF, 0o600);
    fs.renameSync(tmpF, STATS_SYNC_FILE);
  } catch (e) {
    log(`stats-sync.json 写入失败: ${e.message}`);
  }
}

function loadSyncedStatsDays() {
  try {
    const d = JSON.parse(fs.readFileSync(STATS_SYNC_FILE, 'utf8'));
    if (d && d.days && typeof d.days === 'object') return d;
  } catch (e) {
    if (e.code !== 'ENOENT') { /* 展示层忽略坏文件 */ }
  }
  return null;
}

export function statsSnapshot() {
  const todayKey = dayKey();
  // 有 stats-sync.json（spoke 拉到的枢纽跨设备 sum）时整段用于展示，避免与本机
  // stats.json 再求和导致双计。recordStats 仍只写本机文件；下一轮 push→pull 刷新视图
  // （最多约 intervalSec 延迟）。无 sync 文件时行为与改前一致。
  const synced = loadSyncedStatsDays();
  const viewDays = (synced?.days && Object.keys(synced.days).length)
    ? synced.days
    : (stats.days || {});

  const today = viewDays[todayKey] ?? stats.days[todayKey] ?? { total: emptyBucket(), providers: {}, hours: [] };
  const flatten = (day, stripSamples) => {
    const out = {};
    for (const [pid, pv] of Object.entries(day.providers ?? {})) {
      for (const [m, b] of Object.entries(pv.models ?? {})) out[`${pid}:${m}`] = b;
    }
    return stripSamples ? stripPerfSamples(out) : out;
  };
  const models = Object.entries(flatten(today))
    .map(([id, b]) => {
      const [provider, ...rest] = id.split(':');
      return { id, provider, model: rest.join(':'), ...b, cost: b.cost || 0 };
    })
    .sort((a, b) => b.req - a.req);
  const days = Object.keys(viewDays).sort()
    .map((date) => {
      const d = viewDays[date];
      // 历史天的 total.perf 同样剥样本（含 bands）；今日的 total 直接引用（today 顶层字段）
      const total = (d.total?.perf && date !== todayKey)
        ? { ...d.total, perf: stripPerf(d.total.perf) }
        : d.total;
      return { date, total, models: flatten(d, date !== todayKey) };
    });
  // 单价表：统计期间出现过的 (pid, model) 的当前生效单价（本机+视图）
  const seen = new Map();
  for (const day of Object.values({ ...(stats.days || {}), ...viewDays })) {
    for (const [pid, pv] of Object.entries(day.providers ?? {})) {
      for (const m of Object.keys(pv.models ?? {})) {
        if (!seen.has(`${pid}:${m}`)) seen.set(`${pid}:${m}`, true);
      }
    }
  }
  const prices = [...seen.keys()].map((key) => {
    const [pid, ...rest] = key.split(':');
    const model = rest.join(':');
    const p = resolvePrice(pid, model);
    return { pid, model, input: p?.input ?? null, output: p?.output ?? null, source: p ? p.source : 'none' };
  }).sort((a, b) => (a.pid + a.model).localeCompare(b.pid + b.model));
  // 顶层 protocols：pid → 上游协议。遍历全量配置（不过滤 enabled），供前端按协议分支
  // 选缓存命中率分母（openai 桶 tin 已含缓存、anthropic 桶不含）；不在 map 中的历史桶
  // （provider 已删）由前端走保守兜底分母。
  const protocols = {};
  for (const p of tryGetConfig().providers ?? []) protocols[p.id] = p.protocol;
  return {
    today: today.total,
    models,
    hours: today.hours,
    days,
    protocols,
    latEdges: LAT_EDGES,
    prices,
  };
}

// 某订阅的等效花费（美元）：今日 + 近 30 天。
//
// **必须走 statsSnapshot()**，不能自己遍历 stats.days：有 stats-sync.json 时快照返回的是
// 跨设备合计，首屏与「统计」页必须是同一个数（这台机器是 spoke，自己求和会只算本机，
// 用户在 MacBook 上看到的就是半截数据）。
//
// snap 参数只为测试注入；正常调用不传。
export function providerSpend(pid, snap = statsSnapshot(), todayKey = dayKey()) {
  const round2 = (x) => Math.round((x || 0) * 100) / 100;
  // 今日与近 30 天必须**同源**：statsSnapshot 的顶层 models 在 sync 文件缺失今天的桶时
  // 会回落到本机 stats.days，而 days[] 只含 viewDays —— 那时顶层的「今日」不在「近 30 天」
  // 里，卡片会显示「近 30 天 $7.40 · 今日 $0.42」这种自相矛盾的一对数字。
  // 所以两者都从 days[] 取，today 只挑今天那一份。
  let total = 0;
  let today = 0;
  for (const day of snap?.days ?? []) {
    let dayCost = 0;
    for (const [key, bucket] of Object.entries(day?.models ?? {})) {
      const at = key.indexOf(':');
      const owner = at < 0 ? key : key.slice(0, at);
      if (owner === pid) dayCost += Number(bucket?.cost) || 0;
    }
    total += dayCost;
    if (day?.date === todayKey) today += dayCost;
  }
  return { today: round2(today), days30: round2(total) };
}

// 某订阅的 token 用量（全量输入 + 输出），供「用本机记账折算额度」的场景画环。
//
// 口径就是 tin + tout，**不扣缓存读**：cannbot 走 openai 协议，tin = prompt_tokens
// 本身就包含缓存命中部分，cread 是拆项（为了单独计价），不是 tin 之外的增量。
// 所以再减 cread 会少算——那正是这个函数第一版的错。
//
// month 是**自然月**（与 todayKey 同月），不是滚动 30 天：月度上限问的是「本月用了多少」，
// 把上个月的用量摊进来会让月初的环凭空少一截。
//
// 与 providerSpend 同源：都走 statsSnapshot()，保证与「统计」页同一份数。
export function providerTokens(pid, snap = statsSnapshot(), todayKey = dayKey()) {
  let total = 0;
  let today = 0;
  const monthPrefix = String(todayKey).slice(0, 7); // YYYY-MM
  for (const day of snap?.days ?? []) {
    let dayTok = 0;
    for (const [key, bucket] of Object.entries(day?.models ?? {})) {
      const at = key.indexOf(':');
      const owner = at < 0 ? key : key.slice(0, at);
      if (owner !== pid) continue;
      dayTok += (Number(bucket?.tin) || 0) + (Number(bucket?.tout) || 0);
    }
    // 同月才计入。用 slice 比对而不是 >= 字符串比较：后者会把「下个月」的桶也算进来
    // （sync 时钟偏差时可能造出未来日期），而月上限问的是本月。
    if (String(day?.date ?? '').slice(0, 7) === monthPrefix) total += dayTok;
    if (day?.date === todayKey) today += dayTok;
  }
  return { today, month: total };
}

export { flushStats, STATS_FILE, STATS_SYNC_FILE };
