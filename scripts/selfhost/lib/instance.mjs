// scripts/selfhost/lib/instance.mjs
//
// One self-hosted Bridge installation as real processes: its OWN PostgreSQL
// cluster (initdb), its OWN Redis, its OWN upload root, and the production
// build (`node server/dist/index.js`, NODE_ENV=production) — the same command
// the Docker image runs. Nothing is shared between two Instance objects, so the
// federation lab can run two independent installations side by side.
//
// The app process inherits almost nothing from the harness environment (PATH,
// HOME, locale): an install must work from its own documented configuration.
// Every app process is preloaded with lib/egress-guard.cjs, which records any
// outbound connection that leaves the machine.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO, sleep, waitFor, findPgBin, runPg, portOpen } from '../../multinode/lib/cluster.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EGRESS_GUARD = path.join(HERE, 'egress-guard.cjs');
export { REPO, sleep, waitFor };

const HEX64 = '0123456789abcdef'.repeat(4);

export class Instance {
  /**
   * @param {object} o
   * @param {string} o.name        short name (a, b, cleanroom, ...)
   * @param {string} o.workDir     lab work directory (logs and state live under it)
   * @param {number} o.pgPort
   * @param {number} o.redisPort
   * @param {number} o.appPort
   * @param {object} [o.env]       extra app environment for every start
   */
  constructor({ name, workDir, pgPort, redisPort, appPort, env = {} }) {
    Object.assign(this, { name, workDir, pgPort, redisPort, appPort });
    this.baseEnv = env;
    this.dir = path.join(workDir, name);
    this.logs = path.join(workDir, 'logs');
    this.pgDir = path.join(this.dir, 'pg');
    this.uploads = path.join(this.dir, 'uploads');
    this.egressLog = path.join(workDir, `egress-${name}.jsonl`);
    this.pgBin = findPgBin();
    this.app = null;
    this.starts = 0;
    fs.mkdirSync(this.logs, { recursive: true });
    fs.mkdirSync(this.uploads, { recursive: true });
  }

  get base() { return `http://127.0.0.1:${this.appPort}`; }
  get dbUrl() { return `postgresql://bridge:bridge-${this.name}-pw@127.0.0.1:${this.pgPort}/bridge`; }
  get redisUrl() { return `redis://127.0.0.1:${this.redisPort}`; }

  // ── PostgreSQL ────────────────────────────────────────────────────────────
  async startPg({ fresh = false } = {}) {
    if (!this.pgBin) throw new Error('PostgreSQL binaries not found (set MN_PG_BIN)');
    const data = path.join(this.pgDir, 'data');
    if (fresh && fs.existsSync(this.pgDir)) {
      this.stopPg('immediate');
      fs.rmSync(this.pgDir, { recursive: true, force: true });
    }
    if (!fs.existsSync(data)) {
      fs.mkdirSync(this.pgDir, { recursive: true });
      const pw = path.join(this.pgDir, 'pw');
      fs.writeFileSync(pw, `bridge-${this.name}-pw\n`);
      if (process.getuid?.() === 0) spawnSync('chown', ['-R', 'postgres:postgres', this.pgDir]);
      runPg(path.join(this.pgBin, 'initdb'), ['-D', data, '-U', 'bridge', '--pwfile', pw, '-A', 'scram-sha-256', '--no-sync'], { env: { ...process.env, LC_ALL: 'C' } });
      // Unix socket paths are limited to 107 bytes; a deep work dir exceeds it.
      this.sockDir = fs.mkdtempSync(path.join('/tmp', `bsh-${this.name.slice(0, 8)}-`));
      fs.chmodSync(this.sockDir, 0o777);
      fs.appendFileSync(path.join(data, 'postgresql.conf'),
        `\nport = ${this.pgPort}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '${this.sockDir}'\nfsync = off\n`);
      if (process.getuid?.() === 0) spawnSync('chown', ['-R', 'postgres:postgres', this.pgDir]);
      runPg(path.join(this.pgBin, 'pg_ctl'), ['-D', data, '-l', path.join(this.pgDir, 'postgres.log'), '-w', 'start']);
      this.psql('postgres', 'CREATE DATABASE bridge OWNER bridge');
      return;
    }
    if (!(await portOpen(this.pgPort))) {
      runPg(path.join(this.pgBin, 'pg_ctl'), ['-D', data, '-l', path.join(this.pgDir, 'postgres.log'), '-w', 'start']);
    }
  }

  stopPg(mode = 'fast') {
    const data = path.join(this.pgDir, 'data');
    if (!fs.existsSync(data)) return;
    try { runPg(path.join(this.pgBin, 'pg_ctl'), ['-D', data, '-m', mode, '-w', 'stop']); } catch { /* not running */ }
  }

