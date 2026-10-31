/**
 * Central opt-in bridge from any canonical member-role mutation to the
 * independent 3D Social Space permission reconciliation contract.
 *
 * Call AFTER the real role assignment is committed and permission cache is
 * invalidated. Never make role writes contingent on this feature when it is
 * disabled. A failure while enabled is NOT silently reported as a clean room.
 */
export async function reconcileSocialRoleChange(
  io: unknown,
  serverId: string,
  userId?: string,
): Promise<void> {
  if (process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER !== '1') return;
  const { reconcileSocialRoomAccess } = await import('../socket/handlers/social-room-eviction');
  await reconcileSocialRoomAccess(
    io as Parameters<typeof reconcileSocialRoomAccess>[0],
    serverId,
    userId,
  );
}
