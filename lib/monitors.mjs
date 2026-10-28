// 显示器输入源切换（m1ddc / DDC-CI over USB-C）：状态查询 + 切换 + 命名。
//
// 背景：本机两台 AOC Q27P2G5，USB-C 接本 Mac、DP 接 Windows 主机，靠 DDC/CI
// VCP 60（输入源）在两台主机间切换。写入后短时读回 0 属切换过渡态。屏停在
// Windows 时 macOS 仍报在线（EDID 不断），DDC 双向可达——两个方向都能从 Mac 侧控制。
//
// 设计：网关不猜语义。哪块屏在哪、哪个 VCP 值对应哪台主机，是使用现场的事，
// 代码只认两样硬件事实——屏的 System UUID、输入的 VCP 值。名字（"左屏"、"Mac"、
// "工作机"…）全部由用户在配置里填，留空就显示编号：
//   屏   → UUID 前 8 位（如 3F2A91C4）
//   输入 → VCP 值（如 输入 15）
// 这样不存在「按钮反了」这类问题：没有内置的方向假设可反。
//
// 约束：
//   - m1ddc 每次调用 1-2s（I2C 慢）且并发可能互扰 → 所有调用走串行队列；
//   - 状态查询带短 TTL 缓存 + 在途去重（管理台轮询不能每轮都打 I2C）；
//   - m1ddc 缺失时优雅降级（available:false / 503），不阻塞网关其他功能。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { httpError } from './util.mjs';
import { log } from './log.mjs';
import { tryGetConfig, defaultMonitors } from './config.mjs';

// launchd 无用户 PATH / ~ 展开：os.homedir() 拼绝对路径；env 覆盖（测试注入 mock 用）
const M1DDC = process.env.CANNBOT_M1DDC || path.join(os.homedir(), 'bin', 'm1ddc');
const EXEC_TIMEOUT_MS = 8_000; // 单次 m1ddc 上限（I2C 偶发卡死不拖垮请求）
const CACHE_TTL_MS = 5_000;    // 状态缓存：轮询友好，过渡态也能较快刷新
const SETTLE_DELAY_MS = 4_000; // 切换后等过渡态（读回 0）过去再后台回读

// 内置默认（本机实测两台 AOC Q27P2G5）来自 config.mjs 的 defaultMonitors()——
// 单一来源，管理台改名播种时用的也是同一份，免得两处 UUID/值表漂移。

// 屏的默认标识 = UUID 前 8 位大写（两屏 UUID 前缀不同，够区分且比全串好读）
const shortUuid = (uuid) => String(uuid).split('-')[0].slice(0, 8).toUpperCase();

// 输入的默认标识 = 「输入 N」，N 是 DDC VCP 60 的真实值
const inputLabel = (entry) => entry.name || `输入 ${entry.value}`;
const monitorLabel = (entry) => entry.name || shortUuid(entry.uuid);

function monitorConfig() {
  const m = tryGetConfig().monitors; // config.mjs 按 mtime 热加载，改名不用重启
  return m && m.list?.length ? m : defaultMonitors();
}

function m1ddcAvailable() {
  try { fs.accessSync(M1DDC, fs.constants.X_OK); return true; } catch { return false; }
}

// ---- 串行队列：DDC/I2C 并发互扰，全部 m1ddc 调用排队 ----------------------
let queueTail = Promise.resolve();
function enqueue(fn) {
  const run = queueTail.then(fn, fn); // 前一个无论成败都放行下一个
  queueTail = run.catch(() => {});
  return run;
}

const execP = (args) => new Promise((resolve, reject) => {
  execFile(M1DDC, args, { timeout: EXEC_TIMEOUT_MS }, (e, stdout, stderr) => {
    if (e) {
      const extra = String(stderr || stdout || '').trim().slice(0, 200);
      return reject(new Error(extra ? `${e.message}: ${extra}` : e.message));
    }
    resolve(String(stdout).trim());
  });
});

// 读 VCP60（m1ddc 输出为裸数字，如 "15"）；写输入源。均按 System UUID 寻址
// （两台屏同名，display 序号重连后可能互换，UUID 稳定）。
async function getInput(uuid) {
  const out = await enqueue(() => execP(['display', `uuid=${uuid}`, 'get', 'input']));
  if (!/^\d+$/.test(out)) throw new Error(`无法解析 m1ddc 输出: ${out.slice(0, 80)}`);
  return Number(out);
}

function setInput(uuid, val) {
  return enqueue(() => execP(['display', `uuid=${uuid}`, 'set', 'input', String(val)]));
}

// ---- 状态查询：逐屏串行读（队列决定），整体 2-4s，TTL 缓存 + 在途去重 ------
let cache = null; // { at, result }
let inflight = null;

// 输入值 → { value, name, label }：name 只在配置里声明过该值时才有（用于「当前是 Mac」式提示）
function inputInfo(cfg, value) {
  if (value === 0) return { value, name: '', label: '切换中' };
  const hit = cfg.inputs.find((i) => i.value === value);
  if (hit) return { value, name: hit.name || '', label: inputLabel(hit) };
  return { value, name: '', label: `输入 ${value}` };
}

