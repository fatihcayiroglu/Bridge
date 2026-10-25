"""Unit privacy controls; these do not replace the real native CI journeys."""
import io
from contextlib import redirect_stderr
import runpy
import re
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
REPORTER = ROOT / 'apps/mobile/scripts/summarize_xcode_failure.py'
SCOPE = runpy.run_path(str(REPORTER))


class InMemoryLog:
    def __init__(self, contents):
        self.contents = contents

    def open(self, **_kwargs):
        return io.StringIO(self.contents)


class NativeDiagnosticPrivacyTests(unittest.TestCase):
    def report(self, line, status='65'):
        return SCOPE['summarize'](InMemoryLog(line), status)

    def test_private_filename_is_not_retained_as_a_path_suffix(self):
        report = self.report('error: Multiple commands produce "/Users/runner/private/customer-medical-record.xctest"\n')
        self.assertIn('category=duplicate-build-output', report)
        self.assertNotIn('customer-medical-record', report)
        self.assertNotIn('/Users', report)

    def test_first_and_last_fragments_cannot_publish_unlabelled_identifiers(self):
        report = self.report('error: account-private-7301 ' + ('element state; ' * 40)
                             + 'email-private-8402 Failed to tap\n')
        self.assertIn('category=ui-interaction', report)
        self.assertNotIn('account-private-7301', report)
        self.assertNotIn('email-private-8402', report)

    def test_all_url_schemes_paths_and_credential_spellings_are_private(self):
        for payload in [
            'file:///private/clinic-note.json', 's3://secret-bucket/customer-key',
            'wss://internal.example/private-room', 'bridge://private-channel',
            'C:\\Users\\PrivatePerson\\private-draft.txt', '/private/var/secrets/medical.json',
            '/tmp/team-secret.docx', 'relative/private-evidence.png',
            'Bearer opaque-private-token', 'access_token = "private token with spaces"',
            'refreshToken: private-refresh', 'password: "private password with spaces"',
            'accountId=private-account', 'serverId=private-tenant', 'alice+private@example.invalid',
            '\x1b]0;private-terminal-title\x07', '\u202eprivate-bidi-payload',
        ]:
            with self.subTest(kind=payload.split(':', 1)[0][:16]):
                report = self.report('xcodebuild: error: unknown option ' + payload + '\n')
                self.assertIn('category=invocation', report)
                self.assertNotIn(payload, report)
                self.assertNotIn('private', report.lower())

    def test_error_markers_and_malformed_lines_never_echo_log_text(self):
        for prefix in ['error:', 'xcodebuild: error:', '\x1b[31merror:', 'random\x00 error:']:
            with self.subTest(marker=prefix[:12]):
                report = self.report(prefix + ' sensitive-unclassified-filename.txt\n')
                self.assertNotIn('sensitive-unclassified', report)
                self.assertNotIn('\x00', report)
                self.assertNotIn('\x1b', report)

    def test_exit_status_cannot_inject_an_extra_field_or_identifier(self):
        for status in ['65\naccount=private-id', 'token=private-token', '999999999', '-1', '0', '\u0666\u0665']:
            with self.subTest(status_kind=status[:2]):
                report = self.report('error: unknown option\n', status)
                self.assertIn('xcodebuild-exit-status=invalid', report)
                self.assertNotIn('private', report)
        self.assertIn('xcodebuild-exit-status=65', self.report('error: unknown option\n'))

    def test_known_failures_retain_actionable_reason_codes(self):
        for message, category, reason in [
            ('Multiple commands produce /private/name.xctest', 'duplicate-build-output', 'duplicate-output'),
            ('Must specify -test-iterations with more than 1 iteration.', 'invocation', 'test-iterations-minimum'),
            ('Failed to tap input: not hittable for keyboard focus', 'ui-interaction', 'not-hittable'),
            ('no matches found for input', 'ui-interaction', 'element-not-found'),
            ('Failed to type into input', 'ui-interaction', 'type-failed'),
            ('scheme Native not configured for test', 'scheme', 'scheme-unavailable'),
        ]:
            with self.subTest(category=category, reason=reason):
                report = self.report('error: ' + message + '\n')
                self.assertIn('category=' + category, report)
                self.assertIn('error-1-reason=' + reason, report)

    def test_marker_count_and_output_remain_bounded(self):
        report = self.report(('error: unknown option secret-value\n' * 50))
        self.assertIn('error-markers=50', report)
        self.assertIn('error-4-category=', report)
        self.assertNotIn('error-5-category=', report)
        self.assertNotIn('secret-value', report)
        self.assertLess(len(report), 2048)

    def test_journey_stage_codes_are_allowlisted_and_associated_with_each_error(self):
        report = self.report(
            'BRIDGE_NATIVE_JOURNEY_STAGE=connect\n'
            'error: XCTAssertTrue failed - Real Bridge liveness failed private-account\n'
            'BRIDGE_NATIVE_JOURNEY_STAGE=private-credential\n'
            'error: unknown option private-option\n'
            'BRIDGE_NATIVE_JOURNEY_STAGE=complete\n'
        )
        self.assertIn('error-1-stage=connect', report)
        self.assertIn('error-1-reason=liveness-not-verified', report)
        self.assertIn('error-2-stage=connect', report)
        self.assertIn('last-stage=complete', report)
        self.assertIn('status=FAIL', report)
        self.assertNotIn('private', report)

    def test_native_assertion_failure_keeps_its_code_without_actual_or_expected_values(self):
        for message, reason in [
            ('XCTAssertEqual failed: private-value - Server address edit did not replace the entire input', 'address-edit-mismatch'),
            ('XCTAssertEqual failed: private-value - Server field did not reflect keyboard delete', 'input-clear-mismatch'),
            ('XCTAssertEqual failed: private-field - Server field did not receive keyboard focus', 'input-focus-not-established'),
            ('XCTAssertEqual failed: private-field - Server field did not reflect keyboard character', 'input-key-mismatch'),
            ('XCTAssertTrue failed - private-data', 'assertion-failed'),
            ('Asynchronous wait failed: private-label', 'assertion-failed'),
        ]:
            with self.subTest(reason=reason):
                report = self.report('error: ' + message + '\n')
                self.assertIn('category=test-failure', report)
                self.assertIn('error-1-reason=' + reason, report)
                self.assertNotIn('private', report)

    def test_native_journey_keeps_checks_and_reports_only_literal_stage_codes(self):
        source = (ROOT / 'apps/mobile/ios/BridgeNativeUITests/ServerConnectionJourneyTests.swift').read_text()
        stages = re.findall(r'print\("BRIDGE_NATIVE_JOURNEY_STAGE=([^\"]+)"\)', source)
        self.assertEqual(set(stages), SCOPE['STAGES'])
        self.assertIn('XCTAssertEqual(typedValue, address,', source)
        self.assertIn('XCTAssertTrue(success.waitForExistence(timeout: 15)', source)
        self.assertIn('XCUIDevice.shared.press(.home)', source)
        self.assertIn('state == .runningBackground || state == .runningBackgroundSuspended', source)
        self.assertIn('backgroundObserved && stillBackground', source)
        self.assertIn('XCTAssertTrue(backgroundObserved && stillBackground,', source)
        self.assertIn('XCTAssertTrue(reportState(app.wait(for: .runningForeground, timeout: 10)))', source)
        self.assertIn('return matched', source)
        self.assertIn('XCTAssertFalse(success.exists,', source)

    def test_home_transition_failure_is_closed_and_suspension_is_not_a_skip(self):
        marker = 'error: App did not remain in a genuine background or suspended state after Home'
        report = self.report('BRIDGE_NATIVE_JOURNEY_STAGE=background\n' + marker + ' private-actor\n')
        self.assertIn('status=FAIL', report)
        self.assertIn('error-1-reason=background-not-reached', report)
        self.assertNotIn('private-actor', report)
        source = (ROOT / 'apps/mobile/ios/BridgeNativeUITests/ServerConnectionJourneyTests.swift').read_text()
        self.assertIn('XCTWaiter.wait(for: [background], timeout: 5)', source)
        self.assertIn('let stillBackground =', source)
        self.assertNotIn('XCTSkip', source)

    def test_native_lifecycle_observation_cannot_publish_unknown_state_values(self):
        report = self.report(
            'BRIDGE_NATIVE_JOURNEY_STAGE=background\n'
            'BRIDGE_NATIVE_APP_STATE=background-suspended\n'
            'BRIDGE_NATIVE_APP_STATE=private-identifier\n'
            'error: XCTAssertTrue failed - private-assertion\n'
        )
        self.assertIn('last-app-state=background-suspended', report)
        self.assertIn('error-1-app-state=background-suspended', report)
        self.assertIn('error-1-stage=background', report)
        self.assertNotIn('private', report)

    def test_oversized_line_has_a_bounded_read_and_explicit_truncation(self):
        class BoundedLog:
            def open(self, **_kwargs):
                class Stream(io.StringIO):
                    def __iter__(self):
                        raise AssertionError('Unbounded line iteration is forbidden')

                    def readline(self, size=-1):
                        if size < 1 or size > 16384:
                            raise AssertionError('Every read must be bounded')
                        return super().readline(size)
                return Stream('error: ' + 'sensitive-large-value' * 10000 + '\n')
        report = SCOPE['summarize'](BoundedLog(), '65')
        self.assertIn('scan-truncated=true', report)
        self.assertNotIn('sensitive-large-value', report)

    def test_cli_io_failures_do_not_print_exception_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'input.log'
            log.write_text('error: unknown option\n')
            output = Path(directory) / 'private-account-name' / 'summary.txt'
            result = subprocess.run([sys.executable, str(REPORTER), str(log), '65', str(output)],
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('private-account-name', result.stdout + result.stderr)
            self.assertNotIn('Traceback', result.stdout + result.stderr)

    def test_scan_budget_is_enforced_and_incompleteness_is_visible(self):
        with patch.dict(SCOPE['summarize'].__globals__, {'MAX_SCAN_CHARS': 64}):
            report = self.report('header\n' * 20 + 'error: Multiple commands produce /private/hidden.xctest\n')
        self.assertIn('scan-truncated=true', report)
        self.assertIn('error-markers=0', report)
        self.assertIn('category=unclassified', report)

    def test_workflow_preserves_original_build_failure_if_diagnostic_io_fails(self):
        workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
        start = workflow.index('          if [ "$xcode_status" -ne 0 ]; then')
        end = workflow.index('\n          fi\n', start) + len('\n          fi\n')
        failure_block = textwrap.dedent(workflow[start:end])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ios = root / 'ios'
            scripts = root / 'scripts'
            ios.mkdir()
            scripts.mkdir()
            for private_directory in (False, True):
                if private_directory:
                    (root / '.ci-results').mkdir()
                for helper_exit in (0, 1):
                    with self.subTest(diagnostic_exit=helper_exit, private_directory=private_directory):
                        (scripts / 'summarize_xcode_failure.py').write_text(f'raise SystemExit({helper_exit})\n')
                        result = subprocess.run(['bash', '-c', 'set -e\nxcode_status=65\n' + failure_block],
                                                cwd=ios, capture_output=True, text=True, timeout=10, check=False)
                        self.assertEqual(result.returncode, 65)
                        self.assertNotIn(directory, result.stdout + result.stderr)
                        self.assertNotIn('Traceback', result.stdout + result.stderr)
                        if helper_exit:
                            self.assertIn('category=xcode-diagnostic-unavailable', result.stderr)

    def test_backend_failure_cannot_publish_arbitrary_event_names_from_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / 'bin'
            binaries.mkdir()
            commands = {
                'git': '#!/bin/sh\nprintf "%s\\n" 0123456789012345678901234567890123456789\n',
                'node': '#!/bin/sh\nprintf "%s\\n" \'{"event":"db.private-account-secret"}\'\nexit 17\n',
                'curl': '#!/bin/sh\nexit 7\n',
                'sleep': '#!/bin/sh\nexit 0\n',
            }
            for name, contents in commands.items():
                command = binaries / name
                command.write_text(contents)
                command.chmod(0o755)
            result = subprocess.run(['bash', str(ROOT / 'apps/mobile/scripts/start-ci-backend.sh')],
                                    cwd=root, env={**os.environ, 'PATH': str(binaries) + os.pathsep + os.environ['PATH']},
                                    capture_output=True, text=True, timeout=10, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('startup FAIL', result.stderr)
            self.assertNotIn('private-account-secret', result.stdout + result.stderr)

    def test_result_gate_does_not_publish_private_report_names_on_failure(self):
        gate = ROOT / 'apps/mobile/scripts/verify_native_results.py'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'private-runner-account'
            root.mkdir()
            report = root / 'TEST-private-medical-record.xml'
            report.write_text('<testsuite failures="1"><testcase><failure message="private diagnosis"/></testcase></testsuite>')
            result = subprocess.run([sys.executable, str(gate), '--junit-dir', str(root), '--expected', '1'],
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('private', result.stdout + result.stderr)
            self.assertNotIn('Traceback', result.stdout + result.stderr)

    def test_result_gate_malformed_or_missing_input_fails_without_raw_exceptions(self):
        gate = ROOT / 'apps/mobile/scripts/verify_native_results.py'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'private-reports'
            root.mkdir()
            for suffix, flag, contents in [('xml', '--junit-dir', '<invalid private'),
                                           ('json', '--xcode-summary', '{private-invalid'),
                                           ('missing', '--xcode-summary', None)]:
                with self.subTest(format=suffix):
                    file = root / ('TEST-private-result.' + suffix)
                    if contents is not None:
                        file.write_text(contents)
                    target = root if flag == '--junit-dir' else file
                    result = subprocess.run([sys.executable, str(gate), flag, str(target), '--expected', '1'],
                                            capture_output=True, text=True, check=False)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('private', result.stdout + result.stderr)
                    self.assertNotIn('Traceback', result.stdout + result.stderr)

    def test_result_gate_argument_errors_cannot_echo_sensitive_values(self):
        gate = ROOT / 'apps/mobile/scripts/verify_native_results.py'
        for args in [ ['--xcode-summary', 'unused', '--expected', 'private-token'],
                      ['--xcode-summary', 'unused', '--expected', '1', '--private-account'] ]:
            result = subprocess.run([sys.executable, str(gate), *args],
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('private', result.stdout + result.stderr)

    def test_result_gate_unknown_exception_category_cannot_become_free_text(self):
        scope = runpy.run_path(str(ROOT / 'apps/mobile/scripts/verify_native_results.py'))

        def private_error(_filename, _expected):
            raise scope['NativeEvidenceError']('private-account-and-path')

        stderr = io.StringIO()
        with patch.dict(scope['main'].__globals__, {'verify_xcode': private_error}), \
             patch.object(sys, 'argv', ['verify-native-results', '--xcode-summary', 'unused', '--expected', '1']), \
             redirect_stderr(stderr):
            self.assertEqual(scope['main'](), 1)
        self.assertIn('category=native-report-invalid', stderr.getvalue())
        self.assertNotIn('private', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
