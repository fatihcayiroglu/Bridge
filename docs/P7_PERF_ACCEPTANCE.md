# P7 #570 — real-product desktop performance acceptance (harness, not results)

Bridge has to stay smooth while a person plays a demanding game, talks to friends and shares a screen. The earlier React/Svelte
A/B runs (#569) are synthetic windows and are **not** acceptance evidence for any row below.

`node scripts/perf-acceptance/run.mjs [report.json]` lists the ten required scenarios (PA01–PA10) and reports each as
`NOT EXECUTED` with the exact missing requirement. It measures nothing. There is no automated executor for the packaged
app yet, so today every scenario is `NOT EXECUTED` and the command exits **3** (never green).
`report.mjs` is the gate for a future real report: an `EXECUTED` entry is refused unless it carries provenance (OS, OS version,
Bridge commit, app version, machine, start/end), at least the required duration, the required number of independent remote
clients, `sfu: "real"`, and raw samples (three or more) for every required metric; a `NOT EXECUTED` entry is refused if it carries
any numbers. A report is `complete` only when all ten are executed.

| ID | Scenario | Minimum run | Needs beyond the packaged app |
|---|---|---|---|
| PA01 | Idle Bridge | 5 min | a signed-in test account on a real server |
| PA02/03/04 | Voice with 2 / 5 / 10 participants | 5 min | 1 / 4 / 9 independent remote clients through the real SFU, a real audio route |
| PA05 | Voice while gaming | 5 min | a demanding game (`BRIDGE_PERF_GAME_CMD`), FPS capture (PresentMon/MangoHud), GPU counters |
| PA06 | Voice + 1080p60 screen share while gaming | 5 min | the above + OS screen-recording permission and picker |
| PA07 | Voice + screen share + active messaging while gaming | 5 min | the above + 2 remote clients |
| PA08 | 10,000-message history and scrolling | 2 min | a channel seeded with 10,000 messages |
| PA09 | 1440p and 4K capture | 5 min | a display that supports them, GPU counters, screen-recording permission |
| PA10 | Network degradation and recovery | 10 min | a network shaper (tc/netem, Network Link Conditioner, clumsy) |

Metrics collected per scenario (see `scenarios.mjs`): CPU per Bridge process, GPU utilization, working set, game average and 1%-low
FPS, mouth-to-ear latency, audio glitches, packet loss and jitter, capture/encoded/sent/received/presented FPS and dropped frames,
input latency, reconnect time and resource growth.

## What is missing before any row can run
1. An executor that drives the **packaged** Windows, macOS and Linux (X11 and native Wayland) apps with a seeded test account (PA01, PA08 first: they need no game or remote clients).
2. Independent remote clients on separate machines, joined through the real SFU.
3. A game and a frame-capture tool per OS, GPU counters, screen-recording permission, and a network shaper.
4. Physical hardware for 1440p/4K and for audio routes. Hosted CI runners have none of these, so CI can run at most PA01 and PA08.

No measurement is claimed anywhere. Do not merge into production `main` without owner approval.
