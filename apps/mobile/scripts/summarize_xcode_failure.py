#!/usr/bin/env python3
"""Publish bounded failure classifications; build-log text is private input.

All emitted values belong to a closed vocabulary, except bounded numeric counts
and a validated process exit code. Redacting selected patterns cannot establish
that a filename, identifier or unknown credential spelling is safe to publish.
This diagnostic can never turn a failed build into PASS.
"""
from __future__ import annotations

import json
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
STATE_MARKER = re.compile(r"BRIDGE_NATIVE_APP_STATE=([a-z-]+)(?:\s|$)")
STATES = frozenset({"unknown", "not-running", "background-suspended", "background", "foreground"})
ACTION_MARKER = re.compile(r"BRIDGE_NATIVE_JOURNEY_ACTION=([a-z-]+)(?:\s|$)")
ACTIONS = frozenset({"input-focus", "keyboard-wait", "keyboard-geometry", "input-clear",
                     "input-clear-verify", "input-focus-observe", "input-type", "input-verify", "input-submit", "liveness-wait",
                     "app-launch", "form-wait", "form-observation", "renderer-check"})
INPUT_MARKER = re.compile(r"BRIDGE_NATIVE_INPUT_KIND=([a-z-]+)(?:\s|$)")
INPUT_KINDS = frozenset({"text-field", "secure-field", "text-view", "other", "missing", "unavailable"})
SURFACE_MARKER = re.compile(r"BRIDGE_NATIVE_SURFACE=([a-z-]+)(?:\s|$)")
SURFACES = frozenset({"form", "module-error", "metro-error", "reference-error", "type-error", "other", "unavailable"})
VALUE_MARKER = re.compile(r"BRIDGE_NATIVE_INPUT_VALUE=([a-z-]+);length=([0-9]{1,3});expected-length=([0-9]{1,3});settled=(true|false)(?:\s|$)")
VALUE_SHAPES = frozenset({"empty", "placeholder", "unchanged", "expected-prefix", "expected-suffix", "other", "not-string"})
UI_FOCUS_MARKER = re.compile(r"BRIDGE_NATIVE_UI_FOCUS=(true|false)(?:\s|$)")
KEY_INPUT_MARKER = re.compile(r"BRIDGE_NATIVE_KEYBOARD_INPUT=first-character-verified;ui-focus=(true|false)(?:\s|$)")
MAX_XCRESULT_CHARS = 1_048_576
TARGETS = (
    ("server-address-input", re.compile(r"\bserver-url-input\b")),
    ("connect-button", re.compile(r"\bconnect-button\b")),
    ("connection-result", re.compile(r"\bconnection-(?:success|error)\b")),
    ("preview-application", re.compile(r"\bcom\.bridge\.nativepreview(?![\w.])")),
    ("native-test-runner", re.compile(r"\bcom\.bridge\.nativepreview\.uitests\.xctrunner(?![\w.])")),
)

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
    ("ui-interaction", "keyboard-focus-absent", r"neither element nor any descendant has keyboard focus|no keyboard focus"),
    ("ui-interaction", "keyboard-not-visible", r"software keyboard is not visible|no keyboard found"),
    ("ui-interaction", "input-covered-by-keyboard", r"server field is covered by software keyboard"),
    ("ui-interaction", "scroll-to-visible-failed", r"failed to scroll to visible"),
    ("ui-interaction", "input-event-rejected", r"failed to synthesize event"),
    ("ui-interaction", "not-hittable", r"not hittable"),
    ("ui-interaction", "element-not-found", r"no matches found|failed to get matching"),
    ("ui-interaction", "tap-failed", r"failed to tap"),
    ("ui-interaction", "type-failed", r"failed to type"),
    ("ui-interaction", "focus-failed", r"failed to focus"),
    ("test-failure", "input-focus-not-established", r"server field did not receive keyboard focus"),
    ("test-failure", "input-key-mismatch", r"server field did not reflect keyboard character"),
    ("test-failure", "input-clear-mismatch", r"server field did not reflect keyboard delete"),
    ("test-failure", "address-edit-mismatch", r"server address edit did not replace the entire input"),
    ("test-failure", "liveness-not-verified", r"real Bridge liveness failed"),
    ("test-failure", "native-form-not-visible", r"native form did not launch"),
    ("test-failure", "resident-connection-lost", r"connection state disappeared on a resident resume"),
    ("test-failure", "background-not-reached", r"App did not remain in a genuine background or suspended state after Home"),
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


