# 首屏（#home）：待办简览 + 订阅额度卡片 · 设计文档

日期：2026-10-31
状态：用户已确认布局 B1、金额口径与失败降级策略，待批准后写实施计划。

## 一、要解决的问题

现有「总览」（`#overview`）是排查视角：凭证体检、模型目录、显示器切源。每天打开要看的是
「今天还有什么活、我的订阅还剩多少」，这两件事散在待办页和各家的官网后台里，看一眼要走三处。

## 二、目标 / 非目标

**目标**
1. 一个新视图 `#home`，默认落地，一眼看完：待办简述 + 各订阅用量。
2. 订阅卡片**不硬编码任何一家**：coding plan 增删只改 `providers.json`，代码不动。
3. 额度和花费并列显示，但两者的口径差异要诚实标注，不能让人误读。

**非目标**
- 不做额度用尽的自动告警/通知（未来可加，本期不做）。
- 不替代「总览」：`#overview` 原样保留，仍是排查页。
- 不查月额度：Kimi 与智谱的额度接口只暴露 5 小时与周两档（见 §五），不伪造第三档。

**反目标**
- 不把「上次成功值」伪装成当前值（必须带相对时间，超时降级）。
- 不在前端拼凭证：额度查询必须走后端。

## 三、布局（B1，已选定）

```
┌──────────────────────────────────────────────────────────┐
│  2026 · 10 · 31 星期五                                    │
│  还有 5 件事                                              │
│                                                           │
│  ● 黄区 kblas int8 问题单处理          42m   │ CANNWork   │
│  ● 网关流式翻译补 StringDecoder         8m   │  $12.84    │
│  ○ 写本周汇报                        待办   │  本月·今日…│
│  ○ 周末把显示器线理一下              不急   │ ─────────  │
│  ✓ 梳理订阅计费口径                  完成   │ Kimi       │
│                                              │  $3.21  ⭕⭕│
└──────────────────────────────────────────────────────────┘
```

- **标题数「所有未完成」**（`in_progress` + `pending`），不是「今天动过的」。措辞是
  「还有 N 件事」——不说「今天」，因为积压几天的待办也在里面，说「今天」是假的。
- 左栏（约 60%）：待办，按 进行中 → 待办 → 完成 分组，最多各若干条（超出给「还有 N 条」）。
  完成组只列**今天完成的**（昨天及更早的不占首屏空间）。
- 右栏（约 40%，有左细线分隔）：一张订阅卡一个，纵向排列。
- 视觉沿用现有主题令牌，不引入新配色；大标题用 `--serif`，数字用 `--mono`。

## 四、数据形状

### 4.1 新增端点 `GET /admin/home`（仅回环 Host）

一次返回整页数据，避免前端发三个请求：

```jsonc
{
  "todos": {
    "counts": { "in_progress": 2, "pending": 3, "open": 5 },   // open = in_progress + pending，标题就用它
    "items": [ { "id","title","status","urgency","project","runningMs" } ],  // 最多 ~12 条
  },
  "providers": [
    {
      "id": "zcode", "name": "GLM Coding Plan",
      // 等效费用，**两台机器合计**（走 statsSnapshot 的 sync 视图，与「统计」页同口径）
      "spend": { "today": 0.42, "month": 7.40 },
      "quota": {
        "state": "ok" | "stale" | "error" | "none",
        "at": 1793432073000,          // 上次成功查询时刻（state=stale 时前端据此显示「N 分钟前」）
        "error": "…",                 // state=error 时的原因
        "tiers": [ { "name": "five_hour" | "weekly_limit", "remainingPct": 62, "resetsAt": "…" } ]
      }
    }
  ],
  "generatedAt": 1793432073000
}
```

**为什么合并成一个端点**：首屏要发的三个请求（待办/统计/额度）里，额度的缓存与降级逻辑是
服务端唯一的，前端只要一份快照；分开拿会让「stale 的时间戳」和「花费的时点」对不上。

### 4.2 额度查询（`lib/quota.mjs`，新模块）

按 `provider.baseUrl` 认家数。**判据按主机名认，不按路径**——路径在同一家的不同套餐下会变：

