# 个人工作台设计文档（待办 + AI 时间段工作总结）

日期：2026-10-27
状态：已与用户对齐产品形态与技术方案；builder check 已完成，4 个遗留问题已定案（见 §5.4、§5.2、§6.2）；用户豁免批准环节，授权直接实施 + 完工后全量审查

## 一、意图与为什么

本仓库现在是「统一订阅 API 网关 + 显示器切换器」。用户要把它升级为**个人工作台**：
在完全不动现有功能的前提下，新增两块能力——

1. **待办事项**：网页管理 + agent 可读写（人机共用的任务中枢）。
2. **AI 时间段工作总结**：选定时间范围 → 自动读本机各 coding agent 在该时段的对话
   记录 → AI 总结成一份**给领导看的**简短工作汇报。

为什么：用户的日常工作全部通过 coding agent（Claude Code、zcode、opencode、Cursor）
完成，工作痕迹散落在各工具的私有存储里；要向领导汇报时只能凭记忆。把提取 + 总结
做进常驻网关，汇报变成点一下按钮的事。

**质量迭代是明确需求**：用户会在使用中持续调整总结质量。所有 prompt、截断阈值、
报告结构集中在一个模块（`lib/report-prompts.mjs`），改起来一处生效。不需要网页端
可编辑，但要代码端好改。

## 二、目标 / 非目标 / 反目标

### 目标

- 待办 CRUD：标题、状态（待办/进行中/完成）、**紧急程度（紧急/普通/不急，用户点名要）**、
  可选项目标签、来源标记（人 or 哪个 agent）、时间戳。
- `/v1/todos` REST API，agent 经 Bearer token 用 curl 读写（与网关现有鉴权同源）。
- 时间段总结：预设（今日/昨天/本周/上周/近7天/近30天）+ 自定义起止；素材来自
  4 个 agent 数据源 + 待办变动 + 网关 stats 用量；两级总结（按项目小结 → 汇总成报告）。
- 报告为中文 Markdown、客观陈述、按项目组织、一键复制、生成后存档可回看。
- 报告生成的过程数据（各源提取了多少会话/字符）随报告存档，便于诊断质量问题。
- 一个新页面承载待办 + 报告（**用户指定同页**），与 admin.html 同主题、导航互通。
- 全部测试进 `test/smoke.mjs`，运行时产物用 env 隔离，不碰真实数据目录。

### 非目标

- 不做 MCP server（REST 已够；以后要加是套一层适配的事，REST 逻辑不变）。
- 不做定时自动生成报告（手动触发；以后要定时加一行 launchd 即可）。
- 不做 grokbot 接入（侦察确认：本地只有守护进程配置与加密凭证，无对话记录）。
- 不做截止日 / 子任务 / 负责人（单人工作台用不上，用户已确认）。
- 不做前端精雕（用户明示「先做成品，前端后面再改」；首版求功能完整、主题统一）。
- 不改项目名 / launchd label / 目录布局 / 现有任何端点行为。

### 反目标（做错了等于失败）

- **任何现有功能回归**：网关路由、翻译、统计、管理台、显示器切换必须原样。
- **读到凭证**：`~/.local/share/opencode/auth.json`、`session.json`、网关
  `creds.json`/`vk-cache.json`、`~/.zcode` 凭证文件等绝不读取；报告与提取产物中
  绝不出现密钥。
- **报告泄密**：对话记录里捞到的 token、路径细节等敏感串不得进入报告（提取层
  正则预过滤 + prompt 指令双保险）。
- **零依赖破戒**：只用 Node ≥18 内置模块 + spawn 系统 `/usr/bin/sqlite3`（3.54.0）。

## 三、约束（来自现有架构，已侦察核实）

- 零依赖 ESM：`server.mjs` + `lib/*.mjs`，无 package.json；Node v22.22.2（本机）。
- 双目录设计：改 `server.mjs`/`lib/`/`*.html` 后必须重跑 `./install.sh` 才在
  launchd 实例生效；运行时产物（todos.json、reports.json）落运行时目录
  `~/.local/share/cannbot-gateway-proxy/`，均提供 env 覆盖（测试隔离用）。
- `providers.json` 含全部订阅凭证：新配置节只加行为字段，绝不涉凭证；管理台写
  操作保留未知顶层键（现有行为），手写的 workbench 节不会被抹掉。
