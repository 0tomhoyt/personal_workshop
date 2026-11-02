// 电视快照 / 监听的纯函数单测（不起进程，快）：
//   截断、runningMs、排序、usage 汇总、快照形状、ETag 稳定性、CIDR、Host、token、限速。
// 运行: node test/tv-unit.mjs
import assert from 'node:assert/strict';
import {
  clip, runningMs, orderTodos, usageToday, buildSnapshot, etagOf, etagMatches,
  startOfLocalDay, fitToLimit, MAX_BYTES, providerCard,
} from '../lib/tv-snapshot.mjs';
import { inCidrs, hostAllowed, normalizeAddress, matchTvToken, createRateLimiter, bucketKey } from '../lib/tv-server.mjs';
import { normalizeTv, TV_DEFAULT_CIDRS } from '../lib/config.mjs';
import { safeEqual } from '../lib/gwauth.mjs';
import {
  buildOpenCodeSnapshot, buildDemoOpenCodeSnapshot, deriveStatus, mapToolStatus, mapTaskState,
  extractTools, extractTasks, etagOfOpenCode, fitOpenCodeToLimit, OPENCODE_MAX_BYTES,
  buildSessionBrief, buildSessionBriefs, SESSIONS_MAX, RICH_LIMITS, OPENCODE_RICH_MAX_BYTES,
} from '../lib/tv-opencode.mjs';
import {
  putSpokeOpenCodeFrame, clearSpokeOpenCodeFrames, resolveOpenCodeForTv,
  sanitizeSpokeOpenCodePayload, parseOpenCodeSource,
} from '../lib/tv-opencode-hub.mjs';

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(name); console.log(`  ✗ ${name} — ${e.message}`); }
}
const group = (title) => console.log(`— ${title} —`);

group('clip');
check('按码位截断且不劈 emoji', () => {
  assert.equal(clip('😀'.repeat(5), 3), '😀😀😀…');
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip('   ', 5), undefined);
  assert.equal(clip(null, 5), undefined);
});

group('runningMs');
check('闭合段相加', () => {
  assert.equal(runningMs({ spans: [{ start: 1000, end: 3000 }, { start: 5000, end: 5500 }] }, 9999), 2500);
});
check('未闭合段算到 now', () => {
  assert.equal(runningMs({ spans: [{ start: 1000, end: null }] }, 4000), 3000);
});
check('坏段跳过、无 spans 为 0', () => {
  assert.equal(runningMs({ spans: [{ start: 0, end: 10 }, { start: 5, end: 1 }, null] }, 100), 0);
  assert.equal(runningMs({}, 100), 0);
  assert.equal(runningMs(null, 100), 0);
});

group('orderTodos');
check('进行中 → 待办；同状态 紧急→普通→不急；再按更新', () => {
  const rows = [
    { status: 'done', urgency: 'urgent', updated_at: 9 },
    { status: 'pending', urgency: 'someday', updated_at: 9 },
    { status: 'pending', urgency: 'urgent', updated_at: 1 },
    { status: 'in_progress', urgency: 'someday', updated_at: 1 },
    { status: 'pending', urgency: 'urgent', updated_at: 5 },
  ];
  assert.deepEqual(orderTodos(rows).map((r) => `${r.status}/${r.urgency}/${r.updated_at}`), [
    'in_progress/someday/1', 'pending/urgent/5', 'pending/urgent/1', 'pending/someday/9', 'done/urgent/9',
  ]);
});

group('usageToday');
check('汇总请求/tokens/费用与 Top 模型份额', () => {
  const u = usageToday({
    today: { req: 10, tin: 100, tout: 50, cost: 1.23456 },
    hours: Array.from({ length: 24 }, (_, i) => ({ req: i })),
    models: [{ model: 'a', req: 6 }, { model: 'b', req: 3 }, { model: 'c', req: 1 }, { model: 'd', req: 0 }],
  });
  assert.equal(u.requests, 10);
  assert.equal(u.tokens, 150);
  assert.equal(u.costUsd, 1.2346);
  assert.equal(u.hours.length, 24);
  assert.deepEqual(u.topModels.map((m) => m.model), ['a', 'b', 'c']);
  assert.deepEqual(u.topModels.map((m) => m.share), [0.6, 0.3, 0.1]);
});
check('空统计不炸', () => {
  const u = usageToday(undefined);
  assert.equal(u.requests, 0);
  assert.equal(u.hours.length, 24);
  assert.deepEqual(u.topModels, []);
});

group('providerCard');
check('裁剪与钳制：名字 24、tier 名 16、remainingPct 收进 0–100', () => {
  const c = providerCard(
    { id: 'p1', name: 'N'.repeat(30) },
    { today: 1.234, days30: 9.876 },
    { state: 'ok', tiers: [
      { name: 'T'.repeat(20), remainingPct: 150 },
      { name: 'monthly', remainingPct: -5, over: true, used: 9, limit: 1, usedPct: 900 },
    ] },
  );
  assert.equal(c.name, 'N'.repeat(24) + '…');
  assert.deepEqual(c.spend, { today: 1.23, days30: 9.88 });
  assert.equal(c.quota.state, 'ok');
  assert.equal(c.quota.tiers[0].name, 'T'.repeat(16) + '…');
  assert.equal(c.quota.tiers[0].remainingPct, 100);
  assert.equal(c.quota.tiers[1].remainingPct, 0);
  assert.equal(c.quota.tiers[1].over, true);
  // tier 的 used/limit/usedPct 是首屏悬浮用的细节，LAN 上不多带
  assert.deepEqual(Object.keys(c.quota.tiers[1]).sort(), ['name', 'over', 'remainingPct']);
  assert.equal(c.quota.error, undefined);
});
check('at 只在 stale 时下发（其余状态带 at 会毁掉 304 的 ETag 语义）', () => {
  const ok = providerCard({ name: 'a' }, {}, { state: 'ok', at: 123, tiers: [] });
  const stale = providerCard({ name: 'a' }, {}, { state: 'stale', at: 123, tiers: [] });
  const err = providerCard({ name: 'a' }, {}, { state: 'error', at: 123, error: 'E'.repeat(100), tiers: [] });
  assert.equal(ok.quota.at, undefined);
  assert.equal(stale.quota.at, 123);
  assert.equal(err.quota.error, 'E'.repeat(80) + '…');
  assert.equal(err.quota.at, undefined);
});
check('未知 state / 坏 quota 按 error；name 缺失回落 id；spend 缺失补 0', () => {
  const c = providerCard({ id: 'xyz' }, undefined, { state: 'weird', tiers: 'nope' });
  assert.equal(c.name, 'xyz');
  assert.equal(c.quota.state, 'error');
  assert.deepEqual(c.quota.tiers, []);
  assert.deepEqual(c.spend, { today: 0, days30: 0 });
  assert.deepEqual(providerCard({ name: 'a' }, {}, null).quota.state, 'error');
});

