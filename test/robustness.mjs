// 稳健性回归：这几条都是「smoke 打不到、但线上会出事」的路径——
// 需要真实的多字节跨包、真实的上游断流、真实的恶意键，靠 mock 上游的固定响应测不出来。
//
//   ① StringDecoder：中文/emoji 被 TCP chunk 边界劈开时不能变 U+FFFD
//   ② pipeSafely：上游断流不能杀死整个进程
//   ③ stats 原型污染：model / provider 为 "__proto__" 时必须落进自己的桶
//   ④ isLocalHost：跨站 drive-by（sec-fetch-site: cross-site）必须被拒
//   ⑤ 并行 tool_use：同帧两个 tool_call 必须有各自的 content_block
//
// 运行: node test/robustness.mjs（纯进程内，不联网、不碰真实数据）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough, pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

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
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}
function group(t) { console.log(`\n— ${t} —`); }

// ── ① StringDecoder：多字节跨 chunk ─────────────────────────────────────────
group('StringDecoder（多字节 UTF-8 跨 chunk）');
check('一个中文字被劈成两半时，裸 toString 会坏、StringDecoder 不会', () => {
  const buf = Buffer.from('中文输出', 'utf8');
  const half = 1; // 「中」是 3 字节，切 1 字节必劈开
  const a = buf.subarray(0, half);
  const b = buf.subarray(half);

  const naive = a.toString('utf8') + b.toString('utf8');
  assert.ok(naive.includes('�'), `裸拼接应产生替换字符，实际: ${JSON.stringify(naive)}`);

  const dec = new StringDecoder('utf8');
  const safe = dec.write(a) + dec.write(b);
  assert.equal(safe, '中文输出');
  assert.ok(!safe.includes('�'));
});
check('逐字节喂入（最坏情况）也能完整还原', () => {
  const text = '混合 ASCII 与中文😀emoji';
  const buf = Buffer.from(text, 'utf8');
  const dec = new StringDecoder('utf8');
  let out = '';
  for (const byte of buf) out += dec.write(Buffer.from([byte]));
  out += dec.end();
  assert.equal(out, text);
});

// ── ② pipeSafely：上游断流不杀进程 ──────────────────────────────────────────
group('pipeSafely（上游断流）');
await checkAsync('上游 emit error 时进程存活、回调收到错误', async () => {
  const { pipeSafely } = await import('../lib/util.mjs');
  // 必须用「永不自然结束」的源：Readable.from(['a']) 会在 destroy 之前就读完，
  // pipeline 以成功收尾，就测不到断流路径了
  let push;
  const src = new Readable({ read() { push = (c) => this.push(c); } });
  const sink = new PassThrough();
  sink.resume();

  const done = new Promise((resolve) => {
    pipeSafely(src, sink, (err) => resolve(err));
    setImmediate(() => {
      push('chunk1');           // 先流起来
      setImmediate(() => src.destroy(new Error('upstream aborted')));
    });
  });
  const err = await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error('回调没被调用（进程可能已崩）')), 2000)),
  ]);
  assert.ok(err instanceof Error, `应收到 error，实际: ${err}`);
  assert.match(err.message, /upstream aborted/);
});
await checkAsync('上游正常结束时不报错', async () => {
  const { pipeSafely } = await import('../lib/util.mjs');
  const src = Readable.from(['a', 'b', 'c']);
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (d) => chunks.push(d));
  const err = await new Promise((resolve) => pipeSafely(src, sink, resolve));
  assert.equal(err, null);
  assert.equal(Buffer.concat(chunks).toString(), 'abc');
});
check('pipe 不转发错误、pipeline 会（对照组：说明这条修复不是多余的）', () => {
  // 不真的崩测试进程（uncaughtException 会污染后续用例），改为核对事实：
  //   ① 裸 stream 默认没有 error 监听者——未监听的 error 冒到进程级，进程退出
  //   ② pipeline 会给链上每个流挂 error 监听，这就是它不崩的原因
  const bare = new PassThrough();
  assert.equal(bare.listenerCount('error'), 0, '裸 stream 默认没有 error 监听者');

  const src = new Readable({ read() {} });
  const sink = new PassThrough();
  pipeline(src, sink, () => {});
  assert.ok(src.listenerCount('error') > 0, 'pipeline 会给链上每个流挂 error 监听');
  src.destroy();
});

