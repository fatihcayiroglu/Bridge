# Electron Svelte-versus-React WebRTC audio-load probe

**Not an application-level voice-quality or release gate.** This is a paired,
synthetic 10,000-message renderer benchmark running alongside *actual* local
WebRTC audio RTP. Both candidates use the existing same Svelte/React fixtures,
the same Electron version, viewport, Web Audio 48 kHz 440 Hz generated stream,
local ICE-only RTCPeerConnection pair, and browser-runner OS.

It compares idle and UI-busy RTP jitter/loss **as reported by getStats()**, UI
work duration, Chromium renderer TaskDuration, and optional instantaneous
Electron renderer working-set/CPU snapshots. The order alternates by round,
two warmups and eight recorded attempts per candidate per platform.

The report is invalid if either framework, a required sample, live audio RTP,
actual DOM mutation, or an observed metric is absent. A missing audio device
or a CI session error is a RED **NOT MEASURED** condition, never a product bug
and never proof that one framework won. The run does not retry acceptance
failures or suppress skipped tests.

Boundaries:

- Local RTP jitter/loss under artificial audio load is *not* real-network
  ping/packet loss, a listening test, audio output or microphone permissions.
- 48 kHz means audio-source sample rate, **not** an objective microphone
  capture-quality result. No physical devices, screen/system audio, OS audio
  route changes, hardware codec, battery, or end-to-end acoustic delay are
  verified.
- Renderer task time is not whole-machine CPU; Electron CPU percent is a
  single optional process snapshot; renderer working set is not full-app RAM.
- This does not compare the full production Svelte Bridge with a fully
  feature-equivalent React Bridge. The React product equivalent is not built.
- Linux, Windows and macOS hosted runners are different machines; compare
  candidates within the same OS/job. Cross-OS absolute values are not a fair
  league table.

Run after the parent synthetic UI benchmark dependencies are installed and
`node bench-ui/build-assets.mjs` has produced the two built fixtures:

```bash
node --test bench-ui/audio-*.test.cjs
xvfb-run -a electron/node_modules/electron/dist/electron --no-sandbox bench-ui/audio-electron-benchmark.cjs
node bench-ui/audio-report.cjs
```

The workflow saves `bench-ui/generated/audio-report.json` and the complete
failure log without rerunning the first failed attempt. It stays separate
from the existing real Bridge 33/33 WebRTC suite and product release CI.
