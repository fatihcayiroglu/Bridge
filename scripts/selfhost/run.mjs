#!/usr/bin/env node
// scripts/selfhost/run.mjs — self-hosting evidence against real processes.
//
//   node scripts/selfhost/run.mjs [--scenarios fresh,smoke,restart,config,upgrade,backup,egress]
//                                 [--previous DIR] [--work DIR] [--out DIR]
//
// Every check is PASS / FAIL / BLOCKED / SKIPPED / MEASURED. Only PASS passes.
// Exit code 0 only when no check FAILed. See README.md in this directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Instance, REPO, EGRESS_GUARD, sleep } from './lib/instance.mjs';
import { seed, verify } from './lib/fixture.mjs';
import { request } from '../multinode/lib/client.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const ALL = ['fresh', 'smoke', 'restart', 'config', 'upgrade', 'backup', 'egress'];
const selected = opt('scenarios', ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const workDir = opt('work', fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-selfhost-')));
const outDir = opt('out', path.join(workDir, 'report'));
const previousDir = opt('previous', process.env.SELFHOST_PREVIOUS_DIR || '');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const record = (scenario, id, name, status, detail = '', data) => {
  if (!['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'MEASURED'].includes(status)) throw new Error(`bad status ${status}`);
  results.push({ scenario, id, name, status, detail, ...(data !== undefined ? { data } : {}) });
  console.log(`  [${status.padEnd(8)}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
};

const MIGRATION_FILES = fs.readdirSync(path.join(REPO, 'server/db/migrations_pg')).filter((f) => f.endsWith('.sql')).sort();
// Tables only the versioned chain creates (SH-01: all four were missing on a fresh boot).
const CHAIN_TABLES = ['ap_delivery_queue', 'ap_follows', 'oauth_tokens', 'server_boosts'];

function errorLinesMentioningMissingSchema(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => {
    if (!/does not exist/.test(l)) return false;
    try { return JSON.parse(l).level >= 40; } catch { return false; }
  });
}

const instances = [];
let base = 56100; // port block for this run
const newInstance = (name, env) => {
  const inst = new Instance({ name, workDir, pgPort: base + 1, redisPort: base + 2, appPort: base + 3, env });
  base += 10;
  instances.push(inst);
  return inst;
};

let main; // the fresh installation shared by fresh/smoke/restart/backup
let fixture;

async function ensureMain() {
  if (main) return main;
  main = newInstance('cleanroom');
  await main.startPg({ fresh: true });
  await main.startRedis();
  return main;
}

const scenarios = {
  async fresh() {
    const inst = await ensureMain();
    let boot;
    try { boot = await inst.start({ tag: 'fresh' }); } catch (e) { record('fresh', 'SH-FRESH-01', 'fresh install boots to ready', 'FAIL', e.message); return; }
    record('fresh', 'SH-FRESH-01', 'fresh install boots to ready (production build, NODE_ENV=production)', 'PASS', `${boot.bootMs} ms`);
    record('fresh', 'SH-FRESH-M1', 'boot → ready on an empty database', 'MEASURED', `${boot.bootMs} ms`);
    const applied = Number(inst.psql('bridge', 'SELECT count(*) FROM schema_migrations WHERE rolled_back = FALSE'));
    record('fresh', 'SH-FRESH-02', 'versioned migration chain fully applied by boot (SH-01)', applied === MIGRATION_FILES.length ? 'PASS' : 'FAIL',
      `${applied}/${MIGRATION_FILES.length} applied`);
    const missing = CHAIN_TABLES.filter((t) => inst.psql('bridge', `SELECT to_regclass('public.${t}') IS NULL`) === 't');
    record('fresh', 'SH-FRESH-03', 'tables created only by the chain exist', missing.length === 0 ? 'PASS' : 'FAIL', missing.length ? `missing: ${missing.join(', ')}` : CHAIN_TABLES.join(', '));
    const bad = errorLinesMentioningMissingSchema(boot.log);
    record('fresh', 'SH-FRESH-04', 'no warn/error log line about a missing table or column', bad.length === 0 ? 'PASS' : 'FAIL', bad.length ? bad[0].slice(0, 300) : '');
    // FED-01 / SH-04: the first boot's schema must already be the final one. A
    // difference means some statement only succeeds once a later step has run.
    const snapshot = () => inst.psql('bridge', `
      SELECT 'col ' || table_name || '.' || column_name || ' ' || data_type FROM information_schema.columns WHERE table_schema = 'public'
      UNION ALL SELECT 'idx ' || indexname FROM pg_indexes WHERE schemaname = 'public'
      UNION ALL SELECT 'con ' || conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
      ORDER BY 1`).split('\n');
    const first = snapshot();
    await inst.stop();
    await inst.start({ tag: 'second-boot' });
    const second = snapshot();
    const added = second.filter((x) => !first.includes(x));
    const removed = first.filter((x) => !second.includes(x));
    record('fresh', 'SH-FRESH-05', 'a second boot changes nothing in the schema (columns, indexes, constraints)', added.length === 0 && removed.length === 0 ? 'PASS' : 'FAIL',
      added.length || removed.length ? `second boot added ${JSON.stringify(added.slice(0, 5))} removed ${JSON.stringify(removed.slice(0, 5))}` : `${first.length} objects identical`);
  },

  async smoke() {
    const inst = await ensureMain();
    if (!inst.app || inst.app.exited) await inst.start({ tag: 'smoke' });
    try {
      fixture = await seed(inst.base, 'sh');
      record('smoke', 'SH-SMOKE-01', 'register 2 users, server + channel + invite, channel message, DM, upload (product API)', 'PASS');
    } catch (e) {
      record('smoke', 'SH-SMOKE-01', 'seed the dataset through the product API', 'FAIL', e.message);
      return;
    }
    for (const c of await verify(inst.base, fixture)) record('smoke', 'SH-SMOKE-V', c.check, c.ok ? 'PASS' : 'FAIL', c.detail);
    const info = await request(inst.base, 'GET', '/api/federation/info');
    record('smoke', 'SH-SMOKE-02', 'federation identity endpoint answers with a public key', info.status === 200 && info.body?.software === 'bridge' && /BEGIN PUBLIC KEY/.test(info.body?.publicKey?.publicKeyPem || '') ? 'PASS' : 'FAIL', `status ${info.status}`);
  },

  async restart() {
    const inst = await ensureMain();
    if (!fixture) { record('restart', 'SH-RESTART-00', 'needs the smoke dataset', 'BLOCKED', 'smoke did not seed'); return; }
    const stopped = await inst.stop({ signal: 'SIGTERM', timeoutMs: 30_000 });
    record('restart', 'SH-RESTART-01', 'SIGTERM → graceful exit with code 0', stopped && stopped.code === 0 && !stopped.forced ? 'PASS' : 'FAIL', JSON.stringify(stopped));
    record('restart', 'SH-RESTART-M1', 'SIGTERM → process exit', 'MEASURED', `${stopped?.ms} ms`);
    let boot;
    try { boot = await inst.start({ tag: 'restart' }); } catch (e) { record('restart', 'SH-RESTART-02', 'restarts to ready', 'FAIL', e.message); return; }
    record('restart', 'SH-RESTART-02', 'restarts to ready on the existing database', 'PASS', `${boot.bootMs} ms`);
    for (const c of await verify(inst.base, fixture)) record('restart', 'SH-RESTART-V', c.check, c.ok ? 'PASS' : 'FAIL', c.detail);
  },

  async config() {
    const inst = await ensureMain();
    const wasRunning = inst.app && !inst.app.exited;
    if (wasRunning) await inst.stop();
    const cases = [
      { id: 'SH-CONFIG-01', name: 'JWT_SECRET missing', unset: ['JWT_SECRET'], expect: /JWT_SECRET/ },
      { id: 'SH-CONFIG-02', name: 'JWT_SECRET shorter than 32 characters', env: { JWT_SECRET: 'short' }, expect: /JWT_SECRET/ },
      { id: 'SH-CONFIG-03', name: 'REDIS_URL missing in production', unset: ['REDIS_URL'], expect: /REDIS_URL/ },
      { id: 'SH-CONFIG-04', name: 'AP_ENCRYPTION_KEY not 64 hex characters', env: { AP_ENCRYPTION_KEY: 'not-hex' }, expect: /AP_ENCRYPTION_KEY/ },
      { id: 'SH-CONFIG-05', name: 'FEDERATION_SECRET too short', env: { FEDERATION_SECRET: 'x' }, expect: /FEDERATION_SECRET/ },
      { id: 'SH-CONFIG-06', name: 'METRICS_SECRET missing', unset: ['METRICS_SECRET'], expect: /METRICS_SECRET/ },
      { id: 'SH-CONFIG-07', name: 'DATABASE_URL not a PostgreSQL URL', env: { DATABASE_URL: 'mysql://root@127.0.0.1/bridge' }, expect: /DATABASE_URL/ },
      { id: 'SH-CONFIG-08', name: 'ALLOWED_ORIGINS contains an invalid URL', env: { ALLOWED_ORIGINS: 'not a url' }, expect: /ALLOWED_ORIGINS/ },
      { id: 'SH-CONFIG-09', name: 'PostgreSQL unreachable', env: { DATABASE_URL: `postgresql://bridge:x@127.0.0.1:${inst.pgPort + 7}/bridge` }, expect: /ECONNREFUSED|connect|database/i, timeoutMs: 60_000 },
    ];
    for (const c of cases) {
      const r = await inst.bootExpectingRefusal(c.env || {}, { unset: c.unset || [], timeoutMs: c.timeoutMs || 30_000 });
      const ok = r.exited && r.code !== 0 && !r.listened && c.expect.test(r.output);
      record('config', c.id, `refuses to start: ${c.name}`, ok ? 'PASS' : 'FAIL',
        `exited=${r.exited} code=${r.code} listened=${r.listened} names-it=${c.expect.test(r.output)}`);
    }
    if (wasRunning) await inst.start({ tag: 'after-config' });
  },

  async upgrade() {
    if (!previousDir || !fs.existsSync(path.join(previousDir, 'server/dist/index.js'))) {
      record('upgrade', 'SH-UPGRADE-00', 'previous release available (built checkout)', 'BLOCKED', 'pass --previous DIR (a built checkout of the previous release)');
      return;
    }
    const prevVersion = JSON.parse(fs.readFileSync(path.join(previousDir, 'package.json'), 'utf8')).version;
    const curVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
    for (const variant of ['documented', 'boot-only']) {
      const inst = newInstance(`upgrade-${variant}`);
      await inst.startPg({ fresh: true });
      await inst.startRedis();
      const sid = `SH-UPGRADE-${variant === 'documented' ? 'D' : 'B'}`;
      try {
        await inst.start({ releaseDir: previousDir, tag: `previous-${variant}` });
      } catch (e) { record('upgrade', `${sid}1`, `previous release ${prevVersion} boots`, 'FAIL', e.message); continue; }
      if (variant === 'documented') {
        // What the previous release's DEPLOYMENT_GUIDE told operators to run.
        const r = spawnSync(process.execPath, ['server/dist/db/migrate-postgres.js', 'up'], { cwd: previousDir, env: inst.env(), encoding: 'utf8' });
        if (r.status !== 0) { record('upgrade', `${sid}1`, `previous release ${prevVersion}: documented migrate-postgres up`, 'FAIL', (r.stderr || r.stdout).slice(-300)); continue; }
      }
      record('upgrade', `${sid}1`, `previous release ${prevVersion} installed (${variant === 'documented' ? 'boot + its documented migrate step' : 'boot only, as its image did'})`, 'PASS');
      let fx;
      try { fx = await seed(inst.base, `up${variant[0]}`); record('upgrade', `${sid}2`, `data created on ${prevVersion} through its API`, 'PASS'); }
      catch (e) { record('upgrade', `${sid}2`, `data created on ${prevVersion} through its API`, 'FAIL', e.message); await inst.stop(); continue; }
      await inst.stop();
      let boot;
      try { boot = await inst.start({ tag: `upgraded-${variant}` }); }
      catch (e) { record('upgrade', `${sid}3`, `${curVersion} (this build) boots on the ${prevVersion} database`, 'FAIL', e.message); continue; }
      const applied = Number(inst.psql('bridge', 'SELECT count(*) FROM schema_migrations WHERE rolled_back = FALSE'));
      record('upgrade', `${sid}3`, `this build boots on the ${prevVersion} database and completes the chain`, applied === MIGRATION_FILES.length ? 'PASS' : 'FAIL', `${boot.bootMs} ms, ${applied}/${MIGRATION_FILES.length} applied`);
      for (const c of await verify(inst.base, fx)) record('upgrade', `${sid}V`, `[${variant}] ${c.check}`, c.ok ? 'PASS' : 'FAIL', c.detail);
      await inst.stop();
    }
  },

  async backup() {
    const inst = await ensureMain();
    if (!fixture) { record('backup', 'SH-BACKUP-00', 'needs the smoke dataset', 'BLOCKED', 'smoke did not seed'); return; }
    if (!inst.app || inst.app.exited) await inst.start({ tag: 'backup' });
    const backupRoot = path.join(workDir, 'backups');
    const envBackup = {
      ...process.env,
      PATH: `${inst.pgBin}:${process.env.PATH}`,
      POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: String(inst.pgPort), POSTGRES_USER: 'bridge', POSTGRES_DB: 'bridge',
      POSTGRES_PASSWORD: `bridge-${inst.name}-pw`, BACKUP_ROOT: backupRoot, UPLOADS_DIR: `${inst.uploads}/`, S3_BUCKET: '',
    };
    // A marker written after the seed proves the restored copy is what is served.
    const marker = `marker-${Date.now()}`;
    inst.psql('bridge', `CREATE TABLE IF NOT EXISTS selfhost_marker (v TEXT); INSERT INTO selfhost_marker VALUES ('${marker}')`);
    const b = spawnSync('bash', [path.join(REPO, 'backup/backup.sh')], { env: envBackup, encoding: 'utf8' });
    const dump = fs.existsSync(path.join(backupRoot, 'postgres')) ? fs.readdirSync(path.join(backupRoot, 'postgres')).find((f) => f.endsWith('.sql.gz')) : null;
    record('backup', 'SH-BACKUP-01', 'backup/backup.sh (as shipped) dumps PostgreSQL, checksums it and copies uploads', b.status === 0 && dump ? 'PASS' : 'FAIL', b.status === 0 ? dump : (b.stderr || b.stdout).slice(-300));
    if (!dump) return;
    const dumpPath = path.join(backupRoot, 'postgres', dump);

    // Disaster: stop the app, destroy the database and the uploads.
    await inst.stop();
    inst.psql('postgres', 'DROP DATABASE bridge WITH (FORCE)');
    inst.psql('postgres', 'CREATE DATABASE bridge OWNER bridge');
    const tablesBefore = Number(inst.psql('bridge', "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"));
    fs.rmSync(inst.uploads, { recursive: true, force: true });
    fs.mkdirSync(inst.uploads, { recursive: true });
    record('backup', 'SH-BACKUP-02', 'target database recreated empty, uploads removed', tablesBefore === 0 ? 'PASS' : 'FAIL', `${tablesBefore} tables before restore`);

    const r = spawnSync('bash', [path.join(REPO, 'backup/restore.sh'), dumpPath], { env: { ...envBackup, BRIDGE_RESTORE_CONFIRM: 'RESTORE' }, encoding: 'utf8' });
    record('backup', 'SH-BACKUP-03', 'backup/restore.sh verifies the dump and restores it', r.status === 0 && /RESTORE=PASS/.test(r.stdout) ? 'PASS' : 'FAIL', r.status === 0 ? '' : (r.stderr || r.stdout).slice(-300));
    // docs/BACKUP-RESTORE.md §5: database first, then uploads.
    const u = spawnSync('rsync', ['-a', `${path.join(backupRoot, 'uploads')}/`, `${inst.uploads}/`], { encoding: 'utf8' });
    record('backup', 'SH-BACKUP-04', 'uploads restored from the backup copy (documented step)', u.status === 0 ? 'PASS' : 'FAIL', u.stderr?.slice(-200) || '');

    const served = inst.psql('bridge', 'SELECT v FROM selfhost_marker');
    record('backup', 'SH-BACKUP-05', 'restored database carries the marker written before the backup', served === marker ? 'PASS' : 'FAIL', served);
    try { await inst.start({ tag: 'restored' }); record('backup', 'SH-BACKUP-06', 'app boots to ready on the restored data', 'PASS'); }
    catch (e) { record('backup', 'SH-BACKUP-06', 'app boots to ready on the restored data', 'FAIL', e.message); return; }
    for (const c of await verify(inst.base, fixture)) record('backup', 'SH-BACKUP-V', c.check, c.ok ? 'PASS' : 'FAIL', c.detail);
  },

  async egress() {
    // Positive control: the observer must record a real non-local connect.
    const ctl = path.join(workDir, 'egress-control.jsonl');
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ['--require', EGRESS_GUARD, '-e',
        "const s=require('net').connect(443,'198.51.100.7');s.on('error',()=>{});setTimeout(()=>process.exit(0),300)"],
      { env: { PATH: process.env.PATH, BRIDGE_EGRESS_LOG: ctl }, stdio: 'ignore' });
      p.on('exit', resolve);
    });
    const ctlLines = fs.existsSync(ctl) ? fs.readFileSync(ctl, 'utf8').trim().split('\n').filter(Boolean) : [];
    record('egress', 'SH-EGRESS-00', 'positive control: the egress observer records a non-local connect', ctlLines.length === 1 && ctlLines[0].includes('198.51.100.7') ? 'PASS' : 'FAIL', `${ctlLines.length} record(s)`);
    const all = instances.flatMap((i) => i.egress().map((e) => ({ instance: i.name, ...e })));
    const ran = instances.filter((i) => i.starts > 0).map((i) => i.name);
    if (!fixture) {
      record('egress', 'SH-EGRESS-01', 'no outbound connection beyond the machine during boot + the full smoke', 'BLOCKED', 'the smoke dataset was not created; an empty log would prove nothing');
      return;
    }
    record('egress', 'SH-EGRESS-01', `no outbound connection beyond the machine during everything above (${ran.join(', ') || 'nothing ran'})`,
      ran.length && all.length === 0 ? 'PASS' : 'FAIL', all.length ? JSON.stringify(all.slice(0, 3)) : `${ran.length} installation(s) observed`);
  },
};

