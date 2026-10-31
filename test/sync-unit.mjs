// gateway.sync 纯函数单测：normalizeSync / buildSyncSnapshot / matchSyncToken
// 运行: node test/sync-unit.mjs
import assert from 'node:assert/strict';
import { normalizeSync, normalizeSyncClient, SYNC_DEFAULT_CIDRS, normalizeTv } from '../lib/config.mjs';
import { buildSyncSnapshot, toSyncTodo } from '../lib/sync-snapshot.mjs';
import { planRemoteMerges, planLocalPushes, planAfterConflict } from '../lib/sync-client.mjs';
import { remoteTodoWins } from '../lib/todos.mjs';
import { matchSyncToken } from '../lib/sync-server.mjs';
import { safeEqual } from '../lib/gwauth.mjs';

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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
