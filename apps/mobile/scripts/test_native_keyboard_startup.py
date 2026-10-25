"""Controls for stronger native acceptance and private startup observations."""
import io
import json
from pathlib import Path
import re
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SCOPE = runpy.run_path(str(ROOT / 'apps/mobile/scripts/summarize_xcode_failure.py'))


class NativeKeyboardStartupTests(unittest.TestCase):
    def test_rejected_keyboard_events_have_fixed_reason_codes(self):
        for message, expected in [
            ('Failed to synthesize event: Neither element nor any descendant has keyboard focus', 'keyboard-focus-absent'),
            ('Failed to scroll to visible (by AX action)', 'scroll-to-visible-failed'),
            ('Failed to synthesize event: private payload', 'input-event-rejected'),
            ('Software keyboard is not visible', 'keyboard-not-visible'),
            ('Server field is covered by software keyboard', 'input-covered-by-keyboard'),
        ]:
            with self.subTest(reason=expected):
                class Log:
                    def open(self, **_kwargs):
                        return io.StringIO('error: ' + message + ' private-token\n')
                report = SCOPE['summarize'](Log(), '65')
                self.assertIn('error-1-reason=' + expected, report)
                self.assertNotIn('private', report)

    def test_action_markers_cannot_publish_ui_input_or_unknown_actions(self):
        class Log:
            def open(self, **_kwargs):
                return io.StringIO('BRIDGE_NATIVE_JOURNEY_ACTION=input-type\n'
                                   'BRIDGE_NATIVE_JOURNEY_ACTION=private-account\n'
                                   'error: failed to synthesize event private-key\n')
        report = SCOPE['summarize'](Log(), '65')
        self.assertIn('error-1-action=input-type', report)
        self.assertNotIn('private', report)

    def test_failure_observations_publish_only_known_surface_and_element_codes(self):
        class Log:
            def open(self, **_kwargs):
                return io.StringIO('BRIDGE_NATIVE_INPUT_KIND=other\n'
                                   'BRIDGE_NATIVE_INPUT_KIND=private-identifier\n'
                                   'BRIDGE_NATIVE_SURFACE=module-error\n'
                                   'BRIDGE_NATIVE_SURFACE=private-credential\n')
        report = SCOPE['summarize'](Log(), '65')
        self.assertIn('input-kind=other', report)
        self.assertIn('surface=module-error', report)
        self.assertNotIn('private', report)
        self.assertIn('status=FAIL', report)

    def test_structured_failure_classifies_multiline_query_without_publishing_values(self):
        payload = {'testFailures': [{
            'failureText': 'Failed to get matching snapshot: No matches found\n'
                           'Find TextField server-url-input\n'
                           'file:///private/medical-note account=private-actor token=private-key',
            'testName': 'private-test-name',
            'sourceLocation': 'private-source-path',
        }], 'environment': 'private-runner-account'}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private-result.json'
            path.write_text(json.dumps(payload))
            report = SCOPE['xcresult_evidence'](path)
        self.assertEqual(report, ['xcresult-status=available', 'xcresult-failures=1',
                                 'xcresult-scan-truncated=false',
                                 'xcresult-reasons=element-not-found',
                                 'query-targets=server-address-input'])
        self.assertNotIn('private', '\n'.join(report))

    def test_structured_failure_does_not_classify_arbitrary_metadata_as_a_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'summary.json'
            path.write_text(json.dumps({'testFailures': [{
                'testName': 'Failed to type private-key into server-url-input',
                'failureText': 'private-unrecognized-error'}]}))
            report = SCOPE['xcresult_evidence'](path)
        self.assertIn('xcresult-reasons=unclassified', report)
        self.assertIn('query-targets=unclassified', report)
        self.assertNotIn('private', '\n'.join(report))

    def test_structured_failure_budget_and_marker_limit_are_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'summary.json'
            path.write_text(json.dumps({'testFailures': [{'failureText': 'private'}] * 4 +
                                                       [{'failureText': 'Failed to type connect-button'}]}))
            report = SCOPE['xcresult_evidence'](path)
            self.assertIn('xcresult-failures=5', report)
            self.assertIn('xcresult-scan-truncated=true', report)
            self.assertIn('query-targets=unclassified', report)
            self.assertIn('xcresult-reasons=unclassified', report)
            path.write_text('x' * (SCOPE['MAX_XCRESULT_CHARS'] + 1))
            self.assertEqual(SCOPE['xcresult_evidence'](path), ['xcresult-status=oversized'])

    def test_missing_malformed_and_deep_private_json_fail_closed_without_exception_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private-result.json'
            self.assertEqual(SCOPE['xcresult_evidence'](path), ['xcresult-status=unavailable'])
            for content, status in [('private-invalid-json', 'unavailable'),
                                    ('[]', 'malformed'), ('{}', 'malformed'),
                                    ('{"testFailures": ["private"]}', 'malformed')]:
                with self.subTest(status=status):
                    path.write_text(content)
                    self.assertEqual(SCOPE['xcresult_evidence'](path), ['xcresult-status=' + status])

    def test_private_parser_recursion_failure_cannot_escape_as_a_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private-result.json'
            path.write_text('{}')
            with patch.object(SCOPE['json'], 'loads', side_effect=RecursionError('private-parser-details')):
                self.assertEqual(SCOPE['xcresult_evidence'](path), ['xcresult-status=unavailable'])

    def test_launch_observation_does_not_replace_the_original_form_acceptance(self):
        source = (ROOT / 'apps/mobile/ios/BridgeNativeUITests/ServerConnectionJourneyTests.swift').read_text()
        self.assertIn('let input = app.textFields["server-url-input"]', source)
        self.assertIn('let formMatches = input.waitForExistence(timeout: 60)', source)
        self.assertIn('if !formMatches {', source)
        self.assertIn('XCTAssertTrue(formMatches, "Native form did not launch")', source)
        observation = source[source.index('func reportMissingForm()'):source.index('print("BRIDGE_NATIVE_JOURNEY_ACTION=app-launch")')]
        for forbidden in ('.tap(', '.launch(', '.activate(', 'debugDescription', 'print(candidate'):
            self.assertNotIn(forbidden, observation)

    def test_private_xcresult_summary_is_not_in_the_artifact_allowlist(self):
        workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
        upload = workflow[workflow.index('name: p8-ios-native-evidence'):workflow.index('- name: Stop disposable services', workflow.index('name: p8-ios-native-evidence'))]
        self.assertNotIn('xcode-private-summary.json', upload)
        self.assertNotIn('xcodebuild.log', upload)
        self.assertNotIn('native-journey.xcresult', upload)
        self.assertNotIn('apps/mobile/.ci-results/\n', upload)

    def test_ios_requires_actual_software_keyboard_and_unobscured_input(self):
        source = (ROOT / 'apps/mobile/ios/BridgeNativeUITests/ServerConnectionJourneyTests.swift').read_text()
        workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
        self.assertIn('XCTAssertTrue(keyboard.waitForExistence(timeout: 5)', source)
        self.assertIn('input.isHittable && input.frame.maxY <= keyboard.frame.minY', source)
        self.assertIn('XCTAssertEqual(XCTWaiter.wait(for: [visibleInput], timeout: 5), .completed,', source)
        self.assertIn('XCTAssertEqual(typedValue, address,', source)
        self.assertIn('ConnectHardwareKeyboard -bool false', workflow)
        actions = re.findall(r'print\("BRIDGE_NATIVE_JOURNEY_ACTION=([^\"]+)"\)', source)
        self.assertEqual(set(actions), SCOPE['ACTIONS'])

    def test_input_mismatch_publishes_only_shape_bounded_lengths_and_settling_flag(self):
        class Log:
            def open(self, **_kwargs):
                return io.StringIO('BRIDGE_NATIVE_INPUT_VALUE=expected-prefix;length=11;expected-length=26;settled=true\n'
                                   'error: XCTAssertEqual failed private-input-value\n')
        report = SCOPE['summarize'](Log(), '65')
        for field in ('input-value-shape=expected-prefix', 'input-value-length=11',
                      'input-expected-length=26', 'input-value-settled=true', 'status=FAIL'):
            self.assertIn(field, report)
        self.assertNotIn('private', report)

    def test_unknown_shapes_excessive_lengths_and_injected_flags_cannot_enter_evidence(self):
        for marker in ('private-value;length=1;expected-length=26;settled=true',
                       'other;length=999;expected-length=26;settled=false',
                       'other;length=1;expected-length=999;settled=false',
                       'other;length=1;expected-length=26;settled=private-token'):
            with self.subTest(marker=marker.split(';')[0]):
                class Log:
                    def open(self, **_kwargs):
                        return io.StringIO('BRIDGE_NATIVE_INPUT_VALUE=' + marker + '\n')
                report = SCOPE['summarize'](Log(), '65')
                self.assertNotIn('input-value-', report)
                self.assertNotIn('private', report)

    def test_settling_observation_does_not_replace_a_failed_immediate_value(self):
        source = (ROOT / 'apps/mobile/ios/BridgeNativeUITests/ServerConnectionJourneyTests.swift').read_text()
        self.assertLess(source.index('let typedValue = input.value as? String'),
                        source.index('let settled = XCTWaiter.wait'))
        self.assertLess(source.index('let settled = XCTWaiter.wait'),
                        source.index('XCTAssertEqual(typedValue, address,'))
        self.assertEqual(source.count('input.typeText(address)'), 1)
        self.assertNotIn('XCTAssertTrue(settled', source)

    def test_android_observation_is_test_only_and_jvm_gate_counts_every_new_test(self):
        gradle = (ROOT / 'apps/mobile/android/app/build.gradle').read_text()
        workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
        support = ROOT / 'apps/mobile/android/app/src/testSupport/java/com/bridge/nativepreview/NativeStartupObservation.kt'
        unit = (ROOT / 'apps/mobile/android/app/src/test/java/com/bridge/nativepreview/NativeStartupObservationTest.kt').read_text()
        self.assertTrue(support.is_file())
        self.assertIn("test.java.srcDir 'src/testSupport/java'", gradle)
        self.assertIn("androidTest.java.srcDir 'src/testSupport/java'", gradle)
        self.assertNotIn("main.java.srcDir 'src/testSupport/java'", gradle)
        self.assertEqual(unit.count('@Test fun '), 5)
        self.assertEqual(workflow.count('testDebugUnitTest --expected 7'), 2)

    def test_android_checks_runner_preconditions_without_automatic_foreground_or_retry(self):
        source = (ROOT / 'apps/mobile/android/app/src/androidTest/java/com/bridge/nativepreview/ServerConnectionJourneyTest.kt').read_text()
        self.assertIn('NativeStartupFailure.SCREEN_UNAVAILABLE', source)
        self.assertIn('NativeStartupFailure.KEYGUARD_NOT_UNLOCKED', source)
        self.assertIn('requireStartup(formVisible == true,', source)
        self.assertIn('device.wait(Until.hasObject(By.desc("Server address")), 60_000)', source)
        for forbidden in ('dismissKeyguard', 'wakeUp()', 'pressMenu()', 'Thread.sleep', 'retry('):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__':
    unittest.main()
