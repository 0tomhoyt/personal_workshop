// 终端监听（gateway.terminal）纯函数单测（不起进程，快）：
//   配置归一、项目白名单、token 撞车、CIDR、消息/事件归一、待批归并、host 判定。
// 运行: node test/terminal-unit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeTerminal, TERMINAL_DEFAULT_CIDRS } from '../lib/config.mjs';
import { SYNC_ROLE_GATEWAY_KEYS } from '../lib/sync-config.mjs';

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(name); console.log(`  ✗ ${name} — ${e.message}`); }
}
const group = (title) => console.log(`— ${title} —`);

// realpath 校验用真实临时目录（macOS 上 /var/folders → /private/var/...，正好覆盖归一）
const tmpA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-unit-a-')));
const tmpB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-unit-b-')));

group('normalizeTerminal · 默认与基本归一');
check('undefined → 全默认', () => {
  const t = normalizeTerminal(undefined);
  assert.equal(t.enabled, false);
  assert.equal(t.port, 8492);
  assert.equal(t.bind, '0.0.0.0');
  assert.deepEqual(t.tokens, []);
  assert.deepEqual(t.allowedCidrs, TERMINAL_DEFAULT_CIDRS);
  assert.equal(t.maxPerMinute, 120);
  assert.equal(t.backendPort, 4096);
  assert.equal(t.backendBin, '');
  assert.deepEqual(t.projects, []);
});
check('enabled/port/bind/合法值透传', () => {
  const t = normalizeTerminal({ enabled: true, port: 9000, bind: '127.0.0.1', backendPort: 4100, backendBin: '/x/opencode', maxPerMinute: 60 });
  assert.equal(t.enabled, true);
  assert.equal(t.port, 9000);
  assert.equal(t.bind, '127.0.0.1');
  assert.equal(t.backendPort, 4100);
  assert.equal(t.backendBin, '/x/opencode');
  assert.equal(t.maxPerMinute, 60);
});
check('port/bind/maxPerMinute/backendPort 非法值回落默认', () => {
  const t = normalizeTerminal({ enabled: true, port: 99999, bind: '', maxPerMinute: -5, backendPort: 'abc' });
  assert.equal(t.port, 8492);
  assert.equal(t.bind, '0.0.0.0');
  assert.equal(t.maxPerMinute, 120);
  assert.equal(t.backendPort, 4096);
});

group('normalizeTerminal · token 撞车');
check('与 clientToken 相同 → 该枚被丢、其余保留', () => {
  const t = normalizeTerminal({ tokens: [{ name: 'a', token: 'X-KEEP' }, { name: 'b', token: 'sk-CLIENT' }] }, 'sk-CLIENT');
  assert.deepEqual(t.tokens.map((x) => x.token), ['X-KEEP']);
});
check('与 gateway.tv.tokens 相同 → 被丢', () => {
  const tvRaw = { tokens: [{ name: 'tv', token: 'TVT' }] };
  const t = normalizeTerminal({ tokens: [{ name: 'a', token: 'TVT' }, { name: 'b', token: 'OK' }] }, null, tvRaw);
  assert.deepEqual(t.tokens.map((x) => x.token), ['OK']);
});
check('与 gateway.sync.tokens 相同 → 被丢', () => {
  const syncRaw = { tokens: [{ name: 'm1', token: 'SYNCT' }] };
  const t = normalizeTerminal({ tokens: [{ name: 'a', token: 'SYNCT' }] }, null, null, syncRaw);
  assert.deepEqual(t.tokens, []);
});
check('重复 token 去重；name 空回落编号；token 去空白', () => {
  const t = normalizeTerminal({ tokens: [{ token: ' T1 ' }, { name: 'b', token: 'T1' }, { name: '  ', token: 'T2' }] });
  assert.equal(t.tokens.length, 2);
  assert.equal(t.tokens[0].name, 'terminal1');
  assert.equal(t.tokens[0].token, 'T1');
  assert.equal(t.tokens[1].name, 'terminal2');
});

