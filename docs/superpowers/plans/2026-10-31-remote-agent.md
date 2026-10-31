# 远程 Agent 控制台（gateway.terminal）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机浏览器经第四个监听 `gateway.terminal`(8492) 远程拉起/观看/操作 opencode agent（聊天、批准权限、答选择题），断线重连靠重拉历史。

**Architecture:** 网关内托管一个 `opencode serve` 子进程（随机口令、崩溃退避重启、pidfile 防孤儿）；terminal 监听把 opencode 方言翻译成自家 `/term/v1/*` 窄契约（白名单项目、会话归属校验、SSE 事件桥）；`term.html` 移动页由该监听托管。主监听 8484 一行不动。

**Tech Stack:** Node ≥18 内置模块（http/child_process/crypto/fs），零 npm 依赖；测试为自研脚本（无测试框架）。

**Spec:** `docs/superpowers/specs/2026-10-31-remote-agent-design.md`（已获批准；本计划不重复其论证，冲突时以 spec 为准）

## Global Constraints

- 零依赖：只用 Node 内置模块；无 package.json/node_modules（spec §项目约定）。
- 注释、commit message、日志文案全部中文。
- `OPENCODE_SERVER_PASSWORD` 明文**绝不**出现在：任何 HTTP 响应体、proxy.log、pidfile、health 输出。
- 主监听 `server.mjs` 的 `listen(PORT, HOST)`（8484）一行不动；新监听照 `lib/tv-server.mjs` 的管线顺序。
- token 撞车（与 clientToken / gateway.tv.tokens / gateway.sync.tokens 相同）→ 丢 terminal 那枚并 `log()` 警告。
- `gateway.terminal` 加入 `SYNC_ROLE_GATEWAY_KEYS`，永不进 Mac↔Mac 同步。
- 会话归属/白名单失败一律 **404**（不泄漏存在性）；鉴权失败 401；CIDR/Host 失败 403。
- 改动 `server.mjs`/`lib/`/`term.html` 后需 `./install.sh` 才对 launchd 实例生效（本计划只改源目录）。
- 测试端口：GW 6296、TERM 6297、mock 后端 6298（6290–6295 已被占用）。

## Review Focus

1. **SSE 上游断流**（opencode 重启/网络抖动）：网关不能崩——上游流 error/end 时关掉所有下游 SSE、退避重连；下游客户端断开不拖垮桥。
2. **超长内容**：tool output >8KB、input >2KB、历史一屏拉不完——截断必须真的生效（mock 造 1MB 输出断言 ≤8KB）。
3. **路径注入**：`:id` 里塞 `../../`、`%2F`、空串——必须 404，不得拼进上游 URL 造成越权访问。
4. **空 projects 白名单**：sessions 返回 `[]`、POST /sessions 400（不是 500）、pending `[]`。
5. **并发 SSE**：两个客户端同挂一个会话都收到事件；一个断开不影响另一个。

---

### Task 1: 配置层——`normalizeTerminal` + 同步排除 + 模板

**Files:**
- Modify: `lib/config.mjs`（`normalizeSyncClient` 之后加 `normalizeTerminal`；`normalizeConfig` 的返回对象加 `terminal` 键，约 133 行处）
- Modify: `lib/sync-config.mjs:17`（`SYNC_ROLE_GATEWAY_KEYS` 数组加 `'terminal'`）
- Modify: `providers.template.json`（gateway 节内 `syncClient` 之后加 `terminal` 节）
- Test: `test/terminal-unit.mjs`（新建，后续任务往里加用例）

