// scripts/medialab/lib/turn.mjs
//
// A real coturn TURN server for the media lab, using the same shared-secret
// (REST API / `use-auth-secret`) scheme Bridge issues credentials for
// (server/lib/turnConfig.ts). TLS/DTLS listeners are disabled: the lab has no
// certificate a browser would accept, so `turns:` is NOT exercised here.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { TURN_IP } from './net.mjs';

export const TURN_PORT = 3478;

export class Turn {
  constructor(workDir) {
    this.workDir = workDir;
    this.secret = crypto.randomBytes(24).toString('hex');
    this.proc = null;
    this.history = [];
  }

  static available() {
    return spawnSync('sh', ['-c', 'command -v turnserver'], { encoding: 'utf8' }).status === 0;
  }

  version() {
    const r = spawnSync('turnserver', ['--version'], { encoding: 'utf8' });
    return (r.stdout || r.stderr || '').trim().split('\n')[0];
  }

  /** `faketime` (e.g. '+25h') runs coturn with a shifted clock: REST-API
   *  credentials issued "now" by Bridge then look expired to coturn. */
  async start({ faketime } = {}) {
    if (this.proc && !this.proc.exitCode) return;
    const log = path.join(this.workDir, 'logs', 'coturn.log');
    const args = [
      '-n', '--no-cli', '--no-tls', '--no-dtls',
      `--listening-ip=${TURN_IP}`, `--relay-ip=${TURN_IP}`, `--listening-port=${TURN_PORT}`,
      '--min-port=50000', '--max-port=50999',
      '--use-auth-secret', `--static-auth-secret=${this.secret}`, '--realm=bridge.medialab',
      '--fingerprint', '--no-multicast-peers', '--simple-log', '--verbose', `--log-file=${log}`,
      // mediasoup lives on another address of this host; private ranges are
      // coturn's default "allowed" set, loopback is explicitly not needed.
      '--pidfile', path.join(this.workDir, 'coturn.pid'),
    ];
    this.proc = faketime
      ? spawn('faketime', ['-f', faketime, 'turnserver', ...args], { stdio: 'ignore' })
      : spawn('turnserver', args, { stdio: 'ignore' });
    this.history.push({ event: faketime ? `start(faketime ${faketime})` : 'start', at: Date.now() });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await tcpOpen(TURN_IP, TURN_PORT)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('coturn did not start');
  }

  stop(signal = 'SIGKILL') {
    if (!this.proc) return;
    try { this.proc.kill(signal); } catch { /* gone */ }
    this.proc = null;
    this.history.push({ event: `stop:${signal}`, at: Date.now() });
  }

  /** Allocations currently held, from coturn's own log (evidence only). */
  logTail(lines = 200) {
    try {
      const all = fs.readFileSync(path.join(this.workDir, 'logs', 'coturn.log'), 'utf8').split('\n');
      return all.slice(-lines);
    } catch { return []; }
  }

  /** Counts of allocation/auth events in coturn's verbose log (no credentials). */
  logSummary() {
    let text = '';
    try { text = fs.readFileSync(path.join(this.workDir, 'logs', 'coturn.log'), 'utf8'); } catch { /* none */ }
    const lines = text.split('\n');
    const count = (re) => lines.filter((l) => re.test(l)).length;
    return {
      allocateOk: count(/ALLOCATE processed, success/),
      allocateError: count(/ALLOCATE processed, error/),
      unauthorized: count(/processed, error 401|error 401|Unauthorized/),
      staleOrExpired: count(/error 438|Stale|expired/i),
      permissionOk: count(/CREATE_PERMISSION processed, success/),
      channelBindOk: count(/CHANNEL_BIND processed, success/),
      sessionsClosed: count(/closed \(2nd stage\)/),
      tcpRelayed: count(/TCP|tcp/),
    };
  }
}

function tcpOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}
