// CANNWork (cannbot) 上游的凭证链：JWT + VK。
//
// 登录与凭证签发全部由外部 VSCode 扩展（CANNWork）完成，代理是被动的凭证消费者：
//   JWT ← ~/.local/share/opencode/session.json .accessToken（CANNWork 扩展登录时刷新，24h 有效）
//   VK  ← ① ~/.local/share/opencode/auth.json .cannbot.key（CANNWork 2.0.2+ 登录时写入，官方位置）
//         ② GET /cannbot/api/ai-keys/vk/my（JWT 换取，权威来源，附带配额与模型白名单）
//         ③ GET /cannbot/api/models/personal 各模型自带的 apiKey（遗留接口兜底）
//         常规顺序: 内存/磁盘缓存 → ① → ② → ③；上游 401 后跳过缓存从 ② 开始重取
// 模型目录 ← GET /cannbot/api/models/list（2.0.2+ 官方接口，仅取 status=1）；
//         不可用时回落遗留接口 /cannbot/api/models/personal
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError, b64urlJson } from '../util.mjs';
import { log } from '../log.mjs';

const SCRIPT_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const VK_CACHE = process.env.CANNBOT_VK_CACHE || path.join(SCRIPT_DIR, 'vk-cache.json');
const MODELS_TTL = 10 * 60 * 1000;

function sessionFileOf(provider) {
  return provider.auth.sessionFile
    || process.env.CANNBOT_SESSION_FILE
    || path.join(os.homedir(), '.local/share/opencode/session.json');
}
function authJsonFileOf(provider) {
  return provider.auth.authJsonFile
    || process.env.CANNBOT_AUTH_FILE
    || path.join(os.homedir(), '.local/share/opencode/auth.json');
}
// 管理类接口（ai-keys/models）在站点根域，与推理 baseUrl 同源
function originOf(provider) {
  return new URL(provider.baseUrl).origin;
}

function readJwt(provider) {
  const file = sessionFileOf(provider);
  if (!fs.existsSync(file)) {
    throw httpError(502, `未找到 ${file}：请打开 VSCode 的 CANNWork 扩展并登录 CANN 账号`, 'jwt_missing');
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw httpError(502, `session.json 解析失败: ${e.message}`, 'jwt_invalid'); }
  const jwt = raw.accessToken;
  if (!jwt) throw httpError(502, 'session.json 中没有 accessToken：请在 CANNWork 扩展中重新登录', 'jwt_missing');
  const payload = b64urlJson(jwt) || {};
  const expMs = (payload.exp || 0) * 1000;
  if (expMs && Date.now() > expMs - 60_000) {
    throw httpError(502,
      `CANNBot JWT 已于 ${new Date(expMs).toLocaleString('zh-CN')} 过期：请打开 CANNWork 扩展重新登录，然后重试`,
      'jwt_expired');
  }
  return { jwt, userId: payload.userId, expMs };
}

// 凭证缓存。VK 与模型列表来源不同、更新时机不同，分开存放：
//   vk/vkSource/vkQuota  账号级虚拟密钥及其来源与配额（配额仅 VK 接口网络换取时才有）
//   models/modelsAt      模型列表（TTL 见 MODELS_TTL）
let personalCache = null; // { userId, vk, vkAt, vkSource, vkQuota, models, modelsAt }

function cacheOf(userId) {
  if (personalCache?.userId !== userId) {
    personalCache = { userId, vk: null, vkAt: 0, vkSource: null, vkQuota: null, models: null, modelsAt: 0 };
  }
  return personalCache;
}

function readVkDisk(userId) {
  try {
    const d = JSON.parse(fs.readFileSync(VK_CACHE, 'utf8'));
    if (d.userId === userId && d.vk) return d.vk;
  } catch {}
  return null;
}

function rememberVk(userId, vk, source, quota = null) {
  const c = cacheOf(userId);
  c.vk = vk;
  c.vkAt = Date.now();
  c.vkSource = source;
  if (quota) c.vkQuota = quota;
  try {
    fs.writeFileSync(VK_CACHE, JSON.stringify({ userId, vk, at: c.vkAt }), { mode: 0o600 });
    fs.chmodSync(VK_CACHE, 0o600); // 含实时凭证，与 providers.json 同标准 0600（writeFileSync 的 mode 仅新建时生效）
  } catch {}
  return vk;
}

