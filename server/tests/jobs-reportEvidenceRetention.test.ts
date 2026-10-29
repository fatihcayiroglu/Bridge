// server/tests/jobs-reportEvidenceRetention.test.ts
//
// P7 B5 / B3 — the report evidence retention job. The repository query itself is
// proved on mockDb (report-evidence-flow.test.ts) and on real PostgreSQL
// (pg-integration/report-evidence.pgtest.ts); this file covers the job around it:
// the cutoff it computes, the overlap guard, the failure path and the timer.

process.env.NODE_ENV = 'test';

const messageReports = { scrubEvidenceResolvedBefore: jest.fn() };
const info = jest.fn();
const error = jest.fn();

jest.mock('../db/repositories', () => ({ MessageReports: messageReports }));
jest.mock('../lib/logger', () => {
  const logger = { info, error, warn: jest.fn(), debug: jest.fn(), fatal: jest.fn(), child: () => logger };
  return { __esModule: true, default: logger, logger, createLogger: () => logger };
});

import {
  runReportEvidenceRetentionTick,
  startReportEvidenceRetentionJob,
  stopReportEvidenceRetentionJob,
} from '../jobs/reportEvidenceRetention';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS;
  messageReports.scrubEvidenceResolvedBefore.mockResolvedValue(0);
});

afterEach(() => { stopReportEvidenceRetentionJob(); jest.useRealTimers(); });

it('clears evidence resolved more than the default 90 days ago', async () => {
  messageReports.scrubEvidenceResolvedBefore.mockResolvedValue(3);
  expect(await runReportEvidenceRetentionTick(NOW)).toBe(3);
  expect(messageReports.scrubEvidenceResolvedBefore).toHaveBeenCalledWith(NOW - 90 * DAY, NOW);
  expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'moderation.report_evidence.scrubbed', count: 3 }), expect.any(String));
});

it('uses the configured window', async () => {
  process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS = '7';
  await runReportEvidenceRetentionTick(NOW);
  expect(messageReports.scrubEvidenceResolvedBefore).toHaveBeenCalledWith(NOW - 7 * DAY, NOW);
});

it('logs nothing when there was nothing to clear', async () => {
  await runReportEvidenceRetentionTick(NOW);
  expect(info).not.toHaveBeenCalled();
});

it('a failing store is logged and does not throw', async () => {
  messageReports.scrubEvidenceResolvedBefore.mockRejectedValue(new Error('db down'));
  await expect(runReportEvidenceRetentionTick(NOW)).resolves.toBe(0);
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'moderation.report_evidence.scrub_failed' }), expect.any(String));
});

it('an invalid window is a failure, not a silent fallback', async () => {
  process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS = '0';
  await expect(runReportEvidenceRetentionTick(NOW)).resolves.toBe(0);
  expect(messageReports.scrubEvidenceResolvedBefore).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  expect(() => startReportEvidenceRetentionJob()).toThrow(/MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS/);
});

it('a tick that is still running is not started twice', async () => {
  let release: (n: number) => void = () => undefined;
  messageReports.scrubEvidenceResolvedBefore.mockImplementation(() => new Promise<number>(r => { release = r; }));
  const first = runReportEvidenceRetentionTick(NOW);
  expect(await runReportEvidenceRetentionTick(NOW)).toBe(0);
  release(1);
  expect(await first).toBe(1);
  expect(messageReports.scrubEvidenceResolvedBefore).toHaveBeenCalledTimes(1);
});

it('start runs once immediately, then hourly; start twice keeps one timer; stop is idempotent', async () => {
  jest.useFakeTimers();
  startReportEvidenceRetentionJob();
  startReportEvidenceRetentionJob();
  await Promise.resolve();
  expect(messageReports.scrubEvidenceResolvedBefore).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(messageReports.scrubEvidenceResolvedBefore).toHaveBeenCalledTimes(2);
  stopReportEvidenceRetentionJob();
  await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  expect(messageReports.scrubEvidenceResolvedBefore).toHaveBeenCalledTimes(2);
  expect(() => stopReportEvidenceRetentionJob()).not.toThrow();
});
