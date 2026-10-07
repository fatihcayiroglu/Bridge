#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Cluster, sleep } from '../multinode/lib/cluster.mjs';
import { RoutingProxy } from '../multinode/lib/proxy.mjs';
import {
  connectSocket, fakeIp, makeServer, mutate, register, rnd,
} from '../multinode/lib/client.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const work = opt('work', undefined);
const outDir = opt('out', undefined);
const gate = flag('gate');
const cluster = new Cluster({ nodes: ['A', 'B'], workDir: work });
const reportDir = outDir || path.join(cluster.workDir, 'abuse-report');
fs.mkdirSync(reportDir, { recursive: true });

const results = [];
const measurements = {};
const sockets = [];
let proxy;
let crashed = null;

function classifyAttack(accepted, attempted) {
  if (attempted <= 0) return 'INVALID';
  if (accepted === 0) return 'BLOCKED';
  if (accepted < attempted) return 'LIMITED';
  return 'OPEN';
}

function record(id, kind, name, data) {
  const row = { id, kind, name, ...data };
  results.push(row);
  console.log(`[${kind}] ${id} ${name}: ${JSON.stringify(data)}`);
  return row;
}

function measure(key, value, unit, note) {
  measurements[key] = { value, unit, ...(note ? { note } : {}) };
  console.log(`[MEASURE] ${key}=${value} ${unit}${note ? ` (${note})` : ''}`);
}

function procRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function clusterRssKb() {
  let total = 0;
  let seen = 0;
  for (const node of cluster.nodes.values()) {
    const rss = node?.proc?.pid ? procRssKb(node.proc.pid) : null;
    if (rss !== null) { total += rss; seen += 1; }
  }
  return seen ? total : null;
}

function captureSocket(socket, names) {
  const events = [];
  const handlers = [];
  for (const name of names) {
    const handler = (payload) => events.push({ name, payload, at: Date.now() });
    socket.on(name, handler);
    handlers.push([name, handler]);
  }
  return {
    events,
    stop() { for (const [name, handler] of handlers) socket.off(name, handler); },
  };
}

async function channelBatch(socket, ctx, messages, { spacingMs = 0 } = {}) {
  const cap = captureSocket(socket, ['message:ack', 'error:spam', 'error:ratelimit', 'error:message', 'warn:spam']);
  const startedAt = Date.now();
  const ackIds = [];
  for (let i = 0; i < messages.length; i += 1) {
    const ackId = `ab-${Date.now().toString(36)}-${i}-${rnd()}`;
    ackIds.push(ackId);
    socket.emit('message:send', {
      channelId: ctx.channelId,
      serverId: ctx.serverId,
      content: messages[i],
      ackId,
    });
    if (spacingMs) await sleep(spacingMs);
  }
  await sleep(2_500);
  cap.stop();
  const ackSet = new Set(cap.events.filter(e => e.name === 'message:ack').map(e => e.payload?.ackId));
  return {
    attempted: messages.length,
    accepted: ackIds.filter(id => ackSet.has(id)).length,
    spamRejected: cap.events.filter(e => e.name === 'error:spam').length,
    socketRejected: cap.events.filter(e => e.name === 'error:ratelimit').length,
    genericRejected: cap.events.filter(e => e.name === 'error:message').length,
    warnings: cap.events.filter(e => e.name === 'warn:spam').length,
    durationMs: Date.now() - startedAt,
  };
}

async function dmBatch(socket, targets, { spacingMs = 0 } = {}) {
  const cap = captureSocket(socket, ['dm:message', 'error:dm_rate', 'error:ratelimit', 'error:message', 'error:dm_privacy']);
  const nonces = [];
  const startedAt = Date.now();
  for (let i = 0; i < targets.length; i += 1) {
    const clientNonce = `dm-${Date.now().toString(36)}-${i}-${rnd()}`;
    nonces.push(clientNonce);
    socket.emit('dm:send', { toUserId: targets[i].id, content: `hello-${i}-${rnd()}`, clientNonce });
    if (spacingMs) await sleep(spacingMs);
  }
  await sleep(2_500);
  cap.stop();
  const delivered = new Set(cap.events
    .filter(e => e.name === 'dm:message' && e.payload?.clientNonce)
    .map(e => e.payload.clientNonce));
  return {
    attempted: targets.length,
    accepted: nonces.filter(n => delivered.has(n)).length,
    dmRateRejected: cap.events.filter(e => e.name === 'error:dm_rate').length,
    socketRejected: cap.events.filter(e => e.name === 'error:ratelimit').length,
    policyRejected: cap.events.filter(e => e.name === 'error:dm_privacy').length,
    genericRejected: cap.events.filter(e => e.name === 'error:message').length,
    durationMs: Date.now() - startedAt,
  };
}

