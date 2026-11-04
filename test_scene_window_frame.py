"""Native frame geometry, lifecycle and owner-thread tests; no UI windows."""
import ctypes
from ctypes import wintypes
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import Mock, patch

import launch
import scene_window_frame as frame
from test_scene_native_dispatch import QueuedForm


def rectangle(value):
    return value.left, value.top, value.right, value.bottom


class EventStub:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self


class SceneWindowFrameTests(unittest.TestCase):
    def hook(self):
        hook = object.__new__(frame.SceneWindowFrameHook)
        hook.hwnd = 100
        hook._installed = True
        hook._refreshed = False
        hook._edge_widths = (8, 8)
        hook._callback = object()
        hook._subclass_id = 42
        hook._user32 = SimpleNamespace(GetWindowThreadProcessId=Mock(return_value=17),
            SetWindowPos=Mock(return_value=True), GetWindowRect=Mock(),
            IsZoomed=Mock(return_value=False), IsIconic=Mock(return_value=False))
        hook._kernel32 = SimpleNamespace(GetCurrentThreadId=Mock(return_value=17))
        hook._comctl32 = SimpleNamespace(DefSubclassProc=Mock(return_value=0x400),
            RemoveWindowSubclass=Mock(return_value=True))
        return hook

    def test_geometry_preserves_caption_and_bottom_at_multiple_dpis_and_negative_origins(self):
        for outer, normal, expected in (
            ((100, 100, 1100, 800), (108, 131, 1092, 792), (100, 131, 1100, 792)),
            ((-1600, -100, -400, 700), (-1590, -61, -410, 690), (-1600, -61, -400, 690)),
            ((1920, 80, 4480, 1520), (1936, 142, 4464, 1504), (1920, 142, 4480, 1504)),
        ):
            with self.subTest(outer=outer):
                self.assertEqual(frame.expand_client_horizontally(outer, normal), expected)

    def test_invalid_normal_geometry_falls_back_instead_of_removing_caption(self):
        outer = (0, 0, 100, 100)
        for normal in ((8, -1, 92, 92), (8, 31, 92, 101), (92, 31, 8, 92), (-1, 31, 92, 92), (8, 92, 92, 31)):
            with self.subTest(normal=normal):
                self.assertIsNone(frame.expand_client_horizontally(outer, normal))
        self.assertIsNone(frame.expand_client_horizontally((0, 0, 0, 100), (0, 31, 0, 92)))

    def test_wparam_false_saves_outer_before_default_and_changes_only_client_sides(self):
        hook = self.hook()
        rect = wintypes.RECT(100, 100, 900, 700)
        def default(*args):
            self.assertEqual(rectangle(rect), (100, 100, 900, 700))
            rect.left, rect.top, rect.right, rect.bottom = (108, 142, 892, 690)
            return 0x400
        hook._comctl32.DefSubclassProc.side_effect = default
        result = hook._window_proc(100, hook.WM_NCCALCSIZE, 0, ctypes.addressof(rect), 42, 0)
        self.assertEqual(rectangle(rect), (100, 142, 900, 690))
        self.assertEqual(hook._edge_widths, (8, 8))
        self.assertEqual(result, 0)
        hook._comctl32.DefSubclassProc.assert_called_once()

    def test_wparam_true_preserves_other_rectangles_and_drops_stale_validrect_flags(self):
        hook = self.hook()
        params = frame.NCCalcSizeParams()
        params.rgrc[0] = wintypes.RECT(-1920, 40, -640, 800)
        params.rgrc[1] = wintypes.RECT(1, 2, 3, 4)
        params.rgrc[2] = wintypes.RECT(5, 6, 7, 8)
        params.lppos = 0x1234
        def default(*args):
            self.assertEqual(rectangle(params.rgrc[0]), (-1920, 40, -640, 800))
            params.rgrc[0] = wintypes.RECT(-1910, 82, -650, 790)
            return 0x400  # WVR_VALIDRECTS refers to the original narrower client.
        hook._comctl32.DefSubclassProc.side_effect = default
        result = hook._window_proc(100, hook.WM_NCCALCSIZE, 1, ctypes.addressof(params), 42, 0)
        self.assertEqual(result, 0)
        self.assertEqual(rectangle(params.rgrc[0]), (-1920, 82, -640, 790))
        self.assertEqual(rectangle(params.rgrc[1]), (1, 2, 3, 4))
        self.assertEqual(rectangle(params.rgrc[2]), (5, 6, 7, 8))
        self.assertEqual(params.lppos, 0x1234)

    def test_later_zero_insets_do_not_clear_resize_fallback_and_nonzero_dpi_changes_update_it(self):
        hook = self.hook()
        for insets, expected in (((0, 0), (8, 8)), ((12, 0), (12, 8)), ((0, 16), (12, 16))):
            rect = wintypes.RECT(100, 100, 900, 700)
            def default(*args):
                rect.left, rect.right = 100 + insets[0], 900 - insets[1]
                rect.top = 142
                return 0
            hook._comctl32.DefSubclassProc.side_effect = default
            hook._window_proc(100, hook.WM_NCCALCSIZE, 0, ctypes.addressof(rect), 42, 0)
            self.assertEqual(hook._edge_widths, expected)
            self.assertEqual(rectangle(rect), (100, 142, 900, 700))

    def test_null_foreign_and_invalid_calculations_keep_the_default_result(self):
        hook = self.hook()
        self.assertEqual(hook._window_proc(100, hook.WM_NCCALCSIZE, 1, 0, 42, 0), 0x400)
        rect = wintypes.RECT(0, 0, 100, 100)
        self.assertEqual(hook._window_proc(999, hook.WM_NCCALCSIZE, 0, ctypes.addressof(rect), 42, 0), 0x400)
        def default(*args):
            rect.top = -1
            return 77
        hook._comctl32.DefSubclassProc.side_effect = default
        self.assertEqual(hook._window_proc(100, hook.WM_NCCALCSIZE, 0, ctypes.addressof(rect), 42, 0), 77)
        self.assertEqual(rectangle(rect), (0, -1, 100, 100))

    def test_callback_failures_do_not_escape_or_skip_default_processing(self):
        hook = self.hook()
        with patch.object(hook, '_client_rectangle', side_effect=ValueError('unavailable geometry')):
            self.assertEqual(hook._window_proc(100, hook.WM_NCCALCSIZE, 1, 123, 42, 0), 0x400)
        hook._comctl32.DefSubclassProc.assert_called_once()

    def test_destroy_removes_own_callback_and_is_nonfatal_if_window_is_already_closing(self):
        for fails in (False, True):
            hook = self.hook()
            if fails:
                hook._comctl32.RemoveWindowSubclass.side_effect = OSError('window is gone')
            self.assertEqual(hook._window_proc(100, hook.WM_NCDESTROY, 0, 0, 42, 0), 0x400)
            hook._comctl32.RemoveWindowSubclass.assert_called_once_with(100, hook._callback, 42)
            self.assertFalse(hook.installed)

    def test_frame_refresh_is_idempotent_and_preserves_activation_size_position_and_zorder(self):
        hook = self.hook()
        self.assertTrue(hook.refresh())
        self.assertTrue(hook.refresh())
        hook._user32.SetWindowPos.assert_called_once_with(100, None, 0, 0, 0, 0, 0x2237)
        hook._refreshed = False
        hook._user32.SetWindowPos.return_value = False
        self.assertFalse(hook.refresh())
        hook._kernel32.GetCurrentThreadId.return_value = 18
        with self.assertRaisesRegex(RuntimeError, 'owner thread'):
            hook.refresh()
        self.assertEqual(hook._user32.SetWindowPos.call_count, 2)

    def test_constructor_rejects_cross_thread_subclassing_before_installing(self):
        user32 = SimpleNamespace(GetWindowThreadProcessId=Mock(return_value=17))
        kernel32 = SimpleNamespace(GetCurrentThreadId=Mock(return_value=18))
        comctl32 = SimpleNamespace(SetWindowSubclass=Mock())
        dlls = {'user32': user32, 'kernel32': kernel32, 'comctl32': comctl32}
        with patch('scene_window_frame.sys.platform', 'win32'), \
             patch.object(frame.ctypes, 'WinDLL', side_effect=lambda name, **kwargs: dlls[name]):
            with self.assertRaisesRegex(RuntimeError, 'owner thread'):
                frame.SceneWindowFrameHook(123)
        comctl32.SetWindowSubclass.assert_not_called()

    def test_client_strips_keep_resize_hits_without_overriding_caption_buttons_or_maximized_state(self):
        hook = self.hook()
        hook._edge_widths = (8, 10)
        def get_rect(hwnd, address):
            rect = ctypes.cast(address, ctypes.POINTER(wintypes.RECT)).contents
            rect.left, rect.top, rect.right, rect.bottom = (-1200, 100, -200, 900)
            return True
        hook._user32.GetWindowRect.side_effect = get_rect
        hook._comctl32.DefSubclassProc.return_value = hook.HTCLIENT
        def hit(x, y):
            point = ((y & 0xFFFF) << 16) | (x & 0xFFFF)
            return hook._window_proc(100, hook.WM_NCHITTEST, 0, point, 42, 0)
        self.assertEqual(hit(-1199, 200), hook.HTLEFT)
        self.assertEqual(hit(-201, 200), hook.HTRIGHT)
        self.assertEqual(hit(-500, 200), hook.HTCLIENT)
        self.assertEqual(hit(-1199, 99), hook.HTCLIENT)
        for native_hit in (2, 13, 14, 20):  # CAPTION, TOPLEFT, TOPRIGHT, CLOSE
            hook._comctl32.DefSubclassProc.return_value = native_hit
            self.assertEqual(hit(-1199, 200), native_hit)
        hook._comctl32.DefSubclassProc.return_value = hook.HTCLIENT
        hook._user32.IsZoomed.return_value = True
        self.assertEqual(hit(-1199, 200), hook.HTCLIENT)

    def test_scene_binding_is_idempotent_and_keeps_hook_alive_without_touching_main(self):
        window = SimpleNamespace(native=QueuedForm(), events=SimpleNamespace(before_show=EventStub(), loaded=EventStub()))
        api = launch.DesktopApi()
        main = SimpleNamespace(native=QueuedForm())
        api._main_window = main
        saved_hook = Mock(installed=True)
        saved_hook.refresh.return_value = True
        with patch('launch.SceneWindowFrameHook', return_value=saved_hook) as install, \
             patch.object(api, '_apply_scene_window_theme', return_value=True) as theme:
            self.assertFalse(api._install_scene_window_frame(main))
            self.assertFalse(api._install_scene_window_frame(window))
            api._bind_scene_window(window, 'dark')
            api._bind_scene_window(window, 'light')
            self.assertEqual(len(window.events.before_show.handlers), 1)
            self.assertEqual(len(window.events.loaded.handlers), 1)
            window.events.before_show.handlers[0]()
            window.events.loaded.handlers[0]()
            install.assert_called_once_with(123)
            self.assertIs(api._scene_frame_hooks[123], saved_hook)
            self.assertEqual(theme.call_count, 2)
            self.assertEqual(api._scene_theme, 'light')

    def test_scene_frame_failure_leaves_caption_theme_and_startup_available(self):
        window = SimpleNamespace(native=QueuedForm(), events=SimpleNamespace(before_show=EventStub(), loaded=EventStub()))
        api = launch.DesktopApi()
        api._bind_scene_window(window)
        with patch('launch.SceneWindowFrameHook', side_effect=OSError('subclass unsupported')), \
             patch.object(api, '_apply_scene_window_theme', return_value=True) as theme:
            window.events.before_show.handlers[0]()
            theme.assert_called_once_with(window)
        self.assertEqual(api._scene_frame_hooks, {})

    def test_worker_dispatches_install_and_refresh_to_ui_thread_without_direct_fallback(self):
        form = QueuedForm()
        window = SimpleNamespace(native=form)
        api = launch.DesktopApi()
        api._scene_windows = [window]
        calls, result = [], []
        saved_hook = Mock(installed=True)
        saved_hook.refresh.side_effect = lambda: calls.append(('refresh', threading.get_ident())) or True
        def construct(hwnd):
            calls.append(('install', threading.get_ident()))
            return saved_hook
        with patch.dict('sys.modules', {'System': SimpleNamespace(Action=lambda callback: callback)}), \
             patch('launch.SceneWindowFrameHook', side_effect=construct):
            worker = threading.Thread(target=lambda: result.append(api._install_scene_window_frame(window)), daemon=True)
            worker.start()
            self.assertTrue(form.posted.wait(1))
            self.assertEqual(calls, [])
            form.pump()
            worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [True])
        self.assertEqual(calls, [('install', form.owner), ('refresh', form.owner)])
        self.assertIs(api._scene_frame_hooks[123], saved_hook)
        form.BeginInvoke = Mock(side_effect=RuntimeError('closing'))
        calls.clear()
        result.clear()
        with patch.dict('sys.modules', {'System': SimpleNamespace(Action=lambda callback: callback)}):
            worker = threading.Thread(target=lambda: result.append(api._install_scene_window_frame(window)), daemon=True)
            worker.start()
            worker.join(1)
        self.assertEqual(result, [False])
        self.assertEqual(calls, [])

    def test_non_windows_install_is_a_noop(self):
        api = launch.DesktopApi()
        window = SimpleNamespace(native=QueuedForm())
        api._scene_windows = [window]
        with patch('launch.sys.platform', 'linux'), patch('launch.SceneWindowFrameHook') as install:
            self.assertFalse(api._install_scene_window_frame(window))
            install.assert_not_called()


if __name__ == '__main__':
    unittest.main()
