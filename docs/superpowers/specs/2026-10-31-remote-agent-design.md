# 跨设备远程 agent（手机可用的 opencode 控制台）· 设计文档

日期：2026-10-31
状态：路线 B（自家窄 API + 自家移动页）已选定；项目白名单已确认；待批准后写实施计划。

## 一、要解决的问题

现在想用 agent 必须坐在这台 Mac 前面。出门在外（手机）时：
想起一件事要交代给 agent、想知道昨晚那个任务跑完没有、它卡在权限询问上等了一整晚——都无从得知，
只能回家再说。

已有 `gateway.tv`（电视只读快照）与 `gateway.sync`（Mac↔Mac 同步）两个 LAN 监听，验证了
「主监听 8484 一行不动 + 另一个只挂白名单路由的监听」这个范式可行。这一期把它用到最后一件事上：
**在手机上拉起一个 agent、看它在干什么、回话、批准操作。**

## 二、目标 / 非目标

**目标**

1. 手机浏览器打开 `http://<Mac 的局域网或 Tailscale IP>:8492/term`，选一个项目 → 起一个 opencode
   会话 → 打字、看流式回复与工具调用、遇权限询问点「允许 / 总是允许 / 拒绝」。
2. **断续无感**：锁屏、断网、换设备回来，重新打开页面能看到完整历史并接着聊。会话与消息的真相
   在 opencode 自己的库里，我们不做第二份存储。
3. 网关托管 opencode 服务端进程：手机点「新建」时它必须已经活着；它挂了网关负责拉起来。
4. 契约与实现分离：移动页只认自家的 `/term/v1/*`，不认 opencode 的形状。将来接 claude / zcode
   是加一个适配器分支，不是改页面。

**非目标（本期明确不做）**

- **claude / zcode / cursor 适配器**。用户已明确本轮只做 opencode。但 `/term/v1/*` 的语义从第一天
  就按「多后端」设计（会话里带 `backend` 字段），免得将来推翻。
- 像素级终端镜像 / PTY / xterm.js。要的是「控制 agent」，不是「看终端画面」。
- 文件上传、截图、图片消息。
- 系统级推送通知（APNs）。手机锁屏时不会有通知，页面打开时才看到待批。
- 多用户、多人协作。单用户多设备。
- 模型选择 UI：用 opencode 自己配置里的默认模型。

**反目标**

- 不把 opencode 的完整能力面（fork / revert / shell / 任意目录）敞给局域网。
- 不让页面能指定任意工作目录——那等于让拿到 token 的设备在这台 Mac 上任何地方起 agent。
- 不在网关里自建事件队列/重放缓冲，把 opencode 已经做好且更可靠的事重做一遍。

## 三、实测事实（这些是设计的根据，不是查文档得来的）

在本机 `opencode 1.18.31` 上逐条跑过：