**Interfaces:**
- Produces: `normalizeTerminal(raw, clientToken = null, tvRaw = null, syncRaw = null)` →
  `{ enabled:boolean=false, port:8492, bind:'0.0.0.0', tokens:[{name,token}], allowedCidrs:string[], maxPerMinute:120, backendPort:4096, backendBin:'', projects:[{name,dir}] }`
  - `allowedCidrs` 默认 `['192.168.0.0/16','10.0.0.0/8','172.16.0.0/12','100.64.0.0/10','127.0.0.1/32','::1/128']`（导出为 `TERMINAL_DEFAULT_CIDRS`，照 `SYNC_DEFAULT_CIDRS` 形状）。
  - `projects`：每项 `{name,dir}`；`dir` 必须绝对路径（`path.isAbsolute`）且 `fs.realpathSync` 成功且是目录，否则**丢弃该项**并 `log('警告: gateway.terminal.projects 项「x」不是存在的目录，已忽略')`；`name` 去空白截 40 字符，空则取 `path.basename(dir)`；按 `dir` 去重留第一条。
  - token 收集逻辑照 `normalizeSync`：剥出 `gateway.tv.tokens` 与 `gateway.sync.tokens` 的 token 集合，命中即丢并警告。
- Produces: `getConfig().terminal`（经 `normalizeConfig` 挂上）。

- [ ] **Step 1: 写失败测试**（`test/terminal-unit.mjs`，自研脚本风格照 `test/tv-unit.mjs`：`check(name, cond)` 计数 + 末尾汇总 exit code）

用例（含 `TERMINAL_DEFAULT_CIDRS` import 断言）：
```js
// 1. undefined → 全默认（enabled:false、port:8492、projects:[]、cidrs=TERMINAL_DEFAULT_CIDRS）
// 2. token 与 clientToken 相同 → 该枚被丢、其余保留
// 3. token 与 tv.tokens / sync.tokens 中的 token 相同 → 被丢
// 4. projects: 相对路径 'foo' → 丢弃；'/tmp'（存在）→ realpath 为 '/private/tmp' 且 name 回落 'tmp'
// 5. projects 重复 dir → 留第一条；name 空白 → basename；name 超 40 字 → 截断
// 6. allowedCidrs 非法项（'999.1.1.1/8'）剔除；自填合法值则完全替换默认
// 7. port/bind/maxPerMinute/backendPort 非法值回落默认
// 8. SYNC_ROLE_GATEWAY_KEYS 含 'terminal'（import 断言）
```

- [ ] **Step 2: 跑测试确认失败** — `node test/terminal-unit.mjs`，期望 import 报错（`normalizeTerminal` 不存在）。
- [ ] **Step 3: 实现 `normalizeTerminal`** 并接线 `normalizeConfig`、`SYNC_ROLE_GATEWAY_KEYS`；`providers.template.json` 加节（照 spec §五 的 jsonc 内容落成合法 JSON + `_说明` 字段，token 留空、projects 留空数组 `[]`）。
- [ ] **Step 4: 跑测试通过 + 回归** — `node test/terminal-unit.mjs` 全绿；`node test/smoke.mjs` 全绿（默认关闭不影响现状）。
- [ ] **Step 5: Commit** — `git add lib/config.mjs lib/sync-config.mjs providers.template.json test/terminal-unit.mjs` → `feat(terminal): gateway.terminal 配置归一（token 撞车/项目白名单/CIDR）`

### Task 2: 适配层纯函数——消息/事件/待批归一

**Files:**
- Create: `lib/terminal/adapter.mjs`
- Test: `test/terminal-unit.mjs`（追加「适配层」段）

**Interfaces:**
- Consumes: opencode 实测形状（spec §三 表 + 下面的补充；**字段名区分大小写**）：
  - 消息：`{info:{id,role,time:{created,completed}},parts:[…]}`
  - part（12 种）：`text{text,synthetic?,ignored?}` / `reasoning{text}` / `tool{tool,callID,state:{status,input,output,error,metadata,time}}` / `patch{files}` / `file{mime,filename}` / `step-start{}` / `step-finish{reason,cost,tokens}` / 其余丢弃
  - 事件信封：`{type, properties:{…}}`；`message.part.updated` → `properties:{sessionID, part, time}`；`message.part.delta` → `properties:{sessionID, messageID, partID, field, delta}`；`session.status` → `properties:{sessionID, status:{type}}`；`session.idle` → `properties:{sessionID}`；`message.updated` → `properties:{sessionID, info}`；`permission.asked`/`permission.replied` → `properties:{id, sessionID, permission, patterns, metadata, always?, reply?}`；`question.asked` → `properties:{id, sessionID, questions:[{question,header,options:[{label,description}],multiple?,custom?}]}`
