"""Work-area maximize regressions without opening or touching a desktop window."""
import ctypes
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import launch


class EventStub:
    def __init__(self, ready=False):
        self.handlers = []
        self.ready = ready

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self

    def is_set(self):
        return self.ready


def window_stub():
    events = SimpleNamespace(**{name: EventStub(name == 'loaded') for name in
                                ('before_show', 'maximized', 'restored', 'minimized', 'loaded')})
    return SimpleNamespace(events=events, native=None, maximize=Mock(), restore=Mock(),
                           minimize=Mock(), evaluate_js=Mock())


class WindowMaximizeTests(unittest.TestCase):
    def hook_stub(self, monitor=(0, 0, 1920, 1080), work=(0, 0, 1920, 1040)):
        hook = object.__new__(launch._WorkAreaMaximizeHook)
        hook.hwnd = 100
        hook._monitor_rectangles = Mock(return_value=(monitor, work))
        hook._comctl32 = SimpleNamespace(DefSubclassProc=Mock(return_value=123), RemoveWindowSubclass=Mock())
        hook._user32 = SimpleNamespace(IsZoomed=Mock(return_value=True), IsIconic=Mock(return_value=False), SetWindowPos=Mock())
        hook._callback = object()
        hook._subclass_id = 10
        hook._installed = True
        return hook

    def test_taskbar_at_every_edge_uses_physical_work_area(self):
        monitor = (0, 0, 1920, 1080)
        for work, position, size in (
            ((0, 0, 1920, 1040), (0, 0), (1920, 1040)),
            ((48, 0, 1920, 1080), (48, 0), (1872, 1080)),
            ((0, 40, 1920, 1080), (0, 40), (1920, 1040)),
            ((0, 0, 1872, 1080), (0, 0), (1872, 1080)),
        ):
            with self.subTest(work=work):
                self.assertEqual(launch._monitor_maximize_geometry(monitor, work), (position, size))

    def test_secondary_monitors_use_relative_offsets_even_with_negative_coordinates(self):
        for monitor, work, expected in (
            ((-1920, 0, 0, 1080), (-1920, 40, 0, 1080), ((0, 40), (1920, 1040))),
            ((1920, -200, 4480, 1240), (1968, -200, 4480, 1240), ((48, 0), (2512, 1440))),
            ((-2560, -1440, 0, 0), (-2560, -1440, -40, 0), ((0, 0), (2520, 1440))),
        ):
            with self.subTest(monitor=monitor):
                self.assertEqual(launch._monitor_maximize_geometry(monitor, work), expected)

    def test_native_minmax_callback_overrides_fullscreen_bounds_after_default_processing(self):
        hook = self.hook_stub(monitor=(-1920, 0, 0, 1080), work=(-1872, 0, 0, 1080))
        info = launch._MinMaxInfo()
        info.ptMinTrackSize.x, info.ptMinTrackSize.y = (2000, 1200)
        def default_proc(*args):
            info.ptMaxSize.x, info.ptMaxSize.y = (1920, 1080)
            return 123
        hook._comctl32.DefSubclassProc.side_effect = default_proc
        result = hook._window_proc(100, hook.WM_GETMINMAXINFO, 0, ctypes.addressof(info), 10, 0)
        self.assertEqual(result, 123)
        self.assertEqual((info.ptMaxPosition.x, info.ptMaxPosition.y), (48, 0))
        self.assertEqual((info.ptMaxSize.x, info.ptMaxSize.y), (1872, 1080))
        self.assertEqual((info.ptMaxTrackSize.x, info.ptMaxTrackSize.y), (1872, 1080))
        self.assertEqual((info.ptMinTrackSize.x, info.ptMinTrackSize.y), (1872, 1080))

    def test_work_area_or_dpi_change_refits_only_a_maximized_window(self):
        hook = self.hook_stub(monitor=(1920, 0, 4480, 1440), work=(1920, 48, 4480, 1440))
        for message in hook.WORK_AREA_MESSAGES:
            with self.subTest(message=message):
                hook._user32.SetWindowPos.reset_mock()
                hook._window_proc(100, message, 0, 0, 10, 0)
                hook._user32.SetWindowPos.assert_called_once_with(100, None, 1920, 48, 2560, 1392, 0x14)
        hook._user32.IsZoomed.return_value = False
        hook._user32.SetWindowPos.reset_mock()
        hook._refit_maximized()
        hook._user32.SetWindowPos.assert_not_called()
        hook._user32.IsZoomed.return_value = True
        hook._user32.IsIconic.return_value = True
        hook._refit_maximized()
        hook._user32.SetWindowPos.assert_not_called()

    def test_hook_is_removed_with_its_own_window(self):
        hook = self.hook_stub()
        hook._window_proc(100, hook.WM_NCDESTROY, 0, 0, 10, 0)
        hook._comctl32.RemoveWindowSubclass.assert_called_once_with(100, hook._callback, 10)
        self.assertFalse(hook._installed)

    def test_toggle_uses_actual_state_and_preserves_native_restore(self):
        api = launch.DesktopApi()
        window = window_stub()
        state = {'maximized': False, 'minimized': False}
        window.maximize.side_effect = lambda: state.update(maximized=True)
        window.restore.side_effect = lambda: state.update(maximized=False)
        api._bind_main_window(window)
        with patch.object(launch, '_native_window_state', side_effect=lambda value: state.copy()):
            api._main_maximized = True  # Simulate an old out-of-order native event.
            self.assertTrue(api.window_toggle_maximize())
            window.maximize.assert_called_once_with()
            self.assertFalse(api.window_toggle_maximize())
            window.restore.assert_called_once_with()
            self.assertEqual(api.window_state(), {'maximized': False, 'minimized': False})
        self.assertEqual(len(window.events.before_show.handlers), 1)
        self.assertEqual(len(window.events.maximized.handlers), 1)
        self.assertEqual(len(window.events.restored.handlers), 1)

    def test_native_events_publish_state_for_restore_icon_without_blocking_startup(self):
        api = launch.DesktopApi()
        window = window_stub()
        api._bind_main_window(window)
        actual = {'maximized': True, 'minimized': False}
        with patch.object(launch, '_native_window_state', return_value=actual):
            window.events.maximized.handlers[0]()
        script = window.evaluate_js.call_args.args[0]
        self.assertIn("CustomEvent('workspace-window-state'", script)
        self.assertIn(json.dumps(actual), script)
        window.events.loaded.ready = False
        window.evaluate_js.reset_mock()
        api._publish_main_window_state()
        window.evaluate_js.assert_not_called()


if __name__ == '__main__':
    unittest.main()
