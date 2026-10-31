// gateway.sync 端到端：临时目录起网关，验证
//   - 默认关闭：不监听 8491
//   - 无 token → 401；白名单外 → 404；health 带 token → 200
//   - 不暴露 /admin /v1
// 运行: node test/sync.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GW_PORT = 6294;
const SYNC_PORT = 6295;
const TOKEN = 'sk-test-client-token';
const SYNC_TOKEN = 'sync-test-token-aaaaaaaaaaaaaaaa';

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-sync-'));
const configFile = path.join(tmp, 'providers.json');

function writeConfig(sync) {
  const raw = {
    gateway: { clientToken: TOKEN, ...(sync === undefined ? {} : { sync }) },
    providers: [
      { id: 'mock-oai', name: 'MockOAI', baseUrl: 'http://127.0.0.1:1/oai', protocol: 'openai', auth: { type: 'static-token', token: 'x' }, models: { source: 'static', list: [{ id: 'm' }] } },
    ],
  };
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2));
}

writeConfig({
  enabled: true,
  port: SYNC_PORT,
  bind: '127.0.0.1',
  tokens: [{ name: 'macbook', token: SYNC_TOKEN }],
  maxPerMinute: 120,
});

const gateway = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CANNBOT_PROXY_PORT: String(GW_PORT),
    CANNBOT_CONFIG_FILE: configFile,
    CANNBOT_LOG_FILE: path.join(tmp, 'proxy.log'),
    CANNBOT_STATS_FILE: path.join(tmp, 'stats.json'),
    CANNBOT_STATS_SYNC_FILE: path.join(tmp, 'stats-sync.json'),
    CANNBOT_SYNC_STATS_FILE: path.join(tmp, 'stats-sync-hub.json'),
    CANNBOT_TODOS_FILE: path.join(tmp, 'todos.json'),
    CANNBOT_REPORTS_FILE: path.join(tmp, 'reports.json'),
    CANNBOT_CC_DIR: path.join(tmp, 'cc'),
    CANNBOT_ZCODE_DB: path.join(tmp, 'none.db'),
    CANNBOT_OPENCODE_DB: path.join(tmp, 'none.db'),
    CANNBOT_CURSOR_DIR: path.join(tmp, 'cursor'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
gateway.stdout.on('data', (d) => out.push(d));
gateway.stderr.on('data', (d) => out.push(d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYNC = `http://127.0.0.1:${SYNC_PORT}`;
const syncHeaders = (token = SYNC_TOKEN) => ({ authorization: `Bearer ${token}` });

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status) return r; } catch {}
    await sleep(100);
  }
  return null;
}

function portClosed(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/sync/v1/health', timeout: 400 }, (res) => {
      res.resume();
      resolve(false);
    });
    req.on('error', () => resolve(true));
    req.on('timeout', () => { req.destroy(); resolve(true); });
    req.end();
  });
}

