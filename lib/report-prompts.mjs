// 工作台「时间段工作总结」的 prompt 与阈值 —— 全部可调参数集中在这一个文件。
// 使用中要调整总结质量（太啰嗦/要突出交付物/换报告结构），改这里即可，无需动管线。
//
// ┌─ 第一部分：素材压缩与脱敏（本文件先建，Task 7 补全 PROMPTS）──────────────┐
// │ LIMITS      各级截断预算（码位计）                                        │
// │ REDACT_*    凭证样式预过滤（提取层防线，prompt 防线是第二道）              │
// └─────────────────────────────────────────────────────────────────────────┘

// 素材压缩阈值：单条 → 会话 → 项目 三级预算
export const LIMITS = {
  userMsgChars: 500,        // 每条真人输入最多保留字符
  assistantChars: 300,      // 每条 assistant 文本最多保留字符
  toolArgsChars: 80,        // 工具调用参数摘要最多保留字符
  sessionChars: 2000,       // 每会话素材总上限（超出截断）
  sessionsPerProject: 15,   // 每项目最多展开的会话数（超出附一行说明）
  projectSummaryChars: 200, // 一级总结（项目小结）目标字数
};

// 疑似凭证/密钥样式 → [REDACTED]（长 hex 同时兜底 JWT 段与 sha 摘要）
export const REDACT_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._-]{8,}/gi, '[REDACTED]'],
  [/AKIA[A-Z0-9]{8,}/g, '[REDACTED]'],
  [/[0-9a-fA-F]{32,}/g, '[REDACTED]'],
];

export function redact(text) {
  let out = String(text);
  for (const [re, rep] of REDACT_PATTERNS) out = out.replace(re, rep);
  return out;
}
