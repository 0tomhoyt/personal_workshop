// 冒烟测试用的 mock 上游：同一端口按路径前缀模拟多类订阅。
//   /oai/*    openai 协议上游（Bearer mock-token-oai），模型 mock-pro / mock-flash / shared-model
//   /anth/*   anthropic 协议上游（x-api-key 或 Bearer mock-token-anthropic；兼收 mock-token-dual），模型 claude-mock / shared-model
//   /oai 兼收 mock-token-dual（双入口 smoke）
//   /zhipu/*  智谱方言 openai 上游（Bearer mock-token-zhipu），模型 glm-mock：web_search 工具
//             走智谱真实形态（非流式顶层 web_search 数组 / 流式 delta.content 数组传闻形态）
//   /z.ai/*   智谱方言变体端点（处理同 /zhipu），模型 glm-zai：验证 z.ai 域名同样命中方言推断
//   /kimi/*   Kimi 方言 openai 上游（Bearer mock-token-kimi），模型 kimi-mock：builtin_function
//             $web_search 走「tool_calls → 回传 role:tool(arguments 原样) → 终轮」循环
// 未知块回归：请求 messages 里含标记 'UNKNOWN-BLOCK-TEST' 时，/oai 与 /anth 的流式分支会
// 额外发出未知 delta 键 / 未知 content 块，验证两个翻译状态机跳过未知形态、不中断流。
// 非流式响应把收到的请求体回显在 content 文本里（前缀 ECHO:），供测试断言翻译/直通的
// 请求结构是否保真；流式响应发固定文本（你好/世界）+ usage。
// 铁律：所有搜索分支的响应同时内嵌 ECHO 回显与搜索内容，杜绝 parseEcho 对非 ECHO 文本报错。
import http from 'node:http';

const PORT = Number(process.argv[2] || 6291);
const OAI_TOKEN = 'mock-token-oai';
const ANTH_TOKEN = 'mock-token-anthropic';
const ZHIPU_TOKEN = 'mock-token-zhipu';
const KIMI_TOKEN = 'mock-token-kimi';
const DUAL_TOKEN = 'mock-token-dual';

const ECHO = (extra) => 'ECHO:' + JSON.stringify(extra);

// 报告重试演练的调用计数（模型:级 → 次数），见 /oai chat 分支
const emptySeen = {};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

function openaiEcho(body, auth, token = OAI_TOKEN) {
  return {
    model: body.model,
    sawAuth: auth === `Bearer ${token}`,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    stream: body.stream,
    stream_options: body.stream_options,
    max_tokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null,
  };
}

function openaiChatResult(echoText, model, usage) {
  return {
    id: 'cmpl-mock', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: echoText }, finish_reason: 'stop' }],
    usage,
  };
}

function anthropicEcho(body, auth) {
  return {
    model: body.model,
    sawAuth: auth === ANTH_TOKEN || auth === `Bearer ${ANTH_TOKEN}`,
    system: body.system ?? null,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice ?? null,
    max_tokens: body.max_tokens ?? null,
    stream: body.stream ?? false,
  };
}

