# P7 iOS browser transport investigation — 2026-10-30

P7 remains OPEN. This change adds evidence and fixes diagnostic privacy defects;
it does not establish a fix for the native authentication failure.

## Preserved first evidence

PR #553 head `ff31737b150cbb9e85c59fbb41c20dc05727bef8`, first native run
[40790887919](https://github.com/fatihcayiroglu/Bridge/actions/runs/40790887919),
job `123175534130`: **1 PASS / 1 FAIL / 1 NOT EXECUTED / 0 skipped**.
The cancellation case passed. Authentication/restart/rotation failed waiting for
`system-authentication-browser`; account-switch/revocation never ran. The final
closed accessibility evidence had 0 text fields, 0 secure fields and 3 visible
web views. This is not the older password-key-command HTTP 500 failure.

Artifact `12861829424` was downloaded and SHA-256 verified:
`ffbd015ee316e101c2298643178d7a95252bcb583927fbf2f899b02152ace5ca`.
Only closed JSON and fixed wire records were inspected. Its old proxy log has
two fixture `servers:200` records, and no native-code/refresh records. It did not
instrument document/assets/TLS, so it cannot distinguish page transport failure
from loaded-but-inaccessible browser content. No existing artifact was altered.

## New observation boundary

The disposable HTTPS proxy records fixed request categories and phases:
document, script, style, CSRF, native-login/authorize/code/refresh, other;
request, response, complete, aborted, upstream-error. TLS events record a secure
connection or a fixed allow-list of client error codes (unknown maps to OTHER).
No URL, query, state, challenge, body, cookie, token, account name, raw TLS error,
certificate, driver arguments or request ID is emitted by this observer.

Each native case retains aggregate events in its own time window and its elapsed
duration. Missing/truncated proxy evidence is null, not zero or PASS. Case-window
events may include native application API traffic; they do not identify a browser
solely from an HTTP connection. A complete response means the fixture wrote the
response, not that WebKit rendered it. Reused TLS connections may produce HTTP
events without a new secureConnection event. No request retry, page reload,
authentication bypass, timeout increase or acceptance relaxation was added.

The UI survey now emits only fixed labels. A plain-letters regex admitted private
account names, passwords and messages. The journey no longer captures screenshots
at consent, after sign-in or on failure. Its existing closed accessibility counts,
field geometry/focus, password-placement assertions and database checks remain.

## Local verification and limitations

Two privacy regressions first failed **0 PASS / 2 FAIL / 0 skipped**; saved TAP
SHA-256 `268f76092be6b8bec3ff9dd80d45fbe8d75be235b91c591a5c952671ee2d27d5`.
Focused new/existing evidence tests then passed **36/36**, zero skipped, including
real loopback HTTP completion and deliberate socket interruption. The first
focused run was **35 PASS / 1 FAIL** because the test asserted before the server's
response-close event; the fixture now explicitly awaits that event, without a
sleep or changed production assertion. Existing WebDriver contracts passed **6/6**.
Pilot TypeScript passed. Exact-lockfile pilot install audited **0 vulnerabilities**.

The full local pilot run did not complete: Windows resolves bash to the Windows
Apps launcher, and existing synchronous Bash fixtures stalled. Only the verified
test runner and its descendants were terminated. Its incomplete TAP is preserved;
it is not a passing full-suite result. Linux CI must execute the full suite with
zero skipped tests. macOS CI must run the actual simulator journey; this Windows
host has no Xcode/iOS runtime. Hardware and other OS acceptance remains NOT
EXECUTED. Keep #553 and this child draft, preserve both histories, do not deploy
or merge into production main.
