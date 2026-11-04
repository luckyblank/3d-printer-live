import unittest
from unittest.mock import Mock, patch

from launch import DesktopApi


class WindowChromeTests(unittest.TestCase):
    def test_maximize_restore_remain_correct_when_native_events_fire_synchronously(self):
        api = DesktopApi()
        window = Mock()
        api._main_window = window
        window.maximize.side_effect = lambda: api._set_main_maximized(True)
        window.restore.side_effect = lambda: api._set_main_maximized(False)
        self.assertTrue(api.window_toggle_maximize())
        self.assertFalse(api.window_toggle_maximize())
        window.maximize.assert_called_once()
        window.restore.assert_called_once()

    def test_minimize_targets_only_the_main_window(self):
        api = DesktopApi()
        api._main_window = Mock()
        api.window_minimize()
        api._main_window.minimize.assert_called_once()

    def test_close_leaves_time_for_bridge_reply(self):
        api = DesktopApi()
        api._main_window = Mock()
        with patch('launch.threading.Timer') as timer:
            api.window_close()
        timer.assert_called_once_with(.1, api._main_window.destroy)
        timer.return_value.start.assert_called_once()
        api._main_window.destroy.assert_not_called()


if __name__ == '__main__':
    unittest.main()
