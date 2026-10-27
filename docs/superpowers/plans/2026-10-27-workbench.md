# 个人工作台（待办 + AI 报告）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在网关上新增跨 agent 待办系统（REST + 网页）与时间段 AI 工作总结（读 4 个 agent 本地对话记录 → 两级总结 → 给领导看的 Markdown 汇报），一个 workbench.html 页面承载，现有功能零回归。

**Architecture:** 零依赖 Node ESM 延续：server.mjs 加路由段；数据层 `lib/todos.mjs`；报告管线 `lib/report/`（4 个源适配器 + collect 组装 + generate 状态机）+ prompt 集中在 `lib/report-prompts.mjs`；上游调用复用 `lib/upstream.mjs` 的 requestUpstream（按 provider.protocol 分支）；前端从 admin.html 提取共享 `workbench.css`，新页面 `workbench.html`。

**Tech Stack:** Node ≥18 内置模块（fs/path/http/child_process/crypto）、系统 `/usr/bin/sqlite3`（spawn `-json -readonly`）、原生 fetch（undici）。

**Spec:** `docs/superpowers/specs/2026-10-27-workbench-design.md`（含 4 个数据源的侦察事实与判别式——实现源适配器前必读对应小节）

## Global Constraints

- 零依赖：不新增 package.json / node_modules；只用 Node 内置模块 + spawn `/usr/bin/sqlite3`。
- 注释、文档、commit message 全部中文，风格与现有代码一致。
- 运行时产物全部走 env 覆盖：`CANNBOT_TODOS_FILE`、`CANNBOT_REPORTS_FILE`、`CANNBOT_CC_DIR`、`CANNBOT_ZCODE_DB`、`CANNBOT_OPENCODE_DB`、`CANNBOT_CURSOR_DIR`（测试必须全部用它们隔离，绝不读写真实数据目录）。
- 凭证文件绝不读取：`~/.local/share/opencode/{auth,session}.json`、网关 `creds.json`/`vk-cache.json`、`~/.zcode` 下凭证；适配器只访问声明的 db/目录本身。
- `/v1/todos` 必须插在 server.mjs:277 `url.startsWith('/v1/')` catch-all **之前**；读 query 用 `req.url` 原文（`url` 变量已在 :80 剥掉 query）。
- `/admin/report/*` 写端点照抄 server.mjs:170-187 三件套：非 POST → 405；非回环 Host → 403；写体 content-type 非 application/json → 415。
- 落盘用 providers-admin.mjs:50-58 模式：tmp（`${file}.${process.pid}.tmp`）→ chmod 0600 → renameSync。
- 测试全部进 `test/smoke.mjs`（spawn env :93-101 处加新变量），现有断言零回归。
- 在 worktree 分支 `worktree-workbench` 上开发；`./install.sh` 双目录拷贝清单新增文件必须同步加 cp 行。

## Review Focus

1. **时间窗非法值**（end≤start、跨度>92 天、非数字）→ generate 启动即 400，不产生 job → Task 8 测试。
2. **todos.json 坏文件 / 首次不存在** → 空列表起步不崩，下次写盘自动修复 → Task 1 测试。
3. **源不可用**（db/目录缺失、损坏）→ 该源降级为 0 + sourcesFailed 记原因，其余源继续 → Task 7 测试。
4. **报告生成上游失败**（401/超时/无可用模型）→ job 进 failed 带可读错误，不悬挂、不误报 done → Task 8 测试。
5. **坏行容错**（半截 JSON、空文件、空会话、emoji 多字节截断）→ 逐行跳过不崩，UTF-8 按码位截断 → Task 5/6/7 测试。

---

### Task 0: 基线快照提交

worktree 里复制自源目录的未提交变更（8 个 M + lib/、test/、CLAUDE.md 等未跟踪）先落一个基线 commit，让后续 feature commit 干净。

- [ ] **Step 1: 提交基线**

