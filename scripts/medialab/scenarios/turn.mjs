// scripts/medialab/scenarios/turn.mjs
//
// TURN-relayed media with real coturn. The client networks are firewalled so
// the SFU's media ports are unreachable directly (nftables drop on the lab
// links): media can only flow through TURN, and the selected ICE candidate
// pair must be a `relay` candidate. The product flag FORCE_TURN=true makes
// the server hand clients iceTransportPolicy 'relay'.

import { rtp, rates } from '../lib/analysis.mjs';
import { sleep, waitUntil, waitAudible, waitSilent, paths } from '../lib/util.mjs';

const both = [0, 1];

function relayOnly(sample) {
  const pairs = rtp(sample).pairs;
  return pairs.length > 0 && pairs.every((p) => p.local?.type === 'relay');
}

async function pair(lab, prefix) {
  const [ua, ub] = await lab.users(2, prefix);
  const room = await lab.voiceRoom(ua, [ub]);
  const A = await lab.client(0, ua);
  const B = await lab.client(1, ub);
  await A.joinVoice(room);
  await sleep(1000);
  await B.joinVoice(room);
  return { A, B, room };
}

async function transportConfig(c) {
  const ev = await c.events(c.joinedAt);
  return ev.filter((e) => e.ev === 'created').map((e) => e.cfg);
}

async function closeAll(lab) {
  for (const c of [...lab.clients]) await lab.closeClient(c);
  lab.net.down();
  lab.net.up();
}

