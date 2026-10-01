#!/usr/bin/env python3
"""Session-bound danmaku overlay for DeepSeek Harness.

One process, one window, one session. The overlay is a pure display region:
no title bar, no frame, no buttons. Everything that controls it lives on the DSH
session page, because a control inside an overlay cannot be reached reliably.

Rendering: per-pixel alpha
--------------------------
The surface is drawn into a 32-bit ARGB bitmap and handed to Windows through
``UpdateLayeredWindow``, so every pixel carries its own alpha. That is what makes
"faint background, solid bubbles" possible; a whole-window alpha value -
``SetLayeredWindowAttributes`` - fades the bubbles along with the background,
which is the defect this replaced.

Bubbles
-------
One bubble per event, right-aligned, each exactly as wide as its text plus
padding. The stack grows upward from the bottom of the region and anything pushed
past the top edge is destroyed rather than kept, so the region never accumulates
history and never scrolls.

Data comes from the ``dsh-danmaku`` host plugin's two endpoints on the harness's
own HTTP server:

    GET /dsh-danmaku/v3/stream   Server-sent events, live
    GET /dsh-danmaku/v3/recent   JSON backfill

Settings live in ``settings.json`` beside this file, which is how the DSH-side
buttons reach this process without an IPC channel.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import queue
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
from ctypes import wintypes


class FILETIME(ctypes.Structure):
    """Win32 ``FILETIME``: two 32-bit halves of a 64-bit 100ns count.

    Declared here because the panel needs this process's own start time, and that
    comes from ``GetProcessTimes``.
    """

    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]
from tkinter import scrolledtext

from layered_window import LayeredCanvas, measure_text_standalone

# --------------------------------------------------------------------------- #
# Appearance
# --------------------------------------------------------------------------- #

#: The panel behind the bubbles: white, and only faintly present. Alpha is
#: per-pixel, so this does NOT affect the bubbles drawn on top of it.
PANEL_BG = "#FFFFFF"
PANEL_ALPHA = 60

#: Bubbles are fully opaque whatever the background does. This is the whole
#: reason the renderer is per-pixel alpha rather than a single window alpha.
BUBBLE_ALPHA = 255

BUBBLE_TEXT = "#FFFFFF"
BUBBLE_TEXT_DIM = "#9AA6B4"

#: Per-kind bubble body colour. The three families - what was done, what was said,
#: and the reply - share one stack, so they need to be told apart by more than the
#: accent border alone.
BUBBLE_FILL = {
    "tool:ok": "#11151B",
    "tool:error": "#1D1114",
    "file": "#0F1A17",
    "turn:end": "#14171B",
    "summary": "#1C1710",
    "assistant:final": "#1C1710",
    "user": "#101C2A",
    "assistant": "#16121F",
    "assistant:reasoning": "#141821",
}

BODY_FONT = ("Microsoft YaHei UI", 14, 400)
META_FONT = ("Microsoft YaHei UI", 12, 400)

PADDING_X = 12
PADDING_Y = 8
#: Gap between bubbles. Wide enough that two adjacent dark bubbles read as two
#: things rather than one tall block - at 6px the seam disappeared once they were
#: stacked, especially with the tails reaching into it.
BUBBLE_GAP = 12
RADIUS = 10
TAIL_HEIGHT = 7
RIGHT_MARGIN = 10
BOTTOM_MARGIN = 10
#: The control row along the bottom: the composer's box, then the hide toggle.
CONTROL_HEIGHT = 34
CONTROL_GAP = 6
EYE_WIDTH = 34
EYE_LABEL = "◐"
#: Shown in the composer's box. It is a description, not a hint to click: the box
#: cannot take focus, for the reason in ``Overlay._draw_controls``.
COMPOSER_PLACEHOLDER = "在会话页输入 · 这里只读"
MAX_BUBBLE_WIDTH_RATIO = 0.94
MAX_DETAIL_WINDOWS = 4
#: Typing windows at once. One is the normal case; the cap is there so a double
#: click cannot leave two identical composers open.
MAX_COMPOSER_WINDOWS = 2
#: A second click within this long is the same click, as far as the 45ms poll is
#: concerned. See Overlay._open_composer.
COMPOSER_DEBOUNCE_SECONDS = 1.5
#: Never shrink below this, so the very first bubble does not produce a
#: two-line-tall window pinned to the bottom of the screen.
MIN_HEIGHT = 120
#: How often the settings file is re-read. It is only ever written by hand, so a
#: second was needless I/O; the redraw that used to follow it unconditionally was
#: far worse (see Overlay.run).
SETTINGS_POLL_SECONDS = 3.0
#: How often a click is looked for when the window is click-through and so cannot
#: be told about one. 45ms is under the threshold where a click feels late.
CLICK_POLL_SECONDS = 0.045

#: Muted on purpose. Every verb is already distinct, and colour is doing the one
#: job it is good at here: separating a failure from a success at a glance.
ACCENT = {
    "tool:ok": "#5B93EE",
    "tool:error": "#E0646F",
    "file": "#4FBF9A",
    "turn:end": "#6B7684",
    "summary": "#E8B45C",
    "user": "#5FB8C9",
    "assistant": "#8E7BE8",
}

# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #

DEFAULT_SETTINGS = {
    "alpha": PANEL_ALPHA,
    # Narrower than the first working version. A 400x640 region parked over the
    # middle of the screen is a large no-go area even when it is click-through,
    # and a smaller column reads better as an ambient side display.
    "width": 360,
    # The height in use. It is recomputed from the content on every change, so the
    # stored value only matters as the size of the first window before anything
    # has arrived.
    "height": 240,
    # Bottom-right by default, computed from the live work area. Out of the way
    # of the editor and the terminal, and a region nobody aims at while working.
    "x": None,
    "y": None,
    # CLICK-THROUGH ON, and this is now a hard requirement rather than a
    # preference.
    #
    # The overlay must never receive mouse input. It has no message pump, and
    # Windows sends a window under the pointer a continuous stream of WM_SETCURSOR,
    # WM_NCHITTEST and WM_MOUSEMOVE. Queueing those against a thread that never
    # drains them shows the busy cursor the moment the pointer crosses the window,
    # and eventually locks the desktop up. Measured in stages: handling WM_SETCURSOR
    # explicitly narrowed the symptom from the whole panel down to just the bubbles,
    # and turning this on removed it completely.
    #
    # Clicks are therefore read from the cursor instead of delivered to the window -
    # see ``Overlay._poll_click``. The window region still clips it to the bubbles,
    # which is what keeps the transparent gaps from swallowing clicks at all.
    "clickThrough": True,
    # Read the cursor and the mouse button from the drawing loop, so a click on a
    # bubble still opens its detail window without the window ever receiving a
    # message. Costs two Win32 calls per loop iteration and nothing else.
    "pollClicks": True,
    # Opacity of a bubble while the hide toggle is on. See Overlay.toggle_dim.
    "dimAlpha": 128,
    # The control row along the bottom of the panel.
    "showControls": True,
    "maxBubbles": 6,
    # Startup backfill, and deliberately tiny. Replaying a session's history
    # produces a wall of stale bubbles that has nothing to do with what is
    # happening now; a couple of lines of context is all that is useful.
    "backfillBubbles": 3,
    # The window shrink-wraps its content and never grows past this. Long
    # summaries belong in the detail window, not in the overlay.
    "maxHeight": 520,
    # Narrow enough that a bubble is usually a single line. Wide bubbles wrap into
    # tall blocks that read as an opaque wall rather than as passing notices.
    "maxBubbleWidth": 300,
    # Stop by itself when nothing has happened for this long, so an overlay left
    # running cannot linger unattended.
    "idleExitSeconds": 900,
}


def settings_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")


def status_path() -> str:
    """Where the live process reports itself, for anything outside it to read."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ".panel-status.json")


