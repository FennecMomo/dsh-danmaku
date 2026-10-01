# dsh-danmaku · plugin

会话事件的弹幕浮层，标准 DSH bundle 插件：装进 profile 的 `dsh.profile.bundles`，随 harness 一起启动。

两半：**host 半边**（`lib/index.js`）把会话里发生的事读成一句话并广播出去；**前端**（`lib/bubbles.js`）
是一份自包含脚本，被注进页面里画气泡。前端那份**同时挂在两个宿主**（DSH 页面、桌面 overlay 窗口），
但只有一份代码。

---

## 五条路由

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-danmaku/v3/bubbles.js` | 前端本体，按 mtime 热读（改完刷新页面即生效） |
| `GET /dsh-danmaku/v3/stream` | SSE，实时事件 |
| `GET /dsh-danmaku/v3/recent` | JSON 回填：`{ active, activeTitle, events }` |
| `POST /dsh-danmaku/v3/send` | 把一句话发进会话（前端那条折叠输入框用） |
| `GET /dsh-danmaku/v3/status` | 诊断：活跃会话、事件数、客户端数、前端文件状态、SSE 错误 |

五条都走 `ctx.effect` 注册，插件停用/更新时一起撤掉。留下一条还在应答的路由，就是一个插件
"该走了却还在说话"的样子。

`status` 里两个字段是专门为排查留的：`clients` 是当前 SSE 连接数（断掉的连接会被就地摘掉，
所以它不该一直涨），`lastStreamError` 记着 stream handler 里最后一次抛出来的东西 —— 见下面第 1 条坑。

---

## 前端挂两处，注入通道是一条

```
              ┌── DSH 页面 ──────── webserver/index-inject 的结构化行
host 半边 ────┤                     web 形态：renderIndex() 把行渲染进 index
              │                     桌面端：宿主 collectIndexInjections() 收集后经 IPC 交给渲染层
              └── overlay 页面 ───── dsh-desktop-overlay 的 WHITELIST 引入
