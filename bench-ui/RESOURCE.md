# Desktop renderer CPU and RAM benchmark under local WebRTC load

Eight paired runs per platform (Svelte 5 and React 19; same Electron binary,
1280×800 viewport, local synthetic message UI):

| Case | Measured load | Explicit boundary |
| --- | --- | --- |
| `idle` | Static mounted renderer | Not the full Bridge process tree |
| `messages` | 10,000 messages, 800 appended, 8 draft edits | Synthetic renderer, not network messages |
| `voice2` | 1 local duplex-negotiated audio RTP link | Not 2 physical Bridge users |
| `voice5` | 4 parallel audio RTP links (star) | Not a server-hosted 5-person SFU |
| `voice10` | 9 parallel audio RTP links (star) | Not a real 10-person conference |
| `video2` | Audio + 640×360 15fps generated canvas video | Not camera or GPU capture |
| `screen2` | Audio + 1280×720 15fps generated canvas video | Not OS screen or system audio |
| `voice2_chat` | 1 live audio RTP link while mutating 10,000+ message DOM | Not real Bridge voice |

Every scenario uses one warmup + five measured rounds per candidate in
alternating framework order. Each media session is connected and receiving
real RTP *before* the CPU interval begins. A paired Electron
`app.getAppMetrics()` call gives **renderer-process** average CPU
`percentCPUUsage` across the measured interval and an after-interval
working-set snapshot; CDP `TaskDuration` records renderer main-thread work.
The report includes all raw intervals, p50/p95 summaries, received RTP and
**presented** video frames where applicable. Video acceptance requires BOTH
inbound RTP packets and five genuinely presented frames in the measured
interval, determined from `HTMLVideoElement.getVideoPlaybackQuality()` minus
dropped frames; a media packet alone cannot count as a rendered frame.
This avoids relying on the optional WebRTC `framesDecoded` stats field,
missing on one observed macOS runner, without accepting unrendered video.

The test is **red** if CPU, renderer RAM, either framework, a scenario, live
RTP or actually presented video is missing. The contract tests reject a fabricated
summary and assertions cannot be skipped. First-failure artifacts are kept
without rerunning failed CI jobs.

Do **not** interpret this as whole-machine CPU, total app memory, GPU percent,
power/battery usage, full real Bridge React parity, actual media devices,
hardware Bluetooth routes, screen capture permission, system audio,
end-to-end acoustic latency or real-network call quality. Local candidate RTT,
if available, is strictly a loopback ICE measurement.

The same code runs in real Electron under hosted Ubuntu, Windows and macOS.
Comparisons are only valid within each OS runner and exact commit head.
Device/hardware acceptance and Windows/macOS real Bridge feature parity
remain independent NOT EXECUTED work.
