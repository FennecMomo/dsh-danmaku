/*
 * Danmaku overlay: the session-header button.
 *
 * This is a hand-written client bundle, so it uses the format the loader
 * actually consumes rather than anything a bundler would emit:
 *
 *   - `window.__ModuleLoader__.load({ id, factory })`, where the factory returns
 *     `module.exports`;
 *   - the plugin is the module's `apply` export, not a return value - that is the
 *     dynamic-package shape and it does not load here;
 *   - React arrives through `require('react')` and JSX is not compiled, so markup
 *     is written with React.createElement.
 *
 * TWO THINGS HERE ARE LOAD-BEARING, AND BOTH TOOK FAR TOO LONG TO FIND:
 *
 * 1. `exports.inject = ['slots']` is REQUIRED. The client facade guards service
 *    reads: `ctx.get('slots')` returns undefined for a service that is not
 *    declared, and the `ctx.slots` property resolves only for a declared one.
 *    Without the declaration, `apply` saw undefined, returned at its own guard,
 *    and registered nothing - a failure with no host-side symptom at all.
 *
 * 2. The state shown is always the panel process's own answer, fetched over HTTP.
 *    A persistent plugin has no `harness.handle`/`host.call` pair - that RPC
 *    belongs to dynamic packages - so this package's host half registers these
 *    routes with webServer. A button that remembered whether it had opened a
 *    window would be wrong the moment anything else started or stopped one, and it
 *    would outlive the process, having no way to notice an overlay that retired
 *    itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-danmaku',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    var SLOT = 'conversation.session.header.actions'
    var STATUS_URL = '/dsh-danmaku/v3/status'
    var TOGGLE_URL = '/dsh-danmaku/v3/toggle'
    var POLL_MS = 5000

    function DanmakuButton(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : ''
      var stateHook = React.useState('loading')
      var state = stateHook[0]
      var setState = stateHook[1]
      var noteHook = React.useState('')
      var note = noteHook[0]
      var setNote = noteHook[1]
      var pulseHook = React.useState(0)
      var pulse = pulseHook[0]
      var setPulse = pulseHook[1]

      React.useEffect(
        function () {
          if (sessionId === '') return undefined
          var cancelled = false

          function read() {
            fetch(STATUS_URL, { headers: { accept: 'application/json' } })
              .then(function (response) {
                if (!response.ok) throw new Error('status ' + String(response.status))
                return response.json()
              })
              .then(function (result) {
                if (cancelled || !result) return
                setState(result.running === true ? 'open' : 'closed')
                if (result.running === true) {
                  setNote(
                    '运行中 · 气泡 ' +
                      String(
                        result.bubbles === null || result.bubbles === undefined
                          ? '?'
                          : result.bubbles,
                      ) +
                      ' · 已收事件 ' +
                      String(
                        result.ingested === null || result.ingested === undefined
                          ? '?'
                          : result.ingested,
                      ),
                  )
                } else {
                  setNote(typeof result.line === 'string' ? result.line : '')
                }
              })
              .catch(function (error) {
                if (cancelled) return
                setState('error')
                setNote(String(error && error.message ? error.message : error))
              })
          }

          read()
          /*
           * The polling runs on window.setInterval rather than ctx.interval. A
           * static bundle can reach the global: the teaching traps for timer
           * globals are installed only by evaluateClientHalf, which builds a
           * closure with new Function for DYNAMIC halves. Using the global keeps
           * `timer` out of the declaration list, and every declaration is another
           * way for this entry to sit parked.
           *
           * The cleanup is what prevents a leak when the session header unmounts.
           */
          var handle = window.setInterval(read, POLL_MS)
          return function () {
            cancelled = true
            window.clearInterval(handle)
          }
        },
        [sessionId, pulse],
      )

      function onClick() {
        if (sessionId === '' || state === 'busy') return
        setState('busy')
        setNote('')
        fetch(TOGGLE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error('toggle ' + String(response.status))
            return response.json()
          })
          .then(function (result) {
            if (result && typeof result.error === 'string' && result.error !== '') {
              setState('error')
              setNote(result.error)
              return
            }
            setState(result && result.running === true ? 'open' : 'closed')
            // Re-arm the poll so the button catches up now instead of waiting out
            // the current interval.
            setPulse(function (value) {
              return value + 1
            })
          })
          .catch(function (error) {
            setState('error')
            setNote(String(error && error.message ? error.message : error))
          })
      }

      var colour = state === 'error' ? '#E05260' : state === 'open' ? '#2F6FEB' : '#6B7684'
      var text =
        state === 'error'
          ? '弹幕 ⚠ ' + (note ? note.slice(0, 26) : '出错')
          : state === 'busy'
            ? '弹幕 …'
            : state === 'open'
              ? '弹幕 ●'
              : '弹幕'

      return React.createElement(
        'button',
        {
          type: 'button',
          onClick: onClick,
          title: note
            ? note
            : state === 'open'
              ? '关闭这个会话的弹幕窗口（气泡可点击展开）'
              : '为这个会话打开弹幕窗口',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: '26px',
            maxWidth: '290px',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            padding: '0 10px',
            border: '1px solid ' + colour,
            borderRadius: '6px',
            background: state === 'open' ? 'rgba(47,111,235,0.12)' : 'transparent',
            color: colour,
            font: 'inherit',
            fontSize: '12px',
            cursor: state === 'busy' ? 'default' : 'pointer',
          },
        },
        text,
      )
    }

    function apply(ctx) {
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register({ name: SLOT, id: 'danmaku', order: 30, label: '弹幕' }, DanmakuButton)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.DanmakuButton = DanmakuButton
    return module.exports
  },
})
