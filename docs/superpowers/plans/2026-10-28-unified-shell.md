# 统一外壳实现计划（管理台与工作台合一）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `admin.html` 与 `workbench.html` 合并成一个页面（`index.html`），左栏改为「工作台 / 管理台」两级导航，并修掉左栏中文逐字竖排。

**Architecture:** 单页 + 单段内联脚本（设计文档方案 A）。服务端只增加/复用一个静态路由：`/`、`/admin`、`/workbench` 都返回 `index.html`，样式由 `/theme.css` 提供（`/workbench.css` 继续提供同一份）。六个视图挂在 `data-view` 上，由 `#hash` 深链驱动；左栏是两组可折叠分组，全部用真链接，不写 JS 导航。

**Tech Stack:** Node ≥ 18 内置模块 + 原生 HTML/CSS/JS。零依赖、无构建、无 lint。测试是 `node test/smoke.mjs`（起 mock 上游 + 网关实例，自带 `check()` 断言收集器）。

**Spec:** `docs/superpowers/specs/2026-10-28-unified-shell-design.md`

## Global Constraints

- **零依赖**：不新增 `package.json`、不加外部 CDN、字体、图标库。字体栈维持 `--sans / --serif / --mono` 现有定义。
- **零内容注入**：不触及任何请求/响应内容路径；本计划只动页面层。
- **不改服务端能力**：`/v1/*`、`/admin/*` 的处理逻辑、统计口径、报告管线、待办数据层一律不动。`server.mjs` 只改静态页路由与 404 文案。
- **中文**：注释、文档、commit message 全部中文，与现有风格一致。
- **左栏布局契约（§5.3 原文）**：左栏内不放横向并排的多个文字控件；每个左栏行单行，`min-width:0` + `white-space:nowrap` + `overflow:hidden` + `text-overflow:ellipsis`；禁用 `word-break: break-all`；不靠缩字号解决拥挤。
- **严格模式**：合并后的脚本以 `'use strict'` 开头。
- **安全边界**：页面侧 `esc()` 取工作台版（转 `& < > "`）；`/admin/*` 回环限制与 `application/json` 要求不动。
- **测试基线**：改动前 `node test/smoke.mjs` 为 408 通过 / 0 失败。每个任务结束时必须全绿，且总数只增不减（改写的断言不计入减少）。
- **断言不得自相矛盾**：`test/smoke.mjs` 的 `check()` 是纯字符串/正则匹配。同一事实若已有一条旧断言按旧实现写死，新断言必须**改写那一条**，不能并列新增——否则两条断言互相打架、永远无法同时通过。每个任务收尾都要跑一遍全量，逐条看有没有这种对撞。

## Review Focus

按「最可能咬到使用者」排序。每条都在下面某个任务的步骤里有对应断言：

1. **超长自定义名字被截断后还能不能认出来**——显示器名/输入源名由用户自填（可能很长），左栏与按钮里被省略号截断时必须保留 `title` 全文，否则用户看不出是哪台。→ Task 3（按钮 `title`）与 Task 4（左栏单行契约）。
2. **窄屏（≤900px）顶栏的折叠组**——分组展开后顶栏高度变化、当前项是否仍在视野内、是否出现横向溢出。→ Task 4。
3. **深链与回访记忆的冲突**——`/workbench` 旧书签必须落「待办」，不能被 `gw-view` 记忆带到统计页。→ Task 4。
4. **离开统计视图再回来的数字新鲜度**——按视图轮询后，切回统计页必须立刻拉一次，不能把几十分钟前的旧值当成当前值展示。→ Task 5。
5. **合并后同名标识符 / 严格模式导致的静默错误**——`esc` 转义范围、`editingId` 串台（改待办标题却改到供应商）。→ Task 2。

---

## Task 1: 文件改名与路由（页面仍是两页）

纯机械改名，行为零变化。做完这一任务，`/` 与 `/workbench` 都还能正常打开，只是文件名对得上内容了。

**Files:**
- Rename: `admin.html` → `index.html`（`git mv`）
- Rename: `workbench.css` → `theme.css`（`git mv`）
- Modify: `server.mjs:60-62`（三个路径常量）、`server.mjs:111-139`（静态路由块）、`server.mjs:444`（404 文案）
- Modify: `install.sh:71-74`（拷贝清单 + 清理旧文件）
- Test: `test/smoke.mjs`（`工作台静态资源` 小节、`861-862` 行、`1779` 行附近）

**Interfaces:**
- Produces: 服务端常量 `INDEX_HTML`（指向 `index.html`）、`THEME_CSS`（指向 `theme.css`）；HTTP 路由 `/theme.css`。后续任务都基于这两个名字。

- [ ] **Step 1: 写失败断言**

在 `test/smoke.mjs` 的 `工作台静态资源` 小节开头（`const css = await fetch(...)` 之前）插入：