def xcresult_evidence(path: Path) -> list[str]:
    try:
        with path.open(encoding="utf-8") as source:
            contents = source.read(MAX_XCRESULT_CHARS + 1)
        if len(contents) > MAX_XCRESULT_CHARS:
            return ["xcresult-status=oversized"]
        summary = json.loads(contents)
        failures = summary.get("testFailures") if isinstance(summary, dict) else None
        if not isinstance(failures, list):
            return ["xcresult-status=malformed"]
        if any(not isinstance(failure, dict) for failure in failures):
            return ["xcresult-status=malformed"]
        reasons: set[str] = set()
        targets: set[str] = set()
        for failure in failures[:MAX_MARKERS]:
            # Values are scanned privately; only literal codes leave this function.
            text = failure.get("failureText", "")
            if not isinstance(text, str):
                continue
            for _category, reason, pattern in PATTERNS:
                if pattern.search(text):
                    reasons.add(reason)
            for name, pattern in TARGETS:
                if pattern.search(text):
                    targets.add(name)
        return ["xcresult-status=available", f"xcresult-failures={len(failures)}",
                f"xcresult-scan-truncated={str(len(failures) > MAX_MARKERS).lower()}",
                "xcresult-reasons=" + (",".join(sorted(reasons)) or "unclassified"),
                "query-targets=" + (",".join(sorted(targets)) or "unclassified")]
    except (OSError, ValueError, RecursionError):
        return ["xcresult-status=unavailable"]


