/*
 * dsh-danmaku —— 前端本体
 *
 * 一份自包含的普通脚本，**同时挂在两个地方**：
 *
 *   ① DSH 自己的页面 —— host 半边通过 `webserver/index-inject`（桌面端）与
 *      `webServer.tapIndex`（web 形态）把它注进 index；
 *   ② dsh-desktop-overlay 的 overlay 页面 —— 由那份插件的 `WHITELIST` 引入。
 *
 * 两个宿主，同一份代码。所以这里**不能依赖任何 DSH 专有全局**（没有 __DSH_BOOT__、没有 slot
 * 运行时、没有 React），也不能依赖"页面上还有什么别的东西"：自己建 DOM、自己挂 body、
 * 请求一律走同源相对路径。
 *
 * 透明、置顶、鼠标穿透完全不归这里管。overlay 那层窗口常驻 `setIgnoreMouseEvents(true)`，
 * 由主进程轮询光标 + 页面里 `elementFromPoint` 判断"这里该不该可交互"——落到气泡或按钮上
 * 就临时关掉穿透，落到空白就打开。所以这里的规矩只有一条：
 *
 *     **背景必须完全不接收指针事件**（容器 `pointer-events: none`），
 *     只有真正可点的那些小方块（气泡、按钮）才 `pointer-events: auto`。
 *
 * 违反它的后果不是"点不到"，而是"整块桌面点不动"——那正是 overlay 那层费了很大劲避开的事。
 *
 * 另一个必须记住的边界：overlay 里**不要做拖动**。指针一旦离开可交互元素，窗口就恢复穿透，
 * mousemove 立刻断掉，拖动会半途而废。桌面上的落点本来就该固定在右下角，所以那边不做拖动；
 * DSH 页面里（不是 overlay）才可以拖，位置记在 localStorage 里。
 */
