"""Closed observation records supplement the real XCTest; they never replace it."""
import io
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
REPORTER = ROOT / 'apps/mobile/scripts/summarize_xcode_failure.py'
SCOPE = runpy.run_path(str(REPORTER))


class Log:
    def __init__(self, value):
        self.value = value

    def open(self, **_kwargs):
        return io.StringIO(self.value)


def attempt(ui_focus='false', verified=True, after_focus='false'):
    return ('BRIDGE_NATIVE_JOURNEY_ACTION=input-focus\n'
            'BRIDGE_NATIVE_JOURNEY_ACTION=input-focus-observe\n'
            'BRIDGE_NATIVE_UI_FOCUS=' + ui_focus + '\n'
            'BRIDGE_NATIVE_JOURNEY_ACTION=input-type\n' +
            ('BRIDGE_NATIVE_KEYBOARD_INPUT=first-character-verified;ui-focus=' + after_focus + '\n' if verified else ''))


class NativeKeyboardEvidenceTests(unittest.TestCase):
    def test_ui_focus_false_and_verified_real_key_are_distinct_observations(self):
        for focus in ('false', 'true'):
            with self.subTest(ui_focus=focus):
                result = SCOPE['summarize'](Log(attempt(focus, after_focus=focus)), None, keyboard_only=True)
                self.assertIn('ui-focus-' + focus + '-observations=1', result)
                self.assertIn('first-characters-verified=1', result)
                self.assertIn('false-ui-focus-then-key-verified=' + ('1' if focus == 'false' else '0'), result)
                self.assertIn('verified-first-keys-ui-focus-false=' + ('1' if focus == 'false' else '0'), result)
                self.assertNotIn('status=', result)
                self.assertNotIn('PASS', result)

    def test_a_rejected_native_event_never_becomes_a_verified_key(self):
        log = attempt(verified=False) + 'error: Neither element nor any descendant has keyboard focus private-field\n'
        result = SCOPE['summarize'](Log(log), '65')
        self.assertIn('status=FAIL', result)
        self.assertIn('error-1-reason=keyboard-focus-absent', result)
        self.assertIn('first-characters-verified=0', result)
        self.assertIn('false-ui-focus-then-key-verified=0', result)
        self.assertNotIn('private', result)

    def test_unknown_markers_out_of_order_and_duplicate_proofs_cannot_inflate_observations(self):
        value = ('BRIDGE_NATIVE_KEYBOARD_INPUT=first-character-verified;ui-focus=false\n' +
                 attempt('private-account') + attempt() +
                 'BRIDGE_NATIVE_KEYBOARD_INPUT=first-character-verified;ui-focus=false\n' +
                 'BRIDGE_NATIVE_KEYBOARD_INPUT=private-key\n')
        result = SCOPE['summarize'](Log(value), None, keyboard_only=True)
        self.assertIn('ui-focus-false-observations=1', result)
        self.assertIn('first-characters-verified=1', result)
        self.assertNotIn('private', result)

    def test_focus_that_changes_before_the_verified_key_is_not_reported_as_still_false(self):
        result = SCOPE['summarize'](Log(attempt('false', after_focus='true')), None, keyboard_only=True)
        self.assertIn('false-ui-focus-then-key-verified=1', result)
        self.assertIn('verified-first-keys-ui-focus-false=0', result)

    def test_budget_limits_and_private_contents_remain_explicit_in_observation_mode(self):
        with patch.dict(SCOPE['summarize'].__globals__, {'MAX_SCAN_CHARS': 32}):
            result = SCOPE['summarize'](Log('private-value\n' * 8 + attempt()), None, keyboard_only=True)
        self.assertIn('scan-truncated=true', result)
        self.assertIn('first-characters-verified=0', result)
        self.assertNotIn('private', result)

    def test_cli_requires_all_three_native_edits_without_grading_the_xctest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / 'private-runner.log'
            output = root / 'observation.txt'
            for count in (0, 1, 3):
                with self.subTest(edits=count):
                    log.write_text('private-input-address\n' + attempt() * count)
                    result = subprocess.run([sys.executable, str(REPORTER), '--keyboard-observation',
                                             str(log), str(output), '--require-complete-journey'],
                                            capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, 0 if count == 3 else 1)
                    self.assertNotIn('private', result.stdout + result.stderr + output.read_text())
                    self.assertNotIn('PASS', output.read_text())
                    if count != 3:
                        self.assertIn('category=keyboard-observation-incomplete', result.stderr)

    def test_cli_missing_files_and_private_arguments_fail_without_paths_or_tracebacks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'private-account'
            for args in ([str(root / 'input.log'), str(root / 'output.txt')],
                         ['unused', 'unused', '--private-secret']):
                result = subprocess.run([sys.executable, str(REPORTER), '--keyboard-observation', *args],
                                        capture_output=True, text=True, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('private', result.stdout + result.stderr)
                self.assertNotIn('Traceback', result.stdout + result.stderr)

    def test_workflow_retains_real_xctest_grade_and_publishes_only_closed_observation(self):
        source = (ROOT / 'apps/mobile/ios/BridgeNativeUITests/ServerConnectionJourneyTests.swift').read_text()
        workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
        self.assertIn('input.tap()', source)
        self.assertIn('input.typeText(String(character))', source)
        self.assertIn('XCTAssertEqual(keyResult, .completed,', source)
        self.assertIn('if keyResult == .completed && acceptedPrefix.count == 1', source)
        self.assertIn('XCTAssertEqual(typedValue, address,', source)
        self.assertIn('--xcode-summary ../.ci-results/xcode-summary.json --expected 1', workflow)
        self.assertIn('--require-complete-journey', workflow)
        self.assertIn('apps/mobile/.ci-results/keyboard-observation.txt', workflow)
        for forbidden in ('UIPasteboard', 'input.setValue', 'input.paste', 'XCTSkip', 'retry('):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__':
    unittest.main()
