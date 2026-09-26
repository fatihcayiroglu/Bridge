# Voice — Human Verification Checklist

**Status: UNVERIFIED by humans.** Everything testable without a second person
is now automated (see below); what remains genuinely needs two humans, two
machines and two networks.

Every voice claim in Bridge's documentation is currently an inference from code
and unit tests. No one has confirmed that audio actually travels from one human
to another. Automated tests cannot close this gap: `getUserMedia`,
`RTCPeerConnection` and the audio output path are all mocked in jsdom, so a
suite can prove the *wiring* is correct and still be silent about whether
anyone can hear anything.

This document exists so that verification is a **procedure with a result**,
not an opinion. Until every REQUIRED row below is signed off, voice must be
described as "implemented, unverified" — never as "working".

---

## Preconditions

| Item | Requirement |
|---|---|
| Participants | Two people (A and B) on **separate machines**, not two tabs |
| Network | At least one run where A and B are on **different networks** (proves ICE/TURN, not just loopback) |
| Browsers | Chromium-based on both for run 1; repeat run 1 with Firefox on one side |
| Instance | A running Bridge instance both can reach over **HTTPS** — `getUserMedia` is blocked on plain HTTP for non-localhost origins |
| Devices | Each side has a real microphone and a real output device (headphones strongly preferred — speakers make echo tests ambiguous) |

> **Headphones matter.** With open speakers, "no echo" may simply mean the
> other side's volume was low. Echo cancellation must be judged with a
> deliberate loudspeaker run (row V-11), not accidentally.

---

## Required checks

Mark each **PASS**, **FAIL**, or **BLOCKED**. A skipped row is not a pass.

### Core audio path

| # | Check | Expected | Result |
|---|---|---|---|
| V-1 | A joins a voice channel; B joins the same channel | Both appear in the participant list within ~3 s | |
| V-2 | **A speaks → B hears** | Intelligible audio, no more than ~1 s delay | |
| V-3 | **B speaks → A hears** | Same, in the reverse direction | |
| V-4 | A speaks continuously for 60 s | No dropout, no robotic artefacts, no drift | |

### Controls

| # | Check | Expected | Result |
|---|---|---|---|
| V-5 | A mutes | B hears **nothing**; A's card shows the muted state on **both** screens | |
| V-6 | A unmutes | Audio resumes; state clears on both screens | |
| V-7 | A deafens | A hears nothing **and** A is muted to B (deafen implies mute) | |
| V-8 | A undeafens | Both directions restored | |
| V-9 | A holds the push-to-talk key | Audio flows only while held | |
| V-10 | Speaking indicator | B's card highlights **only** while B talks, and never while B is muted | |

### Quality

| # | Check | Expected | Result |
|---|---|---|---|
| V-11 | Both sides on **loudspeakers**, A speaks | B does not hear their own voice echoed back | |
| V-12 | B types loudly / plays background noise | Noise is visibly reduced for A | |
| V-13 | A speaks quietly, then loudly | Level stays roughly consistent (auto gain) | |
| V-14 | Open Voice Check during the call | Applied audio settings show real values, not "unknown", when the browser reports them | |
| V-15 | Connection quality badge in the voice header | Shows a real class; degrades when the network is throttled | |

### Devices

| # | Check | Expected | Result |
|---|---|---|---|
| V-16 | A switches microphone mid-call | B keeps hearing A, now from the new device | |
| V-17 | A switches speaker/output mid-call | A keeps hearing B, now on the new device | |
| V-18 | A unplugs the active microphone mid-call | Bridge reports the loss; it does not silently go dead | |

### Recovery

| # | Check | Expected | Result |
|---|---|---|---|
| V-19 | A leaves and rejoins | Audio works again in both directions | |
| V-20 | A's network drops for ~10 s, then returns | Call recovers, or fails **visibly** — never a silent dead call | |
| V-21 | A reloads the page while in voice | A is removed from B's list; rejoin works | |
| V-22 | Third participant C joins | All three hear each other (P2P mesh: 3 connections) | |

### Screen share

| # | Check | Expected | Result |
|---|---|---|---|
| V-23 | A shares a screen | B sees it within a few seconds | |
| V-24 | A stops sharing | B's view ends cleanly, audio unaffected | |
| V-25 | A shares with audio | B hears the shared audio **and** A's voice | |

---

## Privacy checks (do not skip)

Voice diagnostics are deliberately limited. Confirm the limits hold in a real
call, where real candidates and credentials exist:

