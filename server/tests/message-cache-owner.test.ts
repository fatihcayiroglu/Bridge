const invalidatePattern = jest.fn();
const set = jest.fn();
const get = jest.fn();
const debug = jest.fn();
jest.mock('../lib/redisAdapter', () => ({ cache: { invalidatePattern, set, get } }));
jest.mock('../lib/logger', () => ({ debug }));
import {
  channelMessagesCachePrefix, channelMessagesGeneration, currentChannelPage, invalidateChannelMessages,
} from '../lib/messageCache';

beforeEach(() => {
  jest.clearAllMocks();
  invalidatePattern.mockResolvedValue(undefined);
  set.mockResolvedValue(undefined);
  get.mockResolvedValue(null);
});

describe('message-cache invalidation owner', () => {
  it('invalidates every cached first page for the channel through the canonical prefix', async () => {
    expect(channelMessagesCachePrefix('c-1')).toBe('messages:c-1:');
    await invalidateChannelMessages('c-1');
    expect(invalidatePattern).toHaveBeenCalledWith('messages:c-1:');
  });

  it('moves the channel to a new generation first, outside the page prefix, and never reuses one', async () => {
    await invalidateChannelMessages('c-1');
    await invalidateChannelMessages('c-1');
    expect(set).toHaveBeenCalledTimes(2);
    const [[key, first, ttl], [, second]] = set.mock.calls;
    expect(key).toBe('messages-gen:c-1');
    expect(key.startsWith(channelMessagesCachePrefix('c-1'))).toBe(false);
    expect(ttl).toBeGreaterThan(45);
    expect(first).not.toBe(second);
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(invalidatePattern.mock.invocationCallOrder[0]!);
  });

  it('a page is served only for the generation it was read under', async () => {
    expect(await channelMessagesGeneration('c-1')).toBe('0');
    get.mockResolvedValue('g-2');
    expect(await channelMessagesGeneration('c-1')).toBe('g-2');
    const page = { messages: [] };
    expect(currentChannelPage({ generation: 'g-2', page }, 'g-2')).toBe(page);
    expect(currentChannelPage({ generation: 'g-1', page }, 'g-2')).toBeNull();
    expect(currentChannelPage(page, '0')).toBeNull();                 // a pre-upgrade entry is a miss
    expect(currentChannelPage(null, '0')).toBeNull();
  });

  it('still drops the pages when the generation cannot be written', async () => {
    set.mockRejectedValue(new Error('redis unavailable'));
    await expect(invalidateChannelMessages('c-1')).resolves.toBeUndefined();
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
