/**
 * dsh-danmaku —— 离线自检
 *
 * 为什么值得写：这套东西的两个半边，失败的样子都是**安静的**。
 *
 *   - host 半边把事件读错字段名（例如 `toolName` 而不是 `name`），什么都不抛：事件照常到达，
 *     只是每颗气泡既没有工具名也没有对象。看起来"没坏"，内容却是空的。
 *   - 前端挂在两个地方，而两边都没有方便的控制台：DSH 页面里它只是"没出现"，overlay 页面里
 *     更是没人会去开 devtools。等真机上发现"什么都没有"再回头查，一轮一轮都很贵。
 *
 * 所以这里用一套最小 DOM 在 Node 里把前端真跑一遍，再用一个假 root/假 ctx 把 host 半边
 * 真跑一遍。它不能替代真机验证，但能在按 F5 之前把"字段读错、路由没注册、脚本一跑就抛异常"
 * 这一类错误全部挡下来。
 *
 * 跑法：node tools/check.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FRONT_FILE = join(ROOT, 'plugin', 'lib', 'bubbles.js')
const HOST_FILE = join(ROOT, 'plugin', 'lib', 'index.js')

const ROOT_ID = 'dsh-danmaku-root'
const FRONT_URL = '/dsh-danmaku/v3/bubbles.js'

let passed = 0
function ok(label) {
  passed += 1
  console.log(`  \u2713 ${label}`)
}

// --------------------------------------------------------------------------- //
// 第一段：host 半边
// --------------------------------------------------------------------------- //

function fakeResponse() {
  const state = { status: 0, headers: {}, body: '', frames: [] }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
    },
    write(chunk) {
      state.frames.push(String(chunk))
    },
    on() {
      /* SSE 路由给 res 挂了 close / error；假对象不需要真的触发它们。 */
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk)
    },
  }
}

function fakeRequest(method = 'GET') {
  return { method, on() {} }
}

/** 一个能喂 body 的假 POST 请求：`readBody` 先挂 `data` 再挂 `end`。 */
function fakePostRequest(payload) {
  const listeners = new Map()
  return {
    method: 'POST',
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      if (event === 'data') listener(Buffer.from(JSON.stringify(payload), 'utf8'))
      if (event === 'end') setImmediate(() => listener())
    },
  }
}

