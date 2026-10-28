# Bridge P7 — desktop viewport acceptance (draft)

This check complements the RN native phone/iPad matrix in PR #554. It covers
the **real Bridge web app** in headless Chromium, Firefox, and Playwright WebKit
on a Linux CI runner. Playwright WebKit is **not** macOS Safari on an Apple
computer, and this job is **not** a native Electron Windows/macOS/Linux test.

Tested CSS viewport sizes:

| Situation | Browser viewport (CSS pixels) |
| --- | --- |
| small laptop | 1280 × 720 |
| common laptop | 1366 × 768 |
| Full HD | 1920 × 1080 |
| QHD / 2K class | 2560 × 1440 |
| UHD / 4K | 3840 × 2160 |
| narrow desktop window | 1024 × 768 |
| short window | 1280 × 600 |

For each viewport and each of three browser engines, a real authenticated app
is opened and the following are **asserted**:

1. The app shell and at least one enabled visible action are rendered.
2. No horizontal document scrolling; the app shell itself is not replaced by
   an empty page. No vertical page scrolling outside the app shell.
3. Primary search/settings controls (when the desktop layout is expected to
   expose them) have visible, non-clipped bounds inside the viewport.
4. JavaScript page errors are absent. A real screenshot and exact measurement
   JSON are attached for every passing test and the first failure.
5. The same signed-in browser page survives window shrink and expansion.

The 24-case outcome gate requires **exactly 24 first-attempt PASS results**:
8 journeys × 3 engines. Any skipped/not-executed case, failed test, retried
test, or missing browser keeps CI red; `--retries=0` is pinned.

This measures CSS pixels, not the actual hardware monitor's physical inches,
Windows 125/150/200% scaling, GPU driver, multiple monitor arrangements,
system text zoom, Electron windows, or native Windows/macOS/Linux usability.
Those need separate platform and accessibility evidence. No tests are weakened
and no claim of full release readiness follows from this smoke matrix.
