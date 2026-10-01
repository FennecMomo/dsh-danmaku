#!/usr/bin/env python3
"""Render one bubble and compare the drawn buffer against the screen.

The two questions this answers, in order:

1. Does the *drawing buffer* hold opaque bubbles on a faint panel? If not, the
   bug is in the drawing code and no amount of window plumbing will help.
2. Does a screen capture of the same window agree with the buffer? If not, the
   drawing is right and the defect is in how the window is presented or clipped -
   ``UpdateLayeredWindow``, the blend function, the region, or DPI scaling.

Run:  python compare_render.pyw
"""

from __future__ import annotations

import ctypes
import os
import sys
import time
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from layered_window import LayeredCanvas  # noqa: E402
from probe_alpha import grab_printwindow, summarize, write_png  # noqa: E402

PANEL_BG = "#FFFFFF"
PANEL_ALPHA = 60
BUBBLE_FILL = "#11151B"
BUBBLE_ALPHA = 255
BODY_FONT = ("Microsoft YaHei UI", 15, 400)
PADDING_X = 12
PADDING_Y = 8
RADIUS = 10

user32 = ctypes.windll.user32


def alpha_at(raw: bytes, width: int, x: int, y: int) -> int:
    return raw[(y * width + x) * 4 + 3]


def colour_at(raw: bytes, width: int, x: int, y: int) -> tuple[int, int, int, int]:
    index = (y * width + x) * 4
    blue, green, red, alpha = raw[index : index + 4]
    return red, green, blue, alpha


def main() -> int:
    width, height = 320, 180
    canvas = LayeredCanvas(60, 60, width, height, class_name="DshRenderCompare")
    try:
        # A faint panel, then one bubble at the bottom-right.
        canvas.fill(PANEL_BG, PANEL_ALPHA)
        text = "正在修改 danmaku/layered_window.py"
        text_width, text_height = canvas.measure_text(text, BODY_FONT, 260)
        bubble_width = min(260, text_width) + PADDING_X * 2
        bubble_height = text_height + PADDING_Y * 2
        bubble_x = width - 10 - bubble_width
        bubble_y = height - 10 - bubble_height

        canvas.rounded_rect(
            bubble_x, bubble_y, bubble_width, bubble_height, RADIUS, BUBBLE_FILL, BUBBLE_ALPHA,
            "#4C86E8", 255,
        )
        canvas.draw_text(
            text, bubble_x + PADDING_X, bubble_y + PADDING_Y,
            bubble_width - PADDING_X * 2, bubble_height - PADDING_Y * 2,
            BODY_FONT, "#FFFFFF",
        )
        # GDI wrote the colours but not the alpha, so the bubble would otherwise
        # still carry the panel's faint alpha. This is the step under test.
        canvas.force_opaque(bubble_x, bubble_y, bubble_width, bubble_height)
        canvas.set_region([(bubble_x, bubble_y, bubble_width, bubble_height)], RADIUS)
        canvas.present()
        time.sleep(1.2)  # let the compositor settle before reading it back

        print(f"window hwnd={canvas.hwnd} size={width}x{height}")
        print(f"bubble  x={bubble_x} y={bubble_y} w={bubble_width} h={bubble_height}")
        centre_x = bubble_x + bubble_width // 2
        centre_y = bubble_y + bubble_height // 2
        panel_x, panel_y = 6, 6
        print(f"probe points: panel=({panel_x},{panel_y}) bubble=({centre_x},{centre_y})")

        buffer_width, _, buffer_raw = canvas.snapshot()
        print(f"\nDRAWN BUFFER over the whole surface: {summarize(buffer_width, height, buffer_raw)}")
        print(f"  panel pixel  {colour_at(buffer_raw, buffer_width, panel_x, panel_y)}  (want a=60, near white)")
        print(f"  bubble pixel {colour_at(buffer_raw, buffer_width, centre_x, centre_y)}  (want a=255, dark)")

        out_dir = os.path.dirname(os.path.abspath(__file__))
        write_png(os.path.join(out_dir, "compare-buffer.png"), buffer_width, height, buffer_raw)

        captured = grab_printwindow(canvas.hwnd)
        if captured is None:
            print("\nSCREEN CAPTURE: PrintWindow returned nothing")
        else:
            screen_width, screen_height, screen_raw = captured
            print(f"\nSCREEN CAPTURE via PrintWindow: {summarize(screen_width, screen_height, screen_raw)}")
            print(f"  panel pixel  {colour_at(screen_raw, screen_width, panel_x, panel_y)}")
            print(f"  bubble pixel {colour_at(screen_raw, screen_width, centre_x, centre_y)}")
            write_png(os.path.join(out_dir, "compare-screen.png"), screen_width, screen_height, screen_raw)

        print("\nwindow styles: exstyle=0x%08X" % user32.GetWindowLongW(wintypes.HWND(canvas.hwnd), -20))
        region_type = ctypes.windll.gdi32.CreateRectRgn(0, 0, 1, 1)
        print(f"window has a region: {bool(user32.GetWindowRgn(wintypes.HWND(canvas.hwnd), region_type))}")
        ctypes.windll.gdi32.DeleteObject(region_type)

        print("\nholding the window open for 6s so it can be looked at directly")
        time.sleep(6)
    finally:
        canvas.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
