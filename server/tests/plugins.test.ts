// server/tests/plugins.test.ts
// Sprint 66+: plugins/word-filter, plugins/welcome-bot, plugins/allowlist birim testleri
// Coverage hedefi: lines 80%, functions 75%, branches 70%
'use strict';

process.env.NODE_ENV = 'test';

// ── allowlist testleri ────────────────────────────────────────
import {
  validateManifest,
  isAllowed,
  ALLOWED_PERMISSIONS,
  RESTRICTED_PERMISSIONS,
  BANNED_PERMISSIONS,
  BANNED_CATEGORIES,
  type PluginMeta,
} from '../../plugins/allowlist';

describe('allowlist — validateManifest', () => {
  const validMeta: PluginMeta = {
    id:      'test-plugin',
    name:    'Test Plugin',
    version: '1.0.0',
  };

  it('geçerli manifest → ok: true, reasons boş', () => {
    const result = validateManifest(validMeta);
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('id eksik → hata', () => {
    const result = validateManifest({ name: 'X', version: '1.0.0' });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('id'))).toBe(true);
  });

  it('name eksik → hata', () => {
    const result = validateManifest({ id: 'x', version: '1.0.0' });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('name'))).toBe(true);
  });

  it('version eksik → hata', () => {
    const result = validateManifest({ id: 'x', name: 'X' });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('version'))).toBe(true);
  });

  it('geçersiz id formatı (büyük harf) → hata', () => {
    const result = validateManifest({ id: 'My_Plugin', name: 'X', version: '1.0.0' });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('id'))).toBe(true);
  });

  it('geçersiz id (çok kısa 1 karakter) → hata', () => {
    const result = validateManifest({ id: 'a', name: 'X', version: '1.0.0' });
    expect(result.ok).toBe(false);
  });

  it('geçersiz versiyon formatı → hata', () => {
    const result = validateManifest({ id: 'x-plugin', name: 'X', version: 'v1' });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('versiyon'))).toBe(true);
  });

  it('yasaklı izin → hata', () => {
    const result = validateManifest({
      ...validMeta,
      permissions: ['admin:write'],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('admin:write'))).toBe(true);
  });

  it('bilinmeyen izin → hata', () => {
    const result = validateManifest({
      ...validMeta,
      permissions: ['unknown:permission'],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('Bilinmeyen'))).toBe(true);
  });

  it('izin listesi dizi değilse → hata', () => {
    const result = validateManifest({
      ...validMeta,
      permissions: 'messages:read' as unknown as string[],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('dizi'))).toBe(true);
  });

  it('izin içinde string olmayan değer → hata', () => {
    const result = validateManifest({
      ...validMeta,
      permissions: [42 as unknown as string],
    });
    expect(result.ok).toBe(false);
  });

  it('allowed permission → ok', () => {
    const result = validateManifest({
      ...validMeta,
      permissions: ['messages:read', 'messages:send'],
    });
    expect(result.ok).toBe(true);
  });

  it('restricted permission → ok (özel onay gerektirir ama reddedilmez)', () => {
    const result = validateManifest({
      ...validMeta,
      permissions: ['admin:read'],
    });
    expect(result.ok).toBe(true);
  });

  it('yasaklı kategori → hata', () => {
    const result = validateManifest({ ...validMeta, category: 'adult' });
    expect(result.ok).toBe(false);
    expect(result.reasons.some(r => r.includes('adult'))).toBe(true);
  });

  it('geçerli kategori → ok', () => {
    const result = validateManifest({ ...validMeta, category: 'moderation' });
    expect(result.ok).toBe(true);
  });

  it('category string değilse → hata', () => {
    const result = validateManifest({
      ...validMeta,
      category: 123 as unknown as string,
    });
    expect(result.ok).toBe(false);
  });

  it('tüm banned permissions setinde olmalı', () => {
    for (const perm of BANNED_PERMISSIONS) {
      const result = validateManifest({ ...validMeta, permissions: [perm] });
      expect(result.ok).toBe(false);
    }
  });

  it('tüm banned categories setinde olmalı', () => {
    for (const cat of BANNED_CATEGORIES) {
      const result = validateManifest({ ...validMeta, category: cat });
      expect(result.ok).toBe(false);
    }
  });

  it('birden fazla hata — hepsi reasons listesinde', () => {
    const result = validateManifest({ id: 'Bad', name: undefined, version: 'x' });
    expect(result.reasons.length).toBeGreaterThan(1);
  });
});

