/**
 * dsh-danmaku —— 现场自检
 *
 * `tools/check.mjs` 是离线自检（假 root、假 DOM），它验的是"代码对不对"。
 * 这个脚本验的是另一件事：**这台机器上、此刻跑着的那个进程**，四件事是不是真的成立了 ——
 *
 *   1. host 半边是**新代码**（`status` 里的 `build` 字段）；
 *   2. SSE 长连接能稳住（不是 open 完就断 —— 那正是 timer 没进 inject 时的样子）；
 *   3. DSH 的 index 里有前端 loader（web 形态的注入）；
 *   4. overlay 页面的白名单里也有那份脚本（跨插件那一条）。
 *
 * 2 是这里最要紧的一条：它没有别的观测点，浏览器里只会看到"前端无限重连"，host 侧一声不吭。
 *
 * 跑法：
 *   node tools/verify-live.mjs
 *   node tools/verify-live.mjs --port 19387
 *   DSH_DANMAKU_LOGIN_URL='http://127.0.0.1:19387/?token=…' node tools/verify-live.mjs
 *
 * 第 3 项要凭据（index 有授权栅栏）。凭据默认从旁边那个 overlay 仓库的
 * `.launch-url.txt` 里读 —— 那是 fresh process token 唯一的落点；读不到就跳过这一项，
 * 不当成失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SIBLING_LAUNCH_URL = join(ROOT, '..', 'dsh-desktop-overlay', '.launch-url.txt')

const args = process.argv.slice(2)
function argument(name, fallback) {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const PORT = Number(argument('--port', process.env.DSH_DANMAKU_PORT ?? '19387'))
const ORIGIN = `http://127.0.0.1:${String(PORT)}`
const FRONT_URL = '/dsh-danmaku/v3/bubbles.js'
/*
 * 期望的 host 版本，与 `lib/index.js` 里 status 的 `build` 字段一致。
 * 改了 host 就把它跟着 +1 —— "重启之后自检该不该全绿"因此只看一处。
 */
const EXPECTED_BUILD = 'v3'

let failed = 0
let skipped = 0