```

**一条行，两个宿主。** 实测确认：只注册了 `webserver/index-inject`，没有写 `tapIndex`，
而 curl DSH 的 index 里就有我们那行内联 loader（它出现在 `__DSH_BOOT_READY__` 之前）：

```html
<script>(function(){try{var d=document.body||document.head||document.documentElement;
if(!d)return;var s=document.createElement("script");s.src="/dsh-danmaku/v3/bubbles.js";
s.onerror=function(){};d.appendChild(s)}catch(e){}})()</script>
```

两边的差别在**什么时候收集**：web 形态每次 `renderIndex()` 都重新 `collectIndexInjections()`（所以那行是动态的），
桌面端是宿主启动时收集一次后缓存、没有刷新路径。后者决定了下面两条硬规矩。

**规矩一：注册必须在 `apply()` 的一开头**，不能放进 `root.inject([...])` 里等服务就绪 ——
服务晚一点，这一行就永远进不了表，症状是"桌面端弹幕从不出现"，而 host 侧没有任何报错。
本插件因此**故意没有对象级 `inject`**（`export const inject = [...]`），`tools/check.mjs`
里有一条断言专门拦它。

**规矩二：行必须是内联 `<script>` 文本，不能是 `script-src` 行。** 页面侧解释器对两种行的处理不对称：
`script` 行是 `createElement` + `textContent`（没有 await，不可能失败），`script-src` 行是
`await loadScript(src)`（**加载失败会 reject 掉 `__DSH_BOOT_READY__`，整个应用起不来**）。
我们的路由在插件被停用后就是 404，所以这里自己建标签、自己吞掉 `onerror`：
路由在就正常加载，路由不在就静默失败，宿主永远不会因为我们起不来。

`webServer.tapIndex`（裸 HTML 变换）是"结构化行表达不了的标记"的逃生口，本插件没有用到。

行本身是最朴素的那种：`{ kind: 'script', placement: 'body', text: '<一段内联 IIFE>' }`。
宿主侧的 `renderRow` 认这个形状（`script` 渲染成 `<script>${text}</script>`，`placement` 照用），
而**鲸鱼挂件用的是同一个形状、并且已经在这台桌面客户端上跑通了** —— 这是"重启后它也会被认"
最便宜的一条旁证。

---

## 弹幕跟着哪个会话

一个浮层只显示一个会话的事件，规则三条：

1. **用户消息是锚。** `user/message` 到达时，那个会话就是"你现在在看的那个"，浮层清空并提示切换。
   其余事件（工具、助手文本）只跟着锚走，不抢。
2. **没有锚时用第一条带会话的事件落位**（刚启动、或者这一轮还没有用户消息）。
3. **子代理的会话不播。** 子代理也是 Session，它的工具调用带着自己的 id 到达。不过滤的话，
   主会话派一个子代理出去，整片弹幕就跟着子代理走了。判定用 `ctx.get('agents').roots()`；
   服务不在或者列表为空时**不拦**（宁可多显示，也不要因为拿不到列表就整片哑掉）。

---

## 六个坑（都是实测的，不是推测）

**1. `timer` 必须在 `inject` 里 —— 否则 SSE 会在响应头发出之后炸掉。**

Cordis 的 context 是个 Proxy：**没在 inject 里声明过的服务，属性访问会抛**
`cannot get property "timer" without inject`。而 `ctx.interval` 属于 `timer` 服务，它当时不在
inject 列表里（原来的版本是从客户端半边抄来的，那边是另一套门禁），于是：

```
SSE handler → writeHead(200) → write(': connected')  → ctx.interval(...) 抛错
webServer   → 响应头已发出 ⇒ 直接销毁 socket（外加一条 logger.warn）
浏览器      → open 之后 1 毫秒 error ⇒ 前端无限重连，屏幕上一条实时事件都没有
```

现场完全没有指向 inject 的线索：路由是 200、前端不报错、`recent` 回填正常（所以气泡看起来是有的），
只有"新的不来"。定位方式是拿一个**临时探针插件**（新包 = 新模块 = 立刻生效）把每一步的成败记下来
再读出来，一行就写明白了。

推论：**`ctx.get('name')` 与 `ctx.name` 不是一回事。** `get()` 是宽松读取（拿不到给 undefined），
属性访问受 inject 门禁约束。所以要可选依赖就用 `get()`，要属性形式就老老实实写进 inject。

**2. 改了 host 代码，"禁用再启用"不会加载新代码。**

Node 的 ESM 缓存按 specifier 命中，重新实例化执行的还是旧模块 —— 现象是"改动像没生效，但文件时间戳
确实更新了"（因为旧模块的 `apply` 又跑了一遍）。**唯一可靠的办法是重启 DSH 客户端。**
真要在不重启的情况下迭代 host 代码，只有换 specifier（例如改 `main` 指向新文件名）。

前端不在此列：`bubbles.js` 是按 mtime 热读的，改完**刷新页面**即生效。

**3. 事件字段名是 `exec.name` / `exec.arguments` / `exec.agent.id`。**

不是 `toolName` / `args` / `sessionId`。读错名字不报错 —— 事件照常到达，只是气泡里既没有工具名
也没有对象，所以"看起来没坏"但内容是空的。

**4. `session/event` 的载荷在 `event.data` 里。**

`SessionEvent` 的形状是 `{ type, seq, time, data }`。曾经读的是 `event.reason` 和 `event.text`
（两个都不存在），同样什么都不抛，只是每颗气泡都是空的。

**5. 断掉的 SSE 连接不会自己从表里消失 —— 顺序要摆对。**

`broadcast` 里写失败时就地删除，只是第一层；更要紧的是 **stream handler 里的顺序：
先把 `close` 处理器挂上，最后才把 `res` 放进 listeners**。反过来的话，中间任何一步抛错都会留下
一条永远摘不掉的连接（close 还没注册，而它已经入表了）。timer 那个 bug 就是这样留下了
**11 条尸体** —— `status` 里的 `clients` 一路涨到两位数，看起来像"有一堆客户端连着"。
现在先挂钩子、最后入表，且 handler 里每一步抛错都记进 `lastStreamError`。

**6. 别在 overlay 页面里做拖动。**

指针一旦离开可交互元素，外壳就恢复鼠标穿透，`mousemove` 立刻断掉，拖动会半途而废。
桌面上的落点本来也该固定在右下角，所以 overlay 里不做拖动，DSH 页面里才可以（位置记在
localStorage 里，两个宿主各存一份）。

同样的道理决定了前端样式里唯一一条硬规矩：**容器必须 `pointer-events: none`，只有气泡和按钮
`auto`**。违反它的后果不是"点不到"，而是"整块桌面点不动" —— 那正是 overlay 那层费了很大劲避开的事。

---

## 自检

```powershell
node tools/check.mjs
```

离线跑两半，23 项：

- **host**：导出形状（含"不许有对象级 inject"）、注入行幂等、五条路由、工具事件读的是真字段名、
  用户消息锚定活跃会话、非活跃会话与子代理会话被挡住、`recent` 形状、`send` 通路。
- **前端**：在一套最小 DOM 里真跑一遍 —— 建根节点、SSE 与回填、一条事件变成一颗按 kind 上色的气泡、
  点开详情、气泡上限 6 条挤掉最旧的、切会话清空、没有详情的气泡不可点，以及三件交互
  （◐ 淡化/恢复、✎ 输入条展开/收起、拖动 + 位置记忆）。

假 ctx 复刻了 Cordis 的 inject 门禁（第 1 条坑），所以"忘了声明 timer"这类问题在自检里就会现形，
不必等到真机。

`tools/verify-live.mjs` 管的是另一半：对着**正在跑的那台机器**问六个问题 —— host 是不是新代码、
SSE handler 有没有抛过错、跟着哪个活跃会话、SSE 长连接稳不稳、DSH 的 index 里有没有前端 loader、
overlay 白名单里有没有。改完 host 代码重启之后拿它复核；它需要 `/dsh-danmaku/v3/status` 和
`/dsh-overlay`，index 那一项要凭据（从旁边 overlay 仓库的 `.launch-url.txt` 读 fresh token，
读不到就跳过那一项而不算失败）。

`tools/verify-page.mjs` 管最后一段：**页面里到底长出来没有**。它起一个**独立的**无头 Edge
（独立 user-data-dir，不碰主人在用的浏览器），走带 token 的 login URL 建立会话，打开真实页面，
检查浮层有没有被自动注入、气泡、点开的详情、以及事件流有没有在喊断线，最后截一张图；
`--url /dsh-overlay` 就换 overlay 那个宿主。

这里有一处值得记住的教训：**判断 SSE 不能只读一次前端那行提示**。它在 open 与 error 之间会
**闪** —— EventSource 一重连成功就清空、一失败又写回去 —— 只读一次有一半概率读到"干净"的那一瞬，
把断线的连接误判成健康的。这个脚本的第一版就这么被骗过一次；现在它连采 8 次，并且同时数
`performance` 里 `/stream` 的请求条数（Resource Timing 只记录**已结束**的请求，所以一条健康的
长连接反而**不**留下记录，一串记录才说明它在反复断）。

---

## 界面出问题时怎么查

前端在**两个**地方跑，而两边的失败都是安静的：DSH 页面里它只是"没出现"，overlay 页面里更是
没人会去开 devtools。所以先建立观测，再猜：

```powershell
# host 半边活着吗、在跟谁、SSE 有没有客户端
curl.exe -s http://127.0.0.1:<port>/dsh-danmaku/v3/status

# 前端本体在不在（200 就是路由在）
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:<port>/dsh-danmaku/v3/bubbles.js

# 手动灌一份前端进页面（浏览器控制台 / CDP 都能用），看它到底会不会建出来
var s=document.createElement('script');s.src='/dsh-danmaku/v3/bubbles.js';document.body.appendChild(s)
```

页面里那两个诊断入口：`document.getElementById('dsh-danmaku-root')` 在不在，
以及 `.dshd-note` 那一行文字（断流、发送失败都会写在那里）。

overlay 那一侧另有一套：外壳每秒把状态写进 `dsh-desktop-overlay/shell/.shell-status.json`，
里面 `overlayVisible` / `interactive` / `reloads` 能回答"窗口到底有没有浮出来"。

---

## 缓存与生效边界（一张表）

| 改了什么 | 怎么生效 |
| --- | --- |
| `plugin/lib/bubbles.js`（前端） | 刷新页面；overlay 里浮出来之前外壳会自己 `reload()` |
| `plugin/lib/index.js`（host） | **重启 DSH 客户端**（禁用再启用不算） |
| `dsh-desktop-overlay` 的 `WHITELIST` | 重启 DSH 客户端（那是它 host 半边里的常量） |