```js
const themeCss = await fetch(`${GW}/theme.css`);
const themeCssText = await themeCss.text();   // Task 4 还要用，保留这个变量名
check('/theme.css → 200 且 text/css', themeCss.status === 200 && (themeCss.headers.get('content-type') || '').includes('text/css'));
const idxHtml = await (await fetch(`${GW}/`)).text();
check('index.html 引用 /theme.css', idxHtml.includes('<link rel="stylesheet" href="/theme.css">'), '未找到 link 标签');
```

并把同小节里 `const adminHtml = await (await fetch(`${GW}/`)).text();` 一行改为复用 `idxHtml`（删除该赋值，把后续 `adminHtml` 全部替换为 `idxHtml`）。

- [ ] **Step 2: 运行确认失败**

Run: `node test/smoke.mjs 2>&1 | grep -E 'theme.css|失败'`
Expected: 两条新增断言失败（`/theme.css` 非 200；`index.html` 未引用 `/theme.css`），末尾失败数 ≥ 2。

- [ ] **Step 3: 改名并同步路径**

```bash
git mv admin.html index.html
git mv workbench.css theme.css
grep -rn 'admin\.html\|workbench\.css' --include='*.mjs' --include='*.sh' --include='*.md' --include='*.command' .
```

`server.mjs` 改动（保留 `WORKBENCH_HTML`，它到 Task 2 才删除）：

```js
const INDEX_HTML = path.join(SCRIPT_DIR, 'index.html');
const WORKBENCH_HTML = path.join(SCRIPT_DIR, 'workbench.html');
const THEME_CSS = path.join(SCRIPT_DIR, 'theme.css');
```

路由块改为：`/` 与 `/admin` 读 `INDEX_HTML`（404 文案改成 `index.html 缺失：重跑 ./install.sh 安装`）；新增 `/theme.css` 读 `THEME_CSS`；`/workbench.css` 继续读 `THEME_CSS`，并在注释里写明「旧缓存页面的兼容入口，与 /theme.css 同一份」。`index.html` 里 `<link rel="stylesheet" href="/workbench.css">` 改成 `/theme.css`。

`install.sh` 拷贝段改成：

```bash
cp "$PROJECT_DIR/server.mjs" "$RUNTIME_DIR/server.mjs"
[ -f "$PROJECT_DIR/index.html" ] && cp "$PROJECT_DIR/index.html" "$RUNTIME_DIR/index.html"
[ -f "$PROJECT_DIR/workbench.html" ] && cp "$PROJECT_DIR/workbench.html" "$RUNTIME_DIR/workbench.html"
[ -f "$PROJECT_DIR/theme.css" ] && cp "$PROJECT_DIR/theme.css" "$RUNTIME_DIR/theme.css"
# 改名前的旧副本：升级后残留在运行时目录里会让人误以为还有效，一律清掉
rm -f "$RUNTIME_DIR/admin.html" "$RUNTIME_DIR/workbench.css"
```

（`workbench.html` 的拷贝在 Task 2 删除。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/smoke.mjs 2>&1 | tail -3`
Expected: `结果: 410 通过, 0 失败`（基线 408 + 新增 2）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor: admin.html → index.html、workbench.css → theme.css（名实对齐，路由与安装清单同步）"
```

---

## Task 2: 合并成一个页面

把工作台的两个 `.sec` 变成 `.view`，两段脚本合并为一段并逐个归并重名标识符。做完这一任务，页面在**行为上与改之前完全等价**（左栏还是六个扁平项），只是不再有第二个 HTML 文件。

**Files:**
- Modify: `index.html`（左栏导航、`<main>` 内视图结构、脚本合并）
- Delete: `workbench.html`（`git rm`）
- Modify: `server.mjs:60-...`（删 `WORKBENCH_HTML` 常量与 `/workbench` 的独立读取分支，改为读 `INDEX_HTML`）
- Modify: `install.sh`（删 `workbench.html` 那行拷贝，改成 `rm -f "$RUNTIME_DIR/workbench.html"`）
- Test: `test/smoke.mjs`（HTTP 小节 + 两处 `readFileSync` 直接读文件的断言，后者见 Step 5）

**Interfaces:**
- Consumes: Task 1 的 `INDEX_HTML` / `THEME_CSS`。
- Produces: 六个视图 `data-view` 取值 —— `todos`、`report`、`overview`、`traffic`、`test`、`providers`；顶层函数 `setView(v, {push})`、`esc(s)`、`apiFetch(url, opt)`、`loadToken()`、`safe(fn)`、`showErr(msg)`、`setOnline(ok)`；变量 `provEditingId`、`todoEditingId`。

- [ ] **Step 1: 写失败断言**

**先做机械替换再改语义**。这里有个省事的杠杆：合并后 `/workbench` 返回的就是 `index.html`，
所以 `const wbText = await (await fetch(`${GW}/workbench`)).text()` **一行都不用改**——那三十多条
`wbText.includes(...)` 断言会自动变成在测合并后的单页，正是我们要的。**不要**把 `wbText` 别名成
`idxHtml`，否则「同一份字节」那条断言会退化成 `idxHtml === idxHtml` 永真。

