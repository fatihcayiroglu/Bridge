"""Exercise the actual artifact selection and native evidence CLI with private input."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[3]
GATE = ROOT / 'apps/mobile/scripts/verify_native_results.py'


def artifact_paths(name):
    workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
    block = workflow[workflow.index('name: ' + name):]
    match = re.search(r'\n          path: \|\n((?:            [^\n]+\n)+)', block)
    if not match:
        raise AssertionError('Native artifact must use an explicit file allowlist')
    return [line.strip() for line in match[1].splitlines()]


class NativeArtifactPrivacyTests(unittest.TestCase):
    def run_gate(self, root, source, flag='--junit-dir', expected=1):
        output = root / 'evidence.json'
        result = subprocess.run([sys.executable, str(GATE), flag, str(source),
                                 '--expected', str(expected), '--output', str(output)],
                                capture_output=True, text=True, check=False, timeout=10)
        self.assertNotIn('private', result.stdout + result.stderr)
        self.assertNotIn('Traceback', result.stdout + result.stderr)
        return result, json.loads(output.read_text())

    def test_passing_junit_artifact_copies_only_verified_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'TEST-private-account.xml'
            report.write_text('<testsuite name="private-suite" hostname="private-host">'
                              '<testcase name="private-test" file="private-path"/>'
                              '<system-out>Bearer private-token</system-out></testsuite>')
            result, artifact = self.run_gate(root, root)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(artifact, {'status': 'PASS', 'executed': 1, 'skipped': 0, 'failed': 0})

    def test_failed_skipped_disabled_and_missing_reports_remain_failed_in_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'TEST-private.xml'
            for xml, category in [
                ('<testsuite><testcase><failure>private-credential</failure></testcase></testsuite>', 'native-junit-failed-or-skipped'),
                ('<testsuite><testcase><error>private-credential</error></testcase></testsuite>', 'native-junit-failed-or-skipped'),
                ('<testsuite><testcase><skipped>private-reason</skipped></testcase></testsuite>', 'native-junit-failed-or-skipped'),
                ('<testsuite disabled="1"><testcase/></testsuite>', 'native-junit-failed-or-skipped'),
                ('<testsuite/>', 'native-junit-count-mismatch'),
                ('<private-malformed', 'native-report-malformed'),
                (None, 'native-junit-missing'),
            ]:
                with self.subTest(category=category):
                    if xml is None:
                        report.unlink()
                    else:
                        report.write_text(xml)
                    result, artifact = self.run_gate(root, root)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(artifact, {'status': 'FAIL', 'category': category})

    def test_failed_startup_keeps_only_complete_closed_enum_observations(self):
        packet = ('startup=form-not-visible;screen-on=true;keyguard-locked=false;'
                  'foreground=preview;heading-visible=true;edit-text-visible=false;'
                  'input-id-visible=unknown;input-label=missing')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'TEST-private.xml'
            for suffix in ('', '-private-unrecognized'):
                report.write_text('<testsuite><testcase><failure>private-path\n' + packet + suffix +
                                  '\nBearer private-token</failure></testcase></testsuite>')
                result, artifact = self.run_gate(root, root)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(artifact['status'], 'FAIL')
                self.assertNotIn('private', json.dumps(artifact))
                if suffix:
                    self.assertNotIn('startup', artifact)
                else:
                    self.assertEqual(artifact['startup'], {
                        'reason': 'form-not-visible', 'screen-on': 'true', 'keyguard-locked': 'false',
                        'foreground': 'preview', 'heading-visible': 'true', 'edit-text-visible': 'false',
                        'input-id-visible': 'unknown', 'input-label': 'missing'})

    def test_startup_packet_in_system_output_is_not_mistaken_for_a_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'TEST-private.xml').write_text('<testsuite><testcase/>'
                                                 '<system-out>startup=form-not-visible;private-key</system-out></testsuite>')
            result, artifact = self.run_gate(root, root)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('startup', artifact)

    def test_xcode_artifact_projects_counts_without_private_summary_fields(self):
        valid = {'totalTestCount': 1, 'passedTests': 1, 'failedTests': 0,
                 'skippedTests': 0, 'expectedFailures': 0,
                 'testFailures': [], 'title': 'private-runner', 'runnerPath': '/private/runner'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'private-summary.json'
            report.write_text(json.dumps(valid))
            result, artifact = self.run_gate(root, report, '--xcode-summary')
            self.assertEqual(result.returncode, 0)
            self.assertEqual(artifact, {'status': 'PASS', 'executed': 1, 'skipped': 0, 'failed': 0})
            for key, value in [('skippedTests', 1), ('passedTests', True), ('failedTests', 1)]:
                report.write_text(json.dumps({**valid, key: value}))
                result, artifact = self.run_gate(root, report, '--xcode-summary')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(artifact, {'status': 'FAIL', 'category': 'native-xcode-count-mismatch'})

    def test_xcode_failure_details_cannot_contradict_zero_failure_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'private-summary.json'
            for failures in ([{'failureText': 'private-failed-assertion'}], {}, None, True):
                with self.subTest(kind=type(failures).__name__):
                    report.write_text(json.dumps({'totalTestCount': 1, 'passedTests': 1,
                                                  'failedTests': 0, 'skippedTests': 0,
                                                  'expectedFailures': 0, 'testFailures': failures}))
                    result, artifact = self.run_gate(root, report, '--xcode-summary')
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(artifact, {'status': 'FAIL', 'category': 'native-xcode-summary-invalid'})

    def test_artifact_write_failure_fails_without_disclosing_the_private_output_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'TEST-private.xml').write_text('<testsuite><testcase/></testsuite>')
            result = subprocess.run([sys.executable, str(GATE), '--junit-dir', str(root), '--expected', '1',
                                     '--output', str(root / 'private-parent' / 'report.json')],
                                    capture_output=True, text=True, check=False, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('category=native-artifact-write-failed', result.stderr)
        self.assertNotIn('private', result.stdout + result.stderr)
        self.assertNotIn('Traceback', result.stdout + result.stderr)

    def test_android_artifact_selection_excludes_raw_private_reports_and_device_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inputs = {
                'apps/mobile/android/app/build/test-results/testDebugUnitTest/TEST-private.xml': '<testsuite><system-out>private-jvm-output</system-out></testsuite>',
                'apps/mobile/android/app/build/outputs/androidTest-results/connected/device/logcat-private.txt': 'Bearer private-device-token',
                'apps/mobile/android/app/build/outputs/androidTest-results/connected/test-result.pb': 'private-protobuf',
                'apps/mobile/android/app/build/outputs/androidTest-results/connected/TEST-private.xml': '<testsuite><failure>private-account</failure></testsuite>',
                'apps/mobile/.ci-results/source-commit.txt': 'a' * 40,
                'apps/mobile/.ci-results/android-jvm-summary.json': '{"status":"PASS","executed":6,"failed":0,"skipped":0}',
                'apps/mobile/.ci-results/android-ui-summary.json': '{"status":"FAIL","category":"native-junit-failed-or-skipped"}',
                'apps/mobile/.ci-results/metro-diagnostic.txt': 'status=FAIL\nreason=readiness-timeout\n',
            }
            for filename, value in inputs.items():
                file = root / filename
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(value)
            uploaded = set()
            for pattern in artifact_paths('p8-android-native-evidence'):
                for match in root.glob(pattern):
                    if match.is_dir():
                        uploaded.update(file for file in match.rglob('*') if file.is_file())
                    else:
                        uploaded.add(match)
            self.assertTrue(uploaded)
            for file in uploaded:
                self.assertNotIn('private', file.read_text())
            for filename in ('source-commit.txt', 'android-jvm-summary.json', 'android-ui-summary.json'):
                self.assertIn(filename, {file.name for file in uploaded})

    def test_ios_uploads_normalized_counts_instead_of_the_raw_xcresult_summary(self):
        paths = artifact_paths('p8-ios-native-evidence')
        self.assertIn('apps/mobile/.ci-results/ios-native-summary.json', paths)
        self.assertNotIn('apps/mobile/.ci-results/xcode-summary.json', paths)
        self.assertNotIn('apps/mobile/.ci-results/xcode-private-summary.json', paths)

    def test_actual_workflow_publishes_both_results_and_fails_if_either_native_gate_fails(self):
        workflow = (ROOT / '.github/workflows/mobile-react-native.yml').read_text()
        block = workflow[workflow.index('- name: Publish normalized native test evidence'):]
        self.assertRegex(block, r'if: always\(\)')
        script = re.search(r'        run: \|\n((?:          [^\n]*\n)+)', block)
        self.assertIsNotNone(script)
        for bad_suite in ('jvm', 'ui'):
            with self.subTest(bad_suite=bad_suite), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                scripts = root / 'apps/mobile/scripts'
                scripts.mkdir(parents=True)
                (scripts / GATE.name).write_text(GATE.read_text())
                output = root / 'apps/mobile/.ci-results'
                output.mkdir()
                for name, location, count in [
                    ('jvm', 'test-results/testDebugUnitTest', 6),
                    ('ui', 'outputs/androidTest-results/connected', 1),
                ]:
                    folder = root / 'apps/mobile/android/app/build' / location
                    folder.mkdir(parents=True)
                    cases = ('<testcase/>' * count if name != bad_suite else
                             '<testcase><failure>private-credential</failure></testcase>' * count)
                    (folder / 'TEST-private.xml').write_text('<testsuite>' + cases + '</testsuite>')
                result = subprocess.run(['bash', '-ec', textwrap.dedent(script[1])], cwd=root,
                                        capture_output=True, text=True, check=False, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('private', result.stdout + result.stderr)
                for name in ('jvm', 'ui'):
                    report = json.loads((output / ('android-' + name + '-summary.json')).read_text())
                    self.assertEqual(report['status'], 'FAIL' if name == bad_suite else 'PASS')


if __name__ == '__main__':
    unittest.main()
