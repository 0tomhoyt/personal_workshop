# 个人工作台 · 统一订阅 API 网关（cannbot-gateway-proxy）

**统一订阅网关**：把**多个订阅服务**（CANNWork、Kimi For Coding、GLM Coding Plan 等）集中接入一个本地网关，
本机所有 Agent（zcode CLI、Claude Code、opencode、任意 OpenAI/Anthropic 客户端）统一从这里调用。
网关按请求里的**模型名**路由到对应订阅，自动注入该订阅的凭证——业务配置里不需要保存任何上游密钥。

**个人工作台**（`http://127.0.0.1:8484/workbench`）：跨 agent 的待办事项（人与 agent 经
`/v1/todos` 共用）+ 时间段 AI 工作总结（读本机各 agent 的会话记录，两级总结成给上级的汇报）。

```
zcode CLI / Claude Code / opencode / curl …（全部 Agent）
        │  Authorization: Bearer <网关token>
        │  OpenAI  /v1/chat/completions    Anthropic  /v1/messages
        ▼
统一网关 127.0.0.1:8484（launchd 常驻）
   ├─ 模型名路由     model → provider（providers.json，热加载）
   ├─ 协议处理       同协议原样直通（字节级）；跨协议双向翻译
   ├─ 凭证注入       per-provider：CANNWork JWT+VK 链 / 静态 token
   ├─ 统计与管理台   流量、TTFT/TPOT/ITL/E2E、provider 维度
   └─ 个人工作台     /workbench：待办 /v1/todos（人与 agent 共用）
        │            + AI 时间段总结 /admin/report/*（读 Claude Code /
        │              zcode / opencode / Cursor 本地会话 → 两级总结汇报）
        ├─→ cannbot  https://cannbot.hicann.cn/…        (openai 协议)
        ├─→ kimi     https://api.kimi.com/anthropic      (anthropic 协议)
        └─→ zcode    https://api.z.ai/api/anthropic      (anthropic 协议)
```

**为什么不影响模型输出质量**：网关只做「选上游 + 注入凭证头」，不改写 prompt/messages——模型看到的
输入不变，输出分布就不变。同协议请求走**原样直通**（Anthropic 客户端 → Kimi/Zcode 的 Anthropic 原生
端点是字节级透传）；只有跨协议才走翻译，且翻译以「内容逐字保留、只换结构」为红线。OpenAI 透传路径
唯一 body 修改是补 `stream_options.include_usage`（仅为统计，可用 `streamUsage: false` 关闭）。

> 前身是 CANNBot 单上游代理；2026-10 重构为多上游统一网关。原 cannbot 订阅的接入方式不变
> （凭证链、zcode/claude-code 接入点全部兼容）。

---

## 目录结构

| 文件/目录 | 作用 |
|---|---|
| `server.mjs` | 入口：HTTP 服务 + 路由分发 + healthz/admin 端点（Node ≥18 零依赖） |
| `lib/` | 服务端模块：config（providers.json）/ models（模型目录与路由）/ upstream（统一上游请求）/ auth/（cannwork、static 凭证链）/ translate/（Anthropic↔OpenAI 双向翻译）/ proxy-openai、proxy-anthropic（两条入站管道）/ stats / log / gwauth / util / todos（工作台待办）/ report（总结管线：四源适配器 + 素材收集 + 生成状态机）/ report-prompts（总结 prompt 与阈值，调质量改这里） |
| `admin.html` | 网页管理台（`http://127.0.0.1:8484/`，provider 健康卡 + 供应商增删改 + 统计 + 测试） |
| `workbench.html` / `workbench.css` | 个人工作台页（`/workbench`：待办 + AI 工作总结）与两页共享的主题样式 |
| `providers.template.json` | providers.json 模板（install.sh 首次安装时生成到运行时目录） |
| `test/mock-upstream.mjs` `test/smoke.mjs` | 端到端冒烟测试：mock 双协议上游 + 三百余项断言（`node test/smoke.mjs`） |
| `install.sh` / `uninstall.sh` / `status.sh` / `plist.template` | launchd 部署与状态 |
| `cannbot-creds.sh` | cannbot 订阅凭证诊断（可选；`--sync-zcode` 重写 zcode 指向网关并写入 token） |
| `打开管理界面.command` | **双击即可**：自动确保网关已启动并打开管理台 |

