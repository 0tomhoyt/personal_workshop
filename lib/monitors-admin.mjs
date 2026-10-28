// 管理台对显示器 monitors 节的改名写入（providers.json 的事实源操作）。
//
// 只改 name，不碰 inputs 的 value / list 的 uuid —— 那两个是硬件地址，改名接口
// 不该也不能挪动它们。约定与 providers-admin.mjs 一致：
//   - 内存里改 raw → 整体校验（config.mjs 归一化）→ 原子落盘（tmp + rename，0600）；
//   - 落盘后按 mtime 热加载，改名立即生效；
//   - 保留文件里未知的顶层键与未触及的条目；providers.json 不存在时拒绝写入
//     （不在这里凭空造一份配置）。
import fs from 'node:fs';
import { CONFIG_FILE, validateRawConfig, defaultMonitors } from './config.mjs';
import { httpError } from './util.mjs';
import { log } from './log.mjs';

const MAX_NAME = 40;

function readRaw() {
  let text;
  try { text = fs.readFileSync(CONFIG_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw httpError(400, 'providers.json 不存在，无法保存名称（请先通过「配置」页创建）', 'config_missing');
    throw httpError(500, `providers.json 读取失败: ${e.message}`, 'config_read_failed');
  }
  try { return JSON.parse(text); }
  catch (e) { throw httpError(500, `providers.json 不是合法 JSON: ${e.message}`, 'config_invalid'); }
}

function cleanName(raw, what) {
  const s = String(raw ?? '').trim();
  if (s.length > MAX_NAME) throw httpError(400, `${what}名称过长（最多 ${MAX_NAME} 字）`, 'bad_request');
  return s;
}

// 把已存的 monitors 节升级成新形态，再在其上改名。
//   - 整节缺失（默认配置，运行时 providers.json 通常没有 monitors）→ 用 defaultMonitors()
//     播种，否则默认配置下点改名会 404「可用: 无」；
//   - 旧形态的语义键名（mac/windows）与旧 id（left/right）按 config.mjs 的迁移规则丢弃，
//     但用户自己写的 name 保留——否则在这一页改名会顺手抹掉别处的手工命名。
function upgradeSection(raw) {
  const src = raw && typeof raw.monitors === 'object' && raw.monitors && !Array.isArray(raw.monitors)
    ? raw.monitors : null;
  const inputs = [];
  const seenVal = new Set();
  const pushInput = (value, name) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 255 || seenVal.has(n)) return;
    seenVal.add(n);
    inputs.push({ value: n, name: String(name ?? '').trim() });
  };
  const list = [];
  const seenUuid = new Set();
  const pushMonitor = (uuid, name) => {
    const u = String(uuid || '').trim().toUpperCase();
    if (!u || seenUuid.has(u)) return;
    seenUuid.add(u);
    list.push({ uuid: u, name: String(name ?? '').trim() });
  };
  if (src) {
    if (Array.isArray(src.inputs)) {
      for (const it of src.inputs) {
        if (it && typeof it === 'object') pushInput(it.value ?? it.input, it.name);
        else pushInput(it, '');
      }
    } else if (src.inputs && typeof src.inputs === 'object') {
      for (const v of Object.values(src.inputs)) pushInput(v, '');
    }
    for (const it of Array.isArray(src.list) ? src.list : []) {
      if (typeof it === 'string') pushMonitor(it, '');
      else pushMonitor(it?.uuid, it?.name);
    }
  }
  if (!inputs.length && !list.length) {
    const d = defaultMonitors();
    for (const i of d.inputs) pushInput(i.value, i.name);
    for (const m of d.list) pushMonitor(m.uuid, m.name);
  }
  // 热键节整体保留原样（含显式空数组=不绑）：本模块不解读，校验交给 config.mjs
  // 归一化；文件里没写就不造（缺省=加载期播种默认，不在这里抢跑）。
  const sec = { inputs, list };
  if (src && Array.isArray(src.hotkeys)) sec.hotkeys = src.hotkeys;
  return sec;
}

// 已升级的 monitors 节 → 校验 → 原子落盘（rename / hotkeys 共用）
function persistSection(raw, sec, note) {
  const next = { ...raw, monitors: sec };
  validateRawConfig(next); // 与加载期同一套校验，写坏配置不可能落盘
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw httpError(500, `providers.json 写入失败: ${e.message}`, 'config_write_failed');
  }
  log(`显示器配置已由管理台更新: ${note}`);
}