- Produces:
  - `truncate(s, maxBytes)` — 按字符截断（先 `JSON.stringify` 非 string），尾缀 `…(截断)`
  - `normalizePart(p)` → spec §七 表的形状（每个带 `id`、`messageId`）或 `null`（丢弃）
  - `normalizeMessage(m)` → `{id, role, at, parts:[…]}`（`at` = `info.time.created`；parts 全 null 的消息仍返回、parts 为 `[]`）
  - `mapEvent(ev)` → `null` 或 `{event:'part'|'delta'|'status'|'pending', sessionID, data}`：
    - `part.updated` → `{event:'part', data: normalizePart(properties.part)}`
    - `part.delta` → `{event:'delta', data:{messageId, partId, field, delta}}`
    - `session.status`/`session.idle` → `{event:'status', data:{busy: …}}`（idle → busy:false）
    - `message.updated` → `{event:'status', data:{messageId, role, completed}}`
    - `permission.*`/`question.*` → `{event:'pending', data:null}`（详情走 pending 端点重拉，不在事件里带——宁重拉不错漏）
    - `server.*`/`session.updated`/`session.diff`/`plugin.*`/`catalog.*`/`reference.*`/`integration.*`/其余 → `null`
  - `normalizePermission(p, sessionTitle)` → `{kind:'permission', id, session, sessionTitle, summary:'bash', detail:'ls /tmp', options:null}`（`summary`=permission 类型；`detail`= `metadata.command` ?? `patterns.join(' ')`）
  - `normalizeQuestion(q, sessionTitle)` → `{kind:'question', id, session, sessionTitle, summary:q.questions[0].header, detail:q.questions[0].question, options:{questions:[…原样…], multiple, custom}}`

- [ ] **Step 1: 写失败测试** — 12 种 part 逐条断言（用上面 Interfaces 的字段名造 fixture）；截断边界（8192/2048）；`synthetic:true` 丢弃；`mapEvent` 对每种事件类型断言（含 `session.idle` → busy:false、未知类型 → null）。
- [ ] **Step 2: 跑测试确认失败** — import 报错。
- [ ] **Step 3: 实现 `adapter.mjs`**（纯函数、无 I/O、无 import）。
- [ ] **Step 4: 跑测试通过** — `node test/terminal-unit.mjs`。
- [ ] **Step 5: Commit** — `feat(terminal): 消息/事件/待批归一纯函数（adapter）`

### Task 3: opencode HTTP 客户端

**Files:**
- Create: `lib/terminal/opencode.mjs`
- Test: `test/terminal-unit.mjs` 不适用（有 I/O）→ 本任务的验证并入 Task 6 端到端；此处只做接口交付。