group('buildSnapshot');
const now = new Date(2026, 9, 30, 15, 0, 0).getTime();
const todos = [
  { id: 'a', title: '进行中的', status: 'in_progress', urgency: 'normal', updated_at: 3, spans: [{ start: now - 600_000, end: null }] },
  { id: 'b', title: '紧急', status: 'pending', urgency: 'urgent', updated_at: 2, note: 'n'.repeat(200) },
  { id: 'c', title: '刚完成', status: 'done', urgency: 'normal', updated_at: 4, completed_at: now - 60_000 },
  { id: 'd', title: '昨天完成', status: 'done', urgency: 'normal', updated_at: 1, completed_at: now - 86_400_000 },
];
check('形状与派生字段', () => {
  const s = buildSnapshot({ todos, stats: {}, now });
  assert.equal(s.version, 2);
  assert.equal(s.now, now);
  assert.equal(s.online, true);
  assert.equal(s.todos.inProgress, 1);
  assert.equal(s.todos.pending, 1);
  assert.equal(s.todos.doneToday, 1);
  assert.deepEqual(s.todos.items.map((t) => t.id), ['a', 'b']);
  assert.equal(s.todos.items[0].runningMs, 600_000);
  assert.ok(s.todos.items[1].note.length <= 81);
  assert.deepEqual(Object.keys(s.todos.items[1]).sort(), ['id', 'note', 'runningMs', 'status', 'title', 'updatedAt', 'urgency']);
});
check('最多 6 条', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, title: `t${i}`, status: 'pending', urgency: 'normal', updated_at: i }));
  assert.equal(buildSnapshot({ todos: many, stats: {}, now }).todos.items.length, 6);
});
check('providers 节：透传卡片、剔除非对象、缺省为空数组', () => {
  const card = providerCard({ name: 'a' }, {}, { state: 'ok', tiers: [] });
  const s = buildSnapshot({ todos, stats: {}, providers: [card, 'junk', null], now });
  assert.equal(s.providers.length, 1);
  assert.equal(s.providers[0].name, 'a');
  assert.deepEqual(buildSnapshot({ todos, stats: {}, now }).providers, []);
});
check('startOfLocalDay 按本地零点', () => {
  assert.equal(new Date(startOfLocalDay(now)).getHours(), 0);
  assert.ok(startOfLocalDay(now) <= now);
});

check('最坏情况体积仍 ≤ 6 KB（超长标题/备注/项目/模型名 + 24 根柱）', () => {
  const worst = Array.from({ length: 6 }, (_, i) => ({
    id: 'x'.repeat(16), title: '待'.repeat(499), note: '注'.repeat(300), project: '项'.repeat(59),
    status: i % 2 ? 'pending' : 'in_progress', urgency: ['urgent', 'normal', 'someday'][i % 3],
    updated_at: now - i, spans: [{ start: now - 3_600_000, end: null }],
  }));
  const stats = {
    today: { req: 123456, tin: 999_999_999, tout: 999_999_999, cost: 123.4567 },
    hours: Array.from({ length: 24 }, () => 123456),
    models: Array.from({ length: 3 }, (_, i) => ({ model: '模'.repeat(40), req: 100_000 - i })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(buildSnapshot({ todos: worst, stats, now })));
  assert.ok(bytes <= 6144, `${bytes} bytes`);
});

check('fitToLimit：订阅脉搏逐级瘦身（error/at → tiers → 整卡），待办活着', () => {
  const longTodos = Array.from({ length: 6 }, (_, i) => ({
    id: `x${i}`, title: '待'.repeat(499), note: '注'.repeat(300), project: '项'.repeat(59),
    status: 'pending', urgency: 'normal', updated_at: i,
  }));
  // 注入的是未经 providerCard 裁剪的原始卡（模拟上游给的极端形状），各级都要被压到：
  const fatCards = Array.from({ length: 4 }, () => ({
    name: 'N'.repeat(24) + '…',
    spend: { today: 0, days30: 0 },
    quota: {
      state: 'error',
      error: 'E'.repeat(300),
      tiers: Array.from({ length: 40 }, () => ({ name: 'T'.repeat(16) + '…', remainingPct: 50 })),
    },
  }));
  const out = fitToLimit(buildSnapshot({ todos: longTodos, stats: {}, providers: fatCards, now }));
  const size = Buffer.byteLength(JSON.stringify(out));
  assert.ok(size <= MAX_BYTES, `${size} bytes`);
  assert.ok(out.todos.items.length >= 1, '待办至少留一条');
  for (const c of out.providers) {
    assert.equal(c.quota.error, undefined, '超限时 error 文案先被剥掉');
    assert.equal(c.quota.at, undefined);
  }
  const tiersLeft = out.providers.reduce((n, c) => n + (c.quota.tiers?.length ?? 0), 0);
  assert.ok(tiersLeft < 4 * 40, `tiers 应该被砍掉一部分（剩 ${tiersLeft}）`);
});
check('fitToLimit：连名字都巨大的卡整卡从尾部丢弃，绝不超字节', () => {
  const longTodos = Array.from({ length: 6 }, (_, i) => ({
    id: `x${i}`, title: '待'.repeat(499), status: 'pending', urgency: 'normal', updated_at: i,
  }));
  const fatCards = Array.from({ length: 4 }, () => ({
    name: 'N'.repeat(2000),
    spend: { today: 0, days30: 0 },
    quota: { state: 'none', tiers: [] },
  }));
  const out = fitToLimit(buildSnapshot({ todos: longTodos, stats: {}, providers: fatCards, now }));
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= MAX_BYTES);
  assert.ok(out.providers.length < 4, `名字放不下就该丢卡（剩 ${out.providers.length}）`);
  assert.ok(out.todos.items.length >= 1, '丢的是卡，不是待办');
});