要做的替换只有三处：

1. 删掉 `const adminHtml = await (await fetch(`${GW}/`)).text();`，同小节内所有 `adminHtml` → `idxHtml`。
2. `test/smoke.mjs:861` 的 `wbh` 改读 `index.html`；`:862` 的 `wbc` 改读 `theme.css`。
3. `:1782` 的 `wbText2` 改读 `index.html`（内容改动见 Step 5）。
4. 跑 `grep -n 'workbench\.html\|workbench\.css\|admin\.html\|adminHtml\|\bwbh\b\|\bwbc\b' test/smoke.mjs`，除 `workbench:` 配置节与 `/workbench` 路由相关外应无残留。

替换完再改写下面这些**语义已变**的断言（不是删除）：

```js
check('/workbench 与 / 返回同一份字节', (await (await fetch(`${GW}/workbench`)).text()) === idxHtml);
check('单页含六个视图', ['todos', 'report', 'overview', 'traffic', 'test', 'providers']
  .every((v) => idxHtml.includes(`data-view="${v}"`)), '缺视图');
check('脚本以严格模式开头', /<script>\s*\n'use strict';/.test(idxHtml), '顶层脚本未开严格模式');
check('标识符已归并：无裸 editingId', !/\beditingId\b/.test(idxHtml) && idxHtml.includes('provEditingId') && idxHtml.includes('todoEditingId'));
check('esc() 转义 & < > " 四类（取工作台版）', idxHtml.includes(".replace(/>/g, '&gt;')") && idxHtml.includes('.replace(/"/g, \'&quot;\')'));
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/smoke.mjs 2>&1 | grep -E '同一份字节|六个视图|严格模式|标识符|esc'`
Expected: 五条全部失败。

- [ ] **Step 3: 合并标记**

在 `index.html` 的 `<main>` 里，把原 `workbench.html` 的两个 `<section class="sec">` 改为：

```html
<!-- 01 待办 -->
<section class="view" data-view="todos"> …原待办 section 的全部子节点（含 sec/sechead/card）… </section>
<!-- 02 汇报 -->
<section class="view" data-view="report" tabindex="-1"> …原汇报 section… </section>
```

`data-view="todos"` 排在最前并带 `active`。删掉原 `<div class="foot">PERSONAL WORKBENCH …</div>`，管理台那份 `<div class="foot">` 保留在 `test` 视图（本任务不改页码结构）。

左栏导航临时改成六项扁平按钮（Task 4 才分组）：

```html
<button class="viewbtn active" data-view="todos"><span class="vname">待办</span></button>
<button class="viewbtn" data-view="report"><span class="vname">汇报</span></button>
<button class="viewbtn" data-view="overview"><span class="vname">总览</span></button>
<button class="viewbtn" data-view="traffic"><span class="vname">统计</span></button>
<button class="viewbtn" data-view="test"><span class="vname">诊断</span></button>
<button class="viewbtn" data-view="providers"><span class="vname">配置</span></button>
```

`VIEW_IDS` 改为 `['todos', 'report', 'overview', 'traffic', 'test', 'providers']`；`VIEW_ALIASES` 改为 `{ latency: 'traffic', log: 'test', stats: 'traffic', workbench: 'todos' }`；空 hash 落到 `todos`。

- [ ] **Step 4: 合并脚本并归并重名标识符**

把 `workbench.html` 的 `<script>` 内容并入 `index.html` 的单段脚本（顶部加 `'use strict';`）。按下表逐个处理，**一项都不能省**：

| 冲突 | 处理 |
|---|---|
| `esc()` | 保留工作台版（转 `& < > "`），删掉管理台那份；管理台里手写的 `.replace(/"/g,'&quot;')` 随之删掉 |
| `apiFetch()` | 保留工作台语义（仅 `/v1/` 加 Bearer + 401 重取一次）；管理台所有调用目标都是 `/v1/*`，行为不变 |
| `loadToken()` | 保留一份 |
| `editingId` | 管理台那份改名 `provEditingId`，工作台那份改名 `todoEditingId`（含 `clearDoneTodos` 里对它的两处引用） |
| `applyTheme()` | 保留管理台版（无参 + 监听 `prefers-color-scheme` 变化），删掉工作台那份带参版本；工作台启动时的 `applyTheme(...)` 调用改成 `applyTheme()` |
| 在线状态 | 统一由 `render(h)` 决定 `dot`/`sState`；`setOnline(ok)` 保留为 `render` 内部的辅助，工作台 `refreshTodos` 的失败分支改调 `setOnline(false)` |
| 错误条 | 三个各司其职：`providerBanner`（凭证异常，常驻）、`errBanner`（操作失败，8s 自隐 + 点击关闭，取工作台版）、`stopBanner`（已停服） |
| `safe()` | 保留，全站 async 回调统一用它 |