async function joinUsers(base, inviteCode, users, { concurrency = 8 } = {}) {
  let accepted = 0;
  let blocked = 0;
  const statuses = {};
  const startedAt = Date.now();
  for (let offset = 0; offset < users.length; offset += concurrency) {
    const batch = users.slice(offset, offset + concurrency);
    const rows = await Promise.all(batch.map(async (u) => {
      try {
        const r = await mutate(base, 'POST', `/api/servers/invites/${inviteCode}/use`, u.token, {}, {
          'X-Forwarded-For': fakeIp(),
        });
        return r.status;
      } catch { return 599; }
    }));
    for (const status of rows) {
      statuses[status] = (statuses[status] || 0) + 1;
      if (status >= 200 && status < 300) accepted += 1; else blocked += 1;
    }
    await sleep(100);
  }
  return { attempted: users.length, accepted, blocked, statuses, durationMs: Date.now() - startedAt };
}

async function registerMany(base, count, prefix) {
  const out = [];
  for (let i = 0; i < count; i += 5) {
    const batch = await Promise.all(Array.from({ length: Math.min(5, count - i) }, () => register(base, prefix)));
    out.push(...batch);
    await sleep(75);
  }
  return out;
}

try {
  console.log(`work dir: ${cluster.workDir}`);
  await cluster.up();
  proxy = new RoutingProxy({
    port: cluster.basePort,
    nodes: cluster.nodeNames.map((name) => ({ name, host: '127.0.0.1', port: cluster.nodePort(name) })),
  });
  await proxy.start();
  const lb = `http://127.0.0.1:${cluster.basePort}`;

  const rssStart = clusterRssKb();
  const owner = await register(lb, 'abuse_owner');
  const legitPeer = await register(lb, 'abuse_legit');
  const mentionTargets = await registerMany(lb, 8, 'abuse_mention');
  const dmTargets = await registerMany(lb, 16, 'abuse_dm');
  const raidUsers = await registerMany(lb, 36, 'abuse_raid');

  const community = await makeServer(lb, owner, [legitPeer, ...mentionTargets]);
  const ownerSocket = await connectSocket(lb, owner.token);
  sockets.push(ownerSocket);

  let row = await channelBatch(ownerSocket, community,
    ['normal one', 'normal two', 'normal three', 'normal four', 'normal five'], { spacingMs: 550 });
  record('LEG-01', 'LEGIT', 'normal conversation burst', {
    ...row, falsePositive: row.accepted !== row.attempted,
  });

  row = await channelBatch(ownerSocket, community,
    Array.from({ length: 40 }, (_, i) => `burst-${i}-${rnd()}`));
  record('ATK-01', 'ATTACK', 'single-account channel burst', {
    ...row, outcome: classifyAttack(row.accepted, row.attempted),
  });

  await sleep(5_000);

  row = await channelBatch(ownerSocket, community, Array.from({ length: 12 }, () => 'duplicate-payload'));
  record('ATK-02', 'ATTACK', 'repeated identical content', {
    ...row, outcome: classifyAttack(row.accepted, row.attempted),
  });

  await sleep(5_000);

  row = await channelBatch(ownerSocket, community,
    ['offline-1', 'offline-2', 'offline-3', 'offline-4'], { spacingMs: 1_000 });
  record('LEG-02', 'LEGIT', 'paced reconnect backlog', {
    ...row, falsePositive: row.accepted !== row.attempted,
  });

  const mentionSockets = [];
  for (const u of mentionTargets) {
    const s = await connectSocket(lb, u.token);
    sockets.push(s); mentionSockets.push(s);
  }
  const mentionCaps = mentionSockets.map(s => captureSocket(s, ['mention:received']));
  row = await channelBatch(ownerSocket, community, [`hi <@${mentionTargets[0].id}>`]);
  await sleep(500);
  const legitMentions = mentionCaps.reduce((n, c) => n + c.events.length, 0);
  record('LEG-03', 'LEGIT', 'single explicit mention', {
    accepted: row.accepted, mentionDeliveries: legitMentions,
    falsePositive: row.accepted !== 1 || legitMentions !== 1,
  });
  for (const cap of mentionCaps) cap.events.length = 0;
  const massBody = mentionTargets.map(u => `<@${u.id}>`).join(' ');
  row = await channelBatch(ownerSocket, community, [massBody]);
  await sleep(750);
  const massMentions = mentionCaps.reduce((n, c) => n + c.events.length, 0);
  for (const cap of mentionCaps) cap.stop();
  record('ATK-03', 'ATTACK', 'single-message mass mention fan-out', {
    accepted: row.accepted, attemptedMentions: mentionTargets.length,
    deliveredMentions: massMentions,
    outcome: massMentions >= mentionTargets.length ? 'OPEN' : (massMentions > 0 ? 'LIMITED' : 'BLOCKED'),
  });

  await sleep(5_000);

  row = await dmBatch(ownerSocket, dmTargets, { spacingMs: 1_100 });
  record('ATK-04', 'ATTACK', 'new-recipient DM spray', {
    ...row, outcome: classifyAttack(row.accepted, row.attempted),
    projectedAcceptedPerHour: row.durationMs > 0 ? Math.round(row.accepted * 3_600_000 / row.durationMs) : null,
  });

  const joinOwner = await register(lb, 'abuse_join_owner');
  const serverResp = await mutate(lb, 'POST', '/api/servers', joinOwner.token, { name: `abuse-${rnd()}` });
  if (serverResp.status >= 300) throw new Error(`join server create ${serverResp.status}`);
  const joinServerId = serverResp.body._id || serverResp.body.id;
  const inviteResp = await mutate(lb, 'POST', '/api/servers/invites', joinOwner.token, { serverId: joinServerId });
  if (inviteResp.status >= 300) throw new Error(`join invite create ${inviteResp.status}`);
  const joinCode = inviteResp.body.code;
  const legitJoin = await joinUsers(lb, joinCode, raidUsers.slice(0, 4), { concurrency: 2 });
  record('LEG-04', 'LEGIT', 'small legitimate join cohort', {
    ...legitJoin, falsePositive: legitJoin.accepted !== legitJoin.attempted,
  });

  const raidOwner = await register(lb, 'abuse_raid_owner');
  const raidServerResp = await mutate(lb, 'POST', '/api/servers', raidOwner.token, { name: `raid-${rnd()}` });
  if (raidServerResp.status >= 300) throw new Error(`raid server create ${raidServerResp.status}`);
  const raidServerId = raidServerResp.body._id || raidServerResp.body.id;
  const raidInvite = await mutate(lb, 'POST', '/api/servers/invites', raidOwner.token, { serverId: raidServerId });
  if (raidInvite.status >= 300) throw new Error(`raid invite create ${raidInvite.status}`);
  const raid = await joinUsers(lb, raidInvite.body.code, raidUsers, { concurrency: 12 });
  record('ATK-05', 'ATTACK', 'multi-account single-community join raid', {
    ...raid, outcome: classifyAttack(raid.accepted, raid.attempted),
  });

  const rssEnd = clusterRssKb();
  if (rssStart !== null && rssEnd !== null) {
    measure('bridge_node_rss_start', rssStart, 'KiB', 'sum of two Bridge node VmRSS values');
    measure('bridge_node_rss_end', rssEnd, 'KiB', 'sum of two Bridge node VmRSS values');
    measure('bridge_node_rss_delta', rssEnd - rssStart, 'KiB', 'includes fixture and cache growth during the whole lab');
  }
} catch (err) {
  crashed = err?.stack || String(err);
  console.error(crashed);
} finally {
  for (const socket of sockets) {
    try { socket.close(); } catch { /* ignore */ }
  }

  const attacks = results.filter(r => r.kind === 'ATTACK');
  const legits = results.filter(r => r.kind === 'LEGIT');
  const summary = {
    attacks: attacks.length,
    open: attacks.filter(r => r.outcome === 'OPEN').length,
    limited: attacks.filter(r => r.outcome === 'LIMITED').length,
    blocked: attacks.filter(r => r.outcome === 'BLOCKED').length,
    legitimateControls: legits.length,
    falsePositives: legits.filter(r => r.falsePositive).length,
    crashed: Boolean(crashed),
  };
  const report = {
    generatedAt: new Date().toISOString(),
    mode: gate ? 'gate' : 'baseline',
    topology: cluster.topology(),
    summary,
    measurements,
    results,
    ...(crashed ? { crash: crashed } : {}),
  };
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = [
    `# P7 abuse lab — ${report.generatedAt}`,
    '',
    `Mode: **${report.mode}**`,
    '',
    `Attacks: open=${summary.open}, limited=${summary.limited}, blocked=${summary.blocked}; legitimate false positives=${summary.falsePositives}/${summary.legitimateControls}`,
    '',
    '| Id | Kind | Scenario | Outcome | Accepted | Attempted | Detail |',
    '|---|---|---|---|---:|---:|---|',
    ...results.map(r => `| ${r.id} | ${r.kind} | ${r.name} | ${r.outcome || (r.falsePositive ? 'FALSE_POSITIVE' : 'PASS')} | ${r.accepted ?? ''} | ${r.attempted ?? ''} | ${JSON.stringify(r).replace(/\|/g, '\\|').slice(0, 320)} |`),
    '',
    '## Measurements', '',
    ...Object.entries(measurements).map(([k, v]) => `- ${k}: ${v.value} ${v.unit}${v.note ? ` — ${v.note}` : ''}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(reportDir, 'report.md'), md);

  await proxy?.stop().catch(() => undefined);
  await cluster.down().catch(() => undefined);

  if (crashed) process.exitCode = 1;
}