**Interfaces:**
- Produces: `createOpencodeClient({ baseUrl, password, timeoutMs = 15000 })`，方法全部返回 JSON（204 返回 `null`），失败抛 `{status, message}` 形状的 Error（带 `.upstream = true`）：
  - `health()` → `GET /global/health`
  - `listSessions()` → `GET /session`（全局，不按目录）
  - `sessionStatus()` → `GET /session/status`（全局 busy 表）
  - `createSession({ directory, title })` → `POST /session?directory=…`
  - `messages(sessionId, { directory, limit, before })` → `GET /session/:id/message?…`
  - `promptAsync(sessionId, { directory, text })` → `POST /session/:id/prompt_async?…`，body `{parts:[{type:'text',text}]}`（text >200000 字符在客户端就抛 413，不发请求）
  - `abort(sessionId, { directory })` → `POST /session/:id/abort?…`
  - `permissions(directory)` → `GET /permission?directory=…`
  - `replyPermission(id, { directory, reply })` → `POST /permission/:id/reply?…` body `{reply}`
  - `questions(directory)` → `GET /question?directory=…`
  - `replyQuestion(id, { directory, answers })` / `rejectQuestion(id, { directory })`
  - `openEvents()` → 发起 `GET /event`（**无限时**，`timeoutMs` 不适用），返回 `{ response, asyncIterator }`：`asyncIterator` 逐条 yield 解析后的事件对象（按 `\n\n` 分帧、剥 `data: ` 前缀、`JSON.parse`，解析失败跳过不中断）
  - 鉴权：所有请求带 `Authorization: Basic base64("opencode:" + password)`。
  - **`:id` 拼路径前先校验** `!/^[A-Za-z0-9_-]+$/.test(id)` 即抛（防路径注入，Review Focus #3 的客户端半边）。

- [ ] **Step 1: 实现客户端**（fetch + AbortSignal.timeout；错误读 body 取 `error.message` 兜底 `e.message`）。
- [ ] **Step 2: 语法自检** — `node --check lib/terminal/opencode.mjs`。
- [ ] **Step 3: Commit** — `feat(terminal): opencode HTTP 客户端（basic auth + 事件流解析）`

### Task 4: 后端子进程监管（host）

**Files:**
- Create: `lib/terminal/host.mjs`
- Test: `test/terminal-unit.mjs`（追加「host 纯逻辑」段：pidfile 判定函数单测）

**Interfaces:**
- Consumes: `tryGetConfig().terminal`（每请求现读）、`randHex`（util.mjs）、`log`（log.mjs）、`createOpencodeClient`（Task 3）
- Produces: `createBackendHost({ getConfig = tryGetConfig, pidFile, env = process.env, spawnFn = spawn, execFn = execFileSync, now = Date.now })`（全部可注入，测试不用真进程）：
  - `start()` → Promise<void>：enabled 时拉起；流程 = 读 pidfile 收孤儿 → 解析 bin → 合并 PATH → spawn → 就绪探测 → 僵尸清扫 → 写 pidfile → `state='ready'`
  - `stop()` → 杀子进程（SIGTERM，5s 后 SIGKILL）、删 pidfile、`state='down'`
  - `restart()` → 重置失败计数后走 start（`down` 的唯一出口）
  - `status()` → `{ state:'starting'|'ready'|'retrying'|'down', version, pid, restarts, error, log:[最近 50 行] }`
  - `client()` → 就绪时返回 opencode 客户端，否则 null
  - `onEvent(fn)` → 状态变化回调（供 server 推 `event: status`）
  - 内部规则（spec §八 全文照做）：
    - 口令 `randHex(16)`（32 hex），每次 spawn **新生成**；子进程 stdout/stderr 行进环形缓冲（50 行），行内出现口令则替换为 `***`
    - bin 解析：`terminal.backendBin` → `env.CANNBOT_OPENCODE_BIN` → 在合并 PATH 里 `command -v opencode`（`execFn` 注入便于测试）；都无 → `state='down'`、`error='未找到 opencode，请设置 gateway.terminal.backendBin'`
    - PATH 合并：`execFn(userShell, ['-lc','printf "%s" "$PATH"'], …)` 一次并缓存（失败用 `process.env.PATH` 兜底）；子 env = `{...env, OPENCODE_SERVER_PASSWORD, PATH: 合并值}`；userShell 取 `env.SHELL ?? '/bin/zsh'`
    - 就绪探测：每 250ms `client.health()`，20s 超时 → 记失败走退避
    - 崩溃重启：非主动 stop 的 exit → 退避 `1s,2s,5s,15s,60s` 封顶，连续 5 次失败 → `state='down'` 停止自动重试
    - 孤儿 pidfile：pid 存活**且** `ps -p <pid> -o command=` 含 `opencode` 与 `--port <backendPort>` → SIGTERM 等 3s 再 SIGKILL；命令行对不上（别人的进程）→ 不杀；若随后 spawn `EADDRINUSE` → `down` 报「端口被占用且不是本网关启动的实例」
    - 僵尸清扫：就绪后取 `sessionStatus()`，对 **config.projects 目录内** 的 busy 会话逐个 `abort()`；只做一次/每次成功拉起
  - pidfile 路径：默认 `<运行时目录>/terminal-backend.json`（server.mjs 传入；内容 `{pid, startedAt, bin}`，0600，**不含口令**）
