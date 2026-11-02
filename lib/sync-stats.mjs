// Mac↔Mac 同步：用量统计按设备分桶，快照返回跨设备求和视图。
// 防双计：枢纽对 devices[deviceId].days 整段替换（同设备重复推送只覆盖，不累加）。
// 数值桶（req/tin/…）与直方图相加；未知字段尽量保留为数字则加、否则后者覆盖。

const LAT_EDGES_LEN = 25; // 与 lib/stats.mjs LAT_EDGES.length + 1 的桶数一致（24 edges → 25 bins）
// 设备仓的有界性：日期键必须像日期、天数/设备数封顶。枢纽磁盘与求和 CPU 都被它撑着，
// 已认证方每轮换一个 deviceId 或塞一堆非日期键就能缓慢无界膨胀
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYNC_DAYS_MAX = 400; // stats 本身只保留 30 天，400 是宽裕余量
const SYNC_DEVICES_MAX = 16;
const SYNC_PROVIDERS_MAX = 64;
const SYNC_MODELS_MAX = 128;
const SYNC_HOURS_MAX = 24;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 两桶数值字段相加（浅）；perf 走 mergePerfShape。 */
export function sumBuckets(a, b) {
  if (!isPlainObject(a)) return isPlainObject(b) ? structuredCloneSafe(b) : {};
  if (!isPlainObject(b)) return structuredCloneSafe(a);
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'perf') {
      out.perf = mergePerfShape(out.perf, v);
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      const cur = out[k];
      out[k] = (typeof cur === 'number' && Number.isFinite(cur) ? cur : 0) + v;
    } else if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = sumBuckets(out[k], v);
    } else if (Array.isArray(v) && Array.isArray(out[k]) && v.length === out[k].length
      && v.every((x) => typeof x === 'number') && out[k].every((x) => typeof x === 'number')) {
      out[k] = out[k].map((x, i) => x + v[i]);
    } else if (!(k in out)) {
      out[k] = structuredCloneSafe(v);
    }
  }
  return out;
}

function mergeHistShape(dst, src) {
  if (!isPlainObject(src) || !Array.isArray(src.b)) return dst;
  const base = isPlainObject(dst) && Array.isArray(dst.b)
    ? { n: dst.n || 0, sum: dst.sum || 0, b: dst.b.slice() }
    : { n: 0, sum: 0, b: Array(src.b.length || LAT_EDGES_LEN).fill(0) };
  if (base.b.length !== src.b.length) {
    // 长度不一致：拉齐到较长
    const n = Math.max(base.b.length, src.b.length);
    while (base.b.length < n) base.b.push(0);
  }
  base.n += src.n || 0;
  base.sum += src.sum || 0;
  for (let i = 0; i < src.b.length; i++) base.b[i] += src.b[i] || 0;
  // 同步路径不保留原始样本 s，避免体积膨胀与双计歧义
  return base;
}

function mergePerfShape(dst, src) {
  if (!isPlainObject(src)) return dst;
  const out = isPlainObject(dst) ? { ...dst } : {};
  for (const k of ['ttft', 'tpot', 'itl', 'e2e']) {
    if (src[k]) out[k] = mergeHistShape(out[k], src[k]);
  }
  for (const k of ['dtok', 'dms', 'dn']) {
    if (typeof src[k] === 'number' && Number.isFinite(src[k])) {
      out[k] = (typeof out[k] === 'number' && Number.isFinite(out[k]) ? out[k] : 0) + src[k];
    }
  }
  if (src.bands && isPlainObject(src.bands)) {
    out.bands = out.bands && isPlainObject(out.bands) ? { ...out.bands } : {};
    for (const id of Object.keys(src.bands)) {
      out.bands[id] = mergePerfShape(out.bands[id], src.bands[id]);
    }
  }
  return out;
}