let exitCode = 0;
try {
  console.log(`work dir: ${workDir}`);
  for (const name of selected) {
    if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);
    console.log(`\n=== ${name} ===`);
    try { await scenarios[name](); } catch (e) { record(name, `${name}:crash`, 'scenario aborted', 'FAIL', e.stack || String(e)); }
  }
} finally {
  for (const i of instances) await i.destroy().catch(() => undefined);
  const counts = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const report = {
    generatedAt: new Date().toISOString(), node: process.version, platform: 'process',
    commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
    previous: previousDir || null, counts, results,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = ['# Self-host evidence (process platform)', '', `commit ${report.commit} · node ${report.node} · ${report.generatedAt}`, '',
    `**${counts.PASS || 0} PASS, ${counts.FAIL || 0} FAIL, ${counts.BLOCKED || 0} BLOCKED, ${counts.SKIPPED || 0} SKIPPED, ${counts.MEASURED || 0} MEASURED**`, '',
    '| Scenario | ID | Check | Status | Detail |', '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.scenario} | ${r.id} | ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`)].join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), md + '\n');
  console.log(`\nTOTAL ${JSON.stringify(counts)} (BLOCKED, SKIPPED and MEASURED are never counted as PASS)`);
  console.log(`report: ${path.join(outDir, 'report.md')}`);
  if (results.some((r) => r.status === 'FAIL')) exitCode = 1;
}
process.exit(exitCode);