改完自查：

```bash
grep -oE '^(function|const|let|var) [A-Za-z_$][A-Za-z0-9_$]*' index.html | sort | uniq -d
```

Expected: 无输出（无顶层重复声明）。有输出就逐个改掉。

- [ ] **Step 5: 删除 workbench.html 并同步服务端与安装脚本**

```bash
git rm workbench.html
```

`server.mjs`：删 `WORKBENCH_HTML` 常量与 `/workbench` 分支里的独立读取，`/workbench` 改读 `INDEX_HTML`（404 文案 `index.html 缺失：重跑 ./install.sh 安装`）。
`install.sh`：删 `workbench.html` 的 `cp` 行，改为 `rm -f "$RUNTIME_DIR/workbench.html"`。

**测试里直接读文件的断言会随删文件一起报 ENOENT，必须同步改**（这类断言不在 HTTP 小节，容易漏）：

- `test/smoke.mjs:861-862`（`wbh` / `wbc`）：`wbh` 改读 `index.html`；`wbc` 在 Task 1 已改名为 `theme.css`，此处一并确认。
- `test/smoke.mjs:1782`（`wbText2`）：整条「工作台：Displays 区整体移除」断言改为读 `index.html`，并把检查对象从「工作台页不含显示器」改为「显示器相关代码只出现在 `overview` 视图范围内」：

```js
const wbText2 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('显示器相关代码只在总览视图（工作台视图不含）',
  !/data-view="todos"[\s\S]*?data-view="report"[\s\S]*?monBox/.test(wbText2)
    && !wbText2.includes('loadMonitorsOnce'));
```

改完跑 `grep -n "workbench\.html\|workbench\.css" test/smoke.mjs` 确认无残留。

- [ ] **Step 6: 跑测试确认通过**

Run: `node test/smoke.mjs 2>&1 | tail -3`
Expected: 全绿；总数 ≥ 415。

- [ ] **Step 7: 手工冒烟（必须真点一遍）**

起实例后确认六项都能切、待办能加、日志能出：

```bash
CANNBOT_PROXY_PORT=8485 CANNBOT_VK_CACHE=/tmp/vk-t2.json CANNBOT_LOG_FILE=/tmp/t2.log \
CANNBOT_STATS_FILE=/tmp/t2-stats.json CANNBOT_TODOS_FILE=/tmp/t2-todos.json \
CANNBOT_REPORTS_FILE=/tmp/t2-reports.json node server.mjs
```

浏览器打开 `http://127.0.0.1:8485/`：六个左栏项逐个点过；待办加一条并删掉；`#traffic` 与 `#todos` 直接访问都能落对视图。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat: 管理台与工作台合并为单页（六个视图、脚本归并、删除 workbench.html）"
```

---

## Task 3: 移出左栏的功能归位

把左栏里塞不下、也是竖排来源的功能搬到主区；同时去掉 workbench 的 skip link（前提已不成立）。

**Files:**
- Modify: `index.html`（左栏、总览视图、配置视图、待办视图说明行）
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: Task 2 的六个 `data-view`。
- Produces: 总览视图内的 `#monWholeRow`（整机同切按钮容器，沿用 `data-mminput` 属性名与现有事件委托）；配置视图内的 `#btnRestart` / `#btnStop`；总览「订阅上游」说明行内的 `#sProto`。

- [ ] **Step 1: 写失败断言**

```js
check('左栏不再有横向按钮组与协议串', !idxHtml.includes('id="railMonBtns"') && !idxHtml.includes('id="monRailMsg"') && !idxHtml.includes('class="rail-proto"'));
check('整机同切搬到总览页', idxHtml.includes('id="monWholeRow"'));
check('重启/停止搬到配置页', /data-view="providers"[\s\S]{0,4000}id="btnRestart"/.test(idxHtml)
  && /data-view="providers"[\s\S]{0,4000}id="btnStop"/.test(idxHtml));
check('skip link 已移除（汇报为独立视图）', !idxHtml.includes('class="skip"'));
// 截断必须仍可辨识：显示器/输入源名由用户自填，按钮与左栏被省略号截断时留 title 全文
check('整机同切按钮带 title 全文（省略号截断后可辨识）',
  /data-mminput[\s\S]{0,200}title=/.test(idxHtml));
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/smoke.mjs 2>&1 | grep -E '左栏不再|整机同切搬到|重启/停止搬到|skip link|title 全文'`
Expected: 五条失败。

- [ ] **Step 3: 搬迁标记**

