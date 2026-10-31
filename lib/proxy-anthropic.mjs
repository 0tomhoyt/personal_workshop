// /v1/messages 入口的分发与执行。
//   客户端 Anthropic + 上游 anthropic 协议 → 原样直通（仅替换凭证头与 model 名，
//     响应字节级透传，SSE 不重组）——同协议直通是保真度最高的路径，零翻译损耗。
//   客户端 Anthropic + 上游 openai 协议 → 现有双向翻译器（anth2openai）。
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { requestUpstream, getFetchStart } from './upstream.mjs';
import { bindInboundEndpoint } from './config.mjs';
import { recordStats, observeStream } from './stats.mjs';
import { httpError, anthropicOutputWeight, readBodyLimited, clientTag, pipeSafely, extractUsageBalanced } from './util.mjs';
import { log } from './log.mjs';
import {
  anthropicToOpenAI, openaiToAnthropicMessage, pipeAnthropicStream, sendAnthropicError,
} from './translate/anth2openai.mjs';
import {
  openAIToAnthropicRequest, anthropicToOpenAIChat, pipeOpenAIStream, sendOpenAIError, extractAnthropicErrorMessage,
} from './translate/openai2anth.mjs';
import { searchDialect } from './translate/searchtool.mjs';
import { tryGetConfig } from './config.mjs';

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

// ---- 翻译层非流式响应的读整保险丝 ----------------------------------------
// 翻译路径语义上需要完整响应体，但失控上游（max_tokens 极大的非流式响应）不能无界读入。
// 与入站 MAX_BODY 对齐（同样按 env/配置走），超限断流。流式路径逐块转发无此问题。
const MAX_RESP_BODY = Math.max(1, Number(process.env.CANNBOT_MAX_BODY_MB)
  || Number(tryGetConfig().gateway?.maxBodyMB)
  || 32) * 1024 * 1024;

// 累计读上游响应体：预检 + 边读边检的实现在 util.readBodyLimited（与 models.mjs 目录拉取共用）
async function readUpstreamBody(up) {
  return readBodyLimited(up, MAX_RESP_BODY);
}

// 非流式 JSON 响应读整（翻译需要完整对象）；超限抛错由调用方落 502
async function readUpstreamJson(up) {
  const buf = await readUpstreamBody(up);
  return JSON.parse(buf.toString('utf8'));
}

// 上游错误体读整：只取前 64KB——调用方只 slice(0,2000) 提取 message，足够诊断
async function readUpstreamErrorText(up) {
  const buf = await readUpstreamBody(up);
  return buf.toString('utf8').slice(0, 64 * 1024);
}

// route = { provider, model }；body 为已解析的请求 JSON（可能带 pid/model 前缀，已由调用方解好 model）
export async function handleAnthropicInbound(req, res, bodyBuf, body, route) {
  const provider = bindInboundEndpoint(route.provider, 'anthropic');
  route = { ...route, provider };
  if (provider.protocol === 'anthropic') return passthrough(req, res, bodyBuf, body, route);
  return translated(req, res, bodyBuf, body, route);
}

// ---- 同协议直通 ----------------------------------------------------------

