// Anthropic Messages → OpenAI Chat Completions 方向的翻译（客户端 Anthropic、上游 OpenAI 时使用）。
// 红线：内容逐字保留，只换结构。已知损耗点与取舍：
//   - thinking / redacted_thinking / document 块在上游 OpenAI 侧无对应，历史消息中忽略；
//     请求开启 thinking 时，上游 reasoning_content 仍会翻译回 thinking 块
//   - tool_result 内容里的非文本块（image 等）：OpenAI role:tool 的 content 只收字符串，
//     文本逐字拼接保留、其余块丢弃并 log 留痕（Claude Code 截图回传等场景可见损耗）
//   - tool_choice any→required（语义等价）；top_k 直接透传
import { httpError, randHex, openaiOutputWeight, sendJson } from '../util.mjs';
import { recordStats, observeStream } from '../stats.mjs';
import { log } from '../log.mjs';
import { zhipuSearchTool, kimiSearchTool, zhipuResultBlocks } from './searchtool.mjs';

export function anthropicErrorType(status) {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  if (status === 400) return 'invalid_request_error';
  return 'api_error';
}

export function sendAnthropicError(res, status, message) {
  sendJson(res, status, { type: 'error', error: { type: anthropicErrorType(status), message } });
}

// Anthropic 请求体 → OpenAI chat.completions 请求体。
// opts.searchDialect 为上游搜索方言（'zhipu' | 'kimi' | null，见 searchtool.mjs）：
// web_search server tool 只有智谱/Kimi 方言能映射，其余上游丢弃并留痕。
export function anthropicToOpenAI(body, opts = {}) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Anthropic 请求体不是 JSON 对象', 'invalid_request_error');
  if (!body.model) throw httpError(400, 'Anthropic 请求缺少 model 字段', 'invalid_request_error');

  const messages = [];
  if (body.system) {
    const text = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system : [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n');
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }
    const parts = [];
    const toolCalls = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } });
      } else if (b.type === 'image' && b.source?.type === 'url') {
        parts.push({ type: 'image_url', image_url: { url: b.source.url } });
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === 'tool_result') {
        let content;
        if (typeof b.content === 'string') content = b.content;
        else if (Array.isArray(b.content)) {
          const dropped = b.content.filter((x) => x && x.type !== 'text').map((x) => x.type || 'unknown');
          if (dropped.length) log(`Anthropic 翻译: tool_result ${b.tool_use_id ?? '?'} 含 OpenAI 侧无对应的块，已丢弃: ${dropped.join(',')}`);
          content = b.content
            .filter((x) => x?.type === 'text')
            .map((x) => x.text)
            .join('\n');
        } else content = '';
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
      }
      // thinking / redacted_thinking / document 块：OpenAI 侧无对应，忽略
    }
    if (role === 'assistant') {
      const msg = { role: 'assistant' };
      msg.content = parts.length
        ? (parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts)
        : (toolCalls.length ? null : '');
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else if (parts.length) {
      messages.push({
        role: 'user',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      });
    }
  }

  const payload = { model: body.model, messages, stream: Boolean(body.stream) };
  if (body.max_tokens != null) payload.max_tokens = body.max_tokens;
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.top_p != null) payload.top_p = body.top_p;
  if (body.top_k != null) payload.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    const dialect = opts.searchDialect ?? null;
    const fnTools = [];
    const searchTools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue;
      // 三分类：① function 工具（显式 type，或有 name 且带 input_schema 的常规客户端工具）
      if (t.name && (t.type === 'function' || t.input_schema != null)) {
        fnTools.push({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        });
        continue;
      }
      // ② server 搜索工具：同时覆盖带 name 与只有 type:'web_search_20250305' 两种 wire 形态
      if (/^web_search(_\d{8})?$/.test(String(t.type || '')) || t.name === 'web_search') {
        if (dialect === 'zhipu') searchTools.push(zhipuSearchTool(t));
        else if (dialect === 'kimi') searchTools.push(kimiSearchTool());
        else log(`Anthropic→OpenAI 翻译: 上游非智谱/Kimi 方言，搜索工具无法映射（已丢弃）: type=${t.type ?? '-'}, name=${t.name ?? '-'}`);
        continue;
      }
      // ③ 其余（computer_* 等未知 server tool、无 name 杂项）：丢弃并留痕，请求继续
      log(`Anthropic→OpenAI 翻译: 丢弃无法识别的工具: type=${t.type ?? '(无)'}, name=${t.name ?? '(无)'}`);
    }
    const tools = [...fnTools, ...searchTools];
    if (tools.length) {
      payload.tools = tools;
      // tool_choice 仅在存在 function 工具时映射（纯搜索工具不设：上游混用行为未文档化，保守）
      if (fnTools.length) {
        const tc = body.tool_choice;
        if (tc?.type === 'auto') payload.tool_choice = 'auto';
        else if (tc?.type === 'any') payload.tool_choice = 'required';
        else if (tc?.type === 'none') payload.tool_choice = 'none';
        else if (tc?.type === 'tool' && tc.name) payload.tool_choice = { type: 'function', function: { name: tc.name } };
      }
    }
  }
  if (payload.stream) payload.stream_options = { include_usage: true };

  const thinkingRequested = body.thinking?.type === 'enabled';
  return { payload, thinkingRequested };
}

