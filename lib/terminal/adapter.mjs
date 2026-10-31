// opencode 方言 → 自家 /term/v1 契约的归一层。纯函数、无 I/O：所有 opencode 的
// 形状知识集中在这里（另一个知情人是从上游拉数据的 opencode.mjs），页面只认本文件的输出。
//
// 字段名注意大小写：opencode 的 part 用 messageID / callID（大写 D），自家契约统一
// 输出 messageId / callId。fixture 以真实 1.18.31 的 /event、/session/:id/message 为准
// （2026-10-31 实测，见设计文档 §三）。

/** 截断：非 string 先 JSON.stringify；按码位截断，加尾缀。 */
export function truncate(v, max) {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  if (s.length <= max) return s;
  return s.slice(0, max) + '…(截断)';
}

const TOOL_OUTPUT_MAX = 8 * 1024;
const TOOL_INPUT_MAX = 2 * 1024;

/**
 * 单个 part 归一。12 种 part 里只保留移动页要渲染的 7 类语义，其余丢弃返回 null。
 * 每个归一结果都带 id 与 messageId：流式更新是同一 part 的多次快照，页面按 id 替换。
 */
export function normalizePart(p) {
  if (!p || typeof p !== 'object') return null;
  const id = typeof p.id === 'string' ? p.id : null;
  const messageId = typeof p.messageID === 'string' ? p.messageID : null;
  if (!id || !messageId) return null;
  const base = { id, messageId };
  switch (p.type) {
    case 'text':
      if (p.synthetic || p.ignored) return null;
      return { ...base, type: 'text', text: String(p.text ?? '') };
    case 'reasoning':
      return { ...base, type: 'reasoning', text: String(p.text ?? '') };
    case 'tool': {
      const st = p.state && typeof p.state === 'object' ? p.state : {};
      return {
        ...base,
        type: 'tool',
        name: String(p.tool ?? ''),
        callId: String(p.callID ?? ''),
        status: st.status ?? 'pending',
        input: st.input === undefined ? undefined : truncate(st.input, TOOL_INPUT_MAX),
        output: st.output === undefined ? undefined : truncate(st.output, TOOL_OUTPUT_MAX),
        error: st.error === undefined ? undefined : truncate(st.error, TOOL_OUTPUT_MAX),
        files: Array.isArray(st.metadata?.files) ? st.metadata.files.map(String) : undefined,
      };
    }
    case 'patch':
      return { ...base, type: 'patch', files: Array.isArray(p.files) ? p.files.map(String) : [] };
    case 'file':
      // url 不回：可能是 data URL，体积不可控
      return { ...base, type: 'file', mime: String(p.mime ?? ''), filename: String(p.filename ?? '') };
    case 'step-start':
      return { ...base, type: 'step' };
    case 'step-finish':
      return { ...base, type: 'step', finish: p.reason, cost: p.cost, tokens: p.tokens };
    default:
      // snapshot / subtask / agent / retry / compaction / 未知：不转发
      return null;
  }
}

/** 一条消息归一：{info, parts} → {id, role, at, parts}。坏消息返回 null。 */
export function normalizeMessage(m) {
  if (!m || typeof m !== 'object' || !m.info) return null;
  const parts = (Array.isArray(m.parts) ? m.parts : []).map(normalizePart).filter(Boolean);
  return {
    id: String(m.info.id ?? ''),
    role: String(m.info.role ?? ''),
    at: m.info.time?.created,
    parts,
  };
}

/**
 * opencode 事件 → 自家 SSE 事件。只转发会改变页面的事，其余返回 null。
 * 返回 {event, sessionID, data}；pending 事件不带详情——页面收到后重拉 /pending，
 * 宁可重拉一次，不在事件里带可能过期的载荷。
 */
export function mapEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const props = ev.properties && typeof ev.properties === 'object' ? ev.properties : {};
  const sessionID = typeof props.sessionID === 'string' ? props.sessionID : null;
  switch (ev.type) {
    case 'message.part.updated': {
      const part = normalizePart(props.part);
      if (!part) return null;
      return { event: 'part', sessionID, data: part };
    }
    case 'message.part.delta':
      if (!props.messageID || !props.partID) return null;
      return {
        event: 'delta',
        sessionID,
        data: {
          messageId: props.messageID,
          partId: props.partID,
          field: String(props.field ?? ''),
          delta: String(props.delta ?? ''),
        },
      };
    case 'session.status':
      return { event: 'status', sessionID, data: { busy: props.status?.type === 'busy' } };
    case 'session.idle':
      return { event: 'status', sessionID, data: { busy: false } };
    case 'message.updated':
      return {
        event: 'status',
        sessionID,
        data: {
          messageId: props.info?.id ?? null,
          role: props.info?.role ?? null,
          completed: props.info?.time?.completed ?? null,
        },
      };
    case 'permission.asked':
    case 'permission.replied':
    case 'question.asked':
    case 'question.replied':
    case 'question.rejected':
      return { event: 'pending', sessionID, data: null };
    default:
      // server.* / session.updated / session.diff / plugin.* / catalog.* / 未知：不转发
      return null;
  }
}

/** opencode 待批权限 → 自家待批条目（detail = 要跑的命令，就是「它要干什么」）。 */
export function normalizePermission(p, sessionTitle = '') {
  return {
    kind: 'permission',
    id: String(p?.id ?? ''),
    session: String(p?.sessionID ?? ''),
    sessionTitle: String(sessionTitle ?? ''),
    summary: String(p?.permission ?? ''),
    detail: truncate(p?.metadata?.command ?? (Array.isArray(p?.patterns) ? p.patterns.join(' ') : ''), TOOL_INPUT_MAX),
    options: null,
  };
}

/** opencode 待答问题 → 自家待批条目（options.questions 原样透传给页面渲染选项）。 */
export function normalizeQuestion(q, sessionTitle = '') {
  const first = Array.isArray(q?.questions) ? q.questions[0] ?? {} : {};
  return {
    kind: 'question',
    id: String(q?.id ?? ''),
    session: String(q?.sessionID ?? ''),
    sessionTitle: String(sessionTitle ?? ''),
    summary: String(first.header ?? ''),
    detail: String(first.question ?? ''),
    options: {
      questions: Array.isArray(q?.questions) ? q.questions : [],
      multiple: first.multiple === true,
      custom: first.custom === true,
    },
  };
}
