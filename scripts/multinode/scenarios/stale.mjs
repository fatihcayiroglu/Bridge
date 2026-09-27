// Stale per-node socket state after authorization changes made on ANOTHER node.
// Each check is run twice: with the revoking request on the SAME node as the
// target's socket (single-node behaviour) and on a DIFFERENT node. A result
// that differs between the two is a distributed-state bug.

import { register, makeServer, connectSocket, collect, nextEvent, sendMessage, mutate, rnd } from '../lib/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function voiceChannel(base, owner, serverId) {
  const c = await mutate(base, 'POST', `/api/servers/${serverId}/channels`, owner.token, { name: `v-${rnd()}`, type: 'voice' });
  if (c.status >= 300) throw new Error(`voice channel ${c.status} ${JSON.stringify(c.body)}`);
  return c.body._id || c.body.id;
}

function joinVoice(sock, channelId, serverId) {
  const joined = nextEvent(sock, 'voice:joined', (p) => p?.channelId === channelId, 5_000);
  sock.emit('voice:join', { channelId, serverId, requestId: rnd() });
  return joined;
}

export async function run({ cluster, record }) {
  const url = (n) => cluster.nodeUrl(n);

  for (const [label, kickVia] of [['same-node', 'B'], ['cross-node', 'C']]) {
    const owner = await register(url('A'), 'st');
    const member = await register(url('B'), 'st');
    const { serverId, channelId } = await makeServer(url('A'), owner, [member]);
    const vc = await voiceChannel(url('A'), owner, serverId);
    const ownerSock = await connectSocket(url('A'), owner.token);
    const memberSock = await connectSocket(url('B'), member.token);
    ownerSock.emit('channel:join', channelId);
    memberSock.emit('channel:join', channelId);
    await sleep(400);
    const oj = await joinVoice(ownerSock, vc, serverId);
    const mj = await joinVoice(memberSock, vc, serverId);

    // Positive control before the kick.
    const pre = `pre-${rnd()}`;
    const preSeen = collect(memberSock, 'message:new', (m) => m?.content === pre, 1_500);
    await sendMessage(ownerSock, { channelId, serverId, content: pre, ackId: `p-${rnd()}` });
    const preOk = (await preSeen).length === 1 && Boolean(oj) && Boolean(mj);

    const revoked = nextEvent(memberSock, 'membership:revoked', (p) => p?.serverId === serverId, 5_000);
    const k = await mutate(url(kickVia), 'POST', `/api/servers/${serverId}/members/${member.id}/kick`, owner.token, {});
    const rv = await revoked;

    // 1. text channel traffic
    const post = `post-${rnd()}`;
    const postSeen = collect(memberSock, 'message:new', (m) => m?.content === post, 1_500);
    await sendMessage(ownerSock, { channelId, serverId, content: post, ackId: `q-${rnd()}` });
    memberSock.emit('channel:join', channelId); // re-join attempt must be refused
    await sleep(300);
    const post2 = `post2-${rnd()}`;
    const post2Seen = collect(memberSock, 'message:new', (m) => m?.content === post2, 1_500);
    await sendMessage(ownerSock, { channelId, serverId, content: post2, ackId: `r-${rnd()}` });
    const textLeak = (await postSeen).length + (await post2Seen).length;
    record(`STALE-01-${label}`, `kick via ${kickVia} (member socket on B): no channel traffic after kick, re-join refused`,
      preOk && k.status === 200 && rv && textLeak === 0 ? 'PASS' : 'FAIL',
      `control=${preOk} kick=${k.status} revokedEvent=${!!rv} leaked=${textLeak}`);

    // 2. voice control plane: the kicked socket must not keep acting in the room
    const stateSeen = collect(ownerSock, 'voice:peer-state', (p) => p?.userId === member.id, 1_500);
    const actSeen = collect(ownerSock, 'voice:activity', (p) => p?.userId === member.id, 1_500);
    const offerSeen = collect(ownerSock, 'webrtc:offer', (p) => p?.fromSocketId === memberSock.id, 1_500);
    memberSock.emit('voice:state-update', { channelId: vc, muted: false, deafened: false, screensharing: true, video: true });
    memberSock.emit('voice:activity', { channelId: vc, speaking: true });
    memberSock.emit('webrtc:offer', { targetSocketId: ownerSock.id, offer: { type: 'offer', sdp: 'v=0' }, channelId: vc });
    const [st, act, off] = await Promise.all([stateSeen, actSeen, offerSeen]);
    record(`STALE-02-${label}`, `kick via ${kickVia}: kicked socket cannot inject voice state/activity/WebRTC offers into the room`,
      st.length + act.length + off.length === 0 ? 'PASS' : 'FAIL',
      `peer-state=${st.length} activity=${act.length} webrtc-offer=${off.length}`);

    // 3. voice roster: the kicked user must not remain a peer
    const roster = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3_000);
      ownerSock.once('voice:existing-peers', (peers) => { clearTimeout(t); resolve(peers); });
      ownerSock.emit('voice:join', { channelId: vc, serverId, requestId: rnd() });
    });
    const ghost = Array.isArray(roster) && roster.some((p) => p.userId === member.id);
    record(`STALE-03-${label}`, `kick via ${kickVia}: kicked user no longer listed as a voice peer`,
      roster && !ghost ? 'PASS' : 'FAIL', `roster=${JSON.stringify((roster || []).map((p) => p.userId === member.id ? 'KICKED-USER' : 'other'))}`);

    ownerSock.close();
    memberSock.close();
  }

  // 4. permission revocation (deny VIEW_CHANNELS to @everyone) on another node
  for (const [label, via] of [['same-node', 'B'], ['cross-node', 'C']]) {
    const owner = await register(url('A'), 'sp');
    const member = await register(url('B'), 'sp');
    const { serverId, channelId } = await makeServer(url('A'), owner, [member]);
    const ownerSock = await connectSocket(url('A'), owner.token);
    const memberSock = await connectSocket(url('B'), member.token);
    ownerSock.emit('channel:join', channelId);
    memberSock.emit('channel:join', channelId);
    await sleep(400);
    const deny = await mutate(url(via), 'PUT', `/api/servers/${serverId}/channels/${channelId}/permissions/__everyone__`, owner.token, { allow: 0, deny: 1 });
    await sleep(300);
    const c = `perm-${rnd()}`;
    const seen = collect(memberSock, 'message:new', (m) => m?.content === c, 1_500);
    await sendMessage(ownerSock, { channelId, serverId, content: c, ackId: `s-${rnd()}` });
    const leak = (await seen).length;
    record(`STALE-04-${label}`, `VIEW_CHANNELS denied via ${via} (member socket on B): no further channel traffic`,
      deny.status === 200 && leak === 0 ? 'PASS' : 'FAIL', `deny=${deny.status} leaked=${leak}`);
    ownerSock.close();
    memberSock.close();
  }

  // 5. voice-channel access revoked on another node while the member is in voice
  for (const [label, via] of [['same-node', 'B'], ['cross-node', 'C']]) {
    const owner = await register(url('A'), 'sv');
    const member = await register(url('B'), 'sv');
    const { serverId } = await makeServer(url('A'), owner, [member]);
    const vc = await voiceChannel(url('A'), owner, serverId);
    const ownerSock = await connectSocket(url('A'), owner.token);
    const memberSock = await connectSocket(url('B'), member.token);
    await joinVoice(ownerSock, vc, serverId);
    const mj = await joinVoice(memberSock, vc, serverId);
    const left = nextEvent(ownerSock, 'voice:peer-left', (p) => p?.userId === member.id, 5_000);
    const deny = await mutate(url(via), 'PUT', `/api/servers/${serverId}/channels/${vc}/permissions/__everyone__`, owner.token, { allow: 0, deny: 1 });
    const peerLeft = await left;
    const stateSeen = collect(ownerSock, 'voice:peer-state', (p) => p?.userId === member.id, 1_500);
    memberSock.emit('voice:state-update', { channelId: vc, muted: false, deafened: false, screensharing: true, video: true });
    const roster = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3_000);
      ownerSock.once('voice:existing-peers', (peers) => { clearTimeout(t); resolve(peers); });
      ownerSock.emit('voice:join', { channelId: vc, serverId, requestId: rnd() });
    });
    const ghost = Array.isArray(roster) && roster.some((p) => p.userId === member.id);
    const injected = (await stateSeen).length;
    record(`STALE-05-${label}`, `voice channel VIEW denied via ${via} (member in voice on B): member leaves the roster, peers told, no further injection`,
      mj && deny.status === 200 && peerLeft && roster && !ghost && injected === 0 ? 'PASS' : 'FAIL',
      `joined=${Boolean(mj)} deny=${deny.status} peerLeftEvent=${Boolean(peerLeft)} ghost=${ghost} injectedState=${injected}`);
    ownerSock.close();
    memberSock.close();
  }
}