function pass(label, detail = '') {
  console.log(`  \u2713 ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function fail(label, detail = '') {
  failed += 1
  console.log(`  \u2717 ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function skip(label, detail = '') {
  skipped += 1
  console.log(`  \u25CB ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** `.launch-url.txt` 里有两行：login=…（带 token）与 page=…。 */
function readLoginUrl() {
  if (typeof process.env.DSH_DANMAKU_LOGIN_URL === 'string' && process.env.DSH_DANMAKU_LOGIN_URL !== '') {
    return process.env.DSH_DANMAKU_LOGIN_URL
  }
  try {
    const text = readFileSync(SIBLING_LAUNCH_URL, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('login=')) return line.slice('login='.length).trim()
    }
  } catch {
    /* 没有就没有，下面会跳过需要凭据的那一项。 */
  }
  return ''
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'manual' })
  return { response, text: await response.text() }
}

/** 用带 token 的 login URL 换一份会话 cookie。token 只在 index 那一次请求上生效。 */
async function sessionCookie(loginUrl) {
  try {
    const response = await fetch(loginUrl, { redirect: 'manual' })
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    const pairs = list.map((entry) => entry.split(';')[0]).filter((entry) => entry !== '')
    return pairs.join('; ')
  } catch (error) {
    return ''
  }
}

// --------------------------------------------------------------------------- //

console.log(`dsh-danmaku 现场自检 · ${ORIGIN}\n`)

// 1) host 半边活着，而且是新代码 ---------------------------------------------- //

let status = null
try {
  const { response, text } = await fetchText(`${ORIGIN}/dsh-danmaku/v3/status`)
  if (response.status !== 200) {
    fail('host 半边应答', `HTTP ${String(response.status)}（路由没注册，或者插件没启用）`)
  } else {
    status = JSON.parse(text)
    if (status.build === EXPECTED_BUILD) {
      pass('host 半边是新代码', `build ${String(status.build)}`)
    } else {
      fail(
        'host 半边是新代码',
        `build=${String(status.build)}，期望 ${EXPECTED_BUILD} —— 跑的还是旧模块，改完 host 代码必须重启客户端（禁用再启用不算）`,
      )
    }
    /* 旧模块没有这几个诊断字段，所以先认 build：认不出来就不假装检查过了。 */
    if (status.build !== EXPECTED_BUILD) {
      skip('SSE handler 没抛过错', '旧模块没有这个诊断字段')
    } else if (typeof status.lastStreamError === 'string' && status.lastStreamError !== '') {
      fail('SSE handler 没抛过错', status.lastStreamError.split('\n')[0])
    } else {
      pass('SSE handler 没抛过错')
    }
    if (typeof status.active === 'string' && status.active !== '') {
      pass('跟着一个活跃会话', status.active.slice(0, 8) + '…')
    } else {
      skip('活跃会话', '还没有任何事件到达（说一句话再看）')
    }
  }
} catch (error) {
  fail('host 半边应答', String(error?.message ?? error))
}

// 2) SSE 真的能稳住 ----------------------------------------------------------- //

if (status !== null) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const response = await fetch(`${ORIGIN}/dsh-danmaku/v3/stream`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = ''
    let closedEarly = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(0, deadline - Date.now()))),
      ])
      if (chunk.timeout === true) break
      if (chunk.done === true) {
        closedEarly = true
        break
      }
      received += decoder.decode(chunk.value, { stream: true })
    }
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    if (closedEarly) {
      fail(
        'SSE 长连接稳得住',
        '连接在 5 秒内被服务端结束了 —— handler 里大概抛错了（看一眼上面那条 lastStreamError）',
      )
    } else if (received.includes(': connected')) {
      const frames = (received.match(/^data: /gm) ?? []).length
      pass('SSE 长连接稳得住', `收到开场帧，5 秒内 ${String(frames)} 条事件`)
    } else {
      fail('SSE 长连接稳得住', '连开场帧都没收到')
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    /*
     * 服务端销毁 socket 时，undici 抛出来的是一句 `terminated` —— 一个不指向任何东西的词。
     * 这里把它翻译成现场真正发生的事。
     */
    if (message.includes('terminated') || message.includes('ECONNRESET') || message.includes('socket hang up')) {
      fail('SSE 长连接稳得住', '连接被服务端中途掐断 —— handler 里大概抛错了（看一眼上面那条 lastStreamError）')
    } else {
      fail('SSE 长连接稳得住', message)
    }
  }
}

// 3) DSH 的 index 里有前端 loader --------------------------------------------- //

const loginUrl = readLoginUrl()
if (loginUrl === '') {
  skip('DSH index 里有前端 loader', '拿不到带 token 的 login URL（设 DSH_DANMAKU_LOGIN_URL 或准备旁边的 overlay 仓库）')
} else {
  try {
    const cookie = await sessionCookie(loginUrl)
    const { response, text } = await fetchText(`${ORIGIN}/`, cookie === '' ? {} : { cookie })
    if (response.status !== 200) {
      fail('DSH index 里有前端 loader', `index 取不到：HTTP ${String(response.status)}`)
    } else if (text.includes(FRONT_URL)) {
      pass('DSH index 里有前端 loader')
    } else {
      fail(
        'DSH index 里有前端 loader',
        'index 里没有我们的那行 —— 多半是注入行注册得太晚（必须在 apply 一开头），或者插件没启用',
      )
    }
  } catch (error) {
    fail('DSH index 里有前端 loader', String(error?.message ?? error))
  }
}

// 4) overlay 页面的白名单里也有 ----------------------------------------------- //

try {
  const { response, text } = await fetchText(`${ORIGIN}/dsh-overlay`)
  if (response.status !== 200) {
    fail('overlay 白名单里有弹幕前端', `overlay 页面取不到：HTTP ${String(response.status)}`)
  } else if (text.includes(FRONT_URL)) {
    pass('overlay 白名单里有弹幕前端')
  } else {
    fail(
      'overlay 白名单里有弹幕前端',
      'overlay 页面里没有这个 script —— 改过 WHITELIST 之后要重启客户端（那是 overlay 的 host 常量）',
    )
  }
} catch (error) {
  fail('overlay 白名单里有弹幕前端', String(error?.message ?? error))
}

// --------------------------------------------------------------------------- //

console.log('')
if (failed === 0) {
  console.log(`全部通过${skipped === 0 ? '' : `（${String(skipped)} 项跳过）`}`)
} else {
  console.log(`${String(failed)} 项不通过${skipped === 0 ? '' : `，${String(skipped)} 项跳过`}`)
  process.exitCode = 1
}
