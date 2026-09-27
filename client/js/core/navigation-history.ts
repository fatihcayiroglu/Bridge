// Bridge app-level navigation history.
//
// This is deliberately session-memory only. It stores destination identifiers,
// never message bodies, auth tokens, ICE data, or private API responses. Replay
// always goes through the canonical channel/DM/GDM owners, so history cannot
// bypass a permission check or resurrect content the server no longer returns.

import { BridgeRegistry } from './bridge-registry.ts';
import { t } from './i18n/index.ts';
import { createLogger } from './logger.ts';

const log = createLogger('NavigationHistory');
const MAX_ENTRIES = 100;

export interface HistoryServer { _id: string; name?: string }
export interface HistoryUser { _id: string; displayName?: string; avatarColor?: string }
export interface HistoryGroup { _id: string; name?: string }

export type NavigationLocation =
  | { type: 'channel'; channelId: string; messageId?: string; server?: HistoryServer }
  | { type: 'dm'; user: HistoryUser; messageId?: string }
  | { type: 'gdm'; group: HistoryGroup; messageId?: string };

export interface NavigationHistorySnapshot {
  index: number;
  length: number;
  canBack: boolean;
  canForward: boolean;
  locations: Array<{ type: NavigationLocation['type']; key: string }>;
}

type Replay = (location: NavigationLocation) => Promise<boolean> | boolean;

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Close the input shape: only the minimum destination metadata survives. */
export function normalizeNavigationLocation(raw: unknown): NavigationLocation | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const type = value.type;
  const messageId = cleanString(value.messageId);

  if (type === 'channel') {
    const channelId = cleanString(value.channelId);
    if (!channelId) return null;
    const rawServer = value.server && typeof value.server === 'object'
      ? value.server as Record<string, unknown> : null;
    const serverId = cleanString(rawServer?._id);
    return {
      type,
      channelId,
      ...(messageId ? { messageId } : {}),
      ...(serverId ? { server: { _id: serverId, ...(cleanString(rawServer?.name) ? { name: cleanString(rawServer?.name) } : {}) } } : {}),
    };
  }

  if (type === 'dm') {
    const rawUser = value.user && typeof value.user === 'object'
      ? value.user as Record<string, unknown> : null;
    const userId = cleanString(rawUser?._id);
    if (!userId) return null;
    const displayName = cleanString(rawUser?.displayName);
    const avatarColor = cleanString(rawUser?.avatarColor);
    return {
      type,
      user: {
        _id: userId,
        ...(displayName ? { displayName } : {}),
        ...(avatarColor ? { avatarColor } : {}),
      },
      ...(messageId ? { messageId } : {}),
    };
  }

  if (type === 'gdm') {
    const rawGroup = value.group && typeof value.group === 'object'
      ? value.group as Record<string, unknown> : null;
    const groupId = cleanString(rawGroup?._id);
    if (!groupId) return null;
    const name = cleanString(rawGroup?.name);
    return {
      type,
      group: { _id: groupId, ...(name ? { name } : {}) },
      ...(messageId ? { messageId } : {}),
    };
  }

  return null;
}

export function navigationLocationKey(location: NavigationLocation): string {
  const message = location.messageId ?? '';
  if (location.type === 'channel') return `channel:${location.server?._id ?? ''}:${location.channelId}:${message}`;
  if (location.type === 'dm') return `dm:${location.user._id}:${message}`;
  return `gdm:${location.group._id}:${message}`;
}

