#!/usr/bin/env python3
"""Fail closed on absent, failed, skipped, or incomplete native test evidence."""
import argparse
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import sys

FAILURE_CATEGORIES = frozenset({
    "native-arguments-invalid", "native-test-count-invalid",
    "native-junit-missing", "native-junit-failed-or-skipped",
    "native-junit-count-mismatch", "native-xcode-summary-invalid",
    "native-xcode-count-mismatch",
})

# Only the test-owned Kotlin enum/boolean record may accompany a failed JUnit
# artifact. Raw failure text, stack traces and system-out stay private.
FLAG = r"(true|false|unknown)"
STARTUP = re.compile(
    r"(?<![\w-])startup=(screen-unavailable|keyguard-not-unlocked|form-not-visible);"
    r"screen-on=" + FLAG + r";keyguard-locked=" + FLAG +
    r";foreground=(preview|launcher|system-ui|permission-controller|other|unavailable);"
    r"heading-visible=" + FLAG + r";edit-text-visible=" + FLAG +
    r";input-id-visible=" + FLAG + r";input-label=(exact|includes-label|missing|unavailable)(?![\w-])"
)
STARTUP_KEYS = ("reason", "screen-on", "keyguard-locked", "foreground",
                "heading-visible", "edit-text-visible", "input-id-visible", "input-label")


def startup_observation(directory):
    """Bounded private scan; a missing observation never implies a passing test."""
    remaining = 4 * 1024 * 1024
    try:
        for file in sorted(Path(directory).rglob("TEST-*.xml"))[:64]:
            limit = min(remaining, 256 * 1024)
            if limit <= 0:
                break
            with file.open(encoding="utf-8") as source:
                contents = source.read(limit + 1)
            remaining -= len(contents)
            if len(contents) > limit:
                continue
            root = ET.fromstring(contents)
            for issue in root.iter():
                if issue.tag not in ("failure", "error"):
                    continue
                match = STARTUP.search(issue.text or "")
                if match:
                    return dict(zip(STARTUP_KEYS, match.groups()))
    except (OSError, ValueError, ET.ParseError, RecursionError):
        pass
    return None


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
    failures = result.get("testFailures", [])
    if not isinstance(failures, list) or failures:
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
    parser.add_argument("--output", help="Write only normalized evidence to this artifact file")
    output = None
    junit_dir = None
    category = None
    try:
        args = parser.parse_args()
        output = args.output
        junit_dir = args.junit_dir
        if args.expected < 1:
            raise NativeEvidenceError("native-test-count-invalid")
        evidence = (verify_junit(args.junit_dir, args.expected) if args.junit_dir
                    else verify_xcode(args.xcode_summary, args.expected))
    except NativeEvidenceError as error:
        category = str(error) if str(error) in FAILURE_CATEGORIES else "native-report-invalid"
    except (OSError, UnicodeError):
        category = "native-report-unreadable"
    except (ET.ParseError, ValueError, RecursionError):
        # Parser exceptions and OS tracebacks can contain raw payloads/paths.
        category = "native-report-malformed"
    report = {"status": "FAIL", "category": category} if category else {"status": "PASS", **evidence}
    if output and category == "native-junit-failed-or-skipped" and junit_dir:
        observation = startup_observation(junit_dir)
        if observation is not None:
            report["startup"] = observation
    if output:
        try:
            Path(output).write_text(json.dumps(report) + "\n")
        except (OSError, ValueError):
            print("status=FAIL\ncategory=native-artifact-write-failed", file=sys.stderr)
            return 1
    if category:
        print("status=FAIL\ncategory=" + category, file=sys.stderr)
        return 1
    print(json.dumps(evidence))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
