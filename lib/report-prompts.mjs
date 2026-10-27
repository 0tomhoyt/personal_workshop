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
  projectSummaryChars: 150, // 一级总结（项目小结）目标字数（第 2 轮 200→150：一级不收紧，成稿压不住）
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

// ┌─ 第二部分：两级总结的 prompt ────────────────────────────────────────────┐
// │ 一级 systemProject/userProject：项目素材 → 项目小结                        │
// │ 二级 systemFinal/userFinal：全部小结 + 待办变动 + 用量 → 最终汇报           │
// │ 汇报读者是上级：客观陈述、按项目组织、突出产出与推进；安全红线两道          │
// │ （提取层 redact 是第一道，prompt 指令是第二道）。                          │
// └─────────────────────────────────────────────────────────────────────────┘
export const PROMPTS = {
  systemProject: `你是一名工程效能助手。根据提供的开发会话素材，为该项目写一份不超过 ${LIMITS.projectSummaryChars} 字的中文小结，概括：这段时间做了什么、关键产出或结论、当前进展状态。进展状态一句话带过（如「未合并」「待评审」），不展开版本库或提交细节。只依据素材内容，不臆测、不虚构；素材中出现密钥、token、凭证、完整内部路径等敏感信息时一律略去不复述。直接输出小结正文，不要任何前后缀或标题。`,

  userProject: (project) => `项目：${project.name}（共 ${project.sessions} 个工作会话）\n\n${project.summaryText}`,

  systemFinal: `你是一名资深工程师的汇报助手，替 TA 撰写给上级的中文工作汇报（Markdown 格式）。要求：
1. 客观陈述视角，按项目分节（## 项目名）。按工作量与产出排序，**最多保留 5-6 个主项目节**，
   每节先一句总述，再用无序列表列 2-3 条要点；其余项目、一次性技术问答全部并入「## 其他」
   汇总节、每项一行（无信息量的直接省略）
2. 突出「做了什么、推进到哪、产出什么」，不写对话流水账，不复述具体技术操作步骤，
   也不写工作流元信息（等待输入、会话轮次、验证工具链细节等）
3. 素材含「待办进展」「模型用量」时，在文末生成「## 数据附注」小节，客观呈现数字；
   附注只列有数据的行，全空时整节省略；「数据源状态」仅当素材明确给出时原样呈现，不得自行编写
4. 篇幅是硬约束：正文（不含数据附注）项目不多时 600 字左右，项目多时也不超过 900 字；
   超篇幅时宁可丢掉琐碎条目，不可逐项保全
5. 安全红线：绝不引用任何密钥、token、凭证、完整内部路径；绝不虚构素材里没有的工作内容
直接输出汇报正文。`,

  // ctx: { rangeText, projects: [{name, summaryText}], todos, usage, sourcesFailed }
  userFinal: (ctx) => {
    const projText = (ctx.projects ?? []).map((p) => `【${p.name}】\n${p.summaryText}`).join('\n\n');
    const t = ctx.todos ?? { created: [], completed: [] };
    const todosLines = [];
    if (t.completed.length) todosLines.push(`完成（${t.completed.length}）：${t.completed.map((x) => `${x.title}${x.urgency === 'urgent' ? '（紧急）' : ''}`).join('、')}`);
    if (t.created.length) todosLines.push(`新增（${t.created.length}）：${t.created.map((x) => `${x.title}${x.urgency === 'urgent' ? '（紧急）' : ''}`).join('、')}`);
    const u = ctx.usage ?? {};
    const usageLines = [];
    if (u.totalRequests > 0) {
      usageLines.push(`${u.totalRequests} 次模型调用、约 ${Math.round(u.totalTokens / 1000)}K tokens、折算费用 $${u.totalCost.toFixed(2)}`);
      const provs = Object.entries(u.byProvider ?? {}).sort((a, b) => b[1].requests - a[1].requests);
      if (provs.length > 1) usageLines.push(`分订阅：${provs.map(([pid, v]) => `${pid} ${v.requests} 次`).join('、')}`);
    }
    // 单源故障如实进报告：不能把「源挂了」呈现成「该时段没干活」
    const failedLines = (ctx.sourcesFailed ?? []).map((x) => `- ${x}`);
    // 空数据段直接不喂给模型（第 1 轮曾据「（无统计数据）」占位自行编写附注）
    const todosBlock = todosLines.length ? `\n待办进展：\n${todosLines.join('\n')}` : '';
    const usageBlock = usageLines.length ? `\n模型用量：\n${usageLines.join('\n')}` : '';
    return `汇报时间段：${ctx.rangeText}

各项目小结：
${projText || '（该时段未发现 agent 会话素材）'}${todosBlock}${usageBlock}${failedLines.length ? `
数据源状态（以下源提取失败，该源时段内的工作未计入本汇报）：
${failedLines.join('\n')}` : ''}`;
  },
};