- 安全模式照抄现有：`/v1/*` 走 `checkClientAuth`（Bearer/x-api-key，timingSafeEqual）；
  `/admin/*` 写操作走「POST 405 + isLocalHost 403 + content-type application/json 415」
  三件套（见 server.mjs:170-187 monitors/switch 样板）。
- 路由插入点：`/v1/todos` **必须插在 server.mjs:277 的 `url.startsWith('/v1/')`
  catch-all 之前**，否则被当 OpenAI 请求转发上游（侦察标注的最大坑）。
- query string 在 server.mjs:80 已剥掉：读 query 用 `req.url` 原文。
- 上游调用复用 `lib/upstream.mjs` 的 `requestUpstream(provider, path, {…})`
  （upstream.mjs:30-63）：返回 fetch Response；**按 provider.protocol 分支**——
  openai 走 `/v1/chat/completions`，anthropic 走 `/v1/messages` 且 max_tokens 必填；
  响应体用 `lib/util.mjs` 的 `readBodyLimited(up, 上限)` 有界读回。
- 404 兜底信息里的路径清单要同步新增端点。
- install.sh 是显式 cp 清单（install.sh:49-57）：新 HTML/CSS 各加一行条件 cp；
  `lib/report/` 子目录由 `cp -R lib/.` 递归自动覆盖，无需改。

## 四、方案选择记录（与用户逐项确认过）

| 分叉 | 选项 | 结论 |
|---|---|---|
| agent 读写待办机制 | REST + curl 指引 vs MCP server | **REST**（半天量级；MCP 以后可套适配层） |
| 前端组织 | admin.html 单文件续命 vs 拆多页 | **拆多页**；但用户随后指定**待办+报告合并为一页**，故只新增 `workbench.html` + 共享 `workbench.css` |
| 报告数据源 | 从网关流量采 vs 直读 agent 本地记录 | **直读本地**（Claude Code 目前直连 GLM 不走网关，本地记录一份不漏） |
| 数据源范围 | 4 agent 全上 vs 核心两个 | **4 个全上**（Claude Code/zcode/opencode/Cursor；grokbot 无本地数据放弃） |
| 总结调用链 | 内部 requestUpstream vs HTTP 自环 | **内部直连**（无自环、复用凭证、统计口径可控） |

## 五、数据源事实（侦察结论，实现照此执行）

统一接口：每个适配器导出 `listSessions({ startMs, endMs })`，返回
`[{ source, sessionId, project, title, startTime, endTime, messages: [{ role, time, text }] }]`。
`messages` 是**压缩后的提取结果**（真人输入 + assistant 文本 + 工具调用摘要行），
不是原文全量。所有根路径支持 env 覆盖（测试隔离 + 以后数据目录迁移）。

### 5.1 Claude Code（`lib/report/sources/claude-code.mjs`）

- 根：`~/.claude/projects/`；env 覆盖 `CANNBOT_CC_DIR`。只读顶层 `*.jsonl`
  （不递归——子代理在 `<sessionId>/subagents/` 下，天然排除）。
- 真人输入判别式：`type=="user" && typeof message.content=="string" &&
  promptSource=="typed" && !isMeta`。字符串 content 但 `promptSource!=null=="typed"`
  的是斜杠命令回显，排除；content 为数组的是 tool_result，排除。
- assistant：`type=="assistant"` 取 `message.content[].type=="text"` 的 `.text`
  （**thinking 块字节量是 text 的 ~16 倍，必须排除**）。
- 项目路径取行内 `cwd` 字段（目录名编码有损，不能用目录名反推）。
- 会话标题取最后一条 `ai-title` 行的 `aiTitle`（本版本无 summary 行）。
- 时间戳 ISO 8601 UTC 毫秒（`2026-10-27T11:50:21.955Z`）；**跨天会话存在**，
  不得用文件 mtime 预筛（要么全读按行过滤，要么放宽窗口；量级全库 63.7MB 可全读）。
- 逐行 parse 必须容错（活跃会话尾部半截 JSON）。
- 量级：过滤后仅原体积 1-2%，7 天窗口实际处理 <1MB。

### 5.2 zcode（`lib/report/sources/zcode.mjs`）

- 根：`~/.zcode/cli/db/db.sqlite`；env 覆盖 `CANNBOT_ZCODE_DB`。
  spawn `/usr/bin/sqlite3 -json -readonly`（WAL 活库实测可读；**不要 immutable=1**）。
