// 管理台的供应商配置读写（providers.json 的事实源操作）。
//
// 约定：
//   - 任何写操作 = 内存里改 raw → 整体校验（复用 config.mjs 归一化 + 防自环检查）
//     → 原子落盘（同目录 tmp + rename，0600）；校验不过不落盘，在线配置不受影响；
//   - 落盘后网关按 mtime 热加载（lib/config.mjs），无需重启；
//   - 凭证明文只存在于 providers.json；任何读视图只输出 tokenSet / tokenMask；
//   - 编辑时 auth.token 传空 = 沿用已存值（表单留空不覆盖）；但若同时填了
//     tokenEnv / tokenFile，视为切换凭证来源，清掉旧的内联 token。
import fs from 'node:fs';
import { CONFIG_FILE, validateRawConfig, builtinConfig } from './config.mjs';
import { httpError } from './util.mjs';
import { log } from './log.mjs';

const AUTH_KEYS = ['type', 'token', 'tokenEnv', 'tokenFile', 'tokenJsonPath', 'sessionFile', 'authJsonFile'];

function maskToken(t) {
  if (!t) return null;
  return t.length <= 8 ? '***' : `${t.slice(0, 4)}…${t.slice(-4)}`;
}

// 读当前 raw 配置。missing: 文件不存在（写入时从内置骨架创建）；error: 文件损坏（拒绝写入）。
function readRaw() {
  let text;
  try { text = fs.readFileSync(CONFIG_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { raw: null, missing: true };
    throw httpError(500, `providers.json 读取失败: ${e.message}`, 'config_read_failed');
  }
  try { return { raw: JSON.parse(text) }; }
  catch (e) { return { raw: null, error: `providers.json 不是合法 JSON: ${e.message}` }; }
}

// 防自我代理环路：providers 的 baseUrl 绝不能指向网关自身端口（见 CLAUDE.md 关键设计约束 3）
function assertNotSelfLoop(config, port) {
  for (const p of config.providers) {
    const urls = [p.baseUrl, ...(p.endpoints ? Object.values(p.endpoints) : [])];
    for (const rawUrl of urls) {
      const u = new URL(rawUrl); // 归一化已保证可解析
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const isLoop = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host);
      const targetPort = u.port || (u.protocol === 'https:' ? '443' : '80');
      if (isLoop && targetPort === String(port)) {
        throw httpError(400, `provider「${p.id}」的 baseUrl/endpoints 指向网关自身（${u.host}），会造成自我代理环路`, 'self_loop');
      }
    }
  }
}

function validateAndSave(raw, port) {
  const config = validateRawConfig(raw); // 复用加载期同一套校验，写坏配置不可能落盘
  assertNotSelfLoop(config, port);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600); // mode 只在新建时生效，显式再设一次
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw httpError(500, `providers.json 写入失败: ${e.message}`, 'config_write_failed');
  }
  log(`providers.json 已由管理台更新: ${config.providers.map((p) => p.id).join(', ')}（默认上游 ${config.routing.defaultProvider}）`);
}

