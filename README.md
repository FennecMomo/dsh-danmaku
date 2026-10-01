# dsh-danmaku

DSH（DeepSeek Harness）的**弹幕浮层**：把当前会话正在做的事变成一颗颗气泡 ——
调用了哪个工具、改了哪个文件、这一轮有没有正常结束。

```
        ┌─────────────── DSH 页面（会话页里的浮层）───────────────┐
        │                                                        │
一份自包含前端（plugin/lib/bubbles.js）                           │
        │                                                        │
        └─────────────── 桌面 overlay 窗口（透明/置顶/穿透）──────┘
                         由 dsh-desktop-overlay 提供
```

## 架构：一份前端，两个宿主

| 路径 | 是什么 |
| --- | --- |
| [`plugin/`](plugin/README.md) | DSH 插件包：会话事件 → 一句话、SSE/回填/发送、把前端注进页面 |
| [`plugin/lib/bubbles.js`](plugin/lib/bubbles.js) | 前端本体：一份自包含脚本，两个宿主共用 |
| [`tools/check.mjs`](tools/check.mjs) | 离线自检（23 项），两半都能在 Node 里跑 |

两个宿主是同一个文件：

- **DSH 页面**：host 半边向外推一行 `webserver/index-inject` —— web 形态由 `renderIndex()` 渲染进 index，
  桌面端由宿主启动时收集后经 IPC 交给渲染层。**一条行，两个宿主**，不需要 `tapIndex`。
- **桌面 overlay 窗口**：由 [`dsh-desktop-overlay`](../dsh-desktop-overlay) 的 `WHITELIST` 引入，
  和余额小鲸鱼挂件待在同一个页面里。**透明、置顶、鼠标穿透、点击判定全部由那层外壳负责**，
  所以这边一行 Win32 都没有。

这也意味着一件事：**弹幕插件不装或没启用时，overlay 里那一条就是 404**（页面静默失败，
不影响 overlay 自己的启动）。两个仓库之间因此有一条单向的软依赖，改 `WHITELIST` 时要一起想。

## 怎么用

浮层在右下角（DSH 页面里可以按住把手拖动，位置会记住）：

- **点气泡** → 展开全文。带工具参数、完整回复；`Esc` 或 `×` 收起，`复制` 拿走全文。
  没有详情的气泡点不动 —— 开一个正文和气泡上一模一样的窗口，比不开更糟。
- **✎** → 展开一行输入框，`Enter` 发送给当前会话（走 `sessionController.prompt`，`queue` 模式，
  不会打断正在跑的一轮）。发失败时内容会留着，不会静默吞掉。
- **◐** → 淡出/恢复。淡出态同时**不可点**（"别挡着我"这个状态里，一个还吞点击的淡方块是个陷阱）。
- **最多同时 6 颗气泡**，旧的在顶上被挤掉：这是一个"正在发生什么"的窗口，不是历史记录。

