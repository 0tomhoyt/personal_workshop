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
import { parseCidr } from './tv-net.mjs';

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

// providers[].quota.kind 的合法取值（与 lib/quota.mjs 的 detectQuotaKind 保持一致）
const QUOTA_KINDS = new Set(['kimi', 'zhipu', 'none']);

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
  let endpoints;
  if (raw.endpoints && typeof raw.endpoints === 'object' && !Array.isArray(raw.endpoints)) {
    const ep = {};
    for (const key of ['openai', 'anthropic']) {
      if (raw.endpoints[key] != null && String(raw.endpoints[key]).trim()) {
        ep[key] = normalizeBaseUrl(raw.endpoints[key]);
      }
    }
    if (Object.keys(ep).length) endpoints = ep;
  }
  return {
    id,
    name: String(raw.name || id),
    protocol,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    // 额度查询方式的显式覆盖（见 lib/quota.mjs）。正常按 baseUrl 的 host 自动识别，
    // 这个键给「自动认不出 / 想关掉」的情况留口子。非法值静默丢弃，不阻塞配置加载。
    ...(QUOTA_KINDS.has(raw?.quota?.kind) ? { quota: { kind: raw.quota.kind } } : {}),
    endpoints,
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
    tv: normalizeTv(gateway.tv, gateway.clientToken != null && gateway.clientToken !== '' ? String(gateway.clientToken) : null),
    sync: normalizeSync(gateway.sync, gateway.clientToken != null && gateway.clientToken !== '' ? String(gateway.clientToken) : null, gateway.tv),
    syncClient: normalizeSyncClient(gateway.syncClient),
  };
}

// 电视工作台（设计稿 §6.2 B1）：主监听 8484 一行不动，另起一个只挂白名单路由的
// LAN 监听，数据由同进程直接调 listTodos() / statsSnapshot() 聚合。
//
//   gateway.tv = {
//     enabled: false,                 // 默认关闭；false 或 tokens 为空 → 完全不监听
//     port: 8490,
//     bind: '0.0.0.0',                // 只绑 LAN 网卡；不要填 127.0.0.1（电视够不到）
//     tokens: [{ name, token }],      // 每台电视一枚，独立于 gateway.clientToken
//     allowedCidrs: [...],            // 来源地址白名单（默认三个私网段 + 回环，回环供本机自检）
//     cacheSeconds: 5,                // 响应头 Cache-Control 提示；快照本身每次现算
//     maxPerMinute: 30,               // 每 token 每分钟请求上限
//   }
//
// 非法条目静默跳过，不阻塞配置加载（凭证链是主业务）；enabled 的真实监听状态在启动时
// 读取（改 enabled 需重启），tokens / allowedCidrs 每请求现读（吊销即时生效）。
export const TV_DEFAULT_CIDRS = ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '127.0.0.1/32', '::1/128'];

export function normalizeTv(raw, clientToken = null) {
  const out = {
    enabled: false,
    port: 8490,
    bind: '0.0.0.0',
    tokens: [],
    allowedCidrs: TV_DEFAULT_CIDRS.slice(),
    cacheSeconds: 5,
    maxPerMinute: 30,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  out.enabled = raw.enabled === true;
  const port = Number(raw.port);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) out.port = port;
  const bind = typeof raw.bind === 'string' ? raw.bind.trim() : '';
  if (bind) out.bind = bind;
  const seen = new Set();
  for (const it of Array.isArray(raw.tokens) ? raw.tokens : []) {
    const name = String((typeof it === 'string' ? '' : it?.name) || '').trim();
    const token = String((typeof it === 'string' ? it : it?.token) || '').trim();
    // 空 token / 重复 token 一律跳过：重复会让「按台吊销」失去意义
    if (!token || seen.has(token)) continue;
    // 与主监听 clientToken 相同的一律拒绝：那串能给电视拿到的就是全部模型调用权限，
    // 而电视会在明文 LAN 上持有它。宁可少一个 token，也不能悄悄共用。
    if (clientToken && token === clientToken) {
      log(`警告: gateway.tv.tokens 中「${name || '未命名'}」与 gateway.clientToken 相同，已忽略`);
      continue;
    }
    seen.add(token);
    out.tokens.push({ name: name.slice(0, 40) || `tv${out.tokens.length + 1}`, token });
  }
  // 用与请求匹配同一套解析校验：笔误（999.999.999.999/8、abc/8）不会悄悄落进白名单、
  // 再让所有来源被拒（那种「配错了反而全不通」最难查）。
  const cidrs = (Array.isArray(raw.allowedCidrs) ? raw.allowedCidrs : [])
    .map((c) => String(c || '').trim())
    .filter((c) => parseCidr(c) !== null);
  if (cidrs.length) out.allowedCidrs = [...new Set(cidrs)];
  const cache = Number(raw.cacheSeconds);
  if (Number.isInteger(cache) && cache >= 0 && cache <= 3600) out.cacheSeconds = cache;
  const limit = Number(raw.maxPerMinute);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 6000) out.maxPerMinute = limit;
  return out;
}


