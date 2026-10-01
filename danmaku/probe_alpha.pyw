#!/usr/bin/env python3
"""Read back the alpha channel of a live layered window and write a PNG.

Why this exists
---------------
"the bubbles look transparent" is not something that can be diagnosed by reading
the drawing code, because the code is only half the story: ``UpdateLayeredWindow``
either honours the per-pixel alpha channel or silently falls back to something
else, and which one happened is visible only in the pixels Windows actually kept.

So this asks Windows for the surface it is holding - ``GetDC`` on the window gives
the layered composition, and ``BitBlt`` copies it out - then reports the alpha
distribution and writes the result next to this script. An opaque bubble shows up
as a solid block of 255s; a bubble that is being blended shows up as lower values.

Usage:  pythonw probe_alpha.pyw [--hwnd N] [--title dsh-danmaku] [--out shot.png]
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import os
import struct
import sys
import time
import zlib

# The structures come from ``layered_window`` instead of being declared again
# here. ``ctypes.windll.user32`` and ``gdi32`` are cached WinDLLs shared by every
# module in the process, so the argtypes installed by one module apply to calls
# made from another. A second, structurally identical BITMAPINFOHEADER or RECT
# therefore does not shadow anything - it *overwrites* the argtypes, and the
# original module's next call dies with "expected LP_X instance instead of
# pointer to X". Importing the real types makes the issue impossible.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from layered_window import BITMAPINFOHEADER, RECT  # noqa: E402

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
BI_RGB = 0


user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindowVisible.argtypes = [wintypes.HWND]

gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateDIBSection.argtypes = [
    wintypes.HDC,
    ctypes.POINTER(BITMAPINFOHEADER),
    wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p),
    wintypes.HANDLE,
    wintypes.DWORD,
]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.BitBlt.argtypes = [
    wintypes.HDC,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.HDC,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.DWORD,
]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]


def find_window(title: str) -> list[int]:
    """Every top-level window whose title contains ``title``."""
    found: list[int] = []
    proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def visit(hwnd, _lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        if length:
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)
            if title.lower() in buffer.value.lower():
                found.append(int(hwnd))
        return True

    user32.EnumWindows(proc_type(visit), 0)
    return found


def grab(hwnd: int) -> tuple[int, int, bytes]:
    """Copy the window's current pixels out as straight BGRA rows."""
    rect = RECT()
    if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        raise OSError("GetWindowRect failed")
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        raise OSError(f"degenerate window size {width}x{height}")

    screen_dc = user32.GetDC(None)
    memory_dc = gdi32.CreateCompatibleDC(screen_dc)
    header = BITMAPINFOHEADER()
    header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    header.biWidth = width
    header.biHeight = -height  # top-down, so row 0 is the top
    header.biPlanes = 1
    header.biBitCount = 32
    header.biCompression = BI_RGB
    bits = ctypes.c_void_p()
    bitmap = gdi32.CreateDIBSection(
        screen_dc, ctypes.byref(header), DIB_RGB_COLORS, ctypes.byref(bits), None, 0
    )
    if not bitmap:
        raise OSError("CreateDIBSection failed")
    previous = gdi32.SelectObject(memory_dc, bitmap)

    window_dc = user32.GetDC(wintypes.HWND(hwnd))
    ok = gdi32.BitBlt(memory_dc, 0, 0, width, height, window_dc, 0, 0, SRCCOPY)
    user32.ReleaseDC(wintypes.HWND(hwnd), window_dc)

    raw = ctypes.string_at(bits, width * height * 4)
    gdi32.SelectObject(memory_dc, previous)
    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(memory_dc)
    user32.ReleaseDC(None, screen_dc)
    if not ok:
        raise OSError("BitBlt failed")
    return width, height, raw


PW_RENDERFULLCONTENT = 0x00000002


def grab_printwindow(hwnd: int) -> tuple[int, int, bytes] | None:
    """Capture through ``PrintWindow``, which can see layered surfaces.

    ``BitBlt`` from a layered window's DC returns nothing: a ``WS_EX_LAYERED``
    window does not keep its pixels in the DC that ``GetDC`` hands out. This path
    goes through the compositor instead and does return them on Windows 8.1+.

    WARNING: this is a synchronous cross-process request and it **can hang**. When
    the target process is busy, ``PrintWindow`` waits for it to pump messages, and
    the wait has no timeout. It is therefore opt-in (``--printwindow``) and never
    part of the default path.
    """
    rect = RECT()
    user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect))
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        return None

    screen_dc = user32.GetDC(None)
    memory_dc = gdi32.CreateCompatibleDC(screen_dc)
    header = BITMAPINFOHEADER()
    header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    header.biWidth = width
    header.biHeight = -height
    header.biPlanes = 1
    header.biBitCount = 32
    header.biCompression = BI_RGB
    bits = ctypes.c_void_p()
    bitmap = gdi32.CreateDIBSection(
        screen_dc, ctypes.byref(header), DIB_RGB_COLORS, ctypes.byref(bits), None, 0
    )
    if not bitmap:
        gdi32.DeleteDC(memory_dc)
        user32.ReleaseDC(None, screen_dc)
        return None
    previous = gdi32.SelectObject(memory_dc, bitmap)

    user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
    user32.PrintWindow.restype = wintypes.BOOL
    ok = user32.PrintWindow(wintypes.HWND(hwnd), memory_dc, PW_RENDERFULLCONTENT)
    raw = ctypes.string_at(bits, width * height * 4) if ok else None

    gdi32.SelectObject(memory_dc, previous)
    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(memory_dc)
    user32.ReleaseDC(None, screen_dc)
    return (width, height, raw) if raw is not None else None


