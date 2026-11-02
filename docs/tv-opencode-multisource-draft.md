# 草案：电视 OpenCode / 工作台多信号源（未实现）

状态：2026-11-02 **已按枢纽汇聚落地**（网关 + 管理台小卡 + 电视 source 展示）。下文仍是设计说明。对照现状：`GET /tv/v1/opencode` 已在网关；管理台 `index.html` 无 OpenCode 战况/指挥台面板；Aerial 配对为**单** `base_url`+token，电视**拉**网关。

## 现状（事实）

| 项 | 现状 |
|---|---|
| 推送方向 | **电视拉**：`/tv/v1/snapshot`、`/tv/v1/opencode`、`/tv/v1/health`；ETag/304；OpenCode 约 5s 一轮。网关**不**向电视推送。 |
| 谁提供数据 | 当前配对机（Mac mini `192.168.3.7:8490`）本机 todos / 本机 `~/.local/share/opencode/opencode.db`。 |
| 管理台前端 | **未**为 OpenCode 战况墙/指挥台改 UI；仅有 cannwork 凭证路径里的 opencode 文件占位。 |
| Mac↔Mac sync | 8491 同步 todos/config/stats；`gateway.tv` 是**本机角色键**，永不同步。 |
| 多源切换 | **无**。换 MacBook = 电视改配对到另一台的 8490（且那台须 `gateway.tv.enabled`）。 |

用户体感「不断推新状态」= 电视持续轮询已配对的那一台；不是网关主动 push。

## 目标

1. 多数时候：客厅只跟 **Mac mini**（常开 LAN）。
2. 有时：信号改跟 **MacBook** 上正在跑的 OpenCode。
3. 有时：MacBook **不要**喂电视（合盖出差），但 mini 待办/工作台仍可显示。
4. 少改配对、少改威胁模型（仍白名单 + 每电视 token + 私网）。

## 推荐：枢纽汇聚（B）——改动面最小且符合现网拓扑

**原则**：电视永远只配对 **一台枢纽**（Mac mini:8490）。哪台 Mac 的 OpenCode「上墙」由枢纽决定；MacBook 通过已有 sync 通道**可选投稿**，默认可关。

```
MacBook OpenCode.db ──(可选 publish)──► mini sync/hub ──► mini /tv/v1/opencode
本机 OpenCode.db    ─────────────────► mini 现读 ──────┘
电视 ──────────────────────────────────► 只认 mini:8490
```

### 最小改动步骤

1. **枢纽（mini）**  
   - `providers.json` 增加例如 `gateway.tv.opencodeSource`: `local` | `spoke:<deviceId>` | `auto`。  
   - `auto`：若最近 N 秒内收到 spoke 投稿且 `status=running` 则用 spoke，否则本机。  
   - `/tv/v1/opencode` 读「选定源」的缓存帧（仍 ETag）；本机路径保持现有 `tv-opencode.mjs`。

2. **Spoke（MacBook）**  
   - syncClient 增可选 `publishOpenCode: false`（默认 false = **不投稿**，满足「有时不需要」）。  
   - true 时周期性把本机 `opencodeSnapshotNow()` 小型 JSON POST 到枢纽新路由，例如 `PUT /sync/v1/opencode`（同 sync token；体积极限与 TV 契约一致 ≤6KB）。  
   - 合盖/关机即停投；枢纽超时回落到 `local`。

3. **电视（aerial-tv）**  
   - **不改配对模型**（仍单 base_url）。  
   - 可选：指挥台状态行显示 `source: mini|macbook`（网关在 opencode JSON 加 `source`/`host` 字段）。

4. **管理台前端（可后做）**  
   - 首屏或设置卡：「电视 OpenCode 源」三选一 + spoke 投稿开关只读状态；**非**战况墙重做。

### 不推荐作为第一步：电视端多配对（A）

电视存 mini/MacBook 两套 `base_url`+token 并 UI 切换：能用，但手机页/配对/断网态都要加倍，且 MacBook 不在家 LAN 时切过去必离线。适合以后做「高级」，不如 B 贴合「mini 常开」。

### 「停推」语义（对用户话术）

- 技术上无 push；「停」= spoke `publishOpenCode=false`，或枢纽源锁 `local`，或电视关 OpenCode 屏保/指挥台。  
- 关 mini 的 `gateway.tv.enabled` 会让**整台电视工作台**离线，不要当「只停 MacBook」。

## 前端是否要为本次联调补？

- **功能联调**：不依赖管理台前端；电视 + `/tv/v1/*` 已闭环。  
- **体验完整**：建议补轻量「源/投稿状态」卡；战况墙 UI 留在电视，避免管理台再画一套大屏。

## 相关提交 / 路径

- 网关：`e03dea2` `lib/tv-opencode.mjs` + `lib/tv-server.mjs`；`a41eb0a` README 路由。  
- 电视：`Workbench` / `OpenCode` 共用配对；`POLL_MS = 5000`。  
- Sync 角色键：`lib/sync-config.mjs` → `SYNC_ROLE_GATEWAY_KEYS = sync, syncClient, tv`。
