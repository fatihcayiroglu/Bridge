/**
 * Bridge Activities: product catalog, NOT an assertion that these games are
 * implemented. Only server-registered, reviewed playable activities may be
 * launched. An unimplemented catalog ID must never reach activity:start.
 */
export type BridgeGameId =
  | 'mini-kart-racing' | 'parkour-party' | 'mini-golf' | 'eight-ball-pool'
  | 'mini-football' | 'hide-and-seek-3d' | 'tower-chaos'
  | 'dodgeball-arena' | 'escape-room-3d' | 'last-one-standing';

export interface PlannedBridgeGame {
  readonly id: BridgeGameId;
  readonly title: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly category: 'racing' | 'sports' | 'party' | 'puzzle' | 'physics';
  readonly state: 'planned';
}

export const BRIDGE_3D_GAME_CATALOG: readonly PlannedBridgeGame[] = Object.freeze([
  { id: 'mini-kart-racing', title: 'Mini Kart Racing', minPlayers: 2, maxPlayers: 8, category: 'racing', state: 'planned' },
  { id: 'parkour-party', title: 'Parkour Party', minPlayers: 2, maxPlayers: 16, category: 'party', state: 'planned' },
  { id: 'mini-golf', title: 'Mini Golf', minPlayers: 2, maxPlayers: 8, category: 'sports', state: 'planned' },
  { id: 'eight-ball-pool', title: '8-Ball Pool', minPlayers: 2, maxPlayers: 2, category: 'sports', state: 'planned' },
  { id: 'mini-football', title: 'Mini Football', minPlayers: 2, maxPlayers: 6, category: 'sports', state: 'planned' },
  { id: 'hide-and-seek-3d', title: 'Hide & Seek 3D', minPlayers: 3, maxPlayers: 12, category: 'party', state: 'planned' },
  { id: 'tower-chaos', title: 'Tower Chaos', minPlayers: 2, maxPlayers: 8, category: 'physics', state: 'planned' },
  { id: 'dodgeball-arena', title: 'Dodgeball Arena', minPlayers: 2, maxPlayers: 8, category: 'sports', state: 'planned' },
  { id: 'escape-room-3d', title: 'Escape Room 3D', minPlayers: 2, maxPlayers: 6, category: 'puzzle', state: 'planned' },
  { id: 'last-one-standing', title: 'Last One Standing', minPlayers: 4, maxPlayers: 16, category: 'party', state: 'planned' },
]);

/** A separate social destination, not an eleventh game and not a game session. */
export const BRIDGE_SOCIAL_SPACE = Object.freeze({
  id: 'bridge-social-space-3d',
  kind: 'social',
  title: 'Sosyal Alan 3D',
  state: 'local-prototype' as const,
});
