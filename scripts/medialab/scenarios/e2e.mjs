// scripts/medialab/scenarios/e2e.mjs
//
// End-to-end media between two real browsers on a clean network: two-way
// audio (decoded tone identity, not packet counters alone), the app's own
// playback path, video, screen share, mute/unmute, deafen, leave/rejoin and
// repeated join/leave cycles with server-side leak evidence.

import { audibleSenders, visibleSenders, rtp, rates } from '../lib/analysis.mjs';
import { sleep, waitUntil, waitAudible, waitSilent, joinTimings, paths, redirects } from '../lib/util.mjs';

export async function run({ lab, record, measure }) {
  const [ua, ub] = await lab.users(2, 'e2e');
  const room = await lab.voiceRoom(ua, [ub]);
  const A = await lab.client(0, ua);
  const B = await lab.client(1, ub);
  const both = [0, 1];

  await A.joinVoice(room);
  await sleep(1500);
  await B.joinVoice(room);
  const owner = lab.roomOwner(room.channelId);

  // ── two-way audio ──────────────────────────────────────────────────────
  const ab = await waitAudible(B, [0], both, 15_000);
  record('E2E-01', 'A→B audio: B decodes A\'s tone', ab.ok ? 'PASS' : 'FAIL',
    ab.ok ? `after B joined: ${ab.ms} ms` : `B heard ${JSON.stringify(ab.value?.heard ?? [])}; B inbound audio packets ${rtp(await B.sample()).audioIn.packets}`);
  const ba = await waitAudible(A, [1], both, 15_000);
  record('E2E-02', 'B→A audio: A decodes B\'s tone', ba.ok ? 'PASS' : 'FAIL',
    ba.ok ? `${ba.ms} ms` : `A heard ${JSON.stringify(ba.value?.heard ?? [])}`);

  const sa0 = await A.sample(); const sb0 = await B.sample();
  record('E2E-03', 'selected ICE path (clean network, no relay policy)', 'INFO',
    `A ${paths(sa0).join(', ')} | B ${paths(sb0).join(', ')} | room owner ${owner} | SFU redirects A=${redirects(A)} B=${redirects(B)}`);

  // The product's playback path: a playing `audio.remote-audio` element per peer.
  const playback = await waitUntil(async () => {
    const [x, y] = [await A.sample(), await B.sample()];
    return x.remoteAudioElementsPlaying >= 1 && y.remoteAudioElementsPlaying >= 1 ? [x, y] : null;
  }, { timeoutMs: 8_000 });
  const pa = playback.value?.[0] ?? await A.sample();
  const pb = playback.value?.[1] ?? await B.sample();
  record('E2E-04', 'app plays remote audio (audio.remote-audio element attached and playing)', playback.ok ? 'PASS' : 'FAIL',
    `A elements=${pa.remoteAudioElements} playing=${pa.remoteAudioElementsPlaying}; B elements=${pb.remoteAudioElements} playing=${pb.remoteAudioElementsPlaying}`);

  const dupA = audibleSenders(pa, both).filter((i) => i === 1).length;
  const dupB = audibleSenders(pb, both).filter((i) => i === 0).length;
  const selfA = audibleSenders(pa, both).includes(0);
  const selfB = audibleSenders(pb, both).includes(1);
  record('E2E-05', 'no duplicate audio and no self-echo', dupA <= 1 && dupB <= 1 && !selfA && !selfB && pa.remoteAudioElements <= 1 && pb.remoteAudioElements <= 1 ? 'PASS' : 'FAIL',
    `A: B-tone tracks ${dupA}, own tone ${selfA}, elements ${pa.remoteAudioElements}; B: A-tone tracks ${dupB}, own tone ${selfB}, elements ${pb.remoteAudioElements}`);

  for (const [c, peer] of [[A, B], [B, A]]) {
    const t = await joinTimings(c, [peer]);
    measure(`join.${c.name}`, {
      pcCreated: t.firstPcCreatedMs, iceConnected: t.firstIceConnectedMs, dtlsConnected: t.firstDtlsConnectedMs,
      allTransportsConnected: t.lastDtlsConnectedMs, firstAudioSent: t.firstAudioSentMs, firstToneDecoded: t.firstToneDecodedMs[peer.index],
    }, 'ms from UI click', `policy ${t.cfg.map((x) => x.iceTransportPolicy).join('/')}`);
  }
  const w0a = await A.sample(); const w0b = await B.sample();
  await sleep(10_000);
  const w1a = await A.sample(); const w1b = await B.sample();
  measure('audio.clean.A', rates(w0a, w1a), 'window');
  measure('audio.clean.B', rates(w0b, w1b), 'window');

  // ── mute / unmute ──────────────────────────────────────────────────────
  const outBefore = rtp(await A.sample()).audioOut.packets;
  const tMute = await A.toggleMute();
  const muted = await waitSilent(B, [0], both, 8_000);
  await sleep(2000);
  const outMid1 = rtp(await A.sample()).audioOut.packets;
  await sleep(2000);
  const outMid2 = rtp(await A.sample()).audioOut.packets;
  // Mute disables the track (mediasoup-client Producer.pause without
  // zeroRtpOnPause): Opus DTX keeps a few comfort-noise packets flowing, the
  // tone must be gone at the receiver and the rate must fall far below 50 pps.
  record('E2E-06', 'mute: B stops hearing A; A\'s audio RTP drops to DTX rate', muted.ok && (outMid2 - outMid1) / 2 < 12 ? 'PASS' : 'FAIL',
    `silent after ${muted.ms} ms; A audio ${Math.round((outMid2 - outMid1) / 2)} pps while muted (50 pps unmuted; total before mute ${outBefore})`);
  const tUnmute = await A.toggleMute();
  const unmuted = await waitAudible(B, [0], both, 8_000);
  record('E2E-07', 'unmute: B hears A again', unmuted.ok ? 'PASS' : 'FAIL', `${unmuted.ms} ms after click`);
  measure('mute.latency', { muteToSilenceMs: muted.ms, unmuteToAudibleMs: unmuted.ms, clickGapMs: tUnmute - tMute }, 'ms');

  // ── deafen ─────────────────────────────────────────────────────────────
  await B.toggleDeafen();
  await sleep(1500);
  const sd = await B.sample();
  const aHearsB = await waitSilent(A, [1], both, 6_000);
  const inB1 = rtp(sd).audioIn.packets; await sleep(2000); const inB2 = rtp(await B.sample()).audioIn.packets;
  const ui = await B.uiState();
  record('E2E-08', 'deafen: remote playback muted and own microphone muted', sd.remoteAudioElements >= 1 && sd.remoteAudioElementsMuted === sd.remoteAudioElements && aHearsB.ok && ui.muted ? 'PASS' : 'FAIL',
    `B remote elements muted ${sd.remoteAudioElementsMuted}/${sd.remoteAudioElements}; A stopped hearing B: ${aHearsB.ok}; B mute button pressed: ${ui.muted}`);
  record('E2E-09', 'deafen does not stop receiving (receive-side playback mute only)', 'INFO',
    `B kept receiving ${inB2 - inB1} audio packets in 2 s while deafened`);
  await B.toggleDeafen();
  await sleep(500);
  if ((await B.uiState()).muted) await B.toggleMute();
  const undeaf = await waitAudible(A, [1], both, 8_000);
  record('E2E-10', 'undeafen + unmute restores B→A audio', undeaf.ok ? 'PASS' : 'FAIL', `${undeaf.ms} ms`);

  // ── video ──────────────────────────────────────────────────────────────
  const tv = await A.toggleVideo();
  const vid = await waitUntil(async () => {
    const s = await B.sample();
    return visibleSenders(s).includes(0) ? s : null;
  }, { timeoutMs: 20_000 });
  record('E2E-11', 'camera A→B: B decodes A\'s identity frames', vid.ok ? 'PASS' : 'FAIL',
    vid.ok ? `${vid.ms} ms after camera click` : `B video tracks: ${JSON.stringify((await B.sample()).tracks.filter((t) => t.kind === 'video'))}`);
  if (vid.ok) {
    await sleep(8000);
    const v0 = await B.sample(); const s0 = await A.sample();
    await sleep(8000);
    const v1 = await B.sample(); const s1 = await A.sample();
    measure('video.clean.receiver', rates(v0, v1), 'window');
    measure('video.clean.sender', rates(s0, s1), 'window');
  }
  const bv = await B.toggleVideo();
  const vid2 = await waitUntil(async () => (visibleSenders(await A.sample()).includes(1) ? true : null), { timeoutMs: 20_000 });
  record('E2E-12', 'camera B→A: A decodes B\'s identity frames', vid2.ok ? 'PASS' : 'FAIL', `${vid2.ms} ms (click ${bv - tv} ms after A)`);
  await A.toggleVideo();
  const voff = await waitUntil(async () => (!visibleSenders(await B.sample()).includes(0) ? true : null), { timeoutMs: 10_000 });
  const capA = await A.liveCaptures();
  record('E2E-13', 'camera off: B stops receiving A\'s video; A releases the camera', voff.ok && !capA.some((c) => c.kind === 'video') ? 'PASS' : 'FAIL',
    `B stopped seeing A after ${voff.ms} ms; A live captures ${JSON.stringify(capA)}`);
  await B.toggleVideo();

  // ── screen share ───────────────────────────────────────────────────────
  const tss = await A.startScreenShare();
  const ss = await waitUntil(async () => {
    const s = await B.sample();
    const r = rtp(s);
    return r.videoIn.frames > 0 && s.tracks.some((t) => t.kind === 'video' && t.w > 0) ? s : null;
  }, { timeoutMs: 20_000 });
  const capSs = await A.liveCaptures();
  if (!capSs.some((c) => c.source === 'display')) {
    record('E2E-14', 'screen share A→B', 'BLOCKED', `headless Chromium returned no display capture (${JSON.stringify(capSs)}); screen share not exercised in this environment`);
  } else {
    record('E2E-14', 'screen share A→B: B decodes the shared screen', ss.ok ? 'PASS' : 'FAIL',
      ss.ok ? `${ss.ms} ms; ${rtp(ss.value).videoIn.res.join(',')}` : 'no decoded screen frames at B');
    if (ss.ok) {
      await sleep(6000);
      const q0 = await B.sample(); await sleep(6000); const q1 = await B.sample();
      measure('screen.clean.receiver', rates(q0, q1), 'window');
    }
    await A.stopScreenShare();
    const ssOff = await waitUntil(async () => ((await A.liveCaptures()).some((c) => c.source === 'display') ? null : true), { timeoutMs: 8_000 });
    record('E2E-15', 'screen share stop releases the display capture', ssOff.ok ? 'PASS' : 'FAIL', `${ssOff.ms} ms (started ${tss})`);
  }

  // ── leave / rejoin and repeated cycles ─────────────────────────────────
  const baseline = lab.serverProbe();
  const cycles = [];
  for (let i = 0; i < 5; i++) {
    await B.leaveVoice();
    const gone = await waitSilent(A, [1], both, 8_000);
    const aAfterLeave = await A.sample();
    await sleep(1000);
    const t = await B.joinVoice(room);
    const waitStart = Date.now();
    const back = await waitAudible(A, [1], both, 15_000);
    const backB = await waitAudible(B, [0], both, 15_000);
    const sa = await A.sample(); const sb = await B.sample();
    cycles.push({
      cycle: i + 1,
      leaveSilenceMs: gone.ms,
      aLiveInboundAfterLeave: aAfterLeave.tracks.filter((x) => x.kind === 'audio').length,
      rejoinClickToAudibleAtAMs: back.ok ? waitStart + back.ms - t : null,
      aHearsB: back.ok, bHearsA: backB.ok,
      aAudioTracks: sa.tracks.filter((x) => x.kind === 'audio').length,
      bAudioTracks: sb.tracks.filter((x) => x.kind === 'audio').length,
      aOpenPcs: rtp(sa).pcs, bOpenPcs: rtp(sb).pcs,
    });
  }
  await sleep(6000);
  const after = lab.serverProbe();
  const ok = cycles.every((c) => c.aHearsB && c.bHearsA && c.aAudioTracks === 1 && c.bAudioTracks === 1 && c.aOpenPcs <= 2 && c.bOpenPcs <= 2);
  record('E2E-16', '5 leave/rejoin cycles: audio both ways every cycle, no duplicate tracks or transports', ok ? 'PASS' : 'FAIL', JSON.stringify(cycles));
  const sock = (p) => Object.fromEntries(Object.entries(p).map(([n, v]) => [n, (v.workers || []).map((w) => w.udpSockets)]));
  const grew = Object.keys(after).some((n) => (after[n].workers?.[0]?.udpSockets ?? 0) > (baseline[n].workers?.[0]?.udpSockets ?? 0));
  record('E2E-17', 'worker UDP sockets return to baseline after 5 cycles (no leaked transports)', grew ? 'FAIL' : 'PASS',
    `baseline ${JSON.stringify(sock(baseline))} after ${JSON.stringify(sock(after))}`);
}