- Produces（纯函数，单独导出供单测）：`shouldKillOrphan(pidInfo, { alive, command, backendPort })` → boolean

- [ ] **Step 1: 写失败测试** — `shouldKillOrphan` 四例：活+命令行匹配→true；活+不匹配→false；不活→false；命令行匹配但端口不同→false。pidfile 读写与 0600 权限、口令打码（造含口令的行断言输出含 `***` 不含明文）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现 `host.mjs`**。
- [ ] **Step 4: 跑测试通过** — `node test/terminal-unit.mjs`。
- [ ] **Step 5: Commit** — `feat(terminal): opencode 子进程监管（拉起/退避重启/pidfile 防孤儿/僵尸清扫）`

### Task 5: mock opencode 后端

**Files:**
- Create: `test/mock-opencode.mjs`

**Interfaces:**
- Produces: **可执行脚本**（首行 `#!/usr/bin/env node` + `chmod +x`，git 保留执行位——`backendBin` 只收单个路径，不能带参数），调用形态 `test/mock-opencode.mjs serve --port <p> --hostname 127.0.0.1`，环境变量 `OPENCODE_SERVER_PASSWORD`（要求 Basic auth，与真实一致）、`MOCK_STATE_FILE`（JSON 状态：sessions/messages/busy/pending，**跨重启存活**——重启后 busy=true 的会话模拟僵尸轮次）。工具大输出**由提示词触发**：文本含 `big-output` → 产出 1MB 输出的 tool part（免起第二个网关实例测截断）。
- 行为约定（Task 6 断言依赖）：
  - `GET /global/health` → `{healthy:true, version:'mock-1.0'}`
  - `GET /session`（无 directory → 全部）/ `POST /session?directory=` 建会话（id `ses_mockN`，自增持久化在状态文件）
  - `GET /session/status` → busy 表（从状态文件恢复，模拟僵尸）
  - `GET /session/:id/message` → 历史；`POST /session/:id/prompt_async` → 204 后异步：若文本含 `ask-permission` → 建待批（`permission:'bash'`、`metadata.command:'echo test'`）+ 事件流发 `permission.asked`，**busy 保持到 reply**；含 `ask-question` → 建待答（两个选项 label A/B）+ `question.asked`；否则产出 user text part → assistant `message.part.delta`×2 → `message.part.updated`（text/reasoning）→ `message.updated` → `session.idle`
  - `POST /session/:id/abort` → busy 清、running tool part 置 error `{interrupted:true}`
  - `GET /permission?directory=` → **只回该目录的待批**；不带 directory → `[]`（与真实一致）；`POST /permission/:id/reply?directory=` → directory 不匹配 **404**；匹配则移除待批、完成该轮（产出 tool part + text part + idle 事件、busy 清）
  - `/question` 系列同构；`GET /event` → SSE（订阅者广播，`data: {json}`，含初始 `server.connected`）
  - 未带正确 Basic auth → 一律 401

- [ ] **Step 1: 实现 mock**（单文件 http server，~250 行）。
- [ ] **Step 2: 手工冒烟** — 起两个终端目录各建一会话、各发 `ask-permission`，断言 `GET /permission` 全局空、带 directory 各一条；kill 重启后 busy 僵尸还在、abort 可清。（curl 脚本一次性验证，命令写在 commit message 外的测试文件注释里即可）
- [ ] **Step 3: Commit** — `test(terminal): mock opencode 后端（目录作用域/待批/僵尸轮次/事件流）`

