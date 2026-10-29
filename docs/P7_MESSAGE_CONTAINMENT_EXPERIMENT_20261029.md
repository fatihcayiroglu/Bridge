# P7 plain-message rendering containment experiment — NOT performance acceptance

Base: #580 `e219a7a9598c8316f00ab3f0b1477b85a0e3736b`; original history preserved.

## Evidence and hypothesis

Actual packaged Linux X11 run 40794522256 / job 123187608778 reached 5950 message DOM elements but failed PA08. Its failed-attempt CPU/memory growth is diagnostic, not an accepted PA08 measurement. Layout versus script/network cost is not yet established. The baseline retains its first failure; no rerun overwrites it.

The subsequent diagnostic baseline at e219a7a9598c8316f00ab3f0b1477b85a0e3736b, run 40796925234 / job 123195525418, failed before any scenario at AUTH_RESPONSE / AUTH_RESPONSE_UNAVAILABLE. Login form and populated input booleans were visible, login function existed, no login HTTP response was observed, and there were no recorded API network failures or runtime errors. This does not establish an authentication root cause. Artifact 12863559955 SHA-256: `3fd0df4292e14a6bcd9e05440071bd5a2782d305ce17ada9c364836fa27536b6`.

## Candidate

Use CSS content-visibility:auto and remembered intrinsic block size only for short, single-line, delivered normal messages with one plain text node. Keep the full DOM and existing keyboard/reply identifiers. Exclude pending/failed messages, replies, attachments, stickers, reactions, embeds, pinned rows and crosspost controls. Open action sheets, history/report dialogs, reaction pickers and image viewers opt out immediately, including touch paths without hover/focus. Hover/focus and print force visible rendering. Unsupported CSS retains ordinary rendering. No dependency, authentication, message cache, backend or persistence change.

Specification: https://www.w3.org/TR/css-contain-2/#content-visibility . This permits offscreen layout/paint skipping; it is not DOM virtualization and does not bound message-store memory.

Potential risks: estimated unvisited row heights and scroll anchoring; skipped paint interacting with focused actions; no established CPU improvement. The focused native CI retains the 120-second/full-10000 history gate, verifies first/last actual viewport visibility, ArrowUp to the adjacent message, and requires real contentvisibilityautostatechange skipped events. Failed attempts remain unqualified and retain numeric diagnostics. An unchanged control run and physical-device evidence are still needed for a causal performance claim.

## Local verification

- Existing message renderer/dialog/embed/list keyboard component suites: 105/105 PASS, zero failed/pending/skipped. An initial incorrect root-directory invocation collected zero tests and exited 1; it is not counted. Corrected client working directory executes the suites.
- Executor/report integrity contracts: 12/12 PASS, zero skipped.
- Strict client TypeScript: PASS.
- Svelte check: 0 errors, 0 warnings.
- Production Svelte build: PASS.
- Actual packaged candidate measurement: pending CI; NOT EXECUTED locally (no native Linux runtime).

P7 remains OPEN. No startup SLA, native mobile compatibility, Wayland fix, durable delivery or complete performance acceptance is claimed. No deployment or main merge.


Latest containment head 2a51c5b7f51ab0590fd8f842bef285097003fc97 first run40798429405/job123200421428 FAILed before scenarios: AUTH_RESPONSE/AUTH_RESPONSE_UNAVAILABLE. CI12 executor +105 component tests and actual builds passed, zero skipped; no native containment measurement. Artifact12864139735 SHA2567b6735daabacd9abf8e0e4be6f74913fdae3d2d79141f310918f9736a4a4a122 downloaded/verified. A follow-up observes only login pointerdown/captured-click/bubbled-click counts, request count, document-ready/disabled/message-presence booleans. It changes no product authentication, retries, timeout or event propagation. Values, messages, tokens and raw driver exceptions are never exported. Authentication causality remains OPEN; a later successful run cannot by itself classify the intermittent issue fixed.
