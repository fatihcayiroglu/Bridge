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
    if (group.audioElement) {
      group.audioElement.pause();
      group.audioElement.srcObject = null;
      group.audioElement.remove();
    }
    if (group.receiveContext.state !== 'closed') await group.receiveContext.close();
    if (group.audioContext.state !== 'closed') await group.audioContext.close();
  }
  async function prepare(mode) {
    if (active || !(mode in configs) || typeof window.__bench?.reset !== 'function' ||
        !window.__audioQualityMath?.measure || !window.RTCPeerConnection) {
      throw new Error('AUDIO_QUALITY_PREPARE_INVALID');
    }
    await window.__bench.reset(0);
    const audioContext = new AudioContext({ sampleRate: 48000 });
    const receiveContext = new AudioContext({ sampleRate: 48000 });
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const output = audioContext.createMediaStreamDestination();
    const sourceAnalyser = audioContext.createAnalyser();
    sourceAnalyser.fftSize = 2048;
    oscillator.frequency.value = 440;
    gain.gain.value = 0.06;
    oscillator.connect(gain);
    gain.connect(sourceAnalyser);
    sourceAnalyser.connect(output);
    const track = output.stream.getAudioTracks()[0];
    if (!track) throw new Error('AUDIO_SOURCE_TRACK_MISSING');
    const group = { mode, count: configs[mode], audioContext, receiveContext, oscillator,
      track, pairs: [], analyser: null, receiverTrack: null,
      sourceAnalyser, audioElement: null, playError: null, started: false };
    try {
      for (let i = 0; i < group.count; i++) {
        const left = new RTCPeerConnection({ iceServers: [] });
        const right = new RTCPeerConnection({ iceServers: [] });
        const pair = { left, right };
        group.pairs.push(pair);
        if (i === 0) {
          right.ontrack = event => {
            if (event.track.kind !== 'audio') return;
            const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
            const audioElement = document.createElement('audio');
            audioElement.autoplay = true;
            audioElement.volume = 0.0001;
            audioElement.srcObject = remoteStream;
            document.body.appendChild(audioElement);
            group.audioElement = audioElement;
            void audioElement.play().catch(error => {
              group.playError = error?.name ?? 'play-error';
            });
            const source = receiveContext.createMediaStreamSource(remoteStream);
            const analyser = receiveContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0;
            const silentOutput = receiveContext.createGain();
            // A fully zero-gain output can be pruned by browser audio
            // optimizations. Keep an effectively inaudible nonzero sink.
            silentOutput.gain.value = 0.001;
            source.connect(analyser);
            analyser.connect(silentOutput);
            silentOutput.connect(receiveContext.destination);
            group.analyser = analyser;
            group.receiverTrack = event.track;
          };
        }
        left.addTrack(track, output.stream);
      }
      await audioContext.resume();
      await receiveContext.resume();
      if (audioContext.state !== 'running' || receiveContext.state !== 'running') {
        throw new Error('AUDIO_CONTEXT_NOT_RUNNING');
      }
      oscillator.start();
      group.started = true;
      await Promise.all(group.pairs.map(negotiate));
      let lastSnapshot = {};
      try {
        await until(async () => {
          const stats = await rtp(group);
          const sourceData = new Float32Array(2048);
          group.sourceAnalyser.getFloatTimeDomainData(sourceData);
          const sourceRms = window.__audioQualityMath.measure(sourceData, audioContext.sampleRate).rms;
          const receivedData = new Float32Array(2048);
          if (group.analyser) group.analyser.getFloatTimeDomainData(receivedData);
          const receivedRms = window.__audioQualityMath.measure(receivedData, receiveContext.sampleRate).rms;
          lastSnapshot = { packets: stats.packets, sourceRms: Number(sourceRms.toFixed(5)),
            receivedRms: Number(receivedRms.toFixed(5)), analyserReady: !!group.analyser,
            receiverState: group.receiverTrack?.readyState ?? 'absent',
            receiverMuted: group.receiverTrack?.muted ?? null,
            sourceState: track.readyState, audioContextState: audioContext.state,
            receiveContextState: receiveContext.state,
            audioPlaying: group.audioElement ? !group.audioElement.paused : false,
            audioReadyState: group.audioElement?.readyState ?? null,
            audioPlayError: group.playError };
          return stats.packets >= group.count * 15 && receivedRms > 0.003;
        }, 'AUDIO_DECODED_PCM_NOT_AVAILABLE');
      } catch (error) {
        if (error.message === 'AUDIO_DECODED_PCM_NOT_AVAILABLE') {
          throw new Error('AUDIO_DECODED_PCM_NOT_AVAILABLE ' + JSON.stringify(lastSnapshot));
        }
        throw error;
      }
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
        windows.push({ ...window.__audioQualityMath.measure(pcm, group.receiveContext.sampleRate),
          time: performance.now() });
      }
    })();
    let uiWorkMs = 0;
    if (mode === 'voice2_chat') {
      const draft = i => 'audio-stress-' + i + '-'.repeat(64);
      const t = performance.now();
      await window.__bench.reset(10_000);
      for (let i = 0; i < 8; i++) {
        await window.__bench.appendBatch(100);
        await window.__bench.setDraft(draft(i));
      }
      uiWorkMs = performance.now() - t;
      if (document.querySelector('#rows')?.childElementCount !== 10_800 ||
          document.querySelector('#preview')?.textContent !== draft(7)) {
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