**两个目录的关系**：本文件夹是项目源（source of truth）；`install.sh` 会把 `server.mjs + lib/ + admin.html`
拷贝到运行时目录 `~/.local/share/cannbot-gateway-proxy/`（providers.json、日志、VK 缓存、stats.json 也
都在那里），launchd 实际运行的是该副本——macOS 对桌面目录有 TCC 保护，launchd 读不到桌面。
**改动代码后需重跑 `./install.sh` 才生效**；改 `providers.json` 不用（网关按 mtime 热加载）。

## 快速开始

```bash
./install.sh                    # 默认端口 8484；冲突时: ./install.sh 8485
# 首次安装会生成 ~/.local/share/cannbot-gateway-proxy/providers.json（0600，含随机网关 token）
#   并在终端打印 token 与两个协议的接入片段
$EDITOR ~/.local/share/cannbot-gateway-proxy/providers.json   # 填入各订阅凭证（见下节）
#   —— 或者直接在管理台网页里「供应商配置」卡添加/编辑，无需手改文件
./status.sh                     # 看各上游凭证体检结果
```

模板里 cannbot（CANNWork）无需凭证配置——JWT 由 CANNWork 扩展登录供给；Kimi/GLM 需要补 token。

## providers.json 详解

```jsonc
{
  "gateway": {
    "clientToken": "sk-gw-…",              // 客户端调 /v1/* 需带的 Bearer token；留空则不鉴权（不建议）
    "upstreamHeadersTimeoutMs": 180000     // 上游「发请求→收到响应头」超时；不影响已建立的流
  },
  "providers": [
    {
      "id": "cannbot",                     // 路由前缀标识：cannbot/glm-5.3
      "name": "CANNWork",
      "baseUrl": "https://cannbot.hicann.cn/gateway/compatible-mode",   // 不带尾部 /v1（自动补协议路径）
      "protocol": "openai",                // openai | anthropic —— 上游兼容的 API 协议
      "auth": { "type": "cannwork-jwt-vk" },                            // JWT+VK 凭证链
      "models": { "source": "api", "exclude": [] }                      // 从上游接口拉模型列表
    },
    {
      "id": "kimi",
      "baseUrl": "https://api.kimi.com/anthropic",
      "protocol": "anthropic",
      "auth": { "type": "static-token", "tokenEnv": "KIMI_API_KEY" },   // 或 token / tokenFile
      "models": { "source": "static", "list": [{ "id": "kimi-k2-thinking" }] }
    },
    {
      "id": "zcode",
      "baseUrl": "https://api.z.ai/api/anthropic",
      "protocol": "anthropic",
      "auth": { "type": "static-token", "tokenEnv": "ZAI_API_KEY" },
      "models": { "source": "api" }        // anthropic 协议也支持标准 GET /v1/models
    }
  ],
  "routing": {
    "defaultProvider": "cannbot",          // 模型名查不到时的兜底上游（请求原样携带 model）
    "aliases": { "k2": "kimi/kimi-k2-thinking" }
  },
  "pricing": {                             // 可选：模型单价覆盖（美元 / 1M tokens），费用统计用
    "glm-5.3": { "input": 1.2, "output": 4.5 },
    "kimi/k3.1-pro": { "input": 1.5, "output": 6.0 }   // pid/模型名 精确覆盖 > 裸模型名 > 内置参考价
  }
}
```

要点：
- **baseUrl 统一填不含尾部 `/v1` 的地址**（粘贴带 `/v1` 的会被自动去掉）。openai 上游代码补
  `/v1/chat/completions`，anthropic 上游补 `/v1/messages`，与各家「Claude Code/OpenAI 兼容端点」文档一致。
- **静态 token 三种来源**（按优先级）：`token` 内联 / `tokenEnv` 环境变量 / `tokenFile`（可选
  `tokenJsonPath` 用 `a.b.c` 取字段，可直接复用其他工具已登录的凭证文件）。每次请求现读，外部工具
  刷新 token 后立即生效。
  ⚠️ launchd 环境里 shell 的 env 不生效——用 `token`/`tokenFile`，或把变量写进 plist 的
  `EnvironmentVariables`。
