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
  todoTitleChars: 40,       // 待办标题进 prompt 的码位上限（短列表，不灌长文）
  todosPerList: 30,         // 待办「新增/更新/完成」每列表最多列出的条数（超出加「等 N 条」）
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

  // 一级（按待办）：与 userProject 同形，只是把「项目」换成「待办」——
  // 一条待办可能跨多个项目目录，素材里已按〔项目名〕分段
  userTodoGroup: (g) => `待办：${g.todo.title}（共 ${g.sessions} 个工作会话）\n\n${g.summaryText}`,

  // 未归属的零散工作：一级只写「干了什么」的一句话清单，供二级并进「## 其他」
  systemUnassigned: `你是一名工程效能助手。下面是一批没有对应待办的零散工作会话素材。请为每一件独立的事写一句话（不超过 30 字），说明做了什么；没有实质产出的（纯问答、环境排查后无结论）直接省略。输出为 Markdown 无序列表，一行一条，不要标题、不要前后缀。`,
  userUnassigned: (u) => `${u.summaryText}`,

  systemFinal: `你是一名资深工程师的汇报助手，替 TA 撰写给上级的中文工作汇报（Markdown 格式）。要求：
1. 客观陈述视角，**按待办分节（## 待办标题）**。每条待办的材料形态不同，按下面三类处理：
   - **有会话素材**：写清「做到哪了、产出什么」，1-3 句
   - **无会话素材、但有子项或备忘**：这类工作不产生 agent 会话（发邮件、开会、评审、对齐方案）。
     整合子项与备忘，写成 1-2 句结论。**备忘是用户写给自己的**，可能含私人提醒、
     未跟人确认的猜测、无关待办——只提炼能对上级讲的进展，其余一律略去，
     绝不把备忘原文照搬进汇报
   - **无会话素材、无子项无备忘**：只写一行「<状态>：<标题>」，不要编造内容
   - 标了「另一台机器上进行」的待办：那类工作不在本机做，本机没有会话是正常的。
     按子项/备忘正常写，**不要**写成「没有进展」「缺少记录」这类判断
2. **没有对应待办的零散工作**（素材里的「未归属其他工作」一节）一律并入文末「## 其他」，
   每项一行、只说做了什么，不展开。无信息量的直接省略
3. 突出「做了什么、推进到哪、产出什么」，不写对话流水账，不复述具体技术操作步骤，
   也不写工作流元信息（等待输入、会话轮次、验证工具链细节等）
4. 素材含「待办进展」「模型用量」时，在文末生成「## 数据附注」小节，客观呈现数字；
   附注只列有数据的行，全空时整节省略；「数据源状态」仅当素材明确给出时原样呈现，不得自行编写
5. 篇幅是硬约束：正文（不含数据附注）**每条待办 80-150 字**，「## 其他」每行不超过 30 字；
   整体不超过 700 字。超篇幅时宁可丢掉琐碎条目，不可逐项保全
6. 安全红线：绝不引用任何密钥、token、凭证、完整内部路径；绝不虚构素材里没有的工作内容
直接输出汇报正文。`,

  // ctx: { rangeText, projects: [{name, summaryText}], todoGroups,
  //        unassigned: {sessions, summaryText}, todos, usage, sourcesFailed }
  // todoGroups: [{ todo, summaryText, hasSessions, status, items, note, mappingNotes }]
  //   summaryText 只有「有会话素材」的待办才有；其余三类字段是给模型自己组织的原始材料。
  // projects 仅在 todoGroups 为空（一条待办都没有）时作为回落。
  // todos = { created, updated, completed }；updated 与新增/完成互斥
  // （口径见 lib/todos.mjs todosInWindow：本窗新建或本窗完成的条目不再重复计入 updated）
  userFinal: (ctx) => {
    const groups = ctx.todoGroups ?? [];
    const useTodo = groups.length > 0 || (ctx.unassigned?.sessions ?? 0) > 0;
    const STATUS_LABEL = { done: '已完成', in_progress: '进行中', pending: '待办' };
    // 每条待办按证据分级组包：有会话 → 小结；无会话 → 子项/备忘原文（附「请过滤备忘」指令）
    const todoText = useTodo
      ? groups.map((g) => {
        // 远程待办（不在本机做）标明来源，避免模型把它写成「本机无进展」
        const head = `【待办：${g.todo.title}】（${STATUS_LABEL[g.status] ?? g.status}）`
          + (g.remote ? '［另一台机器上进行，本机无会话记录属正常］' : '');
        if (g.summaryText) {
          const extra = g.mappingNotes?.length ? `\n（归属说明：${g.mappingNotes.join('；')}）` : '';
          return `${head}\n${g.summaryText}${extra}`;
        }
        // 无会话：这类工作不产生 agent 记录，材料只有待办自身
        const bits = [];
        if (g.items?.length) {
          bits.push(`子项：${g.items.map((it) => `${it.done ? '✓' : '○'} ${it.title}`).join('；')}`);
        }
        if (g.note) bits.push(`用户备忘（原文，需过滤）：${g.note}`);
        if (!bits.length) return `${head}\n（无会话、无子项、无备忘）`;
        return `${head}\n${bits.join('\n')}`;
      }).join('\n\n')
      : (ctx.projects ?? []).map((p) => `【${p.name}】\n${p.summaryText}`).join('\n\n');
    // 未归属其他工作：只说「干了什么」，正文里一行一条，不展开
    const unassignedBlock = useTodo && ctx.unassigned?.summaryText
      ? `\n\n未归属其他工作（这些会话对不上任何待办）：\n${ctx.unassigned.summaryText}`
      : '';
    const t = ctx.todos ?? { created: [], updated: [], completed: [] };
    // 待办行：标题截 todoTitleChars 码位、每列表最多 todosPerList 条；子项进度（k/j）
    // 仅在尚有未完成子项时缀——手动完成的待办可能子项没勾完，此时完成行同样缀进度如实呈现。
    // 短列表纪律：这段「待办进展」附注只列标题与计数，note 不进（note 已在上面的
    // 待办分组里按证据分级单独给过，且带「需过滤」指令；这里再塞一遍等于绕过那条约束）。
    const cutTitle = (s) => {
      const cps = Array.from(String(s ?? ''));
      return cps.length <= LIMITS.todoTitleChars ? cps.join('') : cps.slice(0, LIMITS.todoTitleChars).join('') + '…';
    };
    const todoLine = (list, label) => {
      if (!list?.length) return null; // 容错：调用方传旧形态（无 updated）时该行整行省略
      const shown = list.slice(0, LIMITS.todosPerList).map((x) => {
        const prog = Array.isArray(x.items) && x.items.length && x.items.some((i) => !i.done)
          ? `（${x.items.filter((i) => i.done).length}/${x.items.length}）` : '';
        return `${cutTitle(x.title)}${x.urgency === 'urgent' ? '（紧急）' : ''}${prog}`;
      });
      const rest = list.length - shown.length;
      return `${label}（${list.length}）：${shown.join('、')}${rest > 0 ? ` 等 ${rest} 条` : ''}`;
    };
    const todosLines = [todoLine(t.completed, '完成'), todoLine(t.updated, '更新'), todoLine(t.created, '新增')].filter(Boolean);
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

${useTodo ? '待办工作（按待办分组）' : '各项目小结'}：
${todoText || '（该时段未发现 agent 会话素材）'}${unassignedBlock}${todosBlock}${usageBlock}${failedLines.length ? `
数据源状态（以下源提取失败，该源时段内的工作未计入本汇报）：
${failedLines.join('\n')}` : ''}`;
  },
};
