// 会话 → 待办 的归属：交给模型做内容判断。
//
// 曾经的做法是让用户手填「开始-结束」时段、靠时间重叠归属。实测 6 条待办 0 条填了
// 时段——没人记得在干活前后点按钮，而漏填的代价是那段时间的活整段从汇报里消失且
// 毫无提示。「不用就悄悄变差」是最糟的形状，所以换成下面这个：
//
//   把「待办清单（标题 + 项目 + 状态）」和「按项目归并好的会话素材」一起交给模型，
//   让它输出每条会话属于哪个待办；对不上的归「其他」。
//
// 代价是**归属不确定**（每次跑可能略有不同），用户已明确接受：零输入成本换确定性。
//
// 这个模块只负责 prompt 组包与结果解析，不发请求——调用方（generate.mjs）
// 用现有的 callSummaryModel 走同一套上游/重试/错误口径。
import { LIMITS } from '../report-prompts.mjs';

const cutTitle = (s) => {
  const cps = Array.from(String(s ?? ''));
  return cps.length <= LIMITS.todoTitleChars ? cps.join('') : cps.slice(0, LIMITS.todoTitleChars).join('') + '…';
};

// 待办清单行：标题 + 项目 + 状态 + 子项进度。**不带 note**——note 是用户的私人备忘
// （「找张工要数据」这类），不适合作为「这条待办干了什么」的判断依据，也不该为了
// 归属把它发出去。归属只看标题/项目这类用户本来就写给自己的概括。
export function todoListBlock(todos) {
  if (!todos?.length) return '（无待办）';
  return todos.map((t, i) => {
    const proj = t.project ? `［${t.project}］` : '';
    const st = t.status === 'done' ? '已完成' : t.status === 'in_progress' ? '进行中' : '待办';
    const items = Array.isArray(t.items) && t.items.length
      ? `（子项 ${t.items.filter((x) => x.done).length}/${t.items.length}）` : '';
    return `${i + 1}. ${proj}${cutTitle(t.title)} · ${st}${items}`;
  }).join('\n');
}

// 是否「不在这台机器上做」的待办（project 命中 workbench.remoteProjects）。
// 这类待办不参与会话归属——本机不会有它们的会话，放进候选只会诱导模型
// 把同名的无关会话错配过去（「黄区kblas int8问题单处理」vs 本机 kblas 会话就是这种）。
export function isRemoteTodo(todo, remoteProjects) {
  if (!Array.isArray(remoteProjects) || !remoteProjects.length) return false;
  const p = typeof todo?.project === 'string' ? todo.project.trim() : '';
  return Boolean(p) && remoteProjects.includes(p);
}

// 归属 prompt：让模型输出「项目 → 待办序号」的映射。
// 只让它做编号对应，不让它复述会话内容——复述既浪费 token，又会引入幻觉风险。
export const ATTRIBUTE_PROMPT = `你是一名工程助理。下面给出「待办清单」和「本次时间窗内的开发会话素材（已按项目归并）」。
请判断每个项目的会话素材分别对应哪一条待办。

规则：
1. 只依据项目路径、会话标题与正文内容做判断，不要臆测。
2. 一个项目可能对应一条待办，也可能对应多条（同一项目里不同会话做的是不同的事）——
   这种情况下拆成多行，用「会话标题」关键字指明是哪些会话。
3. 完全对不上任何待办的（一次性排查、临时问答、与待办无关的探索），归为「其他」。
4. **不要为了凑数强行归类**：拿不准就归「其他」，错配比漏配代价更大。
5. 待办清单里没有的编号不要编。
6. 每个项目的素材只给了开头一段（用于判断这个项目在做什么），不是全部内容——
   不要因为「没看到某件事」就断定它不属于该待办，以项目名与开头内容为准。
7. **每个项目都必须输出一行**，包括归「其他」的。项目很多时也要逐个覆盖，不要省略。

输出格式：每行一条，形如
项目名 | 待办序号 | 一句话说明这批会话在这条待办上做了什么
对不上的写
项目名 | 其他 | 一句话说明做了什么
不要任何标题、前言、总结或 Markdown 修饰。`;

// 归属只看「这个项目在做什么」，不看全文。每项目截到 `perProjectChars` 码位——
// 项目素材开头就是「### 会话标题 时间段 / [用户] 首句需求」，足以判断归属。
//
// 为什么必须截：归属是一次调用要对完**所有**项目，而 collect 的
// sessionChars(2000)/sessionsPerProject(15) 预算是按「一个项目一次总结」设计的。
// 实测 6 天窗口 21 个项目 → 9 万字符（约 6 万 token）一次性发出去，上游 120s 超时，
// 重试才勉强成功且 25 条映射里 21 条归「其他」（项目太多，顾不过来）。
// 截到 600 码位后约 1.2 万字符，快一个数量级，归属质量也更高。
const ATTRIBUTE_PROJECT_CHARS = 600;
const cut = (s, n) => {
  const cps = Array.from(String(s ?? ''));
  return cps.length <= n ? cps.join('') : cps.slice(0, n).join('') + '…';
};

export function userAttribute({ todos, projects, remoteProjects }) {
  const projText = (projects ?? [])
    .map((p) => `【${p.name}】（${p.sessions} 个会话）\n${cut(p.summaryText, ATTRIBUTE_PROJECT_CHARS)}`)
    .join('\n\n');
  // 远程待办在这里已经被调用方剔除，但仍把「哪些标签属于另一台机器」告诉模型——
  // 否则它看到项目名跟某条待办撞词（kblas），仍可能把会话归给清单里剩下的相似条目
  const remoteNote = Array.isArray(remoteProjects) && remoteProjects.length
    ? `\n\n注意：带［${remoteProjects.join(' / ')}］标签的工作**不在本机进行**，本机不会产生它们的会话；`
      + '清单里已排除这些待办。若某批会话的内容主题接近某条被排除的待办，那也是巧合，应归「其他」。'
    : '';
  return `待办清单：
${todoListBlock(todos)}

时间窗内的会话素材：
${projText || '（该时段没有会话素材）'}${remoteNote}`;
}

// 解析模型输出：行 → { project, todoIndex|'other', note }
// 容错：模型偶尔加 Markdown 表格竖线包裹、加序号、改分隔符（全角｜、tab），都容忍。
export function parseAttribution(text, projects, todos) {
  const projNames = new Set((projects ?? []).map((p) => p.name));
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim().replace(/^[-*•]\s*/, '').replace(/^\|/, '').replace(/\|$/, '').trim();
    if (!line) continue;
    // 分隔符：半角/全角竖线、tab 都接受；取前两段当「项目」「待办」，其余合并为说明
    const parts = line.split(/\s*[|｜\t]\s*/);
    if (parts.length < 2) continue;
    // 模型常把项目名包在 【】/ ` ` / 「」 里，也常加粗——都剥掉再比对
    const project = parts[0].replace(/^【|】$/g, '').replace(/^[`「『*_]+|[`」』*_]+$/g, '').trim();
    if (!projNames.has(project)) continue; // 模型编出来的项目名：丢掉（宁可漏配）
    const target = parts[1].trim();
    const note = parts.slice(2).join(' ').trim();
    if (/^其他$/.test(target)) { out.push({ project, other: true, note }); continue; }
    const idx = Number(target.replace(/^待办\s*/, '').replace(/[^\d]/g, ''));
    if (!Number.isInteger(idx) || idx < 1 || idx > (todos?.length ?? 0)) continue;
    out.push({ project, todoId: todos[idx - 1].id, note });
  }
  return out;
}
