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
    check('healthz 五个 provider', h.providers?.length === 5);
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
    check('/admin/config 返回网关 token', c.clientToken === TOKEN && c.providers?.length === 5);
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
    check('stats.protocols 契约（5 键）', s.protocols?.['mock-oai'] === 'openai' && s.protocols?.['mock-anth'] === 'anthropic'
      && s.protocols?.['mock-kimi'] === 'openai' && s.protocols?.['mock-zhipu'] === 'openai' && s.protocols?.['mock-zai'] === 'openai' && Object.keys(s.protocols).length === 5, JSON.stringify(s.protocols));
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
    check('GET 视图含五个 provider 与默认上游', v.providers?.length === 5 && v.routing?.defaultProvider === 'mock-oai', JSON.stringify(v.routing));
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
    // 删到只剩一个时拒绝（providers 不允许为空）：依次删 mock-kimi、mock-zhipu、mock-zai、mock-anth
    await fetch(`${GW}/admin/providers/mock-kimi`, { method: 'DELETE', headers: authHeaders });
    await fetch(`${GW}/admin/providers/mock-zhipu`, { method: 'DELETE', headers: authHeaders });
    await fetch(`${GW}/admin/providers/mock-zai`, { method: 'DELETE', headers: authHeaders });
    await fetch(`${GW}/admin/providers/mock-anth`, { method: 'DELETE', headers: authHeaders });
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

    // 空素材窗口：不调模型直接成稿（model=none、不再 failed）。
    // 主网关 zcode/opencode 指向 no-such.db（采集必失败）→ 空窗走「采集失败」口径，
    // 不把采集故障伪装成「无记录」
    const emptyWin = { startMs: Date.now() + 5 * 24 * 3600_000, endMs: Date.now() + 5 * 24 * 3600_000 + 3600_000 };
    check('空素材+源失败：POST → 200', (await post('/admin/report/generate', emptyWin)).status === 200);
    const emptyDone = await waitJob('done');
    const emptyRep = await (await fetch(`${GW}/admin/report/${emptyDone.reportId}`)).json();
    check('空素材+源失败：done 且未调模型（model=none）', emptyDone.state === 'done' && emptyRep.model === 'none' && emptyRep.provider === 'none', JSON.stringify({ s: emptyDone.state, m: emptyRep.model }));
    check('空素材+源失败：文案明确采集失败、结论不可信（不写「无记录」）', emptyRep.report.includes('素材采集失败') && emptyRep.report.includes('不可作为汇报依据') && !emptyRep.report.includes('未检索到可用的工作记录') && emptyRep.materials?.sourcesFailed?.length === 2, String(emptyRep.report).slice(0, 160));

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
    check('list 返回 5 份元数据且不含正文（场景 A/空素材/C/C′/F）', list.reports?.length === 5 && list.reports.every((r) => typeof r.report !== 'string'), JSON.stringify(list.reports?.map((r) => r.id)));
    const del = await fetch(`${GW}/admin/report/${done.reportId}`, { method: 'DELETE' });
    check('DELETE 报告 → 204', del.status === 204, `got ${del.status}`);
    const gone = await fetch(`${GW}/admin/report/${done.reportId}`);
    check('删后 GET → 404', gone.status === 404);
    const list2 = await (await fetch(`${GW}/admin/report/list`)).json();
    check('删除后 list 剩 4 份（场景 空素材/C/C′/F 各一）', list2.reports?.length === 4, JSON.stringify(list2.reports?.length));
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

  console.log('— 工作台静态资源（/workbench、/workbench.css、admin 外链改造） —');
  {
    const css = await fetch(`${GW}/workbench.css`);
    const cssText = await css.text();
    check('/workbench.css → 200 且 text/css', css.status === 200 && (css.headers.get('content-type') || '').includes('text/css'));
    check('workbench.css 含主题令牌与骨架', cssText.includes('--bg') && cssText.includes('.frame') && cssText.includes('.viewbtn'), cssText.slice(0, 80));
    const adminHtml = await (await fetch(`${GW}/`)).text();
    check('admin.html 外链共享样式', adminHtml.includes('<link rel="stylesheet" href="/workbench.css">'), '未找到 link 标签');
    check('admin.html 通用样式已移出（body 底纹不再内嵌）', !adminHtml.includes('body::before'), 'body::before 仍内嵌');
    check('admin.html 视图专属样式保留（趋势图/性能表）', adminHtml.includes('.chartwrap') && adminHtml.includes('.tbl.perf'));
    check('admin.html rail 含工作台链接', adminHtml.includes('href="/workbench"'));
    const wb = await fetch(`${GW}/workbench`);
    const wbText = await wb.text();
    check('/workbench → 200 含「工作台」', wb.status === 200 && wbText.includes('工作台'), `got ${wb.status}`);
    check('工作台页含待办/报告两区', wbText.includes('待办') && wbText.includes('报告'), '缺功能区字样');
    check('工作台页含 token 获取逻辑（/admin/config）', wbText.includes('/admin/config'), '缺 loadToken 逻辑');
    check('工作台页引用共享样式', wbText.includes('/workbench.css'));
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
    check('搜索框 Esc：有内容走同一清空+持久化路径、无内容失焦', wbText.includes('todoSearch\').addEventListener(\'keydown\'') && wbText.includes('e.target.blur()'));
    check('清理已完成：全部已完成项在编辑态时的空清理提示', wbText.includes('已跳过——退出编辑后再清理'));
    // feature-4：按此时间段重新生成（复用 generateReport 路径，坏区间禁用）
    check('工作台页含「按此时间段重新生成」按钮', wbText.includes('id="regenBtn"') && wbText.includes('按此时间段重新生成') && wbText.includes('regenFromReport'));
    const regenMatch = wbText.match(/function regenFromReport\(\) \{[\s\S]*?\n\}/);
    check('regenFromReport：回填起止+同步预设后调 generateReport（复用生成路径），坏区间直接返回', Boolean(regenMatch) && regenMatch[0].includes('generateReport()') && regenMatch[0].includes('isBadReportRange(range)') && regenMatch[0].includes('syncPresetFromInputs()'));
    check('regenBtn 禁用口径：初始/生成中/坏区间禁用', wbText.includes("$('regenBtn').disabled = on || isBadReportRange") && wbText.includes("$('regenBtn').disabled = true") && wbText.includes('该报告的时间段无效'));
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
    const swDown = await fetch('http://127.0.0.1:6292/admin/monitors/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"target":"windows"}' });
    check('m1ddc 缺失：switch → 503', swDown.status === 503);
    gw2.kill();
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
