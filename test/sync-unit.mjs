// gateway.sync 纯函数单测：normalizeSync / buildSyncSnapshot / matchSyncToken
// 运行: node test/sync-unit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// todos 数据文件必须指到临时目录**再**导入 lib/todos.mjs：它加载时按 env 定落点，
// 否则「applyRemoteTodo」那组用例会把测试待办写进源目录的 todos.json。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-unit-'));
process.env.CANNBOT_TODOS_FILE = path.join(tmp, 'todos.json');
process.env.CANNBOT_LOG_FILE = path.join(tmp, 'inproc.log');

const { normalizeSync, normalizeSyncClient, SYNC_DEFAULT_CIDRS, normalizeTv } = await import('../lib/config.mjs');
const { buildSyncSnapshot, toSyncTodo } = await import('../lib/sync-snapshot.mjs');
const { planRemoteMerges, planLocalPushes, planAfterConflict, planConfigSync } = await import('../lib/sync-client.mjs');
const { remoteTodoWins, createTodo, updateTodo, listTodos, applyRemoteTodo } = await import('../lib/todos.mjs');
const { matchSyncToken } = await import('../lib/sync-server.mjs');
const { safeEqual } = await import('../lib/gwauth.mjs');
const {
  stripRoleGateway, restoreRoleGateway, extractShareableConfig,
  applyShareableToRaw, configContentRev, SYNC_ROLE_GATEWAY_KEYS,
} = await import('../lib/sync-config.mjs');
const {
  sumDay, sumDaysMaps, replaceDeviceDays, migrateHubStatsStore, sanitizeDaysForSync,
  wrapStatsForSync,
} = await import('../lib/sync-stats.mjs');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}
function group(t) { console.log(`\n— ${t} —`); }

group('normalizeSync');
check('默认关闭 + 8491 + Tailscale CIDR', () => {
  const s = normalizeSync(undefined);
  assert.equal(s.enabled, false);
  assert.equal(s.port, 8491);
  assert.deepEqual(s.tokens, []);
  assert.ok(s.allowedCidrs.includes('100.64.0.0/10'));
  assert.deepEqual(s.allowedCidrs, SYNC_DEFAULT_CIDRS);
  assert.equal(s.maxPerMinute, 120);
});
check('enabled 只认严格 true', () => {
  assert.equal(normalizeSync({ enabled: 'true' }).enabled, false);
  assert.equal(normalizeSync({ enabled: true }).enabled, true);
});
check('与 clientToken / TV token 相同则丢弃', () => {
  const s = normalizeSync(
    { tokens: [{ name: 'a', token: 'ct' }, { name: 'b', token: 'tv' }, { name: 'c', token: 'ok' }] },
    'ct',
    { tokens: [{ name: 'living', token: 'tv' }] },
  );
  assert.deepEqual(s.tokens.map((t) => t.token), ['ok']);
});
check('坏端口 / 坏 CIDR 回落', () => {
  const s = normalizeSync({ port: 99999, allowedCidrs: ['nope', '10.0.0.0/8'] });
  assert.equal(s.port, 8491);
  assert.deepEqual(s.allowedCidrs, ['10.0.0.0/8']);
});

group('buildSyncSnapshot');
check('rev 等于 updated_at；since 过滤', () => {
  const todos = [
    { id: 'a', title: '旧', status: 'pending', urgency: 'normal', updated_at: 100, created_at: 50 },
    { id: 'b', title: '新', status: 'in_progress', urgency: 'urgent', updated_at: 200, created_at: 150, note: 'n' },
  ];
  const full = buildSyncSnapshot({ todos, now: 999 });
  assert.equal(full.version, 2);
  assert.equal(full.todos.length, 2);
  assert.equal(full.todos[0].id, 'b');
  assert.equal(full.todos[0].rev, 200);
  assert.equal(full.cursor, 200);
  const inc = buildSyncSnapshot({ todos, now: 999, since: 100 });
  assert.deepEqual(inc.todos.map((t) => t.id), ['b']);
  assert.equal(toSyncTodo(todos[0]).rev, 100);
});
check('不下发 spans', () => {
  const row = toSyncTodo({ id: 'x', title: 't', updated_at: 1, spans: [{ id: 's', start: 1, end: null }] });
  assert.equal(row.spans, undefined);
});

