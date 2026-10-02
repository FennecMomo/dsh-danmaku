/**
 * dsh-danmaku —— host 半边
 *
 * 弹幕以前是一个自己画的 Win32 悬浮窗（layered window + GDI 逐像素 alpha + 光标轮询点击）。
 * 那整套东西存在的唯一理由，是「要一个透明、置顶、点得到下面的窗口」；而这件事现在由
 * `dsh-desktop-overlay` 的 Electron 外壳负责了。于是这里退化成一件普通得多的事：
 *
 *   1. 把会话正在发生的事**读成一句话**（调了哪个工具、动了哪个文件、这轮有没有答完）；
 *   2. **广播**给前端：SSE 实时流 + recent 回填，两条路都是普通 HTTP；
 *   3. 把前端脚本**塞进页面**——塞两处：DSH 自己的 index，以及 overlay 页面
 *      （后者由 overlay 的白名单引入，见 dsh-desktop-overlay 的 `WHITELIST`）。
 *
 * 透明、置顶、鼠标穿透、点击判定，全部归 overlay；这个文件里没有一行 Win32、
 * 没有子进程、没有状态文件、没有停止脚本。
 *
 *     GET  /dsh-danmaku/v3/bubbles.js   前端本体（按 mtime 热读，改完刷新页面即生效）
 *     GET  /dsh-danmaku/v3/stream       SSE，实时事件
 *     GET  /dsh-danmaku/v3/recent       JSON 回填（含「现在是哪个会话」）
 *     GET  /dsh-danmaku/v3/sessions     会话列表（浮层上那个会话选择菜单的数据源）
 *     POST /dsh-danmaku/v3/focus        选定要看哪个会话
 *     POST /dsh-danmaku/v3/place        记下浮层的位置（距视口右下角多少像素）
 *     POST /dsh-danmaku/v3/send         把一句话发进会话（前端那条折叠输入框用）
 *     GET  /dsh-danmaku/v3/status       诊断：活跃会话、会话表、位置、客户端数、前端文件状态
 *
 * 每条路由都走 `ctx.effect`，所以插件停用/更新时八条一起撤掉。留下一条还在应答的路由，
 * 就是一个插件"该走了却还在说话"的样子。
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 前端本体就在这个文件旁边，按 mtime 热读：改前端只要刷新页面，不必重启 DSH。 */
const FRONT_FILE = join(HERE, 'bubbles.js')

const MOUNT = '/dsh-danmaku/v3'
const FRONT_URL = `${MOUNT}/bubbles.js`

/** 自动模式下回填多少条（所有会话混起来按时间排）。这是一份"补课"，不是历史。 */
const RECENT_LIMIT = 120
/** 每个会话各留多少条：钉住一个安静会话时，它那几条不该被别人的刷掉。 */
const RECENT_PER_SESSION = 30
/** 会话表最多记多少个，免得两个 Map 跟着进程寿命无限长。 */
const SESSION_MEMORY = 64
/** 「上一轮说了什么」最多记住几个会话。 */
const ANSWER_MEMORY = 32

// --------------------------------------------------------------------------- //
// 前端脚本：读盘 + 注入页面
// --------------------------------------------------------------------------- //

let cachedFrontend = null

/**
 * 按 mtime 热读前端脚本。
 *
 * 常驻缓存过一次，结果是"改了前端但页面还是旧的"，而且看起来像没保存。mtime 比较很便宜，
 * 换掉的是整类"改完不生效"的困惑。
 */
function loadFrontend() {
  try {
    const stat = statSync(FRONT_FILE)
    if (cachedFrontend !== null && cachedFrontend.mtimeMs === stat.mtimeMs) return cachedFrontend.text
    const text = readFileSync(FRONT_FILE, 'utf8')
    cachedFrontend = { mtimeMs: stat.mtimeMs, size: stat.size, text }
    return text
  } catch (error) {
    // 读不到就退回上一次的内容（总比给页面一段语法错误的空字符串好），并留下痕迹。
    console.error('[dsh-danmaku] 读不到前端脚本：', String(error?.message ?? error))
    return cachedFrontend === null ? '/* dsh-danmaku: frontend bundle missing */' : cachedFrontend.text
  }
}

/**
 * 桌面端（Electron）的注入行，**必须是一段内联 script**，不能是 `script-src` 行。
 *
 * 桌面壳的 index.html 从安装包静态 dist 直出，`tapIndex`（函数变换）永远不经过它，
 * 唯一通道是 `webserver/index-inject` 推的结构化行；而页面侧解释器对两种 script 行的
 * 处理是不对称的：`script` 行是 createElement + textContent，没有 await，不可能失败；
 * `script-src` 行是 await loadScript(src)，**加载失败会 reject 掉 __DSH_BOOT_READY__，
 * 整个应用起不来**（whale-widget 的 issue #154 就是这条）。
 *
 * 我们的路由在插件停用后就是 404，所以这里自己建标签、自己吞掉 onerror：
 * 路由在就正常加载，路由不在就静默失败——宿主永远不会因为我们起不来。
 *
 * 另外，那张注入表是宿主**启动时一次性收集**的，所以这一行必须在 `apply()` 一开头注册，
 * 不能等 service 就绪（等到了就赶不上收集了，症状是"桌面端弹幕从不出现"）。
 */
const INLINE_LOADER =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  `var s=document.createElement("script");s.src="${FRONT_URL}";` +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// --------------------------------------------------------------------------- //
// 帧辅助
// --------------------------------------------------------------------------- //

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      // 这个插件接受的唯一 body 是一个小 JSON 对象。比这更大的不是给它的请求，
      // 直接丢，不缓冲。
      if (size > 64 * 1024) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

