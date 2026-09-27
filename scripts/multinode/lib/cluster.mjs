// scripts/multinode/lib/cluster.mjs
//
// Disposable multi-process Bridge cluster for distributed-correctness evidence.
//
// Every component is a REAL, independent OS process:
//   · PostgreSQL  (initdb + pg_ctl, or an external DATABASE_URL)
//   · Redis       (redis-server, or an external REDIS_URL)
//   · S3          (any S3-compatible server; `moto_server` is spawned when
//                  MN_MOTO_SERVER points at it, otherwise MN_S3_ENDPOINT)
//   · Bridge nodes (`node server/dist/index.js`, NODE_ENV=production)
//
// PostgreSQL traffic from the Bridge nodes goes through a fault-injecting TCP
// proxy (lib/faultProxy.mjs) so a scenario can cut connections — including
// the classic "COMMIT sent, reply lost" ambiguity — without touching Bridge.
//
// Nothing here is used by the product. It only drives it from the outside.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpFaultProxy, PgFaultProxy } from './faultProxy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
export const SERVER = path.join(REPO, 'server');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) { last = err; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function findPgBin() {
  if (process.env.MN_PG_BIN) return process.env.MN_PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!fs.existsSync(root)) return null;
  const versions = fs.readdirSync(root).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
  for (const v of versions) {
    const bin = path.join(root, v, 'bin');
    if (fs.existsSync(path.join(bin, 'initdb'))) return bin;
  }
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// PostgreSQL refuses to run as root. When the harness itself runs as root
// (containers, CI), the server runs as the unprivileged `postgres` account.
const PG_USER = process.env.MN_PG_OS_USER || (process.getuid?.() === 0 ? 'postgres' : null);
// When running as root, PostgreSQL runs as an unprivileged account that must
// be able to traverse every ancestor of its data directory. Re-asserted before
// every pg_ctl call: some sandboxes reset temp-root permissions mid-run.
function ensureTraversable(dir) {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    try { fs.chmodSync(d, fs.statSync(d).mode | 0o711); } catch { /* not ours */ }
  }
}

function runPg(cmd, args, opts = {}) {
  if (!PG_USER) return run(cmd, args, opts);
  const dIdx = args.indexOf('-D');
  if (dIdx >= 0) ensureTraversable(path.dirname(args[dIdx + 1]));
  return run('runuser', ['-u', PG_USER, '--', cmd, ...args], opts);
}

const HEX64 = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16) + 'd'.repeat(16);

export class Cluster {
  constructor(opts = {}) {
    this.workDir = opts.workDir || fs.mkdtempSync(path.join(process.env.MN_WORK_ROOT || '/tmp', 'bridge-mn-'));
    this.nodeNames = opts.nodes || ['A', 'B', 'C'];
    this.basePort = opts.basePort || 3100;
    // `per-node` models Kubernetes emptyDir; `shared` models the compose
    // cluster's shared upload volume.
    this.uploads = opts.uploads || 'per-node';
    this.extraEnv = opts.env || {};
    this.pgPort = opts.pgPort || 55432;
    this.pgProxyPort = opts.pgProxyPort || 55433;
    this.redisPort = opts.redisPort || 56379;
    this.s3Port = opts.s3Port || 59000;
    this.nodes = new Map();
    this.exitHistory = []; // every node process exit, for time-interval evidence
    this.logs = path.join(this.workDir, 'logs');
    fs.mkdirSync(this.logs, { recursive: true });
    this.pgBin = findPgBin();
    this.versions = {};
  }

  nodePort(name) { return this.basePort + 1 + this.nodeNames.indexOf(name); }
  nodeUrl(name) { return `http://127.0.0.1:${this.nodePort(name)}`; }
  get databaseUrl() { return `postgresql://bridge:mn_pg_password@127.0.0.1:${this.pgProxyPort}/bridge_mn`; }
  get directDatabaseUrl() { return `postgresql://bridge:mn_pg_password@127.0.0.1:${this.pgPort}/bridge_mn`; }
  get redisUrl() { return `redis://127.0.0.1:${this.redisPort}`; }
  get s3Endpoint() { return process.env.MN_S3_ENDPOINT || `http://127.0.0.1:${this.s3Port}`; }

  // ── PostgreSQL ────────────────────────────────────────────────────────────
  get pgDir() { return path.join(this.workDir, 'pg'); }

