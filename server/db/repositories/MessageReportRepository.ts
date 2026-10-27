import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { anonymizeReportAuthor, isMachineMessageAuthor, scrubbedEvidence, type ReportEvidenceColumns } from '../../lib/reportEvidence';

export type MessageReportReason = 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'other';
export type MessageReportResolution = 'resolved' | 'dismissed';

class MessageReportRepository {
  async create(input: {
    serverId: string; channelId: string; messageId: string; reporterId: string;
    reason: MessageReportReason; detail: string;
    /** P7 B5 (093): set when `messageId` is a reply in thread_messages. */
    threadId?: string | null;
    /** P7 B5: what was reported, captured from the message at report time. */
    evidence: ReportEvidenceColumns;
  }): Promise<{ row: Record<string, unknown>; created: boolean }> {
    // In production, report insertion and the author lock must share one client.
    // Mock collections have no pool; their route tests exercise presentation while
    // real-PostgreSQL tests exercise this transaction and its race ordering.
    if (db._pool) return this.createProtected(input);
    const existing = await db.messageReports.findOne({ reporterId: input.reporterId, messageId: input.messageId, status: 'open' });
    if (existing) return { row: existing as Record<string, unknown>, created: false };
    try {
      const { evidence, ...report } = input;
      const row = await db.messageReports.insert({
        _id: uuidv4(), ...report, threadId: input.threadId ?? null, ...evidence, status: 'open', createdAt: Date.now(),
        resolvedAt: null, resolvedBy: null, resolution: null,
      });
      return { row: row as Record<string, unknown>, created: true };
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      if (code !== '23505' && !/duplicate|unique/i.test(String((error as Error)?.message ?? ''))) throw error;
      const raced = await db.messageReports.findOne({ reporterId: input.reporterId, messageId: input.messageId, status: 'open' });
      if (!raced) throw error;
      return { row: raced as Record<string, unknown>, created: false };
    }
  }

  private async createProtected(input: {
    serverId: string; channelId: string; messageId: string; reporterId: string;
    reason: MessageReportReason; detail: string; threadId?: string | null; evidence: ReportEvidenceColumns;
  }): Promise<{ row: Record<string, unknown>; created: boolean }> {
    const transaction = db._transaction as <T>(fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>) => Promise<T>;
    return transaction(async client => {
      const authorId = input.evidence.evidenceAuthorId;
      let evidence = input.evidence;
      if (authorId && authorId !== 'deleted-user' && !isMachineMessageAuthor(authorId)) {
        // FOR SHARE conflicts with erasure's first FOR UPDATE. If erasure wins,
        // the missing row identifies a formerly human author; never persist the
        // name or id from the route's earlier message read.
        const author = await client.query('SELECT _id FROM users WHERE _id = $1 FOR SHARE', [authorId]);
        if (author.rows.length === 0) evidence = anonymizeReportAuthor(evidence);
      } else if (authorId === 'deleted-user') {
        evidence = anonymizeReportAuthor(evidence);
      }
      const existing = await client.query(
        `SELECT * FROM message_reports WHERE "reporterId" = $1 AND "messageId" = $2 AND status = 'open' LIMIT 1`,
        [input.reporterId, input.messageId]);
      if (existing.rows[0]) return { row: existing.rows[0], created: false };
      const fields = ['_id', 'serverId', 'channelId', 'messageId', 'threadId', 'reporterId', 'reason', 'detail',
        'status', 'createdAt', 'resolvedAt', 'resolvedBy', 'resolution', ...Object.keys(evidence)];
      const values: unknown[] = [uuidv4(), input.serverId, input.channelId, input.messageId,
        input.threadId ?? null, input.reporterId, input.reason, input.detail, 'open', Date.now(), null, null, null,
        ...Object.values(evidence)];
      const inserted = await client.query(
        `INSERT INTO message_reports (${fields.map(field => `"${field}"`).join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING *`, values);
      if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
      const raced = await client.query(
        `SELECT * FROM message_reports WHERE "reporterId" = $1 AND "messageId" = $2 AND status = 'open' LIMIT 1`,
        [input.reporterId, input.messageId]);
      if (!raced.rows[0]) throw new Error('Report insertion conflicted without an open report');
      return { row: raced.rows[0], created: false };
    });
  }

  async findOpenForServer(serverId: string, limit = 200): Promise<Record<string, unknown>[]> {
    return db.messageReports.find({ serverId, status: 'open' })
      .sort({ createdAt: -1, _id: -1 }).limit(Math.min(Math.max(limit, 1), 500)) as unknown as Promise<Record<string, unknown>[]>;
  }

  async findById(serverId: string, id: string): Promise<Record<string, unknown> | null> {
    return db.messageReports.findOne({ _id: id, serverId }) as unknown as Promise<Record<string, unknown> | null>;
  }

  async resolveTargetState(input: { serverId: string; id: string; actorId: string; resolution: MessageReportResolution }) {
    const targetStatus = input.resolution === 'resolved' ? 'resolved' : 'dismissed';
    const existing = await this.findById(input.serverId, input.id);
    if (!existing) return { kind: 'missing' as const };
    if (String(existing.status ?? '') === targetStatus && String(existing.resolution ?? '') === input.resolution) {
      return { kind: 'already' as const, row: existing };
    }
    if (String(existing.status ?? '') !== 'open') return { kind: 'conflict' as const, row: existing };
    const result = await db.messageReports.update(
      { _id: input.id, serverId: input.serverId, status: 'open' },
      { $set: { status: targetStatus, resolution: input.resolution, resolvedAt: Date.now(), resolvedBy: input.actorId } },
    );
    if (result?.updated !== 1) return { kind: 'conflict' as const, row: await this.findById(input.serverId, input.id) };
    return { kind: 'updated' as const, row: await this.findById(input.serverId, input.id) };
  }

  /**
   * P7 B5 retention: clears the evidence of reports resolved or dismissed at or before
   * `resolvedBefore`. Open reports keep theirs. Idempotent, so every node may run it.
   */
  async scrubEvidenceResolvedBefore(resolvedBefore: number, now = Date.now()): Promise<number> {
    const result = await db.messageReports.update(
      {
        status: { $in: ['resolved', 'dismissed'] },
        resolvedAt: { $lte: resolvedBefore },
        evidenceCapturedAt: { $exists: true },
        evidenceScrubbedAt: null,
      },
      { $set: scrubbedEvidence(now) },
    );
    return Number(result?.updated ?? 0);
  }
}

export default new MessageReportRepository();
