import { BridgeRegistry } from './bridge-registry.ts';
import { draftContextKey, draftKindOf, type DraftKind } from './message-composer-policy.ts';

export interface SocketLike {
  emit(event: string, ...args: unknown[]): void;
  on?(event: string, fn: (...args: never[]) => void): void;
  off?(event: string, fn: (...args: never[]) => void): void;
}

export interface ComposerChannel {
  _id?: string;
  serverId?: string;
  name?: string;
  type?: string;
}

export function composerSocket(): SocketLike | null {
  return BridgeRegistry.get('socket') as SocketLike | null;
}

export function composerCurrentChannel(): ComposerChannel | null {
  return BridgeRegistry.call<ComposerChannel | null>('getCurrentChannel') ?? null;
}

export function composerCurrentUser(): Record<string, unknown> {
  return BridgeRegistry.call<Record<string, unknown> | null>('getMe') ?? {};
}

export function composerCurrentUserId(): string {
  const me = composerCurrentUser();
  return String(me._id ?? me.id ?? '');
}

export function saveDraft(text: string): void {
  BridgeRegistry.get<(value: string) => void>('setDraft')?.(text);
}

export function loadDraft(): string {
  return BridgeRegistry.get<() => string>('getDraft')?.() ?? '';
}

export function flushDraft(): void {
  BridgeRegistry.get<() => void>('flushDraft')?.();
}

export function dropDraft(channelId?: string, kind?: DraftKind, serverId?: string): void {
  BridgeRegistry.get<(id?: string, k?: string, sid?: string) => void>('clearDraft')?.(channelId, kind, serverId);
}

export function saveAttachmentPending(value: boolean): void {
  BridgeRegistry.get<(pending: boolean) => void>('setDraftAttachmentPending')?.(value);
}

export function loadAttachmentPending(): boolean {
  return BridgeRegistry.get<() => boolean>('getDraftAttachmentPending')?.() === true;
}

export function currentDraftContextKey(): string {
  const channel = composerCurrentChannel();
  const userId = composerCurrentUserId();
  if (!channel?._id || !userId) return '';
  const kind = draftKindOf(channel);
  const serverScope = kind === 'channel'
    ? channel.serverId ?? BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer')?._id ?? ''
    : kind;
  return draftContextKey(userId, channel._id, kind, serverScope);
}
