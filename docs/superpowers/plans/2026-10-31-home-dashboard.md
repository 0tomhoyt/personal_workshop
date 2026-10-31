# 首屏（#home）：待办简览 + 订阅额度卡片 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个落地视图 `#home`，左栏显示所有未完成待办，右栏显示每个订阅的等效花费与（能查到的）编码套餐剩余额度环。

**Architecture:** 额度查询是唯一的新逻辑，抽成独立模块 `lib/quota.mjs`（识别 → 查 → 缓存 → 降级）；首屏数据由一个新增的 `GET /admin/home` 端点一次给全，由 `lib/home.mjs` 组装；前端只加一个视图和一套局部样式，不碰其他视图。

**Tech Stack:** Node ≥ 18 内置模块（零依赖）、原生 `fetch`、ESM；前端为 `index.html` 内联脚本 + `theme.css`。

**Spec:** `docs/superpowers/specs/2026-10-31-home-dashboard-design.md`

## Global Constraints

- **零依赖**：不得引入 package.json / node_modules，只用 Node 内置模块。
- **注释、commit message 一律中文**，与现有风格一致（解释「为什么」，不复述代码）。
- **额度地址固定**，不拼 `baseUrl`：Kimi → `https://api.kimi.com/coding/v1/usages`；智谱国内 → `https://open.bigmodel.cn/api/monitor/usage/quota/limit`；智谱国际 → `https://api.z.ai/api/monitor/usage/quota/limit`。
- **`percentage` 是已用百分比**，对外契约字段是 `remainingPct`，适配器必须 `100 - percentage`。
- **Kimi 用 `Authorization: Bearer <key>`；智谱用 `Authorization: <key>`（不带 Bearer）。**
- **花费口径 = 两台合计**：走 `statsSnapshot()`，不得自行遍历 `stats.days` 求和。
- **标题文案固定「还有 N 件事」**，N = `in_progress + pending`；**不得出现「今天」**。
- **花费标签固定「近 30 天」**（`lib/stats.mjs:233` 只保留 30 天），不得写「本月」。
- 新增 `/admin/home` 必须做 `isLocalHost` 回环校验（`/admin/stats` 没有这道校验，别照抄）。
- 前端所有动态文本经 `esc()` 转义。

## Review Focus

- **额度字段为字符串数字**（Kimi 的 `limit: "100"`）：解析必须 `Number()` 而不是依赖算术隐式转换，否则 `"100" - "40"` 之外的地方会拼出 `"10040"`。
- **智谱 `unit` 缺失**（老套餐 / 上游改字段）：必须仍能分出 5 小时与周，不能两个环都空或都标成 5 小时。
- **上游 401/403 与「按量账户查套餐」**：前者是凭证问题、后者是「你根本没买套餐」，文案不能混，也都不能被当成「额度用尽（0%）」。
- **待办一个都没有 / 全是已完成**：首屏不能出现空标题或 `NaN`。
- **某家额度连同花费都拿不到**（provider 配了但没流量、额度又超时）：卡片仍要出现并显示花费 $0.00，不能整张消失。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `lib/quota.mjs`（新） | 认家数、发两个固定 URL 的请求、解析两种响应形状、60 秒缓存 + stale/error 降级。纯函数解析与网络分离，便于单测。 |
| `lib/home.mjs`（新） | 组装 `/admin/home` 响应：待办裁剪排序、花费聚合（调 `statsSnapshot`）、并发展额度。 |
| `lib/stats.mjs`（改） | 新增 `providerSpend(pid)`：从快照已合并视图取今日/近 30 天花费。 |
| `lib/auth/static.mjs`（改） | 导出 `resolveToken`（现为模块内私有）。 |
| `lib/config.mjs`（改） | `normalizeProvider` 白名单加 `quota`。 |
| `server.mjs`（改） | 新增 `GET /admin/home` 路由。 |
| `index.html`（改） | 新视图 `#home`、左栏第一项、`VIEW_IDS`/`VIEW_GROUP`、落地规则、数字键 1–7。 |
| `theme.css`（改） | 首屏局部样式。 |
| `test/home-unit.mjs`（新） | 额度解析 + 花费聚合 + 待办裁剪的纯函数单测。 |
| `test/smoke.mjs`（改） | `/admin/home` 端到端；更新视图数量相关断言。 |

---

### Task 1: 额度解析纯函数（不联网）

**Files:**
- Create: `lib/quota.mjs`
- Test: `test/home-unit.mjs`

