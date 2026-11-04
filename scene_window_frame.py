"""Extend only a scene window's client sides, retaining its native caption."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import sys


class NCCalcSizeParams(ctypes.Structure):
    _fields_ = [('rgrc', wintypes.RECT * 3), ('lppos', ctypes.c_void_p)]


def expand_client_horizontally(outer, client):
    """Keep the default caption/bottom geometry, including DPI and screen offsets."""
    left, top, right, bottom = outer
    client_left, client_top, client_right, client_bottom = client
    if not (left < right and top < bottom and
            left <= client_left < client_right <= right and
            top <= client_top < client_bottom <= bottom):
        return None
    return left, client_top, right, client_bottom


def _load_resize_api():
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    kernel32.GetCurrentThreadId.argtypes = []
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    for name in ('IsZoomed', 'IsIconic'):
        function = getattr(user32, name)
        function.argtypes = [wintypes.HWND]
        function.restype = wintypes.BOOL
    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
    user32.GetAsyncKeyState.restype = wintypes.SHORT
    user32.ReleaseCapture.argtypes = []
    user32.ReleaseCapture.restype = wintypes.BOOL
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.PostMessageW.restype = wintypes.BOOL
    return user32, kernel32


def post_scene_resize(hwnd, edge):
    """Queue native side resizing after a WebView edge pointer-down gesture.

    Must execute on the scene form's owner thread. Posting, rather than sending,
    returns before Windows enters its modal sizing loop. The result reports
    queue acceptance, not completion of a resize. No cross-thread fallback.
    """
    if type(edge) is not str or edge not in ('left', 'right'):
        raise ValueError('Scene resize edge must be left or right')
    if sys.platform != 'win32' or not hwnd:
        return False
    user32, kernel32 = _load_resize_api()
    owner = user32.GetWindowThreadProcessId(hwnd, None)
    if not owner or owner != kernel32.GetCurrentThreadId():
        return False
    if user32.IsZoomed(hwnd) or user32.IsIconic(hwnd):
        return False
    # Bridge delivery can trail a quick click. Do not start a modal sizing
    # gesture after its physical left button has already been released.
    if not user32.GetAsyncKeyState(0x01) & 0x8000:  # VK_LBUTTON, current down bit
        return False
    point = wintypes.POINT()
    if not user32.GetCursorPos(ctypes.byref(point)):
        return False
    position = (point.x & 0xFFFF) | ((point.y & 0xFFFF) << 16)
    # ReleaseCapture may return false when there was no capture; posting still
    # works in that normal case. Never SendMessage into the modal sizing loop.
    user32.ReleaseCapture()
    return bool(user32.PostMessageW(hwnd, 0x00A1, 10 if edge == 'left' else 11, position))


class SceneWindowFrameHook:
    """Per-HWND subclass; construct and refresh exclusively on the owner thread.

    The owner must retain this instance until WM_NCDESTROY, because Windows does
    not keep a Python reference to the ctypes callback. No window style, global
    setting, caption paint or synchronous cross-thread invocation is changed.
    """
    WM_NCCALCSIZE = 0x0083
    WM_NCHITTEST = 0x0084
    WM_NCDESTROY = 0x0082
    HTCLIENT, HTLEFT, HTRIGHT = 1, 10, 11
    FRAME_FLAGS = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020 | 0x0200 | 0x2000

    def __init__(self, hwnd):
        if sys.platform != 'win32' or not hwnd:
            raise OSError('A valid Windows scene HWND is required')
        self.hwnd = hwnd
        self._installed = False
        self._refreshed = False
        self._edge_widths = (0, 0)
        self._user32 = ctypes.WinDLL('user32', use_last_error=True)
        self._kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        self._comctl32 = ctypes.WinDLL('comctl32', use_last_error=True)
        self._user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self._user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        self._kernel32.GetCurrentThreadId.argtypes = []
        self._kernel32.GetCurrentThreadId.restype = wintypes.DWORD
        self._assert_owner_thread()
        self._user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self._user32.GetWindowRect.restype = wintypes.BOOL
        self._user32.IsZoomed.argtypes = [wintypes.HWND]
        self._user32.IsZoomed.restype = wintypes.BOOL
        self._user32.IsIconic.argtypes = [wintypes.HWND]
        self._user32.IsIconic.restype = wintypes.BOOL
        self._user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                            ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        self._user32.SetWindowPos.restype = wintypes.BOOL
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT,
                                          wintypes.WPARAM, wintypes.LPARAM, ctypes.c_size_t, ctypes.c_size_t)
        self._callback = callback_type(self._window_proc)
        self._subclass_id = id(self)
        self._comctl32.SetWindowSubclass.argtypes = [wintypes.HWND, callback_type, ctypes.c_size_t, ctypes.c_size_t]
        self._comctl32.SetWindowSubclass.restype = wintypes.BOOL
        self._comctl32.RemoveWindowSubclass.argtypes = [wintypes.HWND, callback_type, ctypes.c_size_t]
        self._comctl32.RemoveWindowSubclass.restype = wintypes.BOOL
        self._comctl32.DefSubclassProc.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        self._comctl32.DefSubclassProc.restype = ctypes.c_ssize_t
        if not self._comctl32.SetWindowSubclass(hwnd, self._callback, self._subclass_id, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        self._installed = True

    @property
    def installed(self):
        return self._installed

    def _assert_owner_thread(self):
        owner = self._user32.GetWindowThreadProcessId(self.hwnd, None)
        if not owner or owner != self._kernel32.GetCurrentThreadId():
            raise RuntimeError('Scene frame subclass requires its window owner thread')

    def refresh(self):
        if not self._installed:
            return False
        self._assert_owner_thread()
        if not self._refreshed:
            # Recalculate the frame without moving, resizing, activating or
            # changing pin state. DEFERERASE avoids forcing WM_SYNCPAINT.
            self._refreshed = bool(self._user32.SetWindowPos(self.hwnd, None, 0, 0, 0, 0, self.FRAME_FLAGS))
        return self._refreshed

    @staticmethod
    def _client_rectangle(wparam, lparam):
        if wparam:
            return ctypes.cast(lparam, ctypes.POINTER(NCCalcSizeParams)).contents.rgrc[0]
        return ctypes.cast(lparam, ctypes.POINTER(wintypes.RECT)).contents

    def _resize_hit(self, lparam):
        if self._user32.IsZoomed(self.hwnd) or self._user32.IsIconic(self.hwnd):
            return self.HTCLIENT
        rect = wintypes.RECT()
        if not self._user32.GetWindowRect(self.hwnd, ctypes.byref(rect)):
            return self.HTCLIENT
        x, y = ctypes.c_int16(lparam & 0xFFFF).value, ctypes.c_int16((lparam >> 16) & 0xFFFF).value
        if rect.top <= y < rect.bottom:
            left, right = self._edge_widths
            if rect.left <= x < rect.left + left:
                return self.HTLEFT
            if rect.right - right <= x < rect.right:
                return self.HTRIGHT
        return self.HTCLIENT

    def _window_proc(self, hwnd, message, wparam, lparam, subclass_id, reference):
        outer = None
        if hwnd == self.hwnd:
            try:
                if message == self.WM_NCCALCSIZE and lparam:
                    rect = self._client_rectangle(wparam, lparam)
                    outer = (rect.left, rect.top, rect.right, rect.bottom)
                elif message == self.WM_NCDESTROY:
                    try:
                        self._comctl32.RemoveWindowSubclass(hwnd, self._callback, self._subclass_id)
                    finally:
                        self._installed = False
            except Exception:
                # A native callback must never unwind into the window loop.
                pass
        try:
            result = self._comctl32.DefSubclassProc(hwnd, message, wparam, lparam)
        except Exception:
            return 0
        try:
            if hwnd == self.hwnd and outer is not None:
                rect = self._client_rectangle(wparam, lparam)
                client = (rect.left, rect.top, rect.right, rect.bottom)
                expanded = expand_client_horizontally(outer, client)
                if expanded is not None:
                    insets = (client[0] - outer[0], outer[2] - client[2])
                    # Some later calculations already report expanded sides.
                    # Keep the last nonzero native inset for parent fallback.
                    self._edge_widths = tuple(new if new > 0 else old
                                             for new, old in zip(insets, self._edge_widths))
                    rect.left, rect.right = expanded[0], expanded[2]
                    # DefSubclassProc's WVR_VALIDRECTS describe the narrower
                    # client area; retain the default caption, return normal
                    # top-left preservation for the updated client rectangle.
                    return 0
            elif hwnd == self.hwnd and message == self.WM_NCHITTEST and result == self.HTCLIENT:
                # Only recover resize hits in the newly expanded client strips.
                # Native caption buttons, dragging, corners and bottom keep
                # their original hit-test result.
                return self._resize_hit(lparam)
        except Exception:
            pass
        return result