### Task 6: terminal 监听 + 端到端测试

**Files:**
- Create: `lib/terminal/server.mjs`
- Modify: `server.mjs`（启动处加 `terminalReady = startTerminalServer()`；SIGTERM/SIGINT 处理加 stop；import）
- Test: `test/terminal.mjs`

**Interfaces:**
- Consumes: `createBackendHost`（Task 4）、`createOpencodeClient`（Task 3）、adapter（Task 2）、`hostAllowed/inCidrs/normalizeAddress`（tv-net.mjs）、`safeEqual`（gwauth.mjs）、`createRateLimiter/bucketKey`（tv-server.mjs）、`tryGetConfig`、`sendJson/httpError/randHex`（util.mjs）、`log`
- Produces: `startTerminalServer()` → `{ server, port } | null`（未启用/无 token/起不来 → null + 日志）
- 路由（管线顺序照 tv-server：Host → CIDR → 白名单路由 → token → 限速）：
  - `GET /term`、`GET /term/theme.css` → 静态文件（`term.html`/`theme.css`，免 token，**不进失败限速桶**）
  - `GET /term/v1/health` → `{ok, backend:{state,version,pid,restarts,error,log}, projects:n, pending:n}`（log 尾 20 行）
  - `POST /term/v1/backend/restart` → 202 触发 `host.restart()`
  - `GET /term/v1/projects` → `[{name, dir}]`
  - `GET /term/v1/sessions` → 白名单内会话（`listSessions()` 过滤 + `sessionStatus()` busy + pending 计数），按 `time.updated` 倒序
  - `POST /term/v1/sessions` `{project, title?}` → project 名必须在配置里（**忽略 body 里的任何 dir 字段**）；空 projects → 400
  - `GET /term/v1/sessions/:id/messages?limit=&before=` → 归一消息，limit 默认 100 上限 200；`:id` 越白名单 → 404
  - `POST /term/v1/sessions/:id/input` `{text}` → 202（空 400、>200k 413）
  - `POST /term/v1/sessions/:id/abort` → 200
  - `GET /term/v1/pending` → **逐白名单目录** `permissions(dir)+questions(dir)` 归并，带 sessionTitle；可选 `?session=` 只留该会话的
  - `POST /term/v1/approvals/:id` `{decision:'once'|'always'|'reject'}` → 先从 pending 列表反查该 id 所属目录（查不到 404），用该目录 reply
  - `POST /term/v1/questions/:id` `{answers:[[…]]}` 或 `{reject:true}`
  - `GET /term/v1/events?session=` → SSE（`text/event-stream`）：`event: hello` → `event: part/delta/status/pending`（pending 事件不带详情，页面收到后重拉 `/pending`）→ 注释 `: ping` 每 15s；上游桥 = **单条**上游 `openEvents()` 连接 + `mapEvent` 过滤（无 session 参数时只放行 pending/status）+ 订阅者扇出；上游断流 → 关全部下游、退避 1s/5s/30s 重连、重连成功不重放（页面靠重拉消息）
  - **token 只认 `Authorization: Bearer`**；query 参数里出现 token 一律无视（spec §七红线）
  - 会话归属统一入口 `assertSessionAllowed(id)`：`listSessions()`（无 directory，**实测返回全部目录的会话**）里 `find(s => s.id === id)` → 拿 `s.directory` 与 projects 比对（realpath 后相等）；找不到或不属于 → 抛 404。**每个** `:id` 路由都必须先过它
- server.mjs 接线：`terminalReady = startTerminalServer()`（listen 回调内，syncClient 之后）；退出处理 `terminalReady?.host?.stop()`；pidfile 路径 = `path.join(运行时目录, 'terminal-backend.json')`（与 LOG_FILE 同目录推导，`CANNBOT_TERMINAL_PID_FILE` 可覆盖）