弹幕跟着**最近活跃的会话**走：你在哪个会话里说话，它就跟到哪儿（规则细节见
[`plugin/README.md`](plugin/README.md#弹幕跟着哪个会话)）。子代理的会话不会把画面抢走。

## 装它

这是一个标准 bundle 插件，装进 profile 后随 harness 一起启动。

**官方桌面端（Electron）**：桌面端读的是 `desktop` profile，而 `dsh plugin` 命令行按设计拒绝碰它 ——
在桌面端的会话里说一句「把 dsh-danmaku 装上」即可（会话里的插件管理器作用域就是当前 profile）。
等价的手工方式是往该 profile 里 link 安装：

```powershell
# 在 desktop profile 目录里（由客户端自己管理，手工改要小心）
pnpm add link:D:\Projects\dsh-plugins\dsh-danmaku\plugin
# 再把 dsh-danmaku 写进该 profile package.json 的 dsh.profile.bundles
```

**`dsh web`（Web profile）**：

```powershell
dsh plugin --profile web add link:D:\Projects\dsh-plugins\dsh-danmaku\plugin
```

还要在 overlay 那边加一条白名单（见下方「状态」）。改完 **host 半边要重启一次客户端**才生效。

## 自检

```powershell
node tools/check.mjs        # 离线：假 root + 假 ctx 跑 host，最小 DOM 跑前端（23 项）
node tools/verify-live.mjs  # 现场：问正在跑的那台机器四个问题
```

离线那份不需要装进 profile、不需要浏览器，`plugin/README.md` 里列了它覆盖的 23 项，
以及它的假 ctx 为什么要复刻 Cordis 的 inject 门禁。

现场那份是给"改完 host 代码、重启之后"用的复核：

| 它问什么 | 为什么会问 |
| --- | --- |
| host 半边是不是**新代码**（`build` 字段） | 改了 host 代码不重启的话，跑的还是旧模块，而旧模块看起来一切都正常 |
| SSE 长连接稳不稳（5 秒不被掐断） | 这条没有别的观测点：浏览器里只会看到"前端无限重连" |
| DSH 的 index 里有没有前端 loader | web 形态的注入 |
| overlay 页面里有没有同一份脚本 | 跨插件那条（`WHITELIST`） |

它现在就**故意是红的**：三处不通过，全都指向"还没重启客户端"。重启后应当全绿 ——
红着的时候它说的每一句都指明了该动什么。

## 目录

| 路径 | 放什么 |
| --- | --- |
| `plugin/` | DSH 插件包（host 半边 + 前端本体 + 挂载声明） |
| `tools/` | 离线自检 |

## 状态

已经验证过的：

| 检查 | 结果 |
| --- | --- |
| 离线自检 `tools/check.mjs` | ✅ 23 项 |
| host 半边真机热装后可用 | ✅ `/dsh-danmaku/v3/status` 200，`active` 正确指向当前会话，事件在采 |
| 前端在**真实 DSH 页面**里 | ✅ 建根节点、回填 3 条气泡、无 JS 错误（CDP 手工注入验证） |
| 前端**交互**（真机） | ✅ 点气泡开详情（标题/正文正确、`Esc` 能关）、◐ 淡化到 0.24 再恢复、✎ 展开/收起输入条、拖动把位置写进 localStorage |
| 前端在**真实 overlay 页面**里 | ✅ 同上，且与小鲸鱼挂件共处不打架，页面背景透明 |
| web 形态**端到端**（自动注入 → 前端启动 → 回填） | ✅ 独立无头 Edge 打开真实 DSH 页面，什么都不做：浮层自己出现、回填 3 条气泡、零 JS 错误 |
| 注入行进了 web 形态的 index | ✅ curl DSH 的 index，里面就有那行内联 loader（排在 `__DSH_BOOT_READY__` 之前） |
| `timer` 进 inject 这条修复 | ✅ 用临时探针插件在真机上验证：`ctx.interval` 可用、带心跳的 SSE 稳定跑了 8 秒收到 5 次 ping；`ctx.get('agents')`（会话过滤）与 `ctx.get('sessionController')`（发送）都在 |

还没验证的（要等一次客户端重启，重启后 host 新代码与新的白名单才会加载）：

- ⏳ DSH **桌面端**页面里的自动注入 —— web 形态已经用 curl index 验证过；桌面端的注入表是宿主
  **启动时收集一次**的，所以只有重启才算数。
- ⏳ overlay 页面里 `WHITELIST` 生效。
- ⏳ 端到端的**实时**：重启后说一句话，气泡应当立刻冒出来（重启前跑的是旧模块，
  `ctx.interval` 还在抛错，所以 SSE 只能靠 `recent` 回填 —— 屏幕上看起来"有气泡"，但新的不来）。
  复核方式：`/dsh-danmaku/v3/status` 里的 `clients` 不该一直涨、`lastStreamError` 应当是空的。

另外记一笔：**换 `package.json` 的 `main` 指向新文件，并不能让 host 代码热重载** ——
试过了，loader 缓存的是包级模块，重启是唯一可靠的路（见 [`plugin/README.md`](plugin/README.md#六个坑都是实测的不是推测)）。

## 它以前是一个自己画的窗口

这个仓库原来还有一整套 Python 实现（`danmaku/`）：Win32 layered window + GDI 逐像素 alpha 自绘、
`SetWindowRgn` 裁出气泡区域、光标轮询判点击、Tk 详情窗与输入窗、状态文件 + 停止脚本。
**现在整个目录删掉了** —— 那套东西存在的唯一理由就是"要一个透明、置顶、点得到下面的窗口"，
而这件事已经由 `dsh-desktop-overlay` 做好了。

留在这里的是它踩出来的三条教训，因为它们是这类需求绕不开的：

1. **GDI 根本不写 alpha 通道。** 在 32 位 DIB 上 `CreateSolidBrush` + `RoundRect` 只写 B/G/R，
   第四个字节原封不动 —— 于是"背景很淡、气泡完全不透明"做不出来，改任何窗口样式都没用。
   这一条在 DOM 里不存在（`rgba()` 是真 alpha），自绘窗口才有。
2. **透明 ≠ 点得到下面的东西。** layered window 看起来透明，但它依然拥有整个矩形；
   没有 region 的话，气泡之间那些"透明"缝隙照样吃掉点击。overlay 那层换了做法：
   常驻穿透 + 光标落点时用 `elementFromPoint` 判断该不该临时关掉穿透。
3. **窗口会跟着内容收缩。** 固定高度的窗口会留下大片半透明白色矩形，压住后面的东西又什么都不显示；
   而且 `SetWindowPos(SWP_NOMOVE)` 钉的是左上角，堆栈往上长时底边会一直往下跑。
   浏览器里 `position: fixed; bottom: …` 天然没有这个问题。

顺带一个更贵的教训，写进了 `plugin/README.md`：**一个不注册的 client bundle，在 host 侧完全没有痕迹。**
这一版干脆不再有 client bundle —— 前端是普通脚本，由 host 注入，失败面从"看不见的注册"变成
"一条 200 或一条 404"。