group('matchSyncToken');
check('Bearer 与 X-Workshop-Token', () => {
  const tokens = [{ name: 'mbp', token: 'secret-sync' }];
  assert.equal(matchSyncToken({ headers: { authorization: 'Bearer secret-sync' } }, tokens), 'mbp');
  assert.equal(matchSyncToken({ headers: { 'x-workshop-token': 'secret-sync' } }, tokens), 'mbp');
  assert.equal(matchSyncToken({ headers: { authorization: 'Bearer nope' } }, tokens), null);
  assert.equal(matchSyncToken({ headers: {} }, tokens), null);
});
check('safeEqual 口径', () => {
  assert.equal(safeEqual('ab', 'ab'), true);
  assert.equal(safeEqual('ab', 'ac'), false);
});

// TV 默认仍独立（回归）
check('normalizeTv 默认不含 Tailscale CGNAT（sync 才有）', () => {
  assert.equal(normalizeTv(undefined).allowedCidrs.includes('100.64.0.0/10'), false);
});

group('normalizeSyncClient');
check('默认关闭 + 空 url/token + 15s + push true', () => {
  const c = normalizeSyncClient(undefined);
  assert.equal(c.enabled, false);
  assert.equal(c.url, '');
  assert.equal(c.token, '');
  assert.equal(c.intervalSec, 15);
  assert.equal(c.push, true);
});
check('push 仅显式 false 关闭', () => {
  assert.equal(normalizeSyncClient({}).push, true);
  assert.equal(normalizeSyncClient({ push: true }).push, true);
  assert.equal(normalizeSyncClient({ push: false }).push, false);
  assert.equal(normalizeSyncClient({ push: 'false' }).push, true);
});
check('enabled 只认严格 true；剥尾斜杠；interval 边界', () => {
  assert.equal(normalizeSyncClient({ enabled: 'true' }).enabled, false);
  const c = normalizeSyncClient({
    enabled: true,
    url: 'http://100.1.2.3:8491/',
    token: ' tok ',
    intervalSec: 3,
  });
  assert.equal(c.enabled, true);
  assert.equal(c.url, 'http://100.1.2.3:8491');
  assert.equal(c.token, 'tok');
  assert.equal(c.intervalSec, 15); // <5 回落
  assert.equal(normalizeSyncClient({ intervalSec: 30 }).intervalSec, 30);
});

group('merge rev');
check('remoteTodoWins 严格大于', () => {
  assert.equal(remoteTodoWins(100, 101), true);
  assert.equal(remoteTodoWins(100, 100), false);
  assert.equal(remoteTodoWins(100, 99), false);
  assert.equal(remoteTodoWins(undefined, 1), true);
});
// 远端状态变更必须让本机跟着开/闭段：同步快照不下发 spans（另一台机器的段对这台没意义、
// 段 id 还会撞），所以「本机正在进行中的段」只能由收到状态变更的这一侧自己关掉。
// 漏掉这条的后果：远端把待办置 done，本机日历里那条事件永不结束。
check('applyRemoteTodo：远端 done 时闭本机未闭合段', () => {
  const t = createTodo({ title: '远端完成它' });
  updateTodo(t.id, { status: 'in_progress' });
  assert.equal(listTodos().find((x) => x.id === t.id).spans.filter((s) => s.end === null).length, 1);
  applyRemoteTodo({ id: t.id, title: t.title, status: 'done', rev: Date.now() + 1000, updated_at: Date.now() + 1000 });
  const after = listTodos().find((x) => x.id === t.id);
  assert.equal(after.status, 'done');
  assert.ok(after.spans.length > 0 && after.spans.every((s) => s.end !== null), JSON.stringify(after.spans));
});
check('applyRemoteTodo：远端 in_progress 时开一段', () => {
  const t = createTodo({ title: '远端开始它' });
  applyRemoteTodo({ id: t.id, title: t.title, status: 'in_progress', rev: Date.now() + 2000, updated_at: Date.now() + 2000 });
  const after = listTodos().find((x) => x.id === t.id);
  assert.equal(after.status, 'in_progress');
  assert.equal(after.spans.filter((s) => s.end === null).length, 1, JSON.stringify(after.spans));
});
check('applyRemoteTodo：新建远端待办为 in_progress 时也开一段', () => {
  applyRemoteTodo({ id: 'remote-new-span', title: '远端新建', status: 'in_progress', rev: Date.now() + 3000, updated_at: Date.now() + 3000 });
  const after = listTodos().find((x) => x.id === 'remote-new-span');
  assert.equal(after.status, 'in_progress');
  assert.equal(after.spans.filter((s) => s.end === null).length, 1, JSON.stringify(after.spans));
});
check('planRemoteMerges：新 id / 更新 / 跳过', () => {
  const local = [
    { id: 'a', updated_at: 100 },
    { id: 'b', updated_at: 200 },
  ];
  const remote = [
    { id: 'a', rev: 150, title: '新' },
    { id: 'b', rev: 200, title: '同' },
    { id: 'c', rev: 1, title: '全新' },
  ];
  const { apply, skip } = planRemoteMerges(local, remote);
  assert.deepEqual(apply.map((t) => t.id), ['a', 'c']);
  assert.deepEqual(skip, ['b']);
});


