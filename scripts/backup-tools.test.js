// scripts/backup-tools.test.js — the shipped backup/restore tools, executed.
//
// P5 found two ways the documented restore path refused every real backup:
//   SH-02  restore.sh exec'd verify-backup.sh, which git stored as 100644 →
//          "Permission denied" from a fresh checkout (and the backup image did
//          not ship either script).
//   SH-03  verify-backup.sh piped `gzip -cd | head | grep -q` under
//          `set -o pipefail`; grep -q exits at the first match, head dies of
//          SIGPIPE and the check failed for any dump larger than a pipe buffer.
// The full drill (backup.sh → empty database → restore.sh → app on restored
// data) runs against real PostgreSQL in scripts/selfhost/run.mjs; this suite
// pins the tool behaviour without a database.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

function writeDump(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text)));
  const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${sum}  ${name}\n`);
  return file;
}

function sqlDump(bytes) {
  let s = '--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\nCREATE TABLE t (v text);\n';
  while (s.length < bytes) s += `INSERT INTO t VALUES ('${crypto.randomBytes(24).toString('hex')}');\n`;
  return s;
}

const run = (script, args, env = {}) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('verify-backup.sh accepts a real-sized SQL dump (SH-03: no SIGPIPE false rejection)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  for (const size of [2_000, 1_200_000]) {
    const dump = writeDump(dir, `bridge_${size}.sql.gz`, sqlDump(size));
    const r = run(path.join(REPO, 'backup/verify-backup.sh'), [dump]);
    assert.equal(r.status, 0, `size ${size}: ${r.stderr}`);
    assert.match(r.stdout, /BACKUP_VERIFY=PASS/);
  }
});

test('verify-backup.sh still refuses opaque or tampered data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const opaque = writeDump(dir, 'bridge_opaque.sql.gz', crypto.randomBytes(400_000).toString('base64'));
  assert.equal(run(path.join(REPO, 'backup/verify-backup.sh'), [opaque]).status, 65);

  const tampered = writeDump(dir, 'bridge_tampered.sql.gz', sqlDump(10_000));
  fs.appendFileSync(tampered, zlib.gzipSync(Buffer.from('-- appended\n')));
  assert.notEqual(run(path.join(REPO, 'backup/verify-backup.sh'), [tampered]).status, 0, 'checksum mismatch must fail');
});

test('restore.sh runs its verifier without relying on the exec bit (SH-02) and stays gated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  for (const f of ['restore.sh', 'verify-backup.sh']) {
    fs.copyFileSync(path.join(REPO, 'backup', f), path.join(dir, f));
    fs.chmodSync(path.join(dir, f), 0o644); // as a copy or an archive without modes would be
  }
  const dump = writeDump(dir, 'bridge_x.sql.gz', sqlDump(300_000));
  const dry = run(path.join(dir, 'restore.sh'), [dump], { BRIDGE_RESTORE_DRY_RUN: 'true' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /RESTORE_DRY_RUN=PASS/);
  const ungated = run(path.join(dir, 'restore.sh'), [dump], { BRIDGE_RESTORE_DRY_RUN: 'false', BRIDGE_RESTORE_CONFIRM: '' });
  assert.equal(ungated.status, 77, 'restore without BRIDGE_RESTORE_CONFIRM=RESTORE must refuse');
});

test('the backup image ships the restore half and the scripts are executable in git', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'backup/Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY restore\.sh \/usr\/local\/bin\/restore\.sh/);
  assert.match(dockerfile, /COPY verify-backup\.sh \/usr\/local\/bin\/verify-backup\.sh/);
  const modes = spawnSync('git', ['ls-files', '-s', 'backup/'], { cwd: REPO, encoding: 'utf8' }).stdout;
  for (const f of ['backup.sh', 'restore.sh', 'verify-backup.sh', 'scheduler.sh']) {
    assert.match(modes, new RegExp(`^100755 \\S+ \\d+\\s+backup/${f.replace('.', '\\.')}$`, 'm'), `${f} must be 100755 in git`);
  }
});