async function spawnWith(sync, port, label) {
  writeConfig(sync);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CANNBOT_PROXY_PORT: String(GW_PORT + 10 + Math.floor(Math.random() * 200)),
      CANNBOT_CONFIG_FILE: configFile,
      CANNBOT_LOG_FILE: path.join(tmp, `proxy-${label}.log`),
      CANNBOT_STATS_FILE: path.join(tmp, `stats-${label}.json`),
      CANNBOT_TODOS_FILE: path.join(tmp, `todos-${label}.json`),
      CANNBOT_REPORTS_FILE: path.join(tmp, `reports-${label}.json`),
      CANNBOT_CC_DIR: path.join(tmp, 'cc'),
      CANNBOT_ZCODE_DB: path.join(tmp, 'none.db'),
      CANNBOT_OPENCODE_DB: path.join(tmp, 'none.db'),
      CANNBOT_CURSOR_DIR: path.join(tmp, 'cursor'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(600);
  const closed = await portClosed(port);
  try { child.kill('SIGTERM'); } catch {}
  await sleep(200);
  return { closed, label };
}

try {
  await waitFor(`http://127.0.0.1:${GW_PORT}/healthz`);
  await waitFor(`${SYNC}/sync/v1/health`, 50);

  console.log('— 同步监听 · 鉴权与白名单 —');
  {
    const noToken = await fetch(`${SYNC}/sync/v1/health`);
    check('无 token → 401', noToken.status === 401, `got ${noToken.status}`);

    const wrong = await fetch(`${SYNC}/sync/v1/snapshot`, { headers: syncHeaders('nope') });
    check('错 token → 401', wrong.status === 401, `got ${wrong.status}`);

    const client = await fetch(`${SYNC}/sync/v1/health`, { headers: syncHeaders(TOKEN) });
    check('clientToken 不能当 sync token（401）', client.status === 401, `got ${client.status}`);

    const health = await fetch(`${SYNC}/sync/v1/health`, { headers: syncHeaders() });
    const hj = await health.json();
    check('health → 200 且 service=gateway-sync', health.status === 200 && hj.service === 'gateway-sync' && hj.ok === true, JSON.stringify(hj).slice(0, 120));

    const xh = await fetch(`${SYNC}/sync/v1/health`, { headers: { 'x-workshop-token': SYNC_TOKEN } });
    check('X-Workshop-Token → 200', xh.status === 200, `got ${xh.status}`);

    for (const p of ['/admin/stats', '/admin/config', '/v1/todos', '/v1/models', '/', '/sync/v1', '/tv/v1/health']) {
      const r = await fetch(`${SYNC}${p}`, { headers: syncHeaders() });
      check(`白名单外 ${p} → 404`, r.status === 404, `got ${r.status}`);
    }

    const snap = await fetch(`${SYNC}/sync/v1/snapshot`, { headers: syncHeaders() });
    const sj = await snap.json();
    check('snapshot → 200 且带 version/todos/cursor/config/stats', snap.status === 200 && sj.version === 2 && Array.isArray(sj.todos) && typeof sj.cursor === 'number' && sj.config?.rev && sj.stats && typeof sj.stats.rev === 'number', JSON.stringify({v:sj.version,cfg:sj.config?.rev,st:sj.stats?.rev,td:sj.todos?.length}).slice(0, 160));

    const created = await fetch(`${SYNC}/sync/v1/todos`, {
      method: 'POST',
      headers: { ...syncHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'sync-e2e', status: 'pending' }),
    });
    const cj = await created.json();
    check('POST todo → 201 且带 rev', created.status === 201 && cj.id && typeof cj.rev === 'number', JSON.stringify(cj).slice(0, 160));

    const stableId = 'ab12cd';
    const stamped = await fetch(`${SYNC}/sync/v1/todos`, {
      method: 'POST',
      headers: { ...syncHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: stableId, title: 'spoke-push', status: 'pending',
        updated_at: 1_700_000_000_000, rev: 1_700_000_000_000, created_at: 1_700_000_000_000,
      }),
    });
    const sj2 = await stamped.json();
    check('POST 带稳定 id → 201 且保留 id/rev', stamped.status === 201 && sj2.id === stableId && sj2.rev === 1_700_000_000_000, JSON.stringify(sj2).slice(0, 160));

    const dup = await fetch(`${SYNC}/sync/v1/todos`, {
      method: 'POST',
      headers: { ...syncHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ id: stableId, title: 'dup', rev: 1 }),
    });
    const dj = await dup.json();
    check('POST 重复 id → 409', dup.status === 409 && dj.todo?.id === stableId, JSON.stringify(dj).slice(0, 160));

    const patched = await fetch(`${SYNC}/sync/v1/todos/${stableId}`, {
      method: 'PATCH',
      headers: { ...syncHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'spoke-push-2', rev: 1_700_000_000_000 }),
    });
    const pj = await patched.json();
    check('PATCH 正确 rev → 200', patched.status === 200 && pj.title === 'spoke-push-2' && pj.rev > 1_700_000_000_000, JSON.stringify(pj).slice(0, 160));

    const stale = await fetch(`${SYNC}/sync/v1/todos/${stableId}`, {
      method: 'PATCH',
      headers: { ...syncHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'stale', rev: 1_700_000_000_000 }),
    });
    check('PATCH 过期 rev → 409', stale.status === 409, `got ${stale.status}`);

    const stPost = await fetch(`${SYNC}/sync/v1/stats`, {
      method: 'POST',
      headers: { ...syncHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'macbook-test',
        days: { '2026-10-30': { total: { req: 3, tin: 1, tout: 1, cost: 0 }, providers: { 'mock-oai': { models: { m: { req: 3, tin: 1, tout: 1, cost: 0 } } } }, hours: [] } },
      }),
    });
    const stj = await stPost.json();
    check('POST stats → 200 且含 device', stPost.status === 200 && stj.ok && stj.deviceId === 'macbook-test' && stj.stats?.days?.['2026-10-30']?.total?.req >= 3, JSON.stringify(stj).slice(0, 200));

    const stPost2 = await fetch(`${SYNC}/sync/v1/stats`, {
      method: 'POST',
      headers: { ...syncHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'macbook-test',
        days: { '2026-10-30': { total: { req: 3, tin: 1, tout: 1, cost: 0 }, providers: { 'mock-oai': { models: { m: { req: 3, tin: 1, tout: 1, cost: 0 } } } }, hours: [] } },
      }),
    });
    const stj2 = await stPost2.json();
    check('POST stats 同切片再推 changed=false（不双计）', stPost2.status === 200 && stj2.changed === false, JSON.stringify(stj2).slice(0, 160));

    // 枢纽 buildStatsSection 应把跨设备 sum 写入 stats-sync.json，供本机 /admin/stats 展示
    const syncDisplayPath = path.join(tmp, 'stats-sync.json');
    let displayOk = false;
    let displayDetail = '';
    try {
      const raw = JSON.parse(fs.readFileSync(syncDisplayPath, 'utf8'));
      const dayReq = raw?.days?.['2026-10-30']?.total?.req;
      const sectionReq = stj2.stats?.days?.['2026-10-30']?.total?.req;
      displayOk = Number(raw?.version) === 1
        && dayReq != null
        && sectionReq != null
        && Number(dayReq) === Number(sectionReq)
        && Number(dayReq) >= 3;
      displayDetail = JSON.stringify({ dayReq, sectionReq, rev: raw?.rev }).slice(0, 160);
    } catch (e) {
      displayDetail = e.message;
    }
    check('hub POST stats 后写出 stats-sync.json 且 days 与 section 一致', displayOk, displayDetail);

    const cfgGet = await fetch(`${SYNC}/sync/v1/config`, { headers: syncHeaders() });
    const cgj = await cfgGet.json();
    check('GET config → 200 且无 gateway.sync 键', cfgGet.status === 200 && cgj.rev && cgj.gateway && cgj.gateway.sync === undefined && Array.isArray(cgj.providers), JSON.stringify({ rev: cgj.rev, keys: Object.keys(cgj.gateway||{}) }).slice(0, 160));
  }

  console.log('— 默认关闭不监听 —');
  {
    // 先停主测实例，避免端口占用干扰；关闭用例用独立子进程 + 独立端口
    try { gateway.kill('SIGTERM'); } catch {}
    await sleep(300);

    const cases = [
      ['没有 gateway.sync 节', undefined, 6391],
      ['enabled=false', { enabled: false, port: 6392, bind: '127.0.0.1', tokens: [{ name: 'x', token: SYNC_TOKEN }] }, 6392],
      ['tokens 为空', { enabled: true, port: 6393, bind: '127.0.0.1', tokens: [] }, 6393],
    ];
    for (const [label, sync, port] of cases) {
      const r = await spawnWith(sync, port, label.replace(/\s+/g, '-'));
      check(`${label} → 不监听`, r.closed, label);
    }
  }
} catch (e) {
  failures.push(`异常: ${e.message}`);
  console.error(e);
  console.error(Buffer.concat(out).toString('utf8').slice(-2000));
} finally {
  try { gateway.kill('SIGTERM'); } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(Buffer.concat(out).toString('utf8').slice(-2000));
  process.exit(1);
}