export function createNavigationHistory(replay: Replay, onUnavailable?: () => void) {
  let entries: NavigationLocation[] = [];
  let index = -1;
  let pendingReplayKey: string | null = null;
  let operationSequence = 0;
  let busy = false;

  function snapshot(): NavigationHistorySnapshot {
    return {
      index,
      length: entries.length,
      canBack: index > 0,
      canForward: index >= 0 && index < entries.length - 1,
      locations: entries.map(location => ({ type: location.type, key: navigationLocationKey(location) })),
    };
  }

  function reset(): void {
    operationSequence += 1;
    pendingReplayKey = null;
    busy = false;
    entries = [];
    index = -1;
  }

  function record(raw: unknown): boolean {
    const location = normalizeNavigationLocation(raw);
    if (!location) return false;
    const key = navigationLocationKey(location);

    // A successful canonical replay reports the destination here. Consume the
    // signal without appending another entry.
    if (pendingReplayKey === key) {
      pendingReplayKey = null;
      return true;
    }

    // A different navigation won the race while back/forward was awaiting an
    // API call. Cancel that replay before recording the user's newer intent.
    if (pendingReplayKey !== null) {
      operationSequence += 1;
      pendingReplayKey = null;
    }

    const currentKey = index >= 0 ? navigationLocationKey(entries[index]!) : null;
    if (currentKey === key) {
      entries[index] = location; // refresh harmless display metadata
      return false;
    }

    // Collapse A → B → A → B oscillation by moving across adjacent existing
    // entries instead of appending the same pair forever.
    if (index > 0 && navigationLocationKey(entries[index - 1]!) === key) {
      index -= 1;
      entries[index] = location;
      return true;
    }
    if (index + 1 < entries.length && navigationLocationKey(entries[index + 1]!) === key) {
      index += 1;
      entries[index] = location;
      return true;
    }

    // A fresh navigation after Back creates a new branch, just like browser
    // history: inaccessible/stale forward entries are no longer relevant.
    entries = entries.slice(0, index + 1);
    entries.push(location);
    if (entries.length > MAX_ENTRIES) entries.shift();
    index = entries.length - 1;
    return true;
  }

  async function go(delta: -1 | 1): Promise<boolean> {
    if (busy) return false;
    busy = true;
    const operation = ++operationSequence;
    let skipped = false;

    try {
      while (true) {
        const targetIndex = index + delta;
        if (targetIndex < 0 || targetIndex >= entries.length) {
          if (skipped) onUnavailable?.();
          return false;
        }

        const target = entries[targetIndex]!;
        pendingReplayKey = navigationLocationKey(target);

        let reached = false;
        try {
          reached = (await replay(target)) === true;
        } catch (error) {
          log.warn('History destination replay failed', error);
        }

        if (operation !== operationSequence) return false;
        pendingReplayKey = null;

        if (reached) {
          index = targetIndex;
          return true;
        }

        // Canonical owner rejected/failed the destination. Remove it and keep
        // walking in the requested direction; no stale private surface opens.
        entries.splice(targetIndex, 1);
        if (delta < 0) index -= 1; // current entry shifted left by the splice
        skipped = true;
      }
    } finally {
      if (operation === operationSequence) pendingReplayKey = null;
      busy = false;
    }
  }

  return {
    record,
    back: () => go(-1),
    forward: () => go(1),
    reset,
    snapshot,
  };
}

async function replayCanonical(location: NavigationLocation): Promise<boolean> {
  if (location.type === 'channel') {
    if (!BridgeRegistry.has('navigateToChannel')) return false;
    return (await BridgeRegistry.call<Promise<boolean> | boolean>(
      'navigateToChannel', location.channelId, location.messageId, location.server,
    )) === true;
  }
  if (location.type === 'dm') {
    if (!BridgeRegistry.has('openDm')) return false;
    return (await BridgeRegistry.call<Promise<boolean> | boolean>(
      'openDm', location.user._id, location.user.displayName, location.user.avatarColor, location.messageId,
    )) === true;
  }
  if (!BridgeRegistry.has('groupDmPanel:openGroupDm')) return false;
  return (await BridgeRegistry.call<Promise<boolean> | boolean>(
    'groupDmPanel:openGroupDm', location.group, location.messageId,
  )) === true;
}

const navigationHistory = createNavigationHistory(replayCanonical, () => {
  BridgeRegistry.call('toast', t('navigation_history_unavailable'), 'warning');
});

BridgeRegistry.register('recordNavigationLocation', (location: unknown) => navigationHistory.record(location));
BridgeRegistry.register('navigateBack', () => navigationHistory.back());
BridgeRegistry.register('navigateForward', () => navigationHistory.forward());
BridgeRegistry.register('getNavigationHistoryState', () => navigationHistory.snapshot());
BridgeRegistry.register('resetNavigationHistory', () => navigationHistory.reset());

function onHistoryKeyDown(event: KeyboardEvent): void {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

  const state = navigationHistory.snapshot();
  const canMove = event.key === 'ArrowLeft' ? state.canBack : state.canForward;
  if (!canMove) return;

  event.preventDefault();
  if (event.key === 'ArrowLeft') void navigationHistory.back();
  else void navigationHistory.forward();
}

window.addEventListener('keydown', onHistoryKeyDown);
document.addEventListener('bridge:auth-logout', () => navigationHistory.reset());

export { navigationHistory };