| # | Check | Expected | Result |
|---|---|---|---|
| P-1 | Open Voice Check during a call, read every field | **No IP address** is shown anywhere | |
| P-2 | Same | **No ICE candidate** details (`srflx`, `relay`, host addresses) | |
| P-3 | Same | **No TURN/STUN URL or credential** | |
| P-4 | Copy/export any diagnostics output | Same three rules hold in the exported text | |

---

## Recording a result

Write the outcome into this file — date, build, participants' platforms, and
the table with every row filled. A run is only meaningful if it names what was
tested on:

```
Run: 2026-__-__   Build: ____   A: Windows 11 / Chrome ___   B: macOS / Firefox ___
Network: A on home fibre, B on mobile hotspot (different networks: YES)
```

### Interpreting failures

- **V-2 or V-3 fails** → voice does not work. Nothing else in this list matters
  until it passes; do not report partial success.
- **V-11 fails** → check Voice Check row V-14 first. If the browser reports
  `echoCancellation: false`, the constraint was requested but **not applied** —
  that is a browser/device limitation to document, not a Bridge bug to hide.
- **V-20 shows a silent dead call** → this is worse than a visible failure and
  should be treated as a P0 defect.

---

## What is already verified automatically

Do not re-test these by hand — they are locked by the suite and would only
waste a scarce two-person session:

| Area | Where it is proven |
|---|---|
| Constraints are *requested* (`echoCancellation`, `noiseSuppression`, `autoGainControl`) | `client/tests/voice-audio-settings.test.ts` |
| Applied settings are read honestly, `unknown` when the browser is silent | same |
| Connection quality derives from real `getStats()` fields; never assumes "good" | `client/tests/voice-connection-quality.test.ts` |
| Quality badge renders, degrades, and states the class in **text** as well as colour | `client/tests/VoicePanel.test.ts` |
| Diagnostics never render IP / ICE candidate / TURN credential | same (`ADRES / ICE adayı / kimlik bilgisi SIZDIRMAZ`) |
| Muted participants never show as speaking | `client/tests/VoicePanel.test.ts` |
| VAD thresholds, hysteresis, hang-time | `client/tests/voice-activity-detector.test.ts` |
| DM call signalling (ring → accept → ready → offer/answer/ice → end), decline, and the three authorization boundaries | `e2e/tests/dm-call.spec.ts` (8 tests, real server) |

**Present in the product** (built, reachable — but audio path unproven):
participant cards, speaking indicator, connection-quality badge, microphone
selector, speaker selector (`setSinkId`), input volume, push-to-talk, mute,
deafen, screen share.

**Not present:** an input-*sensitivity* control. VAD thresholds are fixed
constants (`VAD_TUNING`). Row V-10 below tests the indicator, not a
user-tunable threshold — do not report a missing control as a failure.

---

## Why there is no automated substitute

The suite mocks the media stack end to end. It can prove:

- the correct constraints are **requested** (`echoCancellation`,
  `noiseSuppression`, `autoGainControl`),
- the **applied** settings are read back honestly and reported as `unknown`
  when the browser stays silent,
- connection quality is derived from real `getStats()` fields and never
  assumes "good" when a measurement is missing,
- muted participants never show as speaking,
- diagnostics never render addresses, candidates or credentials.

It cannot prove that a human heard another human. That is what this document
is for.

---

# Echo — narrowing it down (added after a reported failure)

A human ran this checklist and reported **audio still noticeably echoey** after
the first fix. That first fix was real but was only one of several causes. Below
is what has been fixed since, and how to tell the remaining causes apart.

## Fixed so far

| # | Cause | Evidence it was real | Status |
|---|---|---|---|
| E-1 | **Double playback.** Remote video tiles rendered `muted={tile.isLocal}`, so a remote participant's stream played through *both* the `<video>` tile and the dedicated `<audio>` host. | Two elements, one stream | Fixed — tiles are always `muted`; audio only ever plays through `.remote-audio` |
| E-2 | **One switch controlled three processors.** `echoCancellation: nsEnabled`, `noiseSuppression: nsEnabled`, `autoGainControl: nsEnabled` — turning off *noise suppression* silently turned off *echo cancellation*. | Same variable on all three constraints | Fixed — three independent flags, echo cancellation defaults **on** |
| E-3 | **The echo-cancellation setting never reached the microphone.** Settings → Devices has its own toggle, saved to localStorage and the server, but `voice:applyDeviceSettings` read only `micDeviceId` and discarded the rest. It also returned early when no specific microphone was selected — the most common case. | Handler body | Fixed — settings now re-acquire the track and `replaceTrack` on every sender |

