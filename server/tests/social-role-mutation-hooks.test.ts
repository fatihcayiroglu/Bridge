/**
 * The common reconciliation hook is a strict OFF-by-default boundary. These
 * unit tests are not Redis acceptance: parent feature PRs separately run
 * real PG16 + Redis7 + live Socket.IO acceptance on the same exact head.
 */
const mockReconcile = jest.fn().mockResolvedValue(0);
jest.mock('../socket/handlers/social-room-eviction', () => ({
  reconcileSocialRoomAccess: (...args: unknown[]) => mockReconcile(...args),
}));
import { reconcileSocialRoleChange } from '../lib/socialRoleAccess';

describe('Social role change hook — gated and failure-visible', () => {
  const oldValue = process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER;
  afterEach(() => {
    mockReconcile.mockReset().mockResolvedValue(0);
    if (oldValue === undefined) delete process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER;
    else process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER = oldValue;
  });

  it('never consults social state when feature flag is absent', async () => {
    delete process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER;
    await reconcileSocialRoleChange({}, 'server-disabled', 'member');
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('reconciles only the targeted member after plugin, reaction or onboarding changes', async () => {
    process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER = '1';
    const io = { to: jest.fn(), in: jest.fn() };
    await reconcileSocialRoleChange(io, 'server-1', 'user-1');
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(io, 'server-1', 'user-1');
  });

  it('can reconcile the whole server for role permission edits and surfaces errors', async () => {
    process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER = '1';
    const io = {};
    await reconcileSocialRoleChange(io, 'server-1');
    expect(mockReconcile).toHaveBeenCalledWith(io, 'server-1', undefined);
    mockReconcile.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(reconcileSocialRoleChange(io, 'server-1', 'user-1'))
      .rejects.toThrow('Redis unavailable');
  });
});