group('planLocalPushes');
check('缺 hub id → post；本地更新 → patch；相等跳过', () => {
  const local = [
    { id: 'new', updated_at: 50, title: 'n' },
    { id: 'old', updated_at: 300, title: 'u' },
    { id: 'same', updated_at: 100, title: 's' },
  ];
  const hub = { old: 200, same: 100 };
  const { post, patch } = planLocalPushes(local, hub);
  assert.deepEqual(post.map((t) => t.id), ['new']);
  assert.equal(patch.length, 1);
  assert.equal(patch[0].id, 'old');
  assert.equal(patch[0].rev, 200);
});
check('Map 与空 hubRevs', () => {
  const m = new Map([['a', 10]]);
  const { post, patch } = planLocalPushes([{ id: 'a', updated_at: 11 }, { id: 'b', updated_at: 1 }], m);
  assert.deepEqual(post.map((t) => t.id), ['b']);
  assert.equal(patch[0].id, 'a');
  assert.deepEqual(planLocalPushes([{ id: 'x', updated_at: 1 }], {}).post.map((t) => t.id), ['x']);
});

group('planAfterConflict');
check('远端更新 / 本地仍新 / 对齐', () => {
  assert.equal(planAfterConflict({ id: 'a', updated_at: 10 }, { id: 'a', rev: 20 }).action, 'apply');
  assert.equal(planAfterConflict({ id: 'a', updated_at: 30 }, { id: 'a', rev: 20 }).action, 'retry');
  assert.equal(planAfterConflict({ id: 'a', updated_at: 20 }, { id: 'a', rev: 20 }).action, 'align');
});


group('sync-config role keys');
check('strip / restore 保留 sync syncClient tv', () => {
  const gw = {
    clientToken: 'ct',
    upstreamHeadersTimeoutMs: 1,
    sync: { enabled: true, port: 8491 },
    syncClient: { enabled: true, url: 'http://x' },
    tv: { enabled: false },
  };
  const stripped = stripRoleGateway(gw);
  assert.equal(stripped.clientToken, 'ct');
  for (const k of SYNC_ROLE_GATEWAY_KEYS) assert.equal(stripped[k], undefined);
  const restored = restoreRoleGateway({ clientToken: 'new', port: 9 }, gw);
  assert.equal(restored.clientToken, 'new');
  assert.deepEqual(restored.sync, gw.sync);
  assert.deepEqual(restored.syncClient, gw.syncClient);
  assert.deepEqual(restored.tv, gw.tv);
});
check('applyShareableToRaw 不覆盖角色键；rev 稳定', () => {
  const local = {
    gateway: { clientToken: 'old', sync: { enabled: true, tokens: [{ name: 'a', token: 't' }] }, syncClient: { enabled: true, url: 'http://hub' }, tv: { enabled: false } },
    providers: [{ id: 'a', name: 'A', baseUrl: 'http://a', protocol: 'openai', auth: { type: 'static-token', token: 'x' } }],
    routing: {},
  };
  const shared = extractShareableConfig({
    gateway: { clientToken: 'shared-ct', sync: { enabled: false }, syncClient: { enabled: false }, tv: { enabled: true } },
    providers: [{ id: 'b', name: 'B', baseUrl: 'http://b', protocol: 'openai', auth: { type: 'static-token', token: 'secret' } }],
    routing: { defaultProvider: 'b' },
    pricing: { 'b/m': { input: 1, output: 2 } },
    monitors: { inputs: [], list: [] },
    workbench: { reportModel: 'm' },
  });
  assert.equal(shared.gateway.sync, undefined);
  const merged = applyShareableToRaw(local, shared);
  assert.equal(merged.gateway.clientToken, 'shared-ct');
  assert.equal(merged.gateway.sync.enabled, true);
  assert.equal(merged.gateway.syncClient.url, 'http://hub');
  assert.equal(merged.gateway.tv.enabled, false);
  assert.equal(merged.providers[0].id, 'b');
  assert.equal(merged.providers[0].auth.token, 'secret');
  const r1 = configContentRev(shared);
  const r2 = configContentRev(extractShareableConfig(merged));
  // merged 角色键不在 shareable 内，providers 等同 → 同指纹
  assert.equal(r1, configContentRev(extractShareableConfig({ ...shared, gateway: shared.gateway })));
  assert.equal(typeof r1, 'string');
  assert.equal(r1.length, 16);
  assert.equal(r1, r2);
});