**Interfaces:**
- Produces:
  - `detectQuotaKind(provider) -> 'kimi' | 'zhipu' | null`
  - `parseKimiQuota(body) -> Tier[]`
  - `parseZhipuQuota(body) -> Tier[]`
  - `Tier = { name: 'five_hour' | 'weekly_limit', remainingPct: number, resetsAt: string | null }`

- [ ] **Step 1: 写失败的测试**

`test/home-unit.mjs`（新文件，沿用 `test/tv-unit.mjs` 的 `check`/`group` 骨架）：

```js
import assert from 'node:assert/strict';
import { detectQuotaKind, parseKimiQuota, parseZhipuQuota } from '../lib/quota.mjs';

// Kimi 真实形状：数字是字符串，5 小时在 limits[].detail，周在 usage
const KIMI = {
  usage: { limit: '100', remaining: '40', resetTime: '2030-01-01T00:00:00Z' },
  limits: [{ detail: { limit: '100', remaining: '62', resetTime: '2026-11-01T10:00:00Z' } }],
};

group('Kimi 额度解析');
check('两档：5 小时在前、周在后', () => {
  const t = parseKimiQuota(KIMI);
  assert.deepEqual(t.map((x) => x.name), ['five_hour', 'weekly_limit']);
  assert.equal(t[0].remainingPct, 62);
  assert.equal(t[1].remainingPct, 40);
  assert.equal(t[1].resetsAt, '2030-01-01T00:00:00Z');
});
check('字符串数字按数字解析（剩余 40/100 不是拼接）', () => {
  const t = parseKimiQuota({ usage: { limit: '100', remaining: '40' } });
  assert.equal(t[0].remainingPct, 40);
  assert.equal(typeof t[0].remainingPct, 'number');
});
check('缺 limits 时只剩周档', () => {
  assert.deepEqual(parseKimiQuota({ usage: { limit: '10', remaining: '5' } }).map((x) => x.name), ['weekly_limit']);
});
check('limit 为 0 时不产生 NaN', () => {
  const t = parseKimiQuota({ usage: { limit: '0', remaining: '0' } });
  assert.equal(t[0].remainingPct, 0);
});
check('空响应返回空数组', () => {
  assert.deepEqual(parseKimiQuota({}), []);
});

group('智谱额度解析');
// 真实形状：percentage 是「已用」，unit 3 = 5 小时、6 = 周
const ZHIPU = { success: true, data: { level: 'max', limits: [
  { type: 'TOKENS_LIMIT', unit: 3, percentage: 38.0, nextResetTime: '2026-11-01T10:00:00Z' },
  { type: 'TOKENS_LIMIT', unit: 6, percentage: 53.0, nextResetTime: '2026-11-04T00:00:00Z' },
] } };
check('percentage 是已用 → remainingPct 必须取反', () => {
  const t = parseZhipuQuota(ZHIPU);
  const five = t.find((x) => x.name === 'five_hour');
  assert.equal(five.remainingPct, 62); // 100 - 38
  assert.equal(t.find((x) => x.name === 'weekly_limit').remainingPct, 47); // 100 - 53
});
check('unit 缺失时按 nextResetTime 升序兜底，无 reset 的归 5 小时', () => {
  const t = parseZhipuQuota({ data: { limits: [
    { type: 'TOKENS_LIMIT', percentage: 25 },
    { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: '2026-11-04T00:00:00Z' },
  ] } });
  assert.equal(t.find((x) => x.name === 'five_hour').remainingPct, 75);
  assert.equal(t.find((x) => x.name === 'weekly_limit').remainingPct, 90);
});
check('老套餐只有一条 TOKENS_LIMIT → 只有 5 小时档', () => {
  const t = parseZhipuQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 2 }] } });
  assert.deepEqual(t.map((x) => x.name), ['five_hour']);
  assert.equal(t[0].remainingPct, 98);
});
check('TIME_LIMIT 等其他类型忽略', () => {
  assert.deepEqual(parseZhipuQuota({ data: { limits: [{ type: 'TIME_LIMIT', percentage: 7 }] } }), []);
});
check('type 大小写不敏感', () => {
  const t = parseZhipuQuota({ data: { limits: [{ type: 'tokens_limit', unit: 3, percentage: 10 }] } });
  assert.equal(t.length, 1);
});
check('percentage 超过 100 时 remainingPct 夹到 0', () => {
  assert.equal(parseZhipuQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 130 }] } })[0].remainingPct, 0);
});

group('认家数');
check('按 host 识别，不看路径', () => {
  assert.equal(detectQuotaKind({ baseUrl: 'https://api.kimi.com/coding/' }), 'kimi');
  assert.equal(detectQuotaKind({ baseUrl: 'https://api.kimi.com/anthropic' }), 'kimi');
  assert.equal(detectQuotaKind({ baseUrl: 'https://open.bigmodel.cn/api/anthropic' }), 'zhipu');
  assert.equal(detectQuotaKind({ baseUrl: 'https://api.z.ai/api/anthropic' }), 'zhipu');
});
check('认不出返回 null（cannbot / deepseek）', () => {
  assert.equal(detectQuotaKind({ baseUrl: 'https://cannbot.hicann.cn/gateway/compatible-mode' }), null);
  assert.equal(detectQuotaKind({ baseUrl: 'https://api.deepseek.com' }), null);
});
check('quota.kind 显式覆盖，none 表示不查', () => {
  assert.equal(detectQuotaKind({ baseUrl: 'https://example.com', quota: { kind: 'kimi' } }), 'kimi');
  assert.equal(detectQuotaKind({ baseUrl: 'https://api.kimi.com/coding', quota: { kind: 'none' } }), null);
});
check('大小写不敏感的 host 匹配', () => {
  assert.equal(detectQuotaKind({ baseUrl: 'https://API.KIMI.COM/coding' }), 'kimi');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/home-unit.mjs`
