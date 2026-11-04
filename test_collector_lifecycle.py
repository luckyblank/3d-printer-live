"""Owned-process lifecycle only; fake children and temporary encrypted state."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

import collector_auth as auth
from test_collector_auth import cookies, store_at


class FakeProcess:
    def __init__(self, pid):
        self.pid, self.alive, self.code = pid, True, 0
        self.terminated = self.killed = False
        self.timeout = False

    def poll(self):
        return None if self.alive else self.code

    def wait(self, timeout=None):
        if self.timeout and self.alive:
            raise subprocess.TimeoutExpired('fictional-child', timeout)
        self.alive = False
        return self.code

    def terminate(self):
        self.terminated, self.alive = True, False

    def kill(self):
        self.killed, self.alive = True, False


class CollectorLifecycleTests(unittest.TestCase):
    def controller(self, directory, **kwargs):
        created, tasks = [], []
        def popen(command, **options):
            process = FakeProcess(500 + len(created))
            created.append((process, command, options))
            return process
        store = store_at(directory)
        controller = auth.CollectorController(directory,
            lambda room, request: ['app.exe', '--live-room', room, '--auth-request', request],
            lambda room: ['node.exe', 'douyin-bridge.mjs', room],
            lambda process: {'ok': True, 'port': 8765, 'url': 'ws://127.0.0.1:8765',
                             'collectorStatus': 'connecting', 'pid': process.pid},
            store=store, popen=popen, launch_thread=tasks.append,
            environment=lambda: {'PRINTER_CDP_PORT': '9224', 'PRINTER_COLLECTOR': 'cdp',
                                 'PRINTER_DOUYIN_COOKIE': 'old-inherited',
                                 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS': '--remote-debugging-port=9224 --keep'},
            **kwargs)
        return controller, store, created, tasks

    def test_capture_without_credentials_requires_login_without_starting_any_process(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, store, created, tasks = self.controller(directory)
            with self.assertRaises(auth.CollectorError) as error:
                controller.start_capture('12345')
            self.assertEqual(error.exception.code, 'LOGIN_REQUIRED')
            self.assertEqual(created, [])
            self.assertTrue(controller.auth_status()['needsLogin'])

    def test_saved_credentials_start_without_a_login_window_and_only_go_in_child_env(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, store, created, tasks = self.controller(directory)
            record = store.save(cookies(), 'existing')
            status = controller.start_capture('12345')
            self.assertEqual(len(created), 1)
            process, command, options = created[0]
            self.assertEqual(command, ['node.exe', 'douyin-bridge.mjs', '12345'])
            self.assertEqual(options['env']['PRINTER_COLLECTOR'], 'lightweight')
            self.assertEqual(options['env']['PRINTER_DOUYIN_COOKIE'], record.cookie_header)
            self.assertNotIn('PRINTER_CDP_PORT', options['env'])
            self.assertNotIn('sessionid', ' '.join(command))
            self.assertEqual(tasks, [])
            self.assertEqual(status['pid'], process.pid)
            self.assertIsNone(controller._login)

    def test_login_child_has_no_cookie_or_debug_port_and_duplicate_request_does_not_spawn(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, store, created, tasks = self.controller(directory)
            controller.open_login('12345')
            controller.open_login('12345')
            self.assertEqual(len(created), 1)
            self.assertEqual(len(tasks), 1)
            _, command, options = created[0]
            self.assertEqual(command[1:3], ['--live-room', '12345'])
            self.assertIn('--auth-request', command)
            self.assertNotIn('PRINTER_DOUYIN_COOKIE', options['env'])
            self.assertNotIn('PRINTER_CDP_PORT', options['env'])
            self.assertNotIn('remote-debugging-port', options['env']['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'])
            self.assertTrue(controller.auth_status()['loginInProgress'])

    def test_successful_login_closes_progress_and_a_later_login_can_be_started(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, store, created, tasks = self.controller(directory)
            controller.open_login('12345')
            store.save(cookies(), controller._request_id)
            tasks.pop(0)()
            status = controller.auth_status()
            self.assertTrue(status['loggedIn'])
            self.assertFalse(status['loginInProgress'])
            self.assertIsNone(status['error'])
            self.assertNotIn('cookie', str(status).lower())
            controller.open_login('12345')
            self.assertEqual(len(created), 2)
            self.assertTrue(controller.auth_status()['loginInProgress'])

    def test_relogin_restarts_only_owned_running_bridge_with_new_cookie_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, store, created, tasks = self.controller(directory)
            store.save(cookies('old-session'), 'old')
            controller.start_capture('12345')
            old_bridge = created[0][0]
            controller.open_login('12345')
            self.assertFalse(old_bridge.terminated)
            store.save(cookies('new-session'), controller._request_id)
            tasks.pop(0)()
            self.assertTrue(old_bridge.terminated)
            self.assertEqual(len(created), 3)
            self.assertIn('new-session', created[-1][2]['env']['PRINTER_DOUYIN_COOKIE'])
            self.assertNotIn('old-session', created[-1][2]['env']['PRINTER_DOUYIN_COOKIE'])

    def test_cancel_keeps_saved_auth_and_original_bridge_and_timeout_is_safe(self):
        for timeout, expected in ((False, 'LOGIN_CANCELLED'), (True, 'LOGIN_TIMEOUT')):
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as directory:
                controller, store, created, tasks = self.controller(directory)
                store.save(cookies('old-session'), 'old')
                original = store.path.read_bytes()
                controller.start_capture('12345')
                old_bridge = created[0][0]
                controller.open_login('12345')
                login = created[-1][0]
                login.code = 2
                login.timeout = timeout
                tasks.pop(0)()
                self.assertEqual(controller.auth_status()['errorCode'], expected)
                self.assertTrue(controller.auth_status()['loggedIn'])
                self.assertEqual(store.path.read_bytes(), original)
                self.assertFalse(old_bridge.terminated)
                self.assertEqual(len(created), 2)
                if timeout:
                    self.assertTrue(login.terminated)

    def test_a_stale_record_from_an_earlier_request_does_not_complete_this_login(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, store, created, tasks = self.controller(directory)
            store.save(cookies(), 'other-request')
            controller.open_login('12345')
            tasks[0]()
            self.assertEqual(controller.auth_status()['errorCode'], 'LOGIN_CANCELLED')

    def test_stop_and_close_keep_auth_file_and_prevent_late_login_from_restarting(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, store, created, tasks = self.controller(directory)
            store.save(cookies(), 'old')
            controller.start_capture('12345')
            bridge = created[0][0]
            controller.stop_capture()
            self.assertTrue(bridge.terminated)
            self.assertTrue(store.status()['loggedIn'])
            controller.start_capture('12345')
            second_bridge = created[-1][0]
            controller.open_login('12345')
            login = created[-1][0]
            store.save(cookies('refreshed'), controller._request_id)
            controller.close()
            count = len(created)
            tasks.pop(0)()
            self.assertEqual(len(created), count)
            self.assertTrue(login.terminated)
            self.assertTrue(second_bridge.terminated)
            self.assertTrue(store.status()['loggedIn'])
            self.assertFalse(controller.auth_status()['loginInProgress'])
            with self.assertRaises(auth.CollectorError):
                controller.start_capture('12345')

    def test_start_retries_failed_owned_collector_but_reuses_active_connection_states(self):
        for phase in ('error', 'offline', 'stopped', 'connected', 'connecting', 'reconnecting'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                probe = Mock(side_effect=lambda pid: {'ok': True, 'port': 8765, 'pid': pid, 'collectorStatus': phase})
                controller, store, created, tasks = self.controller(directory, probe_status=probe)
                store.save(cookies(), 'auth')
                controller.start_capture('12345')
                first = created[0][0]
                controller.start_capture('67890')
                retry = phase in ('error', 'offline', 'stopped')
                self.assertEqual(len(created), 2 if retry else 1)
                self.assertEqual(first.terminated, retry)
                self.assertEqual((Path(directory) / '.bridge-room').read_text(), '67890')

    def test_bridge_failure_terminates_only_owned_child_and_never_leaks_exception_cookie(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, store, created, tasks = self.controller(directory)
            store.save(cookies(), 'auth')
            controller.wait_ready = Mock(side_effect=RuntimeError('do-not-leak-unit-secret'))
            with self.assertRaises(auth.CollectorError) as error:
                controller.start_capture('12345')
            self.assertEqual(error.exception.code, 'BRIDGE_START_FAILED')
            self.assertNotIn('do-not-leak', str(error.exception))
            self.assertTrue(created[0][0].terminated)
            self.assertEqual(controller.bridge_status(), {'ok': False})


if __name__ == '__main__':
    unittest.main()
