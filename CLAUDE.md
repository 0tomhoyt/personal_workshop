# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**个人工作台 = 统一订阅 API 网关 + 待办 + AI 工作总结**。网关部分：把多个订阅服务（CANNWork、Kimi For Coding、GLM Coding Plan 等）集中接入一个本地网关，本机所有 Agent（zcode CLI、Claude Code、opencode 等）统一调用。按请求体里的**模型名**路由到对应订阅（providers.json 声明），自动注入该订阅凭证；同协议**原样直通**，跨协议走**双向翻译**。工作台部分（同一页的左栏第一组）：跨 agent 的**待办事项**（`/v1/todos`，人与 agent 共用）+ **时间段 AI 工作总结**（读 Claude Code / zcode / opencode / Cursor 四个 agent 的本地会话记录 → 两级总结成给上级的汇报）。**管理台与工作台是同一个页面（`index.html`）、六个视图**，左栏两级分组导航。

- **零依赖 + 模块化**：无 package.json / node_modules，只用 Node ≥ 18 内置模块 + spawn 系统 `sqlite3`，`server.mjs` 入口 + `lib/` 若干 ESM 模块。没有构建、lint；测试是 `node test/smoke.mjs`（mock 上游端到端 + fixture 数据源，不依赖真实订阅与真实 agent 数据）。
- **语言约定**：注释、文档、commit message 全部使用中文，与现有风格保持一致。

## 常用命令

```bash
node server.mjs              # 前台直接运行（调试用；源目录无 providers.json，会回落内置默认配置——仅 cannbot、无客户端鉴权）
node test/smoke.mjs          # 端到端冒烟测试（起 mock 上游 + 网关实例，三百余项断言；固定端口 6290/6291）
# 前台联调真实配置（换端口避开 launchd 实例；VK 缓存指到临时目录防活凭证落入源目录）：
CANNBOT_PROXY_PORT=8485 CANNBOT_CONFIG_FILE="$HOME/.local/share/cannbot-gateway-proxy/providers.json" CANNBOT_VK_CACHE=/tmp/vk-debug.json node server.mjs
./install.sh [端口]           # 安装并启动 launchd 常驻服务（幂等，缺省 8484）；CGP_SKIP_LAUNCHCTL=1 演练（跳过 launchctl 步骤）
./uninstall.sh [--revert-configs]   # 停服务；--revert-configs 连 zcode 配置一起回滚；CGP_SKIP_LAUNCHCTL=1 演练同上（launchctl 作用于用户域、与 HOME 无关，脚本测试必须带它）
./status.sh                  # 服务状态 + 各上游凭证体检 + 最近请求
./cannbot-creds.sh           # cannbot 订阅凭证诊断（日常不用跑）
curl http://127.0.0.1:8484/healthz  # 健康检查（providers[] 数组）
```

## ⚠️ 双目录设计（改代码必读）

本目录（桌面）是**项目源**；launchd 实际运行的是 `install.sh` 拷贝到 `~/.local/share/cannbot-gateway-proxy/` 的**运行时副本**（macOS TCC 限制 launchd 读不了桌面）。

**改动 `server.mjs`、`lib/`、`index.html`、`theme.css` 后必须重跑 `./install.sh` 才生效。** 运行时产物（providers.json、proxy.log、vk-cache.json、stats.json、todos.json、reports.json、logs/proxy.err.log、port 记录）都在运行时目录，不在本目录排障。**providers.json 改动不用重装**——网关按 mtime 热加载（lib/config.mjs）。运行时文件位置可用 `CANNBOT_CONFIG_FILE` / `CANNBOT_LOG_FILE` / `CANNBOT_STATS_FILE` / `CANNBOT_TODOS_FILE` / `CANNBOT_REPORTS_FILE` 覆盖；报告数据源根路径可用 `CANNBOT_CC_DIR` / `CANNBOT_ZCODE_DB` / `CANNBOT_OPENCODE_DB` / `CANNBOT_CURSOR_DIR` 覆盖（test/smoke.mjs 即用它们把产物与数据源全部隔离到临时目录）。

## 架构（模块图）