// --------------------------------------------------------------------------- //
// 事件 → 一句话
//
// 这段是从原来那份 Python 面板里搬过来的（它当时负责把原始事件读成气泡上的句子）。
// 搬到 host 的理由有两个：前端因此薄得只剩渲染；而且"同一件事该怎么说"只在一个地方决定，
// DSH 页面里的那份和桌面 overlay 里的那份不可能说法不一样。
// --------------------------------------------------------------------------- //

const TOOL_VERBS = {
  read: '正在读取',
  read_image: '正在看图片',
  write: '正在写入',
  edit: '正在修改',
  glob: '正在查找文件',
  grep: '正在搜索',
  pwsh: '正在执行命令',
  bash: '正在执行命令',
  web_search: '正在搜索网络',
  web_fetch: '正在抓取网页',
  todo_write: '正在更新任务清单',
  ask_user_question: '正在向你提问',
  skill: '正在加载技能',
  task: '正在派发子任务',
  subagent: '正在派发子代理',
  subagent_fork: '正在派发子代理',
  send_message: '正在给子代理发消息',
  workflow: '正在编排工作流',
  ralph: '正在跑 Ralph 循环',
  present: '正在交付文件',
  list_agents: '正在查看子代理',
  interrupt_agent: '正在中断子代理',
  cordis_define: '正在定义插件',
  cordis_run: '正在运行插件',
  cordis_stop: '正在停止插件',
  cordis_undefine: '正在删除插件',
  cordis_inspect_query: '正在查询接口',
  cordis_inspect_self: '正在查看插件状态',
  cordis_inspect_list: '正在列出接口',
  mcp__unity__execute_code: '正在 Unity 里执行代码',
  mcp__unity__batch_execute: '正在批量操作 Unity',
  mcp__unity__manage_gameobject: '正在编辑 Unity 物体',
  mcp__unity__manage_components: '正在编辑 Unity 组件',
  mcp__unity__manage_scene: '正在操作 Unity 场景',
  mcp__unity__manage_asset: '正在操作 Unity 资源',
}

/**
 * 哪个参数会变成气泡的"对象"，按优先级排。
 *
 * `description` 故意排在 `command` 前面：一条 shell 调用两个都有，而它们读起来天差地别——
 * description 是一句人话（"核对事件字段"），command 是整段脚本（换行、赋值、引号）。
 * 把后者截断到气泡长度，会从半个 token 处切开，得到的是一屏噪音，信息量还不如那句描述。
 * 完整的命令仍然留在详情里，那才是长内容该待的地方。
 */
const SUBJECT_KEYS = [
  'description',
  'objective',
  'pattern',
  'query',
  'queries',
  'file_path',
  'path',
  'url',
  'search_term',
  'menu_path',
  'tool_name',
  'command',
  'name',
  'packageId',
  'pluginId',
  'action',
  'mode',
  'reason',
]

/** 永远不当对象、也不值得报告的参数：文件正文与替换文本又大又不可读。 */
const NOISE_KEYS = new Set(['content', 'new_string', 'old_string', 'oldText', 'newText'])
const FILE_KEYS = new Set(['file_path', 'path'])

/** 详情里单个参数值的截断长度。 */
const DETAIL_VALUE_LIMIT = 1600

function verbFor(name) {
  if (Object.hasOwn(TOOL_VERBS, name)) return TOOL_VERBS[name]
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    if (parts.length >= 3) return `正在 ${parts[1]} · ${parts[2]}`
  }
  return `正在调用 ${name}`
}

function shorten(value, limit = 90) {
  const text = String(value ?? '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ')
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function tailPath(path, keep = 2) {
  const normalized = String(path).replace(/\\/g, '/')
  const parts = normalized.split('/').filter((part) => part !== '')
  return parts.length > keep ? parts.slice(-keep).join('/') : normalized
}

function subjectOf(args) {
  if (args === null || args === undefined || typeof args !== 'object') return { subject: null, key: null }
  for (const key of SUBJECT_KEYS) {
    if (NOISE_KEYS.has(key)) continue
    const value = args[key]
    if (value === null || value === undefined || value === '' || value === 0) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      const joined = value.filter((item) => item !== null && item !== undefined && item !== '').map(String).join(' / ')
      if (joined === '') continue
      return { subject: shorten(joined), key }
    }
    return { subject: shorten(value), key }
  }
  return { subject: null, key: null }
}

/** 一棵工具调用参数的完整文本，给详情面板。每个值都截断，一条巨型命令不至于毁掉可读性。 */
function describeCall(args) {
  if (args === null || args === undefined) return ''
  if (typeof args !== 'object') return String(args).slice(0, DETAIL_VALUE_LIMIT)
  const lines = []
  for (const key of Object.keys(args)) {
    const value = args[key]
    if (value === null || value === undefined) continue
    const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    if (typeof rendered !== 'string' || rendered === '') continue
    const clipped =
      rendered.length > DETAIL_VALUE_LIMIT
        ? `${rendered.slice(0, DETAIL_VALUE_LIMIT)}\n… （已截断，共 ${rendered.length} 字）`
        : rendered
    lines.push(`${key}:\n${clipped}`)
  }
  return lines.join('\n\n')
}

