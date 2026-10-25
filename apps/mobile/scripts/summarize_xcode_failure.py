#!/usr/bin/env python3
"""Publish bounded failure classifications; build-log text is private input.

All emitted values belong to a closed vocabulary, except bounded numeric counts
and a validated process exit code. Redacting selected patterns cannot establish
that a filename, identifier or unknown credential spelling is safe to publish.
This diagnostic can never turn a failed build into PASS.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

MAX_MARKERS = 4
MAX_LINE_CHARS = 16_384
MAX_SCAN_CHARS = 8 * 1024 * 1024
ERROR_MARKER = re.compile(r"xcodebuild:\s*error:|(?:^|\s)error:", re.I)
ANSI_CSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
STAGE_MARKER = re.compile(r"BRIDGE_NATIVE_JOURNEY_STAGE=([a-z-]+)(?:\s|$)")
STAGES = frozenset({"launch", "connect", "background", "resume", "insecure-input",
                    "unavailable-input", "complete"})

# Codes are literals owned here. No captures or log substrings are returned.
CLASSIFIERS = (
    ("duplicate-build-output", "duplicate-output", r"Multiple commands produce"),
    ("scheme", "scheme-unavailable", r"scheme.+(?:not found|not configured|does not contain)|does not contain a scheme"),
    ("workspace", "workspace-unavailable", r"workspace.+(?:does not exist|not found|not a workspace|could not)|not a workspace"),
    ("simulator-destination", "destination-unavailable", r"unable to find a destination|ineligible destinations|destination.*not available"),
    ("signing", "signing-unavailable", r"provisioning profile|code.sign|signing certificate"),
    ("dependency", "dependency-unavailable", r"no such module|framework not found|module map file|module not found"),
    ("test-target", "test-target-unavailable", r"no test.+(?:target|bundle)|not configured for the test action"),
    ("invocation", "test-iterations-minimum", r"must specify -test-iterations with more than 1 iteration"),
    ("invocation", "invalid-invocation", r"unknown (?:option|argument)|invalid (?:option|argument)|usage: xcodebuild"),
    ("compilation", "compilation-failed", r"compilation failed|swift compiler|clang: error|build failed"),
    ("ui-interaction", "not-hittable", r"not hittable"),
    ("ui-interaction", "element-not-found", r"no matches found|failed to get matching"),
    ("ui-interaction", "tap-failed", r"failed to tap"),
    ("ui-interaction", "type-failed", r"failed to type"),
    ("ui-interaction", "focus-failed", r"failed to focus"),
    ("test-failure", "address-edit-mismatch", r"server address edit did not replace the entire input"),
    ("test-failure", "liveness-not-verified", r"real Bridge liveness failed"),
    ("test-failure", "native-form-not-visible", r"native form did not launch"),
    ("test-failure", "resident-connection-lost", r"connection state disappeared on a resident resume"),
    ("test-failure", "assertion-failed", r"XCTAssert\w* failed|Asynchronous wait failed|failed:.*expectation"),
    ("test-failure", "test-failed", r"test failed|testing failed"),
)
PATTERNS = tuple((category, reason, re.compile(pattern, re.I))
                 for category, reason, pattern in CLASSIFIERS)


def validated_exit_status(value: str) -> str:
    if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,2}", value):
        if int(value) <= 255:
            return value
    return "invalid"


def classify_marker(line: str) -> tuple[str, str, str]:
    for category, reason, pattern in PATTERNS:
        if pattern.search(line):
            artifact = "none"
            if category == "duplicate-build-output":
                for extension, kind in (("xctest", "ui-test-bundle"),
                                        ("plist", "property-list"),
                                        ("app", "application-bundle")):
                    if re.search(r"\." + extension + r"(?:\W|$)", line, re.I):
                        artifact = kind
                        break
            return category, reason, artifact
    return "unclassified", "unclassified", "none"


def summarize(log: Path, exit_status: str) -> str:
    markers: list[tuple[str, str, str, str]] = []
    category = "unclassified"
    count = 0
    truncated = False
    remaining = MAX_SCAN_CHARS
    stage = "not-started"
    with log.open(encoding="utf-8", errors="replace") as stream:
        while remaining > 0:
            limit = min(MAX_LINE_CHARS, remaining)
            chunk = stream.readline(limit)
            if not chunk:
                break
            remaining -= len(chunk)
            if len(chunk) == limit and not chunk.endswith("\n"):
                truncated = True
            line = ANSI_CSI.sub("", chunk)
            stage_match = STAGE_MARKER.search(line)
            if stage_match and stage_match[1] in STAGES:
                stage = stage_match[1]
            if ERROR_MARKER.search(line):
                marker = classify_marker(line)
                if category == "unclassified":
                    category = marker[0]
                count += 1
                if len(markers) < MAX_MARKERS:
                    markers.append((*marker, stage))
        if remaining == 0:
            truncated = True
    fields = ["status=FAIL", f"xcodebuild-exit-status={validated_exit_status(exit_status)}",
              f"category={category}", f"error-markers={count}",
              f"scan-truncated={str(truncated).lower()}", f"last-stage={stage}"]
    for number, (kind, reason, artifact, marker_stage) in enumerate(markers, start=1):
        fields.extend((f"error-{number}-category={kind}",
                       f"error-{number}-reason={reason}",
                       f"error-{number}-artifact={artifact}",
                       f"error-{number}-stage={marker_stage}"))
    return "\n".join(fields) + "\n"


def main() -> int:
    if len(sys.argv) != 4:
        print("Usage: summarize-xcode-failure LOG EXIT_STATUS SUMMARY", file=sys.stderr)
        return 2
    log, exit_status, summary = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    if validated_exit_status(exit_status) == "invalid":
        print("status=FAIL\ncategory=xcode-exit-status-invalid", file=sys.stderr)
        return 1
    try:
        report = summarize(log, exit_status)
        summary.write_text(report)
    except (OSError, ValueError):
        # OS exception strings/tracebacks include runner and output paths.
        print("status=FAIL\ncategory=xcode-diagnostic-io-failed", file=sys.stderr)
        return 1
    print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
