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

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
try { fs.rmSync(tmpA, { recursive: true, force: true }); fs.rmSync(tmpB, { recursive: true, force: true }); } catch {}
process.exit(failures.length ? 1 : 0);
