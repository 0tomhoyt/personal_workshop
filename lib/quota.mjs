// 编码套餐（coding plan）额度解析：Kimi For Coding 与智谱 GLM Coding Plan。
//
// 设计与判据见 docs/superpowers/specs/2026-10-31-home-dashboard-design.md §4.2。
// 关键事实（读 cc-switch 的 services/coding_plan.rs 及其测试夹具确认，非推测）：
//
//   Kimi：GET https://api.kimi.com/coding/v1/usages   Authorization: Bearer <key>
//     5 小时：limits[].detail.{limit, remaining, resetTime}
//     周    ：usage.{limit, remaining, resetTime}
//     数字是**字符串**（"100"），必须 Number() 转换。
//
//   智谱：GET https://{open.bigmodel.cn|api.z.ai}/api/monitor/usage/quota/limit
//     Authorization: <key>    ← 注意：裸值，不带 Bearer
//     data.limits[] 里 type=="TOKENS_LIMIT"，按 unit 分窗：3 → 5 小时，6 → 周
//     **percentage 是「已用」百分比**，对外契约是 remainingPct，必须 100 - percentage。
//     弄反的话环会在额度耗尽时显示满格，且读起来完全合理——最难被发现的那种错。
//
// 两家都只暴露 5 小时与周两档，没有月档。查不到就不显示，不伪造。

export const QUOTA_URLS = {
  kimi: 'https://api.kimi.com/coding/v1/usages',
  zhipuCn: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  zhipuIntl: 'https://api.z.ai/api/monitor/usage/quota/limit',
};

const KIMI_HOSTS = new Set(['api.kimi.com', 'api.kimi.ai']);
const VALID_KINDS = new Set(['kimi', 'zhipu', 'none']);

// 认家数：按 **host** 认，不按路径。
// 为什么不能按路径：智谱的额度接口跟对话接口根本不同源（对话 /api/anthropic、
// 额度 /api/monitor），Kimi 的 baseUrl 在模板里还写着过时的 /anthropic 形态。
// 路径一变就查不到，host 是稳定的。
export function detectQuotaKind(provider) {
  const kind = provider?.quota?.kind;
  if (VALID_KINDS.has(kind)) return kind === 'none' ? null : kind;
  let host;
  try { host = new URL(String(provider?.baseUrl ?? '')).hostname.toLowerCase(); } catch { return null; }
  if (KIMI_HOSTS.has(host)) return 'kimi';
  if (host.includes('bigmodel.cn') || host === 'api.z.ai') return 'zhipu';
  return null;
}

// 智谱的额度 URL 要区分国内站/国际站（两站同后端、同形状，但 host 不同）
export function zhipuQuotaUrl(baseUrl) {
  try {
    const host = new URL(String(baseUrl ?? '')).hostname.toLowerCase();
    if (host.includes('bigmodel.cn')) return QUOTA_URLS.zhipuCn;
  } catch {}
  return QUOTA_URLS.zhipuIntl;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));

// limit/remaining → 剩余百分比。limit <= 0 时返回 0（不产生 NaN/Infinity）
function remainingPctOf(limit, remaining) {
  const l = num(limit);
  const r = num(remaining);
  if (!(l > 0)) return 0;
  return clampPct((r / l) * 100);
}

// ISO 或数字（秒/毫秒）统一成 ISO 字符串；无法识别返回 null
export function normalizeResetTime(v) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  const n = num(v);
  if (!(n > 0)) return null;
  const ms = n < 1_000_000_000_000 ? n * 1000 : n; // 秒级 < 1e12
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function parseKimiQuota(body) {
  const tiers = [];
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  for (const item of limits) {
    const d = item?.detail;
    if (!d) continue;
    tiers.push({
      name: 'five_hour',
      remainingPct: remainingPctOf(d.limit, d.remaining),
      resetsAt: normalizeResetTime(d.resetTime),
    });
  }
  const usage = body?.usage;
  if (usage) {
    tiers.push({
      name: 'weekly_limit',
      remainingPct: remainingPctOf(usage.limit, usage.remaining),
      resetsAt: normalizeResetTime(usage.resetTime),
    });
  }
  return tiers;
}

// ── 查询：缓存 + 降级 ──────────────────────────────────────────────────────
//
// 成功缓存 60 秒（首屏 30 秒轮询不会真打上游）；失败**不清空**上次成功值，
// 而是按年龄分两档：15 分钟内 → stale（环照画、标「N 分钟前」），超过才 → error。
// 这样单家上游抽风时用户还能看到它最后的状态，但旧数字不会被伪装成当前值。
const TTL_MS = 60_000;
const STALE_MAX_MS = 15 * 60_000;
const cache = new Map();    // `${pid}:${kind}` → { at, tiers }
const inflight = new Map(); // 同上 → Promise

