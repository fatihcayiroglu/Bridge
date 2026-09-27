// scripts/medialab/scenarios/authz.mjs
//
// Media authorization DURING an active call, across nodes: the server owner
// (A, pinned to node A, room owner) and a member (B, pinned to node B, SFU
// signaling redirected to node A). Each revocation is applied through the
// public API at t0; the evidence is what each browser still DECODES.
//   kick / ban / timeout / VIEW or CONNECT revoked: no media either way
//   SPEAK revoked: B may still listen, but must no longer be heard
//   logout-all: B's sessions end; no media either way
// A 45 s observation window checks that nothing (including client-side
// session recovery) resurrects revoked media.

import { mutate, request } from '../../multinode/lib/client.mjs';
import { sleep, waitAudible, waitSilent, waitUntil } from '../lib/util.mjs';
import { audibleSenders } from '../lib/analysis.mjs';

const both = [0, 1];
const VIEW = 1 << 0;
const CONNECT = 1 << 16;
const SPEAK = 1 << 17;

async function call(lab, tag) {
  const [ua, ub] = await lab.users(2, tag);
  const room = await lab.voiceRoom(ua, [ub]);
  const A = await lab.client(0, ua, { node: 'A' });
  const B = await lab.client(1, ub, { node: 'B' });
  await A.joinVoice(room);
  await sleep(1500);
  await B.joinVoice(room);
  const ok = (await waitAudible(B, [0], both, 15_000)).ok && (await waitAudible(A, [1], both, 15_000)).ok;
  return { A, B, ua, ub, room, ok };
}

async function reset(lab) {
  for (const c of [...lab.clients]) await lab.closeClient(c);
  lab.net.down();
  lab.net.up();
  lab.proxy.setMode('round-robin');
}

/** Does `receiver` decode `sender` at any point during `ms`? */
async function heardDuring(receiver, sender, ms) {
  const r = await waitUntil(async () => (audibleSenders(await receiver.sample(), both).includes(sender) ? true : null), { timeoutMs: ms, intervalMs: 500 });
  return r.ok;
}

const CASES = [
  {
    id: 'AZ-01', label: 'kicked mid-call', bIsHeard: false, bHears: false,
    act: (lab, { ua, ub, room }) => mutate(lab.baseUrl, 'POST', `/api/servers/${room.serverId}/members/${ub.id}/kick`, ua.token, { reason: 'medialab' }),
  },
  {
    id: 'AZ-02', label: 'banned mid-call', bIsHeard: false, bHears: false,
    act: (lab, { ua, ub, room }) => mutate(lab.baseUrl, 'POST', `/api/servers/${room.serverId}/bans`, ua.token, { userId: ub.id, reason: 'medialab' }),
  },
  {
    id: 'AZ-03', label: 'channel VIEW revoked mid-call', bIsHeard: false, bHears: false,
    act: (lab, { ua, room }) => mutate(lab.baseUrl, 'PUT', `/api/servers/${room.serverId}/channels/${room.channelId}/permissions/__everyone__`, ua.token, { allow: 0, deny: VIEW }),
  },
  {
    id: 'AZ-04', label: 'channel CONNECT revoked mid-call (VIEW kept)', bIsHeard: false, bHears: false,
    act: (lab, { ua, room }) => mutate(lab.baseUrl, 'PUT', `/api/servers/${room.serverId}/channels/${room.channelId}/permissions/__everyone__`, ua.token, { allow: 0, deny: CONNECT }),
  },
  {
    id: 'AZ-05', label: 'channel SPEAK revoked mid-call (may listen, must not be heard)', bIsHeard: false, bHears: true,
    act: (lab, { ua, room }) => mutate(lab.baseUrl, 'PUT', `/api/servers/${room.serverId}/channels/${room.channelId}/permissions/__everyone__`, ua.token, { allow: 0, deny: SPEAK }),
  },
  {
    id: 'AZ-06', label: 'member timed out mid-call', bIsHeard: false, bHears: false,
    act: (lab, { ua, ub, room }) => mutate(lab.baseUrl, 'POST', `/api/servers/${room.serverId}/members/${ub.id}/timeout`, ua.token, { durationMs: 600_000, reason: 'medialab' }),
  },
  {
    id: 'AZ-07', label: 'logout-all (token revocation) mid-call', bIsHeard: false, bHears: false,
    act: (lab, { ub }) => mutate(lab.baseUrl, 'POST', '/api/logout-all', ub.token, {}),
  },
];

export async function run({ lab, record, measure }) {
  for (const c of CASES) {
    const ctx = await call(lab, c.id.toLowerCase().replace('-', ''));
    if (!ctx.ok) { record(c.id, c.label, 'BLOCKED', 'no two-way media before the revocation'); await reset(lab); continue; }
    const t0 = Date.now();
    const res = await c.act(lab, ctx);
    if (res.status >= 300) { record(c.id, c.label, 'BLOCKED', `revocation API returned ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`); await reset(lab); continue; }

    const aStops = await waitSilent(ctx.A, [1], both, 15_000);
    const bStops = c.bHears ? null : await waitSilent(ctx.B, [0], both, 15_000);
    const stopMs = Date.now() - t0;
    // Anything decoded again during 45 s would be a resurrection.
    const aHeardAgain = await heardDuring(ctx.A, 1, 45_000);
    const bHearsLater = await heardDuring(ctx.B, 0, 3_000);
    const uiB = await ctx.B.uiState();
    const bConsole = ctx.B.console.filter((m) => m.t >= t0).map((m) => m.text.slice(0, 140)).slice(-4);
    const bIsHeardOk = !aHeardAgain && aStops.ok;
    const bHearsOk = c.bHears ? true : (bStops.ok && !bHearsLater);
    record(c.id, `${c.label}: ${c.bHears ? 'B no longer heard' : 'no media in either direction'}; nothing resurrects it`,
      bIsHeardOk && bHearsOk ? 'PASS' : 'FAIL',
      `A stopped hearing B: ${aStops.ok ? `${aStops.ms} ms` : 'NO'}; B stopped hearing A: ${c.bHears ? 'n/a (listening allowed)' : (bStops.ok ? `${bStops.ms} ms` : 'NO')}; A heard B again within 45 s: ${aHeardAgain}; B hears A at the end: ${bHearsLater}; B UI ${JSON.stringify(uiB)}; B console ${JSON.stringify(bConsole)}`);
    if (c.bHears) {
      record(`${c.id}-listen`, `${c.label}: B keeps listening (receive not revoked)`, 'INFO', `B hears A at the end: ${bHearsLater}`);
    }
    measure(`revoke.${c.id}`, { stopMs, aStopsMs: aStops.ok ? aStops.ms : null, bStopsMs: bStops?.ok ? bStops.ms : null }, 'ms');
    await reset(lab);
  }
}
