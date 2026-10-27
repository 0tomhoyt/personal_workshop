// 端到端冒烟测试：起一个 mock 上游 + 一个网关实例（临时目录配置），覆盖
//   ① openai 客户端 → openai 上游（透传，流式/非流式）
//   ② anthropic 客户端 → openai 上游（翻译，含 tool 往返）
//   ③ anthropic 客户端 → anthropic 上游（直通，流式/非流式）
//   ④ openai 客户端 → anthropic 上游（反向翻译，流式/非流式，含 tool）
//   以及网关 token 鉴权、模型名路由（裸名/显式前缀/重名消歧/默认上游兜底）、统计维度。
// 运行: node test/smoke.mjs
import { spawn } from 'node:child_process';
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
    check('缺 title → 400', (await post('/v1/todos', {})).status === 400);
    check('非法 urgency → 400', (await post('/v1/todos', { title: 'x', urgency: '高' })).status === 400);
    check('非法 status → 400', (await fetch(`${GW}/v1/todos/${t1.id}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ status: 'todo' }) })).status === 400);
    check('未知方法 PATCH → 405', (await fetch(`${GW}/v1/todos`, { method: 'PATCH', headers: authHeaders, body: '{}' })).status === 405);

    // 持久化：直读 todos.json（合法 JSON、与内存一致、0600）
    const fileState = JSON.parse(fs.readFileSync(path.join(tmp, 'todos.json'), 'utf8'));
    const listed = await (await fetch(`${GW}/v1/todos`, { headers: todosHeaders })).json();
    check('todos.json 落盘且与列表一致', Array.isArray(fileState.todos) && fileState.todos.length === listed.todos.length, `${fileState.todos?.length} vs ${listed.todos?.length}`);
    check('todos.json 权限 0600', (fs.statSync(path.join(tmp, 'todos.json')).mode & 0o777) === 0o600, fs.statSync(path.join(tmp, 'todos.json')).mode.toString(8));

    // 坏文件自愈：另起实例指向损坏的 todos.json → 空列表起步、主业务不崩
    fs.writeFileSync(path.join(tmp, 'todos-bad.json'), '{not-json');
    const gwTodo = spawnNode([path.join(ROOT, 'server.mjs')], {
      CANNBOT_PROXY_PORT: '6294',
      CANNBOT_CONFIG_FILE: path.join(tmp, 'providers.json'),
      CANNBOT_LOG_FILE: path.join(tmp, 'proxy4.log'),
      CANNBOT_STATS_FILE: path.join(tmp, 'stats4.json'),
      CANNBOT_TODOS_FILE: path.join(tmp, 'todos-bad.json'),
    }, 'gateway-bad-todos');
    await sleep(1500);
    const badList = await (await fetch('http://127.0.0.1:6294/v1/todos', { headers: todosHeaders })).json();
    check('坏 todos.json：实例存活且空列表起步', Array.isArray(badList.todos) && badList.todos.length === 0, JSON.stringify(badList));
    check('坏 todos.json：主业务正常', (await (await fetch('http://127.0.0.1:6294/healthz')).json()).service === 'unified-subscription-gateway');
    gwTodo.kill();
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
