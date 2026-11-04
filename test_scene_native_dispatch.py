"""Exercise real Python thread dispatch without opening a native UI window."""
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import launch
import window_theme


class QueuedForm:
    def __init__(self):
        self.owner = threading.get_ident()
        self.pending = []
        self.posted = threading.Event()
        self.TopMost = True
        self.Handle = SimpleNamespace(ToInt64=lambda: 123)

    @property
    def InvokeRequired(self):
        return threading.get_ident() != self.owner

    def BeginInvoke(self, callback):
        self.pending.append(callback)
        self.posted.set()

    def pump(self):
        assert threading.get_ident() == self.owner
        for callback in self.pending[:]:
            self.pending.remove(callback)
            callback()


class SceneWindow:
    def __init__(self, native):
        self.native = native
        self._on_top = True
        self.changes = []

    @property
    def on_top(self):
        return self._on_top

    @on_top.setter
    def on_top(self, value):
        self.changes.append((threading.get_ident(), value))
        if threading.get_ident() != self.native.owner:
            raise RuntimeError('WinForms property accessed from the bridge thread')
        self._on_top = value
        self.native.TopMost = value


class SceneNativeDispatchTests(unittest.TestCase):
    def test_bridge_pin_waits_without_the_gil_and_runs_setter_only_on_owner_thread(self):
        form = QueuedForm()
        window = SceneWindow(form)
        api = launch.DesktopApi()
        api._scene_windows = [window]
        result = []
        with patch.dict('sys.modules', {'System': SimpleNamespace(Action=lambda callback: callback)}):
            worker = threading.Thread(target=lambda: result.append(api.set_scene_topmost(False)), daemon=True)
            worker.start()
            self.assertTrue(form.posted.wait(1))
            self.assertEqual(window.changes, [])
            form.pump()
            worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [{'onTop': False, 'applied': True}])
        self.assertEqual(window.changes, [(form.owner, False)])

    def test_theme_bridge_marshals_dwm_and_before_show_can_run_directly(self):
        form = QueuedForm()
        api = launch.DesktopApi()
        window = SceneWindow(form)
        api._scene_windows = [window]
        calls, result = [], []
        def apply(hwnd, theme):
            calls.append((threading.get_ident(), hwnd, theme))
            return True
        with patch.dict('sys.modules', {'System': SimpleNamespace(Action=lambda callback: callback)}), \
             patch('launch.apply_caption_theme', side_effect=apply):
            worker = threading.Thread(target=lambda: result.append(api.set_window_theme('light')), daemon=True)
            worker.start()
            self.assertTrue(form.posted.wait(1))
            self.assertEqual(calls, [])
            form.pump()
            worker.join(1)
            self.assertTrue(api._apply_scene_window_theme(window))
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [{'theme': 'light', 'applied': True}])
        self.assertEqual(calls, [(form.owner, 123, 'light'), (form.owner, 123, 'light')])
        self.assertEqual(form.pending, [])

    def test_noop_pin_does_not_repeat_the_native_property_setter(self):
        form = QueuedForm()
        window = SceneWindow(form)
        api = launch.DesktopApi()
        api._scene_windows = [window]
        self.assertEqual(api.set_scene_topmost(True), {'onTop': True, 'applied': True})
        self.assertEqual(window.changes, [])

    def test_dispatch_failure_never_falls_back_to_cross_thread_mutation(self):
        form = QueuedForm()
        form.BeginInvoke = Mock(side_effect=RuntimeError('form is closing'))
        window = SceneWindow(form)
        api = launch.DesktopApi()
        api._scene_windows = [window]
        results = []
        with patch.dict('sys.modules', {'System': SimpleNamespace(Action=lambda callback: callback)}):
            worker = threading.Thread(target=lambda: results.extend([api.set_scene_topmost(False), api.set_window_theme('light')]), daemon=True)
            worker.start()
            worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results, [{'onTop': False, 'applied': False}, {'theme': 'light', 'applied': False}])
        self.assertEqual(window.changes, [])
        action = Mock(return_value=True)
        self.assertFalse(launch._run_native_window_task(SimpleNamespace(native=None), action))
        action.assert_not_called()

    def test_timeout_reports_failure_but_documents_that_the_queued_action_can_run_later(self):
        form = QueuedForm()
        ran, result = [], []
        window = SceneWindow(form)
        with patch.dict('sys.modules', {'System': SimpleNamespace(Action=lambda callback: callback)}):
            worker = threading.Thread(target=lambda: result.append(launch._run_native_window_task(window, lambda: ran.append(threading.get_ident()) or True, timeout=.02)), daemon=True)
            worker.start()
            self.assertTrue(form.posted.wait(1))
            worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [False])
        self.assertEqual(ran, [])
        form.pump()
        self.assertEqual(ran, [form.owner])

    def test_caption_refresh_does_not_force_synchronous_window_paint(self):
        redraw = Mock(return_value=True)
        dll = SimpleNamespace(RedrawWindow=redraw)
        with patch.object(window_theme.ctypes, 'WinDLL', return_value=dll):
            window_theme._redraw_caption(123)
        self.assertEqual(redraw.call_args.args, (123, None, None, 0x401))
        self.assertEqual(redraw.call_args.args[-1] & 0x100, 0, 'RDW_UPDATENOW must remain unset')


if __name__ == '__main__':
    unittest.main()
