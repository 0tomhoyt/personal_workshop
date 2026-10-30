// 电视工作台监听（gateway.tv）端到端测试：起一个网关实例（临时目录配置），验证
//   - 默认关闭：不配 gateway.tv（或 enabled=false / tokens 为空）时 8490 不监听
//   - 白名单：/tv/v1/snapshot、/tv/v1/health 之外一律 404（含 /admin/*、/v1/*）
//   - 鉴权：无 token / 错 token → 401；clientToken 不能当 TV token 用
//   - 来源：非私网（这里用 127.0.0.2——回环但不默认在白名单里）→ 403
//   - Host 反 rebinding：外部域名 Host → 403
//   - 快照：形状、字段裁剪（无 spans/perf/days/prices）、排序、runningMs/doneToday、体积
//   - ETag：If-None-Match 命中 → 304；内容变了 → 200 新 ETag
//   - 限速：超限 → 429
//   - 8484 行为不变：没有 TV token 也能照常访问 /admin/*（只绑回环）
// 运行: node test/tv.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GW_PORT = 6292;
const TV_PORT = 6293;
const TOKEN = 'sk-test-client-token';
const TV_TOKEN = 'tv-test-token-aaaaaaaaaaaaaaaa';
const TV_TOKEN_2 = 'tv-test-token-bbbbbbbbbbbbbbbb';

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-tv-'));
const configFile = path.join(tmp, 'providers.json');

function writeConfig(tv) {
  const raw = {
    gateway: { clientToken: TOKEN, ...(tv === undefined ? {} : { tv }) },
    providers: [
      { id: 'mock-oai', name: 'MockOAI', baseUrl: 'http://127.0.0.1:1/oai', protocol: 'openai', auth: { type: 'static-token', token: 'x' }, models: { source: 'static', list: [{ id: 'm' }] } },
    ],
  };
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2));
}

writeConfig({ enabled: true, port: TV_PORT, bind: '127.0.0.1', tokens: [{ name: 'living-room', token: TV_TOKEN }, { name: 'bedroom', token: TV_TOKEN_2 }], maxPerMinute: 30 });

const gateway = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CANNBOT_PROXY_PORT: String(GW_PORT),
    CANNBOT_CONFIG_FILE: configFile,
    CANNBOT_LOG_FILE: path.join(tmp, 'proxy.log'),
    CANNBOT_STATS_FILE: path.join(tmp, 'stats.json'),
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
const TV = `http://127.0.0.1:${TV_PORT}`;
const tvHeaders = (token = TV_TOKEN) => ({ 'x-aerial-token': token });
const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status) return r; } catch {}
    await sleep(100);
  }
  return null;
}

/** 原始 HTTP 请求：fetch 不允许改 Host，反 rebinding 用例需要 http.request。 */
function rawGet(port, pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}


