"""Controls for stronger native acceptance and private startup observations."""
import io
from pathlib import Path
import re
import runpy
import unittest

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

    def test_ios_requires_actual_software_keyboard_and_unobscured_input(self):
        source = (ROOT / 'apps/mobile/ios/BridgeNativeUITests/ServerConnectionJourneyTests.swift').read_text()
        workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
        self.assertIn('XCTAssertTrue(keyboard.waitForExistence(timeout: 5)', source)
        self.assertIn('input.isHittable && input.frame.maxY <= keyboard.frame.minY', source)
        self.assertIn('XCTAssertEqual(XCTWaiter.wait(for: [visibleInput], timeout: 5), .completed,', source)
        self.assertIn('XCTAssertEqual(input.value as? String, address,', source)
        self.assertIn('ConnectHardwareKeyboard -bool false', workflow)
        actions = re.findall(r'print\("BRIDGE_NATIVE_JOURNEY_ACTION=([^\"]+)"\)', source)
        self.assertEqual(set(actions), SCOPE['ACTIONS'])

    def test_android_observation_is_test_only_and_jvm_gate_counts_every_new_test(self):
        gradle = (ROOT / 'apps/mobile/android/app/build.gradle').read_text()
        workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
        support = ROOT / 'apps/mobile/android/app/src/testSupport/java/com/bridge/nativepreview/NativeStartupObservation.kt'
        unit = (ROOT / 'apps/mobile/android/app/src/test/java/com/bridge/nativepreview/NativeStartupObservationTest.kt').read_text()
        self.assertTrue(support.is_file())
        self.assertIn("test.java.srcDir 'src/testSupport/java'", gradle)
        self.assertIn("androidTest.java.srcDir 'src/testSupport/java'", gradle)
        self.assertNotIn("main.java.srcDir 'src/testSupport/java'", gradle)
        self.assertEqual(unit.count('@Test fun '), 4)
        self.assertIn('testDebugUnitTest --expected 6', workflow)

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
