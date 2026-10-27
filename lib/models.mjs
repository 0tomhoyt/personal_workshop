// 模型目录聚合 + 模型名 → provider 路由。
//
// 各 provider 的模型来源：
//   models.source = 'static'  providers.json 里的 models.list
//   models.source = 'api'     cannwork 凭证走站点专用接口；其余走上游标准
//                             GET /v1/models（openai 与 anthropic 形态都支持）
// 聚合规则：裸模型名全局唯一时直接用；重名时裸名从列表移除，统一用 `pid/model`
// 显式指定（任何模型任何时候也都接受 `pid/model` 写法）。routing.aliases 可加别名。
import { getConfig } from './config.mjs';
import { requestUpstream } from './upstream.mjs';
import { fetchCatalog as fetchCannworkCatalog } from './auth/cannwork.mjs';
import { httpError, readBodyLimited } from './util.mjs';

const MODELS_TTL = 10 * 60 * 1000;
const ERROR_TTL = 30 * 1000; // 拉取失败的负缓存，避免上游故障时每个请求都重试

const cache = new Map(); // pid -> { providerObj, at, models? , error? }

function staticModels(provider) {
  const out = [];
  const seen = new Set();
  for (const entry of provider.models.list) {
    const m = typeof entry === 'string' ? { id: entry } : entry;
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, title: m.title || m.id, contextLength: m.contextLength ?? null });
  }
  return out;
}

// 上游标准 GET /v1/models（openai 形态 {data:[{id}]} 与 anthropic 形态同构）。
// 错误对象附带 upStatus，供管理台「测试」区分「凭证错误」与「上游无此接口」。
async function fetchStandardModels(provider) {
  const up = await requestUpstream(provider, '/v1/models', { method: 'GET' });
  if (!up.ok) {
    throw Object.assign(httpError(502, `provider「${provider.id}」拉取模型列表失败: HTTP ${up.status}`, 'models_fetch_failed'), { upStatus: up.status });
  }
  // 模型目录是小 JSON；上限 2MB——content-length 预检 + 无/非法长度（分块、gzip）边读边检
  // （readBodyLimited），防止失控响应被无界整读
  let body = null;
  try {
    body = JSON.parse((await readBodyLimited(up, 2 * 1024 * 1024, 'models_fetch_failed')).toString('utf8'));
  } catch (e) {
    if (e.code === 'models_fetch_failed') throw httpError(502, `provider「${provider.id}」模型目录响应异常: ${e.message}`, 'models_fetch_failed');
    // 读失败 / 非法 JSON：落到下方空列表报错（沿用旧行为）
  }
  const items = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const out = [];
  const seen = new Set();
  for (const m of items) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, title: m.display_name || m.title || m.id, contextLength: m.context_length ?? m.contextLength ?? null });
  }
  return out;
}

async function providerModels(provider) {
  const hit = cache.get(provider.id);
  if (hit && hit.providerObj === provider) {
    if (hit.models && Date.now() - hit.at < MODELS_TTL) return hit.models;
    if (hit.error && Date.now() - hit.at < ERROR_TTL) throw hit.error;
  }
  try {
    const models = provider.models.source === 'static'
      ? staticModels(provider)
      : provider.auth.type === 'cannwork-jwt-vk'
        ? await fetchCannworkCatalog(provider)
        : await fetchStandardModels(provider);
    if (!models.length) throw httpError(502, `provider「${provider.id}」模型列表为空`, 'models_fetch_failed');
    cache.set(provider.id, { providerObj: provider, at: Date.now(), models });
    return models;
  } catch (e) {
    cache.set(provider.id, { providerObj: provider, at: Date.now(), error: e });
    throw e;
  }
}

