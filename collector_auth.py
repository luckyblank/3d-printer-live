"""App-local Douyin authentication and lightweight collector lifecycle.

No API in this module returns credentials. The login profile belongs to this
application; cookies are filtered before values are copied out of WebView2.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid


AUTH_FILENAME = '.collector-auth.bin'
AUTH_MAGIC = b'AvatarPrinterAuth1\0'
MAX_AUTH_BYTES = 128 * 1024
LOGIN_TIMEOUT = 300
AUTH_MESSAGES = {
    'LOGIN_REQUIRED': '请先打开抖音登录窗口完成登录，再开始抓取。',
    'LOGIN_CANCELLED': '登录窗口已关闭，未更新登录态。',
    'LOGIN_TIMEOUT': '登录等待超时，请重新打开登录窗口。',
    'LOGIN_START_FAILED': '无法打开登录窗口，请重试。',
    'AUTH_STORAGE_UNAVAILABLE': '无法读取或保存本机登录态，请重新登录。',
    'BRIDGE_START_FAILED': '轻量采集启动失败，请查看采集状态后重试。',
    'NODE_NOT_FOUND': '未找到采集运行环境，请检查桌面包是否完整。',
    'APP_CLOSED': '程序正在退出，操作已取消。',
}


class CollectorError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(AUTH_MESSAGES.get(code, '采集操作失败，请重试。'))


class _DataBlob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(data, decrypt=False):
    if sys.platform != 'win32':
        raise CollectorError('AUTH_STORAGE_UNAVAILABLE')
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.argtypes = [ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.POINTER(_DataBlob),
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob)]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(data)
    source = _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = _DataBlob()
    # User-scoped DPAPI, no machine-wide flag and no interactive UI.
    if not function(ctypes.byref(source), None, None, None, None, 0x01, ctypes.byref(output)):
        raise CollectorError('AUTH_STORAGE_UNAVAILABLE')
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)


def protect_auth(data):
    return _dpapi(data)


def unprotect_auth(data):
    return _dpapi(data, decrypt=True)


def is_douyin_domain(domain):
    if not isinstance(domain, str):
        return False
    domain = domain.lstrip('.').lower()
    return domain == 'douyin.com' or domain.endswith('.douyin.com')


def cookie_snapshot(cookies):
    """Called on the UI thread; never read values from another domain."""
    result = []
    for cookie in cookies:
        domain = cookie.Domain
        if not is_douyin_domain(domain):
            continue
        expires = None
        if not getattr(cookie, 'IsSession', True):
            try:
                value = cookie.Expires.ToUniversalTime().ToString('o')
                expires = datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
            except (AttributeError, TypeError, ValueError, OverflowError):
                pass
        result.append({'domain': domain, 'name': cookie.Name, 'value': cookie.Value,
                       'path': cookie.Path, 'expiresAt': expires})
    return result


def credential_from_cookies(cookies, now=None):
    now = time.time() if now is None else now
    selected = {}
    for cookie in cookies:
        if not isinstance(cookie, dict) or not is_douyin_domain(cookie.get('domain')):
            continue
        name, value = cookie.get('name'), cookie.get('value')
        if not isinstance(name, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name):
            continue
        if not isinstance(value, str) or not value or any(ord(c) < 32 or ord(c) == 127 or c == ';' for c in value):
            continue
        expiry = cookie.get('expiresAt')
        if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry) or expiry <= now):
            continue
        # Prefer domain-wide credentials when both host and domain cookies have
        # the same name. CookieManager is this app's dedicated profile only.
        rank = (cookie['domain'].lstrip('.').lower() != 'douyin.com', len(str(cookie.get('path') or '/')))
        if name not in selected or rank < selected[name][0]:
            selected[name] = (rank, value, expiry)
    sessions = [item for name, item in selected.items() if name in ('sessionid', 'sessionid_ss')]
    if not sessions:
        return None
    header = '; '.join(f'{name}={item[1]}' for name, item in sorted(selected.items()))
    if len(header) > 32000:
        raise CollectorError('AUTH_STORAGE_UNAVAILABLE')
    expiry = None if any(item[2] is None for item in sessions) else max(item[2] for item in sessions)
    return header, expiry


@dataclass(frozen=True)
class AuthRecord:
    cookie_header: str = field(repr=False)
    updated_at: str
    request_id: str
    expires_at: float | None = None

    def usable(self, now=None):
        return self.expires_at is None or self.expires_at > (time.time() if now is None else now)


class DouyinAuthStore:
    def __init__(self, path, *, protect=protect_auth, unprotect=unprotect_auth, clock=time.time):
        self.path = Path(path)
        self._protect, self._unprotect, self._clock = protect, unprotect, clock

    def load(self):
        try:
            if not self.path.exists():
                return None
            data = self.path.read_bytes()
            if not data.startswith(AUTH_MAGIC) or len(data) > MAX_AUTH_BYTES:
                raise ValueError('Invalid encrypted auth format')
            value = json.loads(self._unprotect(data[len(AUTH_MAGIC):]))
            header, updated, request_id, expiry = (value['cookieHeader'], value['updatedAt'],
                                                    value['requestId'], value.get('expiresAt'))
            if (value.get('version') != 1 or not isinstance(header, str) or len(header) > 32000
                    or any(ord(c) < 32 or ord(c) == 127 for c in header)
                    or not any(part.strip().split('=', 1)[0] in ('sessionid', 'sessionid_ss')
                               and len(part.strip().split('=', 1)) == 2 and part.strip().split('=', 1)[1]
                               for part in header.split(';'))
                    or not isinstance(updated, str) or len(updated) > 64
                    or not isinstance(request_id, str) or len(request_id) > 128
                    or expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry))):
                raise ValueError('Invalid auth record')
            return AuthRecord(header, updated, request_id, expiry)
        except Exception:
            raise CollectorError('AUTH_STORAGE_UNAVAILABLE') from None

    def save(self, cookies, request_id, *, cancelled=lambda: False):
        credential = credential_from_cookies(cookies, self._clock())
        if credential is None or cancelled():
            return None
        header, expiry = credential
        updated = datetime.fromtimestamp(self._clock(), timezone.utc).isoformat()
        record = AuthRecord(header, updated, str(request_id), expiry)
        temporary = self.path.with_name(self.path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            payload = json.dumps({'version': 1, 'cookieHeader': header, 'updatedAt': updated,
                                  'requestId': str(request_id), 'expiresAt': expiry}).encode('utf-8')
            encrypted = AUTH_MAGIC + self._protect(payload)
            if len(encrypted) > MAX_AUTH_BYTES:
                raise ValueError('Encrypted credential exceeds limit')
            if cancelled():
                return None
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_bytes(encrypted)
            if cancelled():
                return None
            os.replace(temporary, self.path)
            return record
        except Exception:
            raise CollectorError('AUTH_STORAGE_UNAVAILABLE') from None
        finally:
            temporary.unlink(missing_ok=True)

    def status(self):
        try:
            record = self.load()
            logged_in = bool(record and record.usable(self._clock()))
            return {'loggedIn': logged_in, 'updatedAt': record.updated_at if record else None,
                    'needsLogin': not logged_in, 'error': None, 'errorCode': None}
        except CollectorError as error:
            return {'loggedIn': False, 'updatedAt': None, 'needsLogin': True,
                    'error': str(error), 'errorCode': error.code}


class AsyncCookieReader:
    """Initiate and parse CookieManager tasks on UI; never wait on a UI Task."""
    def __init__(self, manager_provider, dispatch_ui, action_factory):
        self.manager_provider, self.dispatch_ui, self.action_factory = manager_provider, dispatch_ui, action_factory
        self._pending = {}
        self._closed = False

    def cancel(self):
        self._closed = True
        for context in list(self._pending.values()):
            context['active'] = False

    def request(self, on_cookies, on_error):
        token = object()
        context = {'active': True}
        self._pending[token] = context

        def fail():
            self._pending.pop(token, None)
            active = context['active'] and not self._closed
            context['active'] = False
            if active:
                on_error()

        def parse_completed():
            if self._closed or not context['active']:
                self._pending.pop(token, None)
                return
            try:
                # GetResult is reached only after completion; no .Result/Wait.
                if not context['task'].IsCompleted:
                    fail()
                    return
                values = context['awaiter'].GetResult()
                snapshot = cookie_snapshot(values)
            except Exception:
                fail()
                return
            self._pending.pop(token, None)
            context['active'] = False
            on_cookies(snapshot)

        def complete():
            if not self.dispatch_ui(parse_completed):
                fail()

        def begin():
            if self._closed or not context['active']:
                self._pending.pop(token, None)
                return
            try:
                manager = self.manager_provider()
                task = manager.GetCookiesAsync(None)
                context['task'], context['awaiter'] = task, task.GetAwaiter()
                if task.IsCompleted:
                    parse_completed()
                else:
                    context['continuation'] = self.action_factory(complete)
                    context['awaiter'].OnCompleted(context['continuation'])
            except Exception:
                fail()

        if not self.dispatch_ui(begin):
            context['active'] = False
            self._pending.pop(token, None)
            on_error()


class CookieLoginSession:
    def __init__(self, store, request_id, reader, close_ui, *, timeout=LOGIN_TIMEOUT, interval=1):
        self.store, self.request_id, self.reader, self.close_ui = store, request_id, reader, close_ui
        self.timeout, self.interval = timeout, interval
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._started = False
        self._inflight = False
        self._saving = False
        self.exit_code = 2  # User cancellation unless a save/timeout says otherwise.

    def start(self):
        with self._lock:
            if self._started or self._stop.is_set():
                return
            self._started = True
        threading.Thread(target=self._poll, daemon=True).start()

    def cancel(self):
        self._stop.set()
        self.reader.cancel()

    def _poll(self):
        deadline = time.monotonic() + self.timeout
        while not self._stop.is_set():
            if time.monotonic() >= deadline:
                self.exit_code = 3
                self.cancel()
                self.close_ui()
                return
            with self._lock:
                request = not self._inflight and not self._saving
                if request:
                    self._inflight = True
            if request:
                self.reader.request(self._received, self._read_failed)
            self._stop.wait(min(self.interval, max(0, deadline - time.monotonic())))

    def _read_failed(self):
        with self._lock:
            self._inflight = False

    def _received(self, cookies):
        with self._lock:
            self._inflight = False
            if self._stop.is_set() or self._saving:
                return
            if not any(cookie.get('name') in ('sessionid', 'sessionid_ss') and cookie.get('value')
                       for cookie in cookies):
                return
            self._saving = True
        # Native cookie properties were copied on UI; encryption/disk never is.
        threading.Thread(target=self._save, args=(cookies,), daemon=True).start()

    def _save(self, cookies):
        try:
            record = self.store.save(cookies, self.request_id, cancelled=self._stop.is_set)
            if record is not None and not self._stop.is_set():
                self.exit_code = 0
                self.cancel()
                self.close_ui()
        except CollectorError:
            if not self._stop.is_set():
                self.exit_code = 4
                self.cancel()
                self.close_ui()
        finally:
            with self._lock:
                self._saving = False


def _start_background(target):
    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return thread


class CollectorController:
    """The shared desktop/HTTP owner of login and lightweight bridge children."""
    def __init__(self, root, login_command, bridge_command, wait_ready, *, store=None,
                 popen=subprocess.Popen, environment=lambda: os.environ.copy(),
                 launch_thread=_start_background, login_timeout=LOGIN_TIMEOUT, probe_status=None):
        self.root = Path(root)
        self.store = store or DouyinAuthStore(self.root / AUTH_FILENAME)
        self.login_command, self.bridge_command, self.wait_ready = login_command, bridge_command, wait_ready
        self.popen, self.environment, self.launch_thread = popen, environment, launch_thread
        self.login_timeout = login_timeout
        self.probe_status = probe_status
        self._lock = threading.RLock()
        self._login = self._bridge = None
        self._room = None
        self._request_id = None
        self._generation = 0
        self._closed = False
        self._error_code = None
        self._bridge_auth_version = None
        self._ready = None

    @staticmethod
    def _alive(process):
        return process is not None and process.poll() is None

    @staticmethod
    def _terminate(process):
        if not CollectorController._alive(process):
            return
        try:
            process.terminate()
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
        except OSError:
            pass

    def auth_status(self):
        with self._lock:
            status = self.store.status()
            status['loginInProgress'] = not self._closed and self._alive(self._login)
            if self._error_code:
                status.update(errorCode=self._error_code, error=AUTH_MESSAGES[self._error_code])
            return status

    def bridge_status(self):
        with self._lock:
            if not self._alive(self._bridge) or not self._ready:
                return {'ok': False}
            if self.probe_status:
                return self.probe_status(self._bridge.pid)
            return dict(self._ready)

    def open_login(self, room):
        with self._lock:
            if self._closed:
                raise CollectorError('APP_CLOSED')
            if self._alive(self._login):
                return '抖音登录窗口已打开，请完成登录。'
            self._generation += 1
            generation = self._generation
            request_id = uuid.uuid4().hex
            env = self.environment()
            env.pop('PRINTER_DOUYIN_COOKIE', None)
            env.pop('PRINTER_CDP_PORT', None)
            flags = env.get('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '')
            env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = re.sub(r'--remote-debugging-(?:port|address)(?:=\S+|\s+\S+)', '', flags)
            try:
                process = self.popen(self.login_command(room, request_id), cwd=str(self.root), env=env)
            except Exception:
                self._error_code = 'LOGIN_START_FAILED'
                raise CollectorError(self._error_code) from None
            self._login, self._request_id, self._error_code = process, request_id, None
            self.launch_thread(lambda: self._watch_login(process, request_id, generation))
            return '抖音登录窗口已打开，登录成功后会自动保存并关闭。'

    def _watch_login(self, process, request_id, generation):
        try:
            code = process.wait(timeout=self.login_timeout + 15)
        except subprocess.TimeoutExpired:
            self._terminate(process)
            code = 3
        except Exception:
            code = 2
        with self._lock:
            if self._closed or generation != self._generation or self._login is not process:
                return
            self._login = None
            if code in (3, 4):
                self._error_code = 'LOGIN_TIMEOUT' if code == 3 else 'AUTH_STORAGE_UNAVAILABLE'
                return
            try:
                record = self.store.load()
                success = code == 0 and record and record.request_id == request_id and record.usable()
            except CollectorError:
                self._error_code = 'AUTH_STORAGE_UNAVAILABLE'
                return
            if not success:
                self._error_code = 'LOGIN_CANCELLED'
                return
            self._error_code = None
            if (self._alive(self._bridge) and self._room
                    and self._bridge_auth_version != (record.updated_at, record.request_id)):
                # A process environment cannot be changed after launch. Restart
                # only our owned bridge after a successful re-login.
                try:
                    self._start_capture_locked(self._room, record, force=True)
                except CollectorError as error:
                    self._error_code = error.code

    def start_capture(self, room):
        with self._lock:
            if self._closed:
                raise CollectorError('APP_CLOSED')
            record = self.store.load()
            if not record or not record.usable():
                self._error_code = 'LOGIN_REQUIRED'
                raise CollectorError(self._error_code)
            self._error_code = None
            return self._start_capture_locked(room, record)

    def _start_capture_locked(self, room, record, force=False):
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            (self.root / '.bridge-room').write_text(room, encoding='utf-8')
        except OSError:
            raise CollectorError('BRIDGE_START_FAILED') from None
        self._room = room
        version = (record.updated_at, record.request_id)
        if not force and self._alive(self._bridge) and self._bridge_auth_version == version and self._ready:
            status = self.probe_status(self._bridge.pid) if self.probe_status else self._ready
            if status.get('ok') and status.get('collectorStatus') not in ('error', 'offline', 'stopped'):
                self._ready = dict(status)
                return dict(status, already=True)
        self._terminate(self._bridge)
        self._bridge, self._ready = None, None
        env = self.environment()
        env.pop('PRINTER_CDP_PORT', None)
        env['PRINTER_COLLECTOR'] = 'lightweight'
        env['PRINTER_DOUYIN_COOKIE'] = record.cookie_header
        try:
            command = self.bridge_command(room)
            with (self.root / 'desktop-bridge.log').open('ab') as log:
                process = self.popen(command, cwd=str(self.root), env=env, stdout=log, stderr=log,
                                     creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self._bridge = process
            ready = self.wait_ready(process)
            self._ready = dict(ready, ok=True, collector='lightweight', pid=process.pid)
            self._bridge_auth_version = version
            return dict(self._ready)
        except CollectorError:
            self._terminate(self._bridge)
            self._bridge, self._ready = None, None
            raise
        except Exception:
            self._terminate(self._bridge)
            self._bridge, self._ready = None, None
            raise CollectorError('BRIDGE_START_FAILED') from None

    def stop_capture(self):
        with self._lock:
            self._terminate(self._bridge)
            self._bridge, self._ready, self._bridge_auth_version = None, None, None
            return '抓取已停止。'

    def close(self):
        with self._lock:
            self._closed = True
            self._generation += 1
            login, bridge = self._login, self._bridge
            self._login = self._bridge = self._ready = None
        self._terminate(bridge)
        self._terminate(login)
