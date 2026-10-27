# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**统一订阅 API 网关**：把多个订阅服务（CANNWork、Kimi For Coding、GLM Coding Plan 等）集中接入一个本地网关，本机所有 Agent（zcode CLI、Claude Code、opencode 等）统一调用。按请求体里的**模型名**路由到对应订阅（providers.json 声明），自动注入该订阅凭证；同协议**原样直通**，跨协议走**双向翻译**。

- **零依赖 + 模块化**：无 package.json / node_modules，只用 Node ≥ 18 内置模块，`server.mjs` 入口 + `lib/` 若干 ESM 模块。没有构建、lint；测试是 `node test/smoke.mjs`（mock 上游端到端，不依赖真实订阅）。
- **语言约定**：注释、文档、commit message 全部使用中文，与现有风格保持一致。

## 常用命令

```bash
node server.mjs              # 前台直接运行（调试用；源目录无 providers.json，会回落内置默认配置——仅 cannbot、无客户端鉴权）
node test/smoke.mjs          # 端到端冒烟测试（起 mock 上游 + 网关实例，百余项断言；固定端口 6290/6291）
# 前台联调真实配置（换端口避开 launchd 实例）：
CANNBOT_PROXY_PORT=8485 CANNBOT_CONFIG_FILE="$HOME/.local/share/cannbot-gateway-proxy/providers.json" node server.mjs
./install.sh [端口]           # 安装并启动 launchd 常驻服务（幂等，缺省 8484）
./uninstall.sh [--revert-configs]   # 停服务；--revert-configs 连 zcode 配置一起回滚
./status.sh                  # 服务状态 + 各上游凭证体检 + 最近请求
./cannbot-creds.sh           # cannbot 订阅凭证诊断（日常不用跑）
curl http://127.0.0.1:8484/healthz  # 健康检查（providers[] 数组）
```

## ⚠️ 双目录设计（改代码必读）

本目录（桌面）是**项目源**；launchd 实际运行的是 `install.sh` 拷贝到 `~/.local/share/cannbot-gateway-proxy/` 的**运行时副本**（macOS TCC 限制 launchd 读不了桌面）。

**改动 `server.mjs`、`lib/`、`admin.html` 后必须重跑 `./install.sh` 才生效。** 运行时产物（providers.json、proxy.log、vk-cache.json、stats.json、logs/proxy.err.log、port 记录）都在运行时目录，不在本目录排障。**providers.json 改动不用重装**——网关按 mtime 热加载（lib/config.mjs）。运行时文件位置可用 `CANNBOT_CONFIG_FILE` / `CANNBOT_LOG_FILE` / `CANNBOT_STATS_FILE` 覆盖（test/smoke.mjs 即用它们把产物隔离到临时目录）。

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
                      输入=「输入 N」）。默认值表在 config.mjs 的 defaultMonitors()
lib/monitors-admin.mjs 管理台对 monitors 节的改名写回（只改 name，不动 UUID/VCP；原子落盘 0600）
lib/log.mjs           日志（内存环形缓冲 1000 行 + 落盘 + 5MB 轮转）
lib/util.mjs          httpError / sendJson / readBodyLimited（上游响应体有界读：content-length
                      预检 + 无/非法长度边读边检）/ token 权重（CJK 1:1 其余 4:1）/ randHex
```

### 请求路由（server.mjs 主入口）

| 路径 | 处理 |
|---|---|
| `/v1/messages`、`/messages` | Anthropic 客户端：先 checkClientAuth → 解析 model → 路由 → 直通或翻译 |
| `/v1/*` 其余 | OpenAI 客户端：鉴权 → 路由 → openai 上游透传 / anthropic 上游反向翻译 |
| `/v1/models` | 聚合所有 provider 目录（重名消歧为 `pid/model`，`owned_by`=provider id） |
| `/healthz`、`/admin/*` | healthz（providers[] 凭证体检）、管理台页面与 API（log/stats/config/restart/stop、
  providers CRUD+测试：GET 脱敏视图 / POST 新增 / PUT、DELETE `/admin/providers/:id` /
  POST `.../:id/check` 现拉目录验证凭证；写后热加载即时生效；
  显示器切换：GET `/admin/monitors`（状态，`?refresh=1` 绕缓存）/ POST `/admin/monitors/switch`
  （body `{"input":n}` 切全部屏，可选 `"display":"<UUID 或前 8 位或名字>"` 单切一台；
  `input` 也可写成 `"target":"<输入源名字>"`）/ POST `/admin/monitors/rename`
  `{"input":n,"name":...}` 或 `{"display":...,"name":...}`，name 空串=恢复编号） |

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

### 管理台

`admin.html`（Claude 风格深浅色主题）由 `/` 提供，3 秒轮询 `/healthz`、`/admin/log`（内存环形缓冲）、`/admin/stats`；启动时经 `/admin/config`（仅回环）取网关 token 供测试按钮调用。订阅上游卡逐 provider 展示凭证状态；「供应商配置」卡经 `/admin/providers` 在网页上增删改 providers.json（token 脱敏、保存即热生效、`测试` 按钮经 GET /v1/models 验证端点与凭证，static 目录也走该探测）。总览页另有「显示器输入源」卡（`/admin/monitors`）：**界面不写死任何方向或主机语义**，屏显示 UUID 前 8 位、输入显示 VCP 值，名字由用户在页内「改名」按钮自填（写入 providers.json 的 monitors 节，热生效；留空恢复编号）。左侧导航栏按输入源动态生成「整机同切」按钮，状态卡每屏一个「⇄ 下一输入源」按钮点击轮换单切（不设下拉），m1ddc 缺失时降级提示；卡片底部有可直接绑热键的 curl 示例。

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
- launchd label：`cn.hicann.cannbot-gateway-proxy`（plist 由 `plist.template` sed 生成；端口经 `CANNBOT_PROXY_PORT` 注入或运行时 `port` 文件记录）。

## 安全红线

- `providers.json`、`creds.json`、`vk-cache.json` 含实时凭证，已在 .gitignore，**绝不入库/入源目录**。当前源目录残留历史 `creds.json`/`proxy.log`（已被 ignore，不入库；creds.json 已迁运行时目录，可择机清理）。
- 服务只绑 127.0.0.1；/v1/* 要求 Bearer token（未配置 clientToken 时不校验，勿在生产默认关闭）。
- 网关 token 的防护边界：挡盲扫与误暴露；单用户 Mac 上同 uid 进程仍可读凭证文件（README 有如实说明）。
