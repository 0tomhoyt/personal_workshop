// 端到端冒烟测试：起一个 mock 上游 + 一个网关实例（临时目录配置），覆盖
//   ① openai 客户端 → openai 上游（透传，流式/非流式）
//   ② anthropic 客户端 → openai 上游（翻译，含 tool 往返）
//   ③ anthropic 客户端 → anthropic 上游（直通，流式/非流式）
//   ④ openai 客户端 → anthropic 上游（反向翻译，流式/非流式，含 tool）
//   以及网关 token 鉴权、模型名路由（裸名/显式前缀/重名消歧/默认上游兜底）、统计维度。
// 运行: node test/smoke.mjs
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MOCK_PORT = 6291;
const GW_PORT = 6290;
const GW = `http://127.0.0.1:${GW_PORT}`;
const TOKEN = 'sk-test-token';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-smoke-'));
// 防泄漏：进程内会动态 import lib/pricing.mjs，其 config/log 模块的默认落点在源目录
// （resolvePrice → tryGetConfig 的内置回退警告会在源目录写 proxy.log）——先指到临时目录
process.env.CANNBOT_LOG_FILE = path.join(tmp, 'inproc.log');
fs.writeFileSync(path.join(tmp, 'providers.json'), JSON.stringify({
  gateway: { clientToken: TOKEN },
  providers: [
    { id: 'mock-oai', name: 'MockOAI', baseUrl: `http://127.0.0.1:${MOCK_PORT}/oai`, protocol: 'openai', auth: { type: 'static-token', token: 'mock-token-oai' }, models: { source: 'api' } },
    { id: 'mock-anth', name: 'MockAnth', baseUrl: `http://127.0.0.1:${MOCK_PORT}/anth`, protocol: 'anthropic', auth: { type: 'static-token', token: 'mock-token-anthropic' }, models: { source: 'api' } },
    // 方言 provider：baseUrl 含 'zhipu' / 'kimi' 关键词（searchDialect 按此推断），mock 端点内嵌搜索分支
    { id: 'mock-zhipu', name: 'MockZhipu', baseUrl: `http://127.0.0.1:${MOCK_PORT}/zhipu`, protocol: 'openai', auth: { type: 'static-token', token: 'mock-token-zhipu' }, models: { source: 'api' } },
    { id: 'mock-kimi', name: 'MockKimi', baseUrl: `http://127.0.0.1:${MOCK_PORT}/kimi`, protocol: 'openai', auth: { type: 'static-token', token: 'mock-token-kimi' }, models: { source: 'api' } },
    // z.ai 域名变体：GLM Coding Plan 的 api.z.ai 若配成 openai 协议端点，同样应命中智谱方言
    { id: 'mock-zai', name: 'MockZAI', baseUrl: `http://127.0.0.1:${MOCK_PORT}/z.ai`, protocol: 'openai', auth: { type: 'static-token', token: 'mock-token-zhipu' }, models: { source: 'api' } },
    // 双入口：默认 openai；endpoints 按入站协议直通到对应 mock 路径（同一 token）
    { id: 'mock-dual', name: 'MockDual', baseUrl: `http://127.0.0.1:${MOCK_PORT}/oai`, protocol: 'openai',
      endpoints: { openai: `http://127.0.0.1:${MOCK_PORT}/oai`, anthropic: `http://127.0.0.1:${MOCK_PORT}/anth` },
      auth: { type: 'static-token', token: 'mock-token-dual' },
      models: { source: 'static', list: [{ id: 'dual-model' }] } },
  ],
  routing: { defaultProvider: 'mock-oai' },
  // 工作台：报告生成用的模型（Task 8 消费；此处锁定配置透传）
  workbench: { reportProvider: 'mock-oai', reportModel: 'mock-pro' },
  pricing: { // 费用统计：mock-pro 走裸名覆盖，claude-mock 走 pid/模型名 精确覆盖
    'mock-pro': { input: 1, output: 2 },
    'mock-anth/claude-mock': { input: 0.5, output: 1 },
  },
  // 显示器：只用编号（VCP 值 + UUID），name 留空——网关不预设任何语义标签
  monitors: {
    inputs: [15, 21],
    list: [
      'A016429F-BCEC-4FAF-BD7D-23128391F7F1',
      'F2F948D6-2F40-4DEC-8EF8-2E158BFF4328',
    ],
  },
}, null, 2));

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const parseEcho = (text) => JSON.parse(String(text).replace(/^ECHO:/, ''));

async function post(urlPath, body, headers = authHeaders) {
  const r = await fetch(GW + urlPath, { method: 'POST', headers, body: JSON.stringify(body) });
  return r;
}

async function collectStream(r) {
  const text = await r.text();
  const events = [];
  const datas = [];
  for (const line of text.split('\n')) {
    const line_ = line.trim();
    if (line_.startsWith('event:')) events.push(line_.slice(6).trim());
    else if (line_.startsWith('data:')) datas.push(line_.slice(5).trim());
  }
  return { text, events, datas };
}

function spawnNode(args, env, name) {
  // 补 PATH/HOME：子进程里再 execFile 的脚本（如 mock-m1ddc 的 `#!/usr/bin/env node`）
  // 需要能找到 node；也贴近 launchd 运行 m1ddc 的真实环境
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...env };
  const child = spawn(process.execPath, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => out.push(d));
  child.dump = () => console.log(`---- ${name} 输出 ----\n${out.join('').slice(-4000)}`);
  return child;
}