// ── ②b 超长响应尾部 usage 提取（>4MB 走 tail 窗口）────────────────────────────
group('extractUsageBalanced（尾部窗口取 usage）');
{
  const { extractUsageBalanced } = await import('../lib/util.mjs');
  check('嵌套 usage（prompt_tokens_details）不被截断', () => {
    const tail = '"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3}}';
    // 旧实现的正则完全匹配不上（嵌套对象它抓不到）——这正是修复点
    assert.equal(tail.match(/"usage"\s*:\s*(\{[^{}]*\})/)?.[1], undefined, '旧正则应失败（对照）');
    assert.deepEqual(extractUsageBalanced(tail), {
      prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 },
    });
  });
  check('字符串值里的花括号不干扰配平', () => {
    assert.deepEqual(extractUsageBalanced('"usage":{"note":"a}b{c","tin":1}'), { note: 'a}b{c', tin: 1 });
  });
  check('窗口截断在半截对象时返回 null（不返回半个 usage）', () => {
    assert.equal(extractUsageBalanced('"usage":{"a":{"b":1'), null);
  });
  check('没有 usage 时返回 null', () => {
    assert.equal(extractUsageBalanced('{"foo":1}'), null);
  });
  check('多个 usage 时取最后一个（末尾窗口里最近的那个才完整）', () => {
    const tail = '"usage":{"tin":1},"x":0,"usage":{"tin":9}';
    assert.deepEqual(extractUsageBalanced(tail), { tin: 9 });
  });
}

