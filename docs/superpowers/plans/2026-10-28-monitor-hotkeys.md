# 显示器输入源系统级热键 Implementation Plan

> **注（2026-10-28）**：本计划初稿是「F13→输入15 / F14→输入21」双键模型，已被需求更正
> （`~/Desktop/wb-review/feat-monitor-hotkeys-task.md`）**作废**，实际实现改为单键 toggle 模型
> （`monitors.hotkeys: [{action:"toggle", key:"f13"}]`，绑动作不绑输入源值）。本文仅存档，
> 实现以代码与 CLAUDE.md/README 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统级热键（F13→输入源15 / F14→输入源21，可改绑）+ 管理台改绑 UI + 工作台侧栏一键切。

**Architecture:** 配置事实源是 `providers.json` 的 `monitors.hotkeys`（config.mjs 归一化 + 管理台写回原子落盘）。热键守护为独立 Swift/Carbon 小进程（RegisterEventHotKey，无第三方依赖），随独立 LaunchAgent `cn.hicann.cannbot-monitor-hotkeys` 开机自启；按下热键 → `POST /admin/monitors/switch` 到本机网关；守护每 3s 查 providers.json mtime，变更即重注册热键（热生效，无需信号）。

**Tech Stack:** Swift + Carbon HIToolbox（swiftc 编译，install.sh 现场编译）；网关侧 Node ESM 沿现有模式。

**Spec:** `~/Desktop/wb-review/feat-monitor-hotkeys-task.md`

## Global Constraints

- 零第三方依赖；注释/文档/commit 全中文。
- 热键守护 LaunchAgent 与网关 plist **分离**；install/uninstall 集成且尊重 `CGP_SKIP_LAUNCHCTL=1`（只写文件不 bootout/bootstrap）。
- 写端点 `POST /admin/monitors/hotkeys` 仅回环 Host + 强制 `application/json`（与 rename 同威胁模型）。
- key 记号：小写稳定记号（`f13`、`cmd+opt+w`），解析层预留任意修饰键组合，不止 F 键。
- 禁止：合并 main、动正式网关 `cn.hicann.cannbot-gateway-proxy` plist、停正式网关、对 8484 执行 install/uninstall。
- 双时区 smoke 全绿 + 一次清晰 commit + 工作树干净。

## Review Focus

- key 记号非法（大写、未知键名、空串）→ 写接口 400 且不落盘。
- input 不在 monitors.inputs → 404（与 rename 同口径）。
- 网关未起/请求失败 → 守护只记日志不崩、热键不注销。
- providers.json 缺 monitors 节 → defaultMonitors() 播种（含默认热键）。
- 同一 key 绑到多个 input → 写接口 400（热键互撞）。

---

### Task 1: 配置层 hotkeys（config.mjs）

**Files:** Modify `lib/config.mjs`
**Interfaces:** Produces `normalizeMonitors` 返回 `{inputs, list, hotkeys}`；`defaultMonitors()` 返回含 `hotkeys: [{input:15,key:'f13'},{input:21,key:'f14'}]`。

- [ ] `normalizeMonitors` 增加解析 `raw.hotkeys`：条目 `{input, key}`，input 1-255 整数、key 匹配 `/^[a-z]+[a-z0-9]*(\+[a-z]+[a-z0-9]*)*$/` 且长度 ≤ 32，非法静默跳过；同 input 重复取首个、同 key 重复取首个。
- [ ] defaultMonitors 播种默认 F13/F14。

### Task 2: 写接口 + 状态透出（monitors-admin.mjs / monitors.mjs / server.mjs）

**Files:** Modify `lib/monitors-admin.mjs`、`lib/monitors.mjs`、`server.mjs`
**Interfaces:** Produces `setMonitorsHotkeys(payload)`（payload `{hotkeys:[{input,key}]}` 整体替换）；`monitorsStatus()` 响应新增 `hotkeys` 字段（来自 cfg）；路由 `POST /admin/monitors/hotkeys`。

- [ ] `setMonitorsHotkeys`：非数组 400；逐条校验（input 需在 sec.inputs，key 记号正则同 Task1，同 key 撞车 400、同 input 重复 400）；沿用 renameMonitors 的 upgradeSection + 原子落盘 + validateRawConfig；返回 `{ok, hotkeys}`。
- [ ] `monitorsStatus` 在 ok:false 分支与正常分支都带 `hotkeys: cfg.hotkeys ?? []`。
- [ ] server.mjs 新路由：POST + 回环 + JSON 三件套，照抄 rename 段。
- [ ] smoke 行为级断言：合法写入落盘且 GET /admin/monitors 读回；非法 key 400；未知 input 404；key 撞车 400；GET 带 hotkeys。

### Task 3: Swift 热键守护 + LaunchAgent + install/uninstall 集成

**Files:** Create `hotkeys/monitor-hotkeys.swift`、`hotkeys.plist.template`；Modify `install.sh`、`uninstall.sh`
**Interfaces:** 二进制 `$RUNTIME_DIR/monitor-hotkeys`；plist `~/Library/LaunchAgents/cn.hicann.cannbot-monitor-hotkeys.plist`；环境变量 `CANNBOT_CONFIG_FILE`（缺省二进制同目录 providers.json）、`CANNBOT_PROXY_PORT`（缺省读同目录 `port` 文件，再缺省 8484）。

- [ ] Swift：Carbon RegisterEventHotKey + InstallEventHandler；key 记号解析（修饰键 cmd/ctrl/opt/alt/shift + f1-f24/字母/数字）；按下 → URLSession POST switch，失败只写日志；Timer 3s 查配置 mtime 变更即 Unregister + 重注册；日志追加 `$RUNTIME_DIR/logs/hotkeys.log`。
- [ ] install.sh：swiftc 存在则编译拷贝（不存在则警告跳过，不阻断网关安装）；sed 生成 hotkeys plist；非演练时 bootstrap。
- [ ] uninstall.sh：bootout + 删 hotkeys plist + 删二进制（守卫同网关）。
- [ ] smoke 源码断言：swift 源存在且含 RegisterEventHotKey；install.sh 含 hotkeys plist 生成与 CGP_SKIP_LAUNCHCTL 分支；uninstall.sh 含清理。

### Task 4: 管理台改绑 + 工作台侧栏

**Files:** Modify `admin.html`、`workbench.html`
**Interfaces:** Consumes Task2 的 GET hotkeys / POST hotkeys / switch。

- [ ] admin.html 显示器卡：每个 input 行旁显示热键输入框（占位「如 f13」）+ 保存 → POST hotkeys（整表提交）；顶部提示改为「已绑定系统热键：F13→win …」，curl 示例保留一行精简版。
- [ ] workbench.html 侧栏：打开页拉一次 /admin/monitors，动态生成「输入源」按钮组（label 用 inputLabel），点击 POST switch，失败/409 短提示；不轮询。
- [ ] smoke 源码断言：admin 含 hotkeys 提交逻辑；workbench 含 monitors switch 调用。

### Task 5: 回归 + 真机验收 + commit

- [ ] `swiftc` 本机编译通过；`node test/smoke.mjs` 双时区（Shanghai/LA）全绿。
- [ ] 真机：bootstrap 热键 LaunchAgent（允许），不聚焦浏览器按 F13/F14，`GET /admin/monitors?refresh=1` 读回验证幂等。
- [ ] 文档：README/CLAUDE.md 补热键说明（安装/改绑/路径）。
- [ ] 单次 commit，工作树干净，汇报。
