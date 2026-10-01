# dsh-plugin-danmaku

会话标题旁的「弹幕」按钮，以及弹幕窗口读取的事件流。装进 `desktop` profile，
随 harness 一起启动。

## 为什么这是一个插件包，而不是动态 Cordis 插件

动态 Cordis 插件**只活在当前进程里**。下次重启就没有那一行了，
所以按钮根本不存在 —— 不是「没自动启用」，是「没东西可启动」。

这个包放在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里，那个文件**每次启动都会读**，
所以能力跟着进程一起回来。

## 它提供什么

| 路由 | 用途 |
|---|---|
| `GET /dsh-danmaku/v3/status` | 按钮轮询面板状态 |
| `POST /dsh-danmaku/v3/toggle` | 开/关弹幕窗口 |
| `GET /dsh-danmaku/v3/stream` | SSE，面板的实时事件源 |
| `GET /dsh-danmaku/v3/recent` | JSON 回填 |

四条路由都用 `ctx.effect` 注册，所以停用或更新这个插件会把四条一起撤掉。

## 为什么走 HTTP 而不是 `harness.handle` / `host.call`

那一对 RPC 是**动态插件专属**的，持久插件没有。`webServer.register` 给的是普通的
Node `req` / `res`，所以页面直接走 HTTP 和这个插件说话。

## 路径怎么找

弹幕窗口是 Python，和这个包放在**同一个仓库**里（本仓库的 `danmaku/`）。
包不从磁盘猜路径，而是：

1. 读 `DSH_DESKTOP_HOME` —— 早先自制的桌面壳启动 harness 时会把自己的目录传进来；
   官方桌面端不设这个变量，所以这一步在官方壳下会落空
2. 找不到就退回**本仓库根目录**下的 `danmaku/`。这个位置是算出来的（入口文件往上两级），
   所以仓库搬到哪台机器、放在哪个路径都不用改，直接 `dsh --profile desktop` 也能用

可用环境变量覆盖：

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_HOME` | 桌面壳目录；`danmaku/` 就在它下面（官方桌面端不设它） |
| `DSH_DANMAKU_DIR` | 直接指定弹幕目录 |
| `DSH_DANMAKU_PYTHON_DIR` | 含有 `python.exe` / `pythonw.exe` 的目录 |

## 安装

在 profile 的 `cordis.patch.yml` 里加一行：`name` 用**入口文件的绝对路径**。
路径形式的 loader name 会直接解析到最近的 `package.json`，所以
不需要 `dsh plugin add`，也不需要 pnpm 安装 —— 这个包待在哪个目录都行，
和 DSH 的安装目录没有关系。

```yaml
- insert:
    - id: danmaku-overlay
      name: 'file:///D:/Projects/dsh-plugins/dsh-danmaku/plugin/lib/index.js'
```

改完要**重启一次 harness**（关掉桌面端再打开）。

## 八个不能搞错的地方

1–3 是「命令看起来没问题、结果什么都没有」，4–8 是「包看起来加载了、按钮就是不出现」。

**1. `name` 必须指向入口文件，不能指向包目录。**

```
name: 'file:///D:/Projects/dsh-plugins/dsh-danmaku/plugin'              # ✗ ERR_UNSUPPORTED_DIR_IMPORT
name: 'file:///D:/Projects/dsh-plugins/dsh-danmaku/plugin/lib/index.js' # ✓
```

Node 的 ESM 加载器不接受目录导入。指到目录上，整个 harness 起不来。

**2. 客户端半边必须声明 `slots`，而且要用 `ctx.slots` —— 这是最难查的一个。**

```js
exports.inject = ['slots']     // ✓ 必须声明
ctx.slots.inject(...)          // ✓ 声明过的服务用属性形式

