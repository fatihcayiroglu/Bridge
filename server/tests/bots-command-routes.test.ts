import express from 'express';
import request from 'supertest';

const mockBots = {
  create: jest.fn(),
  delete: jest.fn(),
  findByIdAndServer: jest.fn(),
  findByServer: jest.fn(),
  findInstalledForServer: jest.fn(),
  updateByIdAndServer: jest.fn(),
  updateToken: jest.fn(),
};
const mockChannels = { findById: jest.fn() };
const mockChannelWebhooks = { findById: jest.fn() };
const mockMessages = { create: jest.fn() };
const mockResolvePermissions = jest.fn();
const mockBot = {
  _id: 'bot-1',
  serverId: 'server-1',
  username: 'Command Bot',
  tokenHash: 'must-never-leave-the-server',
};

jest.mock('../db/repositories', () => ({
  Bots: mockBots,
  Channels: mockChannels,
  ChannelWebhooks: mockChannelWebhooks,
  Messages: mockMessages,
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1' };
    next();
  },
}));
jest.mock('../middleware/botAuth', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = mockBot;
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: { bots: () => (_req: any, _res: any, next: any) => next() },
}));
jest.mock('../lib/permissions', () => ({
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
  hasPermission: (actual: number, required: number) => (actual & required) === required,
  PERMS: { MANAGE_SERVER: 1, ADMIN: 2, USE_BOT_COMMANDS: 4 },
}));
jest.mock('uuid', () => ({ v4: () => 'message-1' }));

import botsRouter from '../routes/bots';

const app = express();
app.use(express.json());
app.use('/api/bot', botsRouter);
app.use('/api/webhooks', botsRouter);

describe('bot command self-service and webhook target boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolvePermissions.mockResolvedValue(4);
    mockBots.updateByIdAndServer.mockResolvedValue({ updated: 1 });
    mockBots.findInstalledForServer.mockResolvedValue([]);
  });

  it('never exposes the credential hash from bot self-service identity', async () => {
    const response = await request(app).get('/api/bot/me');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      _id: 'bot-1',
      serverId: 'server-1',
      name: 'Command Bot',
    }));
    expect(response.body.tokenHash).toBeUndefined();
  });

  it('normalizes context commands before persisting them to the authenticated bot', async () => {
    const response = await request(app)
      .patch('/api/bot/me/context-commands')
      .send({
        commands: [{
          name: 'Inspect message',
          type: 'MESSAGE_COMMAND',
          description: '  Show audit details  ',
        }],
      });

    const commands = [{
      name: 'Inspect message',
      type: 'MESSAGE_COMMAND',
      description: 'Show audit details',
    }];
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ commands });
    expect(mockBots.updateByIdAndServer).toHaveBeenCalledWith(
      'bot-1',
      'server-1',
      { contextCommands: commands },
    );
  });

  it('rejects a non-object command payload without mutating bot metadata', async () => {
    const response = await request(app)
      .patch('/api/bot/me/context-commands')
      .send([]);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid context commands' });
    expect(mockBots.updateByIdAndServer).not.toHaveBeenCalled();
  });

  it('requires an explicit server scope before command discovery', async () => {
    const response = await request(app).get('/api/bot/commands');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'serverId required' });
    expect(mockResolvePermissions).not.toHaveBeenCalled();
  });

  it('fails command discovery closed when permission resolution is unavailable', async () => {
    mockResolvePermissions.mockRejectedValueOnce(new Error('permission store unavailable'));

    const response = await request(app).get('/api/bot/commands?serverId=server-1');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'No USE_BOT_COMMANDS permission' });
    expect(mockBots.findInstalledForServer).not.toHaveBeenCalled();
  });

  it('returns only valid persisted slash commands from installed bots', async () => {
    mockBots.findInstalledForServer.mockResolvedValueOnce([
      {
        _id: 'bot-1',
        username: 'Command Bot',
        slashCommands: JSON.stringify([
          { name: 'ping', description: 'Health check', usage: '/ping' },
          { name: 'not valid', description: 'must be ignored', usage: '' },
        ]),
      },
      { _id: 'bot-2', username: 'Corrupt Bot', slashCommands: '{not-json' },
    ]);

    const response = await request(app).get('/api/bot/commands?serverId=server-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      commands: [{
        name: 'ping',
        description: 'Health check',
        usage: '/ping',
        botId: 'bot-1',
        botName: 'Command Bot',
      }],
    });
  });

  it('rejects a webhook whose persisted record has no channel scope', async () => {
    mockChannelWebhooks.findById.mockResolvedValueOnce({
      _id: 'webhook-1',
      token: 'secret',
      name: 'Build Bot',
    });

    const response = await request(app)
      .post('/api/webhooks/webhook-1?token=secret')
      .send({ content: 'build complete' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Webhook kanal bilgisi eksik' });
    expect(mockChannels.findById).not.toHaveBeenCalled();
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it('does not create a message when a webhook points at a deleted channel', async () => {
    mockChannelWebhooks.findById.mockResolvedValueOnce({
      _id: 'webhook-1',
      channelId: 'deleted-channel',
      token: 'secret',
      name: 'Build Bot',
    });
    mockChannels.findById.mockResolvedValueOnce(null);

    const response = await request(app)
      .post('/api/webhooks/webhook-1?token=secret')
      .send({ content: 'build complete' });

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/^Kanal bulunamad/);
    expect(mockMessages.create).not.toHaveBeenCalled();
  });
});