```bash
git add -A && git commit -m "基线快照：源目录当前未提交状态（lib 模块化 + 冒烟测试 + CLAUDE.md）"
```

- [ ] **Step 2: 验证干净**

Run: `git status --short`
Expected: 空（.claude/ 若出现属 worktree 元数据，加入 .gitignore 或不加都行，不阻塞）

---

### Task 1: 待办数据层 + `/v1/todos` CRUD

**Files:**
- Create: `lib/todos.mjs`
- Modify: `server.mjs`（路由，插在 /v1/models 分支之前）
- Test: `test/smoke.mjs`（新增「待办 API」段）

**Interfaces:**
- Produces: `listTodos(filter?) → todo[]`；`createTodo(input) → todo`（校验失败 throw httpError(400,…)，重复/超限规则见下）；`updateTodo(id, patch) → todo`（不存在 throw httpError(404)）；`deleteTodo(id)`（404 同理）；`todosInWindow(startMs, endMs) → {created:[], completed:[]}`（Task 7 消费）。todo 形状见 spec §6.1（id=randHex(6)、status/urgency 枚举校验、status→done 时盖 completed_at、时间戳毫秒整型）。
- 数据文件：`process.env.CANNBOT_TODOS_FILE || path.join(SCRIPT_DIR,'todos.json')`；启动加载（坏文件→`{version:1,todos:[]}` + log 警告）；每次变更原子写穿（tmp+rename+0600）。
- 校验：title 必填 ≤500 字符；note ≤2000；project ≤60；urgency ∈ {urgent,normal,someday}（缺省 normal）；status ∈ {pending,in_progress,done}；source 字符串 ≤60（缺省 "user"）。

- [ ] **Step 1: 写失败测试**

smoke.mjs 新段（fixture providers.json 已有 clientToken，直接复用 `GW`/token 帮手；spawn env 加 `CANNBOT_TODOS_FILE: path.join(tmp,'todos.json')`）：

```
无 token GET /v1/todos → 401
POST /v1/todos {title:"适配 unigemm SME"} → 201，urgency 缺省 normal，source 缺省 "user"
POST 带 {title, urgency:"urgent", project:"unigemm", note:"x", source:"agent:claude-code"} → 201 全字段
GET /v1/todos → 数组含 2 条；?status=done → 0 条
PUT /v1/todos/:id {status:"done"} → completed_at 非空
PUT 不存在 id → 404
DELETE /v1/todos/:id → 204；再 GET 少一条；DELETE 同 id → 404
POST {title: >500 字} → 400；POST {} → 400；POST {urgency:"高"} → 400
直读 todos.json：JSON 合法、todos 数量与 GET 一致、文件权限 0600
删掉 todos.json 写入坏 JSON → 重启网关进程 → GET /v1/todos → []（不崩）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/smoke.mjs`
Expected: 新段全 FAIL（404 路由不存在），既有段 PASS

- [ ] **Step 3: 实现 `lib/todos.mjs`**

模块级状态 + 上述接口；路由处理放 server.mjs：`/v1/todos`（GET/POST）与 `/v1/todos/:id`（PUT/DELETE，`:id` 取 `url.split('/')[3]` 后 decodeURIComponent），全部先 `checkClientAuth(req)`；POST/PUT 体用 `readRequestBody(req, 64*1024)` + JSON.parse（坏 JSON → 400）；**插在 /v1/models 分支之前**。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/smoke.mjs`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add lib/todos.mjs server.mjs test/smoke.mjs
git commit -m "待办系统：lib/todos.mjs 数据层（原子写穿 0600）+ /v1/todos CRUD（Bearer 鉴权、字段校验）"
```

---

### Task 2: providers.json 的 workbench 节

**Files:**
- Modify: `lib/config.mjs`（normalizeWorkbench + 挂键 + tryGetConfig 降级）
- Modify: `providers.template.json`（`_说明` 约定的 workbench 示例）
- Test: `test/smoke.mjs`（providers fixture 加 workbench 节，断言透传；坏值静默跳过）

