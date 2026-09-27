import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

export type MessageReportReason = 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'other';
export type MessageReportResolution = 'resolved' | 'dismissed';

class MessageReportRepository {
  async create(input: {
    serverId: string; channelId: string; messageId: string; reporterId: string;
    reason: MessageReportReason; detail: string;
  }): Promise<{ row: Record<string, unknown>; created: boolean }> {
    const existing = await db.messageReports.findOne({ reporterId: input.reporterId, messageId: input.messageId, status: 'open' });
    if (existing) return { row: existing as Record<string, unknown>, created: false };
    try {
      const row = await db.messageReports.insert({
        _id: uuidv4(), ...input, status: 'open', createdAt: Date.now(),
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
}

export default new MessageReportRepository();