1. 左栏：删除 `<div class="rail-controls" id="railMonBtns">`、`#monRailMsg`、`<div class="rail-controls">`（重启/停止）、`.rail-proto#sProto` 四块。
2. 总览「显示器输入源」卡：卡片顶部加一行 `<div class="actions" id="monWholeRow"></div>`，把 `renderMonitors` 里 `rail.innerHTML = …` 的目标从 `$('railMonBtns')` 改成 `$('monWholeRow')`，事件委托从 `$('railMonBtns')` 挂到 `$('monWholeRow')`。按钮横排在这里宽度充足，但每个按钮加 `title`（全名）并**不设 `flex:1`**。
3. 配置视图末尾新增小节：

```html
<section class="sec">
  <div class="sechead"><span class="idx">02</span><h2>服务控制</h2><span class="en">Service</span><span class="spacer"></span>
    <span class="note">重启会中断进行中的请求；停止后所有 agent 无法调用模型</span></div>
  <div class="card"><div class="actions">
    <button id="btnRestart">重启服务</button>
    <button class="danger" id="btnStop">停止服务</button>
  </div></div>
</section>
```

4. `#sProto` 挪到总览「订阅上游」的 `.sechead .note` 里：`<span class="note"><span id="sProto">…</span></span>`。
5. 删除 `<a class="skip" href="#sec-report">跳到报告区 ↓</a>` 与 `.skip` 相关 CSS；`#sec-report` 的 `tabindex="-1"` 一并去掉。
6. **本任务不动 `renderRailStats()` 的任何落点**。左栏 `.rail-stats` 网格此刻还在，
   `railTodo` / `railDoing` / `railDone` / `railReports` 四处写入照常工作。
   「今日完成」挪到待办页说明行、其余三处并入徽标，统一由 Task 4（重建左栏时）一次改完——
   拆成两半会出现「落点已删、写入还在」的空指针窗口。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/smoke.mjs 2>&1 | tail -3`
Expected: 除旧断言外全绿。此时 `test/smoke.mjs:878` 的旧断言 `workbench 含「跳到报告区」skip link`
（内容为 `wbh.includes('class="skip" href="#sec-report"')`）必然失败——**就地改写它**，
与 Step 1 新增的那条合并成一条，不要两条并存：

```js
// 原「跳到报告区」skip link：汇报已是独立视图，左栏一键可达，前提消失，故移除。
// 取代关系由 Task 4 的「导航链接与视图双向一致」保证（届时 href="#report" 才存在）。
check('skip link 已移除（汇报为独立视图，左栏直达取代）', !idxHtml.includes('class="skip"'));
```

注意**不要**在这条里断言 `href="#report"`：那是 Task 4 的产物，此刻还不存在。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor: 整机同切/重启停止/协议串移出左栏，skip link 由独立视图取代"
```

---

## Task 4: 左栏重做（两级导航 + 竖排修复）

本任务的核心交付：**左栏不再有中文竖排**，且层级正确。

**Files:**
- Modify: `index.html`（左栏标记、`setView`、启动逻辑）
- Modify: `theme.css`（左栏契约、分组样式、窄屏）
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: Task 2 的 `setView` / `VIEW_IDS` / `VIEW_ALIASES`。
- Produces: 左栏组容器 `.navgroup[data-group]`；折叠状态键 `gw-groups`（`{"workbench":bool,"console":bool}`）；`.navgroup` 上的 `open` 类；徽标 id `vbTodos`（组头汇总，本任务只建不用）、`vbTodoN`、`vbReport`、`vbConsole`、`vbLog`；`#todoTodayDone`（待办页说明行）。
- **本任务必须同时收尾 `renderRailStats()`**：删除 `.rail-stats` 网格与四处旧写入，改为
  写 `vbTodoN`（pending + in_progress）、`vbReport`（存档数）、`#todoTodayDone`（今日完成）；
  `updateClearDone()` 的调用保留。

- [ ] **Step 1: 写失败断言**

```js
check('左栏两级：两个组头 + 六个子项', (idxHtml.match(/class="navgroup"/g) || []).length === 2
  && ['todos','report','overview','traffic','test','providers'].every((v) => idxHtml.includes(`href="#${v}"`)));
// 双向一致：导航里的每个 #v 都对应一个真实视图，没有孤儿链接
const navHrefs = [...idxHtml.matchAll(/<a class="viewbtn" href="#([a-z]+)"/g)].map((m) => m[1]);
check('导航链接与视图双向一致（无孤儿）',
  navHrefs.length === 6 && navHrefs.every((v) => idxHtml.includes(`data-view="${v}"`)), navHrefs.join(','));
check('导航是真链接（不用 button 切视图）', !/class="viewbtn"[^>]*data-view/.test(idxHtml));
check('左栏单行契约在 theme.css（单行 + 省略号 + 禁 break-all）',
  /\.viewbtn \.vname[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/.test(themeCssText)
  && !themeCssText.includes('break-all'));
check('左栏遥测行同样单行省略', /\.rail-tel[^}]*nowrap|\.rail-tel \.val[^}]*text-overflow:\s*ellipsis/.test(themeCssText));
check('左栏无英文小标（.ven 已移除）', !idxHtml.includes('class="ven"'));
// 窄屏折叠：分组展开后顶栏不溢出（组与子项都 nowrap + 容器横向滚动）
check('窄屏顶栏：分组与子项均 nowrap，容器可横向滚动',
  /@media \(max-width: 900px\)[\s\S]*\.views \{[^}]*overflow-x: auto/.test(themeCssText)
  && /@media \(max-width: 900px\)[\s\S]*\.viewbtn[^}]*white-space: nowrap/.test(themeCssText));
check('/workbench 强制落 todos（优先于 gw-view 记忆）', idxHtml.includes("location.pathname === '/workbench'"));
check('数字键按左栏顺序映射六个视图', /const n = Number\(e\.key\)[\s\S]{0,200}n <= VIEW_IDS\.length/.test(idxHtml));
```

