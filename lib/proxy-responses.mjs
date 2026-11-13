// Codex Responses API 入站管道。
//
//   Responses 客户端 + openai-responses 上游 → /v1/responses 原样直通
//   Responses 客户端 + openai 上游          → Chat Completions 双向转换
//   Responses 客户端 + anthropic 上游       → 明确报不支持（避免静默降级）
//
// Codex 当前只使用 Responses API。Chat 上游转换覆盖文本、reasoning_content、
// function tools、namespace tools、工具调用与多轮工具结果回传。
import { requestUpstream, getFetchStart } from './upstream.mjs';
import { randomUUID } from 'node:crypto';
import { bindInboundEndpoint } from './config.mjs';
import { recordStats, observeStream } from './stats.mjs';
import {
  httpError,
  readBodyLimited,
  clientTag,
  openaiOutputWeight,
} from './util.mjs';
import { forward, withUpstreamModel } from './proxy-openai.mjs';
import { log } from './log.mjs';

const MAX_RESP_BODY = 32 * 1024 * 1024;
const newId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      return typeof part?.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function convertTools(tools) {
  const converted = [];
  const canonical = new Map();
  if (!Array.isArray(tools)) return { converted, canonical };

  const addFunction = (name, description, parameters, namespace = null) => {
    if (!name) return;
    const chatName = namespace ? `${namespace}__${name}` : name;
    converted.push({
      type: 'function',
      function: {
        name: chatName,
        description: typeof description === 'string' ? description : '',
        parameters: parameters && typeof parameters === 'object'
          ? parameters
          : { type: 'object', properties: {} },
      },
    });
    canonical.set(chatName, { namespace, name });
  };

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function') {
      addFunction(tool.name, tool.description, tool.parameters);
    } else if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        if (nested?.type === 'function') {
          addFunction(nested.name, nested.description, nested.parameters, tool.name);
        }
      }
    }
  }
  return { converted, canonical };
}

export function responsesToChat(body, upstreamModel, chatOptions = {}) {
  const messages = [];
  const { converted: tools, canonical } = convertTools(body.tools);
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  let input = body.input;
  if (typeof input === 'string') input = [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input)) input = [];

  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const type = item.type || 'message';
    if (type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role || 'user';
      messages.push({ role, content: textFromContent(item.content) });
    } else if (type === 'function_call') {
      const namespace = typeof item.namespace === 'string' ? item.namespace : null;
      const name = namespace ? `${namespace}__${item.name}` : item.name;
      const args = typeof item.arguments === 'string'
        ? item.arguments
        : JSON.stringify(item.arguments ?? {});
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || newId('call'),
          type: 'function',
          function: { name, arguments: args },
        }],
      });
    } else if (type === 'function_call_output') {
      const output = typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output ?? '');
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id,
        content: output,
      });
    }
  }

  const chat = {
    ...chatOptions,
    model: upstreamModel,
    messages,
    stream: body.stream !== false,
    enable_thinking: chatOptions.enable_thinking ?? true,
    chat_template_kwargs: {
      ...(chatOptions.chat_template_kwargs || {}),
      enable_thinking: chatOptions.chat_template_kwargs?.enable_thinking ?? true,
    },
  };
  if (tools.length) {
    chat.tools = tools;
    if (body.tool_choice != null) {
      let choice = body.tool_choice;
      if (choice?.type === 'function' && choice.name) {
        const namespace = choice.namespace ? `${choice.namespace}__` : '';
        choice = {
          ...choice,
          name: `${namespace}${choice.name}`,
        };
      }
      chat.tool_choice = choice;
    }
    if (typeof body.parallel_tool_calls === 'boolean') {
      chat.parallel_tool_calls = body.parallel_tool_calls;
    }
  }
  if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens;
  if (body.temperature != null) chat.temperature = body.temperature;
  if (body.top_p != null) chat.top_p = body.top_p;
  return { chat, canonical };
}

function usageFromChat(usage) {
  const input = Number(usage?.prompt_tokens || 0);
  const output = Number(usage?.completion_tokens || 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Number(usage?.prompt_tokens_details?.cached_tokens || 0) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number(usage?.completion_tokens_details?.reasoning_tokens || 0) },
    total_tokens: Number(usage?.total_tokens || input + output),
  };
}

function responseObject(body, model, id, output, status = 'completed', usage = null) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    completed_at: status === 'completed' ? Math.floor(Date.now() / 1000) : null,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model,
    output,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: body.reasoning && typeof body.reasoning === 'object'
      ? body.reasoning
      : { effort: null, summary: null },
    store: false,
    temperature: body.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: body.tools ?? [],
    top_p: body.top_p ?? null,
    truncation: 'disabled',
    usage: usage || {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    user: null,
    metadata: body.metadata ?? null,
  };
}

