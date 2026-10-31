// Mac↔Mac 同步：可共享的 providers.json 片段（含 auth 明文；仅私网/Tailscale）。
// 永不下发、永不被 apply 覆盖的角色键：gateway.sync / syncClient / tv。
//
// **本机事实键（永不进同步）**：monitors。
//   monitors 描述的是「这台机器通过哪根 USB-C 接哪块屏、VCP 是多少」——同一套显示器
//   在两台机器上的 UUID/VCP 可以相同，但名字、顺序、接了哪几台完全不同；更常见的是
//   两台机器压根接不同的屏。把它当可共享配置会两头坏事：
//     ① 拉取方向：spoke 拿到枢纽的屏 UUID 去本机跑 m1ddc，每块屏都 ok:false（界面
//        有按钮、点了必失败），而本机真实的屏反而从界面消失；
//     ② 推送方向：没写 monitors 节的机器 extract 出的是 {}，而 `s.monitors && ...`
//        对 {} 为真 → **整段覆盖成空**，monitorConfig() 回落到 defaultMonitors()
//        里硬编码的两台 AOC UUID，看着还在工作，其实指向不存在的硬件。
//   与 tv 同一条纪律：绑定的是本机环境，不是账号。
import crypto from 'node:crypto';

/** @type {readonly string[]} */
export const SYNC_ROLE_GATEWAY_KEYS = Object.freeze(['sync', 'syncClient', 'tv']);

/** 顶层 provider 配置里「只属于本机硬件拓扑、永不同步」的键。 */
export const SYNC_LOCAL_ONLY_KEYS = Object.freeze(['monitors']);

/**
 * 从 gateway 对象去掉角色键（浅拷贝）。
 * @param {object|null|undefined} gateway
 */
export function stripRoleGateway(gateway) {
  const src = gateway && typeof gateway === 'object' && !Array.isArray(gateway) ? gateway : {};
  const out = { ...src };
  for (const k of SYNC_ROLE_GATEWAY_KEYS) delete out[k];
  return out;
}

/**
 * 把本地 gateway 里的角色键盖回 shared gateway（apply 时用）。
 * @param {object} sharedGateway 已去角色键或远端下发的 gateway
 * @param {object|null|undefined} localGateway 本机当前 raw.gateway
 */
export function restoreRoleGateway(sharedGateway, localGateway) {
  const out = stripRoleGateway(sharedGateway);
  const local = localGateway && typeof localGateway === 'object' ? localGateway : {};
  for (const k of SYNC_ROLE_GATEWAY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(local, k)) out[k] = local[k];
  }
  return out;
}

/**
 * 从 raw providers.json 抽出可同步节（含 provider auth）。
 * 本机事实键（SYNC_LOCAL_ONLY_KEYS，如 monitors）**不出现**在结果里——
 * 既不下发，也不参与 rev 指纹（否则一台机器改个显示器名字就让两边 rev 打架）。
 * @param {object|null|undefined} raw
 * @returns {{ providers: any[], routing: object, pricing: object, workbench: object, gateway: object }}
 */
export function extractShareableConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    providers: Array.isArray(r.providers) ? r.providers : [],
    routing: r.routing && typeof r.routing === 'object' ? r.routing : {},
    pricing: r.pricing && typeof r.pricing === 'object' ? r.pricing : {},
    workbench: r.workbench && typeof r.workbench === 'object' ? r.workbench : {},
    gateway: stripRoleGateway(r.gateway),
  };
}

/**
 * 稳定内容指纹（rev）：对 shareable 做 canonical JSON 的 sha256 前 16 hex。
 * @param {object} shareable
 */
export function configContentRev(shareable) {
  const canonical = stableStringify(shareable ?? {});
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/**
 * 把远端/共享配置合并进本机 raw：共享节整段替换，gateway 去角色键后盖回本机 sync/syncClient/tv。
 * 保留本机未知顶层键（如 _说明）与本机事实键（monitors 等）。
 * @param {object|null|undefined} localRaw
 * @param {object} shared extractShareableConfig 形状
 * @returns {object} 新 raw（未落盘）
 */
export function applyShareableToRaw(localRaw, shared) {
  const local = localRaw && typeof localRaw === 'object' ? { ...localRaw } : {};
  const s = shared && typeof shared === 'object' ? shared : {};
  if (Array.isArray(s.providers)) local.providers = s.providers;
  if (s.routing && typeof s.routing === 'object') local.routing = s.routing;
  if (s.pricing && typeof s.pricing === 'object') local.pricing = s.pricing;
  if (s.workbench && typeof s.workbench === 'object') local.workbench = s.workbench;
  // 本机事实键：**即使远端发了也不采用**。这里不是「s.monitors 为真才覆盖」——
  // 那个写法对空对象 {} 为真，会把本机配置整段清空再回落硬编码默认值。
  // 显式从 shared 里剔除，并把本机原值还原（local 是浅拷贝，未被动过即为原值）。
  for (const k of SYNC_LOCAL_ONLY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(s, k)) {
      // 远端带了这个键 → 忽略，保留本机（可能是 undefined，表示本机没配）
      if (Object.prototype.hasOwnProperty.call(localRaw ?? {}, k)) local[k] = localRaw[k];
      else delete local[k];
    }
  }
  local.gateway = restoreRoleGateway(s.gateway ?? {}, localRaw?.gateway);
  return local;
}

/**
 * 快照用包装：shareable + rev + updatedAt（文件 mtime ms，可选）。
 */
export function wrapConfigForSync(raw, { mtimeMs = null } = {}) {
  const config = extractShareableConfig(raw);
  return {
    rev: configContentRev(config),
    updatedAt: mtimeMs != null && Number.isFinite(Number(mtimeMs)) ? Number(mtimeMs) : null,
    ...config,
  };
}