group('monitors 是本机事实：永不同步');
check('extractShareableConfig 不含 monitors（不下发、不进 rev）', () => {
  const shared = extractShareableConfig({
    providers: [{ id: 'p', name: 'P', baseUrl: 'http://p', protocol: 'openai' }],
    monitors: { inputs: [{ value: 15, name: 'Mac' }], list: [{ uuid: 'A016429F-BCEC-4FAF-BD7D-23128391F7F1', name: '左屏' }] },
  });
  assert.equal(shared.monitors, undefined, 'monitors 不该出现在可同步配置里');
  // 改显示器名字不能改变 rev——否则两台机器的配置会为它反复互相覆盖
  const a = configContentRev(extractShareableConfig({ providers: [], monitors: { inputs: [{ value: 15 }] } }));
  const b = configContentRev(extractShareableConfig({ providers: [], monitors: { inputs: [{ value: 21 }] } }));
  assert.equal(a, b, 'monitors 不参与 rev 指纹');
});
check('apply 时远端带的 monitors 被忽略、本机原值保留', () => {
  const local = {
    monitors: { inputs: [{ value: 15, name: '本机Mac' }], list: [{ uuid: 'AAAAAAAA-0000-0000-0000-000000000000', name: '本机屏' }] },
    providers: [{ id: 'a', name: 'A', baseUrl: 'http://a', protocol: 'openai' }],
  };
  // 场景 ①：远端有具体值（枢纽的屏 UUID）
  const merged1 = applyShareableToRaw(local, {
    providers: [{ id: 'b', name: 'B', baseUrl: 'http://b', protocol: 'openai' }],
    monitors: { inputs: [{ value: 21, name: '枢纽Mac' }], list: [{ uuid: 'BBBBBBBB-0000-0000-0000-000000000000', name: '枢纽屏' }] },
  });
  assert.deepEqual(merged1.monitors, local.monitors, '本机显示器配置必须原样保留');
  // 场景 ②：远端是空对象——这正是原 bug 最阴的形态（`s.monitors && …` 对 {} 为真，
  // 会把本机配置整段清空后回落硬编码默认值）
  const merged2 = applyShareableToRaw(local, { providers: [], ...{ monitors: {} } });
  assert.deepEqual(merged2.monitors, local.monitors, '空对象也不能清空本机配置');
  // 场景 ③：本机本来没配 → 不能被远端塞进来
  const merged3 = applyShareableToRaw({ providers: [] }, { providers: [], monitors: { inputs: [{ value: 15 }] } });
  assert.equal(merged3.monitors, undefined, '本机没有的键不该被远端创建');
});
check('remoteProjects / workbench 仍正常同步（本机事实只排除 monitors）', () => {
  const merged = applyShareableToRaw(
    { providers: [], workbench: { reportModel: 'old', remoteProjects: ['旧'] } },
    { providers: [], workbench: { reportModel: 'new', remoteProjects: ['黄区'] }, monitors: { inputs: [] } },
  );
  assert.equal(merged.workbench.reportModel, 'new');
  assert.deepEqual(merged.workbench.remoteProjects, ['黄区']);
  assert.equal(merged.monitors, undefined);
});

group('planConfigSync');
check('hub 新 → applyHub；本地脏 → pushLocal', () => {
  assert.equal(planConfigSync({ hubRev: 'aaa', localRev: 'bbb', lastAppliedRev: 'old', localUpdatedAt: 10, lastPullAt: 5 }).action, 'applyHub');
  assert.equal(planConfigSync({ hubRev: 'aaa', localRev: 'bbb', lastAppliedRev: 'aaa', localUpdatedAt: 20, lastPullAt: 10 }).action, 'pushLocal');
  assert.equal(planConfigSync({ hubRev: 'aaa', localRev: 'aaa', lastAppliedRev: 'aaa', localUpdatedAt: 20, lastPullAt: 10 }).action, 'noop');
});

