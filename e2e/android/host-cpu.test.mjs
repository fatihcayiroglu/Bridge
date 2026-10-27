// Host CPU contention sampler (#209): pure parsers and the live /proc sampler.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOST_CPU_CLASSES, hostCpuClass, intervalShares, parseLoadavg, parsePidStat, parseProcStatTotals,
  startHostCpuSampler, summarizeHostCpu,
} from './host-cpu.mjs';

test('classifies host processes into fixed categories only', () => {
  assert.equal(hostCpuClass('qemu-system-x86', 10, 1), 'emulator');
  assert.equal(hostCpuClass('node', 1, 1), 'harness');
  assert.equal(hostCpuClass('node', 2, 1), 'node_other');
  assert.equal(hostCpuClass('postgres', 3, 1), 'postgres');
  assert.equal(hostCpuClass('redis-server', 4, 1), 'redis');
  assert.equal(hostCpuClass('mediasoup-worker', 5, 1), 'mediasoup');
  assert.equal(hostCpuClass('bash', 6, 1), 'other');
  for (const c of ['qemu-system-x86', 'node', 'x']) assert.ok(HOST_CPU_CLASSES.includes(hostCpuClass(c, 9, 1)));
});

test('parses /proc/stat, /proc/<pid>/stat (comm with spaces and parens) and /proc/loadavg', () => {
  assert.deepEqual(parseProcStatTotals('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n'), { total: 1000, idle: 850 });
  assert.equal(parseProcStatTotals('nothing'), null);
  const line = '1234 (qemu (x) y) S 1 1 1 0 -1 4194560 0 0 0 0 700 300 0 0 20 0 9 0 5 0 0';
  assert.deepEqual(parsePidStat(line), { comm: 'qemu (x) y', cpu: 1000 });
  assert.equal(parsePidStat('garbage'), null);
  assert.deepEqual(parseLoadavg('3.50 2.00 1.25 4/500 999\n'), [3.5, 2, 1.25]);
});

test('interval shares: busy % of all cores and per-category share; new processes count from first sight', () => {
  const a = { totals: { total: 1000, idle: 800 }, perPid: new Map([['10', { klass: 'emulator', cpu: 100 }], ['11', { klass: 'postgres', cpu: 50 }]]) };
  const b = { totals: { total: 2000, idle: 1100 }, perPid: new Map([
    ['10', { klass: 'emulator', cpu: 600 }], ['11', { klass: 'postgres', cpu: 60 }], ['12', { klass: 'other', cpu: 40 }]]) };
  const r = intervalShares(a, b);
  assert.equal(r.busyPct, 70);
  assert.equal(r.byClass.emulator, 50);
  assert.equal(r.byClass.postgres, 1);
  assert.equal(r.byClass.other, 0, 'a process first seen in b has no measured interval');
  assert.equal(intervalShares(a, a), null, 'no elapsed time, no share');
  const s = summarizeHostCpu([r, { busyPct: 100, byClass: { ...r.byClass, emulator: 80 } }, null], 4, [5, 4, 3]);
  assert.equal(s.intervals, 2);
  assert.equal(s.saturatedIntervals, 1);
  assert.deepEqual(s.busyPct, { avg: 85, max: 100, p90: 100 });
  assert.equal(s.byClassAvgPct.emulator, 65);
  assert.deepEqual(s.loadEnd, [5, 4, 3]);
});

test('live sampler over a fake /proc measures a known busy process and emits no names or pids', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  let total = 1000; let idle = 900; let emu = 0;
  const flush = () => {
    write('stat', `cpu  ${total - idle} 0 0 ${idle} 0 0 0 0\n`);
    write('4242/stat', `4242 (qemu-system-x86) S 1 1 1 0 -1 0 0 0 0 0 ${emu} 0 0 0 20 0 1 0 1 0 0`);
    write('loadavg', '9.00 5.00 2.00 3/300 4242\n');
  };
  flush();
  const sampler = startHostCpuSampler({ intervalMs: 20, procRoot: root, selfPid: 1, cores: 4 });
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    total += 100; idle += 20; emu += 60; flush();
  }
  const s = sampler.stop();
  assert.equal(sampler.stop(), s, 'stop() is idempotent');
  assert.equal(s.available, true);
  assert.ok(s.intervals >= 3, `intervals ${s.intervals}`);
  assert.equal(s.busyPct.max, 80);
  assert.equal(s.byClassAvgPct.emulator > 0, true);
  assert.deepEqual(s.loadEnd, [9, 5, 2]);
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /qemu|4242/);
});