try {
  await waitFor(`http://127.0.0.1:${GW_PORT}/healthz`);
  await waitFor(`${TV}/tv/v1/health`, 50);

  console.log('— 电视监听 · 白名单与鉴权 —');
  {
    const noToken = await fetch(`${TV}/tv/v1/snapshot`);
    check('无 token → 401', noToken.status === 401, `got ${noToken.status}`);

    const wrong = await fetch(`${TV}/tv/v1/snapshot`, { headers: tvHeaders('nope') });
    check('错 token → 401', wrong.status === 401, `got ${wrong.status}`);

    const client = await fetch(`${TV}/tv/v1/snapshot`, { headers: tvHeaders(TOKEN) });
    check('clientToken 不能当 TV token（401）', client.status === 401, `got ${client.status}`);

    const health = await fetch(`${TV}/tv/v1/health`, { headers: tvHeaders() });
    const hj = await health.json();
    check('health → 200 且带 now/service', health.status === 200 && hj.service === 'gateway-tv' && typeof hj.now === 'number', JSON.stringify(hj).slice(0, 120));

    for (const p of ['/admin/stats', '/admin/config', '/admin/log', '/v1/todos', '/v1/models', '/', '/tv/v1', '/tv/v1/snapshot/', '/tv/v1/todos']) {
      const r = await fetch(`${TV}${p}`, { headers: { ...tvHeaders(), authorization: `Bearer ${TOKEN}` } });
      check(`白名单外 ${p} → 404`, r.status === 404, `got ${r.status}`);
    }

    const post = await fetch(`${TV}/tv/v1/snapshot`, { method: 'POST', headers: { ...tvHeaders(), 'content-type': 'application/json' }, body: '{}' });
    check('POST 白名单路由 → 405（不是 404，白名单内方法不对）', post.status === 405, `got ${post.status}`);

    // Guessing tokens must be throttled, not free: 401s count per source IP. 90 wrong tries,
    // the limit is 3×30/min for failures.
    let unauth = 0;
    let throttled = 0;
    for (let i = 0; i < 95; i++) {
      const rr = await fetch(`${TV}/tv/v1/snapshot`, { headers: tvHeaders(`guess-${i}`) });
      if (rr.status === 401) unauth++;
      if (rr.status === 429) { throttled++; break; }
    }
    check('错误 token 会被限速（401 不是无限可猜）', throttled === 1 && unauth >= 1, `401s ${unauth}, 429s ${throttled}`);

    const rebinding = await rawGet(TV_PORT, '/tv/v1/snapshot', { headers: { ...tvHeaders(), host: 'attacker.example.com' } });
    check('外部 Host（DNS rebinding）→ 403', rebinding.status === 403, `got ${rebinding.status}`);

    const localHost = await rawGet(TV_PORT, '/tv/v1/snapshot', { headers: { ...tvHeaders(), host: 'mac.local:6293' } });
    check('.local Host 正常（403 只针对外部域名）', localHost.status === 200, `got ${localHost.status}`);

    const both = await fetch(`${TV}/tv/v1/snapshot`, { headers: { ...tvHeaders(TV_TOKEN_2), authorization: `Bearer ${TOKEN}` } });
    check('第二枚 TV token 独立可用', both.status === 200, `got ${both.status}`);
  }

  console.log('— 快照：字段裁剪 / 排序 / 服务端算好 runningMs —');
  {
    const mk = (body) => fetch(`http://127.0.0.1:${GW_PORT}/v1/todos`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify(body),
    }).then((r) => r.json()).then((j) => j.todo);
    const patch = (id, body) => fetch(`http://127.0.0.1:${GW_PORT}/v1/todos/${id}`, {
      method: 'PATCH', headers: authHeaders, body: JSON.stringify(body),
    }).then((r) => r.json()).then((j) => j.todo);

    // 7 条未完成（验证最多 6 条），1 条今天完成，1 条很久以前完成
    const normal = await mk({ title: '普通待办', project: 'kblas', note: 'x'.repeat(200) });
    const urgent = await mk({ title: '紧急待办', urgency: 'urgent' });
    const someday = await mk({ title: '不急的', urgency: 'someday' });
    const working = await mk({ title: '进行中的', urgency: 'normal' });
    // 进 in_progress：排序要看状态；runningMs 的数值算法由 test/tv-unit.mjs 覆盖，
    // 这里只验证「字段由服务端给出、且不是电视自己算的」这个形状。
    await patch(working.id, { status: 'in_progress' });
    const doneToday = await mk({ title: '今天完成的' });
    await patch(doneToday.id, { status: 'done' });
    const oldDone = await mk({ title: '很久前完成的' });
    // completed_at 由服务端盖，直接看它是否被计到「今日」：用 status 切换时间当完成时刻
    await patch(oldDone.id, { status: 'done' });
    await mk({ title: '第二条普通' });
    await mk({ title: '第三条普通' });
    await mk({ title: '第四条普通' });
    await mk({ title: '第五条普通' });
    await patch(normal.id, { status: 'pending' });

    const r = await fetch(`${TV}/tv/v1/snapshot`, { headers: tvHeaders() });
    const raw = await r.text();
    const snap = JSON.parse(raw);

    check('snapshot → 200', r.status === 200, String(r.status));
    check('快照带 ETag', /^"[^"]+"$/.test(r.headers.get('etag') || ''), r.headers.get('etag'));
    check('快照体积不超 6 KB（字节数；2 KB 是满工作量的下限，此夹具待办较少）', Buffer.byteLength(raw) <= 6144, `${Buffer.byteLength(raw)} bytes`);
    check('顶层字段齐全', snap.version === 1 && typeof snap.now === 'number' && snap.online === true && snap.health && snap.todos && snap.usage,
      Object.keys(snap).join(','));
    check('最多 6 条待办', snap.todos.items.length === 6, String(snap.todos.items.length));
    check('完成项不进列表', !snap.todos.items.some((t) => t.status === 'done'));
    check('进行中排第一', snap.todos.items[0].status === 'in_progress', JSON.stringify(snap.todos.items[0]));
    const pendingRest = snap.todos.items.slice(1);
    // 紧急度秩单调不减；截断到 6 条时「不急」可能排在窗口外，这里只验证已下发的顺序
    const rank = { urgent: 0, normal: 1, someday: 2 };
    const ranks = pendingRest.map((t) => rank[t.urgency]);
    check('同状态内 紧急 → 普通 → 不急（秩单调）', pendingRest[0].urgency === 'urgent' && ranks.every((r, i) => i === 0 || r >= ranks[i - 1]),
      pendingRest.map((t) => t.urgency).join(','));
    const somedayAll = await fetch(`http://127.0.0.1:${GW_PORT}/v1/todos?status=pending`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
    check('不急项存在于源数据（只是被 6 条上限截掉）', somedayAll.todos.some((t) => t.urgency === 'someday'));
    check('inProgress / pending 计数', snap.todos.inProgress === 1 && snap.todos.pending >= 5, JSON.stringify({ i: snap.todos.inProgress, p: snap.todos.pending }));
    check('doneToday 计今天完成的', snap.todos.doneToday === 2, String(snap.todos.doneToday));

    const row = snap.todos.items[0];
    check('行字段：id/title/status/urgency/runningMs/updatedAt', ['id', 'title', 'status', 'urgency', 'runningMs', 'updatedAt'].every((k) => k in row), Object.keys(row).join(','));
    check('runningMs 是数字（服务端算好，never null）', typeof row.runningMs === 'number' && Number.isFinite(row.runningMs), String(row.runningMs));

    const normalRow = snap.todos.items.find((t) => t.title === '普通待办');
    check('project 透传为 chip', normalRow.project === 'kblas', normalRow.project);
    check('note 截到 ~80 码位', normalRow.note.length <= 81, String(normalRow.note.length));

    check('不下发 spans', !raw.includes('"spans"'));
    check('不下发 perf / days / prices', !raw.includes('"perf"') && !raw.includes('"days"') && !raw.includes('"prices"'));
    check('不下发 completed_at / created_at', !raw.includes('"created_at"') && !raw.includes('"completed_at"'));

    check('usage 今日请求/tokens/费用', snap.usage && typeof snap.usage.requests === 'number'
      && typeof snap.usage.tokens === 'number' && typeof snap.usage.costUsd === 'number', JSON.stringify(snap.usage));
    check('usage 24 小时柱', Array.isArray(snap.usage.hours) && snap.usage.hours.length === 24, String(snap.usage.hours?.length));

    console.log('— 体积上限（真实工作量） —');
    {
      // Six full-length Chinese todos plus three models: the shape a real board sends.
      const mkBig = async (i) => (await (await fetch(`http://127.0.0.1:${GW_PORT}/v1/todos`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({
          title: `补齐 kblas 920F int8 回归与性能对比 ${i}`, project: `项目${i}`,
          note: '这是一段较长的备忘，用来把备注截断与体积上限一起压到真实规模。'.repeat(2),
          urgency: i % 3 === 0 ? 'urgent' : 'normal',
        }),
      })).json()).todo;
      const made = [];
      for (let i = 0; i < 8; i++) made.push(await mkBig(i));
      for (const t of made.slice(6)) await fetch(`http://127.0.0.1:${GW_PORT}/v1/todos/${t.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
      const big = await fetch(`${TV}/tv/v1/snapshot`, { headers: tvHeaders() });
      const txt = await big.text();
      check('6 条满长中文待办仍 ≤ 6 KB', Buffer.byteLength(txt) <= 6144, `${Buffer.byteLength(txt)} bytes`);
      check('满长待办仍给满 6 条', JSON.parse(txt).todos.items.length === 6, String(JSON.parse(txt).todos.items.length));
      for (const t of made.slice(0, 6)) await fetch(`http://127.0.0.1:${GW_PORT}/v1/todos/${t.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
    }

    console.log('— ETag / 304 —');
    const etag = r.headers.get('etag');
    const again = await fetch(`${TV}/tv/v1/snapshot`, { headers: { ...tvHeaders(), 'if-none-match': etag } });
    check('If-None-Match 命中 → 304 且无正文', again.status === 304 && (await again.text()) === '', `got ${again.status}`);
    const weak = await fetch(`${TV}/tv/v1/snapshot`, { headers: { ...tvHeaders(), 'if-none-match': `W/${etag}` } });
    check('弱校验 W/ 也算命中', weak.status === 304, `got ${weak.status}`);
    const list = await fetch(`${TV}/tv/v1/snapshot`, { headers: { ...tvHeaders(), 'if-none-match': `"nope", ${etag}` } });
    check('If-None-Match 列表命中', list.status === 304, `got ${list.status}`);

    // 数据一变 ETag 就变（连 now 也在快照里，所以这里比较「旧 ETag 不再 304」）
    await mk({ title: '刚加的' });
    const changed = await fetch(`${TV}/tv/v1/snapshot`, { headers: { ...tvHeaders(), 'if-none-match': etag } });
    check('待办变化后旧 ETag → 200 新 ETag', changed.status === 200 && changed.headers.get('etag') !== etag, `got ${changed.status}`);

    console.log('— gzip —');
    const gz = await rawGet(TV_PORT, '/tv/v1/snapshot', { headers: { ...tvHeaders(), 'accept-encoding': 'gzip' } });
    check('Accept-Encoding: gzip → Content-Encoding: gzip', gz.headers['content-encoding'] === 'gzip' && gz.status === 200, String(gz.headers['content-encoding']));

    console.log('— 限速（30/分钟/token） —');
    // 上面已经用了若干次；逐次请求直到 429，统计被接受的次数
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const rr = await fetch(`${TV}/tv/v1/snapshot`, { headers: tvHeaders(TV_TOKEN_2) });
      if (rr.status === 429) { limited++; break; }
      accepted++;
    }
    check('同一 token 超过 30 次/分钟 → 429', limited === 1, `accepted ${accepted}, limited ${limited}`);
    // Two different tokens must not share a bucket: the second one still works after the first
    // was throttled. (Same-name tokens are split by bucketKey; see tv-unit.)
    const otherToken = await fetch(`${TV}/tv/v1/snapshot`, { headers: tvHeaders() });
    check('限速按 token 独立：第二枚在另一枚被限后仍 200', otherToken.status === 200,
      `got ${otherToken.status}`);

    console.log('— 8484 主监听行为不变 —');
    const stats = await fetch(`http://127.0.0.1:${GW_PORT}/admin/stats`);
    check('主监听 /admin/stats 照常（仍只绑回环、无 TV token 无关）', stats.status === 200, `got ${stats.status}`);
    const v1NoAuth = await fetch(`http://127.0.0.1:${GW_PORT}/v1/todos`);
    check('主监听 /v1/todos 无 clientToken 仍 401（TV token 不通用）', v1NoAuth.status === 401, `got ${v1NoAuth.status}`);
    const v1WithTvToken = await fetch(`http://127.0.0.1:${GW_PORT}/v1/todos`, { headers: { 'x-aerial-token': TV_TOKEN } });
    check('TV token 不能访问主监听 /v1/todos', v1WithTvToken.status === 401, `got ${v1WithTvToken.status}`);
  }
} catch (e) {
  failures.push(`异常: ${e.message}`);
  console.error(e);
} finally {
  gateway.kill();
}

