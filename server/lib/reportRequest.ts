// server/lib/reportRequest.ts
//
// P7 B5: the body of a user report. It is shared by every reportable message
// kind, so a reason or limit cannot drift between them:
//   POST /api/messages/:id/report                       channel message
//   POST /api/threads/:threadId/messages/:id/report     thread reply

import type { MessageReportReason } from '../db/repositories/MessageReportRepository';

const REPORT_REASONS: ReadonlySet<string> = new Set(['spam', 'harassment', 'hate', 'sexual', 'violence', 'other']);
export const REPORT_DETAIL_MAX = 500;

/** The validated reason and note, or null for an invalid report (answer 400). */
export function parseReportRequest(body: unknown): { reason: MessageReportReason; detail: string } | null {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as { reason?: unknown; detail?: unknown };
  const reason = String(fields.reason ?? '').trim();
  const detail = String(fields.detail ?? '').trim();
  if (!REPORT_REASONS.has(reason) || detail.length > REPORT_DETAIL_MAX) return null;
  return { reason: reason as MessageReportReason, detail };
}