- 800MB 库，**先筛 session（389 行小表）再按 session_id 进 message**，避免全表扫。
- 会话筛选：`task_type='interactive'`（一半是子代理会话，必须滤）、
  `time_deleted IS NULL`、`time_updated >= winStart AND time_created < winEnd`
  （毫秒整数，**与秒混用会查不到任何数据**）。
- **消息级时间过滤（builder check 定案）**：会话按重叠选中后，消息再按
  `message.time_created` 过滤到窗口内（长期会话仅擦边窗口时，整段历史会挤爆
  每会话 2000 字预算、淹没窗口内真实工作，必须滤）。与 Claude Code 的行级过滤
  对齐，`listSessions` 契约语义统一为「返回窗口内的消息」；会话 startTime/endTime
  取窗口内消息的实际首末时间。
- 消息：message.data 只有元数据，**正文在 part 表**。真实用户消息判别：
  `json_extract(m.data,'$.semantics.kind')='user_prompt' AND
  json_extract(m.data,'$.semantics.origin')='real_user'`（user 消息 60%+ 是合成注入：
  todo_reminder/system_reminder 等，不过滤会把系统提醒当用户话）。
- 正文：part.data 按 type：text→`$.text`；tool→`$.tool` + `$.state.input`（只取
  工具名与关键参数做摘要行）；reasoning 排除。
- 项目路径：`session.directory`。排序：message.sequence + part.sequence。
- rollout jsonl 只保留最近 3 个会话（源码常量 aHs=3，设计使然），**不能当历史源**。

### 5.3 opencode（`lib/report/sources/opencode.mjs`）

- 根：`~/.local/share/opencode/opencode.db`；env 覆盖 `CANNBOT_OPENCODE_DB`。
- **双路查询必须都做**：session 表只剩 1 行，其余 13/14 历史会话只在 event 事件
  溯源表（用户删过会话）。
  - 主路：session JOIN message JOIN part（role 从 `message.data.$.role`；正文
    `part.data.$.text`，type=text；按 part.id（ULID 字典序=创建序）排序拼接）。
  - 补路：event 表对 `message.updated.1` / `message.part.updated.1` 各做
    `ROW_NUMBER() OVER (PARTITION BY <id> ORDER BY seq DESC)=1` 取最终态（事件是
    全量快照非增量，不取最后一条会把流式中间态重复拼入）。
- **Apple 定制 sqlite3 3.54 不支持 `GROUP_CONCAT(x ORDER BY y)`**：嵌套有序子查询
  或在 JS 侧拼接。
- user 首条消息 data 含完整 system prompt（数十 KB）：只 json_extract 需要的字段，
  别整读 data。
- 合成输入过滤：OpsTeam 插件注入的 user 消息（「你是多 agent 团队中的成员…」开头）
  启发式排除。
- **消息级时间过滤（builder check 定案）**：同 zcode——主路按
  `message.time_created` 滤窗口，补路按 event 快照内的 `$.time`/`$.info.time` 滤
  窗口；会话归并后 startTime/endTime 取窗口内消息实际首末。
- 同目录 `auth.json`/`session.json` 是凭证，**适配器只允许访问 db 文件本身**。
- 历史断层：2026-09-12 之前正文已丢，属已知事实不修复。

### 5.4 Cursor（`lib/report/sources/cursor.mjs`）

- 根：`~/.cursor/projects/`；env 覆盖 `CANNBOT_CURSOR_DIR`。
- 布局：`<项目编码目录>/agent-transcripts/<uuid>/<uuid>.jsonl`，每行
  `{"role":"user"|"assistant","message":{"content":[{"type":"text","text":…}]}}`。
  **只读这个精确路径模式（浅层 glob），不递归**——`<uuid>/subagents/*.jsonl` 是
  Cursor 的子代理记录（约占活跃项目 1/3 行数），与 Claude Code 同理排除
  （主会话已含用户意图与 agent 综合，子代理是探索过程噪音）。非项目编码的
  顶层目录（纯数字时间戳、`empty-window` 等）无 transcripts，自然跳过。