// ── 默认关闭：enabled=false / 无 tokens / 根本没配 gateway.tv，都不监听 ─────────
async function spawnWith(tv, port, label) {
  writeConfig(tv);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      CANNBOT_PROXY_PORT: String(GW_PORT + 10),
      CANNBOT_CONFIG_FILE: configFile,
      CANNBOT_LOG_FILE: path.join(tmp, `proxy-${port}.log`),
      CANNBOT_STATS_FILE: path.join(tmp, `stats-${port}.json`),
      CANNBOT_TODOS_FILE: path.join(tmp, `todos-${port}.json`),
      CANNBOT_REPORTS_FILE: path.join(tmp, `reports-${port}.json`),
      CANNBOT_CC_DIR: path.join(tmp, 'cc'), CANNBOT_ZCODE_DB: path.join(tmp, 'none.db'),
      CANNBOT_OPENCODE_DB: path.join(tmp, 'none.db'), CANNBOT_CURSOR_DIR: path.join(tmp, 'cursor'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(String(d)));
  child.stderr.on('data', (d) => lines.push(String(d)));
  await waitFor(`http://127.0.0.1:${GW_PORT + 10}/healthz`, 80);
  await sleep(300);
  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/tv/v1/health', timeout: 600, headers: { 'x-aerial-token': TV_TOKEN } }, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
    listening = true;
  } catch { listening = false; }
  child.kill();
  await sleep(250);
  return { listening, log: lines.join('') };
}