`themeCssText` 用 Task 1 已取的 `await themeCss.text()`，存在变量里复用。

- [ ] **Step 2: 运行确认失败**

Run: `node test/smoke.mjs 2>&1 | grep -E '左栏两级|真链接|单行契约|英文小标|强制落'`
Expected: 五条失败。

- [ ] **Step 3: 写左栏标记**

```html
<nav class="views">
  <div class="navgroup" data-group="workbench">
    <button class="grouphead" data-group-toggle="workbench" aria-expanded="true"><span class="caret">▾</span><span class="gname">工作台</span></button>
    <div class="groupsub">
      <a class="viewbtn" href="#todos"><span class="vname">待办</span><span class="vbadge" id="vbTodoN" hidden></span></a>
      <a class="viewbtn" href="#report"><span class="vname">汇报</span><span class="vbadge" id="vbReport" hidden></span></a>
    </div>
  </div>
  <div class="navgroup" data-group="console">
    <button class="grouphead" data-group-toggle="console" aria-expanded="false"><span class="caret">▸</span><span class="gname">管理台</span><span class="vbadge red" id="vbConsole" hidden></span></button>
    <div class="groupsub">
      <a class="viewbtn" href="#overview"><span class="vname">总览</span></a>
      <a class="viewbtn" href="#traffic"><span class="vname">统计</span></a>
      <a class="viewbtn" href="#test"><span class="vname">诊断</span><span class="vbadge" id="vbLog" hidden></span></a>
      <a class="viewbtn" href="#providers"><span class="vname">配置</span></a>
    </div>
  </div>
</nav>
```

`setView(v)` 改为只负责：切 `.view` 的 `active`、给对应 `href="#v"` 的 `.viewbtn` 加 `active`、写 `gw-view`、`history.replaceState`；**并强制展开 `v` 所属组**（手动收起后不立刻翻回来——只在 `v` 变化时展开一次）。`hashchange` 监听调 `setView`（`push:false`）。启动逻辑：

```js
const forced = location.pathname === '/workbench' ? 'todos' : null;
const fromHash = location.hash.replace(/^#/, '');
const start = forced || (VIEW_IDS.includes(VIEW_ALIASES[fromHash] || fromHash) ? fromHash : null) || saved || 'todos';
setView(VIEW_ALIASES[start] || start, { push: false });
if (forced) history.replaceState(null, '', '/#todos');
```

组头点击：翻转 `gw-groups[group]`、切 `.open` 类、切 caret 字形与 `aria-expanded`，**不导航**。

主题按钮（`#themeBtn`）的去处：留左栏遥测第一行右侧（状态灯那一行），去掉它的内联
`style="padding:3px 9px;font-size:12px"`，改用 `theme.css` 里的 `.rail-theme` 类。
左栏底部不再有任何按钮组——这是 §5.1「底部只留主题切换」的落地方式。

- [ ] **Step 4: 写左栏 CSS 契约（`theme.css`）**

替换现有 `.viewbtn` 规则并新增（`--rail-w` 维持 216px）：

```css
/* 左栏布局契约：不放横向并排的文字控件；每行单行 + 省略号；禁 break-all；不缩字号硬塞 */
.grouphead, .viewbtn, .rail-tel .statline { min-width: 0; }
.grouphead .gname, .viewbtn .vname, .rail-tel .val {
  min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 遥测行：数字与文字都不换行；超长时整段省略，全文留在 title */
.rail-tel .statline { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.rail-tel .statline > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.rail-theme { flex: none; margin-left: auto; padding: 3px 9px; font-size: 12px; }
.grouphead { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px;
  background: transparent; border: none; color: var(--dim); cursor: pointer; border-radius: 7px; }
.grouphead:hover { color: var(--ink); background: var(--row-hover); }
.grouphead .gname { flex: 1; font: 600 14.5px var(--serif); letter-spacing: .08em; }
.grouphead .caret { font-size: 9px; color: var(--faint); width: 10px; flex: none; }
.groupsub { display: none; }
.navgroup.open .groupsub { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 6px; }
.navgroup.open .groupsub { padding-left: 12px; border-left: 1px solid var(--line-soft); margin-left: 9px; }
.groupsub .viewbtn { padding-left: 8px; }
```