- [ ] **Step 1: 写端到端测试 `test/terminal.mjs`**（结构照 `test/tv.mjs`：临时目录配置、spawn 网关子进程、`check()` 计数）：
  配置 `gateway.terminal = { enabled:true, port:6297, bind:'127.0.0.1', tokens:[{name:'phone',token:'…'}], backendPort:6298, backendBin:'<ROOT>/test/mock-opencode.mjs', projects:[{name:'甲',dir:tmpA},{name:'乙',dir:tmpB}] }`。
  断言清单（每条一个 check）：
  ```text
  鉴权管线：/term 免 token 200 且含 '<title>'；/term/v1/health 无 token 401；错 token 401；
    clientToken 不能用；127.0.0.2 来源 403；外部域名 Host 403；/admin/stats 与 /v1/models → 404
  health：state==='ready'、version==='mock-1.0'
  会话：POST {project:'甲'} → 201 且返回 directory===realpath(tmpA)；
    POST {project:'甲', dir:'/etc'} → 仍 201 且 dir 被忽略；POST {project:'不存在'} → 400
  input→SSE：挂 /term/v1/events?session=<id> 后 POST input 'say hi'，
    依次收到 event: delta（含 delta 字段）与 event: part（含 id/messageId）
  权限：input 'ask-permission' → GET /pending 有一条 kind==='permission'、detail==='echo test'；
    /pending 不含目录乙的会话条目；SSE 收到 event: pending；
    POST /approvals/<per_id> {decision:'once'} → pending 清空、abort 无需（busy 已清）
  提问：input 'ask-question' → pending 有 question、options.questions[0].options 两条；
    POST /questions/<que_id> {answers:[['A']]} → 清空
  跨目录隔离：直接用乙目录的会话 id GET messages → 404；POST approvals 用编造 id → 404；
    :id 带 '../../etc' → 404
  截断：input 'big-output' → messages 中 tool.output ≤ 8KB+尾缀（截断生效）
  僵尸与重启：input 'ask-permission'（busy 挂起）→ 读 pidfile 杀 pid → 等待 health.restarts 增加且 ready
    → 该会话 GET /sessions busy===false（僵尸已被 abort）→ mock 状态文件里 messages 未丢
  SSE 断流自愈：挂 events?session= 后再杀一次后端 → 客户端 SSE 流被关闭（读到 end 而非挂死）；
    网关不崩（随后 /term/v1/health 仍 200）；后端自动重启后新挂的 events 正常收事件
  孤儿判定：手写 pidfile {pid: <sleep 进程>} 起网关 → sleep 进程仍活（ps 校验）
  口令不泄漏：抓 proxy.log 与 /term/v1/health 响应体 → grep 子进程口令十六进制串 → 0 命中
  空白名单：第二份配置 projects:[] → GET /sessions === []、POST /sessions 400、/pending === []
  并发 SSE：两个 events 连接同一 session → 都收到 part；断开一个 → 另一个仍收到
  ```

- [ ] **Step 2: 跑测试确认失败** — 全部连不上/404（监听不存在）。
- [ ] **Step 3: 实现 `lib/terminal/server.mjs` + server.mjs 接线**。
- [ ] **Step 4: 跑测试通过** — `node test/terminal.mjs` 全绿。
- [ ] **Step 5: 回归** — `node test/smoke.mjs && node test/robustness.mjs && node test/tv.mjs && node test/sync.mjs && node test/terminal-unit.mjs` 全绿。
- [ ] **Step 6: Commit** — `feat(terminal): /term/v1 窄契约监听 + SSE 事件桥 + 会话归属校验`

### Task 7: term.html 移动页

**Files:**
- Create: `term.html`
- Modify: `lib/terminal/server.mjs`（`GET /term` 读 `term.html`——本任务才落文件，Task 6 先回占位字符串避免 readFileSync 崩）
- Modify: `install.sh:84-97`（拷贝清单加 `term.html`）
- Modify: `index.html`（总览视图 04 节后加 05 节「远程 Agent」：链接 `http://${location.hostname}:8492/term`（桌面点开即本地可用）+ dim 说明文案「手机访问请把主机名换成 Mac 的局域网 IP；需在 providers.json 开启 gateway.terminal」）
- Test: `test/terminal.mjs`（追加页面断言段）