- **时间归因（builder check 定案）**：实测仅 user 行带
  `<timestamp>Monday, Oct 26, 2026, 7:24 PM (UTC+8)</timestamp>` 标签且不全；
  assistant 行（多数素材）**完全无时间字段**。归因规则：
  1. 会话选中 = 会话与窗口重叠（用会话内可解析的 user 标签时间集合 + 文件
     mtime 判断）；
  2. 会话内定位窗口段：取**最后一个落在窗口内的 user 标签行**为锚点，保留
     从锚点到会话末尾的内容（assistant 回复紧跟其后产生，无标签即为锚点
     后的响应）；
  3. 会话内解析不到任何窗口内标签 → 保留整个会话，压缩预算按**从尾往前**
     截断（最近的内容最可能是窗口内工作）；
  4. 刻意不选「整会话无脑全收」与「丢弃无标签内容」：前者会让旧内容淹没
     当日报告，后者会漏掉大部分 Cursor 工作。
- 项目路径由目录名反推（`Users-tomhoyt-Desktop-...` → `/Users/tomhoyt/Desktop/...`），
  与 Claude Code 不同这里目录名是可逆编码。
- role 区分 user/assistant 直接可得；空 transcript 目录（0 文件）跳过。
- 实现时先抽样验证 assistant 行结构与 content 块类型全集（本次侦察只核了 user 行）。

### 5.5 佐证数据（非对话源）

- **待办变动**：todos.json 中 `created_at/completed_at` 落在时间窗内的条目
  （新增了什么、完成了什么、紧急项清掉几个）。
- **网关用量**：`lib/stats.mjs` 按天/provider/模型分桶，取窗口内请求数/tokens/
  等效费用做数据附注（stats 只有 30 天保留，超窗如实标注「无数据」）。
- `~/.claude/history.jsonl`（全局 prompt 流）**首版不用**，留作后续增强素材。

## 六、详细设计

### 6.1 待办

**数据模型**（`todos.json`，env `CANNBOT_TODOS_FILE`，运行时目录；写穿式落盘——
变更即原子写，参照 providers-admin.mjs:50-58 的 tmp+rename+0600；todos 写频低，
不需要 stats 的防抖）：

```json
{ "version": 1,
  "todos": [
    { "id": "a1b2c3",          // randHex(6)
      "title": "…",             // 必填，一句话
      "status": "pending",      // pending | in_progress | done
      "urgency": "normal",      // urgent | normal | someday（紧急/普通/不急）
      "project": "unigemm",     // 可选自由文本标签
      "source": "user",         // "user" | "agent:<名字>"，如 "agent:claude-code"
      "note": "…",              // 可选备注（agent 加的待办放原始指令上下文）
      "created_at": 1793000000000,
      "updated_at": 1793000000000,
      "completed_at": null } ] }
```

**REST API**（`server.mjs` 插在 /v1/models 附近、catch-all 之前）：

- `GET /v1/todos`（可选 `?status=` 过滤）→ `{todos:[…]}`
- `POST /v1/todos` `{title, urgency?, project?, note?, source?}` → 201 + 完整对象
  （source 缺省 "user"；agent 调用时显式传 `source:"agent:xxx"`）
- `PUT /v1/todos/:id`（任意字段部分更新；status→done 自动盖 completed_at）→ 更新后对象
- `DELETE /v1/todos/:id` → 204

全部 `checkClientAuth(req)` 鉴权（Bearer，跨站表单带不了 Authorization 头，无需 415）。
title 上限 500 字符、note 2000、project 60（防滥用写爆）。

**agent 接入指引**：README 增加「agent 用待办」一节，给出可直接粘进用户全局
`~/.claude/CLAUDE.md` 的指引文本 + curl 示例（增/列/完成三命令）。不做自动写入
用户配置（不越权）；zcode/opencode 的接入由用户按同样文本贴到各自配置。

### 6.2 报告生成

**配置**（providers.json 新增节，`lib/config.mjs` 加 `normalizeWorkbench`，
normalizeConfig 挂 `workbench` 键；纯行为字段，getConfig 现读即热生效）：

```json
{ "workbench": { "reportProvider": "glm", "reportModel": "glm-5.3" } }
```

缺省回退链（builder check 定案，目标：升级后开箱即用、不配置也能点出第一份报告）：
1. 配置了 `workbench.reportProvider` + `reportModel` → `resolveModelRoute` 完整路由
   （享受 aliases / 显式 pid/model 机制）；
2. 只配了 provider（或全缺）→ provider 取 `workbench.reportProvider`，缺省
   `defaultProvider()`；model 取该 provider 静态 `models.list` 第一个；无静态
   list（api source）则拉一次目录取第一个；
3. 兜底仍失败（provider 无可用模型）→ job failed，error 文案明确指引
   「在 providers.json 的 workbench 节配置 reportProvider/reportModel」。
