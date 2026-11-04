"""Standalone WebView2 printer and isolated live-room login window."""
import argparse
import ctypes
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from functools import partial
from scene_relay import SceneRelay
from window_size import default_window_geometry, default_scene_window_geometry
from window_theme import apply_caption_theme, normalize_window_theme
from scene_window_frame import SceneWindowFrameHook, post_scene_resize
from collector_auth import (AUTH_FILENAME, LOGIN_TIMEOUT, AsyncCookieReader, CollectorController,
                            CollectorError, CookieLoginSession, DouyinAuthStore)
from urllib.parse import urlparse, parse_qs
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from ctypes import wintypes

FROZEN = getattr(sys, 'frozen', False)
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent
ROOT = APP_DIR / 'app' if FROZEN else APP_DIR
_window_state_user32 = None


class _MonitorInfo(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.DWORD), ('rcMonitor', wintypes.RECT),
                ('rcWork', wintypes.RECT), ('dwFlags', wintypes.DWORD)]


class _MinMaxInfo(ctypes.Structure):
    _fields_ = [('ptReserved', wintypes.POINT), ('ptMaxSize', wintypes.POINT),
                ('ptMaxPosition', wintypes.POINT), ('ptMinTrackSize', wintypes.POINT),
                ('ptMaxTrackSize', wintypes.POINT)]


def _monitor_maximize_geometry(monitor, work):
    """WM_GETMINMAXINFO uses physical sizes and monitor-relative positions."""
    return ((work[0] - monitor[0], work[1] - monitor[1]),
            (work[2] - work[0], work[3] - work[1]))


def _native_handle(window):
    native = getattr(window, 'native', None)
    handle = getattr(native, 'Handle', None)
    return int(handle.ToInt64()) if handle is not None else None


def _run_native_window_task(window, action, timeout=2):
    """Marshal scene HWND changes to WinForms without cross-thread painting.

    pywebview bridge/loaded handlers run on Python worker threads. WinForms'
    on_top setter does not marshal itself. BeginInvoke queues the action, and
    Event.wait releases the GIL so the UI thread can enter the Python callback.
    A stalled/closing UI yields a failure instead of hanging the bridge forever.
    """
    native = getattr(window, 'native', None)
    required = getattr(native, 'InvokeRequired', None)
    if native is None or required is None:
        return False
    if not required:
        return bool(action())
    from System import Action
    finished = threading.Event()
    result = {'applied': False}

    def apply_on_ui_thread():
        try:
            result['applied'] = bool(action())
        except Exception:
            result['applied'] = False
        finally:
            finished.set()

    native.BeginInvoke(Action(apply_on_ui_thread))
    # A timeout cannot retract an already queued UI delegate. The bridge reports
    # failure promptly, but the action may still execute if that UI later pumps.
    return result['applied'] if finished.wait(timeout) else False


def _native_window_state(window):
    """Read actual HWND state, including native maximize/restore shortcuts."""
    global _window_state_user32
    if sys.platform != 'win32' or not window:
        return None
    hwnd = _native_handle(window)
    if not hwnd:
        return None
    if _window_state_user32 is None:
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        for name in ('IsZoomed', 'IsIconic'):
            function = getattr(user32, name)
            function.argtypes = [wintypes.HWND]
            function.restype = wintypes.BOOL
        _window_state_user32 = user32
    user32 = _window_state_user32
    return {'maximized': bool(user32.IsZoomed(hwnd)), 'minimized': bool(user32.IsIconic(hwnd))}


