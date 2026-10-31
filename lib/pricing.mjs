// 模型单价表与费用折算（美元 / 1M tokens）。
//
// 费用是「按 API 牌价折算的等效成本」：订阅制（Kimi Code / GLM Coding Plan / CANNWork）
// 实际是固定月费，这里的金额只用于横向比较各模型用量价值，不代表真实扣费。
//
// 单价优先级：providers.json pricing 覆盖（键 `pid/model` > 裸模型名）> 内置表。
// 内置价参考 OpenRouter 公开牌价与各家官方定价的量级估算（2026-10），可随时被覆盖。
//
// 缓存计价：上游报告的 cache_read（命中）/ cache_creation（写入）token 单独计量——
//   费用 = 普通输入×in + 缓存写×in_cache_write + 缓存读×in_cache_read + 输出×out
// 未单独配置缓存价时按各家惯例近似：写 = 1.25×in（Anthropic/GPT 惯例 1.25），
// 读 = 0.1×in（Anthropic 0.1 / GPT 0.25 / GLM 0.2 取中偏保守）。无缓存字段的请求不受影响。
import { tryGetConfig } from './config.mjs';

// 内置参考单价：input / output = 美元每 1M tokens
export const BUILTIN_PRICES = {
  // GLM 家族（z.ai / OpenRouter）
  'glm-4.5': { input: 0.6, output: 2.2 },
  'glm-4.5-air': { input: 0.2, output: 1.1 },
  'glm-4.6': { input: 0.6, output: 2.2 },
  'glm-4.7': { input: 0.7, output: 2.4 },
  'glm-5': { input: 1.0, output: 3.6 },
  'glm-5-turbo': { input: 0.3, output: 1.2 },
  'glm-5.1': { input: 1.0, output: 3.8 },
  'glm-5.2': { input: 1.1, output: 4.0 },
  'glm-5.3': { input: 1.2, output: 4.5 },
  'glm-5.3-flash': { input: 0.25, output: 1.1 },
  'glm-5.3-flashx': { input: 0.4, output: 1.5 },
  // Kimi 家族（Moonshot 开放平台牌价，2026-10 核对 platform.kimi.com/docs/pricing/chat）
  // K3 系列缓存写按 TTL 分档单独计费：默认 5min 档 = 输入价，1h 档 = 2×输入价；
  // 网关只拿到 cache_creation 总数、不区分 TTL，故取默认档（5min）。
  'k3': { input: 3.0, output: 15.0, cacheWrite: 3.0, cacheRead: 0.3 },
  'k3-256k': { input: 3.0, output: 15.0, cacheWrite: 3.0, cacheRead: 0.3 },
  'k3.1-pro': { input: 2.0, output: 10.0, cacheWrite: 2.0, cacheRead: 0.2 },
  'k3.1-pro-highspeed': { input: 4.0, output: 20.0, cacheWrite: 4.0, cacheRead: 0.2 },
  'kimi-for-coding': { input: 1.0, output: 4.0 },
  'kimi-for-coding-highspeed': { input: 2.2, output: 8.5 },
  // DeepSeek 家族（v4 系列沿用 v3.2-Exp 的缓存定价结构）
  'deepseek-v4-pro': { input: 0.55, output: 2.2 },
  'deepseek-v4-flash': { input: 0.28, output: 0.45 },
  'deepseek-v4.1-flash': { input: 0.28, output: 0.45 },
  'deepseek-v4.2-flash': { input: 0.28, output: 0.45 },
  'deepseek-flash': { input: 0.28, output: 0.45 }, // 历史别名（上游旧版快照名）
  'deepseek-v4-1-flash': { input: 0.28, output: 0.45 }, // 历史别名（点号写法变体）
  // Qwen 家族
  'qwen3.8-max': { input: 1.2, output: 6.0 },
  'qwen3.8-flash': { input: 0.3, output: 1.2 },
};

// 上游常以「基名-YYMMDD」发布版本快照（如 glm-5.3-260910、deepseek-v4.1-flash-261017）。
// 精确名查不到时剥掉末尾日期后缀再查一次，视为同价。
function stripDateSuffix(model) {
  return String(model).replace(/-[0-9]{6}$/, '');
}

// 解析 (pid, model) 的生效单价。返回 { input, output, cacheWrite, cacheRead, source } 或 null。
// providers.json 损坏时降级为只用内置表——记账路径绝不能抛错。
export function resolvePrice(pid, model) {
  let custom = null;
  try {
    custom = tryGetConfig().pricing ?? {};
  } catch { custom = {}; }
  const tryKeys = [`${pid}/${model}`, model];
  const stripped = stripDateSuffix(model);
  if (stripped !== model) tryKeys.push(`${pid}/${stripped}`, stripped);
  for (const key of tryKeys) {
    if (custom[key]) return withCachePrices({ ...custom[key] }, 'custom');
  }
  for (const key of [model, ...tryKeys.slice(2)]) {
    if (BUILTIN_PRICES[key]) return withCachePrices({ ...BUILTIN_PRICES[key] }, 'builtin');
  }
  return null;
}

// 补全缓存单价：显式给出则用之；否则按惯例近似（写 1.25×in、读 0.1×in）
function withCachePrices(p, source) {
  const input = Number(p.input ?? p.in);
  const output = Number(p.output ?? p.out);
  return {
    input,
    output,
    cacheWrite: Number.isFinite(Number(p.cacheWrite)) && p.cacheWrite != null ? Number(p.cacheWrite) : input * 1.25,
    cacheRead: Number.isFinite(Number(p.cacheRead)) && p.cacheRead != null ? Number(p.cacheRead) : input * 0.1,
    source,
  };
}

// 一次请求的等效费用（美元）：
//   普通输入×in + 缓存写×cacheWrite + 缓存读×cacheRead + 输出×out（每 1M tokens）
// usage 里各字段缺省 0；未计价返回 0。
export function costOf(pid, model, tin, tout, cacheRead = 0, cacheWrite = 0) {
  const p = resolvePrice(pid, model);
  if (!p) return 0;
  return ((tin || 0) / 1e6) * p.input
    + ((cacheRead || 0) / 1e6) * p.cacheRead
    + ((cacheWrite || 0) / 1e6) * p.cacheWrite
    + ((tout || 0) / 1e6) * p.output;
}
