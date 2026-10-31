# 待办子项 + 详情 + 纳入时间段总结 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 待办支持 checklist 子项与可编辑详情，全部子项完成自动完成父待办，待办变动纳入时间段总结的生成与展示。

**Architecture:** 数据层全在 lib/todos.mjs（items 归一化 + 状态派生集中在每次变更后跑）；server.mjs 加嵌套子项路由（细粒度单操作 + 父 PATCH 整组替换并存）；报告侧只动 report-prompts.mjs（prompt 文案与 LIMITS）、collect.mjs（计数透传）、generate.mjs（materials.todos + 空素材快径收窄）；UI 在 workbench.html/css 做展开行。

**Tech Stack:** Node ≥18 内置模块（零依赖），端到端测试 test/smoke.mjs（mock 上游 + 隔离 env），中文注释/commit。

**Spec:** docs/superpowers/specs/2026-10-28-todo-subitems-design.md

## Global Constraints

- 工作目录 `~/Desktop/project/personal_workshop/.claude/worktrees/workbench`；**禁止碰 8484 / 正式配置 / 合 main / launchctl**；隔离实例用 6399。
- 零依赖；注释、文档、commit message 中文。
- 子项变更后派生规则（spec §三表格）逐条进 smoke；`completed_at` 原有值不重盖。
- agent（source ≠ 'user'）note ≤ 300 码位、子项标题 ≤ 200、每待办 ≤ 50 子项、父 note 2000、标题 500 不变。
- 动态文本一律 esc() 后入 HTML（XSS 防线）；报告 prompt 不进 note 长文。

## Review Focus

1. **并发覆盖**：agent 细粒度勾子项时不能覆盖网页对其他子项/字段的并发改动 → Task 1 测「单子项 PATCH 后其他子项原样」。
2. **旧数据升级**：todos.json 旧条目无 items 字段 → 读/列表/更新不炸，按无清单处理 → Task 1 测「旧条目 PATCH title 后 items 仍缺省且状态手动」。
3. **非法 items 形态**：items 非数组 / 成员缺 title / done 非布尔 → 400 且不落盘 → Task 1 校验矩阵。
4. **completed_at 不重盖**：全 done 后原样重发 items 数组 → completed_at 保持首盖值 → Task 1。
5. **仅待办窗口**：四源空但窗口内有待办变动 → 不再出「无记录」固定文案，走模型出稿（数据源失败照实附注）→ Task 3。

---

### Task 1: 数据层 + 子项路由（HTTP 级 TDD）

**Files:**
- Modify: `lib/todos.mjs`
- Modify: `server.mjs:329-367`（todos 路由块）与 404 兜底文案（:408）
- Test: `test/smoke.mjs`（待办 CRUD 节后插新块）

**Interfaces（后续任务依赖）:**
- `createTodo(input)` / `updateTodo(id, patch)` 接受可选 `input.items`（数组：`{title 必填≤200cp, done? 布尔, id? 留则保留}`），返回的 todo 含 `items: [{id,title,done,done_at}]`。
- 新导出：`createTodoItem(todoId, {title, done?}) → todo`、`updateTodoItem(todoId, itemId, {title?, done?}) → todo`、`deleteTodoItem(todoId, itemId) → void`；错误用 `httpError`（400 `invalid_todo` / 404 `not_found`）。
- 派生函数（模块内私有）`deriveFromItems(todo)`：spec §三表格；`note` 上限按 `todo.source !== 'user'` 取 300/2000。

- [ ] **Step 1: 写失败测试** —— smoke 新块：①POST 带 items（agent source + note 300 边界 201、301 → 400 且文案含 300）②逐子项勾完 → 父 pending→…→全 done 父自动 done+completed_at ③取消一个 → in_progress + completed_at null ④再勾回 → done 重盖新值 ⑤done 父加未勾子项 → in_progress；删该子项 → 回 done ⑥PATCH 整组替换（保留 id）⑦校验矩阵（空标题/超 200/超 50 条/items 非数组/成员缺 title/未知 todoId 404/未知 itemId 404/子资源 404）⑧user note 2000 OK ⑨旧条目（无 items 字段的存量）PATCH title 正常 ⑩单子项 PATCH 不动其他子项 ⑪全 done 后原样重发 items → completed_at 不变
- [ ] **Step 2: 跑 smoke 确认新断言失败**（404/400 类失败，旧断言仍绿）
- [ ] **Step 3: 实现 lib/todos.mjs**（normalizeItems + deriveFromItems + 三个 item 导出 + note 分级上限 + createTodo/updateTodo 接 items）
- [ ] **Step 4: 实现 server.mjs 路由**（parts 解析：`/v1/todos/:id/items` POST、`/v1/todos/:id/items/:itemId` PATCH/PUT/DELETE；未知子资源 404；404 兜底清单补 items 端点说明）
- [ ] **Step 5: 跑 smoke 全绿**（旧 351 项不回归）
- [ ] **Step 6: Commit** `feat: 待办子项 checklist 数据层与 API——…`