export async function run({ lab, record, measure }) {
  await lab.restartNodes({ FORCE_TURN: 'true' });
  await lab.settle();

  // ── relay-only: audio, video, screen through coturn ─────────────────────
  lab.net.blockDirectSfu(true);
  {
    const { A, B } = await pair(lab, 'turn');
    const ab = await waitAudible(B, [0], both, 20_000);
    const ba = await waitAudible(A, [1], both, 20_000);
    const sa = await A.sample(); const sb = await B.sample();
    const cfg = await transportConfig(A);
    record('TURN-01', 'relay-only network: two-way audio through TURN', ab.ok && ba.ok ? 'PASS' : 'FAIL',
      `A→B ${ab.ok ? `${ab.ms} ms` : 'NO'}; B→A ${ba.ok ? `${ba.ms} ms` : 'NO'}; A paths ${paths(sa).join(', ') || 'none'}; B paths ${paths(sb).join(', ') || 'none'}; A transport PC config ${JSON.stringify(cfg)}`);
    record('TURN-02', 'selected candidate pair is a TURN relay on every live transport', relayOnly(sa) && relayOnly(sb) ? 'PASS' : 'FAIL',
      `A ${paths(sa).join(', ') || 'none'}; B ${paths(sb).join(', ') || 'none'}`);
    measure('coturn.afterJoin', lab.turn.logSummary(), 'log counts');
    if (ab.ok && ba.ok) {
      const t0a = await A.sample(); await sleep(10_000); const t1a = await A.sample();
      measure('audio.relay.A', rates(t0a, t1a), 'window');
      await A.toggleVideo();
      const vid = await waitUntil(async () => ((await B.sample()).tracks.some((t) => t.kind === 'video' && t.w > 0) ? true : null), { timeoutMs: 20_000 });
      record('TURN-03', 'relay-only: camera A→B decodes', vid.ok ? 'PASS' : 'FAIL', `${vid.ms} ms`);
      if (vid.ok) {
        const v0 = await B.sample(); await sleep(10_000); const v1 = await B.sample();
        measure('video.relay.receiver', rates(v0, v1), 'window');
      }
      await A.toggleVideo();
      await B.startScreenShare();
      const ss = await waitUntil(async () => ((await A.sample()).tracks.some((t) => t.kind === 'video' && t.w > 0) ? true : null), { timeoutMs: 20_000 });
      record('TURN-04', 'relay-only: screen share B→A decodes', ss.ok ? 'PASS' : 'FAIL', `${ss.ms} ms`);
      await B.stopScreenShare();

      // Reconnect through TURN: leave and rejoin.
      await B.leaveVoice();
      await waitSilent(A, [1], both, 8_000);
      const t = await B.joinVoice(B.room);
      const back = await waitAudible(A, [1], both, 20_000);
      const backB = await waitAudible(B, [0], both, 20_000);
      record('TURN-05', 'relay-only: leave + rejoin restores two-way audio through TURN', back.ok && backB.ok && relayOnly(await B.sample()) ? 'PASS' : 'FAIL',
        `rejoin→audible at A ${back.ok ? Date.now() - t : 'NO'} ms; B hears A ${backB.ok}`);

      // TURN server dies mid-call (allocations are lost with it).
      const tKill = Date.now();
      lab.turn.stop('SIGKILL');
      const dead = await waitSilent(B, [0], both, 20_000);
      record('TURN-06', 'TURN killed mid-call: relayed media stops', dead.ok ? 'INFO' : 'FAIL', `silent after ${dead.ms} ms`);
      await sleep(3000);
      await lab.turn.start();
      const tUp = Date.now();
      const rec = await waitAudible(B, [0], both, 45_000);
      const sb2 = await B.sample();
      record('TURN-07', 'TURN restarted: relayed call recovers without user action', rec.ok ? 'PASS' : 'FAIL',
        rec.ok ? `audible ${Date.now() - tUp} ms after TURN came back (outage ${tUp - tKill} ms)`
          : `no audio 45 s after TURN restart; B transports ${JSON.stringify(rtp(sb2).pairs.map((p) => ({ ice: p.ice, dtls: p.dtls, state: p.state })))}; UI ${JSON.stringify(await B.uiState())}`);
      const ui = await B.uiState();
      record('TURN-08', 'dead relayed call is visible to the user (UI does not claim a healthy call)', 'INFO', `UI after outage: ${JSON.stringify(ui)}; console ${JSON.stringify(B.console.slice(-3).map((m) => m.text.slice(0, 120)))}`);
    }
    await closeAll(lab);
  }

  // ── TURN over TCP only (UDP to the TURN server blocked) ─────────────────
  lab.net.blockDirectSfu(true);
  lab.net.blockTurnUdp(true);
  {
    const { A, B } = await pair(lab, 'turntcp');
    const ab = await waitAudible(B, [0], both, 25_000);
    const ba = await waitAudible(A, [1], both, 25_000);
    const sb = await B.sample();
    const tcp = rtp(sb).pairs.every((p) => p.local?.type === 'relay' && p.local?.relayProtocol === 'tcp');
    record('TURN-09', 'UDP blocked: two-way audio via TURN over TCP', ab.ok && ba.ok && tcp ? 'PASS' : 'FAIL', `B paths ${paths(sb).join(', ') || 'none'}`);
    if (ab.ok) {
      const x0 = await B.sample(); await sleep(10_000); const x1 = await B.sample();
      measure('audio.relayTcp.B', rates(x0, x1), 'window');
    }
    await closeAll(lab);
  }
  lab.net.blockTurnUdp(false);

  // ── invalid credentials (Bridge signs with a secret coturn does not know) ─
  await lab.restartNodes({ FORCE_TURN: 'true', TURN_SECRET: `wrong-${lab.turn.secret}` });
  await lab.settle();
  lab.net.blockDirectSfu(true);
  {
    const { A, B } = await pair(lab, 'turnbad');
    const ab = await waitAudible(B, [0], both, 15_000);
    const sb = await B.sample();
    record('TURN-10', 'invalid TURN credentials on a relay-only network: no media (no bypass)', ab.ok ? 'FAIL' : 'PASS',
      `B heard A: ${ab.ok}; B transports ${JSON.stringify(rtp(sb).pairs.map((p) => p.local?.type))}; coturn ${JSON.stringify(lab.turn.logSummary())}`);
    const ui = await B.uiState();
    record('TURN-11', 'invalid TURN credentials: what the user sees', 'INFO', `UI ${JSON.stringify(ui)}; console ${JSON.stringify(B.console.slice(-3).map((m) => m.text.slice(0, 160)))}`);
    await closeAll(lab);
  }

  // ── expired credentials (coturn clock 25 h ahead of the 24 h TTL) ────────
  await lab.restartNodes({ FORCE_TURN: 'true', TURN_SECRET: lab.turn.secret });
  await lab.settle();
  lab.turn.stop('SIGKILL');
  await lab.turn.start({ faketime: '+25h' });
  lab.net.blockDirectSfu(true);
  {
    const { A, B } = await pair(lab, 'turnexp');
    const ab = await waitAudible(B, [0], both, 15_000);
    record('TURN-12', 'expired TURN credentials are rejected (no relayed media)', ab.ok ? 'FAIL' : 'PASS',
      `B heard A: ${ab.ok}; coturn ${JSON.stringify(lab.turn.logSummary())}`);
    await closeAll(lab);
  }
  lab.turn.stop('SIGKILL');
  await lab.turn.start();

  // ── TURN unavailable at join, then recovers ─────────────────────────────
  lab.net.blockDirectSfu(true);
  lab.net.blockTurn(true);
  {
    const { A, B } = await pair(lab, 'turndown');
    const ab = await waitAudible(B, [0], both, 12_000);
    record('TURN-13', 'TURN unreachable at join on a relay-only network: no media', ab.ok ? 'FAIL' : 'PASS', `B heard A: ${ab.ok}`);
    lab.net.blockTurn(false);
    const tUp = Date.now();
    const rec = await waitAudible(B, [0], both, 40_000);
    record('TURN-14', 'TURN reachable again: call recovers without rejoin', rec.ok ? 'PASS' : 'FAIL',
      rec.ok ? `${Date.now() - tUp} ms` : `still silent 40 s later; B ICE ${JSON.stringify(rtp(await B.sample()).pairs.map((p) => p.ice))}; UI ${JSON.stringify(await B.uiState())}`);
    await closeAll(lab);
  }

  lab.net.blockDirectSfu(false);
  await lab.restartNodes({ FORCE_TURN: 'false' });
  await lab.settle();
  measure('coturn.final', lab.turn.logSummary(), 'log counts');
}