def done_path() -> str:
    """Written on a clean exit, so a stopped panel is distinguishable from a crash."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ".panel-done.json")


def stop_path() -> str:
    """The stop request: a file whose existence asks the panel to shut down.

    This exists because the panel cannot be killed from outside. Measured in the
    harness host's execution context, both `Get-Process -Id` against the panel and
    `taskkill /PID` come back "Access denied", so every out-of-band stop failed and
    the overlay could be opened but never closed.

    A cooperative request sidesteps the permission question entirely: the panel is
    asked to quit, and quits. It is also simply better than a kill - the window is
    destroyed, the SSE socket is closed, and a clean exit record is written, so
    `--status` reports "stopped" rather than a crash.
    """
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ".panel-stop")


def command_path() -> str:
    """A one-word command file, consumed on read. See ``Overlay._watch_commands``."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ".panel-command")


#: FILETIME counts 100ns units from 1601; .NET ticks count them from 0001. The
#: difference is a constant, which is all that is needed to make this process's
#: start time comparable with PowerShell's `StartTime` without a date library.
FILETIME_TO_DOTNET_TICKS = 504911232000000000


def process_start_ticks() -> str:
    """This process's start time as a .NET tick count, or an empty string.

    Published in the status file so the stop script can prove that the pid it is
    about to kill is still this process. A pid alone is not proof: Windows recycles
    them, and "kill whatever now owns that number" is how a stop button takes out
    something unrelated.

    Ticks rather than a formatted time, because PowerShell's ``StartTime`` converts
    straight to them - no parsing, no timezone reasoning, no locale.
    """
    kernel32 = ctypes.windll.kernel32
    # Explicit argtypes/restype, for the same reason every other call in this
    # project needs them: without a declared pointer type ctypes assumes a 32-bit
    # int, and a process handle does not fit - the call then fails with
    # "OverflowError: int too long to convert" rather than returning a value.
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.GetProcessTimes.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(FILETIME),
        ctypes.POINTER(FILETIME),
        ctypes.POINTER(FILETIME),
        ctypes.POINTER(FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    created = FILETIME()
    exited = FILETIME()
    kernel = FILETIME()
    user = FILETIME()
    ok = kernel32.GetProcessTimes(
        kernel32.GetCurrentProcess(),
        ctypes.byref(created),
        ctypes.byref(exited),
        ctypes.byref(kernel),
        ctypes.byref(user),
    )
    if not ok:
        return ""
    value = (created.dwHighDateTime << 32) | created.dwLowDateTime
    return str(value + FILETIME_TO_DOTNET_TICKS)


def work_area() -> tuple[int, int, int, int]:
    """The primary monitor's working area as ``(left, top, right, bottom)``.

    The working area, not the screen: the taskbar is excluded, which is what keeps
    the overlay's bottom row out from under it.
    """
    SPI_GETWORKAREA = 0x0030
    rect = wintypes.RECT()
    try:
        if not ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0):
            raise OSError("SystemParametersInfoW failed")
        return rect.left, rect.top, rect.right, rect.bottom
    except Exception:  # noqa: BLE001 - fall back rather than refuse to start
        return 0, 0, 1920, 1080


def default_position(width: int, height: int) -> tuple[int, int]:
    """Bottom-right of the primary work area, inset a little.

    Computed rather than hard-coded: a literal position that lands in the corner
    on one monitor sits off-screen on another, and a window nobody can see is a
    window nobody can move back.
    """
    _, _, right, bottom = work_area()
    return max(0, right - width - 24), max(0, bottom - height - 24)


#: Keys whose value must be a real number, and the type they must be.
#:
#: Everything here is a coordinate, a size or a count, and every one of them ends
#: up inside `int(...)` on the drawing path. A malformed file that yields `None`
#: therefore does not degrade gracefully - it kills the process at the first
#: `int(None)`. That actually happened: a settings file written with a byte-order
#: mark failed to parse, the defaults were returned, the defaults' `x`/`y` are
#: `None` by design ("work it out"), and the panel died on the next layout.
NUMERIC_KEYS = (
    "alpha",
    "width",
    "height",
    "maxBubbles",
    "backfillBubbles",
    "maxHeight",
    "maxBubbleWidth",
    "idleExitSeconds",
)


def read_settings() -> dict:
    """Load the settings file, forgiving anything wrong with it.

    Two failure modes are handled on purpose:

    * **A byte-order mark.** `utf-8-sig` strips one if present and is identical to
      plain UTF-8 otherwise. PowerShell's `Set-Content -Encoding UTF8` writes a BOM
      on 5.1, which is a perfectly ordinary way for this file to get edited by hand.
    * **A value of the wrong type.** Anything that is not a usable number is
      dropped, so the default survives instead of a `None` reaching `int()`.
    """
    merged = dict(DEFAULT_SETTINGS)
    try:
        with open(settings_path(), "r", encoding="utf-8-sig") as handle:
            stored = json.load(handle)
    except (OSError, ValueError):
        return merged
    if not isinstance(stored, dict):
        return merged
    for key, value in stored.items():
        if key not in merged:
            continue
        if key in NUMERIC_KEYS:
            # bool is an int subclass, and `true` here means a typo, not 1.
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
        if key in ("x", "y") and value is not None and not isinstance(value, (int, float)):
            continue
        merged[key] = value
    return merged


def write_settings(settings: dict) -> None:
    """Atomic replace, so a reader never sees a half-written file."""
    target = settings_path()
    temporary = target + ".tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, target)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# The interpreter: raw tool calls into readable sentences
# --------------------------------------------------------------------------- #

TOOL_VERBS = {
    "read": "正在读取",
    "read_image": "正在看图片",
    "write": "正在写入",
    "edit": "正在修改",
    "glob": "正在查找文件",
    "grep": "正在搜索",
    "pwsh": "正在执行命令",
    "bash": "正在执行命令",
    "web_search": "正在搜索网络",
    "web_fetch": "正在抓取网页",
    "todo_write": "正在更新任务清单",
    "ask_user_question": "正在向你提问",
    "skill": "正在加载技能",
    "task": "正在派发子任务",
    "subagent": "正在派发子代理",
    "subagent_fork": "正在派发子代理",
    "send_message": "正在给子代理发消息",
    "workflow": "正在编排工作流",
    "ralph": "正在跑 Ralph 循环",
    "present": "正在交付文件",
    "list_agents": "正在查看子代理",
    "interrupt_agent": "正在中断子代理",
    "cordis_define": "正在定义插件",
    "cordis_run": "正在运行插件",
    "cordis_stop": "正在停止插件",
    "cordis_undefine": "正在删除插件",
    "cordis_inspect_query": "正在查询接口",
    "cordis_inspect_self": "正在查看插件状态",
    "cordis_inspect_list": "正在列出接口",
    "mcp__unity__execute_code": "正在 Unity 里执行代码",
    "mcp__unity__batch_execute": "正在批量操作 Unity",
    "mcp__unity__manage_gameobject": "正在编辑 Unity 物体",
    "mcp__unity__manage_components": "正在编辑 Unity 组件",
    "mcp__unity__manage_scene": "正在操作 Unity 场景",
    "mcp__unity__manage_asset": "正在操作 Unity 资源",
}