### Task 2: 工作台 UI（展开行 + 清单 + 详情）

**Files:**
- Modify: `workbench.html`（renderTodos 的 item()、事件委托、expandedIds 状态）
- Modify: `workbench.css`（如需共享令牌级样式）+ 页内 `<style>`（视图专属）
- Test: `test/smoke.mjs` 工作台源码断言块

**Interfaces:**
- Consumes: Task 1 的子项端点（`POST/PATCH/DELETE /v1/todos/:id/items(/:itemId)`，响应 `{ok, todo}` / 204）。
- Produces: 页面行为——收起行只显父标题（2 行 CSS 钳制）+ `子项 k/j` 徽标 + 展开/收起钮；展开区：checkbox 清单（点选即 PATCH 单子项）、添加子项输入、详情 note 查看/编辑（textarea + PATCH note）、子项删除 ✕。

- [ ] **Step 1: 写失败源码断言**（workbench.html 含 expandedIds/data-expand/添加子项/详情编辑函数名、CSS line-clamp；agent 短写提示文案）
- [ ] **Step 2: 跑 smoke 确认失败**
- [ ] **Step 3: 实现 UI**（展开态 Set；全部动态文本 esc()；勾选/添加/删除走 apiFetch + refreshTodos；编辑详情复用 saveTodoEdit 的 PATCH 路径）
- [ ] **Step 4: 6399 隔离实例手测**（curl 建待办+子项 → 抓 /workbench HTML 确认渲染数据与脚本无语法错；CGP env 全隔离，结束杀进程）
- [ ] **Step 5: 跑 smoke 全绿；Commit**

### Task 3: 报告纳入（prompt + 素材计数 + 快径收窄 + UI 展示）

**Files:**
- Modify: `lib/report-prompts.mjs`（LIMITS.todoTitleChars=40 / todosPerList=30；userFinal 待办行带（k/j）进度与截断）
- Modify: `lib/report/collect.mjs`（无结构变化，仅确认透传 items）
- Modify: `lib/report/generate.mjs`（materials.todos 计数；空素材快径条件加「窗口内无待办变动」）
- Modify: `workbench.html`（rMaterials 行追加 `待办 新增 n / 完成 m`）
- Test: `test/smoke.mjs` 报告生成节

- [ ] **Step 1: 写失败测试**（①collect fixture 加「带 2 子项完成 1」的待办 → 报告正文含 `（1/2）` ②materials.todos.created/completed 计数 ③四源全失败 + 窗口内仅待办 → done 且 model ≠ none、正文含待办标题与「数据源状态」④四源正常且无待办的未来窗口仍走「无记录」快径（既有断言不回归）⑤超 30 条列表截断「等 N 条」——数据层面单元级调用 userFinal 直测，不起 30 个 HTTP）
- [ ] **Step 2: 跑 smoke 确认失败**
- [ ] **Step 3: 实现**（userFinal 改造；runJob 快径条件 `&& !m.todos.created.length && !m.todos.completed.length`；两处 report materials 加 todos；UI rMaterials 拼接）
- [ ] **Step 4: 跑 smoke 全绿；Commit**

### Task 4: 文档同步（README / CLAUDE.md / agent 短写指南）

**Files:**
- Modify: `README.md`（/v1/todos 节：子项端点、自动完成规则表、agent 写作约定：标题一行可扫范例、note ≤300、一次性建单示例）
- Modify: `CLAUDE.md`（模块图 todos.mjs 行、路由表 /v1/todos 行、工作台页描述）

- [ ] **Step 1: 更新两文档**（与 spec §三规则表一字不差地引用）
- [ ] **Step 2: rg 自检无过时断言**（`rg -n "todos" README.md CLAUDE.md` 核对口径）
- [ ] **Step 3: Commit**

### Task 5: 双时区回归 + 收尾

- [ ] **Step 1: `TZ=Asia/Shanghai node test/smoke.mjs` ×2 全绿**
- [ ] **Step 2: `TZ=America/Los_Angeles node test/smoke.mjs` ×2 全绿**
- [ ] **Step 3: `git status` 工作树干净（todos.json/vk-cache.json 等运行时产物不新增、不入库）；汇报后停**