Expected: FAIL — `Cannot find module '../lib/quota.mjs'`

- [ ] **Step 3: 实现 `lib/quota.mjs` 的纯函数部分**

```js
export const QUOTA_URLS = {
  kimi: 'https://api.kimi.com/coding/v1/usages',
  zhipuCn: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  zhipuIntl: 'https://api.z.ai/api/monitor/usage/quota/limit',
};
export function detectQuotaKind(provider) { /* 见下 */ }
export function parseKimiQuota(body) { /* 见下 */ }
export function parseZhipuQuota(body) { /* 见下 */ }
```

实现要点（这些是签名与测试未固定的判断，写清楚）：
- `detectQuotaKind`：先看 `provider.quota?.kind`，值为 `'kimi'|'zhipu'` 直接返回、`'none'` 返回 `null`；否则按 `new URL(baseUrl).hostname` 小写匹配 `api.kimi.com` / `api.kimi.ai` → `'kimi'`，含 `bigmodel.cn` 或等于 `api.z.ai` → `'zhipu'`；URL 解析失败返回 `null`（配置脏数据不能让首屏崩）。
- 百分比一律 `Math.round()` 取整并夹到 `[0, 100]`。
- `parseKimiQuota`：`limits[].detail` 全部映射为 `five_hour`（上游目前只回一条），`usage` 映射为 `weekly_limit`。`limit <= 0` 时 `remainingPct = 0`。
- `parseZhipuQuota`：筛 `type` 忽略大小写等于 `TOKENS_LIMIT` 的条目；`unit === 3` → `five_hour`、`unit === 6` → `weekly_limit`；无 `unit` 的进兜底池，先取无 `nextResetTime` 的填 `five_hour`，其余按 `nextResetTime` 升序填剩余槽位。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/home-unit.mjs`
Expected: 全部 ✓

- [ ] **Step 5: 提交**

```bash
git add lib/quota.mjs test/home-unit.mjs
git commit -m "feat(quota): 编码套餐额度解析（Kimi / 智谱，按 host 识别、percentage 取反）"
```

---

### Task 2: 额度查询 + 缓存 + 降级（联网）

**Files:**
- Modify: `lib/quota.mjs`
- Modify: `lib/auth/static.mjs`（导出 `resolveToken`）
- Test: `test/home-unit.mjs`

**Interfaces:**
- Consumes: Task 1 的 `detectQuotaKind` / `parseKimiQuota` / `parseZhipuQuota`。
- Produces:
  - `resolveToken(provider) -> string`（`lib/auth/static.mjs` 新导出）
  - `async queryQuota(provider, { now, fetchImpl }) -> QuotaState`
  - `QuotaState = { state: 'ok'|'stale'|'error'|'none', at: number|null, error: string|null, tiers: Tier[] }`

- [ ] **Step 1: 写失败的测试**

追加到 `test/home-unit.mjs`：

```js
import { queryQuota } from '../lib/quota.mjs';

group('额度查询与降级');
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const failFetch = (status) => async () => ({ ok: false, status, json: async () => ({}) });

