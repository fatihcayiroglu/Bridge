// server/tests/report-evidence.test.ts
//
// P7 B5 (#336) — what a message report keeps of the reported message.
// Pure rules of lib/reportEvidence.ts; the route-level flow is in
// report-evidence-flow.test.ts and the PostgreSQL schema in
// pg-integration/report-evidence.pgtest.ts.

import {
  REPORT_EVIDENCE_TEXT_MAX, EVIDENCE_CONTENT_COLUMNS,
  boundText, captureReportEvidence, currentStateSinceReport, evidenceRetentionDays,
  evidenceState, evidenceView, scrubbedEvidence,
} from '../lib/reportEvidence';

const NOW = 1_800_000_000_000;

const message = (overrides: Record<string, unknown> = {}) => ({
  _id: 'm-1', userId: 'author-1', displayName: 'Author', username: 'author',
  content: 'abusive original text', contentFormat: 1, type: 'normal',
  createdAt: NOW - 5000, ...overrides,
});

describe('captureReportEvidence', () => {
  it('copies the text, author, type and times of the reported message', () => {
    expect(captureReportEvidence(message({ editedAt: NOW - 100 }), NOW)).toEqual({
      evidenceCapturedAt: NOW,
      evidenceText: 'abusive original text',
      evidenceTextTruncated: false,
      evidenceAuthorId: 'author-1',
      evidenceAuthorName: 'Author',
      evidenceMessageType: 'normal',
      evidenceMessageCreatedAt: NOW - 5000,
      evidenceMessageEditedAt: NOW - 100,
      evidenceFileName: null,
      evidenceFileType: null,
    });
  });

  it('decodes legacy (sanitized) text the way the queue shows it', () => {
    const e = captureReportEvidence(message({ content: 'a &lt; b', contentFormat: 0 }), NOW);
    expect(e.evidenceText).toBe('a < b');
  });

  it('keeps an attachment name and type, never its URL', () => {
    const e = captureReportEvidence(message({
      type: 'file', fileName: 'proof.png', fileType: 'image/png', fileUrl: '/uploads/secret-path.png',
    }), NOW);
    expect(e).toMatchObject({ evidenceMessageType: 'file', evidenceFileName: 'proof.png', evidenceFileType: 'image/png' });
    expect(JSON.stringify(e)).not.toContain('secret-path');
  });

  it('never copies an encrypted payload', () => {
    for (const encrypted of [
      message({ type: 'e2ee', content: '', encryptedContent: 'CIPHERTEXT', iv: 'IV' }),
      message({ isEncrypted: true, content: 'CIPHERTEXT' }),
      message({ content: 'CIPHERTEXT', encryptedContent: 'CIPHERTEXT' }),
    ]) {
      const e = captureReportEvidence(encrypted, NOW);
      expect(e.evidenceText).toBe('');
      expect(JSON.stringify(e)).not.toContain('CIPHERTEXT');
    }
  });

  it('bounds the text and says it was cut', () => {
    const e = captureReportEvidence(message({ content: 'x'.repeat(REPORT_EVIDENCE_TEXT_MAX + 50) }), NOW);
    expect(e.evidenceText).toHaveLength(REPORT_EVIDENCE_TEXT_MAX);
    expect(e.evidenceTextTruncated).toBe(true);
  });

  it('does not split a surrogate pair at the bound', () => {
    const cut = boundText(`${'x'.repeat(3)}😀`, 4);
    expect(cut).toEqual({ text: 'xxx', truncated: true });
    expect(boundText('😀', 2)).toEqual({ text: '😀', truncated: false });
  });

  it('falls back to the username, a "normal" type and null times', () => {
    const e = captureReportEvidence({ content: 'hi', contentFormat: 1, username: 'only-username', createdAt: 'bad' }, NOW);
    expect(e).toMatchObject({
      evidenceAuthorName: 'only-username', evidenceAuthorId: null, evidenceMessageType: 'normal',
      evidenceMessageCreatedAt: null, evidenceMessageEditedAt: null,
    });
  });
});

