// server/lib/reportEvidence.ts
//
// P7 B5 — evidence-safe message reports (issue #336).
//
// A report used to store only the message id, and the moderator queue showed the
// message's CURRENT text. The reported author could edit or delete the message
// after being reported and the moderator would review the new text (or
// "[Mesaj silindi]"). Edit history keeps 10 versions and a delete clears it.
//
// Now the report carries a bounded copy of what was reported, taken when the
// report is filed. What is copied:
//   · the stored text, at most REPORT_EVIDENCE_TEXT_MAX characters;
//   · the author id and the display name shown on the message;
//   · the message type and its createdAt / editedAt;
//   · an attachment's file name and type, never its bytes or URL.
// What is never copied: encrypted payloads (an `e2ee` message is stored with
// empty text and the snapshot keeps it empty), reactions, embeds, reply quotes.
//
// Who sees it: holders of MANAGE_MESSAGES (or ADMIN) in the report's channel, the
// same check as the queue itself. It is not in the reporter's personal-data export.
// How long: until the report is resolved or dismissed, plus the retention window
// (MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS, default 90), then the retention job
// clears it. When the reported author erases their account, the author id and
// name in the snapshot are anonymized like the message itself; the text stays,
// as it does on the message (accountLifecycle.ts, `messages` ANONYMIZE).

import { storedMessageText } from './storedText';
import { envSafeInt } from './envNumbers';

export const REPORT_EVIDENCE_TEXT_MAX = 4000;
export const REPORT_EVIDENCE_NAME_MAX = 256;
export const REPORT_EVIDENCE_TYPE_MAX = 32;
export const REPORT_EVIDENCE_FILE_NAME_MAX = 512;
export const REPORT_EVIDENCE_FILE_TYPE_MAX = 255;

export const DEFAULT_EVIDENCE_RETENTION_DAYS = 90;
export const MAX_EVIDENCE_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The evidence columns of a message_reports row (migration 085). */
export interface ReportEvidenceColumns {
  evidenceCapturedAt: number;
  evidenceText: string;
  evidenceTextTruncated: boolean;
  evidenceAuthorId: string | null;
  evidenceAuthorName: string | null;
  evidenceMessageType: string;
  evidenceMessageCreatedAt: number | null;
  evidenceMessageEditedAt: number | null;
  evidenceFileName: string | null;
  evidenceFileType: string | null;
}

/** Every evidence column the retention job clears. Capture and scrub times stay. */
export const EVIDENCE_CONTENT_COLUMNS = [
  'evidenceText', 'evidenceTextTruncated', 'evidenceAuthorId', 'evidenceAuthorName',
  'evidenceMessageType', 'evidenceMessageCreatedAt', 'evidenceMessageEditedAt',
  'evidenceFileName', 'evidenceFileType',
] as const;

export type ReportEvidenceState = 'captured' | 'not_captured' | 'scrubbed';
export type ReportCurrentState = 'unchanged' | 'edited' | 'deleted' | 'removed' | 'unknown';

/** Cuts at a UTF-16 boundary without splitting a surrogate pair. */
export function boundText(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  let text = value.slice(0, max);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return { text, truncated: true };
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return boundText(value, max).text;
}