- **费用统计单价**：`pricing` 节可覆盖任意模型单价（键 `模型名` 或 `pid/模型名`，美元 / 1M tokens）；
  未覆盖的模型用内置参考价（`lib/pricing.mjs`，参考 OpenRouter 公开牌价与各家官方定价量级估算）。
  费用是**按牌价折算的等效成本**——订阅制上游（Kimi Code / GLM Coding Plan / CANNWork）实际是
  固定月费，金额仅供横向比较用量价值；缓存 token 未单独计量，按普通输入计。费用在记账时点按当时
  生效单价入账（账本语义），改单价不回溯历史。
- anthropic 协议上游自动带 `x-api-key` + `Authorization: Bearer` + `anthropic-version`，兼容
  Kimi / Z.ai 等不同实现。
- 文件含全部订阅凭证：0600 权限、绝不入版本库（.gitignore 已排除）。

## 模型路由规则

`/v1/models` 聚合所有已启用订阅的目录（`owned_by` = provider id）。请求按 `model` 字段路由：

| 请求里的 model | 路由到 |
|---|---|
| `kimi/kimi-k2-thinking` | 显式前缀：kimi 订阅，上游模型名剥前缀 |
| 裸名且全局唯一（如 `glm-5.3`） | 其唯一所属订阅 |
| 裸名重名（多个订阅都有 `shared-model`） | 列表里自动消歧为 `pid/model`，裸名不再命中 |
| `routing.aliases` 里的别名 | 别名指向的目标 |
| 查不到（如上游新模型） | `defaultProvider` 原样携带，天然自愈 |

## 协议矩阵（质量说明）

| 客户端 \ 上游 | openai 订阅（cannbot…） | anthropic 订阅（kimi、zcode…） |
|---|---|---|
| **OpenAI 客户端** | 原样透传（逐字节，仅可选补 include_usage） | 双向翻译：openai→anth 请求 + anthropic SSE→openai chunk 状态机 |
| **Anthropic 客户端** | 双向翻译（anth→openai 请求 + openai SSE→anth 事件流） | **原样直通**（换凭证头与 model 名，SSE 字节级透传，零翻译损耗） |

翻译层覆盖：system（字符串/块数组）、文本、base64/url 图片、tools + tool_choice、tool_use/tool_result
多轮闭环、stop/temperature/top_p/top_k、流式完整事件序列、thinking↔reasoning_content。
已知取舍：跨协议路径上 `document`（PDF）块与 `metadata` 无对应被忽略——同协议直通不受影响。

## Agent 接入

### OpenAI 兼容客户端（zcode、openai SDK、curl）

```
Base URL : http://127.0.0.1:8484/v1
API Key  : providers.json 里的 gateway.clientToken
模型列表 : GET /v1/models（全部订阅聚合，owned_by 标注来源）
```

```bash
curl http://127.0.0.1:8484/v1/chat/completions \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"model":"kimi/kimi-k2-thinking","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

### Anthropic 协议客户端（claude-code、anthropic SDK）

```
Base URL : http://127.0.0.1:8484        （SDK 自动拼 /v1/messages；多写 /v1 也能容错）
API Key  : ANTHROPIC_AUTH_TOKEN = 网关 token
```

**claude-code 接入**（`~/.claude/settings.json` 的 `env` 块）：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<网关token>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8484",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi/kimi-k2-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "glm-5.3-flash",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "model": "opus"
}
```

**zcode CLI**：`./cannbot-creds.sh --sync-zcode` 会把 `~/.zcode/cli/config.json` 的 `provider.cannbot`
指向网关并写入 token（模型清单优先取网关聚合目录）；`~/.zcode/v2/provider_config.json` 里个人 provider
的 baseUrl 改为 `http://127.0.0.1:8484/v1`、apiKey 改为网关 token 即可。

**鉴权边界（如实说明）**：网关 token 挡的是「盲扫 127.0.0.1:8484 的无凭证请求」与端口误暴露后的外部
扫探。单用户 Mac 上其他进程与网关同 uid，理论上能读到 providers.json（或经仅回环可读的 /admin/config
取 token）——真正的多用户隔离需要另做，不在本工具定位内。