group('normalizeTerminal · projects 白名单');
check('相对路径丢弃、存在目录 realpath 归一、名字回落 basename', () => {
  const t = normalizeTerminal({ projects: [{ name: '甲', dir: '相对路径' }, { dir: tmpA }] });
  assert.equal(t.projects.length, 1);
  assert.equal(t.projects[0].dir, tmpA);
  assert.equal(t.projects[0].name, path.basename(tmpA));
});
check('文件（非目录）也丢弃', () => {
  const f = path.join(tmpA, 'f.txt');
  fs.writeFileSync(f, 'x');
  const t = normalizeTerminal({ projects: [{ dir: f }] });
  assert.deepEqual(t.projects, []);
});
check('重复 dir 留第一条；name 去空白截 40 字符', () => {
  const long = '名'.repeat(50);
  const t = normalizeTerminal({ projects: [
    { name: `  ${long}  `, dir: tmpA },
    { name: 'later', dir: tmpA },
    { name: '乙', dir: tmpB },
  ] });
  assert.equal(t.projects.length, 2);
  assert.equal(t.projects[0].name, '名'.repeat(40));
  assert.equal(t.projects[0].dir, tmpA);
  assert.equal(t.projects[1].name, '乙');
});

group('normalizeTerminal · allowedCidrs');
check('非法项剔除、合法项去重', () => {
  const t = normalizeTerminal({ allowedCidrs: ['999.1.1.1/8', '10.0.0.0/8', '10.0.0.0/8'] });
  assert.deepEqual(t.allowedCidrs, ['10.0.0.0/8']);
});
check('自填合法值则完全替换默认（不叠加）', () => {
  const t = normalizeTerminal({ allowedCidrs: ['127.0.0.1/32'] });
  assert.deepEqual(t.allowedCidrs, ['127.0.0.1/32']);
});
check('TERMINAL_DEFAULT_CIDRS 含私网/回环/Tailscale', () => {
  for (const c of ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '100.64.0.0/10', '127.0.0.1/32', '::1/128']) {
    assert.ok(TERMINAL_DEFAULT_CIDRS.includes(c), c);
  }
});

group('同步排除');
check("SYNC_ROLE_GATEWAY_KEYS 含 'terminal'（永不进 Mac↔Mac 同步）", () => {
  assert.ok(SYNC_ROLE_GATEWAY_KEYS.includes('terminal'));
});

// ── 适配层：fixture 字段名与真实 opencode 1.18.31 一致（2026-10-31 实测）───────
import {
  truncate, normalizePart, normalizeMessage, mapEvent, normalizePermission, normalizeQuestion,
} from '../lib/terminal/adapter.mjs';

group('adapter · truncate');
check('短串原样；长串按码位截断加尾缀；非 string 先 JSON.stringify', () => {
  assert.equal(truncate('abc', 10), 'abc');
  const cut = truncate('x'.repeat(50), 10);
  assert.equal(cut.length, 'x'.repeat(10).length + '…(截断)'.length);
  assert.ok(cut.endsWith('…(截断)'));
  assert.equal(truncate({ a: 1 }, 100), '{"a":1}');
  assert.equal(truncate(null, 100), 'null');
});

