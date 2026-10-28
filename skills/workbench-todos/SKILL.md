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

**`source` 必须填你自己的名字，不要留空、不要写 `user`。** 留空会算成用户手动建的；
写了 `user` 会让用户以为是自己记的。来源徽标在网页上就是靠这个字段区分的。

**`note` 的 300 字上限按 `source` 分级**：`source` 为空或 `user` 时上限是 2000，其他来源是
300。想写长背景时不要改 `source` 骗额度——精简，或者把细节放在你自己的输出里，待办只留结论。

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
