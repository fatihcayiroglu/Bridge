jest.mock('../db/repositories', () => ({ Bots: { findInstalledForServer: jest.fn() } }));
const mockLiveChannels = jest.fn();
jest.mock('../lib/channelLiveReadSet', () => ({ liveChannelSet: (...args: unknown[]) => mockLiveChannels(...args) }));

import { Bots } from '../db/repositories';
import { dispatchRegisteredBotCommand } from '../lib/botCommandDispatch';

const findInstalled = Bots.findInstalledForServer as jest.Mock;
function ioHarness() {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  return {
    io: { to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }) },
    emitted,
  };
}

describe('registered bot slash dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLiveChannels.mockResolvedValue(new Set(['c']));
  });

  test('delivers only exact registered command to private bot room', async () => {
    findInstalled.mockResolvedValue([
      { _id: 'b1', slashCommands: [{ name: 'ping' }] },
      { _id: 'b2', slashCommands: [{ name: 'help' }] },
    ]);
    const { io, emitted } = ioHarness();
    const message = { _id: 'm', serverId: 's', channelId: 'c', userId: 'u', content: '/ping now' };
    expect(await dispatchRegisteredBotCommand(io as never, message)).toBe(1);
    expect(emitted).toEqual([{ room: 'bot:b1', event: 'message:new', payload: message }]);
  });

  test('ordinary/malformed slash text does not query bot store', async () => {
    const { io } = ioHarness();
    expect(await dispatchRegisteredBotCommand(io as never, { _id:'m',serverId:'s',channelId:'c',userId:'u',content:'hello' })).toBe(0);
    expect(await dispatchRegisteredBotCommand(io as never, { _id:'m',serverId:'s',channelId:'c',userId:'u',content:'/bad! name' })).toBe(0);
    expect(findInstalled).not.toHaveBeenCalled();
  });

  test('metadata-store failure never rolls back/throws the persisted chat message path', async () => {
    findInstalled.mockRejectedValue(new Error('db down'));
    const { io, emitted } = ioHarness();
    await expect(dispatchRegisteredBotCommand(io as never, { _id:'m',serverId:'s',channelId:'c',userId:'u',content:'/ping' })).resolves.toBe(0);
    expect(emitted).toHaveLength(0);
  });

  test('an unavailable fresh expiry check never delivers command arguments', async () => {
    findInstalled.mockResolvedValue([{ _id: 'b1', slashCommands: [{ name: 'ping' }] }]);
    mockLiveChannels.mockRejectedValue(new Error('availability unavailable'));
    const { io, emitted } = ioHarness();
    expect(await dispatchRegisteredBotCommand(io, { _id:'m',serverId:'s',channelId:'c',userId:'u',content:'/ping private' })).toBe(0);
    expect(emitted).toEqual([]);
  });
});
