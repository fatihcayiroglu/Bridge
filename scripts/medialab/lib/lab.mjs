// scripts/medialab/lib/lab.mjs
//
// The disposable media lab: PostgreSQL + Redis + S3 (moto) + two real Bridge
// nodes with real mediasoup workers (reusing the P1 multi-node Cluster),
// the P1 routing load balancer exposed on the lab's SFU address, a real
// coturn, and per-client network namespaces behind impairment links.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Cluster, sleep, waitFor } from '../../multinode/lib/cluster.mjs';
import { RoutingProxy } from '../../multinode/lib/proxy.mjs';
import { register, mutate, request, rnd } from '../../multinode/lib/client.mjs';
import { Net, SFU_IP, TURN_IP } from './net.mjs';
import { Turn, TURN_PORT } from './turn.mjs';
import { Client, chromiumVersion } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LB_PORT = 3100;
const RTC_RANGES = { A: [40000, 40999], B: [41000, 41999], C: [42000, 42999] };

export { sleep, waitFor };

export class Lab {
  constructor({ workDir, nodes = ['A', 'B'], env = {} } = {}) {
    this.workDir = workDir || fs.mkdtempSync(path.join(process.env.MN_WORK_ROOT || os.tmpdir(), 'bridge-medialab-'));
    fs.mkdirSync(path.join(this.workDir, 'logs'), { recursive: true });
    this.nodes = nodes;
    this.baseUrl = `http://${SFU_IP}:${LB_PORT}`;
    this.net = new Net(this.workDir);
    this.turn = new Turn(this.workDir);
    this.labEnv = env;
    this.clients = [];
    this.cluster = new Cluster({
      workDir: path.join(this.workDir, 'cluster'),
      nodes,
      basePort: LB_PORT,
      pgPort: 55532, pgProxyPort: 55533, redisPort: 56479, s3Port: 59100,
      uploads: 'shared',
      env: this.#nodeEnv(env),
    });
  }