| 判据 | 家数 | 额度地址（固定 origin，不拼 baseUrl） |
|---|---|---|
| host 是 `api.kimi.com` / `api.kimi.ai` | Kimi | `https://api.kimi.com/coding/v1/usages` |
| host 含 `bigmodel.cn` | 智谱（国内） | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` |
| host 是 `api.z.ai` | 智谱（国际） | `https://api.z.ai/api/monitor/usage/quota/limit` |
| `provider.quota.kind` 显式指定 | `kimi` / `zhipu` / `none` | 覆盖自动识别 |
| 其余 | 不查额度 | 卡片只显示花费 |

**额度地址不拼 baseUrl**，理由（已实测）：

- `https://api.kimi.com/coding/usages` → **404**（少 `/v1`）
- `https://api.kimi.com/coding/v1/usages` → **401** ← 真地址
- `https://api.kimi.com/anthropic/usages` → **404**（模板里写的 baseUrl 是这条，已过时）

拼 baseUrl 还要处理「base 以 /v1 结尾就别再拼 /v1」这类分支，而 origin 是稳定的——智谱的
额度接口甚至和对话接口不同源（对话在 `/api/anthropic`，额度在 `/api/monitor`）。
所以：**按 host 认出家数 → 用该家固定的额度 URL**，不猜路径。

**接口与真实形状**（读 cc-switch `services/coding_plan.rs` 及其测试夹具确认）：

- Kimi：`Authorization: Bearer <key>`
  - 5 小时：`limits[].detail.{limit, remaining, resetTime}`（**字符串数字**，需 parse）
  - 周：`usage.{limit, remaining, resetTime}`
  - 只有这两档，无月档
- 智谱：`Authorization: <key>`（**不带 Bearer**，cc-switch 实测）
  - `data.limits[]` 里 `type == "TOKENS_LIMIT"`（大小写不敏感），按 `unit` 分窗口：
    `3` → 5 小时，`6` → 周
  - `unit` 缺失时兜底：**无 `nextResetTime` 的归 5 小时**，其余按 reset 升序填剩余槽位
  - 老套餐只回 1 条 → 自然降级为只有 5 小时档
  - 按量账户查套餐时回 HTTP 200 + `{success:false, msg:"…coding plan…"}` → 归 `error`，
    不当成「额度用尽」

> ⚠️ **`percentage` 是「已用百分比」，不是剩余。** 契约字段是 `remainingPct`，适配器必须
> 做 `100 - percentage`。弄反的话环会在额度耗尽时显示满格——这是最难被发现的错，必须单测。

**凭证**：复用 `lib/auth/static.mjs` 的 token 解析（需导出 `resolveToken`）。假设 Kimi 的
额度接口与对话接口用**同一枚订阅 key**（cc-switch 的 OAuth 与 API key 两条路都这么用）；
若实际不通，卡上会显示查询失败，不影响花费数字。

**配置**：`provider.quota` 需要加进 `lib/config.mjs` 的 `normalizeProvider` 白名单
（目前会丢弃未知键），否则手写 `quota.kind` 静默失效。注意它随后会随
`extractShareableConfig` 参与 Mac↔Mac 同步——可接受（同一家订阅在两台机器上是同一种类）。

**缓存与降级（第三种策略）**：
- 成功结果缓存 **60 秒**，同 `lib/monitors.mjs` 的 in-flight 去重模式（并发请求只打一次上游）。
- 失败时**不清空**上次成功值：返回 `state:"stale"` + 上次 `at`。
- 超过 **15 分钟**没成功过 → `state:"error"` + 原因，环留空。
- 前端：`stale` 时环照画、旁边标灰色「3 分钟前」；`error` 时不画环，显示「查询失败 · <原因>」。

## 五、为什么没有月额度

Kimi `/usages` 只给 `usage`（周）与 `limits`（5 小时）；智谱 `limits[]` 只有 `unit:3`/`unit:6`。
两家都不提供月档，cc-switch 也未实现。**按用户决定：查不了就不显示，不伪造。**

## 六、金额口径（关键）

Kimi / 智谱的额度接口**不返回美元金额**（cc-switch 里 `used_value_usd` 对这两家恒为 `None`）。
金额一律来自网关记账：`days[].providers[pid].models[*].cost` 求和，与「统计」页同一张单价表。