**Interfaces:**
- Consumes: `/term/v1/*`（Task 6 契约）；`/term/theme.css`
- 页面结构（单文件，内联 JS/CSS，无框架；中文文案）：
  - **token 层**：无 token → 粘贴框（`type=password`）；存 `localStorage['term-token']`；任何 401 → 清空重索
  - **请求层**：`api(path, opts)` 统一带 `Authorization: Bearer`；SSE 用 `fetch` + `ReadableStream` 手工解析（**不用 EventSource**），断流自动重连（1s/5s/30s）
  - **屏 1 会话列表**：待批横幅（红，点击 → 屏 3）+ 项目分组会话行（标题/相对时间/状态点）+「＋ 新建」（项目选择 + 可选标题）+ 15s 轮询（`document.hidden` 时暂停）
  - **屏 2 会话**：消息流（`text`→markdown-lite：先 `esc()` 转义 `& < > "` 再做代码块/行内码/粗体/列表/链接替换——XSS 红线；`reasoning`→默认折叠灰块；`tool`→一行摘要可展开（输出等宽限高滚动）；`patch`→文件名列表；`step`→忽略不渲染）+ 底部输入框（发送/停止/重载）+ 顶部状态条（进行中/空闲/后端未就绪+重试按钮）
  - **part 合并**：按 `messageId` 分组、part 按 `id` **替换**（`delta` 追加到对应 part 的 `field`，收到 `part` 覆盖之）；滚动到底（用户上滚时暂停自动滚动）
  - **屏 3 待批**：permission → 摘要 + detail + 三按钮（拒绝/允许一次/总是允许，第三个带「会写进 opencode 权限配置」小字）；question → 选项按钮（multiple 多选、custom 自由输入）
  - **重连协议**：`visibilitychange→visible`、SSE error、进会话页 → 一律 ①`GET messages` 全量重拉 ②重挂 SSE（spec §七：重复渲染不会错，漏一条会）
- [ ] **Step 1: 实现 `term.html`**（占位由 Task 6 换成真文件）。
- [ ] **Step 2: 端到端页面断言**（`test/term.mjs` 追加）：`GET /term` 返回体含 `id="app"`、`term-token`、`EventSource` **不**出现（用 fetch 流的反证）；`GET /term/theme.css` 200。
- [ ] **Step 3: 手工验收** — 起临时网关（8485 端口、mock 后端），浏览器开 `http://127.0.0.1:8497/term` 过一遍三屏（建会话/发消息/批准/断网重连）；macOS 上 `open` 命令代开，人工确认后勾掉。
- [ ] **Step 4: 回归 + Commit** — 全部测试脚本绿后：`git add term.html lib/terminal/server.mjs install.sh index.html test/terminal.mjs` → `feat(terminal): 手机端 term.html（三屏/SSE 流解析/token 层）`

### Task 8: 文档收尾 + 全量回归

**Files:**
- Modify: `CLAUDE.md`（架构模块图加 `lib/terminal/*` 与 `term.html`；「请求路由」表后加「终端监听」小节，照「电视工作台监听」的格式；常用命令节加 `node test/terminal-unit.mjs`、`node test/terminal.mjs`）
- Modify: `README.md`（功能清单一段：gateway.terminal、term.html 用法、白名单与 token 配置说明——照 tv/sync 的现有段落风格）

- [ ] **Step 1: 更新两份文档**（中文；模块图行内说明照现有密度，不写实现细节）。
- [ ] **Step 2: 全量回归** — `for t in smoke robustness tv sync terminal-unit terminal home-unit; do node test/$t.mjs || exit 1; done` 全绿。
- [ ] **Step 3: Commit** — `docs(terminal): CLAUDE.md/README 增补终端监听与移动页`
