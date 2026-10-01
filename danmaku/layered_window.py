#!/usr/bin/env python3
"""A borderless, click-through-capable overlay window with PER-PIXEL alpha.

Why this exists instead of Tk alone
-----------------------------------
Tk draws widgets into a window whose opacity is set for the whole surface:
``SetLayeredWindowAttributes`` takes one alpha value, so fading the background
also fades everything on top of it. That is fine for a uniform overlay and
useless for this one, which needs a faint background and fully opaque bubbles in
the same window.

Per-pixel transparency is a different Windows path: ``UpdateLayeredWindow`` with
a 32-bit premultiplied-ARGB bitmap. Every pixel carries its own alpha, so the
background can sit at 40% while the bubbles stay at 100%. Tk cannot provide that,
because it offers no access to the pixels it painted, so this module owns a
device-independent bitmap, draws into it with GDI, and hands it to Windows.

What is drawn, and how
----------------------
Fills use ``RoundRect`` with a solid brush, which is aliased but sharp enough at
these radii. Text uses ``DrawTextW`` with ``DT_CALCRECT`` first so a bubble is
sized to its content -- that measurement is what makes a bubble exactly as wide
as its text plus padding.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

WS_EX_LAYERED = 0x00080000
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TRANSPARENT = 0x00000020

WS_POPUP = 0x80000000

#: SetWindowPos z-orders. HWND_TOPMOST is the pseudo-handle -1.
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
#: Keep a borderless popup out of the taskbar and out of Alt-Tab.
SWP_NOOWNERZORDER = 0x0200

SW_SHOWNOACTIVATE = 4

#: Cursor and click observation, used when the window must NOT receive mouse
#: messages. Reading these from the drawing loop is what lets the overlay be fully
#: click-through and still notice a click - see ``Overlay._poll_click``.
VK_LBUTTON = 0x01
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

ULW_ALPHA = 0x00000002
AC_SRC_OVER = 0x00
AC_SRC_ALPHA = 0x01

BI_RGB = 0
DIB_RGB_COLORS = 0

DT_LEFT = 0x00000000
DT_CENTER = 0x00000001
DT_RIGHT = 0x00000002
DT_TOP = 0x00000000
DT_WORDBREAK = 0x00000010
DT_CALCRECT = 0x00000400
DT_NOPREFIX = 0x00000800
DT_EDITCONTROL = 0x00002000
DT_END_ELLIPSIS = 0x00008000

WM_LBUTTONUP = 0x0202

#: Messages that decide whether a window whose thread never pumps behaves like a
#: passive surface or like a hung application. See LayeredCanvas._handle_message.
WM_SETCURSOR = 0x0020
WM_NCHITTEST = 0x0084
WM_MOUSEACTIVATE = 0x0021
HTCLIENT = 1
MA_NOACTIVATE = 3

RGN_OR = 2

TRANSPARENT_BK = 1

DEFAULT_CHARSET = 1
CLEARTYPE_QUALITY = 5
ANTIALIASED_QUALITY = 4

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32


# --------------------------------------------------------------------------- #
# Structures
# --------------------------------------------------------------------------- #


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [
        ("BlendOp", ctypes.c_ubyte),
        ("BlendFlags", ctypes.c_ubyte),
        ("SourceConstantAlpha", ctypes.c_ubyte),
        ("AlphaFormat", ctypes.c_ubyte),
    ]


# ``ctypes.windll.user32`` is a **shared, cached** WinDLL, so every module in the
# process writes ``argtypes`` onto the same function objects. A RECT declared
# privately here and a differently declared one in a diagnostic script silently
# clobber each other's argtypes, and the loser fails at its first call with
# "expected LP_RECT instance instead of pointer to RECT".
#
# Aliasing the single ``wintypes.RECT`` removes the whole class of conflict: every
# module that writes these argtypes writes the same type. The short name is kept
# because it is used throughout this file.
RECT = wintypes.RECT


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class SIZE(ctypes.Structure):
    _fields_ = [("cx", wintypes.LONG), ("cy", wintypes.LONG)]


class WNDCLASSW(ctypes.Structure):
    """Win32 ``WNDCLASSW``.

    Declared here because ``ctypes.wintypes`` does not provide it, and the
    callback field must be typed as a pointer-sized value or RegisterClassW sees
    a malformed structure.
    """

    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", ctypes.c_void_p),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_longlong, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

# Every function used below gets explicit argtypes/restype.
#
# This is not tidiness. Without them ctypes assumes 32-bit ints for handles, and
# on 64-bit Windows a module handle or HWND does not fit: CreateWindowExW then
# fails with "OverflowError: int too long to convert" instead of creating a
# window. Declaring the types once here removes that whole class of failure.
user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
user32.RegisterClassW.restype = wintypes.ATOM

user32.CreateWindowExW.argtypes = [
    wintypes.DWORD,
    wintypes.LPCWSTR,
    wintypes.LPCWSTR,
    wintypes.DWORD,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.HWND,
    wintypes.HMENU,
    wintypes.HINSTANCE,
    ctypes.c_void_p,
]
user32.CreateWindowExW.restype = wintypes.HWND

user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL

user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.DestroyWindow.restype = wintypes.BOOL

user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.restype = ctypes.c_longlong

#: The cursor name is a MAKEINTRESOURCE value rather than a string: IDC_ARROW
#: arrives as the integer 32512 cast to a pointer. Typing the parameter as a
#: string makes ctypes reject the call outright.
IDC_ARROW = 32512

user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
user32.LoadCursorW.restype = wintypes.HANDLE

user32.SetCursor.argtypes = [wintypes.HANDLE]
user32.SetCursor.restype = wintypes.HANDLE

user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
user32.GetCursorPos.restype = wintypes.BOOL

user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short

user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int

user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowLongW.restype = wintypes.LONG

user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.LONG]
user32.SetWindowLongW.restype = wintypes.LONG

user32.SetWindowPos.argtypes = [
    wintypes.HWND,
    wintypes.HWND,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.UINT,
]
user32.SetWindowPos.restype = wintypes.BOOL

user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetWindowRect.restype = wintypes.BOOL

user32.SetWindowRgn.argtypes = [wintypes.HWND, wintypes.HRGN, wintypes.BOOL]
user32.SetWindowRgn.restype = ctypes.c_int

gdi32.CreateRoundRectRgn.argtypes = [
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
]
gdi32.CreateRoundRectRgn.restype = wintypes.HRGN

gdi32.CombineRgn.argtypes = [wintypes.HRGN, wintypes.HRGN, wintypes.HRGN, ctypes.c_int]
gdi32.CombineRgn.restype = ctypes.c_int

user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC

user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.ReleaseDC.restype = ctypes.c_int

user32.UpdateLayeredWindow.argtypes = [
    wintypes.HWND,
    wintypes.HDC,
    ctypes.POINTER(POINT),
    ctypes.POINTER(SIZE),
    wintypes.HDC,
    ctypes.POINTER(POINT),
    wintypes.DWORD,
    ctypes.POINTER(BLENDFUNCTION),
    wintypes.DWORD,
]
user32.UpdateLayeredWindow.restype = wintypes.BOOL

kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE

kernel32.GetLastError.restype = wintypes.DWORD

gdi32.CreateDIBSection.argtypes = [
    wintypes.HDC,
    ctypes.POINTER(BITMAPINFOHEADER),
    wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p),
    wintypes.HANDLE,
    wintypes.DWORD,
]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP

gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC

gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ

gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteObject.restype = wintypes.BOOL

gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.DeleteDC.restype = wintypes.BOOL

gdi32.CreateSolidBrush.argtypes = [wintypes.COLORREF]
gdi32.CreateSolidBrush.restype = wintypes.HBRUSH

gdi32.CreatePen.argtypes = [ctypes.c_int, ctypes.c_int, wintypes.COLORREF]
gdi32.CreatePen.restype = wintypes.HPEN

gdi32.GetStockObject.argtypes = [ctypes.c_int]
gdi32.GetStockObject.restype = wintypes.HGDIOBJ

gdi32.RoundRect.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
gdi32.RoundRect.restype = wintypes.BOOL

gdi32.Polygon.argtypes = [wintypes.HDC, ctypes.POINTER(ctypes.c_long), ctypes.c_int]
gdi32.Polygon.restype = wintypes.BOOL

gdi32.CreateFontW.argtypes = [
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.LPCWSTR,
]
gdi32.CreateFontW.restype = wintypes.HFONT

gdi32.SetTextColor.argtypes = [wintypes.HDC, wintypes.COLORREF]
gdi32.SetTextColor.restype = wintypes.COLORREF

gdi32.SetBkMode.argtypes = [wintypes.HDC, ctypes.c_int]
gdi32.SetBkMode.restype = ctypes.c_int

# DrawTextW lives in user32, not gdi32, even though every other text call here
# is a GDI one.
user32.DrawTextW.argtypes = [wintypes.HDC, wintypes.LPCWSTR, ctypes.c_int, ctypes.POINTER(RECT), wintypes.UINT]
user32.DrawTextW.restype = ctypes.c_int


# --------------------------------------------------------------------------- #
# Colour helper
# --------------------------------------------------------------------------- #


def premultiplied(hex_colour: str, alpha: int) -> tuple[int, int, int, int]:
    """Split ``#RRGGBB`` plus an alpha into premultiplied B, G, R, A bytes.

    ``UpdateLayeredWindow`` with ``AC_SRC_ALPHA`` expects premultiplied colour:
    each channel already multiplied by the alpha. Passing straight colour makes
    translucent areas glow, which is the classic symptom of forgetting this.
    """
    value = hex_colour.lstrip("#")
    red = int(value[0:2], 16)
    green = int(value[2:4], 16)
    blue = int(value[4:6], 16)
    a = max(0, min(255, alpha))
    return (
        (blue * a) // 255,
        (green * a) // 255,
        (red * a) // 255,
        a,
    )


def colorref(hex_colour: str) -> int:
    """``#RRGGBB`` to a Win32 COLORREF (0x00BBGGRR)."""
    value = hex_colour.lstrip("#")
    return int(value[0:2], 16) | (int(value[2:4], 16) << 8) | (int(value[4:6], 16) << 16)


