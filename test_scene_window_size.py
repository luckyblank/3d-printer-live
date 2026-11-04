import unittest
from unittest.mock import Mock, patch
from launch import DesktopApi


class SceneWindowResizeTests(unittest.TestCase):
    def test_resolution_change_does_not_resize_existing_preview(self):
        api = DesktopApi()
        api._scene_orientation = 'landscape'
        api._scene_windows = [Mock(closed=False)]
        api.resize_scene(1920, 1080)
        api._scene_windows[0].resize.assert_not_called()

    def test_orientation_change_uses_fitted_window_not_video_pixels(self):
        api = DesktopApi()
        api._scene_orientation = 'landscape'
        window = Mock(closed=False)
        api._scene_windows = [window]
        geometry = dict(width=405, height=720, x=80, y=32, min_size=(270, 480))
        with patch('launch.default_scene_window_geometry', return_value=geometry):
            api.resize_scene(1080, 1920)
            api.resize_scene(720, 1280)
        window.resize.assert_called_once_with(405, 720)
        window.move.assert_called_once_with(80, 32)


if __name__ == '__main__':
    unittest.main()
