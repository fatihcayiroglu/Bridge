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

The failure-only probe now attempts a single bounded WebSocket handshake to an
allowlisted `ws://localhost` / `ws://127.0.0.1` page endpoint on the exact
temporary ADB-forwarded port. A `Runtime.evaluate` request for the constant
`1+1` distinguishes a responsive CDP page from socket/handshake/protocol
failure. Only `attempted`, `handshake` and a fixed status value are logged;
raw URLs, target titles, page data, protocol replies, tokens and device IDs
stay in memory. The ADB forward is removed in a `finally` block.

This is **diagnostics only**: it does not add retry attempts, extend the L03
timeout, bypass failed assertions, prove normal application restoration or
classify an emulator failure as passed. Product L03 remains a strict gate.