# --------------------------------------------------------------------------- #
# The window
# --------------------------------------------------------------------------- #


def create_font(font: tuple[str, int, int]) -> int:
    """Create a GDI font handle. The caller owns it and must delete it."""
    family, size, weight = font
    return gdi32.CreateFontW(
        -size,  # negative height means "character height", the usual choice
        0,
        0,
        0,
        weight,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        0,
        0,
        CLEARTYPE_QUALITY,
        0,
        family,
    )


def measure_text_standalone(text: str, font: tuple[str, int, int], max_width: int) -> tuple[int, int]:
    """Measure wrapped text with no window involved.

    Exists so a caller can size its window *before* creating it. Sizing afterwards
    would mean showing a large empty surface first and shrinking it a moment
    later, which is visible as a flash.

    ``DT_CALCRECT`` makes DrawText compute the rectangle the text needs, and it
    comes from the same renderer that will draw it, so the two cannot disagree.
    That guarantee is the reason this is not done with a hand-rolled character
    count: an estimate that is 20% short stacks the bubbles off the top edge.
    """
    screen_dc = user32.GetDC(None)
    memory_dc = gdi32.CreateCompatibleDC(wintypes.HDC(screen_dc))
    font_handle = create_font(font)
    previous = gdi32.SelectObject(wintypes.HDC(memory_dc), wintypes.HGDIOBJ(font_handle))
    rect = RECT(0, 0, max_width, 0)
    user32.DrawTextW(
        wintypes.HDC(memory_dc),
        text,
        -1,
        ctypes.byref(rect),
        DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX | DT_EDITCONTROL,
    )
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    gdi32.SelectObject(wintypes.HDC(memory_dc), wintypes.HGDIOBJ(previous))
    gdi32.DeleteObject(wintypes.HGDIOBJ(font_handle))
    gdi32.DeleteDC(wintypes.HDC(memory_dc))
    user32.ReleaseDC(None, wintypes.HDC(screen_dc))
    return width, height


