"""P8 native CI bootstrap regression controls (stdlib-only, no network)."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]


class NativeBootstrapContracts(unittest.TestCase):
    def test_android_setup_does_not_request_retired_tools_package(self):
        workflow = (ROOT / ".github/workflows/mobile-react-native.yml").read_text()
        self.assertIn("uses: android-actions/setup-android@v3", workflow)
        self.assertIn("packages: 'platform-tools'", workflow)
        self.assertNotRegex(workflow, r"packages:\s*['\"]?tools(?:\s|['\"]|$)")
        self.assertIn("sdkmanager --channel=3 --install 'platforms;android-37.0' 'build-tools;37.0.0' 'ndk;27.1.12297006'", workflow)

    def test_native_backend_uses_real_postgres_and_fails_closed(self):
        script = (ROOT / "apps/mobile/scripts/start-ci-backend.sh").read_text()
        self.assertIn(
            "NODE_ENV=development HOST=127.0.0.1 node server/dist/index.js",
            script,
        )
        self.assertIn('if ! kill -0 "$backend_pid" 2>/dev/null; then', script)
        self.assertIn('report_backend_failure "process-exited-before-ready"', script)
        self.assertIn('report_backend_failure "readiness-timeout"', script)
        # Never dump unfiltered private backend logs into public CI output.
        self.assertNotIn('cat apps/mobile/.ci-results/bridge.log', script)
        self.assertNotIn('tail -40 apps/mobile/.ci-results/bridge.log', script)

    def test_metro_has_bounded_fail_closed_readiness_and_private_diagnostics(self):
        workflow = (ROOT / ".github/workflows/mobile-react-native.yml").read_text()
        script = (ROOT / "apps/mobile/scripts/start-ci-metro.sh").read_text()
        self.assertEqual(workflow.count("bash apps/mobile/scripts/start-ci-metro.sh"), 2)
        self.assertIn("NODE_ENV=development npm start -- --port 8081", script)
        self.assertIn("record_failure \"process-exited-before-ready\"", script)
        self.assertIn("record_failure \"readiness-timeout\"", script)
        self.assertIn("status=FAIL", script)
        self.assertIn("include-hidden-files: true", workflow)
        self.assertNotIn("            apps/mobile/.ci-results/\\n", workflow)
        self.assertNotIn('cat "$log"', script)
        self.assertNotIn('tail -40 "$log"', script)


if __name__ == "__main__":
    unittest.main()
