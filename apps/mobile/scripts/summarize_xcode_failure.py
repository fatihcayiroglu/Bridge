#!/usr/bin/env python3
"""Bounded, redacted CI evidence for failed native Xcode commands.

Never publish the raw build log: it may contain test fixture data, repository
paths and credential-bearing URLs. This is a diagnostic, not a test pass.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

MAX_MARKERS = 4
MAX_CHARS = 240

CLASSIFIERS = (
    ("duplicate-build-output", re.compile(r"Multiple commands produce", re.I)),
    ("scheme", re.compile(r"scheme.+(?:not found|not configured|does not contain)|does not contain a scheme", re.I)),
    ("workspace", re.compile(r"workspace.+(?:does not exist|not found|not a workspace|could not)|not a workspace", re.I)),
    ("simulator-destination", re.compile(r"unable to find a destination|ineligible destinations|destination.*not available", re.I)),
    ("signing", re.compile(r"provisioning profile|code.sign|signing certificate", re.I)),
    ("dependency", re.compile(r"no such module|framework not found|module map file|module not found", re.I)),
    ("test-target", re.compile(r"no test.+(?:target|bundle)|not configured for the test action", re.I)),
    ("invocation", re.compile(r"unknown (?:option|argument)|invalid (?:option|argument)|usage: xcodebuild", re.I)),
    ("compilation", re.compile(r"compilation failed|swift compiler|clang: error|build failed", re.I)),
    ("ui-interaction", re.compile(r"failed to (?:tap|type|focus)|no matches found|not hittable|failed to get matching", re.I)),
    ("test-failure", re.compile(r"test failed|testing failed", re.I)),
)

def redact(line: str) -> str:
    line = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", line)
    line = re.sub(r"\b(?:https?|postgresql|redis)://\S+", "[redacted-url]", line, flags=re.I)
    line = re.sub(
        r"(?:/Users|/home)/[^\s:'\"\]\),;]+",
        lambda match: "[redacted-runner-path]/" + match.group(0).rsplit("/", 1)[-1][:80],
        line,
    )
    line = re.sub(r"\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", "[redacted-email]", line, flags=re.I)
    line = re.sub(r"\b(token|secret|password|authorization)\s*[:=]\s*\S+", r"\1=[redacted]", line, flags=re.I)
    # Preserve only the explicit error marker and its bounded message, not
    # stdout/stderr lines that could carry channel or account fixture details.
    match = re.search(r"(?:xcodebuild:\s*error:|(?:^|\s)error:)\s*", line, flags=re.I)
    if match:
        line = line[match.start():]
    line = line.strip()
    if len(line) <= MAX_CHARS:
        return line
    # The leading test name and the final XCTest reason are both useful. Keep
    # a fixed bounded amount of each, after secret/path redaction.
    return line[:104] + " [middle omitted] " + line[-118:]

def summarize(log: Path, exit_status: str) -> str:
    markers: list[str] = []
    category = "unclassified"
    count = 0
    with log.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            if re.search(r"xcodebuild:\s*error:|(?:^|\s)error:", line, flags=re.I):
                for label, pattern in CLASSIFIERS:
                    if category == "unclassified" and pattern.search(line):
                        category = label
                count += 1
                if len(markers) < MAX_MARKERS:
                    markers.append(redact(line))
    fields = [f"status=FAIL", f"xcodebuild-exit-status={exit_status}",
              f"category={category}", f"error-markers={count}"]
    fields.extend(f"error-{n}={marker}" for n, marker in enumerate(markers, start=1))
    return "\n".join(fields) + "\n"

def main() -> int:
    if len(sys.argv) != 4:
        print("Usage: summarize-xcode-failure LOG EXIT_STATUS SUMMARY", file=sys.stderr)
        return 2
    log, exit_status, summary = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    if not log.is_file():
        print("status=FAIL\ncategory=xcode-log-missing", file=sys.stderr)
        return 1
    report = summarize(log, exit_status)
    summary.write_text(report)
    print(report, end="")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
