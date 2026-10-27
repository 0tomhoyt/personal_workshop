// OpenAI Chat Completions → Anthropic Messages 方向的翻译（客户端 OpenAI、上游 anthropic 协议时使用）。
// 红线：内容逐字保留，只换结构。
//   请求侧：system 消息 → system 参数；tool_calls → tool_use 块；role:tool → tool_result 块；
//           data URI / http 图片 → base64 / url image 块；max_tokens 缺省补 8192（Anthropic 必填）。
//   响应侧：thinking 块 → reasoning_content 字段（OpenAI 兼容客户端可识别可忽略）。
import { randHex, openaiOutputWeight } from '../util.mjs';
import { recordStats, observeStream } from '../stats.mjs';
import { log } from '../log.mjs';
import { formatSearchAsText } from './searchtool.mjs';

function mapFinishToAnthropicChoice(fr) {
  if (fr === 'tool_calls') return 'tool_calls';
  if (fr === 'length') return 'length';
  return 'stop';
}

function anthropicStopToFinishReason(sr) {
  if (sr === 'tool_use') return 'tool_calls';
  if (sr === 'max_tokens') return 'length';
  return 'stop';
}

// data URI 图片 → Anthropic base64 source
function imageDataUri(uri) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (!m) return null;
  return { source: { type: 'base64', media_type: m[1] || 'image/png', data: m[2] } };
}

// OpenAI 请求体 → Anthropic messages 请求体
export function openAIToAnthropicRequest(body) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('请求体不是 JSON 对象'), { status: 400 });
  if (!body.model) throw Object.assign(new Error('请求缺少 model 字段'), { status: 400 });

  const system = [];
  const messages = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string') system.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const p of m.content) if (p?.type === 'text' && typeof p.text === 'string') system.push(p.text);
      }
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = [];
    const toolCalls = [];
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' && typeof p.text === 'string') blocks.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
          if (!url) continue;
          const img = url.startsWith('data:') ? imageDataUri(url) : { source: { type: 'url', url } };
          if (img) blocks.push({ type: 'image', ...img });
        }
      }
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        toolCalls.push({ type: 'tool_use', id: tc.id ?? `toolu_${randHex()}`, name: tc.function?.name ?? '', input });
      }
    }
    if (m.role === 'tool') {
      // OpenAI 的 tool 消息 → user 消息里的 tool_result 块
      let content = m.content;
      if (Array.isArray(content)) content = content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: typeof content === 'string' ? content : '' }] });
      continue;
    }
    const content = [...blocks, ...toolCalls];
    if (content.length) messages.push({ role, content });
    else if (role === 'assistant') messages.push({ role, content: [{ type: 'text', text: '' }] });
  }

  const payload = { model: body.model, messages, stream: Boolean(body.stream) };
  if (system.length) payload.system = system.join('\n');
  // Anthropic 必填 max_tokens；OpenAI 客户端可能不传
  payload.max_tokens = body.max_tokens ?? body.max_completion_tokens ?? 8192;
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.top_p != null) payload.top_p = body.top_p;
  if (body.top_k != null) payload.top_k = body.top_k;
  if (body.stop != null) payload.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = [];
    let hasFunction = false;
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue;
      // 智谱 web_search 形态 → Anthropic server tool（仅域过滤参数有对应）
      if (t.type === 'web_search' && t.web_search && typeof t.web_search === 'object') {
        const ws = { type: 'web_search_20250305', name: 'web_search' };
        if (Array.isArray(t.web_search.search_domain_filter) && t.web_search.search_domain_filter.length) {
          ws.allowed_domains = t.web_search.search_domain_filter;
        }
        tools.push(ws);
        continue;
      }
      // Kimi builtin_function $web_search → 同型 Anthropic server tool（无域过滤参数）
      if (t.type === 'builtin_function' && t.function?.name === '$web_search') {
        tools.push({ type: 'web_search_20250305', name: 'web_search' });
        continue;
      }
      // 普通 function 工具：现路径不变
      if (t.function?.name) {
        hasFunction = true;
        tools.push({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters && typeof t.function.parameters === 'object'
            ? t.function.parameters
            : { type: 'object', properties: {} },
        });
        continue;
      }
      // 未识别（无 function.name 且非上述两型）：丢弃并留痕，请求继续
      log(`OpenAI→Anthropic 翻译: 丢弃无法识别的工具: ${JSON.stringify(t).slice(0, 120)}`);
    }
    if (tools.length) {
      payload.tools = tools;
      // tool_choice 仅在存在 function 工具时设（纯搜索工具不设，保守）
      if (hasFunction) {
        const tc = body.tool_choice;
        if (tc === 'auto' || tc == null) payload.tool_choice = { type: 'auto' };
        else if (tc === 'required') payload.tool_choice = { type: 'any' };
        else if (tc === 'none') payload.tool_choice = { type: 'none' };
        else if (typeof tc === 'object' && tc?.type === 'function' && tc.function?.name) payload.tool_choice = { type: 'tool', name: tc.function.name };
      }
    }
  }
  return payload;
}