async function passthrough(req, res, bodyBuf, body, route) {
  const { provider, model } = route;
  const t0 = Date.now();
  body.model = model; // 显式 pid/model 时剥前缀；裸名时通常等于原值
  const headers = { 'content-type': 'application/json' };
  // Anthropic 协议头原样带给上游（客户端发过什么版本/beta 就用什么）
  if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  if (req.headers.accept) headers.accept = req.headers.accept;
  const bodyStr = JSON.stringify(body);
  const up = await requestUpstream(provider, '/v1/messages', {
    method: 'POST',
    headers,
    body: bodyStr,
  });

  const st = {
    provider: provider.id,
    model,
    status: up.status, ms: 0,
    bytesIn: bodyBuf?.length ?? 0, bytesOut: 0, tin: 0, tout: 0, cacheRead: 0, cacheWrite: 0,
  };
  const tFetch = getFetchStart(up);
  const marks = [];
  let recorded = false;
  const finishStats = () => {
    if (recorded) return;
    recorded = true;
    st.ms = Date.now() - t0;
    if (tFetch != null && marks.length) st.perf = observeStream(tFetch, marks, st.tout, performance.now());
    recordStats(st);
  };

  const ct = (up.headers.get('content-type') || '').toLowerCase();
  const respHeaders = { 'content-type': up.headers.get('content-type') || 'application/json; charset=utf-8' };
  if (up.headers.get('request-id')) respHeaders['request-id'] = up.headers.get('request-id');
  res.writeHead(up.status, respHeaders);

  if (!up.body) {
    res.end();
    finishStats();
  } else if (ct.includes('text/event-stream')) {
    // SSE 字节级透传；旁路按 event/data 帧抓 usage 与输出到达时间
    let lineBuf = '';
    let currentEvent = null;
    const absorb = (line) => {
      const em = line.match(/^event:\s*(.*)$/);
      if (em) { currentEvent = em[1].trim(); return; }
      const dm = line.match(/^data:\s*(.*)$/);
      if (!dm) return;
      const data = dm[1].trim();
      if (!data || data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const type = j.type ?? currentEvent;
        if (type === 'message_start' && j.message?.usage) {
          const u = j.message.usage;
          st.tin = u.input_tokens ?? st.tin;
          // Anthropic 形态缓存：message_start 里同时带 cache_read / cache_creation
          st.cacheRead = u.cache_read_input_tokens ?? st.cacheRead ?? 0;
          st.cacheWrite = u.cache_creation_input_tokens ?? st.cacheWrite ?? 0;
        }
        if (type === 'message_delta' && j.usage) {
          // 智谱等方言把完整 usage 放在 message_delta（message_start 只报占位 0），
          // 官方形态 message_delta 只带 output_tokens——逐字段 ?? 兜底合并，两者兼容
          st.tout = j.usage.output_tokens ?? st.tout;
          st.tin = j.usage.input_tokens ?? st.tin;
          st.cacheRead = j.usage.cache_read_input_tokens ?? st.cacheRead;
          st.cacheWrite = j.usage.cache_creation_input_tokens ?? st.cacheWrite;
        }
        const w = anthropicOutputWeight(type, j);
        if (w > 0) marks.push({ at: performance.now(), w });
      } catch {}
    };
    // StringDecoder：多字节 UTF-8 字符跨 chunk 边界时不被劈成 U+FFFD
    // （劈开后摸到的 JSON 是坏的，usage 丢、权重算错）
    const dec = new StringDecoder('utf8');
    const tap = new Transform({
      transform(chunk, enc, cb) {
        st.bytesOut += chunk.length;
        lineBuf += dec.write(chunk);
        let idx;
        while ((idx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          absorb(line);
        }
        cb(null, chunk);
      },
      flush(cb) { absorb(lineBuf.trim()); finishStats(); cb(); },
    });
    tap.on('close', finishStats);
    // pipeline 而非裸 pipe：上游断流时未监听的 'error' 会杀死整个网关进程
    const upstream = Readable.fromWeb(up.body);
    // 客户端中途断开：销毁上游端，不悬挂到上游自己超时（悬挂期间照常计费）
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
      finishStats();
    });
    pipeSafely(upstream, tap, res);
  } else {
    // 非流式 JSON（含错误响应）：字节透传，旁路解析 usage。超过 4MB 改为从末尾 64KB
    // 窗口正则提取 usage（与 proxy-openai 同款）：截断后整读解析必败，也不能白持
    // 4MB 死 chunks 到流结束。anthropic 非流式 usage 是顶层扁平对象、通常在响应末尾。
    const SCAN_MAX = 4 * 1024 * 1024;
    const TAIL_WINDOW = 64 * 1024;
    const chunks = [];
    let collected = 0;
    let overflowed = false;
    let tail = '';
    const decTail = new StringDecoder('utf8'); // 同上：tail 按字符取，不能劈开多字节
    const tap = new Transform({
      transform(chunk, enc, cb) {
        st.bytesOut += chunk.length;
        if (!overflowed) {
          if (collected + chunk.length <= SCAN_MAX) { chunks.push(chunk); collected += chunk.length; }
          else { overflowed = true; chunks.length = 0; collected = 0; } // 溢出即弃：flush 只走 tail 分支
        }
        if (overflowed) tail = (tail + decTail.write(chunk)).slice(-TAIL_WINDOW);
        cb(null, chunk);
      },
      flush(cb) {
        try {
          let usage = null;
          if (!overflowed) {
            usage = JSON.parse(Buffer.concat(chunks).toString('utf8')).usage;
          } else {
            usage = extractUsageBalanced(tail);
          }
          if (usage) {
            st.tin = usage.input_tokens ?? 0;
            st.tout = usage.output_tokens ?? 0;
            st.cacheRead = usage.cache_read_input_tokens ?? 0;
            st.cacheWrite = usage.cache_creation_input_tokens ?? 0;
          }
        } catch {}
        finishStats();
        cb();
      },
    });
    tap.on('close', finishStats);
    // 同上：上游断流不能让整个进程崩 + 客户端断开要销毁上游端
    const upstream = Readable.fromWeb(up.body);
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
      finishStats();
    });
    pipeSafely(upstream, tap, res);
  }
  log(`${req.method} /v1/messages ${provider.id}/${model} → ${up.status} ${Date.now() - t0}ms ${clientTag(req)}${ct.includes('text/event-stream') ? ' (stream, direct)' : ' (direct)'}`);
}