function structuredCloneSafe(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

/** 合并一天：total / providers.models / hours[] */
export function sumDay(a, b) {
  if (!isPlainObject(a)) return isPlainObject(b) ? structuredCloneSafe(b) : { total: {}, providers: {}, hours: [] };
  if (!isPlainObject(b)) return structuredCloneSafe(a);
  const out = {
    total: sumBuckets(a.total || {}, b.total || {}),
    providers: {},
    hours: Array.from({ length: 24 }, (_, h) => {
      const ha = Array.isArray(a.hours) ? a.hours[h] : null;
      const hb = Array.isArray(b.hours) ? b.hours[h] : null;
      if (!ha && !hb) return { req: 0, tin: 0, tout: 0, cost: 0 };
      return sumBuckets(ha || { req: 0, tin: 0, tout: 0, cost: 0 }, hb || { req: 0, tin: 0, tout: 0, cost: 0 });
    }),
  };
  const pids = new Set([
    ...Object.keys(a.providers || {}),
    ...Object.keys(b.providers || {}),
  ]);
  for (const pid of pids) {
    const pa = (a.providers || {})[pid] || { models: {} };
    const pb = (b.providers || {})[pid] || { models: {} };
    const models = {};
    const mids = new Set([...Object.keys(pa.models || {}), ...Object.keys(pb.models || {})]);
    for (const mid of mids) {
      models[mid] = sumBuckets((pa.models || {})[mid] || {}, (pb.models || {})[mid] || {});
    }
    out.providers[pid] = { models };
  }
  return out;
}

/** 多个 days map 相加 → 一个 days map */
export function sumDaysMaps(...maps) {
  const out = {};
  for (const m of maps) {
    if (!isPlainObject(m)) continue;
    for (const [date, day] of Object.entries(m)) {
      out[date] = out[date] ? sumDay(out[date], day) : structuredCloneSafe(day);
    }
  }
  return out;
}

/**
 * 枢纽设备仓：{ version, devices: { [deviceId]: { days, updatedAt? } }, statsRev? }
 * 旧版扁平 { version, days } → 迁到 devices["_migrated"].days
 */
export function migrateHubStatsStore(raw) {
  if (!raw || typeof raw !== 'object') {
    return { version: 1, devices: {}, statsRev: 0 };
  }
  if (raw.devices && typeof raw.devices === 'object') {
    return {
      version: Number(raw.version) || 1,
      devices: { ...raw.devices },
      statsRev: Number(raw.statsRev) || 0,
    };
  }
  if (raw.days && typeof raw.days === 'object') {
    return {
      version: 1,
      devices: { _migrated: { days: structuredCloneSafe(raw.days), updatedAt: Date.now() } },
      statsRev: 1,
    };
  }
  return { version: 1, devices: {}, statsRev: 0 };
}

/**
 * 用某设备的完整 days 替换该设备切片（非累加）。同内容重复推送不双计。
 * 设备数封顶：超出时逐最旧（updatedAt）淘汰，防换着 deviceId 投稿把仓库撑大。
 * @returns {{ store: object, changed: boolean }}
 */
export function replaceDeviceDays(store, deviceId, days, { now = Date.now() } = {}) {
  const id = String(deviceId || '').trim() || 'unknown';
  const base = migrateHubStatsStore(store);
  const nextDays = isPlainObject(days) ? structuredCloneSafe(days) : {};
  const prev = base.devices[id];
  const prevJson = prev ? stableJson(prev.days || {}) : '';
  const nextJson = stableJson(nextDays);
  if (prevJson === nextJson) {
    return { store: base, changed: false };
  }
  while (!prev && Object.keys(base.devices).length >= SYNC_DEVICES_MAX) {
    let oldest = null;
    for (const [k, ent] of Object.entries(base.devices)) {
      if (!oldest || (ent.updatedAt || 0) < oldest.at) oldest = { k, at: ent.updatedAt || 0 };
    }
    if (!oldest) break;
    delete base.devices[oldest.k];
  }
  base.devices[id] = { days: nextDays, updatedAt: now };
  base.statsRev = (Number(base.statsRev) || 0) + 1;
  return { store: base, changed: true };
}

function stableJson(v) {
  return JSON.stringify(v);
}

/** 跨设备求和 → days map */
export function sumStoreDevices(store, { extraDevices = null } = {}) {
  const base = migrateHubStatsStore(store);
  const maps = [];
  for (const ent of Object.values(base.devices || {})) {
    if (ent?.days) maps.push(ent.days);
  }
  if (extraDevices && typeof extraDevices === 'object') {
    for (const ent of Object.values(extraDevices)) {
      if (ent?.days) maps.push(ent.days);
      else if (ent && !ent.days && typeof ent === 'object') {
        // 允许直接传 { deviceId: daysMap }
      }
    }
    // extraDevices 也支持 { [id]: daysMap } 简写
    for (const [k, v] of Object.entries(extraDevices)) {
      if (v?.days) continue;
      if (isPlainObject(v) && !Array.isArray(v) && (v.total || v.providers || Object.keys(v).some((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))) {
        // 若值本身像 days map（键为日期）
        const keys = Object.keys(v);
        if (keys.length && keys.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) || d === 'total')) {
          // ambiguous — prefer date keys
        }
        if (keys.some((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) maps.push(v);
      }
    }
  }
  return sumDaysMaps(...maps);
}

/**
 * 推送体净化：去掉直方图原始样本 s，控制体积。
 * 日期键必须形如 2026-11-02（非日期键原样入库会让仓库慢慢塞满任意垃圾），
 * 天数封顶（保留最新）；providers/models/hours 也各自封顶。
 */
export function sanitizeDaysForSync(days) {
  if (!isPlainObject(days)) return {};
  const dateKeys = Object.keys(days).filter((k) => DAY_KEY_RE.test(k)).sort();
  const kept = dateKeys.slice(-SYNC_DAYS_MAX);
  const out = {};
  for (const date of kept) {
    out[date] = sanitizeDay(days[date]);
  }
  return out;
}

function sanitizeDay(day) {
  if (!isPlainObject(day)) return { total: {}, providers: {}, hours: [] };
  const providers = Object.entries(day.providers || {}).slice(0, SYNC_PROVIDERS_MAX).map(([pid, pv]) => [
    String(pid).slice(0, 80),
    {
      models: Object.fromEntries(
        Object.entries(pv?.models || {}).slice(0, SYNC_MODELS_MAX).map(([mid, b]) => [String(mid).slice(0, 160), sanitizeBucket(b || {})]),
      ),
    },
  ]);
  return {
    total: sanitizeBucket(day.total || {}),
    providers: Object.fromEntries(providers),
    hours: Array.isArray(day.hours)
      ? day.hours.slice(0, SYNC_HOURS_MAX).map((h) => (isPlainObject(h) ? { ...h } : { req: 0, tin: 0, tout: 0, cost: 0 }))
      : [],
  };
}

function sanitizeBucket(b) {
  if (!isPlainObject(b)) return {};
  const out = { ...b };
  if (out.perf) out.perf = stripPerfSamples(out.perf);
  return out;
}

function stripPerfSamples(p) {
  if (!isPlainObject(p)) return p;
  const stripH = (h) => {
    if (!isPlainObject(h)) return h;
    const { s, ...rest } = h;
    return rest;
  };
  const out = {
    ttft: stripH(p.ttft),
    tpot: stripH(p.tpot),
    itl: stripH(p.itl),
    e2e: stripH(p.e2e),
    dtok: p.dtok,
    dms: p.dms,
    dn: p.dn,
  };
  if (p.bands) {
    out.bands = {};
    for (const [id, bp] of Object.entries(p.bands)) out.bands[id] = stripPerfSamples(bp);
  }
  return out;
}

/** 快照用 stats 节 */
export function wrapStatsForSync(store, { hubLocalDays = null, hubDeviceId = 'hub', now = Date.now() } = {}) {
  const base = migrateHubStatsStore(store);
  // 枢纽本机用量以 live overlay 并入求和（不强制写入 devices，避免与 spoke 替换语义混淆）
  const maps = [];
  for (const ent of Object.values(base.devices || {})) {
    if (ent?.days) maps.push(ent.days);
  }
  if (hubLocalDays && isPlainObject(hubLocalDays)) maps.push(hubLocalDays);
  const days = sumDaysMaps(...maps);
  return {
    rev: Number(base.statsRev) || 0,
    deviceCount: Object.keys(base.devices || {}).length + (hubLocalDays ? 1 : 0),
    hubDeviceId,
    days,
    now,
  };
}