exports.inject = []            // ✗
var slots = ctx.get('slots')   // ✗ 返回 undefined，apply 直接 return，什么都没注册
```

客户端 facade 对服务读取**有门禁**：没在 `inject` 里声明的服务 `ctx.get()`
拿不到；而 `ctx.slots` 这种属性形式**只有声明过才解析**。

这个失败**在 host 侧没有任何症状** —— 没有报错、没有 404、没有日志，
只有浏览器控制台里一行。这是它耗掉最多轮次的原因：我们一直在看不见反馈的
情况下推理。最后是靠让客户端把每一步 POST 回 host 才定位到的：

```
module-evaluated   factory entered
apply-entered      ctx type=object
apply-slots        undefined        ← 就是这里
```

**3. `active: false` 的含义是确定的：那个 entry 渲染时抛异常了。**

```js
entriesOfSlot(t) { for (const c of r.entries) { if (this.abdicated.has(c)) continue; ... } }
```

`abdicated` 这个 WeakSet **只由 `reportEntryError(..., {abdicate: true})` 写入**。
`register()` 只把 entry 推进 `i.entries`，不会让它变 false。
所以看到 `active: false` 就不必再猜「注册失败了」。

**4. 事件字段名是 `exec.name` / `exec.arguments` / `exec.agent.id`。**

不是 `toolName` / `args` / `sessionId`。读错名字不报错 —— 事件照常到达，
只是气泡里没有工具名也没有对象，所以「看起来没坏」但内容是空的。

**5. 静态 bundle 拿得到 `window` 和 `fetch`。**

`setInterval`/`fetch`/`require` 的教学陷阱**只由 `evaluateClientHalf` 安装**，
而它只给**动态插件**用 `new Function` 造闭包。静态 bundle 走
`window.__ModuleLoader__.load`，不受影响。所以轮询可以直接用
`window.setInterval`，不需要声明 `timer` —— 少一个声明就少一种被 park 的可能。

**6. 探测用 `python.exe`，启动用 `pythonw.exe`。**
`pythonw.exe` 是 GUI 子系统程序，没有控制台。给它一根 stdout 管道，
Windows 是**直接丢掉**而不是接上去。实测三次：同一条 `--status`，
`pythonw` 返回退出码 0 加空字符串，`python` 每次都给完整结果。

**7. 启动走 `subprocess.spawn`，探测走 `ctx.shell`。**
`ctx.shell` 在命令结束时会**连带杀掉整棵进程树**，用它启动的面板活不过几秒，
而且死得很安静（启动日志已经写出来了，看起来像崩溃）。探测不启动任何东西，
而且只有 `ctx.shell` 的返回值带 stdout —— `subprocess` 的完成结果只有
`{ exitCode, signal }`。

**8. `ctx.shell` 是 PowerShell，不是 bash。**
PowerShell 会把开头的引号字符串当成**字符串字面量**，给程序名加引号会直接报
`Unexpected token`。程序名必须裸写，只有参数加引号。

## 界面出问题时怎么查 —— 先建立观测

这是这个包最贵的一课：**一个不注册的 client bundle，在 host 侧完全没有痕迹。**
只能读 host 的话，就必须先给自己开一条从浏览器回来的路。

```js
// host 侧加一条临时路由
ctx.webServer.register({ kind: 'exact', path: '/.../report', handler: ... })

// client 侧每一步都 POST 回去。window.onerror 放最前面 ——
// 模块求值阶段抛异常时，后面的上报还来不及跑
window.addEventListener('error', (e) => report('window.onerror', e.message))
report('module-evaluated')
report('apply-slots', slots === undefined ? 'undefined' : typeof slots)
```

再加上 slot 表（读它不需要浏览器）：

```js
Slots.listSubTree({ root: 'conversation.session.header.actions' })
// 看不到自己的 id  = 没注册（apply 里就 return 了，或者根本没跑）
// active: false    = 注册了，但渲染时抛异常
```

两条信息一交叉，剩下的就只是读那一行错误文本。

两边都能在 Node 里单独验，不用重启也不用刷新：

```sh
# host 半边
node -e "import('file:///D:/Projects/dsh-plugins/dsh-danmaku/plugin/lib/index.js').then(m => console.log(m.inject))"

# client 半边：搭一个假的 __ModuleLoader__ 和一个假的 react
node -e "const vm=require('vm'),fs=require('fs');const reg=[];vm.runInNewContext(fs.readFileSync('plugin/lib/client.js','utf8'),{window:{__ModuleLoader__:{load:r=>reg.push(r)}},console});const m=reg[0].factory(()=>({useState:()=>[0,()=>{}],useEffect:()=>{},createElement:()=>({})}));console.log(Object.keys(m),m.inject)"
```

**缓存边界**：`plugin/lib/client.js` 的改动会被 `clientModules` 的 watcher 捡到并换 rev，
所以**刷新页面**就能拿到新 bundle；但 host 半边（`lib/index.js`）**必须重启**才生效。

## 客户端 bundle

`lib/client.js` 是手写的，所以用的是 loader 真正消费的格式：

- `window.__ModuleLoader__.load({ id, factory })`，factory 返回 `module.exports`
- 插件就是模块的 `apply` / `inject` 导出 —— **不是** return 一个对象
  （那是动态包的形状，在这里加载不起来）
- 没有 JSX 和 TS 编译，所以用 `React.createElement`
- 只有这几个模块能从 `require` 拿到：`react`、`react/jsx-runtime`、`react-dom`、
  `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`
