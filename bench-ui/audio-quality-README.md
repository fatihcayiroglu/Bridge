# Synthetic decoded WebRTC audio fidelity experiment

This A/B investigation uses **identical** Svelte and React UI workloads in
real Electron/Chromium on Windows, Linux, and macOS. Its source is a generated
440 Hz oscillator sent through real local WebRTC audio RTP (Opus) and decoded
into actual Web Audio PCM on the receiver. A numerical best-fit sinusoid and
residual measure **signal-to-noise-plus-distortion** in dB, receiver RMS,
clipping, dropout windows and 100-ms sampling gaps. RTP receive counts, packet
loss and jitter are independently verified using `RTCRtpReceiver.getStats()`.

Modes: 1 RTP audio link, 9 concurrent local RTP links (10-user *fanout proxy*),
and 1 audio link while mutating 10,800 synthetic message DOM nodes. For each
mode/framework: fresh renderer, one warmup, five accepted 2-second PCM runs,
20 sampled 2048-frame PCM windows in each run. The report contains every raw
value and exact backed p50/p95 summaries; a missing decoder signal, missing
RTP packet evidence, missing sample or fake summary keeps CI **red**.

**Important boundaries:** This is NOT subjective perceived speech quality,
PESQ/POLQA/MOS, a recorded human voice, hardware microphone/speaker, acoustic
echo, spatial audio, actual screen share, real Bridge login, genuine remote
2/10-user SFU traffic or packet-loss network emulation. It measures only a
single frequency and may miss very short glitches between sampled windows.
A higher SNR for one UI fixture is not proof that the framework itself changes
Chromium's shared audio codec or makes real Bridge calls sound better.

The workflow runs the same fail-closed contract on all three OSes and keeps
the exact first-failure log. No product code is modified by this experiment.
