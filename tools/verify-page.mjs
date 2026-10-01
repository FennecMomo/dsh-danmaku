/**
 * dsh-danmaku —— 页面端到端自检
 *
 * 前两个脚本问的是别的问题：
 *   - `check.mjs`     ：代码对不对（假 root、假 DOM，不碰真机）；
 *   - `verify-live.mjs`：这台机器上的**接口**对不对（host 是不是新代码、SSE 稳不稳、白名单在不在）。
 *
 * 这个脚本问的是最后一件：**页面里到底长出来没有**。它起一个**独立的**无头 Edge
 * （独立 user-data-dir，绝不碰主人在用的浏览器），走带 token 的 login URL 建立会话，
 * 打开真实页面，然后：
 *
 *   1. 前端脚本有没有被自动注入（不是手工塞进去的）；
 *   2. 有没有气泡、文本对不对；
 *   3. 点一颗气泡，详情面板开不开、正文对不对；
 *   4. 前端自己有没有在喊"事件流断开"——这是 SSE 那条链路的现场证据；
 *   5. 截图一张，好看清它落在哪、挡住什么没有。
 *
 * 跑法：
 *   node tools/verify-page.mjs
 *   node tools/verify-page.mjs --url /dsh-overlay      # 验 overlay 页面那一份
 *   node tools/verify-page.mjs --keep                  # 留着浏览器和截图，方便自己看
 *   node tools/verify-page.mjs --out D:\shot.png
 *
 * 凭据：默认从旁边 overlay 仓库的 `.launch-url.txt` 读（fresh process token 唯一的落点），
 * 也可以用 `DSH_DANMAKU_LOGIN_URL` 或 `--login` 指定。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SIBLING_LAUNCH_URL = join(ROOT, '..', 'dsh-desktop-overlay', '.launch-url.txt')

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

const args = process.argv.slice(2)
function argument(name, fallback) {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const PORT = Number(argument('--port', process.env.DSH_DANMAKU_PORT ?? '19387'))
const CDP_PORT = Number(argument('--cdp-port', '9231'))
const ORIGIN = `http://127.0.0.1:${String(PORT)}`
const PAGE_PATH = argument('--url', '/')
const KEEP = args.includes('--keep')
const OUT_PNG = argument('--out', join(tmpdir(), 'dsh-danmaku-page.png'))
const SETTLE_MS = Number(argument('--settle', '9000'))

let failed = 0
function pass(label, detail = '') {
  console.log(`  \u2713 ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
function fail(label, detail = '') {
  failed += 1
  console.log(`  \u2717 ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function readLoginUrl() {
  const explicit = argument('--login', process.env.DSH_DANMAKU_LOGIN_URL ?? '')
  if (explicit !== '') return explicit
  try {
    for (const line of readFileSync(SIBLING_LAUNCH_URL, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('login=')) return line.slice('login='.length).trim()
    }
  } catch {
    /* 交给下面的报错 */
  }
  return ''
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --------------------------------------------------------------------------- //

const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate))
if (edge === undefined) {
  console.error('找不到 msedge.exe，跳过页面自检')
  process.exitCode = 2
  process.exit()
}

const loginUrl = readLoginUrl()
if (loginUrl === '') {
  console.error('拿不到带 token 的 login URL（用 --login 或 DSH_DANMAKU_LOGIN_URL 指定）')
  process.exitCode = 2
  process.exit()
}

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-danmaku-page-'))

/** 只认我们自己起的那个实例：命令行里带着这个 user-data-dir。 */
function killEdge() {
  return new Promise((resolve) => {
    const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profileDir.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    const killer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
    killer.on('exit', () => resolve())
    killer.on('error', () => resolve())
  })
}

