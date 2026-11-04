"""Credential scoping, DPAPI persistence and nonblocking WebView cookie reads."""
import ctypes
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import collector_auth as auth


def cookies(value='unit-session-value', **kwargs):
    return [dict(domain='.douyin.com', name='sessionid', value=value, path='/', expiresAt=None, **kwargs),
            dict(domain='.douyin.com', name='ttwid', value='unit-anonymous-id', path='/', expiresAt=None)]


def cipher(data):
    return bytes(value ^ 0xA5 for value in data)


def store_at(directory, **kwargs):
    return auth.DouyinAuthStore(Path(directory) / auth.AUTH_FILENAME, protect=cipher, unprotect=cipher, **kwargs)


class FakeCookie:
    def __init__(self, domain='.douyin.com', name='sessionid', value='unit-session-value', owner=None):
        self._domain, self._name, self._value = domain, name, value
        self.owner = owner or threading.get_ident()
        self.IsSession, self.Path = True, '/'

    def check_thread(self):
        if threading.get_ident() != self.owner:
            raise AssertionError('Cookie COM property read outside owner UI thread')

    @property
    def Domain(self):
        self.check_thread()
        return self._domain

    @property
    def Name(self):
        self.check_thread()
        return self._name

    @property
    def Value(self):
        self.check_thread()
        if not auth.is_douyin_domain(self._domain):
            raise AssertionError('A non-Douyin cookie value was read')
        return self._value


class FakeTask:
    def __init__(self, values):
        self.IsCompleted = False
        self.values = values
        self.continuation = None
        self.result_reads = 0

    @property
    def Result(self):
        raise AssertionError('Task.Result must not be used')

    def GetAwaiter(self):
        return self

    def OnCompleted(self, continuation):
        self.continuation = continuation

    def GetResult(self):
        if not self.IsCompleted:
            raise AssertionError('GetResult must not block an incomplete task')
        self.result_reads += 1
        return self.values


class UiQueue:
    def __init__(self):
        self.owner = threading.get_ident()
        self.pending = []

    def dispatch(self, callback):
        if threading.get_ident() == self.owner:
            callback()
        else:
            self.pending.append(callback)
        return True

    def pump(self):
        assert threading.get_ident() == self.owner
        while self.pending:
            self.pending.pop(0)()


