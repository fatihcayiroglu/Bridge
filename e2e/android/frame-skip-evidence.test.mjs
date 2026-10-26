import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChoreographerSkips, summarizeStartupSkips } from './frame-skip-evidence.mjs';

const line = (pid, frames) =>
  `I/Choreographer( ${pid}): Skipped ${frames} frames!  The application may be doing too much work on its main thread.`;

test('#209 counts Choreographer stalls for the exact app PID only', () => {
  const raw = [line(4321, 123), line(4321, 31), line(999, 400),
    'I/Choreographer( 4321): Frame time is 12.5 ms in the future!', 'garbage Choreographer line'].join('\n');
  assert.deepEqual(parseChoreographerSkips(raw, '4321'), {
    available: true, reports: 2, totalFrames: 154, maxFrames: 123, foreignPidLines: 1, unparsedLines: 1,
  });
});

test('#209 zero reports is "no stall at or above the limit", and bad input is unavailable', () => {
  assert.equal(parseChoreographerSkips('', '4321').reports, 0);
  assert.equal(parseChoreographerSkips('', '4321').available, true);
  assert.equal(parseChoreographerSkips(undefined, '4321').available, false);
  assert.equal(parseChoreographerSkips(line(1, 50), 'not-a-pid').available, false);
});

test('#209 the summary is measurement only and keeps unknown starts out of the counts', () => {
  const summary = summarizeStartupSkips([
    { skippedFrames: parseChoreographerSkips(line(1, 123), '1') },
    { skippedFrames: parseChoreographerSkips('', '2') },
    { skippedFrames: null },
  ]);
  assert.deepEqual({ ...summary, limitNote: undefined }, {
    coldStarts: 3, measured: 2, startsWithStall: 1, maxFrames: 123, totalReports: 1, unparsedLines: 0, limitNote: undefined,
  });
  assert.match(summary.limitNote, /SKIPPED_FRAME_WARNING_LIMIT/);
});

test('#209 CS01 records stalls without changing its assertions, and SF01 is a measurement', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const cs01 = source.slice(source.indexOf("await check('CS01'"), source.indexOf("await check('A02'"));
  assert.match(cs01, /skippedFrames: await startupSkips\(initialPid\)/);
  assert.match(cs01, /assert\(finalPid === initialPid,/);
  assert.match(cs01, /assert\(newAnrs === baselineAnrs,/);
  assert.doesNotMatch(cs01, /assert\([^)]*skippedFrames/);
  assert.match(source, /await measure\('SF01', /);
});