**口径选「两台合计」**（用户已定）：直接走 `statsSnapshot()`——它在有 `stats-sync.json` 时
返回跨设备求和，与「统计」页完全一致，不会出现首屏和统计页两个数字的情况。

**已知失真**：只有经过本网关的流量才计入，且「合计」只覆盖开了 sync 的两台。按当前接入现状，
Claude Code 直连 GLM（`open.bigmodel.cn`），那部分花费在卡上不出现，但额度百分比（官方接口）
是真实的。两者并列会读作矛盾，所以：

> 金额标签固定写「本月等效」；当某家的**已用额度 > 20% 且本月等效花费 < $0.5** 时，
> 金额下额外显示一行小字「记账未含直连流量」。

> ⚠️ **「本月」其实是近 30 天**：`lib/stats.mjs:233` 的落盘只保留最近 30 天，31 天月份的
> 1 号会被裁掉。首屏沿用这个窗口（与统计页一致），但标签用「近 30 天」更诚实。

**旧的「本机记账」说法作废**：这台机器是 spoke（`deviceId: "macbook"`），说「本机」会让
用户在 MacBook 上看到 hub 的消费却以为是自己的。

只在数字明显对不上时出现那行小字，不做常驻免责声明。

## 七、coding plan 增减怎么办

- 新增一家：在 `providers.json` 加 provider。baseUrl 命中识别表 → 卡片自动出现带环；
  没命中 → 卡片只有金额。要环就加一条映射（或写 `quota.kind`）。
- 删一家：删 provider 即可，前端不维护列表。
- 同一家有多个订阅（如两个 Kimi 号）：各自一个 provider，各自一张卡，互不影响。

## 八、改动面

| 文件 | 改动 |
|---|---|
| `lib/quota.mjs` | 新建：识别、查询、缓存、降级 |
| `lib/auth/static.mjs` | 导出 `resolveToken`（现在是模块内私有） |
| `lib/stats.mjs` | 新增 `providerSpend()`：从 `statsSnapshot()` 的**已合并视图**取 pid 的今日/近 30 天花费。不再单独实现一遍求和，避免与统计页口径漂移 |
| `lib/home.mjs` | 新建：组装 `/admin/home` 的响应（待办裁剪 + 花费 + 额度） |
| `server.mjs` | 新增 `GET /admin/home` 路由（`isLocalHost` 回环校验 —— 注意 `/admin/stats` 其实**没有**这道校验，别照抄它） |
| `index.html` | 新增 `#home` 视图 + 左栏第一项；视图常量、数字键、默认落地 |
| `theme.css` | 首屏卡片样式（局部，不影响其他视图） |
| `test/home-unit.mjs` | 额度解析（两家真实形状 + 老套餐 + 失败降级）、花费聚合 |
| `test/smoke.mjs` | `/admin/home` 端到端（mock 上游返回两种额度形状） |

## 九、视图接入（用户已定：`#home` 作为落地页）

**`#home` 是新视图，放在工作台分组第一位，并成为冷启动默认落地。** 这会影响既有的
`gw-view` 记忆（`index.html` 的 `initView()`）：现在的顺序是
`hash → /workbench 强制 todos → localStorage('gw-view') → todos`。

落地规则改为：

```
hash（有效）→ /workbench 强制 todos → #home
```

即**不再读 `gw-view` 记忆**。理由是首屏的用途就是「打开就看」，记忆上次视图与它直接冲突。
`gw-view` 的写入可以保留（无副作用），但读取路径删除，并在注释里写明为什么。

配套：
- `VIEW_IDS` 加 `home`（放最前），`VIEW_GROUP.home = 'workbench'`。
- 数字键 1–6 的顺序按左栏从上到下 → 变成 1–7，`home` 是 1。快捷键提示文案同步。
- `#home` 无需旧别名兼容（新视图）。

## 十、留给实现者的判断

- 待办每组条数上限：进行中全部 + 待办前 8 条 + 完成前 3 条（**完成组只取今天完成的**），
  超出显示「还有 N 条」。
- 首屏刷新节奏：跟现有轮询一致，但额度走 60 秒缓存，前端 30 秒拉一次即可（不会真打上游）。
- `#home` 与 hashchange：与其它视图同一条 `viewForHash` 路径，无特殊处理。
