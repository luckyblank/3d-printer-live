"""Regressions that prevent the frozen desktop build from starting correctly."""
import json
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import launch
import build_desktop


def clean_zip_helper():
    path = Path(__file__).resolve().parents[2] / 'build' / 'verification' / 'refresh-clean-zip.py'
    spec = importlib.util.spec_from_file_location('clean_zip_checks', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DesktopPackageTests(unittest.TestCase):
    def test_scene_gift_icons_is_explicit_in_both_package_lists(self):
        updates = json.loads((build_desktop.ROOT / 'build' / 'ui-update-files.json').read_text(encoding='utf-8'))
        self.assertEqual(build_desktop.MODULES.count('scene-gift-icons.mjs'), 1)
        self.assertEqual(updates.count('app/scene-gift-icons.mjs'), 1)
        self.assertEqual(len(updates), 41)
        self.assertEqual(len(set(updates)), 41)

    def test_clean_zip_allows_only_explicit_modules_and_locked_collector_resources(self):
        helper = clean_zip_helper()
        old_files = {'AvatarPrinter.exe', *(f'app/existing-{index}.mjs' for index in range(170))}
        new_module = 'app/scene-gift-icons.mjs'
        current_files = old_files | {new_module}
        self.assertEqual(len(old_files) + 1, 172)  # Archive also contains its manifest.
        self.assertEqual(len(current_files) + 1, 173)
        self.assertEqual(helper.EXPECTED_UI_FILES, 41)
        self.assertEqual(helper.allowlist_additions(old_files, current_files, [new_module]), {new_module})
        self.assertEqual(helper.allowlist_additions(current_files, current_files, [new_module]), set())
        additions = helper.approved_additions()
        self.assertIn('app/node_modules/ws/package.json', additions)
        self.assertIn('app/third_party/douyin-sign/LICENSE', additions)
        self.assertEqual(helper.allowlist_additions(old_files, old_files | additions, list(additions)), additions)

    def test_collector_package_is_self_contained_without_profiles_or_credentials(self):
        resources = build_desktop.collector_resources()
        self.assertEqual(len(resources), len(set(resources)))
        required = {'package.json', 'package-lock.json', 'THIRD-PARTY-NOTICES.md',
                    'third_party/douyin-sign/sign.js', 'third_party/douyin-sign/DYHUB-LICENSE',
                    'third_party/douyin-sign/LICENSE', 'node_modules/ws/wrapper.mjs',
                    'node_modules/protobufjs/src/reader.js', 'node_modules/long/umd/index.js'}
        self.assertTrue(required <= set(resources))
        self.assertEqual({name.split('/')[1] for name in resources if name.startswith('node_modules/')},
                         set(build_desktop.NODE_RUNTIME_PACKAGES))
        helper = clean_zip_helper()
        for name in resources:
            self.assertEqual(helper.clean_relative('app/' + name), 'app/' + name)

    def test_clean_zip_rejects_other_additions_removals_or_an_unlisted_new_module(self):
        helper = clean_zip_helper()
        old_files = {'AvatarPrinter.exe', 'app/live-view.html'}
        new_module = 'app/scene-gift-icons.mjs'
        for current, updates in [
            (old_files | {new_module, 'app/unapproved.mjs'}, [new_module, 'app/unapproved.mjs']),
            ((old_files - {'app/live-view.html'}) | {new_module}, [new_module]),
            (old_files | {new_module}, []),
        ]:
            with self.subTest(current=current, updates=updates), self.assertRaises(ValueError):
                helper.allowlist_additions(old_files, current, updates)

    def test_clean_zip_still_refuses_local_profiles_and_developer_files(self):
        helper = clean_zip_helper()
        for name in ['profiles/browser/Preferences', 'app/my-profile/Cookies',
                     'app/EBWebView/Default/Cookies', 'app/logs/scene.log',
                     'app/local.webview2/Cookies', 'app/test_scene.py', 'app/py-spy.exe',
                     'app/.collector-auth.bin', 'app/.collector-auth.bin.abc.tmp']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                helper.clean_relative(name)

    def test_frozen_child_window_uses_executable_and_selected_port(self):
        api = launch.DesktopApi()
        with patch.object(launch, 'FROZEN', True), patch.object(launch, 'ACTIVE_PORT', 8181), \
                patch.object(launch.subprocess, 'Popen') as popen:
            api.open_scene_window(orient='portrait')
        command = popen.call_args.args[0]
        self.assertEqual(command[0], launch.sys.executable)
        self.assertNotIn(str(launch.ROOT / 'launch.py'), command)
        self.assertEqual(command[command.index('--server-port') + 1], '8181')
        self.assertEqual(command[command.index('--scene-orient') + 1], 'portrait')

    def test_bundled_node_works_without_system_path(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / 'runtime'
            runtime.mkdir()
            node = runtime / 'node.exe'
            node.touch()
            with patch.object(launch, 'APP_DIR', Path(directory)), patch.object(launch.shutil, 'which', return_value=None):
                self.assertEqual(launch.node_executable(), str(node))

    def test_busy_ports_preserve_fallback_and_resource_root(self):
        original_port = launch.ACTIVE_PORT
        try:
            with patch.object(launch, 'listening', side_effect=[True, True, False]), \
                    patch.object(launch, 'local_get', side_effect=OSError), \
                    patch.object(launch, 'ThreadingHTTPServer') as server_class, \
                    patch.object(launch.threading, 'Thread'):
                url, _ = launch.ensure_server()
            self.assertEqual(url, 'http://127.0.0.1:8181/')
            self.assertEqual(server_class.call_args.args[0], ('127.0.0.1', 8181))
            self.assertEqual(server_class.call_args.args[1].keywords['directory'], str(launch.ROOT))
        finally:
            launch.ACTIVE_PORT = original_port

    def test_another_installation_is_not_reused(self):
        original_port = launch.ACTIVE_PORT
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({'service': 'avatar-printer-desktop', 'root': 'C:/other-install'}).encode()
        try:
            with patch.object(launch, 'listening', side_effect=[True, False]), \
                    patch.object(launch, 'local_get', return_value=response), \
                    patch.object(launch, 'ThreadingHTTPServer') as server_class, \
                    patch.object(launch.threading, 'Thread'):
                launch.ensure_server()
            self.assertEqual(server_class.call_args.args[0], ('127.0.0.1', 8081))
        finally:
            launch.ACTIVE_PORT = original_port


if __name__ == '__main__':
    unittest.main()