check('doneToday 按本地零点切（跨午夜前后各一条）', () => {
  const midnight = new Date(2026, 9, 30, 0, 5, 0).getTime();
  const rows = [
    { id: 'a', title: 'a', status: 'done', urgency: 'normal', completed_at: midnight - 60_000, updated_at: 1 },
    { id: 'b', title: 'b', status: 'done', urgency: 'normal', completed_at: midnight - 3_600_000, updated_at: 1 },
    { id: 'c', title: 'c', status: 'done', urgency: 'normal', completed_at: startOfLocalDay(midnight) - 1, updated_at: 1 },
  ];
  assert.equal(buildSnapshot({ todos: rows, stats: {}, now: midnight }).todos.doneToday, 1);
});

group('ETag');
check('同一数据不同 now → 同 ETag（304 才命中）', () => {
  const a = JSON.stringify(buildSnapshot({ todos, stats: {}, now }));
  const b = JSON.stringify(buildSnapshot({ todos, stats: {}, now: now + 60_000 }));
  assert.equal(etagOf(a), etagOf(b));
});
check('数据变 → ETag 变', () => {
  const a = JSON.stringify(buildSnapshot({ todos, stats: {}, now }));
  const b = JSON.stringify(buildSnapshot({ todos: [...todos, { id: 'z', title: '新', status: 'pending', urgency: 'normal', updated_at: 9 }], stats: {}, now }));
  assert.notEqual(etagOf(a), etagOf(b));
});
check('订阅脉搏进哈希：额度/花费变了要重画，now 仍不进', () => {
  const card = providerCard({ name: 'a' }, { today: 1, days30: 2 }, { state: 'ok', tiers: [{ name: 'daily', remainingPct: 80 }] });
  const a = JSON.stringify(buildSnapshot({ todos, stats: {}, providers: [card], now }));
  const same = JSON.stringify(buildSnapshot({ todos, stats: {}, providers: [card], now: now + 60_000 }));
  assert.equal(etagOf(a), etagOf(same));
  const changed = JSON.stringify(buildSnapshot({
    todos, stats: {}, now,
    providers: [providerCard({ name: 'a' }, { today: 1, days30: 2 }, { state: 'ok', tiers: [{ name: 'daily', remainingPct: 70 }] })],
  }));
  assert.notEqual(etagOf(a), etagOf(changed));
});
check('runningMs 每 10 分钟进位才换 ETag（304 仍常态化）', () => {
  const at = (ms) => etagOf(JSON.stringify(buildSnapshot({
    todos: [{ id: 'a', title: 'x', status: 'in_progress', urgency: 'normal', updated_at: 1, spans: [{ start: now - ms, end: null }] }],
    stats: {}, now,
  })));
  // Same bucket → same tag; a bucket later → a new tag, so the shown duration moves on.
  assert.equal(at(60_000), at(5 * 60_000));
  assert.notEqual(at(60_000), at(11 * 60_000));
});
check('etagMatches 支持列表 / 弱校验 / *', () => {
  assert.equal(etagMatches('"x"', '"x"'), true);
  assert.equal(etagMatches('W/"x"', '"x"'), true);
  assert.equal(etagMatches('"a", "x"', '"x"'), true);
  assert.equal(etagMatches('*', '"x"'), true);
  assert.equal(etagMatches('"y"', '"x"'), false);
  assert.equal(etagMatches(undefined, '"x"'), false);
});