// VK 来源①：~/.local/share/opencode/auth.json（CANNWork 2.0.2+ 登录时经
// /cannbot/api/ai-keys/vk/my 换取后写入；扩展自己发请求也读这里，本代理与其同源）
function readVkAuthJson(provider) {
  try {
    const d = JSON.parse(fs.readFileSync(authJsonFileOf(provider), 'utf8'));
    const vk = d?.cannbot?.key;
    return typeof vk === 'string' && vk ? vk : null;
  } catch { return null; }
}

// 管理类接口（换取 VK / 模型列表）的超时：这些是凭证链的旁路请求，不能让站点
// 卡死拖住主请求——15s 足够覆盖正常往返（推理请求的超时由 upstream.mjs 单独管理）
const ADMIN_API_TIMEOUT_MS = 15_000;

// VK 来源②：GET /cannbot/api/ai-keys/vk/my（JWT 换取的权威来源，附带配额与模型白名单）
async function fetchVkApi(provider, jwt) {
  const res = await fetch(`${originOf(provider)}/cannbot/api/ai-keys/vk/my`, {
    headers: { authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(ADMIN_API_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null))?.data;
  if (!data?.vk) return null;
  return {
    vk: data.vk,
    quota: {
      dailyQuota: data.dailyQuota ?? null,
      monthlyQuota: data.monthlyQuota ?? null,
      priority: data.priority ?? null,
      modelAllowList: data.modelAllowList ?? null,
    },
  };
}

// 模型列表（官方，CANNWork 2.0.2+ 同源）：GET /cannbot/api/models/list，
// 裸分页结构（无 success/data 包装），status=1 为启用。每页 100 逐页拉全，
// 安全上限 10 页（1000 个模型，防异常分页死循环）；首页失败交遗留接口兜底，
// 翻页中途失败用已取到的（目录 TTL 会在下轮补齐）。
async function fetchModelsList(provider, jwt) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const url = new URL(`${originOf(provider)}/cannbot/api/models/list`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', '100');
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(ADMIN_API_TIMEOUT_MS),
    });
    if (!res.ok) return items.length ? items : null;
    const body = await res.json().catch(() => null);
    const list = Array.isArray(body?.models) ? body.models : [];
    items.push(...list.filter((m) => m?.model && m.status === 1));
    if (list.length < 100) break; // 最后一页
  }
  return items.length ? items : null;
}