## 个人工作台（待办 + AI 工作总结）

浏览器打开 `http://127.0.0.1:8484/workbench`（管理台左栏「工作台」进入）：

- **待办事项**：标题 + 紧急程度（紧急/普通/不急）+ 可选项目标签；进行中 → 待办 → 已完成（折叠）
  分组；紧急排前。点标题可就地编辑（标题/紧急度/项目标签，走 `PATCH /v1/todos/:id`），列表上方可按
  项目标签、来源（user / agent）与紧急度筛选，也可按标题关键字搜索（纯前端，与筛选叠加），筛选状态记在
  浏览器 localStorage；`/` 快捷键聚焦搜索、Esc 清空；一键「清理已完成」（全量口径，编辑中的跳过）。
  键盘可达：主区首部有视觉隐藏的 skip link「跳到报告区」，大量待办下 Tab 一次即到报告区。
  数据在 `todos.json`（运行时目录），人与 agent 共用同一份。
- **时间段工作总结**：预设区间（今日/昨天/本周/上周/近7天/近30天）或自定义起止 → 点「生成报告」。
  网关读取 **Claude Code / zcode / opencode / Cursor 四个 agent 的本地会话记录**（只读各自的
  数据文件，互相独立、单源故障只降级不失败），按项目归并压缩、脱敏（密钥样式 → `[REDACTED]`），
  经两级总结（逐项目小结 → 汇总成稿）产出**给上级看的中文 Markdown 汇报**——按项目分节、
  突出做了什么/推进到哪/产出什么，文末附待办进展与模型用量数据附注。一键复制、下载 .md（按报告时间窗命名）、历史存档可回看并按原时间段一键重跑。任一级总结失败或空响应会自动重试一次（间隔可用
  `CANNBOT_REPORT_RETRY_DELAY_MS` 调）。
- **报告用什么模型**：providers.json 的 `workbench` 节（`reportProvider` / `reportModel`，改完热
  生效）；不配则自动用默认上游的第一个可用模型。**总结质量的调优入口集中在
  `lib/report-prompts.mjs`**（prompt 文案、截断阈值、脱敏模式都在这一个文件）。

### 让 agent 读写待办

把下面这段贴进 `~/.claude/CLAUDE.md`（或其他 agent 的全局指引），它就能替你管理待办：

```markdown
## 待办事项（跨会话持久）

用户让你「加待办 / 看待办 / 完成某条待办」时，用 curl 调本地网关（token 见
providers.json 的 gateway.clientToken，或先 GET http://127.0.0.1:8484/admin/config）：

- 列出：curl -s http://127.0.0.1:8484/v1/todos -H "Authorization: Bearer <token>"
- 新增：curl -s -X POST http://127.0.0.1:8484/v1/todos -H "Authorization: Bearer <token>" \
    -H 'content-type: application/json' \
    -d '{"title":"一句话说清","urgency":"urgent|normal|someday","project":"可选标签","source":"agent:claude-code"}'
- 完成：curl -s -X PUT http://127.0.0.1:8484/v1/todos/<id> -H "Authorization: Bearer <token>" \
    -H 'content-type: application/json' -d '{"status":"done"}'

加待办时始终带上 "source":"agent:<你的名字>"。
```

REST 明细：`GET /v1/todos`（`?status=` 过滤）· `POST /v1/todos` · `PUT /v1/todos/:id`（部分字段；
status=done 自动盖 completed_at）· `DELETE /v1/todos/:id`。报告 API（仅回环）：
`POST /admin/report/generate` `{startMs,endMs}` → `{jobId}` · `GET /admin/report/job` 进度 ·
`GET /admin/report/list` · `GET|DELETE /admin/report/:id`。

## 管理台 / 统计

浏览器打开 `http://127.0.0.1:8484/`（或双击「打开管理界面.command」），每 3 秒自动刷新：

- **订阅上游卡**：每个 provider 一块——协议、凭证状态（CANNWork JWT 倒计时 + VK 来源/配额；
  静态 token 来源）、模型目录数量；异常时顶部 banner 给出对应修复动作
