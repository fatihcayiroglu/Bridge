import type { SessionCoordinator } from './session-coordinator.mjs';
import type { BridgeRealtime } from './bridge-realtime.mjs';
import type { OutboxRow } from './outbox.mjs';
import type { EncryptedOutboxJournal } from './encrypted-outbox-journal.mjs';
export interface PersistentOutbox {
  ready(): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): OutboxRow[];
  enqueue(input: { serverId: string; channelId: string; content: string }): Promise<string>;
  flush(): Promise<OutboxRow[]>;
  retry(id: string): Promise<OutboxRow[]>;
  remove(id: string): Promise<void>;
  dispose(): void;
}
export declare function createPersistentOutbox(config: {
  coordinator: Pick<SessionCoordinator, 'getSession' | 'getState' | 'subscribe'>;
  realtime: Pick<BridgeRealtime, 'send' | 'getStatus' | 'joinChannel'>;
  createId: () => string;
  openJournal(accountId: string): Promise<EncryptedOutboxJournal>;
}): PersistentOutbox;
