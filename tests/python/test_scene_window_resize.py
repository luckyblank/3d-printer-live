"""Edge gesture/native resize queue contract without touching a real window."""
import ctypes
from ctypes import wintypes
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import Mock, patch

import launch
import scene_window_frame as frame
from .test_scene_native_dispatch import QueuedForm


class SceneWindowResizeTests(unittest.TestCase):
    def native_api(self, x=-1919, y=-100):
        events = []
        def cursor(address):
            point = ctypes.cast(address, ctypes.POINTER(wintypes.POINT)).contents
            point.x, point.y = x, y
            return True
        user32 = SimpleNamespace(GetWindowThreadProcessId=Mock(return_value=17),
            IsZoomed=Mock(return_value=False), IsIconic=Mock(return_value=False),
            GetAsyncKeyState=Mock(return_value=0x8000),
            GetCursorPos=Mock(side_effect=cursor),
            ReleaseCapture=Mock(side_effect=lambda: events.append('release') or False),
            PostMessageW=Mock(side_effect=lambda *args: events.append(('post', args)) or True))
        return user32, SimpleNamespace(GetCurrentThreadId=Mock(return_value=17)), events

    def test_left_and_right_post_native_resize_with_signed_screen_point_and_no_send(self):
        for edge, hit in (('left', 10), ('right', 11)):
            with self.subTest(edge=edge):
                user32, kernel32, events = self.native_api()
                with patch('scene_window_frame._load_resize_api', return_value=(user32, kernel32)):
                    self.assertTrue(frame.post_scene_resize(123, edge))
                position = (-1919 & 0xFFFF) | ((-100 & 0xFFFF) << 16)
                self.assertEqual(events, ['release', ('post', (123, 0x00A1, hit, position))])
                self.assertFalse(hasattr(user32, 'SendMessageW'))

    def test_native_queue_refuses_wrong_thread_maximized_minimized_and_missing_cursor(self):
        for condition in ('wrong-thread', 'invalid-window', 'maximized', 'minimized', 'cursor'):
            with self.subTest(condition=condition):
                user32, kernel32, events = self.native_api()
                if condition == 'wrong-thread': kernel32.GetCurrentThreadId.return_value = 18
                elif condition == 'invalid-window': user32.GetWindowThreadProcessId.return_value = 0
                elif condition == 'maximized': user32.IsZoomed.return_value = True
                elif condition == 'minimized': user32.IsIconic.return_value = True
                else: user32.GetCursorPos.side_effect = None; user32.GetCursorPos.return_value = False
                with patch('scene_window_frame._load_resize_api', return_value=(user32, kernel32)):
                    self.assertFalse(frame.post_scene_resize(123, 'right'))
                self.assertEqual(events, [])

    def test_failed_post_is_reported_without_fallback(self):
        user32, kernel32, events = self.native_api()
        user32.PostMessageW.side_effect = None
        user32.PostMessageW.return_value = False
        with patch('scene_window_frame._load_resize_api', return_value=(user32, kernel32)):
            self.assertFalse(frame.post_scene_resize(123, 'right'))
        user32.ReleaseCapture.assert_called_once_with()
        user32.PostMessageW.assert_called_once()

    def test_late_bridge_after_mouse_up_does_not_queue_a_modal_resize(self):
        for state in (0, 1):  # A prior press transition is not a current hold.
            with self.subTest(button_state=state):
                user32, kernel32, events = self.native_api()
                user32.GetAsyncKeyState.return_value = state
                with patch('scene_window_frame._load_resize_api', return_value=(user32, kernel32)):
                    self.assertFalse(frame.post_scene_resize(123, 'right'))
                user32.GetAsyncKeyState.assert_called_once_with(0x01)
                user32.GetCursorPos.assert_not_called()
                self.assertEqual(events, [])

    def test_bad_edges_and_ordinary_main_only_api_never_touch_native_window(self):
        api = launch.DesktopApi()
        api._main_window = SimpleNamespace(native=QueuedForm())
        api._scene_windows = [api._main_window]
        with patch('launch.post_scene_resize') as post, patch('scene_window_frame._load_resize_api') as load:
            for edge in ('top', 'bottom', 'RIGHT', '', None, True, 1, [], {}):
                with self.subTest(edge=edge), self.assertRaises(ValueError):
                    api.resize_scene_window(edge)
                with self.subTest(native_edge=edge), self.assertRaises(ValueError):
                    frame.post_scene_resize(123, edge)
            self.assertEqual(api.resize_scene_window('right'), {'edge': 'right', 'applied': False, 'queued': False})
            api._scene_windows = []
            self.assertFalse(api.resize_scene_window('left')['queued'])
            post.assert_not_called()
            load.assert_not_called()

    def test_scene_api_posts_once_to_bound_scene_and_reports_failed_post(self):
        api = launch.DesktopApi()
        main = SimpleNamespace(native=QueuedForm())
        scene = SimpleNamespace(native=QueuedForm())
        api._main_window = main
        api._scene_windows = [main, scene]
        with patch('launch.post_scene_resize', return_value=True) as post:
            self.assertEqual(api.resize_scene_window('left'), {'edge': 'left', 'applied': True, 'queued': True})
            post.assert_called_once_with(123, 'left')
        with patch('launch.post_scene_resize', return_value=False) as post:
            self.assertEqual(api.resize_scene_window('right'), {'edge': 'right', 'applied': False, 'queued': False})
            post.assert_called_once_with(123, 'right')

    def test_bridge_worker_queues_only_on_owner_thread_and_never_directly_falls_back(self):
        form = QueuedForm()
        window = SimpleNamespace(native=form)
        api = launch.DesktopApi()
        api._scene_windows = [window]
        calls, result = [], []
        def post(hwnd, edge):
            calls.append((threading.get_ident(), hwnd, edge))
            return True
        with patch.dict('sys.modules', {'System': SimpleNamespace(Action=lambda callback: callback)}), \
             patch('launch.post_scene_resize', side_effect=post):
            worker = threading.Thread(target=lambda: result.append(api.resize_scene_window('right')), daemon=True)
            worker.start()
            self.assertTrue(form.posted.wait(1))
            self.assertEqual(calls, [])
            form.pump()
            worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(calls, [(form.owner, 123, 'right')])
        self.assertEqual(result, [{'edge': 'right', 'applied': True, 'queued': True}])
        calls.clear(); result.clear()
        form.BeginInvoke = Mock(side_effect=RuntimeError('closing'))
        with patch.dict('sys.modules', {'System': SimpleNamespace(Action=lambda callback: callback)}), \
             patch('launch.post_scene_resize', side_effect=post):
            worker = threading.Thread(target=lambda: result.append(api.resize_scene_window('left')), daemon=True)
            worker.start(); worker.join(1)
        self.assertEqual(calls, [])
        self.assertEqual(result, [{'edge': 'left', 'applied': False, 'queued': False}])

    def test_unsupported_platform_or_missing_handle_never_loads_native_api(self):
        with patch('scene_window_frame.sys.platform', 'linux'), patch('scene_window_frame._load_resize_api') as load:
            self.assertFalse(frame.post_scene_resize(123, 'left'))
            load.assert_not_called()
        with patch('scene_window_frame._load_resize_api') as load:
            self.assertFalse(frame.post_scene_resize(None, 'right'))
            load.assert_not_called()


if __name__ == '__main__':
    unittest.main()