// payload: { input?: VCP值, display?: UUID, name: string } —— 按 input 改输入源名字，
// 按 display 改屏名字；两者都给时各改各的。name 传空串 = 清空（回到显示编号）。
export function renameMonitors(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(400, '请求体不是 JSON 对象', 'bad_request');
  }
  const hasInput = payload.input != null && payload.input !== '';
  const hasDisplay = payload.display != null && String(payload.display).trim() !== '';
  if (!hasInput && !hasDisplay) {
    throw httpError(400, '需提供 input（输入源 VCP 值）或 display（显示器 UUID）', 'bad_request');
  }
  const name = cleanName(payload.name, hasInput ? '输入源' : '显示器');

  const raw = readRaw();
  const sec = upgradeSection(raw);
  const notes = [];
  if (hasInput) {
    const n = Number(payload.input);
    if (!Number.isInteger(n) || n < 1 || n > 255) throw httpError(400, 'input 需为 1-255 的整数', 'bad_request');
    const hit = sec.inputs.find((i) => i.value === n);
    if (!hit) throw httpError(404, `输入源 ${n} 不在 monitors.inputs 里（可用: ${sec.inputs.map((i) => i.value).join(' / ') || '无'}）`, 'not_found');
    hit.name = name;
    notes.push(`输入 ${n} → ${name || '（编号）'}`);
  }
  if (hasDisplay) {
    const want = String(payload.display).trim().toUpperCase();
    const hit = sec.list.find((m) => m.uuid === want || m.uuid.startsWith(want));
    if (!hit) throw httpError(404, `显示器 "${payload.display}" 不在 monitors.list 里（可用: ${sec.list.map((m) => m.uuid.slice(0, 8)).join(' / ') || '无'}）`, 'not_found');
    hit.name = name;
    notes.push(`${hit.uuid.slice(0, 8)} → ${name || '（编号）'}`);
  }

  persistSection(raw, sec, notes.join('；'));
  return { ok: true, note: notes.join('；'), monitors: sec };
}

// 热键改绑：整体替换 monitors.hotkeys（管理台改绑后热键守护按 mtime 热加载重注册）。
// 与 rename 同一威胁模型（仅回环 + JSON，路由层把关）；这里只管语义校验：
//   - action 必须是已支持的动作名（当前只有 'toggle'＝一键切换，400）；
//   - key 用稳定小写记号（f13 / cmd+opt+w），正则与 config.mjs 归一化一致（400）；
//   - 同 key 撞车 → 400（热键互撞是最容易配出的错）。
// 热键绑的是动作不是具体输入源值——toggle 切到哪由运行时读屏决定。
// 显式空数组 = 清空全部热键（合法）。
const HOTKEY_KEY_RE = /^[a-z]+[a-z0-9]*(\+[a-z]+[a-z0-9]*)*$/;
const HOTKEY_ACTIONS = new Set(['toggle']);

export function setMonitorsHotkeys(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(400, '请求体不是 JSON 对象', 'bad_request');
  }
  if (!Array.isArray(payload.hotkeys)) {
    throw httpError(400, '需提供 hotkeys 数组（整体替换，如 [{ "action":"toggle", "key":"f13" }]；空数组=清空）', 'bad_request');
  }
  const raw = readRaw();
  const sec = upgradeSection(raw);
  const seenKey = new Set();
  const hotkeys = [];
  for (const it of payload.hotkeys) {
    if (!it || typeof it !== 'object') throw httpError(400, 'hotkeys 条目需为 { action, key } 对象', 'bad_request');
    const action = String(it.action ?? '').trim().toLowerCase();
    if (!HOTKEY_ACTIONS.has(action)) {
      throw httpError(400, `未知 action "${action || '(空)'}"（当前支持: ${[...HOTKEY_ACTIONS].join(' / ')}）`, 'bad_request');
    }
    const key = String(it.key ?? '').trim().toLowerCase();
    if (!HOTKEY_KEY_RE.test(key) || key.length > 32) {
      throw httpError(400, `key 记号 "${key}" 不合法（应为小写、加号组合，如 f13 / cmd+opt+w）`, 'bad_request');
    }
    if (seenKey.has(key)) throw httpError(400, `热键 ${key} 重复出现`, 'bad_request');
    seenKey.add(key);
    hotkeys.push({ action, key });
  }
  const next = { ...raw, monitors: { ...sec, hotkeys } };
  validateRawConfig(next);
  persistSection(raw, next.monitors, hotkeys.length
    ? `热键 → ${hotkeys.map((h) => `${h.key}=${h.action}`).join('、')}`
    : '热键 → （已清空）');
  return { ok: true, hotkeys };
}
