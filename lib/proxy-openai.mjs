// OpenAI 协议透传管道：客户端 /v1/* → 上游 /v1/*（openai 协议 provider）。
// 逐字节转发，唯一 body 修改是按 provider 开关注入 stream_options.include_usage
// （只为统计 usage；流式响应多一个 usage chunk，不影响内容）。
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { requestUpstream, getFetchStart } from './upstream.mjs';
import { recordStats, observeStream } from './stats.mjs';
import { httpError, openaiOutputWeight, clientTag, pipeSafely, extractUsageBalanced } from './util.mjs';
import { log } from './log.mjs';

const PASSTHROUGH_HEADERS = ['content-type', 'x-request-id', 'openai-processing-ms', 'openai-version', 'x-logid'];

export async function readRequestBody(req, maxBody) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw httpError(413, `请求体超过 ${maxBody / 1024 / 1024}MB 上限`, 'body_too_large');
    chunks.push(chunk); // 先判超限再入内存，峰值不超过 maxBody
  }
  return Buffer.concat(chunks);
}

// 客户端用 `pid/model` 显式指定上游时，把 body.model 改回上游真实模型名。
// 其余情况（裸名唯一命中或默认上游）不重写 body，保持字节透传。
export function withUpstreamModel(bodyBuf, model) {
  if (model == null || !bodyBuf?.length) return bodyBuf;
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { return bodyBuf; }
  if (!body || typeof body !== 'object' || body.model === model) return bodyBuf;
  body.model = model;
  return Buffer.from(JSON.stringify(body));
}

// 流式 chat 补上 include_usage，否则上游不回 usage，解码速度无法按 token 计算。
// 只改发给上游的请求体；已显式打开的不重复包一层。
function withStreamUsage(urlPath, bodyBuf) {
  if (!bodyBuf?.length || !/\/v1\/(chat\/completions|completions)$/.test(urlPath)) return bodyBuf;
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { return bodyBuf; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.stream) return bodyBuf;
  if (body.stream_options?.include_usage) return bodyBuf;
  body.stream_options = { ...body.stream_options, include_usage: true };
  return Buffer.from(JSON.stringify(body));
}

// route = { provider, model }，model 为上游真实模型名（可能等于请求值）
export async function forward(req, res, urlPath, bodyBuf, route) {
  const { provider, model } = route;
  const t0 = Date.now();
  const headers = { 'content-type': req.headers['content-type'] ?? 'application/json' };
  if (req.headers.accept) headers.accept = req.headers.accept;
  let upstreamBody = req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf;
  if (upstreamBody && provider.streamUsage) upstreamBody = withStreamUsage(urlPath, upstreamBody);
  const up = await requestUpstream(provider, urlPath, {
    method: req.method,
    headers,
    body: upstreamBody,
  });
  const respHeaders = {};
  for (const h of PASSTHROUGH_HEADERS) {
    const v = up.headers.get(h);
    if (v) respHeaders[h] = v;
  }
  res.writeHead(up.status, respHeaders);

  // 流量统计：透传的同时旁路采集字节数、usage，以及流式性能样本
  const st = {
    provider: provider.id,
    model: model ?? '-',
    status: up.status, ms: 0,
    bytesIn: bodyBuf?.length ?? 0, bytesOut: 0, tin: 0, tout: 0,
  };
  const tFetch = getFetchStart(up);
  const marks = []; // { at, w } 每次真正有输出的 SSE 块
  let recorded = false;
  const finishStats = () => {
    if (recorded) return;
    recorded = true;
    st.ms = Date.now() - t0;
    if (tFetch != null && marks.length) st.perf = observeStream(tFetch, marks, st.tout, performance.now());
    recordStats(st);
  };

  if (!up.body) {
    res.end();
    finishStats();
  } else {
    const ct = (up.headers.get('content-type') || '').toLowerCase();
    let tap;
    if (ct.includes('text/event-stream')) {
      // SSE：逐行扫描 data: 帧，抓 usage 与输出 token 的到达时间（解码速度用）
      // StringDecoder：一个多字节 UTF-8 字符（中文/emoji 各 3–4 字节）可能被上游的
      // TCP chunk 边界劈成两半，直接 chunk.toString('utf8') 两半都会变成 U+FFFD，
      // 摸到的 JSON 就是坏的（usage 丢、权重算错，日志里中文乱七八糟）。decoder 会
      // 把不完整的尾字节留到下一次 write，跨 chunk 拼回原字符。
      const dec = new StringDecoder('utf8');
      let lineBuf = '';
      const absorbSse = (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
          const j = JSON.parse(data);
          if (j.usage) {
            st.tin = j.usage.prompt_tokens ?? st.tin;
            st.tout = j.usage.completion_tokens ?? st.tout;
            // OpenAI 形态缓存命中：prompt_tokens_details.cached_tokens（部分上游在顶层 prompt_cached_tokens）
            st.cacheRead = j.usage.prompt_tokens_details?.cached_tokens ?? j.usage.prompt_cached_tokens ?? st.cacheRead ?? 0;
          }
          const w = openaiOutputWeight(j);
          if (w > 0) marks.push({ at: performance.now(), w });
        } catch {}
      };
      tap = new Transform({
        transform(chunk, enc, cb) {
          st.bytesOut += chunk.length;
          lineBuf += dec.write(chunk);
          let idx;
          while ((idx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, idx).trim();
            lineBuf = lineBuf.slice(idx + 1);
            absorbSse(line);
          }
          cb(null, chunk);
        },
        flush(cb) { absorbSse(lineBuf.trim()); finishStats(); cb(); },
      });
    } else {
      // JSON：整体收集后解析 usage；超过 4MB 改为从末尾 64KB 窗口正则提取 usage，
      // 避免对超长响应截断后 JSON.parse 静默失败（旧实现丢块后解析必败，usage 计 0）
      const SCAN_MAX = 4 * 1024 * 1024;
      const TAIL_WINDOW = 64 * 1024;
      const chunks = [];
      let collected = 0;
      let overflowed = false;
      let tail = '';
      const decTail = new StringDecoder('utf8'); // 同上：tail 也是按字符取的，不能劈开多字节
      tap = new Transform({
        transform(chunk, enc, cb) {
          st.bytesOut += chunk.length;
          if (!overflowed) {
            if (collected + chunk.length <= SCAN_MAX) { chunks.push(chunk); collected += chunk.length; }
            else { overflowed = true; chunks.length = 0; collected = 0; } // 溢出即弃：flush 只走 tail 分支，≤4MB 死 chunks 不持有到流结束
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
              st.tin = usage.prompt_tokens ?? 0;
              st.tout = usage.completion_tokens ?? 0;
              st.cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cached_tokens ?? 0;
            }
          } catch {}
          finishStats();
          cb();
        },
      });
    }
    tap.on('close', finishStats); // 客户端中途断开也计入
    // pipeline 而非裸 pipe：上游断流时 Readable.fromWeb 会 emit 'error'，裸 pipe 不
    // 转发错误 → 无人监听的 'error' 直接杀死整个网关进程（所有客户端一起断）。
    // pipeline 负责在各段之间转发并销毁，回调里收尾即可。
    const upstream = Readable.fromWeb(up.body);
    // 客户端中途断开：res 先关，上游那端必须显式销毁，否则连接悬挂到上游自己超时
    // （订阅按 token 计费，悬挂期间上游还在生成，白烧配额）。
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
      finishStats();
    });
    pipeSafely(upstream, tap, res);
  }
  log(`${req.method} ${urlPath} ${provider.id}/${st.model} → ${up.status} ${Date.now() - t0}ms ${clientTag(req)}`);
}
