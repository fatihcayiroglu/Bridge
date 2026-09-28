# Bridge media lab

Disposable, reproducible lab for **real** voice/video evidence. Nothing in the
media path is mocked:

| Component | Real / synthetic |
|---|---|
| Bridge nodes A and B (`node server/dist/index.js`, `NODE_ENV=production`, `BRIDGE_MULTI_NODE=true`) | real processes |
| mediasoup workers (one per node, separate RTC port ranges) | real |
| PostgreSQL, Redis, S3 (moto) — reused from `scripts/multinode` | real processes |
| Routing load balancer (`?bridgeNode=` SFU routing, cookie affinity) | real HTTP/WS proxy |
| coturn (`use-auth-secret`, UDP + TCP; no TLS) | real TURN server |
| Clients | real Chromium processes, each **inside its own Linux network namespace**, loading the production web bundle and joining through the real UI |
| Audio / video sources | Chromium fake capture fed with per-client fixtures (`fixtures.py`): a sine tone at 440 + 220·i Hz and a 640x480 video with a per-client identity colour |
| Network impairment | **synthetic**: `impair.py`, a userspace link between each namespace and the host over TUN devices (the host kernel has no `netem`) — real kernel packets, synthetic delay / jitter / loss / bandwidth / blackhole |
| Handoff | synthetic: a second interface + address in the namespace, the old one taken down |

Receivers prove media by what they **decode**: the dominant frequency of each
remote audio track (WebAudio FFT) identifies the sender; the top quarter of
each remote video frame identifies the sender's camera. `getStats()` adds
loss, jitter buffer, concealment, NACK/PLI, bitrate, resolution and the
selected ICE candidate pair (`relay` proves TURN).

## Topology

```
 netns ml0 (10.78.0.2) ─ impair.py ─┐
 netns ml1 (10.78.1.2) ─ impair.py ─┼─ host: 10.77.0.1  LB :3100 → nodes A :3101 / B :3102
 netns mlN (…)          ─ impair.py ─┘         mediasoup A 40000-40999 / B 41000-41999
                                        10.77.0.2  coturn :3478 (relay 50000-50999)
```

Clients cannot reach each other (no IP forwarding) — every packet goes
through the SFU or TURN. `nftables` rules can block the SFU's media ports
(relay-only networks), TURN entirely, or TURN over UDP (forces TURN/TCP).

## Running

Needs root, `/dev/net/tun`, iproute2, nftables, coturn, faketime, Redis,
PostgreSQL binaries, Python 3, a Chromium build (Playwright's) and moto:

```bash
npm run build && (cd server && npm run build)      # production web bundle + server
sudo -E MN_MOTO_SERVER=$(command -v moto_server) \
  node scripts/medialab/run.mjs --scenarios e2e,turn --out /tmp/medialab-report
```

Scenarios: `e2e`, `turn`, `impair`, `netchange`, `failover`, `lifecycle`,
`authz`, `multiuser`, `soak` (`SOAK_MINUTES`, default 10;
`IMPAIR_ONLY=interruptions` skips the profile matrix). Each writes
`report.json` / `report.md`: `PASS`, `FAIL`, `BLOCKED`, `SKIPPED` (never
counted as passing) and `INFO`/measurements. The report is written before
teardown.

coturn runs in its own process group and is stopped as a group (`faketime`
forks it as a child); a start removes stray lab TURN servers and refuses to
continue while any other process listens on the TURN address — a second
server on the port (SO_REUSEPORT) silently refuses a share of the
allocations. `TURN-LAB` records that no stray had to be removed.

CI: `.github/workflows/media-evidence.yml` (weekly + manual). Not part of PR
CI; the fast regression tests for the defects found here are client Vitest
suites in the Quality Gate.

## What the lab does not prove

Perceptual audio/video quality, echo cancellation and noise suppression (no
acoustic path), real Wi-Fi/cellular radios and physical devices, real WAN
behaviour, TURN over TLS, multi-host production topology or production
traffic. See `docs/MEDIA_RELIABILITY.md`.