- **供应商配置卡**：在网页上直接增删改 providers.json——添加/编辑供应商（id、协议、端点、
  凭证、静态模型列表每行一个 `id | 标题`）、启用/停用、删除、一键测试（现拉一次模型目录，
  顺带验证端点与凭证）。token 只显示掩码、编辑时留空即沿用；保存即热生效，无需重启
- **流量与费用**：今日/近 7 天/近 30 天区间汇总、趋势图（请求/Tokens/费用三种指标切换）、
  分供应商费用汇总块、分上游×模型用量与费用表（含费用占比条）、单价表（内置参考价 /
  自定义 / 未计价）——费用为按牌价折算的等效成本（参考 cc-switch 用量页口径）
- **模型性能**（只统计流式响应，口径对齐 vLLM benchmark / MLPerf）：TTFT / TPOT / ITL / E2E
  中位与 P99、解码速度、速度分排行，按输入档（短/中/长）分桶，同一区间内跨订阅对比
- 模型 chips 带 provider 徽标（点击填入测试）、一键测试/对比全部模型、实时日志、重启/停止

程序化读取：`GET /admin/stats` 返回 today/week/models/hours + `days` 逐日数组（`models` 以
`provider:model` 为 key 展平）+ `latEdges`。`GET /healthz` 返回 `providers[]` 数组（各上游凭证状态）。
`GET /admin/config`（仅回环）返回网关 token，管理台测试按钮用。

供应商管理 API（均仅回环 Host；写操作另要求 `application/json`，跨站表单伪造不出）：
`GET /admin/providers`（脱敏视图）· `POST /admin/providers` 新增 · `PUT /admin/providers/:id`
修改（部分字段即可，token 留空=沿用）· `DELETE /admin/providers/:id`（最后一个拒绝删）·
`POST /admin/providers/:id/check` 测试。写入前整体校验（含 baseUrl 防指向网关自身），
原子落盘保持 0600，网关按 mtime 热加载即时生效。

## 显示器输入源切换 + 系统热键

通用功能：网关只认硬件事实（屏 = System UUID、输入 = DDC VCP60 值），**不写死任何方向 /
主机 / 输入值语义**——名字全部由用户在管理台自填（输入源名、屏名，留空显示编号）。单屏、
多屏、两台 Mac 共接一台显示器等拓扑都适用。

- **一键切换（toggle）**：`POST /admin/monitors/switch {"mode":"toggle"}`——先读各屏当前
  输入再定向：各屏同源 → 整机切到 `monitors.inputs` 列表里的下一个（循环；单屏即此规则）；
  异源 → 按配置 list 顺序轮换互换（两屏即「互换」）。管理台按钮 / 工作台侧栏按钮 /
  系统热键走的是同一后端动作。显式指定仍可用：`{"input":VCP值}`、`{"target":"输入源名"}`，
  加 `"display":"屏名或UUID"` 单切一台。
- **系统热键**：默认 **F13 = 一键切换**（可在管理台改绑，如 `cmd+opt+d`，可多把）。热键由
  独立 LaunchAgent `cn.hicann.cannbot-monitor-hotkeys` 常驻（Swift/Carbon，`install.sh` 现场
  编译，无 swiftc 时自动跳过；与网关服务分离，互不影响启停）。配置在 providers.json 的
  `monitors.hotkeys`（`[{"action":"toggle","key":"f13"}]`——绑动作不绑输入源值），改绑后
  守护数秒内热加载，无需重启。日志：运行时目录 `logs/hotkeys.log`。
- 显示器配置（`monitors.inputs` / `monitors.list`）在 providers.json 的 `monitors` 节，管理台
  「显示器输入源」卡可改名（热生效）；`monitors.inputs` 换成任何机器自己的 VCP 值都照常工作。

## 刷新凭证（通常无事可做）

| 场景 | 你需要做的 |
|---|---|
| **CANNWork JWT 过期**（每 24h） | 打开 VSCode 的 CANNWork 扩展**重新登录**。网关每次请求现读 session.json，登录即生效，无需重启。过期返回带指引的 502（`jwt_expired`）。 |
| **VK 失效/换账号** | 无需操作。VK 链路：`auth.json` → `/cannbot/api/ai-keys/vk/my`（JWT 换取，权威来源）→ 遗留接口兜底，缓存 `vk-cache.json`；上游 401 跳过缓存重取并重试一次（403 是账号权限问题，不重试）。 |
| **静态 token 失效/更换** | 管理台「供应商配置」卡编辑粘贴新 token（或改 providers.json / 刷新 tokenFile 指向的文件），保存即热加载，无需重启。 |
| **不确定状态** | `./status.sh` 看各上游体检；或管理台订阅上游卡。 |