class LayeredCanvas:
    """A topmost, borderless window whose pixels each carry their own alpha.

    Drawing is immediate: every ``present()`` redraws the whole surface, which is
    the right model here because the content is a stack of a few dozen shapes
    that changes as a whole when a bubble is added.
    """

    def __init__(
        self,
        x: int,
        y: int,
        width: int,
        height: int,
        class_name: str = "DshDanmakuOverlay",
        on_click=None,
    ):
        self._on_click = on_click
        self.hwnd = self._create_window(x, y, width, height, class_name)
        self._bitmap = None
        self._memory_dc = None
        self._screen_dc = None
        self._previous_bitmap = None
        self._bits = ctypes.c_void_p()
        #: The rectangles the window is currently clipped to, mirroring the system
        #: region so diagnostics can report the geometry instead of guessing.
        self.region: list[tuple[int, int, int, int]] = []
        self._blank()

    # -- window ------------------------------------------------------------- #

    def _create_window(self, x: int, y: int, width: int, height: int, class_name: str) -> int:
        # The callback must outlive the window, so it is bound to the instance;
        # a temporary would be collected and the window procedure would vanish.
        self._wndproc = WNDPROC(self._handle_message)

        wc = WNDCLASSW()
        wc.style = 0
        wc.lpfnWndProc = ctypes.cast(self._wndproc, ctypes.c_void_p)
        wc.cbClsExtra = 0
        wc.cbWndExtra = 0
        wc.hInstance = kernel32.GetModuleHandleW(None)
        wc.hIcon = None
        # Held on the instance as well, because WM_SETCURSOR sets it directly rather
        # than letting DefWindowProc consult the class.
        self._cursor = user32.LoadCursorW(None, ctypes.c_void_p(IDC_ARROW))
        wc.hCursor = self._cursor
        wc.hbrBackground = None
        wc.lpszMenuName = None
        wc.lpszClassName = class_name

        atom = user32.RegisterClassW(ctypes.byref(wc))
        if atom == 0:
            error = kernel32.GetLastError()
            # 1410 = class already registered, which is expected when a previous
            # instance in the same process used this class name.
            if error != 1410:
                raise ctypes.WinError(error)

        ex_style = WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
        hwnd = user32.CreateWindowExW(
            ex_style,
            class_name,
            "dsh-danmaku",
            WS_POPUP,
            x,
            y,
            width,
            height,
            None,
            None,
            wc.hInstance,
            None,
        )
        if not hwnd:
            raise ctypes.WinError(kernel32.GetLastError())
        user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
        return int(hwnd)

    def _handle_message(self, hwnd, message, wparam, lparam) -> int:
        """The window procedure.

        The messages handled explicitly here are the ones that decide whether this
        window behaves like a passive surface or like an application that has
        stopped responding. That distinction turned out to matter a great deal:

        **This process has no message pump.** The drawing loop is a plain `while`
        with a `sleep`, so nothing ever calls `GetMessage`/`DispatchMessage`. A
        window in that situation still receives messages, and while the mouse is
        over it Windows sends a steady stream of `WM_SETCURSOR`, `WM_NCHITTEST` and
        `WM_MOUSEMOVE`. Queueing those against a thread that never drains them is
        what produced the busy cursor on hover and the eventual freeze - at almost
        no CPU cost, because a queue filling up is not a spin.

        So the cursor is set directly and the hit test is answered directly, which
        keeps Windows from doing its own default handling (and its own waiting) on
        both. `WM_MOUSEACTIVATE` refuses activation outright: this window must never
        take focus from whatever the user is working in.
        """
        if message == WM_SETCURSOR:
            # Answer it, do not defer it. DefWindowProc would consult the class
            # cursor and, for a window whose thread is not pumping, may leave the
            # system showing its "starting" cursor instead.
            user32.SetCursor(self._cursor)
            return 1
        if message == WM_NCHITTEST:
            # Inside the region (Windows already clipped to it), so this is a
            # normal client area. Answering avoids the default path entirely.
            return HTCLIENT
        if message == WM_MOUSEACTIVATE:
            # Never activate: the overlay is a display surface and must not pull
            # focus away from the window the user is typing in.
            return MA_NOACTIVATE
        if self._on_click is not None and message == WM_LBUTTONUP:
            # lparam packs the client-relative cursor position as two signed
            # 16-bit values. Unpacked by hand because ctypes has no helper.
            x = ctypes.c_short(lparam & 0xFFFF).value
            y = ctypes.c_short((lparam >> 16) & 0xFFFF).value
            try:
                self._on_click(x, y)
            except Exception:  # noqa: BLE001 - a bad handler must not kill the window
                pass
            return 0
        # Everything else goes to DefWindowProc: the surface is drawn by
        # UpdateLayeredWindow, never by WM_PAINT.
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def set_click_through(self, enabled: bool) -> None:
        """Toggle mouse transparency for the whole window.

        This is the blunt instrument. It exists for the case where even the
        bubbles should not be clickable; ``set_region`` is the precise one.
        """
        GWL_EXSTYLE = -20
        style = user32.GetWindowLongW(wintypes.HWND(self.hwnd), GWL_EXSTYLE)
        style = style | WS_EX_TRANSPARENT if enabled else style & ~WS_EX_TRANSPARENT
        user32.SetWindowLongW(wintypes.HWND(self.hwnd), GWL_EXSTYLE, style)

    def set_region(self, rectangles: list[tuple[int, int, int, int]], radius: int = 0) -> None:
        """Clip the window to a union of rectangles in window coordinates.

        This is what makes an overlay with see-through gaps usable. The window is
        one surface, but a window *region* decides which parts of it exist for
        hit-testing and painting. Without a region the whole rectangle swallows
        clicks, including the empty space between bubbles, so a transparent
        overlay still behaves like a solid block parked over the desktop.

        With the region set to exactly the bubbles, the gaps are genuinely not
        there: clicks land on whatever is behind them, and the bubbles
        themselves stay clickable.

        An empty list removes the region entirely.
        """
        if not rectangles:
            self.region = []
            user32.SetWindowRgn(wintypes.HWND(self.hwnd), None, True)
            return
        # A region is a hard-edged shape, so its rounded corners cut a hair inside
        # the drawn bubble. Growing each rectangle by one pixel hides that seam.
        combined = None
        for x, y, width, height in rectangles:
            piece = gdi32.CreateRoundRectRgn(x, y, x + width + 1, y + height + 1, radius * 2, radius * 2)
            if not piece:
                continue
            if combined is None:
                combined = piece
            else:
                # CombineRgn with RGN_OR gives the union. On success it consumes
                # neither source, so both handles are deleted afterwards.
                gdi32.CombineRgn(combined, combined, piece, RGN_OR)
                gdi32.DeleteObject(wintypes.HGDIOBJ(piece))
        if combined is None:
            return
        self.region = list(rectangles)
        if not user32.SetWindowRgn(wintypes.HWND(self.hwnd), combined, True):
            # On failure the region is still ours to free. On success the system
            # owns it and deleting it would be a double free.
            gdi32.DeleteObject(wintypes.HGDIOBJ(combined))

    def move(self, x: int, y: int) -> None:
        user32.SetWindowPos(
            wintypes.HWND(self.hwnd),
            wintypes.HWND(HWND_TOPMOST),
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE,
        )

    def geometry(self) -> tuple[int, int, int, int]:
        rect = RECT()
        user32.GetWindowRect(wintypes.HWND(self.hwnd), ctypes.byref(rect))
        return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top

    # -- surface ------------------------------------------------------------ #

    def resize(self, width: int, height: int) -> None:
        """Rebuild the backing bitmap at a new size."""
        user32.SetWindowPos(
            wintypes.HWND(self.hwnd),
            wintypes.HWND(HWND_TOPMOST),
            0,
            0,
            width,
            height,
            SWP_NOMOVE | SWP_NOACTIVATE,
        )
        self._release_surface()
        self._blank()

    def _blank(self) -> None:
        """Allocate the 32-bit top-down DIB used as the drawing surface."""
        rect = RECT()
        user32.GetWindowRect(wintypes.HWND(self.hwnd), ctypes.byref(rect))
        width = max(1, rect.right - rect.left)
        height = max(1, rect.bottom - rect.top)

        header = BITMAPINFOHEADER()
        header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        header.biWidth = width
        # Negative height requests a top-down bitmap, so row 0 is the top edge
        # and GDI's y axis matches the window's.
        header.biHeight = -height
        header.biPlanes = 1
        header.biBitCount = 32
        header.biCompression = BI_RGB

        self._screen_dc = user32.GetDC(None)
        self._memory_dc = gdi32.CreateCompatibleDC(wintypes.HDC(self._screen_dc))
        self._bitmap = gdi32.CreateDIBSection(
            wintypes.HDC(self._screen_dc),
            ctypes.byref(header),
            DIB_RGB_COLORS,
            ctypes.byref(self._bits),
            None,
            0,
        )
        if not self._bitmap:
            raise ctypes.WinError(kernel32.GetLastError())
        self._previous_bitmap = gdi32.SelectObject(wintypes.HDC(self._memory_dc), wintypes.HGDIOBJ(self._bitmap))
        self.width = width
        self.height = height

    def _release_surface(self) -> None:
        if self._memory_dc and self._previous_bitmap:
            gdi32.SelectObject(wintypes.HDC(self._memory_dc), wintypes.HGDIOBJ(self._previous_bitmap))
            self._previous_bitmap = None
        if self._bitmap:
            gdi32.DeleteObject(wintypes.HGDIOBJ(self._bitmap))
            self._bitmap = None
        if self._memory_dc:
            gdi32.DeleteDC(wintypes.HDC(self._memory_dc))
            self._memory_dc = None
        if self._screen_dc:
            user32.ReleaseDC(None, wintypes.HDC(self._screen_dc))
            self._screen_dc = None

    # -- drawing ------------------------------------------------------------ #

    def fill(self, hex_colour: str, alpha: int) -> None:
        """Paint the whole surface."""
        buffer_type = ctypes.c_uint32 * (self.width * self.height)
        pixels = buffer_type.from_address(self._bits.value)
        blue, green, red, a = premultiplied(hex_colour, alpha)
        packed = (a << 24) | (red << 16) | (green << 8) | blue
        # ctypes slicing assignment is C-speed; a per-pixel Python loop over a
        # 360x520 surface is 187,200 iterations, which is visible as lag.
        pixels[:] = [packed] * (self.width * self.height)

    def rounded_rect(
        self,
        x: int,
        y: int,
        width: int,
        height: int,
        radius: int,
        fill_hex: str,
        fill_alpha: int,
        outline_hex: str | None = None,
        outline_alpha: int = 255,
    ) -> None:
        """Draw one rounded rectangle, optionally outlined."""
        hdc = wintypes.HDC(self._memory_dc)
        if outline_hex is not None:
            pen = gdi32.CreatePen(0, 1, colorref(outline_hex))
            gdi32.SelectObject(hdc, wintypes.HGDIOBJ(pen))
        else:
            gdi32.SelectObject(hdc, wintypes.HGDIOBJ(gdi32.GetStockObject(8)))  # NULL_PEN

        brush = gdi32.CreateSolidBrush(colorref(fill_hex))
        gdi32.SelectObject(hdc, wintypes.HGDIOBJ(brush))
        gdi32.RoundRect(hdc, x, y, x + width, y + height, radius * 2, radius * 2)
        if outline_hex is not None:
            gdi32.DeleteObject(wintypes.HGDIOBJ(pen))
        gdi32.DeleteObject(wintypes.HGDIOBJ(brush))

    def triangle(self, points: list[tuple[int, int]], fill_hex: str) -> None:
        """Draw a filled triangle, used for the bubble tails."""
        hdc = wintypes.HDC(self._memory_dc)
        brush = gdi32.CreateSolidBrush(colorref(fill_hex))
        gdi32.SelectObject(hdc, wintypes.HGDIOBJ(brush))
        gdi32.SelectObject(hdc, wintypes.HGDIOBJ(gdi32.GetStockObject(8)))
        flat = (ctypes.c_long * (len(points) * 2))()
        for index, (px, py) in enumerate(points):
            flat[index * 2] = px
            flat[index * 2 + 1] = py
        gdi32.Polygon(hdc, flat, len(points))
        gdi32.DeleteObject(wintypes.HGDIOBJ(brush))

    def measure_text(self, text: str, font: tuple[str, int, int], max_width: int) -> tuple[int, int]:
        """Measure wrapped text without drawing it, for content-sized bubbles."""
        hdc = wintypes.HDC(self._memory_dc)
        font_handle = self._select_font(hdc, font)
        rect = RECT(0, 0, max_width, 0)
        user32.DrawTextW(
            hdc,
            text,
            -1,
            ctypes.byref(rect),
            DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX | DT_EDITCONTROL,
        )
        gdi32.SelectObject(hdc, wintypes.HGDIOBJ(self._previous_font))
        gdi32.DeleteObject(wintypes.HGDIOBJ(font_handle))
        return rect.right - rect.left, rect.bottom - rect.top

    def draw_text(
        self,
        text: str,
        x: int,
        y: int,
        width: int,
        height: int,
        font: tuple[str, int, int],
        colour_hex: str,
        align: str = "left",
    ) -> None:
        """Draw wrapped text inside a rectangle."""
        hdc = wintypes.HDC(self._memory_dc)
        font_handle = self._select_font(hdc, font)
        gdi32.SetTextColor(hdc, colorref(colour_hex))
        gdi32.SetBkMode(hdc, TRANSPARENT_BK)
        flags = DT_WORDBREAK | DT_NOPREFIX | DT_EDITCONTROL
        if align == "right":
            flags |= DT_RIGHT
        elif align == "center":
            flags |= DT_CENTER
        rect = RECT(x, y, x + width, y + height)
        user32.DrawTextW(hdc, text, -1, ctypes.byref(rect), flags)
        gdi32.SelectObject(hdc, wintypes.HGDIOBJ(self._previous_font))
        gdi32.DeleteObject(wintypes.HGDIOBJ(font_handle))

    def _select_font(self, hdc, font: tuple[str, int, int]) -> int:
        handle = create_font(font)
        self._previous_font = gdi32.SelectObject(hdc, wintypes.HGDIOBJ(handle))
        return handle

    def present(self) -> None:
        """Hand the surface to Windows. This is the only step that shows anything."""
        blend = BLENDFUNCTION(AC_SRC_OVER, 0, 255, AC_SRC_ALPHA)
        source = POINT(0, 0)
        size = SIZE(self.width, self.height)
        user32.UpdateLayeredWindow(
            wintypes.HWND(self.hwnd),
            wintypes.HDC(self._screen_dc),
            None,
            ctypes.byref(size),
            wintypes.HDC(self._memory_dc),
            ctypes.byref(source),
            0,
            ctypes.byref(blend),
            ULW_ALPHA,
        )

    def assert_topmost(self) -> None:
        """Re-assert the topmost seat.

        ``CreateWindowEx`` does not take an extended style for this, so the window
        is only topmost because ``SetWindowPos`` was called with ``HWND_TOPMOST``
        once - and that is not a standing guarantee. Another application raising
        itself to topmost, or a full-screen window coming and going, can take the
        seat away, after which the overlay sits behind ordinary windows and is
        effectively invisible in a busy desktop.

        Cheap enough to call on every present, which is exactly when it matters:
        the surface is being updated, so the overlay should be visible.
        """
        user32.SetWindowPos(
            wintypes.HWND(self.hwnd),
            wintypes.HWND(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )

    def lower_to_bottom(self) -> None:
        """Drop out of the topmost band without hiding the window.

        Used when the overlay must stop covering other windows - the topmost seat
        is what makes a full-screen or shared screen unusable, and no amount of
        transparency helps while it holds that seat.
        """
        user32.SetWindowPos(
            wintypes.HWND(self.hwnd),
            wintypes.HWND(HWND_NOTOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )

    def force_opaque(self, x: int, y: int, width: int, height: int, alpha: int = 255) -> None:
        """Write the alpha of a rectangle, leaving colours alone.

        This method exists because of a GDI behaviour that is easy to miss and
        produces exactly the wrong symptom. **GDI drawing calls do not write the
        alpha channel of a 32-bit DIB.** ``CreateSolidBrush`` + ``RoundRect``
        writes B, G and R for every pixel it covers and leaves the fourth byte
        untouched; ``DrawTextW`` does the same. The alpha that survives is
        whatever was already in the buffer.

        Fill the surface at alpha 60 and draw an opaque bubble on top, and the
        bubble comes out *at alpha 60* - the shape and its colour are right, so it
        looks correct in code, but the whole bubble is see-through and the text
        inside it is invisible. That is not a blending bug and no window setting
        fixes it; the alpha channel has to be written explicitly, here.

        Setting a whole rectangle rather than tracing the shape is deliberate: a
        bubble is drawn over a uniform background, so raising the entire bounding
        box changes nothing outside the shape, and the window region clips the
        corners away before anything is composited.

        ``alpha`` below 255 is the dimmed state. It has to happen here for the text
        to dim with its bubble: GDI zeroes the text's alpha like everything else, so
        fading only the shape would leave the words at full strength on a pale fill.
        """
        clamped_x = max(0, x)
        clamped_y = max(0, y)
        clamped_width = min(self.width, x + width) - clamped_x
        clamped_height = min(self.height, y + height) - clamped_y
        if clamped_width <= 0 or clamped_height <= 0:
            return
        pixels = (ctypes.c_uint32 * (self.width * self.height)).from_address(self._bits.value)
        view = memoryview(pixels).cast("B")
        stride = self.width * 4
        level = max(0, min(255, alpha))
        # Built once and sliced per row: a bytes multiply per pixel would dominate
        # the paint for a wide bubble.
        row_bytes = bytes((level,)) * clamped_width
        for row in range(clamped_y, clamped_y + clamped_height):
            start = row * stride + clamped_x * 4 + 3
            view[start : start + clamped_width * 4 : 4] = row_bytes

    def snapshot(self) -> tuple[int, int, bytes]:
        """Return the drawing surface as straight BGRA rows, for inspection.

        This is the buffer *before* Windows sees it. Comparing it against a screen
        capture is what separates "we drew it wrong" from "Windows is blending it
        differently than we asked", which are two very different bugs.
        """
        return self.width, self.height, ctypes.string_at(self._bits, self.width * self.height * 4)

    def cursor_client_position(self) -> tuple[int, int] | None:
        """Cursor position in window coordinates, or None when it is not over us.

        Coordinates are translated to window-relative the same way a mouse message
        would deliver them, so a hit test against the bubble rectangles works
        identically whether the click arrived as a message or was polled.
        """
        point = POINT()
        if not user32.GetCursorPos(ctypes.byref(point)):
            return None
        left, top, width, height = self.geometry()
        x = point.x - left
        y = point.y - top
        if 0 <= x < width and 0 <= y < height:
            return x, y
        return None

    def left_button_down(self) -> bool:
        """Whether the left mouse button is currently held.

        `GetAsyncKeyState` is read from the drawing loop, not from a message. It has
        one well-known caveat: the low bit it also sets means "this key was pressed
        since the last call", which is *not* a state query. Only the high bit is
        tested here, so a press that happened while the overlay was not looking
        cannot be mistaken for one happening now.
        """
        return (user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0

    def close(self) -> None:
        try:
            self._release_surface()
        finally:
            if self.hwnd:
                user32.DestroyWindow(wintypes.HWND(self.hwnd))
                self.hwnd = 0
