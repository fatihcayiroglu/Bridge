// Browser-side fixture shared unchanged by the Svelte and React Electron windows.
// Real RTCPeerConnection audio RTP is generated from the same 440 Hz Web Audio
// source. This is a LOOPBACK transport benchmark, never microphone/speaker QA.
(() => {
  'use strict';
  const TIMEOUT_MS = 15_000;
  const IDLE_MS = 1_200;

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, code) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(100);
    }
    throw new Error(code);
  }

  async function waitForIce(pc) {
    await waitFor(() => pc.iceGatheringState === 'complete', 'AUDIO_ICE_GATHER_TIMEOUT');
  }

  async function snapshot(sender, receiver) {
    const send = await sender.getStats();
    const recv = await receiver.getStats();
    const outbound = [...send.values()].find(s =>
      s.type === 'outbound-rtp' && !s.isRemote && (s.kind === 'audio' || s.mediaType === 'audio'));
    const inbound = [...recv.values()].find(s =>
      s.type === 'inbound-rtp' && !s.isRemote && (s.kind === 'audio' || s.mediaType === 'audio'));
    if (!outbound || !inbound || !Number.isFinite(outbound.packetsSent) ||
        !Number.isFinite(inbound.packetsReceived) || !Number.isFinite(inbound.jitter) ||
        !Number.isFinite(inbound.packetsLost)) {
      throw new Error('AUDIO_RTP_STATS_UNAVAILABLE');
    }
    return {
      sent: outbound.packetsSent,
      received: inbound.packetsReceived,
      lost: inbound.packetsLost,
      jitterMs: inbound.jitter * 1000,
    };
  }

  function delta(before, after, stage) {
    const sentPackets = after.sent - before.sent;
    const receivedPackets = after.received - before.received;
    const lostPackets = after.lost - before.lost;
    if (sentPackets < 12 || receivedPackets < 12 || lostPackets < 0 ||
        after.jitterMs < 0 || !Number.isFinite(after.jitterMs)) {
      throw new Error('AUDIO_RTP_NOT_DELIVERED_' + stage);
    }
    return {
      sentPackets, receivedPackets, lostPackets,
      jitterMs: after.jitterMs,
      packetLossPercent: Number((100 * lostPackets / (receivedPackets + lostPackets)).toFixed(4)),
    };
  }

  async function run(size, updates) {
    if (size !== 10_000 || updates !== 8 || typeof window.__bench?.reset !== 'function') {
      throw new Error('AUDIO_FIXTURE_CONTRACT_FAILED');
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || typeof window.RTCPeerConnection !== 'function') {
      throw new Error('AUDIO_WEBRTC_UNAVAILABLE');
    }
    const context = new AudioContextClass({ sampleRate: 48_000 });
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    const destination = context.createMediaStreamDestination();
    const sender = new RTCPeerConnection({ iceServers: [] });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    oscillator.frequency.value = 440;
    volume.gain.value = 0.04;
    oscillator.connect(volume);
    volume.connect(destination);
    const tracks = destination.stream.getAudioTracks();
    if (tracks.length !== 1) throw new Error('AUDIO_TRACK_MISSING');
    sender.addTrack(tracks[0], destination.stream);
    let started = false;
    try {
      await context.resume();
      if (context.state !== 'running') throw new Error('AUDIO_CONTEXT_NOT_RUNNING');
      oscillator.start();
      started = true;
      await sender.setLocalDescription(await sender.createOffer());
      await waitForIce(sender);
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await waitForIce(receiver);
      await sender.setRemoteDescription(receiver.localDescription);
      await waitFor(async () => {
        if (sender.connectionState !== 'connected' || receiver.connectionState !== 'connected') return false;
        const stats = await snapshot(sender, receiver);
        return stats.received >= 12;
      }, 'AUDIO_RTP_CONNECTION_TIMEOUT');
      const idleBegan = performance.now();
      const idleStart = await snapshot(sender, receiver);
      await sleep(IDLE_MS);
      const idleEnd = await snapshot(sender, receiver);
      const idleDurationMs = performance.now() - idleBegan;
      const idle = delta(idleStart, idleEnd, 'IDLE');

      const start = performance.now();
      await window.__bench.reset(size);
      for (let i = 0; i < updates; i++) {
        await window.__bench.appendBatch(100);
        await window.__bench.setDraft('voice-stress-' + i + '-' + 'x'.repeat(128));
      }
      const uiWorkMs = performance.now() - start;
      const observed = document.querySelector('#rows')?.childElementCount;
      const expected = size + updates * 100;
      const preview = document.querySelector('#preview')?.textContent;
      if (observed !== expected || preview !== 'voice-stress-7-' + 'x'.repeat(128)) {
        throw new Error('AUDIO_UI_RENDER_MISMATCH');
      }
      // End the stressed RTP window with the last actual DOM commit. Do not
      // dilute it with a post-workload idle wait just to pad the measurement.
      const underLoadEnd = await snapshot(sender, receiver);
      const stressDurationMs = performance.now() - start;
      const stressed = delta(idleEnd, underLoadEnd, 'UI_STRESS');
      return {
        uiWorkMs, idleDurationMs, stressDurationMs,
        idle, stressed,
        observedRows: observed,
        senderConnected: sender.connectionState === 'connected',
        receiverConnected: receiver.connectionState === 'connected',
      };
    } finally {
      if (started) oscillator.stop();
      tracks.forEach(track => track.stop());
      sender.close();
      receiver.close();
      await context.close();
    }
  }

  window.__audioBench = { run };
})();
