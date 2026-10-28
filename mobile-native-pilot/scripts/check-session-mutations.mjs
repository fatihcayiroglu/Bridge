import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { classifyNodeRun } from './mutation-result.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? 'mutation-evidence');
mkdirSync(output, { recursive: false }); // never overwrite earlier evidence
const source = join(root, 'src/session-coordinator.mjs');
const rawOriginal = readFileSync(source, 'utf8');
const original = rawOriginal.replaceAll('\r\n', '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const cases = [
  ['baseline', null, null],
  ['epoch-fence', 'const current = (mine) => mine === epoch;', 'const current = (mine) => true;'],
  ['single-flight', 'if (flight && flight.epoch === epoch) return flight.promise;', '/* mutation: no single flight */'],
  ['clear-access-at-transition', '    accessToken = null;\n    refreshToken = null;\n    userId = null;\n    flight = null;\n    phase = nextPhase;', '    refreshToken = null;\n    userId = null;\n    flight = null;\n    phase = nextPhase;'],
];
const results = [];
for (const [name, before, after] of cases) {
  if (before && original.split(before).length !== 2) throw new Error(`Mutation not uniquely applicable: ${name}`);
  const isolated = mkdtempSync(join(tmpdir(), 'bridge-session-mutation-'));
  cpSync(join(root, 'src'), join(isolated, 'src'), { recursive: true });
  cpSync(join(root, 'tests'), join(isolated, 'tests'), { recursive: true });
  writeFileSync(join(isolated, 'src/session-coordinator.mjs'), before ? original.replace(before, after) : original);
  const args = ['--test', '--test-reporter=tap', 'tests/session-coordinator.test.mjs'];
  const run = spawnSync(process.execPath, args, { cwd: isolated, encoding: 'utf8', timeout: 15000 });
  writeFileSync(join(output, `${name}.stdout.log`), run.stdout ?? '');
  writeFileSync(join(output, `${name}.stderr.log`), run.stderr ?? '');
  results.push({ name, ...classifyNodeRun(run), status: run.status, signal: run.signal, error: run.error?.code,
    sourceSha256: hash(readFileSync(join(isolated, 'src/session-coordinator.mjs'))), command: [process.execPath, ...args], cwd: isolated });
}
const unchanged = hash(readFileSync(source)) === hash(rawOriginal);
const report = { schema: 1, sourceSha256: hash(rawOriginal), sourceUnchanged: unchanged, results,
  limitation: 'Three explicitly defined mutations; original untracked 11-case harness was unavailable. The clear-access survivor is not exposed by phase-gated getSession(); this is not 100% mutation coverage.' };
writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = unchanged && results[0].outcome === 'SURVIVED' && results.slice(1).every(r => r.outcome === 'DETECTED') ? 0 : 1;