function timestamp(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The fields of a channel message the snapshot reads. */
export interface ReportableMessage {
  content?: unknown; contentFormat?: unknown; type?: unknown;
  userId?: unknown; displayName?: unknown; username?: unknown;
  createdAt?: unknown; editedAt?: unknown; fileName?: unknown; fileType?: unknown;
  isEncrypted?: unknown; encryptedContent?: unknown;
}

/** The snapshot stored on a new report. `message` is the row being reported. */
export function captureReportEvidence(message: ReportableMessage, now = Date.now()): ReportEvidenceColumns {
  // The server cannot read an encrypted message, and its ciphertext is not evidence a
  // moderator can review: the snapshot of an encrypted message is empty text.
  const encrypted = message.type === 'e2ee' || message.isEncrypted === true
    || (typeof message.encryptedContent === 'string' && message.encryptedContent.length > 0);
  const { text, truncated } = encrypted
    ? { text: '', truncated: false }
    : boundText(storedMessageText(message), REPORT_EVIDENCE_TEXT_MAX);
  const name = message.displayName ?? message.username;
  return {
    evidenceCapturedAt: now,
    evidenceText: text,
    evidenceTextTruncated: truncated,
    evidenceAuthorId: boundedString(message.userId, REPORT_EVIDENCE_NAME_MAX),
    evidenceAuthorName: boundedString(name, REPORT_EVIDENCE_NAME_MAX),
    evidenceMessageType: boundedString(message.type, REPORT_EVIDENCE_TYPE_MAX) ?? 'normal',
    evidenceMessageCreatedAt: timestamp(message.createdAt),
    evidenceMessageEditedAt: timestamp(message.editedAt),
    evidenceFileName: boundedString(message.fileName, REPORT_EVIDENCE_FILE_NAME_MAX),
    evidenceFileType: boundedString(message.fileType, REPORT_EVIDENCE_FILE_TYPE_MAX),
  };
}

/** Machine principals have no users row and must retain their own attribution. */
export function isMachineMessageAuthor(id: string): boolean {
  return id === 'system' || ['bot:', 'webhook:', 'bridge:', 'crosspost:', 'ap:'].some(prefix => id.startsWith(prefix));
}

/** A previously erased human must not be reidentified by a stale message read. */
export function anonymizeReportAuthor(evidence: ReportEvidenceColumns): ReportEvidenceColumns {
  return { ...evidence, evidenceAuthorId: 'deleted-user', evidenceAuthorName: '' };
}

export function evidenceState(row: Record<string, unknown>): ReportEvidenceState {
  if (timestamp(row.evidenceScrubbedAt) !== null) return 'scrubbed';
  if (timestamp(row.evidenceCapturedAt) !== null && typeof row.evidenceText === 'string') return 'captured';
  return 'not_captured';
}

/** What the moderator queue shows as "reported content". */
export function evidenceView(row: Record<string, unknown>): Record<string, unknown> {
  const state = evidenceState(row);
  if (state === 'scrubbed') {
    return {
      state,
      capturedAt: timestamp(row.evidenceCapturedAt),
      scrubbedAt: timestamp(row.evidenceScrubbedAt),
    };
  }
  if (state === 'not_captured') return { state };
  return {
    state,
    capturedAt: timestamp(row.evidenceCapturedAt),
    text: String(row.evidenceText),
    truncated: row.evidenceTextTruncated === true,
    authorId: typeof row.evidenceAuthorId === 'string' ? row.evidenceAuthorId : null,
    authorName: typeof row.evidenceAuthorName === 'string' ? row.evidenceAuthorName : null,
    messageType: typeof row.evidenceMessageType === 'string' ? row.evidenceMessageType : 'normal',
    messageCreatedAt: timestamp(row.evidenceMessageCreatedAt),
    messageEditedAt: timestamp(row.evidenceMessageEditedAt),
    fileName: typeof row.evidenceFileName === 'string' ? row.evidenceFileName : null,
    fileType: typeof row.evidenceFileType === 'string' ? row.evidenceFileType : null,
  };
}

/**
 * How the message differs from the snapshot now:
 *   removed  — the row is gone (a ban that removed recent messages, an admin purge);
 *   deleted  — soft-deleted (the author or a moderator deleted it);
 *   edited   — the text differs, or it was edited again after the snapshot;
 *   unchanged;
 *   unknown  — the report has no snapshot to compare with (filed before 085, or cleared).
 */
export function currentStateSinceReport(
  row: Record<string, unknown>, message: Record<string, unknown> | null | undefined,
): ReportCurrentState {
  if (!message) return 'removed';
  if (message.deletedAt) return 'deleted';
  if (evidenceState(row) !== 'captured') return 'unknown';
  const now = boundText(storedMessageText(message), REPORT_EVIDENCE_TEXT_MAX).text;
  if (now !== row.evidenceText) return 'edited';
  const editedNow = timestamp(message.editedAt) ?? 0;
  const editedThen = timestamp(row.evidenceMessageEditedAt) ?? 0;
  return editedNow > editedThen ? 'edited' : 'unchanged';
}

/** The `$set` the retention job applies: every content column cleared, scrub time recorded. */
export function scrubbedEvidence(now: number): Record<string, unknown> {
  const set: Record<string, unknown> = { evidenceScrubbedAt: now };
  for (const column of EVIDENCE_CONTENT_COLUMNS) set[column] = null;
  return set;
}

/** Days a resolved or dismissed report keeps its snapshot. Invalid values fail at startup. */
export function evidenceRetentionDays(): number {
  return envSafeInt('MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS', DEFAULT_EVIDENCE_RETENTION_DAYS, {
    min: 1, max: MAX_EVIDENCE_RETENTION_DAYS,
  });
}

export function evidenceRetentionMs(): number {
  return evidenceRetentionDays() * DAY_MS;
}
