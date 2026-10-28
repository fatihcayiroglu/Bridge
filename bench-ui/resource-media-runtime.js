// Same browser-side resource workload for Svelte and React Electron fixtures.
// These are actual *local* WebRTC RTP streams, not real Bridge conferences.
(() => {
  'use strict';
  const DURATION_MS = 1_200;
  const MAX_SETUP_MS = 25_000;
  const SIZES = Object.freeze({
    idle: 0, messages: 0, voice2: 1, voice5: 4, voice10: 9,
    video2: 1, screen2: 1, voice2_chat: 1,
  });
  let active = null;

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate, code) {
    const expires = Date.now() + MAX_SETUP_MS;
    while (Date.now() < expires) {
      if (await predicate()) return;
      await pause(100);
    }
    throw new Error(code);
  }
  const inbound = (stats, kind) => [...stats.values()].find(s =>
    s.type === 'inbound-rtp' && !s.isRemote && (s.kind === kind || s.mediaType === kind));

  async function stats(group) {
    const report = { audioPackets: 0, audioLost: 0, maxAudioJitterMs: 0,
      videoFrames: 0, rttSamplesMs: [] };
    for (const pair of group.pairs) {
      const entries = await pair.right.getStats();
      const audio = inbound(entries, 'audio');
      if (!audio || !Number.isFinite(audio.packetsReceived) ||
          !Number.isFinite(audio.packetsLost) || !Number.isFinite(audio.jitter)) {
        throw new Error('RESOURCE_AUDIO_RTP_UNAVAILABLE');
      }
      report.audioPackets += audio.packetsReceived;
      report.audioLost += audio.packetsLost;
      report.maxAudioJitterMs = Math.max(report.maxAudioJitterMs, audio.jitter * 1000);
      for (const candidate of entries.values()) {
        if (candidate.type === 'candidate-pair' && candidate.state === 'succeeded' &&
            Number.isFinite(candidate.currentRoundTripTime) && candidate.currentRoundTripTime >= 0) {
          report.rttSamplesMs.push(candidate.currentRoundTripTime * 1000);
        }
      }
      if (group.videoKind) {
        const video = inbound(entries, 'video');
        if (!video || !Number.isFinite(video.framesDecoded)) {
          throw new Error('RESOURCE_VIDEO_DECODE_UNAVAILABLE');
        }
        report.videoFrames += video.framesDecoded;
      }
    }
    return report;
  }

  async function negotiate(pair) {
    await pair.left.setLocalDescription(await pair.left.createOffer());
    await until(() => pair.left.iceGatheringState === 'complete', 'RESOURCE_ICE_GATHER_TIMEOUT');
    await pair.right.setRemoteDescription(pair.left.localDescription);
    await pair.right.setLocalDescription(await pair.right.createAnswer());
    await until(() => pair.right.iceGatheringState === 'complete', 'RESOURCE_ICE_GATHER_TIMEOUT');
    await pair.left.setRemoteDescription(pair.right.localDescription);
    await until(() => pair.left.connectionState === 'connected' &&
      pair.right.connectionState === 'connected', 'RESOURCE_RTC_CONNECT_TIMEOUT');
  }

  async function createMediaGroup(count, videoKind) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !window.RTCPeerConnection) {
      throw new Error('RESOURCE_MEDIA_API_UNAVAILABLE');
    }
    const ctx = new AudioContextClass({ sampleRate: 48_000 });
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const output = ctx.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.04;
    oscillator.connect(gain);
    gain.connect(output);
    const tracks = [...output.stream.getAudioTracks()];
    const group = { ctx, oscillator, tracks, pairs: [], videos: [], videoKind,
      frameTimer: null, canvas: null, started: false };
    try {
      if (videoKind) {
        const canvas = document.createElement('canvas');
        canvas.width = videoKind === 'screen' ? 1280 : 640;
        canvas.height = videoKind === 'screen' ? 720 : 360;
        const context = canvas.getContext('2d');
        if (!context || !canvas.captureStream) throw new Error('RESOURCE_CANVAS_CAPTURE_UNAVAILABLE');
        let frame = 0;
        const paint = () => {
          frame++;
          context.fillStyle = frame % 2 ? '#24385a' : '#385a24';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#f8f8f8';
          context.fillRect((frame * 17) % canvas.width, 25, 64, 64);
          context.fillText('Frame ' + frame, 12, 15);
        };
        paint();
        group.frameTimer = setInterval(paint, 66);
        group.canvas = canvas;
        const videoTrack = canvas.captureStream(15).getVideoTracks()[0];
        if (!videoTrack) throw new Error('RESOURCE_VIDEO_TRACK_MISSING');
        tracks.push(videoTrack);
      }
      const stream = new MediaStream(tracks);
      for (let i = 0; i < count; i++) {
        const left = new RTCPeerConnection({ iceServers: [] });
        const right = new RTCPeerConnection({ iceServers: [] });
        const pair = { left, right };
        group.pairs.push(pair);
        if (videoKind) {
          right.ontrack = event => {
            if (event.track.kind !== 'video') return;
            const video = document.createElement('video');
            video.muted = true;
            video.autoplay = true;
            video.playsInline = true;
            video.width = 1;
            video.height = 1;
            video.srcObject = new MediaStream([event.track]);
            document.body.appendChild(video);
            group.videos.push(video);
            void video.play().catch(() => {});
          };
        }
        for (const track of tracks) left.addTrack(track, stream);
      }
      await ctx.resume();
      if (ctx.state !== 'running') throw new Error('RESOURCE_AUDIO_CONTEXT_NOT_RUNNING');
      oscillator.start();
      group.started = true;
      await Promise.all(group.pairs.map(negotiate));
      await until(async () => {
        const now = await stats(group);
        return now.audioPackets >= count * 12 &&
          (!videoKind || now.videoFrames >= count * 2);
      }, 'RESOURCE_MEDIA_NOT_RECEIVED');
      return group;
    } catch (error) {
      await closeGroup(group);
      throw error;
    }
  }

  async function closeGroup(group) {
    if (!group) return;
    if (group.frameTimer) clearInterval(group.frameTimer);
    if (group.started) group.oscillator.stop();
    group.tracks.forEach(track => track.stop());
    group.pairs.forEach(({ left, right }) => { left.close(); right.close(); });
    group.videos.forEach(video => {
      video.pause();
      video.srcObject = null;
      video.remove();
    });
    if (group.ctx.state !== 'closed') await group.ctx.close();
  }

  async function prepare(mode) {
    if (!(mode in SIZES) || active || typeof window.__bench?.reset !== 'function') {
      throw new Error('RESOURCE_SCENARIO_INVALID');
    }
    // Preserve a clean, equal DOM before the measured CPU interval.
    await window.__bench.reset(0);
    const peers = SIZES[mode];
    const videoKind = mode === 'screen2' ? 'screen' : mode === 'video2' ? 'camera' : null;
    active = { mode, peerCount: peers, videoKind, group: null };
    try {
      if (peers) active.group = await createMediaGroup(peers, videoKind);
      return { mode, peerCount: peers, source: videoKind ? 'synthetic-canvas' : peers ? 'web-audio' : 'none' };
    } catch (error) {
      active = null;
      throw error;
    }
  }

  async function execute(mode) {
    if (!active || active.mode !== mode) throw new Error('RESOURCE_NOT_PREPARED');
    const { group, peerCount, videoKind } = active;
    const before = group ? await stats(group) : null;
    const started = performance.now();
    let uiWorkMs = 0;
    const loadChat = mode === 'messages' || mode === 'voice2_chat';
    if (loadChat) {
      const t = performance.now();
      await window.__bench.reset(10_000);
      for (let i = 0; i < 8; i++) {
        await window.__bench.appendBatch(100);
        await window.__bench.setDraft('resource-stress-' + i + '-' + 'x'.repeat(128));
      }
      uiWorkMs = performance.now() - t;
      const nodes = document.querySelector('#rows')?.childElementCount;
      if (nodes !== 10_800 || document.querySelector('#preview')?.textContent !==
        'resource-stress-7-' + 'x'.repeat(128)) {
        throw new Error('RESOURCE_UI_NOT_COMMITTED');
      }
    }
    await pause(Math.max(0, DURATION_MS - (performance.now() - started)));
    const measuredMs = performance.now() - started;
    const after = group ? await stats(group) : null;
    let audio = null;
    let video = null;
    if (group) {
      const received = after.audioPackets - before.audioPackets;
      const lost = after.audioLost - before.audioLost;
      const jitterMs = after.maxAudioJitterMs;
      if (!Number.isFinite(received) || received < peerCount * 12 ||
          lost < 0 || !Number.isFinite(jitterMs) || jitterMs < 0) {
        throw new Error('RESOURCE_AUDIO_RTP_NOT_MEASURED');
      }
      audio = {
        peerLinks: peerCount,
        receivedPackets: received,
        lostPackets: lost,
        jitterMs,
        lossPercent: Number((100 * lost / (received + lost)).toFixed(4)),
        localCandidateRttMs: after.rttSamplesMs.length
          ? Number((after.rttSamplesMs.reduce((sum, n) => sum + n, 0) /
              after.rttSamplesMs.length).toFixed(4)) : null,
      };
      if (videoKind) {
        const framesDecoded = after.videoFrames - before.videoFrames;
        if (!Number.isFinite(framesDecoded) || framesDecoded < 5) {
          throw new Error('RESOURCE_VIDEO_FRAMES_NOT_DECODED');
        }
        video = {
          source: 'synthetic-canvas; not physical camera/OS screen',
          framesDecoded,
          decodedFps: Number((framesDecoded * 1000 / measuredMs).toFixed(2)),
        };
      }
    }
    return { mode, measuredMs, uiWorkMs, audio, video };
  }

  async function teardown() {
    const current = active;
    active = null;
    await closeGroup(current?.group);
  }
  window.__resourceBench = { prepare, execute, teardown };
})();
