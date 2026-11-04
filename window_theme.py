"""Apply app-local caption colors to one native Windows scene window."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import sys


def normalize_window_theme(theme):
    return 'light' if theme == 'light' else 'dark'


def _colorref(hex_color):
    red, green, blue = (int(hex_color[index:index + 2], 16) for index in (1, 3, 5))
    return red | green << 8 | blue << 16


# Match assets/workspace.css --ws-panel and --ws-text, not the OS preference.
CAPTION_PALETTES = {
    'dark': (_colorref('#1b1e22'), _colorref('#f1f0ed')),
    'light': (_colorref('#faf9f6'), _colorref('#292b2c')),
}
DWMWA_BORDER_COLOR = 34
DWMWA_COLOR_NONE = 0xFFFFFFFE
_dwm_set_attribute = None


def _load_dwm_set_attribute():
    global _dwm_set_attribute
    if _dwm_set_attribute is None:
        function = ctypes.WinDLL('dwmapi', use_last_error=True).DwmSetWindowAttribute
        function.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        function.restype = ctypes.c_long
        _dwm_set_attribute = function
    return _dwm_set_attribute


def _redraw_caption(hwnd):
    """Invalidate this frame without synchronous WM_PAINT or activation."""
    try:
        redraw = ctypes.WinDLL('user32', use_last_error=True).RedrawWindow
        redraw.argtypes = [wintypes.HWND, ctypes.c_void_p, wintypes.HANDLE, wintypes.UINT]
        redraw.restype = wintypes.BOOL
        redraw(hwnd, None, None, 0x0001 | 0x0400)  # INVALIDATE | FRAME; never UPDATENOW
    except (AttributeError, OSError, TypeError, ValueError):
        pass


def apply_caption_theme(hwnd, theme='dark'):
    """Best-effort DWM theme for one HWND; return whether any attribute applied.

    Windows 11 supports custom caption/text colors and suppressing the visible
    DWM outline without removing the native caption or resizing hit targets.
    Older Windows may only
    accept immersive dark mode, including its legacy attribute 19 fallback.
    Unsupported platforms, old APIs and disappearing windows are non-fatal.
    No registry or global Windows theme setting is read or changed.
    """
    if sys.platform != 'win32' or not hwnd:
        return False
    try:
        function = _load_dwm_set_attribute()
    except (AttributeError, OSError, TypeError, ValueError):
        return False
    theme = normalize_window_theme(theme)

    def set_attribute(attribute, value):
        value = ctypes.c_uint32(value)
        try:
            return function(hwnd, attribute, ctypes.byref(value), ctypes.sizeof(value)) == 0
        except (AttributeError, OSError, TypeError, ValueError):
            return False

    dark = int(theme == 'dark')
    immersive_applied = set_attribute(20, dark) or set_attribute(19, dark)
    border_applied = set_attribute(DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE)
    background, foreground = CAPTION_PALETTES[theme]
    caption_applied = set_attribute(35, background)
    text_applied = set_attribute(36, foreground)
    applied = immersive_applied or border_applied or caption_applied or text_applied
    if applied:
        _redraw_caption(hwnd)
    return applied
