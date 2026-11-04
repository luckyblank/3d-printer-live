"""Mock-only native-caption and scene-launch theme checks; no desktop capture."""
import ctypes
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

import launch
import window_theme


class EventStub:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self


def window_stub(handle=123):
    return SimpleNamespace(
        native=SimpleNamespace(Handle=SimpleNamespace(ToInt64=lambda: handle), InvokeRequired=False),
        events=SimpleNamespace(before_show=EventStub(), loaded=EventStub()),
    )


class WindowThemeTests(unittest.TestCase):
    def apply_mock_theme(self, theme, unsupported=()):
        calls = []
        def attribute(hwnd, name, value, size):
            calls.append((hwnd, name, ctypes.cast(value, ctypes.POINTER(ctypes.c_uint32)).contents.value, size))
            return -1 if name in unsupported else 0
        with patch('window_theme.sys.platform', 'win32'), \
             patch('window_theme._load_dwm_set_attribute', return_value=attribute), \
             patch('window_theme._redraw_caption') as redraw:
            result = window_theme.apply_caption_theme(123, theme)
        return result, calls, redraw

    def test_caption_colors_match_the_workspace_in_colorref_order(self):
        for theme, colors, dark in (
            ('dark', (0x221E1B, 0xEDF0F1), 1),
            ('light', (0xF6F9FA, 0x2C2B29), 0),
        ):
            with self.subTest(theme=theme):
                result, calls, redraw = self.apply_mock_theme(theme)
                self.assertTrue(result)
                self.assertEqual(calls, [(123, 20, dark, 4), (123, 34, 0xFFFFFFFE, 4),
                                         (123, 35, colors[0], 4), (123, 36, colors[1], 4)])
                redraw.assert_called_once_with(123)

    def test_older_windows_use_immersive_attribute_19_and_skip_unsupported_custom_colors(self):
        result, calls, redraw = self.apply_mock_theme('dark', unsupported=(20, 34, 35, 36))
        self.assertTrue(result)
        self.assertEqual([call[1] for call in calls], [20, 19, 34, 35, 36])
        self.assertEqual(calls[1][2], 1)
        redraw.assert_called_once_with(123)
        result, _, redraw = self.apply_mock_theme('light', unsupported=(20, 19, 34, 35, 36))
        self.assertFalse(result)
        redraw.assert_not_called()

    def test_outline_suppression_is_best_effort_without_disabling_caption_theme(self):
        result, calls, redraw = self.apply_mock_theme('dark', unsupported=(34,))
        self.assertTrue(result)
        self.assertEqual(calls[1], (123, 34, 0xFFFFFFFE, 4))
        self.assertEqual([call[1] for call in calls], [20, 34, 35, 36])
        redraw.assert_called_once_with(123)

    def test_unsupported_platform_or_missing_dwm_is_nonfatal(self):
        with patch('window_theme.sys.platform', 'linux'), patch('window_theme._load_dwm_set_attribute') as load:
            self.assertFalse(window_theme.apply_caption_theme(123, 'dark'))
            load.assert_not_called()
        with patch('window_theme.sys.platform', 'win32'), \
             patch('window_theme._load_dwm_set_attribute', side_effect=OSError('not supported')):
            self.assertFalse(window_theme.apply_caption_theme(123, 'dark'))

    def test_scene_caption_is_applied_before_show_and_after_load(self):
        api = launch.DesktopApi()
        window = window_stub()
        with patch('launch.apply_caption_theme', return_value=True) as apply:
            api._bind_scene_window(window, 'light')
            self.assertEqual(api._scene_windows, [window])
            window.events.before_show.handlers[0]()
            window.events.loaded.handlers[0]()
        self.assertEqual(apply.call_args_list, [unittest.mock.call(123, 'light'), unittest.mock.call(123, 'light')])

    def test_theme_api_changes_scene_only_and_uses_latest_theme_at_load(self):
        api = launch.DesktopApi()
        api._main_window = window_stub(999)
        scene = window_stub(123)
        api._bind_scene_window(scene, 'dark')
        with patch('launch.apply_caption_theme', return_value=True) as apply:
            self.assertEqual(api.set_window_theme('light'), {'theme': 'light', 'applied': True})
            scene.events.loaded.handlers[0]()
        self.assertEqual(apply.call_args_list, [unittest.mock.call(123, 'light'), unittest.mock.call(123, 'light')])

    def test_scene_launch_propagates_normalized_theme_in_cli(self):
        for theme, expected in (('light', 'light'), ('dark', 'dark'), ('invalid', 'dark')):
            with self.subTest(theme=theme), patch('launch.subprocess.Popen') as popen:
                api = launch.DesktopApi()
                api.open_scene_window(None, 'landscape-1080p', theme)
                command = popen.call_args.args[0]
                self.assertEqual(command[command.index('--scene-theme') + 1], expected)
                self.assertEqual(command[command.index('--scene-orient') + 1], 'landscape-1080p')

    def test_scene_cli_initial_theme_reaches_native_binding_and_page_url(self):
        scene = window_stub()
        webview = SimpleNamespace(create_window=Mock(return_value=scene), start=Mock())
        with patch.dict('sys.modules', {'webview': webview}), \
             patch.dict(os.environ, {}, clear=False), \
             patch('launch.sys.argv', ['launch.py', '--scene-view', '--scene-theme', 'light']), \
             patch('launch.default_scene_window_geometry', return_value={'width': 960, 'height': 540, 'min_size': (640, 360)}):
            launch.main()
        query = parse_qs(urlparse(webview.create_window.call_args.args[1]).query)
        self.assertEqual(query, {'theme': ['light'], 'onTop': ['1']})
        self.assertTrue(webview.create_window.call_args.kwargs['on_top'])
        self.assertEqual(webview.create_window.call_args.kwargs['js_api']._scene_theme, 'light')
        self.assertEqual(len(scene.events.before_show.handlers), 1)

    def test_desktop_marker_and_optional_managed_scene_reopen(self):
        for reopen in (False, True):
            with self.subTest(reopen=reopen):
                main_window = window_stub()
                main_window.events.maximized = EventStub()
                main_window.events.restored = EventStub()
                main_window.events.minimized = EventStub()
                api = launch.DesktopApi()
                api.open_scene_window = Mock()
                api.close = Mock()
                def start(callback, **kwargs):
                    callback()
                webview = SimpleNamespace(create_window=Mock(return_value=main_window), start=start, settings={})
                arguments = ['launch.py', '--scene-orient', 'portrait-1080p', '--scene-theme', 'light']
                if reopen:
                    arguments.append('--open-scene')
                with patch.dict('sys.modules', {'webview': webview}), \
                     patch.dict(os.environ, {}, clear=False), \
                     patch('launch.sys.argv', arguments), \
                     patch('launch.ensure_server', return_value=('http://127.0.0.1:8080/', None)), \
                     patch('launch.DesktopApi', return_value=api), \
                     patch('launch.default_window_geometry', return_value={'width': 1280, 'height': 720, 'min_size': (900, 560)}):
                    launch.main()
                self.assertEqual(webview.create_window.call_args.args[1], 'http://127.0.0.1:8080/?desktop=1')
                if reopen:
                    api.open_scene_window.assert_called_once_with(None, 'portrait-1080p', 'light', {'onTop': True})
                else:
                    api.open_scene_window.assert_not_called()


if __name__ == '__main__':
    unittest.main()
