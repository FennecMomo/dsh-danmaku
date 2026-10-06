/*
 * 侧栏底部那个「弹幕开关」。
 *
 * 这是**手写**的 client bundle，用的就是 loader 真正消费的格式，不是打包器的产物：
 *
 *   - `window.__ModuleLoader__.load({ id, factory })`，factory 返回 `module.exports`；
 *   - 插件是 module 的 `apply` 导出（不是 factory 的返回值）；
 *   - React 走 `require('react')`，JSX 不参与编译，所以标签全部 `React.createElement`。
 *
 * 三件事是**承重**的，都是踩出来的：
 *
 * 1. `exports.inject = ['slots']` 是必须的。client 那层门禁和 host 一样：没声明过的服务，
 *    `ctx.get('slots')` 返回 undefined、`ctx.slots` 直接抛。少了这一行，apply 会在自己的
 *    guard 上静静返回、一个 slot 都不注册 —— 而 **host 侧一点痕迹都没有**，查起来极贵。
 *
 * 2. 注册要包在 `ctx.slots.inject(槽位, () => ctx.slots.register(...))` 里。槽位是**别的包**
 *    声明的，谁先加载不确定；直接 register 会在声明出现之前落空。inject 会在声明出现时才跑
 *    回调，声明塌掉时自动摘掉、回来时再装上。
 *
 * 3. 状态**只认 host 的答案**（HTTP 问 `/visible`），不在按钮里记一份。DSH 页面和桌面
 *    overlay 是两个前端，按钮自己记的话，另一个窗口的显示状态立刻就对不上了。
 */
window.__ModuleLoader__.load({
  id: 'dsh-danmaku',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    var SLOT = 'sidebar.footer.action'
    var VISIBLE_URL = '/dsh-danmaku/v3/visible'
    /* 按钮不是唯一能改这个状态的地方（浮层自己也有入口），所以定期对一次账。 */
    var POLL_MS = 5000

    /* 内联样式而不是注入 CSS：这一层不引入 styles 服务，少一个能静静失败的地方。 */
    var ROW = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      width: '100%',
      boxSizing: 'border-box',
      background: 'transparent',
      border: 'none',
      borderRadius: '6px',
      padding: '6px 8px',
      color: 'inherit',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
      textAlign: 'left',
    }

    function DanmakuToggle() {
      var visibleHook = React.useState(true)
      var visible = visibleHook[0]
      var setVisible = visibleHook[1]
      var busyHook = React.useState(false)
      var busy = busyHook[0]
      var setBusy = busyHook[1]

      React.useEffect(function () {
        var cancelled = false

        function read() {
          window
            .fetch(VISIBLE_URL, { headers: { accept: 'application/json' } })
            .then(function (response) {
              return response.json()
            })
            .then(function (data) {
              if (cancelled || data === null || data === undefined) return
              if (typeof data.visible === 'boolean') setVisible(data.visible)
            })
            .catch(function () {
              /* 问不到就保持上一次的答案：按钮不该因为一次网络抖动自己抖起来。 */
            })
        }

        read()
        var timer = window.setInterval(read, POLL_MS)
        return function () {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [])

      function toggle() {
        var next = !visible
        setBusy(true)
        /* 先乐观地翻过去：这个按钮要立刻有反应；失败再翻回来。 */
        setVisible(next)
        window
          .fetch(VISIBLE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ visible: next }),
          })
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            if (data !== null && data !== undefined && typeof data.visible === 'boolean') setVisible(data.visible)
          })
          .catch(function () {
            setVisible(!next)
          })
          .then(function () {
            setBusy(false)
          })
      }

      var style = visible ? ROW : Object.assign({}, ROW, { opacity: 0.55 })

      return React.createElement(
        'button',
        {
          type: 'button',
          style: style,
          onClick: toggle,
          disabled: busy,
          title: visible ? '弹幕正在显示，点一下隐藏' : '弹幕已隐藏，点一下显示',
          'aria-pressed': visible,
        },
        React.createElement('span', { style: { width: '16px', textAlign: 'center', opacity: 0.85 } }, visible ? '💬' : '🚫'),
        React.createElement('span', null, visible ? '弹幕' : '弹幕已隐藏'),
      )
    }

    exports.inject = ['slots']
    exports.apply = function (ctx) {
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register(
          {
            name: SLOT,
            id: 'danmaku-visible',
            order: 20,
          },
          DanmakuToggle,
        )
      })
    }

    return module.exports
  },
})
