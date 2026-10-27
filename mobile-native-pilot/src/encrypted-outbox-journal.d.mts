import type { OutboxRow } from './outbox.mjs';
export interface SqlPort {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<{ changes: number }>;
  closeAsync(): Promise<void>;
}
export interface EncryptedOutboxJournal {
  list(): Promise<OutboxRow[]>;
  append(input: { id: string; serverId: string; channelId: string; content: string }): Promise<OutboxRow>;
  mark(id: string, status: OutboxRow['status'], messageId?: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}
export declare function createEncryptedOutboxJournal(config: { db: SqlPort; keyHex: string }): Promise<EncryptedOutboxJournal>;