| 事实 | 验证方式与结论 |
|---|---|
| `opencode serve` 有完整 HTTP + SSE 服务端 | `GET /doc` 返回 OpenAPI 3.1，约 100 条路由 |
| 会话与消息持久化 | 杀掉 serve 重启后 `GET /session`、`GET /session/:id/message` 完整可读，可继续 `prompt_async` |
| 发消息非阻塞 | `POST /session/:id/prompt_async` → `204`，结果走事件流/历史 |
| 事件流 | `GET /event` 为 SSE，实测收到 `message.part.updated`、`session.status`、`permission.asked`、`session.diff`、`server.heartbeat` |
| 权限询问可远程作答 | `permission.asked` 事件带 `id`；`GET /permission` 列待批；`POST /permission/:id/reply {"reply":"once\|always\|reject"}` → 200 |
| 提问（选择题）也可远程作答 | `GET /question`、`POST /question/:id/reply {"answers":[[label,...]]}`、`.../reject` |
| 鉴权 | `OPENCODE_SERVER_PASSWORD` 未设时它自己打警告 "server is unsecured"；设了之后 `401` / Basic（用户名 `opencode`）`200` |
| **服务被杀会留下僵尸轮次** | 正在跑的轮次留下永远 `running` 的工具块，`session/status` 持续 `busy`；`POST /session/:id/abort` 后变 `{}`，可重新发消息 |
| 待批权限跨重启幸存 | 重启后 `GET /permission` 仍有那一条，可正常 `reply` |
| `--port 0` 不随机 | 回落到 `4096`，会与用户自己的 `opencode` TUI 撞 → 内部端口必须显式指定 |
| `directory` 是作用域 | 建会话、发消息、拉历史、回权限都要带 `?directory=<绝对路径>` |
| **`GET /permission` 不带 `directory` 返回空** | 两个目录各挂一条待批：全局查询 `0` 条，`?directory=a` 只出 a 那条。**这就是白名单边界的现成工具**——逐目录拉取即天然限定范围 |
| **`reply` 必须带对的 `directory`** | 用别的目录去回一条，直接 `404` |
| **launchd 下没有 PATH** | `launchctl getenv PATH` 为空；最小 PATH 跑 `opencode --version` → `No such file or directory`。`spawn('opencode')` 开发机可用、线上必挂 |
| 登录 shell 取 PATH 很便宜 | `zsh -lc 'printf "%s" "$PATH"'` 实测 53 ms，启动时取一次缓存即可 |
| 消息结构 | `{info:{role,id,time,...}, parts:[{type:"text"\|"reasoning"\|"tool"\|"step-start"\|"step-finish"\|"patch"\|"file"\|...}]}`；`tool` 配件有 `tool` 名与 `state:{status,input,output,error,metadata}` |

另外：`~/.config/opencode/opencode.json` 里用户已配 `"permission": {"*": "ask"}`——**所有工具都会问**，
所以批准界面不是可选项，是核心。

## 四、架构

第四个监听，与 `gateway.tv`（8490）、`gateway.sync`（8491）并列。主监听 8484 一行不动。

```
server.mjs
  └─ startTerminalServer()            lib/terminal/server.mjs
       ① Host 反 rebinding（复用 tv-net.hostAllowed）
       ② 来源 IP ∈ gateway.terminal.allowedCidrs（默认私网 + 回环 + Tailscale CGNAT）
       ③ 路由白名单：/term（页面）、/term/v1/* ；其余（含 /admin/*、/v1/*）一律 404
       ④ Bearer token（gateway.terminal.tokens，timingSafeEqual，与 clientToken/tv/sync 互不复用）
       ⑤ 每 token 限速（默认 120/分钟；失败尝试按来源 IP 限速，3 倍额度）
     ├─ lib/terminal/host.mjs          opencode 子进程监管（spawn / 健康轮询 / 崩溃重启 / 退出清理）
     ├─ lib/terminal/opencode.mjs      opencode API 客户端（basic auth、超时、错误归一）
     ├─ lib/terminal/adapter.mjs       自家语义 → opencode 方言（唯一知道两边形状差异的地方）
     └─ lib/terminal/project.mjs       项目白名单解析与路径校验（纯函数，可单测）
term.html                              移动页（由 terminal 监听自己托管）
```

### 为什么不让页面直连 opencode（被否掉的 C 路线）

页面会硬编码 opencode 的 API 形状，将来接第二家就变成在页面里写 if/else；而 opencode 的完整能力面
（`shell`、`revert`、`command`、任意 directory）会一并暴露给局域网。适配层多出来的那层薄翻译，
换的是稳定契约和更窄的暴露面。

### 为什么不做反代 opencode 自带 web UI（被否掉的 A 路线）

省事，但界面不是手机要的形状，且将来手机 app 接的是它家的 HTML/JS 契约——等于把入口交给别人。

## 五、配置（`providers.json` → `gateway.terminal`）

