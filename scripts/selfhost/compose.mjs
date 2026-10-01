#!/usr/bin/env node
// scripts/selfhost/compose.mjs — the documented Docker Compose install, exercised.
//
//   node scripts/selfhost/compose.mjs [--out DIR] [--keep]
//
// Builds the real images from this checkout (Dockerfile, backup/Dockerfile),
// writes the `.env` the docs ask an operator to write (generated secrets, no
// defaults), runs `docker compose up`, then proves: health, the complete
// migration chain, a functional smoke through the published port, data
// surviving `docker compose restart bridge`, and backup → empty database →
// restore with the tools inside the backup container. Same statuses as run.mjs.
// Needs Docker with network access to the image registries (CI).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO, sleep, waitFor } from './lib/instance.mjs';
import { seed, verify } from './lib/fixture.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const keep = args.includes('--keep');
const outDir = opt('out', fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-compose-')));
fs.mkdirSync(outDir, { recursive: true });
const PROJECT = 'bridgeselfhost';
const BASE = 'http://127.0.0.1:3001';

const results = [];
const record = (id, name, status, detail = '') => {
  results.push({ scenario: 'compose', id, name, status, detail });
  console.log(`  [${status.padEnd(8)}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
};

const hex = (n) => crypto.randomBytes(n).toString('hex');
const envFile = path.join(outDir, 'selfhost.env');
// What docs/DEPLOYMENT.md asks for: every secret generated, nothing defaulted.
fs.writeFileSync(envFile, [
  `POSTGRES_PASSWORD=${hex(24)}`,
  `JWT_SECRET=${hex(32)}`,
  `REFRESH_SECRET=${hex(32)}`,
  `FEDERATION_SECRET=${hex(32)}`,
  `AP_ENCRYPTION_KEY=${hex(32)}`,
  `METRICS_SECRET=${hex(16)}`,
  // MinIO is a profile (not started) but compose interpolates its variables.
  `MINIO_ACCESS_KEY=selfhost${hex(4)}`,
  `MINIO_SECRET_KEY=${hex(16)}`,
  'ALLOWED_ORIGINS=http://localhost:3001',
  // A 10 000-port UDP publish range makes `docker compose up` take minutes on a
  // CI runner; the SFU range itself is not under test here.
  'MEDIASOUP_RTC_MIN_PORT=40000',
  'MEDIASOUP_RTC_MAX_PORT=40009',
  '',
].join('\n'));

function compose(cmdArgs, { input, allowFail = false, timeoutMs = 20 * 60_000 } = {}) {
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '--env-file', envFile, '-f', path.join(REPO, 'docker-compose.yml'), ...cmdArgs], {
    cwd: REPO, encoding: 'utf8', input, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  fs.appendFileSync(path.join(outDir, 'compose.log'), `\n$ docker compose ${cmdArgs.join(' ')}\n${r.stdout || ''}${r.stderr || ''}`);
  if (r.status !== 0 && !allowFail) throw new Error(`docker compose ${cmdArgs.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(-600)}`);
  return r;
}

const psql = (sql) => compose(['exec', '-T', 'postgres', 'psql', '-U', 'bridge', '-d', 'bridge', '-tAc', sql]).stdout.trim();
const ready = async () => (await fetch(`${BASE}/api/health/ready`).catch(() => null))?.status === 200;

let exitCode = 0;
try {
  const t0 = Date.now();
  compose(['build', 'bridge', 'backup']);
  record('SH-COMPOSE-01', 'images build from this checkout (Dockerfile, backup/Dockerfile)', 'PASS', `${Math.round((Date.now() - t0) / 1000)} s`);

  const t1 = Date.now();
  compose(['up', '-d', 'postgres', 'redis', 'bridge', 'backup']);
  await waitFor(ready, { timeoutMs: 5 * 60_000, intervalMs: 1000, label: 'bridge ready via the published port' });
  record('SH-COMPOSE-02', '`docker compose up` → /api/health/ready = 200 on the published port', 'PASS', `${Math.round((Date.now() - t1) / 1000)} s`);

  const files = fs.readdirSync(path.join(REPO, 'server/db/migrations_pg')).filter((f) => f.endsWith('.sql')).length;
  const applied = Number(psql('SELECT count(*) FROM schema_migrations WHERE rolled_back = FALSE'));
  record('SH-COMPOSE-03', 'the image applied the whole versioned migration chain at boot (SH-01)', applied === files ? 'PASS' : 'FAIL', `${applied}/${files}`);

  const fixture = await seed(BASE, 'dc');
  record('SH-COMPOSE-04', 'functional smoke through the published port (users, server, channel, message, DM, upload)', 'PASS');
  for (const c of await verify(BASE, fixture)) record('SH-COMPOSE-V1', c.check, c.ok ? 'PASS' : 'FAIL', c.detail);

  compose(['restart', 'bridge']);
  await sleep(2000);
  await waitFor(ready, { timeoutMs: 3 * 60_000, intervalMs: 1000, label: 'ready after restart' });
  record('SH-COMPOSE-05', '`docker compose restart bridge` → ready again', 'PASS');
  for (const c of await verify(BASE, fixture)) record('SH-COMPOSE-V2', `after restart: ${c.check}`, c.ok ? 'PASS' : 'FAIL', c.detail);

  // Backup with the shipped container, then lose the database and the uploads.
  const marker = `marker-${hex(4)}`;
  psql(`CREATE TABLE IF NOT EXISTS selfhost_marker (v TEXT); INSERT INTO selfhost_marker VALUES ('${marker}')`);
  const b = compose(['exec', '-T', 'backup', 'backup.sh'], { allowFail: true });
  const dump = (compose(['exec', '-T', 'backup', 'sh', '-c', 'ls -1t /backups/postgres/*.sql.gz | head -1']).stdout || '').trim();
  record('SH-COMPOSE-06', '`docker compose exec backup backup.sh` writes a verified dump + uploads copy', b.status === 0 && dump ? 'PASS' : 'FAIL', dump || (b.stderr || '').slice(-300));

  compose(['stop', 'bridge']);
  compose(['exec', '-T', 'postgres', 'psql', '-U', 'bridge', '-d', 'postgres', '-c', 'DROP DATABASE bridge WITH (FORCE)']);
  compose(['exec', '-T', 'postgres', 'psql', '-U', 'bridge', '-d', 'postgres', '-c', 'CREATE DATABASE bridge OWNER bridge']);
  compose(['run', '--rm', '--no-deps', '--entrypoint', 'sh', 'bridge', '-c', 'rm -rf /app/server/uploads/*'], { allowFail: true });
  record('SH-COMPOSE-07', 'database dropped and recreated empty, uploads volume emptied', psql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'") === '0' ? 'PASS' : 'FAIL');

  const r = compose(['exec', '-T', '-e', 'BRIDGE_RESTORE_CONFIRM=RESTORE', 'backup', 'restore.sh', dump], { allowFail: true });
  record('SH-COMPOSE-08', '`docker compose exec backup restore.sh <dump>` (SH-02, SH-03)', r.status === 0 && /RESTORE=PASS/.test(r.stdout) ? 'PASS' : 'FAIL', r.status === 0 ? '' : (r.stderr || r.stdout).slice(-300));
  // docs/BACKUP-RESTORE.md §5: uploads after the database. The backup container
  // mounts the uploads volume read-only, so the copy-back runs in a one-off
  // container that mounts both volumes.
  // The backup copy is ownerless (rsync --no-owner); files must come back owned by
  // the app's unprivileged user or the app cannot read protected attachments.
  const uid = compose(['run', '--rm', '--no-deps', '--entrypoint', 'id', 'bridge', '-u']).stdout.trim();
  const gid = compose(['run', '--rm', '--no-deps', '--entrypoint', 'id', 'bridge', '-g']).stdout.trim();
  const u = spawnSync('docker', ['run', '--rm', '-v', `${PROJECT}_backup_data:/backups:ro`, '-v', `${PROJECT}_uploads_data:/uploads`,
    `${PROJECT}-backup`, 'rsync', '-a', `--chown=${uid}:${gid}`, '/backups/uploads/', '/uploads/'], { encoding: 'utf8' });
  record('SH-COMPOSE-09', 'uploads copied back from the backup volume', u.status === 0 ? 'PASS' : 'FAIL', (u.stderr || '').slice(-300));
  record('SH-COMPOSE-10', 'restored database carries the marker written before the backup', psql('SELECT v FROM selfhost_marker') === marker ? 'PASS' : 'FAIL');

  compose(['start', 'bridge']);
  await waitFor(ready, { timeoutMs: 3 * 60_000, intervalMs: 1000, label: 'ready on restored data' });
  record('SH-COMPOSE-11', 'bridge ready on the restored data', 'PASS');
  for (const c of await verify(BASE, fixture)) record('SH-COMPOSE-V3', `after restore: ${c.check}`, c.ok ? 'PASS' : 'FAIL', c.detail);
} catch (err) {
  record('SH-COMPOSE-X', 'compose run aborted', 'FAIL', err.stack || String(err));
} finally {
  compose(['logs', '--no-color', 'bridge'], { allowFail: true, timeoutMs: 60_000 });
  if (!keep) compose(['down', '-v', '--remove-orphans'], { allowFail: true, timeoutMs: 5 * 60_000 });
  const counts = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), platform: 'compose', counts, results }, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), ['# Self-host evidence (Docker Compose)', '',
    `**${counts.PASS || 0} PASS, ${counts.FAIL || 0} FAIL, ${counts.BLOCKED || 0} BLOCKED**`, '',
    '| ID | Check | Status | Detail |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`)].join('\n') + '\n');
  console.log(`\nTOTAL ${JSON.stringify(counts)}  report: ${path.join(outDir, 'report.md')}`);
  if (results.some((r) => r.status === 'FAIL') || !results.some((r) => r.id === 'SH-COMPOSE-11')) exitCode = 1;
}
process.exit(exitCode);