**Interfaces:**
- Produces: `getConfig().workbench → { reportProvider?: string, reportModel?: string }`（normalize 风格照抄 normalizePricing：只收已知键、非法静默跳过 + log；缺省 `{}`）；`tryGetConfig()` 降级对象补 `workbench:{}`。

- [ ] **Step 1: 写失败测试**

```
fixture providers.json 加 "workbench":{"reportProvider":"oai","reportModel":"mock-model"}
GET /admin/config（回环）→ 响应含 workbench 节原样
另起临时配置（或单元级）：workbench 带非法类型值 → getConfig 不抛错、坏键被剔除
```

（第二项若 e2e 不好搭，允许进程内 `import('./lib/config.mjs')` 直测——参照 smoke.mjs 防泄漏注释 :22-24 的做法。）

- [ ] **Step 2: 跑测试确认失败 → Step 3: 实现 → Step 4: 跑测试通过**

normalizeWorkbench(raw)：raw 非对象→`{}`；reportProvider/reportModel 非空字符串才收。normalizeConfig 返回对象加 `workbench` 键；tryGetConfig 的降级空对象同步。

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs providers.template.json test/smoke.mjs
git commit -m "配置：providers.json 新增 workbench 节（reportProvider/reportModel，热加载，非法静默跳过）"
```

---

### Task 3: sqlite 封装 + zcode 源适配器

**Files:**
- Create: `lib/report/sqlite.mjs`
- Create: `lib/report-prompts.mjs`（本任务只建常量部分：`LIMITS`/`REDACT_PATTERNS`/`redact()`，PROMPTS 留 Task 7 补全——工具行截断与脱敏从最早的适配器起就统一引用它）
- Create: `lib/report/sources/zcode.mjs`
- Test: `test/smoke.mjs`（进程内直测适配器，不经 HTTP）

**Interfaces:**
- `lib/report/sqlite.mjs` Produces: `querySqlite(dbPath, sql) → Promise<rows[]>`——spawn `/usr/bin/sqlite3 -json -readonly <dbPath> <sql>`，stdout 整体 JSON.parse（sqlite3 -json 输出数组或空输出→[]）；dbPath 不存在/命令失败 → reject（调用方降级）；**SQL 里只允许内联 `Number()` 强转后的数字参数**（无 CLI 参数绑定，禁止内联用户可控字符串）。
- 源适配器统一接口（Task 5/6/7 消费）：`listSessions({startMs, endMs}) → Promise<session[]>`；`session = {source, sessionId, project, title, startTime, endTime, messages:[{role:'user'|'assistant', time, text}]}`；源不可用 → reject（collect 捕获）。env：zcode 用 `CANNBOT_ZCODE_DB`（缺省 `~/.zcode/cli/db/db.sqlite`）。
- zcode 查询要点（spec §5.2，SQL 草案在 spec）：session 筛 `task_type='interactive' AND time_deleted IS NULL AND time_updated>=start AND time_created<end`（毫秒）；**消息按 message.time_created 再滤窗口**；真实用户判别 `semantics.kind='user_prompt' AND semantics.origin='real_user'`；正文 part.type='text'→$.text，part.type='tool'→摘要行「工具名(关键参数)」（截 `LIMITS.toolArgsChars`，本任务建 LIMITS 后适配器即引用），reasoning/step-* 跳过；项目=session.directory；title=session.title；排序 message.sequence、part.sequence。

- [ ] **Step 1: 写失败测试**

测试用 `/usr/bin/sqlite3` 在 tmp 里建 fixture 库（CREATE TABLE 按适配器 SQL 引用的列建最小集），env `CANNBOT_ZCODE_DB` 指过去：

```
造 3 个 session：A interactive 窗口内（1 条真用户 + 1 条合成 user + 1 条 assistant 带 text part + 1 条 tool part）、
B subagent（应整会话排除）、C interactive 但消息全在窗口外（会话重叠选中后消息级过滤应清空 → session 不产出）
listSessions → 恰 1 个 session；messages 含用户文本与 assistant 文本、工具摘要行；
不含合成 user 内容；时间均为窗口内
env 指向不存在路径 → reject（await assert.rejects）
```

- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过**

- [ ] **Step 5: Commit**

```bash
git add lib/report/sqlite.mjs lib/report/sources/zcode.mjs test/smoke.mjs
git commit -m "报告源：sqlite3 spawn 封装 + zcode 适配器（interactive 会话、真实用户判别、消息级时间过滤、part 正文提取）"
```

---

### Task 4: opencode 源适配器

**Files:**
- Create: `lib/report/sources/opencode.mjs`
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: `querySqlite`（Task 3）。
- env：`CANNBOT_OPENCODE_DB`（缺省 `~/.local/share/opencode/opencode.db`）。
- 双路查询（spec §5.3）：主路 session JOIN message JOIN part（role=message.data.$.role、正文=part.data.$.text type=text、part.id ULID 排序、message.time_created 滤窗）；补路 event 表对 `message.updated.1`/`message.part.updated.1` 各 `ROW_NUMBER() OVER (PARTITION BY id ORDER BY seq DESC)=1` 取最终态再滤窗；两路结果按 sessionId 去重合并（主路优先）。**不使用 `GROUP_CONCAT(x ORDER BY y)`**（Apple sqlite3 3.54 不支持），拼装在 JS 侧。user 首条消息含大 system prompt：只 json_extract 需要的字段。合成输入启发式过滤：user 文本以「你是多 agent」或「你是多 agent 团队」开头 → 跳过。同目录 auth.json/session.json 绝不触碰。

- [ ] **Step 1: 写失败测试**

fixture 库：1 个 live 会话（session/message/part 表）+ 1 个 event-only 会话（只在 event 表）+ 1 个合成 user 消息（应滤）：

```
listSessions → 2 个 session；live 会话正文来自 part；event-only 会话正文来自 event 最终态
（event 里同一 part 造 pending/completed 两条 → 断言只取 completed 最终文本，不重复拼接）
合成 user 文本不在结果；窗口外消息不在结果；不存在路径 → reject
```

- [ ] **Step 2: 失败 → Step 3: 实现 → Step 4: 通过 → Step 5: Commit**

```bash
git add lib/report/sources/opencode.mjs test/smoke.mjs
git commit -m "报告源：opencode 适配器（session/message/part 主路 + event 事件溯源补路，全量快照取最终态）"
```

---

### Task 5: Claude Code 源适配器

**Files:**
- Create: `lib/report/sources/claude-code.mjs`
- Test: `test/smoke.mjs`

**Interfaces:**
- env：`CANNBOT_CC_DIR`（缺省 `~/.claude/projects`）。
- 只 glob 顶层 `<dir>/*.jsonl`（不递归，天然排除子代理）；逐行 JSON.parse 容错（坏行跳过）；真人输入判别 `type=='user' && typeof content=='string' && promptSource=='typed' && !isMeta`；assistant 取 `content[].type=='text'` 的 .text 拼接；isSidechain 行跳过（防御性）；项目路径取行内 `cwd`；标题取最后一条 ai-title；会话时间窗按行级 timestamp（ISO UTC → Date.parse）过滤；**UTF-8 截断按码位**（Array.from 处理后再 join，防 emoji 半截）——截断统一放 collect（Task 7），本任务只产出原文。

- [ ] **Step 1: 写失败测试**

fixture：`<tmp>/projects/-Users-x-test-proj/` 下 2 个 jsonl——

```
sess1.jsonl：typed user（窗口内）+ 斜杠命令 user（promptSource 缺省，应排除）+ tool_result 数组 user（应排除）
  + isMeta user（应排除）+ assistant 行（thinking 块 + text 块，只取 text）+ 末尾一行半截 JSON（容错）+ ai-title 行
sess2.jsonl：全部行窗口外 → 不产出
跨目录路径用行内 cwd 字段（目录名故意起成不可逆编码，断言 project 来自 cwd）
listSessions → 1 session；messages 恰为窗口内真输入 + assistant text
坏 jsonl（整体非 JSON 行）→ 跳过不崩
```

- [ ] **Step 2: 失败 → Step 3: 实现 → Step 4: 通过 → Step 5: Commit**

```bash
git add lib/report/sources/claude-code.mjs test/smoke.mjs
git commit -m "报告源：Claude Code 适配器（顶层 glob 排除子代理、promptSource 真人判别、ai-title、坏行容错）"
```

---

### Task 6: Cursor 源适配器

**Files:**
- Create: `lib/report/sources/cursor.mjs`
- Test: `test/smoke.mjs`

**Interfaces:**
- env：`CANNBOT_CURSOR_DIR`（缺省 `~/.cursor/projects`）。
- 只读精确路径模式 `<项目目录>/agent-transcripts/<uuid>/<uuid>.jsonl`（浅层，排除 `<uuid>/subagents/`）；项目路径=目录名把 `-` 还原为 `/`（`Users-tomhoyt-Desktop-x` → `/Users/tomhoyt/Desktop/x`）。
- 时间归因（spec §5.4 定案）：解析 user 行 text 内嵌 `<timestamp>Monday, Oct 26, 2026, 7:24 PM (UTC+8)</timestamp>`（正则 + Date 解析，注意星期与 12 小时制；解析失败忽略该标签）；会话选中=标签集合或文件 mtime 与窗口重叠；会话内取**最后一个窗口内 user 标签行**为锚点，保留锚点到会话尾；无窗口内标签 → 整会话保留并标记 `tailOnly:true`（collect 据此从尾往前截断）；assistant 行无时间 → 沿用最近一次 user 标签时间。

- [ ] **Step 1: 写失败测试**

fixture：`<tmp>/projects/Users-x-proj/agent-transcripts/<uuid>/<uuid>.jsonl`，含：窗口外 user 标签行 + 其后 assistant、窗口内 user 标签行 + 其后 assistant（无标签）、无标签 user 行；另造 `<uuid>/subagents/agent-1.jsonl`（应排除）：

```
listSessions → 1 session；messages 从窗口内锚点行开始（窗口外 user 与其 assistant 均不在）
  窗口内 assistant 的 time = 锚点时间
subagents 内容不在任何产出
全文件无窗口内标签 → session 仍产出且 tailOnly=true
空 transcript 目录（0 文件）→ 无产出不崩
```

- [ ] **Step 2: 失败 → Step 3: 实现 → Step 4: 通过 → Step 5: Commit**

```bash
git add lib/report/sources/cursor.mjs test/smoke.mjs
git commit -m "报告源：Cursor 适配器（agent-transcripts 浅层读取、user 标签锚点时间归因、子代理排除）"
```

---

### Task 7: prompt 常量 + 素材收集

**Files:**
- Modify: `lib/report-prompts.mjs`（补全 `PROMPTS = { systemProject, userProject(project), systemFinal, userFinal(ctx) }`，常量部分 Task 3 已建）
- Create: `lib/report/collect.mjs`
- Test: `test/smoke.mjs`

**Interfaces:**
- `lib/report-prompts.mjs` 本任务补全：
  - `PROMPTS = { systemProject, userProject(project), systemFinal, userFinal(ctx) }`（中文 prompt；systemFinal 含「绝不引用密钥/凭证/内部路径细节」防线；userFinal(ctx) 接收 `{rangeText, projects:[{name,summaryText}], todos, usage}` 返回完整用户消息；文风：客观陈述、按项目组织、突出产出与推进、结尾数据附注）
- `lib/report/collect.mjs` Produces: `collectMaterials({startMs, endMs}) → Promise<{projects:[{name, sessions, summaryText}], sources:{'claude-code':n, zcode:n, opencode:n, cursor:n}, sourcesFailed:[string], chars, todos:{created:[],completed:[]}, usage}>`
  - 4 源 Promise.allSettled 并发；reject 的源记 `sourcesFailed`（`${源名}: ${err.message}` 截 100 字），fulfilled 的计 sources 数
  - 项目归并：project 路径取 basename 为短名；同短名合并；每项目按 LIMITS 压缩（真人输入每条截 userMsgChars、assistant 每条截 assistantChars、工具行 toolArgsChars、会话总长 sessionChars **按码位截断**、cursor tailOnly 会话从尾往前取）+ 每项目超 sessionsPerProject 截断并附「另有 N 个会话未展开」
  - 全部文本过 `redact()`
  - todos 来自 `todosInWindow`（Task 1）；usage 来自 statsSnapshot 按天过滤聚合 `{totalRequests,totalTokens,totalCost,byProvider:{pid:{requests,tokens,cost}},outOfRange?}`（stats 只留 30 天，窗口更早则 outOfRange:true）

- [ ] **Step 1: 写失败测试**

复用 Task 3-6 的 fixture 目录（claude + cursor 指到 fixture，zcode/opencode 指到不存在路径）：

```
collectMaterials → projects 含 fixture 两项目；sourcesFailed 恰含 zcode 与 opencode 两条原因
  sources 计数正确；chars>0
脱敏：某 fixture 消息里埋 "sk-abcdefghijklmnop" → 产出文本含 [REDACTED] 不含原串
压缩：一条 2000 字 user 消息 → summaryText 中被截到 500（按码位）
todosInWindow 联动：先经 HTTP 建 2 条 todo（1 条完成）→ collect 的 todos.created/completed 各含对应项
usage：窗口内若有 mock 流量则计数>0；窗口全在 1970 → outOfRange:true
```

- [ ] **Step 2: 失败 → Step 3: 实现 → Step 4: 通过 → Step 5: Commit**

```bash
git add lib/report-prompts.mjs lib/report/collect.mjs test/smoke.mjs
git commit -m "报告管线：素材收集（4 源并发降级、项目归并压缩、脱敏预过滤、待办与用量佐证）+ prompt 常量集中"
```

---

### Task 8: 报告生成 + `/admin/report/*` 路由

**Files:**
- Create: `lib/report/generate.mjs`
- Modify: `server.mjs`（4 个端点，插 monitors 段后；404 清单更新）
- Test: `test/smoke.mjs`

**Interfaces:**
- `lib/report/generate.mjs` Produces:
  - `startReportJob({startMs, endMs}) → {jobId}`：窗口校验（end>start、跨度≤92 天、均为有限数字，否则 throw httpError(400)）；模块级单任务——`job.state==='running'` 时 throw httpError(409)；**同步置 running 后再异步执行**（保证 POST 返回即可见 409）
  - `getReportJob() → {state:'idle'|'running'|'done'|'failed', progress:{phase:'collect'|'summarize'|'final', projectsDone, projectsTotal}, error?, reportId?, startMs, endMs}`（idle=从未跑过）
  - `listReports() → 元数据[]`（不含 report 正文）；`getReport(id) → 报告`（404）；`deleteReport(id)`（404）
  - 任务体：collectMaterials → 逐项目一级总结（并发，每项目 requestUpstream，失败重试一次）→ 二级汇总 → 报告对象（spec §6.2 形状，id=randHex(6)）→ reports.json 原子写（env `CANNBOT_REPORTS_FILE`，上限 200 份删最旧）→ job=done
  - 模型解析兜底链（spec §6.2 定案）：resolveModelRoute(workbench.reportModel) → workbench.reportProvider||defaultProvider 的静态 models.list 第一个 → api source 拉聚合目录取该 provider 第一个（用 lib/models.mjs 现有聚合函数）→ 全失败 job=failed（error 指引配置 workbench 节）
  - 上游调用：requestUpstream 按 provider.protocol 分支（anthropic 必带 max_tokens，如 4096）；`stream:false`；timeoutMs 120_000；响应 `readBodyLimited(up, 512*1024)`；解析出文本（openai choices[0].message.content / anthropic content[].text 拼接）；一级全部失败 → failed；零会话素材 → 仍走完两级（报告如实说明）+ materials.sources 全 0
- server.mjs 端点（全部 isLocalHost）：`POST /admin/report/generate`（三件套+体≤4KB）；`GET /admin/report/job`；`GET /admin/report/list`；`GET|DELETE /admin/report/:id`（:id 从 url 尾段取；DELETE 免 415 与 providers 一致）

- [ ] **Step 1: 写失败测试**

fixture providers.json 的 workbench 节指 mock 上游（`{"reportProvider":"oai","reportModel":"mock-model"}`）；mock-upstream 非流式响应回显 `ECHO:{请求体}`：

```
POST /admin/report/generate {startMs,endMs}（窗口覆盖 claude/cursor fixture 会话时间）→ 200 {jobId}
立即再 POST（job 尚 running，mock 上游非流式但 generate 流程含两级+异步）→ 409
轮询 GET /admin/report/job → 到 done（progress 途经 collect→summarize→final；超时 30s 上限）
done 后 getReport(job.reportId) → report 含 "ECHO:"（模型收到了素材）；materials.sources 计数与 fixture 一致
GET /admin/report/list → 1 条元数据（无 report 正文字段）；DELETE :id → 204；GET :id → 404
窗口非法：end≤start → 400；跨度 100 天 → 400；非数字 → 400
防护：Host 非回环 → 403；POST text/plain → 415；GET 方法打 generate → 405
上游失败路径：另配 workbench 指向不存在 baseUrl 的 provider → 新 job → failed，error 含上游信息、getReportJob 不悬挂
无 workbench 节 + defaultProvider 有静态 list → 兜底链仍能出报告（ECHO 断言）
```

- [ ] **Step 2: 失败 → Step 3: 实现 → Step 4: 通过 → Step 5: Commit**

```bash
git add lib/report/generate.mjs server.mjs test/smoke.mjs
git commit -m "报告生成：两级总结状态机（单任务 409、进度可查、reports.json 存档上限 200）+ /admin/report/* 四端点三件套"
```

---

### Task 9: workbench.css 提取 + admin.html 改造 + 静态路由 + install.sh

**Files:**
- Create: `workbench.css`（从 admin.html `<style>` 18-392 行提取通用部分）
- Modify: `admin.html`（内嵌样式删通用部分、加 `<link rel="stylesheet" href="/workbench.css">`、rail 加「工作台」链接、19-21 单文件注释改写）
- Modify: `server.mjs`（`/workbench`、`/workbench.css` 静态路由插 107-115 段；404 兜底路径清单同步加这两个；workbench.html 暂 404 没关系，下个任务补文件——本任务先建占位文件）
- Modify: `install.sh`（cp 清单加两行；:10 拷贝说明注释更新）
- Test: `test/smoke.mjs`

- [ ] **Step 1: 写失败测试**

```
GET /workbench.css → 200 且 content-type text/css、含 --bg 类主题令牌
GET / → 200 且 HTML 含 <link ...workbench.css> 且不再含被提取的通用样式（如 body 网格底纹定义）
GET /workbench → 200 text/html（占位或成品皆可）
```

- [ ] **Step 2: 失败 → Step 3: 实现**（提取时保留 admin.html 视图专属样式原位；两页共用的 9 行首屏主题脚本各自内联）**→ Step 4: 通过**

- [ ] **Step 5: 浏览器目检 admin.html 主题不回归**

Run: `CANNBOT_PROXY_PORT=8485 CANNBOT_CONFIG_FILE=… node server.mjs` 后浏览器开 `http://127.0.0.1:8485/` 对照改前截图（深浅色各一遍，重点：底纹、卡片、表格、窄屏折叠）

- [ ] **Step 6: Commit**

```bash
git add workbench.css admin.html server.mjs install.sh test/smoke.mjs
git commit -m "前端：提取 workbench.css 共享主题（admin.html 改外链 + 加工作台导航）+ 静态路由 + install.sh 拷贝清单"
```

---

### Task 10: workbench.html 工作台页面

**使用 frontend-design 技能实现本任务的 UI。** 主题必须与 admin.html 严格一致（同一套 workbench.css 令牌）；求功能完整，不求精雕（用户明示前端后面再改）。

**Files:**
- Create: `workbench.html`
- Test: `test/smoke.mjs`（页面可测断言）+ 真实浏览器走查

**Interfaces:**
- Consumes: `/v1/todos` CRUD（Task 1）、`/admin/report/*`（Task 8）、`/admin/config` 取 token、`/workbench.css`。
- 结构：左 rail（管理台 `/` 链接 + 工作台当前项 + 主题切换三态按钮 + 9 行内联首屏主题脚本）+ 主体两区：
  - **待办区**：快速添加（标题/紧急度/项目标签）→ POST；列表按「进行中 → 待办（紧急在前）→ 完成（折叠）」分组；行内状态切换（PUT）、删除；agent 来源徽标（source 非 user 时显示）
  - **报告区**：预设区间按钮（今日/昨天/本周/上周/近7天/近30天）+ 自定义 datetime-local 起止（转本地日边界 epoch ms）；「生成报告」→ POST → 2s 轮询 job（进度文案：提取素材 / 分项目总结 (n/m) / 汇总成稿）→ done 渲染报告；「复制 Markdown」按钮（navigator.clipboard，失败回退 execCommand）；历史列表（list → 查看/删除）
  - Markdown 简易渲染（标题/列表/粗体/行内代码/代码块，先 esc() 再替换——**所有动态文本过 esc()**，参照 admin.html:710）

- [ ] **Step 1: 写失败测试**

```
GET /workbench → 200；含「工作台」「待办」「报告」字样；含 /workbench.css link；含 /admin/config 取 token 逻辑特征
```

- [ ] **Step 2: 失败 → Step 3: 实现（frontend-design 技能）→ Step 4: 通过**

- [ ] **Step 5: 浏览器全流程走查**

前台起 8485 实例（真实 providers.json），浏览器验证：建待办→改状态→删除；生成今日报告（真上游模型）→ 进度 → 报告渲染 → 复制；历史列表查看/删除；深浅色切换；窄屏（DevTools 375px）不散架

- [ ] **Step 6: Commit**

```bash
git add workbench.html test/smoke.mjs
git commit -m "工作台页面：待办管理 + 报告生成（预设/自定义区间、进度轮询、Markdown 渲染与复制、历史回看）"
```

---

### Task 11: 文档同步 + 全量回归

**Files:**
- Modify: `CLAUDE.md`（模块图、路由表、管理台章节、外部集成不变）
- Modify: `README.md`（「agent 用待办」指引文本 + curl 三命令示例、工作台页说明）
- Test: `node test/smoke.mjs` 全量

- [ ] **Step 1: 更新文档**（CLAUDE.md 加 lib/todos.mjs、lib/report/*、lib/report-prompts.mjs、workbench.html/css 与新路由；README 给可直接粘进 ~/.claude/CLAUDE.md 的 agent 指引）

- [ ] **Step 2: 全量回归**

Run: `node test/smoke.mjs`
Expected: 全绿（既有断言零回归 + 新增全过）

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "文档：工作台功能说明（模块图/路由表/agent 待办指引）"
```

---

## 完工后（用户指定）：几轮全量审查

代码全部完成后，按用户要求跑多轮全量审查（不属本计划任务序）：Workflow 多维度审查（正确性/安全/回归面/规范一致性）+ 对抗验证确认的发现 + 修复 + 复跑全量测试。
