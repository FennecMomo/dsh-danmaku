# dsh-danmaku

DSH（DeepSeek Harness）的**弹幕悬浮窗**插件：把当前会话正在做的事变成屏幕右下角的一颗颗气泡
——调用了哪个工具、改了哪个文件、这一轮有没有正常结束。

两个半边，各自独立，靠 HTTP 和几个状态文件说话，没有 IPC：

| 路径 | 是什么 |
|---|---|
| [`plugin/`](plugin/README.md) | DSH 插件包：会话标题旁的「弹幕」按钮、事件流的四条路由 |
| [`danmaku/`](danmaku/README.md) | 悬浮窗本体：Python + Win32 layered window，逐像素 alpha |

这个仓库是从早先自制的 Electron 桌面壳里提出来的。官方桌面端（基于 Electron 44）已经发布，
桌面壳那部分就不再需要了，插件和面板留下来单独维护。

## 装它

在 profile 的 `cordis.patch.yml` 里加一行，`name` 指向**入口文件**（不是包目录 —— Node 的
ESM 加载器不接受目录导入，指到目录会让整个 harness 起不来）：

```yaml
- insert:
    - id: danmaku-overlay
      name: 'file:///D:/Projects/dsh-plugins/dsh-danmaku/plugin/lib/index.js'
```

改完重启一次 harness。插件名、四条路由、八个容易搞错的地方、界面出问题时的观测方法，
都写在 [`plugin/README.md`](plugin/README.md)。

插件不需要 `dsh plugin add`，也不需要 pnpm 安装：路径形式的加载名会直接解析到最近的
`package.json`，所以这个仓库放在哪儿都行，和 DSH 的安装目录没有关系。

## 面板单独跑

```powershell
# 启动（GUI 用 pythonw，否则窗口后面会闪一个黑框）
pythonw.exe danmaku\danmaku_panel.pyw --url http://127.0.0.1:19387 --session <sessionId>

# 探测（必须用 python.exe：pythonw 没有控制台，stdout 会被 Windows 直接丢掉）
python.exe danmaku\danmaku_panel.pyw --status

# 关掉（按命令行匹配，不按进程名）
powershell -NoProfile -File danmaku\stop-panel.ps1
```

面板的实现、三个踩过的坑（GDI 不写 alpha、透明不等于点得到、窗口跟着内容收缩）、
以及所有设置项，写在 [`danmaku/README.md`](danmaku/README.md)。

## 状态

- 宿主半边探测面板状态（以及停止面板）走的是 `ctx.shell`。这个方法在当前 DSH（0.2.0-rc.2）
  上已经从 `run(spec)` 变成了两段式：`execute(spec)` 拿活句柄，再 `await handle.result()`
  拿 `stdout` / `exitCode`。仓库里已经按新契约改好，但**还没有装进 profile 在真机上跑过**，
  别当它已经验证可用。
