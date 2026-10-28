// providers.json 配置层：加载、校验、按 mtime 热重载。
//
// 配置文件默认在 server.mjs 同目录（运行时副本目录），测试可用 CANNBOT_CONFIG_FILE 覆盖。
// 文件含全部订阅凭证，权限 0600，绝不入版本库。文件缺失时回退到内置的 cannbot 单上游
// 配置（保持与旧版行为兼容），服务仍可启动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError } from './util.mjs';
import { log } from './log.mjs';

const SCRIPT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONFIG_FILE = process.env.CANNBOT_CONFIG_FILE || path.join(SCRIPT_DIR, 'providers.json');

const PROTOCOLS = new Set(['openai', 'anthropic']);
const AUTH_TYPES = new Set(['cannwork-jwt-vk', 'static-token']);

// 文件缺失时的兜底：等价于旧版单上游 cannbot 代理（无客户端鉴权）。
// 也导出给 providers-admin.mjs：providers.json 不存在时按此骨架新建。
export function builtinConfig() {
  return {
    version: 1,
    gateway: {},
    providers: [
      {
        id: 'cannbot',
        name: 'CANNWork',
        baseUrl: 'https://cannbot.hicann.cn/gateway/compatible-mode',
        protocol: 'openai',
        auth: { type: 'cannwork-jwt-vk' },
        models: { source: 'api', list: [], exclude: [] },
        streamUsage: true,
      },
    ],
    routing: {},
  };
}

// baseUrl 统一为「不含 /v1 后缀」的形态：请求时由代码补 '/v1/chat/completions'
// 或 '/v1/messages'。用户按上游文档粘贴的 https://host/.../v1 会自动去掉尾部 /v1。
function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (u.endsWith('/v1')) u = u.slice(0, -3);
  if (!/^https?:\/\//.test(u)) throw httpError(500, `providers.json baseUrl 必须以 http(s):// 开头: ${raw}`, 'bad_config');
  return u;
}

function normalizeProvider(raw, idx) {
  const where = `providers[${idx}]`;
  if (!raw || typeof raw !== 'object') throw httpError(500, `${where} 不是对象`, 'bad_config');
  const id = String(raw.id || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw httpError(500, `${where}.id 非法（字母数字连字符）: ${id}`, 'bad_config');
  const protocol = raw.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const auth = raw.auth && typeof raw.auth === 'object' ? raw.auth : {};
  const type = String(auth.type || (protocol === 'openai' ? 'cannwork-jwt-vk' : 'static-token'));
  if (!AUTH_TYPES.has(type)) throw httpError(500, `${where}.auth.type 不支持: ${type}`, 'bad_config');
  const models = raw.models && typeof raw.models === 'object' ? raw.models : {};
  const exclude = new Set([
    ...(Array.isArray(models.exclude) ? models.exclude : []),
    ...(process.env.CANNBOT_EXCLUDE_MODELS ?? '').split(',').filter(Boolean),
  ]);
  return {
    id,
    name: String(raw.name || id),
    protocol,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    auth: {
      type,
      token: auth.token != null ? String(auth.token) : undefined,
      tokenEnv: auth.tokenEnv != null ? String(auth.tokenEnv) : undefined,
      tokenFile: auth.tokenFile != null ? String(auth.tokenFile) : undefined,
      tokenJsonPath: auth.tokenJsonPath != null ? String(auth.tokenJsonPath) : undefined,
      sessionFile: auth.sessionFile != null ? String(auth.sessionFile) : undefined,
      authJsonFile: auth.authJsonFile != null ? String(auth.authJsonFile) : undefined,
    },
    models: {
      source: models.source === 'static' ? 'static' : 'api',
      list: Array.isArray(models.list) ? models.list : [],
      exclude,
    },
    streamUsage: raw.streamUsage !== false,
    enabled: raw.enabled !== false,
  };
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw httpError(500, 'providers.json 缺少 providers 数组或为空', 'bad_config');
  }
  const providers = raw.providers.map(normalizeProvider);
  const ids = providers.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw httpError(500, `providers.json 存在重复的 provider id`, 'bad_config');
  const gateway = raw.gateway && typeof raw.gateway === 'object' ? raw.gateway : {};
  const routing = raw.routing && typeof raw.routing === 'object' ? raw.routing : {};
  const defaultProvider = routing.defaultProvider && ids.includes(routing.defaultProvider)
    ? routing.defaultProvider
    : ids[0];
  return {
    version: 1,
    file: CONFIG_FILE,
    gateway: {
      clientToken: gateway.clientToken != null && gateway.clientToken !== '' ? String(gateway.clientToken) : null,
      upstreamHeadersTimeoutMs: Number(gateway.upstreamHeadersTimeoutMs) > 0 ? Number(gateway.upstreamHeadersTimeoutMs) : 180_000,
      // 请求体上限与端口：均为启动时读取（热加载不重算，改了需重启生效），
      // server.mjs / proxy-anthropic.mjs 处对 null 再兜底默认 32MB / 8484
      maxBodyMB: Number(gateway.maxBodyMB) > 0 ? Number(gateway.maxBodyMB) : null,
      port: Number.isInteger(Number(gateway.port)) && Number(gateway.port) >= 1 && Number(gateway.port) <= 65535 ? Number(gateway.port) : null,
    },
    providers,
    routing: { defaultProvider, aliases: routing.aliases && typeof routing.aliases === 'object' ? routing.aliases : {} },
    pricing: normalizePricing(raw.pricing),
    monitors: normalizeMonitors(raw.monitors),
    workbench: normalizeWorkbench(raw.workbench),
  };
}

