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

Each was reproduced in the lab on the unfixed build (lab check FAIL), fixed,
covered by a fast regression test that fails on the old code (negative
control run), and re-verified in the lab (PASS).

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

(measured values: see the final run below)

## What is not proven

- **Human perceptual quality** (echo, noise suppression, loudness, lip sync):
  the fake capture device has no acoustic path. HUMAN VALIDATION REQUIRED
  (`docs/VOICE_HUMAN_VERIFICATION.md`).
- **Real Wi-Fi / cellular handoff and physical devices** (macOS, iOS,
  Android): the lab models a handoff as a new interface + address inside a
  network namespace. PHYSICAL DEVICE VALIDATION REQUIRED.
- **Real WAN**: impairment is synthetic (userspace netem-equivalent on real
  kernel packets); real networks have correlated loss, bufferbloat and
  middleboxes the lab does not model.
- **TURN over TLS (`turns:`)**: no trusted certificate in the lab; not tested.
- **Multi-host production topology and production traffic.**
