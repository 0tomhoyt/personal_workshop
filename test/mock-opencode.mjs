#!/usr/bin/env node
// mock opencode serve：终端监听端到端测试的后端替身。行为与真实 opencode 1.18.31 对齐
// （2026-10-31 实测口径，见 docs/superpowers/specs/2026-10-31-remote-agent-design.md §三）：
//   - Basic auth（用户名 opencode + OPENCODE_SERVER_PASSWORD），否则一律 401
//   - directory 是作用域：GET /permission 不带 directory 返回空；reply 带错 directory 404
//   - 状态存 MOCK_STATE_FILE（JSON）跨重启存活——重启后 busy=true 的会话模拟僵尸轮次
//   - 提示词触发：含 'ask-permission' → 挂起待批；含 'ask-question' → 挂起待答；
//     含 'big-output' → 产出 1MB 输出的 tool part（测网关截断）
//   - GET /event 为 SSE，事件信封 {id:'evt_N', type, properties} 与真实一致
// 手工冒烟（见 test/terminal.mjs 前置注释）：
//   MOCK_STATE_FILE=/tmp/m.json OPENCODE_SERVER_PASSWORD=p ./test/mock-opencode.mjs serve --port 45899 --hostname 127.0.0.1
import http from 'node:http';
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] !== 'serve') { console.error('用法: mock-opencode.mjs serve --port <p> --hostname <h>'); process.exit(2); }
const getOpt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(getOpt('--port') || 4096);
const HOST = getOpt('--hostname') || '127.0.0.1';
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || '';
const STATE_FILE = process.env.MOCK_STATE_FILE;

if (!PASSWORD) { console.error('mock-opencode: 需要设置 OPENCODE_SERVER_PASSWORD'); process.exit(2); }
if (!STATE_FILE) { console.error('mock-opencode: 需要设置 MOCK_STATE_FILE'); process.exit(2); }

// ── 状态（跨重启存活）───────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* 起步空状态 */ }
  return { nextId: 1, sessions: {}, messages: {}, busy: {}, permissions: {}, questions: {} };
}
const S = loadState();
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S));

const nid = (prefix) => `${prefix}_mock${S.nextId++}`;

// ── SSE 订阅者与事件 ────────────────────────────────────────────────────────
const subscribers = new Set();
let evtSeq = 0;
function emit(type, properties) {
  const line = `data: ${JSON.stringify({ id: `evt_${++evtSeq}`, type, properties })}\n\n`;
  for (const res of subscribers) {
    try { res.write(line); } catch { subscribers.delete(res); }
  }
}

// ── 会话/消息工具 ──────────────────────────────────────────────────────────
function sessionUpdated(s) {
  s.time.updated = Date.now();
  emit('session.updated', { sessionID: s.id, info: { ...s } });
}
function setBusy(sesId, busy) {
  if (busy) { S.busy[sesId] = true; emit('session.status', { sessionID: sesId, status: { type: 'busy' } }); }
  else { delete S.busy[sesId]; emit('session.idle', { sessionID: sesId }); }
}
function appendMessage(sesId, role, parts) {
  const id = nid('msg');
  const msg = { info: { id, role, sessionID: sesId, time: { created: Date.now() } }, parts };
  (S.messages[sesId] ??= []).push(msg);
  emit('message.updated', { sessionID: sesId, info: { ...msg.info } });
  return msg;
}
function partOf(sesId, msgId, over) {
  return { id: nid('prt'), sessionID: sesId, messageID: msgId, ...over };
}

/** 一轮「正常回复」：reasoning → 两次 delta → text 快照 → step-finish → idle。 */
function completeTurn(sesId, replyText) {
  const m = appendMessage(sesId, 'assistant', []);
  const reasonPart = partOf(sesId, m.info.id, { type: 'reasoning', text: '思考：按要求回复', time: { start: Date.now() } });
  m.parts.push(reasonPart);
  emit('message.part.updated', { sessionID: sesId, part: { ...reasonPart } });
  const textPart = partOf(sesId, m.info.id, { type: 'text', text: '' });
  m.parts.push(textPart);
  for (const delta of [replyText.slice(0, Math.ceil(replyText.length / 2)), replyText.slice(Math.ceil(replyText.length / 2))]) {
    textPart.text += delta;
    emit('message.part.delta', { sessionID: sesId, messageID: m.info.id, partID: textPart.id, field: 'text', delta });
  }
  emit('message.part.updated', { sessionID: sesId, part: { ...textPart } });
  const fin = partOf(sesId, m.info.id, { type: 'step-finish', reason: 'stop', cost: 0.01, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } });
  m.parts.push(fin);
  emit('message.part.updated', { sessionID: sesId, part: { ...fin } });
  m.info.time.completed = Date.now();
  setBusy(sesId, false);
  save();
}