function anthropicMessage(echoText, model, usage, tools = []) {
  const content = [{ type: 'text', text: echoText }];
  if (tools.length) content.push({ type: 'tool_use', id: 'toolu_mock1', name: tools[0].name, input: { echoed: true } });
  return { id: 'msg_mock', type: 'message', role: 'assistant', model, content, stop_reason: tools.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? '';
  const bodyBuf = await readBody(req);
  let body = {};
  try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}

  if (url === '/oai/v1/models') {
    return json(res, 200, { object: 'list', data: [{ id: 'mock-pro' }, { id: 'mock-flash' }, { id: 'shared-model' }] });
  }
  if (url === '/anth/v1/models') {
    return json(res, 200, { data: [{ id: 'claude-mock', display_name: 'Claude Mock' }, { id: 'shared-model', display_name: 'Shared' }] });
  }
  if (url === '/zhipu/v1/models') {
    return json(res, 200, { object: 'list', data: [{ id: 'glm-mock' }] });
  }
  if (url === '/z.ai/v1/models') {
    return json(res, 200, { object: 'list', data: [{ id: 'glm-zai' }] });
  }
  if (url === '/kimi/v1/models') {
    return json(res, 200, { object: 'list', data: [{ id: 'kimi-mock' }] });
  }

  if (url === '/oai/v1/chat/completions') {
    if (auth !== `Bearer ${OAI_TOKEN}` && auth !== `Bearer ${DUAL_TOKEN}`) return json(res, 401, { error: { message: 'bad token', type: 'authentication_error' } });
    if (body.model === 'mock-500') return json(res, 500, { error: { message: 'mock 上游 5xx 演练' } }); // 报告失败口径测试用
    // 报告重试演练：按 system prompt 区分两级（systemFinal 含「汇报助手」），模拟 kimi 式偶发空响应
    {
      const sys = (body.messages ?? []).find((m) => m?.role === 'system')?.content ?? '';
      const isFinal = typeof sys === 'string' && sys.includes('汇报助手');
      const key = `${body.model}:${isFinal ? 'final' : 'project'}`;
      emptySeen[key] = (emptySeen[key] ?? 0) + 1;
      if (body.model === 'mock-empty-final' && isFinal) {
        return json(res, 200, openaiChatResult('   \n', body.model, { prompt_tokens: 9, completion_tokens: 0 }));
      }
      if (body.model === 'mock-empty-final-once' && isFinal && emptySeen[key] <= 1) {
        return json(res, 200, openaiChatResult('  \n ', body.model, { prompt_tokens: 9, completion_tokens: 0 }));
      }
      if (body.model === 'mock-empty-project-once' && !isFinal && emptySeen[key] <= 1) {
        return json(res, 200, openaiChatResult('', body.model, { prompt_tokens: 9, completion_tokens: 0 }));
      }
    }
    const echo = ECHO(openaiEcho(body, auth));
    if (!body.stream) {
      return json(res, 200, openaiChatResult(echo, body.model, { prompt_tokens: 9, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } }));
    }
    const weird = JSON.stringify(body.messages ?? []).includes('UNKNOWN-BLOCK-TEST');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    if (weird) chunk({ mystery_signal: { v: 1 } }); // 未知 delta 键：翻译层应忽略
    chunk({ content: echo });
    if (weird) chunk({ content: [{ type: 'mystery_block', payload: 'x' }, { type: 'text', text: '未知块后的正文' }] }); // 未知块与文本块混排
    chunk({}, 'stop');
    if (body.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({ id: 'cmpl-mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } } })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // /oai 同款流式回显（含 include_usage 时的 usage chunk）；content 可为数组模拟智谱传闻形态
  const openaiStyleStream = (res_, body, content, usage) => {
    res_.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null, extra = {}) => res_.write(`data: ${JSON.stringify({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    chunk({ content });
    chunk({}, 'stop');
    if (body.stream_options?.include_usage) {
      res_.write(`data: ${JSON.stringify({ id: 'cmpl-mock', object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
    }
    res_.write('data: [DONE]\n\n');
    return res_.end();
  };

  if (url === '/zhipu/v1/chat/completions' || url === '/z.ai/v1/chat/completions') {
    if (auth !== `Bearer ${ZHIPU_TOKEN}`) return json(res, 401, { error: { message: 'bad token', type: 'authentication_error' } });
    const echo = ECHO(openaiEcho(body, auth, ZHIPU_TOKEN));
    const hasWebSearch = Array.isArray(body.tools) && body.tools.some((t) => t?.type === 'web_search');
    if (!body.stream) {
      if (hasWebSearch) {
        // 智谱真实形态：搜索结果在响应顶层 web_search 数组，message.content 为纯字符串
        return json(res, 200, {
          id: 'cmpl-mock-zhipu', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: echo }, finish_reason: 'stop' }],
          web_search: [{ icon: 'https://e.cn/i.png', title: '结果标题', link: 'https://example.com/a', media: '示例站', publish_date: '2026-10-01', content: '摘要内容', refer: 'ref_1' }],
          usage: { prompt_tokens: 9, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } },
        });
      }
      return json(res, 200, openaiChatResult(echo, body.model, { prompt_tokens: 9, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } }));
    }
    if (hasWebSearch) {
      // 智谱流式传闻形态：delta.content 为数组，text 与 web_search 块混排
      return openaiStyleStream(res, body, [
        { type: 'text', text: echo },
        { type: 'web_search', title: '流式结果', link: 'https://example.com/s', content: '流式摘要', refer: 'ref_1', media: 'm', publish_date: '2026-10-01', icon: 'i' },
      ], { prompt_tokens: 9, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 5 } });
    }
    return openaiStyleStream(res, body, echo, { prompt_tokens: 9, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } });
  }

  if (url === '/kimi/v1/chat/completions') {
    if (auth !== `Bearer ${KIMI_TOKEN}`) return json(res, 401, { error: { message: 'bad token', type: 'authentication_error' } });
    const hasSearch = Array.isArray(body.tools) && body.tools.some((t) => t?.type === 'builtin_function' && t?.function?.name === '$web_search');
    const toolMsg = Array.isArray(body.messages) ? [...body.messages].reverse().find((m) => m?.role === 'tool') : null;
    if (hasSearch && !toolMsg) {
      // 第一轮：返回 $web_search tool_calls，等网关按 Kimi 约定回传 role:tool(arguments 原样)
      return json(res, 200, {
        id: 'cmpl-mock-kimi', object: 'chat.completion', created: 1, model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: '$web_search', arguments: '{"search_query":"杭州天气"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      });
    }
    if (hasSearch && toolMsg) {
      // 终轮：ECHO 里带上下文关键信息，验证网关把 arguments 原封回传
      const lastAsst = [...body.messages].reverse().find((m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
      const echo = 'ECHO:' + JSON.stringify({
        toolsType: body.tools[0]?.type,
        fnName: body.tools[0]?.function?.name,
        assistantArgs: lastAsst?.tool_calls?.[0]?.function?.arguments ?? null,
        echoedToolCall: toolMsg.content ?? null,
        final: '搜索完成：杭州晴[1]',
      });
      return json(res, 200, openaiChatResult(echo, body.model, { prompt_tokens: 30, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } }));
    }
    // 无搜索工具：按 /oai 同款 ECHO
    const echo = ECHO(openaiEcho(body, auth, KIMI_TOKEN));
    if (!body.stream) return json(res, 200, openaiChatResult(echo, body.model, { prompt_tokens: 9, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } }));
    return openaiStyleStream(res, body, echo, { prompt_tokens: 9, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } });
  }

  if (url === '/anth/v1/messages') {
    if (auth !== ANTH_TOKEN && auth !== `Bearer ${ANTH_TOKEN}` && auth !== DUAL_TOKEN && auth !== `Bearer ${DUAL_TOKEN}`) {
      return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'bad token' } });
    }
    const echo = ECHO(anthropicEcho(body, auth));
    const usage = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 };
    // 搜索分支：请求带 type 以 'web_search' 开头的 server tool 时回搜索块（usage 不变）
    const hasServerSearch = Array.isArray(body.tools) && body.tools.some((t) => String(t?.type || '').startsWith('web_search'));
    const searchBlocks = [
      { type: 'server_tool_use', id: 'srvtoolu_m1', name: 'web_search', input: { query: '杭州天气' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_m1', content: [{ type: 'web_search_result', url: 'https://example.com/a', title: '结果标题', content: '搜索摘要' }] },
    ];
    if (!body.stream) {
      if (hasServerSearch) {
        return json(res, 200, {
          id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: echo }, ...searchBlocks],
          stop_reason: 'end_turn', stop_sequence: null, usage,
        });
      }
      return json(res, 200, anthropicMessage(echo, body.model, usage, body.tools ?? []));
    }
    const zhipuUsage = JSON.stringify(body.messages ?? []).includes('STREAM-USAGE-IN-DELTA');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // 智谱方言变体：message_start 的 usage 只报占位 0，完整 usage 放 message_delta
    ev('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], usage: zhipuUsage ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : { input_tokens: usage.input_tokens, output_tokens: 0, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 } } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '世界' } });
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    if (hasServerSearch) {
      ev('content_block_start', { type: 'content_block_start', index: 1, content_block: searchBlocks[0] });
      ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"杭州天气"}' } });
      ev('content_block_stop', { type: 'content_block_stop', index: 1 });
      ev('content_block_start', { type: 'content_block_start', index: 2, content_block: searchBlocks[1] });
      ev('content_block_stop', { type: 'content_block_stop', index: 2 });
    }
    if (JSON.stringify(body.messages ?? []).includes('UNKNOWN-BLOCK-TEST')) {
      // 未知块回归：未知 content_block 类型与未知 delta 类型，反向翻译层应跳过、不中断流
      ev('content_block_start', { type: 'content_block_start', index: 9, content_block: { type: 'mystery_block', data: 'zzz' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 9, delta: { type: 'mystery_delta', blob: 'zzz' } });
      ev('content_block_stop', { type: 'content_block_stop', index: 9 });
    }
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: zhipuUsage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 } : { output_tokens: usage.output_tokens } });
    ev('message_stop', { type: 'message_stop' });
    return res.end();
  }

  json(res, 404, { error: { message: `mock upstream 未知路径 ${url}` } });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock upstream ready on ${PORT}`));