// ---- 跨协议翻译（上游 openai） --------------------------------------------

async function translated(req, res, bodyBuf, body, route) {
  const { provider, model } = route;
  const t0 = Date.now();
  body.model = model;

  let payload;
  let thinkingRequested;
  try {
    ({ payload, thinkingRequested } = anthropicToOpenAI(body, { searchDialect: searchDialect(provider) }));
  } catch (e) {
    return sendAnthropicError(res, e.status ?? 400, e.message);
  }

  // Kimi 方言的 $web_search 是服务端执行的 builtin：官方要求调用方把 tool_calls 的
  // arguments 原封回传为 role:tool 消息、由服务端执行搜索——网关代跑该循环。
  const kimiLoopMode = searchDialect(provider) === 'kimi'
    && Array.isArray(payload.tools) && payload.tools.some((t) => t?.type === 'builtin_function' && t?.function?.name === '$web_search');
  if (kimiLoopMode) return kimiSearchLoop(req, res, { provider, payload, bodyBuf, thinkingRequested, t0 });

  const up = await requestUpstream(provider, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!up.ok) {
    const text = await readUpstreamErrorText(up).catch(() => '');
    let message = text.slice(0, 2000) || `upstream HTTP ${up.status}`;
    try {
      const e = JSON.parse(text);
      message = e.error?.message || e.message || message;
    } catch {}
    log(`ANTHROPIC /v1/messages ${provider.id}/${payload.model} → ${up.status} ${Date.now() - t0}ms ${clientTag(req)} (上游错误)`);
    recordStats({ provider: provider.id, model: payload.model, status: up.status, ms: Date.now() - t0, bytesIn: bodyBuf.length });
    return sendAnthropicError(res, up.status, message);
  }

  if (payload.stream) {
    await pipeAnthropicStream(res, up.body, {
      providerId: provider.id, model: payload.model, thinkingRequested,
      bytesIn: bodyBuf.length, tFetch: getFetchStart(up),
    });
  } else {
    // catch 参数出了箭头函数就不可见，失败原因（resp_too_large 等）存到外层变量供文案使用
    let readErr = null;
    const json = await readUpstreamJson(up).catch((e) => { readErr = e; return null; });
    if (json == null) {
      log(`ANTHROPIC /v1/messages ${provider.id}/${payload.model} → 502 ${Date.now() - t0}ms ${clientTag(req)} (非流式响应读整失败/超限: ${readErr?.code ?? ''})`);
      recordStats({ provider: provider.id, model: payload.model, status: 502, ms: Date.now() - t0, bytesIn: bodyBuf.length });
      return sendAnthropicError(res, 502, `上游非流式响应读取失败${readErr?.code === 'resp_too_large' ? `（超 ${MAX_RESP_BODY} 字节上限）` : ''}`);
    }
    const msg = openaiToAnthropicMessage(json, payload.model, thinkingRequested);
    recordStats({
      provider: provider.id, model: payload.model, status: 200, ms: Date.now() - t0, bytesIn: bodyBuf.length,
      tin: json?.usage?.prompt_tokens ?? 0, tout: json?.usage?.completion_tokens ?? 0,
      cacheRead: json?.usage?.prompt_tokens_details?.cached_tokens ?? json?.usage?.prompt_cached_tokens ?? 0,
    });
    sendJson(res, 200, msg);
  }
  log(`ANTHROPIC /v1/messages ${provider.id}/${payload.model} → 200 ${Date.now() - t0}ms ${clientTag(req)}${payload.stream ? ' (stream)' : ''}`);
}