## 排障

```bash
./status.sh                       # 服务 + 各上游凭证 + 最近请求
tail -f ~/.local/share/cannbot-gateway-proxy/proxy.log
tail -50 ~/.local/share/cannbot-gateway-proxy/logs/proxy.err.log
node test/smoke.mjs               # 端到端回归（不依赖真实订阅）
```

| 现象 | 原因与处理 |
|---|---|
| 401 `gateway_auth_failed` | 客户端没带/带错网关 token → 用 install.sh 打印的 token |
| 502 `jwt_expired` / `jwt_missing` | CANNWork 未登录/过期 → 重新登录即可 |
| 502 `provider_auth_missing` | 静态 token 未配置 → providers.json 补 auth；注意 launchd 里 env 不生效 |
| 上游 403 "Model not allowed" | 订阅账号无该模型权限，与网关无关 |
| 模型不在 /v1/models | 该订阅 models.source 或列表配置问题；也可显式 `pid/model` 直呼（defaultProvider 兜底） |
| 连接拒绝 | 网关没运行 → `./install.sh`；换过端口则客户端同步改 |
| 改了代码不生效 | 重跑 `./install.sh`（launchd 跑运行时副本）；改 providers.json 则即时生效 |

### 环境变量（写进 launchd plist 或前台导出）

| 变量 | 缺省 | 说明 |
|---|---|---|
| `CANNBOT_PROXY_PORT` | `8484` | 监听端口（`./install.sh <端口>` 一步到位；providers.json gateway.port 亦可） |
| `CANNBOT_SESSION_FILE` / `CANNBOT_AUTH_FILE` | opencode 目录 | cannwork 凭证来源（provider auth 里也可配） |
| `CANNBOT_EXCLUDE_MODELS` | 空 | 追加到各 provider models.exclude 的隐藏模型 |
| `CANNBOT_CONFIG_FILE` / `CANNBOT_LOG_FILE` / `CANNBOT_STATS_FILE` | 运行时目录 | 文件位置覆盖（测试用） |

## 回滚（完全撤销）

```bash
./uninstall.sh --revert-configs   # 停服务 + 回滚 zcode 两处配置
rm -rf ~/Desktop/cannbot-gateway-proxy
```

卸载会先把 `providers.json` / `todos.json` / `reports.json` 与坏文件自愈的 `*.bad` 现场备份
抢救到 `~/.local/share/cannbot-gateway-proxy.data-backup-<时间戳>/` 再清理运行时目录。
脚本演练/测试时务必带 `CGP_SKIP_LAUNCHCTL=1`（跳过 launchctl 步骤——launchctl 作用于
用户域、与 HOME 无关，沙箱 HOME 下跑也会停掉真实服务）。

## 已知注意事项

- **CANNWork 2.0.2 已适配**：模型列表走 `/cannbot/api/models/list`（遗留 `/models/personal` 兜底），
  VK 存 `~/.local/share/opencode/auth.json`，`/healthz` 的 `auth` 块与订阅上游卡可查来源与配额。
- ZCode.app 在 UI 里改动 provider 时可能重写 `provider_config.json`，把 baseUrl 改回 bigmodel。
  发现 zcode 又报"余额不足"时先 `./status.sh`，再
  `grep -o '127.0.0.1:8484' ~/.zcode/v2/provider_config.json`（无输出即被改回）。
- 原理备忘：zcode CLI 0.16.9 忽略配置里的 `model.main`，实际用个人 provider 存储里第一个 provider
  的第一个模型——这是改接 `glm` provider 而不是新增 provider 的原因。
- **防自我代理环路**：providers 的 baseUrl 必须直连上游官方域名，绝不指向网关自身。
- 详细排查历史见 `~/Desktop/CANNBot网关接入zcode-进度报告.md`。