group('sync-stats merge / replace-by-device');
check('sumDay 相加 providers 与 hours', () => {
  const a = {
    total: { req: 1, tin: 10, tout: 2, cost: 0.1 },
    providers: { p: { models: { m: { req: 1, tin: 10, tout: 2, cost: 0.1 } } } },
    hours: Array.from({ length: 24 }, (_, h) => (h === 3 ? { req: 1, tin: 10, tout: 2, cost: 0.1 } : { req: 0, tin: 0, tout: 0, cost: 0 })),
  };
  const b = {
    total: { req: 2, tin: 5, tout: 1, cost: 0.2 },
    providers: { p: { models: { m: { req: 2, tin: 5, tout: 1, cost: 0.2 } } }, q: { models: { n: { req: 1, tin: 1, tout: 1, cost: 0 } } } },
    hours: Array.from({ length: 24 }, (_, h) => (h === 3 ? { req: 2, tin: 5, tout: 1, cost: 0.2 } : { req: 0, tin: 0, tout: 0, cost: 0 })),
  };
  const s = sumDay(a, b);
  assert.equal(s.total.req, 3);
  assert.equal(s.total.tin, 15);
  assert.equal(s.providers.p.models.m.req, 3);
  assert.equal(s.providers.q.models.n.req, 1);
  assert.equal(s.hours[3].req, 3);
});
check('replaceDeviceDays 同切片再推不双计；跨设备 sum', () => {
  let store = migrateHubStatsStore(null);
  const daysA = { '2026-10-30': { total: { req: 5, tin: 1, tout: 1, cost: 0 }, providers: {}, hours: [] } };
  const r1 = replaceDeviceDays(store, 'macbook', daysA);
  assert.equal(r1.changed, true);
  store = r1.store;
  const r2 = replaceDeviceDays(store, 'macbook', daysA);
  assert.equal(r2.changed, false);
  assert.equal(r2.store.statsRev, store.statsRev);
  const daysA2 = { '2026-10-30': { total: { req: 8, tin: 1, tout: 1, cost: 0 }, providers: {}, hours: [] } };
  const r3 = replaceDeviceDays(store, 'macbook', daysA2);
  assert.equal(r3.changed, true);
  store = r3.store;
  const daysB = { '2026-10-30': { total: { req: 2, tin: 0, tout: 0, cost: 0 }, providers: {}, hours: [] } };
  store = replaceDeviceDays(store, 'mac-mini', daysB).store;
  const summed = sumDaysMaps(store.devices.macbook.days, store.devices['mac-mini'].days);
  assert.equal(summed['2026-10-30'].total.req, 10);
});
check('sanitizeDaysForSync 去掉 perf.s', () => {
  const days = {
    '2026-10-30': {
      total: { req: 1, perf: { ttft: { n: 1, sum: 10, b: [1], s: [10] }, tpot: { n: 0, sum: 0, b: [] }, itl: { n: 0, sum: 0, b: [] }, e2e: { n: 0, sum: 0, b: [] }, dtok: 0, dms: 0, dn: 0 } },
      providers: {},
      hours: [],
    },
  };
  const s = sanitizeDaysForSync(days);
  assert.equal(s['2026-10-30'].total.perf.ttft.s, undefined);
  assert.equal(s['2026-10-30'].total.perf.ttft.n, 1);
});
check('snapshot 可带 config/stats', () => {
  const snap = buildSyncSnapshot({
    todos: [],
    now: 1,
    config: { rev: 'abc', providers: [] },
    stats: { rev: 1, days: {} },
  });
  assert.equal(snap.version, 2);
  assert.equal(snap.config.rev, 'abc');
  assert.equal(snap.stats.rev, 1);
});
check('wrapStatsForSync days = devices sum + hubLocal overlay', () => {
  let store = migrateHubStatsStore(null);
  store = replaceDeviceDays(store, 'macbook', {
    '2026-10-30': { total: { req: 5, tin: 1, tout: 1, cost: 1.5 }, providers: {}, hours: [] },
  }).store;
  store = replaceDeviceDays(store, 'other', {
    '2026-10-30': { total: { req: 2, tin: 0, tout: 0, cost: 0.5 }, providers: {}, hours: [] },
  }).store;
  const hubLocal = {
    '2026-10-30': { total: { req: 3, tin: 0, tout: 0, cost: 0.25 }, providers: {}, hours: [] },
  };
  const section = wrapStatsForSync(store, { hubLocalDays: hubLocal, hubDeviceId: 'mini', now: 99 });
  assert.equal(section.days['2026-10-30'].total.req, 10);
  assert.equal(section.days['2026-10-30'].total.cost, 2.25);
  assert.equal(section.hubDeviceId, 'mini');
  assert.equal(section.deviceCount, 3); // 2 devices + hubLocal
  const withoutLocal = wrapStatsForSync(store, { hubLocalDays: null, hubDeviceId: 'mini', now: 99 });
  assert.equal(withoutLocal.days['2026-10-30'].total.req, 7);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