async function checkHost() {
  const module = await import(new URL('../plugin/lib/index.js', import.meta.url).href)
  const plugin = module.default

  assert.equal(plugin.name, 'dsh-danmaku', 'host 半边的 name 不对')
  assert.equal(typeof plugin.apply, 'function', 'host 半边没有 apply')
  /*
   * 这条是硬的：**对象级 inject 绝不能有**。
   *
   * 它会把整个 apply 推迟到 webServer 就绪之后，而桌面端的 index 注入表是宿主启动时
   * 一次性收集的 —— 晚了就永远进不去，症状是"桌面端弹幕从不出现"，host 侧没有任何报错。
   * 正确的形状是 apply 立刻执行、第一件事注册注入行，其余逻辑放进 root.inject([...])。
   */
  assert.equal(plugin.inject, undefined, '出现了对象级 inject：桌面端的注入行会赶不上收集')
  ok('host 导出形状（default 对象 / 无对象级 inject）')

  const handlers = new Map()
  const routes = new Map()
  /** 插件声明过的服务，由 root.inject 填。 */
  const declared = []

  /*
   * 复刻 Cordis 的 inject 门禁。
   *
   * 这不是"多写一层保险"——它是真实踩过的坑：`ctx.interval` 来自 `timer` 服务，而 timer
   * 不在 inject 里时，属性访问会抛 `cannot get property "timer" without inject`。抛错的位置
   * 在 SSE 响应头已经发出去之后，webServer 会把 socket 直接销毁，现象是"事件流一毫秒就断"。
   * 假 ctx 不模拟这道门禁的话，这类错误只有在真机上才会现形，而真机上 host 代码每改一次都要
   * 重启客户端才能重载。
   */
  const services = {
    /*
     * 三个 root 会话：a 先落位、b 是用户切过去的、c 用来验证"别的会话在说话"不会抢走 active。
     * 子代理会话不在这里面（`isRootSession` 会把它们挡住，另有一条断言）。
     */
    agents: { roots: () => [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }] },
    /*
     * 工作区注册表：重启之后**唯一还认得历史会话**的地方（前两个来源都是"当前进程里活着的东西"）。
     * 这里放两个只有它知道的会话 —— 菜单必须列得出来，而且必须选得动。
     */
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', sessionIds: ['session-d', 'session-e'] }],
    },
    sessionController: {
      async prompt() {
        return { accepted: true }
      },
    },
    /* 会话标题：菜单里如果只有一串 id，选了也不知道选的是谁。 */
    sessionTitle: {
      get: () => ({ title: '测试会话' }),
    },
    timer: {
      interval() {
        return () => {}
      },
    },
    webServer: {
      port: 19387,
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }

  /** 直接挂在 context 上的方法来自哪个服务（Cordis 把它叫 mixin）。 */
  const MIXINS = { interval: 'timer', timeout: 'timer', throttle: 'timer', debounce: 'timer' }

  const base = {
    on(name, listener) {
      handlers.set(name, listener)
    },
    effect(factory) {
      return factory()
    },
    /* `ctx.get()` 是宽松读取：拿不到就是 undefined，不受 inject 门禁约束。 */
    get(name) {
      return services[name]
    },
  }

  const ctx = new Proxy(base, {
    get(target, prop) {
      if (prop === 'then') return undefined
      if (Reflect.has(target, prop)) return target[prop]
      const owner = MIXINS[prop]
      if (owner !== undefined) {
        if (!declared.includes(owner)) throw new Error(`cannot get property "${owner}" without inject`)
        return services[owner][prop]
      }
      if (Object.hasOwn(services, prop)) {
        if (!declared.includes(prop)) throw new Error(`cannot get property "${prop}" without inject`)
        return services[prop]
      }
      return undefined
    },
  })

  const root = {
    on(name, listener) {
      handlers.set(name, listener)
    },
    inject(names, callback) {
      declared.length = 0
      declared.push(...names)
      callback(ctx)
    },
  }

  plugin.apply(root)
  assert.ok(declared.includes('timer'), 'timer 没进 inject：ctx.interval 会抛 cannot get property "timer" without inject')
  ok('apply 在假 root 上跑通（含 inject 门禁）')

  // -- 注入行 -------------------------------------------------------------- //

  const table = []
  const injectRow = handlers.get('webserver/index-inject')
  assert.equal(typeof injectRow, 'function', '没有注册 webserver/index-inject')
  injectRow(table)
  assert.equal(table.length, 1, '注入行没有推上去')
  assert.equal(table[0].kind, 'script', '注入行必须是内联 script（script-src 加载失败会 reject 掉 boot）')
  assert.ok(table[0].text.includes(FRONT_URL), '注入行没有指向前端脚本')
  injectRow(table)
  assert.equal(table.length, 1, '重复的 index-inject 推出了第二条相同的行')
  ok('桌面端注入行：内联 script、幂等')

  // -- 路由 ---------------------------------------------------------------- //

  for (const path of ['frontend', 'status', 'recent', 'send', 'stream', 'sessions', 'focus', 'place']) {
    const suffix = path === 'frontend' ? FRONT_URL : `/dsh-danmaku/v3/${path}`
    assert.ok(routes.has(suffix), `路由没注册：${suffix}`)
  }
  ok('八条路由全部注册')

  const frontend = fakeResponse()
  routes.get(FRONT_URL).handler(fakeRequest(), frontend)
  assert.ok(frontend.state.body.includes('dsh-danmaku'), '前端脚本路由没有返回脚本内容')
  assert.equal(frontend.state.headers['content-type'], 'application/javascript; charset=utf-8')
  ok('前端脚本路由返回 JS')

  // -- 事件流 -------------------------------------------------------------- //

  const stream = fakeResponse()
  routes.get('/dsh-danmaku/v3/stream').handler(fakeRequest(), stream)
  assert.ok(stream.state.frames[0].startsWith(': connected'), 'SSE 开头没有那条注释帧')

  const toolResult = handlers.get('tools/result')
  assert.equal(typeof toolResult, 'function', '没有监听 tools/result')
  /*
   * 字段名故意用真的那套：`name` / `arguments` / `agent.id`。
   * 读成 toolName / args / sessionId 不会抛任何东西 —— 事件照样到，气泡是空的。这条断言就是拦它。
   */
  toolResult(
    { name: 'read', arguments: { file_path: 'D:/Projects/dsh-plugins/dsh-danmaku/plugin/lib/index.js' }, agent: { id: 'session-a' } },
    { isError: false },
  )
  const frames = stream.state.frames.join('')
  assert.ok(frames.includes('"kind":"tool:ok"'), '工具事件没有播出去')
  assert.ok(frames.includes('正在读取'), '工具名没有读出来（字段名可能又被读错了）')
  assert.ok(frames.includes('lib/index.js'), '对象路径没有读出来')
  ok('tools/result → 气泡句子（读的是 name / arguments / agent.id）')

  const sessionEvent = handlers.get('session/event')
  assert.equal(typeof sessionEvent, 'function', '没有监听 session/event')

  /*
   * 第一条带会话的事件**落位一次** —— 落位之后画面就钉在这儿。
   * 这是"自动跟随"唯一剩下的部分：选定之后别再自己换，是主人明确要的。
   */
  const afterFirst = stream.state.frames.join('')
  assert.ok(afterFirst.includes('现在看'), '第一条事件没有落位到那个会话')
  ok('第一条带会话的事件落位一次')

  /* 别的会话里用户说话，也**不再**把画面换走。 */
  const beforeUser = stream.state.frames.length
  sessionEvent({ id: 'session-b', title: '搬弹幕' }, { type: 'user/message', data: { content: [{ type: 'text', text: '把弹幕改成普通前端' }] } })
  assert.equal(stream.state.frames.length, beforeUser, '别的会话说话又把画面换走了 —— 自动跟随应当已经去掉')
  ok('选定之后不再自动跟随（用户消息也不换画面）')

  /* 气泡上不该再有「我说：」「你说：」——气泡的颜色和位置已经在说是谁了。 */
  sessionEvent({ id: 'session-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**加粗** 和 `代码`\n## 标题' }] } } })
  const spoken = stream.state.frames.join('')
  assert.ok(!spoken.includes('我说：'), '气泡上还带着「我说：」前缀')
  assert.ok(!spoken.includes('你说：'), '气泡上还带着「你说：」前缀')
  ok('气泡去掉了「我说：」「你说：」前缀')

  /* Markdown 标记要洗掉：气泡不渲染 Markdown，留着就只剩噪音。 */
  /* 只看气泡文本（`text`）—— `detail` 是故意留原文的，那里有 `**` 才对。 */
  const spokenTexts = stream.state.frames
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)).text)
    .join(' | ')
  assert.ok(spokenTexts.includes('加粗 和 代码 标题'), 'Markdown 标记没有被洗掉')
  assert.ok(!spokenTexts.includes('**'), '气泡文本里还留着 ** 标记')
  ok('气泡洗掉了 Markdown 标记（detail 仍保留原文）')

  // 别的会话的事件不该抢走画面。
  const before = stream.state.frames.length
  sessionEvent({ id: 'session-c' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '别的会话在说话' }] } } })
  assert.equal(stream.state.frames.length, before, '非选定会话的事件被播出去了')
  ok('非选定会话的事件被挡住')

  /*
   * 子代理的会话也是一个 Session，它的工具调用带着自己的 id 到达。不过滤的话，
   * 主会话派出去一个子代理，弹幕整片就跟着子代理走了。
   */
  const beforeChild = stream.state.frames.length
  sessionEvent({ id: 'subagent-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '子代理在干活' }] } } })
  assert.equal(stream.state.frames.length, beforeChild, '子代理会话的事件被播出去了')
  ok('子代理会话的事件被挡住')

  // -- 回填 ---------------------------------------------------------------- //

  const recent = fakeResponse()
  routes.get('/dsh-danmaku/v3/recent').handler(fakeRequest(), recent)
  const payload = JSON.parse(recent.state.body)
  assert.equal(payload.active, 'session-a', '回填没有带上选定的会话')
  assert.ok(payload.place !== null && typeof payload.place.right === 'number', '回填没有带上浮层位置')
  assert.ok(Array.isArray(payload.events) && payload.events.length > 0, '回填没有事件')
  assert.ok(payload.events.every((event) => typeof event.text === 'string' && event.text !== ''), '有气泡没有文本')
  ok('recent 回填带 active + place + 非空文本')

  // -- send ---------------------------------------------------------------- //

  const send = fakeResponse()
  await routes.get('/dsh-danmaku/v3/send').handler(fakePostRequest({ sessionId: 'session-b', text: '你好' }), send)
  const sent = JSON.parse(send.state.body)
  assert.equal(sent.ok, true, `send 路由没有把 prompt 送出去：${send.state.body}`)
  ok('send 路由把话送进会话')

  // -- 会话菜单：列表、钉住、恢复 -------------------------------------------- //

  const listResponse = fakeResponse()
  routes.get('/dsh-danmaku/v3/sessions').handler(fakeRequest(), listResponse)
  const list = JSON.parse(listResponse.state.body)
  assert.equal(list.focused, 'session-a', '落位之后应当选中第一个开口的会话')
  const ids = list.sessions.map((row) => row.id)
  assert.ok(
    ids.includes('session-a') && ids.includes('session-b') && ids.includes('session-c'),
    '会话列表缺了见过的会话（记账必须发生在"播不播"的判断之前）',
  )
  assert.ok(!ids.includes('subagent-1'), '子代理的会话不该出现在菜单里')
  ok('GET /sessions 列出见过的 root 会话（不含子代理）')

  assert.equal(
    list.sessions.find((row) => row.id === 'session-c').title,
    '测试会话',
    '标题没有从 sessionTitle 服务取到',
  )
  assert.equal(list.sessions.find((row) => row.id === 'session-b').title, '搬弹幕', '事件自带的标题没有优先')
  ok('会话标题：事件自带优先，取不到才问 sessionTitle 服务')

  assert.ok(
    list.sessions.every((row) => typeof row.lastText === 'string'),
    '会话行没有"最后在干什么"',
  )
  ok('每一行都带"最后在干什么"')

  const focusRoute = routes.get('/dsh-danmaku/v3/focus')

  const pinned = fakeResponse()
  await focusRoute.handler(fakePostRequest({ sessionId: 'session-c' }), pinned)
  assert.equal(JSON.parse(pinned.state.body).focused, 'session-c', '钉住没有生效')
  ok('POST /focus 钉住一个会话')

  const beforeOther = stream.state.frames.length
  sessionEvent({ id: 'session-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '别的会话又在说话' }] } } })
  assert.equal(stream.state.frames.length, beforeOther, '钉住之后还播了别的会话')
  ok('钉住之后只播这一个会话')

  const beforeOwn = stream.state.frames.length
  sessionEvent({ id: 'session-c' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '就是我' }] } } })
  assert.ok(stream.state.frames.length > beforeOwn, '钉住的会话自己说话也没播')
  ok('钉住的会话照常上屏')

  const pinnedBackfill = fakeResponse()
  routes.get('/dsh-danmaku/v3/recent').handler(fakeRequest(), pinnedBackfill)
  const pinnedPayload = JSON.parse(pinnedBackfill.state.body)
  assert.equal(pinnedPayload.focused, 'session-c')
  assert.ok(pinnedPayload.events.length > 0, '钉住之后回填是空的')
  assert.ok(
    pinnedPayload.events.every((event) => event.session === 'session-c'),
    '钉住时回填里混进了别的会话',
  )
  ok('钉住时回填只含该会话')

  const bogus = fakeResponse()
  await focusRoute.handler(fakePostRequest({ sessionId: 'session-nope' }), bogus)
  assert.equal(bogus.state.status, 404, '没见过的会话没有被拒绝')
  assert.equal(JSON.parse(bogus.state.body).focused, 'session-c', '被拒之后状态不该变')
  ok('POST /focus 拒绝没见过的会话，且不改状态')

  /*
   * 回归：**菜单里列出来的每一条都必须选得动**。
   *
   * 主人撞上的就是这个：菜单列的是 root 全集（含工作区注册表里的历史会话），门禁却只认
   * `knownSessions` —— 菜单里点哪一条都是 404「没有这个会话」。两边的判据必须同源，
   * 所以这里直接拿菜单的输出去喂门禁，而不是各自写一份期望值。
   */
  const sessionsRoute = routes.get('/dsh-danmaku/v3/sessions')
  const listed = fakeResponse()
  sessionsRoute.handler(fakeRequest(), listed)
  const listedIds = JSON.parse(listed.state.body).sessions.map((row) => row.id)
  assert.ok(listedIds.includes('session-d'), '工作区注册表里的会话没有进菜单')
  assert.ok(listedIds.includes('session-e'), '工作区注册表里的会话没有进菜单')
  for (const id of listedIds) {
    const probe = fakeResponse()
    await focusRoute.handler(fakePostRequest({ sessionId: id }), probe)
    assert.equal(probe.state.status, 200, `菜单里的 ${id} 选不动`)
  }
  ok('菜单里列出的每一个会话都选得动（含注册表里的历史会话）')

  const resumed = fakeResponse()
  await focusRoute.handler(fakePostRequest({ sessionId: '' }), resumed)
  assert.equal(JSON.parse(resumed.state.body).focused, '', '空串没有回到未选状态')
  ok('POST /focus 空串回到未选状态（下一次事件重新落位）')

  // -- 浮层位置 -------------------------------------------------------------- //

  const placeRoute = routes.get('/dsh-danmaku/v3/place')
  const placed = fakeResponse()
  await placeRoute.handler(fakePostRequest({ right: 40, bottom: 200 }), placed)
  const placeBody = JSON.parse(placed.state.body)
  assert.equal(placeBody.ok, true, 'place 没有接受位置')
  assert.equal(placeBody.right, 40, 'right 没记对')
  assert.equal(placeBody.bottom, 200, 'bottom 没记对')
  ok('POST /place 记下位置（只收 right/bottom）')

  const badPlace = fakeResponse()
  await placeRoute.handler(fakePostRequest({ right: -5, bottom: 10 }), badPlace)
  assert.equal(badPlace.state.status, 400, '负数位置没有被拒绝')
  ok('POST /place 拒绝负数位置')

  // -- 被挡住的会话，切过去要有回填 ------------------------------------------ //

  /*
   * 只"记进会话表"是不够的：菜单里写着它有几十条事件，切过去却只剩一条"钉住 xxx" ——
   * 这正是测试时在真机上撞见的。所以被过滤掉的事件也要进回填缓冲区。
   */
  const switchBack = fakeResponse()
  await focusRoute.handler(fakePostRequest({ sessionId: 'session-b' }), switchBack)
  assert.equal(JSON.parse(switchBack.state.body).focused, 'session-b', '没切过去')
  const backfilled = fakeResponse()
  routes.get('/dsh-danmaku/v3/recent').handler(fakeRequest(), backfilled)
  const backfillBody = JSON.parse(backfilled.state.body)
  assert.ok(
    backfillBody.events.some(
      (event) => event.session === 'session-b' && event.text.includes('把弹幕改成普通前端'),
    ),
    '切到那个一直被挡着的会话之后，回填里没有它的事件',
  )
  ok('被挡住的会话仍然进回填（切过去不会是空白）')

  return { routes, handlers, ctx }
}

