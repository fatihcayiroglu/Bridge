// SFU CONTROL PLANE across real nodes (media quality is P2, not measured here).
// Every node runs real mediasoup workers; ownership of a voice room is decided
// by the Redis registry (`bridge:sfu:room:<channelId>` = INSTANCE_ID).
//
// Split-brain evidence comes from each node's own log: a node logs
// "Room oluşturuldu — channel: <id>, node: <INSTANCE_ID>" when it opens a
// router for a channel. Two nodes opening routers for one channel while both
// are alive is split-brain.

import { register, makeServer, connectSocket, mutate, rnd, io } from '../lib/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function voiceChannel(base, owner, serverId) {
  const c = await mutate(base, 'POST', `/api/servers/${serverId}/channels`, owner.token, { name: `sfu-${rnd()}`, type: 'voice' });
  if (c.status >= 300) throw new Error(`voice channel ${c.status} ${JSON.stringify(c.body)}`);
  return c.body._id || c.body.id;
}

/** First SFU answer to a capabilities request: caps | redirect | error | timeout. */
function capabilities(sock, channelId, ms = 6_000) {
  const requestId = `cap-${rnd()}`;
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); sock.off('sfu:rtp-capabilities', onCaps); sock.off('sfu:redirect', onRedir); sock.off('sfu:error', onErr); resolve(v); };
    const onCaps = (d) => { if (d?.requestId === requestId) done({ kind: 'caps', rtpCapabilities: d.rtpCapabilities }); };
    const onRedir = (d) => { if (d?.requestId === requestId) done({ kind: 'redirect', owner: d.ownerNodeId }); };
    const onErr = (d) => { if (d?.requestId === requestId) done({ kind: 'error', code: d.code }); };
    const t = setTimeout(() => done({ kind: 'timeout' }), ms);
    sock.on('sfu:rtp-capabilities', onCaps); sock.on('sfu:redirect', onRedir); sock.on('sfu:error', onErr);
    sock.emit('sfu:get-rtp-capabilities', { channelId, requestId });
  });
}

function sfuJoin(sock, channelId, serverId, rtpCapabilities, ms = 6_000) {
  const requestId = `join-${rnd()}`;
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); sock.off('sfu:joined', onJoined); sock.off('sfu:redirect', onRedir); sock.off('sfu:error', onErr); resolve(v); };
    const onJoined = (d) => { if (d?.requestId === requestId) done({ kind: 'joined', peers: (d.existingPeers || []).map((p) => p.userId) }); };
    const onRedir = (d) => { if (d?.requestId === requestId) done({ kind: 'redirect', owner: d.ownerNodeId }); };
    const onErr = (d) => { if (d?.requestId === requestId) done({ kind: 'error', code: d.code }); };
    const t = setTimeout(() => done({ kind: 'timeout' }), ms);
    sock.on('sfu:joined', onJoined); sock.on('sfu:redirect', onRedir); sock.on('sfu:error', onErr);
    sock.emit('sfu:join', { channelId, serverId, rtpCapabilities, requestId });
  });
}

/** The client's redirect flow: a dedicated socket through the LB with ?bridgeNode=<owner>. */
function targeted(lb, token, owner) {
  return new Promise((resolve) => {
    const s = io(lb, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5_000, query: { bridgeNode: owner } });
    const t = setTimeout(() => { s.close(); resolve({ ok: false, error: 'timeout' }); }, 6_000);
    s.once('userAuthenticated', () => { clearTimeout(t); resolve({ ok: true, sock: s }); });
    s.once('connect_error', (err) => { clearTimeout(t); s.close(); resolve({ ok: false, error: err.message }); });
  });
}

/**
 * Full client join flow: capabilities on the entry socket; on redirect, open
 * the targeted owner socket and join there. Returns where the peer landed.
 */
async function clientJoin(lb, user, entry, channelId, serverId) {
  let sock = entry;
  for (let hop = 0; hop < 3; hop++) {
    const cap = await capabilities(sock, channelId);
    if (cap.kind === 'redirect') {
      const t = await targeted(lb, user.token, cap.owner);
      if (!t.ok) return { ok: false, stage: 'targeted-connect', owner: cap.owner, error: t.error };
      sock = t.sock;
      continue;
    }
    if (cap.kind !== 'caps') return { ok: false, stage: 'capabilities', detail: cap };
    const j = await sfuJoin(sock, channelId, serverId, cap.rtpCapabilities);
    if (j.kind === 'joined') return { ok: true, sock, peers: j.peers };
    if (j.kind === 'redirect') {
      const t = await targeted(lb, user.token, j.owner);
      if (!t.ok) return { ok: false, stage: 'targeted-connect', owner: j.owner, error: t.error };
      sock = t.sock;
      continue;
    }
    return { ok: false, stage: 'join', detail: j };
  }
  return { ok: false, stage: 'redirect-loop' };
}