function writeSse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function makeStats(route, bodyBuf, status) {
  return {
    provider: route.provider.id,
    model: route.model ?? '-',
    status,
    ms: 0,
    bytesIn: bodyBuf?.length ?? 0,
    bytesOut: 0,
    tin: 0,
    tout: 0,
  };
}

function statsFinisher(stats, t0, tFetch, marks) {
  let recorded = false;
  return () => {
    if (recorded) return;
    recorded = true;
    stats.ms = Date.now() - t0;
    if (tFetch != null && marks.length) {
      stats.perf = observeStream(tFetch, marks, stats.tout, performance.now());
    }
    recordStats(stats);
  };
}

async function sendUpstreamError(res, up) {
  const text = (await readBodyLimited(up, 256 * 1024, 'upstream_error_too_large')).toString('utf8');
  res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
  res.end(text);
}

function outputItemsFromChat(message, canonical) {
  const output = [];
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: newId('rs'),
      status: 'completed',
      summary: [],
      content: [{ type: 'reasoning_text', text: message.reasoning_content }],
      encrypted_content: null,
    });
  }
  if (typeof message?.content === 'string' && message.content) {
    output.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      phase: 'final_answer',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: message.content,
        annotations: [],
        logprobs: [],
      }],
    });
  }
  for (const call of message?.tool_calls || []) {
    const chatName = call?.function?.name;
    const original = canonical.get(chatName);
    if (!original) continue;
    const item = {
      id: newId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: call.id || newId('call'),
      name: original.name,
      arguments: call.function?.arguments || '',
    };
    if (original.namespace) item.namespace = original.namespace;
    output.push(item);
  }
  return output;
}

