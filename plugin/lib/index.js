/**
 * Danmaku overlay: the event bridge and the panel control, as a real plugin.
 *
 * Why this is a package and not a dynamic plugin
 * ----------------------------------------------
 * A dynamic Cordis plugin lives only inside the running process. On the next
 * restart it is gone: no rows to compose, so the session-header button simply
 * does not exist and there is nothing to click. That is fine for a probe and
 * wrong for a feature, so the whole thing lives here and loads from the profile's
 * `cordis.patch.yml` on every start.
 *
 * Two routes exist because a persistent plugin has no `harness.handle`/`host.call`
 * pair - that RPC belongs to dynamic packages. `webServer.register` hands out
 * plain Node `req`/`res`, so the page talks to this plugin over ordinary HTTP.
 * The other two routes are the SSE stream and recent-event JSON the Python panel
 * reads; keeping them here means the panel has no dependency on anything dynamic.
 *
 *     GET  /dsh-danmaku/v3/status?session=<id>   the button's poll
 *     POST /dsh-danmaku/v3/toggle               open/close the panel
 *     GET  /dsh-danmaku/v3/stream               SSE, live events
 *     GET  /dsh-danmaku/v3/recent               JSON backfill
 *
 * Every route is registered through `ctx.effect`, so stopping or updating this
 * plugin withdraws all four. A row that leaves a listener or a route behind is
 * how a plugin keeps answering after it is supposed to be gone.
 */

/*
 * Where everything lives.
 *
 * The overlay is Python and sits beside this package inside the same repository,
 * so its directory is derived rather than assumed: `plugin/lib` -> the repository
 * root -> `danmaku/`. That is what keeps the checkout portable - the repository
 * can live anywhere on any machine and nothing here needs editing.
 *
 * Both path overrides are optional, for the case where the panel is kept outside
 * this repository; with neither set, the panel is the one here.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository this package lives in: `<repo>/plugin/lib` -> `<repo>`. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function firstExisting(candidates, fallback) {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)) return candidate
  }
  return fallback
}

const PANEL_DIR = firstExisting(
  [
    process.env.DSH_DANMAKU_DIR,
    /* A directory named by a desktop shell, when one launched this Host. */
    process.env.DSH_DESKTOP_HOME === undefined
      ? undefined
      : join(process.env.DSH_DESKTOP_HOME, 'danmaku'),
    join(PACKAGE_ROOT, 'danmaku'),
  ],
  join(PACKAGE_ROOT, 'danmaku'),
)
const PANEL_SCRIPT = join(PANEL_DIR, 'danmaku_panel.pyw')
const STOP_SCRIPT = join(PANEL_DIR, 'stop-panel.ps1')

/*
 * The interpreter, likewise found rather than assumed. `pythonw.exe` may sit
 * beside `python.exe` (a normal CPython install) or somewhere else entirely;
 * both are probed, and the same directory serves both roles.
 */
const PYTHON_DIR = firstExisting(
  [process.env.DSH_DANMAKU_PYTHON_DIR, 'C:/Python314'],
  'C:/Python314',
)
const PYTHON = join(PYTHON_DIR, 'python.exe')
const PYTHONW = join(PYTHON_DIR, 'pythonw.exe')