group('CIDR');
check('默认私网段命中', () => {
  assert.equal(inCidrs('192.168.1.20', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('10.1.2.3', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('172.16.5.5', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('127.0.0.1', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('::1', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('::ffff:192.168.1.20', TV_DEFAULT_CIDRS), true);
});
check('段外地址拒绝', () => {
  assert.equal(inCidrs('8.8.8.8', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('172.32.0.1', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('100.64.0.1', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('fe80::1', TV_DEFAULT_CIDRS), false);
});
check('CIDR 边界：/0、/32、IPv6 前缀、坏 bits、zone id', () => {
  assert.equal(inCidrs('192.168.1.5', ['0.0.0.0/0']), true);
  assert.equal(inCidrs('192.168.1.5', ['192.168.1.5/32']), true);
  assert.equal(inCidrs('192.168.1.6', ['192.168.1.5/32']), false);
  assert.equal(inCidrs('fd00::1', ['fc00::/7']), true);
  assert.equal(inCidrs('fd00::1', ['fc00::/8']), false);
  assert.equal(inCidrs('10.0.0.1', ['10.0.0.0/33']), false);
  assert.equal(inCidrs('10.0.0.1', ['10.0.0.0/-1']), false);
  assert.equal(inCidrs('fe80::1%eth0', ['fe80::/10']), true);
});

check('坏地址 / 坏网段默认拒绝', () => {
  assert.equal(inCidrs('', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('not-an-ip', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('192.168.1.1', ['192.168.1.0/99', 'nope']), false);
  assert.equal(inCidrs('192.168.1.1', []), false);
});
check('normalizeAddress 去 IPv4 映射前缀', () => {
  assert.equal(normalizeAddress('::ffff:10.0.0.2'), '10.0.0.2');
  assert.equal(normalizeAddress('10.0.0.2'), '10.0.0.2');
});

group('字节上限与配置陷阱');
check('控制字符撑大的快照被压回 6 KB', () => {
  const worst = Array.from({ length: 6 }, (_, i) => ({
    id: 'x'.repeat(16), title: '\u0001'.repeat(499), note: '\u0001'.repeat(300),
    project: '\u0001'.repeat(59), status: 'in_progress', urgency: 'urgent',
    updated_at: now - i, spans: [{ start: now - 3_600_000, end: null }],
  }));
  const stats = { today: { req: 1, tin: 1, tout: 1, cost: 1 }, hours: Array(24).fill(1), models: [{ model: '\u0001'.repeat(40), req: 1 }] };
  const raw = buildSnapshot({ todos: worst, stats, now });
  const fitted = fitToLimit(raw);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= MAX_BYTES, `${Buffer.byteLength(JSON.stringify(fitted))} bytes`);
  assert.ok(fitted.todos.items.length >= 1, 'still shows at least one todo');
});
check('正常数据不被 fitToLimit 改动', () => {
  const s = buildSnapshot({ todos, stats: {}, now });
  assert.deepEqual(fitToLimit(s), s);
});
check('CIDR 笔误被丢弃而不是落成白名单', () => {
  assert.equal(normalizeTv({ allowedCidrs: ['999.999.999.999/8'] }).allowedCidrs.length, 5);
  assert.equal(normalizeTv({ allowedCidrs: ['abcd/8'] }).allowedCidrs.length, 5);
  assert.deepEqual(normalizeTv({ allowedCidrs: ['10.0.0.0/8', 'bad'] }).allowedCidrs, ['10.0.0.0/8']);
});
check('TV token 不得与 clientToken 相同', () => {
  const tv = normalizeTv({ tokens: [{ name: 'living', token: 'ct' }, { name: 'bed', token: 'tv' }] }, 'ct');
  assert.deepEqual(tv.tokens.map((t) => t.name), ['bed']);
});

group('Host 反 rebinding');
check('IP 字面量 / .local / localhost / Tailscale MagicDNS 放行', () => {
  assert.equal(hostAllowed('192.168.1.9:8490'), true);
  assert.equal(hostAllowed('[::1]:8490'), true);
  assert.equal(hostAllowed('mac-mini.local:8490'), true);
  assert.equal(hostAllowed('localhost:8490'), true);
  assert.equal(hostAllowed('tomhoytmac-mini.tail76ab40.ts.net:8491'), true);
  assert.equal(hostAllowed('Foo.TS.NET'), true);
});
check('假冒 ts.net 后缀域名拒绝', () => {
  assert.equal(hostAllowed('evil.ts.net.example.com'), false);
  assert.equal(hostAllowed('ts.net.evil.com'), false);
});
check('nip.io 风格的解析回环域名也拒绝（只看 Host 字面量）', () => {
  assert.equal(hostAllowed('1.2.3.4.nip.io'), false);
  assert.equal(hostAllowed('192.168.1.9.evil.com'), false);
});

check('外部域名拒绝', () => {
  assert.equal(hostAllowed('evil.example.com'), false);
  assert.equal(hostAllowed('192.168.1.9.evil.com'), false);
  assert.equal(hostAllowed(''), false);
  assert.equal(hostAllowed(undefined), false);
});

group('token 与限速');
check('matchTvToken 返回名字而非 token', () => {
  const req = { headers: { 'x-aerial-token': 'secret-2' } };
  assert.equal(matchTvToken(req, [{ name: 'a', token: 'secret-1' }, { name: 'b', token: 'secret-2' }]), 'b');
  assert.equal(matchTvToken({ headers: {} }, [{ name: 'a', token: 'secret-1' }]), null);
  assert.equal(matchTvToken({ headers: { 'x-aerial-token': 'secret-' } }, [{ name: 'a', token: 'secret-1' }]), null);
});
check('safeEqual：同值 true、异值 false、长度不同也 false', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});
check('限速桶按 token 名哈希分（重名不会共用额度）', () => {
  assert.notEqual(bucketKey('tv-1'), bucketKey('tv-2'));
  assert.equal(bucketKey('tv-1'), bucketKey('tv-1'));
  assert.ok(!bucketKey('tv-1').includes('tv-1'));
});

check('限速窗口按 key 独立、滚动 60 s，上限每次调用现给', () => {
  const rl = createRateLimiter();
  assert.equal(rl.take('x', 2, 0), true);
  assert.equal(rl.take('x', 2, 1), true);
  assert.equal(rl.take('x', 2, 2), false);
  assert.equal(rl.take('y', 2, 2), true);
  // The limit is read per call: raising it takes effect without a restart.
  assert.equal(rl.take('x', 5, 2), true);
  assert.equal(rl.take('x', 2, 60_001), true);
});

group('normalizeTv');
check('默认关闭 + 默认端口 / 网段', () => {
  const tv = normalizeTv(undefined);
  assert.equal(tv.enabled, false);
  assert.equal(tv.port, 8490);
  assert.deepEqual(tv.tokens, []);
  assert.deepEqual(tv.allowedCidrs, TV_DEFAULT_CIDRS);
  assert.equal(tv.maxPerMinute, 30);
});
check('enabled 只认严格 true', () => {
  assert.equal(normalizeTv({ enabled: 'true' }).enabled, false);
  assert.equal(normalizeTv({ enabled: true }).enabled, true);
});
check('token 归一化：空/重复跳过、补名字', () => {
  const tv = normalizeTv({ tokens: [{ token: 'a' }, { name: 'x', token: '' }, { name: 'b', token: 'a' }, 'c'] });
  assert.deepEqual(tv.tokens.map((t) => t.token), ['a', 'c']);
  assert.equal(tv.tokens[0].name, 'tv1');
  assert.equal(tv.tokens[1].name, 'tv2');
});
check('坏 CIDR / 坏端口回落默认', () => {
  const tv = normalizeTv({ port: 70000, allowedCidrs: ['nope', '10.0.0.0/8'] });
  assert.equal(tv.port, 8490);
  assert.deepEqual(tv.allowedCidrs, ['10.0.0.0/8']);
});
check('cacheSeconds / maxPerMinute 边界', () => {
  assert.equal(normalizeTv({ cacheSeconds: -1 }).cacheSeconds, 5);
  assert.equal(normalizeTv({ cacheSeconds: 0 }).cacheSeconds, 0);
  assert.equal(normalizeTv({ maxPerMinute: 0 }).maxPerMinute, 30);
  assert.equal(normalizeTv({ maxPerMinute: 5 }).maxPerMinute, 5);
});

group('OpenCode status / maps');
check('mapToolStatus pending/error', () => {
  assert.equal(mapToolStatus('pending'), 'running');
  assert.equal(mapToolStatus('running'), 'running');
  assert.equal(mapToolStatus('error'), 'failed');
  assert.equal(mapToolStatus('completed'), 'ok');
});
check('mapTaskState', () => {
  assert.equal(mapTaskState('completed'), 'done');
  assert.equal(mapTaskState('in_progress'), 'running');
  assert.equal(mapTaskState('pending'), 'pending');
});
check('deriveStatus：工具 running 优先；busy>idle → running；succeeded → done', () => {
  assert.equal(deriveStatus({ tools: [{ status: 'running' }] }), 'running');
  assert.equal(deriveStatus({ timeBusy: 10, timeIdle: 5, now: 20 }), 'running');
  assert.equal(deriveStatus({ timeBusy: 5, timeIdle: 10, idleOutcome: 'succeeded', now: 20 }), 'done');
  assert.equal(deriveStatus({ idleOutcome: 'failed', now: 20 }), 'failed');
  assert.equal(deriveStatus({ now: 20 }), 'idle');
});

group('OpenCode snapshot');
check('无会话 → online idle', () => {
  const s = buildOpenCodeSnapshot({ now: 1000 });
  assert.equal(s.online, true);
  assert.equal(s.status, 'idle');
  assert.equal(s.demo, false);
  assert.equal(s.now, 1000);
  assert.equal(s.session, undefined);
});
check('完成会话：done + tokens + tools + plan', () => {
  const s = buildOpenCodeSnapshot({
    now: 10_000,
    branch: 'feat/x',
    session: {
      id: 'ses_1', title: '战况墙', directory: '/Users/tom/Desktop/project/aerial-tv',
      model: { id: 'deepseek-v4.1-flash', providerID: 'pg' }, agent: 'build',
      time_created: 0, time_updated: 9_000, time_busy: 1_000, time_idle: 9_000,
      idle_outcome: 'succeeded', tokens_input: 100, tokens_output: 20, tokens_reasoning: 5,
    },
    todos: [
      { position: 0, content: '已做', status: 'completed' },
      { position: 1, content: '进行中', status: 'in_progress' },
    ],
    messages: [{
      id: 'm1', time_updated: 8_000,
      data: { content: [
        { type: 'tool', id: 'c1', name: 'edit', state: { status: 'completed', input: { path: 'a.kt' } } },
        { type: 'tool', id: 'c2', name: 'shell', state: { status: 'pending', input: { command: 'gradlew test' } } },
      ] },
    }],
  });
  // 有 pending 工具 → running，即使 idle_outcome=succeeded
  assert.equal(s.status, 'running');
  assert.equal(s.session.project, 'aerial-tv');
  assert.equal(s.session.branch, 'feat/x');
  assert.equal(s.session.model, 'pg/deepseek-v4.1-flash');
  assert.equal(s.session.agent, 'build');
  assert.equal(s.tokens, 125);
  assert.equal(s.tools[0].name, 'edit');
  assert.equal(s.tools[1].status, 'running');
  assert.equal(s.plan.tasks[1].state, 'running');
  assert.equal(s.step, '进行中');
});
check('extractTools 截到 8；无 name 丢弃', () => {
  const msgs = [{
    id: 'm', time_updated: 1,
    data: { content: [
      { type: 'tool', id: 'x', name: '', state: { status: 'completed' } },
      ...Array.from({ length: 10 }, (_, i) => ({ type: 'tool', id: `c${i}`, name: `t${i}`, state: { status: 'completed', input: { path: `f${i}` } } })),
    ] },
  }];
  assert.equal(extractTools(msgs).length, 8);
  assert.equal(extractTasks([{ content: 'a', status: 'pending' }, { content: '', status: 'pending' }]).length, 1);
});
check('演示帧带 demo=true 且同相位 ETag 稳定', () => {
  const a = buildDemoOpenCodeSnapshot(1_000);
  const b = buildDemoOpenCodeSnapshot(1_000 + 72_000);
  assert.equal(a.demo, true);
  assert.equal(a.status === 'running' || a.status === 'done', true);
  assert.equal(a.title, b.title);
  assert.equal(etagOfOpenCode(JSON.stringify(a)), etagOfOpenCode(JSON.stringify(b)));
});
check('ETag 忽略 now/elapsedMs；status 变则变', () => {
  const base = buildOpenCodeSnapshot({
    now: 1, session: { id: 's', title: 't', directory: '/p/x', time_created: 0, time_updated: 1, idle_outcome: 'succeeded', time_idle: 1, time_busy: 0 },
  });
  const later = { ...base, now: 999, elapsedMs: base.elapsedMs + 100 };
  assert.equal(etagOfOpenCode(JSON.stringify(base)), etagOfOpenCode(JSON.stringify(later)));
  assert.notEqual(etagOfOpenCode(JSON.stringify(base)), etagOfOpenCode(JSON.stringify({ ...base, status: 'running' })));
});
check('fitOpenCodeToLimit 不超 6KB', () => {
  const fat = buildOpenCodeSnapshot({
    now: 1,
    session: { id: 's', title: '题'.repeat(200), directory: '/p/' + 'x'.repeat(80), time_created: 0, time_updated: 1, idle_outcome: 'succeeded', time_idle: 1 },
    todos: Array.from({ length: 8 }, (_, i) => ({ position: i, content: '任'.repeat(100), status: 'pending' })),
    messages: [{ id: 'm', time_updated: 1, data: { content: Array.from({ length: 8 }, (_, i) => ({
      type: 'tool', id: `c${i}`, name: 'edit', state: { status: 'completed', input: { path: '路'.repeat(200) } },
    })) } }],
  });
  const fitted = fitOpenCodeToLimit(fat);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= OPENCODE_MAX_BYTES);
});


check('parseOpenCodeSource 默认/非法 → local', () => {
  assert.equal(parseOpenCodeSource(undefined).mode, 'local');
  assert.equal(parseOpenCodeSource('spoke:macbook').deviceId, 'macbook');
  assert.equal(parseOpenCodeSource('spoke:bad id!').mode, 'local');
  assert.equal(parseOpenCodeSource('auto').mode, 'auto');
});
check('枢纽 resolve：local 带 source.kind=local', () => {
  clearSpokeOpenCodeFrames();
  const out = resolveOpenCodeForTv({
    opencodeSource: 'local',
    localFrame: { now: 1, online: true, status: 'idle', title: '本机' },
    now: 1000,
  });
  assert.equal(out.source.kind, 'local');
  assert.equal(out.title, '本机');
  assert.ok(out.source.host);
});
check('枢纽 resolve：spoke 新鲜帧优先；过期回落本机', () => {
  clearSpokeOpenCodeFrames();
  putSpokeOpenCodeFrame('macbook', { now: 1, online: true, status: 'running', title: 'MB' }, { receivedAt: 900 });
  const hit = resolveOpenCodeForTv({
    opencodeSource: 'spoke:macbook',
    localFrame: { now: 1, online: true, status: 'idle', title: '本机' },
    now: 1000,
    staleMs: 45_000,
  });
  assert.equal(hit.source.kind, 'spoke');
  assert.equal(hit.source.id, 'macbook');
  assert.equal(hit.title, 'MB');
  const miss = resolveOpenCodeForTv({
    opencodeSource: 'spoke:macbook',
    localFrame: { now: 1, online: true, status: 'idle', title: '本机' },
    now: 100_000,
    staleMs: 45_000,
  });
  assert.equal(miss.source.kind, 'local');
  assert.equal(miss.title, '本机');
});
check('枢纽 resolve：auto 只在 spoke running 时切', () => {
  clearSpokeOpenCodeFrames();
  putSpokeOpenCodeFrame('macbook', { now: 1, online: true, status: 'idle', title: 'idleMB' }, { receivedAt: 900 });
  const idle = resolveOpenCodeForTv({
    opencodeSource: 'auto',
    localFrame: { now: 1, online: true, status: 'idle', title: '本机' },
    now: 1000,
  });
  assert.equal(idle.source.kind, 'local');
  putSpokeOpenCodeFrame('macbook', { now: 1, online: true, status: 'running', title: 'runMB' }, { receivedAt: 950 });
  const run = resolveOpenCodeForTv({
    opencodeSource: 'auto',
    localFrame: { now: 1, online: true, status: 'idle', title: '本机' },
    now: 1000,
  });
  assert.equal(run.source.kind, 'spoke');
  assert.equal(run.title, 'runMB');
});
check('sanitizeSpokeOpenCodePayload 拒超大/非法', () => {
  const { frame, deviceId } = sanitizeSpokeOpenCodePayload(
    { online: true, status: 'running', title: 'x', deviceId: 'macbook', now: 1 },
  );
  assert.equal(deviceId, 'macbook');
  assert.equal(frame.status, 'running');
  assert.equal(frame.source, undefined);
  let threw = false;
  try { sanitizeSpokeOpenCodePayload(null); } catch (e) { threw = e.status === 400; }
  assert.equal(threw, true);
});


group('OpenCode sessions 小卡列表');
const SB_NOW = 10_000_000;
const sbMsg = (name, input, status = 'completed') => [{ id: 'm1', time_updated: SB_NOW - 1000, data: { content: [{ type: 'tool', id: 'c1', name, state: { status, input } }] } }];
check('brief：done / 路径取文件名 / 字段瘦', () => {
  const r = buildSessionBrief(
    { id: 'ses_a', title: '修网关', directory: '/Users/x/proj/aerial-tv', time_updated: SB_NOW - 60_000, time_busy: SB_NOW - 200_000, time_idle: SB_NOW - 60_000, idle_outcome: 'succeeded' },
    sbMsg('edit', { path: '/Users/x/proj/aerial-tv/lib/tv-opencode.mjs' }), SB_NOW);
  assert.equal(r.status, 'done');
  assert.equal(r.project, 'aerial-tv');
  assert.equal(r.title, '修网关');
  assert.equal(r.step, 'edit tv-opencode.mjs');
  assert.equal(r.at, SB_NOW - 60_000);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) < 260);
});
check('brief：有未完成工具 → running；shell 去掉前导 cd', () => {
  const r = buildSessionBrief(
    { id: 'ses_b', title: 'x', directory: '/a/b', time_updated: SB_NOW - 2000, time_busy: SB_NOW - 5000, time_idle: 0 },
    sbMsg('shell', { command: 'cd /a/b && npm test' }, 'running'), SB_NOW);
  assert.equal(r.status, 'running');
  assert.equal(r.step, 'shell npm test');
});
check('brief：遗留 busy（超 10 分钟没更新）不装成 running', () => {
  const r = buildSessionBrief(
    { id: 'ses_c', title: 'old', directory: '/a/b', time_updated: SB_NOW - 3_600_000, time_busy: SB_NOW - 3_600_000, time_idle: 0 }, [], SB_NOW);
  assert.equal(r.status, 'idle');
});
check('brief：failed；无工具无 step；缺 title/directory 不抛', () => {
  const r = buildSessionBrief({ id: 'ses_d', time_updated: SB_NOW, time_busy: SB_NOW - 9000, time_idle: SB_NOW - 100, idle_outcome: 'failed' }, [], SB_NOW);
  assert.equal(r.status, 'failed');
  assert.equal(r.step, undefined);
  assert.equal(r.title, undefined);
  assert.equal(buildSessionBrief(null), null);
});
check('briefs：最多 3 行，保持输入顺序（最新在前）', () => {
  const sessions = [1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, title: `t${i}`, time_updated: SB_NOW - i }));
  const rows = buildSessionBriefs({ sessions, now: SB_NOW });
  assert.equal(rows.length, SESSIONS_MAX);
  assert.deepEqual(rows.map((r) => r.id), ['s1', 's2', 's3']);
});
check('快照：sessions 挂到 out.sessions；空列表不出现该键（瘦 JSON）', () => {
  const sessions = buildSessionBriefs({ sessions: [{ id: 's1', title: 'a', time_updated: SB_NOW }], now: SB_NOW });
  const withS = buildOpenCodeSnapshot({ session: { id: 's1', title: 'a', time_updated: SB_NOW }, sessions, now: SB_NOW });
  assert.equal(withS.sessions.length, 1);
  const without = buildOpenCodeSnapshot({ session: { id: 's1', title: 'a', time_updated: SB_NOW }, now: SB_NOW });
  assert.equal('sessions' in without, false);
});
check('演示帧带 3 个会话且不超 6KB；ETag 在周期内稳定', () => {
  const d = buildDemoOpenCodeSnapshot(1_000);
  assert.equal(d.sessions.length, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(d)) <= OPENCODE_MAX_BYTES);
  assert.equal(etagOfOpenCode(JSON.stringify(d)), etagOfOpenCode(JSON.stringify(buildDemoOpenCodeSnapshot(1_000 + 72_000))));
});
check('fit：超限时先砍 sessions 到 1 行，其后整体仍合规', () => {
  const sessions = [0, 1, 2].map((i) => ({ id: `s${i}`, status: 'idle', at: 1, title: 'x'.repeat(40), step: 'y'.repeat(40) }));
  const fat = { now: 1, online: true, status: 'idle', title: 't', sessions, plan: { tasks: [{ id: 'a', title: 'z'.repeat(80), state: 'done' }] }, junk: 'q'.repeat(OPENCODE_MAX_BYTES) };
  const f = fitOpenCodeToLimit({ ...fat, junk: 'q'.repeat(OPENCODE_MAX_BYTES - 700) });
  assert.ok(Buffer.byteLength(JSON.stringify(f)) <= OPENCODE_MAX_BYTES);
  assert.ok(!f.sessions || f.sessions.length <= 3);
});
check('枢纽：sessions 跟随 source（local 用本机的；spoke 用投稿端的）', () => {
  clearSpokeOpenCodeFrames();
  const localFrame = { now: 1, online: true, status: 'idle', sessions: [{ id: 'L1', status: 'idle', at: 1, title: '本机会话' }] };
  putSpokeOpenCodeFrame('macbook', { now: 1, online: true, status: 'running', sessions: [{ id: 'M1', status: 'running', at: 2, title: '投稿会话' }] }, { receivedAt: 950 });
  const loc = resolveOpenCodeForTv({ opencodeSource: 'local', localFrame, now: 1000 });
  assert.equal(loc.source.kind, 'local');
  assert.equal(loc.sessions[0].id, 'L1');
  const sp = resolveOpenCodeForTv({ opencodeSource: 'spoke:macbook', localFrame, now: 1000 });
  assert.equal(sp.source.kind, 'spoke');
  assert.equal(sp.sessions[0].id, 'M1');
  const stale = resolveOpenCodeForTv({ opencodeSource: 'spoke:macbook', localFrame, now: 999_000 });
  assert.equal(stale.source.kind, 'local');
  assert.equal(stale.sessions[0].id, 'L1');
});
check('投稿体 sanitize：sessions 只收数组、≤3 行、白名单字段、非法 status → idle', () => {
  const { frame } = sanitizeSpokeOpenCodePayload({
    online: true, status: 'idle', deviceId: 'macbook', now: 1,
    sessions: [
      { id: 'a', status: 'bogus', at: 5, title: 't', evil: 'x'.repeat(100) },
      { id: 'b', status: 'running', at: 6 }, { id: 'c', status: 'done', at: 7 }, { id: 'd', status: 'done', at: 8 }, 'junk',
    ],
  });
  assert.equal(frame.sessions.length, 3);
  assert.equal(frame.sessions[0].status, 'idle');
  assert.equal('evil' in frame.sessions[0], false);
  const { frame: f2 } = sanitizeSpokeOpenCodePayload({ online: true, status: 'idle', deviceId: 'macbook', sessions: 'nope' });
  assert.equal('sessions' in f2, false);
});

group('rich 档（大屏监控）');
check('rich 快照：tools/sessions/tasks 上限放宽、title 截断放宽', () => {
  const mk = (rich) => buildOpenCodeSnapshot({
    now: 1, rich,
    session: { id: 's', title: '题'.repeat(200), directory: '/p/proj', time_created: 0, time_updated: 1, idle_outcome: 'succeeded', time_idle: 1 },
    todos: Array.from({ length: 20 }, (_, i) => ({ position: i, content: `任务${i}`, status: 'pending' })),
    messages: [{ id: 'm', time_updated: 1, data: { content: Array.from({ length: 30 }, (_, i) => ({
      type: 'tool', id: `c${i}`, name: 'edit', state: { status: 'completed', input: { path: `a/文件${i}.mjs` } },
    })) } }],
    sessions: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, status: 'idle', at: i })),
  });
  const thin = mk(false);
  const rich = mk(true);
  assert.equal(thin.tools.length, 8);
  assert.equal(thin.plan.tasks.length, 8);
  assert.equal(thin.sessions.length, 3);
  assert.equal(thin.title.length, 81); // 80 + …
  assert.equal(rich.tools.length, RICH_LIMITS.tools);
  assert.equal(rich.plan.tasks.length, RICH_LIMITS.tasks);
  assert.equal(rich.sessions.length, RICH_LIMITS.sessions);
  assert.equal(rich.title.length, 161); // 160 + …
});
check('rich sanitize：32KB 内全收（tools 24 不被砍）；超长字段被截断收下', () => {
  const tools = Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, name: 'edit', status: 'ok', at: 1, target: 'x'.repeat(20) }));
  const ok = sanitizeSpokeOpenCodePayload({ online: true, status: 'running', deviceId: 'mb', now: 1, tools }, { rich: true });
  assert.equal(ok.frame.tools.length, 24);
  // 32KB 以上的 fat 帧：白名单内字段逐项截断（target ≤200 码位），整帧收下且有界
  const fat = { online: true, status: 'running', deviceId: 'mb', now: 1,
    tools: tools.map((t) => ({ ...t, target: '巨'.repeat(600) })) };
  const squeezed = sanitizeSpokeOpenCodePayload(fat, { rich: true });
  assert.equal(squeezed.frame.tools.length, 24);
  assert.ok(squeezed.frame.tools.every((t) => Array.from(t.target).length <= 201));
  assert.ok(Buffer.byteLength(JSON.stringify(squeezed.frame)) <= OPENCODE_RICH_MAX_BYTES);
  // 33KB junk 超长**未知键**：白名单直接剥离（曾透传到电视出口），不再 413
  const junked = sanitizeSpokeOpenCodePayload({ online: true, status: 'running', deviceId: 'mb', now: 1, junk: 'x'.repeat(33 * 1024) }, { rich: true });
  assert.ok(!('junk' in junked.frame));
});
check('瘦档 sanitize：白名单外键剥离；超长 title 截断后 fit 到 6KB 内', () => {
  const { frame } = sanitizeSpokeOpenCodePayload({ online: true, status: 'idle', deviceId: 'mb', now: 1 });
  assert.equal(frame.status, 'idle');
  const junked = sanitizeSpokeOpenCodePayload({ online: true, status: 'idle', deviceId: 'mb', now: 1, junk: 'x'.repeat(OPENCODE_MAX_BYTES) });
  assert.ok(!('junk' in junked.frame));
  const { frame: fitted, } = sanitizeSpokeOpenCodePayload({ online: true, status: 'idle', deviceId: 'mb', now: 1, title: '标'.repeat(20_000) });
  assert.ok(Array.from(fitted.title).length <= 161); // 160 + …
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= OPENCODE_MAX_BYTES);
});