  #nodeEnv(extra) {
    return {
      BASE_URL: this.baseUrl,
      INSTANCE_URL: this.baseUrl,
      ALLOWED_ORIGINS: this.baseUrl,
      MEDIASOUP_LISTEN_IP: SFU_IP,
      MEDIASOUP_ANNOUNCED_IP: SFU_IP,
      MEDIASOUP_WORKERS: '1',
      TURN_SECRET: this.turn.secret,
      TURN_HOST: TURN_IP,
      TURN_PORT: String(TURN_PORT),
      // The only STUN server a lab client can reach is the lab's coturn.
      STUN_URLS: `stun:${TURN_IP}:${TURN_PORT}`,
      // Lab only: the web app runs on a plain-HTTP lab address where the
      // Secure refresh cookie cannot be stored; a long access token keeps a
      // token refresh from ending sessions mid-soak. Not a media setting.
      ACCESS_TOKEN_TTL: '6h',
      ...extra,
    };
  }

  fixtures(index) {
    const dir = path.join(this.workDir, 'fixtures');
    const wav = path.join(dir, `tone-${index}.wav`);
    const y4m = path.join(dir, `video-${index}.y4m`);
    if (!fs.existsSync(wav) || !fs.existsSync(y4m)) {
      const r = spawnSync('python3', [path.join(HERE, '..', 'fixtures.py'), dir, String(index)], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`fixtures: ${r.stderr}`);
    }
    return { wav, y4m, toneHz: 440 + 220 * index };
  }

  async up() {
    this.net.up();
    await this.turn.start();
    const c = this.cluster;
    await c.startPostgres();
    await c.startRedis();
    await c.startS3();
    c.migrate();
    c.versions.node = process.version;
    for (const n of this.nodes) await this.startNode(n);
    this.proxy = new RoutingProxy({
      port: LB_PORT, host: SFU_IP, mode: 'round-robin',
      nodes: this.nodes.map((name) => ({ name, host: '127.0.0.1', port: c.nodePort(name) })),
    });
    await this.proxy.start();
    await this.settle();
    return this;
  }

  /**
   * A freshly created SFU registry epoch refuses brand-new room claims for
   * REGISTRY_SETTLE_MS (~22 s, lib/sfuRegistry.ts) so live owners can
   * re-assert first. That is intended P1 fail-closed behaviour, not a media
   * result: the lab waits it out before the first join.
   */
  async settle(ms = 24_000) {
    const first = Math.min(...[...this.cluster.nodes.values()].map((n) => n.readyAt || Date.now()));
    const wait = first + ms - Date.now();
    if (wait > 0) await sleep(wait);
  }

  async startNode(name, extraEnv = {}) {
    const [min, max] = RTC_RANGES[name];
    return this.cluster.startNode(name, { MEDIASOUP_RTC_MIN_PORT: String(min), MEDIASOUP_RTC_MAX_PORT: String(max), ...extraEnv });
  }

  /** Restart every node with a new environment (e.g. FORCE_TURN on/off). */
  async restartNodes(extraEnv = {}) {
    this.labEnv = { ...this.labEnv, ...extraEnv };
    this.cluster.extraEnv = this.#nodeEnv(this.labEnv);
    for (const n of this.nodes) await this.cluster.killNode(n, 'SIGTERM');
    for (const n of this.nodes) await this.startNode(n);
  }

  topology() {
    return {
      workDir: this.workDir,
      host: { kernel: os.release(), cpus: os.cpus().length, memMb: Math.round(os.totalmem() / 1048576) },
      chromium: chromiumVersion(),
      coturn: this.turn.version(),
      mediasoup: JSON.parse(fs.readFileSync(path.resolve(HERE, '../../../server/node_modules/mediasoup/package.json'), 'utf8')).version,
      mediasoupClient: JSON.parse(fs.readFileSync(path.resolve(HERE, '../../../node_modules/mediasoup-client/package.json'), 'utf8')).version,
      cluster: this.cluster.topology(),
      lb: `${this.baseUrl} (routing proxy, ?bridgeNode= SFU routing)`,
      sfu: { ip: SFU_IP, rtcPorts: Object.fromEntries(this.nodes.map((n) => [n, RTC_RANGES[n].join('-')])) },
      turn: { ip: TURN_IP, port: TURN_PORT, transports: ['udp', 'tcp'], tls: 'not configured (no trusted certificate in lab)' },
      firewall: this.net.firewall,
    };
  }

  // ── fixtures: accounts and rooms ─────────────────────────────────────
  async users(n, prefix = 'ml') {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await register(this.baseUrl, prefix));
    return out;
  }

  async makeAdmin(user) {
    this.cluster.psql(`UPDATE users SET "isAdmin" = true WHERE _id = '${user.id}'`);
  }

  async voiceRoom(owner, members = []) {
    const s = await mutate(this.baseUrl, 'POST', '/api/servers', owner.token, { name: `ML ${rnd()}` });
    if (s.status >= 300) throw new Error(`server create ${s.status} ${JSON.stringify(s.body)}`);
    const serverId = s.body._id || s.body.id;
    const voiceName = `ses-${rnd()}`;
    const c = await mutate(this.baseUrl, 'POST', `/api/servers/${serverId}/channels`, owner.token, { name: voiceName, type: 'voice' });
    if (c.status >= 300) throw new Error(`voice channel ${c.status} ${JSON.stringify(c.body)}`);
    const channelId = c.body._id || c.body.id;
    if (members.length) {
      const inv = await mutate(this.baseUrl, 'POST', '/api/servers/invites', owner.token, { serverId });
      if (inv.status >= 300) throw new Error(`invite ${inv.status}`);
      for (const m of members) {
        const u = await mutate(this.baseUrl, 'POST', `/api/servers/invites/${inv.body.code}/use`, m.token, {});
        if (u.status >= 300) throw new Error(`invite use ${u.status}`);
      }
    }
    return { serverId, channelId, voiceName, owner };
  }

  /** `node` pins the client's app traffic to one Bridge node (LB cookie
   *  affinity, like a sticky production LB); SFU redirects still use the
   *  `?bridgeNode=` route to the room owner. */
  async client(index, user, { node } = {}) {
    await this.net.addClient(index);
    const c = new Client(this, index, user);
    await c.launch();
    if (node) {
      this.proxy.setMode('cookie');
      await c.context.addCookies([{ name: 'MNNODE', value: node, url: this.baseUrl }]);
      c.node = node;
    }
    await c.open();
    this.clients.push(c);
    return c;
  }

  async closeClient(c) {
    await c.close();
    this.clients = this.clients.filter((x) => x !== c);
  }

  // ── server-side observation ──────────────────────────────────────────
  /** Which node owns the room according to the Redis registry. */
  roomOwner(channelId) {
    const r = this.cluster.redisCli('GET', `bridge:sfu:room:${channelId}`);
    return String(r || '').trim() || null;
  }

  /** Process-level evidence per node: RSS, CPU ticks, worker sockets. */
  serverProbe() {
    const out = {};
    const ss = spawnSync('ss', ['-uanp'], { encoding: 'utf8' }).stdout || '';
    const sst = spawnSync('ss', ['-tanp'], { encoding: 'utf8' }).stdout || '';
    for (const [name, node] of this.cluster.nodes) {
      if (node.exited) { out[name] = { alive: false }; continue; }
      const pid = node.proc.pid;
      const workers = childPids(pid).filter((p) => procComm(p).startsWith('mediasoup'));
      out[name] = {
        alive: true, pid,
        rssKb: procRss(pid), cpuTicks: procCpu(pid), fds: fdCount(pid),
        workers: workers.map((w) => ({
          pid: w, rssKb: procRss(w), cpuTicks: procCpu(w), fds: fdCount(w),
          udpSockets: (ss.match(new RegExp(`pid=${w},`, 'g')) || []).length,
          tcpSockets: (sst.match(new RegExp(`pid=${w},`, 'g')) || []).length,
        })),
      };
    }
    return out;
  }

  redisSfuKeys() {
    const r = spawnSync('redis-cli', ['-p', String(this.cluster.redisPort), '--scan', '--pattern', 'bridge:sfu:*'], { encoding: 'utf8' });
    return (r.stdout || '').split('\n').filter(Boolean);
  }

  async adminSfuStats(admin, node) {
    const r = await request(this.baseUrl, 'GET', '/api/admin/sfu/stats', { token: admin.token, headers: { 'x-mn-node': node } });
    return r.status === 200 ? r.body : { status: r.status };
  }

  async down() {
    for (const c of this.clients) await c.close();
    this.clients = [];
    // Keep-alive connections would hold server.close() open indefinitely.
    this.proxy?.server?.closeAllConnections?.();
    await Promise.race([this.proxy?.stop().catch(() => {}), sleep(5_000)]);
    await this.cluster.down().catch(() => {});
    this.turn.stop();
    this.net.down();
  }
}