def write_png(path: str, width: int, height: int, bgra: bytes) -> None:
    """Minimal PNG writer: BGRA rows in, RGBA8 PNG out."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter type 0 (None)
        start = y * width * 4
        for x in range(width):
            blue, green, red, alpha = bgra[start + x * 4 : start + x * 4 + 4]
            rows += bytes((red, green, blue, alpha))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.write(chunk(b"IHDR", header))
        handle.write(chunk(b"IDAT", zlib.compress(bytes(rows), 6)))
        handle.write(chunk(b"IEND", b""))


def summarize(width: int, height: int, bgra: bytes) -> dict:
    """Alpha distribution, and the same for the near-black bubble interiors."""
    alphas: dict[int, int] = {}
    opaque = 0
    clear = 0
    for index in range(3, len(bgra), 4):
        value = bgra[index]
        alphas[value] = alphas.get(value, 0) + 1
        if value >= 250:
            opaque += 1
        elif value <= 2:
            clear += 1
    total = width * height
    top = sorted(alphas.items(), key=lambda item: -item[1])[:6]
    return {
        "total": total,
        "opaque_pct": round(opaque * 100.0 / total, 2),
        "clear_pct": round(clear * 100.0 / total, 2),
        "top_alpha_values": top,
    }


def window_pid(hwnd: int) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
    return pid.value


def describe_windows(title: str) -> None:
    """List every match with its PID and visibility, so the right one can be picked."""
    for hwnd in find_window(title):
        print(
            f"  hwnd={hwnd} pid={window_pid(hwnd)} "
            f"visible={bool(user32.IsWindowVisible(wintypes.HWND(hwnd)))}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe a layered window's real alpha channel")
    parser.add_argument("--hwnd", type=int, default=0)
    parser.add_argument("--pid", type=int, default=0, help="pick the match owned by this process")
    parser.add_argument("--title", default="dsh-danmaku")
    parser.add_argument("--out", default=None)
    parser.add_argument("--list", action="store_true", help="only list matching windows")
    parser.add_argument(
        "--printwindow",
        action="store_true",
        help="try PrintWindow as well; can hang, so never automatic",
    )
    parser.add_argument("--rows", type=int, default=0, help="also scan N horizontal rows for edges")
    args = parser.parse_args()

    handles = find_window(args.title)
    if args.pid:
        handles = [hwnd for hwnd in handles if window_pid(hwnd) == args.pid]
    if args.list:
        print(f"windows matching {args.title!r}:")
        describe_windows(args.title)
        return 0
    if not handles:
        print(f"no window titled like {args.title!r} found", file=sys.stderr)
        return 2

    hwnd = handles[0]
    width = height = 0
    raw = b""
    source = "bitblt"
    # Never the default: see grab_printwindow's warning about hanging.
    if args.printwindow:
        captured = grab_printwindow(hwnd)
        if captured is not None and captured[2].count(b"\x00") != len(captured[2]):
            width, height, raw = captured
            source = "printwindow"
    if not raw:
        for attempt in range(3):
            try:
                width, height, raw = grab(hwnd)
                break
            except OSError as error:
                if attempt == 2:
                    print(f"grab failed: {error}", file=sys.stderr)
                    return 3
                time.sleep(0.3)

    print(
        f"hwnd={hwnd} pid={window_pid(hwnd)} "
        f"visible={bool(user32.IsWindowVisible(wintypes.HWND(hwnd)))} "
        f"size={width}x{height} via={source}"
    )
    print(f"summary={summarize(width, height, raw)}")

    if args.rows:
        for y in range(0, height, max(1, height // args.rows)):
            row = []
            for x in range(0, width, max(1, width // 12)):
                row.append(f"{raw[(y * width + x) * 4 + 3]:3d}")
            print(f"  y={y:3d} alpha: {' '.join(row)}")

    out = args.out or f"probe-{hwnd}.png"
    write_png(out, width, height, raw)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