// --------------------------------------------------------------------------- //
// 第二段：前端（最小 DOM 里真跑一遍）
// --------------------------------------------------------------------------- //

class FakeClassList {
  constructor(node) {
    this.node = node
  }

  list() {
    return String(this.node.className ?? '')
      .split(/\s+/)
      .filter((part) => part !== '')
  }

  write(list) {
    this.node.className = list.join(' ')
  }

  add(...names) {
    const list = this.list()
    for (const name of names) if (!list.includes(name)) list.push(name)
    this.write(list)
  }

  remove(...names) {
    this.write(this.list().filter((name) => !names.includes(name)))
  }

  contains(name) {
    return this.list().includes(name)
  }

  toggle(name, force) {
    const has = this.contains(name)
    const want = force === undefined ? !has : force === true
    if (want && !has) this.add(name)
    else if (!want && has) this.remove(name)
    return want
  }
}

class FakeStyle {
  constructor() {
    this.properties = new Map()
  }

  setProperty(name, value) {
    this.properties.set(name, String(value))
  }

  getPropertyValue(name) {
    return this.properties.get(name) ?? ''
  }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = new FakeStyle()
    this.classList = new FakeClassList(this)
    this.listeners = new Map()
    this.className = ''
    this.id = ''
    this.title = ''
    this.type = ''
    this.placeholder = ''
    this.disabled = false
    this._text = ''
    /* 滚动相关的三个属性：真实 DOM 上由布局算出来，这里当普通字段用（默认 0 = 没超出）。 */
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
  }

  get firstElementChild() {
    return this.children.length > 0 ? this.children[0] : null
  }

  get textContent() {
    /* 真实 DOM 会聚合子节点。菜单项正是靠 appendChild 拼出来的，不聚合就只能读到空串。 */
    if (this.children.length === 0) return this._text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this._text = String(value)
    this.children.length = 0
  }

  /*
   * 真实 DOM 会解析标签；这里不解析，只把 HTML 存下来给断言看，并把去掉标签后的近似纯文本
   * 塞进 `_text` —— 这样那些用 `textContent` 写的断言在改成渲染之后依然读得通。
   */
  get innerHTML() {
    return this._html ?? ''
  }

  set innerHTML(value) {
    this._html = String(value)
    this._text = this._html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    this.children.length = 0
  }

  appendChild(child) {
    this.children.push(child)
    child.parentNode = this
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  /** 真实 DOM 的标准 API，前端用它判断"点的是不是菜单按钮自己"。 */
  contains(node) {
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  focus() {}

  getBoundingClientRect() {
    /* 真实 DOMRect 有 right/bottom，浮层拖动正是靠它们算"右下角"，所以这里也得给齐。 */
    return { left: 20, top: 30, width: 340, height: 220, right: 360, bottom: 250 }
  }
}

function walk(node, visit) {
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function findById(root, id) {
  let found = null
  walk(root, (node) => {
    if (found === null && node.id === id) found = node
  })
  return found
}

function findByClass(root, className) {
  let found = null
  walk(root, (node) => {
    if (found === null && node.classList.contains(className)) found = node
  })
  return found
}

/** 按 `title` 找控件：按钮上没有 id，而 title 是给人看的、也最稳定。 */
function findByTitle(root, needle) {
  let found = null
  walk(root, (node) => {
    if (found === null && typeof node.title === 'string' && node.title.includes(needle)) found = node
  })
  return found
}

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.onmessage = null
    this.onerror = null
    this.onopen = null
    FakeEventSource.instances.push(this)
  }

  emit(event) {
    if (this.onmessage !== null) this.onmessage({ data: JSON.stringify(event) })
  }

  static instances = []
}