// ---- Kimi $web_search 回传循环 ------------------------------------------------
// 上游全轮非流式（Kimi 官方循环形态只文档化了非流式）；客户端要流式时，末轮由网关按
// pipeAnthropicStream 同款事件形状合成 Anthropic SSE。上限 3 轮防死循环，超限按最后
// 一轮继续翻译（不伪造内容）。

const KIMI_MAX_ROUNDS = 3;

// req 必须显式传进来：本函数不在 translated() 的作用域里（外层那层 req 是兄弟函数的形参）。
// 日志要记调用方 UA，漏了它就是「上游一报错，客户端收到 req is not defined」——
// 错误路径上的 ReferenceError 会把真正的原因（限流/额度）吞掉。
async function kimiSearchLoop(req, res, { provider, payload, bodyBuf, thinkingRequested, t0 }) {
  const clientStream = Boolean(payload.stream);
  payload.stream = false; // 循环内上游一律非流式
  delete payload.stream_options; // stream_options 仅对流式请求合法，非流式带上会被上游拒
  let json = null;
  let hitLimit = false;
  for (let round = 0; round < KIMI_MAX_ROUNDS; round++) {
    const up = await requestUpstream(provider, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), // tools 每轮重带（payload 不动天然保留）
    });
    if (!up.ok) {
      const text = await readUpstreamErrorText(up).catch(() => '');
      let message = text.slice(0, 2000) || `upstream HTTP ${up.status}`;
      try {
        const e = JSON.parse(text);
        message = e.error?.message || e.message || message;
      } catch {}
      log(`ANTHROPIC /v1/messages ${provider.id}/${payload.model} → ${up.status} ${Date.now() - t0}ms ${clientTag(req)} (Kimi 搜索循环上游错误)`);
      recordStats({ provider: provider.id, model: payload.model, status: up.status, ms: Date.now() - t0, bytesIn: bodyBuf.length });
      return sendAnthropicError(res, up.status, message);
    }
    json = await readUpstreamJson(up).catch((e) => null);
    if (json == null) {
      log(`ANTHROPIC /v1/messages ${provider.id}/${payload.model} → 502 ${Date.now() - t0}ms ${clientTag(req)} (Kimi 循环响应读整失败/超限)`);
      recordStats({ provider: provider.id, model: payload.model, status: 502, ms: Date.now() - t0, bytesIn: bodyBuf.length });
      return sendAnthropicError(res, 502, `上游非流式响应读取失败（超 ${MAX_RESP_BODY} 字节上限或非法 JSON）`);
    }
    const choice = json?.choices?.[0];
    const calls = choice?.finish_reason === 'tool_calls'
      ? (choice.message?.tool_calls ?? []).filter((tc) => tc?.function?.name === '$web_search')
      : [];
    if (!calls.length) break;
    if (round === KIMI_MAX_ROUNDS - 1) { hitLimit = true; break; }
    // Kimi 官方要求调用方不执行搜索：assistant 原样带回 tool_calls，
    // role:tool 把 arguments 原封不动字符串回传，由服务端执行
    payload.messages.push({
      role: 'assistant',
      content: choice.message?.content ?? null,
      tool_calls: choice.message.tool_calls,
    });
    for (const tc of calls) {
      payload.messages.push({
        role: 'tool',
        tool_call_id: tc.id ?? '',
        name: tc.function?.name ?? '$web_search',
        content: String(tc.function?.arguments ?? ''),
      });
    }
  }
  if (hitLimit) log(`ANTHROPIC /v1/messages ${provider.id}/${payload.model} ${clientTag(req)}: Kimi 搜索循环达 ${KIMI_MAX_ROUNDS} 轮上限，按最后一轮响应继续翻译`);

  const msg = openaiToAnthropicMessage(json, payload.model, thinkingRequested);
  // 只记末轮 usage：中间轮的搜索 token 已计入各轮 prompt_tokens、无法拆分；perf 无逐块时间戳记 null
  recordStats({
    provider: provider.id, model: payload.model, status: 200, ms: Date.now() - t0, bytesIn: bodyBuf.length,
    tin: json?.usage?.prompt_tokens ?? 0, tout: json?.usage?.completion_tokens ?? 0,
    cacheRead: json?.usage?.prompt_tokens_details?.cached_tokens ?? json?.usage?.prompt_cached_tokens ?? 0,
  });
  if (!clientStream) {
    sendJson(res, 200, msg);
  } else {
    // 合成 Anthropic SSE：message_start（带缓存字段）→ 逐内容块（text 单 delta 全文逐字）→
    // message_delta usage → message_stop。未知块类型按「start 原样块 + stop」透传结构。
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    sse('message_start', {
      type: 'message_start',
      message: {
        id: msg.id, type: 'message', role: 'assistant', model: msg.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { ...msg.usage, output_tokens: 0 },
      },
    });
    msg.content.forEach((b, index) => {
      sse('content_block_start', {
        type: 'content_block_start', index,
        content_block: b.type === 'text' ? { type: 'text', text: '' }
          : b.type === 'thinking' ? { type: 'thinking', thinking: '' }
          : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: {} }
          : b,
      });
      if (b.type === 'text') sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
      else if (b.type === 'thinking') sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      else if (b.type === 'tool_use') sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
      sse('content_block_stop', { type: 'content_block_stop', index });
    });
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: msg.usage });
    sse('message_stop', { type: 'message_stop' });
    res.end();
  }
  log(`ANTHROPIC /v1/messages ${provider.id}/${payload.model} → 200 ${Date.now() - t0}ms ${clientTag(req)} (Kimi 搜索循环${clientStream ? ', stream' : ''})`);
}