```jsonc
"terminal": {
  "enabled": false,          // 默认关闭；false 或 tokens 为空 → 完全不建监听。改此键需重启
  "port": 8492,
  "bind": "0.0.0.0",         // 手机要够得到；不要填 127.0.0.1
  "tokens": [{ "name": "phone", "token": "" }],   // 每台设备一枚
  "allowedCidrs": ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12",
                   "100.64.0.0/10", "127.0.0.1/32", "::1/128"],
  "maxPerMinute": 120,
  "backendPort": 4096,       // 内部 opencode serve 端口（只绑 127.0.0.1）；显式指定，避免撞 TUI
  "backendBin": "",          // opencode 可执行文件绝对路径；空 = 自动探测（见下）
  "projects": [              // 手机端能起 agent 的目录白名单
    { "name": "个人工作台", "dir": "/Users/tomhoyt/Desktop/project/personal_workshop" }
  ]
}
```

**为什么必须有 `backendBin`**（实测）：launchd 起的进程**没有 PATH**（`launchctl getenv PATH` 为空），
而本机 opencode 在 `~/.local/share/opencode/bin/opencode`，不在任何系统默认目录里。用最小 PATH
（`/usr/bin:/bin:/usr/sbin:/sbin`）跑 `opencode --version` 直接
`No such file or directory`。所以 `spawn('opencode')` 在开发终端能跑、在 launchd 下必挂。

解析顺序：`backendBin` → 环境变量 `CANNBOT_OPENCODE_BIN` → `command -v opencode` → 报错降级。

**子进程的 PATH 同样要显式给**：agent 的每次 `Bash` 调用继承这个环境，最小 PATH 下它能跑
`/bin/bash` 却找不到 `node`/`git`/`python3`，症状是 agent「莫名其妙」执行失败。做法：首次拉起前跑一次
登录 shell 取 PATH（`zsh -lc 'printf "%s" "$PATH"'`，实测 53 ms，只跑一次并缓存），把结果
**追加**到 `process.env.PATH` 之后传给子进程——不替换，保留 launchd 原有的兜底目录。

校验规则（写进 `lib/config.mjs` 的 `normalizeTerminal`，照 `normalizeSync` 的形状）：

- `tokens` 逐项去空白去重；与 `clientToken` / `gateway.tv.tokens` / `gateway.sync.tokens` 相同的
  **直接丢弃并记警告**（照现有三处一致的做法）。
- `enabled/port/bind/backendBin` 启动时读；`tokens/allowedCidrs/maxPerMinute/projects/backendPort`
  每请求现读（改白名单不用重启；`backendPort` 变更只影响下一次拉起子进程）。
- `projects` 每项：`name` 去空白截断 40 字符（空则回落目录 basename）；`dir` **必须绝对路径且存在且是
  目录**，用 `fs.realpathSync` 归一（`/tmp` → `/private/tmp`，与 opencode 报的 `directory` 对齐）；
  重复 `dir` 只留第一条。
- **`gateway.terminal` 必须加入 `SYNC_ROLE_GATEWAY_KEYS`**（`lib/sync-config.mjs`）。理由是本机事实：
  白名单里是**这台机器上的绝对路径**，设备 token 是**这台机器的**。同步到另一台 Mac 上，
  路径不存在、token 也不该通用——与 `monitors` 同一条纪律。
- `providers.template.json` 加该节（token 留空）；`install.sh` 的拷贝清单加 `term.html`。

## 六、API 契约（`/term/v1/*`，全部要 token）