/** 这一轮没产生回复时，用一句话解释为什么。 */
function turnEndDetail(reason) {
  const wording = {
    aborted: '这一轮被中止了，没有产生回复。',
    interrupted: '这一轮被打断了，没有产生回复。',
    error: '这一轮出错了，没有产生回复。',
    blocked: '这一轮被阻止了，没有产生回复。',
    'max-tokens': '输出达到上限，回复被截断了。',
    completed: '这一轮结束了，但没有文本回复。',
  }
  return wording[reason] ?? `这一轮结束了（${reason}），没有产生回复。`
}

function turnEndSentence(reason) {
  const wording = {
    completed: '这一轮结束了',
    aborted: '这一轮被中止',
    error: '这一轮出错了',
    interrupted: '这一轮被打断',
    blocked: '这一轮被阻止',
    'max-tokens': '输出达到上限',
  }
  return wording[reason] ?? `这一轮结束了（${reason}）`
}

/**
 * 把 Markdown 标记去掉，只留字。
 *
 * 气泡**不渲染** Markdown —— 它是一个"扫一眼"的窗口，不是阅读器。既然不渲染，`**加粗**`、
 * 反引号、`##` 这些照原样显示出来就只剩噪音：一半的字符是语法，读起来比正文还费劲。
 * 所以在这里把标记洗掉、把文字留下。
 *
 * 清洗放在 host 这一侧，两个宿主才会长得一样。`detail` **不受影响** —— 点开的全文仍然给原文，
 * 那里是给人读完整内容和复制的，不该被改写。
 */