def summarize(log: Path, exit_status: str | None, failure_summary: Path | None = None,
              *, keyboard_only: bool = False) -> str:
    markers: list[tuple[str, str, str, str, str, str]] = []
    category = "unclassified"
    count = 0
    truncated = False
    remaining = MAX_SCAN_CHARS
    stage = "not-started"
    state = "not-observed"
    action = "not-observed"
    input_kind = None
    surface = None
    input_value = None
    pending_ui_focus = None
    ui_focus_true = 0
    ui_focus_false = 0
    first_keys_verified = 0
    false_focus_keys_verified = 0
    false_focus_after_verified_key = 0
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
            state_match = STATE_MARKER.search(line)
            if state_match and state_match[1] in STATES:
                state = state_match[1]
            action_match = ACTION_MARKER.search(line)
            if action_match and action_match[1] in ACTIONS:
                action = action_match[1]
                if action == "input-focus":
                    pending_ui_focus = None
            focus_match = UI_FOCUS_MARKER.search(line)
            if focus_match and action == "input-focus-observe":
                pending_ui_focus = focus_match[1] == "true"
                if pending_ui_focus:
                    ui_focus_true += 1
                else:
                    ui_focus_false += 1
            key_input_match = KEY_INPUT_MARKER.search(line)
            if (key_input_match and action == "input-type"
                    and pending_ui_focus is not None):
                first_keys_verified += 1
                if not pending_ui_focus:
                    false_focus_keys_verified += 1
                if key_input_match[1] == "false":
                    false_focus_after_verified_key += 1
                pending_ui_focus = None
            input_match = INPUT_MARKER.search(line)
            if input_match and input_match[1] in INPUT_KINDS:
                input_kind = input_match[1]
            surface_match = SURFACE_MARKER.search(line)
            if surface_match and surface_match[1] in SURFACES:
                surface = surface_match[1]
            value_match = VALUE_MARKER.search(line)
            if (value_match and value_match[1] in VALUE_SHAPES
                    and int(value_match[2]) <= 256 and int(value_match[3]) <= 256):
                input_value = (value_match[1], int(value_match[2]), int(value_match[3]), value_match[4])
            if ERROR_MARKER.search(line):
                marker = classify_marker(line)
                if category == "unclassified":
                    category = marker[0]
                count += 1
                if len(markers) < MAX_MARKERS:
                    markers.append((*marker, stage, state, action))
        if remaining == 0:
            truncated = True
    keyboard_fields = [f"ui-focus-true-observations={ui_focus_true}",
                       f"ui-focus-false-observations={ui_focus_false}",
                       f"first-characters-verified={first_keys_verified}",
                       f"false-ui-focus-then-key-verified={false_focus_keys_verified}",
                       f"verified-first-keys-ui-focus-false={false_focus_after_verified_key}"]
    if keyboard_only:
        # Observations never grade a test. The existing native result verifier
        # still requires an actual successful XCTest with no failed/skipped cases.
        return "\n".join(["evidence-kind=native-keyboard-observation",
                          f"scan-truncated={str(truncated).lower()}", *keyboard_fields]) + "\n"
    fields = ["status=FAIL", f"xcodebuild-exit-status={validated_exit_status(exit_status)}",
              f"category={category}", f"error-markers={count}",
              f"scan-truncated={str(truncated).lower()}", f"last-stage={stage}",
              f"last-app-state={state}", f"last-action={action}"]
    for number, (kind, reason, artifact, marker_stage, marker_state, marker_action) in enumerate(markers, start=1):
        fields.extend((f"error-{number}-category={kind}",
                       f"error-{number}-reason={reason}",
                       f"error-{number}-artifact={artifact}",
                       f"error-{number}-stage={marker_stage}",
                       f"error-{number}-app-state={marker_state}",
                       f"error-{number}-action={marker_action}"))
    if input_kind is not None:
        fields.append("input-kind=" + input_kind)
    if surface is not None:
        fields.append("surface=" + surface)
    if input_value is not None:
        shape, length, expected_length, settled = input_value
        fields.extend(("input-value-shape=" + shape, f"input-value-length={length}",
                       f"input-expected-length={expected_length}", "input-value-settled=" + settled))
    if ui_focus_true or ui_focus_false or first_keys_verified:
        fields.extend(keyboard_fields)
    if failure_summary is not None:
        fields.extend(xcresult_evidence(failure_summary))
    return "\n".join(fields) + "\n"


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--keyboard-observation":
        if len(sys.argv) not in (4, 5) or (len(sys.argv) == 5 and sys.argv[4] != "--require-complete-journey"):
            print("category=keyboard-observation-arguments-invalid", file=sys.stderr)
            return 2
        try:
            report = summarize(Path(sys.argv[2]), None, keyboard_only=True)
            Path(sys.argv[3]).write_text(report)
        except (OSError, ValueError):
            print("evidence-kind=native-keyboard-observation\ncategory=keyboard-observation-unavailable", file=sys.stderr)
            return 1
        print(report, end="")
        if len(sys.argv) == 5:
            fields = dict(line.split("=", 1) for line in report.splitlines())
            if (fields["scan-truncated"] != "false"
                    or int(fields["ui-focus-true-observations"]) + int(fields["ui-focus-false-observations"]) != 3
                    or fields["first-characters-verified"] != "3"):
                print("category=keyboard-observation-incomplete", file=sys.stderr)
                return 1
        return 0
    if len(sys.argv) not in (4, 5):
        print("Usage: summarize-xcode-failure LOG EXIT_STATUS SUMMARY [PRIVATE_XCRESULT_JSON]", file=sys.stderr)
        return 2
    log, exit_status, summary = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    if validated_exit_status(exit_status) == "invalid":
        print("status=FAIL\ncategory=xcode-exit-status-invalid", file=sys.stderr)
        return 1
    try:
        report = summarize(log, exit_status, Path(sys.argv[4]) if len(sys.argv) == 5 else None)
        summary.write_text(report)
    except (OSError, ValueError):
        # OS exception strings/tracebacks include runner and output paths.
        print("status=FAIL\ncategory=xcode-diagnostic-io-failed", file=sys.stderr)
        return 1
    print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