const PWSH = join(
  process.env.SystemRoot ?? 'C:/Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)


/** Events kept for a late-joining panel. A backfill, not a history. */
const RECENT_LIMIT = 120
/** How long a launch may take before it is reported as failed. */
const STARTUP_SETTLE_MS = 8000

// --------------------------------------------------------------------------- //
// Frame helpers
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
      // The only body this plugin accepts is a small JSON object. Anything
      // larger is not a request it understands, so it is dropped rather than
      // buffered.
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

function numberOrNull(pattern, text) {
  const match = pattern.exec(text)
  return match ? Number(match[1]) : null
}

function parseStatus(text) {
  /* 'running pid=1 hwnd=2 bubbles=3 ingested=4 height=266 age=2.0s' */
  const line = typeof text === 'string' ? text : ''
  return {
    running: false,
    pid: numberOrNull(/pid=(\d+)/, line),
    bubbles: numberOrNull(/bubbles=(\d+)/, line),
    ingested: numberOrNull(/ingested=(\d+)/, line),
    height: numberOrNull(/height=(\d+)/, line),
    line,
  }
}

function plain(state) {
  /* Rebuilt field by field. `undefined` is not JSON, and a route that hands one
     back produces a body the caller cannot distinguish from "no answer". */
  return {
    running: state.running === true,
    unknown: state.unknown === true,
    pid: state.pid === undefined ? null : state.pid,
    bubbles: state.bubbles === undefined ? null : state.bubbles,
    ingested: state.ingested === undefined ? null : state.ingested,
    height: state.height === undefined ? null : state.height,
    session: typeof state.session === 'string' ? state.session : '',
    line: typeof state.line === 'string' ? state.line : '',
    note: typeof state.note === 'string' ? state.note : '',
  }
}

/* Single quotes for PowerShell arguments: inside them nothing is interpolated,
   which matters because a session id and a URL both look like variables. An
   embedded single quote is doubled, which is how PowerShell escapes one. */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

// --------------------------------------------------------------------------- //
// The plugin
// --------------------------------------------------------------------------- //

export const name = 'danmaku-overlay'
export const inject = ['subprocess', 'shell', 'timer', 'webServer', 'sessionController']

export function apply(ctx) {
  const listeners = new Set()
  const recent = []

  // -- the event stream the panel reads ------------------------------------- //

  function publish(event) {
    recent.push(event)
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT)
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const listener of listeners) {
      try {
        listener.write(frame)
      } catch {
        /* A dead socket is removed by its own close handler; dropping this
           frame is correct and retrying it would be worse. */
      }
    }
  }

  /* Read only the leaf fields the panel renders. The event payloads carry live
     DSH objects, so nothing is copied wholesale and nothing is stringified.
  
     The field names come from ToolExecutionInput, which is NOT the vocabulary the
     panel speaks: the execution object carries `name`, `arguments`, and an `agent`
     whose `id` is the session. An earlier version read `toolName` / `args` /
     `sessionId`, which silently produced bubbles with no tool and no subject -
     the events arrived, so nothing looked broken. */
  /*
   * A tool's own arguments are the whole story of what it did, so they are built
   * into readable text here for the detail window.
   *
   * The values are the execution's own arguments - plain JSON by the time they
   * reach a tool - and each is clipped, so one enormous command cannot turn the
   * payload into something unreadable. Losing the tail of a very long string is a
   * far better outcome than a detail window nobody can scroll to the end of.
   */
  const DETAIL_VALUE_LIMIT = 1600

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

  ctx.on('tools/result', (exec, result) => {
    if (result === null || result === undefined) return
    const failed = result.isError === true
    const name = typeof exec?.name === 'string' ? exec.name : ''
    const args = exec?.arguments !== undefined && exec.arguments !== null ? exec.arguments : undefined
    const body = describeCall(args)
    publish({
      kind: failed ? 'tool:error' : 'tool:ok',
      tool: name === '' ? undefined : name,
      args,
      // The bubble sentence names the tool and its subject; the detail is the full
      // call, which is what someone clicking a tool bubble is asking for.
      detail: body === '' ? `${name}（没有参数）` : `${name}\n\n${body}`,
      session: typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined,
    })
  })

  /*
   * The session log feed. The payload lives under `event.data` - a SessionEvent is
   * `{ type, seq, time, data }` - and an earlier version read `event.reason` and
   * `event.text`, neither of which exists. Nothing threw: the events arrived, and
   * every bubble they produced was empty.
   *
   * Only leaf fields are read, and message text is pulled out block by block. The
   * message objects are live DSH values, so they are never copied or stringified
   * wholesale.
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

  /** The most recent assistant text, so a turn with no answer can say so. */
  let lastAnswer = null

  /** Why a turn ended without producing an answer. */
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

  ctx.on('session/event', (session, event) => {
    if (event === null || event === undefined) return
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    const data = event.data
    if (data === null || data === undefined) return

    if (event.type === 'turn/end') {
      // The reason is a discriminated union, not a string: { kind: 'completed' }.
      const kind = data.reason?.kind
      const reason = typeof kind === 'string' ? kind : ''
      /*
       * A NORMAL ending publishes nothing.
       *
       * "这一轮结束了" says nothing the answer bubble has not already said, and it
       * was actively harmful: it carried no text, so clicking it opened a detail
       * window whose entire body was that label. A reader who wants to know what
       * was said gained a bubble that answered nothing and pushed the answer up.
       *
       * The exception is an ending that produced no answer at all. If the last
       * assistant message had no text - an abort, an error, an interruption - then
       * the turn-end bubble is the only thing that explains the silence, so it is
       * published with the explanation as its detail.
       */
      if (reason !== 'completed' || lastAnswer === null) {
        publish({
          kind: 'turn:end',
          reason,
          detail: lastAnswer === null ? turnEndDetail(reason) : lastAnswer,
          session: sessionId,
        })
      }
      lastAnswer = null
      return
    }

    if (event.type === 'user/message') {
      const text = textOfMessage(data)
      if (text !== '') publish({ kind: 'user', text, detail: text, session: sessionId })
      return
    }

    if (event.type === 'assistant/message') {
      const message = data.message
      const text = textOfMessage(message)
      if (text === '') return
      /*
       * A message that asks for tools is a step on the way; one that does not is
       * the answer. `content` carries the tool-call blocks, so that is what
       * distinguishes them - and the reply is the one worth clicking, because it
       * is the long one.
       */
      const wantsTools = Array.isArray(message?.content)
        ? message.content.some((block) => block?.type === 'tool-call')
        : false
      lastAnswer = text
      publish({
        kind: wantsTools ? 'assistant' : 'assistant:final',
        text,
        detail: text,
        session: sessionId,
      })
    }
  })

  /*
   * Send one prompt to a session, the same way the DSH page does: through
   * `sessionController.prompt`, which is the Host service behind the generated
   * `ctx.remote.session` namespace.
   *
   * Read from the Service contract rather than guessed. The request is
   * `{ requestId, sessionId, mode, content }`, where content is an array of
   * `PromptContentPart`, and the answer is `{ accepted: true }`. `mode: 'queue'` is
   * the ordinary case - a message typed while the agent is mid-turn waits its turn
   * instead of interrupting - and `steer` is available for when interrupting is
   * what is wanted.
   */
  function newRequestId() {
    // Only needs to be unique among this session's in-flight requests, and
    // `Math.random` is enough for that; a uuid would be a dependency for nothing.
    return `dnk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  async function sendPrompt(sessionId, text, mode) {
    const controller = ctx.sessionController
    if (controller === undefined) {
      return { ok: false, error: 'this deployment has no session controller' }
    }
    /*
     * The signal is NOT optional. The signature is `prompt(request, signal)`, and
     * leaving it out fails inside the service with "Cannot read properties of
     * undefined (reading 'throwIfAborted')" - a message that names nothing useful,
     * which is why the argument list is worth reading instead of assuming a
     * trailing parameter can be skipped.
     *
     * Aborted after a bounded wait: admission is quick, and a prompt not admitted
     * by then is not going to be. The timer comes from the injected service, since
     * a bare setTimeout is not available in a dynamic package - and `timer` was
     * already declared.
     */
    const abort = new AbortController()
    const stop = ctx.timeout(() => abort.abort(), 20000)
    try {
      const result = await controller.prompt(
        {
          requestId: newRequestId(),
          sessionId,
          mode: mode === 'steer' ? 'steer' : 'queue',
          content: [{ type: 'text', text }],
        },
        abort.signal,
      )
      return { ok: result?.accepted === true, error: '' }
    } catch (error) {
      const message = error?.message ?? String(error)
      return { ok: false, error: message.slice(0, 300) }
    } finally {
      stop()
    }
  }

  // -- talking to the panel process ----------------------------------------- //

  async function runShell(command, timeoutMs) {
    const spec = ctx.shell.resolve({ command, workdir: PANEL_DIR, timeoutMs })
    /* `execute` hands back a live handle, not a finished result - the result
       projection is a second await. An older DSH exposed this as one `run(spec)`
       call that returned the result directly, and that method is gone. */
    const handle = await ctx.shell.execute(spec)
    const result = await handle.result()
    const stdout = result?.stdout?.text
    const stderr = result?.stderr?.text
    return {
      code: result?.exitCode === null || result?.exitCode === undefined ? null : Number(result.exitCode),
      text: typeof stdout === 'string' ? stdout.trim() : '',
      err: typeof stderr === 'string' ? stderr.trim() : '',
    }
  }

  async function readStatusFile() {
    const fs = ctx.get('fs')
    if (fs === undefined) return null
    try {
      const target = await fs.resolve(`${PANEL_DIR}/.panel-status.json`)
      const parsed = JSON.parse(await fs.readText(target))
      if (parsed === null || typeof parsed !== 'object') return null
      return {
        session: typeof parsed.session === 'string' ? parsed.session : '',
        bubbles: typeof parsed.bubbles === 'number' ? parsed.bubbles : null,
        ingested: typeof parsed.ingested === 'number' ? parsed.ingested : null,
        height: parsed.settings && typeof parsed.settings.height === 'number' ? parsed.settings.height : null,
      }
    } catch {
      /* Absent, unreadable, or caught mid-rewrite. The exit code still answers
         the only question that matters, so this is not an error. */
      return null
    }
  }

  /*
   * Probe with python.exe, launch with pythonw.exe.
   *
   * pythonw.exe is a GUI-subsystem binary, and such a program has no console:
   * given a pipe on stdout, Windows discards the output instead of connecting
   * it. Measured three times in a row - pythonw returned exit code 0 and an
   * empty string for the same `--status` call that python answered in full. So
   * the probe lost its answer and the button read "closed" for a panel that was
   * running. The launch keeps pythonw so no console window flashes behind the
   * overlay.
   */
  async function probe() {
    let result
    try {
      result = await runShell(`${PYTHON} ${psQuote(PANEL_SCRIPT)} --status`, 15000)
    } catch (error) {
      return plain({ running: false, unknown: true, note: String(error?.message ?? error) })
    }
    const parsed = parseStatus(result.text)
    // The exit code is the authority; the text only adds detail.
    // 0 running, 1 stopped, 2 never started.
    parsed.running = result.code === 0
    parsed.unknown = result.code === 2
    if (result.text === '' && result.err !== '') parsed.note = result.err.slice(0, 160)
    const detail = await readStatusFile()
    if (detail !== null) {
      parsed.session = detail.session
      if (detail.bubbles !== null) parsed.bubbles = detail.bubbles
      if (detail.ingested !== null) parsed.ingested = detail.ingested
      if (detail.height !== null) parsed.height = detail.height
    }
    return plain(parsed)
  }

  /*
   * The launch uses subprocess.spawn, and that is not a style choice.
   *
   * `ctx.shell` reaps the shell's whole process tree when a command completes,
   * so a panel started that way is dead within seconds - and quietly, because it
   * had already written its startup log line first. It reads exactly like a
   * crash on startup. Measured by launching the identical command both ways:
   * through ctx.shell the process was gone every time, through a shell of my own
   * it was still alive ten seconds later.
   */
  function startPanel(sessionId) {
    const webServer = ctx.get('webServer')
    const baseUrl = webServer !== undefined && typeof webServer.port === 'number'
      ? `http://127.0.0.1:${String(webServer.port)}`
      : ''
    if (baseUrl === '') return { ok: false, reason: 'no web server in this scope' }
    try {
      ctx.subprocess.spawn({
        argv: [PYTHONW, PANEL_SCRIPT, '--session', sessionId, '--url', baseUrl],
        cwd: PANEL_DIR,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 5000,
      })
      return { ok: true, baseUrl }
    } catch (error) {
      return { ok: false, reason: `spawn threw: ${String(error?.message ?? error)}` }
    }
  }

  /*
   * Stopping matches the process by its command line rather than going through a
   * recorded child handle. The handle belongs to this process, so it is lost
   * with it, and a handle-based stop would leak the very window it was meant to
   * close. It is also the same rule the escape-hatch script follows, which keeps
   * one behaviour in one place.
   */
  async function stopPanel() {
    const command = `${PWSH} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${psQuote(STOP_SCRIPT)}`
    return await runShell(command, 15000)
  }

  function sleep(ms) {
    return new Promise((resolve) => ctx.timeout(resolve, ms))
  }

  // -- routes ---------------------------------------------------------------- //

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-danmaku/v3/status',
        handler: async (req, res) => {
          sendJson(res, 200, await probe())
        },
      }),
    'danmaku:route:status',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-danmaku/v3/send',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          const body = await readBody(req)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          const text = typeof body?.text === 'string' ? body.text.trim() : ''
          if (sessionId === '') {
            sendJson(res, 400, { ok: false, error: 'no session id' })
            return
          }
          if (text === '') {
            sendJson(res, 400, { ok: false, error: 'nothing to send' })
            return
          }
          const outcome = await sendPrompt(sessionId, text, body?.mode)
          sendJson(res, 200, outcome)
        },
      }),
    'danmaku:route:send',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-danmaku/v3/toggle',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          const body = await readBody(req)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') {
            sendJson(res, 400, { running: false, stopped: false, error: 'no session id' })
            return
          }

          // Ask first. Acting on an assumption is how a second overlay ends up
          // stacked on top of the first one.
          const before = await probe()
          if (before.running === true) {
            const stopped = await stopPanel()
            const after = await probe()
            if (after.running === true) {
              sendJson(res, 200, {
                running: true,
                stopped: false,
                error: `stop did not take effect: ${(stopped.text || stopped.err).slice(0, 120)}`,
              })
              return
            }
            sendJson(res, 200, { running: false, stopped: true, error: '', line: stopped.text })
            return
          }

          const result = startPanel(sessionId)
          if (result.ok !== true) {
            sendJson(res, 200, { running: false, stopped: false, error: result.reason })
            return
          }
          // The launch is detached, so its outcome is only knowable by asking the
          // panel afterwards. Wait long enough for it to have painted once.
          await sleep(STARTUP_SETTLE_MS)
          const after = await probe()
          if (after.running !== true) {
            sendJson(res, 200, {
              running: false,
              stopped: false,
              error: 'launched but no panel reported itself; see .panel-startup.log',
            })
            return
          }
          sendJson(res, 200, { running: true, stopped: false, error: '', line: after.line })
        },
      }),
    'danmaku:route:toggle',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-danmaku/v3/recent',
        handler: (req, res) => {
          sendJson(res, 200, recent)
        },
      }),
    'danmaku:route:recent',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-danmaku/v3/stream',
        handler: (req, res) => {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          // A comment frame makes the browser and urllib both treat the stream as
          // open immediately, instead of waiting for the first event.
          res.write(': connected\n\n')
          listeners.add(res)

          // A keepalive, so a proxy does not close an idle stream and the panel's
          // read loop does not sit in a blocking read forever.
          const beat = ctx.interval(() => {
            try {
              res.write(': ping\n\n')
            } catch {
              /* Removed by the close handler below. */
            }
          }, 20000)

          const close = () => {
            beat()
            listeners.delete(res)
          }
          req.on('close', close)
          res.on('close', close)
          res.on('error', close)
        },
      }),
    'danmaku:route:stream',
  )

  console.log('danmaku overlay plugin ready')
}