class _WorkAreaMaximizeHook:
    """Constrain this HWND's native maximize to its current monitor work area.

    A frameless WinForms form otherwise maximizes over the taskbar. A per-window
    subclass preserves native restore bounds and Windows shortcuts, unlike a
    simulated maximize implemented by resizing a normal window. Install/remove
    on the form's UI thread; no process-wide or user settings are changed.
    """
    WM_GETMINMAXINFO = 0x0024
    WM_NCDESTROY = 0x0082
    WORK_AREA_MESSAGES = (0x001A, 0x007E, 0x02E0)  # setting/display/DPI changes

    def __init__(self, hwnd):
        self.hwnd = hwnd
        self._installed = False
        self._user32 = ctypes.WinDLL('user32', use_last_error=True)
        self._comctl32 = ctypes.WinDLL('comctl32', use_last_error=True)
        self._user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
        self._user32.MonitorFromWindow.restype = wintypes.HANDLE
        self._user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_MonitorInfo)]
        self._user32.GetMonitorInfoW.restype = wintypes.BOOL
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

    def _monitor_rectangles(self):
        monitor = self._user32.MonitorFromWindow(self.hwnd, 2)  # MONITOR_DEFAULTTONEAREST
        info = _MonitorInfo()
        info.cbSize = ctypes.sizeof(info)
        if not monitor or not self._user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return None
        rectangle = lambda value: (value.left, value.top, value.right, value.bottom)
        return rectangle(info.rcMonitor), rectangle(info.rcWork)

    def _apply_minmax(self, address):
        rectangles = self._monitor_rectangles()
        if not rectangles:
            return
        position, size = _monitor_maximize_geometry(*rectangles)
        info = ctypes.cast(address, ctypes.POINTER(_MinMaxInfo)).contents
        info.ptMaxPosition.x, info.ptMaxPosition.y = position
        info.ptMaxSize.x, info.ptMaxSize.y = size
        info.ptMaxTrackSize.x, info.ptMaxTrackSize.y = size
        # A minimum computed for a larger monitor must not force this window
        # past the work area after moving to a smaller secondary display.
        info.ptMinTrackSize.x = min(info.ptMinTrackSize.x, size[0])
        info.ptMinTrackSize.y = min(info.ptMinTrackSize.y, size[1])

    def _refit_maximized(self):
        if not self._user32.IsZoomed(self.hwnd) or self._user32.IsIconic(self.hwnd):
            return
        rectangles = self._monitor_rectangles()
        if rectangles:
            _, work = rectangles
            self._user32.SetWindowPos(self.hwnd, None, work[0], work[1],
                                      work[2] - work[0], work[3] - work[1],
                                      0x0004 | 0x0010)  # NOZORDER | NOACTIVATE

    def _window_proc(self, hwnd, message, wparam, lparam, subclass_id, reference):
        if message == self.WM_NCDESTROY:
            self._comctl32.RemoveWindowSubclass(hwnd, self._callback, self._subclass_id)
            self._installed = False
        result = self._comctl32.DefSubclassProc(hwnd, message, wparam, lparam)
        try:
            if message == self.WM_GETMINMAXINFO and lparam:
                self._apply_minmax(lparam)
            elif message in self.WORK_AREA_MESSAGES:
                self._refit_maximized()
        except Exception:
            # Exceptions must not escape a native callback into the window loop.
            pass
        return result


def app_command(*args):
    """Reopen this executable when frozen, or the Python entry point in source mode."""
    command = [sys.executable] if FROZEN else [sys.executable, str(ROOT / 'launch.py')]
    return command + list(args)


def node_executable():
    bundled = APP_DIR / 'runtime' / 'node.exe'
    return str(bundled) if bundled.is_file() else shutil.which('node')

def room_id(raw):
    match = re.fullmatch(r'(?:https?://live\.douyin\.com/)?(\d{5,25})(?:[/?#].*)?', str(raw).strip())
    if not match:
        raise ValueError('请输入有效的直播间号或直播链接')
    return match[1]

