# Voice / video media reliability (P2)

This document records how a Bridge voice/video call actually moves media, who
is authoritative for each piece of state, what survives which failure, and the
evidence gathered with **real browsers, real mediasoup, real coturn and real
packets** in the disposable media lab (`scripts/medialab`, see its README).

It complements `docs/DISTRIBUTED_AUTHORITY.md` (P1: control-plane
correctness across nodes). Nothing here is production traffic, a physical
device, a real Wi-Fi/cellular network or a human listening test — see
[What is not proven](#what-is-not-proven).

## Media path

```
UI click (ChannelItem → ChannelStagePanel)
 └─ BridgeRTC.joinVoice (client/js/webrtc-sfu.ts)
     1 voice:get-capabilities ──────────────► app node: isSFUReady (local workers)
     2 getUserMedia (AEC/NS/AGC prefs, optional BridgeNS)             [browser]
     3 sfu:get-rtp-capabilities ────────────► app node
          authorizeMediaRoom  (PostgreSQL: channel, member, timeout, VIEW+CONNECT)
          getOrCreateRoom → sfuRegistry.claimRoom (Redis CLAIM_LUA: room key,
                             node lease, registry epoch)
            owned  → router on a local mediasoup worker
            remote → sfu:redirect{ownerNodeId} → client opens a dedicated
                     socket ?bridgeNode=<owner> (LB routes by INSTANCE_ID,
                     server rejects a mismatched route, JWT re-verified)
     4 sfu:join ────────────────────────────► owner node
          authorizeMediaRoom again; peer in process memory; socket joins
          Socket.IO room voice:<ch>; reply sfu:joined{existingPeers,
          iceServers (STUN + TURN REST credential, HMAC(TURN_SECRET), 24 h),
          iceTransportPolicy (FORCE_TURN → relay)}
     5 sfu:create-transport ×2 (send/recv) ─► owner: WebRtcTransport on the
          router (announced IP, UDP+TCP, RTC port range) → ICE/DTLS params
     6 mediasoup-client transports = RTCPeerConnections created WITH the
          issued iceServers + policy  (fixed in P2, MEDIA-04)
          ICE: browser is the controlling agent, mediasoup is ICE-lite
            direct: host/srflx → SFU announced IP:port
            relay : TURN allocation on coturn → relay candidate → coturn
                    relays to the SFU IP:port
     7 DTLS: transport 'connect' → sfu:connect-transport → transport.connect
          (mediasoup DTLS server) → SRTP keys; server closes a transport whose
          DTLS fails/closes
     8 produce: sfu:produce (authorize with SPEAK; stage speaker) → Producer
          → sfu:new-producer to voice:<ch>
     9 router forwards RTP in the worker; per-consumer simulcast layer
          selection from mediasoup's bandwidth estimate
    10 consume: sfu:consume (authorize, producer belongs to room, canConsume)
          → paused Consumer → sfu:consumed → client consume → sfu:resume-consumer
    11 remote track → peerStreams → VoicePanel (voicePanel:* registry owners,
          fixed in P2, MEDIA-03) → <audio class="remote-audio"> (sink id,
          deafen) / video tiles
```

## Authority matrix

| State | Authority | Survives app-socket reconnect | Survives non-owner node death | Survives owner node death / restart | Survives worker death | Survives Redis outage | Survives WAN loss / network change |
|---|---|---|---|---|---|---|---|
| Channel / membership / permissions | PostgreSQL | yes (re-checked on every SFU operation) | yes | yes | yes | yes | yes |
| SFU room ownership | Redis `bridge:sfu:room:<ch>` + node lease + epoch | yes | yes | lease expires (30 s) → takeover on the next claim | released by the worker-close handler | owner fences the room 25 s after the last confirmed lease refresh (P1 fail-closed); new claims refused while unreachable | yes |
| Router, transports, producers, consumers | owning node's mediasoup worker (process memory) | **no** when the socket carrying SFU signaling drops (server `disconnect` → `cleanupPeer`) | yes if the client's SFU signaling runs on a dedicated owner socket | no | no | no after fencing | yes while ICE recovers (< ~15 s); after ICE `failed`, no |
| Peer roster (`voice:room-update`) | owner node process memory | rebuilt on rejoin | yes | rebuilt on the new owner | rebuilt | rebuilt | yes |
| Socket.IO `voice:<ch>` membership | per-socket, Redis adapter | no (new socket) | yes (other nodes) | no | yes (stale until rejoin) | adapter degraded | yes if the socket survives |
| ICE selected pair / consent | browser ICE agent + mediasoup ICE-lite tuple | yes | yes | no | no | yes | a new address needs new checks; a `failed` agent needs a new transport |
| TURN allocation | coturn process memory (600 s lifetime, refreshed) | yes | yes | yes | yes | yes | lost if coturn restarts |
| TURN credential | stateless HMAC, 24 h TTL | re-issued on every join | — | — | — | — | — |
| DTLS / SRTP keys | per transport (browser + mediasoup) | recreated with the transport | yes | recreated | recreated | recreated | kept while the transport lives |
| Mute / deafen / camera / screen intent | client (UI + track.enabled), mirrored to the owner via `voice:state-update` | kept; re-published after recovery (P2) | yes | kept; re-published | kept; re-published | kept | kept |
| Capture tracks (mic, camera, screen) | browser | kept | kept | kept | kept | kept | kept |

## Session recovery (P2, MEDIA-05)

Before P2 a lost media session was never re-established:

- the app socket dropping (network loss ≥ ~20 s, the socket's node dying)
  ended the call client-side even when the media ran on a healthy dedicated
  owner socket;
- ICE reaching `failed` (TURN restart, WAN loss > ~15 s, worker or owner death,
  Redis-fenced room) left the call on screen **with no media and no signal to
  the user**.

`BridgeRTC` now supervises the session:

| Trigger | Action |
|---|---|
| a transport's connection state becomes `failed` | re-establish the session |
| the dedicated owner socket drops (transport-level reason) | re-establish the session |
| the app socket drops (transport-level reason) and SFU signaling rides on it | wait for the app socket to reconnect, then re-establish |
| the app socket drops but a dedicated owner socket is alive | nothing — media is unaffected |
| a server- or client-initiated disconnect (revocation, logout, replacement) | end the call (unchanged) |

Re-establishing runs the **normal join path** (capabilities → redirect →
join → transports → produce/consume), so every authorization check applies
again; a refusal (`FORBIDDEN`, `INVALID_*`, `SESSION_MISMATCH`) ends the call
instead of retrying. Attempts back off (1, 2, 4, 8 s …) inside a 90 s window
— longer than the 30 s owner lease plus the registry settle window, so a
surviving node can take the room over. Local capture tracks are kept and
re-published; the user stays muted if they were muted; remote MediaStream
objects are reused so the UI's audio elements keep playing.

## Defects found with real media (all fixed)

Each was reproduced with real media on the unfixed build (FAIL) — in the lab,
or for MEDIA-12 in the two-browser Playwright suite (`e2e`, project
`voice-media`) — fixed, covered by a fast regression test that fails on the
old code (negative control run), and re-verified the same way (PASS).

| Id | Lab check (before → after) | Defect | Fix | Fast regression test |
|---|---|---|---|---|
| MEDIA-01 | any join: `TypeError: … is not a constructor` → E2E-01..17 PASS | the production bundle could not construct a mediasoup `Device`: every SFU voice join failed | loader unwraps the CommonJS namespace (`client/js/core/mediasoup-client-loader.ts`) | `client/tests/mediasoup-client-loader.test.ts` (bundles with production esbuild settings) |
| MEDIA-02 | E2E-01 FAIL (late joiner: 0 inbound audio packets) → PASS | producers announced before the receive transport existed were dropped: a late joiner was deaf | pending-consume queue | `webrtc-sfu.test.ts` › late join |
| MEDIA-03 | E2E-04 FAIL (0 `audio.remote-audio` elements) → PASS | SFU engine targeted the unregistered `bridgeApp`: no remote audio playback, tiles, state or video | shared `core/voice-panel-adapter.ts` | `webrtc-sfu.test.ts` (canonical owners; 11 stale tests re-pointed) |
| MEDIA-04 | TURN-01/02/09 FAIL (transport PCs: policy `all`, no ICE servers) → PASS (`relay` pairs) | SFU transports ignored the issued TURN servers and relay policy | pass `iceServers`/`iceTransportPolicy` to both transports | `webrtc-sfu.test.ts` › ICE servers and relay policy |
| MEDIA-05 | FO-01..05, FO-09, IMP-INT-20s/40s, TURN-07/14, NC-01/02 FAIL → PASS | no media-session recovery (dead call on screen, or call ended although media was healthy) | session supervisor; `stopTracks:false`; stale-signaling reconnect; `replaces` | `webrtc-sfu.test.ts` › recovery, dead transport, replaces; `mediasoup-handlers.test.ts` › replacing a lost session |
| MEDIA-06 | LC-03 FAIL (no new capture after save) → PASS | Settings → Devices read `window.BridgeRegistry` (never set): device changes never reached the call | import the registry module | `devices-tab-*.test.ts` (fixtures no longer install the fake global) |
| MEDIA-07 | every profile: top simulcast layer `r2` never sent → 2 layers, full-resolution top | fixed /4 /2 /1 layers: libwebrtc sends 2 layers for 640x480 and drops the TOP one → max 320x240 | layers sized to the capture | `webrtc-sfu.test.ts` › camera simulcast layers |
| MEDIA-08 | AZ-04/05/06 FAIL (media kept flowing) → PASS | CONNECT / SPEAK revocation and member timeout did not affect an established call | live voice-access re-check; cross-node publish revocation; timeout hook | `live-voice-access-revocation.test.ts`, `voice-eviction-cross-node.test.ts`, `moderation-branch-closure.test.ts` |
| MEDIA-09 | AZ-03: UI still in call 48 s after VIEW revoked → ends immediately | an evicted client was never told and kept showing a live call | server `voice:evicted` → client ends the call | `voice-eviction-cross-node.test.ts`, `webrtc-sfu.test.ts` |
| MEDIA-10 | LC-04 FAIL (camera shown on after the device ended); LC-05 silent mic loss → PASS / muted + notice | engine-side state changes never reached the VoicePanel | `bridge:voice-local-state`; microphone loss marks muted and tells the user | `VoicePanel.test.ts`, `webrtc-sfu.test.ts` |
| MEDIA-12 | `voice-media` SA1–SA11 FAIL (1 `audio.remote-audio` element for microphone + system audio) → PASS | the SFU client kept one audio and one video `MediaStream` per peer: a share's system audio played inside the microphone element (its own element, and its removal when the share stops, never happened), camera and screen views rendered the same stream, and a closed producer's ended track stayed in it | one stream per producer kind; a closed producer's track leaves its stream; the VoicePanel trusts the kind the SFU names (a camera turned on during a share no longer takes over the screen view) | `webrtc-sfu.test.ts` › one stream per producer kind; `VoicePanel.test.ts` › SFU system audio / camera during a share |

Classified, not changed:

- **Mute** disables the track (mediasoup-client `pause()` without
  `zeroRtpOnPause`): ~5 packets/s of Opus DTX comfort noise keep flowing, no
  audio content. **Deafen** mutes playback only; packets keep arriving.
- **Opus stays at 64 kbit/s** under a constrained uplink (no audio bitrate
  adaptation): at 64 kbit/s links audio concealment reached ~35 %.
- The SFU registry logs `Cannot read properties of undefined (reading
  'destroy')` after a timed-out Redis connect; measured harmless (Redis client
  count unchanged across outages, FO-10).
- The P2P fallback (no mediasoup) is not exercised by the lab.

## Evidence

**Final full run** — product build `3c7b926` (the code merged by PR #100 as
`main 4570778`), 2026-09-27; one host (4 vCPU, 16 GB), Chromium 1194
(Playwright), coturn 4.6.1, mediasoup 3.26.0, mediasoup-client 3.23.1,
PostgreSQL 16.13, Redis 7.0.15, Node 22.22.

| Scenario | PASS | FAIL | BLOCKED | SKIPPED | INFO / measurements |
|---|---|---|---|---|---|
| e2e | 15 | 0 | 0 | 0 | 3 |
| turn | 10 | 1 | 0 | 0 | 4 |
| impair | 7 | 0 | 0 | 0 | 2 |
| netchange | 2 | 0 | 1 | 0 | 1 |
| failover | 11 | 0 | 0 | 0 | 1 |
| lifecycle | 7 | 0 | 0 | 0 | 2 |
| authz | 7 | 0 | 0 | 0 | 2 |
| multiuser | 11 | 0 | 0 | 0 | 1 |
| soak (20 min) | 2 | 0 | 0 | 0 | 2 |
| **total** | **72** | **1** | **1** | **0** | **18** |

The FAIL (TURN-09) and the BLOCKED (NC-02) were a **lab defect**, not a
product one: three coturn processes were listening on the TURN port at once
(SO_REUSEPORT) — the lab's own, the `faketime` instance from TURN-12 (killing
the `faketime` wrapper left its `turnserver` child running with a clock 25 h
ahead) and one left over from an earlier run with another secret — so the
kernel spread allocations across them and some were refused ("Cannot find
credentials"). The lab now runs coturn in its own process group, kills the
group, removes stray lab TURN servers before a start and refuses to run while
anything else listens on the TURN port (`TURN-LAB` checks it).
**Re-run of `turn`, `netchange`, `impair` on the fixed lab** (same product
build): **24 PASS, 0 FAIL, 0 BLOCKED, 0 SKIPPED**, 7 INFO — TURN-09 and NC-02
pass; `TURN-LAB` confirms no stray TURN server. A second `impair` run (after
the `rates()` fix): 7 PASS, **1 FAIL** (IMP-04, open finding MEDIA-11 below).

### Two-browser suite (`e2e`, Playwright project `voice-media`)

33 tests, two or three real Chromium contexts against one local Bridge server
with its mediasoup SFU (fake capture devices, a synthetic display source with
a moving canvas and a 660 Hz tone). It asserts on the UI (remote
`<audio>`/`<video>` elements) as well as `getStats()`, which the lab does not —
that is how it found MEDIA-12. It is not part of PR CI (nightly `e2e-full`,
itself not yet runnable: its job has no schema/migrations and no Redis).

| Run | Passed | Failed | Cause of the failures |
|---|---|---|---|
| `main e07dc85`, server started as CI starts it | 15 | 18 | **environment**: no announced SFU address, so mediasoup offered `0.0.0.0` and no RTP flowed (8 tests); plus the 10 below |
| same, `MEDIASOUP_ANNOUNCED_IP=127.0.0.1` | 23 | 10 | **product** MEDIA-12 (6 system-audio tests); **fixture** (S3/S4); **stale contract** (3) |
| this change, first two runs | 32 | 1 | **harness** (below): SA1/SA3's voice channel was never created — the same test both times |
| after the harness fix, third run | 30 | 1 (+2 not run) | **harness**, same defect in the next setup call (`voice-media.spec` `beforeAll`) |
| after the harness fix covers setup calls, two runs | **33** | **0** | — |

The lab's `e2e` and `lifecycle` scenarios on the same build: 22 PASS, 0 FAIL,
0 BLOCKED, 0 SKIPPED (as in the final run above).

- **Fixture defect (S3/S4, share restart):** the `getDisplayMedia` stub
  returned the same stream object on every call. Bridge stops the capture
  tracks when a share ends, so the second share published ended tracks and
  failed ("screen share cancelled"). A real `getDisplayMedia` never returns
  ended tracks; the stub now returns a fresh capture of the same source.
- **Stale contracts (V13/V14, voice-media "no double playback" and "rejoin"):**
  written for P2P (one connection per peer). With the SFU a client has one
  send and one receive transport, and a closed consumer leaves its media
  section in the receive transport as an `inactive` transceiver whose inbound
  stats stay in `getStats()` (measured: frozen at 16 bytes, track `ended`,
  next to the one live path). The old count read that as a second inbound
  track, and its "bytes > 0" check could have been satisfied by those frozen
  bytes. The suites now count only live receiving paths and judge orphan
  connections against the topology in use (P2P: one per peer; SFU: exactly
  one send and one receive transport) — a real duplicate or orphan still
  fails.
- **Environment:** `scripts/e2e-server.js` now defaults the SFU listen and
  announced address to `127.0.0.1` (browsers and server share the host).
- **Harness defect (hidden until the suite ran clean):** the server keeps one
  CSRF token per user and a browser page of the same user replaces it; the
  API setup helpers cached the old one, got `403 CSRF token invalid or
  expired` and silently returned `null`/`false` — measured on the 15th channel
  of a run, which the test then waited 25 s for. Earlier failures had hidden
  it (a failed test restarts the Playwright worker, which clears the cache).
  The setup helpers now refresh the token once on a 403 (the rule the
  `apiTest` fixture already follows; a real authorization 403 stays 403) and
  the suite asserts that its channel was created.

### Two-way media on a clean network (e2e)

- The late joiner decodes the room's tone **0.5 s** after its join
  completes — 2.8 s after its join click (ICE + DTLS connected after 1.25 s).
- Audio: 64 kbit/s each way, 50 packets/s, 0 % loss, 0 % concealment, 30 ms
  jitter buffer; one playing `audio.remote-audio` element per peer, no
  duplicate track, never the sender's own tone.
- Mute: the receiver is silent **263 ms** after the click; the sender keeps
  ~5 packets/s of Opus DTX (50 unmuted). Unmute: audible after 263 ms.
  Deafen mutes playback and the microphone; packets keep arriving.
- Camera: decoded 1.0–1.8 s after the click at **640x480** (the full capture
  resolution — before MEDIA-07 at most 320x240), ~600 kbit/s. Camera off:
  the receiver stops within 17 ms and the capture is released.
- Screen share: decoded 1.6 s after start (fake 3840x2160 display source,
  ~1.3 Mbit/s, 20 fps); the display capture is released on stop.
- 5 leave/rejoin cycles: silent 5–10 ms after leave; audible again
  2.36 s after each rejoin click; 1 audio track and 2 transports per client
  every cycle; worker UDP sockets back to the baseline.

### TURN (relay-only network: the SFU's media ports are dropped)

From the re-run on the fixed lab (the final run's TURN scenario shared the
port with stray coturn processes; its recovery times are given for
comparison).

- Selected pair `relay` over TURN/UDP on every transport. Audio both ways
  0.26 s; camera 1.0 s (640x480); screen share 1.9 s; leave + rejoin 2.6 s.
- UDP to the TURN server blocked: every transport relays over **TURN/TCP**;
  audio both ways in 0.26 s (TURN-09).
- TURN killed mid-call: media stops at once. TURN back: the call recovers
  **15.4 s** later without user action (final run: 14.9 s) (MEDIA-05).
- Invalid credentials, expired credentials (coturn clock +25 h), TURN
  unreachable at join: **no media** — nothing bypasses the relay-only policy.
  TURN reachable again: recovers in 3.3 s without a rejoin (final run: 7.4 s).
- Lab integrity (`TURN-LAB`): every stop, including the `faketime` instance,
  left no TURN server behind.

### Impairment (B's link, both directions; each profile 6 s settle + 15 s window)

| Profile | A→B audio audible / concealed | B→A audio audible / concealed | A→B video decoded |
|---|---|---|---|
| clean | 100 % / 0 % | 100 % / 0 % | 640x480, 568 kbit/s |
| 20 ms | 100 % / 0.1 % | 100 % / 0 % | 640x480 |
| 75 ms | 100 % / 0 % | 100 % / 0 % | 640x480 |
| 200 ms | 100 % / 0 % | 100 % / 0 % | 640x480 |
| 30 ± 5 ms jitter | 100 % / 0 % | 100 % / 0 % | 640x480 |
| 50 ± 20 ms jitter | 100 % / 0 % | 100 % / 0 % | 640x480 |
| 100 ± 60 ms jitter | 100 % / 0 % | 100 % / 0 % | 640x480 |
| 1 % loss | 100 % / 1.1 % | 100 % / 1.0 % | 640x480 |
| 3 % loss | 100 % / 4.0 % | 100 % / 2.1 % | 640x480 |
| 5 % loss | 100 % / 3.9 % | 100 % / 4.8 % | 640x480 |
| 10 % loss | 100 % / 10.6 % | 100 % / 8.1 % | 640x480 |
| 20 % loss | 98.7 % / 18 % | 100 % / 19.8 % | 320x240, 194 kbit/s |
| burst loss (Gilbert–Elliott, ~7.5 %) | 98.7 % / 7.2 % | 100 % / 6.4 % | 320x240 |
| 2 Mbit/s | 100 % / 0 % | 100 % / 0 % | 320x240 (estimate still climbing after the loss profiles) |
| 500 kbit/s | 100 % / 0 % | 100 % / 0.2 % | 320x240, 124 kbit/s |
| 150 kbit/s | 100 % / 0 % | 100 % / 0.5 % | none (video yields) |
| 64 kbit/s | 100 % / 26.5 % | 97.3 % / 31.9 % | none |
| 100 ± 30 ms | 100 % / 0 % | 100 % / 0 % | none (after the 64 kbit/s squeeze) |
| 100 ms + 5 % loss | 100 % / 4.4 % | 100 % / 5.3 % | none |
| 5 % loss + 500 kbit/s | 100 % / 4.2 % | 100 % / 5.2 % | none |

"Audible" is the share of 200 ms windows in which the receiver's FFT finds
the sender's tone; the link's own counters confirm the configured loss was
applied. The tone is heard in ≥ 98.7 % of windows in every profile down to
150 kbit/s, with concealment tracking the packet loss (≤ 5 % up to 5 % loss,
~20 % at 20 % loss); at 64 kbit/s it is still heard but a quarter to a third
of it is concealment (Opus stays at ~64 kbit/s — see *Classified, not
changed*).

The profiles run back to back on one call, so a profile after a squeeze also
measures the bandwidth estimate climbing back. **Video after congestion
clears** (IMP-04: 64 kbit/s for 20 s, then a clean link) found **MEDIA-11**
on the build merged with P2: 1 PASS / 1 FAIL — in the failing run the video
the SFU sends to the congested receiver had not resumed 90 s after the link
cleared (audio unaffected, no transport re-established). (The first run also
exposed two lab analysis bugs — rates summed across a replaced transport went
negative; a frozen frame's size counted as full resolution — both fixed.)

MEDIA-11 was reproduced with the `congestion` scenario (repeated 64 kbit/s,
20 s squeezes on one call) and traced inside mediasoup (local debug build):
whenever the congested receiver's estimate ended the squeeze at its
**30 kbit/s floor**, no simulcast layer fit, no video was sent, and nothing
fed the estimator again — mediasoup requests no congestion feedback on the
audio it forwards (transport-wide-cc is `recvonly` for audio), and libwebrtc
only probes when the allocated maximum changes, which it does not while the
desired bitrate stays constant. Counting only those floor episodes on the
build merged with P2: 6 episodes in 10 cycles, **4 stuck ≥ 90 s** (until a
session re-establishment happened to replace the transport), 2 recovered
after ~9.7 s.

**A fix was prototyped and measured, and is not merged.** Re-probing a
receive transport while a simulcast consumer stays without a layer (a
temporary outgoing cap, lifted again, makes libwebrtc probe) cures the
deadlock — 4 of 5 floor episodes recovered in 3.1–4.9 s, 10/10 congestion
cycles resumed video — but it **costs audio on a link that stays narrow**:
the recovered estimate is just high enough for the lowest video layer, which
the link cannot carry next to the audio (mediasoup's layer selection reserves
nothing for audio; the layer switches also request key frames from the
sender):

| 150 kbit/s profile | merged build (3 runs) | with re-probe (3 variants) |
|---|---|---|
| A→B audio concealment | 0–0.4 % | 6.6–10.1 % |
| B→A audio concealment | 0.2–0.8 % | 7.5–10.6 % |
| video forwarded | 0–3 kbit/s | 25–44 kbit/s |

Backing off by time (8/16/30 s) or by outcome (a probe that let video
through which stalled again → 60 s, doubling to 5 min) reduced but did not
remove that cost. On the merged build the deadlock is, in effect, what keeps
video off — and audio clean — on narrow links; any mechanism that brings
video back does so there too. Choosing between video recovery and narrow-link
audio is a product decision, so MEDIA-11 stays **open**; the prototype is in
the history of PR #104 (`bweReprobe.ts`, commit `225ad69`) as the starting
point. Workaround: leave and rejoin the call (a fresh transport starts at
800 kbit/s). Recommended fix (P3): re-probe **plus** audio-first admission —
forward video only while the estimate covers the audio plus the lowest layer
plus a margin.

**P3 bounded investigation (2026-09-30): not shipped, still open.** Acceptance
for a fix: (A) narrow-link audio not regressed, (B) video recovers without the
90 s deadlock, (C) no uncontrolled probing, (D) regression tests. On main
`a76a9b2` (mediasoup 3.26.0, unchanged since P2) the deadlock **did not
reproduce**: 16/16 congestion cycles resumed without user action (64 kbit/s ×
20 s × 6: A→B 2.0–10.1 s; 32 kbit/s × 30 s × 10: A→B 2.0–12.1 s), and IMP-04
resumed in 6.3 s. On the same build the 150 kbit/s profile keeps audio clean
(concealment 0 % both ways) and video yields.

Audio-first admission with a bounded re-probe was implemented (hold camera
consumers below 90 kbit/s per audio stream + 80 kbit/s, re-probe every
3 s → 30 s while held, resume above need × 1.3 with a key frame; 14 model
tests including a no-probe negative control that deadlocks) and measured on
the same lab: congestion 6/6 resumed in 6.0–10.2 s — no better than without
it — while narrow-link audio got **worse** (150 kbit/s concealment A→B
0 % → 3.0 %, B→A 0 % → 10.5 %; 500 kbit/s A→B 0 % → 3.9 %; one run each).
That fails (A) with nothing to show for (B), so it was reverted; the code is
in the P3 history (commits `f561254`, reverted by `611c7ad`). Single runs per
profile are noisy; the decision does not rest on the size of the regression
but on there being no measured benefit to pay it for.

What would reopen it: a reproduction of the floor deadlock on a current
build (the lab's `congestion` scenario, `CONGESTION_CYCLES` / `_KBPS` /
`_SECONDS`), or field reports of video not returning after congestion.

Link interruptions (blackhole both ways), all recovered without user action:

| Outage | Audible again after the link returns (final run / re-run) |
|---|---|
| 2 s | 0.26 s / 0.27 s |
| 5 s | 0.26 s / 0.28 s |
| 10 s | 0.26 s / 0.27 s (ICE reconnects the same transports) |
| 20 s | 3.1 s / 3.6 s (both transports `failed` at ~17 s → session re-established) |
| 40 s | 9.4 s / 4.3 s (same; new transports once the link is back) |

### Network change (handoff = new interface + address, old one removed)

- Direct path: media stops 0.8 s after the old address goes; usable again
  **30.2 s** after the handoff (re-run: 42.1 s), without user action; the
  other participant sees no ghost or duplicate peer (`replaces`,
  NC-01-ghost).
- Relay-only network (re-run): usable again **30.6 s** after the handoff over
  a new TURN relay path, no ghost peer (NC-02, NC-02-ghost). A rejoin itself
  takes ~2.4–3 s (E2E-16, TURN-05); the rest of the 30–42 s is spent before
  the client concludes the old path is dead.

### Failover (two nodes; A on the owner node, B redirected to it)

| Fault | Media | Recovered without user action |
|---|---|---|
| non-owner node (B's app/signaling node) killed | never stopped | — |
| SFU owner node killed | stopped | **27.0 s** after the kill (30 s owner lease) |
| owner node rolling restart (SIGTERM + start) | stopped | 19.3 s |
| mediasoup worker killed | stopped | 18.7 s; the pool replaced the worker |
| Redis hung 10 s | kept flowing | — |
| Redis hung past the lease | **fenced** at 22.0 s (P1 fail-closed) | 17.4 s after Redis resumed |

Redis `CLIENT LIST` was 7 before and 7 after the outages.

### Device / track lifecycle

Camera on/off ×5 and screen share ×3: decoded every time, nothing leaks
(captures, remote tracks). A microphone switched in Settings → Devices
applies to the live call (MEDIA-06). A camera that ends underneath the app
closes its producer and the UI shows the camera off; a microphone that ends
marks the user muted and says so (MEDIA-10); leave + rejoin restores it
(0.26 s). A 30 s outage while muted recovers 5.1 s after the link returns
with the user **still muted** and not heard; unmute works (0.26 s).

### Authorization mid-call (real media, two nodes)

Kick, ban, channel VIEW revoked, CONNECT revoked, member timed out and
logout-all: media stops **both ways within 3–14 ms**, the evicted client's
UI leaves the call, and nothing resurrects media in the following 45 s.
SPEAK revoked: the user stops being heard within 10 ms and keeps listening.

### Multi-user

| Participants | Converged after the last join | Join → first audio | Per receiver | Worker CPU (one core) | Node RSS |
|---|---|---|---|---|---|
| 3 | 20 ms | 2.8–3.2 s | 2 streams, 129 kbit/s, 0 % loss | 1.5 % | ~150 MB |
| 5 | 56 ms | 2.8–3.4 s | 4 streams, 206 kbit/s, 0 % loss | 2.7 % | ~155 MB |
| 6 | 100 ms | 3.0–3.2 s | 5 streams, 260 kbit/s, 0 % loss | 3.1 % | ~160 MB |

Everyone decodes everyone else exactly once and never themselves. Two of five
leaving at once: the others converge in 39 ms; both rejoining: 605 ms. After
everyone leaves, worker transports and the Redis room ownership are released.

### Soak

20 minutes, 3 participants, churn every 30 s (mute toggles, camera toggles,
leave/rejoin, 5 s interruptions). First vs last quarter: owner node RSS
160,280 → 160,296 kB, worker RSS 14,192 → 14,192 kB, worker fds 25 → 25,
worker UDP sockets 6 → 6, node fds 35 → 35, Redis SFU keys 8 → 8, transports
per client 2 → 2, audio elements 2 → 2, client JS heap 9 → 11 MB. Everyone
hears everyone at the end. B→A was audible 47.6 % of the time: every gap is a
scheduled 60 s mute period (plus ~3 s when A itself rejoins).

### Video frame rate in the lab

The fixture video carries a moving 192x144 patch of random noise, which does
not compress: at the 900 kbit/s top-layer cap VP8 rate control drops frames,
so the 640x480 layer runs at ~4–11 fps and the 320x240 layer at ~12–17 fps
(`qualityLimitationReason` `none` — not CPU or bandwidth adaptation). Before
MEDIA-07 the same content was only ever sent as 320x240 at ~30 fps. Real
camera content compresses far better; camera frame rate on real devices is
part of the device validation below.

## What is not proven

- **Video recovery after heavy downlink congestion (MEDIA-11, open):** after a
  squeeze that drives the SFU's estimate towards a receiver to its floor, that
  receiver's video can stay off for good (audio is unaffected); see *Evidence*
  for the root cause, the unmerged prototypes and their measured audio cost.
  Reproduced on the P2 build (4 of 10 cycles); **not reproduced on the P3
  build** (0 of 16). How often real bufferbloat or a cellular link reaches
  that floor is not measured.

- **Human perceptual quality** (echo, noise suppression, loudness, lip sync):
  the fake capture device has no acoustic path. HUMAN VALIDATION REQUIRED
  (`docs/VOICE_HUMAN_VERIFICATION.md`).
- **Real Wi-Fi / cellular handoff and physical devices** (macOS, iOS,
  Android): the lab models a handoff as a new interface + address inside a
  network namespace; camera frame rate with real camera content and real
  encoders is not measured (the fixture is deliberately incompressible).
  PHYSICAL DEVICE VALIDATION REQUIRED.
- **Real WAN**: impairment is synthetic (userspace netem-equivalent on real
  kernel packets); real networks have correlated loss, bufferbloat and
  middleboxes the lab does not model.
- **TURN over TLS (`turns:`)**: no trusted certificate in the lab; not tested.
- **Multi-host production topology and production traffic.**
