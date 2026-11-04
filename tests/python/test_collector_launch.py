"""Native/HTTP auth endpoints share one controller; no browser or Node starts."""
import io
import json
import os
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import launch
from collector_auth import CollectorError


class EventStub:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self


class CollectorLaunchTests(unittest.TestCase):
    def handler(self, controller):
        original = launch.ACTIVE_PORT
        try:
            with patch('launch.listening', return_value=False), patch('launch.ThreadingHTTPServer') as server, \
                 patch('launch.threading.Thread'):
                launch.ensure_server(controller)
            handler = object.__new__(server.call_args.args[1].func)
            handler._guard = lambda: True
            handler._json = Mock()
            return handler
        finally:
            launch.ACTIVE_PORT = original

    def test_native_and_http_use_identical_controller_for_auth_login_start_and_stop(self):
        controller = Mock()
        status = {'loggedIn': True, 'loginInProgress': False, 'updatedAt': 'unit-time',
                  'needsLogin': False, 'error': None, 'errorCode': None}
        controller.auth_status.return_value = status
        controller.open_login.return_value = 'login requested'
        controller.start_capture.return_value = {'ok': True, 'port': 8765, 'collector': 'lightweight'}
        controller.stop_capture.return_value = 'stopped'
        api = launch.DesktopApi(controller)
        self.assertEqual(api.get_collector_auth_status(), status)
        self.assertEqual(api.open_live_room('12345'), 'login requested')
        self.assertIn('8765', api.start_capture('12345'))
        self.assertEqual(api.stop_capture(), 'stopped')
        handler = self.handler(controller)
        for path, method in [('/__collector-auth-status', 'auth_status'),
                             ('/__open-live?room=12345&debug=1', 'open_login'),
                             ('/__start-bridge?room=12345', 'start_capture'),
                             ('/__stop-bridge', 'stop_capture')]:
            with self.subTest(path=path):
                before = getattr(controller, method).call_count
                handler.path = path
                handler.do_GET()
                self.assertEqual(handler._json.call_args.args[0], 200)
                self.assertEqual(getattr(controller, method).call_count, before + 1)
        self.assertEqual(controller.open_login.call_args_list, [unittest.mock.call('12345')] * 2)

    def test_http_status_is_guarded_and_login_required_is_an_explicit_error(self):
        controller = Mock()
        handler = self.handler(controller)
        handler._guard = lambda: False
        handler.path = '/__collector-auth-status'
        handler.do_GET()
        self.assertEqual(handler._json.call_args.args[0], 403)
        controller.auth_status.assert_not_called()
        handler._guard = lambda: True
        handler.path = '/__start-bridge?room=12345'
        controller.start_capture.side_effect = CollectorError('LOGIN_REQUIRED')
        handler.do_GET()
        self.assertEqual(handler._json.call_args.args[0], 400)
        body = json.loads(handler._json.call_args.args[1])
        self.assertFalse(body['ok'])
        self.assertEqual(body['errorCode'], 'LOGIN_REQUIRED')
        with self.assertRaises(CollectorError):
            launch.DesktopApi(controller).start_capture('12345')

    def test_bridge_health_ignores_legacy_or_wrong_process_and_returns_runtime_status(self):
        def response(url, timeout):
            port = int(url.split(':')[2].split('/')[0])
            payload = dict(service='avatar-printer', identity=str(launch.ROOT), collector='lightweight',
                           pid=123, collectorStatus='connected', authenticated=True)
            if port == 8765:
                payload.update(collector='cdp')
            elif port == 8766:
                payload.update(pid=999)
            return io.BytesIO(json.dumps(payload).encode())
        with patch('launch.local_get', side_effect=response):
            status = launch.bridge_status(expected_pid=123)
        self.assertEqual(status['port'], 8767)
        self.assertEqual(status['collectorStatus'], 'connected')
        self.assertTrue(status['authenticated'])

    def test_login_branch_has_no_cdp_and_uses_only_application_profile(self):
        window = SimpleNamespace(events=SimpleNamespace(loaded=EventStub(), closing=EventStub()))
        webview = SimpleNamespace(create_window=Mock(return_value=window), start=Mock(), settings={})
        session = Mock(exit_code=0)
        with patch.dict('sys.modules', {'webview': webview}), \
             patch.dict(os.environ, {'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS': '--remote-debugging-port=9224 --keep'}), \
             patch('launch.AsyncCookieReader') as reader, \
             patch('launch.CookieLoginSession', return_value=session):
            self.assertEqual(launch.run_collector_login('12345', 'unit-request'), 0)
            self.assertNotIn('remote-debugging', os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'])
        self.assertIsNone(webview.settings['REMOTE_DEBUGGING_PORT'])
        self.assertFalse(webview.start.call_args.kwargs['private_mode'])
        self.assertEqual(webview.start.call_args.kwargs['storage_path'], str(launch.ROOT / '.live-webview-profile'))
        self.assertEqual(len(window.events.loaded.handlers), 1)
        self.assertEqual(len(window.events.closing.handlers), 1)
        session.cancel.assert_called_once_with()
        self.assertIn('登录成功后自动关闭', webview.create_window.call_args.args[0])

    def test_cli_live_room_routes_to_short_lived_auth_session(self):
        with patch('launch.sys.argv', ['launch.py', '--live-room', '12345', '--auth-request', 'unit-request']), \
             patch('launch.run_collector_login', return_value=3) as login:
            self.assertEqual(launch.main(), 3)
        login.assert_called_once_with('12345', 'unit-request')

    def test_cli_capture_reuses_saved_auth_or_waits_for_login_without_any_cdp_port(self):
        api = Mock()
        api.get_collector_auth_status.return_value = {'loggedIn': True, 'loginInProgress': False}
        api.start_capture.return_value = 'collector requested'
        self.assertEqual(launch._start_requested_collector(api, '12345', True), 'collector requested')
        api.open_live_room.assert_not_called()
        api.reset_mock()
        api.get_collector_auth_status.side_effect = [
            {'loggedIn': False, 'loginInProgress': False},
            {'loggedIn': False, 'loginInProgress': True},
            {'loggedIn': True, 'loginInProgress': False},
        ]
        with patch('launch.threading.Event') as event:
            self.assertEqual(launch._start_requested_collector(api, '12345', True), 'collector requested')
        api.open_live_room.assert_called_once_with('12345')
        api.start_capture.assert_called_once_with('12345')
        event.return_value.wait.assert_called_once_with(1)

    def test_cli_cancelled_login_does_not_start_capture(self):
        api = Mock()
        api.get_collector_auth_status.side_effect = [
            {'loggedIn': False, 'loginInProgress': False},
            {'loggedIn': False, 'loginInProgress': False, 'errorCode': 'LOGIN_CANCELLED'},
        ]
        with self.assertRaises(CollectorError) as error:
            launch._start_requested_collector(api, '12345', True)
        self.assertEqual(error.exception.code, 'LOGIN_CANCELLED')
        api.start_capture.assert_not_called()

    def test_exit_closes_auth_children_even_if_scene_process_does_not_exit(self):
        controller = Mock()
        api = launch.DesktopApi(controller)
        api._scene_process = Mock()
        api._scene_process.poll.return_value = None
        api._scene_process.wait.side_effect = subprocess.TimeoutExpired('fictional-scene', 5)
        api.close()
        api._scene_process.terminate.assert_called_once_with()
        api._scene_process.kill.assert_called_once_with()
        controller.close.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
