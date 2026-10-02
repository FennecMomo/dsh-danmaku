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
 * 唯一的例外是拖动期间那层透明遮罩（`.dshd-shield`），它故意铺满视口且可交互，理由见下。
 *
 * 位置与拖动：
 *
 *   - 位置由 **host** 保管（两个宿主读同一份），而且**永远只用 right/bottom 贴住右下角**。
 *     用 left/top 就等于把"顶边"钉死，内容一长工具行就会被推出屏幕 —— 而工具行恰恰是唯一
 *     能把它拖回来的东西。固定底边，内容才会朝上长。
 *   - overlay 里**也能拖**：拖动期间铺一层满视口的透明遮罩，让外壳的 `elementFromPoint` 判定
 *     在整段拖动里都命中"可交互"，穿透不会在中途打开把 `mousemove` 掐断（见 startDrag）。
 */
;(function () {
  'use strict'

  /* 幂等：host 的两条注入通道在 web 形态下可能都生效，重复的 <script> 不该挂出第二个浮层。 */
  if (window.__dshDanmakuLoaded === true) return
  window.__dshDanmakuLoaded = true

  var API = '/dsh-danmaku/v3'
  /*
   * 栈里最多留多少颗气泡 —— 与 host 那边每个会话的队列上限（`RECENT_PER_SESSION`）一致。
   *
   * 以前是 6，而且切会话时清空、只回填 3 条：于是"上一个会话刚才说了什么"永远找不回来
   * （主人报的正是这个）。现在每个会话的气泡都在 host 各自攒着（各 30 条），切过去就把那 30 条
   * 按顺序铺出来；一屏放不下就滚，而不是丢掉。
   */
  var MAX_BUBBLES = 30
  var IS_OVERLAY = location.pathname.indexOf('/dsh-overlay') === 0
  var STYLE_ID = 'dsh-danmaku-style'
  var ROOT_ID = 'dsh-danmaku-root'
  /** 位置由 host 保管（两个宿主共用一份），这里只是本地的当前值。 */
  var placement = { right: 18, bottom: 128 }

  /*
   * 两族颜色，故意拉开距离：
   *
   *   - **动作**（工具、一轮结束、会话切换）：低饱和的冷灰蓝、底色压暗。它们是"发生了什么"；
   *   - **说话**（你、我、最终回复）：彩色的边框 + 明显更亮的底色。它们是"谁说了什么"。
   *
   * 主人要的是"一眼分得开"，所以差别不能只有边框颜色深浅那么一点 —— 底色也一起分开。
   */
  var ACCENT = {
    'tool:ok': '#3F5A7A',
    'tool:error': '#8C4A52',
    'turn:end': '#4A545F',
    'session:switch': '#4A545F',
    user: '#4FB3C9',
    assistant: '#8E7BE8',
    'assistant:final': '#E8B45C',
  }
  var FILL = {
    'tool:ok': '#0F141B',
    'tool:error': '#1A1013',
    'turn:end': '#12161C',
    'session:switch': '#12161C',
    user: '#12303C',
    assistant: '#1E1836',
    'assistant:final': '#2C2312',
  }

  /* -- 样式 ------------------------------------------------------------------ */

  var CSS = [
    '#' + ROOT_ID + '{position:fixed;right:18px;bottom:128px;width:340px;display:flex;flex-direction:column;',
    'align-items:flex-end;gap:8px;pointer-events:none;z-index:2147483000;',
    'font-family:"Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5}',
    /* 隐藏态：变淡，并且**不再可点**。"别挡着我"这个状态里，一个还吞点击的淡方块是个陷阱。 */
    '#' + ROOT_ID + '.dshd-hidden .dshd-bubble{opacity:.24;pointer-events:none}',
    /* 气泡：唯一大面积可点区域，所以它是 pointer-events:auto 的那个。 */
    /*
     * `flex:0 0 auto` 是**必须的**，不是保险。
     *
     * 气泡栈是 `display:flex; flex-direction:column` + `max-height` + `overflow-y:auto`，
     * 而气泡自己带着 `overflow:hidden`。这两件事凑在一起就出事：flex 子项默认 `flex-shrink:1`，
     * 而 `overflow` 一旦不是 `visible`，它在主轴上的 `min-height:auto` 就解析成 0 —— 于是内容
     * 装不下时浏览器选择**把每颗气泡压扁**，而不是让容器滚起来。主人报的"信息一多气泡就像被
     * 压扁了"正是这个。钉住之后气泡永远保持自然高度，超出交给容器滚。
     */
    '.dshd-bubble{pointer-events:auto;position:relative;flex:0 0 auto;max-width:100%;box-sizing:border-box;padding:8px 12px;',
    'border-radius:10px;border:1px solid var(--dshd-accent);background:var(--dshd-fill);color:#F5F7FA;',
    /* 限高：气泡是"扫一眼"，渲染后的长消息超出部分藏在"点开看全文"里，不让它长成一篇文章。 */
    'max-height:230px;overflow:hidden;word-break:break-word;box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer}',
    /*
     * 气泡里的 Markdown：样式全部收小。
     * 尤其标题 —— 渲染成巨大的 h1 会把气泡撑爆，所以标题是"小号加粗"，只用来分层，不用来喊。
     */
    '.dshd-md p{margin:0 0 5px}',
    '.dshd-md p:last-child,.dshd-md ul:last-child,.dshd-md ol:last-child,.dshd-md pre:last-child{margin-bottom:0}',
    '.dshd-md strong{font-weight:700;color:#FFFFFF}',
    '.dshd-md em{font-style:italic}',
    '.dshd-md del{opacity:.65}',
    '.dshd-md code{font-family:"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace;font-size:12px;',
    'background:rgba(255,255,255,.10);border-radius:4px;padding:1px 4px}',
    '.dshd-md pre{margin:0 0 5px;padding:6px 8px;background:rgba(0,0,0,.35);border-radius:6px;overflow:hidden}',
    '.dshd-md pre code{background:none;padding:0;font-size:11px;line-height:1.45}',
    '.dshd-md ul,.dshd-md ol{margin:0 0 5px;padding-left:18px}',
    '.dshd-md li{margin:0 0 2px}',
    '.dshd-md blockquote{margin:0 0 5px;padding-left:8px;border-left:2px solid #3A4552;color:#B8C2CC}',
    '.dshd-md hr{border:none;border-top:1px solid #2A333E;margin:6px 0}',
    '.dshd-md a{color:#7FB6FF;text-decoration:underline}',
    '.dshd-md .dshd-md-h{font-weight:700;color:#FFFFFF;margin:0 0 4px}',
    '.dshd-bubble.dshd-flat{cursor:default}',
    /* 右侧小尾巴：所有气泡都是右对齐的，尾巴指向"这颗是从右边冒出来的"。 */
    '.dshd-bubble::after{content:"";position:absolute;right:6px;bottom:-7px;width:0;height:0;',
    'border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid var(--dshd-fill)}',
    '@keyframes dshd-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.dshd-in{animation:dshd-in .16s ease-out}',
    /*
     * 气泡栈：限高、自己滚。
     *
     * 保持 `pointer-events: none` —— 滚轮在气泡上会冒泡到这个可滚动容器，所以照样能滚；
     * 而容器整块矩形不会把桌面点击吃掉（那正是 overlay 那层费很大劲避免的事）。
     * 真正的滚动条是右边那条自己画的窄轨，理由见 build() 里的注释。
     */
    '.dshd-scroll{position:relative;width:100%;max-height:52vh}',
    '.dshd-stack{display:flex;flex-direction:column;align-items:flex-end;gap:12px;width:100%;',
    'max-height:52vh;overflow-y:auto;overflow-x:hidden;padding-right:10px;box-sizing:border-box;pointer-events:none}',
    /* 原生滚动条藏掉：容器 pointer-events:none，它拖不动，留着只会误导。 */
    '.dshd-stack::-webkit-scrollbar{width:0;height:0}',
    '.dshd-rail{display:none;position:absolute;top:0;right:0;width:8px;height:100%;',
    'pointer-events:auto;border-radius:4px;background:rgba(255,255,255,.05)}',
    '.dshd-scroll.dshd-has .dshd-rail{display:block}',
    '.dshd-thumb{position:absolute;right:0;width:8px;border-radius:4px;background:rgba(255,255,255,.22)}',
    '.dshd-rail:hover .dshd-thumb{background:rgba(255,255,255,.38)}',
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
    /*
     * 拖动期间的透明遮罩：铺满视口、可交互。
     *
     * overlay 那层窗口靠 elementFromPoint 判断"指针下有没有可交互元素"，没有就把窗口恢复成
     * 鼠标穿透。浮层容器平时是 pointer-events:none，于是指针一离开把手就被判成"空白"
     * → 穿透打开 → mousemove 断掉，拖动半途而废。这一层让整段拖动都命中"可交互"。
     */
    '.dshd-shield{position:fixed;left:0;top:0;right:0;bottom:0;display:none;pointer-events:auto}',
    '#' + ROOT_ID + '.dshd-dragging .dshd-shield{display:block}',
    /*
     * 会话菜单：绝对定位贴着工具行**往上**弹。
     * 浮层永远待在屏幕下半部分，往下弹会直接出屏。
     */
    '.dshd-menu{pointer-events:auto;position:absolute;right:0;bottom:52px;display:none;flex-direction:column;',
    'min-width:210px;max-width:330px;max-height:52vh;overflow:auto;box-sizing:border-box;padding:4px;',
    'background:#0E1218;border:1px solid #3A4552;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.45)}',
    '.dshd-menu.dshd-open{display:flex}',
    '.dshd-menu-head{padding:5px 8px 6px;margin-bottom:4px;border-bottom:1px solid #232B36;color:#5C6672;font-size:11px}',
    /* 同一类坑：菜单也是"限高的 flex 滚动容器"，谁给菜单项加上 overflow 就会重演压扁。 */
    '.dshd-item{flex:0 0 auto;display:flex;flex-direction:column;gap:1px;width:100%;box-sizing:border-box;text-align:left;',
    'background:transparent;border:none;border-radius:6px;padding:6px 8px;color:#DCE3EA;font:inherit;font-size:12px;cursor:pointer}',
    '.dshd-item:hover{background:#1A2230}',
    '.dshd-item.dshd-current{background:#1B2B47}',
    '.dshd-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshd-item-sub{color:#8B98A5;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshd-empty{padding:8px;color:#6B7684;font-size:11px}',
  ].join('')

  /* -- 小工具 ---------------------------------------------------------------- */

  function element(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  /* -- Markdown ---------------------------------------------------------------- */

  /*
   * 气泡**渲染** Markdown，而不是把标记洗掉。
   *
   * 洗掉是走不通的：Markdown 的写法太多（嵌套强调、行内代码混在列表里、缩进、表格…），
   * 漏掉任何一种都会在气泡上露出半截符号，而且"少洗一个"和"多洗一个"都很难被发现。
   * 渲染则是把它变回它本来的样子。
   *
   * 为什么自己写而不是引库：这份脚本必须**自包含** —— 它同时跑在 DSH 页面和 overlay 页面里，
   * 不能 require 任何东西，也不该为了一段消息去下载一个解析器。会话消息里真正会出现的标记
   * 就这几种，够用就好。
   *
   * **安全**：先把整段文本里的 `&` `<` `>` `"` 全部转义，再插入这个文件自己生成的标签。
   * 所以消息内容无论写什么，都只会是**文字**，不存在"内容被当成 HTML 执行"的路径；
   * 链接另外限制协议（只认 http/https 和相对路径，`javascript:` 之类丢掉链接、只留文字）。
   */

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** 只放行 http/https 与相对路径；其它协议（javascript:、data: …）返回空串，调用方只留文字。 */
  function safeUrl(url) {
    var trimmed = String(url).trim()
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return ''
    return trimmed
  }

  /** 行内标记。入参**必须**是已经转义过的文本。 */
  function inlineMarkdown(escaped) {
    var out = escaped
    /* 行内代码先做：它里面的 `*` `_` 不该再被当成强调。 */
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (whole, label, url) {
      var href = safeUrl(url)
      if (href === '') return label
      return '<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + label + '</a>'
    })
    return out
  }

  /**
   * 极简 Markdown → HTML（块级 + 行内）。返回值可以直接塞进 `innerHTML`。
   *
   * 支持的：段落、`#` 标题（渲染成统一样式的小标题，不是巨大的 h1）、有序/无序列表、引用、
   * 围栏代码块、行内代码、加粗/斜体/删除线、链接、水平线。
   * 不支持的（表格、图片、嵌套列表）就按普通文字显示 —— 它们本来就少见，气泡也不是阅读器。
   */
  function markdownToHtml(input) {
    var lines = String(input === null || input === undefined ? '' : input).replace(/\r\n?/g, '\n').split('\n')
    var out = []
    var paragraph = []
    var list = null
    var quote = []
    var code = null

    function flushParagraph() {
      if (paragraph.length === 0) return
      /* 段落内的换行照原样保留：中文消息里一个换行通常就是"换行"，不是"接着往下写"。 */
      out.push(
        '<p>' +
          paragraph
            .map(function (line) {
              return inlineMarkdown(escapeHtml(line))
            })
            .join('<br>') +
          '</p>',
      )
      paragraph = []
    }
    function flushList() {
      if (list === null) return
      out.push('</' + list + '>')
      list = null
    }
    function flushQuote() {
      if (quote.length === 0) return
      out.push(
        '<blockquote>' +
          quote
            .map(function (line) {
              return inlineMarkdown(escapeHtml(line))
            })
            .join('<br>') +
          '</blockquote>',
      )
      quote = []
    }
    function flushAll() {
      flushParagraph()
      flushList()
      flushQuote()
    }

    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index]
      var isFence = /^\s*```/.test(line)

      if (code !== null) {
        if (isFence) {
          out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>')
          code = null
        } else {
          code.push(line)
        }
        continue
      }
      if (isFence) {
        flushAll()
        code = []
        continue
      }
      if (/^\s*$/.test(line)) {
        flushAll()
        continue
      }

      var heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
      if (heading !== null) {
        flushAll()
        out.push('<div class="dshd-md-h">' + inlineMarkdown(escapeHtml(heading[2])) + '</div>')
        continue
      }

      if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushAll()
        out.push('<hr>')
        continue
      }

      var bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line)
      if (bullet !== null) {
        flushParagraph()
        flushQuote()
        if (list !== 'ul') {
          flushList()
          out.push('<ul>')
          list = 'ul'
        }
        out.push('<li>' + inlineMarkdown(escapeHtml(bullet[1])) + '</li>')
        continue
      }

      var numbered = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line)
      if (numbered !== null) {
        flushParagraph()
        flushQuote()
        if (list !== 'ol') {
          flushList()
          out.push('<ol>')
          list = 'ol'
        }
        out.push('<li>' + inlineMarkdown(escapeHtml(numbered[1])) + '</li>')
        continue
      }

      var quoted = /^\s{0,3}>\s?(.*)$/.exec(line)
      if (quoted !== null) {
        flushParagraph()
        flushList()
        quote.push(quoted[1])
        continue
      }

      paragraph.push(line.replace(/^\s+/, ''))
    }

    if (code !== null) out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>')
    flushAll()
    return out.join('')
  }

  /**
   * 把浮层挪到 host 记下的位置。
   *
   * **永远只用 right/bottom 贴住右下角。** 用 left/top 就等于把"顶边"钉死，内容一长就往
   * 下长，工具行被推出屏幕 —— 而工具行恰恰是唯一能把它拖回来的东西（主人报的第 4 条）。
   * 朝哪边延伸由"哪条边被固定"决定：固定底边，就朝上长。
   */
  function applyPlacement(next) {
    if (next === null || next === undefined) return
    var right = Number(next.right)
    var bottom = Number(next.bottom)
    if (!isFinite(right) || !isFinite(bottom) || right < 0 || bottom < 0) return
    placement = { right: right, bottom: bottom }
    if (root === null) return
    root.style.left = 'auto'
    root.style.top = 'auto'
    root.style.right = right + 'px'
    root.style.bottom = bottom + 'px'
  }

  /** 把新位置报给 host —— 它会广播给另一个宿主，两边的浮层才不会各待各的。 */
  function postPlace(next) {
    window
      .fetch(API + '/place', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      .then(function (response) {
        return response.json()
      })
      .catch(function () {
        /* 位置没记上不是故障：这一次拖动照样有效，下次再拖会再报一次。 */
      })
  }

  /* -- 浮层 ------------------------------------------------------------------ */

  var root = null
  var stack = null
  /** 包着气泡栈的滚动容器，以及它右侧那条自己画的滚动条（原生那条在 overlay 里拖不动）。 */
  var scrollBox = null
  var rail = null
  var thumb = null
  var detailBox = null
  var detailBody = null
  var detailTitle = null
  var composer = null
  var input = null
  var sendButton = null
  var note = null
  var menu = null
  var menuButton = null
  /** 现在跟着哪个会话——由 host 的 recent / 事件流给，前端不猜。 */
  var activeSession = ''
  /** host 那边钉住的会话；空串 = 自动跟随。这个也只有 host 说了算。 */
  var focusedSession = ''
  /** 最近一次拉到的会话列表。打开菜单先用它画一版，再去拉最新的。 */
  var sessionRows = []

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

    /*
     * 气泡栈外面包一层滚动容器，右侧是自己画的滚动条。
     *
     * 为什么不用原生那条：容器必须是 `pointer-events: none`（否则它整块矩形会把桌面点击全吃掉，
     * 正是 overlay 那层费很大劲避免的事），而 `pointer-events: none` 的元素**拖不动**自己的
     * 滚动条。所以滚动条做成一个独立的、只有 8px 宽的窄条：它自己可交互，而滚轮照样能在气泡上
     * 滚（滚轮事件会冒泡到可滚动的祖先）。
     */
    scrollBox = element('div', 'dshd-scroll')
    stack = element('div', 'dshd-stack')
    rail = element('div', 'dshd-rail')
    thumb = element('div', 'dshd-thumb')
    rail.appendChild(thumb)
    scrollBox.appendChild(stack)
    scrollBox.appendChild(rail)

    composer = element('div', 'dshd-composer')
    input = element('input')
    input.type = 'text'
    input.placeholder = '发一句话进会话'
    sendButton = element('button', 'dshd-send', '发送')
    composer.appendChild(input)
    composer.appendChild(sendButton)

    var bar = element('div', 'dshd-bar')
    var grip = element('div', 'dshd-grip', '⣿')
    grip.title = '按住拖动，位置两个窗口共用'
    menuButton = element('button', 'dshd-btn', '☰')
    menuButton.title = '选择要看哪个会话的弹幕'
    var eye = element('button', 'dshd-btn', '◐')
    eye.title = '淡出 / 恢复弹幕'
    var pen = element('button', 'dshd-btn', '✎')
    pen.title = '给当前会话发一句话'
    bar.appendChild(grip)
    bar.appendChild(menuButton)
    bar.appendChild(eye)
    bar.appendChild(pen)

    /* 菜单挂在 root 上、靠绝对定位浮在工具行上方：它是覆盖层，不该参与 flex 布局把气泡顶上去。 */
    menu = element('div', 'dshd-menu')

    note = element('div', 'dshd-note')

    root.appendChild(detailBox)
    root.appendChild(scrollBox)
    root.appendChild(composer)
    root.appendChild(bar)
    root.appendChild(note)
    root.appendChild(menu)
    /* 拖动遮罩：平时 display:none，只有加上 .dshd-dragging 时才铺开（见 startDrag）。 */
    root.appendChild(element('div', 'dshd-shield'))
    document.body.appendChild(root)

    /*
     * 位置：host 记着的那一份（两个宿主共用）。grip 在**两边**都能拖 —— overlay 里靠
     * `.dshd-shield` 把穿透判定按住不放，见 startDrag。
     */
    applyPlacement(placement)
    grip.addEventListener('mousedown', startDrag)

    menuButton.addEventListener('click', toggleMenu)

    /* 滚动：栈自己滚时同步滚动条；拖那条窄轨也能滚（在 overlay 里就靠它）。 */
    stack.addEventListener('scroll', syncScrollbar)
    rail.addEventListener('mousedown', startRailDrag)

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
      if (event.key !== 'Escape') return
      if (detailBox.classList.contains('dshd-open')) closeDetail()
      closeMenu()
    })

    /*
     * 点别处收起菜单。
     *
     * 用 mousedown 而不是 click：click 要等菜单项自己的处理器跑完才冒到这里，那时菜单已经被
     * `chooseSession` 关掉了——行为上看着一样，但"点空白"和"点菜单项"会走两条不同的路径，
     * 早晚有一条会出错。
     */
    document.addEventListener('mousedown', function (event) {
      if (menu === null || !menu.classList.contains('dshd-open')) return
      var target = event.target
      if (target === menuButton || (menuButton !== null && menuButton.contains(target))) return
      if (menu.contains(target)) return
      closeMenu()
    })
  }

  function startDrag(event) {
    if (event.button !== 0) return
    var rect = root.getBoundingClientRect()
    /* 抓住的是"右下角"：指针距 root 右边缘、下边缘各多远，整段拖动里保持不变。 */
    var offsetRight = rect.right - event.clientX
    var offsetBottom = rect.bottom - event.clientY
    var latest = null

    function move(moveEvent) {
      /* 夹在视口里，但至少留 40px 能看见、能抓住，免得拖出去再也点不到。 */
      var right = Math.max(
        0,
        Math.min(window.innerWidth - (moveEvent.clientX + offsetRight), Math.max(0, window.innerWidth - 40)),
      )
      var bottom = Math.max(
        0,
        Math.min(window.innerHeight - (moveEvent.clientY + offsetBottom), Math.max(0, window.innerHeight - 40)),
      )
      root.style.left = 'auto'
      root.style.top = 'auto'
      root.style.right = right + 'px'
      root.style.bottom = bottom + 'px'
      latest = { right: Math.round(right), bottom: Math.round(bottom) }
    }

    function up() {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      root.classList.remove('dshd-dragging')
      if (latest !== null) postPlace(latest)
    }

    /*
     * 拖动期间铺一层透明遮罩（`.dshd-shield`）。
     *
     * 这不是为了好看：在 overlay 那层窗口里，外壳每 40ms 用 `elementFromPoint` 判断"指针下有没有
     * 可交互元素"，没有就把窗口恢复成鼠标穿透。浮层容器平时是 `pointer-events:none`，于是指针
     * 一离开把手就被判成空白 → 穿透打开 → `mousemove` 断掉，拖动半途而废。遮罩铺满视口又
     * 可交互，整段拖动里判定都命中它 —— 这就是 overlay 里终于拖得动的原因。
     */
    root.classList.add('dshd-dragging')
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

  /* -- 滚动 ------------------------------------------------------------------ */

  /** 栈是不是已经贴底（留点容差，免得像素取整让它永远差一两个像素）。 */
  function atBottom() {
    if (stack === null) return true
    return stack.scrollHeight - stack.scrollTop - stack.clientHeight < 24
  }

  /**
   * 滚到底。
   *
   * `force` 用在"刚切过来 / 刚回填完"：那时应当直接看到最新的。平时（新气泡进来）只有用户
   * 本来就贴底时才跟着滚 —— 他要是正在往上翻历史，一条新消息把他拽回底部是很讨厌的。
   */
  function scrollToBottom(force) {
    if (stack === null) return
    if (force === true || atBottom()) stack.scrollTop = stack.scrollHeight
    syncScrollbar()
  }

  /** 把滑块摆到该在的位置；内容没超出一屏时整条藏起来。 */
  function syncScrollbar() {
    if (scrollBox === null || stack === null || rail === null || thumb === null) return
    var view = stack.clientHeight
    var full = stack.scrollHeight
    var overflow = full - view
    if (overflow <= 4) {
      scrollBox.classList.remove('dshd-has')
      return
    }
    scrollBox.classList.add('dshd-has')
    var thumbHeight = Math.max(28, Math.round((view / full) * view))
    var maxTop = Math.max(0, view - thumbHeight)
    var ratio = overflow <= 0 ? 0 : Math.max(0, Math.min(1, stack.scrollTop / overflow))
    thumb.style.height = thumbHeight + 'px'
    thumb.style.top = Math.round(ratio * maxTop) + 'px'
  }

  /**
   * 拖那条窄轨。
   *
   * 抓在滑块上就按位移滚，抓在轨道空白处就把滑块中心挪到指针那儿（和原生滚动条一个手感）。
   * 拖动期间同样挂 `.dshd-dragging`：overlay 里的透明遮罩会把穿透按住，否则指针一离开这
   * 8px 宽的小条，穿透打开、`mousemove` 就断了。
   */
  function startRailDrag(event) {
    if (event.button !== 0 || stack === null || rail === null || thumb === null) return
    var view = stack.clientHeight
    var full = stack.scrollHeight
    var maxScroll = full - view
    if (maxScroll <= 0) return

    var railTop = rail.getBoundingClientRect().top
    var thumbHeight = thumb.getBoundingClientRect().height
    var maxTop = Math.max(1, view - thumbHeight)
    var grabbing = event.target === thumb
    var startY = event.clientY
    var startScroll = stack.scrollTop

    function move(moveEvent) {
      var next
      if (grabbing === true) {
        next = startScroll + ((moveEvent.clientY - startY) / maxTop) * maxScroll
      } else {
        next = ((moveEvent.clientY - railTop - thumbHeight / 2) / maxTop) * maxScroll
      }
      stack.scrollTop = Math.max(0, Math.min(maxScroll, next))
      syncScrollbar()
    }

    function up() {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      root.classList.remove('dshd-dragging')
    }

    root.classList.add('dshd-dragging')
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    event.preventDefault()
  }

  /* -- 气泡 ------------------------------------------------------------------ */

  function clearBubbles() {
    if (stack === null) return
    stack.textContent = ''
    /* 换会话时滚动位置也归零：新会话的气泡是从头铺的，不该继承上一个的位置。 */
    stack.scrollTop = 0
    if (scrollBox !== null) scrollBox.classList.remove('dshd-has')
  }

  /** `quiet` 给批量回填用：先别急着滚，等整批铺完再滚一次（省掉几十次 layout）。 */
  function addBubble(event, quiet) {
    if (event === null || event === undefined) return
    var text = typeof event.text === 'string' ? event.text : ''
    if (text === '') return
    var kind = typeof event.kind === 'string' ? event.kind : ''
    var detail = typeof event.detail === 'string' ? event.detail.trim() : ''

    /*
     * 渲染源：说话类事件用 `detail`（那是**原文**，Markdown 完好），其余用 `text`。
     *
     * 说话类为什么不用 `text`：host 那边的 `text` 是"洗掉标记、截到 260 字"的版本，它现在
     * 专门留给 `☰` 菜单当预览用（菜单要的就是一行纯文本）。渲染 Markdown 需要原文，而原文
     * 一直在 `detail` 里 —— 所以这一版前端不必等 host 配合，刷新页面就生效。
     */
    var markdownKinds = { user: true, assistant: true, 'assistant:final': true, 'turn:end': true }
    var source = markdownKinds[kind] === true && detail !== '' ? detail : text

    var bubble = element('div', 'dshd-bubble dshd-in')
    var body = element('div', 'dshd-md')
    body.innerHTML = markdownToHtml(source)
    bubble.appendChild(body)
    bubble.style.setProperty('--dshd-accent', ACCENT[kind] || '#4C86E8')
    bubble.style.setProperty('--dshd-fill', FILL[kind] || FILL['tool:ok'])

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

    /*
     * **先**记下"加之前贴不贴底"，再加。
     *
     * 反过来的话：appendChild 之后内容已经变高了，而 scrollTop 还是旧值，于是 `atBottom()`
     * 必然算出"没贴底" —— 结果是新消息永远不跟着滚（实测差了两三颗气泡的高度）。
     */
    var wasAtBottom = atBottom()
    stack.appendChild(bubble)
    while (stack.children.length > MAX_BUBBLES) {
      var oldest = stack.firstElementChild || stack.children[0]
      if (oldest === null || oldest === undefined) break
      stack.removeChild(oldest)
    }
    if (quiet !== true && wasAtBottom) scrollToBottom(true)
  }

  function openDetail(title, body) {
    detailTitle.textContent = title
    /* 详情同样渲染 —— 那里才是读全文的地方，更该是渲染后的样子。 */
    detailBody.innerHTML = markdownToHtml(body)
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

  /* -- 会话菜单 -------------------------------------------------------------- */

  function relativeTime(at) {
    if (typeof at !== 'number' || at <= 0) return ''
    var seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (seconds < 60) return '刚刚'
    var minutes = Math.round(seconds / 60)
    if (minutes < 60) return minutes + ' 分钟前'
    var hours = Math.round(minutes / 60)
    if (hours < 24) return hours + ' 小时前'
    return Math.round(hours / 24) + ' 天前'
  }

  function updateMenuButton() {
    if (menuButton === null) return
    menuButton.classList.toggle('dshd-on', focusedSession !== '')
    menuButton.title =
      focusedSession === '' ? '选择要看哪个会话的弹幕（现在：自动跟随）' : '正钉在一个会话上，点这里换'
  }

  function renderMenu() {
    if (menu === null) return
    menu.textContent = ''
    menu.appendChild(element('div', 'dshd-menu-head', '看哪个会话的弹幕'))

    /*
     * 这里**没有"自动跟随"这一项**：主人要的是"选定一个会话就别再自己换"。
     * 没选过之前 host 会落位一次（落到第一个开口的会话），那之后画面就固定在那儿了。
     */
    if (sessionRows.length === 0) {
      menu.appendChild(element('div', 'dshd-empty', '还没有会话可选（等它说句话）'))
      return
    }

    sessionRows.forEach(function (row) {
      var current = focusedSession === row.id
      var item = element('button', 'dshd-item' + (current ? ' dshd-current' : ''))
      /*
       * 有标题就用标题，没有就退回 id **尾部** —— 注意是尾部：所有会话 id 都以 `session-` 开头，
       * 取前八位等于每个会话都显示成同一串 "session-…"，一点区分度都没有。
       */
      item.appendChild(element('div', 'dshd-item-title', row.title || '…' + row.id.slice(-8)))
      /*
       * 副行：多久之前 + 最后一句。本进程还没见它说过话的会话（例如重启前活跃过的那些）
       * 没有这两样，写"没有动静"而不是留空 —— 空行看起来像渲染坏了。
       */
      var parts = [row.lastAt ? relativeTime(row.lastAt) : '没有动静']
      if (row.lastText) parts.push(row.lastText)
      item.appendChild(element('div', 'dshd-item-sub', parts.join(' · ')))
      /* 完整 id 挂在 title 上：短 id 是用来认人的，要复制/核对时还得看全的。 */
      item.title = row.id
      item.addEventListener('click', function () {
        chooseSession(row.id)
      })
      menu.appendChild(item)
    })
  }

  function refreshSessions() {
    window
      .fetch(API + '/sessions', { headers: { accept: 'application/json' } })
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        if (data === null || data === undefined) return
        if (typeof data.focused === 'string') focusedSession = data.focused
        if (typeof data.active === 'string' && data.active !== '') activeSession = data.active
        sessionRows = Array.isArray(data.sessions) ? data.sessions : []
        updateMenuButton()
        renderMenu()
      })
      .catch(function () {
        setNote('拿不到会话列表')
      })
  }

  function closeMenu() {
    if (menu !== null) menu.classList.remove('dshd-open')
  }

  function toggleMenu() {
    if (menu === null) return
    if (menu.classList.contains('dshd-open')) {
      closeMenu()
      return
    }
    /* 先用手上的列表画一版（点开就有东西），再去拉最新的把内容换掉。 */
    renderMenu()
    menu.classList.add('dshd-open')
    refreshSessions()
  }

  function chooseSession(sessionId) {
    closeMenu()
    window
      .fetch(API + '/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      })
      .then(function (response) {
        return response.json()
      })
      .then(function (result) {
        if (result === null || result === undefined || result.ok !== true) {
          setNote(String((result && result.error) || '切换失败').slice(0, 60))
          return
        }
        focusedSession = typeof result.focused === 'string' ? result.focused : ''
        updateMenuButton()
        /*
         * host 已经推了一条 session:switch 给所有前端（包括我们自己），气泡会在那条消息里被清空。
         * 这里再补一次回填：事件流只从"现在"开始，不回填的话切过去是一片空白——
         * 而那恰恰是刚点了菜单的人最想看的东西。
         */
        clearBubbles()
        closeDetail()
        backfill()
      })
      .catch(function (error) {
        setNote(String((error && error.message) || error).slice(0, 60))
      })
  }

  /* -- 数据 ------------------------------------------------------------------ */

  function handle(event) {
    if (event === null || event === undefined) return
    if (event.kind === 'place') {
      /* 另一个窗口把浮层拖走了：跟着挪，但**不长气泡** —— 它是位置，不是"发生了什么"。 */
      applyPlacement({ right: event.right, bottom: event.bottom })
      return
    }
    if (typeof event.session === 'string' && event.session !== '') activeSession = event.session
    if (event.kind === 'session:switch') {
      /* 换会话了：屏幕上的旧气泡是上一个会话的，留着就是错的。 */
      clearBubbles()
      closeDetail()
    }
    addBubble(event)
    if (input !== null && activeSession !== '') {
      /* 同样取尾部：`session-` 那个前缀对认人毫无帮助。 */
      input.placeholder = '发往 …' + activeSession.slice(-8)
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
        /* 回填顺带把"现在选的是谁"同步过来：刷新之后按钮的状态不该靠猜。 */
        if (typeof data.focused === 'string') {
          focusedSession = data.focused
          updateMenuButton()
        }
        /* 位置也由 host 保管：两个宿主共用一份，所以拖一边另一边会跟着走。 */
        if (data.place !== undefined && data.place !== null) applyPlacement(data.place)
        /*
         * **整个队列都铺出来**（host 那边每个会话各攒 30 条）—— 这就是"切过去还看得见上文"。
         * 一屏放不下就滚，不再截断成 3 条。
         */
        var events = Array.isArray(data.events) ? data.events : []
        for (var index = 0; index < events.length; index += 1) addBubble(events[index], true)
        /* 整批铺完再滚一次：切过来先看到最新的那几颗。 */
        scrollToBottom(true)
        if (input !== null && activeSession !== '') input.placeholder = '发往 …' + activeSession.slice(-8)
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
