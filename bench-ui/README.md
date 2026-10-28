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
Five warmups are followed by 30 measured rounds, alternating the order of
Svelte and React to reduce drift. Compare p50 and p95 only within the same
runner and the same Electron version. **Never infer CPU/RAM, voice/video,
file uploads or complete-app parity from this test.**
