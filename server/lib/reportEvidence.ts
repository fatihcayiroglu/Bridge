// P7 B5 (#336): bounded, immutable evidence snapshot for a message report.
//
// The moderator queue used to render the message's CURRENT text, so the reported
// author could edit or delete the message and change what moderators review. With
// REPORT_EVIDENCE_SNAPSHOT=1 the report row keeps a snapshot taken at report time.
// Disabled by default: retention, scrub and erasure precedence are owner decisions
// (see #336) and nothing here decides them.
import { storedMessageText } from './storedText';

export const REPORT_EVIDENCE_MAX_TEXT = 4000;
const MAX_NAME = 200;

export function reportEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REPORT_EVIDENCE_SNAPSHOT === '1';
}

const clip = (value: unknown, max: number): string =>
  Array.from(typeof value === 'string' ? value : '').slice(0, max).join('');
const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export interface EvidenceColumns {
  evidenceCapturedAt: number;
  evidenceAuthorId: string;
  evidenceAuthorName: string;
  evidenceText: string;
  evidenceTextTruncated: boolean;
  evidenceCreatedAt: number | null;
  evidenceEditedAt: number | null;
  evidenceFileName: string | null;
  evidenceFileType: string | null;
}

/** Visible text and identifying metadata only; never an attachment body or URL. */
export function buildEvidenceSnapshot(message: Record<string, unknown>, now: number): EvidenceColumns {
  const full = storedMessageText(message as { content?: unknown; contentFormat?: unknown });
  const text = clip(full, REPORT_EVIDENCE_MAX_TEXT);
  const fileName = typeof message.fileName === 'string' && message.fileName ? clip(message.fileName, MAX_NAME) : null;
  const fileType = typeof message.fileType === 'string' && message.fileType ? clip(message.fileType, MAX_NAME) : null;
  return {
    evidenceCapturedAt: now,
    evidenceAuthorId: String(message.userId ?? ''),
    evidenceAuthorName: clip(message.displayName ?? message.username ?? '', MAX_NAME),
    evidenceText: text,
    evidenceTextTruncated: Array.from(full).length > REPORT_EVIDENCE_MAX_TEXT,
    evidenceCreatedAt: finiteOrNull(message.createdAt),
    evidenceEditedAt: finiteOrNull(message.editedAt),
    evidenceFileName: fileName,
    evidenceFileType: fileType,
  };
}

export type EvidenceState = 'unchanged' | 'edited' | 'deleted';

export interface EvidenceView {
  text: string;
  truncated: boolean;
  authorId: string;
  authorName: string;
  createdAt: number | null;
  editedAt: number | null;
  capturedAt: number;
  file: { name: string | null; type: string | null } | null;
  state: EvidenceState;
}

/** Null for reports taken before snapshots existed or while the feature was off. */
export function evidenceView(row: Record<string, unknown>, current: Record<string, unknown> | null): EvidenceView | null {
  const capturedAt = finiteOrNull(row.evidenceCapturedAt);
  if (capturedAt === null) return null;
  const snapshotEdited = finiteOrNull(row.evidenceEditedAt);
  let state: EvidenceState = 'unchanged';
  if (!current || current.deletedAt) state = 'deleted';
  else if (finiteOrNull(current.editedAt) !== snapshotEdited) state = 'edited';
  // Two edits inside one millisecond share an editedAt: the text itself still tells them apart.
  else if (row.evidenceTextTruncated !== true
    && storedMessageText(current as { content?: unknown; contentFormat?: unknown }) !== (typeof row.evidenceText === 'string' ? row.evidenceText : '')) state = 'edited';
  const name = typeof row.evidenceFileName === 'string' ? row.evidenceFileName : null;
  const type = typeof row.evidenceFileType === 'string' ? row.evidenceFileType : null;
  return {
    text: typeof row.evidenceText === 'string' ? row.evidenceText : '',
    truncated: row.evidenceTextTruncated === true,
    authorId: String(row.evidenceAuthorId ?? ''),
    authorName: String(row.evidenceAuthorName ?? ''),
    createdAt: finiteOrNull(row.evidenceCreatedAt),
    editedAt: snapshotEdited,
    capturedAt,
    file: name || type ? { name, type } : null,
    state,
  };
}
