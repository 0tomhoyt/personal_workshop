// 共享小工具：错误构造、随机 id、JWT 解码、输出 token 权重
import { randomBytes } from 'node:crypto';

// 带 status/code 的业务错误，主入口按 e.status 回给客户端
export function httpError(status, message, code = 'gateway_error') {
  return Object.assign(new Error(message), { status, code });
}

export const randHex = (n = 12) => randomBytes(n).toString('hex');

// 解析 JWT payload（仅用于读取 exp/userId 等声明，不做签名校验）
export function b64urlJson(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

// 输出文本的 token 权重。没有各模型自己的 tokenizer，用字符近似：
// CJK / 假名 / 全角区按 1 token，其余按约 4 字 1 token。只用来把上游的
// completion_tokens 摊到各个 SSE 块，总和之后会归一化成上游计数。
export function textWeight(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e80 ? 4 : 1;
  return w;
}

// OpenAI chat chunk / 响应里的输出文本权重（content + reasoning + tool_calls）
export function openaiOutputWeight(j) {
  const choice = Array.isArray(j?.choices) ? j.choices[0] : null;
  if (!choice) return 0;
  const d = choice.delta || {};
  let w = 0;
  if (typeof d.content === 'string') w += textWeight(d.content);
  if (typeof d.reasoning_content === 'string') w += textWeight(d.reasoning_content);
  if (typeof d.text === 'string') w += textWeight(d.text);
  if (typeof choice.text === 'string') w += textWeight(choice.text);
  if (Array.isArray(d.tool_calls)) {
    for (const tc of d.tool_calls) {
      if (typeof tc?.function?.name === 'string') w += textWeight(tc.function.name);
      if (typeof tc?.function?.arguments === 'string') w += textWeight(tc.function.arguments);
    }
  }
  return w;
}

// Anthropic SSE 事件里的输出文本权重（thinking/text/input_json_delta 增量）
export function anthropicOutputWeight(ev, data) {
  const d = data?.delta;
  if (data?.type === 'content_block_delta' && d) {
    if (d.type === 'text_delta' && typeof d.text === 'string') return textWeight(d.text);
    if (d.type === 'thinking_delta' && typeof d.thinking === 'string') return textWeight(d.thinking);
    if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') return textWeight(d.partial_json);
  }
  return 0;
}

// 统一的 JSON 响应写出
export function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

// 有界读上游响应体：content-length 预检；无 / 非法 content-length（分块传输、gzip 压缩
// 响应等）时边读边检，超限取消拉取并抛错。注意 headers.get 缺失时返回 null，
// Number(null)===0 是有限值——不能据此落到无界的 arrayBuffer()。
export async function readBodyLimited(up, limit, code = 'resp_too_large') {
  const raw = up.headers.get('content-length');
  if (raw !== null) {
    const len = Number(raw);
    if (len > limit) throw Object.assign(new Error(`上游响应体 ${len} 字节超上限 ${limit} 字节`), { code });
    if (Number.isFinite(len)) return Buffer.from(await up.arrayBuffer());
  }
  const reader = up.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw Object.assign(new Error(`上游响应体超上限 ${limit} 字节`), { code });
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return Buffer.concat(chunks);
}

// 从请求体提取 model 字段（用于路由；解析失败返回 null）
export function extractModel(bodyBuf) {
  try { return JSON.parse(bodyBuf.toString('utf8')).model ?? null; } catch { return null; }
}