describe('evidence state and the queue view', () => {
  const captured = { ...captureReportEvidence(message(), NOW) };

  it('a report filed before migration 085 has no snapshot', () => {
    expect(evidenceState({})).toBe('not_captured');
    expect(evidenceView({})).toEqual({ state: 'not_captured' });
  });

  it('a captured snapshot is shown in full', () => {
    expect(evidenceView(captured)).toMatchObject({
      state: 'captured', capturedAt: NOW, text: 'abusive original text', truncated: false,
      authorId: 'author-1', authorName: 'Author', messageType: 'normal',
    });
  });

  it('an empty text is still a captured snapshot (an encrypted message)', () => {
    expect(evidenceState({ ...captured, evidenceText: '' })).toBe('captured');
  });

  it('a cleared snapshot shows only when it was taken and cleared', () => {
    const row = { evidenceCapturedAt: NOW, ...scrubbedEvidence(NOW + 10) };
    expect(evidenceView(row)).toEqual({ state: 'scrubbed', capturedAt: NOW, scrubbedAt: NOW + 10 });
  });

  it('the scrub clears every content column', () => {
    const set = scrubbedEvidence(NOW);
    for (const column of EVIDENCE_CONTENT_COLUMNS) expect(set[column]).toBeNull();
    expect(set.evidenceScrubbedAt).toBe(NOW);
    expect(Object.keys(set)).not.toContain('evidenceCapturedAt');
  });
});

describe('currentStateSinceReport', () => {
  const row = captureReportEvidence(message(), NOW);

  it.each([
    ['unchanged', message()],
    ['edited', message({ content: 'totally benign now', editedAt: NOW + 1 })],
    ['edited', message({ editedAt: NOW + 1 })], // edited back to the same text
    ['deleted', message({ content: '[Mesaj silindi]', deletedAt: NOW + 1 })],
  ])('%s', (state, current) => {
    expect(currentStateSinceReport(row as unknown as Record<string, unknown>, current)).toBe(state);
  });

  it('removed when the message row is gone', () => {
    expect(currentStateSinceReport(row as unknown as Record<string, unknown>, null)).toBe('removed');
  });

  it('unknown without a snapshot to compare with', () => {
    expect(currentStateSinceReport({}, message({ editedAt: NOW + 1 }))).toBe('unknown');
  });
});

describe('MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS', () => {
  const saved = process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS;
    else process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS = saved;
  });

  it('defaults to 90 days', () => {
    delete process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS;
    expect(evidenceRetentionDays()).toBe(90);
  });

  it('accepts a bounded value', () => {
    process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS = '30';
    expect(evidenceRetentionDays()).toBe(30);
  });

  it.each(['0', '3651', '-5', '10days', '1.5'])('refuses %s instead of weakening the bound', (value) => {
    process.env.MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS = value;
    expect(() => evidenceRetentionDays()).toThrow(/MESSAGE_REPORT_EVIDENCE_RETENTION_DAYS/);
  });
});

describe('privacy boundaries of the snapshot', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LIFECYCLE } = require('../lib/accountLifecycle') as typeof import('../lib/accountLifecycle');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { snapshotAssignments } = require('../lib/accountErasure') as typeof import('../lib/accountErasure');

  it('erasing the reported author anonymizes them in the snapshot, like their messages', () => {
    const rule = LIFECYCLE.find(r => r.table === 'message_reports' && r.columns.includes('evidenceAuthorId'));
    expect(rule?.disposition).toBe('ANONYMIZE');
    const messagesRule = LIFECYCLE.find(r => r.table === 'messages' && r.columns.includes('userId'));
    expect(messagesRule?.disposition).toBe('ANONYMIZE');
    const set = snapshotAssignments('message_reports', 'evidenceAuthorId',
      new Set(['evidenceAuthorId', 'evidenceAuthorName', 'evidenceText']), 3);
    expect(set).toEqual({ sql: ', "evidenceAuthorName" = $3', params: [''] });
  });

  it("the reporter's erasure still deletes their own reports (unchanged)", () => {
    const rule = LIFECYCLE.find(r => r.table === 'message_reports' && r.columns.includes('reporterId'));
    expect(rule?.disposition).toBe('DELETE');
  });

  it("the reporter's personal-data export selects an allowlist without evidence columns", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'account.ts'), 'utf8') as string;
    const start = src.indexOf("key: 'messageReports'");
    const entry = src.slice(start, src.indexOf('},', start));
    expect(entry).toMatch(/columns: \[/);
    expect(entry).not.toMatch(/evidence/);
    expect(src).toMatch(/SELECT \$\{projection\} FROM/);
  });
});