`providers.template.json` 带 `_说明` 注释示例（沿用模板既有约定；升级不覆盖
已有配置的机制不变）。校验风格参照 normalizePricing（非法静默跳过 + log）。

**提取与组装**（`lib/report/collect.mjs`）：

1. 并发跑 4 个 source 的 `listSessions({startMs, endMs})`（各自 try/catch——
   单源故障如 db 缺失降级为空列表 + 在报告素材里注明「源 X 不可用」，不让整个
   生成失败）。
2. 按 project 归并（路径→短名：取 basename；同名不同路径合并）。
3. 每会话压缩到预算内（阈值集中在 report-prompts.mjs 顶部常量）：真人输入每条
   截 500 字；assistant 文本每块截 300 字；工具调用只记 `工具名(关键参数≤80字)`；
   每会话上限 2000 字、每项目最多 15 个会话（超出附「另有 N 个会话未展开」）。
4. 脱敏预过滤：对提取文本跑正则替换——`sk-[A-Za-z0-9_-]{8,}`、`Bearer\s+\S+`、
   32+ 位连续 hex、`AKIA[A-Z0-9]+` 等样式 → `[REDACTED]`（模式表也放
   report-prompts.mjs 顶部，便于补充）。

**两级总结**（`lib/report/generate.mjs`，全部 prompt 在 `lib/report-prompts.mjs`）：

- 第一级（按项目，可并发）：项目素材 → 上游模型 → ≤200 字项目小结
  （做了什么/产出/状态）。
- 第二级（汇总）：全部项目小结 + 待办变动 + 用量附注 → 上游模型 → 最终报告
  （中文 Markdown；客观陈述、按项目分节、突出产出与推进；文末数据附注；
  系统指令明确「绝不引用密钥/凭证/内部路径细节」）。
- 上游调用：`requestUpstream` 按 provider.protocol 分支组包；
  `stream:false`；`readBodyLimited` 读回（上限 512KB）；一级失败重试一次，
  二级失败则整个任务失败（502 语义）。生成期间的调用**不计入 stats**
  （旁路，不做 tap——保持 stats「真实外部流量」口径纯净）。
- 超时：每级 `timeoutMs` 120s（只约束到响应头）。

**任务模型**（同进程内单任务串行）：

- `POST /admin/report/generate` `{startMs, endMs}`（epoch 毫秒，本地日边界由前端
  算好传入）→ 校验窗口（end>start、跨度 ≤92 天）→ 启动后台生成，立即返回
  `{jobId}`；已有任务在跑 → 409。
- `GET /admin/report/job` → `{state: running|done|failed, progress: {phase,
  projects_done/total}, error?}`（前端 2s 轮询）。
- 生成完成 → 报告对象原子落盘 `reports.json`（env `CANNBOT_REPORTS_FILE`；
  上限保留 200 份，超出删最旧）：

```json
{ "version": 1, "reports": [
  { "id": "r9f8e7", "range": {"start":…, "end":…}, "generated_at": …,
    "model": "glm-5.3", "provider": "glm",
    "materials": { "sessions": 42, "projects": 5, "chars_fed": 38000,
                   "sources": {"claude-code": 20, "zcode": 15, "opencode": 3, "cursor": 4} },
    "report": "# 工作汇报 …markdown…" } ] }
```

- `GET /admin/report/list` → 元数据列表（不含 report 正文，省流量）；
  `GET /admin/report/:id` → 完整报告；`DELETE /admin/report/:id` → 删除。
- 全部 admin 端点照抄三件套（POST 405 / isLocalHost 403 / application/json 415；
  GET/DELETE 只回环校验 + DELETE 免 415——表单伪造不出 DELETE，与 providers 一致）。
- SIGTERM 钩子：无状态可丢（reports 只在完成时落盘），不额外处理。

**失败语义**：某 source 不可用 → 继续（materials.sources 里如实记 0 + 报告附注）；
上游全挂 → job failed，error 带上游错误摘要；无任何会话素材 → 仍生成
（报告如实说「该时段未发现 agent 会话」，附待办/用量部分）。

### 6.3 前端（单页 `workbench.html` + 共享 `workbench.css`）

- 路由：`GET /workbench` → workbench.html（放根路径下，与 `/`（admin.html）平级；
  server.mjs 各加一条硬编码静态路由 + `GET /workbench.css`）。**不叫 /app/ 前缀**，
  减一层无谓命名。
