import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("headless", Path(__file__).with_name("macos-headless-backend.py"))
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class Response(io.BytesIO):
    status = 200


class HeadlessBackendTests(unittest.TestCase):
    def test_desktop_bootstrap_cannot_override_the_restored_backend(self):
        env = backend.backend_environment({
            "HOME": "/Users/test", "PATH": "/bin", "VITE_HTTP_URL": "http://wrong",
            "VITE_WS_URL": "ws://wrong", "T3CODE_BOOTSTRAP_FD": "3", "NODE_OPTIONS": "--inspect",
            "ELECTRON_RUN_AS_NODE": "0", "T3CODE_TAILSCALE_SERVE": "true",
        })
        self.assertEqual(env["HOME"], "/Users/test")
        self.assertNotIn("T3CODE_BOOTSTRAP_FD", env)
        self.assertNotIn("VITE_HTTP_URL", env)
        self.assertNotIn("VITE_WS_URL", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertEqual(env["ELECTRON_RUN_AS_NODE"], "1")
        self.assertEqual(env["T3CODE_TAILSCALE_SERVE"], "false")

    def run_launch(self, descriptor, addresses="n127.0.0.1:3773\n", pid="123"):
        clock = [0]
        def advance(seconds):
            clock[0] += seconds
        with patch.object(backend.subprocess, "Popen") as start, \
             patch.object(backend.subprocess, "check_output", return_value="p" + pid + "\n" + addresses), \
             patch.object(backend.urllib.request, "build_opener") as opener, \
             patch.object(backend.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(backend.time, "sleep", side_effect=advance), contextlib.redirect_stdout(io.StringIO()) as output:
            start.return_value.pid = 123
            start.return_value.poll.return_value = None
            opener.return_value.open.side_effect = lambda url, **kwargs: Response(
                json.dumps(descriptor).encode() if url.endswith('/environment') else b'{"private":"not-for-logs"}')
            result = backend.launch(Path("/Applications/Old.app/Contents/MacOS/Old"),
                                    Path("/Applications/Old.app/Contents/Resources/app.asar/server.mjs"),
                                    Path("/Users/test/.t3"), 3773, "expected", 15)
            return result, start.call_args, output.getvalue(), opener.return_value.open.call_count, start.return_value.terminate.called

    def test_recovers_only_the_expected_loopback_environment_without_a_window(self):
        result, call, output, requests, stopped = self.run_launch({"environmentId": "expected"})
        self.assertEqual(result, 0)
        self.assertEqual(requests, 2)
        self.assertFalse(stopped)
        self.assertTrue(call.kwargs["start_new_session"])
        self.assertEqual(call.kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(call.kwargs["stderr"], subprocess.DEVNULL)
        self.assertIn("--no-browser", call.args[0])
        self.assertNotIn("not-for-logs", output)
        self.assertEqual(json.loads(output.splitlines()[-1])["status"], "healthy")

    def test_wrong_environment_never_passes_health_or_opens_the_desktop(self):
        result, _, output, requests, stopped = self.run_launch({"environmentId": "different"})
        self.assertEqual(result, 1)
        self.assertGreater(requests, 0)
        self.assertTrue(stopped)

    def test_a_nonloopback_listener_never_passes_health(self):
        result, _, output, requests, stopped = self.run_launch({"environmentId": "expected"}, "n*:3773\n")
        self.assertEqual(result, 1)
        self.assertEqual(requests, 0)
        self.assertTrue(stopped)
        self.assertEqual(json.loads(output.splitlines()[-1])["status"], "unhealthy")

    def test_another_pid_cannot_satisfy_the_backend_health_check(self):
        result, _, _, requests, stopped = self.run_launch({"environmentId": "expected"}, pid="456")
        self.assertEqual(result, 1)
        self.assertEqual(requests, 0)
        self.assertTrue(stopped)

    def test_nonobject_environment_descriptors_fail_with_a_receipt(self):
        for descriptor in [None, [], "expected"]:
            with self.subTest(descriptor=descriptor):
                result, _, output, _, stopped = self.run_launch(descriptor)
                self.assertEqual(result, 1)
                self.assertTrue(stopped)
                self.assertEqual(json.loads(output.splitlines()[-1])["status"], "unhealthy")


if __name__ == "__main__":
    unittest.main()