// 模型列表 + VK（遗留）：GET /cannbot/api/models/personal，
// personal/builtin 两列各带 apiKey。接口仍可用但已不在官方代码路径上，仅兜底。
async function fetchModelsPersonal(provider, jwt) {
  const res = await fetch(`${originOf(provider)}/cannbot/api/models/personal`, {
    headers: { authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(ADMIN_API_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const items = [...(body?.data?.personalModels ?? []), ...(body?.data?.builtinModels ?? [])]
    .filter((m) => m?.model);
  return items.length ? items : null;
}

// VK 解析。常规顺序: 内存 → 磁盘 vk-cache → auth.json → VK 接口 → 遗留接口；
// force（上游 401 后）跳过所有本地缓存，网络权威来源优先: VK 接口 → auth.json → 遗留接口。
async function getVk(provider, jwt, userId, force = false) {
  if (!force) {
    if (personalCache?.userId === userId && personalCache.vk) {
      probeQuotaBackground(provider, jwt, userId);
      return personalCache.vk;
    }
    const disk = readVkDisk(userId);
    if (disk) {
      const c = cacheOf(userId); // 保留同用户已取到的 models，避免无谓重取
      c.vk = disk; c.vkAt = Date.now(); c.vkSource = 'cache';
      probeQuotaBackground(provider, jwt, userId);
      return disk;
    }
    const authVk = readVkAuthJson(provider);
    if (authVk) {
      const vk = rememberVk(userId, authVk, 'auth.json');
      probeQuotaBackground(provider, jwt, userId);
      return vk;
    }
  }
  const api = await fetchVkApi(provider, jwt).catch(() => null);
  if (api?.vk) return rememberVk(userId, api.vk, 'ai-keys', api.quota);
  const authVk = readVkAuthJson(provider);
  if (authVk) return rememberVk(userId, authVk, 'auth.json');
  const legacyItems = await fetchModelsPersonal(provider, jwt).catch(() => null);
  const legacyVk = legacyItems?.map((m) => m.apiKey).find(Boolean) ?? null;
  if (legacyVk) return rememberVk(userId, legacyVk, 'legacy-models');
  throw httpError(502,
    '无法获取 VK：auth.json / ai-keys 接口 / 遗留模型接口均未取到（JWT 可能已失效，请在 CANNWork 扩展重新登录）',
    'vk_fetch_failed');
}

// VK 取自 auth.json/缓存时没有配额信息。每个进程生命周期后台补查一次 ai-keys 接口：
// 拿到配额供管理台展示，顺带与权威来源核对——本地 VK 过期(如扩展长期未重登)时采纳接口值自愈。
let quotaProbing = false;
function probeQuotaBackground(provider, jwt, userId) {
  if (quotaProbing || (personalCache?.userId === userId && personalCache.vkQuota)) return;
  quotaProbing = true;
  fetchVkApi(provider, jwt)
    .then((r) => {
      if (!r?.vk || personalCache?.userId !== userId) return;
      if (personalCache.vk === r.vk) {
        personalCache.vkQuota = r.quota; // 同一把 VK：只补配额
      } else {
        const from = personalCache.vkSource;
        rememberVk(userId, r.vk, 'ai-keys', r.quota);
        log(`VK 与 ai-keys 接口不一致（本地来源 ${from}），已采纳接口值`);
      }
    })
    .catch(() => {})
    .finally(() => { quotaProbing = false; });
}

// 鉴权解析器：每次请求现读 JWT（扩展登录后立即生效，无需重启），
// refresh() 供上游 401 时跳过缓存强制重取 VK。
export function createCannworkAuth(provider) {
  return {
    async headers() {
      const { jwt, userId } = readJwt(provider);
      const vk = await getVk(provider, jwt, userId);
      return { authorization: `Bearer ${jwt}`, 'x-api-vkey': vk };
    },
    async refresh() {
      const { jwt, userId } = readJwt(provider);
      const vk = await getVk(provider, jwt, userId, true);
      return { authorization: `Bearer ${jwt}`, 'x-api-vkey': vk };
    },
    status() {
      try {
        const { userId, expMs } = readJwt(provider);
        return {
          jwt: { ok: true, userId, expiresAt: new Date(expMs).toISOString(), expired: false },
          vkCached: Boolean(personalCache?.vk),
          vkCachedAt: personalCache?.vk ? new Date(personalCache.vkAt).toISOString() : null,
          vkSource: personalCache?.vkSource ?? null,
          vkQuota: personalCache?.vkQuota ?? null,
        };
      } catch (e) {
        return { jwt: { ok: false, error: e.message }, vkCached: Boolean(personalCache?.vk), vkSource: personalCache?.vkSource ?? null, vkQuota: personalCache?.vkQuota ?? null };
      }
    },
  };
}

// 模型目录：官方 /models/list 优先（与 CANNWork 2.0.2+ 扩展同源），遗留 /models/personal 兜底。
// 返回 [{ id, title, contextLength }]（去重后），TTL 缓存与排除由 models.mjs 统一处理。
export async function fetchCatalog(provider) {
  const { jwt, userId } = readJwt(provider);
  if (personalCache?.userId === userId && personalCache.models?.length
      && Date.now() - personalCache.modelsAt < MODELS_TTL) {
    return personalCache.models;
  }
  let items = await fetchModelsList(provider, jwt).catch(() => null);
  if (!items) items = await fetchModelsPersonal(provider, jwt).catch(() => null);
  if (!items) {
    throw httpError(502,
      '拉取模型列表失败: /models/list 与 /models/personal 均不可用（JWT 可能已失效，请在 CANNWork 扩展重新登录）',
      'models_fetch_failed');
  }
  const seen = new Map();
  for (const m of items) {
    if (!m?.model || seen.has(m.model)) continue;
    seen.set(m.model, { id: m.model, title: m.title || m.model, contextLength: m.contextLength ?? null });
  }
  const models = [...seen.values()];
  const c = cacheOf(userId); // 保留已有的 vk，只更新 models
  c.models = models;
  c.modelsAt = Date.now();
  return models;
}
