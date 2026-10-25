#!/usr/bin/env python3
"""Fail closed on absent, failed, skipped, or incomplete native test evidence."""
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET


def verify_junit(directory, expected):
    reports = sorted(Path(directory).rglob("TEST-*.xml"))
    if not reports:
        raise ValueError("No native JUnit reports were produced")
    cases = []
    for report in reports:
        root = ET.parse(report).getroot()
        for suite in root.iter("testsuite"):
            for key in ("failures", "errors", "skipped", "disabled"):
                if int(suite.get(key, "0")) != 0:
                    raise ValueError(f"Native suite reports {key}: {report}")
        cases.extend(root.iter("testcase"))
    if len(cases) != expected:
        raise ValueError(f"Expected {expected} executed native tests, found {len(cases)}")
    for case in cases:
        if any(case.find(tag) is not None for tag in ("failure", "error", "skipped")):
            raise ValueError("A native testcase failed or skipped")
    return {"executed": len(cases), "skipped": 0, "failed": 0}


def verify_xcode(filename, expected):
    result = json.loads(Path(filename).read_text())
    required = {"totalTestCount": expected, "passedTests": expected,
                "failedTests": 0, "skippedTests": 0, "expectedFailures": 0}
    if any(type(result.get(key)) is not int or result[key] != value
           for key, value in required.items()):
        raise ValueError("Xcode summary must show every expected test passing, zero skips/expected failures")
    return {"executed": expected, "skipped": 0, "failed": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--junit-dir")
    sources.add_argument("--xcode-summary")
    parser.add_argument("--expected", required=True, type=int)
    args = parser.parse_args()
    if args.expected < 1:
        parser.error("At least one native test is required")
    evidence = (verify_junit(args.junit_dir, args.expected) if args.junit_dir
                else verify_xcode(args.xcode_summary, args.expected))
    print(json.dumps(evidence))