- `workbench.css`：从 admin.html `<style>`（18-392 行）提取通用部分（主题令牌、
  body 底纹、.frame/.rail/.main 骨架、.sec/.card/.tbl、按钮/表单、badge、窄屏折叠，
  约 250-290 行）；admin.html 改为 `<link>` 引用并保留视图专属样式；每页仍内联
  9 行首屏主题脚本（防闪色必须 inline）。admin.html:19-21 的「单文件零依赖」
  设计注释同步改写。
- 页面结构（frontend-design 技能实现，求功能完整 + 主题统一，不精雕）：
  - 左 rail 与 admin.html 同构：管理台（`/`）· **工作台（当前页）**；主题切换按钮。
  - **待办区**：快速添加框（标题 + 紧急度 + 项目标签）；列表按状态分组
    （进行中 → 待办（紧急优先）→ 已完成折叠）；行内操作：状态切换 / 编辑 / 删除；
    agent 来源徽标。
  - **报告区**：预设区间按钮组（今日/昨天/本周/上周/近7天/近30天）+ 自定义
    datetime 起止；「生成报告」按钮 → 2s 轮询进度（阶段：提取素材 → 分项目
    总结 (3/5) → 汇总成稿）；报告渲染（Markdown 简易转 HTML，esc() 防注入）+
    「复制 Markdown」按钮；历史报告列表（时间段 / 生成时间 / 查看 / 删除）。
  - 取 token 照抄 admin.html 的 loadToken()/apiFetch() 模式（GET /admin/config
    仅回环拿 clientToken；/v1/todos 自动带 Bearer；401 重取一次）。
- admin.html 左 rail 加「工作台」链接（`<a href="/workbench">`）。

### 6.4 server.mjs 改动汇总

1. `/v1/todos` CRUD（插 /v1/models 附近，catch-all 之前）。
2. `/workbench`、`/workbench.css` 静态路由（插 107-115 段）。
3. `/admin/report/*`（generate/job/list/:id，插 monitors 段之后，三件套）。
4. 404 兜底路径清单更新。

### 6.5 测试（test/smoke.mjs 增段）

- env 新增：`CANNBOT_TODOS_FILE`、`CANNBOT_REPORTS_FILE`、
  `CANNBOT_CC_DIR`、`CANNBOT_ZCODE_DB`、`CANNBOT_OPENCODE_DB`、
  `CANNBOT_CURSOR_DIR` 全部指到 fixture 临时目录（spawn env 93-101 处加）。
- **待办段**：无 token 401 → POST 建 → GET 列表 → PUT 改状态（completed_at
  盖章）→ DELETE → 持久化断言（重启网关进程或直读 todos.json）；title 超限 400。
- **报告段**：fixture 造 2 个假源目录（claude-code 造 1 个 jsonl 项目 × 2 会话、
  cursor 造 1 个 transcript；zcode/opencode 造极小 sqlite——用 sqlite3 CLI 生成
  含 1 session/1 message/1 part 的库，或 env 指到不存在路径断言降级路径）；
  providers.json fixture 的 workbench 节指向 mock-oai → POST generate → 轮询
  job 到 done → 报告正文含 `ECHO:` 前缀（mock 回显请求体的既有机制）→
  materials 计数正确 → list/:id/delete 全通 → 409 并发防护 → 回环/415 防护
  → 时间窗校验 400。
- **静态页段**：`/workbench` 200 且含标题、`/workbench.css` 200 text/css、
  `/` 仍 200（admin 不回归）。
- **回归**：既有 167 项断言全绿不回归。

### 6.6 文档同步

- CLAUDE.md：模块图加 lib/todos.mjs、lib/report/*、lib/report-prompts.mjs、
  workbench.html/workbench.css；路由表加新端点；常用命令不变。
- README：「agent 用待办」指引文本 + curl 示例；工作台页说明。
- install.sh:10 拷贝说明注释更新。

## 七、留给实现的决定（builder 自定，均为低风险）

- workbench.html 具体布局与交互细节（frontend-design 技能发挥，主题必须与
  admin.html 严格一致）。
- 压缩/截断阈值的具体数值（report-prompts.mjs 顶部常量，初版按 6.2 给的默认）。
- reports.json 保留份数上限（设计 200，可调）。
- Markdown→HTML 的简易渲染实现（无依赖手写，覆盖标题/列表/粗体/代码块即可）。
- 项目短名归并的具体规则实现细节（basename 为主）。