  async startPostgres() {
    if (!this.pgBin) throw new Error('PostgreSQL binaries not found (set MN_PG_BIN)');
    const data = path.join(this.pgDir, 'data');
    if (!fs.existsSync(data)) {
      fs.mkdirSync(this.pgDir, { recursive: true, mode: 0o700 });
      const pw = path.join(this.pgDir, 'pgpw');
      fs.writeFileSync(pw, 'mn_pg_password\n');
      if (PG_USER) {
        run('chown', ['-R', `${PG_USER}:`, this.pgDir]);
      }
      runPg(path.join(this.pgBin, 'initdb'), ['-D', data, '-U', 'bridge', '--pwfile', pw, '-A', 'scram-sha-256', '--no-sync'], { env: { ...process.env, LC_ALL: 'C' } });
      fs.appendFileSync(path.join(data, 'postgresql.conf'), [
        `port = ${this.pgPort}`,
        `listen_addresses = '127.0.0.1'`,
        `unix_socket_directories = '${this.pgDir}'`,
        'fsync = on',
        'max_connections = 300',
        '',
      ].join('\n'));
    }
    runPg(path.join(this.pgBin, 'pg_ctl'), ['-D', data, '-l', path.join(this.pgDir, 'postgres.log'), '-w', 'start']);
    this.versions.postgres = run(path.join(this.pgBin, 'postgres'), ['--version']).trim();
    const env = { ...process.env, PGPASSWORD: 'mn_pg_password' };
    const exists = spawnSync('psql', ['-h', '127.0.0.1', '-p', String(this.pgPort), '-U', 'bridge', '-d', 'postgres', '-tAc',
      "SELECT 1 FROM pg_database WHERE datname='bridge_mn'"], { encoding: 'utf8', env });
    if (!String(exists.stdout).includes('1')) {
      run('psql', ['-h', '127.0.0.1', '-p', String(this.pgPort), '-U', 'bridge', '-d', 'postgres', '-c', 'CREATE DATABASE bridge_mn'], { env });
    }
    if (!this.pgProxy) {
      this.pgProxy = new PgFaultProxy({ listenPort: this.pgProxyPort, targetPort: this.pgPort });
      await this.pgProxy.start();
    }
  }

  /** `immediate` = crash-like shutdown (no checkpoint); `fast` = clean. */
  stopPostgres(mode = 'immediate') {
    runPg(path.join(this.pgBin, 'pg_ctl'), ['-D', path.join(this.pgDir, 'data'), '-m', mode, '-w', 'stop']);
  }

  restartPostgres() {
    runPg(path.join(this.pgBin, 'pg_ctl'), ['-D', path.join(this.pgDir, 'data'), '-l', path.join(this.pgDir, 'postgres.log'), '-w', 'start']);
  }

  psql(sql) {
    return run('psql', ['-h', '127.0.0.1', '-p', String(this.pgPort), '-U', 'bridge', '-d', 'bridge_mn', '-tAc', sql],
      { env: { ...process.env, PGPASSWORD: 'mn_pg_password' } }).trim();
  }