group('CIDR 空前缀笔误 / Host 裸 IPv6（fail-open 修复）');
check('空前缀「1.2.3.4/」不再被当 /0 放行全网段', () => {
  // Number('') === 0 曾把多敲一个斜杠的笔误解析成 /0（匹配所有 IPv4/IPv6），
  // 来源白名单形同虚设——必须按非法配置拒绝（不入白名单）
  assert.equal(inCidrs('8.8.8.8', ['1.2.3.4/']), false);
  assert.equal(inCidrs('fd00::99', ['fd00::1/']), false);
  assert.equal(inCidrs('192.168.1.5', ['192.168.0.0/']), false);
  // 合法写法不受影响
  assert.equal(inCidrs('192.168.1.5', ['192.168.0.0/16']), true);
});
check('hostAllowed 认裸 IPv6（无方括号 ::1）与 mapped v4', () => {
  // /:\d+$/ 曾把 ::1 的「:1」当端口剥掉剩 ':'，第一道门就 403（fail-closed 但难排查）
  assert.equal(hostAllowed('::1'), true);
  assert.equal(hostAllowed('[::1]'), true);
  assert.equal(hostAllowed('[::1]:8490'), true);
  assert.equal(hostAllowed('::ffff:127.0.0.1'), true);
  assert.equal(hostAllowed('evil.example.com'), false);
});

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败${failures.length ? ` — ${failures.join(' ; ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
