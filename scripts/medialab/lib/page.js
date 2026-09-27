// scripts/medialab/lib/page.js
//
// Browser-side instrumentation for the media lab, injected before any app
// script runs. It never changes what the app does: it only observes the
// app's own RTCPeerConnections (created by mediasoup-client) and analyses
// what the browser actually decoded.
//
//   __ml.pcs / __ml.events   every RTCPeerConnection, its ICE / connection
//                            state transitions with wall-clock timestamps
//   __ml.tracks              every remote track the browser surfaced
//   __mlSample()             one full getStats() + decoded-media snapshot
//   __mlStartWatch()         200 ms timeline of decoded tones, colours and
//                            packet counters (continuity / gap analysis)
//
// ICE server credentials are never recorded: only URLs and a boolean.
(() => {
  if (window.__ml) return;
  const ml = window.__ml = { pcs: [], events: [], tracks: [], analysers: new Map(), videos: new Map(), timeline: [], marks: {} };
  const Orig = window.RTCPeerConnection;
  const summarize = (cfg) => {
    const servers = (cfg && cfg.iceServers) || [];
    return {
      iceTransportPolicy: (cfg && cfg.iceTransportPolicy) || 'all',
      iceServerUrls: servers.flatMap((s) => [].concat(s.urls || [])),
      hasTurnCredential: servers.some((s) => typeof s.credential === 'string' && s.credential.length > 0),
    };
  };
  class MlPeerConnection extends Orig {
    constructor(cfg, ...rest) {
      super(cfg, ...rest);
      const id = ml.pcs.length;
      ml.pcs.push(this);
      this.__mlId = id;
      ml.events.push({ t: Date.now(), pc: id, ev: 'created', cfg: summarize(cfg) });
      this.addEventListener('iceconnectionstatechange', () => ml.events.push({ t: Date.now(), pc: id, ev: 'ice', state: this.iceConnectionState }));
      this.addEventListener('connectionstatechange', () => ml.events.push({ t: Date.now(), pc: id, ev: 'conn', state: this.connectionState }));
      this.addEventListener('icecandidate', (e) => {
        if (e.candidate) ml.events.push({ t: Date.now(), pc: id, ev: 'cand', type: e.candidate.type, protocol: e.candidate.protocol });
      });
      this.addEventListener('track', (e) => {
        // mediasoup-client's bandwidth "probator" receiver is a real
        // transceiver but carries only padding; it is not remote media.
        const mid = e.transceiver?.mid ?? null;
        ml.tracks.push({ pc: id, t: Date.now(), track: e.track, mid, probator: mid === 'probator' });
        ml.events.push({ t: Date.now(), pc: id, ev: 'track', kind: e.track.kind, mid });
      });
    }
  }
  window.RTCPeerConnection = MlPeerConnection;

  const audioCtx = () => {
    if (!ml.ctx) ml.ctx = new AudioContext({ sampleRate: 48000 });
    if (ml.ctx.state !== 'running') ml.ctx.resume().catch(() => {});
    return ml.ctx;
  };

  const analyseAudio = (entry) => {
    let a = ml.analysers.get(entry.track);
    if (!a) {
      const ctx = audioCtx();
      // Chromium only feeds remote WebRTC audio into WebAudio while the
      // stream is also attached to a media element; keep it muted.
      const el = new Audio();
      el.muted = true;
      el.srcObject = new MediaStream([entry.track]);
      el.play().catch(() => {});
      const src = ctx.createMediaStreamSource(new MediaStream([entry.track]));
      const an = ctx.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      a = { an, el, buf: new Float32Array(an.frequencyBinCount) };
      ml.analysers.set(entry.track, a);
    }
    a.an.getFloatFrequencyData(a.buf);
    const binHz = 48000 / a.an.fftSize;
    const lo = Math.floor(100 / binHz);
    const hi = Math.floor(4000 / binHz);
    let peak = -Infinity;
    let peakBin = lo;
    const vals = [];
    for (let i = lo; i < hi; i++) {
      const v = a.buf[i];
      vals.push(v);
      if (v > peak) { peak = v; peakBin = i; }
    }
    vals.sort((x, y) => x - y);
    const median = vals[vals.length >> 1];
    return {
      freq: Math.round(peakBin * binHz),
      peakDb: Number.isFinite(peak) ? Math.round(peak) : -200,
      snrDb: Number.isFinite(peak) && Number.isFinite(median) ? Math.round(peak - median) : 0,
    };
  };

  const analyseVideo = (entry) => {
    let v = ml.videos.get(entry.track);
    if (!v) {
      const el = document.createElement('video');
      el.muted = true;
      el.autoplay = true;
      el.playsInline = true;
      el.style.cssText = 'position:fixed;left:-9999px;top:0;width:64px;height:48px';
      el.srcObject = new MediaStream([entry.track]);
      document.documentElement.appendChild(el);
      el.play().catch(() => {});
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      v = { el, canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
      ml.videos.set(entry.track, v);
    }
    const out = { w: v.el.videoWidth, h: v.el.videoHeight, frames: v.el.getVideoPlaybackQuality?.().totalVideoFrames ?? null };
    if (v.el.videoWidth > 0) {
      v.ctx.drawImage(v.el, 0, 0, 32, 24);
      // Identity band = top quarter of the frame (rows 0..5 of 24).
      const d = v.ctx.getImageData(0, 1, 32, 4).data;
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      out.rgb = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }
    return out;
  };

  const liveTracks = () => ml.tracks.filter((e) => e.track.readyState === 'live' && !e.probator);

  const pick = (r, keys) => {
    const o = {};
    for (const k of keys) if (r[k] !== undefined) o[k] = r[k];
    return o;
  };
  const OUT_KEYS = ['kind', 'rid', 'ssrc', 'mid', 'packetsSent', 'bytesSent', 'retransmittedPacketsSent', 'nackCount', 'pliCount', 'firCount',
    'frameWidth', 'frameHeight', 'framesPerSecond', 'framesEncoded', 'keyFramesEncoded', 'qualityLimitationReason', 'qualityLimitationDurations',
    'targetBitrate', 'active', 'scalabilityMode', 'encoderImplementation', 'codecId', 'headerBytesSent'];
  const IN_KEYS = ['kind', 'ssrc', 'mid', 'trackIdentifier', 'packetsReceived', 'packetsLost', 'bytesReceived', 'jitter', 'jitterBufferDelay',
    'jitterBufferEmittedCount', 'jitterBufferTargetDelay', 'concealedSamples', 'silentConcealedSamples', 'totalSamplesReceived', 'concealmentEvents',
    'insertedSamplesForDeceleration', 'removedSamplesForAcceleration', 'fecPacketsReceived', 'fecPacketsDiscarded', 'packetsDiscarded',
    'nackCount', 'pliCount', 'firCount', 'framesDecoded', 'framesDropped', 'framesReceived', 'keyFramesDecoded', 'frameWidth', 'frameHeight',
    'framesPerSecond', 'freezeCount', 'totalFreezesDuration', 'pauseCount', 'totalPauseDuration', 'audioLevel', 'totalAudioEnergy',
    'lastPacketReceivedTimestamp', 'codecId', 'decoderImplementation'];
  const REMOTE_IN_KEYS = ['kind', 'ssrc', 'packetsLost', 'fractionLost', 'jitter', 'roundTripTime', 'localId'];

  window.__mlSample = async () => {
    const pcs = [];
    for (const pc of ml.pcs) {
      const entry = { id: pc.__mlId, conn: pc.connectionState, ice: pc.iceConnectionState, outbound: [], inbound: [], remoteInbound: [] };
      if (pc.connectionState === 'closed') { pcs.push(entry); continue; }
      let stats;
      try { stats = await pc.getStats(); } catch { pcs.push(entry); continue; }
      const byId = new Map();
      stats.forEach((r) => byId.set(r.id, r));
      stats.forEach((r) => {
        if (r.type === 'transport') {
          entry.dtlsState = r.dtlsState;
          entry.iceState = r.iceState;
          entry.selectedCandidatePairChanges = r.selectedCandidatePairChanges;
          const pair = byId.get(r.selectedCandidatePairId);
          if (pair) {
            const lc = byId.get(pair.localCandidateId) || {};
            const rc = byId.get(pair.remoteCandidateId) || {};
            entry.pair = {
              state: pair.state, rtt: pair.currentRoundTripTime, availableOutgoingBitrate: pair.availableOutgoingBitrate,
              bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived, consentRequestsSent: pair.consentRequestsSent,
              local: { type: lc.candidateType, protocol: lc.protocol, relayProtocol: lc.relayProtocol, address: lc.address, port: lc.port, url: lc.url },
              remote: { type: rc.candidateType, protocol: rc.protocol, address: rc.address, port: rc.port },
            };
          }
        } else if (r.type === 'outbound-rtp') {
          const o = pick(r, OUT_KEYS);
          const codec = byId.get(r.codecId);
          if (codec) o.codec = codec.mimeType;
          entry.outbound.push(o);
        } else if (r.type === 'inbound-rtp') {
          const o = pick(r, IN_KEYS);
          const codec = byId.get(r.codecId);
          if (codec) o.codec = codec.mimeType;
          entry.inbound.push(o);
        } else if (r.type === 'remote-inbound-rtp') {
          entry.remoteInbound.push(pick(r, REMOTE_IN_KEYS));
        }
      });
      pcs.push(entry);
    }
    const tracks = liveTracks().map((e, i) => {
      const base = { i, pc: e.pc, kind: e.track.kind, muted: e.track.muted, since: e.t };
      try {
        return { ...base, ...(e.track.kind === 'audio' ? analyseAudio(e) : analyseVideo(e)) };
      } catch (err) { return { ...base, error: String(err) }; }
    });
    const remoteAudioEls = [...document.querySelectorAll('audio.remote-audio')];
    return {
      t: Date.now(), pcs, tracks,
      remoteAudioElements: remoteAudioEls.length,
      remoteAudioElementsPlaying: remoteAudioEls.filter((el) => el.srcObject && !el.paused).length,
      remoteAudioElementsMuted: remoteAudioEls.filter((el) => el.muted).length,
      liveCaptures: window.__mlLiveCaptures ? window.__mlLiveCaptures().length : null,
      audioContextState: ml.ctx?.state ?? null,
    };
  };

  // Decoded-media timeline: which tones are audible and how many packets
  // moved, every 200 ms. Gap/continuity analysis reads this afterwards.
  window.__mlStartWatch = () => {
    if (ml.watch) return;
    ml.watch = setInterval(async () => {
      const t = Date.now();
      const tones = [];
      const colours = [];
      for (const e of liveTracks()) {
        try {
          if (e.track.kind === 'audio') {
            const a = analyseAudio(e);
            tones.push([a.freq, a.snrDb, a.peakDb]);
          } else {
            const v = analyseVideo(e);
            colours.push([v.rgb || null, v.w, v.h, v.frames]);
          }
        } catch { /* track torn down mid-sample */ }
      }
      let outA = 0; let inA = 0; let outV = 0; let inVFrames = 0; let connected = 0;
      for (const pc of ml.pcs) {
        if (pc.connectionState === 'closed') continue;
        if (pc.connectionState === 'connected') connected++;
        try {
          const s = await pc.getStats();
          s.forEach((r) => {
            if (r.type === 'outbound-rtp' && r.kind === 'audio') outA += r.packetsSent || 0;
            if (r.type === 'outbound-rtp' && r.kind === 'video') outV += r.packetsSent || 0;
            if (r.type === 'inbound-rtp' && r.kind === 'audio') inA += r.packetsReceived || 0;
            if (r.type === 'inbound-rtp' && r.kind === 'video') inVFrames += r.framesDecoded || 0;
          });
        } catch { /* closed */ }
      }
      ml.timeline.push({ t, tones, colours, outA, inA, outV, inVFrames, connected, pcs: ml.pcs.length });
      if (ml.timeline.length > 30000) ml.timeline.splice(0, ml.timeline.length - 30000);
    }, 200);
  };
  window.__mlTimeline = (since = 0) => ml.timeline.filter((e) => e.t >= since);
  window.__mlEvents = (since = 0) => ml.events.filter((e) => e.t >= since);

  // Local capture tracks the app holds (leak check for camera/screen).
  const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const origGdm = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
  window.__mlCaptured = [];
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await origGum(c);
    s.getTracks().forEach((track) => window.__mlCaptured.push({ t: Date.now(), kind: track.kind, source: 'user', track }));
    return s;
  };
  if (origGdm) {
    navigator.mediaDevices.getDisplayMedia = async (c) => {
      const s = await origGdm(c);
      s.getTracks().forEach((track) => window.__mlCaptured.push({ t: Date.now(), kind: track.kind, source: 'display', track }));
      return s;
    };
  }
  window.__mlLiveCaptures = () => window.__mlCaptured
    .filter((c) => c.track.readyState === 'live')
    .map((c) => ({ kind: c.kind, source: c.source, enabled: c.track.enabled, since: c.t }));
})();