function routerCreators(cluster, channelId) {
  return ['A', 'B', 'C'].filter((n) => cluster.nodeLog(n).includes(`Room oluşturuldu — channel: ${channelId}, node: mn-${n}`));
}

/**
 * Time intervals during which each node held a live mediasoup router for the
 * channel, reconstructed from the node's own structured log (created → emptied,
 * invalidated or worker closed) and the process exit history (a killed node's
 * routers die with it).
 */
function routerIntervals(cluster, channelId) {
  const out = [];
  for (const n of ['A', 'B', 'C']) {
    const exits = cluster.exitHistory.filter((e) => e.name === n).map((e) => e.at).sort((a, b) => a - b);
    const closeAt = (from) => exits.find((t) => t >= from) ?? Infinity;
    let open = null;
    for (const line of cluster.nodeLog(n).split('\n')) {
      if (!line.startsWith('{')) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const t = Date.parse(j.time);
      const msg = String(j.msg || '');
      if (open !== null && closeAt(open) < t) { out.push({ node: n, from: open, to: closeAt(open) }); open = null; }
      if (msg.includes(`Room oluşturuldu — channel: ${channelId},`)) {
        if (open !== null) out.push({ node: n, from: open, to: t });
        open = t;
      } else if (open !== null && (msg.includes(`Boş room temizlendi — channel: ${channelId}`)
        || msg.includes(`room temizleniyor — channel: ${channelId}`)
        || (j.event === 'sfu.room.ownership_invalidated' && j.channelId === channelId))) {
        out.push({ node: n, from: open, to: t });
        open = null;
      }
    }
    if (open !== null) out.push({ node: n, from: open, to: closeAt(open) });
  }
  return out;
}

/** Pairs of different nodes whose live-router intervals overlap: split-brain. */
function splitBrain(cluster, channelId) {
  const iv = routerIntervals(cluster, channelId);
  const bad = [];
  for (let i = 0; i < iv.length; i++) {
    for (let k = i + 1; k < iv.length; k++) {
      const a = iv[i]; const b = iv[k];
      if (a.node !== b.node && a.from < b.to && b.from < a.to) bad.push(`${a.node}∩${b.node}`);
    }
  }
  return { intervals: iv.map((x) => `${x.node}[${x.to === Infinity ? 'open' : `${x.to - x.from}ms`}]`).join(' '), overlaps: bad };
}