| E-4 | **Selected speaker was not applied to participants who joined later.** `setSpeakerDevice()` called `setSinkId` only on elements present at that moment, but remote audio elements are created per participant as they join. Change your speaker, then have someone join — they play on the *default* device. In a mixed headphone/speaker situation this also muddies echo diagnosis: you believe you are on headphones while part of the call is on speakers. | Handler body vs. keyed `{#each}` | Fixed — a `use:remoteAudio` action applies the selected sink at element creation |

Regression tests: `client/tests/voice-audio-processing.test.ts` (17 checks) and
`client/tests/voice-audio-graph.test.ts` (22 checks).

## Audio graph audit — every path checked

| Path | Result | Evidence |
|---|---|---|
| Local mic rendered locally | `LOCAL_MIC_LOOPBACK = ABSENT` | Only three files assign `srcObject`; the local mic reaches one element and it is `muted`; no `AudioContext` connects to `.destination` |
| Duplicate remote playback | `REMOTE_AUDIO_DUPLICATION = ABSENT` | `{#each …(socketId)}` is keyed; the map holds one stream per participant |
| Duplicate peer connections | `DUPLICATE_PEER_CONNECTION = ABSENT` | `_createPeerConnection` closes and deletes any existing PC for that id first |
| Stale local audio track | `STALE_LOCAL_AUDIO_TRACK = ABSENT` | Both replacement paths `stop()` + `removeTrack()` then `replaceTrack` on every sender |
| Stale remote audio track | `STALE_REMOTE_AUDIO_TRACK = ABSENT` | Removal on `voice:peer-left` (server signal, no ICE-timeout wait), on connection-state change, and on leave/teardown |
| Duplicate socket bindings | `DUPLICATE_VOICE_SOCKET_BINDINGS = ABSENT` | Bound once in the constructor; `destroy()` removes exactly this owner's handlers by reference; `removeAllListeners` never used |

## If it still echoes, distinguish these

Run V-11 again and answer these in order — each one isolates a different cause.

**Q1 — Who hears the echo?**
- *You hear your own voice back* → acoustic loop at the **other** end (their AEC),
  or E-4 below.
- *You hear the other person twice / doubled* → duplicate peer connection, not
  echo. Check the participant list for a duplicate entry.

**Q2 — Was anyone screen sharing with audio?**

> **CORRECTION.** An earlier revision of this document named screen-share system
> audio as a likely cause (“E-4”) and asked you to retest with it off. That was
> **wrong for Bridge**, and the code disproves it.
>
> Both engines capture the video track only:
> `webrtc.ts` reads `screenStream.getVideoTracks()[0]`, and `webrtc-sfu.ts`
> produces only that track. The system-audio track was **never added to any
> peer connection or producer**. Nobody has ever heard shared system audio in
> Bridge, so it cannot carry call audio back to the far end. **The digital
> feedback path does not exist here.**
>
> What did exist was a false affordance: the “Ses Dahil” checkbox was `checked`
> by default, so every screen share asked the browser for system audio, the user
> granted it, and Bridge held a live capture of their system audio for the whole
> share — used for nothing. That capture is now not requested at all, the box is
> disabled and labelled “henüz desteklenmiyor”, and system-audio sharing is
> recorded as ABSENT in `FEATURE_AUDIT.md`.

So Q2 is **not** an echo cause in Bridge. It is still worth recording, because
if you *do* hear shared application audio, that would contradict the code and is
itself a finding.

**Q3 — Headphones on both sides?**
Put both people on headphones and repeat. If the echo disappears, it is acoustic
and the question becomes whether AEC is actually applied (Q4). If it persists on
headphones, it is **not** acoustic — look at duplicate connections.

**Q4 — Is echo cancellation actually applied?**
Constraints are *requests*; the browser may drop them.
- Open **Voice Check** during the call (V-14). `echoCancellation` should read
  `true`, not `false` or `unknown`.
- The console now logs `voice: 'aec_not_applied'` when echo cancellation was
  requested but the browser reports it off.
- If it reads `false`: check Settings → Devices → "Eko giderme" is on, and note
  the browser and OS — some Linux/PulseAudio and some Bluetooth headset
  configurations disable AEC at the driver level.