  /** Runs SQL with psql as the `bridge` role; returns trimmed stdout (tuples only). */
  psql(db, sql) {
    const r = spawnSync(path.join(this.pgBin, 'psql'), ['-h', '127.0.0.1', '-p', String(this.pgPort), '-U', 'bridge', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], {
      encoding: 'utf8', env: { ...process.env, PGPASSWORD: `bridge-${this.name}-pw` },
    });
    if (r.status !== 0) throw new Error(`psql ${db}: ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  }

  // ── Redis ─────────────────────────────────────────────────────────────────
  async startRedis() {
    if (await portOpen(this.redisPort)) return;
    this.redisProc = spawn('redis-server', ['--port', String(this.redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no',
      '--maxmemory', '256mb', '--maxmemory-policy', 'noeviction'], { stdio: 'ignore' });
    await waitFor(() => portOpen(this.redisPort), { label: `redis ${this.name}` });
  }

  async stopRedis() {
    spawnSync('redis-cli', ['-p', String(this.redisPort), 'SHUTDOWN', 'NOSAVE']);
    await waitFor(async () => !(await portOpen(this.redisPort)), { label: `redis ${this.name} down` });
  }

  // ── Bridge ────────────────────────────────────────────────────────────────
  /** The documented production configuration of this installation. */
  env(overrides = {}) {
    const base = {
      PATH: process.env.PATH,
      HOME: process.env.HOME || '/tmp',
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(this.appPort),
      DATABASE_URL: this.dbUrl,
      DATABASE_SSL: 'false',
      REDIS_URL: this.redisUrl,
      JWT_SECRET: `selfhost-${this.name}-jwt-secret-0123456789abcdef`,
      REFRESH_SECRET: `selfhost-${this.name}-refresh-secret-0123456789abc`,
      FEDERATION_SECRET: `selfhost-${this.name}-federation-secret-01234567`,
      AP_ENCRYPTION_KEY: HEX64,
      METRICS_SECRET: `selfhost-${this.name}-metrics`,
      ALLOWED_ORIGINS: this.base,
      TRUSTED_PROXY_COUNT: '0',
      BRIDGE_UPLOAD_ROOT: this.uploads,
      LOG_LEVEL: 'info',
      // Fixture creation only: the lab registers several accounts from one IP.
      RL_REGISTER_MAX: '1000',
      MAX_REG_PER_HOUR: '1000',
      RL_LOGIN_MAX: '1000',
      NODE_OPTIONS: `--require ${EGRESS_GUARD}`,
      BRIDGE_EGRESS_LOG: this.egressLog,
      ...this.baseEnv,
      ...overrides,
    };
    for (const [k, v] of Object.entries(base)) if (v === undefined || v === null) delete base[k];
    return base;
  }

  logPath(tag) { return path.join(this.logs, `${this.name}-${tag}.log`); }

  /**
   * Starts the app from `releaseDir` (a checkout with server/dist built) and
   * waits for /api/health/ready = 200. Returns { bootMs, log }.
   */
  async start({ releaseDir = REPO, env = {}, readyTimeoutMs = 120_000, tag } = {}) {
    if (this.app && !this.app.exited) throw new Error(`${this.name} already running`);
    this.starts += 1;
    const log = this.logPath(tag || `app-${this.starts}`);
    const out = fs.openSync(log, 'a');
    const t0 = Date.now();
    const proc = spawn(process.execPath, ['server/dist/index.js'], { cwd: releaseDir, env: this.env(env), stdio: ['ignore', out, out] });
    const app = { proc, log, startedAt: t0, exited: null, releaseDir };
    proc.once('exit', (code, signal) => { app.exited = { code, signal, at: Date.now() }; });
    this.app = app;
    await waitFor(async () => {
      if (app.exited) throw new Error(`${this.name} exited ${JSON.stringify(app.exited)} before ready; see ${log}`);
      const r = await fetch(`${this.base}/api/health/ready`).catch(() => null);
      return r?.status === 200;
    }, { timeoutMs: readyTimeoutMs, intervalMs: 250, label: `${this.name} ready` });
    app.readyAt = Date.now();
    return { bootMs: app.readyAt - t0, log };
  }

  /** Graceful stop (SIGTERM, like `docker stop`). Returns { code, signal, ms }. */
  async stop({ signal = 'SIGTERM', timeoutMs = 30_000 } = {}) {
    const app = this.app;
    if (!app || app.exited) return app?.exited ?? null;
    const t0 = Date.now();
    app.proc.kill(signal);
    try {
      await waitFor(() => app.exited, { timeoutMs, intervalMs: 50, label: `${this.name} exit` });
    } catch {
      app.proc.kill('SIGKILL');
      await waitFor(() => app.exited, { timeoutMs: 10_000, label: `${this.name} SIGKILL exit` });
      return { ...app.exited, ms: Date.now() - t0, forced: true };
    }
    return { ...app.exited, ms: Date.now() - t0 };
  }

  /**
   * Boots with a configuration that is expected to be refused. Resolves with
   * { exited, code, output, listened } after the process exits or `timeoutMs`.
   */
  async bootExpectingRefusal(overrides, { timeoutMs = 30_000, unset = [] } = {}) {
    const env = this.env(overrides);
    for (const k of unset) delete env[k];
    const proc = spawn(process.execPath, ['server/dist/index.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', (d) => { output += d; });
    proc.stderr.on('data', (d) => { output += d; });
    let exited = null;
    proc.once('exit', (code, signal) => { exited = { code, signal }; });
    const deadline = Date.now() + timeoutMs;
    let listened = false;
    while (!exited && Date.now() < deadline) {
      if (await portOpen(this.appPort)) listened = true;
      await sleep(200);
    }
    if (!exited) { proc.kill('SIGKILL'); await sleep(300); }
    return { exited: Boolean(exited), code: exited?.code ?? null, output, listened };
  }

  /** Every recorded non-local connection attempt so far. */
  egress() {
    if (!fs.existsSync(this.egressLog)) return [];
    return fs.readFileSync(this.egressLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  async destroy() {
    await this.stop().catch(() => undefined);
    await this.stopRedis().catch(() => undefined);
    this.stopPg('immediate');
  }
}