// 静态模型列表：数组元素（string | {id,title}）或多行文本（每行 `id` 或 `id|标题`）
function parseStaticList(list) {
  const out = [];
  const seen = new Set();
  const push = (id, title) => {
    id = String(id || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const t = String(title || '').trim();
    out.push(t ? { id, title: t } : { id });
  };
  if (typeof list === 'string') {
    for (const line of list.split(/\n/)) {
      const [id, title] = line.split('|');
      push(id, title);
    }
  } else if (Array.isArray(list)) {
    for (const it of list) {
      if (typeof it === 'string') push(it);
      else if (it && typeof it === 'object') push(it.id, it.title);
    }
  }
  return out;
}

// 由请求 payload 构造 raw provider 条目。partial 语义：未提供的字段沿用 existing
// （existing 缺省即新建），未知字段一律不收；条目上用户手写的额外键在编辑时保留。
function buildRawProvider(payload, existing) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(400, '请求体不是 JSON 对象', 'bad_request');
  }
  const id = String(payload.id ?? existing?.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw httpError(400, `id 非法（字母/数字/连字符/下划线，字母数字开头）: ${id || '(空)'}`, 'bad_request');
  }
  const out = existing ? { ...existing } : { id };
  out.id = id;
  const name = String(payload.name ?? existing?.name ?? '').trim();
  out.name = name || id;

  const protocol = payload.protocol ?? existing?.protocol;
  if (protocol !== 'openai' && protocol !== 'anthropic') {
    throw httpError(400, 'protocol 必须是 openai 或 anthropic', 'bad_request');
  }
  out.protocol = protocol;

  const baseUrl = String(payload.baseUrl ?? existing?.baseUrl ?? '').trim();
  if (!baseUrl) throw httpError(400, 'baseUrl 不能为空', 'bad_request');
  out.baseUrl = baseUrl; // /v1 尾缀等归一化交给 config.mjs 统一处理

  // endpoints：按入站协议选直通 URL；显式传 null/空对象 = 清掉；省略则沿用
  if ('endpoints' in payload) {
    const src = payload.endpoints;
    if (src == null || (typeof src === 'object' && !Array.isArray(src) && !Object.keys(src).length)) {
      delete out.endpoints;
    } else if (typeof src === 'object' && !Array.isArray(src)) {
      const ep = {};
      for (const key of ['openai', 'anthropic']) {
        if (src[key] != null && String(src[key]).trim()) ep[key] = String(src[key]).trim();
      }
      if (Object.keys(ep).length) out.endpoints = ep;
      else delete out.endpoints;
    } else {
      throw httpError(400, 'endpoints 必须是对象（openai/anthropic → URL）', 'bad_request');
    }
  }

  // auth：只收白名单字段。token 留空 = 沿用；仅当用户主动改选了与旧值不同的 env/file
  // 凭证来源时才清内联值——编辑表单会把旧 tokenEnv/tokenFile 原样回传（回显未改动），
  // 不能当成切换信号，否则改任何字段保存都会静默丢掉已存 token。
  const src = payload.auth && typeof payload.auth === 'object' && !Array.isArray(payload.auth) ? payload.auth : {};
  const oldAuth = existing?.auth && typeof existing.auth === 'object' ? existing.auth : {};
  const auth = {};
  const newEnv = String(src.tokenEnv ?? '').trim();
  const newFile = String(src.tokenFile ?? '').trim();
  const oldEnv = String(oldAuth.tokenEnv ?? '').trim();
  const oldFile = String(oldAuth.tokenFile ?? '').trim();
  const switchingSource = (src.token == null || src.token === '')
    && Boolean((newEnv && newEnv !== oldEnv) || (newFile && newFile !== oldFile));
  for (const k of AUTH_KEYS) {
    if (k === 'type') continue;
    const v = src[k];
    if (k === 'token') {
      const keep = v == null || v === ''
        ? (switchingSource ? null : (oldAuth.token ?? null))
        : String(v);
      if (keep != null && keep !== '') auth.token = keep;
      continue;
    }
    const s = v == null ? '' : String(v).trim();
    if (s) auth[k] = s;
    else if (k in src) { /* 显式传空 = 清掉该字段 */ }
    else if (oldAuth[k] != null && String(oldAuth[k]).trim() !== '') auth[k] = oldAuth[k];
  }
  auth.type = src.type ?? oldAuth.type ?? (protocol === 'openai' ? 'cannwork-jwt-vk' : 'static-token');
  if (auth.type !== 'static-token' && auth.type !== 'cannwork-jwt-vk') {
    throw httpError(400, `auth.type 不支持: ${auth.type}（static-token / cannwork-jwt-vk）`, 'bad_request');
  }
  out.auth = auth;

  const m = payload.models && typeof payload.models === 'object' && !Array.isArray(payload.models) ? payload.models : {};
  const oldModels = existing?.models && typeof existing.models === 'object' ? existing.models : {};
  const source = m.source ?? oldModels.source ?? 'static';
  const models = { source: source === 'api' ? 'api' : 'static' };
  if (models.source === 'static') {
    models.list = m.list !== undefined ? parseStaticList(m.list) : parseStaticList(oldModels.list ?? []);
  } else if (Array.isArray(oldModels.list) && oldModels.list.length) {
    models.list = oldModels.list; // api 模式下保留静态列表，切回 static 时不丢
  }
  models.exclude = m.exclude !== undefined
    ? (Array.isArray(m.exclude) ? m.exclude.map(String) : [])
    : (Array.isArray(oldModels.exclude) ? oldModels.exclude.map(String) : []);
  out.models = models;

  out.streamUsage = payload.streamUsage ?? existing?.streamUsage ?? true;
  out.enabled = payload.enabled ?? existing?.enabled ?? true;
  return out;
}

// ---- 读视图（token 脱敏） ------------------------------------------------

function viewAuth(rawAuth) {
  const a = rawAuth && typeof rawAuth === 'object' ? rawAuth : {};
  const pick = (k) => (a[k] != null && String(a[k]).trim() !== '' ? String(a[k]) : null);
  const token = pick('token');
  return {
    type: a.type ?? null,
    tokenSet: token != null,
    tokenMask: maskToken(token),
    tokenEnv: pick('tokenEnv'),
    tokenFile: pick('tokenFile'),
    tokenJsonPath: pick('tokenJsonPath'),
    sessionFile: pick('sessionFile'),
    authJsonFile: pick('authJsonFile'),
  };
}