class CollectorAuthTests(unittest.TestCase):
    def test_domain_filter_and_snapshot_never_read_other_domain_values(self):
        for domain in ('douyin.com', '.douyin.com', 'www.douyin.com', '.live.douyin.com', '.DOUYIN.COM'):
            self.assertTrue(auth.is_douyin_domain(domain))
        for domain in ('notdouyin.com', 'douyin.com.evil.test', 'example.com', None, ''):
            self.assertFalse(auth.is_douyin_domain(domain))
        values = auth.cookie_snapshot([FakeCookie(), FakeCookie(domain='example.com')])
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]['domain'], '.douyin.com')

    def test_credentials_require_session_and_ignore_expired_injected_or_other_domain_cookies(self):
        bad = [dict(domain='example.com', name='sessionid', value='not-authorized', path='/'),
               dict(domain='.douyin.com', name='sessionid', value='expired', path='/', expiresAt=9),
               dict(domain='.douyin.com', name='sessionid', value='bad\r\nheader', path='/'),
               dict(domain='.douyin.com', name='sessionid', value='bad;other=value', path='/')]
        self.assertIsNone(auth.credential_from_cookies(bad, now=10))
        self.assertIsNone(auth.credential_from_cookies(cookies()[1:], now=10))
        valid = dict(domain='.douyin.com', name='sessionid_ss', value='unit-valid-session', path='/', expiresAt=20)
        header, expiry = auth.credential_from_cookies([*bad, valid], now=10)
        self.assertEqual(header, 'sessionid_ss=unit-valid-session')
        self.assertEqual(expiry, 20)

    def test_domain_wide_cookie_wins_duplicate_name_and_session_cookie_has_no_invented_expiry(self):
        values = [dict(domain='www.douyin.com', name='sessionid', value='host-only', path='/'), *cookies()]
        header, expiry = auth.credential_from_cookies(values)
        self.assertIn('sessionid=unit-session-value', header)
        self.assertNotIn('host-only', header)
        self.assertIsNone(expiry)

    def test_store_persists_only_ciphertext_and_status_has_no_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            store = store_at(directory, clock=lambda: 1000)
            record = store.save(cookies(), 'request-1')
            raw = store.path.read_bytes()
            self.assertTrue(raw.startswith(auth.AUTH_MAGIC))
            self.assertNotIn(b'unit-session-value', raw)
            self.assertNotIn('unit-session-value', repr(record))
            self.assertEqual(store.load(), record)
            status = store.status()
            self.assertTrue(status['loggedIn'])
            self.assertFalse(status['needsLogin'])
            self.assertEqual(set(status), {'loggedIn', 'updatedAt', 'needsLogin', 'error', 'errorCode'})
            self.assertNotIn('session', json.dumps(status))

    def test_anonymous_and_cancelled_save_preserve_previous_record(self):
        with tempfile.TemporaryDirectory() as directory:
            store = store_at(directory)
            store.save(cookies('old-valid'), 'old-request')
            original = store.path.read_bytes()
            self.assertIsNone(store.save(cookies()[1:], 'anonymous'))
            self.assertIsNone(store.save(cookies('new-valid'), 'cancelled', cancelled=lambda: True))
            self.assertEqual(store.path.read_bytes(), original)
            cancelled = threading.Event()
            def protect(data):
                cancelled.set()
                return cipher(data)
            store._protect = protect
            self.assertIsNone(store.save(cookies('late-value'), 'late', cancelled=cancelled.is_set))
            self.assertEqual(store.path.read_bytes(), original)
            self.assertEqual(list(Path(directory).glob('*.tmp')), [])

    def test_expired_record_requires_login_and_corrupt_storage_uses_safe_error(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [10]
            store = store_at(directory, clock=lambda: now[0])
            value = cookies()
            value[0]['expiresAt'] = 20
            store.save(value, 'expires')
            now[0] = 21
            self.assertFalse(store.status()['loggedIn'])
            self.assertTrue(store.status()['needsLogin'])
            store.path.write_bytes(auth.AUTH_MAGIC + b'not-a-record')
            status = store.status()
            self.assertEqual(status['errorCode'], 'AUTH_STORAGE_UNAVAILABLE')
            self.assertNotIn('not-a-record', status['error'])
            self.assertFalse(status['loggedIn'])

    @unittest.skipUnless(sys.platform == 'win32', 'Windows DPAPI only')
    def test_real_user_scoped_dpapi_roundtrip_uses_fictional_data_without_ui(self):
        value = b'AvatarPrinter unit test; not user credentials'
        protected = auth.protect_auth(value)
        self.assertNotEqual(protected, value)
        self.assertEqual(auth.unprotect_auth(protected), value)

    def test_non_windows_has_no_plaintext_fallback(self):
        with patch('collector_auth.sys.platform', 'linux'):
            with self.assertRaises(auth.CollectorError):
                auth.protect_auth(b'fictional')

    def test_async_cookie_start_and_com_property_reads_both_run_on_ui_without_result_wait(self):
        ui = UiQueue()
        task = FakeTask([FakeCookie(owner=ui.owner)])
        calls, received, failed = [], [], []
        def get_cookies(uri):
            self.assertEqual(threading.get_ident(), ui.owner)
            calls.append(uri)
            return task
        reader = auth.AsyncCookieReader(lambda: SimpleNamespace(GetCookiesAsync=get_cookies), ui.dispatch, lambda callback: callback)
        worker = threading.Thread(target=lambda: reader.request(received.append, lambda: failed.append(True)))
        worker.start(); worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(calls, [])
        ui.pump()
        self.assertEqual(calls, [None])
        self.assertEqual(received, [])
        self.assertEqual(task.result_reads, 0)
        task.IsCompleted = True
        worker = threading.Thread(target=task.continuation)
        worker.start(); worker.join(1)
        self.assertEqual(received, [])
        ui.pump()
        self.assertEqual(received[0][0]['name'], 'sessionid')
        self.assertEqual(failed, [])
        self.assertEqual(task.result_reads, 1)

    def test_premature_completion_does_not_get_result_and_late_callback_cannot_save(self):
        ui = UiQueue()
        task = FakeTask([FakeCookie()])
        received, failed = [], []
        reader = auth.AsyncCookieReader(lambda: SimpleNamespace(GetCookiesAsync=lambda uri: task), ui.dispatch, lambda callback: callback)
        reader.request(received.append, lambda: failed.append(True))
        task.continuation()
        self.assertEqual(task.result_reads, 0)
        self.assertEqual(failed, [True])
        task.IsCompleted = True
        task.continuation()
        self.assertEqual(received, [])

    @unittest.skipUnless(sys.platform == 'win32', 'Windows desktop pythonnet interop')
    def test_real_managed_task_continuation_is_nonblocking_and_returns_to_owner(self):
        try:
            import clr  # noqa: F401; initializes pythonnet, without creating a UI.
            from System import Action, Array, Object
            from System.Threading.Tasks import TaskCompletionSource
        except ImportError:
            self.skipTest('pythonnet is not installed in this Python environment')
        ui = UiQueue()
        source = TaskCompletionSource[Object]()
        received, failed = [], []
        reader = auth.AsyncCookieReader(
            lambda: SimpleNamespace(GetCookiesAsync=lambda uri: source.Task), ui.dispatch, Action)
        reader.request(received.append, lambda: failed.append(True))
        self.assertFalse(source.Task.IsCompleted)
        self.assertEqual(received, [])
        values = Array[Object]([FakeCookie(owner=ui.owner)])
        worker = threading.Thread(target=lambda: source.SetResult(values))
        worker.start()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        deadline = time.monotonic() + 2
        while not received and not failed and time.monotonic() < deadline:
            ui.pump()
            threading.Event().wait(.005)
        self.assertEqual(failed, [])
        self.assertEqual(received[0][0]['name'], 'sessionid')

    def test_cancelled_cookie_request_does_not_read_values_or_call_receivers(self):
        ui = UiQueue()
        task = FakeTask([FakeCookie()])
        received, failed = [], []
        reader = auth.AsyncCookieReader(lambda: SimpleNamespace(GetCookiesAsync=lambda uri: task), ui.dispatch, lambda callback: callback)
        reader.request(received.append, lambda: failed.append(True))
        reader.cancel()
        task.IsCompleted = True
        task.continuation()
        self.assertEqual(task.result_reads, 0)
        self.assertEqual(received, [])
        self.assertEqual(failed, [])

    def test_login_session_saves_then_closes_and_cancel_timeout_do_not_save(self):
        with tempfile.TemporaryDirectory() as directory:
            store = store_at(directory)
            reader, close = Mock(), Mock()
            session = auth.CookieLoginSession(store, 'success', reader, close)
            session._save(cookies())
            self.assertEqual(store.load().request_id, 'success')
            self.assertEqual(session.exit_code, 0)
            close.assert_called_once_with()
            old = store.path.read_bytes()
            session = auth.CookieLoginSession(store, 'cancel', Mock(), Mock())
            session.cancel()
            session._save(cookies('cancelled-value'))
            self.assertEqual(store.path.read_bytes(), old)
            self.assertEqual(session.exit_code, 2)
            timeout_close = Mock()
            session = auth.CookieLoginSession(store, 'timeout', Mock(), timeout_close, timeout=1)
            with patch('collector_auth.time.monotonic', side_effect=[0, 2]):
                session._poll()
            self.assertEqual(session.exit_code, 3)
            timeout_close.assert_called_once_with()
            self.assertEqual(store.path.read_bytes(), old)

    def test_anonymous_poll_does_not_launch_a_save_thread(self):
        session = auth.CookieLoginSession(Mock(), 'pending', Mock(), Mock())
        with patch('collector_auth.threading.Thread') as thread:
            session._received(cookies()[1:])
            thread.assert_not_called()


if __name__ == '__main__':
    unittest.main()
