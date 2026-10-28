# Isolated desktop UI A/B benchmark

This experiment compares a **synthetic** message list rendered with Svelte 5 and
React 19 under the same Electron, Chromium, CSS, viewport and fixture data.
It is a narrow **renderer microbenchmark**, not a replacement for Bridge's
real desktop performance / WebRTC / screen-share / upload acceptance tests.

The benchmark does **not** claim a complete React rewrite of Bridge exists.

In a GitHub Actions Ubuntu runner (or Linux machine with an X server):

```bash
npm ci
npm ci --prefix electron
npm ci --prefix bench-ui
node bench-ui/build-assets.mjs
xvfb-run -a electron/node_modules/electron/dist/electron --no-sandbox bench-ui/electron-benchmark.cjs
```

The runner fails on missing controls, wrong message counts, timeouts or
incomplete samples. It prints `BENCHMARK_RESULT` and creates a JSON artifact.
The scenarios are 1,000 messages (5 warmups + 30 measured rounds) and 10,000
messages (3 warmups + 12 rounds). Each compares list construction, one append,
100-message burst append, filter and an eight-update composer draft burst. The
draft result is the sum of eight independently verified DOM commit durations,
because some individual composer updates fall below browser timer resolution.
Framework order
alternates each round to reduce drift. Each duration ends at the `MutationObserver`
notification when the expected number of DOM elements has committed. The
two animation frames are awaited for correctness, **not included in timing**.
The separate cross-platform jobs exercise the same fixture in real Electron on
Windows and macOS. GUI access on hosted runner images is an environment
requirement; a missing desktop session is a red **NOT MEASURED** job, never a
product regression or an invented comparison. Compare p50 and p95 only within
the same OS/runner and the same Electron version: Windows, macOS and Linux
hosted runners can differ in CPU and scheduling.
Memory is sampled through Electron's OS renderer-process working-set metric,
never through `performance.memory` (which may report privacy-clamped constants).
This is **one snapshot**, and shared Chromium resources, GC and runner conditions
prevent any claim about real Bridge's RAM use, memory peaks or power draw.
**Never infer CPU/RAM, voice/video,
file uploads or complete-app parity from this test.**
