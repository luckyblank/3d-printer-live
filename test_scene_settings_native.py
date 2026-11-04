"""Mock-only scene pin and local settings-transport checks."""
import io
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

import launch
from test_scene_relay import settings, snapshot


class EventStub:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self


class SceneSettingsNativeTests(unittest.TestCase):
    def test_pin_calls_scene_setters_in_order_and_never_changes_main_window(self):
        changes = []
        class Window:
            def __init__(self, name):
                self.name = name
                self._on_top = True
                self.native = SimpleNamespace(InvokeRequired=False)

            @property
            def on_top(self):
                return self._on_top

            @on_top.setter
            def on_top(self, value):
                changes.append((self.name, value))
                self._on_top = value
        api = launch.DesktopApi()
        api._main_window = Window('main')
        api._scene_windows = [Window('scene-1'), Window('scene-2')]
        self.assertEqual(api.set_scene_topmost(False), {'onTop': False, 'applied': True})
        self.assertEqual(changes, [('scene-1', False), ('scene-2', False)])
        self.assertTrue(api._main_window.on_top)
        self.assertEqual(api.set_scene_topmost(True), {'onTop': True, 'applied': True})
        self.assertEqual(changes[-2:], [('scene-1', True), ('scene-2', True)])

    def test_pin_rejects_non_booleans_and_reports_no_bound_scene(self):
        api = launch.DesktopApi()
        self.assertEqual(api.set_scene_topmost(False), {'onTop': False, 'applied': False})
        for value in (0, 1, 'true', 'false', None, [], {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                api.set_scene_topmost(value)
        self.assertFalse(api._scene_on_top)

    def test_closed_scene_setter_does_not_prevent_other_scene_from_updating(self):
        class Closed:
            native = SimpleNamespace(InvokeRequired=False)
            @property
            def on_top(self):
                return True

            @on_top.setter
            def on_top(self, value):
                raise RuntimeError('window closed')
        api = launch.DesktopApi()
        other = SimpleNamespace(on_top=True, native=SimpleNamespace(InvokeRequired=False))
        api._scene_windows = [Closed(), other]
        self.assertEqual(api.set_scene_topmost(False), {'onTop': False, 'applied': True})
        self.assertFalse(other.on_top)

    def test_launch_cli_takes_pin_from_full_scene_settings_or_defaults_true(self):
        for options, expected in ((None, 'true'), ({}, 'true'), ({**settings(), 'onTop': False}, 'false')):
            with self.subTest(options=options), patch('launch.subprocess.Popen') as popen:
                api = launch.DesktopApi()
                api.open_scene_window(None, 'portrait-1080p', 'light', options)
                command = popen.call_args.args[0]
                self.assertEqual(command[command.index('--scene-on-top') + 1], expected)
                self.assertEqual(command[command.index('--scene-theme') + 1], 'light')
        with patch('launch.subprocess.Popen') as popen, self.assertRaises(ValueError):
            launch.DesktopApi().open_scene_window(options={'onTop': 'false'})
        popen.assert_not_called()

    def test_scene_initial_pin_is_available_before_settings_messages(self):
        for pin, expected in (('true', True), ('false', False)):
            with self.subTest(pin=pin):
                window = SimpleNamespace(events=SimpleNamespace(before_show=EventStub(), loaded=EventStub()))
                webview = SimpleNamespace(create_window=Mock(return_value=window), start=Mock())
                with patch.dict('sys.modules', {'webview': webview}), patch.dict(os.environ, {}, clear=False), \
                     patch('launch.sys.argv', ['launch.py', '--scene-view', '--scene-on-top', pin, '--scene-theme', 'light']), \
                     patch('launch.default_scene_window_geometry', return_value={'width': 960, 'height': 540, 'min_size': (640, 360)}):
                    launch.main()
                self.assertIs(webview.create_window.call_args.kwargs['on_top'], expected)
                query = parse_qs(urlparse(webview.create_window.call_args.args[1]).query)
                self.assertEqual(query, {'theme': ['light'], 'onTop': ['1' if expected else '0']})
                self.assertIs(webview.create_window.call_args.kwargs['js_api']._scene_on_top, expected)

    def handler(self):
        original_port = launch.ACTIVE_PORT
        try:
            with patch('launch.listening', return_value=False), patch('launch.ThreadingHTTPServer') as server, \
                 patch('launch.threading.Thread'):
                launch.ensure_server()
            handler_class = server.call_args.args[1].func
            handler = object.__new__(handler_class)
            handler.path = '/__scene-message'
            handler._guard = lambda: True
            handler._json = Mock()
            return handler
        finally:
            launch.ACTIVE_PORT = original_port

    def test_http_accepts_five_compressed_avatars_above_the_old_64k_limit(self):
        handler = self.handler()
        value = snapshot()
        value['queue'] = [dict(value['queue'][0], avatar='a' * 50000) for _ in range(5)]
        payload = json.dumps({'client': 'main', 'message': {'type': 'view-overlay-state', 'snapshot': value}}).encode('utf-8')
        self.assertGreater(len(payload), 65536)
        handler.headers = {'Content-Length': str(len(payload))}
        handler.rfile = io.BytesIO(payload)
        handler.do_POST()
        self.assertEqual(handler._json.call_args.args[0], 200)

    def test_http_refuses_more_than_one_mebibyte_before_reading_it(self):
        handler = self.handler()
        handler.headers = {'Content-Length': str(1024 * 1024 + 1)}
        handler.rfile = Mock()
        handler.do_POST()
        handler.rfile.read.assert_not_called()
        self.assertEqual(handler._json.call_args.args[0], 400)


if __name__ == '__main__':
    unittest.main()