// 个人工作台：报告生成用的模型设置 { reportProvider, reportModel }，生成时按
// 兜底链解析（见 lib/report/generate.mjs）。纯行为字段，getConfig 现读即热生效。
// 非法值静默跳过，不阻塞配置加载（凭证链是主业务）。
function normalizeWorkbench(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of ['reportProvider', 'reportModel']) {
    const v = raw[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

// 费用单价覆盖表：{ "模型名" | "pid/模型名": { input, output } }（美元 / 1M tokens）。
// 非法条目静默跳过，不阻塞配置加载。
function normalizePricing(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    const input = Number(v.input ?? v.in);
    const output = Number(v.output ?? v.out);
    if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
      out[String(key).trim()] = { input, output };
    }
  }
  return out;
}

// 显示器输入源切换配置（m1ddc/DDC，见 lib/monitors.mjs）。网关不预设语义，只记硬件事实
// 与用户起的名字：
//   { inputs: [{ value: VCP60 值, name? }], list: [{ uuid, name? }] }
// name 留空 = 界面显示编号（输入显示「输入 15」，屏显示 UUID 前 8 位）。inputs 也可写成
// 纯数字数组 [15, 21]（等价于无 name）。声明顺序即界面按钮顺序。
//
// 兼容旧形态：inputs 为对象 { 名字: 值 }、list 条目带 id。旧的语义键名（mac/windows）
// 与旧 id（left/right）都丢弃——它们由旧 schema 规定、不是用户自由命名，而正是这层
// 语义被用反了；迁移后界面回到编号，用户再按自己的叫法填 name。
// 非法条目静默跳过，不阻塞配置加载（凭证链是主业务）。
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

// 内置默认（本机实测两台 AOC Q27P2G5 的 System UUID 与真机校准过的 VCP 值表）。
// name 一律留空＝界面显示编号，用户在管理台或 providers.json 里按自己的叫法填。
// monitors 节缺失时用它兜底；管理台改名时也用它播种（否则默认配置下改名无处可写）。
export function defaultMonitors() {
  return {
    inputs: [{ value: 15, name: '' }, { value: 21, name: '' }],
    list: [
      { uuid: 'A016429F-BCEC-4FAF-BD7D-23128391F7F1', name: '' },
      { uuid: 'F2F948D6-2F40-4DEC-8EF8-2E158BFF4328', name: '' },
    ],
    // 默认热键（用户已确认的绑定）：F13→输入15、F14→输入21。可在管理台改绑。
    hotkeys: [{ input: 15, key: 'f13' }, { input: 21, key: 'f14' }],
  };
}