/** 挂起轮次（ask-permission / ask-question 共用）：assistant 消息先给 step-start + running 的 tool part。 */
function openHeldTurn(sesId, toolName, input) {
  const m = appendMessage(sesId, 'assistant', []);
  const start = partOf(sesId, m.info.id, { type: 'step-start' });
  m.parts.push(start);
  emit('message.part.updated', { sessionID: sesId, part: { ...start } });
  const tool = partOf(sesId, m.info.id, { type: 'tool', callID: nid('call'), tool: toolName, state: { status: 'running', input, time: { start: Date.now() } } });
  m.parts.push(tool);
  emit('message.part.updated', { sessionID: sesId, part: { ...tool } });
  return { msg: m, toolPart: tool };
}

/** 待批/待答结束后收尾这轮：tool completed + text + idle。 */
function finishHeldTurn(sesId, held, output) {
  held.toolPart.state = { status: 'completed', input: held.toolPart.state.input, output, time: { start: Date.now(), end: Date.now() } };
  emit('message.part.updated', { sessionID: sesId, part: { ...held.toolPart } });
  const text = partOf(sesId, held.msg.info.id, { type: 'text', text: 'mock：已按你的批复执行' });
  held.msg.parts.push(text);
  emit('message.part.updated', { sessionID: sesId, part: { ...text } });
  setBusy(sesId, false);
  save();
}

// ── prompt_async 的三种剧本 ────────────────────────────────────────────────
function runPrompt(sesId, text) {
  appendMessage(sesId, 'user', [partOf(sesId, null, { type: 'text', text })]);
  setBusy(sesId, true);
  const s = S.sessions[sesId];
  if (s) sessionUpdated(s);
  if (text.includes('ask-permission')) {
    const held = openHeldTurn(sesId, 'bash', { command: 'echo test' });
    const per = { id: nid('per'), sessionID: sesId, directory: s?.directory, permission: 'bash', patterns: ['echo test'], metadata: { command: 'echo test' }, always: ['echo *'], held };
    S.permissions[per.id] = per;
    save();
    emit('permission.asked', { id: per.id, sessionID: sesId, permission: per.permission, patterns: per.patterns, metadata: per.metadata, always: per.always, tool: { messageID: held.msg.info.id, callID: held.toolPart.callID } });
  } else if (text.includes('ask-question')) {
    const held = openHeldTurn(sesId, 'ask', { question: '选哪个' });
    const que = {
      id: nid('que'), sessionID: sesId, directory: s?.directory, held,
      questions: [{ question: '方案选哪个？', header: '方案', multiple: false, custom: false, options: [{ label: 'A', description: '甲方案' }, { label: 'B', description: '乙方案' }] }],
    };
    S.questions[que.id] = que;
    save();
    emit('question.asked', { id: que.id, sessionID: sesId, questions: que.questions, tool: { messageID: held.msg.info.id, callID: held.toolPart.callID } });
  } else if (text.includes('big-output')) {
    const m = appendMessage(sesId, 'assistant', []);
    const tool = partOf(sesId, m.info.id, { type: 'tool', callID: nid('call'), tool: 'bash', state: { status: 'completed', input: { command: 'cat big' }, output: 'x'.repeat(1024 * 1024), time: { start: Date.now(), end: Date.now() } } });
    m.parts.push(tool);
    emit('message.part.updated', { sessionID: sesId, part: { ...tool } });
    completeTurn(sesId, '大输出已产出');
  } else {
    completeTurn(sesId, `收到：${text.slice(0, 80)}`);
  }
}