**Q5 — Is a non-default output device selected?**
If Settings → Devices selects a speaker other than the system default, the
browser routes playback via `setSinkId`. Chrome's echo canceller references the
*default* render stream, so it cannot cancel audio sent to a different device.
→ Set the speaker back to the system default and retest.

## Report back with

**Do not fill Q4, Q5, browser or OS by hand.** Open **Voice Check** and press
**"Yankı raporunu kopyala"**. It fills in everything measurable — the real
`getSettings()` values, whether the output device is the system default, browser
and OS — and leaves only the by-ear rows blank.

### You do not need a second person for Q4

Q4 is the single most diagnostic field, and it can be answered **alone in about
thirty seconds**:

1. Open Voice Check.
2. Press **"Testi başlat"** (microphone test).
3. Press **"Yankı raporunu kopyala"**.

The microphone test acquires its track with **exactly the constraints a real
call uses**, so `getSettings()` reports the same values a call would. The report
labels the source as `mikrofon testi track'i — VEKİL ölçüm` so a solo
measurement is never mistaken for proof about a two-person call.

*(Until this pass the microphone test requested bare `audio: true` — no echo,
noise or gain constraints at all. It was measuring a different configuration
from the one being diagnosed, which would have produced a misleading Q4.)*

If `echoCancellation` comes back **`true`** on both machines, echo cancellation
is working and the cause is Q2 or Q5 — screen-share system audio, or a
non-default output device. If it comes back **`false`**, that is the cause and it
is fixable in code; send the report and nothing else is needed.

Each participant presses it on their own machine, so send **two** blocks.

The button was added because the first attempt at this form came back with every
field still showing its `[placeholder]`: half of it is not information a person
can supply by looking at the screen. If the clipboard is blocked, the same report
is written to the browser console instead.

What the report deliberately does **not** contain: IP addresses, ICE candidates,
TURN/STUN credentials, tokens, channel or user ids, or message content. It is
copied locally and never sent anywhere by the app.

Then answer by ear:

- **Q1** — is it your own voice coming back, or the other person doubled?
- **Q2** — was screen-share audio on?
- **Q3** — headphones on each side, and does the echo survive them?
- the PASS/FAIL result rows.

That combination narrows it to a single cause. A general "still echoey" cannot be
acted on, because E-4 (screen-share system audio) and E-5 (non-default output
device) are configuration rather than code, and only Q2/Q5 separate them from a
genuine AEC failure.


---

# Automated two-browser media test — written, currently skipped

`e2e/tests/voice-media.spec.ts` exists and measures the rows a human should not
have to: does audio *actually* flow A→B and B→A (`getStats()` packet and byte
counters on real `RTCPeerConnection`s), is there exactly one inbound audio
stream and one `audio.remote-audio` element per participant, does leave/rejoin
leave orphans behind, and are the processing constraints applied on a **live
call track** rather than a proxy.

It runs in its own Playwright project (`voice-media`) with Chromium's fake media
device, and it instruments `RTCPeerConnection` from a page init script — the
production code is not modified.

**It is currently `describe.skip`, and the reason is measured, not guessed:**

| Step | Result |
|---|---|
| Select server, click the voice channel | works |
| `ChannelStagePanel` switches the stage to `voice` | works (logged) |
| `detectVoiceStack()` → `BridgeRegistry.has('rtc')` | **false** |
| Consequence | the "voice stack unavailable" state renders, `joinVoice` is never called, no `RTCPeerConnection` is ever constructed |

`ensureRtc()` only constructs the engine when `BridgeRegistry.get('socket')`
exists. In the automated context no Socket.IO handshake was observed — neither
with a restored token nor after a **real UI login** through the app's own
`loginViaUI` helper. Browser capability was ruled out: `typeof
RTCPeerConnection` and `typeof navigator.mediaDevices.getUserMedia` are both
`function`, and `isSecureContext` is `true`.

**This is not a claim that sockets are broken in the product.** Voice demonstrably
works in a real browser — the echo report proves someone was in a call. The most
likely explanation is that the probe fails to observe engine.io's transport, or
something specific to the automation context. That has not been proven either
way, so nothing is asserted.

**Next step to unblock:** confirm from the server's connection log whether the
automated browser session establishes a Socket.IO connection at all. Once it
connects, this spec should run as written — remove the `.skip`.

The spec was **not deleted**, and the boundary carries no false "voice verified"
claim: skipped is reported as skipped.
