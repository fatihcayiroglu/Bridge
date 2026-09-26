// client/js/core/exclusive-surface.ts
// Top-level transient shell surfaces must not stack on top of each other.
//
// This coordinator covers mutually-exclusive top-level shell surfaces. Nested
// dialogs inside one surface, permission editors and media-call overlays keep
// their own stack semantics and are not touched here. The key invariant is that
// opening a peer shell surface cannot leave another full-shell/dialog surface
// interactive underneath it.
//
// Peers are closed with `restoreFocus=false`. Otherwise the surface being
// closed could queue a focus return to its opener and steal focus from the
// surface that is opening next.

import { BridgeRegistry } from './bridge-registry.ts';

export type ExclusiveSurfaceId =
  | 'inbox' | 'saved' | 'search' | 'server-search' | 'pins' | 'command'
  | 'dm' | 'friends' | 'gdm' | 'discover' | 'marketplace' | 'polls';

const CLOSE_OWNER: Record<ExclusiveSurfaceId, string> = {
  inbox: 'closeInbox',
  saved: 'closeSaved',
  search: 'closeGlobalSearch',
  'server-search': 'closeSearch',
  pins: 'closePinnedMessages',
  command: 'closeCommandPalette',
  dm: 'closeDmPanel',
  friends: 'hideFriendsPanel',
  gdm: 'closeGroupDmPanel',
  discover: 'hideDiscoverPanel',
  marketplace: 'closeBotMarketplace',
  polls: 'closePolls',
};

export function closeExclusivePeers(owner: ExclusiveSurfaceId): void {
  for (const [id, closeOwner] of Object.entries(CLOSE_OWNER) as Array<[ExclusiveSurfaceId, string]>) {
    if (id === owner || !BridgeRegistry.has(closeOwner)) continue;
    BridgeRegistry.call(closeOwner, false);
  }
}
