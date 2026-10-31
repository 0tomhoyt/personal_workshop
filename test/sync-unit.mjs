// gateway.sync 纯函数单测：normalizeSync / buildSyncSnapshot / matchSyncToken
// 运行: node test/sync-unit.mjs
import assert from 'node:assert/strict';
import { normalizeSync, SYNC_DEFAULT_CIDRS, normalizeTv } from '../lib/config.mjs';
import { buildSyncSnapshot, toSyncTodo } from '../lib/sync-snapshot.mjs';
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