group('adapter · normalizePart（12 种 part 映射）');
const basePart = (over) => ({ id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', ...over });
check('text → 带 id/messageId；synthetic/ignored 丢弃', () => {
  assert.deepEqual(normalizePart(basePart({ type: 'text', text: 'hi' })), { id: 'prt_1', messageId: 'msg_1', type: 'text', text: 'hi' });
  assert.equal(normalizePart(basePart({ type: 'text', text: 'x', synthetic: true })), null);
  assert.equal(normalizePart(basePart({ type: 'text', text: 'x', ignored: true })), null);
});
check('reasoning → text 字段透传', () => {
  assert.deepEqual(normalizePart(basePart({ type: 'reasoning', text: '想' })), { id: 'prt_1', messageId: 'msg_1', type: 'reasoning', text: '想' });
});
check('tool → name/callId/status/input/output', () => {
  const p = normalizePart(basePart({
    type: 'tool', callID: 'call_9', tool: 'bash',
    state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb' },
  }));
  assert.deepEqual(p, {
    id: 'prt_1', messageId: 'msg_1', type: 'tool', name: 'bash', callId: 'call_9',
    status: 'completed', input: '{"command":"ls"}', output: 'a\nb', error: undefined, files: undefined,
  });
});
check('tool → output 超 8K 截断、input 超 2K 截断', () => {
  const p = normalizePart(basePart({
    type: 'tool', tool: 'bash',
    state: { status: 'completed', input: { command: 'c'.repeat(5000) }, output: 'o'.repeat(20000) },
  }));
  assert.ok(p.output.length < 20000 && p.output.endsWith('…(截断)'));
  assert.ok(p.input.length < 5000 + 20 && p.input.endsWith('…(截断)'));
});
check('tool → error 透传（string 化）', () => {
  const p = normalizePart(basePart({ type: 'tool', tool: 'bash', state: { status: 'error', input: {}, error: '失败' } }));
  assert.equal(p.error, '失败');
});
check('patch → 文件名列表；file → 不回 url', () => {
  assert.deepEqual(normalizePart(basePart({ type: 'patch', hash: 'h', files: ['a.ts', 'b.ts'] })),
    { id: 'prt_1', messageId: 'msg_1', type: 'patch', files: ['a.ts', 'b.ts'] });
  assert.deepEqual(normalizePart(basePart({ type: 'file', mime: 'image/png', filename: 'x.png', url: 'data:...' })),
    { id: 'prt_1', messageId: 'msg_1', type: 'file', mime: 'image/png', filename: 'x.png' });
});
check('step-start / step-finish → type:step，finish 带结束信息', () => {
  assert.deepEqual(normalizePart(basePart({ type: 'step-start' })), { id: 'prt_1', messageId: 'msg_1', type: 'step' });
  const fin = normalizePart(basePart({ type: 'step-finish', reason: 'stop', cost: 0.5, tokens: { input: 10, output: 5 } }));
  assert.deepEqual(fin, { id: 'prt_1', messageId: 'msg_1', type: 'step', finish: 'stop', cost: 0.5, tokens: { input: 10, output: 5 } });
});
check('snapshot/subtask/agent/retry/compaction → 丢弃', () => {
  for (const t of ['snapshot', 'subtask', 'agent', 'retry', 'compaction']) {
    assert.equal(normalizePart(basePart({ type: t })), null, t);
  }
});
check('缺 id/messageID 的坏 part → 丢弃', () => {
  assert.equal(normalizePart({ type: 'text', text: 'x', messageID: 'm' }), null);
  assert.equal(normalizePart(null), null);
});

group('adapter · normalizeMessage');
check('info → id/role/at；parts 归一且丢 null', () => {
  const m = normalizeMessage({
    info: { id: 'msg_1', role: 'assistant', time: { created: 123, completed: 456 } },
    parts: [basePart({ type: 'text', text: 'a' }), basePart({ type: 'snapshot', snapshot: 'x' })],
  });
  assert.deepEqual(m, { id: 'msg_1', role: 'assistant', at: 123, parts: [{ id: 'prt_1', messageId: 'msg_1', type: 'text', text: 'a' }] });
});
check('全 null parts → parts:[] 仍返回；坏消息 → null', () => {
  assert.deepEqual(normalizeMessage({ info: { id: 'm', role: 'user', time: {} }, parts: [basePart({ type: 'agent', name: 'x' })] }),
    { id: 'm', role: 'user', at: undefined, parts: [] });
  assert.equal(normalizeMessage(null), null);
});

group('adapter · mapEvent（事件裁剪）');
check('message.part.updated → part 事件（归一后的 part）', () => {
  const ev = { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: basePart({ type: 'text', text: 'hi' }) } };
  assert.deepEqual(mapEvent(ev), { event: 'part', sessionID: 'ses_1', data: { id: 'prt_1', messageId: 'msg_1', type: 'text', text: 'hi' } });
});
check('message.part.delta → delta 事件（messageId/partId/field/delta）', () => {
  const ev = { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_2', partID: 'prt_3', field: 'text', delta: '你好' } };
  assert.deepEqual(mapEvent(ev), { event: 'delta', sessionID: 'ses_1', data: { messageId: 'msg_2', partId: 'prt_3', field: 'text', delta: '你好' } });
});
check('session.status busy / session.idle → status 事件', () => {
  assert.deepEqual(mapEvent({ type: 'session.status', properties: { sessionID: 's', status: { type: 'busy' } } }),
    { event: 'status', sessionID: 's', data: { busy: true } });
  assert.deepEqual(mapEvent({ type: 'session.idle', properties: { sessionID: 's' } }),
    { event: 'status', sessionID: 's', data: { busy: false } });
});
check('message.updated → status 事件带 completed', () => {
  const ev = { type: 'message.updated', properties: { sessionID: 's', info: { id: 'msg_2', role: 'assistant', time: { completed: 789 } } } };
  assert.deepEqual(mapEvent(ev), { event: 'status', sessionID: 's', data: { messageId: 'msg_2', role: 'assistant', completed: 789 } });
});
check('permission.*/question.* → pending 事件（不带详情）', () => {
  for (const t of ['permission.asked', 'permission.replied', 'question.asked', 'question.replied', 'question.rejected']) {
    const r = mapEvent({ type: t, properties: { sessionID: 's', id: 'per_1' } });
    assert.deepEqual(r, { event: 'pending', sessionID: 's', data: null }, t);
  }
});
check('server.*/session.updated/session.diff/未知 → 不转发', () => {
  for (const t of ['server.connected', 'server.heartbeat', 'session.updated', 'session.diff', 'plugin.added', 'catalog.updated', 'integration.updated', 'reference.updated', 'made.up']) {
    assert.equal(mapEvent({ type: t, properties: { sessionID: 's' } }), null, t);
  }
});

group('adapter · 待批归一');
check('normalizePermission → summary=类型 detail=command（缺 metadata 用 patterns）', () => {
  assert.deepEqual(
    normalizePermission({ id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['echo x'], metadata: { command: 'echo x' } }, '标题甲'),
    { kind: 'permission', id: 'per_1', session: 'ses_1', sessionTitle: '标题甲', summary: 'bash', detail: 'echo x', options: null },
  );
  assert.equal(
    normalizePermission({ id: 'per_2', sessionID: 'ses_1', permission: 'edit', patterns: ['src/**'] }, 't').detail,
    'src/**',
  );
});
check('normalizeQuestion → summary=header detail=question options 原样', () => {
  const q = {
    id: 'que_1', sessionID: 'ses_1',
    questions: [{ question: '选哪个？', header: '方案', multiple: false, custom: true, options: [{ label: 'A', description: '甲' }, { label: 'B', description: '乙' }] }],
  };
  assert.deepEqual(normalizeQuestion(q, '标题乙'), {
    kind: 'question', id: 'que_1', session: 'ses_1', sessionTitle: '标题乙',
    summary: '方案', detail: '选哪个？',
    options: { questions: q.questions, multiple: false, custom: true },
  });
});

// ── host：孤儿判定与日志打码（纯逻辑）────────────────────────────────────────
import { shouldKillOrphan, redactLine } from '../lib/terminal/host.mjs';

group('host · shouldKillOrphan');
check('活 + 命令行含 opencode 与正确端口 → 杀（是孤儿）', () => {
  assert.equal(shouldKillOrphan({ pid: 123 }, { alive: true, command: '/x/opencode serve --port 4096 --hostname 127.0.0.1', backendPort: 4096 }), true);
});
check('活 + 命令行不含 opencode（pid 被复用）→ 不杀', () => {
  assert.equal(shouldKillOrphan({ pid: 123 }, { alive: true, command: 'sleep 100', backendPort: 4096 }), false);
});
check('进程已死 → 不杀', () => {
  assert.equal(shouldKillOrphan({ pid: 123 }, { alive: false, command: 'opencode serve --port 4096', backendPort: 4096 }), false);
});
check('命令行匹配但端口不同（别人的 opencode）→ 不杀', () => {
  assert.equal(shouldKillOrphan({ pid: 123 }, { alive: true, command: 'opencode serve --port 9999 --hostname 127.0.0.1', backendPort: 4096 }), false);
});
check('无 pidfile 记录 → 不杀', () => {
  assert.equal(shouldKillOrphan(null, { alive: true, command: 'opencode serve --port 4096', backendPort: 4096 }), false);
});

group('host · redactLine');
check('口令明文替换为 ***；不含口令的行原样', () => {
  const secret = 'a'.repeat(32);
  assert.equal(redactLine(`listening pw=${secret}`, secret), 'listening pw=***');
  assert.equal(redactLine('普通日志行', secret), '普通日志行');
  assert.equal(redactLine('没有口令可用时原样', ''), '没有口令可用时原样');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
try { fs.rmSync(tmpA, { recursive: true, force: true }); fs.rmSync(tmpB, { recursive: true, force: true }); } catch {}
process.exit(failures.length ? 1 : 0);
