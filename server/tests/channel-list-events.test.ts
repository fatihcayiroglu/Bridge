/** P7 D2: the channel-list change signal carries the server id only and never throws. */
import { announceChannelListChanged, CHANNELS_CHANGED_EVENT } from '../lib/channelListEvents';

describe('announceChannelListChanged', () => {
  it('emits the server id, and nothing else, to that server room', () => {
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };
    announceChannelListChanged(io, 's1');
    expect(io.to).toHaveBeenCalledWith('server:s1');
    expect(emit).toHaveBeenCalledWith(CHANNELS_CHANGED_EVENT, { serverId: 's1' });
    expect(CHANNELS_CHANGED_EVENT).toBe('channels:changed');
  });

  it('does nothing without a socket server or a server id', () => {
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    for (const value of [undefined, null, {}, 'io', { to: 'x' }]) expect(() => announceChannelListChanged(value, 's1')).not.toThrow();
    announceChannelListChanged(io, '');
    announceChannelListChanged(io, 7 as unknown as string);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('never fails the committed mutation when broadcasting throws', () => {
    const io = { to: () => { throw new Error('adapter down'); } };
    expect(() => announceChannelListChanged(io, 's1')).not.toThrow();
  });
});