const child = spawn(
  edge,
  [
    '--headless=new',
    `--remote-debugging-port=${String(CDP_PORT)}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,900',
    loginUrl,
  ],
  { stdio: 'ignore', detached: false },
)

console.log(`dsh-danmaku 页面自检 · ${ORIGIN}${PAGE_PATH}\n`)

try {
  // -- 等 CDP 起来，并找到目标页面 -------------------------------------------- //

  let page = null
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await sleep(500)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)).json()
      page = targets.find((target) => target.type === 'page' && String(target.url).includes(`127.0.0.1:${String(PORT)}`))
      if (page !== undefined) break
    } catch {
      /* CDP 还没监听 */
    }
  }
  if (page === null || page === undefined) {
    fail('打开真实页面', 'CDP 30 秒内没有报出目标页面')
    throw new Error('no page target')
  }
  pass('打开真实页面', String(page.url))

  // -- 连上它 ---------------------------------------------------------------- //

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  })
  function send(method, params = {}) {
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined && result.exceptionDetails !== null) {
      /*
       * 别只取 `text` —— 那通常就是一句 "Uncaught"，行号和真正的消息都在 `exception` 里。
       * 只打 `text` 的话，页面里抛的错在报告里等于没有信息。
       */
      const details = result.exceptionDetails
      const described = details.exception?.description ?? details.exception?.value ?? details.text
      throw new Error(String(described ?? 'evaluate threw'))
    }
    return result.result?.value ?? null
  }

  await send('Runtime.enable')
  await send('Page.enable')

  if (PAGE_PATH !== '/') {
    await send('Page.navigate', { url: `${ORIGIN}${PAGE_PATH}` })
    await sleep(2000)
  }

  /* 页面自己把 DOM 建起来需要时间；前端还会先拉一次回填。 */
  await sleep(SETTLE_MS)

  // -- 检查 ------------------------------------------------------------------ //

  const report = await evaluate(`(async () => {
    const errors = []
    window.addEventListener('error', (event) => errors.push(String(event.message)))
    for (let i = 0; i < 40; i += 1) {
      if (document.getElementById('dsh-danmaku-root') !== null) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const root = document.getElementById('dsh-danmaku-root')
    if (root === null) return { injected: false, errors, path: location.pathname }
    const stack = root.querySelector('.dshd-stack')
    for (let i = 0; i < 24 && stack.children.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const bubbles = [...stack.children]
    const note = root.querySelector('.dshd-note')
    /*
     * 那行提示会在 open 与 error 之间**闪**：EventSource 一重连成功就把它清空，一失败又写回去。
     * 只读一次的话有一半概率正好读到"干净"的那一瞬，于是把断线的连接误判成健康的 ——
     * 这个脚本的第一版就是这么被骗过去的。所以连采 8 次，并且顺手数一下 performance 里
     * /stream 被请求了几条记录：一条健康的长连接只有 1 条，不断重连就是一小串。
     * （注意别在这里用反引号：这段整体是外层模板字符串的一部分，一个反引号就会把它截断。）
     */
    const noteSamples = []
    for (let i = 0; i < 8; i += 1) {
      noteSamples.push(note === null ? '' : note.textContent)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const streamRequests = performance
      .getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/dsh-danmaku/v3/stream')).length
    const withDetail = bubbles.find((bubble) => !bubble.classList.contains('dshd-flat'))
    let detail = null
    if (withDetail !== undefined) {
      withDetail.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      const panel = root.querySelector('.dshd-detail')
      detail = {
        open: panel.classList.contains('dshd-open'),
        title: panel.querySelector('header span').textContent.slice(0, 60),
        chars: panel.querySelector('pre').textContent.length,
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      detail.closedByEscape = !panel.classList.contains('dshd-open')
    }
    return {
      injected: true,
      path: location.pathname,
      bubbles: bubbles.length,
      texts: bubbles.map((bubble) => bubble.textContent.slice(0, 60)),
      noteSamples,
      streamRequests,
      detail,
      errors,
    }
  })()`)

  if (report === null || report.injected !== true) {
    fail('前端被自动注入', `页面 ${String(report?.path ?? PAGE_PATH)} 里没有 #dsh-danmaku-root`)
  } else {
    pass('前端被自动注入', String(report.path))
  }

  if (Array.isArray(report?.errors) && report.errors.length > 0) {
    fail('页面没有 JS 错误', report.errors.join(' | ').slice(0, 160))
  } else {
    pass('页面没有 JS 错误')
  }

  if (report?.injected === true) {
    if (report.bubbles > 0) {
      pass('气泡长出来了', `${String(report.bubbles)} 颗 · 最新一句：${String(report.texts[report.texts.length - 1] ?? '')}`)
    } else {
      fail('气泡长出来了', '一颗都没有（回填是空的？这条会话还没有事件？）')
    }

    /*
     * SSE 的现场证据，两个独立的观测点：
     *   - 那行提示在采样窗口里有没有出现过"断开/重连"（闪一下也算）；
     *   - performance 里 `/stream` 被请求了几条 —— 健康时 1 条长连接，重连就是一小串。
     * 只靠瞬时的 note 会被 open/error 的闪烁骗过去，两个一起看才作数。
     */
    const samples = Array.isArray(report.noteSamples) ? report.noteSamples : []
    const complained = samples.find((line) => line.includes('断开') || line.includes('重连'))
    const requests = typeof report.streamRequests === 'number' ? report.streamRequests : 0
    if (complained !== undefined) {
      fail('事件流连着', `前端在喊：${complained}`)
    } else if (requests > 2) {
      fail('事件流连着', `/stream 被请求了 ${String(requests)} 次 —— 一条健康的长连接只该有 1 条记录`)
    } else {
      pass('事件流连着', `/stream 记录 ${String(requests)} 条`)
    }

    if (report.detail === null) {
      fail('点气泡能看全文', '没有一颗带详情的气泡可点')
    } else if (report.detail.open && report.detail.chars > 0 && report.detail.closedByEscape) {
      pass('点气泡能看全文', `${String(report.detail.chars)} 字 · Esc 能关`)
    } else {
      fail('点气泡能看全文', JSON.stringify(report.detail))
    }
  }

  // -- 截图 ------------------------------------------------------------------ //

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'))
  console.log(`  \u25CB 截图 -> ${OUT_PNG}`)

  socket.close()
} catch (error) {
  if (failed === 0) fail('页面自检', String(error?.message ?? error))
} finally {
  if (KEEP) {
    console.log(`  \u25CB --keep：浏览器与临时目录留着（${profileDir}）`)
  } else {
    /* 两个都要收：我们自己起的那个 pid，以及它拉起来的那些子进程。 */
    try {
      child.kill()
    } catch {
      /* 已经没了 */
    }
    await killEdge()
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 目录被浏览器占着时删不掉，不影响结论 */
    }
  }
}

console.log('')
if (failed === 0) console.log('全部通过')
else console.log(`${String(failed)} 项不通过`)

/*
 * 显式退出。
 *
 * 光把结论打完是不够的：我们自己起的那个浏览器进程（以及它与 CDP 之间的 socket）会一直
 * hold 住事件循环，脚本于是"报告完了却不结束"—— 上一次它就是这样挂成了后台任务。
 */
child.unref()
await sleep(50)
process.exit(failed === 0 ? 0 : 1)
