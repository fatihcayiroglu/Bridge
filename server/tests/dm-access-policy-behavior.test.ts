const findBlock = jest.fn();
const findFriendship = jest.fn();
const findConversationByParticipants = jest.fn();

jest.mock('../db/repositories', () => ({
  Social: { findBlock, findFriendship },
  Dms: { findConversationByParticipants },
}));

import { evaluateDmAccess, isDmBlocked } from '../lib/dmAccessPolicy';

beforeEach(() => {
  jest.clearAllMocks();
  findBlock.mockResolvedValue(null);
  findFriendship.mockResolvedValue(null);
  findConversationByParticipants.mockResolvedValue(null);
});

describe('DM access canonical precedence', () => {
  it('block in either direction overrides an existing conversation and privacy', async () => {
    findConversationByParticipants.mockResolvedValue({ _id: 'dm-existing' });
    findBlock.mockResolvedValueOnce({ blockerId: 'sender' });
    await expect(evaluateDmAccess('sender', { _id: 'recipient', dmPrivacy: 'everyone' })).resolves.toEqual({ allowed: false, reason: 'blocked' });
    expect(findConversationByParticipants).not.toHaveBeenCalled();

    jest.clearAllMocks(); findConversationByParticipants.mockResolvedValue({ _id: 'dm-existing' });
    findBlock.mockResolvedValueOnce(null).mockResolvedValueOnce({ blockerId: 'recipient' });
    await expect(evaluateDmAccess('sender', { _id: 'recipient', dmPrivacy: 'friends' })).resolves.toEqual({ allowed: false, reason: 'blocked' });
  });

  it('preserves an existing conversation across later privacy changes', async () => {
    findConversationByParticipants.mockResolvedValue({ _id: 'dm-existing' });
    await expect(evaluateDmAccess('sender', { _id: 'recipient', dmPrivacy: 'none' })).resolves.toEqual({ allowed: true, existingConversation: true });
    expect(findFriendship).not.toHaveBeenCalled();
  });

  it('enforces none/friends while allowing accepted friends and public recipients', async () => {
    await expect(evaluateDmAccess('s', { _id: 'r', dmPrivacy: 'none' })).resolves.toEqual({ allowed: false, reason: 'privacy_none' });
    await expect(evaluateDmAccess('s', { _id: 'r', dmPrivacy: 'friends' })).resolves.toEqual({ allowed: false, reason: 'friends_only' });
    findFriendship.mockResolvedValue({ status: 'accepted' });
    await expect(evaluateDmAccess('s', { _id: 'r', dmPrivacy: 'friends' })).resolves.toEqual({ allowed: true, existingConversation: false });
    await expect(evaluateDmAccess('s', { _id: 'r', dmPrivacy: 'everyone' })).resolves.toEqual({ allowed: true, existingConversation: false });
  });

  it('propagates policy-store failure rather than interpreting it as access', async () => {
    findBlock.mockRejectedValueOnce(new Error('policy DB unavailable'));
    await expect(evaluateDmAccess('s', { _id: 'r', dmPrivacy: 'everyone' })).rejects.toThrow('policy DB unavailable');
  });

  it('blocking-only call check tests both directions and short-circuits on the first block', async () => {
    findBlock.mockResolvedValueOnce({ _id: 'b' });
    await expect(isDmBlocked('a', 'b')).resolves.toBe(true);
    expect(findBlock).toHaveBeenCalledTimes(1);
    findBlock.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(isDmBlocked('a', 'b')).resolves.toBe(false);
    expect(findBlock).toHaveBeenCalledTimes(2);
  });
});
