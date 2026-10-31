// 首屏（#home）的纯函数与端点单测，不起进程：
//   额度解析（Kimi / 智谱真实形状）、认家数、查询降级、花费聚合、待办裁剪、响应组装。
// 运行: node test/home-unit.mjs
import assert from 'node:assert/strict';

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name} — ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name} — ${e.message}`); }
}
const group = (title) => console.log(`\n— ${title} —`);

const { detectQuotaKind, parseKimiQuota, parseZhipuQuota } = await import('../lib/quota.mjs');

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
check('unit 缺失时按 nextResetTime 兜底，无 reset 的归 5 小时', () => {
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
check('脏 baseUrl 不抛错', () => {
  assert.equal(detectQuotaKind({ baseUrl: 'not a url' }), null);
  assert.equal(detectQuotaKind({}), null);
});

group('额度查询与降级');
const { queryQuota } = await import('../lib/quota.mjs');
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const failFetch = (status) => async () => ({ ok: false, status, json: async () => ({}) });

await checkAsync('成功 → state=ok 且带 at', async () => {
  const q = await queryQuota(
    { id: 'k1', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 't' } },
    { now: () => 1000, fetchImpl: okFetch(KIMI) });
  assert.equal(q.state, 'ok');
  assert.equal(q.at, 1000);
  assert.equal(q.tiers.length, 2);
});
await checkAsync('请求头：Kimi 带 Bearer，智谱不带', async () => {
  const seen = [];
  const spy = (b) => async (url, init) => { seen.push(init.headers.authorization); return { ok: true, status: 200, json: async () => b }; };
  await queryQuota({ id: 'hk', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 'KEY' } }, { fetchImpl: spy(KIMI) });
  await queryQuota({ id: 'hz', baseUrl: 'https://open.bigmodel.cn/api/anthropic', auth: { type: 'static-token', token: 'KEY' } }, { fetchImpl: spy(ZHIPU) });
  assert.equal(seen[0], 'Bearer KEY');
  assert.equal(seen[1], 'KEY');
});
await checkAsync('请求的是固定额度 URL，不拼 baseUrl', async () => {
  const urls = [];
  const spy = (b) => async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => b }; };
  await queryQuota({ id: 'uk', baseUrl: 'https://api.kimi.com/coding/', auth: { type: 'static-token', token: 't' } }, { fetchImpl: spy(KIMI) });
  await queryQuota({ id: 'uz', baseUrl: 'https://api.z.ai/api/anthropic', auth: { type: 'static-token', token: 't' } }, { fetchImpl: spy(ZHIPU) });
  assert.equal(urls[0], 'https://api.kimi.com/coding/v1/usages');
  assert.equal(urls[1], 'https://api.z.ai/api/monitor/usage/quota/limit');
});
await checkAsync('401 → state=error 且文案是凭证问题，不是「用尽」', async () => {
  const q = await queryQuota({ id: 'e401', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 't' } }, { fetchImpl: failFetch(401) });
  assert.equal(q.state, 'error');
  assert.match(q.error, /凭证|401/);
  assert.doesNotMatch(q.error, /用尽/);
});
await checkAsync('智谱「未开通套餐」业务错误 → error，不是 0%', async () => {
  const q = await queryQuota({ id: 'noplan', baseUrl: 'https://open.bigmodel.cn/api/anthropic', auth: { type: 'static-token', token: 't' } },
    { fetchImpl: okFetch({ code: 500, success: false, msg: '当前用户不存在coding plan' }) });
  assert.equal(q.state, 'error');
  assert.match(q.error, /套餐/);
});
await checkAsync('认出但未识别的家数 → state=none 且不发请求', async () => {
  let called = 0;
  const q = await queryQuota({ id: 'none1', baseUrl: 'https://cannbot.hicann.cn/x', auth: { type: 'static-token', token: 't' } },
    { fetchImpl: async () => { called++; return {}; } });
  assert.equal(q.state, 'none');
  assert.equal(called, 0);
});
await checkAsync('缓存：60 秒内不重复打上游', async () => {
  let calls = 0;
  const spy = (b) => async () => { calls++; return { ok: true, status: 200, json: async () => b }; };
  const p = { id: 'c1', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 't' } };
  await queryQuota(p, { now: () => 5000, fetchImpl: spy(KIMI) });
  await queryQuota(p, { now: () => 5500, fetchImpl: spy(KIMI) });
  assert.equal(calls, 1, '第二次应命中缓存');
});
await checkAsync('失败但未过期 → stale，仍返回上次的环', async () => {
  const p = { id: 's1', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 't' } };
  await queryQuota(p, { now: () => 10_000, fetchImpl: okFetch(KIMI) });
  const q = await queryQuota(p, { now: () => 70_000, fetchImpl: failFetch(500), force: true });
  assert.equal(q.state, 'stale');
  assert.equal(q.at, 10_000);
  assert.equal(q.tiers.length, 2, 'stale 时环照旧');
  assert.ok(q.error);
});
await checkAsync('失败且超过 15 分钟 → error，环清空', async () => {
  const p = { id: 'x1', baseUrl: 'https://api.kimi.com/coding', auth: { type: 'static-token', token: 't' } };
  await queryQuota(p, { now: () => 0, fetchImpl: okFetch(KIMI) });
  const q = await queryQuota(p, { now: () => 16 * 60_000, fetchImpl: failFetch(500), force: true });
  assert.equal(q.state, 'error');
  assert.deepEqual(q.tiers, []);
});

group('花费聚合');
const { providerSpend } = await import('../lib/stats.mjs');
const { validateRawConfig } = await import('../lib/config.mjs');

check('providerSpend 从快照已合并视图求和（今日 + 近 30 天）', () => {
  // statsSnapshot 的 models[] 已按 pid:model 展平；days[] 每天各带一份 models
  const snap = {
    models: [
      { provider: 'zcode', model: 'm', cost: 1.5 },
      { provider: 'zcode', model: 'n', cost: 0.5 },
      { provider: 'kimi', model: 'm', cost: 2 },
    ],
    days: [
      { date: '2026-10-30', models: { 'zcode:x': { cost: 0.25 } } },
      { date: '2026-10-31', models: { 'zcode:m': { cost: 1.5 }, 'kimi:m': { cost: 2 } } },
    ],
  };
  assert.deepEqual(providerSpend('zcode', snap), { today: 2, days30: 1.75 });
  assert.deepEqual(providerSpend('kimi', snap), { today: 2, days30: 2 });
  assert.deepEqual(providerSpend('nobody', snap), { today: 0, days30: 0 });
});
check('providerSpend 保留两位小数（分）', () => {
  const snap = { models: [{ provider: 'p', cost: 0.1 }, { provider: 'p', cost: 0.2 }], days: [] };
  assert.equal(providerSpend('p', snap).today, 0.3);
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

group('首屏响应组装');
const { buildHome } = await import('../lib/home.mjs');
const noSpend = () => ({ today: 0, days30: 0 });
const noQuota = () => ({ state: 'none', at: null, error: null, tiers: [] });

await checkAsync('待办：counts.open = in_progress + pending', async () => {
  const h = await buildHome({ todos: [
    { id: '1', title: 'A', status: 'in_progress', urgency: 'normal', spans: [] },
    { id: '2', title: 'B', status: 'pending', urgency: 'normal' },
    { id: '3', title: 'C', status: 'pending', urgency: 'urgent' },
  ], now: 1000, providers: [], spend: noSpend, quota: noQuota });
  assert.equal(h.todos.counts.open, 3);
  assert.equal(h.todos.counts.in_progress, 1);
  assert.equal(h.todos.counts.pending, 2);
});
await checkAsync('排序：进行中 → 待办（紧急在前）', async () => {
  const h = await buildHome({ todos: [
    { id: 'p2', title: '普通', status: 'pending', urgency: 'normal', created_at: 1 },
    { id: 'p1', title: '紧急', status: 'pending', urgency: 'urgent', created_at: 2 },
    { id: 'ip', title: '进行中', status: 'in_progress', urgency: 'normal', spans: [] },
  ], now: 1000, providers: [], spend: noSpend, quota: noQuota });
  assert.deepEqual(h.todos.items.map((x) => x.id), ['ip', 'p1', 'p2']);
});
await checkAsync('完成组只收今天完成的（昨天的不出现）', async () => {
  const now = new Date('2026-10-31T12:00:00').getTime();
  const todayDone = new Date('2026-10-31T09:00:00').getTime();
  const ydayDone = new Date('2026-10-30T09:00:00').getTime();
  const h = await buildHome({ todos: [
    { id: 'a', title: '今天完成', status: 'done', completed_at: todayDone, urgency: 'normal' },
    { id: 'b', title: '昨天完成', status: 'done', completed_at: ydayDone, urgency: 'normal' },
  ], now, providers: [], spend: noSpend, quota: noQuota });
  assert.ok(h.todos.items.some((x) => x.id === 'a'));
  assert.ok(!h.todos.items.some((x) => x.id === 'b'));
});
await checkAsync('空待办不产生 NaN / 空标题', async () => {
  const h = await buildHome({ todos: [], now: 1000, providers: [], spend: noSpend, quota: noQuota });
  assert.equal(h.todos.counts.open, 0);
  assert.deepEqual(h.todos.items, []);
});
await checkAsync('截断：待办前 8 条，hidden 记超出数', async () => {
  const todos = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, status: 'pending', urgency: 'normal', created_at: 100 - i }));
  const h = await buildHome({ todos, now: 1000, providers: [], spend: noSpend, quota: noQuota });
  assert.equal(h.todos.items.filter((x) => x.status === 'pending').length, 8);
  assert.equal(h.todos.hidden, 4);
});
await checkAsync('订阅卡片严格按 config.providers 出（deepseek 这类无配置的不出现）', async () => {
  const h = await buildHome({ todos: [], now: 1000,
    providers: [{ id: 'kimi', name: 'Kimi', baseUrl: 'https://api.kimi.com/coding' }],
    spend: (pid) => (pid === 'deepseek' ? { today: 9, days30: 9 } : { today: 1, days30: 2 }),
    quota: noQuota });
  assert.deepEqual(h.providers.map((p) => p.id), ['kimi']);
  assert.deepEqual(h.providers[0].spend, { today: 1, days30: 2 });
});
await checkAsync('额度查询失败不影响花费数字', async () => {
  const h = await buildHome({ todos: [], now: 1000,
    providers: [{ id: 'kimi', name: 'Kimi', baseUrl: 'https://api.kimi.com/coding' }],
    spend: () => ({ today: 1.5, days30: 9 }),
    quota: () => ({ state: 'error', at: null, error: 'HTTP 401', tiers: [] }) });
  assert.deepEqual(h.providers[0].spend, { today: 1.5, days30: 9 });
  assert.equal(h.providers[0].quota.state, 'error');
});
await checkAsync('额度查询抛异常时整体不失败（降级成 error）', async () => {
  const h = await buildHome({ todos: [], now: 1000,
    providers: [{ id: 'kimi', name: 'Kimi', baseUrl: 'https://api.kimi.com/coding' }],
    spend: noSpend,
    quota: () => { throw new Error('boom'); } });
  assert.equal(h.providers.length, 1);
  assert.equal(h.providers[0].quota.state, 'error');
});
await checkAsync('停用的 provider 不出卡片', async () => {
  const h = await buildHome({ todos: [], now: 1000,
    providers: [
      { id: 'on', name: 'On', baseUrl: 'https://x.dev', enabled: true },
      { id: 'off', name: 'Off', baseUrl: 'https://y.dev', enabled: false },
    ], spend: noSpend, quota: noQuota });
  assert.deepEqual(h.providers.map((p) => p.id), ['on']);
});
await checkAsync('URL 解析失败的脏配置不拖垮整页', async () => {
  const h = await buildHome({ todos: [], now: 1000,
    providers: [{ id: 'bad', name: 'Bad', baseUrl: 'not a url' }], spend: noSpend, quota: noQuota });
  assert.equal(h.providers.length, 1);
});
await checkAsync('runningMs 透传给前端（进行中待办带时长）', async () => {
  const h = await buildHome({ todos: [
    { id: 'r', title: '跑着', status: 'in_progress', urgency: 'normal',
      spans: [{ id: 's', start: 1000, end: null }] },
  ], now: 61_000, providers: [], spend: noSpend, quota: noQuota });
  assert.equal(h.todos.items[0].runningMs, 60_000);
});

console.log(`\n结果: ${passed} 通过${failures.length ? `, ${failures.length} 失败 — ${failures.join(' / ')}` : ', 0 失败'}`);
process.exit(failures.length ? 1 : 0);
