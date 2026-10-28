// Objective decoded PCM fidelity over actual local WebRTC RTP.
// The source is synthetic 440 Hz, never microphone/speech, acoustic MOS or SFU.
(() => {
  'use strict';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const configs = Object.freeze({ voice2: 1, voice10: 9, voice2_chat: 1 });
  const SETUP_TIMEOUT = 25_000;
  const MEASURE_MS = 2_000;
  let active = null;

  async function until(predicate, code) {
    const deadline = Date.now() + SETUP_TIMEOUT;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await pause(100);
    }
    throw new Error(code);
  }
  async function negotiate(pair) {
    await pair.left.setLocalDescription(await pair.left.createOffer());
    await until(() => pair.left.iceGatheringState === 'complete', 'AUDIO_ICE_GATHER_TIMEOUT');
    await pair.right.setRemoteDescription(pair.left.localDescription);
    await pair.right.setLocalDescription(await pair.right.createAnswer());
    await until(() => pair.right.iceGatheringState === 'complete', 'AUDIO_ICE_GATHER_TIMEOUT');
    await pair.left.setRemoteDescription(pair.right.localDescription);
    await until(() => pair.left.connectionState === 'connected' &&
      pair.right.connectionState === 'connected', 'AUDIO_RTC_CONNECT_TIMEOUT');
  }
  async function rtp(group) {
    const report = { packets: 0, lost: 0, jitterMs: 0 };
    for (const pair of group.pairs) {
      const entries = await pair.right.getStats();
      const audio = [...entries.values()].find(x => x.type === 'inbound-rtp' &&
        !x.isRemote && (x.kind === 'audio' || x.mediaType === 'audio'));
      if (!audio || !Number.isFinite(audio.packetsReceived) ||
          !Number.isFinite(audio.packetsLost) || !Number.isFinite(audio.jitter)) {
        throw new Error('AUDIO_RTP_STATS_UNAVAILABLE');
      }
      report.packets += audio.packetsReceived;
      report.lost += audio.packetsLost;
      report.jitterMs = Math.max(report.jitterMs, audio.jitter * 1000);
    }
    return report;
  }
  async function close(group) {
    if (!group) return;
    if (group.started) group.oscillator.stop();
    group.track.stop();
    group.pairs.forEach(({ left, right }) => { left.close(); right.close(); });
    if (group.audioContext.state !== 'closed') await group.audioContext.close();
  }
  async function prepare(mode) {
    if (active || !(mode in configs) || typeof window.__bench?.reset !== 'function' ||
        !window.__audioQualityMath?.measure || !window.RTCPeerConnection) {
      throw new Error('AUDIO_QUALITY_PREPARE_INVALID');
    }
    await window.__bench.reset(0);
    const audioContext = new AudioContext({ sampleRate: 48000 });
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const output = audioContext.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.06;
    oscillator.connect(gain);
    gain.connect(output);
    const track = output.stream.getAudioTracks()[0];
    if (!track) throw new Error('AUDIO_SOURCE_TRACK_MISSING');
    const group = { mode, count: configs[mode], audioContext, oscillator,
      track, pairs: [], analyser: null, started: false };
    try {
      for (let i = 0; i < group.count; i++) {
        const left = new RTCPeerConnection({ iceServers: [] });
        const right = new RTCPeerConnection({ iceServers: [] });
        const pair = { left, right };
        group.pairs.push(pair);
        if (i === 0) {
          right.ontrack = event => {
            if (event.track.kind !== 'audio') return;
            const source = audioContext.createMediaStreamSource(new MediaStream([event.track]));
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0;
            const silentOutput = audioContext.createGain();
            silentOutput.gain.value = 0;
            source.connect(analyser);
            analyser.connect(silentOutput);
            silentOutput.connect(audioContext.destination);
            group.analyser = analyser;
          };
        }
        left.addTrack(track, output.stream);
      }
      await audioContext.resume();
      if (audioContext.state !== 'running') throw new Error('AUDIO_CONTEXT_NOT_RUNNING');
      oscillator.start();
      group.started = true;
      await Promise.all(group.pairs.map(negotiate));
      await until(async () => {
        const stats = await rtp(group);
        if (stats.packets < group.count * 15 || !group.analyser) return false;
        const data = new Float32Array(2048);
        group.analyser.getFloatTimeDomainData(data);
        return window.__audioQualityMath.measure(data, audioContext.sampleRate).rms > 0.003;
      }, 'AUDIO_DECODED_PCM_NOT_AVAILABLE');
      active = group;
      return { mode, peerLinks: group.count, source: 'local-synthetic-440Hz' };
    } catch (error) {
      await close(group);
      throw error;
    }
  }
  async function execute(mode) {
    if (!active || active.mode !== mode || !active.analyser) {
      throw new Error('AUDIO_QUALITY_NOT_PREPARED');
    }
    const group = active;
    const before = await rtp(group);
    const started = performance.now();
    const windows = [];
    const sampling = (async () => {
      for (let i = 0; i < 20; i++) {
        await pause(100);
        const pcm = new Float32Array(2048);
        group.analyser.getFloatTimeDomainData(pcm);
        windows.push({ ...window.__audioQualityMath.measure(pcm, group.audioContext.sampleRate),
          time: performance.now() });
      }
    })();
    let uiWorkMs = 0;
    if (mode === 'voice2_chat') {
      const t = performance.now();
      await window.__bench.reset(10_000);
      for (let i = 0; i < 8; i++) {
        await window.__bench.appendBatch(100);
        await window.__bench.setDraft('audio-stress-' + i + '-'.repeat(64));
      }
      uiWorkMs = performance.now() - t;
      if (document.querySelector('#rows')?.childElementCount !== 10_800 ||
          document.querySelector('#preview')?.textContent !== 'audio-stress-7-' + '-'.repeat(64)) {
        throw new Error('AUDIO_QUALITY_CHAT_NOT_COMMITTED');
      }
    }
    await sampling;
    while (performance.now() - started < MEASURE_MS) await pause(3);
    const measuredMs = performance.now() - started;
    const after = await rtp(group);
    const packets = after.packets - before.packets;
    const lost = after.lost - before.lost;
    const valid = windows.filter(w => !w.dropout);
    if (windows.length !== 20 || valid.length < 12 || packets < group.count * 35 ||
        lost < 0 || !Number.isFinite(after.jitterMs) || measuredMs < MEASURE_MS) {
      throw new Error('AUDIO_QUALITY_NOT_MEASURED');
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
    const gaps = windows.slice(1).map((w, i) => w.time - windows[i].time);
    return {
      mode, measuredMs, uiWorkMs, sampleWindows: windows.length,
      dropoutPercent: 100 * (windows.length - valid.length) / windows.length,
      snrDb: median(valid.map(w => w.snrDb)),
      rms: median(valid.map(w => w.rms)),
      clippingPercent: Math.max(...valid.map(w => w.clippingPercent)),
      maxSampleGapMs: Math.max(...gaps),
      rtp: { peerLinks: group.count, receivedPackets: packets, lostPackets: lost,
        lossPercent: 100 * lost / (packets + lost), maxJitterMs: after.jitterMs },
    };
  }
  async function teardown() {
    const group = active;
    active = null;
    await close(group);
  }
  window.__audioQualityBench = { prepare, execute, teardown };
})();