;(function () {
  'use strict'

  /* 幂等：host 的两条注入通道在 web 形态下可能都生效，重复的 <script> 不该挂出第二个浮层。 */
  if (window.__dshDanmakuLoaded === true) return
  window.__dshDanmakuLoaded = true

  var API = '/dsh-danmaku/v3'
  /** 同时可见的气泡数。旧的在顶上被挤掉——这是一个"正在发生什么"的窗口，不是历史记录。 */
  var MAX_BUBBLES = 6
  /** 启动时回填几条。故意很小：把整个会话回放出来是一堵没用的历史墙。 */
  var BACKFILL = 3
  var IS_OVERLAY = location.pathname.indexOf('/dsh-overlay') === 0
  var POS_KEY = 'dsh-danmaku:pos:' + (IS_OVERLAY ? 'overlay' : 'page')
  var STYLE_ID = 'dsh-danmaku-style'
  var ROOT_ID = 'dsh-danmaku-root'

  /* 三种红/蓝/灰只做一件事：一眼分出"成了""错了""中性"。语义靠句子本身。 */
  var ACCENT = {
    'tool:ok': '#5B93EE',
    'tool:error': '#E0646F',
    'turn:end': '#6B7684',
    'session:switch': '#6B7684',
    user: '#5FB8C9',
    assistant: '#8E7BE8',
    'assistant:final': '#E8B45C',
  }
  var FILL = {
    'tool:ok': '#11151B',
    'tool:error': '#1D1114',
    'turn:end': '#14171B',
    'session:switch': '#14171B',
    user: '#101C2A',
    assistant: '#16121F',
    'assistant:final': '#1C1710',
  }

  /* -- 样式 ------------------------------------------------------------------ */

  var CSS = [
    '#' + ROOT_ID + '{position:fixed;right:18px;bottom:128px;width:340px;display:flex;flex-direction:column;',
    'align-items:flex-end;gap:8px;pointer-events:none;z-index:2147483000;',
    'font-family:"Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5}',
    /* 隐藏态：变淡，并且**不再可点**。"别挡着我"这个状态里，一个还吞点击的淡方块是个陷阱。 */
    '#' + ROOT_ID + '.dshd-hidden .dshd-bubble{opacity:.24;pointer-events:none}',
    /* 气泡：唯一大面积可点区域，所以它是 pointer-events:auto 的那个。 */
    '.dshd-bubble{pointer-events:auto;position:relative;max-width:100%;box-sizing:border-box;padding:8px 12px;',
    'border-radius:10px;border:1px solid var(--dshd-accent);background:var(--dshd-fill);color:#F5F7FA;',
    'white-space:pre-wrap;word-break:break-word;box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer}',
    '.dshd-bubble.dshd-flat{cursor:default}',
    /* 右侧小尾巴：所有气泡都是右对齐的，尾巴指向"这颗是从右边冒出来的"。 */
    '.dshd-bubble::after{content:"";position:absolute;right:6px;bottom:-7px;width:0;height:0;',
    'border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid var(--dshd-fill)}',
    '@keyframes dshd-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.dshd-in{animation:dshd-in .16s ease-out}',
    '.dshd-stack{display:flex;flex-direction:column;align-items:flex-end;gap:12px;width:100%;pointer-events:none}',
    /* 工具行：拖动把手 + 两个按钮。 */
    '.dshd-bar{pointer-events:auto;display:flex;align-items:center;gap:6px;padding:2px 0;user-select:none}',
    '.dshd-grip{color:#5C6672;font-size:11px;letter-spacing:2px;cursor:move;padding:0 2px}',
    '.dshd-btn{pointer-events:auto;width:26px;height:22px;display:flex;align-items:center;justify-content:center;',
    'border:1px solid #3A4552;border-radius:6px;background:#141A22;color:#9AA6B4;font-size:12px;cursor:pointer;padding:0}',
    '.dshd-btn:hover{color:#DCE3EA;border-color:#5A6675}',
    '.dshd-btn.dshd-on{background:#2F6FEB;border-color:#2F6FEB;color:#FFFFFF}',
    /* 输入条：默认收起，展开后是普通的一行 + 发送。 */
    '.dshd-composer{pointer-events:auto;display:none;width:100%;box-sizing:border-box;gap:6px;align-items:center;',
    'background:#141A22;border:1px solid #3A4552;border-radius:8px;padding:6px}',
    '.dshd-composer.dshd-open{display:flex}',
    '.dshd-composer input{flex:1;min-width:0;background:#0E1218;border:1px solid #2A333E;border-radius:6px;',
    'color:#DCE3EA;font:inherit;font-size:12px;padding:5px 8px;outline:none}',
    '.dshd-composer input:focus{border-color:#2F6FEB}',
    '.dshd-send{border:none;border-radius:6px;background:#2F6FEB;color:#FFFFFF;font:inherit;font-size:12px;padding:5px 10px;cursor:pointer}',
    '.dshd-send[disabled]{opacity:.5;cursor:default}',
    /* 详情面板：阅读用的，所以它是唯一允许占大块面积的可交互区域。 */
    '.dshd-detail{pointer-events:auto;display:none;width:100%;box-sizing:border-box;background:#0E1218;',
    'border:1px solid #3A4552;border-radius:10px;overflow:hidden}',
    '.dshd-detail.dshd-open{display:block}',
    '.dshd-detail header{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#141A22;color:#8B98A5;font-size:12px}',
    '.dshd-detail header span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshd-detail pre{margin:0;padding:10px;max-height:46vh;overflow:auto;color:#DCE3EA;font-size:12px;line-height:1.6;',
    'white-space:pre-wrap;word-break:break-word;font-family:"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}',
    '.dshd-note{pointer-events:none;color:#8B98A5;font-size:11px;min-height:14px;text-align:right}',
  ].join('')

  /* -- 小工具 ---------------------------------------------------------------- */

  function element(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function readPosition() {
    try {
      var raw = window.localStorage.getItem(POS_KEY)
      if (raw === null || raw === '') return null
      var parsed = JSON.parse(raw)
      if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') return parsed
    } catch (error) {
      /* 隐私模式 / 存储被禁：没有记忆位置也不是故障。 */
    }
    return null
  }

  function savePosition(position) {
    try {
      window.localStorage.setItem(POS_KEY, JSON.stringify(position))
    } catch (error) {
      /* 同上。 */
    }
  }

  /* -- 浮层 ------------------------------------------------------------------ */

  var root = null
  var stack = null
  var detailBox = null
  var detailBody = null
  var detailTitle = null
  var composer = null
  var input = null
  var sendButton = null
  var note = null
  /** 现在跟着哪个会话——由 host 的 recent / 事件流给，前端不猜。 */
  var activeSession = ''

  function installStyle() {
    if (document.getElementById(STYLE_ID) !== null) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    ;(document.head || document.documentElement).appendChild(style)
  }

  function build() {
    root = element('div')
    root.id = ROOT_ID

    /* 详情面板在最上面：它是"点开看全文"，展开时往上长，不挤走下面正在发生的事。 */
    detailBox = element('div', 'dshd-detail')
    var header = element('header')
    detailTitle = element('span')
    var copy = element('button', 'dshd-btn', '复制')
    copy.title = '复制全文'
    var close = element('button', 'dshd-btn', '×')
    close.title = '收起（Esc）'
    header.appendChild(detailTitle)
    header.appendChild(copy)
    header.appendChild(close)
    detailBody = element('pre')
    detailBox.appendChild(header)
    detailBox.appendChild(detailBody)

    stack = element('div', 'dshd-stack')

    composer = element('div', 'dshd-composer')
    input = element('input')
    input.type = 'text'
    input.placeholder = '发一句话进会话'
    sendButton = element('button', 'dshd-send', '发送')
    composer.appendChild(input)
    composer.appendChild(sendButton)

    var bar = element('div', 'dshd-bar')
    var grip = element('div', 'dshd-grip', IS_OVERLAY ? '' : '⣿')
    grip.title = IS_OVERLAY ? '桌面 overlay 里的位置固定在工作区右下角' : '按住拖动，位置会记住'
    var eye = element('button', 'dshd-btn', '◐')
    eye.title = '淡出 / 恢复弹幕'
    var pen = element('button', 'dshd-btn', '✎')
    pen.title = '给当前会话发一句话'
    bar.appendChild(grip)
    bar.appendChild(eye)
    bar.appendChild(pen)

    note = element('div', 'dshd-note')

    root.appendChild(detailBox)
    root.appendChild(stack)
    root.appendChild(composer)
    root.appendChild(bar)
    root.appendChild(note)
    document.body.appendChild(root)

    /* 位置：DSH 页面里恢复上次拖到的地方；overlay 里固定右下角（那里拖动会断，见文件头）。 */
    if (!IS_OVERLAY) {
      var saved = readPosition()
      if (saved !== null) {
        root.style.left = saved.left + 'px'
        root.style.top = saved.top + 'px'
        root.style.right = 'auto'
        root.style.bottom = 'auto'
      }
      grip.addEventListener('mousedown', startDrag)
    } else {
      grip.style.cursor = 'default'
    }

    eye.addEventListener('click', function () {
      root.classList.toggle('dshd-hidden')
      eye.classList.toggle('dshd-on', root.classList.contains('dshd-hidden'))
      eye.title = root.classList.contains('dshd-hidden') ? '恢复弹幕' : '淡出弹幕'
    })

    pen.addEventListener('click', function () {
      var open = composer.classList.contains('dshd-open')
      composer.classList.toggle('dshd-open', !open)
      pen.classList.toggle('dshd-on', !open)
      if (!open) input.focus()
    })

    sendButton.addEventListener('click', sendPrompt)
    input.addEventListener('keydown', function (event) {
      /* Enter 直接发；Shift+Enter 留给"我这句想分两段"（虽然这里是一行输入，习惯上一致）。 */
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        sendPrompt()
      }
      if (event.key === 'Escape') {
        composer.classList.remove('dshd-open')
        pen.classList.remove('dshd-on')
      }
    })

    close.addEventListener('click', closeDetail)
    copy.addEventListener('click', function () {
      var text = detailBody.textContent || ''
      var clipboard = navigator.clipboard
      if (clipboard === undefined || clipboard === null || typeof clipboard.writeText !== 'function') {
        setNote('复制失败：浏览器不给权限')
        return
      }
      /*
       * 这里要看住 Promise 的失败分支，不能只 try/catch：剪贴板写入是异步的，
       * 权限被拒时它 reject 一个 Promise，而不是抛出来——`try` 什么都拦不到，
       * 于是"复制失败"会静默变成"什么也没发生"。
       */
      clipboard.writeText(text).then(
        function () {
          setNote('已复制 ' + text.length + ' 字')
        },
        function () {
          setNote('复制失败：浏览器不给权限')
        },
      )
    })
    /* Esc 关详情：页面里可能是 DSH 自己的快捷键，所以只在面板开着的时候拦。 */
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && detailBox.classList.contains('dshd-open')) closeDetail()
    })
  }

  function startDrag(event) {
    if (event.button !== 0) return
    var rect = root.getBoundingClientRect()
    var offsetX = event.clientX - rect.left
    var offsetY = event.clientY - rect.top
    var latest = null

    function move(moveEvent) {
      var left = Math.max(0, Math.min(moveEvent.clientX - offsetX, window.innerWidth - rect.width))
      var top = Math.max(0, Math.min(moveEvent.clientY - offsetY, window.innerHeight - rect.height))
      root.style.left = left + 'px'
      root.style.top = top + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      latest = { left: Math.round(left), top: Math.round(top) }
    }

    function up() {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      if (latest !== null) savePosition(latest)
    }

    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    event.preventDefault()
  }

  var noteTimer = null
  function setNote(text) {
    if (note === null) return
    note.textContent = text
    if (noteTimer !== null) window.clearTimeout(noteTimer)
    if (text === '') return
    noteTimer = window.setTimeout(function () {
      note.textContent = ''
    }, 6000)
  }

  /* -- 气泡 ------------------------------------------------------------------ */

  function clearBubbles() {
    if (stack === null) return
    stack.textContent = ''
  }

  function addBubble(event) {
    if (event === null || event === undefined) return
    var text = typeof event.text === 'string' ? event.text : ''
    if (text === '') return
    var kind = typeof event.kind === 'string' ? event.kind : ''

    var bubble = element('div', 'dshd-bubble dshd-in', text)
    bubble.style.setProperty('--dshd-accent', ACCENT[kind] || '#4C86E8')
    bubble.style.setProperty('--dshd-fill', FILL[kind] || FILL['tool:ok'])

    var detail = typeof event.detail === 'string' ? event.detail.trim() : ''
    /*
     * 没有详情就不给点击反馈。
     *
     * 点一颗气泡之后开出一个"正文就是气泡上那句话"的窗口，比不开更糟——那正是以前
     * 「这一轮结束了」那颗气泡干的事。所以能点开才做得像能点开。
     */
    if (detail === '') {
      bubble.classList.add('dshd-flat')
    } else {
      bubble.title = '点开看全文'
      bubble.addEventListener('click', function () {
        openDetail(text, detail)
      })
    }

    stack.appendChild(bubble)
    while (stack.children.length > MAX_BUBBLES) {
      var oldest = stack.firstElementChild || stack.children[0]
      if (oldest === null || oldest === undefined) break
      stack.removeChild(oldest)
    }
  }

  function openDetail(title, body) {
    detailTitle.textContent = title
    detailBody.textContent = body
    detailBox.classList.add('dshd-open')
    root.classList.remove('dshd-hidden')
  }

  function closeDetail() {
    detailBox.classList.remove('dshd-open')
  }

  /* -- 输入 ------------------------------------------------------------------ */

  function sendPrompt() {
    var text = (input.value || '').trim()
    if (text === '') return
    if (activeSession === '') {
      setNote('还不知道是哪个会话')
      return
    }
    sendButton.disabled = true
    sendButton.textContent = '…'
    window
      .fetch(API + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSession, text: text }),
      })
      .then(function (response) {
        return response.json()
      })
      .then(function (result) {
        if (result && result.ok === true) {
          /* 只在成功时清空：发失败还把内容吞掉，是最让人恼火的那种"贴心"。 */
          input.value = ''
          composer.classList.remove('dshd-open')
          setNote('已发送')
        } else {
          setNote(String((result && result.error) || '发送失败').slice(0, 60))
        }
      })
      .catch(function (error) {
        setNote(String((error && error.message) || error).slice(0, 60))
      })
      .then(function () {
        sendButton.disabled = false
        sendButton.textContent = '发送'
      })
  }

  /* -- 数据 ------------------------------------------------------------------ */

  function handle(event) {
    if (event === null || event === undefined) return
    if (typeof event.session === 'string' && event.session !== '') activeSession = event.session
    if (event.kind === 'session:switch') {
      /* 跟着人切会话：屏幕上的旧气泡是上一个会话的，留着就是错的。 */
      clearBubbles()
      closeDetail()
    }
    addBubble(event)
    if (input !== null && activeSession !== '') {
      input.placeholder = '发往 ' + activeSession.slice(0, 8) + '…'
    }
  }

  function backfill() {
    window
      .fetch(API + '/recent', { headers: { accept: 'application/json' } })
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        if (data === null || data === undefined) return
        if (typeof data.active === 'string' && data.active !== '') activeSession = data.active
        var events = Array.isArray(data.events) ? data.events.slice(-BACKFILL) : []
        for (var index = 0; index < events.length; index += 1) addBubble(events[index])
        if (input !== null && activeSession !== '') input.placeholder = '发往 ' + activeSession.slice(0, 8) + '…'
      })
      .catch(function () {
        /* 回填拿不到不是故障：实时流一到，屏幕上就会自己长出东西来。 */
      })
  }

  function connect() {
    var source = null
    try {
      source = new window.EventSource(API + '/stream')
    } catch (error) {
      setNote('这个环境不支持 EventSource')
      return
    }
    source.onmessage = function (message) {
      try {
        handle(JSON.parse(message.data))
      } catch (error) {
        /* 一帧读不懂就跳过，不值得把整条流掀掉。 */
      }
    }
    /*
     * 断线不用自己重连：EventSource 会。这里只在它重连成功之后补一次回填——
     * 断线期间发生的事不会重播，光靠流接上会缺一段。
     */
    source.onerror = function () {
      setNote('事件流断开，正在重连…')
    }
    source.onopen = function () {
      setNote('')
    }
  }

  function start() {
    if (document.getElementById(ROOT_ID) !== null) return
    installStyle()
    build()
    backfill()
    connect()
  }

  if (document.body !== null && document.body !== undefined) start()
  else document.addEventListener('DOMContentLoaded', start)
})()
