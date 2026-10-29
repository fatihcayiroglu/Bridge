// P7 D2 — forget local copies of channels a server no longer lists.
//
// The encrypted history cache and the offline outbox are copies of
// previously-authorized content. A channel that expired (or that the user can
// no longer see) used to keep both until the user happened to open it and got
// a 404; until then offline search still returned its messages, its queued
// sends waited for a channel that will never come back and its unsent draft
// (encrypted, or legacy plaintext never migrated) stayed on the device. After every
// AUTHORIZED channel-list load for a server, anything of that server that the
// list no longer contains is purged. This covers the `channel:expired` event,
// reconnecting after an offline window and permission loss alike.
//
// Attribution is conservative: a history snapshot belongs to the server only
// when one of its cached messages says so; snapshots of other servers, DMs and
// empty snapshots are never touched.

import type { OutboxEntry } from '../outbox-store.ts';
import type { LocalHistorySnapshot } from './history.ts';
import {
  clearLocalFirstHistoryChannel,
  listLocalFirstHistory,
} from './history-runtime.ts';
import {
  readLocalFirstOutbox,
  removeLocalFirstOutboxEntry,
} from './outbox-runtime.ts';
import { localFirstChannelDraftIds, purgeLocalFirstDraft } from './draft-runtime.ts';

export interface StaleLocalChannels {
  /** Channel ids whose encrypted history snapshot must be deleted. */
  history: string[];
  /** Outbox ackIds queued for channels the server no longer lists. */
  outbox: string[];
  /** Channel ids whose unsent draft must be cleared. */
  drafts: string[];
}

function snapshotServer(snapshot: LocalHistorySnapshot): string | null {
  for (const message of snapshot.messages) {
    const serverId = (message as { serverId?: unknown }).serverId;
    if (typeof serverId === 'string' && serverId) return serverId;
  }
  return null;
}

/** Pure decision: what of `serverId` is cached locally but no longer listed. */
export function staleLocalChannels(
  serverId: string,
  liveChannelIds: readonly string[],
  snapshots: readonly LocalHistorySnapshot[],
  outbox: readonly OutboxEntry[],
  draftChannelIds: readonly string[] = [],
): StaleLocalChannels {
  if (!serverId) return { history: [], outbox: [], drafts: [] };
  const live = new Set(liveChannelIds);
  const history = snapshots
    .filter(snapshot => !live.has(snapshot.channelId) && snapshotServer(snapshot) === serverId)
    .map(snapshot => snapshot.channelId);
  const queued = outbox
    .filter(entry => entry.draftKind === 'channel' && entry.serverId === serverId && !live.has(entry.channelId))
    .map(entry => entry.ackId);
  // Draft ids are listed per server already (record scope), so membership in
  // the authorized list is the only test.
  const drafts = [...new Set(draftChannelIds.filter(cid => cid && !live.has(cid)))].sort();
  return { history: [...new Set(history)].sort(), outbox: queued, drafts };
}

export interface ReconcileDeps {
  listHistory(userId: string): Promise<LocalHistorySnapshot[]>;
  clearHistory(userId: string, channelId: string): Promise<void>;
  readOutbox(userId: string): OutboxEntry[];
  removeOutbox(userId: string, ackId: string): void;
  listDraftChannels(userId: string, serverId: string): Promise<string[]>;
  clearDraft(userId: string, serverId: string, channelId: string): void;
}

const runtimeDeps: ReconcileDeps = {
  listHistory: listLocalFirstHistory,
  clearHistory: clearLocalFirstHistoryChannel,
  readOutbox: readLocalFirstOutbox,
  removeOutbox: removeLocalFirstOutboxEntry,
  listDraftChannels: localFirstChannelDraftIds,
  clearDraft: (userId, serverId, channelId) =>
    purgeLocalFirstDraft({ userId, kind: 'channel', serverId, conversationId: channelId }),
};

/**
 * Purge the local copies of `serverId` channels missing from an authorized
 * list. Call only with a list the server just returned for that server.
 */
export async function reconcileLocalChannels(
  userId: string,
  serverId: string,
  liveChannelIds: readonly string[],
  deps: ReconcileDeps = runtimeDeps,
): Promise<StaleLocalChannels> {
  const stale = staleLocalChannels(serverId, liveChannelIds, await deps.listHistory(userId),
    deps.readOutbox(userId), await deps.listDraftChannels(userId, serverId));
  for (const ackId of stale.outbox) deps.removeOutbox(userId, ackId);
  for (const channelId of stale.drafts) deps.clearDraft(userId, serverId, channelId);
  for (const channelId of stale.history) await deps.clearHistory(userId, channelId);
  return stale;
}