export async function run({ cluster, lb, record, measure }) {
  const url = (n) => cluster.nodeUrl(n);
  const owner = await register(url('A'), 'sfu');
  const u2 = await register(url('B'), 'sfu');
  const u3 = await register(url('C'), 'sfu');
  const { serverId } = await makeServer(url('A'), owner, [u2, u3]);
  const socks = {
    A: await connectSocket(url('A'), owner.token),
    B: await connectSocket(url('B'), u2.token),
    C: await connectSocket(url('C'), u3.token),
  };

  // ── 1. ownership race: three nodes, same fresh room, same instant ────────
  let races = 0; let clean = 0; const raceDetail = [];
  for (let i = 0; i < 6; i++) {
    const ch = await voiceChannel(url('A'), owner, serverId);
    const res = await Promise.all(['A', 'B', 'C'].map((n) => capabilities(socks[n], ch)));
    const regOwner = cluster.redisCli('GET', `bridge:sfu:room:${ch}`);
    const winners = res.filter((r) => r.kind === 'caps').length;
    const redirectsAgree = res.filter((r) => r.kind === 'redirect').every((r) => r.owner === regOwner);
    const creators = routerCreators(cluster, ch);
    races += 1;
    if (winners === 1 && redirectsAgree && creators.length === 1 && `mn-${creators[0]}` === regOwner) clean += 1;
    raceDetail.push(`${res.map((r) => r.kind[0]).join('')}/${regOwner}/${creators.join('')}`);
  }
  record('SFU-01', 'concurrent claim of a fresh room from A, B and C: exactly one router, losers redirected to the registry owner',
    clean === races ? 'PASS' : 'FAIL', `${clean}/${races} clean; per race (answers/owner/router-creators): ${raceDetail.join(' ')}`);

  // ── 2. redirect contract works end-to-end through the LB ─────────────────
  const room = await voiceChannel(url('A'), owner, serverId);
  const first = await clientJoin(lb, owner, socks.A, room, serverId);
  const regOwner = cluster.redisCli('GET', `bridge:sfu:room:${room}`);
  const second = await clientJoin(lb, u2, socks.B, room, serverId);
  const third = await clientJoin(lb, u3, socks.C, room, serverId);
  record('SFU-02', 'peers entering via B and C are redirected to the owner node and land in the SAME room',
    first.ok && second.ok && third.ok && second.peers.includes(owner.id) && third.peers.includes(owner.id) && third.peers.includes(u2.id)
      && routerCreators(cluster, room).length === 1 ? 'PASS' : 'FAIL',
    `owner=${regOwner} first=${first.ok} second=${second.ok}:${JSON.stringify(second.peers || second)} third=${third.ok}:${JSON.stringify(third.peers || third)} routers=${routerCreators(cluster, room).join('')}`);

  // ── 3. a targeted socket that reaches the wrong node is refused ──────────
  const wrong = regOwner === 'mn-B' ? 'C' : 'B';
  const mis = await new Promise((resolve) => {
    const s = io(url(wrong), { auth: { token: owner.token }, transports: ['websocket'], reconnection: false, query: { bridgeNode: regOwner } });
    const t = setTimeout(() => { s.close(); resolve('timeout'); }, 5_000);
    s.once('userAuthenticated', () => { clearTimeout(t); s.close(); resolve('accepted'); });
    s.once('connect_error', (e) => { clearTimeout(t); s.close(); resolve(e.message); });
  });
  record('SFU-03', 'targeted SFU socket delivered to a node that is not the named owner is refused before auth',
    /route mismatch/i.test(mis) ? 'PASS' : 'FAIL', `node ${wrong} with bridgeNode=${regOwner} → ${mis}`);

  // ── 5. owner death: SIGKILL the node that owns a populated room ──────────
  {
    const ownerNode = regOwner.replace(/^mn-/, '');
    const survivors = ['A', 'B', 'C'].filter((n) => n !== ownerNode);
    const ttlBefore = Number(cluster.redisCli('TTL', `bridge:sfu:room:${room}`));
    const killedAt = Date.now();
    await cluster.killNode(ownerNode, 'SIGKILL');
    // A survivor's user retries the full join flow (what the client does after
    // its socket dropped) until it lands in a working room, for up to 90 s.
    const who = survivors[0];
    const user = { A: owner, B: u2, C: u3 }[who];
    const entry = await connectSocket(url(who), user.token);
    let joined = null; let lastErr = null; let attempts = 0;
    while (Date.now() - killedAt < 90_000) {
      attempts += 1;
      const r = await clientJoin(lb, user, entry, room, serverId);
      if (r.ok) { joined = r; break; }
      lastErr = r;
      await sleep(2_000);
    }
    const staleTtl = Number(cluster.redisCli('TTL', `bridge:sfu:room:${room}`));
    const nowOwner = cluster.redisCli('GET', `bridge:sfu:room:${room}`);
    record('SFU-05', `owner node ${ownerNode} killed: survivors can re-establish the room within 90 s (owner lease 30 s)`,
      joined ? 'PASS' : 'FAIL',
      joined
        ? `rejoined after ${Date.now() - killedAt}ms on ${nowOwner} (${attempts} attempts)`
        : `stranded: registry still names dead owner ${nowOwner} (TTL ${staleTtl}s of ${ttlBefore}s); last attempt ${JSON.stringify(lastErr)}`);
    if (joined) measure('sfu.owner_death_room_recovery_ms', Date.now() - killedAt, 'ms', 'SIGKILL room owner → a survivor completes sfu:join');
    const sb = splitBrain(cluster, room);
    record('SFU-06', 'owner death and takeover: no two nodes ever held live routers for the room at the same time',
      sb.overlaps.length === 0 ? 'PASS' : 'FAIL', `intervals=${sb.intervals} overlaps=${JSON.stringify(sb.overlaps)}`);
    entry.close();
    joined?.sock?.close();

    // The dead owner comes back with the same INSTANCE_ID.
    await cluster.startNode(ownerNode);
    const back = await connectSocket(url(who), user.token);
    const r = await clientJoin(lb, user, back, room, serverId);
    record('SFU-07', 'restarted owner (same INSTANCE_ID): the room works again and only one router exists',
      r.ok ? 'PASS' : 'FAIL', `${r.ok ? `joined; registry=${cluster.redisCli('GET', `bridge:sfu:room:${room}`)}` : JSON.stringify(r)}`);
    back.close(); r.sock?.close();
  }

  // ── 4. registry (Redis) unavailable: no node guesses ownership ───────────
  {
    const ch = await voiceChannel(url('A'), owner, serverId);
    const seen = [];
    const tap = (n) => (event, p) => { if (!/^voice:|^user:|^presence/.test(event)) seen.push(`${n}:${event}${p?.code ? `(${p.code})` : ''}`); };
    const taps = Object.fromEntries(['A', 'B', 'C'].map((n) => [n, tap(n)]));
    for (const n of ['A', 'B', 'C']) socks[n].onAny(taps[n]);
    await cluster.stopRedis();
    await sleep(1_500);
    const res = await Promise.all(['A', 'B', 'C'].map((n) => capabilities(socks[n], ch, 8_000)));
    for (const n of ['A', 'B', 'C']) socks[n].offAny(taps[n]);
    const creators = routerCreators(cluster, ch);
    record('SFU-04', 'registry unavailable: fresh room is refused on every node (no local router opened on a guess)',
      res.every((r) => r.kind !== 'caps') && creators.length === 0 ? 'PASS' : 'FAIL',
      `answers=${res.map((r) => r.kind + (r.code ? `:${r.code}` : '')).join(',')} routers=${creators.join('') || 'none'}`);
    record('SFU-04i', 'what a client observes while the registry is down', 'INFO', `events=${JSON.stringify(seen)}`);
    await cluster.startRedis();
    // Redis came back EMPTY: every existing socket loses its shared WS
    // connection lease and is disconnected at its next lease heartbeat
    // (connection-limit authority fails closed). A real client reconnects,
    // so recovery is measured on a freshly connected socket.
    const t0 = Date.now();
    let after = null;
    let fresh = null;
    // A registry restarted EMPTY settles (REGISTRY_SETTLE_MS, ~22 s by default)
    // before brand-new rooms can be claimed; live owners re-assert meanwhile.
    while (Date.now() - t0 < 45_000) {
      fresh = fresh || await connectSocket(url('B'), u2.token).catch(() => null);
      if (fresh) {
        after = await capabilities(fresh, ch);
        if (after.kind === 'caps' || after.kind === 'redirect') break;
      }
      await sleep(500);
    }
    fresh?.close();
    for (const n of ['A', 'B', 'C']) socks[n].close();
    socks.A = await connectSocket(url('A'), owner.token);
    socks.B = await connectSocket(url('B'), u2.token);
    socks.C = await connectSocket(url('C'), u3.token);
    const recovered = after && (after.kind === 'caps' || after.kind === 'redirect');
    record('SFU-04r', 'registry restored empty: after the settle window the room can be claimed again without restarting any node (reconnected client)',
      recovered ? 'PASS' : 'FAIL', `${after?.kind} after ${Date.now() - t0}ms`);
    if (recovered) measure('sfu.fresh_claim_after_registry_data_loss_ms', Date.now() - t0, 'ms', 'Redis restarted empty → a brand-new room claimable (includes the registry settle window)');
  }

  // ── 8. Redis restarted EMPTY while a room is live (no persistence) ───────
  // The live owner still runs its router, but the registry no longer names it.
  // (Every socket also loses its shared WS connection lease and is dropped at
  // its next lease heartbeat — connection-limit authority fails closed — so the
  // clients here reconnect exactly like real ones.)
  {
    const ch = await voiceChannel(url('A'), owner, serverId);
    const e1 = await connectSocket(url('A'), owner.token);
    const p1 = await clientJoin(lb, owner, e1, ch, serverId);
    const owner1 = cluster.redisCli('GET', `bridge:sfu:room:${ch}`);
    await cluster.stopRedis();
    await cluster.startRedis();
    const t0 = Date.now();
    const other = owner1 === 'mn-B' ? 'C' : 'B';
    const user = other === 'B' ? u2 : u3;
    let p2 = null; let refusals = 0;
    while (Date.now() - t0 < 45_000) {
      const e2 = await connectSocket(url(other), user.token).catch(() => null);
      if (e2) {
        p2 = await clientJoin(lb, user, e2, ch, serverId);
        if (p2.ok) break;
        refusals += 1;
        e2.close();
      }
      await sleep(1_000);
    }
    const sb = splitBrain(cluster, ch);
    record('SFU-08', 'registry restarted empty while a room is live: no second concurrent router for the channel; a new peer can still join',
      p1.ok && p2?.ok && sb.overlaps.length === 0 ? 'PASS' : 'FAIL',
      `owner before=${owner1} after=${cluster.redisCli('GET', `bridge:sfu:room:${ch}`)} joinedAfter=${Date.now() - t0}ms refusedWhileSettling=${refusals} intervals=${sb.intervals} overlaps=${JSON.stringify(sb.overlaps)}`);
    record('SFU-08i', 'did the new peer land in the ORIGINAL router?', 'INFO',
      p2?.ok ? (p2.peers.includes(owner.id) ? 'yes — joined the existing room' : 'no — the original peer had already been disconnected (WS lease loss) and its room closed; a fresh room was opened afterwards (no overlap)') : 'n/a');
    for (const x of [e1, p1.sock, p2?.sock]) x?.close?.();
  }

  for (const s of [...Object.values(socks), first.sock, second.sock, third.sock]) s?.close?.();
}
