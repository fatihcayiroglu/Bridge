// Regression coverage for P7 #300: exemptions bind to a live installation,
// not to a name, a role, a plugin or an old server association.
process.env.NODE_ENV = 'test';
import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../db/index', () => mockDb);

import {
  bindSelectedIntegrations, currentIntegrationInstallation, listInstalledIntegrations,
} from '../lib/automodIntegrationExemptions';
import { evaluateAutomodRules, normalizeAutomodConfig } from '../lib/automodPolicy';

const SID = 'server-one', OTHER = 'server-two', CID = 'channel-one';
beforeEach(async () => {
  mockDb._reset();
  await mockDb.servers.insert({ _id: SID, ownerId: 'owner', name: 'first' });
  await mockDb.servers.insert({ _id: OTHER, ownerId: 'owner', name: 'second' });
  await mockDb.channels.insert({ _id: CID, serverId: SID, name: 'text', type: 'text' });
});

const linkRule = (exemptIntegrations: unknown) => ({
  _id: 'link-rule', type: 'link_filter', enabled: true,
  config: { exemptIntegrations },
});
const decide = async (userId: string, machineInstallationId: string | null, rules = [linkRule([{ principal: 'webhook:wh1', installationId: 'wh1' }])]) =>
  evaluateAutomodRules(rules, {
    serverId: SID, userId, machineInstallationId, memberRoleIds: [],
    content: 'https://example.test/docs',
  }, async () => 1);

describe('per-integration link filter exceptions', () => {
  it('denies links by default without a verified installation', async () => {
    expect((await decide('webhook:wh1', null)).deleteMessage).toBe(true);
    expect((await decide('plugin:wh1', 'wh1')).deleteMessage).toBe(true);
    expect((await decide('user-1', 'wh1')).deleteMessage).toBe(true);
  });

  it('skips ONLY the matching link rule for exact verified installation', async () => {
    expect((await decide('webhook:wh1', 'wh1')).matched).toBe(false);
    expect((await decide('webhook:wh1', 'different')).deleteMessage).toBe(true);
    expect((await decide('webhook:other', 'wh1')).deleteMessage).toBe(true);
  });

  it('does not skip blocked words when a link exemption matches', async () => {
    const result = await evaluateAutomodRules([
      linkRule([{ principal: 'webhook:wh1', installationId: 'wh1' }]),
      { _id: 'words', type: 'blocked_words', enabled: true, config: { words: ['example'] } },
    ], {
      serverId: SID, userId: 'webhook:wh1', machineInstallationId: 'wh1',
      memberRoleIds: [], content: 'https://example.test/docs',
    }, async () => 1);
    expect(result.matchedRuleIds).toEqual(['words']);
    expect(result.deleteMessage).toBe(true);
  });

  it('rejects forged or malformed stored exception entries fail closed', async () => {
    expect(normalizeAutomodConfig('blocked_words', { words: ['x'], exemptIntegrations: [] }).ok).toBe(false);
    expect(normalizeAutomodConfig('link_filter', { exemptIntegrations: ['webhook:wh1'] }).ok).toBe(false);
    expect(normalizeAutomodConfig('link_filter', { exemptIntegrations: [
      { principal: 'webhook:wh1', installationId: 'wh1' },
      { principal: 'webhook:wh1', installationId: 'wh1' },
    ] }).ok).toBe(false);
    await expect(decide('webhook:wh1', 'wh1', [linkRule([{ principal: 'webhook:wh1', installationId: null }])]))
      .rejects.toThrow('Invalid persisted AutoMod config');
  });

  it('webhook binding requires channel in the SAME server', async () => {
    await mockDb.webhooks.insert({ _id: 'wh1', serverId: SID, channelId: CID, name: 'Builds' });
    expect(await currentIntegrationInstallation(SID, 'webhook:wh1')).toBe('wh1');
    expect(await currentIntegrationInstallation(OTHER, 'webhook:wh1')).toBeNull();
    await mockDb.channels.update({ _id: CID }, { $set: { serverId: OTHER } });
    expect(await currentIntegrationInstallation(SID, 'webhook:wh1')).toBeNull();
    expect(await bindSelectedIntegrations(SID, ['webhook:wh1'])).toBeNull();
  });

  it('uses server-owned bot identity and fresh linked bot row identity', async () => {
    await mockDb.bots.insert({ _id: 'bot1', username: 'worker', active: true, serverId: SID });
    expect(await currentIntegrationInstallation(SID, 'bot:bot1')).toBe('bot1');
    expect(await currentIntegrationInstallation(OTHER, 'bot:bot1')).toBeNull();
    await mockDb.serverBots.insert({ _id: 'install1', botId: 'bot1', serverId: OTHER, grantedScopes: ['commands'] });
    expect(await currentIntegrationInstallation(OTHER, 'bot:bot1')).toBe('install1');
    await mockDb.serverBots.remove({ botId: 'bot1', serverId: OTHER });
    await mockDb.serverBots.insert({ _id: 'install2', botId: 'bot1', serverId: OTHER, grantedScopes: ['commands'] });
    expect(await currentIntegrationInstallation(OTHER, 'bot:bot1')).toBe('install2');
    expect(await currentIntegrationInstallation(OTHER, 'bot:inactive')).toBeNull();
  });

  it('does not accept installation bindings, plugin exemptions, duplicates, or unknown integrations from client', async () => {
    await mockDb.webhooks.insert({ _id: 'wh1', serverId: SID, channelId: CID, name: 'Builds' });
    expect(await bindSelectedIntegrations(SID, [{ principal: 'webhook:wh1', installationId: 'wh1' }])).toBeNull();
    expect(await bindSelectedIntegrations(SID, ['plugin:plug'])).toBeNull();
    expect(await bindSelectedIntegrations(SID, ['webhook:wh1', 'webhook:wh1'])).toBeNull();
    expect(await bindSelectedIntegrations(SID, ['webhook:missing'])).toBeNull();
    expect(await bindSelectedIntegrations(SID, ['webhook:wh1'])).toEqual([{ principal: 'webhook:wh1', installationId: 'wh1' }]);
  });

  it('lists only server installations and excludes tokens', async () => {
    await mockDb.bots.insert({ _id: 'bot1', username: 'Worker', serverId: SID, active: true });
    await mockDb.webhooks.insert({ _id: 'wh1', name: 'Builds', token: 'PRIVATE', serverId: SID, channelId: CID });
    const rows = await listInstalledIntegrations(SID);
    expect(rows).toEqual(expect.arrayContaining([
      { principal: 'bot:bot1', installationId: 'bot1', name: 'Worker' },
      { principal: 'webhook:wh1', installationId: 'wh1', name: 'Builds' },
    ]));
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  });
});