// ── ③ stats 原型污染 ────────────────────────────────────────────────────────
group('stats 原型污染（"__proto__" 作为 model/provider）');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'robust-stats-'));
  process.env.CANNBOT_STATS_FILE = path.join(tmp, 'stats.json');
  process.env.CANNBOT_LOG_FILE = path.join(tmp, 'inproc.log');
  const stats = await import('../lib/stats.mjs');

  check('recordStats 不污染 Object.prototype', () => {
    stats.recordStats({ provider: '__proto__', model: '__proto__', status: 200, ms: 5, tin: 1, tout: 1 });
    stats.recordStats({ provider: 'constructor', model: 'hasOwnProperty', status: 200, ms: 5, tin: 2, tout: 2 });
    assert.deepEqual(Object.keys({}), [], '空对象不应长出键');
    assert.equal(({}).req, undefined, 'Object.prototype.req 不应被写');
    assert.equal(({}).tin, undefined, 'Object.prototype.tin 不应被写');
  });
  check('"__proto__" 作为键仍能正常记账（不是被静默丢掉）', () => {
    // 模型桶在快照顶层 models[]（today 只有合计数字，没有 models）
    const models = stats.statsSnapshot().models ?? [];
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes('__proto__:__proto__'), `应含 __proto__ 桶，实际: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('constructor:hasOwnProperty'), `应含 constructor 桶，实际: ${JSON.stringify(ids)}`);
    const hit = models.find((m) => m.id === '__proto__:__proto__');
    assert.equal(hit.req, 1, '计数应落进自己的桶');
    assert.equal(hit.tin, 1);
  });
  check('落盘内容保留 "__proto__" 键（JSON 里是普通键，无损）', () => {
    stats.flushStats();
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'stats.json'), 'utf8'));
    assert.ok(Object.keys(raw.days).length > 0, '应有落盘数据');
    const day = Object.values(raw.days)[0];
    const provKeys = Object.keys(day.providers ?? {});
    assert.ok(provKeys.includes('__proto__'), `落盘应保留该 provider 键，实际: ${JSON.stringify(provKeys)}`);
  });
  check('读盘路径重建无原型字典（hardenDays 存在且被 loader 调用）', () => {
    // 读盘时 JSON.parse 产出的 provider/models 字典带原型，__proto__ 会成为原型陷阱；
    // 源码层核对 loader 确实过了一遍重建，而不是直接采用 parse 结果。
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib/stats.mjs'), 'utf8');
    assert.match(src, /function hardenDays/, 'hardenDays 应存在');
    assert.match(src, /d\.days = hardenDays\(d\.days\)/, 'loader 必须调用 hardenDays');
    assert.match(src, /Object\.create\(null\)/, '无原型字典用 Object.create(null) 建');
  });
}

// ── ④ isLocalHost：跨站 drive-by ────────────────────────────────────────────
group('isLocalHost（跨站 drive-by 防护）');
{
  // isLocalHost 在 server.mjs 内部，不导出；按其契约在此复刻并比对源码实现
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.mjs'), 'utf8');
  const m = src.match(/function isLocalHost\(req\) \{[\s\S]*?\n\}/);
  check('server.mjs 里的 isLocalHost 确实带了 sec-fetch-site 校验', () => {
    assert.ok(m, '应能找到 isLocalHost 定义');
    assert.match(m[0], /sec-fetch-site/, '缺少 sec-fetch-site 校验 → 任意网页可 drive-by POST /admin/stop');
    assert.match(m[0], /same-origin/);
    assert.match(m[0], /cross-site|!== 'same-origin'/);
  });
  check('不再放行空 Host', () => {
    assert.ok(m, '应能找到 isLocalHost 定义');
    assert.ok(!/\|\| host === ''/.test(m[0]), "空 Host 不应放行（HTTP/1.1 必带 Host，空值是异常）");
  });
  check('行为核对：跨站请求被拒、同源放行', () => {
    const isLocalHost = new Function('return ' + m[0].replace('function isLocalHost', 'function isLocalHost'))();
    const mk = (headers) => ({ headers });
    assert.equal(isLocalHost(mk({ host: '127.0.0.1:8484', 'sec-fetch-site': 'cross-site' })), false, '跨站应拒绝');
    assert.equal(isLocalHost(mk({ host: '127.0.0.1:8484', 'sec-fetch-site': 'same-origin' })), true, '同源应放行');
    assert.equal(isLocalHost(mk({ host: '127.0.0.1:8484', 'sec-fetch-site': 'none' })), true, '地址栏直访应放行');
    assert.equal(isLocalHost(mk({ host: '127.0.0.1:8484' })), true, '非浏览器（无该头）应放行');
    assert.equal(isLocalHost(mk({ host: 'evil.example.com' })), false, '外部 Host 应拒绝');
    assert.equal(isLocalHost(mk({})), false, '空 Host 应拒绝');
  });
}

// ── ⑤ 并行 tool_use ─────────────────────────────────────────────────────────
group('并行 tool_use（同帧两个 tool_call）');
await checkAsync('两个并行 tool_call 各有独立的 content_block', async () => {
  const { pipeAnthropicStream } = await import('../lib/translate/anth2openai.mjs');

  // 构造一个 OpenAI 形态流：同一帧里两个 tool_call，随后各自补 delta
  const frames = [
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"p":' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '{"q":' } },
    ] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: '"a.txt"}' } },
      { index: 1, function: { arguments: '"b.txt"}' } },
    ] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  const upBody = Readable.from([Buffer.from(sse)]);

  const res = new PassThrough();
  res.writeHead = () => {};
  const out = [];
  res.on('data', (d) => out.push(d));
  const finished = new Promise((r) => res.on('end', r));
  await pipeAnthropicStream(res, upBody, { providerId: 'mock', model: 'm' });
  await finished;

  const events = Buffer.concat(out).toString()
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));

  const starts = events.filter((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
  assert.equal(starts.length, 2, `应有两个 tool_use 块，实际 ${starts.length}: ${JSON.stringify(starts)}`);
  assert.deepEqual(starts.map((s) => s.content_block.name).sort(), ['read_file', 'write_file']);
  assert.deepEqual(starts.map((s) => s.content_block.id).sort(), ['call_a', 'call_b']);
  assert.notEqual(starts[0].index, starts[1].index, '两个块必须是不同 index');

  // 参数不能串块：各自拼出合法 JSON
  const frags = new Map();
  for (const e of events) {
    if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
      frags.set(e.index, (frags.get(e.index) ?? '') + e.delta.partial_json);
    }
  }
  const parsed = [...frags.values()].map((s) => JSON.parse(s));
  assert.deepEqual(parsed, [{ p: 'a.txt' }, { q: 'b.txt' }], `参数串块了: ${JSON.stringify([...frags])}`);
});

console.log(`\n结果: ${passed} 通过${failures.length ? `, ${failures.length} 失败 — ${failures.join(' / ')}` : ', 0 失败'}`);
process.exit(failures.length ? 1 : 0);
