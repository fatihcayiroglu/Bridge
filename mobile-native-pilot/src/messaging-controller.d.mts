import type { SessionCoordinator, SessionState } from './session-coordinator.mjs';
import type { BridgeReadApi, ReadListItem, MessageRow } from './bridge-read-api.mjs';
import type { BridgeRealtime, RealtimeStatus } from './bridge-realtime.mjs';
import type { OutboxRow } from './outbox.mjs';
import type { PersistentOutbox } from './persistent-outbox.mjs';
export type MessagingSnapshot = {
  session: SessionState; connection: RealtimeStatus; servers: ReadListItem[]; channels: ReadListItem[];
  serverId: string | null; channelId: string | null; messages: MessageRow[]; drafts: OutboxRow[];
  error: string | null; loading: boolean;
};
export declare function createMessagingController(config: {
  coordinator: SessionCoordinator; read: BridgeReadApi; realtime: BridgeRealtime; createId: () => string; outbox?: PersistentOutbox;
}): {
  snapshot(): MessagingSnapshot;
  subscribe(listener: (state: MessagingSnapshot) => void): () => void;
  start(): Promise<void>;
  selectServer(id: string): Promise<void>;
  selectChannel(id: string): Promise<void>;
  send(content: string): Promise<void>;
  retry(id: string): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
};
