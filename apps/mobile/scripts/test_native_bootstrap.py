"""P8 native CI bootstrap regression controls (stdlib-only, no network)."""
from pathlib import Path
import io
import runpy
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

    def test_emulator_runner_retains_gradle_directory_and_native_result_gate(self):
        workflow = (ROOT / ".github/workflows/mobile-react-native.yml").read_text()
        script = (ROOT / "apps/mobile/scripts/run-android-native-journey.sh").read_text()
        self.assertIn("script: bash apps/mobile/scripts/run-android-native-journey.sh", workflow)
        self.assertNotIn("script: |\\n            adb reverse tcp:8081", workflow)
        self.assertIn("cd apps/mobile/android", script)
        self.assertIn("./gradlew --no-daemon", script)
        self.assertIn("verify_native_results.py", script)
        self.assertIn("set -euo pipefail", script)

    def test_xcode_failure_reports_redacted_reason_without_raw_logs(self):
        workflow = (ROOT / ".github/workflows/mobile-react-native.yml").read_text()
        self.assertIn("summarize_xcode_failure.py", workflow)
        self.assertIn("runs-on: macos-26", workflow)
        self.assertIn("React Native 0.88 requires Xcode 26 or newer", workflow)
        # Xcode rejects -test-iterations 1. A single test action is one pass.
        self.assertNotIn('-test-iterations 1 CODE_SIGNING_ALLOWED', workflow)
        self.assertIn('-parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test', workflow)
        self.assertIn('exit "$xcode_status"', workflow)
        self.assertIn("apps/mobile/.ci-results/xcode-diagnostic.txt", workflow)
        scope = runpy.run_path(str(ROOT / "apps/mobile/scripts/summarize_xcode_failure.py"))

        class InMemoryLog:
            def open(self, **_kwargs):
                return io.StringIO(
                    "xcodebuild: error: scheme BridgeNative not configured for test "
                    "user@example.com /Users/runner/private/demo "
                    "https://example.com/private\\n"
                )

        result = scope["summarize"](InMemoryLog(), "64")
        self.assertIn("category=scheme", result)
        self.assertIn("xcodebuild-exit-status=64", result)
        self.assertIn("[redacted-email]", result)
        self.assertIn("[redacted-runner-path]", result)
        self.assertIn("[redacted-url]", result)
        self.assertNotIn("user@example.com", result)
        self.assertNotIn("/Users/runner/private", result)
        self.assertNotIn("https://example.com/private", result)

        class DuplicateOutput:
            def open(self, **_kwargs):
                return io.StringIO(
                    "error: Multiple commands produce "
                    "'/Users/runner/secret/Build/BridgeNative.app/Info.plist'\n"
                )

        collision = scope["summarize"](DuplicateOutput(), "65")
        self.assertIn("category=duplicate-build-output", collision)
        self.assertIn("[redacted-runner-path]/Info.plist", collision)
        self.assertNotIn("/Users/runner/secret", collision)

        class LongUITestError:
            def open(self, **_kwargs):
                return io.StringIO(
                    "error: XCTest failed: " + ("element state; " * 30)
                    + "input was not hittable for keyboard focus\n"
                )

        ui_error = scope["summarize"](LongUITestError(), "65")
        self.assertIn("[middle omitted]", ui_error)
        self.assertIn("not hittable for keyboard focus", ui_error)
        self.assertLess(len(ui_error), 500)

        class UnquotedRunnerPath:
            def open(self, **_kwargs):
                return io.StringIO(
                    "error: -[BridgeNativeUITests.ServerConnectionJourneyTests] "
                    "/Users/runner/work/Bridge/Bridge/ServerConnectionJourneyTests.swift:42: "
                    + ("element description " * 15)
                    + "Failed to tap text field due to no keyboard focus\n"
                )

        unquoted = scope["summarize"](UnquotedRunnerPath(), "65")
        self.assertIn("Failed to tap text field due to no keyboard focus", unquoted)
        self.assertNotIn("/Users/runner/work", unquoted)
        self.assertLess(len(unquoted), 500)

    def test_ios_ui_test_bundle_has_unique_named_product(self):
        project = (
            ROOT / "apps/mobile/ios/BridgeNative.xcodeproj/project.pbxproj"
        ).read_text()
        self.assertEqual(project.count("PRODUCT_NAME = BridgeNativeUITests;"), 2)
        self.assertIn("productName = BridgeNativeUITests;", project)
        self.assertIn("productType = \"com.apple.product-type.bundle.ui-testing\";", project)


    def test_ios_uses_tested_podfile_lock_in_deployment_mode(self):
        workflow = (ROOT / ".github/workflows/mobile-react-native.yml").read_text()
        lock = (ROOT / "apps/mobile/ios/Podfile.lock").read_text()
        gems = (ROOT / "apps/mobile/Gemfile.lock").read_text()
        self.assertTrue(lock.startswith("PODS:\n"))
        self.assertRegex(lock, r"(?m)^PODFILE CHECKSUM: [0-9a-f]{40}$")
        self.assertRegex(lock, r"(?m)^COCOAPODS: 1\.17\.0$")
        self.assertIn("    cocoapods (1.17.0)", gems)
        self.assertIn("test -s Podfile.lock", workflow)
        self.assertIn("bundle exec pod install --deployment", workflow)
        self.assertIn("git diff --exit-code -- Podfile.lock", workflow)
        self.assertNotIn("          bundle exec pod install\n", workflow)


if __name__ == "__main__":
    unittest.main()