`.viewbtn .ven` 规则全部删除；`.viewbtn` 的 `padding` 保持现值的水平量。
**同时删除 `theme.css` 里的 `.rail-proto` 规则**（Task 3 已把 `#sProto` 移出左栏，这条带
`word-break: break-all` 的规则是竖排的第二个来源，留着必被误用）。窄屏（≤900px）媒体查询里：`.views { flex-direction: row; overflow-x: auto; white-space: nowrap; }`，`.navgroup` 与 `.groupsub` 改为横向 flex、`flex: none`，`.grouphead` 收窄到只显示名字（caret 隐藏），组内子项排在其后。

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/smoke.mjs 2>&1 | tail -3`
Expected: 全绿。

- [ ] **Step 6: 五档宽度截图核验（竖排的最终判据）**

```bash
CANNBOT_PROXY_PORT=8485 … node server.mjs &   # 用 Task 2 Step 7 的那组环境变量
for w in 1220 1100 960 905 800; do
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
    --hide-scrollbars --virtual-time-budget=4000 --window-size=$w,900 \
    --screenshot=/tmp/rail-$w.png http://127.0.0.1:8485/ ; done
```

逐档**看图确认**：无中文逐字竖排、无拉丁文溢出裁切、无横向滚动条、当前项组是展开的。任何一档不合格就回到 Step 4 调整，不允许靠缩字号过。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 左栏两级导航（工作台/管理台分组）+ 单行布局契约，修复中文竖排"
```

---

## Task 5: 按视图轮询、启动预取与徽标语义

**Files:**
- Modify: `index.html`（`poll()`、启动 IIFE、徽标写入点）
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: Task 2 的 `setView` / `curView`；Task 4 的徽标元素 id。
- Produces: `maybeFetchStats()`、`maybeFetchLog()`；徽标 id `vbTodoN`、`vbReport`、`vbConsole`、`vbLog`。

- [ ] **Step 1: 写失败断言**

```js
check('轮询按视图分支：统计与日志不再无条件拉', /if \(curView === 'overview' \|\| curView === 'traffic'\)/.test(idxHtml)
  && /if \(curView === 'test'\)/.test(idxHtml));
check('启动一次性预取五个来源', ['/v1/todos', '/admin/report/list', '/admin/log', '/admin/providers']
  .every((u) => idxHtml.includes(`'${u}'`)) && idxHtml.includes('loadModels()'));
check('旧左栏统计写入已清空（无 railTodo/railDoing/railReport）',
  !/railTodo|railDoing|railReports/.test(idxHtml));
check('切回统计视图立即拉一次（不显示旧值当新值）', /function setView[\s\S]{0,900}maybeFetchStats\(\)/.test(idxHtml));
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/smoke.mjs 2>&1 | grep -E '按视图分支|一次性预取|徽标语义|切回统计'`
Expected: 四条失败。

- [ ] **Step 3: 改 `poll()` 与启动逻辑**

`poll()` 拆成：`/healthz` 永远拉（更新状态灯、运行时长、鉴权、上游数）；`/admin/stats` 只在 `curView` 是 `overview` 或 `traffic` 时拉，封装为 `maybeFetchStats()`；`/admin/log` 只在 `test` 时拉，封装为 `maybeFetchLog()`；`/admin/monitors` 逻辑保持（已按 `overview` 门控）。`setInterval(poll, 3000)` 只留一个。

`setView` 末尾加：`maybeFetchStats(); maybeFetchLog();`（函数内部自带门控，切到不需要的视图时不会发请求）。

启动 IIFE：先 `await loadToken()`，再**各拉一次** `refreshTodos()`、`refreshHistory()`、`maybeFetchLog()`、`loadProvCfg()`、`loadModels()`，全部 `catch` 掉不阻塞；然后 `poll()`。

徽标语义（Task 4 已建好元素与写入点，本任务只补 `vbConsole` 汇总与统计数字的新鲜度说明）：

- `vbConsole` = 凭证异常 provider 数（原 `vbOverview` 的语义 + 原 `vbProviders` 的位置，
  两者合并成一个：组头徽标）
- `vbLog` = 最近 80 行错误行数（不变；挂在「诊断」子项上）
- `vbTraffic` 删掉（今日请求数已在左栏遥测第三行，不重复挂徽标）

左栏遥测第三行「今日 n 次 · 上游 m」：`railTodayReq` 改为由 `maybeFetchStats` 写入，并在 `title` 里写「上次刷新：HH:MM」。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/smoke.mjs 2>&1 | tail -3`
Expected: 全绿。

- [ ] **Step 5: 手工核验新鲜度**

浏览器打开后：停在待办页 30 秒（日志不再拉，打开 devtools network 确认只有 `/healthz` 在跑）→ 点「统计」，确认统计数字**立刻**刷新（不是等 3 秒，也不是旧值）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "perf: 轮询按视图分支 + 启动一次性预取种子；左栏徽标改为未完成数/存档数"
```

