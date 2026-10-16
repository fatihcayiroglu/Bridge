// Real repository-adapter behavior for installation-scoped AutoMod exemptions.
import { createMockDb, makeChannel, makeServer, makeUser } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../db/index', () => mockDb);

import {
  bindIncomingIntegrationSelections,
  currentIntegrationBinding,
  listInstalledAutomodIntegrations,
} from '../lib/automodIntegrationExemptions';

beforeEach(() => mockDb._reset());

describe('server-derived AutoMod integration identity', () => {
  it('uses a current home bot, linked bot installation and scoped incoming webhook', async () => {
    const owner = makeUser();
    const home = makeServer(owner._id);
    const foreign = makeServer(owner._id);
    const channel = makeChannel(home._id);
    await mockDb.servers.insert(home);
    await mockDb.servers.insert(foreign);
    await mockDb.channels.insert(channel);
    await mockDb.bots.insert({ _id: 'homeBot', serverId: home._id, active: true, username: 'Home' });
    await mockDb.bots.insert({ _id: 'linkedBot', serverId: foreign._id, active: true, username: 'Linked' });
    await mockDb.serverBots.insert({ _id: 'inst1', botId: 'linkedBot', serverId: home._id });
    await mockDb.webhooks.insert({ _id: 'hook1', channelId: channel._id, serverId: home._id, name: 'Incoming' });

    expect(await currentIntegrationBinding(home._id, 'bot:homeBot'))
      .toEqual({ principal: 'bot:homeBot', installationId: 'homeBot' });
    expect(await currentIntegrationBinding(home._id, 'bot:linkedBot'))
      .toEqual({ principal: 'bot:linkedBot', installationId: 'inst1' });
    expect(await currentIntegrationBinding(home._id, 'webhook:hook1'))
      .toEqual({ principal: 'webhook:hook1', installationId: 'hook1' });
    expect(await bindIncomingIntegrationSelections(home._id, ['bot:linkedBot', 'webhook:hook1']))
      .toHaveLength(2);
    const listing = await listInstalledAutomodIntegrations(home._id);
    expect(listing.map((x) => x.principal).sort()).toEqual(['bot:homeBot', 'bot:linkedBot', 'webhook:hook1']);

    await expect(bindIncomingIntegrationSelections(home._id, [{ principal: 'bot:linkedBot', installationId: 'inst1' }]))
      .rejects.toThrow('invalid_integration_selection');
    await expect(bindIncomingIntegrationSelections(home._id, ['plugin:welcome']))
      .rejects.toThrow('invalid_integration_selection');
    await expect(bindIncomingIntegrationSelections(home._id, ['bot:linkedBot', 'bot:linkedBot']))
      .rejects.toThrow('invalid_integration_selection');
  });

  it('denies cross-server webhook rows and invalidates removed/reinstalled bot grants', async () => {
    const owner = makeUser();
    const home = makeServer(owner._id);
    const foreign = makeServer(owner._id);
    const channel = makeChannel(foreign._id);
    await mockDb.servers.insert(home);
    await mockDb.servers.insert(foreign);
    await mockDb.channels.insert(channel);
    await mockDb.bots.insert({ _id: 'portable', serverId: foreign._id, active: true });
    await mockDb.serverBots.insert({ _id: 'firstGrant', botId: 'portable', serverId: home._id });
    await mockDb.webhooks.insert({ _id: 'stale', channelId: channel._id, serverId: home._id });

    expect(await currentIntegrationBinding(home._id, 'webhook:stale')).toBeNull();
    expect(await currentIntegrationBinding(home._id, 'bot:portable'))
      .toEqual({ principal: 'bot:portable', installationId: 'firstGrant' });
    await mockDb.serverBots.remove({ botId: 'portable', serverId: home._id });
    expect(await currentIntegrationBinding(home._id, 'bot:portable')).toBeNull();
    await mockDb.serverBots.insert({ _id: 'newGrant', botId: 'portable', serverId: home._id });
    expect(await currentIntegrationBinding(home._id, 'bot:portable'))
      .toEqual({ principal: 'bot:portable', installationId: 'newGrant' });
  });
});