// ── /proc helpers ─────────────────────────────────────────────────────────
function readProc(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function procComm(pid) { return readProc(`/proc/${pid}/comm`).trim(); }
function procRss(pid) { const m = /VmRSS:\s+(\d+)/.exec(readProc(`/proc/${pid}/status`)); return m ? Number(m[1]) : null; }
function procCpu(pid) {
  const stat = readProc(`/proc/${pid}/stat`);
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return rest.length > 13 ? Number(rest[11]) + Number(rest[12]) : null;
}
function fdCount(pid) { try { return fs.readdirSync(`/proc/${pid}/fd`).length; } catch { return null; } }
function childPids(pid) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const stat = readProc(`/proc/${d}/stat`);
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(rest[1]) === pid) out.push(Number(d));
  }
  return out;
}

/** Sum of RSS / CPU ticks of every process inside a client namespace. */
export function namespaceUsage(ns) {
  const r = spawnSync('ip', ['netns', 'pids', ns], { encoding: 'utf8' });
  const pids = (r.stdout || '').split('\n').filter(Boolean).map(Number);
  let rssKb = 0; let cpuTicks = 0;
  for (const p of pids) { rssKb += procRss(p) || 0; cpuTicks += procCpu(p) || 0; }
  return { pids: pids.length, rssKb, cpuTicks };
}