// ── HTTP 服务 ──────────────────────────────────────────────────────────────
const AUTH = 'Basic ' + Buffer.from(`opencode:${PASSWORD}`).toString('base64');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams);
  const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(status === 204 ? undefined : JSON.stringify(obj ?? null)); };

  if (req.headers.authorization !== AUTH) return json(401, { error: { message: 'unauthorized' } });

  // ── 健康 ──
  if (p === '/global/health' && req.method === 'GET') return json(200, { healthy: true, version: 'mock-1.0' });

  // ── 会话集合 ──
  if (p === '/session' && req.method === 'GET') {
    let list = Object.values(S.sessions).sort((a, b) => b.time.updated - a.time.updated);
    if (q.directory) list = list.filter((s) => s.directory === q.directory);
    return json(200, list);
  }
  if (p === '/session' && req.method === 'POST') {
    const dir = q.directory;
    if (!dir) return json(400, { error: { message: 'directory 必填' } });
    const s = { id: nid('ses'), slug: 'mock', projectID: 'global', directory: dir, path: dir.replace(/^\//, ''), title: '', version: 'mock-1.0', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() } };
    S.sessions[s.id] = s;
    S.messages[s.id] = [];
    save();
    emit('session.updated', { sessionID: s.id, info: { ...s } });
    return json(200, s);
  }
  if (p === '/session/status' && req.method === 'GET') {
    return json(200, Object.fromEntries(Object.keys(S.busy).map((id) => [id, { type: 'busy' }])));
  }

  // ── 单会话 ──
  const sm = /^\/session\/([A-Za-z0-9_-]+)(\/[a-z_]+)?$/.exec(p);
  if (sm) {
    const sesId = sm[1];
    const sub = sm[2] || '';
    const s = S.sessions[sesId];
    if (!s) return json(404, { error: { message: 'session not found' } });
    if (sub === '/message' && req.method === 'GET') {
      let list = S.messages[sesId] || [];
      const limit = Number(q.limit) || 0;
      if (limit > 0) list = list.slice(-limit);
      return json(200, list);
    }
    if (sub === '/prompt_async' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const text = String(JSON.parse(body || '{}').parts?.[0]?.text ?? '');
        setTimeout(() => runPrompt(sesId, text), 30);
        json(204);
      });
      return;
    }
    if (sub === '/abort' && req.method === 'POST') {
      for (const msg of S.messages[sesId] || []) {
        for (const part of msg.parts) {
          if (part.type === 'tool' && part.state?.status === 'running') {
            part.state = { ...part.state, status: 'error', error: 'Tool execution aborted', metadata: { interrupted: true }, time: { ...part.state.time, end: Date.now() } };
          }
        }
      }
      // 挂起的待批/待答随轮次作废（真实行为：中断即不再等批复）
      for (const [id, per] of Object.entries(S.permissions)) if (per.sessionID === sesId) delete S.permissions[id];
      for (const [id, que] of Object.entries(S.questions)) if (que.sessionID === sesId) delete S.questions[id];
      setBusy(sesId, false);
      save();
      return json(200, true);
    }
  }

  // ── 待批权限（directory 是作用域：不带返回空、带错 404，均为实测口径）──
  if (p === '/permission' && req.method === 'GET') {
    const list = q.directory ? Object.values(S.permissions).filter((x) => x.directory === q.directory).map(({ held, directory, ...rest }) => rest) : [];
    return json(200, list);
  }
  const pm = /^\/permission\/([A-Za-z0-9_-]+)\/reply$/.exec(p);
  if (pm && req.method === 'POST') {
    const per = S.permissions[pm[1]];
    if (!per || q.directory !== per.directory) return json(404, { error: { message: 'permission not found' } });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reply = JSON.parse(body || '{}').reply;
      delete S.permissions[per.id];
      emit('permission.replied', { sessionID: per.sessionID, requestID: per.id, reply });
      if (reply !== 'reject') finishHeldTurn(per.sessionID, per.held, 'mock-ok');
      else { per.held.toolPart.state = { ...per.held.toolPart.state, status: 'error', error: '用户拒绝' }; emit('message.part.updated', { sessionID: per.sessionID, part: { ...per.held.toolPart } }); setBusy(per.sessionID, false); }
      save();
      json(200, true);
    });
    return;
  }

  // ── 待答问题（同构）──
  if (p === '/question' && req.method === 'GET') {
    const list = q.directory ? Object.values(S.questions).filter((x) => x.directory === q.directory).map(({ held, directory, ...rest }) => rest) : [];
    return json(200, list);
  }
  const qm = /^\/question\/([A-Za-z0-9_-]+)\/(reply|reject)$/.exec(p);
  if (qm && req.method === 'POST') {
    const que = S.questions[qm[1]];
    if (!que || q.directory !== que.directory) return json(404, { error: { message: 'question not found' } });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const answers = qm[2] === 'reply' ? JSON.parse(body || '{}').answers : null;
      delete S.questions[que.id];
      emit(answers ? 'question.replied' : 'question.rejected', { sessionID: que.sessionID, requestID: que.id, ...(answers ? { answers } : {}) });
      finishHeldTurn(que.sessionID, que.held, answers ? `已选 ${JSON.stringify(answers)}` : '已取消');
      json(200, true);
    });
    return;
  }

  // ── 事件流 ──
  if (p === '/event' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.write(`data: ${JSON.stringify({ id: `evt_${++evtSeq}`, type: 'server.connected', properties: {} })}\n\n`);
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    return;
  }

  return json(404, { error: { message: `no route ${p}` } });
});

server.listen(PORT, HOST, () => {
  save();
  console.log(`mock opencode server listening on http://${HOST}:${PORT}`);
});
