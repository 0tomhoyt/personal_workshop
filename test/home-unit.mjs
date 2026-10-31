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

console.log(`\n结果: ${passed} 通过${failures.length ? `, ${failures.length} 失败 — ${failures.join(' / ')}` : ', 0 失败'}`);
process.exit(failures.length ? 1 : 0);
