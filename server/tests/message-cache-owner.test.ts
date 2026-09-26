const invalidatePattern = jest.fn();
const debug = jest.fn();
jest.mock('../lib/redisAdapter', () => ({ cache: { invalidatePattern } }));
jest.mock('../lib/logger', () => ({ debug }));
import { channelMessagesCachePrefix, invalidateChannelMessages } from '../lib/messageCache';

beforeEach(() => { jest.clearAllMocks(); invalidatePattern.mockResolvedValue(undefined); });

describe('message-cache invalidation owner', () => {
  it('invalidates every cached first page for the channel through the canonical prefix', async () => {
    expect(channelMessagesCachePrefix('c-1')).toBe('messages:c-1:');
    await invalidateChannelMessages('c-1');
    expect(invalidatePattern).toHaveBeenCalledWith('messages:c-1:');
  });

  it('does not issue a broad invalidation for an empty channel id', async () => {
    await invalidateChannelMessages('');
    expect(invalidatePattern).not.toHaveBeenCalled();
  });

  it('keeps a durable message successful when cache invalidation is unavailable', async () => {
    invalidatePattern.mockRejectedValue(new Error('redis unavailable'));
    await expect(invalidateChannelMessages('c-1')).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'message_cache.invalidate_failed', channelId: 'c-1', err: expect.any(Error) }), expect.any(String));
  });
});