// 聚合目录：entries 各 provider 的成功/失败明细；byId 裸名路由（重名剔除）；
// conflicts 记录重名集合（/v1/models 里改名 `pid/model` 展示）。
async function getCatalog() {
  const config = getConfig();
  const providers = config.providers.filter((p) => p.enabled);
  const entries = await Promise.all(providers.map(async (p) => {
    try { return { p, models: await providerModels(p) }; }
    catch (e) { return { p, error: e }; }
  }));
  const byId = new Map();
  const conflicts = new Set();
  for (const { p, models } of entries) {
    if (!models) continue;
    for (const m of models) {
      if (p.models.exclude.has(m.id)) continue;
      if (byId.has(m.id)) conflicts.add(m.id);
      else byId.set(m.id, { provider: p, model: m.id });
    }
  }
  for (const id of conflicts) byId.delete(id);
  return { config, entries, byId, conflicts };
}

// 把请求里的 model 解析成 { provider, model }；查不到返回 null（由调用方回落默认上游）。
// `pid/model` 显式写法 > routing.aliases > 裸名唯一命中。
export async function resolveModelRoute(modelRaw) {
  if (!modelRaw || typeof modelRaw !== 'string') return null;
  const cat = await getCatalog();
  let model = modelRaw.trim();
  const alias = cat.config.routing.aliases[model];
  if (alias) model = alias;
  const slash = model.indexOf('/');
  if (slash > 0) {
    const pid = model.slice(0, slash);
    const p = cat.config.providers.find((x) => x.id === pid && x.enabled);
    if (p) return { provider: p, model: model.slice(slash + 1), explicit: true };
  }
  const hit = cat.byId.get(model);
  if (hit) return { provider: hit.provider, model: hit.model, explicit: false };
  return null;
}

// 未命中路由时的默认上游（配置 routing.defaultProvider，校验时已兜底为第一个）
export function defaultProvider() {
  const config = getConfig();
  return config.providers.find((p) => p.id === config.routing.defaultProvider && p.enabled)
    ?? config.providers.find((p) => p.enabled)
    ?? null;
}

// /v1/models 聚合：全部上游都失败才报错；部分失败照常返回可用的
export async function listModels() {
  const cat = await getCatalog();
  const okEntries = cat.entries.filter((e) => e.models);
  if (!okEntries.length) {
    const first = cat.entries.find((e) => e.error)?.error;
    throw first ?? httpError(502, '没有任何可用的上游模型目录', 'models_fetch_failed');
  }
  const data = [];
  for (const { p, models } of okEntries) {
    for (const m of models) {
      if (p.models.exclude.has(m.id)) continue;
      const id = cat.conflicts.has(m.id) ? `${p.id}/${m.id}` : m.id;
      data.push({ id, object: 'model', created: 0, owned_by: p.id, title: m.title, context_length: m.contextLength });
    }
  }
  return { object: 'list', data };
}

// healthz 用：只读缓存，不触发上游拉取
export function peekModelsKnown() {
  const config = getConfig();
  return config.providers.filter((p) => p.enabled).map((p) => {
    const hit = cache.get(p.id);
    return {
      id: p.id,
      count: hit?.models?.length ?? null,
      error: hit?.error ? String(hit.error.message) : null,
    };
  });
}

// 管理台「测试」按钮：绕过缓存现拉一次模型目录（停用的也可测，便于启用前验证）。
// source=static 的目录本身不触网，改用标准 GET /v1/models 探测端点与凭证；
// 探测结果只用于诊断展示，不回填路由缓存（路由以配置的静态列表为准）；
// 上游不提供该接口（404/405 等）不算失败，如实注明「未做线上验证」。
export async function checkProviderCatalog(provider) {
  const idsOf = (models) => models.slice(0, 12).map((m) => m.id);
  cache.delete(provider.id);
  if (provider.models.source === 'static') {
    try {
      const models = await fetchStandardModels(provider);
      return { ok: true, count: models.length, ids: idsOf(models), error: null, note: '端点与凭证可用（/v1/models）' };
    } catch (e) {
      if (e.upStatus === 401 || e.upStatus === 403) return { ok: false, count: null, ids: null, error: e.message };
      return { ok: true, count: null, ids: null, error: null, note: `上游无标准 /v1/models 接口，静态目录未做线上验证（${e.message}）` };
    }
  }
  try {
    const models = await providerModels(provider);
    return { ok: true, count: models.length, ids: idsOf(models), error: null, note: null };
  } catch (e) {
    return { ok: false, count: null, ids: null, error: e.message, note: null };
  }
}
