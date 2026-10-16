// HTTP acceptance for per-installation link exemptions (P7 issue #300).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-exemptions-test-secret-32chars';
process.env.REFRESH_SECRET = 'integration-exemptions-refresh-32chars';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission: jest.fn((mask: number, flag: number) => (mask & flag) !== 0),
  PERMS: { MANAGE_SERVER: 8, ADMINISTRATOR: 1 << 30 },
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import automodRouter from '../routes/automod';
import { machineContentRefused } from '../lib/messageContentPolicy';
const db = require('../db/loader');
const perms = require('../lib/permissions');

const SID = 'integration-server-1', SID2 = 'integration-server-2';
const USER = 'integration-owner-1', MEMBER = 'integration-member-1';
const CHANNEL = 'integration-channel-1';
const TOKEN = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const app = express();
app.use(express.json());
app.use('/api/servers/:sid/automod', automodRouter);

beforeEach(async () => {
  db._reset();
  await db.users.insert({ _id: USER, username: 'owner', tokenVersion: 0 });
  await db.users.insert({ _id: MEMBER, username: 'member', tokenVersion: 0 });
  await db.servers.insert({ _id: SID, name: 'One', ownerId: USER });
  await db.servers.insert({ _id: SID2, name: 'Two', ownerId: USER });
  await db.members.insert({ userId: USER, serverId: SID, roles: [] });
  await db.members.insert({ userId: MEMBER, serverId: SID, roles: [] });
  await db.channels.insert({ _id: CHANNEL, name: 'general', type: 'text', serverId: SID });
  await db.webhooks.insert({ _id: 'hook1', name: 'Builder', token: 'secret-never-show', channelId: CHANNEL, serverId: SID });
  await db.bots.insert({ _id: 'bot1', username: 'Worker', serverId: SID, active: true });
  perms.resolvePermissions.mockImplementation(async (id: string) => id === USER ? 8 : 0);
});
const route = `/api/servers/${SID}/automod`;
const manager = () => ({ Authorization: `Bearer ${TOKEN(USER)}` });
const createLinkRule = (config: Record<string, unknown>) => request(app).post(route).set(manager()).send({ type: 'link_filter', config });

describe('server-managed link filter integration exemptions', () => {
  it('manager lists current scoped installations without token exposure; member denied', async () => {
    const res = await request(app).get(`${route}/integrations`).set(manager());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      { principal: 'webhook:hook1', installationId: 'hook1', name: 'Builder' },
      { principal: 'bot:bot1', installationId: 'bot1', name: 'Worker' },
    ]));
    expect(JSON.stringify(res.body)).not.toContain('secret-never-show');
    expect((await request(app).get(`${route}/integrations`).set('Authorization', `Bearer ${TOKEN(MEMBER)}`)).status).toBe(403);
  });

  it('does not accept forged installation ids, plugins, or cross-server principal', async () => {
    const attempts: unknown[] = [
      [{ principal: 'webhook:hook1', installationId: 'fake' }],
      ['plugin:one'],
      ['webhook:unknown'],
      ['webhook:hook1', 'webhook:hook1'],
    ];
    for (const selected of attempts) {
      const res = await createLinkRule({ exemptIntegrations: selected });
      expect(res.status).toBe(400);
    }
    expect(await db.automodRules.count({ serverId: SID })).toBe(0);
  });

  it('creates a rule with server-owned binding and blocks non-exempt or newly installed hooks', async () => {
    const res = await createLinkRule({ exemptIntegrations: ['webhook:hook1'] });
    expect(res.status).toBe(201);
    expect(res.body.config.exemptIntegrations).toEqual([{ principal: 'webhook:hook1', installationId: 'hook1' }]);
    expect(await machineContentRefused({ principalId: 'webhook:hook1', serverId: SID, channelId: CHANNEL, displayName: 'Builder', content: 'https://example.test' }, null)).toBe(false);
    await db.webhooks.insert({ _id: 'hook2', name: 'Other', channelId: CHANNEL, serverId: SID });
    expect(await machineContentRefused({ principalId: 'webhook:hook2', serverId: SID, channelId: CHANNEL, displayName: 'Other', content: 'https://example.test' }, null)).toBe(true);
    expect(await db.auditLogs.count({ serverId: SID, action: 'AUTOMOD_RULE_CREATE' })).toBe(1);
  });

  it('revocation removes exemption on the next post and creates a redacted audit entry', async () => {
    const created = await createLinkRule({ exemptIntegrations: ['webhook:hook1'] });
    expect(created.status).toBe(201);
    const result = await request(app).patch(`${route}/${created.body._id}`).set(manager())
      .send({ config: { exemptIntegrations: [] } });
    expect(result.status).toBe(200);
    expect(await machineContentRefused({ principalId: 'webhook:hook1', serverId: SID, channelId: CHANNEL, displayName: 'Builder', content: 'https://example.test' }, null)).toBe(true);
    const rows = await db.auditLogs.find({ serverId: SID, action: 'AUTOMOD_RULE_UPDATE' });
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toContain('webhook:hook1');
    expect(rows[0].detail).not.toContain('secret-never-show');
  });

  it('never exempts the same integration from blocked_words', async () => {
    expect((await createLinkRule({ exemptIntegrations: ['webhook:hook1'] })).status).toBe(201);
    const attempt = await request(app).post(route).set(manager())
      .send({ type: 'blocked_words', config: { words: ['forbidden'], exemptIntegrations: ['webhook:hook1'] } });
    expect(attempt.status).toBe(400);
    await request(app).post(route).set(manager()).send({ type: 'blocked_words', config: { words: ['forbidden'] } });
    expect(await machineContentRefused({ principalId: 'webhook:hook1', serverId: SID, channelId: CHANNEL, displayName: 'Builder', content: 'https://example.test/forbidden' }, null)).toBe(true);
  });

  it('stale cross-server webhook channel reparenting refuses new exemption writes', async () => {
    await db.channels.update({ _id: CHANNEL }, { $set: { serverId: SID2 } });
    expect((await createLinkRule({ exemptIntegrations: ['webhook:hook1'] })).status).toBe(400);
    expect(await db.automodRules.count({ serverId: SID })).toBe(0);
  });
});
