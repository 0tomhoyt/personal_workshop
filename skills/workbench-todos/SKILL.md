---
name: workbench-todos
description: 往用户个人工作台的待办清单里添加、更新、勾选或查询事项（本机网关 /v1/todos）。当用户说"记一下/加个待办/帮我建个任务/这件事记到待办里/我还有什么没做/把这条标成完成"，或 agent 完成了一段工作、发现遗留事项、想留个后续给用户时使用。也用于子项清单（checklist）的勾选与追加。
---

# 工作台待办

用户的个人工作台把待办集中在一处（网页左栏「工作台 → 待办」，`http://127.0.0.1:8484/#todos`），
人和 agent 共用同一份数据。**你用这个 skill 写进去的内容，用户打开页面就能看到**——所以它是
跨 agent 的交接手段：你干完活留个尾巴，用户下次打开工作台就知道该收什么。

## 先取 token（每次调用前，别缓存到文件里）

`/v1/todos` 要 Bearer 鉴权。token 从回环端点现取，**不要往仓库、脚本、记忆里写死**：

```bash
BASE=$(curl -s http://127.0.0.1:8484/admin/config | jq -r '"http://127.0.0.1:" + (.port|tostring)')
TOKEN=$(curl -s "$BASE/admin/config" | jq -r .clientToken)
```

`/admin/config` 只接受回环 Host，`clientToken` 为空表示该网关没开客户端鉴权（此时不带
Authorization 也能调）。端口不一定是 8484，所以先问一次 config，别假设。

## 加一条待办（最常用）

```bash
curl -s -X POST "$BASE/v1/todos" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -nc --arg t '补齐 kblas 920F 的 int8 分支回归' \
             --arg p 'kblas' --arg u urgent --arg s claude-code \
             --arg n '920F 分支只跑了 fp16，int8 路径没有测试覆盖' \
        '{title:$t, project:$p, urgency:$u, source:$s, note:$n}')"
```

字段（除 `title` 全可省）：

| 字段 | 取值 | 说明 |
|---|---|---|
| `title` | 字符串，≤500 字 | **必填**，一行能扫完的事；别把整段背景塞进来 |
| `urgency` | `urgent` / `normal` / `someday` | 缺省 `normal`；`urgent` 在列表里排最前 |
| `project` | ≤60 字 | 项目/标签名，用于分组归类 |
| `source` | ≤60 字 | 来源标识，用自己的名字（如 `claude-code`、`zcode`） |
| `note` | agent 来源 **≤300 字** | 详情/背景。**这是硬上限**，超了返回 400 |
| `items` | `[{title, done?}]` | 初始子项清单，≤50 条，每条标题 ≤200 字 |
| `spans` | `[{id?, start, end?}]` | 时段（epoch 毫秒，`end` 省略/null = 进行中）。**每段是一条日历事件**，见下 |

`spans` 是**给日历同步用的**：用户有个程序按段往日历里写事件。所以只有你**确实知道**
这段时间在干什么时才写（比如用户说「刚才一小时在弄 XX」）；不知道就别写——编出来的时段
会变成日历里的假事件。进行中的段传 `end: null`。

通常不需要你手动管 spans：用户点「开始/完成」时服务端会自己开闭段。需要精确写入时才用下面这些。

```bash
# 补一段（start/end 都是 epoch 毫秒；end 传 null = 还在进行）
curl -s -X POST "$BASE/v1/todos/$ID/spans" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"start":1793200000000,"end":1793203600000}'

# 改一段（只传要改的字段；end:null 表示改回进行中）
curl -s -X PATCH "$BASE/v1/todos/$ID/spans/$SPAN_ID" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"end":1793207200000}'

# 删一段
curl -s -X DELETE "$BASE/v1/todos/$ID/spans/$SPAN_ID" -H "Authorization: Bearer $TOKEN"

# 开一段 / 闭所有未闭合段（两个都不改 status）
curl -s -X POST "$BASE/v1/todos/$ID/spans/open"  -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$BASE/v1/todos/$ID/spans/close" -H "Authorization: Bearer $TOKEN"
```

**`open`/`close` 不改 `status`——「暂停」不等于「完成」。** 用户干一半去开会，该
`close` 那段，但状态仍应留在 `in_progress`。反过来，想标完成就直接 `PATCH {"status":"done"}`，
服务端会自动闭段（`PATCH {"status":"in_progress"}` 会自动开一段），不必再单独调 open/close。

一次要写多个段、或要保住段 `id`（日历事件拿它做幂等键）时，用整组替换：
`PATCH /v1/todos/:id` 带 `{"spans":[{id?,start,end},...]}`——带 `id` 的段原样保留锚点，
不带的新派。**显式传了 spans 就不会自动开闭段**，时间线完全以你给的为准。

**`note` 的 300 字上限按 `source` 分级**：`source` 为空或 `user` 时上限是 2000，其他来源是
300。想写长背景时不要改 `source` 骗额度——精简，或者把细节放在你自己的输出里，待办只留结论。

`note` 是**用户给自己看的备忘**（上下文、待核对的事），但生成时间段汇报时它会被交给模型
过滤改写：能对上级讲的进展提炼出来，私人提醒略去。所以写 note 时**别写入不该出现在给上级
汇报里的内容**，也别指望它被原样引用。

新建的待办**状态恒为 `pending`**，`POST` 带 `status` 会被忽略。要直接置为进行中，创建后
再 PATCH 一次。

## 常用操作

```bash
# 查全部（或按状态过滤：pending / in_progress / done）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/todos?status=pending"

# 改字段 / 改状态（PATCH 与 PUT 同义，只动传了的字段）
curl -s -X PATCH "$BASE/v1/todos/$ID" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"status":"in_progress"}'

# 勾子项（写响应带整只父待办，子项全 done 时父自动转 done）
curl -s -X PATCH "$BASE/v1/todos/$ID/items/$ITEM_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"done":true}'

# 追加子项
curl -s -X POST "$BASE/v1/todos/$ID/items" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"跑一遍 int8 回归"}'
```

状态只有 `pending`（待办）/ `in_progress`（进行中）/ `done`（完成）三种。

## 规则

- **一条待办一件事。** 需要多个步骤才能完成时，一条父待办 + `items` 子项清单，
  不要把五件事压进一个 title。
- **先查再写。** 加之前拉一次列表看有没有同一条——用户桌面上的待办是唯一真相，
  重复条目会让他手动删。
- **只在用户要你做、或你确实留下了后续事项时写。** 不要为了"显得有用"批量灌待办；
  这个列表是用户每天扫的，噪声的成本由他承担。
- **改已有待办前先确认是哪一条。** 列表里的 `id` 是 12 位十六进制，标题可能相似
  （比如同一个项目下的好几条）——拿不准就把候选列给用户选，别猜。
- 这是用户的本机服务，只绑 127.0.0.1。不要把它暴露到外部网络，也不要转发 token。

## 出错时

400 通常是字段问题（title 缺失、枚举值不对、note 超限），错误信息里写了具体原因，照着改；
404 说明 `id` 不存在（可能已被删除）；401 说明 token 取错或网关重装换了 token——重新取一次。
