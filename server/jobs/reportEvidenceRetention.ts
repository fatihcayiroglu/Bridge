// server/jobs/reportEvidenceRetention.ts
//
// P7 B5 / B3: a message report's evidence snapshot (migration 085) is another
// person's message, kept so moderators review what was reported. It is kept while
// the report is open and for MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS (default 90)
// after it is resolved or dismissed; then this job clears it. The report row
// itself (reason, status, timestamps) stays, as before.
//
// The UPDATE is idempotent and only touches rows that still hold evidence, so it
// runs on every node without a lease.

import { MessageReports } from '../db/repositories';
import { evidenceRetentionMs } from '../lib/reportEvidence';
import logger from '../lib/logger';

const POLL_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runReportEvidenceRetentionTick(now = Date.now()): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const scrubbed = await MessageReports.scrubEvidenceResolvedBefore(now - evidenceRetentionMs(), now);
    if (scrubbed > 0) {
      logger.info({ event: 'moderation.report_evidence.scrubbed', count: scrubbed }, 'Expired report evidence cleared');
    }
    return scrubbed;
  } catch (error) {
    logger.error({ error, event: 'moderation.report_evidence.scrub_failed' }, 'Report evidence retention failed');
    return 0;
  } finally {
    running = false;
  }
}

export function startReportEvidenceRetentionJob(): void {
  if (timer) return;
  // Reads the setting once at start: an invalid value fails startup, not a later tick.
  evidenceRetentionMs();
  void runReportEvidenceRetentionTick();
  timer = setInterval(() => { void runReportEvidenceRetentionTick(); }, POLL_MS);
  timer.unref?.();
}

export function stopReportEvidenceRetentionJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
