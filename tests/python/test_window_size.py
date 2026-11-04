"""Window geometry checks without changing display settings or opening UI."""
import math
import unittest
from unittest.mock import patch

from window_size import (
    default_scene_window_geometry,
    default_window_geometry,
    fit_scene_window_to_work_area,
    fit_window_to_work_area,
)


class WindowSizeTests(unittest.TestCase):
    def assert_fits(self, area, dpi, geometry):
        scale = dpi / 96
        left, top, right, bottom = area
        # pywebview converts logical coordinates to physical integer pixels.
        actual_left = int(geometry['x'] * scale)
        actual_top = int(geometry['y'] * scale)
        actual_width = int(geometry['width'] * scale)
        actual_height = int(geometry['height'] * scale)
        self.assertGreaterEqual(actual_left, left)
        self.assertGreaterEqual(actual_top, top)
        self.assertLessEqual(actual_left + actual_width, right)
        self.assertLessEqual(actual_top + actual_height, bottom)
        self.assertLessEqual(geometry['min_size'][0], geometry['width'])
        self.assertLessEqual(geometry['min_size'][1], geometry['height'])
        self.assertLessEqual(abs(actual_left + actual_width / 2 - (left + right) / 2), math.ceil(scale))
        self.assertLessEqual(abs(actual_top + actual_height / 2 - (top + bottom) / 2), math.ceil(scale))

    def test_preferred_dimensions_on_large_screen(self):
        result = fit_window_to_work_area((0, 0, 1920, 1040))
        self.assertEqual(result, {'width': 1280, 'height': 720, 'x': 320, 'y': 160, 'min_size': (900, 560)})

    def test_dpi_and_small_work_areas_stay_on_screen(self):
        for dpi in (96, 120, 144, 192):
            for area in ((0, 0, 1920, 1040), (0, 0, 1366, 728), (0, 0, 1024, 720), (0, 0, 640, 440)):
                with self.subTest(dpi=dpi, area=area):
                    result = fit_window_to_work_area(area, dpi)
                    self.assert_fits(area, dpi, result)
                    scale = dpi / 96
                    self.assertLessEqual(result['width'] * scale, area[2] - area[0] - 64)
                    self.assertLessEqual(result['height'] * scale, area[3] - area[1] - 64)

    def test_125_percent_is_not_double_scaled(self):
        result = fit_window_to_work_area((0, 0, 1920, 1040), 120)
        self.assertEqual((result['width'], result['height']), (1280, 720))
        self.assertEqual((result['x'], result['y']), (128, 56))
        self.assert_fits((0, 0, 1920, 1040), 120, result)

    def test_offsets_taskbars_and_negative_monitor_coordinates(self):
        for area in ((48, 0, 1920, 1080), (0, 48, 1920, 1080), (-1920, 40, 0, 1080), (-2560, -1440, -640, -400)):
            for dpi in (96, 120, 144, 192):
                with self.subTest(area=area, dpi=dpi):
                    self.assert_fits(area, dpi, fit_window_to_work_area(area, dpi))

    def test_minimum_cannot_force_a_window_beyond_the_work_area(self):
        result = fit_window_to_work_area((0, 0, 800, 600), 192)
        self.assertEqual((result['width'], result['height']), (368, 268))
        self.assertEqual(result['min_size'], (368, 268))
        self.assert_fits((0, 0, 800, 600), 192, result)

    def test_non_windows_fallback_has_no_arbitrary_position(self):
        with patch('window_size.sys.platform', 'linux'):
            self.assertEqual(default_window_geometry(), {'width': 1280, 'height': 720, 'min_size': (900, 560)})

    def test_invalid_input_is_rejected(self):
        for area, dpi in (((0, 0, 0, 720), 96), ((0, 0, 1280, 720), 0), ((0, 0, 1280, 720), float('nan'))):
            with self.subTest(area=area, dpi=dpi), self.assertRaises(ValueError):
                fit_window_to_work_area(area, dpi)

    def test_scene_default_size_does_not_follow_output_resolution(self):
        area = (0, 0, 1920, 1040)
        landscape = fit_scene_window_to_work_area(area, 96, 'landscape')
        portrait = fit_scene_window_to_work_area(area, 96, 'portrait')
        self.assertEqual((landscape['width'], landscape['height']), (960, 540))
        self.assertEqual(landscape['min_size'], (640, 360))
        self.assertEqual((portrait['width'], portrait['height']), (405, 720))
        self.assertEqual(portrait['min_size'], (270, 480))
        self.assertEqual(landscape, fit_scene_window_to_work_area(area, 96, 'landscape-1080p'))
        self.assertEqual(portrait, fit_scene_window_to_work_area(area, 96, 'portrait-1080p'))

    def test_scene_small_screens_fit_proportionally_at_each_dpi(self):
        for dpi in (96, 120, 144, 192):
            for area in ((0, 0, 1920, 1040), (0, 0, 1366, 728), (0, 0, 640, 440), (-1920, 40, 0, 1080)):
                for orient, ratio, maximum_minimum in (
                    ('landscape', (16, 9), (640, 360)),
                    ('portrait', (9, 16), (270, 480)),
                ):
                    with self.subTest(dpi=dpi, area=area, orient=orient):
                        result = fit_scene_window_to_work_area(area, dpi, orient)
                        self.assert_fits(area, dpi, result)
                        self.assertEqual(result['width'] * ratio[1], result['height'] * ratio[0])
                        self.assertLessEqual(result['min_size'][0], maximum_minimum[0])
                        self.assertLessEqual(result['min_size'][1], maximum_minimum[1])
                        self.assertLessEqual(result['width'] * dpi / 96, area[2] - area[0] - 64)
                        self.assertLessEqual(result['height'] * dpi / 96, area[3] - area[1] - 64)
                        self.assertEqual(result, fit_scene_window_to_work_area(area, dpi, orient + '-1080p'))

    def test_scene_default_reuses_work_area_reader(self):
        area = (-1920, 40, 0, 1080)
        with patch('window_size._read_windows_work_area', return_value=(area, 144)) as reader:
            result = default_scene_window_geometry('portrait-1080p')
            self.assertEqual(result, fit_scene_window_to_work_area(area, 144, 'portrait'))
            reader.assert_called_once_with()

    def test_scene_fallback_is_small_for_both_output_resolutions(self):
        with patch('window_size._read_windows_work_area', return_value=None):
            self.assertEqual(default_scene_window_geometry('landscape-1080p'),
                             {'width': 960, 'height': 540, 'min_size': (640, 360)})
            self.assertEqual(default_scene_window_geometry('portrait-1080p'),
                             {'width': 405, 'height': 720, 'min_size': (270, 480)})


if __name__ == '__main__':
    unittest.main()
