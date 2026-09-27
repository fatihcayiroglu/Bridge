process.env.NODE_ENV = 'test';

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: { headers: Record<string, unknown>; user?: Record<string, unknown> }, _res: unknown, next: () => void) => {
    const mode = req.headers['x-user-mode'];
    req.user = mode === 'id-only'
      ? { id: 'id-only-user' }
      : mode === 'anonymous-shape'
        ? {}
        : { _id: 'user-1', id: 'legacy-user-1', username: 'alice' };
    next();
  },
  castAuthed: (req: unknown) => req,
}));

jest.mock('../lib/adminAuthority', () => ({
  databaseAdminOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: {
    general: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    bots: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));

jest.mock('../db/repositories/BotMarketplaceRepository.js', () => ({
  BotMarketplace: {
    getCategories: jest.fn(),
    listBots: jest.fn(),
    findById: jest.fn(),
    submit: jest.fn(),
    rateBot: jest.fn(),
    update: jest.fn(),
    addReview: jest.fn(),
    deleteBot: jest.fn(),
  },
}));

import type { RequestBody } from './helpers/httpDoubles';
import express from 'express';
import request from 'supertest';
import router from '../routes/bot-marketplace';
import { BotMarketplace } from '../db/repositories/BotMarketplaceRepository';

type MockedMarketplace = {
  [K in keyof typeof BotMarketplace]: jest.Mock;
};

const marketplace = BotMarketplace as unknown as MockedMarketplace;

function bot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'helper-bot',
    name: 'Helper Bot',
    author: 'Alice',
    authorVerified: false,
    avatar: '🤖',
    category: 'utility',
    tags: ['safe'],
    description: 'Helpful',
    longDescription: 'Very helpful',
    verified: false,
    featured: false,
    installs: 0,
    rating: '4.25',
    ratingCount: 2,
    commands: ['/help'],
    permissions: ['send'],
    changelog: '',
    supportUrl: '#',
    sourceUrl: '#',
    approved: true,
    submittedBy: 'user-1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/bots/marketplace', router);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  marketplace.getCategories.mockResolvedValue(['music', 'utility']);
  marketplace.listBots.mockResolvedValue({ rows: [bot()], total: 1 });
  marketplace.findById.mockResolvedValue(bot());
  marketplace.submit.mockResolvedValue(bot({ approved: false }));
  marketplace.rateBot.mockResolvedValue(bot());
  marketplace.update.mockResolvedValue(bot());
  marketplace.addReview.mockResolvedValue(undefined);
  marketplace.deleteBot.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('bot marketplace route fallbacks and failures', () => {
  it('filters categories from storage and falls back to the static catalog on read failure', async () => {
    let response = await request(app()).get('/api/bots/marketplace/categories');
    expect(response.status).toBe(200);
    expect(response.body.map((entry: { id: string }) => entry.id)).toEqual(['', 'music', 'utility']);

    marketplace.getCategories.mockRejectedValueOnce(new Error('catalog unavailable'));
    response = await request(app()).get('/api/bots/marketplace/categories');
    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThan(3);
  });

  it('forwards every list filter and normalizes sparse repository rows', async () => {
    marketplace.listBots.mockResolvedValueOnce({
      rows: [bot({ tags: null, commands: null, permissions: null, rating: null })],
      total: 1,
    });
    const response = await request(app())
      .get('/api/bots/marketplace?category=utility&featured=true&q=helper&limit=7&offset=3');
    expect(response.status).toBe(200);
    expect(marketplace.listBots).toHaveBeenCalledWith({
      category: 'utility', search: 'helper', featured: true, limit: 7, offset: 3,
    });
    expect(response.body.bots[0]).toMatchObject({ tags: [], commands: [], permissions: [], rating: 0 });
  });

  it('tells the client exactly what install consent must cover, and what is unsupported', async () => {
    // Final21 Phase 14: the install route compares acceptedPermissions against these
    // canonical scopes; the client must echo them, not re-derive the policy.
    marketplace.listBots.mockResolvedValueOnce({
      rows: [
        bot({ id: 'reply', executableBotId: 'exec-1', permissions: ['messages:reply', 'commands', 'messages:reply'] }),
        bot({ id: 'bare', executableBotId: 'exec-2', permissions: [] }),
        bot({ id: 'overreach', executableBotId: 'exec-3', permissions: ['commands', 'members:ban'] }),
      ],
      total: 3,
    });
    const response = await request(app()).get('/api/bots/marketplace');
    const [reply, bare, overreach] = response.body.bots;
    expect(reply).toMatchObject({ requestedScopes: ['commands', 'messages:reply'], unsupportedPermissions: [], installable: true });
    expect(bare).toMatchObject({ requestedScopes: ['commands'], unsupportedPermissions: [], installable: true });
    expect(overreach).toMatchObject({ requestedScopes: ['commands'], unsupportedPermissions: ['members:ban'], installable: false });
  });

  it('uses list defaults, preserves featured=false, and contains repository errors', async () => {
    let response = await request(app()).get('/api/bots/marketplace');
    expect(response.status).toBe(200);
    expect(marketplace.listBots).toHaveBeenLastCalledWith({
      category: undefined, search: undefined, featured: false, limit: 50, offset: 0,
    });

    marketplace.listBots.mockRejectedValueOnce(new Error('query failed'));
    response = await request(app()).get('/api/bots/marketplace');
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Sunucu hatası');
  });

  it('hides unapproved details and contains detail lookup failures', async () => {
    marketplace.findById.mockResolvedValueOnce(bot({ approved: false }));
    let response = await request(app()).get('/api/bots/marketplace/draft');
    expect(response.status).toBe(404);

    marketplace.findById.mockRejectedValueOnce(new Error('read failed'));
    response = await request(app()).get('/api/bots/marketplace/failing');
    expect(response.status).toBe(500);
  });

  it.each([
    [{ name: 'N', description: 'D', category: 'utility' }, 'id'],
    [{ id: 'valid-id', description: 'D', category: 'utility' }, 'name'],
    [{ id: 'valid-id', name: 'N', category: 'utility' }, 'description'],
    [{ id: 'valid-id', name: 'N', description: 'D' }, 'category'],
  ] as Array<[RequestBody, string]>)('rejects a submission missing %s before storage', async (body) => {
    const response = await request(app()).post('/api/bots/marketplace').send(body);
    expect(response.status).toBe(400);
    expect(marketplace.submit).not.toHaveBeenCalled();
  });

  it('submits minimal and full bot shapes with canonical user fallbacks', async () => {
    marketplace.submit.mockImplementation(async (input: Record<string, unknown>) => bot({ ...input, approved: false }));
    let response = await request(app())
      .post('/api/bots/marketplace')
      .set('x-user-mode', 'id-only')
      .send({ id: 'minimal-bot', name: 'Minimal', description: 'D', category: 'utility' });
    expect(response.status).toBe(201);
    // No declaration means the base scope only (Final21 Phase 14).
    expect(marketplace.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      author: 'unknown', avatar: '🤖', tags: [], longDescription: 'D', commands: [],
      permissions: ['commands'], supportUrl: '#', sourceUrl: '#', submittedBy: 'id-only-user',
    }));

    response = await request(app())
      .post('/api/bots/marketplace')
      .set('x-user-mode', 'anonymous-shape')
      .send({
        id: 'full-bot', name: 'Full', description: 'D', longDescription: 'Long', category: 'utility',
        avatar: '🧰', tags: ['one'], commands: ['/one'], permissions: ['messages:reply', 'commands', 'commands'],
        supportUrl: 'https://support.example', sourceUrl: 'https://source.example',
      });
    expect(response.status).toBe(201);
    expect(marketplace.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      avatar: '🧰', tags: ['one'], longDescription: 'Long', commands: ['/one'],
      permissions: ['commands', 'messages:reply'], supportUrl: 'https://support.example',
      sourceUrl: 'https://source.example', submittedBy: null,
    }));
  });

  it.each([
    ['an unimplemented capability', ['commands', 'members:ban'], /unsupported permissions: members:ban/],
    ['a declaration without the base scope', ['messages:reply'], /must include "commands"/],
    ['a non-array declaration', 'commands', /must be an array/],
  ])('rejects a submission declaring %s', async (_label, permissions, error) => {
    const response = await request(app()).post('/api/bots/marketplace')
      .send({ id: 'bad-perms-bot', name: 'Bad', description: 'D', category: 'utility', permissions });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(error);
    expect(response.body.supported).toEqual(['commands', 'messages:reply']);
  });

  it('maps duplicate submissions to 409 and contains other submit failures', async () => {
    marketplace.submit.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    const body = { id: 'valid-bot', name: 'Valid', description: 'D', category: 'utility' };
    let response = await request(app()).post('/api/bots/marketplace').send(body);
    expect(response.status).toBe(409);

    marketplace.submit.mockRejectedValueOnce(new Error('write failed'));
    response = await request(app()).post('/api/bots/marketplace').send(body);
    expect(response.status).toBe(500);
  });

  it.each([
    undefined, null, '5', 0, 6, 1.5, Number.MAX_SAFE_INTEGER + 1,
  ])('rejects malformed rating %p', async (rating) => {
    const response = await request(app()).post('/api/bots/marketplace/helper-bot/rating').send({ rating });
    expect(response.status).toBe(400);
    expect(marketplace.rateBot).not.toHaveBeenCalled();
  });

  it('rates using the legacy id fallback and contains storage failures', async () => {
    let response = await request(app())
      .post('/api/bots/marketplace/helper-bot/rating')
      .set('x-user-mode', 'id-only')
      .send({ rating: 1 });
    expect(response.status).toBe(200);
    expect(marketplace.rateBot).toHaveBeenCalledWith('helper-bot', 'id-only-user', 1);

    marketplace.rateBot.mockRejectedValueOnce(new Error('rating failed'));
    response = await request(app()).post('/api/bots/marketplace/helper-bot/rating').send({ rating: 5 });
    expect(response.status).toBe(500);
  });

  it('covers patch missing/no-op/plain update and review variants', async () => {
    marketplace.findById.mockResolvedValueOnce(null);
    let response = await request(app()).patch('/api/bots/marketplace/missing').send({ name: 'N' });
    expect(response.status).toBe(404);

    marketplace.update.mockResolvedValueOnce(null);
    response = await request(app()).patch('/api/bots/marketplace/helper-bot').send({ note: 'ignored' });
    expect(response.status).toBe(400);

    response = await request(app()).patch('/api/bots/marketplace/helper-bot').send({ name: 'Renamed' });
    expect(response.status).toBe(200);
    expect(marketplace.addReview).not.toHaveBeenCalled();

    response = await request(app())
      .patch('/api/bots/marketplace/helper-bot')
      .set('x-user-mode', 'id-only')
      .send({ approved: true, note: 'looks good' });
    expect(response.status).toBe(200);
    expect(marketplace.addReview).toHaveBeenLastCalledWith(expect.objectContaining({
      botId: 'helper-bot', reviewerId: 'id-only-user', action: 'approve', note: 'looks good',
    }));

    response = await request(app())
      .patch('/api/bots/marketplace/helper-bot')
      .send({ approved: false, note: { unsafe: true } });
    expect(response.status).toBe(200);
    expect(marketplace.addReview).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'reject', note: '' }));
  });

  it('contains patch lookup, update, and review failures', async () => {
    marketplace.findById.mockRejectedValueOnce(new Error('lookup failed'));
    let response = await request(app()).patch('/api/bots/marketplace/helper-bot').send({ name: 'N' });
    expect(response.status).toBe(500);

    marketplace.update.mockRejectedValueOnce(new Error('update failed'));
    response = await request(app()).patch('/api/bots/marketplace/helper-bot').send({ name: 'N' });
    expect(response.status).toBe(500);

    marketplace.addReview.mockRejectedValueOnce(new Error('review failed'));
    response = await request(app()).patch('/api/bots/marketplace/helper-bot').send({ approved: true });
    expect(response.status).toBe(500);
  });

  it('covers delete success, missing bot, lookup failure, and deletion failure', async () => {
    let response = await request(app()).delete('/api/bots/marketplace/helper-bot');
    expect(response.status).toBe(204);

    marketplace.findById.mockResolvedValueOnce(null);
    response = await request(app()).delete('/api/bots/marketplace/missing');
    expect(response.status).toBe(404);

    marketplace.findById.mockRejectedValueOnce(new Error('lookup failed'));
    response = await request(app()).delete('/api/bots/marketplace/helper-bot');
    expect(response.status).toBe(500);

    marketplace.deleteBot.mockRejectedValueOnce(new Error('delete failed'));
    response = await request(app()).delete('/api/bots/marketplace/helper-bot');
    expect(response.status).toBe(500);
  });
});