// Anthropic 非流式响应 → OpenAI chat.completion。
// server_tool_use / web_search_tool_result 块在 OpenAI 形态无对应 server tool，降级为
// 纯文本拼进 content（内容逐字保留）；无搜索块时 content 与旧实现字节一致。
export function anthropicToOpenAIChat(json, requestedModel) {
  const content = Array.isArray(json?.content) ? json.content : [];
  const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  const reasoning = content.filter((b) => b?.type === 'thinking' && typeof b.thinking === 'string').map((b) => b.thinking).join('\n');
  const toolCalls = content
    .filter((b) => b?.type === 'tool_use')
    .map((b) => ({
      id: b.id ?? `call_${randHex()}`,
      type: 'function',
      function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
    }));
  // 搜索块降级收集：server_tool_use 取 input.query（容错字符串/对象/缺失），
  // web_search_tool_result 的 content 为数组取各项 url/title/content、为字符串整体保留
  const queries = [];
  const results = [];
  for (const b of content) {
    if (b?.type === 'server_tool_use') {
      const inp = b.input;
      let q = '';
      if (typeof inp === 'string') q = inp;
      else if (inp && typeof inp === 'object') q = typeof inp.query === 'string' ? inp.query : (inp.query != null ? JSON.stringify(inp.query) : '');
      if (q) queries.push(q);
    } else if (b?.type === 'web_search_tool_result') {
      if (Array.isArray(b.content)) {
        for (const r of b.content) {
          if (!r || typeof r !== 'object') continue;
          results.push({
            title: typeof r.title === 'string' ? r.title : '',
            url: typeof r.url === 'string' ? r.url : '',
            content: typeof r.content === 'string' ? r.content : '',
          });
        }
      } else if (typeof b.content === 'string' && b.content) {
        results.push({ title: '', url: '', content: b.content });
      }
    }
  }
  const hasSearch = queries.length > 0 || results.length > 0;
  const message = { role: 'assistant', content: hasSearch ? formatSearchAsText(text, queries, results) : (text || (toolCalls.length ? null : '')) };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const u = json?.usage ?? {};
  // OpenAI 语义 prompt_tokens 为总输入（含缓存）；Anthropic 三分字段求和还原
  const cr = Number(u.cache_read_input_tokens) || 0;
  const cw = Number(u.cache_creation_input_tokens) || 0;
  const promptTokens = (Number(u.input_tokens) || 0) + cr + cw;
  return {
    id: json?.id ?? `chatcmpl_${randHex()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel ?? json?.model ?? '',
    choices: [{
      index: 0,
      message,
      finish_reason: anthropicStopToFinishReason(json?.stop_reason),
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: promptTokens + (u.output_tokens ?? 0),
      prompt_tokens_details: { cached_tokens: cr },
      // 透传给 OpenAI 客户端的缓存命中数（可选形态，部分客户端能读；与流式路径统一）
      prompt_cached_tokens: cr,
    },
  };
}

export function sendOpenAIError(res, status, message) {
  const type = status === 401 || status === 403 ? 'authentication_error'
    : status === 404 ? 'not_found_error'
    : status === 429 ? 'rate_limit_error'
    : status >= 500 ? 'api_error'
    : 'invalid_request_error';
  const buf = Buffer.from(JSON.stringify({ error: { message, type, code: type } }));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

// 从上游 Anthropic 错误 JSON 里提取 message，失败退回原文截断
export function extractAnthropicErrorMessage(text) {
  try {
    const e = JSON.parse(text);
    return e.error?.message || e.message || text.slice(0, 2000);
  } catch { return text.slice(0, 2000) || 'upstream error'; }
}

// Anthropic SSE 流 → OpenAI SSE chunk 流（状态机）
export async function pipeOpenAIStream(res, upBody, { providerId, model, requestedModel, bytesIn = 0, tFetch = null }) {
  const t0 = Date.now();
  const msgId = `chatcmpl_${randHex()}`;
  const shownModel = requestedModel ?? model;
  let usage = null; // { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
  let finishReason = null;
  let started = false;
  const toolStates = new Map(); // anthropic 块 index → OpenAI tool_call index
  // server 搜索块：server_tool_use 只累积入参 JSON 不外发；web_search_tool_result 的
  // content 完整给出、直接捕获。两者均不进 toolStates（tool_call index 映射不受扰）。
  const serverUseStates = new Map(); // anthropic 块 index → { json: 累积 partial_json }
  const searchResults = []; // { title, url, content }
  let emittedAnyText = false; // 本流中已 emit 过非空 content chunk（搜索降级文本的前导换行依据）
  let toolCounter = 0;
  const marks = [];
  const streamPerf = () => (
    tFetch == null || !marks.length ? null : observeStream(tFetch, marks, usage?.output_tokens ?? 0, performance.now())
  );

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const writeChunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finish = null) => {
    const j = {
      id: msgId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      model: shownModel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    const w = openaiOutputWeight(j);
    if (w > 0) marks.push({ at: performance.now(), w });
    return j;
  };
  const start = () => {
    if (started) return;
    started = true;
    writeChunk(chunk({ role: 'assistant', content: '' }));
  };

  const handler = (ev, data) => {
    if (ev === 'message_start') {
      if (data?.message?.usage) {
        const u = data.message.usage;
        usage = {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        };
      }
      start();
      return;
    }
    if (ev === 'content_block_start') {
      const b = data?.content_block;
      if (b?.type === 'tool_use') {
        start();
        const ti = toolCounter++;
        toolStates.set(data.index ?? 0, ti);
        writeChunk(chunk({ tool_calls: [{ index: ti, id: b.id ?? `call_${randHex()}`, type: 'function', function: { name: b.name ?? '', arguments: '' } }] }));
      } else if (b?.type === 'server_tool_use') {
        serverUseStates.set(data.index ?? 0, { json: '' });
      } else if (b?.type === 'web_search_tool_result') {
        // 该块 content 完整给出、无 delta，直接捕获不 emit
        if (Array.isArray(b.content)) {
          for (const r of b.content) {
            if (!r || typeof r !== 'object') continue;
            searchResults.push({
              title: typeof r.title === 'string' ? r.title : '',
              url: typeof r.url === 'string' ? r.url : '',
              content: typeof r.content === 'string' ? r.content : '',
            });
          }
        } else if (typeof b.content === 'string' && b.content) {
          searchResults.push({ title: '', url: '', content: b.content });
        }
      }
      return;
    }
    if (ev === 'content_block_delta') {
      const d = data?.delta ?? {};
      if (d.type === 'text_delta' && d.text) { start(); emittedAnyText = true; writeChunk(chunk({ content: String(d.text) })); }
      else if (d.type === 'thinking_delta' && d.thinking) { start(); writeChunk(chunk({ reasoning_content: String(d.thinking) })); }
      else if (d.type === 'input_json_delta' && d.partial_json) {
        const su = serverUseStates.get(data.index ?? 0);
        if (su) { su.json += String(d.partial_json); return; } // server tool 入参只收集不外发
        const ti = toolStates.get(data.index ?? 0) ?? 0;
        writeChunk(chunk({ tool_calls: [{ index: ti, function: { arguments: String(d.partial_json) } }] }));
      }
      return;
    }
    if (ev === 'message_delta') {
      // 智谱等方言流式在 message_start 只报占位 0、完整 usage 放 message_delta；
      // 官方形态 message_delta 只带 output_tokens——逐字段 ?? 合并，两者兼容
      if (data?.usage) {
        usage = {
          ...(usage ?? {}),
          input_tokens: data.usage.input_tokens ?? usage?.input_tokens ?? 0,
          output_tokens: data.usage.output_tokens ?? usage?.output_tokens ?? 0,
          cache_read_input_tokens: data.usage.cache_read_input_tokens ?? usage?.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: data.usage.cache_creation_input_tokens ?? usage?.cache_creation_input_tokens ?? 0,
        };
      }
      if (data?.delta?.stop_reason) finishReason = anthropicStopToFinishReason(data.delta.stop_reason);
      return;
    }
    if (ev === 'error') {
      const message = data?.error?.message || 'upstream stream error';
      log(`OpenAI 翻译: 上游流内 error 事件: ${message}`);
      writeChunk({ error: { message, type: 'api_error', code: 'api_error' } });
    }
  };

  // 解析上游 SSE（event: X + data: {...} 帧）
  let buffer = '';
  const consumeFrame = (frame) => {
    let ev = null;
    for (const line of frame.split(/\r?\n/)) {
      const em = line.match(/^event:\s*(.*)$/);
      if (em) { ev = em[1].trim(); continue; }
      const dm = line.match(/^data:\s*(.*)$/);
      if (!dm) continue;
      const data = dm[1].trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        if (j.type) handler(j.type, j);
        else if (ev) handler(ev, j);
      } catch { log(`OpenAI 翻译: 跳过无法解析的 SSE 数据行: ${data.slice(0, 120)}`); }
    }
  };
  try {
    for await (const c of upBody) {
      buffer += Buffer.from(c).toString('utf8');
      let sep;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        consumeFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      }
    }
    if (buffer.trim()) consumeFrame(buffer);
  } catch (e) {
    log(`OpenAI 翻译: 上游流中断: ${e.message}`);
    recordStats({ provider: providerId, model, status: 499, ms: Date.now() - t0, bytesIn, tin: usage?.input_tokens ?? 0, tout: usage?.output_tokens ?? 0, cacheRead: usage?.cache_read_input_tokens ?? 0, cacheWrite: usage?.cache_creation_input_tokens ?? 0, perf: streamPerf() });
    try {
      writeChunk({ error: { message: `upstream stream aborted: ${e.message}`, type: 'api_error', code: 'api_error' } });
      res.write('data: [DONE]\n\n');
    } catch {}
    res.end();
    return;
  }

  try {
    start();
    // 搜索降级文本：query 从累积 JSON try-parse 取 .query、失败退原始串；
    // 已输出过正文则补前导换行，否则顶格（与非流式 formatSearchAsText(mainText) 的分隔语义一致）
    const queries = [];
    for (const st of serverUseStates.values()) {
      let q = st.json;
      try { const j = JSON.parse(st.json); if (typeof j?.query === 'string') q = j.query; } catch {}
      if (q) queries.push(q);
    }
    if (queries.length || searchResults.length) {
      writeChunk(chunk({ content: (emittedAnyText ? '\n' : '') + formatSearchAsText('', queries, searchResults) }));
    }
    writeChunk(chunk({}, finishReason ?? 'stop'));
    // include_usage 约定：最后一个 chunk choices 为空、带 usage。
    // prompt_tokens 为总输入（OpenAI 语义含缓存）：input + cache_read + cache_creation
    const cr = Number(usage?.cache_read_input_tokens) || 0;
    const cw = Number(usage?.cache_creation_input_tokens) || 0;
    const promptTokens = (Number(usage?.input_tokens) || 0) + cr + cw;
    writeChunk({
      id: msgId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: shownModel,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: usage?.output_tokens ?? 0,
        total_tokens: promptTokens + (usage?.output_tokens ?? 0),
        prompt_tokens_details: { cached_tokens: cr },
        prompt_cached_tokens: cr,
      },
    });
    res.write('data: [DONE]\n\n');
  } finally {
    recordStats({ provider: providerId, model, status: 200, ms: Date.now() - t0, bytesIn, tin: usage?.input_tokens ?? 0, tout: usage?.output_tokens ?? 0, cacheRead: usage?.cache_read_input_tokens ?? 0, cacheWrite: usage?.cache_creation_input_tokens ?? 0, perf: streamPerf() });
    res.end();
  }
}