// ---- OpenAI 客户端 → anthropic 上游（反向翻译） -----------------------------
// 仅支持 /v1/chat/completions；其余 OpenAI 子路径对 anthropic 上游返回 400。

export async function handleOpenAIToAnthropic(req, res, urlPath, bodyBuf, body, route) {
  if (!urlPath.endsWith('/chat/completions')) {
    return sendOpenAIError(res, 400, `provider「${route.provider.id}」是 anthropic 协议上游，仅支持 /v1/chat/completions 的 OpenAI 翻译转发（收到 ${urlPath}）`);
  }
  const { provider, model } = route;
  const t0 = Date.now();

  let payload;
  try {
    payload = openAIToAnthropicRequest({ ...body, model });
  } catch (e) {
    return sendOpenAIError(res, e.status ?? 400, e.message);
  }

  const up = await requestUpstream(provider, '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!up.ok) {
    const text = await readUpstreamErrorText(up).catch(() => '');
    const message = extractAnthropicErrorMessage(text);
    log(`OPENAI ${urlPath} ${provider.id}/${payload.model} → ${up.status} ${Date.now() - t0}ms ${clientTag(req)} (上游错误)`);
    recordStats({ provider: provider.id, model: payload.model, status: up.status, ms: Date.now() - t0, bytesIn: bodyBuf.length });
    return sendOpenAIError(res, up.status, message);
  }

  if (payload.stream) {
    await pipeOpenAIStream(res, up.body, {
      providerId: provider.id, model: payload.model, requestedModel: model,
      bytesIn: bodyBuf.length, tFetch: getFetchStart(up),
    });
    log(`OPENAI ${urlPath} ${provider.id}/${model} → 200 ${Date.now() - t0}ms ${clientTag(req)} (stream)`);
  } else {
    const json = await readUpstreamJson(up).catch((e) => null);
    if (json == null) {
      log(`OPENAI ${urlPath} ${provider.id}/${payload.model} → 502 ${Date.now() - t0}ms ${clientTag(req)} (非流式响应读整失败/超限)`);
      recordStats({ provider: provider.id, model: payload.model, status: 502, ms: Date.now() - t0, bytesIn: bodyBuf.length });
      return sendOpenAIError(res, 502, `上游非流式响应读取失败（超 ${MAX_RESP_BODY} 字节上限或非法 JSON）`);
    }
    const chat = anthropicToOpenAIChat(json, model);
    recordStats({
      provider: provider.id, model, status: 200, ms: Date.now() - t0, bytesIn: bodyBuf.length,
      tin: json?.usage?.input_tokens ?? 0, tout: json?.usage?.output_tokens ?? 0,
      cacheRead: json?.usage?.cache_read_input_tokens ?? 0, cacheWrite: json?.usage?.cache_creation_input_tokens ?? 0,
    });
    sendJson(res, 200, chat);
    log(`OPENAI ${urlPath} ${provider.id}/${model} → 200 ${Date.now() - t0}ms ${clientTag(req)}`);
  }
}
