// Mac↔Mac 同步：可共享的 providers.json 片段（含 auth 明文；仅私网/Tailscale）。
// 永不下发、永不被 apply 覆盖的角色键：gateway.sync / syncClient / tv。
import crypto from 'node:crypto';

/** @type {readonly string[]} */
export const SYNC_ROLE_GATEWAY_KEYS = Object.freeze(['sync', 'syncClient', 'tv']);

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
 * @param {object|null|undefined} raw
 * @returns {{ providers: any[], routing: object, pricing: object, monitors: object, workbench: object, gateway: object }}
 */
export function extractShareableConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    providers: Array.isArray(r.providers) ? r.providers : [],
    routing: r.routing && typeof r.routing === 'object' ? r.routing : {},
    pricing: r.pricing && typeof r.pricing === 'object' ? r.pricing : {},
    monitors: r.monitors && typeof r.monitors === 'object' ? r.monitors : {},
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
 * 保留本机未知顶层键（如 _说明）。
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
  if (s.monitors && typeof s.monitors === 'object') local.monitors = s.monitors;
  if (s.workbench && typeof s.workbench === 'object') local.workbench = s.workbench;
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
