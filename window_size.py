"""Fit pywebview logical window sizes to the Windows physical work area."""
from __future__ import annotations

import math
import sys


def fit_window_to_work_area(
    work_area,
    dpi=96,
    preferred=(1280, 720),
    minimum=(900, 560),
    margin=32,
):
    """Return logical pywebview geometry for a physical ``RECT`` work area.

    ``work_area`` is ``(left, top, right, bottom)`` in physical pixels, including
    negative monitor offsets. ``margin`` is physical pixels on each edge;
    preferred/minimum dimensions are logical pixels. The minimum is capped at
    the fitted initial size, so it cannot force the window off a small screen.
    """
    left, top, right, bottom = work_area
    values = (left, top, right, bottom, dpi, margin, *preferred, *minimum)
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in values):
        raise ValueError('Window geometry must contain finite numbers')
    if right <= left or bottom <= top or dpi <= 0 or margin < 0:
        raise ValueError('Work area and DPI must be positive; margin cannot be negative')
    if any(value <= 0 for value in (*preferred, *minimum)):
        raise ValueError('Window dimensions must be positive')

    scale = dpi / 96
    physical_width, physical_height = right - left, bottom - top
    # If an unusually small work area cannot reserve the requested margins,
    # retain at least one logical pixel and keep the window centered.
    available_width = max(1, math.floor((physical_width - margin * 2) / scale))
    available_height = max(1, math.floor((physical_height - margin * 2) / scale))
    width = max(1, min(math.floor(preferred[0]), available_width))
    height = max(1, min(math.floor(preferred[1]), available_height))
    x = round((left + (physical_width - width * scale) / 2) / scale)
    y = round((top + (physical_height - height * scale) / 2) / scale)
    return {
        'width': width,
        'height': height,
        'x': x,
        'y': y,
        'min_size': (min(width, math.floor(minimum[0])), min(height, math.floor(minimum[1]))),
    }


def fit_scene_window_to_work_area(work_area, dpi=96, orient='landscape'):
    """Fit a modest scene window independently of its captured pixel count.

    The ``-1080p`` output modes share window geometry with the corresponding
    720p modes. Integer 16:9/9:16 units keep the fitted content proportional.
    """
    portrait = orient in ('portrait', 'portrait-1080p')
    preferred = (405, 720) if portrait else (960, 540)
    minimum = (270, 480) if portrait else (640, 360)
    ratio = (9, 16) if portrait else (16, 9)
    available = fit_window_to_work_area(work_area, dpi, preferred, minimum)
    units = max(1, min(available['width'] // ratio[0], available['height'] // ratio[1]))
    proportional = (ratio[0] * units, ratio[1] * units)
    return fit_window_to_work_area(work_area, dpi, proportional, minimum)


def _read_windows_work_area():
    """Return the primary physical work rectangle and DPI, or ``None``.

    DPI awareness affects this process only. No user display, scaling or other
    system preference is changed. pywebview's WinForms backend also enables
    process DPI awareness before constructing its first native window.
    """
    if sys.platform != 'win32':
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.SetProcessDPIAware.argtypes = []
        user32.SetProcessDPIAware.restype = wintypes.BOOL
        # A false result can simply mean that the executable manifest has
        # already selected DPI awareness; querying metrics is still valid.
        user32.SetProcessDPIAware()
        user32.GetDpiForSystem.argtypes = []
        user32.GetDpiForSystem.restype = wintypes.UINT
        dpi = user32.GetDpiForSystem() or 96
        user32.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, wintypes.LPVOID, wintypes.UINT]
        user32.SystemParametersInfoW.restype = wintypes.BOOL
        work = wintypes.RECT()
        if not user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(work), 0):
            return None
        return (work.left, work.top, work.right, work.bottom), dpi
    except (AttributeError, OSError, ValueError, TypeError):
        return None


def default_window_geometry():
    """Read primary-screen geometry for the main workbench window."""
    work_area = _read_windows_work_area()
    if work_area is not None:
        return fit_window_to_work_area(*work_area)
    return {'width': 1280, 'height': 720, 'min_size': (900, 560)}


def default_scene_window_geometry(orient='landscape'):
    """Read primary-screen geometry for a landscape/portrait scene window."""
    work_area = _read_windows_work_area()
    if work_area is not None:
        return fit_scene_window_to_work_area(*work_area, orient=orient)
    if orient in ('portrait', 'portrait-1080p'):
        return {'width': 405, 'height': 720, 'min_size': (270, 480)}
    return {'width': 960, 'height': 540, 'min_size': (640, 360)}