// Mac↔Mac 同步（gateway.sync）：主监听 / TV 监听不动，另起只挂 /sync/v1/* 的监听。
//
//   gateway.sync = {
//     enabled: false,                 // 默认关闭；false 或 tokens 为空 → 完全不监听
//     port: 8491,
//     bind: '0.0.0.0',                // 枢纽机对 LAN / Tailscale 可达；不要只绑 127.0.0.1
//     tokens: [{ name, token }],      // 每台客户机一枚，独立于 clientToken / TV tokens
//     allowedCidrs: [...],            // 默认私网 + 回环 + Tailscale CGNAT (100.64.0.0/10)
//     maxPerMinute: 120,              // 同步轮询可比 TV 稍高
//   }
//
// enabled/port/bind 启动时读；tokens / allowedCidrs / maxPerMinute 每请求现读。
export const SYNC_DEFAULT_CIDRS = [
  '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12',
  '100.64.0.0/10', // Tailscale
  '127.0.0.1/32', '::1/128',
];

export function normalizeSync(raw, clientToken = null, tvRaw = null) {
  const out = {
    enabled: false,
    port: 8491,
    bind: '0.0.0.0',
    tokens: [],
    allowedCidrs: SYNC_DEFAULT_CIDRS.slice(),
    maxPerMinute: 120,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  out.enabled = raw.enabled === true;
  const port = Number(raw.port);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) out.port = port;
  const bind = typeof raw.bind === 'string' ? raw.bind.trim() : '';
  if (bind) out.bind = bind;

  // 收集 TV token 明文，禁止与 sync 共用（电视在明文 LAN 上）
  const tvTokens = new Set();
  const tvSrc = tvRaw && typeof tvRaw === 'object' && !Array.isArray(tvRaw) ? tvRaw.tokens : null;
  if (Array.isArray(tvSrc)) {
    for (const it of tvSrc) {
      const tok = String((typeof it === 'string' ? it : it?.token) || '').trim();
      if (tok) tvTokens.add(tok);
    }
  }

  const seen = new Set();
  for (const it of Array.isArray(raw.tokens) ? raw.tokens : []) {
    const name = String((typeof it === 'string' ? '' : it?.name) || '').trim();
    const token = String((typeof it === 'string' ? it : it?.token) || '').trim();
    if (!token || seen.has(token)) continue;
    if (clientToken && token === clientToken) {
      log(`警告: gateway.sync.tokens 中「${name || '未命名'}」与 gateway.clientToken 相同，已忽略`);
      continue;
    }
    if (tvTokens.has(token)) {
      log(`警告: gateway.sync.tokens 中「${name || '未命名'}」与 gateway.tv.tokens 相同，已忽略`);
      continue;
    }
    seen.add(token);
    out.tokens.push({ name: name.slice(0, 40) || `sync${out.tokens.length + 1}`, token });
  }
  const cidrs = (Array.isArray(raw.allowedCidrs) ? raw.allowedCidrs : [])
    .map((c) => String(c || '').trim())
    .filter((c) => parseCidr(c) !== null);
  if (cidrs.length) out.allowedCidrs = [...new Set(cidrs)];
  const limit = Number(raw.maxPerMinute);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 6000) out.maxPerMinute = limit;
  return out;
}