export function providersView() {
  const { raw, missing, error } = readRaw();
  const src = raw ?? builtinConfig();
  const providers = (Array.isArray(src.providers) ? src.providers : []).map((p) => {
    const m = p?.models && typeof p.models === 'object' ? p.models : {};
    return {
      id: p?.id ?? '?',
      name: p?.name ?? p?.id ?? '?',
      protocol: p?.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: p?.baseUrl ?? '',
      endpoints: (p?.endpoints && typeof p.endpoints === 'object') ? {
        ...(p.endpoints.openai ? { openai: String(p.endpoints.openai) } : {}),
        ...(p.endpoints.anthropic ? { anthropic: String(p.endpoints.anthropic) } : {}),
      } : undefined,
      enabled: p?.enabled !== false,
      streamUsage: p?.streamUsage !== false,
      auth: viewAuth(p?.auth),
      models: {
        source: m.source === 'static' ? 'static' : 'api',
        list: Array.isArray(m.list) ? m.list : [],
        exclude: Array.isArray(m.exclude) ? m.exclude : [],
      },
    };
  });
  const ids = providers.map((p) => p.id);
  const wanted = src.routing?.defaultProvider;
  return {
    file: CONFIG_FILE,
    fileExists: !missing,
    error: error ?? null,
    gateway: {
      clientTokenSet: Boolean(src.gateway?.clientToken),
      upstreamHeadersTimeoutMs: src.gateway?.upstreamHeadersTimeoutMs ?? null,
    },
    routing: {
      defaultProvider: ids.includes(wanted) ? wanted : (ids[0] ?? null),
      aliases: src.routing?.aliases && typeof src.routing.aliases === 'object' ? src.routing.aliases : {},
    },
    providers,
  };
}

// ---- 增 / 改 / 删 --------------------------------------------------------

export function createProvider(payload, { port }) {
  const { raw, missing, error } = readRaw();
  if (error) throw httpError(500, `${error}（先人工修复再通过管理台写入）`, 'config_invalid');
  const base = raw ?? builtinConfig();
  const entry = buildRawProvider(payload, null);
  base.providers = Array.isArray(base.providers) ? base.providers : [];
  if (base.providers.some((p) => p?.id === entry.id)) {
    throw httpError(409, `provider「${entry.id}」已存在`, 'conflict');
  }
  base.providers.push(entry);
  base.routing = base.routing && typeof base.routing === 'object' ? base.routing : {};
  validateAndSave(base, port);
  return { id: entry.id, note: missing ? 'providers.json 原不存在，已按内置默认配置新建（含 cannbot 上游）' : null };
}

export function updateProvider(id, payload, { port }) {
  const { raw, error } = readRaw();
  if (error) throw httpError(500, `${error}（先人工修复再通过管理台写入）`, 'config_invalid');
  if (!raw) throw httpError(500, 'providers.json 不存在，无法编辑（请先添加）', 'config_missing');
  const list = Array.isArray(raw.providers) ? raw.providers : [];
  const idx = list.findIndex((p) => p?.id === id);
  if (idx < 0) throw httpError(404, `provider「${id}」不存在`, 'not_found');
  if (payload?.id != null && payload.id !== id) {
    throw httpError(400, `id 不可修改（路径为 ${id}，请求体为 ${payload.id}）`, 'bad_request');
  }
  list[idx] = buildRawProvider(payload, list[idx]);
  validateAndSave(raw, port);
  return { note: null };
}

export function deleteProvider(id, { port }) {
  const { raw, error } = readRaw();
  if (error) throw httpError(500, `${error}（先人工修复再通过管理台写入）`, 'config_invalid');
  if (!raw) throw httpError(500, 'providers.json 不存在，无法删除', 'config_missing');
  const list = Array.isArray(raw.providers) ? raw.providers : [];
  const idx = list.findIndex((p) => p?.id === id);
  if (idx < 0) throw httpError(404, `provider「${id}」不存在`, 'not_found');
  if (list.length <= 1) throw httpError(400, '至少保留一个 provider（providers.json 不允许为空）', 'bad_request');
  list.splice(idx, 1);
  raw.routing = raw.routing && typeof raw.routing === 'object' ? raw.routing : {};
  const notes = [];
  if (raw.routing.defaultProvider === id) {
    raw.routing.defaultProvider = list[0]?.id;
    notes.push(`默认上游已改为「${list[0]?.id}」`);
  }
  // 清掉指向该 pid 的别名，避免残留死引用（模型名会回落默认上游，行为可预测）
  const aliases = raw.routing.aliases && typeof raw.routing.aliases === 'object' ? raw.routing.aliases : {};
  for (const [k, v] of Object.entries(aliases)) {
    if (String(v).split('/')[0] === id) delete aliases[k];
  }
  validateAndSave(raw, port);
  return { note: notes.join('；') || null };
}