#: Which argument becomes the bubble's subject, in preference order.
#:
#: `description` sits ahead of `command` deliberately. A shell call carries both,
#: and they could not be more different to read: the description is one short
#: human sentence ("Verify the event fields"), while the command is the whole
#: script - newlines, variable assignments, quoting. Truncating that at the bubble
#: limit cuts it mid-token and produces a bubble full of noise that says less than
#: the description did. The command is still there for the detail window, which is
#: where something that long belongs.
SUBJECT_KEYS = (
    "description",
    "objective",
    "pattern",
    "query",
    "queries",
    "file_path",
    "path",
    "url",
    "search_term",
    "menu_path",
    "tool_name",
    "command",
    "name",
    "packageId",
    "pluginId",
    "action",
    "mode",
    "reason",
)

#: Arguments that are never the subject and never worth reporting: file bodies and
#: replacement text are large, and rendering one into a bubble would be both
#: unreadable and slow.
NOISE_KEYS = {"content", "new_string", "old_string", "oldText", "newText"}

FILE_KEYS = {"file_path", "path"}


def verb_for(name: str) -> str:
    if name in TOOL_VERBS:
        return TOOL_VERBS[name]
    if name.startswith("mcp__"):
        parts = name.split("__")
        if len(parts) >= 3:
            return f"正在 {parts[1]} · {parts[2]}"
    return f"正在调用 {name}"