---

## Task 6: 主区小节编号统一

**Files:**
- Modify: `index.html`（各视图 `.sechead .idx` 文本）
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: Task 2 的六个视图。

- [ ] **Step 1: 写失败断言**

直接写逐视图校验（松的「1–9」写法会被现有串号蒙混过关，不要用）：

```js
const viewIdx = (v) => [...(idxHtml.match(new RegExp(`data-view="${v}"[\\s\\S]*?(?=data-view="|</main>)`))?.[0] || '')
  .matchAll(/<span class="idx">(\d+)<\/span>/g)].map((m) => m[1]);
check('每个视图内小节编号从 01 开始连续', ['todos','report','overview','traffic','test','providers']
  .every((v) => { const a = viewIdx(v); return a.every((n, i) => n === String(i + 1).padStart(2, '0')); }));
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/smoke.mjs 2>&1 | grep '主区编号'`
Expected: 失败（`traffic` 现为 02、03；`test` 为 03；`providers` 为 04）。

- [ ] **Step 3: 重排编号**

按视图重新编号（只改文本）：`todos` 01；`report` 01；`overview` 01–04；`traffic` 01–02（流量与费用、模型性能）；`test` 01–02（测试台、日志流——日志流是小节头不是 `.sechead`，按现状处理即可）；`providers` 01–02（供应商配置、服务控制）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/smoke.mjs 2>&1 | tail -3`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor: 主区小节编号按视图从 01 起算，不再与旧视图编号联动"
```

---

## Task 7: 文档同步与全量回归

**Files:**
- Modify: `CLAUDE.md`、`README.md`
- Test: `test/smoke.mjs`（文档一致性断言）

**Interfaces:** 无新接口；本任务只让文档与代码一致。

- [ ] **Step 1: 写失败断言**

```js
const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const readmeMd = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
check('文档已同步单页事实', !claudeMd.includes('workbench.html') && !readmeMd.includes('workbench.html')
  && claudeMd.includes('index.html') && readmeMd.includes('index.html'));
check('文档记录两级导航与左栏契约', claudeMd.includes('两级') && claudeMd.includes('省略号'));
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/smoke.mjs 2>&1 | grep -E '文档已同步|两级导航'`
Expected: 两条失败。

- [ ] **Step 3: 改文档**

`CLAUDE.md`：项目概述去掉「工作台部分（`/workbench` 页）」改述为同一页；模块图里 `admin.html`/`workbench.html` 两行合并为 `index.html`（单页外壳：两级左栏 + 六个视图）与 `theme.css`；配置双目录那段的拷贝清单换成 `index.html + theme.css`；路由表的 `/workbench` 行注明「兼容入口，与 `/` 同一份页面，强制落 `#todos`」；把「管理台」与「工作台页」两节合并为「页面外壳」一节，写明两级导航、左栏布局契约（单行 + 省略号 + 禁 break-all）、按视图轮询、启动预取、徽标语义。

`README.md`：文件表更新；访问地址统一为 `http://127.0.0.1:8484/`，并加一句 `/workbench` 仍可用（旧书签）；「个人工作台」一节说明它现在是左栏第一组。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/smoke.mjs 2>&1 | tail -3`
Expected: 全绿。

- [ ] **Step 5: 安装演练（验证运行时目录不残留死文件）**

```bash
CGP_SKIP_LAUNCHCTL=1 ./install.sh 8486
ls ~/.local/share/cannbot-gateway-proxy/ | grep -E 'index\.html|theme\.css|admin\.html|workbench'
```

Expected: 只看到 `index.html` 与 `theme.css`，没有 `admin.html` / `workbench.html` / `workbench.css`。

- [ ] **Step 6: 旧链接全量回归**

逐个打开：`/`、`/#todos`、`/#report`、`/#overview`、`/#traffic`、`/#latency`、`/#stats-7`、`/#test`、`/#providers`、`/workbench`。Expected：每个都落到预期视图；`/#stats-7` 落在统计页且预选近 7 天；`/workbench` 落在待办且地址变成 `/#todos`。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "docs: CLAUDE.md 与 README 同步单页外壳（两级导航、左栏契约、按视图轮询）"
```

---

## 完成判据

- `node test/smoke.mjs` 全绿，总数 ≥ 415（基线 408 + 新增）。
- 五档宽度（1220/1100/960/905/800）截图无中文竖排、无溢出、无横向滚动。
- 六个视图功能完整：待办增删改/子项/详情、汇报生成与历史、统计区间与性能、诊断测试台与日志、配置增删改与服务控制、显示器整机同切与单屏轮换。
- `./install.sh` 演练后运行时目录无 `admin.html` / `workbench.html` / `workbench.css`。
- 顶层标识符无重复声明；脚本以 `'use strict'` 开头。