export async function monitorsStatus({ refresh = false } = {}) {
  const cfg = monitorConfig();
  const targets = cfg.inputs.map((i) => ({ ...i, label: inputLabel(i) }));
  if (!m1ddcAvailable()) {
    return {
      ok: false,
      available: false,
      m1ddc: M1DDC,
      reason: `m1ddc 不可执行（${M1DDC}）：请确认已安装，或用 CANNBOT_M1DDC 指定路径`,
      inputs: targets,
      monitors: [],
    };
  }
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.result, cached: true };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const monitors = [];
    for (const m of cfg.list) {
      const t0 = Date.now();
      const id = shortUuid(m.uuid); // 标识即地址：稳定、可区分、不依赖枚举顺序
      try {
        const input = await getInput(m.uuid); // 一屏失败不拖累另一屏
        const info = inputInfo(cfg, input);
        monitors.push({
          ...m, id, uuid: m.uuid, label: monitorLabel(m),
          ok: true, input, inputName: info.name, inputLabel: info.label,
          error: null, ms: Date.now() - t0,
        });
      } catch (e) {
        monitors.push({
          ...m, id, uuid: m.uuid, label: monitorLabel(m),
          ok: false, input: null, inputName: '', inputLabel: null,
          error: e.message, ms: Date.now() - t0,
        });
      }
    }
    const result = {
      ok: monitors.every((m) => m.ok),
      available: true,
      m1ddc: M1DDC,
      at: Date.now(),
      inputs: targets,
      monitors,
    };
    cache = { at: result.at, result };
    return result;
  })();
  try { return await inflight; } finally { inflight = null; }
}

// ---- 切换：逐屏写（串行）→ 乐观返回不等回读；后台延时回读刷缓存 ------------
let switching = false;

// 解析目标输入值。三种写法，优先级：数字 input > 输入名 target > 输入名 target（大小写不敏感）
function resolveInput(cfg, payload) {
  if (payload.input != null) {
    const n = Number(payload.input);
    if (!Number.isInteger(n) || n < 1 || n > 255) {
      throw httpError(400, 'input 需为 1-255 的整数', 'bad_request');
    }
    return n;
  }
  const raw = String(payload.target ?? '').trim();
  if (!raw) throw httpError(400, `缺少 input 或 target；可用输入: ${cfg.inputs.map(inputLabel).join(' / ')}`, 'bad_request');
  // 先按名字精确匹配，再按 label（含「输入 N」默认名）匹配，最后按纯数字容忍
  const byName = cfg.inputs.find((i) => i.name && i.name === raw)
    ?? cfg.inputs.find((i) => inputLabel(i) === raw)
    ?? cfg.inputs.find((i) => i.name && i.name.toLowerCase() === raw.toLowerCase());
  if (byName) return byName.value;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 255) return n;
  }
  throw httpError(400, `未知 target "${raw}"，可用输入: ${cfg.inputs.map(inputLabel).join(' / ')}`, 'bad_request');
}

// 解析目标屏。display 可写 UUID 短前缀（默认标识）、完整 UUID 或配置里的名字。
function resolveDisplays(cfg, payload) {
  const raw = payload.display != null ? String(payload.display).trim() : '';
  if (!raw) return cfg.list;
  const low = raw.toLowerCase();
  const hit = cfg.list.filter((m) => shortUuid(m.uuid).toLowerCase() === low
    || String(m.uuid).toLowerCase() === low
    || (m.name && m.name === raw)
    || (m.name && m.name.toLowerCase() === low));
  if (!hit.length) {
    const avail = cfg.list.map((m) => `${monitorLabel(m)}(${shortUuid(m.uuid)})`).join(' / ');
    throw httpError(400, `未知显示器 "${raw}"，可用: ${avail}`, 'bad_request');
  }
  return hit;
}

// 逐屏串行写目标输入。targets: [{ m, input }]
async function writeInputs(cfg, targets) {
  const monitors = [];
  for (const t of targets) {
    const ts = Date.now();
    const base = { id: shortUuid(t.m.uuid), label: monitorLabel(t.m), to: t.input, toLabel: inputInfo(cfg, t.input).label };
    try {
      await setInput(t.m.uuid, t.input);
      monitors.push({ ...base, ok: true, ms: Date.now() - ts });
    } catch (e) {
      monitors.push({ ...base, ok: false, error: e.message, ms: Date.now() - ts });
      log(`显示器切换失败 ${monitorLabel(t.m)}(${shortUuid(t.m.uuid)}): ${e.message}`);
    }
  }
  if (!monitors.some((m) => m.ok)) {
    throw httpError(500, `全部显示器写入失败: ${monitors[0]?.error ?? ''}`, 'ddc_write_failed');
  }
  return monitors;
}

// 写入后短时读回 0 属过渡态：等它过去再后台回读刷缓存
function refreshAfterSwitch() {
  setTimeout(() => {
    cache = null;
    monitorsStatus({ refresh: true }).catch(() => {});
  }, SETTLE_DELAY_MS).unref();
}

export async function switchMonitors(payload) {
  if (!m1ddcAvailable()) {
    throw httpError(503, `m1ddc 不可执行（${M1DDC}），无法切换`, 'm1ddc_unavailable');
  }
  if (switching) throw httpError(409, '已有一次切换在进行中，请稍候', 'switch_in_progress');
  const cfg = monitorConfig();
  const targets = resolveDisplays(cfg, payload); // 缺省切全部
  const input = resolveInput(cfg, payload);
  switching = true;
  const t0 = Date.now();
  try {
    const monitors = await writeInputs(cfg, targets.map((m) => ({ m, input })));
    const inputName = inputInfo(cfg, input).label;
    log(`显示器输入源已切换为 ${inputName}（对象: ${targets.map((m) => monitorLabel(m)).join('+')}）`);
    refreshAfterSwitch();
    return {
      ok: monitors.every((m) => m.ok),
      input,
      inputLabel: inputName,
      displays: monitors.map((m) => m.label).join('+'),
      note: '已下发，屏幕切换有数秒过渡',
      durationMs: Date.now() - t0,
      monitors,
    };
  } finally {
    switching = false;
  }
}