function fakeFetch(url, options) {
  const target = String(url)
  fakeFetch.calls.push({ url: target, method: options?.method ?? 'GET', body: String(options?.body ?? '') })

  if (target.includes('/sessions')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          active: 'session-a',
          focused: '',
          sessions: [
            { id: 'session-a', title: '读代码', lastAt: Date.now(), lastText: '正在读取 lib/index.js', events: 3 },
            /* 第二个故意没有标题：菜单该退回短 id，而不是显示空行。 */
            { id: 'session-b', title: '', lastAt: Date.now() - 120000, lastText: '我说：你好', events: 1 },
          ],
        }),
    })
  }

  if (target.includes('/focus')) {
    const wanted = JSON.parse(String(options?.body ?? '{}')).sessionId ?? ''
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, focused: wanted, active: wanted === '' ? 'session-a' : wanted }),
    })
  }

  const body = target.includes('/recent') ? { active: '', focused: '', events: [] } : { ok: true }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}
fakeFetch.calls = []

/** 让 fetch 的 then 链跑完。vm 里的 Promise 也是标准 Promise，跨 realm await 一样有效。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function checkFrontend() {
  /* document 上的监听器：拖动靠 document 上的 mousemove / mouseup，Esc 关详情靠 keydown。 */
  const documentListeners = new Map()
  const document = {
    body: new FakeNode('body'),
    head: new FakeNode('head'),
    documentElement: new FakeNode('html'),
    createElement: (tag) => new FakeNode(tag),
    getElementById(id) {
      return findById(document.body, id) ?? findById(document.head, id)
    },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, [])
      documentListeners.get(type).push(listener)
    },
    removeEventListener(type, listener) {
      const list = documentListeners.get(type)
      if (list === undefined) return
      const at = list.indexOf(listener)
      if (at >= 0) list.splice(at, 1)
    },
    dispatch(type, event = {}) {
      for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event)
    },
  }

  const storage = new Map()
  const sandbox = {
    document,
    location: { pathname: '/dsh-danmaku-check', href: 'http://127.0.0.1:19387/dsh-danmaku-check' },
    navigator: { clipboard: null },
    console,
    JSON,
    Math,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    EventSource: FakeEventSource,
    fetch: fakeFetch,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    innerWidth: 1920,
    innerHeight: 1080,
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  createContext(sandbox)

  runInContext(readFileSync(FRONT_FILE, 'utf8'), sandbox, { filename: 'bubbles.js' })
  ok('前端脚本在最小 DOM 里跑通（没有一跑就抛）')

  const root = findById(document.body, ROOT_ID)
  assert.ok(root !== null, `没有挂出 #${ROOT_ID}`)
  assert.ok(document.getElementById('dsh-danmaku-style') !== null, '没有注入样式')
  ok('建出根节点与样式')

  /* 只有气泡和按钮可以在指针上"存在"，其余一切必须穿透——否则 overlay 里会整块桌面点不动。 */
  const stack = findByClass(root, 'dshd-stack')
  assert.ok(stack !== null, '没有气泡栈')
  ok('根节点 / 气泡栈就位')

  assert.equal(FakeEventSource.instances.length, 1, '没有建 SSE 连接')
  assert.ok(FakeEventSource.instances[0].url.endsWith('/dsh-danmaku/v3/stream'), 'SSE 地址不对')
  assert.ok(
    fakeFetch.calls.some((call) => call.url.includes('/recent')),
    '没有回填请求',
  )
  ok('SSE 连接 + recent 回填')

  const source = FakeEventSource.instances[0]
  source.emit({ kind: 'tool:ok', text: '正在读取 lib/index.js', detail: 'read\n\nfile_path:\nD:/a/lib/index.js', session: 'session-a' })
  assert.equal(stack.children.length, 1, '事件没有变成气泡')
  assert.equal(stack.children[0].textContent, '正在读取 lib/index.js')
  assert.ok(stack.children[0].classList.contains('dshd-bubble'))
  assert.equal(
    stack.children[0].style.getPropertyValue('--dshd-accent'),
    '#3F5A7A',
    '按 kind 取色没生效（动作类是低饱和的冷灰蓝）',
  )
  ok('一条事件 → 一颗按 kind 上色的气泡')

  /* 主人要的是"动作和说的话一眼分得开"：两族的**底色**也得不同，不能只差一角边框。 */
  const toolFill = stack.children[0].style.getPropertyValue('--dshd-fill')
  source.emit({ kind: 'assistant', text: '一句话', detail: '', session: 'session-a' })
  const talkFill = stack.children[1].style.getPropertyValue('--dshd-fill')
  assert.notEqual(toolFill, talkFill, '动作和说话的底色一样 —— 那就不叫"一眼分得开"')
  ok('动作与说话用不同底色')

  /*
   * Markdown **渲染**：说话类气泡渲染的是 `detail`（原文），不是 host 洗过的 `text`。
   * 断言看的是渲染结果（innerHTML）—— 露着 `**` 才是要拦的东西。
   */
  source.emit({
    kind: 'assistant',
    text: '（这是菜单预览用的纯文本）',
    detail: '**加粗** 与 `代码`\n\n- 甲\n- 乙\n\n# 标题\n\n[官网](https://example.com)',
    session: 'session-a',
  })
  const rendered = stack.children[stack.children.length - 1].children[0].innerHTML
  assert.ok(rendered.includes('<strong>加粗</strong>'), '没有把 **加粗** 渲染成 <strong>')
  assert.ok(rendered.includes('<code>代码</code>'), '行内代码没有渲染')
  assert.ok(rendered.includes('<li>甲</li>') && rendered.includes('<li>乙</li>'), '列表没有渲染')
  assert.ok(rendered.includes('dshd-md-h'), '标题没有渲染成小标题')
  assert.ok(rendered.includes('<a href="https://example.com"'), '链接没有渲染')
  ok('Markdown 渲染：加粗 / 行内代码 / 列表 / 标题 / 链接')

  /*
   * 安全：消息里的 HTML 只能变成看得见的文字，不能被执行；`javascript:` 链接只留文字。
   * 这条比渲染本身更要紧 —— 渲染意味着从今往后真的在用 innerHTML。
   */
  source.emit({
    kind: 'assistant',
    text: 'x',
    detail: '<img src=x onerror=alert(1)> <script>alert(2)</script> [点我](javascript:alert(3))',
    session: 'session-a',
  })
  const dangerous = stack.children[stack.children.length - 1].children[0].innerHTML
  assert.ok(!dangerous.includes('<img'), 'HTML 注入没有被转义')
  assert.ok(!dangerous.includes('<script'), 'script 标签没有被转义')
  assert.ok(dangerous.includes('&lt;script&gt;'), '转义之后的文字应当还看得见')
  assert.ok(!dangerous.includes('javascript:'), 'javascript: 链接没有被拦下')
  assert.ok(dangerous.includes('点我'), '拦下链接之后应当只留文字')
  ok('Markdown 渲染：HTML 与 javascript: 都被挡住')

  stack.children[0].dispatch('click')
  const detail = findByClass(root, 'dshd-detail')
  assert.ok(detail.classList.contains('dshd-open'), '点击气泡没有打开详情')
  ok('点气泡打开详情')

  for (let index = 0; index < 40; index += 1) {
    /* 说话类气泡渲染的是 `detail`，所以这里两个字段给同一句话。 */
    source.emit({ kind: 'assistant', text: `第 ${String(index)} 条`, detail: `第 ${String(index)} 条`, session: 'session-a' })
  }
  assert.equal(stack.children.length, 30, `气泡数应当被压到 30，现在是 ${String(stack.children.length)}`)
  assert.ok(stack.children[stack.children.length - 1].textContent.includes('第 39 条'), '留下的不是最新的那些')
  assert.ok(stack.children[0].textContent.includes('第 10 条'), '最旧的应当刚好被挤掉')
  ok('气泡上限 30 颗（与 host 每个会话的队列一致），挤掉的是最旧的')

  source.emit({ kind: 'session:switch', text: '跟着你切到 搬弹幕', session: 'session-b' })
  assert.equal(stack.children.length, 1, '切会话没有清空旧气泡')
  assert.ok(stack.children[0].textContent.includes('搬弹幕'))
  ok('切会话清空并提示')

  /* 没有详情的气泡不该做得像能点开——点开一个正文和气泡上一模一样的窗口比不开更糟。 */
  source.emit({ kind: 'turn:end', text: '这一轮结束了', detail: '', session: 'session-b' })
  const last = stack.children[stack.children.length - 1]
  assert.ok(last.classList.contains('dshd-flat'), '没有详情的气泡仍被做成可点')
  ok('无详情的气泡不可点')

  /*
   * 交互三件事：淡化、输入条、拖动。
   *
   * 这三条都在真机上验过一遍（点气泡开详情、◐ 淡化到 0.24、✎ 展开、拖动把位置写进
   * localStorage），在这里钉住是为了以后改样式或改事件时能立刻发现踩坏了。
   */
  const eye = findByTitle(root, '淡出')
  assert.ok(eye !== null, '找不到淡化按钮')
  eye.dispatch('click')
  assert.ok(root.classList.contains('dshd-hidden'), '◐ 没有把浮层切到隐藏态')
  eye.dispatch('click')
  assert.ok(!root.classList.contains('dshd-hidden'), '◐ 再点一次没有恢复')
  ok('◐ 淡化 / 恢复')

  const pen = findByTitle(root, '发一句话')
  assert.ok(pen !== null, '找不到输入条按钮')
  const composer = findByClass(root, 'dshd-composer')
  pen.dispatch('click')
  assert.ok(composer.classList.contains('dshd-open'), '✎ 没有展开输入条')
  pen.dispatch('click')
  assert.ok(!composer.classList.contains('dshd-open'), '✎ 没有收起输入条')
  ok('✎ 输入条展开 / 收起')

  const grip = findByClass(root, 'dshd-grip')
  assert.ok(grip !== null, '找不到拖动把手')
  /*
   * 假 DOM 的 rect 是 (20,30,340,220) ⇒ right=360、bottom=250；抓在 (30,40) ⇒ offset (330,210)；
   * 移到 (500,200) ⇒ right = 1920-830 = 1090、bottom = 1080-410 = 670。
   *
   * 位置**只记 right/bottom**：用 left/top 就等于把顶边钉死，内容一长工具行就被推出屏幕。
   */
  grip.dispatch('mousedown', { button: 0, clientX: 30, clientY: 40, preventDefault() {} })
  document.dispatch('mousemove', { clientX: 500, clientY: 200 })
  document.dispatch('mouseup', {})
  assert.equal(root.style.right, '1090px', '拖动没有把浮层挪过去')
  assert.equal(root.style.bottom, '670px', '拖动没有把浮层挪过去')
  assert.equal(root.style.top, 'auto', '拖动之后还留着 top —— 那会让内容朝下长、工具行被顶出屏幕')
  await flush()
  const placeCalls = fakeFetch.calls.filter((call) => call.url.includes('/place'))
  assert.equal(placeCalls.length, 1, '拖动结束没有把位置报给 host（另一个宿主就同步不到）')
  assert.ok(placeCalls[0].body.includes('1090'), '/place 的 body 里没有新位置')
  ok('拖动 → right/bottom + 报给 host')

  /* 会话菜单：开关、列表、选择、点外面收起。 */
  const menuButton = findByTitle(root, '选择要看哪个会话')
  assert.ok(menuButton !== null, '找不到会话菜单按钮')
  const menu = findByClass(root, 'dshd-menu')
  assert.ok(menu !== null, '找不到菜单容器')

  menuButton.dispatch('click')
  assert.ok(menu.classList.contains('dshd-open'), '点 ☰ 没有打开菜单')
  await flush()
  await flush()

  const items = []
  walk(menu, (node) => {
    if (node.classList.contains('dshd-item')) items.push(node)
  })
  assert.equal(items.length, 2, `菜单里应当是两个会话（没有"自动跟随"这一项），实际 ${String(items.length)} 项`)
  assert.equal(items[0].title, 'session-a', '第一项应当是最近说话的那个会话')
  assert.equal(items[1].title, 'session-b', '完整 id 应当挂在 title 上')
  assert.ok(items[1].textContent.includes('ession-b'), '没有标题的会话应当退回 id 尾部而不是空行')
  ok('☰ 打开菜单：列出会话（没标题退回 id 尾部，且没有"自动跟随"项）')

  const beforeFocus = fakeFetch.calls.filter((call) => call.url.includes('/focus')).length
  items[1].dispatch('click')
  await flush()
  await flush()
  const focusCalls = fakeFetch.calls.filter((call) => call.url.includes('/focus'))
  assert.equal(focusCalls.length, beforeFocus + 1, '点会话项没有发出 /focus')
  assert.ok(focusCalls[focusCalls.length - 1].body.includes('session-b'), '/focus 的 body 里不是点中的那个会话')
  assert.ok(!menu.classList.contains('dshd-open'), '选完之后菜单没有收起')
  ok('点一个会话 → POST /focus 并收起菜单')

  menuButton.dispatch('click')
  assert.ok(menu.classList.contains('dshd-open'), '菜单没打开')
  document.dispatch('mousedown', { target: root })
  assert.ok(!menu.classList.contains('dshd-open'), '点别处没有收起菜单')
  ok('点别处收起菜单')
}

// --------------------------------------------------------------------------- //

console.log('host 半边：')
await checkHost()
console.log('前端：')
await checkFrontend()
console.log(`\n全部通过（${String(passed)} 项）`)