```
server.mjs            HTTP 服务 + 路由分发 + healthz/admin 端点
lib/config.mjs        providers.json 加载/校验/热重载（baseUrl 归一化：剥尾部 /v1）
lib/providers-admin.mjs  管理台对 providers.json 的增删改（写前整体校验 + 防自环、
                      原子落盘 0600、读视图只出 token 掩码、编辑留空 token=沿用）
lib/gwauth.mjs        客户端 Bearer token 校验（timingSafeEqual）
lib/models.mjs        模型目录聚合（TTL 10min + 失败负缓存 30s，目录响应 2MB 有界读）+ model→provider
                      路由（显式 pid/model > aliases > 裸名唯一 > defaultProvider 兜底）
lib/upstream.mjs      requestUpstream：按 provider 解析凭证头、fetch（「发请求→收到
                      响应头」超时，不影响已建立的流）、401 按 provider 策略重试一次
lib/auth/cannwork.mjs CANNWork JWT+VK 链（读 session.json → vk 多级缓存/换取/自愈）
lib/auth/static.mjs   静态 token（内联 / tokenEnv / tokenFile+tokenJsonPath，每次请求现读）
lib/proxy-openai.mjs  OpenAI 客户端 → openai 上游：字节级透传 + Transform tap 旁路统计
lib/proxy-anthropic.mjs
   ├─ handleAnthropicInbound  Anthropic 客户端：anth 上游直通（SSE 字节透传）/ openai 上游翻译
   └─ handleOpenAIToAnthropic OpenAI 客户端 → anthropic 上游：反向翻译（仅 /v1/chat/completions）
lib/translate/anth2openai.mjs   Anthropic→OpenAI：请求翻译（含 web_search server tool → 智谱/Kimi 方言映射、
                      未识别工具容错丢弃）+ 非流式/流式（SSE 状态机）响应翻译（usage 缓存字段
                      换算透传、智谱搜索结果翻译为 server_tool_use/web_search_tool_result 块对）
lib/translate/openai2anth.mjs   OpenAI→Anthropic：请求翻译（智谱 web_search / Kimi builtin → Anthropic
                      server tool）+ 非流式/流式响应翻译（搜索块降级文本、usage prompt_tokens
                      还原为总输入并带 prompt_tokens_details.cached_tokens）
lib/translate/searchtool.mjs    搜索工具跨方言映射：searchDialect（按 baseUrl 推断 zhipu/kimi/null）、
                      zhipuSearchTool / kimiSearchTool / zhipuResultBlocks / formatSearchAsText
lib/stats.mjs         流量/性能/费用统计（v2：days[].providers[pid].models[model] 分桶，含 cost 字段；v1 自动迁移）
lib/pricing.mjs       模型单价表与费用折算（内置 OpenRouter 量级参考价；providers.json pricing 节可按
                      模型名或 pid/模型名 覆盖；费用=按牌价折算的等效成本，记账时点单价入账）
lib/monitors.mjs      显示器输入源切换（m1ddc/DDC-CI over USB-C，串行队列 + 5s 状态缓存；
                      **只认硬件事实**：屏 = System UUID、输入 = VCP60 值，不内置任何
                      方向/主机语义；名字全由用户填，留空显示编号（屏=UUID 前 8 位、
                      输入=「输入 N」）。默认值表在 config.mjs 的 defaultMonitors()——
                      仅示例种子，可删改
lib/monitors-admin.mjs 管理台对 monitors 节的改名写回（只动 name，不碰 UUID/VCP；
                      原子落盘 0600）
lib/log.mjs           日志（内存环形缓冲 1000 行 + 落盘 + 5MB 轮转）
lib/util.mjs          httpError / sendJson / readBodyLimited（上游响应体有界读：content-length
                      预检 + 无/非法长度边读边检）/ token 权重（CJK 1:1 其余 4:1）/ randHex
lib/todos.mjs         工作台待办数据层（todos.json 写穿原子落盘 0600、坏文件自愈空列表、
                      字段码位校验、todosInWindow 供报告素材：新增/更新/完成三列表，
                      updated 只收「窗口前就存在、窗口内被推进、未在本窗新建或完成」）。
                      子项 checklist：todo.items=[{id,title,done,done_at}]，每次子项变更后
                      deriveFromItems 派生父状态
                      （非空且全 done→父 done 盖 completed_at 不重盖；有未完成且父 done→回
                      in_progress 清章；空清单不派生；显式 PATCH status 永远生效）。note 即
                      「详情」：agent 来源（source≠user）硬上限 300 码位、用户 2000；子项
                      标题 ≤200、每条待办 ≤50 子项；createTodoItem/updateTodoItem/
                      deleteTodoItem 供 /v1/todos/:id/items 端点
lib/report/sqlite.mjs 只读 SQLite 封装（spawn 系统 sqlite3 -json；只发 SELECT、id 白名单内联）
lib/report/sources/   四个 agent 会话源适配器（统一 listSessions({startMs,endMs})，正文判别式
                      与时间归因详见各文件头注释与 spec §5）：
   claude-code.mjs    ~/.claude/projects 顶层 jsonl（promptSource=="typed" 真人判别、
                      thinking/tool_result/isMeta/斜杠命令排除、ai-title、cwd 取项目）
   zcode.mjs          ~/.zcode/cli/db/db.sqlite（interactive 会话、semantics 真人判别、
                      消息级时间过滤、part 正文 + 工具摘要行）
   opencode.mjs       opencode.db 双路（session/message/part 主路 + event 事件溯源补路，
                      part 全量快照取最终态、多 agent 合成注入过滤）
   cursor.mjs         ~/.cursor/projects agent-transcripts（浅层排除 subagents、user 标签
                      锚点时间归因、无窗口标签回退 mtime+tailOnly）
lib/report/collect.mjs 素材收集：4 源并发降级（单源故障记 sourcesFailed 不失败）、项目归并
                      （basename 短名）、三级压缩（LIMITS 码位截断、tailOnly 尾取）、脱敏、
                      待办变动（含子项进度）+ stats 用量佐证
lib/report/generate.mjs 报告生成状态机：单任务串行（409）、collect→summarize→final 三段进度、
                      模型兜底链（workbench 节 → 默认上游目录第一个）、requestUpstream 协议
                      分支、reports.json 原子存档（上限 200）；两级总结失败或空响应自动重试一次
                      （CANNBOT_REPORT_RETRY_DELAY_MS 可调间隔）；「无记录」固定快径只在会话
                      与待办**双双为空**时走（有待办变动即调模型），materials.todos 记
                      新增/更新/完成三列表计数（updated = 窗口前就存在、窗口内被推进、
                      但没在本窗新建也没在本窗完成；与另两类互斥）
lib/report-prompts.mjs 两级总结 prompt + 压缩/脱敏阈值**全部集中在此**——调汇报质量只改这里
index.html            单页外壳：左栏两级分组导航（工作台 / 管理台）+ 六个视图
                      （待办 / 汇报 / 总览 / 统计 / 诊断 / 配置）全部逻辑内联在一段脚本里。
                      待办行：收起只扫父标题（2 行钳制 +「子项 k/j」徽标），展开看子项清单
                      （勾选即 PATCH 单条）与详情（agent 长文默认折叠）
theme.css             共享主题：令牌 / 骨架 / 左栏布局契约 / 通用组件（/theme.css 提供，
                      /workbench.css 为旧缓存的兼容别名，同一份内容）
```