export async function queryQuota(provider, { now = Date.now, fetchImpl = globalThis.fetch, force = false } = {}) {
  const kind = detectQuotaKind(provider);
  if (!kind) return { state: 'none', at: null, error: null, tiers: [] };

  const key = `${provider?.id ?? '-'}:${kind}`;
  const hit = cache.get(key);
  if (!force && hit && now() - hit.at < TTL_MS) {
    return { state: 'ok', at: hit.at, error: null, tiers: hit.tiers, cached: true };
  }
  if (!force && inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    const url = kind === 'kimi' ? QUOTA_URLS.kimi : zhipuQuotaUrl(provider?.baseUrl);
    const fail = (msg) => degrade(key, msg, now);

    // token 现取（与转发路径同源：凭证刷新后额度查询立刻跟上）
    let token;
    try {
      const { resolveToken } = await import('./auth/static.mjs');
      token = resolveToken(provider);
    } catch (e) {
      return fail(`凭证不可用：${e?.message ?? e}`);
    }
    // 智谱是裸值不带 Bearer，这是实测的差异，写在适配器里不外泄
    const authorization = kind === 'kimi' ? `Bearer ${token}` : token;

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return fail(`网络错误：${e?.message ?? e}`);
    }
    if (res.status === 401 || res.status === 403) return fail(`凭证无效或已过期（HTTP ${res.status}）`);
    if (!res.ok) return fail(`额度接口返回 HTTP ${res.status}`);

    let body;
    try { body = await res.json(); } catch { return fail('额度响应不是合法 JSON'); }

    // 智谱按量账户查套餐：HTTP 200 + 业务错误。这不是「额度用尽」，是「没买套餐」
    if (kind === 'zhipu' && body?.success === false) {
      const msg = String(body?.msg ?? '');
      if (/coding\s*plan/i.test(msg.replace(/\s+/g, ' '))) return fail('该账户未开通 Coding Plan 套餐');
      return fail(`额度接口业务错误：${msg || '未知'}`);
    }

    const tiers = kind === 'kimi' ? parseKimiQuota(body) : parseZhipuQuota(body);
    const at = now();
    cache.set(key, { at, tiers });
    return { state: 'ok', at, error: null, tiers };
  })();

  inflight.set(key, run);
  try { return await run; } finally { inflight.delete(key); }
}

// 失败时的降级：有新鲜旧值 → stale（保留环），否则 → error（清空环）
function degrade(key, error, now) {
  const old = cache.get(key);
  if (old && now() - old.at < STALE_MAX_MS) {
    return { state: 'stale', at: old.at, error, tiers: old.tiers };
  }
  return { state: 'error', at: old?.at ?? null, error, tiers: [] };
}

// 测试用：清空缓存（模块级状态，用例之间不串味）
export function _resetQuotaCache() {
  cache.clear();
  inflight.clear();
}

// 智谱：percentage 是「已用」，取反成剩余。
// unit: 3 → 5 小时，6 → 周。unit 缺失时走兜底：
// 无 nextResetTime 的优先归 5 小时（5 小时桶在 0% 等状态下可能不带 reset），
// 其余按 nextResetTime 升序依次填剩余槽位。不能单纯按 reset 排序——周期末尾
// 每周桶会比 5 小时桶更早重置，那样会把两桶标反。
export function parseZhipuQuota(body) {
  const limits = Array.isArray(body?.data?.limits) ? body.data.limits : [];
  const entries = [];
  for (const item of limits) {
    const type = String(item?.type ?? '').toLowerCase();
    if (type !== 'tokens_limit') continue;
    const used = num(item.percentage);
    entries.push({
      unit: Number.isInteger(item.unit) ? item.unit : (Number.isInteger(Number(item.unit)) ? Number(item.unit) : null),
      remainingPct: clampPct(100 - used),
      resetsAt: normalizeResetTime(item.nextResetTime),
    });
  }

  let five = null;
  let weekly = null;
  const unclassified = [];
  for (const e of entries) {
    if (e.unit === 3 && !five) five = e;
    else if (e.unit === 6 && !weekly) weekly = e;
    else unclassified.push(e);
  }
  // 兜底：先补 5 小时槽（无 reset 的更可能是 5 小时桶）
  if (!five) {
    const i = unclassified.findIndex((e) => e.resetsAt == null);
    if (i >= 0) five = unclassified.splice(i, 1)[0];
    else if (unclassified.length) five = unclassified.shift();
  }
  if (!weekly && unclassified.length) {
    unclassified.sort((a, b) => String(a.resetsAt ?? '').localeCompare(String(b.resetsAt ?? '')));
    weekly = unclassified.shift();
  }

  const out = [];
  for (const [name, e] of [['five_hour', five], ['weekly_limit', weekly]]) {
    if (e) out.push({ name, remainingPct: e.remainingPct, resetsAt: e.resetsAt });
  }
  return out;
}