自家语义，动作只有几个。所有响应 `application/json`（`events` 是 `text/event-stream`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/term/v1/health` | `{ok, backend:{state,version,log?,pid?,restarts}, projects:n, pending:n}`；`state` ∈ `starting\|ready\|retrying\|down`（见 §八） |
| POST | `/term/v1/backend/restart` | 手动重启后端子进程。**唯一**会从 `down` 重新尝试的入口（`GET /health` 不触发，否则「5 次后停」形同虚设） |
| GET | `/term/v1/projects` | `[{name, dir, exists}]` |
| GET | `/term/v1/sessions?project=` | `[{id, project, title, directory, busy, createdAt, updatedAt, pending:n}]`，**只返回目录落在白名单里的会话**，按 `updatedAt` 倒序 |
| POST | `/term/v1/sessions` | `{project, title?}` → 201 新建会话。`project` 必须是白名单里的 `name`；**不接受 `dir`** |
| GET | `/term/v1/sessions/:id/messages?limit=&before=` | `[{id, role, at, parts:[…]}]`；`parts` 已归一（见 §七）。`:id` 必须属于白名单目录，否则 404 |
| POST | `/term/v1/sessions/:id/input` | `{text}` → 202。空串 400；超 20 万字符 413 |
| POST | `/term/v1/sessions/:id/abort` | 停止当前轮次，清僵尸状态 |
| GET | `/term/v1/pending?session=` | 合并待批权限与待答问题：`[{kind:"permission"\|"question", id, session, sessionTitle, summary, detail, options}]` |
| POST | `/term/v1/approvals/:id` | `{decision:"once"\|"always"\|"reject"}` |
| POST | `/term/v1/questions/:id` | `{answers:[[label,…],…]}` 或 `{reject:true}` |
| GET | `/term/v1/events?session=` | SSE（`text/event-stream`）。`event: part` / `status` / `pending` / `hello`，注释行 `: ping` 每 15 s 一次。无 `session` 时只推 `pending` 与状态 |
| GET | `/term` | `term.html`（**免鉴权**，见下） |
| GET | `/term/theme.css` | 复用工作台主题（**免鉴权**） |

**`/term` 与 `/term/theme.css` 免 token**：顶层导航发不出 `Authorization`，页面本身就是登录界面的
外壳（里面只有静态 HTML/CSS，没有任何数据）。它们**不计入失败限速桶**——否则手机刷几次页面就把
3× 额度耗光。所有 `/term/v1/*` 一律要 token。

**会话归属校验**：每个 `:id` 路径都先取会话的 `directory`，比对白名单（`realpath` 后比较）。
不在白名单 → 404，不泄漏「这个会话存在但不是你的」。

**待批同理，且必须显式圈定**（实测发现的重要细节）：opencode 的 `GET /permission` **不带
`directory` 时返回空数组**，带 `?directory=X` 才按目录过滤；`POST /permission/:id/reply` 不带正确
`directory` 直接 404。所以实现方式是**逐个白名单目录拉取再合并**，天然只覆盖白名单内的会话——
不碰用户自己 TUI 在别的目录里跑的请求。答复前再用该条目的 `sessionID` 反查会话 `directory`
复核一次（两道保险），不匹配按 404 处理。

**为什么 `messages` 不返回 opencode 原始 parts**：opencode 的 part 有 12 种，移动页只该认识
`text / reasoning / tool / file / patch / step` 这几类语义。归一在服务端做，页面跟着契约走。

## 七、数据归约（服务端）

**消息归一**（`adapter.mjs`）。**每个归一后的 part 都带 `id`（= opencode 的 `prt_…`）与
`messageId`**——`message.part.updated` 是同一 part 的多次快照，页面按 `id` **替换**而不是追加；
少了这个键，流式输出会变成满屏重复气泡。

| 输入 part | 输出 |
|---|---|
| `text` | `{id, messageId, type:"text", text}`（`synthetic`/`ignored` 的丢弃） |
| `reasoning` | `{id, messageId, type:"reasoning", text}` |
| `tool` | `{id, messageId, type:"tool", name, callId, status, input, output?, error?, files?}`；`output` 截断 8 KB，`input` 截断 2 KB |
| `patch` | `{id, messageId, type:"patch", files:[…]}` |
| `file` | `{id, messageId, type:"file", mime, filename}`（`url` 不回——可能是 data URL，体积不可控） |
| `step-start` / `step-finish` | `{id, messageId, type:"step", finish?, cost?, tokens?}` |
| 其余（`snapshot`/`subtask`/`agent`/`retry`/`compaction`） | 丢弃 |

消息本身带 `{id, role, at, parts}`；`at` 取 `info.time.created/completed`。

**事件裁剪**（`/term/v1/events`）：只转发该会话的事件，且只转发会改变页面的事：
`message.part.updated`（带 `sessionID`）→ `event: part`，`data` 是**单个归一后的 part**（含 `messageId`）；
`message.updated` → `event: status`（带 usage/`completed`）；`session.status` → `event: status {busy}`；
`permission.asked` / `permission.replied` / `question.*` → `event: pending`（**只转发白名单目录内会话的**）。
`server.heartbeat` / `server.connected` 丢弃，由自家注释心跳代替。**其余事件一律不转发**。

**SSE 的鉴权与消费方式**：`EventSource` 不能发请求头，而 token 放 URL 会进浏览器历史与中间代理
日志——所以移动页**不用 `EventSource`**，改用 `fetch` + `ReadableStream` 手工解析 SSE（约 40 行），
token 照常走 `Authorization` 头。服务端因此**不接受任何形式的 query token**。

**断线重连协议**（页面侧，简单到不容易错）：
`visibilitychange → visible`、SSE `onerror`、以及页面打开时，一律
①`GET messages` 全量重拉（`limit` 取最近 100 条，更早的「加载更早」按 `before` 翻页）
②再挂 `events`。**不做增量 diff**：重复渲染同一份历史不会错，漏一条会。

**僵尸轮次处置**：`host.mjs` 每次成功拉起新子进程后，遍历 `GET /session/status` 里 `busy` 的
**白名单目录内**会话，逐个 `abort`。依据是：子进程是我们杀的，上一个进程里正在跑的轮次必然
已经死了，留着只会让页面永远转圈。**只处理白名单内的会话**，不碰用户自己 TUI 里跑的。

## 八、opencode 子进程监管（`lib/terminal/host.mjs`）

**生命周期只有一种：网关启动即拉起**（不惰性、不按需）。理由：手机点「新建」时不能等一个冷启动，
而一个空闲的 `opencode serve` 只占几十 MB、不跑模型不花钱。`enabled` 为假时完全不 spawn。

状态机（`backend.state`）：

```
starting ──就绪──> ready ──退出──> retrying ──退避重试──> ready
   │                  │                │
   └─超时/失败────────┴────────────────┴─> down（连续 5 次失败后停在这里）
                                          only POST /backend/restart 能把它拉回 starting
```

- **拉起**：`spawn(bin, ['serve','--hostname','127.0.0.1','--port',String(backendPort)],
  {env:{...process.env, OPENCODE_SERVER_PASSWORD: <随机 32 hex>, PATH: <合并后的 PATH>},
  stdio:['ignore','pipe','pipe'], detached:false})`
  - 口令只存在于内存与子进程环境，**不落盘、不进日志、不回给页面**。
  - stdout/stderr 收进环形缓冲（最近 50 行），供 `/term/v1/health` 的 `backend.log` 尾部排障；
    日志里出现口令的行要打码。
- **就绪判定**：每 250 ms 用 basic auth 打 `GET /global/health`，最多 20 s；超时即 `retrying`。
- **崩溃重启**：子进程 `exit` 且网关没在关闭 → 指数退避（1s, 2s, 5s, 15s, 60s 封顶）；连续 5 次
  失败进 `down` 并**停止自动重试**。`GET /health` 只读状态、**不触发**重启——否则页面 15 s 一轮的
  健康轮询会让「5 次后停」永远数不到；只有 `POST /term/v1/backend/restart` 会重置计数并再试。
- **pidfile 与孤儿子进程**（评审发现的关键缺口）：口令只活在内存里，网关被 SIGKILL 后遗留的
  serve 子进程**没人能通过鉴权**，探测会收到 401——不会被误认为「能通」，但会占住端口让新子进程
  `EADDRINUSE`，进而在 5 次失败后永久 `down`，只能手动 `pkill`。所以：
  - 拉起成功后把 `{pid, startedAt, bin}` 写进运行时目录的 `terminal-backend.json`（0600）。
  - 每次拉起前读它：若 pid 仍存活 **且** `ps -p <pid> -o command=` 里含 `opencode` 与
    `--port <backendPort>`（**校验命令行，防 pid 复用误杀**）→ 先 `SIGTERM`（5 s 后 `SIGKILL`），再拉起。
  - 端口被**别人的** opencode 占着（命令行对不上）→ `down` 并明确报错，**不接管**。
- **关闭**：`process.on('exit'/'SIGINT'/'SIGTERM')` 与 `uninstall` 路径上都 kill 子进程并删 pidfile；
  `detached:false` 保证它不会自己活成孤儿进程组。

## 九、移动页（`term.html`）

单文件，手机竖屏优先，与 `theme.css` 共用色板令牌（`/term/theme.css` 路由指向同一份文件，
避免移动页与工作台配色漂移）。

**三个屏**（同一个页面内的三态，不引入路由库）：

1. **会话列表**：顶部待批横幅（有就置顶、红色）→ 项目分组 → 会话行（标题、相对时间、
   状态点：`进行中` 呼吸点 / `有未批` 琥珀点 / 空闲）。
   底部固定「＋ 新建」（选项目 + 可选标题）。
2. **会话页**：消息流。
   - `text` → markdown-lite（代码块、行内代码、粗体、列表、链接；**先 `esc()` 再结构替换**，
     与 `index.html` 同一条 XSS 防线）。
   - `reasoning` → 默认折叠的灰字块。
   - `tool` → 一行摘要（`Bash · ls -la` / `Edit · src/app.ts`），点开看输入与输出，
     输出等宽、限高滚动。
   - `patch` → 「改动 3 个文件」+ 文件名列表。
   - 底部输入框（多行、`⌘↵`/发送键发送）+ 停止按钮 + 「重新加载」。
   - 顶部状态条：`进行中` / `空闲` / `后端未就绪`。
3. **待批详情**：从横幅或列表点进来。权限显示 `permission` 类型 + `patterns` + `metadata.command`
   （就是「它要跑什么」），三个按钮：`拒绝` / `允许一次` / `总是允许`（后者标注「会写进 opencode 权限配置」）。
   问题（`question`）渲染成选项按钮，多选按 `multiple` 处理，`custom` 给自由输入框。

**令牌**：首次打开要求粘贴 token（`type=password`），存 `localStorage`；401 时清掉并重新索要。
**不从 URL 读 token**（会进浏览器历史与代理日志）。所有请求（含 SSE）都走 `Authorization` 头。

**后端状态条**：`starting`/`retrying` 显示「后端启动中…」，`down` 显示错误摘要 + 「重试」按钮
（调 `POST /backend/restart`）；`retrying` 时显示第几次、下次退避秒数。

**轮询/推送边界**：会话列表页 15 s 轮询一次 `sessions` + `pending`（SSE 在列表页只收 `pending`）；
进入会话页就 `messages` 全量 + `events` SSE。页面不可见时全部停掉，`visible` 时立即各拉一次。

## 十、工作台里的入口

桌面工作台只在「总览」页底部加一行链接「远程 agent（手机端）」，指向
`http://<本机 LAN IP>:8492/term`，旁边写明「需在 providers.json 开启 gateway.terminal」。
**不做成第八个视图**——用户的判断是手机形态与桌面三栏布局冲突，硬塞进去会两边都不好用。

## 十一、测试

零依赖，照现有 `test/` 的做法。

1. **`test/terminal-unit.mjs`（纯函数，快）**
   - 项目白名单解析：相对路径剔除、不存在剔除、`realpath` 归一、重复目录去重、名字回落 basename。
   - 会话过滤：不在白名单目录的会话不出现在列表里。
   - 消息归一：12 种 part 的映射表逐条断言；截断边界；`synthetic` 丢弃。
   - 事件裁剪：`server.heartbeat` 不转发；他会话的事件不转发；权限事件转 `pending`。
   - 配置归一：token 与 clientToken/TV/sync 撞车被丢弃；`allowedCidrs` 非法项剔除。

2. **`test/terminal.mjs`（端到端，起 mock 后端 + 网关实例）**
   - mock opencode：一个 ~250 行的 http 服务器，实现 `global/health`、`session`（GET/POST）、
     `session/:id/message`、`prompt_async`、`abort`、`permission`（**含 `directory` 过滤语义**）、
     `question`、`event`（SSE），并能注入「僵尸轮次」「待批权限」「待答问题」。
     **不依赖真实 opencode**。注入点就是 `gateway.terminal.backendBin` 指向一个包装脚本
     （或 `CANNBOT_OPENCODE_BIN`），这也顺带验证了 bin 解析路径。
   - 断言：`/term` 免 token 可加载、`/term/v1/*` 无 token 401、坏 token 401、非白名单 CIDR 拒绝、
     Host 为外部域名拒绝、`/admin/*` 与 `/v1/*` 404；建会话不接受任意 `dir`；
     跨目录会话读不到（404 而非 403）；`pending` 只含白名单目录内会话的请求；
     用非白名单会话的目录去 reply 被拒；`input` 后 SSE 收到带 `id`/`messageId` 的 `part`；
     同一 part 的两次更新只产生一次渲染（页面逻辑在单元层验，端到端只验事件带 id）；
     批准后 `permission` 清空；abort 后 `status` 转空闲；后端进程被杀后自动重启。
   - `OPENCODE_SERVER_PASSWORD` 不出现在任何响应体、`proxy.log`、pidfile 里（拿文件 grep 断言）。
   - 孤儿 pidfile：先写一个「假装上次的 pid」指向一个 `sleep` 进程，断言不误杀（命令行不含
     `opencode`）；再断言真占端口的 mock 会让新实例报冲突而不是接管。

3. **回归**：`node test/smoke.mjs`、`node test/robustness.mjs`、`node test/sync.mjs` 全绿
   （新增第四监听不能影响前三者；`gateway.terminal` 默认关闭，smoke 里不开启）。

## 十二、留给实施的决定（我按明显答案先拍了，有异议再说）

- 内部端口默认 `4096`（与 opencode 自身默认一致，但显式传；冲突时报错而不是换端口——换端口会让
  已有的 `opencode` TUI 和我们的 serve 指向不同实例，更难排障）。
- `backendBin` 空则自动探测：`CANNBOT_OPENCODE_BIN` → `command -v opencode`（在合并后的 PATH 里）；
  都找不到则 `state=down` 且错误信息直说「请设 gateway.terminal.backendBin」。
- `messages` 默认返回最近 100 条，`before` 游标翻页。
- 不暴露模型选择；不暴露 `fork`/`revert`/`shell`。`compact` 从契约里**去掉**——opencode 侧对应的是
  `POST /session/:id/summarize` 且需要指定模型，与本期的「不选模型」冲突。
- 不做服务端事件缓冲：断线期间的增量不补，靠重拉历史。
- 移动页把 reasoning 默认折叠（用户要看的是结论与动作，不是思考过程；点开能看）。
- 令牌撞车时**丢 terminal 的那一枚**（沿用法：后来者让路）；不为了 terminal 去改别的监听。

## 十三、风险

| 风险 | 处置 |
|---|---|
| opencode 升级改了 API 形状 | 所有方言知识集中在 `adapter.mjs` + `opencode.mjs` 两个文件；端到端测试用 mock，升级后先跑真实冒烟再改 |
| 手机在公网（非 Tailscale）够不到 | 明确要求走 Tailscale 或同 LAN；不做端口穿透、不做自签证书 |
| token 泄漏（手机丢失） | 每设备一枚、可在运行期吊销（配置热读）；`/term/v1/health` 只报 token 名不报值 |
| 网关重启打断正在跑的轮次 | 子进程随网关生死；重启后自动 abort 白名单内的僵尸轮次，页面显示「上次中断」而不是永远转圈 |
| 白名单目录含敏感仓库 | 白名单由用户显式配置，默认空（空 = 不能新建会话，只能看已有白名单内会话——也是空） |
| launchd 无 PATH 导致拉不起后端 | `backendBin` 显式配置 + 登录 shell PATH 合并；找不到就 `down` 并把「请设 backendBin」写进 `health.backend.error`，而不是静默 `ENOENT` |
| 孤儿子进程占着 backendPort 且口令已丢 | pidfile + 命令行校验后先杀再拉；命令行对不上（是别人的 opencode）则报冲突、不接管 |