def shorten(value: object, limit: int = 90) -> str:
    text = " ".join(str(value).replace("\r", " ").replace("\n", " ").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def tail_path(path: str, keep: int = 2) -> str:
    normalized = path.replace("\\", "/")
    parts = [part for part in normalized.split("/") if part]
    return "/".join(parts[-keep:]) if len(parts) > keep else normalized


def subject_of(args: object) -> tuple[str | None, str | None]:
    if not isinstance(args, dict):
        return None, None
    for key in SUBJECT_KEYS:
        if key in NOISE_KEYS:
            continue
        value = args.get(key)
        if value in (None, "", [], {}):
            continue
        if isinstance(value, (list, tuple)):
            joined = " / ".join(str(item) for item in value if item not in (None, ""))
            if joined == "":
                continue
            return shorten(joined), key
        return shorten(value), key
    return None, None


def interpret(event: dict) -> tuple[str, str]:
    """Turn one raw event into the sentence a bubble shows."""
    kind = str(event.get("kind", ""))

    if kind == "file":
        path = event.get("path") or event.get("text") or ""
        return kind, f"文件已变更 {tail_path(str(path))}"

    if kind == "turn:end":
        reason = str(event.get("reason", ""))
        wording = {
            "completed": "这一轮结束了",
            "aborted": "这一轮被中止",
            "error": "这一轮出错了",
            "interrupted": "这一轮被打断",
            "blocked": "这一轮被阻止",
            "max-tokens": "输出达到上限",
        }.get(reason, f"这一轮结束了（{reason}）")
        return kind, wording

    if kind == "summary":
        return kind, "回复写好了 · 点击展开"

    # -- what was said, not only what was done ------------------------------ #
    #
    # The point of these is to show the conversation, not merely that a message
    # happened: a stack of tool calls says nothing about what was being attempted
    # or what came back. So the text gets real room - 260 characters rather than the
    # 90 a tool subject gets - and wraps onto several lines. Very long replies are
    # still shortened here, but the whole thing is carried in `detail` and the
    # detail window shows it; that is what the detail window is for.
    if kind == "user":
        return kind, f"你说：{shorten(event.get('text') or '', 260)}"

    if kind == "assistant":
        return kind, f"我说：{shorten(event.get('text') or '', 260)}"

    if kind == "assistant:final":
        return kind, f"我说：{shorten(event.get('text') or '', 260)}"

    if kind == "assistant:reasoning":
        return kind, f"思考：{shorten(event.get('text') or '', 200)}"

    if kind in ("tool:ok", "tool:error"):
        name = str(event.get("tool") or event.get("text") or "tool")
        verb = verb_for(name)
        subject, key = subject_of(event.get("args"))
        shown = tail_path(subject) if subject and key in FILE_KEYS else subject

        if kind == "tool:error":
            return kind, f"{verb.replace('正在', '')}失败" + (f" · {shown}" if shown else "")

        return kind, verb if shown is None else f"{verb} {shown}"

    return "", ""


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #


def discover_base_url(explicit: str | None) -> str | None:
    if explicit:
        return explicit.rstrip("/")
    from_env = os.environ.get("DSH_WEB_URL")
    if from_env:
        return from_env.rstrip("/")
    log_path = os.path.join(os.environ.get("APPDATA", ""), "dsh-desktop-shell", "desktop-shell.log")
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
            for line in reversed(handle.readlines()):
                index = line.find("GUI ready at ")
                if index != -1:
                    return line[index + 13 :].strip().split()[0].rstrip("/")
    except OSError:
        return None
    return None


class EventStream(threading.Thread):
    """Reads SSE and pushes events onto a queue for the render loop to drain."""

    def __init__(self, base_url: str, session_id: str | None, out: queue.Queue):
        super().__init__(daemon=True)
        self.base_url = base_url
        self.session_id = session_id
        self.out = out
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                self._read()
                backoff = 1.0
            except Exception:  # noqa: BLE001 - every failure means retry
                pass
            if self._stop.wait(backoff):
                return
            backoff = min(backoff * 2, 15.0)

    def _read(self) -> None:
        url = f"{self.base_url}/dsh-danmaku/v3/stream"
        request = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
        with urllib.request.urlopen(request, timeout=35) as response:
            payload = ""
            while not self._stop.is_set():
                raw = response.readline()
                if not raw:
                    return
                line = raw.decode("utf-8", errors="replace")
                if line.startswith(":"):
                    continue
                if line.strip() == "":
                    if payload:
                        self._dispatch(payload)
                        payload = ""
                    continue
                if line.startswith("data: "):
                    payload = line[6:].strip()

    def _dispatch(self, payload: str) -> None:
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            return
        if not isinstance(event, dict):
            return
        session = event.get("session")
        if self.session_id and session and session != self.session_id:
            return
        self.out.put(event)


def fetch_recent(base_url: str, session_id: str | None, limit: int) -> list[dict]:
    try:
        with urllib.request.urlopen(f"{base_url}/dsh-danmaku/v3/recent", timeout=8) as response:
            events = json.loads(response.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return []
    if not isinstance(events, list):
        return []
    if session_id:
        events = [e for e in events if not e.get("session") or e.get("session") == session_id]
    return events[-limit:]


# --------------------------------------------------------------------------- #
# The overlay
# --------------------------------------------------------------------------- #


class PlacedBubble:
    """One bubble's geometry, kept so the stack can be laid out again."""

    def __init__(self, width: int, height: int, kind: str, text: str, payload: str):
        self.width = width
        self.height = height
        self.kind = kind
        self.text = text
        self.payload = payload
        self.x = 0
        self.y = 0
        #: The control row, if this bubble is one. Such a row is drawn but never
        #: hit-tested as a message, because its parts have their own hit areas.
        self.control: str = ""


class Overlay:
    """A fixed-size, right-aligned stack of opaque bubbles on a faint panel."""

    def __init__(self, base_url: str, session_id: str | None, settings: dict):
        self.base_url = base_url
        self.session_id = session_id
        self.settings = settings
        self.events: queue.Queue = queue.Queue()
        self.bubbles: list[PlacedBubble] = []
        self.ingested = 0
        self._settings_stamp = 0.0
        self._running = True
        self._detail_windows = 0
        self._composer_windows = 0
        #: When the composer was last opened, for the double-click guard.
        self._composer_opened_at = 0.0
        #: This process's start time, published so the stop script can prove the pid
        #: it is killing is still this panel rather than a recycled number.
        self._started_at = process_start_ticks()
        #: Set when a stop was requested through the request file, so the exit can
        #: be recorded as a clean stop rather than an idle timeout.
        self._stop_requested = False
        #: The hide toggle. Dimmed bubbles are also not clickable, which is the
        #: point: the state is "get out of my way", and a shape that swallows clicks
        #: while looking faint would be a trap.
        self._hidden = False
        self.bubble_alpha = BUBBLE_ALPHA
        #: Where a left-press started, when clicks are polled rather than received.
        self._press_origin: tuple[int, int] | None = None
        self.canvas = None

        # Backfill first, into plain measurements, so the window can be created at
        # its final size. The alternative - open large, then shrink once the data
        # lands - shows a flash of empty overlay on every start.
        for event in fetch_recent(base_url, session_id, int(settings["backfillBubbles"])):
            self._ingest(event)
        self.settings["height"] = self._fitted_height()

        # The click hook is what makes a bubble expandable. It only works because
        # the window is also clipped to the bubbles: with a full-size rectangle
        # and no region, "clickable" would mean "blocks the desktop".
        self.canvas = LayeredCanvas(
            int(settings["x"]),
            int(settings["y"]),
            int(settings["width"]),
            int(self.settings["height"]),
            on_click=self._on_click,
        )
        self.canvas.set_click_through(bool(settings["clickThrough"]))

        self.stream = EventStream(base_url, session_id, self.events)
        self.stream.start()

        for bubble in self.bubbles:
            self._layout()
            self._draw()
        self._apply_region()

    # -- content ------------------------------------------------------------ #

    def _ingest(self, event: dict) -> None:
        """Add one event to the stack. Painting is the caller's job.

        This used to resize, lay out, re-region and repaint per event, which meant a
        burst of ten events did ten full paints of a layered window. The drain loop
        now stages the whole batch and paints once.
        """
        self._stage(event)

    def _stage(self, event: dict) -> bool:
        """Turn an event into a measured bubble. Returns whether one was added.

        Measured instead of drawn so the same path can run during startup, before
        the window exists, which is what lets the window open at its final size.
        """
        kind = str(event.get("kind", ""))
        if kind not in ACCENT:
            return False
        interpreted_kind, sentence = interpret(event)
        if not sentence:
            return False
        self.ingested += 1
        limit = self._bubble_width_limit()
        text_width, text_height = measure_text_standalone(sentence, BODY_FONT, limit)
        width = min(limit, text_width) + PADDING_X * 2
        height = text_height + PADDING_Y * 2
        self.bubbles.append(
            PlacedBubble(width, height, interpreted_kind, sentence, str(event.get("detail") or ""))
        )
        self._prune()
        return True

    def _bubble_width_limit(self) -> int:
        return min(
            int(self.settings["maxBubbleWidth"]),
            int(int(self.settings["width"]) * MAX_BUBBLE_WIDTH_RATIO) - RIGHT_MARGIN,
        )

    def _fit_height(self) -> None:
        """Shrink the window to its content, up to ``maxHeight``.

        A fixed-height window padded with empty space is the wrong shape for this:
        the surplus area is a faint white rectangle over whatever is behind it, and
        the overlay should occupy only what it has to say. Growing and shrinking
        with the stack costs a resize per bubble and removes that dead space
        entirely.

        THE BOTTOM EDGE IS WHAT STAYS PUT.

        Sizing a window with ``SetWindowPos(SWP_NOMOVE)`` pins its TOP-LEFT corner,
        so changing the height moves the BOTTOM edge. That is the opposite of what a
        bottom-anchored stack needs, and leaving it that way was a real defect: the
        window crept downward as bubbles accumulated until its bottom sat 84px below
        the screen edge and the newest bubbles were cut in half. The earlier comment
        here claimed the bottom-right corner stayed pinned; now the code does it, by
        recomputing y from the desired height before every resize.
        """
        wanted = self._fitted_height()
        current = int(self.settings["height"])
        if wanted == current:
            return

        # The bottom edge to keep: where it is now, or - on the first sizing, before
        # the window has settled - where the working area says it should be.
        left, top, width, height = self.canvas.geometry()
        if height <= 0:
            return
        bottom = top + height
        area_left, area_top, area_right, area_bottom = work_area()
        margin_y = max(0, area_bottom - bottom)
        if bottom > area_bottom or top < area_top:
            # Off the working area already: fall back to the intended position rather
            # than preserving a bad edge.
            _, bottom = default_position(int(self.settings["width"]), wanted)
            bottom += wanted
            margin_y = 24

        # Never taller than the room above that edge, so a tall stack cannot push
        # the top of the window off the screen either.
        room = bottom - area_top
        wanted = max(MIN_HEIGHT, min(wanted, room))
        new_top = bottom - wanted

        self.settings["height"] = wanted
        self.settings["x"] = left
        self.settings["y"] = new_top
        self.canvas.resize(int(self.settings["width"]), wanted)
        self.canvas.move(left, new_top)

    def _fitted_height(self) -> int:
        content = sum(bubble.height for bubble in self.bubbles)
        if self.bubbles:
            content += BUBBLE_GAP * (len(self.bubbles) - 1)
        return min(
            max(MIN_HEIGHT, content + BOTTOM_MARGIN * 2 + CONTROL_HEIGHT),
            int(self.settings.get("maxHeight", MIN_HEIGHT)),
        )

    def _layout(self) -> None:
        """Right-align every bubble and stack them upward from the bottom.

        Anything that does not fit above the bottom margin is dropped from the
        front of the list, which is what keeps the stack inside the region
        without scrolling: an older bubble above the top edge would be invisible
        anyway, so keeping it would only make the geometry dishonest.
        """
        right_edge = int(self.settings["width"]) - RIGHT_MARGIN
        # The stack's space stops above the control row, so a bubble can never be
        # drawn underneath it.
        available = int(self.settings["height"]) - BOTTOM_MARGIN * 2 - CONTROL_HEIGHT

        # Walk newest to oldest, accumulating height until the region runs out.
        kept: list[PlacedBubble] = []
        used = 0
        for bubble in reversed(self.bubbles):
            needed = bubble.height + (BUBBLE_GAP if kept else 0)
            if used + needed > available:
                break
            kept.append(bubble)
            used += needed
        kept.reverse()
        self.bubbles = kept

        # The bottom edge is what is fixed, not the top.
        #
        # Placing each bubble by its top edge made the stack's bottom wander: a
        # bubble is as tall as its text, so a one-line notice and a three-line one
        # put the lower edge in different places, and the bottom-most bubble
        # floated up and down as the mix changed. Anchoring the BOTTOM edge of the
        # newest bubble to the window's bottom margin makes the stack sit still and
        # grow upward, which is what a stream of notices should do.
        cursor = int(self.settings["height"]) - BOTTOM_MARGIN
        for bubble in reversed(self.bubbles):
            bubble.y = cursor - bubble.height
            bubble.x = right_edge - bubble.width
            cursor = bubble.y - BUBBLE_GAP

        self._layout_controls()

        self._apply_region()

    def _layout_controls(self) -> None:
        """Place the control row at the very bottom of the window.

        It sits BELOW the bubble stack's reserved space rather than inside it, so
        the stack never has to make room for it and adding a control cannot push a
        bubble out.

        The rectangles are recorded here because the hit test, the window region and
        the painter all need the same numbers; a second copy of the arithmetic would
        drift from the first and the button would stop matching its picture.
        """
        width = int(self.settings["width"])
        height = int(self.settings["height"])
        top = height - CONTROL_HEIGHT + 2
        box_height = CONTROL_HEIGHT - 6

        self._eye_rect = (width - RIGHT_MARGIN - EYE_WIDTH, top, EYE_WIDTH, box_height)
        self._composer_rect = (
            RIGHT_MARGIN,
            top,
            max(40, width - RIGHT_MARGIN * 2 - EYE_WIDTH - CONTROL_GAP),
            box_height,
        )

    def _control_at(self, x: int, y: int) -> str:
        """Which control, if any, a point lands on. Empty when it lands on none."""
        if not self.settings.get("showControls", True):
            return ""
        for name, rect in (("eye", self._eye_rect), ("composer", self._composer_rect)):
            left, top, width, height = rect
            if left <= x <= left + width and top <= y <= top + height:
                return name
        return ""

    def _draw(self) -> None:
        """Repaint the whole surface, then hand it to Windows.

        Order matters. The panel is painted at a faint alpha and the bubbles are
        drawn on top of it, but GDI never writes the alpha channel - see
        ``LayeredCanvas.force_opaque`` - so each bubble is made opaque *after* its
        shape and text are drawn. Doing it first would let the background fill
        paint the alpha straight back down to its own value.
        """
        self.canvas.fill(PANEL_BG, int(self.settings["alpha"]))
        for bubble in self.bubbles:
            accent = ACCENT.get(bubble.kind, "#4C86E8")
            # The fill separates the three families at a glance: what was done, what
            # was said, and the reply. They sit in one stack, so without this a
            # message and a tool call read as the same kind of thing.
            fill = BUBBLE_FILL.get(bubble.kind, BUBBLE_FILL["tool:ok"])
            tail = [
                (bubble.x + bubble.width - 14, bubble.y + bubble.height - 2),
                (bubble.x + bubble.width - 4, bubble.y + bubble.height - 2),
                (bubble.x + bubble.width - 4, bubble.y + bubble.height + TAIL_HEIGHT - 2),
            ]

            self.canvas.rounded_rect(
                bubble.x,
                bubble.y,
                bubble.width,
                bubble.height,
                RADIUS,
                fill,
                self.bubble_alpha,
                accent,
                self.bubble_alpha,
            )
            # A small tail on the right edge, since every bubble is right-aligned.
            self.canvas.triangle(tail, fill)
            self.canvas.draw_text(
                bubble.text,
                bubble.x + PADDING_X,
                bubble.y + PADDING_Y,
                bubble.width - PADDING_X * 2,
                bubble.height - PADDING_Y * 2,
                BODY_FONT,
                BUBBLE_TEXT,
                align="left",
            )
            # GDI left the alpha at the panel's value for all of the above. The dim
            # state is applied here rather than by the shapes, because the shapes
            # cannot set alpha at all and the text has to match them.
            self.canvas.force_opaque(
                bubble.x,
                bubble.y,
                bubble.width,
                bubble.height + TAIL_HEIGHT,
                self.bubble_alpha,
            )
        self._draw_controls()
        # Re-take the topmost seat before showing the new content. Being created
        # topmost is not a standing guarantee: another application raising itself,
        # or a full-screen window coming and going, takes the seat away and the
        # overlay ends up behind ordinary windows. Cheap, and it is exactly the
        # moment where being hidden matters.
        self.canvas.assert_topmost()
        self.canvas.present()

    def _draw_controls(self) -> None:
        """Paint the bottom row: the composer's box, then the hide toggle.

        The composer is currently a display-only box. Text entry needs keyboard
        focus, and this window deliberately has none: it is click-through at the OS
        level and refuses activation, which is what removed the busy cursor and the
        freezes. A field that could take a keystroke would have to be focusable, and
        that would bring both back. So the box shows where typing will go, and the
        actual typing happens wherever the session is already open.
        """
        if not self.settings.get("showControls", True):
            return
        left, top, width, height = self._composer_rect
        self.canvas.rounded_rect(left, top, width, height, 6, "#141A22", BUBBLE_ALPHA, "#3A4552", 200)
        self.canvas.draw_text(
            COMPOSER_PLACEHOLDER,
            left + 10,
            top + 5,
            width - 20,
            height - 10,
            META_FONT,
            "#6B7684",
            align="left",
        )
        self.canvas.force_opaque(left, top, width, height, BUBBLE_ALPHA)

        left, top, width, height = self._eye_rect
        # Filled while dimmed, outlined while normal, so the button shows the state
        # it is in rather than only what it does.
        if self._hidden:
            self.canvas.rounded_rect(left, top, width, height, 6, "#2F6FEB", BUBBLE_ALPHA, "#2F6FEB", 255)
        else:
            self.canvas.rounded_rect(left, top, width, height, 6, "#141A22", BUBBLE_ALPHA, "#3A4552", 200)
        self.canvas.draw_text(
            EYE_LABEL,
            left,
            top + 5,
            width,
            height - 10,
            META_FONT,
            "#FFFFFF" if self._hidden else "#9AA6B4",
            align="center",
        )
        self.canvas.force_opaque(left, top, width, height, BUBBLE_ALPHA)

    def _prune(self) -> None:
        """Keep only the newest few bubbles.

        Two limits, because they catch different things: the count keeps the stack
        short, and the height keeps a single tall bubble from pushing everything
        else out of the region.
        """
        while len(self.bubbles) > int(self.settings["maxBubbles"]):
            self.bubbles.pop(0)

    def _apply_region(self) -> None:
        """Clip the window down to exactly the bubbles.

        This is the difference between a transparent overlay and a usable one. A
        layered window with per-pixel alpha *looks* see-through but still owns its
        whole rectangle, so every transparent gap silently eats a click. Handing
        Windows a region made of the bubbles means the gaps are not part of the
        window in the first place: they belong to whatever is behind them.

        The control row is part of the region too. It is a real control the pointer
        has to be able to reach, and leaving it out would make it a picture of a
        button - the window would not be there for the cursor to press.
        """
        rectangles = [(bubble.x, bubble.y, bubble.width, bubble.height + TAIL_HEIGHT) for bubble in self.bubbles]
        if self.settings.get("showControls", True):
            # BOTH controls, not just the toggle.
            #
            # Missing the composer here is what made it dead to the pointer: the
            # window is click-through and its region is the bubbles plus whatever is
            # listed here, so a rectangle that is drawn but not listed does not exist
            # as far as the cursor is concerned. The click went to whatever was
            # behind the overlay, and the box looked like a button that did nothing.
            rectangles.append(self._eye_rect)
            rectangles.append(self._composer_rect)
        self.canvas.set_region(rectangles, RADIUS)

    def _hit_test(self, x: int, y: int) -> PlacedBubble | None:
        for bubble in reversed(self.bubbles):
            if (
                bubble.x <= x <= bubble.x + bubble.width
                and bubble.y <= y <= bubble.y + bubble.height + TAIL_HEIGHT
            ):
                return bubble
        return None

    def _poll_click(self) -> None:
        """Notice a click on a bubble WITHOUT receiving mouse messages.

        This exists because of a hard constraint discovered the expensive way: the
        overlay must never receive mouse input. It has no message pump, and Windows
        sends a window under the pointer a steady stream of WM_SETCURSOR /
        WM_NCHITTEST / WM_MOUSEMOVE; queueing those against a thread that never
        drains them shows the busy cursor on hover and eventually locks the desktop
        up. Handling WM_SETCURSOR explicitly reduced the damage from the whole panel
        to just the bubbles and did not remove it. Making the window fully
        click-through removed it completely, and that is the state this lives in.

        So the click is read from the cursor instead of delivered to the window.
        The cheap test comes first: with the pointer off the window, or the button
        up, this costs two Win32 calls. Only a press that is inside the window gets
        translated and hit-tested.

        Edge-triggered on purpose. The button being held is not a click, so a press
        is remembered and the action fires on release - the same shape a real
        button has, and it also means dragging across a bubble does not open
        anything.
        """
        if not self.settings.get("pollClicks", True):
            return
        # Dimmed means out of the way, which includes not reacting to a click that
        # lands on a faint bubble.
        if self._hidden:
            self._press_origin = None
            return
        position = self.canvas.cursor_client_position()
        if position is None:
            self._press_origin = None
            return

        held = self.canvas.left_button_down()
        if held:
            if self._press_origin is None:
                self._press_origin = position
            return

        origin = self._press_origin
        self._press_origin = None
        if origin is None:
            return
        # Only a press-and-release that stayed on the same bubble counts, so a drag
        # that happens to end over the overlay opens nothing.
        if self._hit_test(*origin) is None:
            return
        if self._hit_test(*position) is None:
            return
        self._on_click(*position)

    def toggle_hidden(self) -> None:
        """Flip between normal and "get out of my way".

        Dimmed to half opacity AND no longer clickable. Both halves are deliberate:
        the point of the state is to stop the overlay competing for attention, and a
        faint shape that still swallowed a click would be a trap rather than a
        convenience. The window is already click-through at the OS level, so all
        that is needed is to stop looking for clicks.

        The alpha is applied by ``force_opaque`` on the whole bubble rather than by
        the drawing calls, because GDI writes no alpha at all - see that method for
        why fading anything here is more involved than setting one number.
        """
        self._hidden = not self._hidden
        self.bubble_alpha = int(self.settings.get("dimAlpha", 128)) if self._hidden else BUBBLE_ALPHA
        if self._hidden:
            self._press_origin = None
        self._draw()
        self._write_status("hidden" if self._hidden else "shown")

    def _on_click(self, x: int, y: int) -> None:
        """A click landed on a bubble or a control: act on it.

        The body shown is the bubble's `detail`, which is the full text the event
        carried. When there is no detail there is nothing to read, and opening a
        window whose entire content is the sentence that was already on the bubble
        is worse than not opening one - that is exactly the "这一轮结束了" window
        this used to produce. So an empty detail is refused instead.
        """
        # Controls first: the eye button sits above the bubbles in the control row,
        # and a click there must not fall through to a bubble underneath it.
        control = self._control_at(x, y)
        if control == "eye":
            self.toggle_hidden()
            return
        if control == "composer":
            self._open_composer()
            return

        bubble = self._hit_test(x, y)
        if bubble is None:
            return
        body = (bubble.payload or "").strip()
        if body == "":
            return
        # A window cannot be opened on this thread: the detail view runs its own
        # event loop, which would stop every later bubble from being read.
        if self._detail_windows >= MAX_DETAIL_WINDOWS:
            return
        self._detail_windows += 1

        def show() -> None:
            try:
                open_summary(bubble.text, body)
            finally:
                self._detail_windows -= 1

        threading.Thread(target=show, daemon=True, name="danmaku-detail").start()

    def _open_composer(self) -> None:
        """Open the typing window.

        On its own thread, like the detail window: Tk runs its own event loop, and
        starting one on the drawing thread would stop every later bubble from being
        read.

        A click that arrives twice in quick succession opens one window, not two.
        The click is polled at 45ms, so a slow double click is two presses as far as
        this loop is concerned, and two identical composers stacked on each other is
        a confusing thing to hand someone. Re-focusing an existing window would need
        Tk calls from a thread that does not own it, which is not safe; refusing the
        second one is.
        """
        if self.session_id is None:
            return
        now = time.monotonic()
        if now - self._composer_opened_at < COMPOSER_DEBOUNCE_SECONDS:
            return
        if self._composer_windows >= MAX_COMPOSER_WINDOWS:
            return
        self._composer_opened_at = now
        self._composer_windows += 1
        session_id = self.session_id
        base_url = self.base_url

        def show() -> None:
            try:
                open_composer(base_url, session_id)
            finally:
                self._composer_windows -= 1

        threading.Thread(target=show, daemon=True, name="danmaku-composer").start()

    def _write_status(self, note: str = "") -> None:
        """Record that this process is alive and what it is showing.

        Written on a timer because the window itself cannot be inspected from
        outside: a layered, click-through, topmost window is invisible to every
        enumeration trick that does not hang, so "is it running, and is it still
        receiving events" has to be answered by the process itself.

        ``ingested`` is the important number. It counts events that actually
        arrived over SSE, so a rising value proves the stream is live, while a
        frozen value next to a running process means the transport died and the
        bubbles on screen are the last ones that ever will be.
        """
        try:
            with open(status_path(), "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "pid": os.getpid(),
                        # The stop script compares this against the live process's
                        # start time, so a recycled pid cannot be mistaken for this
                        # panel. See stop-panel.ps1.
                        "startedAt": self._started_at,
                        "hwnd": self.canvas.hwnd,
                        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "session": self.session_id,
                        "baseUrl": self.base_url,
                        "ingested": self.ingested,
                        "bubbles": len(self.bubbles),
                        # The dim state is part of the observable state: a caller
                        # asking `--status` wants to know what the overlay is doing,
                        # and `note` cannot carry it because the heartbeat rewrites
                        # that every few seconds.
                        "hidden": self._hidden,
                        "bubbleAlpha": self.bubble_alpha,
                        "region": self.canvas.region,
                        "settings": {k: self.settings[k] for k in sorted(self.settings)},
                        "note": note,
                    },
                    handle,
                    ensure_ascii=False,
                    indent=2,
                )
        except OSError:
            pass

    def _mark_done(self, reason: str, note: str = "") -> None:
        """Leave a record of a clean exit.

        Without this, a panel that stopped and a panel that crashed look
        identical from the outside: no process either way. The ``--status`` reader
        can then say which one happened instead of guessing.
        """
        try:
            with open(done_path(), "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "reason": reason,
                        "note": note,
                        "ingested": self.ingested,
                    },
                    handle,
                    ensure_ascii=False,
                    indent=2,
                )
        except OSError:
            pass
        try:
            os.remove(status_path())
        except OSError:
            pass

    # -- loop --------------------------------------------------------------- #

    def run(self) -> None:
        """Drain events and settings on a timer until asked to stop.

        A plain loop rather than a Win32 message pump: bubbles that only need
        clicks do not justify the complexity of a pump, and the window procedure
        already handles the one message that matters.

        WHAT THIS LOOP MUST NOT DO IS REPAINT ON A TIMER.

        An earlier version called `_watch_settings()` every second, and that method
        ended with an unconditional `_draw()` - a full surface fill, a GDI pass and
        an `UpdateLayeredWindow` - so the overlay repainted once a second forever,
        with no input and nothing on screen changing. On top of that the poll ran
        at 8Hz while idle and 50Hz while draining. The result was a process burning
        CPU continuously, a busy cursor whenever the pointer crossed the window,
        and a machine that locked up if the overlay was left alone or clicked.

        The whole cost was unnecessary: nothing here animates. A repaint is only
        ever needed when the bubble stack actually changes, so `_draw` now runs
        exactly then and the loop is otherwise a `stat` and a sleep.
        """
        last_settings = 0.0
        last_event = time.monotonic()
        last_status = 0.0
        last_poll = 0.0
        last_stop_check = 0.0
        idle_limit = int(self.settings.get("idleExitSeconds", 0))
        dirty = False
        self._write_status("started")

        while self._running:
            now = time.monotonic()
            changed = False
            try:
                while True:
                    self._ingest(self.events.get_nowait())
                    changed = True
                    last_event = now
            except queue.Empty:
                pass

            if changed:
                # A new bubble means new geometry and a new region, then one paint.
                self._fit_height()
                self._layout()
                self._apply_region()
                dirty = True

            # Click observation, when the window is click-through and therefore
            # cannot be told about clicks. Two Win32 calls while the pointer is
            # elsewhere, which is the common case.
            if now - last_poll > CLICK_POLL_SECONDS:
                last_poll = now
                try:
                    self._poll_click()
                except Exception:  # noqa: BLE001 - a missed click, not a dead overlay
                    pass

            if now - last_settings > SETTINGS_POLL_SECONDS:
                last_settings = now
                # A malformed settings file must never be able to kill the overlay.
                # It is a hand-edited file, and the previous version died on
                # `int(None)` because a bad one silently produced defaults whose
                # `x`/`y` mean "work it out". Anything that goes wrong here is a
                # skipped reload, not a dead process.
                try:
                    dirty = self._watch_settings() or dirty
                except Exception:  # noqa: BLE001
                    pass
                try:
                    dirty = self._watch_commands() or dirty
                except Exception:  # noqa: BLE001
                    pass

            if dirty:
                self._draw()
                dirty = False

            # The heartbeat doubles as the only external proof of liveness.
            if now - last_status > 5.0:
                last_status = now
                self._write_status("running")

            # Self-retirement: an overlay that nobody is feeding is an overlay
            # nobody wants, and leaving one running is how a stray window ends up
            # parked over the desktop.
            if idle_limit > 0 and now - last_event > idle_limit:
                self._write_status("idle-exit")
                break

            # A stop request is a file rather than a signal, because the process
            # cannot be signalled from the harness host: both Get-Process -Id and
            # taskkill return "Access denied" there. Checking is one stat, and the
            # same interval as the settings poll is plenty for a button press.
            if now - last_stop_check > SETTINGS_POLL_SECONDS:
                last_stop_check = now
                if os.path.exists(stop_path()):
                    self._stop_requested = True
                    self._write_status("stop-requested")
                    break

            # The wait is short only while there is something to click. With bubbles
            # on screen the loop has to wake often enough for a click to feel
            # instant; with none, 120ms is imperceptible for a notice that arrives a
            # few times a minute and is the difference between an idle process and a
            # busy one. A drained batch skips the wait so a burst does not lag.
            if not changed:
                time.sleep(CLICK_POLL_SECONDS if self.bubbles else 0.12)

    def _watch_settings(self) -> bool:
        """Apply the settings file if it changed. Returns whether a repaint is due.

        Deliberately returns a flag instead of painting. The previous version drew
        on every call, which turned a 1Hz poll into a 1Hz full repaint of a layered
        window - see the note in ``run``.
        """
        try:
            stamp = os.path.getmtime(settings_path())
        except OSError:
            stamp = 0.0
        if stamp == self._settings_stamp:
            return False
        self._settings_stamp = stamp
        fresh = read_settings()
        # `x`/`y` mean "work it out" when they are null, which is correct in the
        # file and wrong at the point of use. Startup resolves them once; a reload
        # has to do the same or the next `int(None)` kills the process.
        if fresh.get("x") is None or fresh.get("y") is None:
            fresh["x"], fresh["y"] = default_position(int(fresh["width"]), int(fresh["height"]))
        geometry_changed = any(fresh[k] != self.settings[k] for k in ("width", "height", "x", "y"))
        self.settings.update(fresh)
        if geometry_changed:
            self.canvas.move(int(self.settings["x"]), int(self.settings["y"]))
            self.canvas.resize(int(self.settings["width"]), int(self.settings["height"]))
            self._prune()
            self._layout()
        self.canvas.set_click_through(bool(self.settings["clickThrough"]))
        self._apply_region()
        return True

    def _watch_commands(self) -> bool:
        """Run a command dropped into `.panel-command`, if any. Returns painted?

        The overlay cannot be clicked from a script - its whole input model is a
        polled cursor - and its window cannot be inspected or driven from outside at
        all. Without a way in, verifying a control means asking a person to press it
        and report what happened, which is exactly the loop this project spent the
        longest time stuck in.

        So one file is watched for a command word, and it is consumed on read. This
        is a test hook, and a small one: two commands, one stat, and no state kept
        between calls.
        """
        path = command_path()
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                command = handle.read().strip().lower()
        except OSError:
            return False
        try:
            os.remove(path)
        except OSError:
            pass
        if command == "toggle-hidden":
            self.toggle_hidden()
            return False
        if command == "open-composer":
            self._open_composer()
            return False
        if command == "redraw":
            self._draw()
            return False
        return False

    def stop(self) -> None:
        self._running = False
        self.stream.stop()
        self.canvas.close()


