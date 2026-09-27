process.env.NODE_ENV = 'test';

const mockFindById = jest.fn();
const mockSubmit = jest.fn();
const mockUpdate = jest.fn();
const mockInfo = jest.fn();

jest.mock('../db/repositories/BotMarketplaceRepository', () => ({
  BotMarketplace: {
    findById: (...args: unknown[]) => mockFindById(...args),
    submit: (...args: unknown[]) => mockSubmit(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: (...args: unknown[]) => mockInfo(...args) },
}));

import { EXAMPLE_BOTS, seedMarketplace } from '../db/seed-marketplace';

describe('canonical marketplace seed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindById.mockResolvedValue(null);
    mockSubmit.mockImplementation(async (row: Record<string, unknown>) => row);
    mockUpdate.mockResolvedValue({});
  });

  it('is idempotent when every catalog id already exists', async () => {
    mockFindById.mockResolvedValue({ id: 'existing' });
    await expect(seedMarketplace()).resolves.toBe(0);
    expect(mockFindById).toHaveBeenCalledTimes(EXAMPLE_BOTS.length);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('seeds missing rows through the marketplace repository and approves them explicitly', async () => {
    await expect(seedMarketplace()).resolves.toBe(EXAMPLE_BOTS.length);
    expect(mockSubmit).toHaveBeenCalledTimes(EXAMPLE_BOTS.length);
    expect(mockUpdate).toHaveBeenCalledTimes(EXAMPLE_BOTS.length);
    for (const [id, fields] of mockUpdate.mock.calls) {
      expect(EXAMPLE_BOTS.some(bot => bot.id === id)).toBe(true);
      expect(fields).toEqual(expect.objectContaining({ approved: true }));
    }
    expect(mockInfo).toHaveBeenCalledTimes(1);
  });

  it('treats a unique conflict as a concurrent idempotent seed winner', async () => {
    mockSubmit.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(seedMarketplace()).resolves.toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not hide non-conflict database failures', async () => {
    const err = Object.assign(new Error('connection lost'), { code: '08006' });
    mockSubmit.mockRejectedValueOnce(err);
    await expect(seedMarketplace()).rejects.toBe(err);
  });

  it('does not count a repository insert that returns no row', async () => {
    mockSubmit.mockResolvedValue(null);
    await expect(seedMarketplace()).resolves.toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // Final21 Phase 14: the seeded catalog declared members:ban, voice:join, roles:assign …
  // and a "verified" official bot, none of which Bridge implements or backs.
  it('ships examples that declare only enforced bot scopes and claim nothing unbacked', async () => {
    const { validateDeclaredBotScopes } = await import('../lib/botScopes');
    for (const bot of EXAMPLE_BOTS) {
      expect({ id: bot.id, declared: validateDeclaredBotScopes(bot.permissions) })
        .toEqual({ id: bot.id, declared: { ok: true, scopes: expect.any(Array) } });
      expect({ id: bot.id, verified: bot.verified, authorVerified: bot.authorVerified, featured: bot.featured })
        .toEqual({ id: bot.id, verified: false, authorVerified: false, featured: false });
      expect(`${bot.supportUrl} ${bot.sourceUrl}`).not.toMatch(/github\.com\/bridge-app/);
    }
  });
});
