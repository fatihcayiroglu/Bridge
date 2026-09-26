const collection = () => ({
  find: jest.fn(async () => []), findOne: jest.fn(async () => null), insert: jest.fn(async (x) => x),
  update: jest.fn(async () => ({ updated: 1 })), remove: jest.fn(async () => ({ removed: 1 })), count: jest.fn(async () => 0),
});
const db: any = {
  channelPermissions: collection(), blocks: collection(), userConnections: collection(), friendships: collection(),
};
jest.mock('../db/loader', () => ({ __esModule: true, default: db }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'uuid-1') }));

import ChannelPermissions from '../db/repositories/ChannelPermissionRepository';
import Social from '../db/repositories/SocialRepository';

describe('authorization/privacy repository stores fail closed', () => {
  it('channel permission store absence never becomes an empty allow/deny set', async () => {
    const store = db.channelPermissions;
    db.channelPermissions = undefined;
    await expect(ChannelPermissions.findByChannel('c')).rejects.toThrow('channelPermissions store unavailable');
    await expect(ChannelPermissions.findOne({ channelId:'c' })).rejects.toThrow('channelPermissions store unavailable');
    await expect(ChannelPermissions.insert({ channelId:'c' })).rejects.toThrow('channelPermissions store unavailable');
    db.channelPermissions = store;
  });

  it('block store absence never becomes no-block state', async () => {
    const store = db.blocks;
    db.blocks = undefined;
    await expect(Social.findBlock('a','b')).rejects.toThrow('blocks store unavailable');
    await expect(Social.findBlocksByUser('a')).rejects.toThrow('blocks store unavailable');
    await expect(Social.findBlocksInvolvingUser('a')).rejects.toThrow('blocks store unavailable');
    await expect(Social.insertBlock('a','b')).rejects.toThrow('blocks store unavailable');
    db.blocks = store;
  });

  it('connection storage absence cannot bypass connection-cap or mutation truthfulness', async () => {
    const store = db.userConnections;
    db.userConnections = undefined;
    await expect(Social.countConnections({ userId:'a' })).rejects.toThrow('userConnections store unavailable');
    await expect(Social.findConnectionsByUser('a')).rejects.toThrow('userConnections store unavailable');
    await expect(Social.insertConnection({ userId:'a', platform:'github' })).rejects.toThrow('userConnections store unavailable');
    db.userConnections = store;
  });
});