### 请求路由（server.mjs 主入口）

| 路径 | 处理 |
|---|---|
| `/v1/messages`、`/messages` | Anthropic 客户端：先 checkClientAuth → 解析 model → 路由 → 直通或翻译 |
| `/v1/todos`、`/v1/todos/:id`、`/v1/todos/:id/items(/:itemId)` | 工作台待办 CRUD（Bearer 鉴权；**必须排在 /v1/* catch-all 之前**）：
  GET（`?status=` 过滤，子项随父返回）/ POST（可带 `items:[{title,done?}]` 初始清单）/ PUT·PATCH
  部分字段（PATCH 与 PUT 同义；可带 items 整组替换、子项对象带 id 则保留；status=done 盖
  completed_at）/ DELETE；子项：POST 加 / PATCH·PUT 勾选改名 / DELETE 删，写响应带整只父待办
  （全部子项完成 → 父自动 done，规则见 lib/todos.mjs 头注释） |
| `/v1/*` 其余 | OpenAI 客户端：鉴权 → 路由 → openai 上游透传 / anthropic 上游反向翻译 |
| `/v1/models` | 聚合所有 provider 目录（重名消歧为 `pid/model`，`owned_by`=provider id） |
| `/`、`/admin`、`/workbench` | 同一个 `index.html`（单页应用）。`/workbench` 是旧链接：页面按 pathname 强制落 `#todos` 并把地址改写成 `/#todos` |
| `/theme.css`、`/workbench.css` | 共享主题样式（硬编码路由；后者为旧缓存页面的兼容别名，同一份） |
| `/healthz`、`/admin/*` | healthz（providers[] 凭证体检）、管理台页面与 API（log/stats/config/restart/stop、
  providers CRUD+测试：GET 脱敏视图 / POST 新增 / PUT、DELETE `/admin/providers/:id` /
  POST `.../:id/check` 现拉目录验证凭证；写后热加载即时生效；
  报告生成（仅回环）：POST `/admin/report/generate` `{startMs,endMs}` 异步启动（在跑 409）、
  GET `/admin/report/job` 进度、GET `/admin/report/list`、GET/DELETE `/admin/report/:id`；
  显示器切换：GET `/admin/monitors`（状态，`?refresh=1` 绕缓存）/ POST `/admin/monitors/switch`
  （`{"input":n}` 显式切全部屏，可选 `"display":"<UUID 或前 8 位或名字>"` 单切一台；
  `input` 也可写成 `"target":"<输入源名字>"`）/ POST `/admin/monitors/rename`
  `{"input":n,"name":...}` 或 `{"display":...,"name":...}`，name 空串=恢复编号 |

URL 容忍 `/v1/v1/...` 叠加前缀。restart/stop/config/providers/monitors 仅接受回环 Host（防 DNS
rebinding）；providers 写操作（POST/PUT）、显示器切换与改名（POST）另强制 `application/json`
（跨站表单伪造不出，防 CSRF）。

### 关键设计约束（改代码前想清楚）

1. **零内容注入**：网关从不改写 system/messages 内容、不注入提示词。同协议路径保持字节级透传
   （OpenAI 透传唯一例外：`stream_options.include_usage`，provider 可用 `streamUsage: false` 关闭）。
   这是「网关不影响模型输出质量」的根据，动翻译层时以「内容逐字保留、只换结构」为红线。
2. **凭证每次请求现取**（不烘死）：CANNWork JWT 每请求读 session.json（扩展重登即生效）；
   静态 token 每请求解析。上游 401 → provider 策略重试一次（cannwork 强制重取 VK；static 不重试）；
   **403 不重试**（账号权限问题，直接透传）。
3. **防自我代理环路**：providers 的 baseUrl 必须直连上游官方域名，绝不能指向网关自身端口。
4. **providers.json 含全部订阅凭证**：0600、.gitignore 排除、绝不入库。模板是 providers.template.json
   （`__CLIENT_TOKEN__` 占位由 install.sh 首次安装时以随机 token 生成，**升级不覆盖已有配置**）。

### 流量统计与性能采样

- 两条入站管道各自用 Transform tap 旁路采集：字节数、usage（openai 与 anthropic 两种 SSE/JSON 形态都有对应解析）、SSE 块到达时间戳（marks）。
- 流式请求自动补 `stream_options.include_usage`（openai 上游）。性能口径对齐 vLLM benchmark：TTFT/TPOT/ITL/E2E；上游 completion_tokens 按字符权重经最大余数法摊到各块（`apportionTokens`）。
- 统计按 天/provider/模型/小时 分桶，延迟直方图 + 有限原始样本，30s 防抖落盘 stats.json 保留 30 天。`/admin/stats` 的 models 以 `provider:model` 展平，buckets 含 `cost`（lib/pricing.mjs 按单价折算的等效费用），响应另带 `prices[]`（期间出现过的模型生效单价，供管理台单价表）。

### 页面外壳（`index.html` + `theme.css`）

单页应用，由 `/`（及 `/admin`、`/workbench`）提供。**左栏两级分组导航**，全部是真链接
`<a href="#v">`（可中键新开、可复制、Tab 可达），由 `hashchange` 驱动切视图：

```
工作台  [默认展开]     待办 #todos（首屏默认）· 汇报 #report
管理台  [默认收起]     总览 #overview · 统计 #traffic · 诊断 #test · 配置 #providers
```

- 组头点击只折叠/展开，不导航；状态存 `localStorage` 的 `gw-groups`。
- **当前视图所属组自动展开**：进了 `#traffic` 却看到组还收着，会让人以为走错页。
- 深链：`#todos`…`#providers` 直达；历史形态 `#latency`→统计、`#log`→诊断、`#stats`→统计、
  `#stats-7`/`#stats-30`→统计并预选区间、`#workbench`→待办；`gw-view` 记住上次视图。
- 数字键 1–6 按左栏顺序切视图（输入控件内不抢键）。
- 徽标：工作台「待办」=未完成数（pending+in_progress）、「汇报」=存档数；管理台组头=
  凭证异常 provider 数；「诊断」=最近 80 行错误行数。今日完成数在待办页说明行。

**左栏布局契约**（`theme.css` 顶部有原文，违反必出中文逐字竖排）：左栏内不放横向并排的
多个文字控件；每个左栏行单行（`min-width:0` + `white-space:nowrap` + `overflow:hidden` +
`text-overflow:ellipsis`）；**禁用 `word-break: break-all`**（中文会被逐字折断）；拥挤不靠
缩字号解决，靠省略号。截断处一律把全文放 `title`，否则用户分不清是哪个（显示器名由用户自填）。

**轮询按视图分支**（不是全量常驻）：`/healthz` 常驻 3s（状态灯、运行时长、鉴权、上游数、
模型目录变化自愈）；`/admin/stats` 只在总览或统计视图可见时拉；`/admin/log` 只在诊断视图；
`/admin/monitors` 只在总览、最快 6s。`setView` 末尾立即各拉一次——切过去不能等下一个 tick，
更不能把旧值当新值展示。启动时一次性预取（模型目录/供应商/待办/历史/日志）作徽标种子，
回环请求各一次，与常驻轮询不是一回事。「今日 n 次」离开统计视图后停在最后值，`title` 注明
刷新时刻，不伪装成实时。报告生成中的 2s job 轮询不受当前视图影响。

**视图内容**：待办（快速添加：标题/紧急度 seg/项目标签；按 进行中→待办（紧急在前）→完成
折叠 分组；行内状态循环/删除；agent 来源徽标；**有子项/详情的行可展开**——收起只扫父标题
（2 行钳制 +「子项 k/j」徽标），展开区勾子项/加删子项/编辑详情（agent 长文默认折叠，输入态
不重建列表 DOM））；汇报（预设区间 seg + 自定义 datetime-local；生成 → 2s 轮询 job 进度
（琥珀扫掠条）→ Markdown 渲染 + 复制 + 下载 .md + 历史表格；成稿元数据行含「待办 新增 n /
更新 m / 完成 k」）；总览（订阅上游卡含凭证体检与协议串、模型目录 chips、今日速览、
显示器输入源——左栏底部一台屏一个按钮（点一下把那台屏切到下一个输入源，循环），
总览卡里每屏另有「⇄ 下一输入源」轮换单切，m1ddc 缺失降级提示）；
统计（趋势图 + 分供应商汇总 + 模型表 + 单价表 + 性能表，区间与指标 seg）；诊断（测试台 +
全模型对比 + 日志流）；配置（供应商增删改经 `/admin/providers`，token 脱敏、保存即热生效、
`测试` 按钮经 GET /v1/models 验证端点与凭证；末尾「服务控制」小节含重启/停止）。

动态文本一律 `esc()` 转义（转 `& < > "`）后再做 Markdown 结构替换（XSS 防线）。
待办走 Bearer（`loadToken`/`apiFetch`，仅 `/v1/*` 带 token 且 401 重取一次），
报告端点仅回环免 token。显示器界面**不写死任何方向或主机语义**：屏显示 UUID 前 8 位、
输入显示 VCP 值，名字由用户在页内「改名」自填（写入 providers.json 的 monitors 节，热生效；
留空恢复编号）。主题按钮在左栏遥测行右侧，**亮 ⇄ 暗二态**并记忆：点击目标取当前实际配色的
反面，因此每次点击必然变色（曾是「跟随系统 → 浅色 → 深色」三态循环，系统本身是浅色时
`auto` 与显式 `light` 渲染相同，导致亮→暗要点两下）。`auto` 只作为首次访问的默认值，
用户点过一次就留下明确偏好。

**趋势图悬停**：柱子带 `data-i`，`#chartTip` 气泡 + `#chartCol` 参考线由 `.plot` 上的
`pointermove` 委托驱动（柱宽仅约 10px，原生 `title` 要停一秒且位置随机）。零值柱用透明
伪元素把命中区撑满整列高度；重绘（轮询/切指标/切区间）后自动收起气泡，避免继续显示上一份
数据的数字。方向键可逐格读（无障碍与鼠标等价）。

**给 agent 的待办 skill** 在 `skills/workbench-todos/SKILL.md`：教 agent 用回环
`/admin/config` 现取 token 调 `/v1/todos`（**绝不写死 token**）、`source` 填自己的名字
（决定 note 300 字上限）、先查再写。该目录是普通仓库内容（不是 `.claude/`），随代码分发。

设计文档：`docs/superpowers/specs/2026-10-28-unified-shell-design.md`（统一外壳）；
待办数据源判别式：`2026-10-27-workbench-design.md` / `2026-10-28-todo-subitems-design.md`。

## 外部集成（改动前了解影响面）

客户端接入是动态的——各工具随时可能直连官方端点或切回网关，下表为 **2026-10-27 实测核对**；
排障时以运行时 `proxy.log` 的实际请求路径为准：

- zcode CLI v2（`~/.zcode/v2/provider_config.json`）：`海思` provider 走网关（openai 协议 →
  `http://127.0.0.1:8484/v1`）；`glm`/`deepseek`/`openrouter` 直连各自官方端点。
- zcode CLI 旧配置（`~/.zcode/cli/config.json`）：`cannbot` provider 走网关
  （`cannbot-creds.sh --sync-zcode` 写入，含网关 token）；`zai`/`bigmodel` 直连。
- Claude Code（`~/.claude/settings.json` env）：当前直连 GLM Coding Plan 的 anthropic 端点
  （open.bigmodel.cn），不走网关；曾经指向网关（2026-10-27 上午 zcode 桶的 130 次多轮 agent
  流量即走 Anthropic 协议直通路径）。
- launchd label：`cn.hicann.cannbot-gateway-proxy`（plist 由 `plist.template` sed 生成；端口经 `CANNBOT_PROXY_PORT` 注入或运行时 `port` 文件记录）。旧版的分离热键守护 label `cn.hicann.cannbot-monitor-hotkeys` 已随功能移除，install/uninstall 仅保留对其历史安装遗留的清理路径。

## 安全红线

- `providers.json`、`creds.json`、`vk-cache.json` 含实时凭证，已在 .gitignore，**绝不入库/入源目录**。注意 `vk-cache.json` 的默认落点是服务根目录：**前台从源目录起网关联调时必须设 `CANNBOT_VK_CACHE` 指向临时目录**（连同 `CANNBOT_LOG_FILE`/`CANNBOT_STATS_FILE`/`CANNBOT_TODOS_FILE`/`CANNBOT_REPORTS_FILE`），否则活 VK 会写进源目录（2026-10 曾发生并已清理）。
- 服务只绑 127.0.0.1；/v1/* 要求 Bearer token（未配置 clientToken 时不校验，勿在生产默认关闭）。
- 网关 token 的防护边界：挡盲扫与误暴露；单用户 Mac 上同 uid 进程仍可读凭证文件（README 有如实说明）。
