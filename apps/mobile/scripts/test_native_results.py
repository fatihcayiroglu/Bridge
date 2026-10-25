import json
from pathlib import Path
import tempfile
import unittest
from verify_native_results import verify_junit, verify_xcode


class NativeEvidenceGateTests(unittest.TestCase):
    def test_junit_pass_requires_actual_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "TEST-native.xml"
            file.write_text('<testsuite tests="1"><testcase name="actual"/></testsuite>')
            self.assertEqual(verify_junit(directory, 1)["executed"], 1)
            with self.assertRaises(ValueError):
                verify_junit(directory, 2)
            file.write_text('<testsuite tests="1"/>')
            with self.assertRaises(ValueError):
                verify_junit(directory, 1)

    def test_missing_junit_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                verify_junit(directory, 1)

    def test_skips_errors_failures_and_disabled_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "TEST-native.xml"
            for tag in ("skipped", "failure", "error"):
                with self.subTest(tag=tag):
                    file.write_text(f'<testsuite><testcase name="bad"><{tag}/></testcase></testsuite>')
                    with self.assertRaises(ValueError):
                        verify_junit(directory, 1)
            for attribute in ("skipped", "disabled", "failures", "errors"):
                with self.subTest(attribute=attribute):
                    file.write_text(f'<testsuites><testsuite {attribute}="1"><testcase/></testsuite></testsuites>')
                    with self.assertRaises(ValueError):
                        verify_junit(directory, 1)

    def test_xcode_summary_cannot_hide_missing_skipped_or_failed_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "summary.json"
            valid = {"totalTestCount": 1, "passedTests": 1, "failedTests": 0,
                     "skippedTests": 0, "expectedFailures": 0}
            file.write_text(json.dumps(valid))
            self.assertEqual(verify_xcode(file, 1)["executed"], 1)
            for key in valid:
                for invalid in (None, True, str(valid[key]), valid[key] + 1):
                    with self.subTest(key=key, invalid=invalid):
                        file.write_text(json.dumps({**valid, key: invalid}))
                        with self.assertRaises(ValueError):
                            verify_xcode(file, 1)


if __name__ == "__main__":
    unittest.main()