def listening(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1', port)) == 0

_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def local_get(url, timeout_s=1.5):
    # 本机健康检查必须直连：系统代理（Clash 等）会拦截 127.0.0.1 请求。
    return _LOCAL_OPENER.open(url, timeout=timeout_s)

def bridge_status(expected_pid=None):
    for port in range(8765, 8775):
        try:
            with local_get(f'http://127.0.0.1:{port}/health', 1.5) as response:
                data = json.load(response)
            if (data.get('service') == 'avatar-printer'
                    and os.path.normcase(data.get('identity', '')) == os.path.normcase(str(ROOT))
                    and data.get('collector') == 'lightweight'
                    and (expected_pid is None or data.get('pid') == expected_pid)):
                return dict(ok=True, port=port, url=f'ws://127.0.0.1:{port}',
                            collector='lightweight', pid=data.get('pid'),
                            collectorStatus=data.get('collectorStatus'), authenticated=data.get('authenticated') is True)
        except Exception:
            pass
    return dict(ok=False)


def wait_bridge(process):
    for _ in range(30):
        if process.poll() is not None:
            raise RuntimeError('数据桥启动失败，请查看 desktop-bridge.log')
        status = bridge_status(expected_pid=process.pid)
        if status['ok']:
            return status
        time.sleep(.1)
    raise RuntimeError('数据桥启动超时，请查看 desktop-bridge.log')


ACTIVE_PORT = 8080
_collector_controllers = {}


def get_collector_controller():
    key = os.path.normcase(str(ROOT.resolve()))
    if key not in _collector_controllers:
        def bridge_command(room):
            node = node_executable()
            if not node:
                raise CollectorError('NODE_NOT_FOUND')
            return [node, str(ROOT / 'douyin-bridge.mjs'), room]
        _collector_controllers[key] = CollectorController(ROOT,
            lambda room, request_id: app_command('--live-room', room, '--auth-request', request_id),
            bridge_command, lambda process: wait_bridge(process),
            popen=lambda *args, **kwargs: subprocess.Popen(*args, **kwargs),
            probe_status=lambda pid: bridge_status(expected_pid=pid))
    return _collector_controllers[key]


def ensure_server(controller=None):
    global ACTIVE_PORT
    controller = controller or get_collector_controller()
    # 8080 被代理等程序占用时自动换备用端口（8081/8181/8088）。
    for port in (8080, 8081, 8181, 8088, 8090, 8095, 8282, 8388):
        if not listening(port):
            ACTIVE_PORT = port
            break
        try:
            with local_get(f'http://127.0.0.1:{port}/__app-info', 1) as response:
                info = json.load(response)
                if (info.get('service') == 'avatar-printer-desktop'
                        and os.path.normcase(info.get('root', '')) == os.path.normcase(str(ROOT))
                        and info.get('collector') == 'lightweight' and info.get('pid') == os.getpid()):
                    ACTIVE_PORT = port
                    return f'http://127.0.0.1:{port}/', None
        except Exception:
            pass
    else:
        raise RuntimeError('没有可用的本地端口，请关闭旧程序后重试。')
    relay = SceneRelay()
    class Handler(SimpleHTTPRequestHandler):
        extensions_map = dict(SimpleHTTPRequestHandler.extensions_map,
                              **{'.mjs': 'text/javascript', '.js': 'text/javascript'})

        def end_headers(self):
            # Ctrl+R must load edited local pages and their scripts immediately.
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            super().end_headers()

        # 叠加一个本地控制端点：让浏览器页面也能拉起“独立应用窗口”（无浏览器界面）。
        def _guard(self):
            # 只允许本机页面调用（防其它网站借用本地服务拉进程）。
            if not str(self.headers.get('Host', '')).startswith('127.0.0.1:' + str(ACTIVE_PORT)):
                return False
            return self.headers.get('Sec-Fetch-Site', '') == 'same-origin'

        def _spawn_app(self, url, size=(1280, 720), extra=None):
            exe = None
            for c in (r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
                      r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
                      r'C:\Program Files\Google\Chrome\Application\chrome.exe',
                      r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'):
                if os.path.exists(c):
                    exe = c
                    break
            if not exe:
                return False
            args = [exe, '--app=' + url, '--window-size=%d,%d' % size]
            if extra:
                args += extra
            subprocess.Popen(args)
            return True

        def do_POST(self):
            if self.path != '/__scene-message' or not self._guard():
                return self._json(403, '{"error":"forbidden"}')
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 1024 * 1024:
                    raise ValueError('bad length')
                body = json.loads(self.rfile.read(length))
                relay.publish(body['client'], body['message'])
                return self._json(200, '{"ok":true}')
            except (ValueError, KeyError, TypeError, RecursionError):
                return self._json(400, '{"error":"invalid message"}')

        def do_GET(self):
            if self.path == '/__app-info':
                return self._json(200, json.dumps(dict(service='avatar-printer-desktop', root=str(ROOT),
                    port=ACTIVE_PORT, collector='lightweight', pid=os.getpid())))
            if self.path == '/__bridge-status':
                if not self._guard():
                    return self._json(403, '{"ok":false}')
                status = controller.bridge_status()
                return self._json(200, json.dumps(status if status.get('ok') else bridge_status()))
            if self.path == '/__collector-auth-status':
                if not self._guard():
                    return self._json(403, '{"ok":false}')
                return self._json(200, json.dumps(controller.auth_status()))
            if self.path.startswith('/__scene-events?'):
                if not self._guard():
                    return self._json(403, '{"error":"forbidden"}')
                try:
                    query = parse_qs(urlparse(self.path).query)
                    client = query['client'][0]
                    after = int(query['after'][0]) if 'after' in query else None
                    return self._json(200, json.dumps(relay.poll(client, after)))
                except (ValueError, KeyError):
                    return self._json(400, '{"error":"invalid cursor"}')
            if self.path.startswith('/__open-live'):
                if not self._guard():
                    return self._json(403, '{"ok":false,"error":"forbidden"}')
                q = parse_qs(urlparse(self.path).query)
                room = ''.join(ch for ch in (q.get('room') or [''])[0] if ch.isdigit())[-25:]
                if not re.fullmatch(r'\d{5,25}', room):
                    return self._json(400, '{"ok":false,"error":"bad room"}')
                try:
                    message = controller.open_login(room)
                    return self._json(200, json.dumps(dict(ok=True, message=message)))
                except CollectorError as error:
                    return self._json(400, json.dumps(dict(ok=False, error=str(error), errorCode=error.code)))
            if self.path.startswith('/__start-bridge'):
                if not self._guard():
                    return self._json(403, '{"ok":false,"error":"forbidden"}')
                q = parse_qs(urlparse(self.path).query)
                room = ''.join(ch for ch in (q.get('room') or [''])[0] if ch.isdigit())[-25:]
                if not re.fullmatch(r'\d{5,25}', room):
                    try:
                        room = ''.join(ch for ch in (ROOT / '.bridge-room').read_text(encoding='utf-8') if ch.isdigit())[-25:]
                    except Exception:
                        room = ''
                if not re.fullmatch(r'\d{5,25}', room):
                    return self._json(400, '{"ok":false,"error":"no room"}')
                try:
                    return self._json(200, json.dumps(controller.start_capture(room)))
                except CollectorError as error:
                    return self._json(400, json.dumps(dict(ok=False, error=str(error), errorCode=error.code)))
            if self.path.startswith('/__stop-bridge'):
                if not self._guard():
                    return self._json(403, '{"ok":false,"error":"forbidden"}')
                return self._json(200, json.dumps(dict(ok=True, message=controller.stop_capture())))
            if self.path.startswith('/__open-scene'):
                if not self._guard():
                    return self._json(403, '{"ok":false,"error":"forbidden"}')
                q = parse_qs(urlparse(self.path).query)
                spath = (q.get('path') or [''])[0]
                orient = (q.get('orient') or ['landscape'])[0]
                sizes = {'landscape': (1280, 720), 'landscape-1080p': (1920, 1080),
                         'portrait': (720, 1280), 'portrait-1080p': (1080, 1920)}
                w, h = sizes.get(orient, (1280, 720))
                size = f'{w},{h}'
                if not re.fullmatch(r'/[A-Za-z0-9_\-]+\.html\?scene=1', spath):
                    return self._json(400, '{"ok":false,"error":"bad path"}')
                exe = None
                for c in (r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
                          r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
                          r'C:\Program Files\Google\Chrome\Application\chrome.exe',
                          r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'):
                    if os.path.exists(c):
                        exe = c
                        break
                if not exe:
                    return self._json(500, '{"ok":false,"error":"no browser found"}')
                subprocess.Popen([exe, '--app=http://127.0.0.1:' + str(ACTIVE_PORT) + spath, '--window-size=' + size])
                return self._json(200, '{"ok":true}')
            # Ignore validators from versions cached before no-store was enabled.
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
            return super().do_GET()

        def _json(self, code, body):
            data = body.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', ACTIVE_PORT), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{ACTIVE_PORT}/', server

class DesktopApi:
    def __init__(self, controller=None):
        self._collector = controller
        self._room = None
        self._scene_windows = []
        self._scene_frame_hooks = {}
        self._scene_process = None
        self._scene_orientation = None
        self._scene_theme = 'dark'
        self._scene_on_top = True
        self._lock = threading.RLock()
        self._restart_requested = False
        self._main_window = None
        self._main_maximized = False
        self._main_maximize_hook = None

    def _bind_main_window(self, window):
        self._main_window = window
        window.events.before_show += self._install_main_window_behavior
        window.events.maximized += lambda: self._set_main_maximized(True)
        window.events.restored += lambda: self._set_main_maximized(False)
        window.events.minimized += self._publish_main_window_state
        window.events.loaded += self._publish_main_window_state

    def _bind_scene_window(self, window, theme='dark'):
        """Keep the native caption while removing scene client-side gutters."""
        self._scene_theme = normalize_window_theme(theme)
        if window in self._scene_windows:
            return
        self._scene_windows.append(window)

        def synchronize_caption():
            self._install_scene_window_frame(window)
            self._apply_scene_window_theme(window)

        # before_show runs synchronously on the WinForms window thread; loaded
        # repeats the preference after the webview/JS bridge is initialized.
        window.events.before_show += synchronize_caption
        window.events.loaded += synchronize_caption

    def _install_scene_window_frame(self, window):
        if sys.platform != 'win32' or window is self._main_window or window not in self._scene_windows:
            return False
        def install():
            hwnd = _native_handle(window)
            if not hwnd:
                return False
            hook = self._scene_frame_hooks.get(hwnd)
            if hook is None or not hook.installed:
                hook = SceneWindowFrameHook(hwnd)
                # Retain before refresh: FRAMECHANGED can reenter the callback,
                # and a failed refresh must not collect an installed callback.
                self._scene_frame_hooks[hwnd] = hook
            return hook.refresh()
        try:
            return _run_native_window_task(window, install)
        except Exception:
            # Unsupported/closing windows retain their original native frame.
            return False

    def _apply_scene_window_theme(self, window):
        try:
            return _run_native_window_task(window,
                lambda: apply_caption_theme(_native_handle(window), self._scene_theme))
        except Exception:
            return False

    def set_window_theme(self, theme):
        self._scene_theme = normalize_window_theme(theme)
        applied = False
        for window in list(self._scene_windows):
            applied = self._apply_scene_window_theme(window) or applied
        return {'theme': self._scene_theme, 'applied': applied}

    def set_scene_topmost(self, enabled):
        if type(enabled) is not bool:
            raise ValueError('Scene pin setting must be a boolean')
        self._scene_on_top = enabled
        applied = False
        for window in list(self._scene_windows):
            try:
                def apply_pin(window=window):
                    native = getattr(window, 'native', None)
                    current = getattr(native, 'TopMost', getattr(window, 'on_top', None))
                    if current == enabled and getattr(window, 'on_top', None) == enabled:
                        return True
                    window.on_top = enabled
                    return True
                applied = _run_native_window_task(window, apply_pin) or applied
            except Exception:
                # Closing/unsupported native windows must not affect the
                # renderer or change the main frameless window's z-order.
                pass
        return {'onTop': enabled, 'applied': applied}

    def resize_scene_window(self, edge):
        """Hand a scene-only edge gesture to Windows' native sizing loop."""
        if type(edge) is not str or edge not in ('left', 'right'):
            raise ValueError('Scene resize edge must be left or right')
        applied = False
        for window in list(self._scene_windows):
            if window is self._main_window:
                continue
            try:
                applied = _run_native_window_task(window,
                    lambda window=window: post_scene_resize(_native_handle(window), edge))
            except Exception:
                applied = False
            if applied:
                break
        return {'edge': edge, 'applied': applied, 'queued': applied}

    def _install_main_window_behavior(self):
        if sys.platform != 'win32' or self._main_maximize_hook:
            return
        try:
            hwnd = _native_handle(self._main_window)
            if hwnd:
                # before_show is synchronous on WinForms' UI thread.
                self._main_maximize_hook = _WorkAreaMaximizeHook(hwnd)
        except (AttributeError, OSError, TypeError, ValueError) as error:
            print('Could not install window work-area constraints: ' + str(error), flush=True)

    def _set_main_maximized(self, value):
        self._main_maximized = value
        self._publish_main_window_state()

    def window_state(self):
        try:
            state = _native_window_state(self._main_window)
        except (AttributeError, OSError, TypeError, ValueError):
            state = None
        return state or {'maximized': self._main_maximized, 'minimized': False}

    def _publish_main_window_state(self):
        window = self._main_window
        if not window or not window.events.loaded.is_set():
            return
        try:
            state = self.window_state()
            window.evaluate_js("window.dispatchEvent(new CustomEvent('workspace-window-state', {detail: "
                               + json.dumps(state) + '}));')
        except Exception:
            # The browser may already be shutting down when native events fire.
            pass

    def window_minimize(self):
        if self._main_window:
            self._main_window.minimize()
        return True

    def window_toggle_maximize(self):
        with self._lock:
            if self._main_window:
                maximized = not self.window_state()['maximized']
                if maximized:
                    self._main_window.maximize()
                else:
                    self._main_window.restore()
                self._main_maximized = maximized
            state = self.window_state()
        self._publish_main_window_state()
        return state['maximized']

    def window_close(self):
        if self._main_window:
            # Give the bridge reply time to complete before destroying its host.
            threading.Timer(.1, self._main_window.destroy).start()
        return True

    def restart_program(self):
        with self._lock:
            if self._restart_requested:
                return '正在重启…'
            self._restart_requested = True
        def shutdown():
            import webview
            for win in list(webview.windows)[::-1]:
                win.destroy()
        threading.Timer(0.5, shutdown).start()
        return '正在完整重启程序…'

    def get_capture_compatibility(self):
        return (ROOT / '.capture-compat').exists()

    def set_capture_compatibility(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError('无效的兼容模式设置')
        config = ROOT / '.capture-compat'
        if enabled:
            config.write_text('software-rendering', encoding='utf-8')
        else:
            config.unlink(missing_ok=True)
        return self.restart_program()

    def save_rules_png(self, data_url):
        import base64
        import webview
        if not isinstance(data_url, str) or not data_url.startswith('data:image/png;base64,') or len(data_url) > 20000000:
            raise ValueError('无效的 PNG 图片')
        data = base64.b64decode(data_url.split(',', 1)[1], validate=True)
        if not data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('无效的 PNG 图片')
        result = webview.windows[0].create_file_dialog(webview.FileDialog.SAVE,
            save_filename='直播打印规则.png', file_types=('PNG 图片 (*.png)',))
        if not result:
            return '已取消保存。'
        path = Path(result[0] if isinstance(result, (tuple, list)) else result)
        if path.suffix.lower() != '.png':
            path = path.with_suffix('.png')
        path.write_bytes(data)
        return '已保存 PNG：' + str(path)

    def open_scene_window(self, path=None, orient='landscape', theme='dark', options=None):
        if orient not in {'landscape','landscape-1080p','portrait','portrait-1080p'}:
            orient = 'landscape'
        theme = normalize_window_theme(theme)
        on_top = options.get('onTop', True) if isinstance(options, dict) else True
        if type(on_top) is not bool:
            raise ValueError('Scene pin setting must be a boolean')

        # A separate process prevents process-based capture from selecting the
        # control panel instead of the output window.
        if self._scene_process and self._scene_process.poll() is None:
            return '直播小窗已在独立进程运行，请从任务栏切换到直播小窗。'
        self._scene_process = subprocess.Popen(
            app_command('--scene-view', '--scene-orient', orient,
                        '--scene-theme', theme,
                        '--scene-on-top', 'true' if on_top else 'false',
                        '--server-port', str(ACTIVE_PORT)), cwd=ROOT)
        return '已打开独立进程直播小窗，请重新选择捕获窗口。'


    def resize_scene(self, w, h):
        # Video output pixels must not become DPI-scaled native window pixels.
        try:
            w, h = max(200, min(int(w), 4096)), max(200, min(int(h), 4096))
        except Exception:
            return 'bad size'
        orient = 'portrait' if h > w else 'landscape'
        if orient == self._scene_orientation:
            return 'ok'
        geometry = default_scene_window_geometry(orient)
        for win in list(self._scene_windows):
            try:
                if not getattr(win, 'closed', False):
                    win.resize(geometry['width'], geometry['height'])
                    if 'x' in geometry and 'y' in geometry:
                        win.move(geometry['x'], geometry['y'])
            except Exception:
                pass
        self._scene_orientation = orient
        return 'ok'

    def open_live_room(self, raw):
        with self._lock:
            room = room_id(raw)
            self._room = room
            return self._collector_controller().open_login(room)

    def start_capture(self, raw):
        with self._lock:
            room = room_id(raw)
            self._room = room
            status = self._collector_controller().start_capture(room)
            return f'轻量采集服务已启动，端口 {status["port"]}，正在连接直播间。'

    def stop_capture(self, raw=None):
        return self._collector_controller().stop_capture()

    def _collector_controller(self):
        if self._collector is None:
            self._collector = get_collector_controller()
        return self._collector

    def get_collector_auth_status(self):
        return self._collector_controller().auth_status()

    def close(self):
        try:
            if self._scene_process and self._scene_process.poll() is None:
                self._scene_process.terminate()
                try:
                    self._scene_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._scene_process.kill()
                    self._scene_process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            # A slow/closing scene child must not leave a credential-bearing
            # bridge or login process behind when the main application exits.
            if self._collector is not None:
                self._collector.close()


def run_collector_login(room, request_id):
    """Short-lived login UI; the lightweight collector never uses its CDP."""
    import webview
    webview.settings['REMOTE_DEBUGGING_PORT'] = None
    flags = os.environ.get('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '')
    os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = re.sub(
        r'--remote-debugging-(?:port|address)(?:=\S+|\s+\S+)', '', flags)
    window = webview.create_window('抖音登录 · 登录成功后自动关闭',
        'https://live.douyin.com/' + room, width=1180, height=800)

    def dispatch(action):
        def execute():
            action()
            return True
        try:
            return _run_native_window_task(window, execute)
        except Exception:
            return False

    def manager():
        # Both task initiation and native cookie property access happen on UI.
        return window.native.browser.webview.CoreWebView2.CookieManager

    def action(callback):
        # pythonnet/System is initialized by webview.start, not import webview.
        from System import Action
        return Action(callback)

    reader = AsyncCookieReader(manager, dispatch, action)
    session = CookieLoginSession(DouyinAuthStore(ROOT / AUTH_FILENAME), request_id,
        reader, lambda: dispatch(lambda: window.native.Close()))
    window.events.loaded += session.start
    window.events.closing += session.cancel
    try:
        webview.start(gui='edgechromium', private_mode=False,
            storage_path=str(ROOT / '.live-webview-profile'))
    finally:
        session.cancel()
    return session.exit_code


def _start_requested_collector(api, room, capture):
    if not capture:
        return api.open_live_room(room)
    status = api.get_collector_auth_status()
    if not status['loggedIn']:
        api.open_live_room(room)
        for _ in range(LOGIN_TIMEOUT + 15):
            status = api.get_collector_auth_status()
            if not status['loginInProgress']:
                if not status['loggedIn']:
                    raise CollectorError(status.get('errorCode') or 'LOGIN_CANCELLED')
                break
            threading.Event().wait(1)
        else:
            raise CollectorError('LOGIN_TIMEOUT')
    return api.start_capture(room)


def main():
    # Keep the rendering window active when the detached view is in front.
    browser_flags = os.environ.get('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '')
    os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = browser_flags + (
        ' --disable-backgrounding-occluded-windows --disable-renderer-backgrounding'
        ' --disable-background-timer-throttling'
    )
    if (ROOT / '.capture-compat').exists():
        os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] += (
            ' --disable-gpu --disable-accelerated-video-decode'
        )
    parser = argparse.ArgumentParser()
    parser.add_argument('--live-room')
    parser.add_argument('--auth-request')
    parser.add_argument('--server-only', action='store_true')
    parser.add_argument('--room')
    parser.add_argument('--capture', action='store_true')
    parser.add_argument('--scene-view', action='store_true')
    parser.add_argument('--open-scene', action='store_true')
    parser.add_argument('--scene-orient', default='landscape')
    parser.add_argument('--scene-theme', choices=('light', 'dark'), default='dark')
    parser.add_argument('--scene-on-top', choices=('true', 'false'), default='true')
    parser.add_argument('--server-port', type=int, default=8080)
    args = parser.parse_args()
    if args.scene_view:
        import webview
        geometry = default_scene_window_geometry(args.scene_orient)
        # Both directions must remain possible when changing output orientation.
        geometry['min_size'] = (min(270, geometry['width']), min(270, geometry['height']))
        api = DesktopApi()
        api._scene_orientation = 'portrait' if args.scene_orient.startswith('portrait') else 'landscape'
        api._scene_on_top = args.scene_on_top == 'true'
        win = webview.create_window('直播小窗 · Avatar Printer',
            'http://127.0.0.1:' + str(args.server_port) + '/live-view.html?theme=' + args.scene_theme
            + '&onTop=' + ('1' if api._scene_on_top else '0'), js_api=api,
            **geometry, background_color='#000000', resizable=True, on_top=api._scene_on_top)
        api._bind_scene_window(win, args.scene_theme)
        webview.start(gui='edgechromium', private_mode=False,
            storage_path=str(ROOT / '.scene-webview-profile'))
        return
    if args.live_room:
        room = room_id(args.live_room)
        return run_collector_login(room, args.auth_request or os.urandom(16).hex())
    controller = get_collector_controller()
    url, server = ensure_server(controller)
    api = DesktopApi(controller)
    try:
        if args.server_only:
            threading.Event().wait()
        else:
            import webview
            webview.settings['DRAG_REGION_DIRECT_TARGET_ONLY'] = True
            main_window = webview.create_window('头像打印机 · 桌面版', url + '?desktop=1', js_api=api,
                **default_window_geometry(), frameless=True, easy_drag=False,
                background_color='#111316')
            api._bind_main_window(main_window)
            def start_requested_room():
                if args.open_scene:
                    try:
                        print(api.open_scene_window(None, args.scene_orient, args.scene_theme,
                                                   {'onTop': args.scene_on_top == 'true'}), flush=True)
                    except Exception as exc:
                        print('Could not reopen scene window: ' + str(exc), flush=True)
                if not args.room:
                    return
                try:
                    print(_start_requested_collector(api, args.room, args.capture), flush=True)
                except Exception as exc:
                    print(str(exc), flush=True)
            webview.start(start_requested_room, gui='edgechromium', private_mode=False, storage_path=str(ROOT / '.printer-webview-profile'))
    except KeyboardInterrupt:
        pass
    finally:
        api.close()
        if server:
            server.shutdown()
            server.server_close()
        if api._restart_requested:
            restart_args = app_command()
            if api._room:
                restart_args += ['--room', api._room]
            env = os.environ.copy()
            if FROZEN:
                env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
            subprocess.Popen(restart_args, cwd=ROOT, env=env)

if __name__ == '__main__':
    # Windowed executables have no console streams; keep dependency errors in a log.
    if FROZEN:
        if sys.stdout is None:
            sys.stdout = open(ROOT / 'desktop-launch.log', 'a', encoding='utf-8', buffering=1)
        if sys.stderr is None:
            sys.stderr = sys.stdout
        if sys.stdin is None:
            sys.stdin = open(os.devnull)
    raise SystemExit(main())
