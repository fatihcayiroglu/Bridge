#!/usr/bin/env python3
"""Fail closed on absent, failed, skipped, or incomplete native test evidence."""
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import sys

FAILURE_CATEGORIES = frozenset({
    "native-arguments-invalid", "native-test-count-invalid",
    "native-junit-missing", "native-junit-failed-or-skipped",
    "native-junit-count-mismatch", "native-xcode-summary-invalid",
    "native-xcode-count-mismatch",
})


class NativeEvidenceError(ValueError):
    """Only literal categories owned by this module may cross the CLI boundary."""


class PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        raise NativeEvidenceError("native-arguments-invalid")


def verify_junit(directory, expected):
    reports = sorted(Path(directory).rglob("TEST-*.xml"))
    if not reports:
        raise NativeEvidenceError("native-junit-missing")
    cases = []
    for report in reports:
        root = ET.parse(report).getroot()
        for suite in root.iter("testsuite"):
            for key in ("failures", "errors", "skipped", "disabled"):
                if int(suite.get(key, "0")) != 0:
                    raise NativeEvidenceError("native-junit-failed-or-skipped")
        cases.extend(root.iter("testcase"))
    if len(cases) != expected:
        raise NativeEvidenceError("native-junit-count-mismatch")
    for case in cases:
        if any(case.find(tag) is not None for tag in ("failure", "error", "skipped")):
            raise NativeEvidenceError("native-junit-failed-or-skipped")
    return {"executed": len(cases), "skipped": 0, "failed": 0}


def verify_xcode(filename, expected):
    result = json.loads(Path(filename).read_text())
    if not isinstance(result, dict):
        raise NativeEvidenceError("native-xcode-summary-invalid")
    required = {"totalTestCount": expected, "passedTests": expected,
                "failedTests": 0, "skippedTests": 0, "expectedFailures": 0}
    if any(type(result.get(key)) is not int or result[key] != value
           for key, value in required.items()):
        raise NativeEvidenceError("native-xcode-count-mismatch")
    return {"executed": expected, "skipped": 0, "failed": 0}


def main():
    parser = PrivateArgumentParser(prog="verify-native-results")
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--junit-dir")
    sources.add_argument("--xcode-summary")
    parser.add_argument("--expected", required=True, type=int)
    try:
        args = parser.parse_args()
        if args.expected < 1:
            raise NativeEvidenceError("native-test-count-invalid")
        evidence = (verify_junit(args.junit_dir, args.expected) if args.junit_dir
                    else verify_xcode(args.xcode_summary, args.expected))
    except NativeEvidenceError as error:
        category = str(error) if str(error) in FAILURE_CATEGORIES else "native-report-invalid"
        print("status=FAIL\ncategory=" + category, file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print("status=FAIL\ncategory=native-report-unreadable", file=sys.stderr)
        return 1
    except (ET.ParseError, ValueError):
        # Parser exceptions and OS tracebacks can contain raw payloads/paths.
        print("status=FAIL\ncategory=native-report-malformed", file=sys.stderr)
        return 1
    print(json.dumps(evidence))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