  // ── Redis ─────────────────────────────────────────────────────────────────
  async startRedis() {
    const conf = [
      '--port', String(this.redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no',
      '--dir', this.workDir, '--logfile', path.join(this.logs, 'redis.log'),
    ];
    this.redisProc = spawn('redis-server', conf, { stdio: 'ignore' });
    await waitFor(() => portOpen(this.redisPort), { label: 'redis' });
    this.versions.redis = run('redis-server', ['--version']).trim();
  }

  redisCli(...args) {
    return spawnSync('redis-cli', ['-p', String(this.redisPort), ...args], { encoding: 'utf8' }).stdout.trim();
  }

  /** Connection refused: the process is gone. */
  async stopRedis() {
    this.redisCli('SHUTDOWN', 'NOSAVE');
    await waitFor(async () => !(await portOpen(this.redisPort)), { label: 'redis down' });
    this.redisProc = null;
  }

  /** Reachable socket, no replies (hung/partitioned server). */
  pauseRedis() { this.redisProc?.kill('SIGSTOP'); }
  resumeRedis() { this.redisProc?.kill('SIGCONT'); }

  /** Drop every established client connection; the server stays up. */
  killRedisClients() { return this.redisCli('CLIENT', 'KILL', 'TYPE', 'normal'); }

  /** Reachable and answering, but every write fails with -OOM. */
  redisRejectWrites(on) {
    if (on) {
      this.redisCli('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
      this.redisCli('CONFIG', 'SET', 'maxmemory', '1');
    } else {
      this.redisCli('CONFIG', 'SET', 'maxmemory', '0');
    }
  }

  // ── S3 ────────────────────────────────────────────────────────────────────
  async startS3() {
    if (!process.env.MN_S3_ENDPOINT) {
      const moto = process.env.MN_MOTO_SERVER;
      if (!moto) throw new Error('Set MN_S3_ENDPOINT (external S3) or MN_MOTO_SERVER (path to moto_server)');
      this.s3Proc = spawn(moto, ['-H', '127.0.0.1', '-p', String(this.s3Port)], {
        stdio: ['ignore', fs.openSync(path.join(this.logs, 's3.log'), 'a'), fs.openSync(path.join(this.logs, 's3.log'), 'a')],
      });
      this.versions.s3 = `moto_server ${spawnSync(moto.replace(/moto_server$/, 'python'), ['-c', 'import moto;print(moto.__version__)'], { encoding: 'utf8' }).stdout.trim()}`;
      await waitFor(() => portOpen(this.s3Port), { label: 's3', timeoutMs: 60_000 });
    } else {
      this.versions.s3 = `external ${process.env.MN_S3_ENDPOINT}`;
    }
    const { S3Client, CreateBucketCommand } = await import(path.join(REPO, 'node_modules/@aws-sdk/client-s3/dist-cjs/index.js'));
    this.s3 = new S3Client({
      endpoint: this.s3Endpoint, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: 'mn-access-key', secretAccessKey: 'mn-secret-key-for-harness' },
    });
    for (const Bucket of ['bridge-public', 'bridge-private']) {
      try { await this.s3.send(new CreateBucketCommand({ Bucket })); } catch (err) {
        if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(err?.name))) throw err;
      }
    }
    if (!this.s3Proxy) {
      const target = new URL(this.s3Endpoint);
      this.s3Proxy = new HttpFaultProxy({ listenPort: this.s3Port + 1, targetPort: Number(target.port || 80), targetHost: target.hostname });
      await this.s3Proxy.start();
    }
  }

  /** What the Bridge nodes use for object storage: through the fault proxy. */
  get nodeS3Endpoint() { return `http://127.0.0.1:${this.s3Port + 1}`; }

  async listPrivateObjects(prefix = '') {
    const { ListObjectsV2Command } = await import(path.join(REPO, 'node_modules/@aws-sdk/client-s3/dist-cjs/index.js'));
    const out = await this.s3.send(new ListObjectsV2Command({ Bucket: 'bridge-private', Prefix: prefix }));
    return (out.Contents || []).map((o) => o.Key);
  }

  // ── Bridge ────────────────────────────────────────────────────────────────
  /** Same order as CI's clean-database gate: base schema, then the chain. */
  migrate() {
    const env = { ...process.env, ...this.nodeEnv(this.nodeNames[0]), DATABASE_URL: this.directDatabaseUrl };
    for (const args of [['dist/db/postgres/index.js'], ['dist/db/migrate-postgres.js', 'up']]) {
      const r = spawnSync(process.execPath, args, { cwd: SERVER, encoding: 'utf8', env });
      if (r.status !== 0) throw new Error(`${args[0]} failed: ${r.stderr || r.stdout}`);
    }
  }

  get uploadMode() { return this.uploads; }

  /** Top-level files in a node's upload root (final-file leftovers, not staging). */
  listUploadRoot(name) {
    try {
      return fs.readdirSync(this.uploadRoot(name), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    } catch { return []; }
  }

  uploadRoot(name) {
    return path.join(this.workDir, this.uploads === 'shared' ? 'uploads-shared' : `uploads-${name}`);
  }

  nodeEnv(name) {
    // WebAuthn RP ID must match the public host; `localhost` is the only
    // loopback host WebAuthn accepts.
    const proxy = `http://localhost:${this.basePort}`;
    return {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(this.nodePort(name)),
      INSTANCE_ID: `mn-${name}`,
      DATABASE_URL: this.databaseUrl,
      REDIS_URL: this.redisUrl,
      JWT_SECRET: 'multinode-harness-jwt-secret-0123456789abcdef',
      REFRESH_SECRET: 'multinode-harness-refresh-secret-0123456789abcd',
      AP_ENCRYPTION_KEY: HEX64,
      FEDERATION_SECRET: 'multinode-harness-federation-secret-0123456789',
      METRICS_SECRET: 'multinode-metrics-secret',
      BRIDGE_MULTI_NODE: 'true',
      CDN_PROVIDER: 'minio',
      MINIO_ENDPOINT: this.nodeS3Endpoint,
      MINIO_BUCKET: 'bridge-public',
      MINIO_ACCESS_KEY: 'mn-access-key',
      MINIO_SECRET_KEY: 'mn-secret-key-for-harness',
      MINIO_PUBLIC_URL: `${this.s3Endpoint}/bridge-public`,
      PRIVATE_STORAGE_PROVIDER: 'minio',
      PRIVATE_MINIO_BUCKET: 'bridge-private',
      BRIDGE_UPLOAD_ROOT: this.uploadRoot(name),
      BASE_URL: proxy,
      INSTANCE_URL: proxy,
      ALLOWED_ORIGINS: proxy,
      WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_ORIGIN: proxy,
      LOG_LEVEL: 'info',
      // Production topology: nodes sit behind one load balancer hop.
      TRUSTED_PROXY_COUNT: '1',
      // Job scenarios deliver outgoing webhooks / ActivityPub retries to a
      // loopback test receiver. These two opt-ins exist for private
      // deployments; SSRF enforcement itself is covered by unit tests.
      ALLOW_INTERNAL_WEBHOOKS: 'true',
      SSRF_ALLOWLIST: 'localhost',
      // Fixture creation only: every scenario registers fresh accounts from
      // one IP. Nothing else about registration/auth limits is changed.
      RL_REGISTER_MAX: '10000',
      MAX_REG_PER_HOUR: '10000',
      RL_LOGIN_MAX: '1000',
      ...this.extraEnv,
    };
  }

  async startNode(name, extraEnv = {}) {
    const out = fs.openSync(path.join(this.logs, `node-${name}.log`), 'a');
    fs.mkdirSync(this.uploadRoot(name), { recursive: true });
    const proc = spawn(process.execPath, ['dist/index.js'], {
      cwd: SERVER, env: { ...process.env, ...this.nodeEnv(name), ...extraEnv }, stdio: ['ignore', out, out],
    });
    const node = { name, proc, url: this.nodeUrl(name), startedAt: Date.now(), exited: null };
    proc.once('exit', (code, signal) => {
      node.exited = { code, signal, at: Date.now() };
      this.exitHistory.push({ name, ...node.exited });
    });
    this.nodes.set(name, node);
    await waitFor(async () => {
      if (node.exited) throw new Error(`node ${name} exited ${JSON.stringify(node.exited)}; see ${path.join(this.logs, `node-${name}.log`)}`);
      const r = await fetch(`${node.url}/api/health/ready`).catch(() => null);
      return r?.ok;
    }, { timeoutMs: 60_000, label: `node ${name} ready` });
    node.readyAt = Date.now();
    return node;
  }

  /** SIGKILL = abrupt death (no graceful shutdown, no socket close frames). */
  async killNode(name, signal = 'SIGKILL') {
    const node = this.nodes.get(name);
    if (!node || node.exited) return;
    node.proc.kill(signal);
    await waitFor(() => node.exited, { label: `node ${name} exit` });
  }

  nodeLog(name) {
    try { return fs.readFileSync(path.join(this.logs, `node-${name}.log`), 'utf8'); } catch { return ''; }
  }

  async up({ nodes = this.nodeNames } = {}) {
    await this.startPostgres();
    await this.startRedis();
    await this.startS3();
    this.migrate();
    this.versions.node = process.version;
    this.versions.bridge = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
    for (const n of nodes) await this.startNode(n);
    return this;
  }

  topology() {
    return {
      workDir: this.workDir,
      versions: this.versions,
      postgres: { port: this.pgPort, faultProxyPort: this.pgProxyPort, shared: true },
      redis: { port: this.redisPort, shared: true },
      s3: { endpoint: this.s3Endpoint, nodeEndpoint: this.nodeS3Endpoint, faultProxy: 'http (per-method failure injection)', buckets: ['bridge-public', 'bridge-private'], shared: true },
      uploads: this.uploads,
      nodes: this.nodeNames.map((n) => ({ name: n, instanceId: `mn-${n}`, url: this.nodeUrl(n), uploadRoot: this.uploadRoot(n) })),
    };
  }

  async down() {
    for (const node of this.nodes.values()) if (!node.exited) node.proc.kill('SIGKILL');
    await this.pgProxy?.stop();
    try { this.redisCli('SHUTDOWN', 'NOSAVE'); } catch { /* already down */ }
    this.resumeRedis();
    try { this.stopPostgres('fast'); } catch { /* already down */ }
    await this.s3Proxy?.stop();
    this.s3Proc?.kill('SIGKILL');
  }
}
