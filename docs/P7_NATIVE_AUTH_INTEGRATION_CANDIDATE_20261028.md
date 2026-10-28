# Combined native authentication candidate — P7 OPEN

This branch combines only the related mobile authentication work, preserving
all source histories and leaving main and the original draft PRs unchanged.

| Component | Exact original head | Evidence before assembly |
|---|---|---|
| Isolated native switch, #560 |090defc733e07c8c8c6b578430830f2e49e1dfe3|Backend40730509047:19/19 integration,121/121 contracts,3/3 Chromium; binary/storage40730509442 Android+iOS PASS|
| Confirmed Android Settings navigation, #562 |845833789889936382ff940790b711c27010fad3|JS40734244619:231/231,0skip; backend40734244527:19/19,121/121,3/3; real Android40734244522 still in progress at authoring|
| iOS keyboard-focus guard/WDA prerequisites, #561 |239bb9f9b8082357dff055f6af354e29455b25dc|JS40730915301:212/212,0skip; actual iOS40730915313:1PASS/1FAIL/1NOT EXECUTED|

Merge34632d15cf4bf7b3bd0a0759939c820ab10a2d08 has the original #562 and #561
heads as parents. It applied cleanly. Server code, pilot lockfiles/dependencies
and B1 are unchanged relative to #562. No squash, rebase or production merge.
The Android candidate retains the existing mandatory three-case journey. The
iOS journey now also has #560's isolated native account-switch behavior.

## New iOS evidence and bounded recovery experiment

#561 run40730915313/job122966659105 started actual XCUITest and passed browser
cancellation. Case2 failed `MOBILE_AUTH_DEADLINE:password-keyboard-focus`, with
activeFound=true,targetMatches=false,secureType=false. The guard refused to type
the password. This proves the active element was not the intended secure field;
it does NOT establish the identity of the other element or the exact reason
focus acquisition failed. The first artifact is preserved with SHA256
`49579cc0afbf92f146286f24b84d6df8fe904ff656bdca869465a579797aa0c7`.

The recovery experiment dismisses the username keyboard through the pinned
driver's native `mobile: hideKeyboard` API (present at Appium XCUITest
77dfb1390ed33914555bfeb37ace8c9ab2f57b28). It requires two consecutive native
keyboard-absent observations, then re-finds the secure field and performs the
existing native focus actions. A delayed keyboard is also observed; only one
dismissal command is allowed. An unsupported dismissal, a keyboard that remains
visible, or a target that never gains actual keyboard focus fails explicitly.

The active-element/type gate remains mandatory before any password input. Its
typing callback uses the exact verified native element's value endpoint. The
prior hardware-key experiment's history is preserved, but it is superseded by
this deliberately verified-element path. No page JavaScript, injected result,
credential fallback, TLS bypass, consent shortcut or authentication relaxation.
Existing username integrity and all real backend/native assertions remain.

Only boolean keyboard/focus facts are retained; no values, passwords or raw
element ids. Existing60s polling and240s WDA-session deadlines, separate WDA
prebuild and zero acceptance-job reruns are unchanged. Keyboard occlusion is a
hypothesis being tested, not an established root cause or a claimed fix.

## Qualification

Local selected navigation/focus/evidence contracts53/53 PASS,0failed/cancelled/
skipped/TODO; source syntax, merge diff and all three affected workflow YAMLs
validated. Full combined Linux JS, actual backend19/server121/Chromium3,
Android/iOS binaries/storage and both normal-screen auth journeys are UNVERIFIED
on this new candidate until its exact-head CI completes. Parent evidence is
retained separately; it is not relabelled as execution of this assembled head.

First full-quality run40735922246 at8c0a8ca6 stopped on the new route file's
missing OpenAPI metadata: OpenAPI validation and the minimum-Node release
contract failed; dependent test/E2E jobs did not execute. Security audit passed.
The validation gate is unchanged. All eight real browser operations now have
canonical contracts (six root-origin paths), with the separate cookie, form CSRF,
exact Origin, PKCE binding, one-time redirects and refusal behavior documented.
The entry annotation mirrors that contract and the runtime JSON snapshot is
regenerated. No empty annotation, ignore entry or coverage-count workaround.
OpenAPI validation, server/pilot TypeScript, scoped ESLint,121/121 handler
contracts and127/127 product-surface contracts passed locally. For the last
suite, two unchanged YAML fixtures were read with the exact LF Git-blob content
used by Linux CI, then their original Windows checkout format was restored;
their Git object hashes matched and no deployment/workflow content changed.
Initial dependency/Windows-line-ending failures are retained separately.

Parent #562's actual Android run40734244522 has subsequently passed all3 native
cases:3PASS/0FAIL/0NOT EXECUTED/0skipped. This includes real isolated B switching,
native process restart, Keystore restoration and server revocation assertions.
Artifact SHA256
`b26e1c4560b480e15a1d5d987323ea3993fc9a5d2b96240985288defa5951251`
is preserved. It does not erase the prior foreign-ANR/prerequisite failures or
qualify this later combined head. Recurring ANR/root-cause work remains open.

Prior Settings failure40730509075 remains0PASS/0FAIL/3NOT EXECUTED. Prior iOS
a9da3508 run40729971780 failed before every case when WDA never became reachable
and the240s session request aborted; its artifact SHA256
`dca7a5cec499d8966c366f9fc49dbbd5b4033830deabd69230232c567831a60e` is retained.
That startup failure is separate from #561's later actual field-focus failure.

Passwordless isolated switching, configured CAPTCHA acceptance, physical phones,
Samsung/Xiaomi/Pixel hardware, minimum/intermediate/latest OS coverage, complete
messaging/uploads/calls/notifications/recovery parity, startup performance and
lossless migration remain open. Unavailable devices/OS versions are NOT EXECUTED.
No ANR/Wayland root cause is declared fixed. P7/#209/#416 remain OPEN; no #375/main
merge, deployment, B1 change, Capacitor retirement or user-data deletion.
