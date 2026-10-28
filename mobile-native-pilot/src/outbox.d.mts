import type { SessionCoordinator } from './session-coordinator.mjs';
import type { BridgeRealtime } from './bridge-realtime.mjs';
export type OutboxRow = Readonly<{
  id: string; serverId: string; channelId: string; content: string;
  status: 'queued' | 'sending' | 'confirmed' | 'unconfirmed' | 'failed'; messageId?: string;
}>;
export interface Outbox {
  enqueue(input: { serverId: string; channelId: string; content: string }): string;
  flush(): Promise<OutboxRow[]>;
  retry(id: string): Promise<OutboxRow[]>;
  remove(id: string): void;
  snapshot(): OutboxRow[];
  dispose(): void;
}
export declare function createOutbox(config: {
  coordinator: Pick<SessionCoordinator, 'getSession' | 'subscribe'>;
  realtime: Pick<BridgeRealtime, 'send' | 'getStatus'>;
  createId: () => string;
  capacity?: number;
}): Outbox;