check('成功 → state=ok 且带 at', async () => {
  const q = await queryQuota(
    { id: 'k1', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 't' } },
    { now: () => 1000, fetchImpl: okFetch(KIMI) });
  assert.equal(q.state, 'ok');
  assert.equal(q.at, 1000);
  assert.equal(q.tiers.length, 2);
});
check('请求头：Kimi 带 Bearer，智谱不带', async () => {
  const seen = [];
  const spy = (b) => async (url, init) => { seen.push(init.headers.authorization); return { ok: true, status: 200, json: async () => b }; };
  await queryQuota({ id: 'k', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 'KEY' } }, { fetchImpl: spy(KIMI) });
  await queryQuota({ id: 'z', baseUrl: 'https://open.bigmodel.cn/api/anthropic', auth: { type: 'static-token', token: 'KEY' } }, { fetchImpl: spy(ZHIPU) });
  assert.equal(seen[0], 'Bearer KEY');
  assert.equal(seen[1], 'KEY');
});
check('请求的是固定额度 URL，不拼 baseUrl', async () => {
  const urls = [];
  const spy = (b) => async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => b }; };
  await queryQuota({ id: 'k', baseUrl: 'https://api.kimi.com/coding/', auth: { type: 'static-token', token: 't' } }, { fetchImpl: spy(KIMI) });
  await queryQuota({ id: 'z', baseUrl: 'https://api.z.ai/api/anthropic', auth: { type: 'static-token', token: 't' } }, { fetchImpl: spy(ZHIPU) });
  assert.equal(urls[0], 'https://api.kimi.com/coding/v1/usages');
  assert.equal(urls[1], 'https://api.z.ai/api/monitor/usage/quota/limit');
});
check('401 → state=error 且文案是凭证问题，不是「用尽」', async () => {
  const q = await queryQuota({ id: 'k', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 't' } }, { fetchImpl: failFetch(401) });
  assert.equal(q.state, 'error');
  assert.match(q.error, /凭证|401/);
  assert.doesNotMatch(q.error, /用尽/);
});
check('智谱「未开通套餐」业务错误 → error，不是 0%', async () => {
  const q = await queryQuota({ id: 'z', baseUrl: 'https://open.bigmodel.cn/api/anthropic', auth: { type: 'static-token', token: 't' } },
    { fetchImpl: okFetch({ code: 500, success: false, msg: '当前用户不存在coding plan' }) });
  assert.equal(q.state, 'error');
  assert.match(q.error, /套餐/);
});
check('认出但未识别的家数 → state=none 且不发请求', async () => {
  let called = 0;
  const q = await queryQuota({ id: 'c', baseUrl: 'https://cannbot.hicann.cn/x', auth: { type: 'static-token', token: 't' } },
    { fetchImpl: async () => { called++; return {}; } });
  assert.equal(q.state, 'none');
  assert.equal(called, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/home-unit.mjs`
Expected: FAIL — `queryQuota is not a function`

- [ ] **Step 3: 实现查询部分**

- `lib/auth/static.mjs`：把 `function resolveToken` 改为 `export function resolveToken`。
- `lib/quota.mjs` 新增：
  - 模块级 `const cache = new Map()`（key = `${provider.id}:${kind}`）与 `const inflight = new Map()`，照 `lib/monitors.mjs:83-143` 的写法。
  - `TTL_MS = 60_000`、`STALE_MAX_MS = 15 * 60_000`。
  - `queryQuota(provider, { now = Date.now, fetchImpl = globalThis.fetch, force = false })`：
    1. `kind = detectQuotaKind(provider)`；`null` → `{ state:'none', at:null, error:null, tiers:[] }`，**不发请求**。
    2. 未过期缓存直接返回（`now() - hit.at < TTL_MS`）。
    3. 同一 key 已有 in-flight → 复用该 Promise。
    4. 请求：`fetchImpl(QUOTA_URLS[...], { headers: { authorization: kind==='kimi' ? `Bearer ${token}` : token, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })`。token 用 `resolveToken(provider)`，抛错时把该错误当查询失败。
    5. `401/403` → `error: '凭证无效或已过期（HTTP 401）'`；非 2xx → `error: '额度接口返回 HTTP N'`；JSON 解析失败 → `error: '额度响应不是合法 JSON'`。
    6. 智谱：`body.success === false` 且 `msg` 含 `coding plan`（忽略大小写）→ `error: '该账户未开通 Coding Plan'`。
    7. 成功 → 写缓存 `{ at: now(), tiers }`，返回 `state:'ok'`。
    8. 失败 → **不清缓存**：有旧值且 `now() - old.at < STALE_MAX_MS` → `{ ...old, state:'stale', error }`；否则 `{ state:'error', at: old?.at ?? null, error, tiers: [] }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/home-unit.mjs`
Expected: 全部 ✓

- [ ] **Step 5: 提交**

```bash
git add lib/quota.mjs lib/auth/static.mjs test/home-unit.mjs
git commit -m "feat(quota): 额度查询 + 60s 缓存 + stale/error 降级"
```

---

### Task 3: 花费聚合与配置白名单

**Files:**
- Modify: `lib/stats.mjs`
- Modify: `lib/config.mjs`
- Test: `test/home-unit.mjs`

**Interfaces:**
- Consumes: `statsSnapshot()`（`lib/stats.mjs:367`）
- Produces: `providerSpend(pid) -> { today: number, days30: number }`

- [ ] **Step 1: 写失败的测试**

```js
import { providerSpend } from '../lib/stats.mjs';
import { validateRawConfig } from '../lib/config.mjs';   // 已导出，内部即 normalizeConfig

group('花费聚合');
check('providerSpend 从快照已合并视图求和（今日 + 近 30 天）', () => {
  // statsSnapshot 的 models[] 已按 pid:model 展平；days[] 每天各带一份 models
  const snap = { models: [
    { provider: 'zcode', cost: 1.5 }, { provider: 'zcode', cost: 0.5 }, { provider: 'kimi', cost: 2 },
  ], days: [
    { date: '2026-10-30', models: {} },
    { date: '2026-10-31', models: { 'zcode:m': { cost: 1.5 }, 'kimi:m': { cost: 2 } } },
  ] };
  assert.deepEqual(providerSpend('zcode', snap), { today: 1.5, days30: 2.0 });
  assert.deepEqual(providerSpend('kimi', snap), { today: 2, days30: 2 });
  assert.deepEqual(providerSpend('nobody', snap), { today: 0, days30: 0 });
});

group('配置：quota 白名单');
check('normalizeProvider 保留 quota.kind', () => {
  const cfg = validateRawConfig({ providers: [
    { id: 'k', name: 'K', baseUrl: 'https://api.kimi.com/coding', protocol: 'anthropic',
      auth: { type: 'static-token', token: 't' }, models: { source: 'static', list: [] }, quota: { kind: 'kimi' } },
  ] });
  assert.equal(cfg.providers[0].quota.kind, 'kimi');
});
check('非法 quota.kind 丢弃（不阻塞配置加载）', () => {
  const cfg = validateRawConfig({ providers: [
    { id: 'k', name: 'K', baseUrl: 'https://x.dev', protocol: 'openai',
      auth: { type: 'static-token', token: 't' }, models: { source: 'static', list: [] }, quota: { kind: 'bogus' } },
  ] });
  assert.equal(cfg.providers[0].quota, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/home-unit.mjs`
Expected: FAIL — `providerSpend is not a function` / `cfg.providers[0].quota` 为 `undefined`

- [ ] **Step 3: 实现**

- `lib/stats.mjs` 末尾新增 `export function providerSpend(pid, snap = statsSnapshot())`：
  - `today`：遍历 `snap.models`，累加 `m.provider === pid` 的 `m.cost`。
  - `days30`：遍历 `snap.days`，对每天 `models` 的键（形如 `pid:model`）按第一个 `:` 切出 pid，匹配则累加 `cost`。
  - 两处求和结果 `Math.round(x * 100) / 100`（保留分）。签名里 `snap` 参数只为测试注入，默认走快照。
- `lib/config.mjs` 的 `normalizeProvider` 返回对象里加：
  ```js
  ...(normalizedQuota(raw.quota) ? { quota: normalizedQuota(raw.quota) } : {}),
  ```
  其中 `normalizedQuota(v)` 只在 `v?.kind` ∈ `['kimi','zhipu','none']` 时返回 `{ kind: v.kind }`，否则 `null`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/home-unit.mjs`
Expected: 全部 ✓

- [ ] **Step 5: 提交**

```bash
git add lib/stats.mjs lib/config.mjs test/home-unit.mjs
git commit -m "feat(stats): providerSpend 聚合；config 保留 quota.kind"
```

---

### Task 4: `/admin/home` 端点与响应组装

**Files:**
- Create: `lib/home.mjs`
- Modify: `server.mjs`
- Test: `test/home-unit.mjs`

**Interfaces:**
- Consumes: `listTodos()`（`lib/todos.mjs`）、`providerSpend()`、`queryQuota()`、`runningMs()` 与 `startOfLocalDay()`（`lib/tv-snapshot.mjs`）、`getConfig()`。
- Produces: `async buildHome() -> HomePayload`

```ts
HomePayload = {
  todos: { counts: { in_progress, pending, open }, items: Item[], hidden: number },
  providers: [{ id, name, spend: { today, days30 }, quota: QuotaState }],
  generatedAt: number,
}
Item = { id, title, status, urgency, project, runningMs }
```

- [ ] **Step 1: 写失败的测试**

```js
import { buildHome } from '../lib/home.mjs';

group('首屏响应组装');
check('待办：counts.open = in_progress + pending，标题用 open', () => {
  const h = buildHome({ todos: [
    { id: '1', title: 'A', status: 'in_progress', urgency: 'normal', spans: [] },
    { id: '2', title: 'B', status: 'pending', urgency: 'normal' },
    { id: '3', title: 'C', status: 'pending', urgency: 'urgent' },
  ], now: 1000, providers: [], spend: () => ({ today: 0, days30: 0 }) });
  assert.equal(h.todos.counts.open, 3);
  assert.equal(h.todos.counts.in_progress, 1);
  assert.equal(h.todos.counts.pending, 2);
});
check('排序：进行中 → 待办（紧急在前）→ 今天完成', () => {
  const h = buildHome({ todos: [
    { id: 'p2', title: '普通', status: 'pending', urgency: 'normal', created_at: 1 },
    { id: 'p1', title: '紧急', status: 'pending', urgency: 'urgent', created_at: 2 },
    { id: 'ip', title: '进行中', status: 'in_progress', urgency: 'normal' },
  ], now: 1000, providers: [], spend: () => ({ today: 0, days30: 0 }) });
  assert.deepEqual(h.todos.items.map((x) => x.id), ['ip', 'p1', 'p2']);
});
check('完成组只收今天完成的（昨天的不出现）', () => {
  const now = new Date('2026-10-31T12:00:00').getTime();
  const todayDone = new Date('2026-10-31T09:00:00').getTime();
  const ydayDone = new Date('2026-10-30T09:00:00').getTime();
  const h = buildHome({ todos: [
    { id: 'a', title: '今天完成', status: 'done', completed_at: todayDone },
    { id: 'b', title: '昨天完成', status: 'done', completed_at: ydayDone },
  ], now, providers: [], spend: () => ({ today: 0, days30: 0 }) });
  assert.ok(h.todos.items.some((x) => x.id === 'a'));
  assert.ok(!h.todos.items.some((x) => x.id === 'b'));
});
check('空待办不产生 NaN / 空标题', () => {
  const h = buildHome({ todos: [], now: 1000, providers: [], spend: () => ({ today: 0, days30: 0 }) });
  assert.equal(h.todos.counts.open, 0);
  assert.deepEqual(h.todos.items, []);
});
check('截断：待办前 8 条，hidden 记超出数', () => {
  const todos = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, status: 'pending', urgency: 'normal', created_at: i }));
  const h = buildHome({ todos, now: 1000, providers: [], spend: () => ({ today: 0, days30: 0 }) });
  assert.equal(h.todos.items.length, 8);
  assert.equal(h.todos.hidden, 4);
});
check('订阅卡片严格按 config.providers 出（deepseek 这类无配置的不出现）', () => {
  const h = buildHome({ todos: [], now: 1000,
    providers: [{ id: 'kimi', name: 'Kimi', baseUrl: 'https://api.kimi.com/coding' }],
    spend: (pid) => (pid === 'deepseek' ? { today: 9, days30: 9 } : { today: 1, days30: 2 }),
    quota: () => ({ state: 'none', at: null, error: null, tiers: [] }) });
  assert.deepEqual(h.providers.map((p) => p.id), ['kimi']);
  assert.deepEqual(h.providers[0].spend, { today: 1, days30: 2 });
});
check('额度查询失败不影响花费数字', () => {
  const h = buildHome({ todos: [], now: 1000,
    providers: [{ id: 'kimi', name: 'Kimi', baseUrl: 'https://api.kimi.com/coding' }],
    spend: () => ({ today: 1.5, days30: 9 }),
    quota: () => ({ state: 'error', at: null, error: 'HTTP 401', tiers: [] }) });
  assert.deepEqual(h.providers[0].spend, { today: 1.5, days30: 9 });
  assert.equal(h.providers[0].quota.state, 'error');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/home-unit.mjs`
Expected: FAIL — `Cannot find module '../lib/home.mjs'`

- [ ] **Step 3: 实现 `lib/home.mjs`**

签名：`export async function buildHome(opts = {})`，所有依赖可注入（默认走真实实现：`listTodos()` / `providerSpend()` / `queryQuota()` / `getConfig().providers`）。

实现要点：
- 待办分组：`in_progress` 全收；`pending` 按 `urgency`（urgent → normal → someday）再按 `created_at` 降序，取前 8 条；`done` 只收 `completed_at >= startOfLocalDay(now)`，按 `completed_at` 降序取前 3 条。`hidden = 总未完成数 - 实际列出数`。
- `runningMs` 直接复用 `lib/tv-snapshot.mjs` 的导出函数，不重写。
- 订阅：只遍历 `config.providers` 里 `enabled !== false` 的；每个 `Promise.allSettled` 并发调 `queryQuota`，额度抛错时降级成 `{ state:'error', error: String(e.message), tiers: [] }`。**额度失败绝不能让 `buildHome` 整体失败。**
- `server.mjs`：在 `/admin/stats` 之后加
  ```js
  if (url === '/admin/home') {
    if (!isLocalHost(req)) return sendJson(res, 403, { error: { message: '仅允许通过 127.0.0.1/localhost 访问此端点', type: 'forbidden' } });
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: '此端点仅接受 GET', type: 'method_not_allowed' } });
    return sendJson(res, 200, await buildHome());
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/home-unit.mjs` → 全部 ✓
再跑 `node test/smoke.mjs` → 仍 545 通过（确认没破坏既有路由）

- [ ] **Step 5: 提交**

```bash
git add lib/home.mjs server.mjs test/home-unit.mjs
git commit -m "feat(home): /admin/home 端点（待办裁剪 + 花费 + 额度）"
```

---

### Task 5: 前端视图 `#home`

**Files:**
- Modify: `index.html`（左栏导航、`VIEW_IDS`/`VIEW_GROUP`、`initView`、新 `<section class="view" data-view="home">`、渲染函数、轮询）
- Modify: `theme.css`
- Modify: `test/smoke.mjs`

**Interfaces:**
- Consumes: `GET /admin/home`（Task 4 的 `HomePayload`）
- Produces: 无（叶子）

- [ ] **Step 1: 更新 smoke 里关于视图数量的断言，并加新断言**

`test/smoke.mjs:1991` 与 `:2117` 的 `['todos','report','overview','traffic','test','providers']` 改为含 `home` 的 7 项；`check` 名称里的「六个视图」改「七个视图」。新增：

```js
check('首屏视图存在且是左栏第一项', /data-view="home"/.test(idxHtml)
  && idxHtml.indexOf('#home') < idxHtml.indexOf('#todos'), '');
check('数字键映射覆盖七个视图（VIEW_IDS.length 驱动）', /n <= VIEW_IDS\.length/.test(idxHtml));
check('首屏不再读 gw-view 记忆', /initView[\s\S]{0,600}gw-view/.test(idxHtml) === false, '落地规则应改为 hash → /workbench → #home');
```

- [ ] **Step 2: 跑 smoke 确认新断言失败**

Run: `node test/smoke.mjs 2>&1 | grep -E "首屏|✗" | head`
Expected: 新断言 ✗

- [ ] **Step 3: 实现前端**

- 左栏工作台分组最前加 `<a class="viewbtn" href="#home"><span class="vname">首屏</span></a>`。
- `VIEW_IDS` 最前加 `'home'`；`VIEW_GROUP.home = 'workbench'`。
- `initView()` 的落地链改为 `hashView || (onWorkbench ? 'todos' : 'home')`，**删除对 `localStorage('gw-view')` 的读取**（写入可保留），注释写明：「首屏的用途是打开就看，记忆上次视图与它直接冲突」。
- `<section class="view" data-view="home">` 放在所有 `.view` 之前，两栏结构：左 `#homeTodos`、右 `#homeProv`。
- 渲染函数 `renderHome(d)`：标题 `还有 N 件事`（`counts.open`），待办行按 `status` 给圆点样式，`runningMs > 0` 时显示 `formatMinutes`；订阅卡按 B1（金额左、环右），环用内联 `<svg>` + `stroke-dasharray`（`周长 = 2πr`，`offset = 周长 × (1 - remainingPct/100)`），颜色：`>=50` 绿、`>=20` 琥珀、`<20` 红。
- 额度 `state`：`ok` 画环；`stale` 画环 + 灰色「N 分钟前」；`error` 不画环、显示「查询失败 · <原因>」；`none` 只显示金额。
- 花费行：`近 30 天 $X`，当 `remainingPct < 80 && days30 < 0.5` 时加小字「记账未含直连流量」。
- 轮询：`setView` 里 `if (v === 'home') loadHome();`，并在常驻 `poll()` 中仅当 `curView === 'home'` 时每 30 秒拉一次（额度 60 秒缓存天然限流）。
- `theme.css` 加 `.home-*` 命名空间的样式，不影响其他视图。

- [ ] **Step 4: 跑测试**

Run: `node test/smoke.mjs` → 全绿
Run: `node -e "const h=require('fs').readFileSync('index.html','utf8'); /* 检查脚本语法 */"` 不适用——改用浏览器打开 `http://127.0.0.1:8484/#home` 目视确认（见 Task 7）。

- [ ] **Step 5: 提交**

```bash
git add index.html theme.css test/smoke.mjs
git commit -m "feat(home): 首屏视图（待办简览 + 额度卡片），默认落地"
```

---

### Task 6: 端到端（mock 上游返回两种额度形状）

**Files:**
- Modify: `test/mock-upstream.mjs`
- Modify: `test/smoke.mjs`

**Interfaces:**
- Consumes: `GET /admin/home`
- Produces: 无

- [ ] **Step 1: mock 上游加额度端点**

`test/mock-upstream.mjs` 加两条路由，返回 Task 1 测试里的 `KIMI` / `ZHIPU` 形状（用固定夹具，不随时间变）。请求头断言：`/kimi-quota/v1/usages` 期望 `Bearer`，`/zhipu-quota/api/monitor/usage/quota/limit` 期望裸 token——两者都不符则 401。

- [ ] **Step 2: 写 smoke 断言**

```js
check('/admin/home → 200 且含 todos/providers', ...);
check('/admin/home 待办 counts.open 等于未完成数', ...);
check('/admin/home 额度：Kimi 两档且 remainingPct 为剩余（非已用）', ...);
check('/admin/home 额度：智谱 percentage 取反', ...);
check('/admin/home 额度失败降级为 error 而非整体 500', ...);  // 用一个指向死端口的 provider
check('/admin/home 非回环 Host → 403', ...);
```

- [ ] **Step 3: 跑 smoke 确认通过**

Run: `node test/smoke.mjs`
Expected: 全绿（含新增断言）

- [ ] **Step 4: 提交**

```bash
git add test/mock-upstream.mjs test/smoke.mjs
git commit -m "test(home): /admin/home 端到端（两种额度形状 + 降级 + 回环校验）"
```

---

### Task 7: 文档与真机确认

**Files:**
- Modify: `CLAUDE.md`、`README.md`
- Modify: `test/robustness.mjs`（若发现跨包/边界问题）

- [ ] **Step 1: 更新文档**

- `CLAUDE.md`：模块图加 `lib/quota.mjs`、`lib/home.mjs` 两行；路由表加 `GET /admin/home`；「数字键 1–6」改 1–7；「六个视图」改七个；写明 `#home` 是落地视图且不再读 `gw-view`。
- `README.md`：同步。

- [ ] **Step 2: 跑全部测试**

```bash
node test/smoke.mjs && node test/robustness.mjs && node test/sync-unit.mjs && node test/sync.mjs && node test/tv-unit.mjs && node test/home-unit.mjs
```
Expected: 全绿

- [ ] **Step 3: 真机确认**

```bash
CANNBOT_PROXY_PORT=8485 CANNBOT_CONFIG_FILE="$HOME/.local/share/cannbot-gateway-proxy/providers.json" CANNBOT_VK_CACHE=/tmp/vk-debug.json node server.mjs
# 另开浏览器访问 http://127.0.0.1:8485/#home
```
目视确认：待办标题是「还有 N 件事」、Kimi/GLM 两个环的角度与百分比一致（**重点核对取反没弄反：额度用得多时环应该变少**）、CANNWork 只有金额、`deepseek` 不出现。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md README.md
git commit -m "docs: 首屏视图与额度查询（quota/home 模块、1-7 快捷键、落地规则）"
```