function plainText(input) {
  let text = String(input ?? '')
  /* 围栏代码块：去掉围栏，内容压成一行（气泡里没有放多行代码的地方）。 */
  text = text.replace(/```[a-zA-Z0-9+#-]*\n?([\s\S]*?)```/g, (_all, body) => String(body).replace(/\s+/g, ' '))
  /* 行内代码、图片、链接：留文字，丢语法。 */
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  /* 加粗 / 删除线：成对才算，免得把单独的符号当语法吃掉。 */
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  /* 行首的标题、引用、列表符号。 */
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  text = text.replace(/^[ \t]{0,3}(?:[-*+]|\d+\.)[ \t]+/gm, '')
  /* 表格分隔行与水平线：整行没有信息量的那种。 */
  text = text.replace(/^[ \t]{0,3}\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
  text = text.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ' ')
  /* 最后压平空白：气泡里的一串空行只会把它撑高。 */
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 把一条原始事件读成 `{ kind, text, detail }`，读不出句子就返回 null。
 *
 * `text` 是气泡上那一行，`detail` 是点开之后看的全文。
 */
function interpret(event) {
  const kind = String(event?.kind ?? '')

  if (kind === 'tool:ok' || kind === 'tool:error') {
    const name = String(event.tool ?? '') || 'tool'
    const verb = verbFor(name)
    const { subject, key } = subjectOf(event.args)
    const shown = subject !== null && FILE_KEYS.has(key) ? tailPath(subject) : subject
    const body = describeCall(event.args)
    const head = `${name}\n\n${body === '' ? '（没有参数）' : body}`
    if (kind === 'tool:error') {
      return {
        kind,
        text: `${verb.replace('正在', '')}失败${shown === null ? '' : ` · ${shown}`}`,
        detail: head,
      }
    }
    return { kind, text: shown === null ? verb : `${verb} ${shown}`, detail: head }
  }

  if (kind === 'turn:end') {
    return { kind, text: turnEndSentence(String(event.reason ?? '')), detail: String(event.detail ?? '') }
  }

  /*
   * 说的话：气泡上只留内容本身。
   *
   * 以前这里带着「我说：」「你说：」的前缀 —— 而气泡的颜色和位置已经在说是谁了，前缀除了占地方
   * 没有别的用处。`detail` 仍然是原文（不清洗）：点开是给人读全文和复制的。
   */
  if (kind === 'user' || kind === 'assistant' || kind === 'assistant:final') {
    const raw = String(event.text ?? '')
    return { kind, text: shorten(plainText(raw), 260), detail: raw }
  }

  if (kind === 'session:switch') {
    return { kind, text: String(event.text ?? ''), detail: '' }
  }

  return null
}

/**
 * 会话名：有标题就用标题，没有就退回 id **尾部**。
 *
 * 尾部而不是头部：会话 id 全部以 `session-` 开头，取前八位每个会话都是同一串 "session-…"，
 * 拿它认人等于没认。这一条是测试时在菜单上撞见的 —— 两个会话长得一模一样。
 */
function sessionLabel(sessionId, title) {
  if (typeof title === 'string' && title !== '') return shorten(title, 24)
  if (sessionId === '') return '当前会话'
  return `…${sessionId.slice(-8)}`
}

// --------------------------------------------------------------------------- //
// 插件
// --------------------------------------------------------------------------- //

export default {
  name: 'dsh-danmaku',

  apply(root) {
    /*
     * ① 注入行**先注册**，而且不依赖任何 service。
     *
     * 桌面端的注入表是宿主启动时一次性收集的；把注册放进 `root.inject([...])` 里，
     * 就等于"等服务就绪之后再进表"——服务晚一点，这一行就永远进不去，
     * 而症状是"桌面端弹幕从不出现"，host 侧没有任何报错。
     */
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (row === null || row === undefined) continue
          if (row.kind === 'script-src' && row.src === FRONT_URL) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(FRONT_URL)) return
        }
        table.push({ kind: 'script', placement: 'body', text: INLINE_LOADER })
      } catch (error) {
        console.error('[dsh-danmaku] 注入 index 失败：', String(error?.message ?? error))
      }
    })

    /*
     * ② 其余逻辑等 service 就绪。
     *
     * `timer` **必须列在这里**，不能指望"用到的时候再拿"。Cordis 的 context 是个 Proxy：
     * 没在 inject 里声明过的服务，属性访问会当场抛 `cannot get property "timer" without inject`。
     * 而这条抛错的位置很坏——它发生在 SSE 的响应头已经发出去之后，webServer 的处理是
     * **直接销毁 socket**（外加一条落在我们读不到的地方的 logger.warn）。现场看到的现象是
     * "事件流 open 之后一毫秒就断、前端无限重连"，跟 inject 一个字都不沾边。
     * 这条是拿一个临时探针插件实测出来的，值得记在这里。
     */
    root.inject(['webServer', 'timer'], (ctx) => {
      const listeners = new Set()
      /*
       * 回填**按会话分开存**。
       *
       * 只留一条全局队列的话，手动钉住一个安静了十分钟的会话时，它的最后几条早就被别的会话
       * 挤出去了 —— 于是"切过去"看到的是空白，而这正是那个人点菜单的原因。
       */
      const recentBySession = new Map()
      /** 会话 id -> { id, title, lastAt, lastText, events }：会话选择菜单的数据源。 */
      const knownSessions = new Map()
      /** 会话 id -> Session 对象。`sessionTitle.get()` 要的是对象，不是 id。 */
      const sessionObjects = new Map()
      /** 用户选定的会话。空串 = 还没选过（第一条带会话的事件会落位一次）。 */
      let focusedSession = ''
      /**
       * 浮层的位置：距视口右下角各多少像素。
       *
       * 放在 host 而不是各自的 localStorage：DSH 页面和桌面 overlay 是两份前端，位置本来就得同步。
       * 更要紧的是**只有"贴着右下角"这种写法**才保证"按钮行固定、内容朝上长"—— 用 left/top 定位时
       * 内容一长就往下长，按钮行直接被顶出屏幕（主人报的第 4 条就是这个）。
       */
      let placement = { right: 18, bottom: 128 }
      /** 会话 id -> 这一轮最后一段助手文本，用来判断「结束但没有回复」。 */
      const lastAnswer = new Map()
      /** 只在诊断里用：一共播出去多少条。 */
      let published = 0
      /** 诊断用：SSE handler 里最后一次抛出来的东西。 */
      let lastStreamError = ''
      /** 诊断用：SSE handler 走完了几次。 */
      let streamOpens = 0
      /** 现在跟着谁。空串 = 还没定（第一条带会话的事件来定）。 */
      let activeSession = ''
      /** 活跃会话的标题，只为把切换提示写得像人话。 */
      let activeTitle = ''

      /*
       * 标题：会话菜单里如果只有一串 `session-266cb42a…`，选了也不知道选的是谁。
       *
       * 用 `ctx.get('sessionTitle')` 而不是 `ctx.sessionTitle`：后者要写进 inject 才是合法访问，
       * 而标题只是个锦上添花的东西，不值得为它把整个半边变成硬依赖（第 1 条坑的同一道理）。
       * 解析一次就缓存起来。
       */
      let titleService
      let titleServiceResolved = false
      function resolveTitleService() {
        if (!titleServiceResolved) {
          titleServiceResolved = true
          try {
            titleService = ctx.get('sessionTitle') ?? null
          } catch {
            titleService = null
          }
        }
        return titleService
      }

      function titleOf(sessionId, inlineTitle) {
        if (typeof inlineTitle === 'string' && inlineTitle !== '') return inlineTitle
        const session = sessionObjects.get(sessionId)
        if (session === undefined) return ''
        try {
          const service = resolveTitleService()
          if (service === null || typeof service.get !== 'function') return ''
          const snapshot = service.get(session)
          return typeof snapshot?.title === 'string' ? snapshot.title : ''
        } catch {
          /* 标题服务闹脾气不该影响弹幕，退回 id 前缀就好。 */
          return ''
        }
      }

      /** 记下"这个会话最近在干什么"。所有 root 会话都记，不管现在播的是哪一个。 */
      function rememberSession(sessionId, text, inlineTitle) {
        if (sessionId === '') return
        const title = titleOf(sessionId, inlineTitle)
        const existing = knownSessions.get(sessionId)
        if (existing === undefined) {
          /* 重新插入让它排到队尾，顺便当作 LRU 的"最近使用"。 */
          knownSessions.set(sessionId, { id: sessionId, title, lastAt: Date.now(), lastText: text, events: 1 })
          while (knownSessions.size > SESSION_MEMORY) {
            const oldest = knownSessions.keys().next()
            if (oldest.done === true) break
            /* 正在看的那个不能被清理掉，否则菜单里会缺一条。 */
            if (oldest.value === activeSession || oldest.value === focusedSession) break
            knownSessions.delete(oldest.value)
          }
          return
        }
        existing.title = title === '' ? existing.title : title
        existing.lastAt = Date.now()
        if (text !== '') existing.lastText = text
        existing.events += 1
      }

      /** 留着 Session 对象只为一件事：向 sessionTitle 服务要标题（它要对象，不要 id）。 */
      function rememberSessionObject(sessionId, session) {
        sessionObjects.delete(sessionId)
        sessionObjects.set(sessionId, session)
        while (sessionObjects.size > SESSION_MEMORY) {
          const oldest = sessionObjects.keys().next()
          if (oldest.done === true) break
          sessionObjects.delete(oldest.value)
        }
      }

      /**
       * 菜单里的候选会话：**所有 root 会话**，最近说过话的排前面。
       *
       * 只列"见过事件的会话"是不够的 —— 要的是"任意选一个会话看"，包括本进程还没见它说过话的
       * 那些（重启之后，之前活跃过的会话就属于这一类）。它们没有时间也没有最后一句，于是排在后面、
       * 显示成"没有动静"，但仍然可以选：选过去之后，它一说话气泡就会长出来。
       */
      function sessionList() {
        const rows = new Map()
        for (const entry of knownSessions.values()) {
          rows.set(entry.id, {
            id: entry.id,
            title: entry.title,
            lastAt: entry.lastAt,
            lastText: entry.lastText,
            events: entry.events,
          })
        }

        try {
          const agents = ctx.get('agents')
          const roots =
            agents !== undefined && agents !== null && typeof agents.roots === 'function' ? agents.roots() : []
          if (Array.isArray(roots)) {
            for (const agent of roots) {
              const id = agent?.id
              if (typeof id !== 'string' || id === '' || rows.has(id)) continue
              /*
               * Agent 身上如果挂着 Session，标题就问得出来（`sessionTitle.get()` 要的是对象，
               * 不是 id）。拿不到也没关系：菜单退回 id 尾部八位，总比这个会话压根不出现强。
               */
              const session = agent?.session
              if (session !== undefined && session !== null) rememberSessionObject(id, session)
              rows.set(id, { id, title: titleOf(id, ''), lastAt: 0, lastText: '', events: 0 })
            }
          }
        } catch {
          /* 少列几条不是故障：菜单还能用，只是安静的那些会话暂时看不见。 */
        }

        const list = [...rows.values()]
        list.sort((left, right) => right.lastAt - left.lastAt)
        return list
      }

      function rememberRecent(event) {
        const key = typeof event.session === 'string' ? event.session : ''
        let list = recentBySession.get(key)
        if (list === undefined) {
          list = []
          recentBySession.set(key, list)
        }
        list.push(event)
        if (list.length > RECENT_PER_SESSION) list.splice(0, list.length - RECENT_PER_SESSION)
      }

      /** 回填：钉住了就只给那一个会话，否则把所有会话按时间混起来取最后一段。 */
      function eventsForBackfill() {
        if (focusedSession !== '') return (recentBySession.get(focusedSession) ?? []).slice()
        const all = []
        for (const list of recentBySession.values()) {
          for (const event of list) all.push(event)
        }
        all.sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
        return all.slice(-RECENT_LIMIT)
      }

      function rememberAnswer(sessionId, text) {
        if (sessionId === '') return
        lastAnswer.delete(sessionId)
        lastAnswer.set(sessionId, text)
        while (lastAnswer.size > ANSWER_MEMORY) {
          const oldest = lastAnswer.keys().next()
          if (oldest.done === true) break
          lastAnswer.delete(oldest.value)
        }
      }

      function takeAnswer(sessionId) {
        const value = lastAnswer.get(sessionId) ?? null
        lastAnswer.delete(sessionId)
        return value
      }

      /**
       * 这条事件来自"用户正在看的会话"吗？
       *
       * 子代理的会话也是一个 Session，它的工具调用会带着自己的 session id 到达。
       * 不过滤的话，主会话派出去一个子代理，弹幕整片就跟着子代理走了——用户看的是主会话，
       * 屏幕上的内容却换成了别人家的活。所以只播 root 会话。
       *
       * 服务不在、或者列表为空时不拦（宁可多显示，也不要因为拿不到列表就整片哑掉）。
       */
      function isRootSession(sessionId) {
        try {
          const agents = ctx.get('agents')
          if (agents === undefined || agents === null || typeof agents.roots !== 'function') return true
          const roots = agents.roots()
          if (!Array.isArray(roots) || roots.length === 0) return true
          return roots.some((agent) => agent !== null && agent !== undefined && agent.id === sessionId)
        } catch {
          return true
        }
      }

      function broadcast(event) {
        const frame = `data: ${JSON.stringify(event)}\n\n`
        for (const listener of listeners) {
          try {
            listener.write(frame)
          } catch {
            /*
             * 写不进去的 socket 就地摘掉。
             *
             * 只靠 close 事件是不够的：断掉的连接如果没能触发 close，它会一直留在表里，
             * 于是每来一条事件都往一个死 socket 上写、每 20 秒给它发一次心跳，
             * 而 `clients` 这个数字会一直涨——看起来像"有八个客户端连着"，其实全是尸体。
             */
            listeners.delete(listener)
          }
        }
      }

      function push(event) {
        published += 1
        rememberRecent(event)
        broadcast(event)
      }

      /**
       * 播一条事件，并维护"现在是哪个会话"。
       *
       * 规则三条，按顺序：
       *
       *   1. **子代理的会话不播**（`isRootSession`）——主会话派一个子代理出去，画面不该跟着它走；
       *   2. **选定的会话说了算**——用户从菜单里点了谁就是谁。**没有自动跟随**：别人说话不会把
       *      画面换走（这是主人明确要的：别在我看的时候把内容换掉）；
       *   3. **还没选过就落位一次**——落到第一条带会话的事件上，之后一直钉在那儿。
       *
       * 而且不管播不播，**每个 root 会话的活动都要记进 `knownSessions`**：会话菜单要能显示
       * "另一个会话最后在干什么" —— 那正是用户决定要不要切过去看的东西。先按规则过滤再记账的话，
       * 菜单里就只剩当前这一个会话了。
       */
      function publish(event) {
        const sessionId = typeof event.session === 'string' ? event.session : ''
        const title = typeof event.sessionTitle === 'string' ? event.sessionTitle : ''

        if (sessionId === '') {
          const loose = interpret(event)
          if (loose === null) return
          push({
            kind: loose.kind,
            text: loose.text,
            detail: loose.detail,
            session: '',
            sessionTitle: '',
            tool: typeof event.tool === 'string' ? event.tool : '',
            reason: typeof event.reason === 'string' ? event.reason : '',
            at: Date.now(),
          })
          return
        }

        if (!isRootSession(sessionId)) return

        const spoken = interpret(event)
        rememberSession(sessionId, spoken === null ? '' : spoken.text, title)

        if (focusedSession === '') {
          focusedSession = sessionId
          activeSession = sessionId
          activeTitle = knownSessions.get(sessionId)?.title || title
          push({
            kind: 'session:switch',
            text: `现在看 ${sessionLabel(sessionId, activeTitle)}`,
            detail: '',
            session: sessionId,
            sessionTitle: activeTitle,
            at: Date.now(),
          })
        } else if (sessionId !== focusedSession) {
          /*
           * 选了别的会话：它的事件**不播**，但要**进回填**。
           *
           * 只记会话表是不够的 —— 那样从菜单切过去时回填里一条都没有（屏幕上只剩"钉住 xxx"
           * 那一句），看起来像这个会话什么都没发生过。这个 bug 是测试时撞见的：菜单里明明写着
           * 它有几十条事件，切过去却是空的。
           */
          if (spoken !== null) {
            rememberRecent({
              kind: spoken.kind,
              text: spoken.text,
              detail: spoken.detail,
              session: sessionId,
              sessionTitle: title,
              tool: typeof event.tool === 'string' ? event.tool : '',
              reason: typeof event.reason === 'string' ? event.reason : '',
              at: Date.now(),
            })
          }
          return
        } else {
          activeSession = sessionId
          activeTitle = knownSessions.get(sessionId)?.title || title
        }

        if (spoken === null) return
        push({
          kind: spoken.kind,
          text: spoken.text,
          detail: spoken.detail,
          session: sessionId,
          sessionTitle: activeTitle,
          tool: typeof event.tool === 'string' ? event.tool : '',
          reason: typeof event.reason === 'string' ? event.reason : '',
          at: Date.now(),
        })
      }

      // -- 事件源 -------------------------------------------------------------- //

      /*
       * 字段名来自 ToolExecutionInput，**不是**面板那套词汇：执行对象带的是 `name`、
       * `arguments`，以及一个 `agent`，会话就在它的 `id` 上。早先的版本读的是
       * `toolName` / `args` / `sessionId`，不报错——事件照常到达，只是每颗气泡既没有工具名
       * 也没有对象，看起来"没坏"，内容却是空的。
       */
      ctx.on('tools/result', (exec, result) => {
        if (result === null || result === undefined) return
        publish({
          kind: result.isError === true ? 'tool:error' : 'tool:ok',
          tool: typeof exec?.name === 'string' ? exec.name : '',
          args: exec?.arguments === undefined ? null : exec.arguments,
          session: typeof exec?.agent?.id === 'string' ? exec.agent.id : '',
          sessionTitle: typeof exec?.agent?.title === 'string' ? exec.agent.title : '',
        })
      })

      /*
       * 会话日志feed。载荷在 `event.data` 里——SessionEvent 的形状是 `{ type, seq, time, data }`
       * ——早先的版本读的是 `event.reason` 和 `event.text`，两个都不存在。什么都没抛：
       * 事件到了，而它们产生的每一颗气泡都是空的。
       *
       * 只读叶子字段，消息文本逐块取。消息对象是活的 DSH 值，不整体复制、不整体序列化。
       */
      function textOfMessage(message) {
        const content = message?.content
        if (!Array.isArray(content)) return ''
        const parts = []
        for (const block of content) {
          if (block === null || block === undefined) continue
          if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        }
        return parts.join('\n').trim()
      }

      ctx.on('session/event', (session, event) => {
        if (event === null || event === undefined) return
        const sessionId = typeof session?.id === 'string' ? session.id : ''
        const sessionTitle = typeof session?.title === 'string' ? session.title : ''
        /* 只有这条事件源给得出 Session 对象，标题也就只能从这里问。 */
        if (sessionId !== '' && session !== null && session !== undefined) rememberSessionObject(sessionId, session)
        const data = event.data
        if (data === null || data === undefined) return

        if (event.type === 'turn/end') {
          // reason 是一个判别联合，不是字符串：{ kind: 'completed' }。
          const kind = data.reason?.kind
          const reason = typeof kind === 'string' ? kind : ''
          /*
           * 正常结束**什么都不播**。
           *
           * 「这一轮结束了」没有说出回复气泡没说过的任何事，而且它是有害的：它不带文本，
           * 点开之后详情里只有这句标签。想看"说了什么"的人，得到的是一颗什么都没回答、
           * 还把回复顶上去了的气泡。
           *
           * 例外是「这一轮压根没有回复」。如果最后一条助手消息没有文本——中止、报错、
           * 被打断——那这颗 turn:end 就是唯一解释沉默的东西，于是连解释一起播。
           */
          const answer = takeAnswer(sessionId)
          if (reason !== 'completed' || answer === null) {
            publish({
              kind: 'turn:end',
              reason,
              detail: answer === null ? turnEndDetail(reason) : answer,
              session: sessionId,
              sessionTitle,
            })
          }
          return
        }

        if (event.type === 'user/message') {
          const text = textOfMessage(data)
          if (text === '') return
          // anchor：用户自己发的话，指认了他正在看的那个会话。
          publish({ kind: 'user', text, session: sessionId, sessionTitle, anchor: true })
          return
        }

        if (event.type === 'assistant/message') {
          const message = data.message
          const text = textOfMessage(message)
          if (text === '') return
          /*
           * 带工具调用的消息是路上的一步，不带的才是回答。`content` 里就有工具调用块，
           * 用它区分——值得点开的是那句回答，因为它是长的那个。
           */
          const wantsTools = Array.isArray(message?.content)
            ? message.content.some((block) => block?.type === 'tool-call')
            : false
          rememberAnswer(sessionId, text)
          publish({
            kind: wantsTools ? 'assistant' : 'assistant:final',
            text,
            session: sessionId,
            sessionTitle,
          })
        }
      })

      // -- 发消息 -------------------------------------------------------------- //

      /*
       * 往会话里送一句话，方式和 DSH 页面一样：走 `sessionController.prompt`，
       * 也就是生成的 `ctx.remote.session` 命名空间背后的那个 Host service。
       *
       * 请求形状读的是 Service 契约而不是猜的：`{ requestId, sessionId, mode, content }`，
       * content 是一组 `PromptContentPart`，回执是 `{ accepted: true }`。
       * `mode: 'queue'` 是常规情况——agent 正在一轮里时，打进去的话排队等它，
       * 而不是打断；想打断就用 `steer`。
       *
       * **signal 不是可选的**：签名是 `prompt(request, signal)`，不给会在 service 内部炸成
       * "Cannot read properties of undefined (reading 'throwIfAborted')"——一句不指向任何
       * 有用东西的错误。所以这里给一个带超时的 signal（准入很快，超时还没进来就是进不来了）。
       */
      function newRequestId() {
        // 只需要在这一个会话的在途请求里唯一，`Math.random` 够了；引一个 uuid 是为零件事加一个依赖。
        return `dnk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      }

      async function sendPrompt(sessionId, text, mode) {
        const controller = ctx.get('sessionController')
        if (controller === undefined || controller === null) {
          return { ok: false, error: 'this deployment has no session controller' }
        }
        try {
          const result = await controller.prompt(
            {
              requestId: newRequestId(),
              sessionId,
              mode: mode === 'steer' ? 'steer' : 'queue',
              content: [{ type: 'text', text }],
            },
            AbortSignal.timeout(20000),
          )
          return { ok: result?.accepted === true, error: '' }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error).slice(0, 300) }
        }
      }

      // -- 路由 ---------------------------------------------------------------- //

      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: FRONT_URL,
            handler: (req, res) => {
              const text = loadFrontend()
              const body = Buffer.from(text, 'utf8')
              res.writeHead(200, {
                'content-type': 'application/javascript; charset=utf-8',
                'content-length': String(body.length),
                'cache-control': 'no-store',
              })
              res.end(body)
            },
          }),
        'dsh-danmaku:route:frontend',
      )

      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: `${MOUNT}/status`,
            handler: (req, res) => {
              const stat = (() => {
                try {
                  return statSync(FRONT_FILE)
                } catch {
                  return null
                }
              })()
              sendJson(res, 200, {
                ok: true,
                build: 'v5',
                active: activeSession,
                activeTitle,
                focused: focusedSession,
                place: placement,
                sessionCount: knownSessions.size,
                sessions: sessionList(),
                events: published,
                backfill: eventsForBackfill().length,
                clients: listeners.size,
                streamOpens,
                lastStreamError,
                frontend: {
                  url: FRONT_URL,
                  bytes: stat === null ? null : stat.size,
                  mtime: stat === null ? null : stat.mtimeMs,
                },
              })
            },
          }),
        'dsh-danmaku:route:status',
      )

      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: `${MOUNT}/recent`,
            handler: (req, res) => {
              /*
               * 回填带上「现在是哪个会话」。
               *
               * 前端迟到（刷新、overlay 重新露面）时，它能拿到的只有这份 JSON；只给一串事件的话，
               * 它没有依据判断哪些还该显示——跟随会话这件事是在 host 这边决定的，所以答案也得从
               * 这边给出去。`focused` 一并带上，菜单才能把当前选中的那一项标出来。
               */
              sendJson(res, 200, {
                active: activeSession,
                activeTitle,
                focused: focusedSession,
                place: placement,
                events: eventsForBackfill(),
              })
            },
          }),
        'dsh-danmaku:route:recent',
      )

      /*
       * 会话列表：菜单的数据源。
       *
       * 只列 `knownSessions`（见过事件的 root 会话），不列 `agents.roots()` 的全集 ——
       * 后者里有一堆从没说过话的会话，菜单里除了 id 什么都显示不出来，选了也是空白。
       */
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: `${MOUNT}/sessions`,
            handler: (req, res) => {
              sendJson(res, 200, {
                active: activeSession,
                focused: focusedSession,
                sessions: sessionList(),
              })
            },
          }),
        'dsh-danmaku:route:sessions',
      )

      /*
       * 钉住一个会话，或者用空串恢复自动跟随。
       *
       * 为什么钉住要由 **host** 记：跟随会话本来就是在 host 这边决定的（它知道谁是 root、
       * 谁是子代理、谁最近说过话）。把它挪到前端，等于要每个页面各自维护一份同样的判断，
       * 而且它们会互相打架——DSH 页面和桌面 overlay 是同一份代码的两个副本，落在两个窗口里。
       */
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: `${MOUNT}/focus`,
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'POST only' })
                return
              }
              const body = await readBody(req)
              const wanted = typeof body?.sessionId === 'string' ? body.sessionId : ''

              if (wanted !== '' && !knownSessions.has(wanted)) {
                /*
                 * 只接受见过的会话。否则一个过期的 id 会把浮层钉在一个永远不会有事件的会话上，
                 * 表现为"弹幕忽然全没了"，而且没有任何提示 —— 比拒绝难查得多。
                 */
                sendJson(res, 404, { ok: false, error: '没有这个会话', focused: focusedSession })
                return
              }

              focusedSession = wanted
              if (wanted !== '') {
                activeSession = wanted
                activeTitle = knownSessions.get(wanted)?.title || ''
              }

              /*
               * 推一条 session:switch，让**所有**开着的前端一起切。
               *
               * 两个宿主各自持有一条 SSE，只在发起的那一个里改状态的话，另一个会继续显示上一个
               * 会话的气泡 —— 桌面窗口和 DSH 页面里的弹幕对不上，而且没人会想到是这个原因。
               */
              const label = wanted === '' ? '' : knownSessions.get(wanted)?.title || ''
              push({
                kind: 'session:switch',
                text: wanted === '' ? '恢复自动跟随' : `钉住 ${sessionLabel(wanted, label)}`,
                detail: '',
                session: wanted === '' ? activeSession : wanted,
                sessionTitle: wanted === '' ? activeTitle : label,
                at: Date.now(),
              })

              sendJson(res, 200, { ok: true, focused: focusedSession, active: activeSession })
            },
          }),
        'dsh-danmaku:route:focus',
      )

      /*
       * 浮层的位置。
       *
       * 由 host 保管的理由和 focus 一样：两个宿主得看同一个答案。而且这里**只收 right/bottom**，
       * 不收 left/top —— 位置一旦用"距顶部多少"来表达，内容一变长就会把工具行推出屏幕。
       */
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: `${MOUNT}/place`,
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'POST only' })
                return
              }
              const body = await readBody(req)
              const right = Number(body?.right)
              const bottom = Number(body?.bottom)
              if (!Number.isFinite(right) || !Number.isFinite(bottom) || right < 0 || bottom < 0) {
                sendJson(res, 400, { ok: false, error: 'right / bottom 要是非负数' })
                return
              }
              placement = { right: Math.round(right), bottom: Math.round(bottom) }
              /*
               * 广播给所有客户端：拖一边，另一边也要跟着挪。前端收到 kind 为 'place' 的事件只挪
               * 位置、不长气泡（它没有 text，addBubble 会跳过）。
               */
              push({
                kind: 'place',
                text: '',
                detail: '',
                session: '',
                sessionTitle: '',
                right: placement.right,
                bottom: placement.bottom,
                at: Date.now(),
              })
              sendJson(res, 200, { ok: true, right: placement.right, bottom: placement.bottom })
            },
          }),
        'dsh-danmaku:route:place',
      )

      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: `${MOUNT}/send`,
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'POST only' })
                return
              }
              const body = await readBody(req)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
              const text = typeof body?.text === 'string' ? body.text.trim() : ''
              if (sessionId === '') {
                sendJson(res, 400, { ok: false, error: '没有会话 id' })
                return
              }
              if (text === '') {
                sendJson(res, 400, { ok: false, error: '没写内容' })
                return
              }
              sendJson(res, 200, await sendPrompt(sessionId, text, body?.mode))
            },
          }),
        'dsh-danmaku:route:send',
      )

      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: `${MOUNT}/stream`,
            handler: (req, res) => {
              streamOpens += 1
              /*
               * 整段包起来，只为把错误留下痕迹。
               *
               * webServer 的规矩是：handler 抛错就回 400，而响应头已经发出去时**直接销毁
               * socket**，外加一条 logger.warn。桌面端的 logger 没有落到任何我们能读的文件里，
               * 所以"客户端 open 之后 1 毫秒就断"这件事在现场是没有解释的——只能靠自己在
               * status 里留一份。
               */
              try {
                res.writeHead(200, {
                  'content-type': 'text/event-stream; charset=utf-8',
                  'cache-control': 'no-cache, no-transform',
                  connection: 'keep-alive',
                  'x-accel-buffering': 'no',
                })
                // 一帧注释让浏览器和 urllib 都立刻认为这条流是开着的，而不是等第一个事件。
                res.write(': connected\n\n')
              } catch (error) {
                lastStreamError = `headers: ${String(error?.stack ?? error)}`
                throw error
              }

              const ping = () => {
                try {
                  res.write(': ping\n\n')
                } catch {
                  /* 由下面的 close 处理器摘掉。 */
                }
              }

              /*
               * 顺序是有讲究的：**先把 close 处理器挂上，最后才把 res 放进 listeners**。
               *
               * 反过来的话，中间任何一步抛错都会留下一条永远摘不掉的连接 —— close 处理器还没
               * 注册，而它已经在表里了。现场的表现就是 `clients` 一路涨到两位数，全是尸体，
               * 每来一条事件都往它们身上写一次。（timer 那个 bug 正是这样留下了 11 条。）
               */
              let stopBeat = () => {}
              const close = () => {
                stopBeat()
                listeners.delete(res)
              }
              try {
                req.on('close', close)
                res.on('close', close)
                res.on('error', close)
              } catch (error) {
                lastStreamError = `close hooks: ${String(error?.stack ?? error)}`
                throw error
              }

              // keepalive：让中间的代理不关掉空闲的流。`timer` 在 inject 里，所以这一行不会抛。
              stopBeat = ctx.interval(ping, 20000)

              listeners.add(res)
            },
          }),
        'dsh-danmaku:route:stream',
      )

      console.log(`dsh-danmaku ready · frontend ${FRONT_URL}`)
    })
  },
}
