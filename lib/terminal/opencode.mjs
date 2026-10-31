// opencode serve 的 HTTP 客户端：全部走回环 127.0.0.1，Basic auth（用户名固定 opencode，
// 口令来自 host.mjs 每次拉起时随机生成的 OPENCODE_SERVER_PASSWORD）。
// 所有 opencode 的 URL 形状知识集中在这一层（与 adapter.mjs 一起构成仅有的两个「知情人」）。
//
// 约定：
//   - directory 是作用域：建会话/发消息/拉历史/回待批都要带 ?directory=<绝对路径>；
//     不带 directory 的 GET /permission 返回空（实测），所以待批必须逐目录拉。
//   - :id 拼路径前一律过 ID_RE 防注入（../、%2F、空串都进不了上游 URL）。
//   - 204 返回 null；非 2xx 抛带 .status 的 Error（.upstream = true，供上层区分归一）。
import http from 'node:http';

const ID_RE = /^[A-Za-z0-9_-]+$/;

function upstreamError(status, message) {
  const e = new Error(`opencode 上游 ${status}: ${message || '请求失败'}`);
  e.status = status;
  e.upstream = true;
  return e;
}

/** 单个 id 参数校验：防路径注入（Review Focus #3 的客户端半边）。 */
export function assertId(id, what = 'id') {
  const s = String(id ?? '');
  if (!ID_RE.test(s)) {
    const e = new Error(`非法的 ${what}`);
    e.status = 404;
    throw e;
  }
  return s;
}

export function createOpencodeClient({ baseUrl, password, timeoutMs = 15000 }) {
  const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
  const origin = baseUrl.replace(/\/+$/, '');

  async function request(method, pathname, { query, body, timeout = timeoutMs, raw } = {}) {
    const qs = query ? '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')),
    ).toString() : '';
    const pathStr = `${pathname}${qs}`;
    return new Promise((resolve, reject) => {
      const u = new URL(origin);
      const req = http.request({
        host: u.hostname,
        port: u.port || 80,
        method,
        path: pathStr,
        headers: {
          authorization: auth,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          accept: raw ? 'text/event-stream' : 'application/json',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (raw) { resolve({ response: res, body: buf }); return; }
            const text = buf.toString('utf8').trim();
            if (!text) { resolve(null); return; }
            try { resolve(JSON.parse(text)); } catch { resolve({ _raw: text }); }
            return;
          }
          let msg = '';
          try { msg = JSON.parse(buf.toString('utf8')).error?.message ?? ''; } catch {}
          reject(upstreamError(res.statusCode, msg));
        });
      });
      req.on('error', (err) => reject(Object.assign(err, { upstream: true, status: err.status ?? 502 })));
      if (timeout > 0) req.setTimeout(timeout, () => req.destroy(upstreamError(504, '上游超时')));
      if (body !== undefined) req.end(JSON.stringify(body));
      else req.end();
    });
  }

  const dirQ = (directory) => (directory ? { directory } : {});
  const sid = (id) => assertId(id, '会话 id');

  return {
    baseUrl: origin,
    /** 就绪探测（host.mjs 每 250ms 调一次）。 */
    health() { return request('GET', '/global/health', { timeout: 5000 }); },
    /** 全量会话（不带 directory → 所有目录，归属校验靠它）。 */
    listSessions() { return request('GET', '/session'); },
    /** 全局 busy 表 {sesId: {type:'busy'}}。 */
    sessionStatus() { return request('GET', '/session/status'); },
    createSession({ directory, title }) {
      return request('POST', '/session', { query: dirQ(directory), body: title ? { title } : {} });
    },
    messages(sessionId, { directory, limit, before } = {}) {
      return request('GET', `/session/${sid(sessionId)}/message`, { query: { ...dirQ(directory), limit, before } });
    },
    promptAsync(sessionId, { directory, text }) {
      const t = String(text ?? '');
      if (!t.trim()) { const e = new Error('消息不能为空'); e.status = 400; throw e; }
      if (t.length > 200000) { const e = new Error('消息过长（上限 20 万字符）'); e.status = 413; throw e; }
      return request('POST', `/session/${sid(sessionId)}/prompt_async`, {
        query: dirQ(directory),
        body: { parts: [{ type: 'text', text: t }] },
      });
    },
    abort(sessionId, { directory }) {
      return request('POST', `/session/${sid(sessionId)}/abort`, { query: dirQ(directory) });
    },
    /** 待批权限：**必须带 directory**（不带返回空，实测）。 */
    permissions(directory) {
      return request('GET', '/permission', { query: dirQ(directory) });
    },
    replyPermission(id, { directory, reply }) {
      const dec = String(reply ?? '');
      if (!['once', 'always', 'reject'].includes(dec)) { const e = new Error('decision 只能是 once/always/reject'); e.status = 400; throw e; }
      return request('POST', `/permission/${assertId(id, '待批 id')}/reply`, { query: dirQ(directory), body: { reply: dec } });
    },
    questions(directory) {
      return request('GET', '/question', { query: dirQ(directory) });
    },
    replyQuestion(id, { directory, answers }) {
      return request('POST', `/question/${assertId(id, '问题 id')}/reply`, { query: dirQ(directory), body: { answers } });
    },
    rejectQuestion(id, { directory }) {
      return request('POST', `/question/${assertId(id, '问题 id')}/reject`, { query: dirQ(directory) });
    },
    /**
     * 事件流：无限时（timeout 0），返回 {response, iterator}。
     * iterator 逐条 yield 解析后的事件对象（按空行分帧、剥 data: 前缀、JSON.parse）；
     * 解析失败的帧跳过不中断。消费方负责在放弃时 destroy response。
     */
    openEvents() {
      return request('GET', '/event', { timeout: 0, raw: true }).then(({ response }) => {
        let pending = '';
        const queue = [];
        let wake = null;
        let done = false;
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          pending += chunk;
          let idx;
          // SSE 帧以空行分隔；事件体内也可能有换行，逐段整体处理
          while ((idx = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, idx);
            pending = pending.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try { queue.push(JSON.parse(line.slice(6))); } catch { /* 坏帧跳过 */ }
            }
          }
          wake?.();
        });
        response.on('end', () => { done = true; wake?.(); });
        response.on('error', () => { done = true; wake?.(); });
        const iterator = {
          async *[Symbol.asyncIterator]() {
            while (true) {
              while (queue.length) yield queue.shift();
              if (done) return;
              await new Promise((r) => { wake = r; });
              wake = null;
            }
          },
        };
        return { response, iterator };
      });
    },
  };
}