function mapFinishReason(fr) {
  if (fr === 'tool_calls') return 'tool_use';
  if (fr === 'length') return 'max_tokens';
  if (fr === 'content_filter') return 'end_turn';
  return 'end_turn';
}

// OpenAI usage → Anthropic usage。OpenAI 语义 prompt_tokens 为总输入、已含缓存命中，
// 而 Anthropic 语义 input_tokens 不含缓存 token（与 cache_read/cache_creation 分列）——
// 不减会造成下游按 input+cache_read+cache_creation 汇总时重复计数。
function anthropicUsage(u) {
  const cached = Math.max(0, Number(u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cached_tokens ?? 0) || 0);
  return {
    input_tokens: Math.max(0, (Number(u?.prompt_tokens ?? 0) || 0) - cached),
    output_tokens: u?.completion_tokens ?? 0,
    cache_creation_input_tokens: 0, // OpenAI 形态无缓存写字段
    cache_read_input_tokens: cached,
  };
}

// OpenAI 非流式响应 → Anthropic message。
// msg.content 容错 string | typed blocks 数组（智谱官方 schema 为顶层 web_search 数组 +
// 字符串 content；社区旧形态为 content blocks 数组，两种都兼容）；顶层 web_search 数组
// 同样收集。搜索结果经 zhipuResultBlocks 追加为独立块对，回显文本块保持纯字符串。
export function openaiToAnthropicMessage(json, model, thinkingRequested) {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (thinkingRequested && msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: String(msg.reasoning_content) });
  }
  const searchResults = [];
  const collectSearch = (r) => { if (r && typeof r === 'object') searchResults.push(r); };
  const texts = [];
  if (typeof msg.content === 'string') {
    if (msg.content) texts.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') { if (b.text) texts.push(b.text); continue; }
      if (b.type === 'web_search') { collectSearch(b); continue; }
      // 未知块但带字符串 text：按文本降级，不丢内容；其余未知块跳过（不依赖其推进任何状态）
      if (typeof b.text === 'string' && b.text) texts.push(b.text);
    }
  }
  if (texts.length) content.push({ type: 'text', text: texts.join('') });
  for (const tc of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id ?? `toolu_${randHex()}`, name: tc.function?.name ?? '', input });
  }
  if (Array.isArray(json?.web_search)) for (const r of json.web_search) collectSearch(r);
  if (searchResults.length) content.push(...zhipuResultBlocks(searchResults));
  return {
    id: `msg_${randHex()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsage(json?.usage),
  };
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// OpenAI SSE 流 → Anthropic SSE 流（状态机：thinking 块 → text 块 → tool_use 块）
export async function pipeAnthropicStream(res, upBody, { providerId, model, thinkingRequested, bytesIn = 0, tFetch = null }) {
  const t0 = Date.now();
  const msgId = `msg_${randHex()}`;
  let messageStarted = false;
  let nextIndex = 0;
  let openBlock = null; // { type, index }
  let usage = null;
  let finishReason = null;
  const marks = [];
  const streamPerf = () => (
    tFetch == null || !marks.length ? null : observeStream(tFetch, marks, usage?.completion_tokens ?? 0, performance.now())
  );

  // message_start 的缓存字段：OpenAI 上游 usage 通常在最后一个 chunk 才到，首个内容块时
  // 多为 0——容忍 0，权威数值由末尾 message_delta 给出。
  const startMessage = (inputTokens = 0, cachedTokens = 0) => {
    if (messageStarted) return;
    messageStarted = true;
    sseWrite(res, 'message_start', {
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cachedTokens },
      },
    });
  };
  const closeBlock = () => {
    if (openBlock) {
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: openBlock.index });
      openBlock = null;
    }
  };
  const ensureBlock = (type, block) => {
    if (openBlock?.type === type) return openBlock.index;
    closeBlock();
    startMessage();
    const index = nextIndex++;
    sseWrite(res, 'content_block_start', { type: 'content_block_start', index, content_block: block });
    openBlock = { type, index };
    return index;
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const toolStates = new Map(); // OpenAI tool_call.index → Anthropic 块序号
  const searchResults = []; // 智谱搜索结果（顶层 web_search 数组 / delta.content 数组内 web_search 项）
  // 收尾发射搜索块对：必须在 closeBlock() 之后调用，index 直取 nextIndex++，
  // 不经过 ensureBlock/toolStates——绝不扰动 thinking→text→tool_use 块序与 tool_call index 映射。
  const emitSearchBlocks = () => {
    if (!searchResults.length) return;
    startMessage();
    for (const b of zhipuResultBlocks(searchResults)) {
      const index = nextIndex++;
      sseWrite(res, 'content_block_start', { type: 'content_block_start', index, content_block: b });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index });
    }
  };
  const handler = (c) => {
    // 上游流内 error 帧（OpenAI 形态 data: {"error":...}，无 choices）：转发给客户端，
    // 否则会被下面的 !choice 分支吞掉、流以「成功但截断」收场（与 openai2anth 的 error 事件处理对齐）
    if (c?.error) {
      const message = c.error.message || 'upstream stream error';
      log(`Anthropic 翻译: 上游流内 error 帧: ${message}`);
      startMessage();
      closeBlock();
      sseWrite(res, 'error', { type: 'error', error: { type: 'api_error', message } });
      return;
    }
    if (c?.usage) usage = c.usage; // OpenAI 形态 usage（含 prompt_tokens_details.cached_tokens 则透传）
    // 智谱搜索结果也可能出现在 chunk 顶层 web_search 数组（未经核验的形态，容错收集）
    if (Array.isArray(c?.web_search)) for (const r of c.web_search) { if (r && typeof r === 'object') searchResults.push(r); }
    const choice = Array.isArray(c?.choices) ? c.choices[0] : null;
    if (!choice) return;
    const d = choice.delta ?? {};
    const w = openaiOutputWeight(c);
    if (w > 0) marks.push({ at: performance.now(), w });
    const au = usage ? anthropicUsage(usage) : null;
    startMessage(au?.input_tokens ?? 0, au?.cache_read_input_tokens ?? 0);
    if (d.reasoning_content && thinkingRequested) {
      const idx = ensureBlock('thinking', { type: 'thinking', thinking: '' });
      sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: String(d.reasoning_content) } });
    }
    if (typeof d.content === 'string') {
      if (d.content) {
        const idx = ensureBlock('text', { type: 'text', text: '' });
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: d.content } });
      }
    } else if (Array.isArray(d.content)) {
      // 传闻流式形态：delta.content 为数组（text 与 web_search 块混排）。逐项分发，
      // 收集不到搜索项时仅缺搜索块，正文文本绝不丢。
      for (const b of d.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          if (!b.text) continue;
          const idx = ensureBlock('text', { type: 'text', text: '' });
          sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: b.text } });
        } else if (b.type === 'web_search') {
          searchResults.push(b); // 收集不进文本
        } else if (typeof b.text === 'string' && b.text) {
          const idx = ensureBlock('text', { type: 'text', text: '' });
          sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: b.text } });
        }
      }
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const key = tc.index ?? 0;
        let st = toolStates.get(key);
        if (!st) {
          const idx = ensureBlock('tool_use', { type: 'tool_use', id: tc.id ?? `toolu_${randHex()}`, name: tc.function?.name ?? '', input: {} });
          st = { index: idx };
          toolStates.set(key, st);
        }
        const frag = tc.function?.arguments;
        if (frag) {
          sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: st.index, delta: { type: 'input_json_delta', partial_json: String(frag) } });
        }
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  // 解析上游 SSE：按帧切分，取 data: 行
  let buffer = '';
  try {
    for await (const chunk of upBody) {
      buffer += Buffer.from(chunk).toString('utf8');
      let sep;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
        for (const line of frame.split(/\r?\n/)) {
          const m = line.match(/^data:\s*(.*)$/);
          if (!m) continue;
          const data = m[1].trim();
          if (!data || data === '[DONE]') continue;
          try { handler(JSON.parse(data)); }
          catch { log(`Anthropic 翻译: 跳过无法解析的 SSE 数据行: ${data.slice(0, 120)}`); }
        }
      }
    }
    // 冲刷残余帧
    for (const line of buffer.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) continue;
      const data = m[1].trim();
      if (!data || data === '[DONE]') continue;
      try { handler(JSON.parse(data)); } catch {}
    }
  } catch (e) {
    log(`Anthropic 流中断: ${e.message}`);
    recordStats({ provider: providerId, model, status: 499, ms: Date.now() - t0, bytesIn, tout: usage?.completion_tokens ?? 0, tin: usage?.prompt_tokens ?? 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cached_tokens ?? 0, perf: streamPerf() });
    try {
      startMessage();
      closeBlock();
      emitSearchBlocks();
      sseWrite(res, 'error', { type: 'error', error: { type: 'api_error', message: `upstream stream aborted: ${e.message}` } });
    } catch {}
    res.end();
    return;
  }

  try {
    startMessage();
    closeBlock();
    emitSearchBlocks();
    sseWrite(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
      usage: anthropicUsage(usage),
    });
    sseWrite(res, 'message_stop', { type: 'message_stop' });
  } finally {
    recordStats({ provider: providerId, model, status: 200, ms: Date.now() - t0, bytesIn, tin: usage?.prompt_tokens ?? 0, tout: usage?.completion_tokens ?? 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cached_tokens ?? 0, perf: streamPerf() });
    res.end();
  }
}