// Mac↔Mac 同步客户端（gateway.syncClient）：本机当 spoke，同进程轮询枢纽 /sync/v1/*。
// 不另起监听；默认关闭。enabled 为 true 但 url/token 空 → startSyncClient 拒绝启动。
//
//   gateway.syncClient = {
//     enabled: false,
//     url: 'http://100.100.115.66:8491',   // 或 MagicDNS http://xxx.tail….ts.net:8491
//     token: '<与枢纽 tokens[].token 相同>',
//     intervalSec: 15,
//     push: true,                          // 默认推：拉完后把本机更新 POST/PATCH 到枢纽
//   }
export function normalizeSyncClient(raw) {
  const out = {
    enabled: false,
    url: '',
    token: '',
    intervalSec: 15,
    push: true,
    deviceId: '', // 空 = 运行时用 os.hostname()；stats 按设备替换切片
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  out.enabled = raw.enabled === true;
  const url = typeof raw.url === 'string' ? raw.url.trim().replace(/\/+$/, '') : '';
  if (url) out.url = url;
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (token) out.token = token;
  const interval = Number(raw.intervalSec);
  if (Number.isInteger(interval) && interval >= 5 && interval <= 3600) out.intervalSec = interval;
  // push 默认 true；仅显式 false 关闭（拉-only）
  out.push = raw.push !== false;
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  // 仅允许安全字符，避免路径/注入怪异 id
  if (deviceId && /^[a-zA-Z0-9._:-]{1,80}$/.test(deviceId)) out.deviceId = deviceId;
  return out;
}

// 个人工作台：报告生成用的模型设置 { reportProvider, reportModel,
// remoteProjects }，生成时按兜底链解析（见 lib/report/generate.mjs）。
// 纯行为字段，getConfig 现读即热生效。
// 非法值静默跳过，不阻塞配置加载（凭证链是主业务）。
//
// remoteProjects：**这些项目标签下的待办不在这台机器上做**（例如另一台机、黄区环境）。
// 作用有二：① 不放进会话归属的候选列表，避免把本机的无关会话错配过去；
// ② 汇报里仍照常出现，走「无会话但有子项/详情」那档。标签内容由用户填，
// 网关不内置任何环境语义（与显示器只认 UUID/VCP 同一条纪律）。
function normalizeWorkbench(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of ['reportProvider', 'reportModel']) {
    const v = raw[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  const rp = raw.remoteProjects;
  if (Array.isArray(rp)) {
    const list = rp.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    if (list.length) out.remoteProjects = [...new Set(list)];
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

// 内置默认＝**示例种子**（取自本机两台 AOC Q27P2G5 的实测值，仅作 monitors 节缺失时的
// 兜底与新机播种起点，可删改）：inputs/list 换成任何机器自己的 VCP 值与屏 UUID 都照常
// 工作，切换逻辑不依赖这里的任何具体数字。name 一律留空＝界面显示编号，用户在
// 管理台或 providers.json 里按自己的叫法填。管理台改名时也用它播种（否则默认配置
// 下写入无处可落）。
export function defaultMonitors() {
  return {
    inputs: [{ value: 15, name: '' }, { value: 21, name: '' }],
    list: [
      { uuid: 'A016429F-BCEC-4FAF-BD7D-23128391F7F1', name: '' },
      { uuid: 'F2F948D6-2F40-4DEC-8EF8-2E158BFF4328', name: '' },
    ],
  };
}

export function normalizeMonitors(raw) {
  const out = { inputs: [], list: [] };
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

  // 旧版曾有的 hotkeys 节（系统热键，2026-10-28 已随功能移除）不解析——读取时直接
  // 忽略，管理台下次对 monitors 节写盘时顺手清掉。
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


// 按入站协议选入口：若 provider.endpoints[inbound] 有值，临时覆盖 protocol+baseUrl，
// 使同协议直通；无对应入口则返回原 provider（走默认 protocol/baseUrl 的翻译/直通逻辑）。
// models 列表、报告生成、stats.protocols 仍用配置里的默认 protocol/baseUrl，不受此影响。
export function bindInboundEndpoint(provider, inbound) {
  const url = provider?.endpoints?.[inbound];
  if (!url) return provider;
  if (url === provider.baseUrl && provider.protocol === inbound) return provider;
  return { ...provider, protocol: inbound, baseUrl: url };
}

export function getProvider(id) {
  return getConfig().providers.find((p) => p.id === id) ?? null;
}

// 供 healthz/管理台展示：不抛错，坏配置降级为空
export function tryGetConfig() {
  try { return getConfig(); } catch (e) { return { error: e.message, providers: [], gateway: {}, routing: {}, pricing: {}, workbench: {} }; }
}