const mock = spawnNode([path.join(ROOT, 'test/mock-upstream.mjs'), String(MOCK_PORT)], {}, 'mock-upstream');
// 显示器切换走 mock m1ddc（env 锁死，测试进程树绝不可能碰真实 I2C）
fs.writeFileSync(path.join(tmp, 'mon-state.json'), '{}');
const gateway = spawnNode([path.join(ROOT, 'server.mjs')], {
  CANNBOT_PROXY_PORT: String(GW_PORT),
  CANNBOT_CONFIG_FILE: path.join(tmp, 'providers.json'),
  CANNBOT_LOG_FILE: path.join(tmp, 'proxy.log'),
  CANNBOT_STATS_FILE: path.join(tmp, 'stats.json'),
  CANNBOT_TODOS_FILE: path.join(tmp, 'todos.json'),
  CANNBOT_REPORTS_FILE: path.join(tmp, 'reports.json'),
  // 报告源隔离：gateway 进程的 collect 绝不碰真实 ~/.zcode / ~/.claude / ~/.cursor 数据
  CANNBOT_CC_DIR: path.join(tmp, 'cc-projects'),
  CANNBOT_ZCODE_DB: path.join(tmp, 'no-such.db'),
  CANNBOT_OPENCODE_DB: path.join(tmp, 'no-such.db'),
  CANNBOT_CURSOR_DIR: path.join(tmp, 'cursor-projects'),
  CANNBOT_M1DDC: path.join(ROOT, 'test/mock-m1ddc.mjs'),
  MOCK_M1DDC_STATE: path.join(tmp, 'mon-state.json'),
  MOCK_M1DDC_LOG: path.join(tmp, 'mon-log.txt'),
  CANNBOT_REPORT_RETRY_DELAY_MS: '0', // 总结重试演练不等真实 1.5s
}, 'gateway');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 等两个服务就绪
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const h = await (await fetch(`${GW}/healthz`)).json(); if (h.service) { up = true; break; } } catch {}
    await sleep(100);
  }
  if (!up) { console.error('网关未就绪'); gateway.dump(); mock.dump(); process.exit(1); }

  console.log('— healthz / 鉴权 / 模型目录 —');
  {
    const h = await (await fetch(`${GW}/healthz`)).json();
    check('healthz ok', h.ok === true, JSON.stringify(h.providers?.map((p) => p.auth)));
    check('healthz 六个 provider', h.providers?.length === 6);
    check('healthz 标记客户端鉴权已启用', h.authRequired === true);
  }
  {
    const r = await fetch(`${GW}/v1/models`);
    check('无 token 访问 /v1/models → 401', r.status === 401, `got ${r.status}`);
    const d = await (await fetch(`${GW}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    const ids = d.data.map((m) => m.id);
    check('聚合模型目录含 mock-pro/claude-mock', ids.includes('mock-pro') && ids.includes('claude-mock'), ids.join(','));
    check('重名模型消歧为 pid/model', ids.includes('mock-oai/shared-model') && ids.includes('mock-anth/shared-model') && !ids.includes('shared-model'), ids.join(','));
    check('owned_by 为 provider id', d.data.find((m) => m.id === 'claude-mock')?.owned_by === 'mock-anth');
  }
  {
    const r = await post('/v1/chat/completions', { model: 'mock-pro', messages: [{ role: 'user', content: 'hi' }] }, { 'content-type': 'application/json', authorization: 'Bearer wrong-token' });
    check('错误 token → 401', r.status === 401);
  }
  {
    const c = await (await fetch(`${GW}/admin/config`)).json();
    check('/admin/config 返回网关 token', c.clientToken === TOKEN && c.providers?.length === 6);
    const html = await (await fetch(`${GW}/`)).text();
    check('管理台页面可访问', html.includes('统一订阅网关'));
  }

  console.log('— ① openai 客户端 → openai 上游（透传） —');
  {
    const j = await (await post('/v1/chat/completions', { model: 'mock-pro', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] })).json();
    const echo = parseEcho(j.choices[0].message.content);
    check('透传到达上游且凭证正确', echo.sawAuth === true && echo.model === 'mock-pro');
    check('usage 透传', j.usage?.prompt_tokens === 9);
  }
  {
    const r = await post('/v1/chat/completions', { model: 'mock-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const { datas } = await collectStream(r);
    const echoChunk = datas.map((d) => { try { return JSON.parse(d); } catch { return null; } }).find((x) => x?.choices?.[0]?.delta?.content?.startsWith('ECHO:'));
    check('流式透传收到 ECHO', Boolean(echoChunk));
    check('网关注入 include_usage（mock 因此回 usage chunk）', datas.some((d) => { try { const x = JSON.parse(d); return x.usage?.completion_tokens === 12; } catch { return false; } }));
    check('流式以 [DONE] 结束', datas[datas.length - 1] === '[DONE]');
  }

  console.log('— ② anthropic 客户端 → openai 上游（翻译） —');
  {
    const j = await (await post('/v1/messages', {
      model: 'mock-pro', max_tokens: 100, system: 'You are terse',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })).json();
    check('响应为 anthropic message', j.type === 'message' && j.role === 'assistant');
    const echo = parseEcho(j.content[0].text);
    check('system 翻译为 system 消息', echo.messages?.[0]?.role === 'system' && echo.messages[0].content === 'You are terse', JSON.stringify(echo.messages));
    check('max_tokens 透传', echo.max_tokens === 100);
    // openai 上游 prompt_tokens=9 已含缓存 5：Anthropic 语义 input 不含缓存 → 9−5=4
    check('usage 翻译回 anthropic 形态（含缓存换算）', j.usage?.input_tokens === 4 && j.usage?.output_tokens === 12 && j.usage?.cache_read_input_tokens === 5 && j.usage?.cache_creation_input_tokens === 0, JSON.stringify(j.usage));
  }
  {
    const j = await (await post('/v1/messages', {
      model: 'mock-pro', max_tokens: 100,
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '杭州' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴' }] },
      ],
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'auto' },
    })).json();
    const echo = parseEcho(j.content[0].text);
    const asst = echo.messages?.find((m) => m.role === 'assistant');
    const toolMsg = echo.messages?.find((m) => m.role === 'tool');
    check('tool_use 翻译为 tool_calls', asst?.tool_calls?.[0]?.function?.name === 'get_weather' && JSON.parse(asst.tool_calls[0].function.arguments).city === '杭州', JSON.stringify(asst));
    check('tool_result 翻译为 role:tool', toolMsg?.tool_call_id === 'toolu_1' && toolMsg?.content === '晴', JSON.stringify(toolMsg));
    check('tools 翻译为 function 形态', echo.tools?.[0]?.function?.name === 'get_weather' && echo.tools[0].function.parameters?.properties?.city, JSON.stringify(echo.tools));
  }

  console.log('— ② 智谱搜索翻译（mock-zhipu / glm-mock） —');
  {
    // 非流式：带 name 与只有 type 两种 wire 形态都映射；响应顶层 web_search 数组 → 块对
    const j = await (await post('/v1/messages', {
      model: 'glm-mock', max_tokens: 64,
      messages: [{ role: 'user', content: '杭州天气' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }, { type: 'web_search_20250305' }],
    })).json();
    const echo = parseEcho(j.content?.[0]?.text ?? '');
    check('智谱: web_search server tool 映射（enable/search_engine）', echo?.tools?.[0]?.type === 'web_search' && echo.tools[0].web_search?.enable === true && echo.tools[0].web_search?.search_engine === 'search_pro', JSON.stringify(echo?.tools));
    check('智谱: 无 name 形态同样映射不丢', echo?.tools?.length === 2 && echo.tools[1]?.type === 'web_search', JSON.stringify(echo?.tools?.length));
    const su = j.content?.find((b) => b?.type === 'server_tool_use');
    const wr = j.content?.find((b) => b?.type === 'web_search_tool_result');
    check('智谱: 搜索结果翻译为 server_tool_use/web_search_tool_result 块对', Boolean(su) && Boolean(wr) && wr.tool_use_id === su.id, JSON.stringify(j.content?.map((b) => b.type)));
    check('智谱: 搜索结果字段逐字保留', wr?.content?.[0]?.content === '摘要内容' && wr.content[0].url === 'https://example.com/a' && wr.content[0].title === '结果标题', JSON.stringify(wr?.content?.[0]));
  }
  {
    // 流式：delta.content 数组（传闻形态），text 与 web_search 块混排
    const r = await post('/v1/messages', { model: 'glm-mock', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '杭州天气' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
    const { datas } = await collectStream(r);
    const evs = datas.filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    const text = evs.filter((e) => e.type === 'content_block_delta').map((e) => e.delta?.text ?? '').join('');
    const wrStart = evs.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'web_search_tool_result');
    const lastDelta = [...evs].reverse().find((e) => e.type === 'message_delta');
    check('智谱流式: 数组 content 文本逐字（请求侧 ECHO 映射）', (() => { try { return parseEcho(text)?.tools?.[0]?.type === 'web_search'; } catch { return false; } })(), text.slice(0, 80));
    check('智谱流式: 搜索结果块内容逐字', wrStart?.content_block?.content?.[0]?.content === '流式摘要', JSON.stringify(wrStart?.content_block?.content?.[0]));
    check('智谱流式: message_delta usage 缓存换算', lastDelta?.usage?.cache_read_input_tokens === 5 && lastDelta?.usage?.input_tokens === 4, JSON.stringify(lastDelta?.usage));
  }
  {
    // 未知 server tool 混排：computer 丢、web_search 留
    const j = await (await post('/v1/messages', {
      model: 'glm-mock', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'computer_20250124', name: 'computer' }, { type: 'web_search_20250305', name: 'web_search' }],
    })).json();
    const echo = parseEcho(j.content?.[0]?.text ?? '');
    check('智谱: 未知 server tool 丢弃、web_search 保留', echo?.tools?.length === 1 && echo.tools[0]?.type === 'web_search' && !JSON.stringify(echo.tools).includes('computer'), JSON.stringify(echo?.tools));
  }
  {
    // z.ai 域名（GLM Coding Plan 的域名，配成 openai 协议端点时）：同样命中智谱方言
    const j = await (await post('/v1/messages', {
      model: 'glm-zai', max_tokens: 64,
      messages: [{ role: 'user', content: '杭州天气' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    })).json();
    const echo = parseEcho(j.content?.find((b) => b?.type === 'text')?.text ?? '');
    check('z.ai 域名: web_search server tool 映射为智谱形态', echo?.tools?.[0]?.type === 'web_search' && echo.tools[0]?.web_search?.enable === true, JSON.stringify(echo?.tools));
    check('z.ai 域名: 搜索结果翻译回 server_tool_use / web_search_tool_result 块', j.content?.some((b) => b?.type === 'server_tool_use') && j.content?.some((b) => b?.type === 'web_search_tool_result'), JSON.stringify(j.content?.map((b) => b?.type)));
  }
  {
    // null 方言（mock-oai，baseUrl 无方言关键词）：搜索工具无法映射 → 丢弃，请求继续
    const j = await (await post('/v1/messages', {
      model: 'mock-pro', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    })).json();
    const echo = parseEcho(j.content?.[0]?.text ?? '');
    check('null 方言: 搜索工具丢弃、请求正常翻译', j.type === 'message' && !(echo?.tools?.length > 0), JSON.stringify(echo?.tools));
  }
  {
    // ② 流式非搜索 usage 透传锁定（mock-pro）
    const r = await post('/v1/messages', { model: 'mock-pro', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const { datas } = await collectStream(r);
    const evs = datas.filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    const lastDelta = [...evs].reverse().find((e) => e.type === 'message_delta');
    check('② 流式非搜索: usage 缓存换算透传', lastDelta?.usage?.cache_read_input_tokens === 5 && lastDelta?.usage?.input_tokens === 4, JSON.stringify(lastDelta?.usage));
  }
  {
    // ② 流式未知块容错：上游发未知 delta 键与未知 content 数组块，流不中断、正文保留、usage 不受影响
    const r = await post('/v1/messages', { model: 'mock-pro', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'UNKNOWN-BLOCK-TEST' }] });
    const { events, datas } = await collectStream(r);
    const evs = datas.filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    const deltas = evs.filter((e) => e.type === 'content_block_delta').map((e) => e.delta?.text ?? '').join('');
    const lastDelta = [...evs].reverse().find((e) => e.type === 'message_delta');
    check('② 流式未知块: 流完整走到 message_stop', events.includes('message_stop'));
    check('② 流式未知块: 正文与未知块后文本逐字保留', deltas.includes('UNKNOWN-BLOCK-TEST') && deltas.includes('未知块后的正文'), deltas.slice(0, 80));
    check('② 流式未知块: usage 换算不受未知块影响', lastDelta?.usage?.input_tokens === 4 && lastDelta?.usage?.cache_read_input_tokens === 5, JSON.stringify(lastDelta?.usage));
  }

  console.log('— ③ anthropic 客户端 → anthropic 上游（直通） —');
  {
    const j = await (await post('/v1/messages', {
      model: 'claude-mock', max_tokens: 77,
      system: [{ type: 'text', text: 'S1' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })).json();
    const echo = parseEcho(j.content[0].text);
    check('直通保留 system 数组结构', Array.isArray(echo.system) && echo.system[0].text === 'S1', JSON.stringify(echo.system));
    check('直通保留 content 块结构', echo.messages?.[0]?.content?.[0]?.type === 'text' && echo.messages[0].content[0].text === 'hi', JSON.stringify(echo.messages));
    check('直通保留 max_tokens', echo.max_tokens === 77);
    check('直通保留 anthropic usage 字段', j.usage?.input_tokens === 11 && j.usage?.output_tokens === 7 && j.stop_reason === 'end_turn');
  }
  {
    const r = await post('/v1/messages', { model: 'claude-mock', max_tokens: 77, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const { text } = await collectStream(r);
    check('直通 SSE 保留原始事件序列', text.includes('event: message_start') && text.includes('event: content_block_delta') && text.includes('event: message_stop'));
    check('直通 SSE 文本原样', text.includes('你好') && text.includes('世界'));
    check('直通凭证注入（mock 校验通过 → 无 401）', !text.includes('authentication_error'));
  }
  {
    // ③ 直通 · 智谱方言流式 usage：message_start 占位 0、完整 usage 在 message_delta → tin/cache 必须落桶
    const s1 = await (await fetch(`${GW}/admin/stats`)).json();
    const b1 = s1.models.find((m) => m.id === 'mock-anth:claude-mock');
    const r = await post('/v1/messages', { model: 'claude-mock', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'STREAM-USAGE-IN-DELTA' }] });
    await r.text();
    const s2 = await (await fetch(`${GW}/admin/stats`)).json();
    const b2 = s2.models.find((m) => m.id === 'mock-anth:claude-mock');
    check('③ 智谱方言流式: message_delta 的 input_tokens 落桶', (b2?.tin ?? 0) >= (b1?.tin ?? 0) + 11, `tin ${b1?.tin ?? '?'} → ${b2?.tin ?? '?'}`);
  }

  console.log('— ③b 双入口 endpoints：按入站协议直通 —');
  {
    // Anthropic 入站 → endpoints.anthropic → /anth 直通（ECHO 带 system 键）
    const j = await (await post('/v1/messages', {
      model: 'mock-dual/dual-model', max_tokens: 64,
      system: 'dual-sys',
      messages: [{ role: 'user', content: 'hi-dual-anth' }],
    })).json();
    check('双入口 anth 入站: 响应为 anthropic message', j.type === 'message' && j.role === 'assistant');
    const echo = parseEcho(j.content?.[0]?.text ?? j.content);
    check('双入口 anth 入站: 直通到 anthropic 上游（ECHO 含 system）', echo.system === 'dual-sys' && echo.max_tokens === 64, JSON.stringify(echo).slice(0, 160));
    check('双入口 anth 入站: 无翻译噪声（保留 system 字符串）', typeof echo.system === 'string');
  }
  {
    // OpenAI 入站 → endpoints.openai → /oai 直通（ECHO 无 system 键）
    const j = await (await post('/v1/chat/completions', {
      model: 'mock-dual/dual-model',
      messages: [{ role: 'system', content: 'dual-oai-sys' }, { role: 'user', content: 'hi-dual-oai' }],
    })).json();
    check('双入口 oai 入站: 响应为 chat.completion', j.object === 'chat.completion');
    const echo = parseEcho(j.choices?.[0]?.message?.content);
    check('双入口 oai 入站: 直通到 openai 上游（ECHO 无 system 顶层键）', !('system' in echo) && echo.messages?.some((m) => m.role === 'system' && m.content === 'dual-oai-sys'), JSON.stringify(echo).slice(0, 160));
  }
  {
    // 仅配 anthropic 入口、默认 protocol=openai：OpenAI 入站仍走 baseUrl（翻译到 anth 不应发生——base 仍是 oai）
    // 反向：仅有 endpoints.openai、默认 anthropic 的情况由 mock-anth 覆盖既有翻译路径，此处不重复。
  }

  console.log('— ④ openai 客户端 → anthropic 上游（反向翻译） —');
  {
    const j = await (await post('/v1/chat/completions', {
      model: 'claude-mock', max_tokens: 123,
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      tool_choice: 'auto',
    })).json();
    check('响应为 chat.completion', j.object === 'chat.completion' && j.model === 'claude-mock');
    const echo = parseEcho(j.choices[0].message.content);
    check('system 消息翻译为 system 参数', echo.system === 'SYS', JSON.stringify(echo.system));
    check('max_tokens 缺省补齐/透传', echo.max_tokens === 123);
    check('tools 翻译为 input_schema', echo.tools?.[0]?.name === 'get_weather' && echo.tools[0].input_schema?.properties?.city, JSON.stringify(echo.tools));
    check('tool_choice auto 翻译', echo.tool_choice?.type === 'auto', JSON.stringify(echo.tool_choice));
    check('上游 tool_use 翻译回 tool_calls', j.choices[0].message.tool_calls?.[0]?.function?.name === 'get_weather', JSON.stringify(j.choices[0].message.tool_calls));
    check('finish_reason 翻译为 tool_calls', j.choices[0].finish_reason === 'tool_calls');
    // anthropic 上游 input=11 不含缓存（读 6 + 写 2 分列）：openai 语义 prompt_tokens 为总输入 → 11+6+2=19
    check('usage 翻译为 openai 形态（含缓存还原）', j.usage?.prompt_tokens === 19 && j.usage?.completion_tokens === 7 && j.usage?.prompt_tokens_details?.cached_tokens === 6, JSON.stringify(j.usage));
  }
  {
    const r = await post('/v1/chat/completions', { model: 'claude-mock', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const { datas } = await collectStream(r);
    const chunks = datas.filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    check('反向流式收到原文', text === '你好世界', text);
    check('反向流式 finish_reason=stop', chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'));
    check('反向流式末尾 usage chunk', chunks.some((c) => c.usage?.completion_tokens === 7 && c.choices?.length === 0));
    check('反向流式以 [DONE] 结束', datas[datas.length - 1] === '[DONE]');
  }
  {
    // ④ 反向流式未知块容错：上游 anthropic 流发未知 content_block 事件，跳过、不中断
    const r = await post('/v1/chat/completions', { model: 'claude-mock', stream: true, messages: [{ role: 'user', content: 'UNKNOWN-BLOCK-TEST' }] });
    const { datas } = await collectStream(r);
    const chunks = datas.filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    check('④ 反向流式未知块: 正文逐字保留', text === '你好世界', text);
    check('④ 反向流式未知块: 以 [DONE] 结束（流未中断）', datas[datas.length - 1] === '[DONE]');
    check('④ 反向流式未知块: usage chunk 不受影响', chunks.some((c) => c.usage?.completion_tokens === 7 && c.choices?.length === 0));
  }
  {
    // ④ 反向流式 · 智谱方言 usage：input 只在 message_delta → 末尾 usage chunk 仍含完整总输入（11+6+2）
    const r = await post('/v1/chat/completions', { model: 'claude-mock', stream: true, messages: [{ role: 'user', content: 'STREAM-USAGE-IN-DELTA' }] });
    const { datas } = await collectStream(r);
    const chunks = datas.filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    const lastUsage = [...chunks].reverse().find((c) => c.usage && c.choices?.length === 0);
    check('④ 智谱方言流式: 末尾 usage chunk 总输入完整（prompt_tokens=19、cached=6）', lastUsage?.usage?.prompt_tokens === 19 && lastUsage?.usage?.prompt_tokens_details?.cached_tokens === 6, JSON.stringify(lastUsage?.usage));
  }

  console.log('— ④ 搜索工具反向翻译（claude-mock，智谱→anthropic server tool） —');
  {
    const j = await (await post('/v1/chat/completions', {
      model: 'claude-mock', max_tokens: 123,
      messages: [{ role: 'user', content: '杭州天气' }],
      tools: [
        { type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
        { type: 'web_search', web_search: { enable: true, search_engine: 'search_pro', search_result: true, search_domain_filter: ['example.com'] } },
      ],
    })).json();
    const raw = j.choices?.[0]?.message?.content ?? '';
    // ECHO JSON 与降级文本拼在同一字符串：JSON.stringify 的字符串体内换行必为转义、
    // 永不含真实换行——按 '\n[web_search]' 边界截断后解析才不会报「JSON 后有多余字符」
    let e14 = null;
    try { e14 = parseEcho(raw.split('\n[web_search]')[0]); } catch {}
    check('④ 搜索: 请求侧 web_search 映射 + function 工具照常', e14?.tools?.some((t) => t?.type === 'web_search_20250305' && t?.name === 'web_search' && JSON.stringify(t?.allowed_domains) === JSON.stringify(['example.com']))
      && e14.tools.some((t) => t?.name === 'get_weather' && t?.input_schema?.properties?.city), JSON.stringify(e14?.tools));
    check('④ 搜索: 非流式降级文本逐字（同一响应原文）', raw.startsWith('ECHO:') && raw.includes('\n[web_search] 杭州天气') && raw.includes('- 结果标题 https://example.com/a') && raw.includes('搜索摘要'), raw.slice(0, 120));
  }
  {
    const r = await post('/v1/chat/completions', { model: 'claude-mock', max_tokens: 123, stream: true, messages: [{ role: 'user', content: '杭州天气' }], tools: [{ type: 'web_search', web_search: { enable: true, search_engine: 'search_pro', search_domain_filter: ['example.com'] } }] });
    const { datas } = await collectStream(r);
    const chunks = datas.filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    check('④ 搜索: 流式降级文本精确拼接（前导换行规则）', text === '你好世界\n[web_search] 杭州天气\n- 结果标题 https://example.com/a\n搜索摘要', JSON.stringify(text));
    const usageChunk = chunks.find((c) => c.usage && c.choices?.length === 0);
    check('④ 搜索: 流式末尾 usage chunk 缓存字段', usageChunk?.usage?.prompt_tokens === 19 && usageChunk?.usage?.prompt_tokens_details?.cached_tokens === 6, JSON.stringify(usageChunk?.usage));
  }

  console.log('— Kimi 搜索循环（mock-kimi / kimi-mock） —');
  {
    const j = await (await post('/v1/messages', {
      model: 'kimi-mock', max_tokens: 64,
      messages: [{ role: 'user', content: '杭州天气' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    })).json();
    const e = parseEcho(j.content?.[0]?.text ?? '');
    check('Kimi 循环: $web_search builtin 映射', e?.toolsType === 'builtin_function' && e?.fnName === '$web_search', JSON.stringify(e?.toolsType));
    check('Kimi 循环: arguments 原封回传', e?.echoedToolCall === '{"search_query":"杭州天气"}' && e?.assistantArgs === '{"search_query":"杭州天气"}', JSON.stringify([e?.assistantArgs, e?.echoedToolCall]));
    check('Kimi 循环: 终轮 usage 透传', j.usage?.input_tokens === 30 && j.usage?.cache_read_input_tokens === 0, JSON.stringify(j.usage));
  }
  {
    // 客户端要流式：循环内上游非流式，末轮由网关合成 Anthropic SSE
    const r = await post('/v1/messages', { model: 'kimi-mock', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '杭州天气' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
    const { events, datas } = await collectStream(r);
    const evs = datas.filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
    const text = evs.filter((e) => e.type === 'content_block_delta').map((e) => e.delta?.text ?? '').join('');
    const lastDelta = [...evs].reverse().find((e) => e.type === 'message_delta');
    check('Kimi 流式: 合成 Anthropic 事件序列', events.includes('message_start') && events.includes('content_block_delta') && events.includes('message_stop'), events.join(','));
    check('Kimi 流式: 终轮正文逐字', (() => { try { return parseEcho(text)?.final === '搜索完成：杭州晴[1]'; } catch { return false; } })(), text.slice(0, 80));
    check('Kimi 流式: message_delta usage 透传', lastDelta?.usage?.input_tokens === 30, JSON.stringify(lastDelta?.usage));
  }

  console.log('— 路由：显式前缀 / 默认上游兜底 —');
  {
    const j = await (await post('/v1/messages', { model: 'mock-anth/claude-mock', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).json();
    check('显式 pid/model 路由（前缀已剥离）', parseEcho(j.content[0].text).model === 'claude-mock');
    const j2 = await (await post('/v1/chat/completions', { model: 'mock-oai/mock-pro', messages: [{ role: 'user', content: 'hi' }] })).json();
    check('openai 显式前缀路由', parseEcho(j2.choices[0].message.content).model === 'mock-pro');
    const j3 = await (await post('/v1/chat/completions', { model: 'totally-unknown-model', messages: [{ role: 'user', content: 'hi' }] })).json();
    check('未知模型回落默认上游并原样携带', parseEcho(j3.choices[0].message.content).model === 'totally-unknown-model');
    const j4 = await (await post('/v1/chat/completions', { model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] })).json();
    const echo4 = parseEcho(j4.choices[0].message.content);
    // anthropic 上游的 ECHO 带 system 键，openai 上游没有——以此区分两个 shared-model 谁接了
    check('裸重名模型路由到目录序首个上游（mock-oai）', echo4.model === 'shared-model' && !('system' in echo4), JSON.stringify(echo4).slice(0, 120));
  }

  console.log('— 统计 —');
  {
    const s = await (await fetch(`${GW}/admin/stats`)).json();
    const ids = s.models.map((m) => m.id);
    check('统计按 provider:model 分桶', ids.includes('mock-oai:mock-pro') && ids.includes('mock-anth:claude-mock'), ids.join(','));
    check('统计记录流式 usage（直通 anthropic tap）', (s.models.find((m) => m.id === 'mock-anth:claude-mock')?.tout ?? 0) >= 7);
    check('逐日快照存在', Array.isArray(s.days) && s.days.length >= 1);
    // 费用：mock-pro 单价 1/2，openai 桶 tin=prompt_tokens(9) 已含缓存 5——费用按净输入折算：
    // (9−5)×1 + 12 out×2 + 5 cached×0.1 = 28.5e-6/次（缓存读不再被按全价输入双计）；
    // claude-mock 单价 0.5/1 + 缓存读 6×0.05 + 缓存写 2×0.625（pid 精确覆盖，anthropic 桶 tin 本就不含缓存）
    const proBucket = s.models.find((m) => m.id === 'mock-oai:mock-pro');
    const costPro = proBucket?.cost ?? 0;
    const costAnth = s.models.find((m) => m.id === 'mock-anth:claude-mock')?.cost ?? 0;
    check('费用按单价折算（mock-oai:mock-pro）', costPro >= 2.85e-5, String(costPro));
    // mock-pro 每次请求 usage 恒为 9/12/cached5：总费用应恰为 28.5e-6×次数（锁死不双计）
    check('openai 桶缓存读不双计费用（每次恰 28.5e-6）', Boolean(proBucket) && Math.abs(costPro - 28.5e-6 * proBucket.req) < 1e-9, `${costPro} / ${proBucket?.req} 次`);
    check('费用支持 pid/模型名 精确单价（mock-anth:claude-mock）', costAnth >= 1.25e-5, String(costAnth));
    check('缓存 token 分档计价（anthropic 直通 cread/cwrite 落桶）', (() => {
      const b = s.models.find((m) => m.id === 'mock-anth:claude-mock');
      // 6×0.5×0.1 + 2×0.5×1.25 = 0.3+1.25 per 1M → 至少一次直通请求计入
      return (b?.cread ?? 0) >= 6 && (b?.cwrite ?? 0) >= 2;
    })(), JSON.stringify(s.models.find((m) => m.id === 'mock-anth:claude-mock')));
    // protocols 契约：pid → 上游协议（供前端命中率分母按协议分支）
    check('stats.protocols 契约（6 键）', s.protocols?.['mock-oai'] === 'openai' && s.protocols?.['mock-anth'] === 'anthropic'
      && s.protocols?.['mock-kimi'] === 'openai' && s.protocols?.['mock-zhipu'] === 'openai' && s.protocols?.['mock-zai'] === 'openai'
      && s.protocols?.['mock-dual'] === 'openai' && Object.keys(s.protocols).length === 6, JSON.stringify(s.protocols));
    check('openai 桶缓存读落桶（P3 翻译路径）', (s.models.find((m) => m.id === 'mock-oai:mock-pro')?.cread ?? 0) >= 5, JSON.stringify(s.models.find((m) => m.id === 'mock-oai:mock-pro')?.cread));
    const kimiBucket = s.models.find((m) => m.id === 'mock-kimi:kimi-mock');
    const zhipuBucket = s.models.find((m) => m.id === 'mock-zhipu:glm-mock');
    check('Kimi 方言桶: req>=2（非流式+流式）且 tin>=30（仅末轮 usage）', (kimiBucket?.req ?? 0) >= 2 && (kimiBucket?.tin ?? 0) >= 30, JSON.stringify(kimiBucket));
    check('智谱方言桶: req>=2（非流式+流式）', (zhipuBucket?.req ?? 0) >= 2, JSON.stringify(zhipuBucket?.req));
    check('今日汇总含费用字段（week/since 死字段已删）', (s.today?.cost ?? 0) > 0 && s.week === undefined && s.since === undefined, JSON.stringify({ today: s.today?.cost, week: s.week, since: s.since }));
    const pm = s.prices.find((p) => p.pid === 'mock-oai' && p.model === 'mock-pro');
    const pa = s.prices.find((p) => p.pid === 'mock-anth' && p.model === 'claude-mock');
    check('单价表列出已计价模型（自定义来源）', pm?.source === 'custom' && pm?.input === 1 && pa?.source === 'custom' && pa?.input === 0.5, JSON.stringify([pm, pa]));
    check('无单价模型标记未计价', s.prices.find((p) => p.model === 'shared-model')?.source === 'none', JSON.stringify(s.prices.map((p) => `${p.pid}/${p.model}:${p.source}`)));
    {
      // 单元级：日期快照后缀名按基名计价（glm-5.3-260910 → glm-5.3）；缓存三档单价
      const { resolvePrice, costOf } = await import(path.join(ROOT, 'lib/pricing.mjs'));
      const p1 = resolvePrice('cannbot', 'glm-5.3-260910');
      const p2 = resolvePrice('kimi', 'no-such-model-261024');
      check('日期后缀剥除后命中内置单价', p1?.source === 'builtin' && p1?.input === 1.2, JSON.stringify(p1));
      check('无对应基名时仍未计价', p2 === null);
      const p3 = resolvePrice('cannbot', 'deepseek-flash');
      check('历史别名 deepseek-flash 已有单价', p3?.source === 'builtin' && p3?.input === 0.28, JSON.stringify(p3));
      const p4 = resolvePrice('cannbot', 'deepseek-v4-1-flash-260910');
      check('点号变体+日期双重兜底命中', p4?.source === 'builtin' && p4?.input === 0.28, JSON.stringify(p4));
      check('缓存三档计价：读 0.1×in、写 1.25×in', Math.abs(costOf('cannbot', 'glm-5.3', 1e6, 0, 1e6, 1e6) - (1.2 + 0.12 + 1.5)) < 1e-9, String(costOf('cannbot', 'glm-5.3', 1e6, 0, 1e6, 1e6)));
    }
  }

  console.log('— 供应商管理（/admin/providers CRUD + 热生效） —');
  {
    const v = await (await fetch(`${GW}/admin/providers`)).json();
    check('GET 视图含六个 provider 与默认上游', v.providers?.length === 6 && v.routing?.defaultProvider === 'mock-oai', JSON.stringify(v.routing));
    check('GET 视图不回显明文 token（只给掩码）', !JSON.stringify(v).includes('mock-token-oai') && v.providers[0].auth?.tokenSet === true && Boolean(v.providers[0].auth?.tokenMask));

    // undici 的 fetch 不允许改 Host 头（会被静默丢弃），用原生 http.request 验证回环校验
    const r403 = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: GW_PORT, path: '/admin/providers', headers: { host: 'evil.example' } }, resolve);
      rq.on('error', reject);
      rq.end();
    });
    check('非回环 Host → 403', r403.statusCode === 403, `got ${r403.statusCode}`);
    const badCt = await fetch(`${GW}/admin/providers`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    check('非 JSON 内容类型 → 415（防跨站表单伪造）', badCt.status === 415);
    const badId = await post('/admin/providers', { id: 'Bad Id!', protocol: 'openai', baseUrl: 'https://x.example' });
    check('非法 id → 400', badId.status === 400);
    const dup = await post('/admin/providers', { id: 'mock-oai', protocol: 'openai', baseUrl: 'https://x.example', auth: { type: 'static-token', token: 't' }, models: { source: 'api' } });
    check('重复 id → 409', dup.status === 409);
    const loop = await post('/admin/providers', { id: 'selfloop', protocol: 'openai', baseUrl: `http://127.0.0.1:${GW_PORT}/v1`, auth: { type: 'static-token', token: 't' }, models: { source: 'api' } });
    check('baseUrl 指向网关自身 → 400（防自环）', loop.status === 400);
    const badProto = await post('/admin/providers', { id: 'ok-id', protocol: 'grpc', baseUrl: 'https://x.example' });
    check('不支持的协议 → 400', badProto.status === 400);

    // 新增：anthropic 协议 + 静态模型 + 内联 token → 模型目录与路由立即生效（不重启）
    const created = await post('/admin/providers', {
      id: 'added', name: 'Added Provider', protocol: 'anthropic',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/anth`,
      auth: { type: 'static-token', token: 'mock-token-anthropic' },
      models: { source: 'static', list: [{ id: 'added-model', title: 'Added' }] },
    });
    check('新增 provider → 201', created.status === 201, String(await created.text()).slice(0, 200));
    const d2 = await (await fetch(`${GW}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    check('新增后模型目录即时包含新模型（热加载）', d2.data.some((m) => m.id === 'added-model' && m.owned_by === 'added'), d2.data.map((m) => m.id).join(','));
    const j = await (await post('/v1/chat/completions', { model: 'added-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] })).json();
    const echo = parseEcho(j.choices[0].message.content);
    check('新模型经反向翻译到达新上游（凭证正确）', echo.model === 'added-model' && echo.sawAuth === true);
    const sAdded = await (await fetch(`${GW}/admin/stats`)).json();
    check('未定价的新模型费用为 0 且标未计价', (sAdded.models.find((m) => m.id === 'added:added-model')?.cost ?? 1) === 0
      && sAdded.prices.find((p) => p.pid === 'added')?.source === 'none');

    // 编辑：部分字段 PUT，token 留空 → 沿用
    const upd = await fetch(`${GW}/admin/providers/added`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ name: '改名了' }) });
    check('部分字段 PUT → 200', upd.status === 200);
    const j2 = await (await post('/v1/chat/completions', { model: 'added-model', messages: [{ role: 'user', content: 'hi' }] })).json();
    check('token 未随编辑丢失（留空=沿用）', parseEcho(j2.choices[0].message.content).sawAuth === true);
    const v2 = await (await fetch(`${GW}/admin/providers`)).json();
    const av2 = v2.providers.find((p) => p.id === 'added');
    check('编辑后 name 生效、baseUrl 保留、token 仍脱敏', av2?.name === '改名了' && av2?.baseUrl.endsWith('/anth') && !JSON.stringify(v2).includes('mock-token-anthropic'));

    // 回归：token+tokenEnv 并存的条目（模板常见残留），编辑表单会把旧 tokenEnv 原样回传——
    // 不能误判为切换凭证来源而清掉内联 token（曾导致编辑任意字段保存后 token 静默丢失 → 401）
    await fetch(`${GW}/admin/providers/added`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ auth: { type: 'static-token', token: 'mock-token-anthropic', tokenEnv: 'ADDED_API_KEY' } }) });
    const updEcho = await fetch(`${GW}/admin/providers/added`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ name: '改名了', auth: { type: 'static-token', tokenEnv: 'ADDED_API_KEY' } }) });
    check('token+tokenEnv 并存: 原样回传 env 编辑 → 200', updEcho.status === 200);
    const jEnv = await (await post('/v1/chat/completions', { model: 'added-model', messages: [{ role: 'user', content: 'hi' }] })).json();
    check('token+tokenEnv 并存: 回显 env 不清内联 token（请求仍过鉴权）', parseEcho(jEnv.choices[0].message.content).sawAuth === true);
    const vEnv = await (await fetch(`${GW}/admin/providers`)).json();
    check('token+tokenEnv 并存: 视图 tokenSet 仍为 true', vEnv.providers.find((p) => p.id === 'added')?.auth?.tokenSet === true);
    // 正向语义保留：用户主动改选不同的 env 来源 → 切换凭证来源，清内联值
    const updSwitch = await fetch(`${GW}/admin/providers/added`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ auth: { type: 'static-token', tokenEnv: 'OTHER_KEY' } }) });
    check('改选不同 env 来源 → 200', updSwitch.status === 200);
    const vSwitch = await (await fetch(`${GW}/admin/providers`)).json();
    check('切换来源后内联 token 被清（tokenSet=false）', vSwitch.providers.find((p) => p.id === 'added')?.auth?.tokenSet === false);
    // 恢复内联 token 并清掉 env，供后续用例
    await fetch(`${GW}/admin/providers/added`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ auth: { type: 'static-token', token: 'mock-token-anthropic', tokenEnv: '' } }) });

    const chk = await post('/admin/providers/added/check', {});
    const chkJ = await chk.json();
    check('测试端点：静态目录经 /v1/models 验证凭证（mock 返回 2 个模型）', chk.status === 200 && chkJ.ok === true && chkJ.count === 2 && chkJ.ids?.includes('claude-mock'), JSON.stringify(chkJ));
    const chk404 = await post('/admin/providers/nope/check', {});
    check('测试不存在的 provider → 404', chk404.status === 404);

    // 停用 → 目录移除、裸名回落默认上游
    const dis = await fetch(`${GW}/admin/providers/added`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ enabled: false }) });
    check('停用 → 200', dis.status === 200);
    const d3 = await (await fetch(`${GW}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    check('停用后模型目录移除其模型', !d3.data.some((m) => m.owned_by === 'added'));
    const j3 = await (await post('/v1/chat/completions', { model: 'added-model', messages: [{ role: 'user', content: 'hi' }] })).json();
    check('停用后裸名回落默认上游透传', parseEcho(j3.choices[0].message.content).model === 'added-model' && !('system' in parseEcho(j3.choices[0].message.content)));

    // 删除与保护
    const del = await fetch(`${GW}/admin/providers/added`, { method: 'DELETE', headers: authHeaders });
    check('删除 provider → 200', del.status === 200);
    const v3 = await (await fetch(`${GW}/admin/providers`)).json();
    check('删除后视图不含 added', !v3.providers.some((p) => p.id === 'added'));
    const del404 = await fetch(`${GW}/admin/providers/added`, { method: 'DELETE', headers: authHeaders });
    check('删除不存在的 provider → 404', del404.status === 404);
    // 删到只剩一个时拒绝（providers 不允许为空）：依次删 mock-kimi、mock-zhipu、mock-zai、mock-anth、mock-dual
    await fetch(`${GW}/admin/providers/mock-kimi`, { method: 'DELETE', headers: authHeaders });
    await fetch(`${GW}/admin/providers/mock-zhipu`, { method: 'DELETE', headers: authHeaders });
    await fetch(`${GW}/admin/providers/mock-zai`, { method: 'DELETE', headers: authHeaders });
    await fetch(`${GW}/admin/providers/mock-anth`, { method: 'DELETE', headers: authHeaders });
    await fetch(`${GW}/admin/providers/mock-dual`, { method: 'DELETE', headers: authHeaders });
    const delLast = await fetch(`${GW}/admin/providers/mock-oai`, { method: 'DELETE', headers: authHeaders });
    check('最后一个 provider 拒绝删除 → 400', delLast.status === 400);
    const d4 = await (await fetch(`${GW}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    check('删除 mock-anth 后目录仍可用（仅剩 mock-oai）', d4.data.some((m) => m.id === 'mock-pro') && !d4.data.some((m) => m.owned_by === 'mock-anth'));
  }

  console.log('— 待办事项（/v1/todos CRUD + 持久化） —');
  {
    const noAuth = await fetch(`${GW}/v1/todos`);
    check('无 token 访问 /v1/todos → 401', noAuth.status === 401, `got ${noAuth.status}`);

    const c1 = await post('/v1/todos', { title: '适配 unigemm SME' });
    const t1 = (await c1.json()).todo;
    check('POST 新建 → 201 且缺省 normal/user', c1.status === 201 && t1?.urgency === 'normal' && t1?.source === 'user' && t1?.status === 'pending' && typeof t1?.id === 'string' && typeof t1?.created_at === 'number', JSON.stringify(t1));
    const c2 = await post('/v1/todos', { title: '排查网关 403', urgency: 'urgent', project: 'cannbot', note: '来自会话的上下文', source: 'agent:claude-code' });
    const t2 = (await c2.json()).todo;
    check('POST 全字段 → 201 且逐字段回显', c2.status === 201 && t2?.urgency === 'urgent' && t2?.project === 'cannbot' && t2?.source === 'agent:claude-code' && t2?.completed_at === null, JSON.stringify(t2));

    const todosHeaders = { authorization: `Bearer ${TOKEN}` };
    const list = await (await fetch(`${GW}/v1/todos`, { headers: todosHeaders })).json();
    check('GET 列表含 2 条', list.todos?.length === 2, JSON.stringify(list.todos?.length));
    const doneOnly = await (await fetch(`${GW}/v1/todos?status=done`, { headers: todosHeaders })).json();
    check('GET ?status=done 过滤为空', doneOnly.todos?.length === 0, JSON.stringify(doneOnly.todos?.length));

    const upd = await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ status: 'done' }) });
    const uJ = await upd.json();
    check('PUT 置 done → 200 且盖 completed_at', upd.status === 200 && typeof uJ.todo?.completed_at === 'number', JSON.stringify(uJ.todo));
    const back = await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ status: 'pending' }) });
    const bJ = await back.json();
    check('PUT 改回 pending → completed_at 清空', back.status === 200 && bJ.todo?.completed_at === null, JSON.stringify(bJ.todo));
    const upd404 = await fetch(`${GW}/v1/todos/no-such-id`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ status: 'done' }) });
    check('PUT 不存在的 id → 404', upd404.status === 404);
    const doneNow = await (await fetch(`${GW}/v1/todos?status=done`, { headers: todosHeaders })).json();
    check('?status=done 此刻为 0（已改回）', doneNow.todos?.length === 0);

    const del = await fetch(`${GW}/v1/todos/${t2.id}`, { method: 'DELETE', headers: todosHeaders });
    check('DELETE → 204', del.status === 204, `got ${del.status}`);
    const afterDel = await (await fetch(`${GW}/v1/todos`, { headers: todosHeaders })).json();
    check('删除后列表剩 1 条', afterDel.todos?.length === 1, JSON.stringify(afterDel.todos?.length));
    const del404 = await fetch(`${GW}/v1/todos/${t2.id}`, { method: 'DELETE', headers: todosHeaders });
    check('再删同一 id → 404', del404.status === 404);

    check('超长 title（501 字）→ 400', (await post('/v1/todos', { title: '长'.repeat(501) })).status === 400);
    check('emoji 按码位计（300 个 😀 ≤ 上限）→ 201', (await post('/v1/todos', { title: '😀'.repeat(300) })).status === 201);
    check('emoji 按码位计（501 个 😀 超限）→ 400', (await post('/v1/todos', { title: '😀'.repeat(501) })).status === 400);
    check('缺 title → 400', (await post('/v1/todos', {})).status === 400);
    check('非法 urgency → 400', (await post('/v1/todos', { title: 'x', urgency: '高' })).status === 400);
    check('非法 status → 400', (await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ status: 'todo' }) })).status === 400);
    check('未知方法 PATCH 打集合 → 405', (await fetch(`${GW}/v1/todos`, { method: 'PATCH', headers: authHeaders, body: '{}' })).status === 405);

    // PATCH 单条部分更新（就地编辑）：与 PUT 同一校验路径
    const p1 = await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ title: '适配 unigemm SME（修订）', urgency: 'urgent', project: 'unigemm' }) });
    const p1J = await p1.json();
    check('PATCH 改 title/urgency/project → 200 且逐字段生效', p1.status === 200 && p1J.todo?.title === '适配 unigemm SME（修订）' && p1J.todo?.urgency === 'urgent' && p1J.todo?.project === 'unigemm', JSON.stringify(p1J.todo));
    const p2 = await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ project: '' }) });
    check('PATCH 清空可选字段 project → 200', p2.status === 200 && !(await p2.json()).todo?.project);
    const p404 = await fetch(`${GW}/v1/todos/no-such-id`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ title: 'x' }) });
    check('PATCH 不存在的 id → 404', p404.status === 404);
    // 控制字符 id 的 404 文案：剥控制字符后给可读占位（不再显示成空白「待办  不存在」）
    const ctrl404 = await fetch(`${GW}/v1/todos/%00`, { method: 'DELETE', headers: authHeaders });
    const ctrlMsg = (await ctrl404.json()).error?.message || '';
    check('控制字符 id → 404 且文案可读（无空白拼接）', ctrl404.status === 404 && ctrlMsg.includes('不可显示') && !/待办\s{2,}/.test(ctrlMsg), ctrlMsg);
    check('PATCH 超长 title（501 码位）→ 400', (await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ title: '😀'.repeat(501) }) })).status === 400);
    check('PATCH 非法 urgency → 400', (await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ urgency: '高' }) })).status === 400);
    const pNoAuth = await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) });
    check('PATCH 无 token → 401', pNoAuth.status === 401);

    // 持久化：直读 todos.json（合法 JSON、与内存一致、0600）
    const fileState = JSON.parse(fs.readFileSync(path.join(tmp, 'todos.json'), 'utf8'));
    const listed = await (await fetch(`${GW}/v1/todos`, { headers: todosHeaders })).json();
    check('todos.json 落盘且与列表一致', Array.isArray(fileState.todos) && fileState.todos.length === listed.todos.length, `${fileState.todos?.length} vs ${listed.todos?.length}`);
    check('todos.json 权限 0600', (fs.statSync(path.join(tmp, 'todos.json')).mode & 0o777) === 0o600, fs.statSync(path.join(tmp, 'todos.json')).mode.toString(8));

    // 「清理已完成」按钮走的 DELETE 循环路径（API 侧）：3 done + 2 未完成 → 只删 done，未完成原样
    const doneIds = [];
    for (let i = 0; i < 3; i++) {
      const r = await post('/v1/todos', { title: `已完成项 ${i + 1}` });
      const id = (await r.json()).todo.id;
      await fetch(`${GW}/v1/todos/${id}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ status: 'done' }) });
      doneIds.push(id);
    }
    const keep = [];
    for (const title of ['未完成 A', '未完成 B']) {
      const r = await post('/v1/todos', { title });
      keep.push({ id: (await r.json()).todo.id, title });
    }
    let delOk = 0;
    for (const id of doneIds) {
      if ((await fetch(`${GW}/v1/todos/${id}`, { method: 'DELETE', headers: todosHeaders })).status === 204) delOk++;
    }
    check('清理循环：3 条 done 全部 204 删除', delOk === 3, String(delOk));
    const afterClear = await (await fetch(`${GW}/v1/todos`, { headers: todosHeaders })).json();
    const afterIds = new Set(afterClear.todos.map((t) => t.id));
    check('清理循环：未完成项原样保留、done 不残留', keep.every((k) => afterIds.has(k.id) && afterClear.todos.find((t) => t.id === k.id).title === k.title) && !doneIds.some((id) => afterIds.has(id)), JSON.stringify(afterClear.todos.map((t) => t.title)));
    for (const k of keep) await fetch(`${GW}/v1/todos/${k.id}`, { method: 'DELETE', headers: todosHeaders });

    // 坏文件自愈：另起实例指向损坏的 todos.json / reports.json → 空列表起步、主业务不崩、
    // 坏文件留 .bad 备份（不静默清掉用户数据）
    fs.writeFileSync(path.join(tmp, 'todos-bad.json'), '{not-json');
    fs.writeFileSync(path.join(tmp, 'reports-bad.json'), '{"reports": [');
    const gwTodo = spawnNode([path.join(ROOT, 'server.mjs')], {
      CANNBOT_PROXY_PORT: '6294',
      CANNBOT_CONFIG_FILE: path.join(tmp, 'providers.json'),
      CANNBOT_LOG_FILE: path.join(tmp, 'proxy4.log'),
      CANNBOT_STATS_FILE: path.join(tmp, 'stats4.json'),
      CANNBOT_TODOS_FILE: path.join(tmp, 'todos-bad.json'),
      CANNBOT_REPORTS_FILE: path.join(tmp, 'reports-bad.json'),
    }, 'gateway-bad-todos');
    await sleep(1500);
    const badList = await (await fetch('http://127.0.0.1:6294/v1/todos', { headers: todosHeaders })).json();
    check('坏 todos.json：实例存活且空列表起步', Array.isArray(badList.todos) && badList.todos.length === 0, JSON.stringify(badList));
    check('坏 todos.json：主业务正常', (await (await fetch('http://127.0.0.1:6294/healthz')).json()).service === 'unified-subscription-gateway');
    check('坏 todos.json：留 .bad 备份且内容原样', fs.readFileSync(path.join(tmp, 'todos-bad.json.bad'), 'utf8') === '{not-json');
    check('坏 todos.json：.bad 备份权限 0600', (fs.statSync(path.join(tmp, 'todos-bad.json.bad')).mode & 0o777) === 0o600);
    check('坏 reports.json：留 .bad 备份且内容原样', fs.readFileSync(path.join(tmp, 'reports-bad.json.bad'), 'utf8') === '{"reports": [');
    // 第二次坏文件：固定名 .bad 已存在 → 备份改带时间戳后缀，不覆盖第一次的现场
    gwTodo.kill();
    fs.writeFileSync(path.join(tmp, 'todos-bad.json'), '{worse-not-json');
    const gwTodo2 = spawnNode([path.join(ROOT, 'server.mjs')], {
      CANNBOT_PROXY_PORT: '6294',
      CANNBOT_CONFIG_FILE: path.join(tmp, 'providers.json'),
      CANNBOT_LOG_FILE: path.join(tmp, 'proxy4.log'),
      CANNBOT_STATS_FILE: path.join(tmp, 'stats4.json'),
      CANNBOT_TODOS_FILE: path.join(tmp, 'todos-bad.json'),
      CANNBOT_REPORTS_FILE: path.join(tmp, 'reports-ok2.json'),
    }, 'gateway-bad-todos-2');
    await sleep(1500);
    const stamped = fs.readdirSync(tmp).filter((f) => /^todos-bad\.json\.bad\.\d{14}$/.test(f));
    check('第二次坏文件：.bad 不被覆盖，改带时间戳后缀', stamped.length === 1 && fs.readFileSync(path.join(tmp, 'todos-bad.json.bad'), 'utf8') === '{not-json' && fs.readFileSync(path.join(tmp, stamped[0]), 'utf8') === '{worse-not-json', JSON.stringify(stamped));
    gwTodo2.kill();
  }

  console.log('— 待办子项 checklist（/v1/todos/:id/items + 自动完成派生 + agent 短写上限） —');
  {
    // 建带清单的待办（agent 来源；note 恰 300 码位边界值）
    const cA = await post('/v1/todos', {
      title: 'SME 推进', source: 'agent:zcode', project: 'unigemm', note: '短'.repeat(300),
      items: [{ title: '内核适配' }, { title: '跑通 benchmark' }, { title: '归档结果' }],
    });
    const jA = (await cA.json()).todo;
    check('POST 带 items（agent note 恰 300）→ 201；子项有 id / done=false / done_at=null',
      cA.status === 201 && Array.isArray(jA?.items) && jA.items.length === 3
      && jA.items.every((it) => typeof it.id === 'string' && it.done === false && it.done_at === null),
      JSON.stringify(jA?.items));
    check('未全完成不派生：父仍 pending 且 completed_at null', jA?.status === 'pending' && jA?.completed_at === null);

    const note301 = await post('/v1/todos', { title: 'x', source: 'agent:claude-code', note: '长'.repeat(301) });
    const note301J = await note301.json();
    check('agent note 301 码位 → 400 且文案点明 300 上限', note301.status === 400 && (note301J.error?.message || '').includes('300'), JSON.stringify(note301J.error));
    const notePatch = await fetch(`${GW}/v1/todos/${jA.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ note: '长'.repeat(301) }) });
    check('agent 条目 PATCH note 301 → 400（分级上限对 PATCH 同样生效）', notePatch.status === 400);
    const userLong = await post('/v1/todos', { title: '用户长详情', note: '详'.repeat(2000) });
    check('用户 note 2000 码位 → 201（用户上限不收）', userLong.status === 201);

    const plain = (await (await post('/v1/todos', { title: '无清单条目' })).json()).todo;
    check('无 items 入参：返回不含 items 键（旧模型零迁移）', plain.items === undefined, JSON.stringify(plain));

    // 自动完成派生：逐个勾完 → 父自动 done
    const [i1, i2, i3] = jA.items;
    const t1 = await fetch(`${GW}/v1/todos/${jA.id}/items/${i1.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ done: true }) });
    const t1J = await t1.json();
    check('PATCH 子项 done → 200 且响应带整只父待办', t1.status === 200 && t1J.ok === true && t1J.todo?.items?.length === 3, JSON.stringify(t1J).slice(0, 140));
    check('勾 1/3：父仍 pending', t1J.todo?.status === 'pending');
    check('勾 1/3：目标子项 done_at 盖章、其余子项原样', t1J.todo?.items?.find((x) => x.id === i1.id)?.done_at != null
      && t1J.todo.items.filter((x) => x.id !== i1.id).every((x) => x.done === false && x.done_at === null), JSON.stringify(t1J.todo?.items));
    check('单子项 PATCH：父 title/note 不被触碰（并发不整组覆盖）', t1J.todo?.title === 'SME 推进' && t1J.todo?.note === '短'.repeat(300));
    const t2 = await (await fetch(`${GW}/v1/todos/${jA.id}/items/${i2.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ done: true }) })).json();
    check('勾 2/3：父仍 pending', t2.todo?.status === 'pending');
    const t3 = await (await fetch(`${GW}/v1/todos/${jA.id}/items/${i3.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ done: true }) })).json();
    check('勾 3/3（全完成）→ 父自动 done 且 completed_at 盖章', t3.todo?.status === 'done' && typeof t3.todo?.completed_at === 'number', JSON.stringify([t3.todo?.status, t3.todo?.completed_at]));
    const stamp1 = t3.todo.completed_at;

    // completed_at 不重盖：全 done 后整组原样替换（保留 id，内容不变）
    const again = await fetch(`${GW}/v1/todos/${jA.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ items: t3.todo.items }) });
    const againJ = await again.json();
    check('全 done 后整组原样替换：completed_at 不重盖', again.status === 200 && againJ.todo?.completed_at === stamp1, JSON.stringify([againJ.todo?.completed_at, stamp1]));

    // 取消一个 → 父回 in_progress、清章；再勾回 → 重盖新值
    const un = await (await fetch(`${GW}/v1/todos/${jA.id}/items/${i2.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ done: false }) })).json();
    check('取消一个子项 → 父回 in_progress 且 completed_at 清空', un.todo?.status === 'in_progress' && un.todo?.completed_at === null, JSON.stringify(un.todo && [un.todo.status, un.todo.completed_at]));
    check('取消后该子项 done_at 置 null', un.todo?.items?.find((x) => x.id === i2.id)?.done_at === null);
    const re = await (await fetch(`${GW}/v1/todos/${jA.id}/items/${i2.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ done: true }) })).json();
    check('再勾回 → 父再次自动 done，completed_at 重盖', re.todo?.status === 'done' && typeof re.todo?.completed_at === 'number' && re.todo.completed_at >= stamp1);

    // done 父加未勾子项 → 派生回 in_progress；删掉 → 剩余全 done 回 done
    const add = await fetch(`${GW}/v1/todos/${jA.id}/items`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ title: '补充：补文档' }) });
    const addJ = await add.json();
    const newItem = addJ.todo?.items?.find((x) => x.title === '补充：补文档');
    check('POST 加子项 → 201 且返回父待办', add.status === 201 && addJ.ok === true && Boolean(newItem), JSON.stringify(addJ).slice(0, 140));
    check('done 父加未勾子项 → 派生回 in_progress', addJ.todo?.status === 'in_progress');
    const delIt = await fetch(`${GW}/v1/todos/${jA.id}/items/${newItem.id}`, { method: 'DELETE', headers: authHeaders });
    const afterDel = await (await fetch(`${GW}/v1/todos`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    const jAAfter = afterDel.todos.find((x) => x.id === jA.id);
    check('DELETE 子项 → 204；剩余全 done → 父回 done', delIt.status === 204 && jAAfter?.status === 'done', JSON.stringify(jAAfter && [jAAfter.status, jAAfter.items?.length]));

    // 整组替换：保留既有 id + 新增一条（网页批量编辑 / agent 一次建单的路径）
    const replaced = await fetch(`${GW}/v1/todos/${jA.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({
      items: [...jAAfter.items.map((it) => ({ id: it.id, title: it.title, done: it.done })), { title: '整组替换新增' }],
    }) });
    const repJ = await replaced.json();
    check('PATCH items 整组替换：既有 id 保留、新增派新 id', replaced.status === 200
      && repJ.todo?.items?.some((it) => it.id === i1.id) && repJ.todo.items.some((it) => it.title === '整组替换新增')
      && repJ.todo.items.length === 4 && new Set(repJ.todo.items.map((it) => it.id)).size === 4,
      JSON.stringify(repJ.todo?.items?.map((it) => [it.id, it.title, it.done])));

    // 显式 status 优先 + 空清单不派生
    const manual = await (await fetch(`${GW}/v1/todos/${jA.id}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ status: 'in_progress' }) })).json();
    check('子项未全完成时显式 PUT status：按显式请求执行', manual.todo?.status === 'in_progress' && manual.todo?.completed_at === null);
    const cleared = await (await fetch(`${GW}/v1/todos/${jA.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ items: [] }) })).json();
    check('PATCH items:[] → 清单清空、父状态不动（空清单不派生）', cleared.todo?.items?.length === 0 && cleared.todo?.status === 'in_progress');

    // 创建即全 done：派生在创建时同样生效
    const born = await post('/v1/todos', { title: '生而完成', items: [{ title: 'a', done: true }, { title: 'b', done: true }] });
    const bornJ = (await born.json()).todo;
    check('POST items 全 done → 创建即派生 done + completed_at', born.status === 201 && bornJ?.status === 'done' && typeof bornJ?.completed_at === 'number');

    // 旧条目（无 items 字段的存量数据）PATCH 正常、不派生
    const oldPatch = await fetch(`${GW}/v1/todos/${plain.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ title: '无清单条目（改名）' }) });
    const oldJ = await oldPatch.json();
    check('旧条目 PATCH title 正常且不派生（items 仍缺省）', oldPatch.status === 200 && oldJ.todo?.title === '无清单条目（改名）' && oldJ.todo?.items === undefined && oldJ.todo?.status === 'pending');

    // 校验矩阵
    check('items 非数组 → 400', (await post('/v1/todos', { title: 'x', items: 'nope' })).status === 400);
    check('子项缺 title → 400', (await post('/v1/todos', { title: 'x', items: [{}] })).status === 400);
    check('子项 title 201 码位 → 400', (await post('/v1/todos', { title: 'x', items: [{ title: '子'.repeat(201) }] })).status === 400);
    check('子项 done 非布尔 → 400', (await post('/v1/todos', { title: 'x', items: [{ title: 'ok', done: 'yes' }] })).status === 400);
    check('子项超 50 条 → 400', (await post('/v1/todos', { title: 'x', items: Array.from({ length: 51 }, (_, i) => ({ title: `子项${i}` })) })).status === 400);
    check('子项恰 50 条 → 201', (await post('/v1/todos', { title: 'x', items: Array.from({ length: 50 }, (_, i) => ({ title: `子项${i}` })) })).status === 201);
    check('加子项缺 title → 400', (await fetch(`${GW}/v1/todos/${plain.id}/items`, { method: 'POST', headers: authHeaders, body: JSON.stringify({}) })).status === 400);
    check('改子项 done 非布尔 → 400', (await fetch(`${GW}/v1/todos/${bornJ.id}/items/${bornJ.items[0].id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ done: 1 }) })).status === 400);
    check('未知子项 id → 404', (await fetch(`${GW}/v1/todos/${plain.id}/items/deadbeef`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ done: true }) })).status === 404);
    check('DELETE 未知子项 → 404', (await fetch(`${GW}/v1/todos/${plain.id}/items/deadbeef`, { method: 'DELETE', headers: authHeaders })).status === 404);
    check('子项端点未知父 id → 404', (await fetch(`${GW}/v1/todos/no-such/items`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ title: 'x' }) })).status === 404);
    check('未知子资源 /v1/todos/:id/notes → 404（不再误当父 id）', (await fetch(`${GW}/v1/todos/${plain.id}/notes`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ title: 'x' }) })).status === 404);
    check('GET /v1/todos/:id/items → 405（清单随父 GET 返回，无独立 GET）', (await fetch(`${GW}/v1/todos/${plain.id}/items`, { headers: { authorization: `Bearer ${TOKEN}` } })).status === 405);
  }

  console.log('— 配置 workbench 节（报告模型设置，热加载） —');
  {
    const c = await (await fetch(`${GW}/admin/config`)).json();
    check('/admin/config 透传 workbench 节', c.workbench?.reportProvider === 'mock-oai' && c.workbench?.reportModel === 'mock-pro', JSON.stringify(c.workbench));
    // 进程内：坏值静默跳过（非字符串/空串/未知键一律剔除，不阻塞配置加载）
    const badCfg = path.join(tmp, 'providers-bad-wb.json');
    fs.writeFileSync(badCfg, JSON.stringify({
      gateway: { clientToken: 'x' },
      providers: [{ id: 'p1', protocol: 'openai', baseUrl: 'https://x.example', auth: { type: 'static-token', token: 't' }, models: { source: 'static', list: [{ id: 'm1' }] } }],
      workbench: { reportProvider: 123, reportModel: '', extra: true },
    }));
    const prev = process.env.CANNBOT_CONFIG_FILE;
    process.env.CANNBOT_CONFIG_FILE = badCfg;
    const { getConfig } = await import(path.join(ROOT, 'lib/config.mjs') + '?badwb=' + Date.now());
    process.env.CANNBOT_CONFIG_FILE = prev;
    const wb = getConfig().workbench;
    check('workbench 坏值静默剔除（非字符串/空串/未知键）', wb && Object.keys(wb).length === 0, JSON.stringify(wb));
    // 进程内：配置文件缺失时的内置默认回落必须过 normalize——否则 healthz 的
    // providers 过滤（p.enabled）会把内置 cannbot 隐形，与「回落仅 cannbot」文案矛盾
    process.env.CANNBOT_CONFIG_FILE = path.join(tmp, '不存在的-providers.json');
    const cfgMod = await import(path.join(ROOT, 'lib/config.mjs') + '?builtin=' + Date.now());
    process.env.CANNBOT_CONFIG_FILE = prev;
    const bc = cfgMod.getConfig();
    check('内置默认回落含 cannbot 且 enabled（过 normalize）',
      bc.providers.length === 1 && bc.providers[0].id === 'cannbot' && bc.providers[0].enabled === true,
      JSON.stringify(bc.providers.map((p) => ({ id: p.id, enabled: p.enabled }))));
    check('内置默认回落无客户端鉴权', bc.gateway.clientToken === null, JSON.stringify(bc.gateway));
  }

  console.log('— 提交就绪：运行时产物 .bad 备份被 .gitignore 覆盖 —');
  {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    check('.gitignore 覆盖 *.bad / *.bad.*（坏文件自愈现场不入库）',
      gi.includes('*.bad') && gi.includes('*.bad.*'),
      gi.split('\n').filter((l) => l.includes('bad')).join(' | '));
  }

  console.log('— 提交就绪：shell 脚本 $VAR 后紧跟全角标点（bash 3.2 + set -u 必崩）—');
  {
    // macOS 自带 bash 3.2 会把紧跟变量的全角（等标点的多字节序列并入变量名，
    // set -u 下报 unbound variable——uninstall.sh 曾因此在 rm -rf 前崩溃
    const bad = [];
    for (const sh of ['install.sh', 'uninstall.sh', 'status.sh', 'cannbot-creds.sh']) {
      const src = fs.readFileSync(path.join(ROOT, sh), 'utf8');
      for (const m of src.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*[（）。：，、]/g)) bad.push(`${sh}: ${m[0]}`);
    }
    check('四个 shell 脚本无 $VAR 后紧跟全角标点', bad.length === 0, bad.join(' | '));
    const un = fs.readFileSync(path.join(ROOT, 'uninstall.sh'), 'utf8');
    check('uninstall.sh 卸载前抢救 .bad 现场备份', un.includes('*.bad') && un.includes('*.bad.*'),
      un.split('\n').filter((l) => l.includes('.bad')).join(' | ').slice(0, 120));
    // r6 事故防护：launchctl 作用于用户域（与 HOME 无关），两脚本必须有演练守卫
    const ins = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    check('install.sh 含 CGP_SKIP_LAUNCHCTL 演练守卫', (ins.match(/CGP_SKIP_LAUNCHCTL/g) ?? []).length >= 2,
      'bootout 与 bootstrap 两处都需守卫');
    check('uninstall.sh 含 CGP_SKIP_LAUNCHCTL 演练守卫', (un.match(/CGP_SKIP_LAUNCHCTL/g) ?? []).length >= 2,
      'bootout 与文案都需守卫');
    // r8 对比度：tgroup-label 用 --dim（暗 5.5 / 亮 4.69，WCAG AA）；亮色 --dim 加深到 #736d5e
    const wbh = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const wbc = fs.readFileSync(path.join(ROOT, 'theme.css'), 'utf8');
    check('tgroup-label 颜色为 --dim（不用 2.67:1 的 --faint）',
      /tgroup-label[\s\S]{0,200}color:\s*var\(--dim\)/.test(wbh),
      '分组标签需达 WCAG AA');
    check('亮色 --dim 对比度 ≥4.5（#736d5e）', wbc.includes('--dim: #736d5e'),
      '原 #7b7566 仅 4.17:1');
    // r9 代码质量：async 界面动作统一兜底（safe 包装）；素材压缩预算耗尽先短路
    check('async 事件回调统一 safe() 兜底（含删除报告 fetch .catch）',
      /const safe = \(fn\) =>/.test(wbh) && /safe\(addTodo\)/.test(wbh) && /safe\(generateReport\)/.test(wbh)
        && /\}\)\.catch\(\(e\) => showErr/.test(wbh),
      '网络层 reject 须给可见提示而非 unhandled rejection');
    const collectSrc = fs.readFileSync(path.join(ROOT, 'lib/report/collect.mjs'), 'utf8');
    check('compressSession 预算耗尽先短路（不拼孤立「…」）', collectSrc.includes('remain <= 0) break'),
      'cut(…,0) 会返回 1 个码位的「…」伪消息');
    // ux-r9 键盘可达性：大量待办下行内按钮全在 Tab 序里，报告区纯键盘不可达——
    // 主区首部极简 skip link（仅 :focus-visible 显现），目标 section tabindex=-1 让焦点真落地
    // 原「跳到报告区」skip link 的前提消失了：汇报已是独立视图，左栏一键可达，
    // 不再有「大量待办行内按钮把报告区挤出 Tab 序」的问题，故移除。
    check('skip link 已移除（汇报为独立视图，左栏直达取代）', !wbh.includes('class="skip"'));
  }

  console.log('— 报告源：zcode（db.sqlite 适配器，fixture） —');
  {
    const NOW = Date.now();
    const WIN = { startMs: NOW - 3600_000, endMs: NOW + 3600_000 };
    // fixture：最小列集 = 适配器 SQL 引用的列；SQL 从 stdin 喂给系统 sqlite3
    const j = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    const db = path.join(tmp, 'zcode-fixture.db');
    spawnSync('/usr/bin/sqlite3', [db], {
      input: `
CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, task_type TEXT, parent_id TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, time_deleted INTEGER);
CREATE TABLE message (id TEXT, session_id TEXT, sequence INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE TABLE part (message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);
INSERT INTO session VALUES ('session_aaa', NULL, '/Users/x/proj-a', '会话A', 'interactive', NULL, '0.17.0', ${NOW - 600_000}, ${NOW - 300_000}, NULL);
INSERT INTO session VALUES ('session_bbb', NULL, '/Users/x/proj-a', '会话B', 'subagent', 'session_aaa', '0.17.0', ${NOW - 600_000}, ${NOW - 300_000}, NULL);
INSERT INTO session VALUES ('session_ccc', NULL, '/Users/x/proj-c', '会话C', 'interactive', NULL, '0.17.0', ${NOW - 100 * 3600_000}, ${NOW - 200_000}, NULL);
INSERT INTO message VALUES ('m1', 'session_aaa', 1, ${NOW - 500_000}, ${NOW - 500_000}, ${j({ role: 'user', semantics: { kind: 'user_prompt', origin: 'real_user' } })});
INSERT INTO message VALUES ('m2', 'session_aaa', 2, ${NOW - 450_000}, ${NOW - 450_000}, ${j({ role: 'user', semantics: { kind: 'todo_reminder', origin: 'system' } })});
INSERT INTO message VALUES ('m3', 'session_aaa', 3, ${NOW - 400_000}, ${NOW - 400_000}, ${j({ role: 'assistant' })});
INSERT INTO message VALUES ('m5', 'session_ccc', 1, ${NOW - 100 * 3600_000}, ${NOW - 100 * 3600_000}, ${j({ role: 'user', semantics: { kind: 'user_prompt', origin: 'real_user' } })});
INSERT INTO part VALUES ('m1', 'session_aaa', 1, ${j({ type: 'text', text: '帮我优化 unigemm 的 SME 内核' })});
INSERT INTO part VALUES ('m2', 'session_aaa', 1, ${j({ type: 'text', text: '提醒：你有 3 个待办' })});
INSERT INTO part VALUES ('m3', 'session_aaa', 1, ${j({ type: 'reasoning', text: '思考中' })});
INSERT INTO part VALUES ('m3', 'session_aaa', 2, ${j({ type: 'text', text: '已完成内核优化，性能提升 15%' })});
INSERT INTO part VALUES ('m3', 'session_aaa', 3, ${j({ type: 'tool', tool: 'Bash', state: { input: { command: 'python bench.py' } } })});
INSERT INTO part VALUES ('m5', 'session_ccc', 1, ${j({ type: 'text', text: '很早以前的消息' })});
`,
    });

    process.env.CANNBOT_ZCODE_DB = db;
    const { listSessions } = await import(path.join(ROOT, 'lib/report/sources/zcode.mjs') + '?t=' + Date.now());
    const sessions = await listSessions(WIN);
    check('zcode: 恰 1 会话（subagent 整会话排除、窗口外消息清空不产出）', sessions.length === 1, JSON.stringify(sessions.map((s) => s.sessionId)));
    const s = sessions[0];
    check('zcode: project 取 directory、title、source 标记', s?.project === '/Users/x/proj-a' && s?.title === '会话A' && s?.source === 'zcode', JSON.stringify(s && { project: s.project, title: s.title, source: s.source }));
    check('zcode: 真人输入与 assistant 正文都在素材里',
      s?.messages?.some((m) => m.role === 'user' && m.text.includes('SME 内核'))
      && s?.messages?.some((m) => m.role === 'assistant' && m.text.includes('性能提升 15%')), JSON.stringify(s?.messages));
    check('zcode: 工具调用产出摘要行（工具名 + 参数）', s?.messages?.some((m) => m.text.includes('[Bash]') && m.text.includes('python bench.py')), JSON.stringify(s?.messages));
    check('zcode: 合成注入（todo_reminder）被过滤', !s?.messages?.some((m) => m.text.includes('提醒')), JSON.stringify(s?.messages?.map((m) => m.text)));
    check('zcode: reasoning 不进素材', !s?.messages?.some((m) => m.text.includes('思考中')));
    check('zcode: 消息时间均在窗口内', s?.messages?.every((m) => m.time >= WIN.startMs && m.time < WIN.endMs));
    check('zcode: 会话起止 = 窗口内消息实际首末（严格相等）', s && s.messages.length > 0 && s.startTime === s.messages[0].time && s.endTime === s.messages[s.messages.length - 1].time, JSON.stringify([s?.startTime, s?.endTime]));

    process.env.CANNBOT_ZCODE_DB = path.join(tmp, 'no-such.db');
    let rejected = false;
    try { await listSessions(WIN); } catch { rejected = true; }
    check('zcode: db 不存在 → reject（collect 层降级用）', rejected);
    process.env.CANNBOT_ZCODE_DB = db;
  }

  console.log('— 报告源：opencode（主路 + event 补路，fixture） —');
  {
    const NOW = Date.now();
    const WIN = { startMs: NOW - 3600_000, endMs: NOW + 3600_000 };
    const j = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    const db = path.join(tmp, 'opencode-fixture.db');
    spawnSync('/usr/bin/sqlite3', [db], {
      input: `
CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
CREATE TABLE part (id TEXT, message_id TEXT, data TEXT);
CREATE TABLE event (id TEXT, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);
INSERT INTO session VALUES ('ses_live', NULL, '/Users/x/proj-live', '现场会话', ${NOW - 600_000}, ${NOW - 300_000});
INSERT INTO message VALUES ('msg_l1', 'ses_live', ${NOW - 500_000}, ${j({ role: 'user' })});
INSERT INTO message VALUES ('msg_l2', 'ses_live', ${NOW - 400_000}, ${j({ role: 'assistant' })});
INSERT INTO message VALUES ('msg_l3', 'ses_live', ${NOW - 100 * 3600_000}, ${j({ role: 'user' })});
INSERT INTO part VALUES ('prt_l1', 'msg_l1', ${j({ type: 'text', text: '排查内存泄漏' })});
INSERT INTO part VALUES ('prt_l2', 'msg_l2', ${j({ type: 'text', text: '定位到泄漏点并修复' })});
INSERT INTO part VALUES ('prt_l3', 'msg_l3', ${j({ type: 'text', text: '很早以前的消息' })});
-- event-only 会话（用户删过会话，session 表级联清空、event 残留）
INSERT INTO event VALUES ('e1', 'ses_gone', 1, 'session.created.1', ${j({ sessionID: 'ses_gone', info: { id: 'ses_gone', directory: '/Users/x/proj-gone', title: '已删会话', time: { created: NOW - 600_000 } } })});
INSERT INTO event VALUES ('e2', 'ses_gone', 2, 'message.updated.1', ${j({ sessionID: 'ses_gone', info: { id: 'msg_g1', sessionID: 'ses_gone', role: 'user', time: { created: NOW - 500_000 } } })});
INSERT INTO event VALUES ('e3', 'ses_gone', 3, 'message.part.updated.1', ${j({ sessionID: 'ses_gone', part: { id: 'prt_g1', messageID: 'msg_g1', type: 'text', text: '整理部署文档（草稿）' }, time: NOW - 500_000 })});
INSERT INTO event VALUES ('e4', 'ses_gone', 4, 'message.part.updated.1', ${j({ sessionID: 'ses_gone', part: { id: 'prt_g1', messageID: 'msg_g1', type: 'text', text: '整理部署文档（终稿）' }, time: NOW - 450_000 })});
INSERT INTO event VALUES ('e5', 'ses_gone', 5, 'message.updated.1', ${j({ sessionID: 'ses_gone', info: { id: 'msg_g2', sessionID: 'ses_gone', role: 'assistant', time: { created: NOW - 400_000 } } })});
INSERT INTO event VALUES ('e6', 'ses_gone', 6, 'message.part.updated.1', ${j({ sessionID: 'ses_gone', part: { id: 'prt_g2', messageID: 'msg_g2', type: 'text', text: '文档已归档' }, time: NOW - 400_000 })});
INSERT INTO event VALUES ('e7', 'ses_gone', 7, 'message.updated.1', ${j({ sessionID: 'ses_gone', info: { id: 'msg_g3', sessionID: 'ses_gone', role: 'user', time: { created: NOW - 350_000 } } })});
INSERT INTO event VALUES ('e8', 'ses_gone', 8, 'message.part.updated.1', ${j({ sessionID: 'ses_gone', part: { id: 'prt_g3', messageID: 'msg_g3', type: 'text', text: '你是多 agent 团队中的成员，负责汇总' }, time: NOW - 350_000 })});
`,
    });

    process.env.CANNBOT_OPENCODE_DB = db;
    const { listSessions } = await import(path.join(ROOT, 'lib/report/sources/opencode.mjs') + '?t=' + Date.now());
    const sessions = await listSessions(WIN);
    check('opencode: 双路产出 2 会话（live + event-only）', sessions.length === 2, JSON.stringify(sessions.map((x) => x.sessionId)));
    const live = sessions.find((x) => x.sessionId === 'ses_live');
    const gone = sessions.find((x) => x.sessionId === 'ses_gone');
    check('opencode: live 会话正文来自 part 表', live?.messages?.some((m) => m.role === 'user' && m.text.includes('排查内存泄漏')) && live?.messages?.some((m) => m.role === 'assistant' && m.text.includes('定位到泄漏点并修复')), JSON.stringify(live?.messages));
    check('opencode: 窗口外消息被滤', !live?.messages?.some((m) => m.text.includes('很早以前')), JSON.stringify(live?.messages?.map((m) => m.text)));
    check('opencode: event-only 会话目录与标题', gone?.project === '/Users/x/proj-gone' && gone?.title === '已删会话' && gone?.source === 'opencode', JSON.stringify(gone && { project: gone.project, title: gone.title }));
    check('opencode: part 事件取最终态（流式中间态不重复拼接）', gone?.messages?.some((m) => m.text.includes('整理部署文档（终稿）')) && !gone?.messages?.some((m) => m.text.includes('草稿')), JSON.stringify(gone?.messages));
    check('opencode: 合成注入（多 agent 插件提示）被滤', !gone?.messages?.some((m) => m.text.includes('你是多 agent')), JSON.stringify(gone?.messages?.map((m) => m.text)));
    check('opencode: 消息时间均在窗口内', sessions.every((x) => x.messages.every((m) => m.time >= WIN.startMs && m.time < WIN.endMs)));

    process.env.CANNBOT_OPENCODE_DB = path.join(tmp, 'no-such.db');
    let rejected = false;
    try { await listSessions(WIN); } catch { rejected = true; }
    check('opencode: db 不存在 → reject', rejected);
    process.env.CANNBOT_OPENCODE_DB = db;
  }

  console.log('— 报告源：Claude Code（projects jsonl 适配器，fixture） —');
  {
    const NOW = Date.now();
    const WIN = { startMs: NOW - 3600_000, endMs: NOW + 3600_000 };
    const T = (offsetMs) => new Date(NOW + offsetMs).toISOString();
    const projDir = path.join(tmp, 'cc-projects', '-Users-x-dirname-lossy---'); // 目录名故意不可逆编码
    fs.mkdirSync(projDir, { recursive: true });
    // sess1：窗口内混合行（真人/斜杠/工具结果/isMeta/assistant thinking+text/ai-title/半截行）
    fs.writeFileSync(path.join(projDir, 'sess1.jsonl'), [
      JSON.stringify({ type: 'ai-title', aiTitle: '网关排障', sessionId: 's1' }),
      JSON.stringify({ type: 'user', message: { content: '帮我看下 403' }, promptSource: 'typed', cwd: '/Users/x/real-proj', timestamp: T(-500_000), sessionId: 's1' }),
      JSON.stringify({ type: 'user', message: { content: '/model glm-4.7 ' }, cwd: '/Users/x/real-proj', timestamp: T(-480_000) }), // 斜杠回显（无 promptSource）
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, toolUseResult: {}, cwd: '/Users/x/real-proj', timestamp: T(-470_000) }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'skill 注入' }, cwd: '/Users/x/real-proj', timestamp: T(-460_000) }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先查日志' }, { type: 'text', text: '403 来自上游' }], model: 'glm-5.3' }, cwd: '/Users/x/real-proj', timestamp: T(-400_000) }),
      '{"type":"user","mess', // 活跃会话尾部半截 JSON
    ].join('\n') + '\n');
    // sess2：全部行在窗口外
    fs.writeFileSync(path.join(projDir, 'sess2.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: '上周的对话' }, promptSource: 'typed', cwd: '/Users/x/real-proj', timestamp: T(-100 * 3600_000) }),
    ].join('\n') + '\n');
    // sess3：整文件坏行（容错跳过）
    fs.writeFileSync(path.join(projDir, 'sess3.jsonl'), 'not json at all\n{broken\n');

    process.env.CANNBOT_CC_DIR = path.join(tmp, 'cc-projects');
    const { listSessions } = await import(path.join(ROOT, 'lib/report/sources/claude-code.mjs') + '?t=' + Date.now());
    const sessions = await listSessions(WIN);
    check('claude-code: 恰 1 会话（窗口外/坏文件不产出）', sessions.length === 1, JSON.stringify(sessions.map((x) => x.sessionId)));
    const s = sessions[0];
    check('claude-code: project 取行内 cwd（不用有损目录名）', s?.project === '/Users/x/real-proj' && s?.source === 'claude-code', JSON.stringify(s?.project));
    check('claude-code: 标题取 ai-title', s?.title === '网关排障', JSON.stringify(s?.title));
    const texts = (s?.messages ?? []).map((m) => `${m.role}:${m.text}`).join(' | ');
    check('claude-code: 真人输入与 assistant 正文在素材里', texts.includes('user:帮我看下 403') && texts.includes('assistant:403 来自上游'), texts);
    check('claude-code: 斜杠命令回显被排除', !texts.includes('/model'), texts);
    check('claude-code: tool_result 被排除', !texts.includes('ok'), texts);
    check('claude-code: isMeta 注入被排除', !texts.includes('skill'), texts);
    check('claude-code: thinking 被排除', !texts.includes('先查日志'), texts);
    check('claude-code: 消息时间均在窗口内', s?.messages?.every((m) => m.time >= WIN.startMs && m.time < WIN.endMs));

    process.env.CANNBOT_CC_DIR = path.join(tmp, 'no-such-cc-dir');
    let rejected = false;
    try { await listSessions(WIN); } catch { rejected = true; }
    check('claude-code: 根目录不存在 → reject', rejected);
    process.env.CANNBOT_CC_DIR = path.join(tmp, 'cc-projects');
  }

  console.log('— 报告源：Cursor（agent-transcripts 适配器，fixture） —');
  {
    const NOW = Date.now();
    const WIN = { startMs: NOW - 3600_000, endMs: NOW + 3600_000 };
    const U1 = '11111111-2222-3333-4444-555555555555';
    const U2 = 'aaaa1111-bbbb-2222-cccc-333333333333';
    const U3 = 'bbbb2222-cccc-3333-dddd-444444444444';
    const dir1 = path.join(tmp, 'cursor-projects', 'Users-x-proj', 'agent-transcripts', U1);
    fs.mkdirSync(dir1, { recursive: true });
    // 标签固定标注 (UTC+8)：墙上分量必须按 UTC+8 墙上时钟生成（对本机时区无关——
    // 用本地分量拼 +8 标注在任何 TZ≠+8 的环境都会解析偏移、锚点掉出窗口）
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const wallClock = (epochMs) => {
      const d = new Date(epochMs);
      let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
      return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ap}`;
    };
    const tag = (offsetMs) => `<timestamp>${wallClock(NOW + offsetMs + 8 * 3600_000)} (UTC+8)</timestamp>`;
    // 指定时区标注的标签（墙上时钟 = 真实 epoch + 偏移）：覆盖负偏移与半时区解析分支
    const zoneTag = (epochMs, zone) => {
      const sign = zone.startsWith('-') ? -1 : 1;
      const [hh, mm] = zone.replace(/^[+-]/, '').split(':');
      const off = sign * (Number(hh) * 3600_000 + Number(mm ?? 0) * 60_000);
      return `<timestamp>${wallClock(epochMs + off)} (UTC${zone})</timestamp>`;
    };
    const line = (role, text) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
    // 会话 1：窗口外标签行 + 窗口内标签锚点行 + 无标签行；subagents 平行目录
    fs.writeFileSync(path.join(dir1, `${U1}.jsonl`), [
      line('user', `${tag(-100 * 3600_000)}\n<user_query>\n上周的问题\n</user_query>`),
      line('assistant', '上周的答复'),
      line('user', `${tag(-500_000)}\n<user_query>\n修复登录超时\n</user_query>`),
      line('assistant', '已修复并补了测试'),
      line('user', '补充：也检查下注册'),
      line('assistant', '注册流程也修了'),
    ].join('\n') + '\n');
    // 子代理记录：必须排除
    fs.mkdirSync(path.join(dir1, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir1, 'subagents', 'agent-1.jsonl'), line('assistant', '子代理探索内容'));
    // 会话 2：无任何窗口内标签（mtime 在窗口内 → tailOnly 整会话保留）
    const dir2 = path.join(tmp, 'cursor-projects', 'Users-x-proj', 'agent-transcripts', U2);
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, `${U2}.jsonl`), [
      line('user', `${tag(-100 * 3600_000)}\n<user_query>\n历史标签会话\n</user_query>`),
      line('assistant', '历史答复'),
      line('assistant', '无标签的新近内容'),
    ].join('\n') + '\n');
    // 空 transcript 目录（0 个 uuid.jsonl）
    const dir3 = path.join(tmp, 'cursor-projects', 'Users-x-proj', 'agent-transcripts', 'empty-transcript');
    fs.mkdirSync(dir3, { recursive: true });
    // 时区算术会话：(UTC-5) 负偏移与 (UTC+5:30) 半时区标注，断言解析回精确 epoch。
    // 标签格式只有分钟精度：期望值先取整到分钟，往返才能严格相等。
    // 被测标签时间放窗口外：锚点=最后一条「窗口内」标签（首行 +8），锚点后全保留，
    // 行时间沿用各自标签时间——解析正确性与窗口过滤解耦验证。
    const floorMin = (ms) => Math.floor(ms / 60_000) * 60_000;
    const T_NEG = floorMin(NOW - 7200_000);
    const T_HALF = floorMin(NOW - 7100_000);
    const dir4 = path.join(tmp, 'cursor-projects', 'Users-x-proj', 'agent-transcripts', U3);
    fs.mkdirSync(dir4, { recursive: true });
    fs.writeFileSync(path.join(dir4, `${U3}.jsonl`), [
      line('user', `${tag(-430_000)}\n<user_query>\n时区算术会话\n</user_query>`),
      line('user', `${zoneTag(T_NEG, '-5')}\n<user_query>\n负偏移时区消息\n</user_query>`),
      line('user', `${zoneTag(T_HALF, '+5:30')}\n<user_query>\n半时区消息\n</user_query>`),
    ].join('\n') + '\n');

    process.env.CANNBOT_CURSOR_DIR = path.join(tmp, 'cursor-projects');
    const { listSessions } = await import(path.join(ROOT, 'lib/report/sources/cursor.mjs') + '?t=' + Date.now());
    const sessions = await listSessions(WIN);
    check('cursor: 产出 3 会话（空目录不产出）', sessions.length === 3, JSON.stringify(sessions.map((x) => x.sessionId)));
    const s1 = sessions.find((x) => x.sessionId === U1);
    const s2 = sessions.find((x) => x.sessionId === U2);
    check('cursor: 项目路径由目录名还原', s1?.project === '/Users/x/proj' && s1?.source === 'cursor', JSON.stringify(s1?.project));
    const texts1 = (s1?.messages ?? []).map((m) => `${m.role}:${m.text}`).join(' | ');
    check('cursor: 从窗口内锚点行开始（窗口外 user/assistant 不在）', !texts1.includes('上周的问题') && !texts1.includes('上周的答复') && texts1.includes('修复登录超时') && texts1.includes('已修复并补了测试'), texts1);
    check('cursor: 锚点后的无标签行保留', texts1.includes('补充：也检查下注册') && texts1.includes('注册流程也修了'), texts1);
    check('cursor: 无标签 assistant 沿用锚点时间', (() => {
      const anchor = s1?.messages?.find((m) => m.role === 'user' && m.text.includes('修复登录超时'));
      const asst = s1?.messages?.find((m) => m.role === 'assistant' && m.text.includes('已修复并补了测试'));
      return anchor && asst && asst.time === anchor.time;
    })(), JSON.stringify(s1?.messages?.map((m) => [m.role, m.time])));
    check('cursor: subagents 内容被排除', !JSON.stringify(sessions).includes('子代理探索内容'));
    check('cursor: 无窗口内标签 → tailOnly 整会话', s2?.tailOnly === true && s2?.messages?.some((m) => m.text.includes('历史标签会话')) && s2?.messages?.some((m) => m.text.includes('无标签的新近内容')), JSON.stringify(s2 && { tailOnly: s2.tailOnly, n: s2.messages.length }));
    check('cursor: 时间戳标签不留在正文里', !JSON.stringify(sessions).includes('<timestamp>'));
    const s3 = sessions.find((x) => x.sessionId === U3);
    check('cursor: (UTC-5) 负偏移标签解析回精确 epoch', s3?.messages?.find((m) => m.text.includes('负偏移时区消息'))?.time === T_NEG, JSON.stringify(s3?.messages?.map((m) => [m.text.slice(0, 10), m.time])));
    check('cursor: (UTC+5:30) 半时区标签解析回精确 epoch', s3?.messages?.find((m) => m.text.includes('半时区消息'))?.time === T_HALF);

    process.env.CANNBOT_CURSOR_DIR = path.join(tmp, 'no-such-cursor-dir');
    let rejected = false;
    try { await listSessions(WIN); } catch { rejected = true; }
    check('cursor: 根目录不存在 → reject', rejected);
    process.env.CANNBOT_CURSOR_DIR = path.join(tmp, 'cursor-projects');
  }

  console.log('— 报告素材收集（collectMaterials：归并/压缩/脱敏/佐证） —');
  {
    const NOW = Date.now();
    const WIN = { startMs: NOW - 3600_000, endMs: NOW + 3600_000 };
    const T = (offsetMs) => new Date(NOW + offsetMs).toISOString();
    const projDir = path.join(tmp, 'cc-projects', '-Users-x-dirname-lossy---');
    // 密钥脱敏 + 超长截断 fixture（cwd 与 Task 5 相同 → 同项目 real-proj）
    fs.writeFileSync(path.join(projDir, 'sess-secret.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: '排查泄漏，测试密钥是 sk-abcdefghijklmnop123 不要外传' }, promptSource: 'typed', cwd: '/Users/x/real-proj', timestamp: T(-300_000) }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projDir, 'sess-long.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: '压'.repeat(2000) }, promptSource: 'typed', cwd: '/Users/x/real-proj', timestamp: T(-200_000) }),
    ].join('\n') + '\n');
    // emoji（astral 平面）：600 码位 > 500 上限必截断——UTF-16 回归会劈开代理对产生乱码
    fs.writeFileSync(path.join(projDir, 'sess-emoji.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: '😀'.repeat(600) }, promptSource: 'typed', cwd: '/Users/x/real-proj', timestamp: T(-150_000) }),
    ].join('\n') + '\n');

    // todos 联动：经 HTTP 建两条（gateway 写穿落盘），一条完成
    const ta = await (await post('/v1/todos', { title: 'collect 测试 A' })).json();
    await post('/v1/todos', { title: 'collect 测试 B' });
    await fetch(`${GW}/v1/todos/${ta.todo.id}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ status: 'done' }) });
    // 子项联动：建带清单的待办并勾 1/2 —— 报告待办行应带（1/2）进度
    const tc = (await (await post('/v1/todos', { title: 'collect 测试 C（清单）', items: [{ title: '甲' }, { title: '乙' }] })).json());
    await fetch(`${GW}/v1/todos/${tc.todo.id}/items/${tc.todo.items[0].id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ done: true }) });

    // usage 联动：进程内 stats 读独立 fixture 文件（今天的桶，数值完全可控）
    const p2 = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const statsUsageFile = path.join(tmp, 'stats-usage.json');
    fs.writeFileSync(statsUsageFile, JSON.stringify({
      version: 2,
      days: { [todayKey]: {
        total: { req: 10, err: 0, tin: 1000, tout: 2000, bin: 0, bout: 0, ms: 0, cost: 0.5 },
        providers: { 'mock-oai': { models: { 'mock-pro': { req: 10, err: 0, tin: 1000, tout: 2000, bin: 0, bout: 0, ms: 0, cost: 0.5 } } } },
        hours: [],
      } },
    }));
    process.env.CANNBOT_STATS_FILE = statsUsageFile;
    process.env.CANNBOT_TODOS_FILE = path.join(tmp, 'todos.json'); // 读 gateway 写穿的最新状态
    process.env.CANNBOT_ZCODE_DB = path.join(tmp, 'no-such.db'); // 失败源降级路径
    process.env.CANNBOT_OPENCODE_DB = path.join(tmp, 'no-such.db');
    const { collectMaterials } = await import(path.join(ROOT, 'lib/report/collect.mjs') + '?t=' + Date.now());
    const m = await collectMaterials(WIN);
    const projNames = m.projects.map((p) => p.name);
    check('collect: 双源归并出项目（real-proj / proj）', projNames.includes('real-proj') && projNames.includes('proj'), JSON.stringify(projNames));
    check('collect: 失败源降级并记原因（zcode/opencode）', m.sourcesFailed.length === 2 && m.sourcesFailed.join(';').includes('zcode') && m.sourcesFailed.join(';').includes('opencode'), JSON.stringify(m.sourcesFailed));
    check('collect: sources 计数正确', m.sources['claude-code'] === 4 && m.sources.cursor === 3 && m.sources.zcode === 0 && m.sources.opencode === 0, JSON.stringify(m.sources));
    const realProj = m.projects.find((p) => p.name === 'real-proj');
    check('collect: 素材总字符数 > 0', m.chars > 0, String(m.chars));
    check('collect: 密钥脱敏（sk- → [REDACTED]）', realProj?.summaryText.includes('[REDACTED]') && !realProj.summaryText.includes('sk-abcdefghijklmnop123'), realProj?.summaryText.slice(0, 120));
    check('collect: 超长真人输入截到 500 字（码位）', realProj?.summaryText.includes('压'.repeat(500)) && !realProj.summaryText.includes('压'.repeat(501)));
    check('collect: emoji 码位截断不劈代理对（剥合法对后无孤立代理）', !/[\uD800-\uDFFF]/.test(realProj?.summaryText?.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '') ?? '\uD800'));
    check('collect: todos 联动（窗口内新增/完成）', m.todos.created.some((t) => t.title === 'collect 测试 A') && m.todos.created.some((t) => t.title === 'collect 测试 B') && m.todos.completed.some((t) => t.title === 'collect 测试 A'), JSON.stringify({ c: m.todos.created.length, d: m.todos.completed.length }));
    check('collect: usage 聚合（请求数/ tokens/费用/分订阅）', m.usage.totalRequests === 10 && m.usage.totalTokens === 3000 && Math.abs(m.usage.totalCost - 0.5) < 1e-9 && m.usage.byProvider['mock-oai']?.requests === 10, JSON.stringify(m.usage));
    const old = await collectMaterials({ startMs: 0, endMs: 1000 });
    check('collect: 窗口早于统计保留期 → outOfRange', old.usage.outOfRange === true && old.usage.totalRequests === 0, JSON.stringify(old.usage));
    check('collect: 1970 窗口无会话素材但流程完整', old.projects.length === 0 && old.sources['claude-code'] === 0, JSON.stringify({ p: old.projects.length, s: old.sources }));
  }

  console.log('— 报告生成（/admin/report/*：生成/轮询/存档/防护） —');
  {
    const WIN = { startMs: Date.now() - 3600_000, endMs: Date.now() + 3600_000 };

    // userFinal 单元：待办行进 prompt 的形态（纯函数直测，不起 HTTP）
    {
      const { PROMPTS, LIMITS } = await import(path.join(ROOT, 'lib/report-prompts.mjs') + '?t=' + Date.now());
      const many = Array.from({ length: 40 }, (_, i) => ({ title: `待办${i}`, urgency: 'normal' }));
      const out = PROMPTS.userFinal({ rangeText: 'x', projects: [], todos: { created: many, completed: [] }, usage: {}, sourcesFailed: [] });
      check('userFinal：待办每列表最多 30 条、超出加「等 N 条」', out.includes('新增（40）') && out.includes('等 10 条') && !out.includes('待办39'), out.slice(out.indexOf('新增（'), out.indexOf('新增（') + 80));
      const long = { title: '标'.repeat(60), urgency: 'normal' };
      const out2 = PROMPTS.userFinal({ rangeText: 'x', projects: [], todos: { created: [long], completed: [] }, usage: {}, sourcesFailed: [] });
      check(`userFinal：待办标题截 ${LIMITS.todoTitleChars} 码位`, out2.includes('标'.repeat(LIMITS.todoTitleChars)) && !out2.includes('标'.repeat(LIMITS.todoTitleChars + 1)), '');
      const withItems = { title: '清单单', urgency: 'normal', items: [{ done: true }, { done: false }, { done: false }] };
      const out3 = PROMPTS.userFinal({ rangeText: 'x', projects: [], todos: { created: [withItems], completed: [] }, usage: {}, sourcesFailed: [] });
      check('userFinal：新增行带子项进度（k/j）', out3.includes('清单单（1/3）'), out3.slice(out3.indexOf('新增（'), out3.indexOf('新增（') + 60));
      const allDone = { title: '已完成单', urgency: 'normal', items: [{ done: true }, { done: true }] };
      const out4 = PROMPTS.userFinal({ rangeText: 'x', projects: [], todos: { created: [], completed: [allDone] }, usage: {}, sourcesFailed: [] });
      check('userFinal：完成行不缀子项进度（必为 j/j）', out4.includes('已完成单') && !out4.includes('已完成单（2/2）'), '');
    }

    const cfgPath = path.join(tmp, 'providers.json');
    const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const writeCfg = (c) => fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
    const waitJob = async (wantState) => {
      for (let i = 0; i < 60; i++) {
        const j = await (await fetch(`${GW}/admin/report/job`)).json();
        if (j.state === wantState) return j;
        if (j.state !== 'running') return j;
        await sleep(500);
      }
      return { state: 'timeout' };
    };

    // 场景 A：workbench 指向 mock-oai → 生成 → ECHO 回显素材
    const g1 = await post('/admin/report/generate', WIN);
    const g1J = await g1.json();
    check('POST generate → 200 且返回 jobId', g1.status === 200 && typeof g1J.jobId === 'string', JSON.stringify(g1J));
    const again = await post('/admin/report/generate', WIN);
    check('生成中再 POST → 409（单任务串行）', again.status === 409, `got ${again.status}`);
    const done = await waitJob('done');
    check('轮询 job → done（途经 collect→summarize→final）', done.state === 'done' && typeof done.reportId === 'string', JSON.stringify(done).slice(0, 200));
    const rep = await (await fetch(`${GW}/admin/report/${done.reportId}`)).json();
    check('报告正文含 ECHO（素材经两级总结到 mock 上游）', typeof rep.report === 'string' && rep.report.includes('ECHO:'), String(rep.report).slice(0, 120));
    check('报告元数据（时间窗/模型/素材统计）', rep.range?.start === WIN.startMs && rep.model === 'mock-pro' && rep.provider === 'mock-oai' && rep.materials?.sources?.['claude-code'] === 4 && rep.materials?.sources?.cursor === 3, JSON.stringify(rep.materials));
    check('失败源如实记录在素材统计', rep.materials?.sourcesFailed?.length === 2, JSON.stringify(rep.materials?.sourcesFailed));
    check('失败源进报告正文（数据源状态附注）', rep.report.includes('数据源状态') && rep.report.includes('zcode'), String(rep.report).slice(0, 300));
    check('待办联动进 prompt（报告含 collect 测试 A）', rep.report.includes('collect 测试 A'), String(rep.report).slice(0, 200));
    check('待办子项进度进 prompt（报告含（1/2））', rep.report.includes('（1/2）'), String(rep.report).slice(0, 300));
    check('报告素材计数 materials.todos（新增 ≥3 / 完成 ≥1）', (rep.materials?.todos?.created ?? 0) >= 3 && (rep.materials?.todos?.completed ?? 0) >= 1, JSON.stringify(rep.materials?.todos));

    // 空素材窗口：不调模型直接成稿（model=none、不再 failed）。
    // 主网关 zcode/opencode 指向 no-such.db（采集必失败）→ 空窗走「采集失败」口径，
    // 不把采集故障伪装成「无记录」
    const emptyWin = { startMs: Date.now() + 5 * 24 * 3600_000, endMs: Date.now() + 5 * 24 * 3600_000 + 3600_000 };
    check('空素材+源失败：POST → 200', (await post('/admin/report/generate', emptyWin)).status === 200);
    const emptyDone = await waitJob('done');
    const emptyRep = await (await fetch(`${GW}/admin/report/${emptyDone.reportId}`)).json();
    check('空素材+源失败：done 且未调模型（model=none）', emptyDone.state === 'done' && emptyRep.model === 'none' && emptyRep.provider === 'none', JSON.stringify({ s: emptyDone.state, m: emptyRep.model }));
    check('空素材+源失败：文案明确采集失败、结论不可信（不写「无记录」）', emptyRep.report.includes('素材采集失败') && emptyRep.report.includes('不可作为汇报依据') && !emptyRep.report.includes('未检索到可用的工作记录') && emptyRep.materials?.sourcesFailed?.length === 2, String(emptyRep.report).slice(0, 160));

    // 上游失败文案三口径（连接失败 / HTTP 非 2xx / 超时）：有素材窗口 + 断上游 → job failed 文案分口径
    const cfg0 = readCfg();
    const failWith = async (mut) => {
      const d = structuredClone(cfg0);
      mut(d);
      writeCfg(d);
      await sleep(600); // mtime 热加载
      await post('/admin/report/generate', WIN);
      return await waitJob('failed');
    };
    let fj = await failWith((d) => {
      const p = d.providers.find((x) => x.id === 'mock-oai');
      p.baseUrl = 'http://127.0.0.1:1/dead';
      p.models = { source: 'static', list: [{ id: 'mock-pro' }] }; // 静态目录：模型解析不联网，失败点落在上游调用
    });
    check('失败口径：连接失败（含 cause、无英文 aborted）', (fj.error || '').startsWith('上游 mock-oai 连接失败（') && !/aborted/i.test(fj.error || ''), fj.error);
    fj = await failWith((d) => {
      const p = d.providers.find((x) => x.id === 'mock-oai');
      p.models = { source: 'static', list: [{ id: 'mock-pro' }, { id: 'mock-500' }] };
      d.workbench.reportModel = 'mock-500'; // mock 上游对该 model 回 500
    });
    check('失败口径：HTTP 非 2xx（返回 HTTP <状态码>）', /上游 mock-oai 返回 HTTP 500/.test(fj.error || ''), fj.error);
    // 超时口径：requestUpstream 的 AbortError 在 callSummaryModel 换成中文——源码层断言（跑一次 120s 超时太慢）
    const genSrc = fs.readFileSync(path.join(ROOT, 'lib/report/generate.mjs'), 'utf8');
    check('失败口径：超时中文文案（请求超时（Ns））', genSrc.includes('请求超时（') && genSrc.includes('AbortError'));
    // 配错 reportProvider：失败文案应指出「配的不存在」，而不是误导用户去配置
    fj = await failWith((d) => { d.workbench = { reportProvider: '不存在-x' }; });
    check('配错 reportProvider：失败文案点名不存在的 provider', /reportProvider.*不存在-x.*不存在/.test(fj.error || ''), fj.error);
    writeCfg(cfg0); // 还原配置
    await sleep(600);

    // 总结重试（两级同纪律）：mock 上游模拟 kimi 式偶发空响应（mock-empty-* 见 mock-upstream.mjs）
    {
      const genWithModel = async (model) => {
        const d = structuredClone(cfg0);
        const p = d.providers.find((x) => x.id === 'mock-oai');
        p.models = { source: 'static', list: [{ id: model }] }; // 静态目录：模型解析不联网
        d.workbench = { reportProvider: 'mock-oai', reportModel: model };
        writeCfg(d);
        await sleep(600);
        await post('/admin/report/generate', WIN);
        return await waitJob();
      };
      const r1 = await genWithModel('mock-empty-final-once');
      const rep1 = r1.state === 'done' ? await (await fetch(`${GW}/admin/report/${r1.reportId}`)).json() : {};
      check('二级首次空响应 → 重试一次后 done 且成稿正常', r1.state === 'done' && (rep1.report ?? '').includes('ECHO:'), JSON.stringify({ s: r1.state, e: r1.error }));
      const r2 = await genWithModel('mock-empty-final');
      check('二级两次都空 → failed 且文案点名响应无文本内容', r2.state === 'failed' && /上游 mock-oai 响应无文本内容/.test(r2.error || ''), JSON.stringify({ s: r2.state, e: r2.error }));
      const r3 = await genWithModel('mock-empty-project-once');
      const rep3 = r3.state === 'done' ? await (await fetch(`${GW}/admin/report/${r3.reportId}`)).json() : {};
      check('一级首次空响应 → 重试一次后 done（一级同样视空为失败）', r3.state === 'done' && (rep3.report ?? '').includes('ECHO:'), JSON.stringify({ s: r3.state, e: r3.error }));
      writeCfg(cfg0); // 还原配置
      await sleep(600);
    }

    // 四源全部采集成功但该窗口无会话 → 走「无记录」固定成稿（另起实例指到 fixture 库，未来窗口 0 会话）
    {
      const gwEmpty = spawnNode([path.join(ROOT, 'server.mjs')], {
        CANNBOT_PROXY_PORT: '6293',
        CANNBOT_CONFIG_FILE: path.join(tmp, 'providers.json'),
        CANNBOT_LOG_FILE: path.join(tmp, 'proxy5.log'),
        CANNBOT_STATS_FILE: path.join(tmp, 'stats5.json'),
        CANNBOT_TODOS_FILE: path.join(tmp, 'todos.json'),
        CANNBOT_REPORTS_FILE: path.join(tmp, 'reports5.json'),
        CANNBOT_CC_DIR: path.join(tmp, 'cc-projects'),
        CANNBOT_ZCODE_DB: path.join(tmp, 'zcode-fixture.db'),
        CANNBOT_OPENCODE_DB: path.join(tmp, 'opencode-fixture.db'),
        CANNBOT_CURSOR_DIR: path.join(tmp, 'cursor-projects'),
      }, 'gateway-empty-clean');
      await sleep(1200);
      const GW3 = 'http://127.0.0.1:6293';
      await (await fetch(`${GW3}/admin/report/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(emptyWin) })).json();
      let cleanDone = { state: 'timeout' };
      for (let i = 0; i < 20; i++) {
        cleanDone = await (await fetch(`${GW3}/admin/report/job`)).json();
        if (cleanDone.state !== 'running') break;
        await sleep(500);
      }
      const cleanRep = await (await fetch(`${GW3}/admin/report/${cleanDone.reportId}`)).json();
      check('空素材四源正常：done 且 model=none', cleanDone.state === 'done' && cleanRep.model === 'none', JSON.stringify({ s: cleanDone.state }));
      check('空素材四源正常：固定「无记录」文案、sourcesFailed 空', cleanRep.report.includes('未检索到可用的工作记录') && cleanRep.materials?.sourcesFailed?.length === 0, String(cleanRep.report).slice(0, 120));
      gwEmpty.kill();
    }

    // 仅待办窗口：四源全部失败但窗口内有待办变动 → 不再走「无记录/采集失败」固定
    // 快径，照常调模型出稿（待办是第一等素材；失败源如实进「数据源状态」附注）
    {
      const gwTodoOnly = spawnNode([path.join(ROOT, 'server.mjs')], {
        CANNBOT_PROXY_PORT: '6296',
        CANNBOT_CONFIG_FILE: path.join(tmp, 'providers.json'),
        CANNBOT_LOG_FILE: path.join(tmp, 'proxy6.log'),
        CANNBOT_STATS_FILE: path.join(tmp, 'stats6.json'),
        CANNBOT_TODOS_FILE: path.join(tmp, 'todos-only.json'),
        CANNBOT_REPORTS_FILE: path.join(tmp, 'reports6.json'),
        CANNBOT_CC_DIR: path.join(tmp, 'no-such-cc'),
        CANNBOT_ZCODE_DB: path.join(tmp, 'no-such.db'),
        CANNBOT_OPENCODE_DB: path.join(tmp, 'no-such.db'),
        CANNBOT_CURSOR_DIR: path.join(tmp, 'no-such-cursor'),
        CANNBOT_REPORT_RETRY_DELAY_MS: '0',
      }, 'gateway-todos-only');
      await sleep(1500);
      const GW6 = 'http://127.0.0.1:6296';
      await fetch(`${GW6}/v1/todos`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ title: '仅待办窗口的单子' }) });
      await fetch(`${GW6}/admin/report/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(WIN) });
      let tJob = { state: 'timeout' };
      for (let i = 0; i < 40; i++) {
        tJob = await (await fetch(`${GW6}/admin/report/job`)).json();
        if (tJob.state !== 'running') break;
        await sleep(500);
      }
      const tRep = tJob.reportId ? await (await fetch(`${GW6}/admin/report/${tJob.reportId}`)).json() : {};
      check('仅待办窗口：done 且走了模型（model ≠ none）', tJob.state === 'done' && tRep.model === 'mock-pro', JSON.stringify({ s: tJob.state, m: tRep.model, e: tJob.error }));
      check('仅待办窗口：报告含待办标题与「数据源状态」附注', (tRep.report || '').includes('仅待办窗口的单子') && (tRep.report || '').includes('数据源状态'), String(tRep.report).slice(0, 200));
      check('仅待办窗口：materials.todos 计数（新增 1）', tRep.materials?.todos?.created === 1, JSON.stringify(tRep.materials?.todos));
      gwTodoOnly.kill();
    }

    // 窗口校验（不启动 job）
    check('end<=start → 400', (await post('/admin/report/generate', { startMs: 100, endMs: 100 })).status === 400);
    check('早于 2000 年（与前端 isBadReportRange 同口径）→ 400', (await post('/admin/report/generate', { startMs: 1, endMs: 7200_000 })).status === 400);
    check('跨度超 92 天 → 400', (await post('/admin/report/generate', { startMs: 0, endMs: 100 * 24 * 3600_000 })).status === 400);
    check('非数字时间 → 400', (await post('/admin/report/generate', { startMs: 'abc', endMs: 5 })).status === 400);

    // 防护矩阵（照抄 monitors/providers 模式）
    const r403 = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: GW_PORT, path: '/admin/report/generate', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, resolve);
      rq.on('error', reject); rq.end('{}');
    });
    check('generate 非回环 Host → 403', r403.statusCode === 403);
    const r415 = await fetch(`${GW}/admin/report/generate`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    check('generate 非 JSON 内容类型 → 415', r415.status === 415);
    const r405 = await fetch(`${GW}/admin/report/generate`);
    check('generate 用 GET → 405', r405.status === 405);
    const list403 = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: GW_PORT, path: '/admin/report/list', headers: { host: 'evil.example' } }, resolve);
      rq.on('error', reject); rq.end();
    });
    check('list 非回环 Host → 403', list403.statusCode === 403);

    // 场景 B：workbench 指向不可达上游 → job failed 带可读错误、不悬挂
    {
      const cfg = readCfg();
      cfg.providers.push({ id: 'dead', name: 'Dead', baseUrl: 'http://127.0.0.1:59999/dead', protocol: 'openai', auth: { type: 'static-token', token: 'x' }, models: { source: 'static', list: [{ id: 'dead-model' }] } });
      cfg.workbench = { reportProvider: 'dead', reportModel: 'dead-model' };
      writeCfg(cfg);
      const g2 = await post('/admin/report/generate', WIN);
      check('dead 上游：POST 仍 200（异步失败）', g2.status === 200);
      const failed = await waitJob('failed');
      check('dead 上游 → failed 且 error 含上游信息', failed.state === 'failed' && (failed.error ?? '').length > 0, JSON.stringify(failed).slice(0, 200));
    }

    // 场景 C：无 workbench 节 → 兜底链（默认上游 + 目录第一个模型）仍出报告
    {
      const cfg = readCfg();
      cfg.providers = cfg.providers.filter((p) => p.id !== 'dead');
      delete cfg.workbench;
      writeCfg(cfg);
      const g3 = await post('/admin/report/generate', WIN);
      check('兜底链：POST 200', g3.status === 200);
      const done3 = await waitJob('done');
      check('兜底链 → done 且默认上游模型生效', done3.state === 'done', JSON.stringify(done3).slice(0, 200));
      const rep3 = await (await fetch(`${GW}/admin/report/${done3.reportId}`)).json();
      check('兜底链报告仍含 ECHO', rep3.report?.includes('ECHO:') === true && rep3.provider === 'mock-oai', JSON.stringify({ provider: rep3.provider, model: rep3.model }));
    }

    // 场景 C'：静态 list 的字符串条目形态（models 层一等公民）也走通兜底链
    {
      const cfg = readCfg();
      cfg.providers = [{ id: 'staticstr', name: 'StaticStr', baseUrl: `http://127.0.0.1:${MOCK_PORT}/oai`, protocol: 'openai', auth: { type: 'static-token', token: 'mock-token-oai' }, models: { source: 'static', list: ['mock-pro'] } }];
      cfg.routing.defaultProvider = 'staticstr';
      delete cfg.workbench;
      writeCfg(cfg);
      const g5 = await post('/admin/report/generate', WIN);
      check('字符串 list：POST 200', g5.status === 200);
      const d5 = await waitJob('done');
      check('字符串静态 list 兜底链解析出模型（job done 非上游 400）', d5.state === 'done', JSON.stringify(d5).slice(0, 200));
      const rep5 = await (await fetch(`${GW}/admin/report/${d5.reportId}`)).json();
      check('字符串 list：模型名取条目字符串', rep5.model === 'mock-pro', JSON.stringify({ model: rep5.model, provider: rep5.provider }));
      // 恢复配置供后续场景
      const back = readCfg();
      back.providers = [{ id: 'mock-oai', name: 'MockOAI', baseUrl: `http://127.0.0.1:${MOCK_PORT}/oai`, protocol: 'openai', auth: { type: 'static-token', token: 'mock-token-oai' }, models: { source: 'api' } }];
      back.routing.defaultProvider = 'mock-oai';
      writeCfg(back);
    }

    // 场景 F：defaultProvider 指向停用订阅 → 兜底链与代理路径同语义（跳过停用、回退首个已启用）
    {
      const cfg = readCfg();
      cfg.providers = [
        { id: 'disabled-dead', name: 'DisabledDead', baseUrl: 'http://127.0.0.1:59998/dead', protocol: 'openai', auth: { type: 'static-token', token: 'x' }, models: { source: 'static', list: [{ id: 'dead-model' }] }, enabled: false },
        { id: 'mock-oai', name: 'MockOAI', baseUrl: `http://127.0.0.1:${MOCK_PORT}/oai`, protocol: 'openai', auth: { type: 'static-token', token: 'mock-token-oai' }, models: { source: 'api' } },
      ];
      cfg.routing = { defaultProvider: 'disabled-dead' };
      delete cfg.workbench;
      writeCfg(cfg);
      const g6 = await post('/admin/report/generate', WIN);
      const d6 = await waitJob('done');
      check('停用订阅被兜底链跳过（回退已启用上游出稿）', d6.state === 'done', JSON.stringify(d6).slice(0, 200));
      const rep6 = await (await fetch(`${GW}/admin/report/${d6.reportId}`)).json();
      check('兜底选中已启用 provider', rep6.provider === 'mock-oai', JSON.stringify({ provider: rep6.provider }));
      // 恢复
      const back6 = readCfg();
      back6.providers = [back6.providers.find((p) => p.id === 'mock-oai')];
      back6.routing = { defaultProvider: 'mock-oai' };
      writeCfg(back6);
    }

    // 场景 G：报告落盘失败（目录只读）→ job failed 且历史列表不出现幽灵报告（内存回滚）
    {
      const roDir = path.join(tmp, 'ro-reports');
      fs.mkdirSync(roDir, { recursive: true });
      const gwRo = spawnNode([path.join(ROOT, 'server.mjs')], {
        CANNBOT_PROXY_PORT: '6295',
        CANNBOT_CONFIG_FILE: path.join(tmp, 'providers.json'),
        CANNBOT_LOG_FILE: path.join(tmp, 'proxy5.log'),
        CANNBOT_STATS_FILE: path.join(tmp, 'stats5.json'),
        CANNBOT_TODOS_FILE: path.join(tmp, 'todos.json'),
        CANNBOT_REPORTS_FILE: path.join(roDir, 'reports.json'),
        CANNBOT_CC_DIR: path.join(tmp, 'cc-projects'),
        CANNBOT_ZCODE_DB: path.join(tmp, 'no-such.db'),
        CANNBOT_OPENCODE_DB: path.join(tmp, 'no-such.db'),
        CANNBOT_CURSOR_DIR: path.join(tmp, 'cursor-projects'),
      }, 'gateway-ro-reports');
      await sleep(1500);
      fs.chmodSync(roDir, 0o500); // 目录只读：persistReports 的 tmp 写入必失败
      await fetch('http://127.0.0.1:6295/admin/report/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(WIN),
      });
      let roJob = { state: 'timeout' };
      for (let i = 0; i < 60; i++) {
        roJob = await (await fetch('http://127.0.0.1:6295/admin/report/job')).json();
        if (roJob.state !== 'running') break;
        await sleep(500);
      }
      const roList = await (await fetch('http://127.0.0.1:6295/admin/report/list')).json();
      check('落盘失败 → job failed 且错误可读（EACCES）', roJob.state === 'failed' && /EACCES|permission/i.test(roJob.error ?? ''), JSON.stringify(roJob).slice(0, 200));
      check('落盘失败 → 历史列表无幽灵报告（内存回滚）', (roList.reports ?? []).length === 0, JSON.stringify(roList));
      fs.chmodSync(roDir, 0o755);
      gwRo.kill();
    }

    // 场景 D：workbench 指向不存在的 provider → failed 且 error 指引配置
    {
      writeCfg({ ...readCfg(), workbench: { reportProvider: 'ghost' } });
      await post('/admin/report/generate', WIN);
      await sleep(800);
      const f4 = await (await fetch(`${GW}/admin/report/job`)).json();
      check('模型解析失败 → failed 且 error 指引 workbench 配置', f4.state === 'failed' && (f4.error ?? '').includes('workbench'), JSON.stringify(f4).slice(0, 200));
      writeCfg({ ...readCfg(), workbench: { reportProvider: 'mock-oai', reportModel: 'mock-pro' } }); // 恢复
    }

    // 历史报告：list（无正文）/ 删除 / 404
    const list = await (await fetch(`${GW}/admin/report/list`)).json();
    check('list 返回 7 份元数据且不含正文（场景 A/空素材/C/C′/F + 重试演练成功 2 份）', list.reports?.length === 7 && list.reports.every((r) => typeof r.report !== 'string'), JSON.stringify(list.reports?.map((r) => r.id)));
    const del = await fetch(`${GW}/admin/report/${done.reportId}`, { method: 'DELETE' });
    check('DELETE 报告 → 204', del.status === 204, `got ${del.status}`);
    const gone = await fetch(`${GW}/admin/report/${done.reportId}`);
    check('删后 GET → 404', gone.status === 404);
    const list2 = await (await fetch(`${GW}/admin/report/list`)).json();
    check('删除后 list 剩 6 份（场景 空素材/C/C′/F 各一 + 重试演练成功 2 份）', list2.reports?.length === 6, JSON.stringify(list2.reports?.length));
    check('GET 不存在的报告 → 404', (await fetch(`${GW}/admin/report/nope`)).status === 404);
    // 默认存档路径：必须在服务根目录（lib/report/ 少算一层 dirname 会落 lib/ 子目录，
    // 且 install.sh 的 cp -R lib/. 会用调试存档覆盖运行时真实报告——见审查修复）
    {
      const savedReports = process.env.CANNBOT_REPORTS_FILE;
      delete process.env.CANNBOT_REPORTS_FILE;
      const { REPORTS_FILE } = await import(path.join(ROOT, 'lib/report/generate.mjs') + '?path=' + Date.now());
      if (savedReports != null) process.env.CANNBOT_REPORTS_FILE = savedReports;
      check('reports.json 默认路径在服务根目录（非 lib/ 子目录）', path.dirname(REPORTS_FILE) === ROOT, REPORTS_FILE);
    }
  }

  console.log('— 工作台静态资源（/workbench、/theme.css、页面外链改造） —');
  {
    const themeCss = await fetch(`${GW}/theme.css`);
    const themeCssText = await themeCss.text();
    check('/theme.css → 200 且 text/css', themeCss.status === 200 && (themeCss.headers.get('content-type') || '').includes('text/css'));
    const idxHtml = await (await fetch(`${GW}/`)).text();
    check('index.html 引用 /theme.css', idxHtml.includes('<link rel="stylesheet" href="/theme.css">'), '未找到 link 标签');
    const css = await fetch(`${GW}/workbench.css`);
    const cssText = await css.text();
    check('/workbench.css → 200 且 text/css（旧页面缓存兼容）', css.status === 200 && (css.headers.get('content-type') || '').includes('text/css'));
    check('workbench.css 含主题令牌与骨架', cssText.includes('--bg') && cssText.includes('.frame') && cssText.includes('.viewbtn'), cssText.slice(0, 80));
    check('index.html 外链共享样式', idxHtml.includes('<link rel="stylesheet" href="/theme.css">'), '未找到 link 标签');
    check('index.html 通用样式已移出（body 底纹不再内嵌）', !idxHtml.includes('body::before'), 'body::before 仍内嵌');
    check('index.html 视图专属样式保留（趋势图/性能表）', idxHtml.includes('.chartwrap') && idxHtml.includes('.tbl.perf'));
    // 合并后左栏不再是「跳页到工作台」，而是六个同页视图（Task 4 再分组）
    check('左栏六个视图项（不再靠跳页切换）',
      ['todos', 'report', 'overview', 'traffic', 'test', 'providers']
        .every((v) => idxHtml.includes(`data-view="${v}"`)));
    // -- 左栏瘦身：塞不下的功能搬进主区（竖排的另一个来源） --
    check('左栏不再有横向按钮组与协议串',
      !idxHtml.includes('id="railMonBtns"') && !idxHtml.includes('id="monRailMsg"') && !idxHtml.includes('class="rail-proto"'));
    check('整机同切搬到总览页', idxHtml.includes('id="monWholeRow"'));
    // 必须落在 providers 视图内部：从 <section class="view" data-view="providers"> 到下一个
    // view/main 边界之间（导航栏里的 data-view="providers" 是按钮，不能算数）
    const provViewHtml = /<section class="view"[^>]*data-view="providers">([\s\S]*?)(?=<section class="view"|<\/main>)/.exec(idxHtml)?.[1] ?? '';
    check('重启/停止搬到配置页', provViewHtml.includes('id="btnRestart"') && provViewHtml.includes('id="btnStop"'),
      provViewHtml.length ? `providers 视图 ${provViewHtml.length} 字符` : '未找到 providers 视图');
    check('skip link 已移除（汇报为独立视图）', !idxHtml.includes('class="skip"'));
    // 截断必须仍可辨识：显示器/输入源名由用户自填，按钮被省略号截断时要留 title 全文
    check('整机同切按钮带 title 全文（省略号截断后可辨识）',
      /data-mminput[\s\S]{0,240}title=/.test(idxHtml));
    // -- 左栏两级导航 + 竖排修复 --
    check('左栏两级：两个组头 + 六个子项', (idxHtml.match(/class="navgroup"/g) || []).length === 2
      && ['todos', 'report', 'overview', 'traffic', 'test', 'providers'].every((v) => idxHtml.includes(`href="#${v}"`)));
    const navHrefs = [...idxHtml.matchAll(/<a class="viewbtn" href="#([a-z]+)"/g)].map((m) => m[1]);
    check('导航链接与视图双向一致（无孤儿）',
      navHrefs.length === 6 && navHrefs.every((v) => idxHtml.includes(`data-view="${v}"`)), navHrefs.join(','));
    check('导航是真链接（不用 button 切视图）', !/class="viewbtn"[^>]*data-view/.test(idxHtml));
    // 禁 break-all：只认「规则里真的用了」，注释里提到这个词（作为禁令说明）不算
    const cssRulesOnly = themeCssText.replace(/\/\*[\s\S]*?\*\//g, '');
    check('左栏单行契约在 theme.css（单行 + 省略号 + 禁 break-all）',
      /\.viewbtn \.vname[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/.test(themeCssText)
      && !cssRulesOnly.includes('break-all'));
    // 遥测行契约落在 .statline 上（每行都是 .statline）：nowrap + 省略号
    check('左栏遥测行同样单行省略',
      /\.statline \{[^}]*white-space:\s*nowrap/.test(themeCssText)
      && /\.statline > span \{[^}]*text-overflow:\s*ellipsis/.test(themeCssText));
    check('左栏无英文小标（.ven 已移除）', !idxHtml.includes('class="ven"'));
    check('窄屏顶栏：分组与子项均 nowrap，容器可横向滚动',
      /@media \(max-width: 900px\)[\s\S]*\.views \{[^}]*overflow-x: auto/.test(themeCssText)
      && /@media \(max-width: 900px\)[\s\S]*\.viewbtn[^}]*white-space: nowrap/.test(themeCssText));
    check('/workbench 强制落 todos（优先于 gw-view 记忆）', idxHtml.includes("location.pathname === '/workbench'"));
    check('数字键按左栏顺序映射六个视图', /const n = Number\(e\.key\)[\s\S]{0,200}n <= VIEW_IDS\.length/.test(idxHtml));
    // -- 按视图轮询 + 启动预取 + 徽标语义 --
    check('轮询按视图分支：统计与日志不再无条件拉',
      /if \(curView === 'overview' \|\| curView === 'traffic'\)/.test(idxHtml)
      && /if \(curView === 'test'\)/.test(idxHtml));
    check('启动一次性预取五个来源', ['/v1/todos', '/admin/report/list', '/admin/log', '/admin/providers']
      .every((u) => idxHtml.includes(`'${u}'`)) && idxHtml.includes('loadModels()'));
    check('旧左栏统计写入已清空（无 railTodo/railDoing/railReports）',
      !/railTodo|railDoing|railReports/.test(idxHtml));
    check('切回统计视图立即拉一次（不显示旧值当新值）',
      /function setView[\s\S]{0,1200}maybeFetchStats\(\)/.test(idxHtml));
    // -- 主区小节编号：每个视图内部从 01 起连续（不再与旧视图编号联动）--
    // 松的「1–9」写法会被现有串号蒙混过关，必须逐视图校验
    const viewSection = (v) => (new RegExp(`data-view="${v}"[\\s\\S]*?(?=data-view="|</main>)`).exec(idxHtml)?.[0] || '');
    check('每个视图内小节编号从 01 开始连续',
      ['todos', 'report', 'overview', 'traffic', 'test', 'providers'].every((v) => {
        const nums = [...viewSection(v).matchAll(/<span class="idx">(\d+)<\/span>/g)].map((m) => m[1]);
        return nums.length > 0 && nums.every((n, i) => n === String(i + 1).padStart(2, '0'));
      }),
      ['todos', 'report', 'overview', 'traffic', 'test', 'providers']
        .map((v) => v + ':' + [...viewSection(v).matchAll(/<span class="idx">(\d+)<\/span>/g)].map((m) => m[1]).join('/')).join(' '));
    const wb = await fetch(`${GW}/workbench`);
    const wbText = await wb.text();
    check('/workbench → 200 含「工作台」', wb.status === 200 && wbText.includes('工作台'), `got ${wb.status}`);
    // -- 合并为单页：六个视图、严格模式、标识符归并 --
    check('/workbench 与 / 返回同一份字节', wbText === idxHtml);
    check('单页含六个视图', ['todos', 'report', 'overview', 'traffic', 'test', 'providers']
      .every((v) => idxHtml.includes(`data-view="${v}"`)), '缺视图');
    // 取最后一个 <script>：首个是 9 行首屏主题脚本（防闪色必须 inline），主逻辑在后面
    const scripts = [...idxHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    check('主脚本以严格模式开头', /^\s*'use strict';/.test((scripts.at(-1) ?? '').trim()), scripts.at(-1)?.slice(0, 40));
    check('标识符已归并：无裸 editingId', !/\beditingId\b/.test(idxHtml) && idxHtml.includes('provEditingId') && idxHtml.includes('todoEditingId'));
    check('esc() 转义 & < > " 四类（取工作台版）',
      /esc\s*=\s*\(s\)\s*=>[\s\S]{0,200}&gt;/.test(idxHtml) && /&quot;/.test(idxHtml));
    check('工作台页含待办/报告两区', wbText.includes('待办') && wbText.includes('报告'), '缺功能区字样');
    check('工作台页含 token 获取逻辑（/admin/config）', wbText.includes('/admin/config'), '缺 loadToken 逻辑');
    check('工作台页引用共享样式', wbText.includes('/theme.css'));
    // 下载 .md 按钮：存在 + 文件名函数（跨日/无效区间），源码抽取后在 Node 内直跑
    check('工作台页含「下载 .md」按钮', wbText.includes('id="dlBtn"') && wbText.includes('下载 .md') && wbText.includes('downloadReport'));
    const fnMatch = wbText.match(/function reportFileName\(range\) \{[\s\S]*?\n\}/);
    check('reportFileName 函数在页面源码中', Boolean(fnMatch));
    if (fnMatch) {
      // 桩掉页面里的区间判别（口径在别处已测），只测文件名函数本体
      const stubBad = (r) => !r || !Number.isFinite(r?.start) || !Number.isFinite(r?.end) || r.end <= r.start;
      const reportFileName = new Function('isBadReportRange', `${fnMatch[0]}; return reportFileName;`)(stubBad);
      const t = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
      const crossMidnight = reportFileName({ start: t(2026, 10, 27, 23, 50), end: t(2026, 10, 28, 0, 10) });
      const expect = '工作总结_20261027-2350_20261028-0010.md';
      check('下载文件名：跨日窗口本地时区 YYYYMMDD-HHmm', crossMidnight === expect, `${crossMidnight} ≠ ${expect}`);
      const invalid = reportFileName(null);
      check('下载文件名：无效区间占位且无非法字符', invalid === '工作总结_无效区间.md' && !/[\\/:*?"<>|]/.test(invalid) && !/[\\/:*?"<>|]/.test(crossMidnight), invalid);
    }
    // 清理已完成按钮：存在 + confirm 文案口径（全量范围/不可撤销/跳过编辑项）
    check('工作台页含「清理已完成」按钮', wbText.includes('id="clearDoneBtn"') && wbText.includes('清理已完成') && wbText.includes('clearDoneTodos'));
    check('清理已完成：confirm 含全量范围与不可撤销、跳过编辑项口径', wbText.includes('此操作不可撤销') && wbText.includes('不受当前筛选影响') && wbText.includes('跳过编辑中的'));
    // feature-3：/ 聚焦搜索框快捷键（排除口径）+ Esc 清空 + 空清理提示
    check('工作台页含 / 聚焦搜索框快捷键（输入类控件/修饰键/IME/编辑中均排除）',
      wbText.includes("e.key !== '/'") && wbText.includes('e.isComposing') && wbText.includes('isContentEditable')
        && wbText.includes('e.ctrlKey || e.metaKey || e.altKey') && wbText.includes('preventDefault'));
    check('/ 快捷键：搜索框随空列表收起时不 preventDefault 白吞按键', wbText.includes('offsetParent'));
    check('两页均有内联 favicon（消除 /favicon.ico 404）', wbText.includes('<link rel="icon"') && idxHtml.includes('<link rel="icon"'));
    check('搜索框 Esc：有内容走同一清空+持久化路径、无内容失焦', wbText.includes('todoSearch\').addEventListener(\'keydown\'') && wbText.includes('e.target.blur()'));
    check('清理已完成：全部已完成项在编辑态时的空清理提示', wbText.includes('已跳过——退出编辑后再清理'));
    // feature-4：按此时间段重新生成（复用 generateReport 路径，坏区间禁用）
    check('工作台页含「按此时间段重新生成」按钮', wbText.includes('id="regenBtn"') && wbText.includes('按此时间段重新生成') && wbText.includes('regenFromReport'));
    const regenMatch = wbText.match(/function regenFromReport\(\) \{[\s\S]*?\n\}/);
    check('regenFromReport：回填起止+同步预设后调 generateReport（复用生成路径），坏区间直接返回', Boolean(regenMatch) && regenMatch[0].includes('generateReport()') && regenMatch[0].includes('isBadReportRange(range)') && regenMatch[0].includes('syncPresetFromInputs()'));
    check('regenBtn 禁用口径：初始/生成中/坏区间禁用', wbText.includes("$('regenBtn').disabled = on || isBadReportRange") && wbText.includes("$('regenBtn').disabled = true") && wbText.includes('该报告的时间段无效'));
    // 待办子项/详情：收起行只扫父标题，展开看清单与详情（agent 长文默认折叠）
    check('工作台页含展开状态与切换（expandedIds / data-expand）', wbText.includes('expandedIds') && wbText.includes('data-expand'));
    check('工作台页含子项操作：勾选 / 添加 / 删除（toggleItem·addItem·delItem）',
      wbText.includes('async function toggleItem') && wbText.includes('async function addItem') && wbText.includes('async function delItem')
        && wbText.includes('data-itemform') && wbText.includes('data-itemid'));
    check('工作台页含详情查看与编辑（noteEditId / data-noteform）', wbText.includes('noteEditId') && wbText.includes('data-noteform') && wbText.includes('data-notecancel'));
    check('收起行标题 2 行钳制（长标题不刷屏）', wbText.includes('-webkit-line-clamp: 2') || wbText.includes('-webkit-line-clamp:2'));
    check('收起行含子项进度徽标（子项 k/j）', wbText.includes('子项 ${'));
    check('成稿元数据行展示待办计数（待办 新增 n / 完成 m）', wbText.includes('待办 新增 ${'));
    check('详情编辑带 agent 分级上限提示（≤300）', wbText.includes('300'));
    // 评审修复：输入态守卫只护「被动刷新」，动作型刷新必须强制重渲染（回车加子项
    // 立刻出现且输入框清空、保存后表单关闭），未保存输入靠重渲染前快照还原
    check('动作型刷新强制重渲染（toggleItem×2/addItem/delItem/saveNote/saveTodoEdit/cycleTodo/清理）',
      (wbText.match(/force: true/g) ?? []).length >= 7 && wbText.includes('skipDraftKey'),
      `force: true ×${(wbText.match(/force: true/g) ?? []).length}`);
    check('重渲染快照还原未保存输入（编辑表单/详情/加子项框的值与焦点选区）',
      wbText.includes('form[data-noteform] textarea') && wbText.includes('selectionStart') && wbText.includes('skipDraftKey'));
    check('子项勾选走 click 委托（另一条编辑中的重渲染不吞勾选；键盘空格同样触发 click；不再用 change）',
      /document\.addEventListener\('click'[\s\S]*?type=["']checkbox["']\]\[data-itemid\]/.test(wbText) && !wbText.includes("document.addEventListener('change'"));
    const togSrc = wbText.match(/async function toggleItem[\s\S]*?\n\}/)?.[0] ?? '';
    check('子项勾选失败回同步（并发删除 404 后界面不与服务器背离）', togSrc.includes('force: true') && togSrc.includes('!r.ok'), togSrc.slice(0, 160));
  }

  console.log('— 显示器输入源切换（/admin/monitors，mock m1ddc） —');
  {
    const MON_UUIDS = ['A016429F-BCEC-4FAF-BD7D-23128391F7F1', 'F2F948D6-2F40-4DEC-8EF8-2E158BFF4328'];
    const st = await (await fetch(`${GW}/admin/monitors`)).json();
    check('GET 状态：available 且两台屏各一节', st.available === true && st.monitors?.length === 2, JSON.stringify(st).slice(0, 200));
    // 网关不预设语义：名字留空时一律显示编号（屏=UUID 前 8 位，输入=「输入 N」）
    check('GET 状态：未命名时输入显示编号 VCP 15', st.monitors.every((m) => m.ok && m.input === 15 && m.inputLabel === '输入 15'), JSON.stringify(st.monitors.map((m) => [m.input, m.inputLabel])));
    check('GET 状态：未命名时屏显示 UUID 前 8 位', st.monitors.every((m) => m.id === m.uuid.slice(0, 8).toUpperCase() && m.label === m.id), JSON.stringify(st.monitors.map((m) => [m.id, m.label])));
    check('GET 状态：inputs 按配置顺序回传且未命名', st.inputs?.length === 2 && st.inputs[0].value === 15 && st.inputs[1].value === 21 && st.inputs.every((i) => i.label === `输入 ${i.value}`), JSON.stringify(st.inputs));

    // 系统热键功能已移除（2026-10-28）：状态不再透出 hotkeys；旧配置里残留的 hotkeys
    // 节读取时直接忽略（不崩、不影响 inputs），管理台下次写盘顺手清掉。
    check('GET 状态：不再透出 hotkeys（系统热键功能已移除）', st.hotkeys === undefined, JSON.stringify(st.hotkeys));
    {
      const cfgMod = await import(path.join(ROOT, 'lib/config.mjs') + '?hk1');
      const parsed = cfgMod.normalizeMonitors({ inputs: [15, 21], hotkeys: [{ action: 'toggle', key: 'f13' }] });
      check('旧配置残留 hotkeys 节：归一化直接忽略，不影响 inputs 解析', parsed.hotkeys === undefined && parsed.inputs.length === 2, JSON.stringify(parsed));
    }

    const st2 = await (await fetch(`${GW}/admin/monitors`)).json();
    check('短时二次 GET 命中缓存（cached:true 且 at 相同）', st2.cached === true && st2.at === st.at);
    const fresh = await (await fetch(`${GW}/admin/monitors?refresh=1`)).json();
    check('refresh=1 绕过缓存现读', fresh.cached !== true);

    // 鉴权矩阵：回环 Host / 方法 / 内容类型
    const r403 = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: GW_PORT, path: '/admin/monitors', headers: { host: 'evil.example' } }, resolve);
      rq.on('error', reject); rq.end();
    });
    check('GET 非回环 Host → 403', r403.statusCode === 403);
    const m405 = await fetch(`${GW}/admin/monitors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('GET 端点不接受 POST → 405', m405.status === 405);
    const sw405 = await fetch(`${GW}/admin/monitors/switch`);
    check('switch 用 GET → 405', sw405.status === 405);
    const sw415 = await fetch(`${GW}/admin/monitors/switch`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    check('switch 非 JSON 内容类型 → 415（防跨站表单伪造）', sw415.status === 415);
    const swHost = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: GW_PORT, path: '/admin/monitors/switch', method: 'POST',
        headers: { host: 'evil.example', 'content-type': 'application/json' } }, resolve);
      rq.on('error', reject); rq.end('{}');
    });
    check('switch 非回环 Host → 403', swHost.statusCode === 403);

    // 参数校验
    const badTarget = await post('/admin/monitors/switch', { target: 'tv' });
    check('未知 target → 400', badTarget.status === 400);
    const badInput = await post('/admin/monitors/switch', { input: 999 });
    check('input 越界 → 400', badInput.status === 400);

    // 切换往返：mock state 可验证 set → get 一致性
    const sw = await post('/admin/monitors/switch', { input: 21 });
    const swJ = await sw.json();
    check('switch input=21 → 200 且 ok', sw.status === 200 && swJ.ok === true, JSON.stringify(swJ).slice(0, 200));
    check('返回带输入标签（未命名 → 输入 21）', swJ.input === 21 && swJ.inputLabel === '输入 21', JSON.stringify(swJ).slice(0, 200));
    const monLog = fs.readFileSync(path.join(tmp, 'mon-log.txt'), 'utf8');
    check('按 UUID 寻址写入两屏 input 21', MON_UUIDS.every((u) => monLog.includes(`uuid=${u} set input 21`)), monLog.trim());
    const after = await (await fetch(`${GW}/admin/monitors?refresh=1`)).json();
    check('切换后状态读回 21（无 Mac/Windows 语义）', after.monitors.every((m) => m.input === 21 && m.inputLabel === '输入 21'), JSON.stringify(after.monitors.map((m) => [m.input, m.inputLabel])));
    const swBack = await post('/admin/monitors/switch', { input: 15 });
    check('input 数字形态切回 15 → 200', swBack.status === 200);

    // target 按名字切换：先给输入源命名，再用名字下发
    const rn = await post('/admin/monitors/rename', { input: 21, name: '工作机' });
    const rnJ = await rn.json();
    check('改名：input 21 → 工作机 → 200', rn.status === 200 && rnJ.ok === true, JSON.stringify(rnJ).slice(0, 200));
    check('改名落盘到 providers.json 的 monitors.inputs', (() => {
      const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'providers.json'), 'utf8'));
      return cfg.monitors.inputs.find((i) => Number(i.value) === 21)?.name === '工作机';
    })());
    const named = await (await fetch(`${GW}/admin/monitors?refresh=1`)).json();
    check('改名后热生效：inputs 里 21 的 label 变为 工作机', named.inputs.find((i) => i.value === 21)?.label === '工作机', JSON.stringify(named.inputs));
    const swNamed = await post('/admin/monitors/switch', { target: '工作机' });
    const swNamedJ = await swNamed.json();
    check('按名字 target=工作机 切换 → 200 且解析为 21', swNamed.status === 200 && swNamedJ.input === 21, JSON.stringify(swNamedJ).slice(0, 200));

    // 屏改名 + 用 UUID 短前缀单切
    const FIRST = MON_UUIDS[0];
    const rnDisp = await post('/admin/monitors/rename', { display: FIRST.slice(0, 8), name: '主屏' });
    check('改名：屏 UUID 短前缀 → 主屏 → 200', rnDisp.status === 200);
    const namedDisp = await (await fetch(`${GW}/admin/monitors?refresh=1`)).json();
    check('屏改名热生效：label 变为 主屏 且 id 仍是 UUID 前缀', (() => {
      const m = namedDisp.monitors.find((x) => x.uuid === FIRST);
      return m?.label === '主屏' && m?.id === FIRST.slice(0, 8).toUpperCase();
    })(), JSON.stringify(namedDisp.monitors.map((m) => [m.id, m.label])));

    // 单屏切换：display 指定屏，只切那一台，另一台不动
    // （上一段 target=工作机 已把两块屏都切到 21，先复位到 15 才有「另一屏不动」可言）
    await post('/admin/monitors/switch', { input: 15 });
    await sleep(100);
    const swOne = await post('/admin/monitors/switch', { input: 21, display: FIRST });
    const swOneJ = await swOne.json();
    check('按 UUID 全串单切一块屏 → 200', swOne.status === 200 && swOneJ.displays === '主屏', JSON.stringify(swOneJ).slice(0, 200));
    const stOne = await (await fetch(`${GW}/admin/monitors?refresh=1`)).json();
    check('单屏切换：目标屏=21 而另一屏保持 15',
      stOne.monitors.find((m) => m.uuid === FIRST)?.input === 21
      && stOne.monitors.find((m) => m.uuid === MON_UUIDS[1])?.input === 15,
      JSON.stringify(stOne.monitors.map((m) => [m.id, m.input])));
    // 改名可用短前缀寻址同一块屏
    const swShort = await post('/admin/monitors/switch', { input: 15, display: FIRST.slice(0, 8) });
    check('display 用短前缀寻址 → 200', swShort.status === 200);
    const badDisp = await post('/admin/monitors/switch', { input: 21, display: 'DEADBEEF' });
    check('不存在的 display → 400', badDisp.status === 400);
    const undeclared = await post('/admin/monitors/switch', { input: 99 });
    check('未声明的 input 也允许（DDC 任意合法值）→ 200', undeclared.status === 200);
    const unknownName = await post('/admin/monitors/switch', { target: '不存在的名字' });
    check('未知 target 名字 → 400', unknownName.status === 400);
    const rnBad = await post('/admin/monitors/rename', { input: 99, name: 'x' });
    check('改名未声明的输入源 → 404', rnBad.status === 404);
    const rnNoSel = await post('/admin/monitors/rename', { name: 'x' });
    check('改名缺 input/display → 400', rnNoSel.status === 400);
    const rnEmpty = await post('/admin/monitors/rename', { input: 21, name: '' });
    const rnEmptyJ = await rnEmpty.json();
    check('改名传空串 → 清空回到编号', rnEmpty.status === 200 && rnEmptyJ.monitors.inputs.find((i) => Number(i.value) === 21)?.name === '');
    const cleared = await (await fetch(`${GW}/admin/monitors?refresh=1`)).json();
    check('清空后 label 回到「输入 21」', cleared.inputs.find((i) => i.value === 21)?.label === '输入 21', JSON.stringify(cleared.inputs));
    const rnHost = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: GW_PORT, path: '/admin/monitors/rename', method: 'POST',
        headers: { host: 'evil.example', 'content-type': 'application/json' } }, resolve);
      rq.on('error', reject); rq.end('{}');
    });
    check('rename 非回环 Host → 403', rnHost.statusCode === 403);
    const rn415 = await fetch(`${GW}/admin/monitors/rename`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    check('rename 非 JSON 内容类型 → 415', rn415.status === 415);

    // mode:"toggle" 一键切换专用路径已随热键功能移除：请求体缺 input/target → 400
    const tgGone = await post('/admin/monitors/switch', { mode: 'toggle' });
    check('switch：mode:"toggle" 专用路径已移除 → 400（缺 input/target）', tgGone.status === 400);

    // 默认配置（providers.json 没有 monitors 节）：状态查询走内置默认能跑，改名也必须能落盘
    // ——曾经改名读的是文件里的空节，默认配置下点改名直接 404「可用: 无」。
    {
      const cfgNoMon = path.join(tmp, 'providers-no-monitors.json');
      const rawCfg = JSON.parse(fs.readFileSync(path.join(tmp, 'providers.json'), 'utf8'));
      delete rawCfg.monitors;
      fs.writeFileSync(cfgNoMon, JSON.stringify(rawCfg, null, 2));
      const gw3 = spawnNode([path.join(ROOT, 'server.mjs')], {
        CANNBOT_PROXY_PORT: '6293',
        CANNBOT_CONFIG_FILE: cfgNoMon,
        CANNBOT_LOG_FILE: path.join(tmp, 'proxy3.log'),
        CANNBOT_STATS_FILE: path.join(tmp, 'stats3.json'),
        CANNBOT_M1DDC: path.join(ROOT, 'test/mock-m1ddc.mjs'),
        MOCK_M1DDC_STATE: path.join(tmp, 'mon-state.json'),
        MOCK_M1DDC_LOG: path.join(tmp, 'mon-log3.txt'),
      }, 'gateway-no-monitors');
      await sleep(1500);
      const st3 = await (await fetch('http://127.0.0.1:6293/admin/monitors')).json();
      check('无 monitors 节：状态仍走内置默认（两台屏）', st3.available === true && st3.monitors?.length === 2, JSON.stringify(st3).slice(0, 200));
      const rn3 = await fetch('http://127.0.0.1:6293/admin/monitors/rename', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 21, name: '第二台' }),
      });
      const rn3J = await rn3.json().catch(() => ({}));
      check('无 monitors 节：改名成功并播种默认节', rn3.status === 200 && rn3J.ok === true, JSON.stringify(rn3J).slice(0, 300));
      check('无 monitors 节：播种的默认值表原样保留', (() => {
        const c = JSON.parse(fs.readFileSync(cfgNoMon, 'utf8'));
        const vals = (c.monitors?.inputs ?? []).map((i) => Number(i.value));
        return vals.length === 2 && vals.includes(15) && vals.includes(21)
          && (c.monitors.list ?? []).length === 2;
      })());
      const st4 = await (await fetch('http://127.0.0.1:6293/admin/monitors?refresh=1')).json();
      check('无 monitors 节：改名后 label 生效', st4.inputs.find((i) => i.value === 21)?.label === '第二台', JSON.stringify(st4.inputs));
      gw3.kill();
    }

    // m1ddc 缺失降级：第二实例指向不存在的路径，主业务不受影响
    const gw2 = spawnNode([path.join(ROOT, 'server.mjs')], {
      CANNBOT_PROXY_PORT: '6292',
      CANNBOT_CONFIG_FILE: path.join(tmp, 'providers.json'),
      CANNBOT_LOG_FILE: path.join(tmp, 'proxy2.log'),
      CANNBOT_STATS_FILE: path.join(tmp, 'stats2.json'),
      CANNBOT_M1DDC: path.join(tmp, 'no-such-m1ddc'),
    }, 'gateway-no-m1ddc');
    await sleep(1500);
    const stDown = await (await fetch('http://127.0.0.1:6292/admin/monitors')).json();
    check('m1ddc 缺失：GET 仍 200 且 available:false + reason', stDown.available === false && Boolean(stDown.reason));
    check('m1ddc 缺失：健康检查等主业务正常', (await (await fetch('http://127.0.0.1:6292/healthz')).json()).service === 'unified-subscription-gateway');
    const swDown = await fetch('http://127.0.0.1:6292/admin/monitors/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"target":"tv"}' });
    check('m1ddc 缺失：switch → 503', swDown.status === 503);
    gw2.kill();
  }

  console.log('— 热键/一键切换功能移除（源、脚本与页面无残留） —');
  {
    check('源目录已无热键守护源与热键 LaunchAgent 模板', !fs.existsSync(path.join(ROOT, 'hotkeys')) && !fs.existsSync(path.join(ROOT, 'hotkeys.plist.template')));
    const inst = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    check('install.sh：不再编译/安装热键守护（无 swiftc / hotkeys 模板 / 守护 bootstrap）', !inst.includes('swiftc') && !inst.includes('hotkeys.plist.template') && !inst.includes('monitor-hotkeys.swift'));
    const uninst = fs.readFileSync(path.join(ROOT, 'uninstall.sh'), 'utf8');
    check('install.sh / uninstall.sh：保留旧版热键 LaunchAgent 的遗留清理路径（曾装过的机器能清掉）', inst.includes('cannbot-monitor-hotkeys') && inst.includes('HOTKEY_PLIST') && uninst.includes('cannbot-monitor-hotkeys') && uninst.includes('HOTKEY_PLIST'));
    const admText = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check('页面：一键切换按钮 / 热键改绑 UI / toggle 调用全部移除', !admText.includes('monToggle') && !admText.includes('monHk') && !admText.includes('/admin/monitors/hotkeys') && !admText.includes("mode: 'toggle'") && !admText.includes('{"mode":"toggle"}'));
    check('页面：手动切换面保留（左栏整机同切 + 每屏下一输入源轮换 + 输入源/屏改名）', admText.includes('data-mminput') && admText.includes('data-mcycle') && admText.includes('monInEdit') && admText.includes('data-mnamesave'));

    // -- 文档与代码同步：单页事实、两级导航、左栏契约 --
    const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    const readmeMd = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    check('文档已同步单页事实',
      !claudeMd.includes('workbench.html') && !readmeMd.includes('workbench.html')
      && claudeMd.includes('index.html') && readmeMd.includes('index.html'));
    check('CLAUDE.md 记录两级导航与左栏布局契约',
      /两级|两个分组/.test(claudeMd) && claudeMd.includes('省略号') && claudeMd.includes('break-all'));
    check('文档不把 /workbench 说成独立页面',
      !/工作台页（workbench|独立页面/.test(readmeMd), 'README 仍把工作台当独立页');
    check('文档记录按视图轮询', claudeMd.includes('按视图') || claudeMd.includes('可见时才拉'));

    // -- 合并后的事件委托隔离（独立审查发现：供应商「删除」会连带触发待办删除）--
    // 这里用 admText（本作用域已读的 index.html），与上面 HTTP 小节里的 idxHtml 同一个文件
    check('全局 data-act 委托排除供应商表（#provTbl 有自己的监听）',
      /closest\('button\[data-act\]'\)[\s\S]{0,400}closest\('#provTbl'\)/.test(admText));
    check('无悬空徽标引用（vbTraffic 已随左栏改版删除）', !admText.includes('vbTraffic'));
    // /workbench 自带有效 hash 时以 hash 意图为准（/workbench#report 应落到汇报）
    check('/workbench 带 hash 时尊重 hash（hashView 优先于强制 todos）',
      /const hashView[\s\S]{0,200}hashView[\s\S]{0,120}\|\|/.test(admText));
    check('显示器相关代码只在总览视图（工作台视图不含）', !admText.includes('monBox') && !admText.includes('loadMonitorsOnce'));
  }

  console.log('— 统计落盘（进程内 recordStats + flushStats：tmp+rename+0600） —');
  {
    const statsFile = path.join(tmp, 'stats-flush.json');
    const prevStats = process.env.CANNBOT_STATS_FILE;
    process.env.CANNBOT_STATS_FILE = statsFile;
    const statsMod = await import(path.join(ROOT, 'lib/stats.mjs') + '?t=' + Date.now());
    statsMod.recordStats({ provider: 'p1', model: 'm1', status: 200, ms: 5, bytesIn: 10, bytesOut: 20, tin: 1, tout: 2 });
    statsMod.flushStats();
    check('stats 原子落盘：文件存在且权限 0600', fs.existsSync(statsFile) && (fs.statSync(statsFile).mode & 0o777) === 0o600, fs.statSync(statsFile)?.mode?.toString(8));
    const flushed = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    check('stats 落盘内容含记账桶', flushed.days && Object.values(flushed.days)[0]?.providers?.p1?.models?.m1?.req === 1, JSON.stringify(flushed).slice(0, 120));
    // 写一半被 kill 模拟：flush 完成后目录无残留 tmp（rename 已原子换名）
    check('stats 落盘无残留 tmp 文件', !fs.readdirSync(tmp).some((f) => f.startsWith('stats-flush.json') && f.endsWith('.tmp')), fs.readdirSync(tmp).filter((f) => f.includes('stats-flush')).join(','));
    // 坏 stats.json 起步：留 .bad 备份（与 todos/reports 同口径），空状态起步不崩
    const statsBad = path.join(tmp, 'stats-bad.json');
    fs.writeFileSync(statsBad, '{not-json');
    process.env.CANNBOT_STATS_FILE = statsBad;
    const statsBadMod = await import(path.join(ROOT, 'lib/stats.mjs') + '?t=' + Date.now() + 'b');
    statsBadMod.recordStats({ provider: 'p1', model: 'm1', status: 200, ms: 5 });
    statsBadMod.flushStats();
    check('坏 stats.json：留 .bad 备份且内容原样', fs.existsSync(statsBad + '.bad') && fs.readFileSync(statsBad + '.bad', 'utf8') === '{not-json');
    check('坏 stats.json：按空起步重新记账落盘', (() => { const d = JSON.parse(fs.readFileSync(statsBad, 'utf8')); return Object.values(d.days)[0]?.providers?.p1?.models?.m1?.req === 1; })());
    if (prevStats === undefined) delete process.env.CANNBOT_STATS_FILE; else process.env.CANNBOT_STATS_FILE = prevStats;
  }
} catch (e) {
  failures.push(`异常: ${e.message}`);
  console.error(e);
} finally {
  mock.kill();
  gateway.kill();
}

console.log(`\n结果: ${passed} 通过, ${failures.length} 失败${failures.length ? ` — ${failures.join(' ; ')}` : ''}`);
if (failures.length) { gateway.dump(); mock.dump(); }
// kill 后子进程可能仍握着临时目录文件句柄片刻：稍等再清，清不掉也不影响结果
setTimeout(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  process.exit(failures.length ? 1 : 0);
}, 300);