try {
  console.log('— 默认关闭 —');
  for (const [label, tv] of [
    ['没有 gateway.tv 节', undefined],
    ['enabled=false', { enabled: false, port: TV_PORT + 1, bind: '127.0.0.1', tokens: [{ name: 'x', token: TV_TOKEN }] }],
    ['enabled=true 但 tokens 为空', { enabled: true, port: TV_PORT + 2, bind: '127.0.0.1', tokens: [] }],
  ]) {
    const needsRestart = tv !== undefined;
    if (!needsRestart) {
      // 第一个用例单独起一次（没有 tv 节）
      const r = await spawnWith(undefined, TV_PORT + 1, label);
      check(`${label} → 电视端口不监听`, !r.listening);
      continue;
    }
    const r = await spawnWith(tv, tv.port, label);
    check(`${label} → 电视端口不监听`, !r.listening);
    if (label.includes('tokens 为空')) {
      check('tokens 为空时日志明确说明不启动', /没有配置 tokens/.test(r.log), r.log.slice(-300));
    }
  }

  console.log('— 来源 CIDR：不在允许网段 → 403 —');
  {
    // 本机只能从 127.0.0.1 连进来：把白名单收成 10.0.0.0/8，回环就成了「非私网来源」
    const port = TV_PORT + 5;
    writeConfig({ enabled: true, port, bind: '127.0.0.1', tokens: [{ name: 'x', token: TV_TOKEN }], allowedCidrs: ['10.0.0.0/8'] });
    const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        CANNBOT_PROXY_PORT: String(GW_PORT + 10),
        CANNBOT_CONFIG_FILE: configFile,
        CANNBOT_LOG_FILE: path.join(tmp, 'proxy-cidr.log'),
        CANNBOT_STATS_FILE: path.join(tmp, 'stats-cidr.json'),
        CANNBOT_TODOS_FILE: path.join(tmp, 'todos-cidr.json'),
        CANNBOT_REPORTS_FILE: path.join(tmp, 'reports-cidr.json'),
        CANNBOT_CC_DIR: path.join(tmp, 'cc'), CANNBOT_ZCODE_DB: path.join(tmp, 'none.db'),
        CANNBOT_OPENCODE_DB: path.join(tmp, 'none.db'), CANNBOT_CURSOR_DIR: path.join(tmp, 'cursor'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(`http://127.0.0.1:${GW_PORT + 10}/healthz`, 80);
    await sleep(300);
    const r = await fetch(`http://127.0.0.1:${port}/tv/v1/snapshot`, { headers: tvHeaders() });
    check('允许网段外（127.0.0.1 不在 10/8）→ 403', r.status === 403, `got ${r.status}`);
    child.kill();
    await sleep(200);
  }
} catch (e) {
  failures.push(`默认关闭用例异常: ${e.message}`);
  console.error(e);
}

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败${failures.length ? ` — ${failures.join(' ; ')}` : ''}`);
if (failures.length) console.log(out.join('').slice(-4000));
setTimeout(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  process.exit(failures.length ? 1 : 0);
}, 300);