describe('allowlist — isAllowed', () => {
  it('geçerli meta → true', () => {
    expect(isAllowed({ id: 'ok-plugin', name: 'OK', version: '2.0.0' })).toBe(true);
  });

  it('geçersiz meta → false + logger.warn', () => {
    const warn = jest.fn();
    const result = isAllowed({ id: 'BAD', name: 'X', version: '1.0.0' }, { warn });
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('allowlist — permission/category setleri', () => {
  it('ALLOWED_PERMISSIONS en az 5 izin içermeli', () => {
    expect(ALLOWED_PERMISSIONS.size).toBeGreaterThanOrEqual(5);
  });

  it('RESTRICTED_PERMISSIONS en az 1 izin içermeli', () => {
    expect(RESTRICTED_PERMISSIONS.size).toBeGreaterThanOrEqual(1);
  });

  it('BANNED_PERMISSIONS ile ALLOWED_PERMISSIONS örtüşmemeli', () => {
    for (const perm of BANNED_PERMISSIONS) {
      expect(ALLOWED_PERMISSIONS.has(perm)).toBe(false);
    }
  });
});

// ── word-filter testleri ──────────────────────────────────────

// PluginContext mock factory
function makeCtx(config: Record<string, unknown> = {}) {
  const emitted: { event: string; payload: unknown }[] = [];
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  const hooks = {
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    }),
    emit: jest.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
  };

  const routes: { method: string; path: string; handler: (...a: unknown[]) => void }[] = [];

  const ctx = {
    meta:   { id: 'word-filter', name: 'Word Filter', version: '1.0.0', config },
    hooks,
    db: {
      channels: {
        find: jest.fn(async () => [
          { _id: 'ch-mod', name: 'mod-log' },
          { _id: 'ch-general', name: 'genel' },
        ]),
      },
    },
    logger: {
      log:   jest.fn(),
      warn:  jest.fn(),
      error: jest.fn(),
    },
    registerRoute: jest.fn((method: string, path: string, handler: (...a: unknown[]) => void) => {
      routes.push({ method, path, handler });
    }),
    // test helpers
    _emitted:   emitted,
    _listeners: listeners,
    _routes:    routes,
  };
  return ctx;
}

describe('word-filter — setup', () => {
  // Dinamik import (ts-jest ile ../../plugins/ resolve edilir)
  let setup: (ctx: unknown) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('../../plugins/word-filter/index');
    setup = mod.setup;
  });

  it('blockedWords boşken pasif kalır — warn loglar', async () => {
    const ctx = makeCtx({ blockedWords: [] });
    await setup(ctx);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('/blocked route kaydedilir', async () => {
    const ctx = makeCtx({ blockedWords: ['spam'] });
    await setup(ctx);
    expect(ctx.registerRoute).toHaveBeenCalledWith('GET', '/blocked', expect.any(Function));
  });

  it('/blocked route — yasaklı kelimeleri döndürür', async () => {
    const ctx = makeCtx({ blockedWords: ['spam', 'scam'] });
    await setup(ctx);
    const route = ctx._routes.find(r => r.path === '/blocked');
    const res = { json: jest.fn() };
    route!.handler({}, res);
    expect(res.json).toHaveBeenCalledWith({ blockedWords: ['spam', 'scam'] });
  });

  it('message:created hook kaydedilir', async () => {
    const ctx = makeCtx({ blockedWords: ['spam'] });
    await setup(ctx);
    expect(ctx.hooks.on).toHaveBeenCalledWith('message:created', expect.any(Function));
  });

  it('yasaklı kelime içeren mesaj → deleteMessage emit edilir', async () => {
    const ctx = makeCtx({ blockedWords: ['spam'], warnUser: false });
    await setup(ctx);
    const handler = ctx._listeners['message:created'][0];
    await handler({
      messageId:   'msg-1',
      channelId:   'ch-1',
      serverId:    'srv-1',
      userId:      'usr-1',
      content:     'bu bir SPAM mesajdır',
      displayName: 'Testçi',
    });
    expect(ctx._emitted.some(e => e.event === 'plugin:deleteMessage')).toBe(true);
  });

  it('warnUser:true → sendMessage emit edilir', async () => {
    const ctx = makeCtx({ blockedWords: ['spam'], warnUser: true });
    await setup(ctx);
    const handler = ctx._listeners['message:created'][0];
    await handler({
      messageId:   'msg-2',
      channelId:   'ch-1',
      serverId:    'srv-1',
      userId:      'usr-1',
      content:     'spam içerik',
      displayName: 'Kullanıcı',
    });
    const warns = ctx._emitted.filter(e => e.event === 'plugin:sendMessage');
    expect(warns.length).toBeGreaterThan(0);
  });

  it('temiz mesaj → hiç emit yok', async () => {
    const ctx = makeCtx({ blockedWords: ['spam'] });
    await setup(ctx);
    const handler = ctx._listeners['message:created'][0];
    await handler({
      messageId:   'msg-3',
      channelId:   'ch-1',
      serverId:    'srv-1',
      userId:      'usr-1',
      content:     'merhaba dünya',
      displayName: 'Kullanıcı',
    });
    expect(ctx._emitted).toHaveLength(0);
  });

  it('content undefined → sessizce geçer', async () => {
    const ctx = makeCtx({ blockedWords: ['spam'] });
    await setup(ctx);
    const handler = ctx._listeners['message:created'][0];
    await expect(
      handler({ messageId: 'm', channelId: 'c', serverId: 's', userId: 'u', content: undefined, displayName: 'd' })
    ).resolves.not.toThrow();
  });

  it('mod-log kanalı bulunursa log mesajı gönderilir', async () => {
    const ctx = makeCtx({ blockedWords: ['spam'], warnUser: false, logChannelName: 'mod-log' });
    await setup(ctx);
    const handler = ctx._listeners['message:created'][0];
    await handler({
      messageId:   'msg-4',
      channelId:   'ch-1',
      serverId:    'srv-1',
      userId:      'usr-1',
      content:     'spam içerik',
      displayName: 'Kullanıcı',
    });
    const logEmits = ctx._emitted.filter(
      e => e.event === 'plugin:sendMessage' && (e.payload as { channelId: string }).channelId === 'ch-mod'
    );
    expect(logEmits.length).toBeGreaterThan(0);
  });
});

// ── welcome-bot testleri ──────────────────────────────────────

describe('welcome-bot — setup', () => {
  let setup: (ctx: unknown) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('../../plugins/welcome-bot/index');
    setup = mod.setup;
  });

  it('/config route kaydedilir', async () => {
    const ctx = makeCtx({});
    await setup(ctx);
    expect(ctx.registerRoute).toHaveBeenCalledWith('GET', '/config', expect.any(Function));
  });

  it('/config route — config ve status döndürür', async () => {
    const ctx = makeCtx({ channelName: 'genel' });
    await setup(ctx);
    const route = ctx._routes.find(r => r.path === '/config');
    const res = { json: jest.fn() };
    route!.handler({}, res);
    const call = res.json.mock.calls[0][0];
    expect(call).toHaveProperty('status', 'active');
  });

  it('member:joined hook kaydedilir', async () => {
    const ctx = makeCtx({});
    await setup(ctx);
    expect(ctx.hooks.on).toHaveBeenCalledWith('member:joined', expect.any(Function));
  });

  it('yeni üye → hoş geldiniz mesajı emit edilir', async () => {
    const ctx = makeCtx({ channelName: 'genel' });
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    await handler({
      userId:      'usr-5',
      serverId:    'srv-1',
      displayName: 'Ahmet',
      username:    'ahmet',
    });
    expect(ctx._emitted.some(e => e.event === 'plugin:sendMessage')).toBe(true);
  });

  it('{username} template değişkeni yerine konulur', async () => {
    const ctx = makeCtx({ messageTemplate: 'Merhaba {username}!' });
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    await handler({
      userId:      'usr-6',
      serverId:    'srv-1',
      displayName: 'Zeynep',
      username:    'zeynep',
    });
    const emit = ctx._emitted.find(e => e.event === 'plugin:sendMessage');
    expect((emit!.payload as { content: string }).content).toContain('Zeynep');
  });

  it('kanal bulunamazsa sessizce geçer', async () => {
    const ctx = makeCtx({ channelName: 'genel' });
    (ctx.db.channels.find as jest.Mock).mockResolvedValueOnce([]); // boş liste
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    await expect(
      handler({ userId: 'u', serverId: 's', displayName: 'd', username: 'u' })
    ).resolves.not.toThrow();
    expect(ctx._emitted).toHaveLength(0);
  });

  it('db hatası → error loglanır, fırlatılmaz', async () => {
    const ctx = makeCtx({});
    (ctx.db.channels.find as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    await expect(
      handler({ userId: 'u', serverId: 's', displayName: 'd', username: 'u' })
    ).resolves.not.toThrow();
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('displayName boşsa username kullanılır', async () => {
    const ctx = makeCtx({ messageTemplate: 'Hoş geldin {username}!' });
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    await handler({
      userId:      'usr-7',
      serverId:    'srv-1',
      displayName: '',
      username:    'tester',
    });
    const emit = ctx._emitted.find(e => e.event === 'plugin:sendMessage');
    expect((emit!.payload as { content: string }).content).toContain('tester');
  });
});

// ── auto-role testleri ──────────────────────────────────────────

describe('auto-role — setup', () => {
  let setup: (ctx: unknown) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('../../plugins/auto-role/index');
    setup = mod.setup;
  });

  function makeAutoRoleCtx(config: Record<string, unknown> = {}) {
    const ctx = makeCtx(config);
    ctx.db.members = {
      findOne: jest.fn(async () => ({
        userId: 'usr-ar', serverId: 'srv-1', roles: '[]',
      })),
    };
    return ctx;
  }

  it('roleId boşken pasif kalır — warn loglar', async () => {
    const ctx = makeAutoRoleCtx({ roleId: '' });
    await setup(ctx);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('/config route kaydedilir', async () => {
    const ctx = makeAutoRoleCtx({ roleId: 'role-member' });
    await setup(ctx);
    expect(ctx.registerRoute).toHaveBeenCalledWith('GET', '/config', expect.any(Function));
  });

  it('/config route — roleId ve status döndürür', async () => {
    const ctx = makeAutoRoleCtx({ roleId: 'role-member', delayMs: 100 });
    await setup(ctx);
    const route = ctx._routes.find(r => r.path === '/config');
    const res = { json: jest.fn() };
    route!.handler({}, res);
    expect(res.json).toHaveBeenCalledWith({
      roleId: 'role-member', delayMs: 100, status: 'active',
    });
  });

  it('member:joined hook kaydedilir', async () => {
    const ctx = makeAutoRoleCtx({ roleId: 'role-member' });
    await setup(ctx);
    expect(ctx.hooks.on).toHaveBeenCalledWith('member:joined', expect.any(Function));
  });

  it('yeni üye → plugin:grantRole emit edilir', async () => {
    const ctx = makeAutoRoleCtx({ roleId: 'role-member' });
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    await handler({ userId: 'usr-ar', serverId: 'srv-1', username: 'ahmet' });

    expect(ctx._emitted.some(e => e.event === 'plugin:grantRole')).toBe(true);
    const emit = ctx._emitted.find(e => e.event === 'plugin:grantRole');
    expect(emit!.payload).toEqual({ userId: 'usr-ar', serverId: 'srv-1', roleId: 'role-member' });
  });

  it('rol zaten atanmışsa emit yapılmaz', async () => {
    const ctx = makeAutoRoleCtx({ roleId: 'role-member' });
    (ctx.db.members.findOne as jest.Mock).mockResolvedValue({
      userId: 'usr-ar', serverId: 'srv-1', roles: '["role-member"]',
    });
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    await handler({ userId: 'usr-ar', serverId: 'srv-1', username: 'ahmet' });
    expect(ctx._emitted).toHaveLength(0);
  });

  it('delayMs > 0 ile assign gecikmeli çalışır', async () => {
    jest.useFakeTimers();
    const ctx = makeAutoRoleCtx({ roleId: 'role-delay', delayMs: 500 });
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    handler({ userId: 'usr-d', serverId: 'srv-1', username: 'delayed' });
    expect(ctx._emitted).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx._emitted.some(e => e.event === 'plugin:grantRole')).toBe(true);
    jest.useRealTimers();
  });

  it('üye bulunamazsa sessizce geçer', async () => {
    const ctx = makeAutoRoleCtx({ roleId: 'role-member' });
    (ctx.db.members.findOne as jest.Mock).mockResolvedValue(null);
    await setup(ctx);
    const handler = ctx._listeners['member:joined'][0];
    await expect(
      handler({ userId: 'u', serverId: 's', username: 'x' }),
    ).resolves.not.toThrow();
    expect(ctx._emitted).toHaveLength(0);
  });
});

// ── registry.ts — hooks.on('*') wildcard entegrasyon testleri ─────────────────
// Sprint 77: registry emit() yalnızca tam eşleşmeye bakıyordu; '*' listener'lar
// atlanıyordu. lifecycle.ts hooks.on('*') kullanır — bu yüzden plugin worker'ına
// hiçbir event iletilmiyordu. Fix: emit() her zaman '*' bucket'ını da tarar.

import { register, emit, unregister } from '../../plugins/registry';

describe("registry — hooks.on('*') wildcard", () => {
  afterEach(() => {
    // Wildcard testleri izole kalsın
    try { unregister('wc-plugin-a'); } catch { /* kayıtlı değilse sorun yok */ }
    try { unregister('wc-plugin-b'); } catch { /* */ }
  });

  it("'*' listener tüm event'leri alır", async () => {
    const hooks = register('wc-plugin-a', { id: 'wc-plugin-a', name: 'WC-A', version: '1.0.0' });
    const received: string[] = [];
    hooks.on('*', (data: unknown) => { received.push((data as { _event?: string })._event ?? '?'); });

    await emit('message:created', { _event: 'message:created' });
    await emit('member:joined',   { _event: 'member:joined' });
    await emit('reaction:added',  { _event: 'reaction:added' });

    expect(received).toEqual(['message:created', 'member:joined', 'reaction:added']);
  });

  it("spesifik listener VE wildcard listener aynı anda tetiklenir", async () => {
    const hooks = register('wc-plugin-a', { id: 'wc-plugin-a', name: 'WC-A', version: '1.0.0' });
    const specific: unknown[] = [];
    const wildcard: unknown[] = [];

    hooks.on('message:created', (d) => specific.push(d));
    hooks.on('*',               (d) => wildcard.push(d));

    await emit('message:created', { id: 'msg-1' });

    expect(specific).toHaveLength(1);
    expect(wildcard).toHaveLength(1);
  });

  it("wildcard olmayan event spesifik listener'ı tetikler, wildcard'ı tetiklemez", async () => {
    const hooks = register('wc-plugin-a', { id: 'wc-plugin-a', name: 'WC-A', version: '1.0.0' });
    const specific: unknown[] = [];

    hooks.on('message:created', (d) => specific.push(d));
    // wildcard kayıtlı DEĞİL

    await emit('message:created', { id: 'msg-2' });
    await emit('member:joined',   { id: 'usr-1' });

    expect(specific).toHaveLength(1); // yalnızca message:created
  });

  it("farklı plugin'in wildcard listener'ı izole kalır", async () => {
    const hooksA = register('wc-plugin-a', { id: 'wc-plugin-a', name: 'WC-A', version: '1.0.0' });
    const hooksB = register('wc-plugin-b', { id: 'wc-plugin-b', name: 'WC-B', version: '1.0.0' });

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];

    hooksA.on('*', (d) => receivedA.push(d));
    hooksB.on('message:created', (d) => receivedB.push(d));

    await emit('message:created', { id: 'msg-3' });

    expect(receivedA).toHaveLength(1); // wildcard her event'i alır
    expect(receivedB).toHaveLength(1); // spesifik listener da alır
  });

  it("unregister sonrası wildcard listener artık çağrılmaz", async () => {
    const hooks = register('wc-plugin-a', { id: 'wc-plugin-a', name: 'WC-A', version: '1.0.0' });
    const received: unknown[] = [];

    hooks.on('*', (d) => received.push(d));
    await emit('message:created', { id: 'msg-before' });
    expect(received).toHaveLength(1);

    unregister('wc-plugin-a');

    await emit('message:created', { id: 'msg-after' });
    expect(received).toHaveLength(1); // yeni event gelmemeli
  });

  it("wildcard listener off() ile kaldırılabilir", async () => {
    const hooks = register('wc-plugin-a', { id: 'wc-plugin-a', name: 'WC-A', version: '1.0.0' });
    const received: unknown[] = [];

    const fn = (d: unknown): void => { received.push(d); };
    hooks.on('*', fn);
    await emit('message:created', { id: 'msg-1' });
    expect(received).toHaveLength(1);

    hooks.off('*', fn);
    await emit('message:created', { id: 'msg-2' });
    expect(received).toHaveLength(1); // off sonrası artık tetiklenmemeli
  });
});