# --------------------------------------------------------------------------- #
# Summary window: a real window, because it is for reading
# --------------------------------------------------------------------------- #


def open_composer(base_url: str, session_id: str) -> None:
    """A real window for typing in, because typing needs keyboard focus.

    This cannot live in the overlay. The overlay is click-through and refuses
    activation at the OS level, and that is not a preference: it is what removed the
    busy cursor and the freezes. A field that could take a keystroke would have to be
    focusable, which would bring both back. So the composer is an ordinary window,
    with the ordinary consequences - it appears in the taskbar and it takes focus
    when clicked.

    It is deliberately NOT modal and does not block the overlay: sending is
    fire-and-forget against the host's `/send` route, and the answer arrives as a
    bubble like everything else, so there is nothing to wait for here.
    """
    root = tk.Tk()
    root.title("弹幕 · 发言")
    root.configure(bg="#14181F")
    root.geometry("620x190+%d+%d" % (max(0, (root.winfo_screenwidth() - 620) // 2), 120))
    root.minsize(420, 160)

    header = tk.Frame(root, bg="#14181F")
    header.pack(fill="x", padx=12, pady=(10, 4))
    tk.Label(
        header,
        text=f"发往 {session_id[:8]}…",
        bg="#14181F",
        fg="#8B98A5",
        font=("Microsoft YaHei UI", 9),
        anchor="w",
    ).pack(side="left")
    status = tk.Label(header, text="Ctrl+Enter 发送", bg="#14181F", fg="#5C6672", font=("Microsoft YaHei UI", 9))
    status.pack(side="right")

    box = tk.Text(
        root,
        height=4,
        wrap="word",
        bg="#0E1218",
        fg="#DCE3EA",
        insertbackground="#DCE3EA",
        relief="flat",
        padx=10,
        pady=8,
        font=("Microsoft YaHei UI", 11),
    )
    box.pack(fill="both", expand=True, padx=12)

    row = tk.Frame(root, bg="#14181F")
    row.pack(fill="x", padx=12, pady=(8, 12))
    send = tk.Button(
        row,
        text="发送",
        width=10,
        bg="#2F6FEB",
        fg="#FFFFFF",
        activebackground="#2A62D0",
        activeforeground="#FFFFFF",
        relief="flat",
        font=("Microsoft YaHei UI", 10),
    )
    send.pack(side="right")
    tk.Button(
        row,
        text="关闭",
        width=8,
        bg="#232A33",
        fg="#9AA6B4",
        activebackground="#2C343E",
        activeforeground="#DCE3EA",
        relief="flat",
        font=("Microsoft YaHei UI", 10),
        command=root.destroy,
    ).pack(side="right", padx=(0, 8))

    def submit(_event=None) -> str:
        text = box.get("1.0", "end").strip()
        if text == "":
            return "break"
        send.config(state="disabled", text="…")
        status.config(text="正在发送", fg="#8B98A5")

        def work() -> None:
            payload = json.dumps({"sessionId": session_id, "text": text}).encode("utf-8")
            request = urllib.request.Request(
                f"{base_url}/dsh-danmaku/v3/send",
                data=payload,
                headers={"content-type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    result = json.loads(response.read().decode("utf-8", errors="replace"))
                ok = isinstance(result, dict) and result.get("ok") is True
                message = "" if ok else str(result.get("error") or "发送失败")
            except Exception as error:  # noqa: BLE001 - reported to the user, not raised
                ok = False
                message = str(error)

            def finish() -> None:
                if ok:
                    # Cleared on success only, so a failed send keeps the text for
                    # a retry instead of losing it.
                    box.delete("1.0", "end")
                    status.config(text="已发送", fg="#4FBF9A")
                else:
                    status.config(text=message[:70], fg="#E05260")
                send.config(state="normal", text="发送")
                box.focus_set()

            try:
                root.after(0, finish)
            except tk.TclError:
                pass  # the window was closed while the request was in flight

        threading.Thread(target=work, daemon=True, name="danmaku-send").start()
        return "break"

    send.config(command=submit)
    # Ctrl+Enter sends; plain Enter inserts a newline, because a prompt is often
    # more than one line and losing that to a stray Enter is worse than a chord.
    root.bind("<Control-Return>", submit)
    root.bind("<Escape>", lambda _event: root.destroy())
    box.focus_set()
    root.mainloop()


def open_summary(title: str, body_text: str) -> None:
    """A real window for reading, because a bubble cannot hold a long reply.

    Deliberately plain Tk: this window exists to be readable and dismissable, and
    it is the one surface in the panel that is a normal, focusable window rather
    than a layered overlay.
    """
    root = tk.Tk()
    root.title(title)
    root.configure(bg="#14181F")
    root.geometry("820x680")
    root.minsize(420, 300)

    header = tk.Frame(root, bg="#14181F")
    header.pack(fill="x", padx=14, pady=(12, 6))
    tk.Label(
        header,
        text=title,
        bg="#14181F",
        fg="#F5F7FA",
        font=("Microsoft YaHei UI", 11, "bold"),
        anchor="w",
    ).pack(side="left")
    tk.Label(
        header,
        text=f"{len(body_text)} 字",
        bg="#14181F",
        fg="#8B98A5",
        font=("Microsoft YaHei UI", 9),
    ).pack(side="right")

    widget = scrolledtext.ScrolledText(
        root,
        wrap="word",
        bg="#0E1218",
        fg="#DCE3EA",
        insertbackground="#DCE3EA",
        relief="flat",
        padx=14,
        pady=12,
        font=("Microsoft YaHei UI", 10),
    )
    widget.pack(fill="both", expand=True, padx=14, pady=(0, 12))
    widget.insert("1.0", body_text)
    widget.config(state="disabled")

    footer = tk.Label(
        root,
        text="Esc 关闭 · Ctrl+C 复制全部",
        bg="#14181F",
        fg="#5C6672",
        font=("Microsoft YaHei UI", 9),
        anchor="w",
    )
    footer.pack(fill="x", padx=14, pady=(0, 10))

    def copy_all(_event=None) -> str:
        root.clipboard_clear()
        root.clipboard_append(body_text)
        return "break"

    root.bind("<Escape>", lambda _event: root.destroy())
    root.bind("<Control-c>", copy_all)
    root.focus_force()
    root.mainloop()


# --------------------------------------------------------------------------- #


def report_status() -> int:
    """Print what the panel is doing, in one line, for a caller to display.

    Three states have to be distinguishable, because they need different
    responses: running (leave it alone), stopped cleanly (safe to start again),
    and absent with no exit record (it crashed, so look at the log).
    """
    try:
        with open(status_path(), "r", encoding="utf-8") as handle:
            status = json.load(handle)
        age = time.time() - os.path.getmtime(status_path())
    except (OSError, json.JSONDecodeError):
        status = None
        age = 0.0

    if status:
        # Liveness is judged by the file's age, not by the PID in it.
        #
        # ``os.kill(pid, 0)`` is the obvious test and it is wrong on Windows: it
        # succeeds whenever the PID exists, and a PID that has been recycled by an
        # unrelated process exists too. That produced a stop that reported success
        # and left the button reading "running" for a window that was already gone.
        #
        # The panel rewrites this file every few seconds, so a stale timestamp is
        # direct evidence that nothing is writing it any more - and it needs no
        # Win32 call that could block.
        heartbeat = 5.0
        if age <= heartbeat * 4:
            print(
                f"running pid={status.get('pid')} hwnd={status.get('hwnd')} "
                f"bubbles={status.get('bubbles')} ingested={status.get('ingested')} "
                f"hidden={status.get('hidden')} height={status.get('settings', {}).get('height')} "
                f"age={age:.1f}s"
            )
            return 0
        print(
            f"stale pid={status.get('pid')} last_at={status.get('at')} "
            f"ingested={status.get('ingested')} age={age:.0f}s"
        )
        return 1

    try:
        with open(done_path(), "r", encoding="utf-8") as handle:
            done = json.load(handle)
        print(f"stopped at={done.get('at')} reason={done.get('reason')} ingested={done.get('ingested')}")
        return 1
    except (OSError, json.JSONDecodeError):
        print("not running (no status file)")
        return 2


def main() -> int:
    parser = argparse.ArgumentParser(description="Session-bound danmaku overlay for DeepSeek Harness")
    parser.add_argument("--session", default=os.environ.get("DSH_SESSION_ID", ""))
    parser.add_argument("--url", default=None)
    parser.add_argument("--title", default=None)
    parser.add_argument(
        "--check",
        action="store_true",
        help="build everything, report it, and exit without showing a window",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="print the live status file and exit; used by the DSH-side button",
    )
    args = parser.parse_args()

    if args.status:
        return report_status()

    base_url = discover_base_url(args.url)
    if base_url is None:
        print("could not determine the harness URL; pass --url", file=sys.stderr)
        return 2

    settings = read_settings()
    # Resolve an unset position now, so the file records where the window is and
    # the DSH-side settings editor has a real value to show.
    if settings.get("x") is None or settings.get("y") is None:
        settings["x"], settings["y"] = default_position(int(settings["width"]), int(settings["height"]))
    if not os.path.exists(settings_path()):
        write_settings(settings)

    overlay = Overlay(base_url, args.session or None, settings)

    # Startup self-check: a window that cannot be inspected is a window that
    # cannot be debugged. This records the geometry, the region and the stack, so
    # "nothing visible" can be told apart from "drawn somewhere off screen".
    report = [
        f"at={time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"hwnd={overlay.canvas.hwnd} size={overlay.canvas.width}x{overlay.canvas.height}",
        f"alpha={settings['alpha']} clickThrough={settings['clickThrough']} "
        f"maxBubbles={settings['maxBubbles']} backfill={settings.get('backfillBubbles')}",
        f"bubbles={len(overlay.bubbles)}",
    ]
    for bubble in overlay.bubbles:
        report.append(
            f"  {bubble.kind} w={bubble.width} h={bubble.height} x={bubble.x} y={bubble.y} "
            f"right={bubble.x + bubble.width} {bubble.text[:60]}"
        )
    try:
        with open(os.path.join(os.path.dirname(settings_path()), ".panel-startup.log"), "w", encoding="utf-8") as handle:
            handle.write("\n".join(report) + "\n")
    except OSError:
        pass

    if args.check:
        for line in report:
            print(line)
        overlay.stop()
        overlay._mark_done("check", "built and verified, window never shown")
        return 0

    # A stop request left over from a previous run would make this instance quit
    # immediately, so the file is cleared as the very first order of business.
    try:
        os.remove(stop_path())
    except OSError:
        pass

    try:
        overlay.run()
    except KeyboardInterrupt:
        overlay._mark_done("interrupted")
    except Exception as error:  # noqa: BLE001 - record why before dying
        overlay._mark_done("crashed", f"{type(error).__name__}: {error}")
        raise
    else:
        if overlay._stop_requested:
            overlay._mark_done("stopped", "a stop was requested")
        else:
            overlay._mark_done("idle-exit", f"no events for {settings.get('idleExitSeconds')}s")
    finally:
        overlay.stop()
        # Leaving the request behind would stop the next instance on sight.
        try:
            os.remove(stop_path())
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