async function translated(req, res, bodyBuf, body, route) {
  const { provider, model } = route;
  const t0 = Date.now();
  const { chat, canonical } = responsesToChat(body, model, provider.chatOptions);
  const up = await requestUpstream(provider, '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: chat.stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(chat),
  });
  const stats = makeStats(route, bodyBuf, up.status);
  const tFetch = getFetchStart(up);
  const marks = [];
  const finishStats = statsFinisher(stats, t0, tFetch, marks);

  if (!up.ok) {
    await sendUpstreamError(res, up);
    finishStats();
    return;
  }

  if (!chat.stream) {
    const result = JSON.parse((await readBodyLimited(up, MAX_RESP_BODY, 'responses_too_large')).toString('utf8'));
    const choice = result.choices?.[0] || {};
    const output = outputItemsFromChat(choice.message || {}, canonical);
    if (result.usage) {
      stats.tin = Number(result.usage.prompt_tokens || 0);
      stats.tout = Number(result.usage.completion_tokens || 0);
    }
    const payload = responseObject(
      body,
      body.model,
      newId('resp'),
      output,
      'completed',
      usageFromChat(result.usage),
    );
    const buf = Buffer.from(JSON.stringify(payload));
    stats.bytesOut = buf.length;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
    });
    res.end(buf);
    finishStats();
    log(`POST /v1/responses ${provider.id}/${model} → 200 (translated json) ${clientTag(req)}`);
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
  });
  const responseId = newId('resp');
  let sequence = 0;
  const outputItems = [];
  const reasoningParts = [];
  let reasoningItem = null;
  const textParts = [];
  let messageItem = null;
  const toolCalls = new Map();
  let upstreamUsage = null;

  const created = responseObject(body, body.model, responseId, [], 'in_progress');
  writeSse(res, { type: 'response.created', sequence_number: sequence++, response: created });
  writeSse(res, { type: 'response.in_progress', sequence_number: sequence++, response: created });

  const send = (event) => {
    const buf = Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    stats.bytesOut += buf.length;
    res.write(buf);
  };

  const finishReasoning = () => {
    if (!reasoningItem) return;
    reasoningItem.status = 'completed';
    reasoningItem.content = [{ type: 'reasoning_text', text: reasoningParts.join('') }];
    send({
      type: 'response.output_item.done',
      sequence_number: sequence++,
      output_index: outputItems.length,
      item: reasoningItem,
    });
    outputItems.push(reasoningItem);
    reasoningItem = null;
  };

  const absorb = (chunk) => {
    if (chunk.usage) {
      upstreamUsage = chunk.usage;
      stats.tin = Number(chunk.usage.prompt_tokens || stats.tin);
      stats.tout = Number(chunk.usage.completion_tokens || stats.tout);
    }
    const delta = chunk.choices?.[0]?.delta || {};
    const weight = openaiOutputWeight(chunk);
    if (weight > 0) marks.push({ at: performance.now(), w: weight });

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (!reasoningItem) {
        reasoningItem = {
          type: 'reasoning',
          id: newId('rs'),
          status: 'in_progress',
          summary: [],
          content: [],
        };
        send({
          type: 'response.output_item.added',
          sequence_number: sequence++,
          output_index: outputItems.length,
          item: reasoningItem,
        });
      }
      reasoningParts.push(delta.reasoning_content);
      send({
        type: 'response.reasoning_text.delta',
        sequence_number: sequence++,
        item_id: reasoningItem.id,
        output_index: outputItems.length,
        content_index: 0,
        delta: delta.reasoning_content,
      });
    }

    if (typeof delta.content === 'string' && delta.content) {
      finishReasoning();
      if (!messageItem) {
        messageItem = {
          type: 'message',
          id: newId('msg'),
          status: 'in_progress',
          role: 'assistant',
          phase: 'final_answer',
          content: [],
        };
        send({
          type: 'response.output_item.added',
          sequence_number: sequence++,
          output_index: outputItems.length,
          item: messageItem,
        });
        send({
          type: 'response.content_part.added',
          sequence_number: sequence++,
          item_id: messageItem.id,
          output_index: outputItems.length,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
        });
      }
      textParts.push(delta.content);
      send({
        type: 'response.output_text.delta',
        sequence_number: sequence++,
        item_id: messageItem.id,
        output_index: outputItems.length,
        content_index: 0,
        delta: delta.content,
        logprobs: [],
      });
    }

    for (const tc of delta.tool_calls || []) {
      const index = Number(tc.index || 0);
      const call = toolCalls.get(index) || { id: '', name: '', arguments: '' };
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
      toolCalls.set(index, call);
    }
  };

  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let cancelled = false;
  res.on('close', () => {
    if (!res.writableEnded && !cancelled) {
      cancelled = true;
      reader.cancel().catch(() => {});
    }
    finishStats();
  });

  try {
    while (!cancelled) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, index).trim();
        lineBuffer = lineBuffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { absorb(JSON.parse(data)); } catch {}
      }
    }
    if (!cancelled) {
      lineBuffer += decoder.decode();
      const tail = lineBuffer.trim();
      if (tail.startsWith('data:')) {
        const data = tail.slice(5).trim();
        if (data && data !== '[DONE]') {
          try { absorb(JSON.parse(data)); } catch {}
        }
      }
      finishReasoning();
      if (messageItem) {
        const text = textParts.join('');
        messageItem.status = 'completed';
        messageItem.content = [{
          type: 'output_text',
          text,
          annotations: [],
          logprobs: [],
        }];
        send({
          type: 'response.output_text.done',
          sequence_number: sequence++,
          item_id: messageItem.id,
          output_index: outputItems.length,
          content_index: 0,
          text,
          logprobs: [],
        });
        send({
          type: 'response.content_part.done',
          sequence_number: sequence++,
          item_id: messageItem.id,
          output_index: outputItems.length,
          content_index: 0,
          part: {
            type: 'output_text',
            text,
            annotations: [],
            logprobs: [],
          },
        });
        send({
          type: 'response.output_item.done',
          sequence_number: sequence++,
          output_index: outputItems.length,
          item: messageItem,
        });
        outputItems.push(messageItem);
      }

      for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        const original = canonical.get(call.name);
        if (!original) continue;
        const item = {
          id: newId('fc'),
          type: 'function_call',
          status: 'in_progress',
          call_id: call.id || newId('call'),
          name: original.name,
          arguments: '',
        };
        if (original.namespace) item.namespace = original.namespace;
        const outputIndex = outputItems.length;
        send({
          type: 'response.output_item.added',
          sequence_number: sequence++,
          output_index: outputIndex,
          item,
        });
        if (call.arguments) {
          send({
            type: 'response.function_call_arguments.delta',
            sequence_number: sequence++,
            item_id: item.id,
            output_index: outputIndex,
            delta: call.arguments,
          });
        }
        send({
          type: 'response.function_call_arguments.done',
          sequence_number: sequence++,
          item_id: item.id,
          output_index: outputIndex,
          arguments: call.arguments,
        });
        item.status = 'completed';
        item.arguments = call.arguments;
        send({
          type: 'response.output_item.done',
          sequence_number: sequence++,
          output_index: outputIndex,
          item,
        });
        outputItems.push(item);
      }

      send({
        type: 'response.completed',
        sequence_number: sequence++,
        response: responseObject(
          body,
          body.model,
          responseId,
          outputItems,
          'completed',
          usageFromChat(upstreamUsage),
        ),
      });
      res.end();
      finishStats();
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  log(`POST /v1/responses ${provider.id}/${model} → ${up.status} (translated stream) ${clientTag(req)}`);
}

export async function handleResponsesInbound(req, res, bodyBuf, body, route) {
  const provider = bindInboundEndpoint(route.provider, 'responses');
  const boundRoute = { ...route, provider };
  if (provider.protocol === 'openai-responses') {
    return forward(
      req,
      res,
      '/v1/responses',
      withUpstreamModel(bodyBuf, route.model),
      boundRoute,
    );
  }
  if (provider.protocol === 'openai') {
    return translated(req, res, bodyBuf, body, boundRoute);
  }
  throw httpError(
    501,
    `Codex Responses 暂不支持 provider「${provider.id}」的 ${provider.protocol} 协议`,
    'responses_protocol_unsupported',
  );
}
