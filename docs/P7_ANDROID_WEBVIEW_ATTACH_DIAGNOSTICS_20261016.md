# Android WebView attach failure — bounded diagnostic evidence

**Status: hypothesis/diagnostics only.** The first failing PR #313 run [38951478055](https://github.com/fatihcayiroglu/Bridge/actions/runs/38951478055) at `ff22d31` produced **23 PASS / 12 FAIL / 0 SKIPPED**, after the P01 denied-microphone permission journey. P03 failed at `device.webView({pkg})` after 60 s despite a live Android Activity/process. The later voice, camera, picker and UI failures depend on the missing WebView/page. L01/ANR01 passed; that neither proves nor disproves a Chromium renderer/DevTools failure.

**New diagnostic**: the *failure-only* attach handler inspects `/proc/net/unix`, publishes only the number of WebView DevTools sockets and whether a socket belongs to the active app PID. A native PID with no matching socket would distinguish native Activity launch from WebView inspectability. This is supplemental evidence, not retry/pass, and raw socket names are not logged.

- Keep P03, subsequent tests and final exit nonzero when assertions fail. Do not extend timeouts, skip later tests or call a rerun a fix.
- Unit tests verify missing/present sockets, wrong PIDs, invalid selectors, and redaction of sensitive raw lines.
- The older failure-only OS crash/activity evidence is retained; investigate whether it needs additional privacy minimization later.
- A single isolated failed-job rerun of #313's original red Android job was requested to assess reproducibility. Its result is **separate** from exact-head validation of this diagnostic PR.
- Android issue [#209](https://github.com/fatihcayiroglu/Bridge/issues/209) remains OPEN. Real-device certification and original ANR investigation remain outstanding.

## Addendum — CDP page-level failure diagnostic (21 October 2026)

L03 can fail with a resumed Activity, the app's DevTools Unix socket and an
HTTP-responsive `/json/list` containing a page, while Playwright still cannot
attach to the WebView. These observations do **not** establish a responsive CDP
page or successful session recovery.

The failure-only probe now attempts a single bounded WebSocket handshake to a
`/devtools/page/<id>` endpoint advertised by `/json/list` for `localhost` or
`127.0.0.1` on the exact temporary ADB-forwarded port. The connection always
uses the `127.0.0.1` literal: a `localhost` hostname would depend on the
resolver (hosts file, or `::1` first, where the ADB forward does not listen).
A `Runtime.evaluate` request for the constant `1+1` distinguishes a responsive
CDP page from socket/handshake/protocol failure. Only `attempted`, `handshake`
and a fixed status value (`responsive`, `timeout`, `socket-error`,
`socket-closed`, `protocol-error` or `unverified`) are logged, as
`devtoolsHttp.cdp` and mirrored in the top-level `cdpPageResponsive` field.
Raw URLs, target titles, page data, protocol replies, tokens and device IDs
stay in memory. The ADB forward is removed in a `finally` block.

How to read the result next to an L03 attach timeout:

| `handshake` | `result` | What it shows |
|---|---|---|
| `true` | `responsive` | The page's CDP endpoint works; the failure is between Playwright's WebView discovery/attach and the page, not a frozen renderer. |
| `true` | `timeout` | The page accepted a CDP connection but did not evaluate `1+1` within 4 s: the renderer/JS thread was not serving CDP. |
| `false` | `socket-error` / `timeout` | The forwarded socket did not complete a WebSocket handshake. |
| any | `protocol-error` / `socket-closed` | The endpoint answered with an error or closed the session. |

The probe lives in `e2e/android/exit-diagnostics.mjs` (`probeWebViewCdpPage`)
so its unit tests cover every result, timer cleanup, and a real Node
`WebSocket` against a local RFC 6455 server.

This is **diagnostics only**: it does not add retry attempts, extend the L03
timeout, bypass failed assertions, prove normal application restoration or
classify an emulator failure as passed. Product L03 remains a strict gate.