export function normalizeMonitors(raw) {
  const out = { inputs: [], list: [], hotkeys: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  const seenInput = new Set();
  const pushInput = (value, name) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 255 || seenInput.has(n)) return;
    seenInput.add(n);
    out.inputs.push({ value: n, name: String(name ?? '').trim() });
  };
  if (Array.isArray(raw.inputs)) {
    for (const it of raw.inputs) {
      if (it && typeof it === 'object') pushInput(it.value ?? it.input, it.name);
      else pushInput(it, ''); // 纯数字写法
    }
  } else if (raw.inputs && typeof raw.inputs === 'object') {
    // 旧形态 { mac: 15, windows: 21 }：键名是旧 schema 规定的语义（不是用户自由命名），
    // 而正是那层语义被用反了。只迁值、弃名，界面回到编号，用户再按自己的叫法填。
    for (const v of Object.values(raw.inputs)) pushInput(v, '');
  }

  const seenUuid = new Set();
  for (const it of Array.isArray(raw.list) ? raw.list : []) {
    const uuid = String((typeof it === 'string' ? it : it?.uuid) || '').trim().toUpperCase();
    if (!UUID_RE.test(uuid) || seenUuid.has(uuid)) continue;
    seenUuid.add(uuid);
    const name = typeof it === 'string' ? '' : String(it?.name || '').trim();
    out.list.push({ uuid, name });
  }

  // 系统级热键：[{ input: VCP 值, key: 'f13' | 'cmd+opt+w' … }]。key 用稳定小写记号、
  // 加号组合修饰键（热键守护解析层预留任意组合，不止 F 键）。非法条目静默跳过；
  // 同 input 或同 key 重复取首个。未写 hotkeys 节 → 播种默认（F13→输入15 / F14→输入21），
  // 显式空数组 = 不绑（管理台可清空）。
  const KEY_RE = /^[a-z]+[a-z0-9]*(\+[a-z]+[a-z0-9]*)*$/;
  if (Array.isArray(raw.hotkeys)) {
    const seenInput = new Set();
    const seenKey = new Set();
    for (const it of raw.hotkeys) {
      if (!it || typeof it !== 'object') continue;
      const input = Number(it.input);
      const key = String(it.key ?? '').trim().toLowerCase();
      if (!Number.isInteger(input) || input < 1 || input > 255) continue;
      if (!KEY_RE.test(key) || key.length > 32 || seenInput.has(input) || seenKey.has(key)) continue;
      seenInput.add(input);
      seenKey.add(key);
      out.hotkeys.push({ input, key });
    }
  } else {
    out.hotkeys = defaultMonitors().hotkeys.map((h) => ({ ...h }));
  }
  return out;
}

// 供管理台写入前校验：与加载期同一套归一化规则，坏配置在落盘前就被拦下。
export function validateRawConfig(raw) {
  return normalizeConfig(raw);
}

let cached = null; // { mtimeMs, size, config }

export function getConfig() {
  let st;
  try { st = fs.statSync(CONFIG_FILE); } catch { st = null; }
  if (!st) {
    // 文件缺失：回退内置配置（只 Warn 一次，避免每请求刷屏）
    if (!cached || cached.config !== undefined) {
      if (!cached?.builtinWarned) {
        log(`警告: 未找到 ${CONFIG_FILE}，使用内置默认配置（仅 cannbot 上游，无客户端鉴权）`);
      }
      // 与文件加载同一套 normalize（补 enabled 等默认字段）：否则 healthz 的
      // providers 过滤（p.enabled）会把内置 cannbot 隐形掉，与「回落仅 cannbot」的
      // 启动警告文案和 README 描述相矛盾
      cached = { config: normalizeConfig(builtinConfig()), builtinWarned: true };
    }
    return cached.config;
  }
  if (cached && !cached.builtinWarned && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.config;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) {
    if (cached?.config && !cached.builtinWarned) {
      log(`providers.json 解析失败（沿用上次配置）: ${e.message}`);
      cached.mtimeMs = st.mtimeMs; cached.size = st.size; // 避免每请求重复解析报错
      return cached.config;
    }
    throw httpError(500, `providers.json 解析失败: ${e.message}`, 'bad_config');
  }
  const config = normalizeConfig(raw);
  cached = { mtimeMs: st.mtimeMs, size: st.size, config };
  log(`已加载 providers.json: ${config.providers.map((p) => p.id).join(', ')}`
    + `（默认上游 ${config.routing.defaultProvider}${config.gateway.clientToken ? '，客户端鉴权已启用' : '，未配置客户端鉴权'}）`);
  return config;
}

export function getProvider(id) {
  return getConfig().providers.find((p) => p.id === id) ?? null;
}

// 供 healthz/管理台展示：不抛错，坏配置降级为空
export function tryGetConfig() {
  try { return getConfig(); } catch (e) { return { error: e.message, providers: [], gateway: {}, routing: {}, pricing: {}, workbench: {} }; }
}
