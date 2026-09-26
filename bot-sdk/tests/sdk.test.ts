/**
 * bot-sdk/tests/sdk.test.ts
 * Sprint 106: Bot SDK builder sınıfları + BridgeBot unit testleri
 *
 * BridgeBot için socket.io-client mock'lanır — gerçek ağ bağlantısı yok.
 */

// ── socket.io-client mock ─────────────────────────────────────

const mockSocketOn    = jest.fn().mockReturnThis();
const mockSocketEmit  = jest.fn().mockReturnThis();
const mockSocketOff   = jest.fn().mockReturnThis();
const mockSocketClose = jest.fn();
// SDK `socket.disconnect()` cagirir (socket.io-client kanonik adi).
// Taklit yalnizca `close` tanimliyordu, bu yuzden `disconnect close() cagirir`
// testi gercekte HICBIR SEY olcmuyordu.
const mockSocketDisconnect = jest.fn();

// AÇIK TİP ZORUNLU: `once` gövdesi `mockSocket`i DÖNDÜRÜYOR, yani nesne kendi
// başlatıcısında kendine referans veriyor. Anotasyon olmadan TypeScript tipi
// çıkaramaz ve TS7022/TS7024 verir. Bu dosya HİÇ derlenmediği için (paketin
// `tsconfig.json`u yalnızca `src/**` içeriyordu, bkz. tsconfig.jest.json) hata
// hiç görünmedi — suit zaten hiçbir koşucu tarafından çalıştırılmıyordu.
type MockSocket = {
  connected: boolean;
  on:    jest.Mock;
  off:   jest.Mock;
  emit:  jest.Mock;
  close:      jest.Mock;
  disconnect: jest.Mock;
  once:       jest.Mock;
};

const mockSocket: MockSocket = {
  connected: true,
  on:        mockSocketOn,
  off:       mockSocketOff,
  emit:      mockSocketEmit,
  close:      mockSocketClose,
  disconnect: mockSocketDisconnect,
  once:      jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    // `connect()` gercek socket.io gibi `once('connect')` bekler. Taklit
    // yalnizca 'ready' icin ates ediyordu, bu yuzden `await bot.connect()`
    // HIC cozulmuyor ve testi zaman asimina ugratiyordu.
    if (event === 'connect') {
      setTimeout(() => cb(), 0);
    }
    if (event === 'ready') {
      setTimeout(() => cb({ id: 'bot-id', username: 'TestBot', displayName: 'Test Bot' }), 0);
    }
    return mockSocket;
  }),
};

jest.mock('socket.io-client', () => ({
  io: jest.fn().mockReturnValue(mockSocket),
}));

// ── fetch mock ────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── Imports ───────────────────────────────────────────────────

import {
  BridgeBot,
  MessageBuilder,
  EmbedBuilder,
  ButtonBuilder,
  BotStore,
  PaginationHelper,
  SDK_VERSION,
  BridgeUnsupportedError,
  BridgeApiError,
  type CommandContext,
} from '../src/index';

// ─────────────────────────────────────────────────────────────
// MessageBuilder
// ─────────────────────────────────────────────────────────────

describe('MessageBuilder', () => {
  it('title bold formatında render edilir', () => {
    const out = new MessageBuilder().title('Merhaba').build();
    expect(out).toBe('**Merhaba**');
  });

  it('field "**isim:** değer" formatında render edilir', () => {
    const out = new MessageBuilder().field('Alan', 'Değer').build();
    expect(out).toBe('**Alan:** Değer');
  });

  it('divider çizgisi içerir', () => {
    const out = new MessageBuilder().text('x').divider().text('y').build();
    expect(out).toContain('──');
  });

  it('code bloğu doğru fence\'lerle sarılır', () => {
    const out = new MessageBuilder().code('x = 1', 'python').build();
    expect(out).toContain('```python');
    expect(out).toContain('x = 1');
    expect(out).toContain('```');
  });

  it('code lang belirtilmezse fence language boş kalır', () => {
    const out = new MessageBuilder().code('x = 1').build();
    expect(out).toContain('```\n');
  });

  it('zincir metodlar çalışır', () => {
    const out = new MessageBuilder()
      .title('Başlık')
      .text('Metin')
      .field('K', 'V')
      .divider()
      .code('{}', 'json')
      .build();
    expect(out.split('\n').length).toBeGreaterThan(4);
  });

  it('boş builder boş string döner', () => {
    expect(new MessageBuilder().build()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────
// EmbedBuilder
// ─────────────────────────────────────────────────────────────

describe('EmbedBuilder', () => {
  it('başlık bold olarak içerilir', () => {
    const out = new EmbedBuilder().setTitle('Test').build();
    expect(out).toContain('**Test**');
  });

  it('açıklama içerilir', () => {
    const out = new EmbedBuilder().setDescription('Açıklama').build();
    expect(out).toContain('Açıklama');
  });

  it('footer italik olarak footer çizgisinden sonra gelir', () => {
    const out = new EmbedBuilder().setTitle('T').setFooter('Alt').build();
    expect(out).toContain('*Alt*');
  });

  it('inline field noktayla ayrılmış tek satırda render edilir', () => {
    const out = new EmbedBuilder()
      .addField('A', 'x', { inline: true })
      .addField('B', 'y', { inline: true })
      .build();
    expect(out).toContain('·');
  });

  it('block field kendi satırında render edilir', () => {
    const out = new EmbedBuilder()
      .addField('Alan', 'Değer')
      .build();
    expect(out).toContain('**Alan**\nDeğer');
  });

  it('setColor fırlatmaz (gelecek özellik)', () => {
    expect(() => new EmbedBuilder().setColor('#ff0000').build()).not.toThrow();
  });

  it('hiçbir şey olmadan da bir şeyler döner (divider en az var)', () => {
    const out = new EmbedBuilder().build();
    expect(out.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
// ButtonBuilder
// ─────────────────────────────────────────────────────────────

describe('ButtonBuilder', () => {
  it('tek buton ActionRow üretir', () => {
    const row = new ButtonBuilder()
      .addButton({ customId: 'btn1', label: 'Tıkla' })
      .build();
    expect(row.type).toBe('action_row');
    expect(row.buttons).toHaveLength(1);
    expect(row.buttons[0].customId).toBe('btn1');
    expect(row.buttons[0].label).toBe('Tıkla');
  });

  it('varsayılan stil "primary"dir', () => {
    const row = new ButtonBuilder()
      .addButton({ customId: 'x', label: 'X' })
      .build();
    expect(row.buttons[0].style).toBe('primary');
  });

  it('tüm stiller kabul edilir', () => {
    const styles = ['primary', 'secondary', 'success', 'danger', 'link'] as const;
    for (const style of styles) {
      const row = new ButtonBuilder()
        .addButton({ customId: 'x', label: 'X', style })
        .build();
      expect(row.buttons[0].style).toBe(style);
    }
  });

  it('disabled=true buton disabled olarak işaretlenir', () => {
    const row = new ButtonBuilder()
      .addButton({ customId: 'x', label: 'Devre Dışı', disabled: true })
      .build();
    expect(row.buttons[0].disabled).toBe(true);
  });

  it('customId veya label eksikse fırlatır', () => {
    expect(() =>
      new ButtonBuilder().addButton({ customId: '', label: 'test' })
    ).toThrow();
    expect(() =>
      new ButtonBuilder().addButton({ customId: 'test', label: '' })
    ).toThrow();
  });

  it('toString buton etiketlerini köşeli parantezle gösterir', () => {
    const b = new ButtonBuilder()
      .addButton({ customId: 'a', label: 'Evet' })
      .addButton({ customId: 'b', label: 'Hayır' });
    expect(b.toString()).toBe('[Evet] [Hayır]');
  });

  it('birden fazla buton eklenebilir', () => {
    const row = new ButtonBuilder()
      .addButton({ customId: 'a', label: 'A' })
      .addButton({ customId: 'b', label: 'B' })
      .addButton({ customId: 'c', label: 'C' })
      .build();
    expect(row.buttons).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────
// BotStore
// ─────────────────────────────────────────────────────────────

describe('BotStore', () => {
  it('set ve get çalışır', () => {
    const store = new BotStore<number>();
    store.set('x', 42);
    expect(store.get('x')).toBe(42);
  });

  it('has var olan key için true döner', () => {
    const store = new BotStore<string>();
    store.set('k', 'v');
    expect(store.has('k')).toBe(true);
  });

  it('has olmayan key için false döner', () => {
    expect(new BotStore().has('yok')).toBe(false);
  });

  it('delete çalışır', () => {
    const store = new BotStore<boolean>();
    store.set('k', true);
    expect(store.delete('k')).toBe(true);
    expect(store.has('k')).toBe(false);
  });

  it('delete olmayan key false döner', () => {
    expect(new BotStore().delete('yok')).toBe(false);
  });

  it('clear tüm öğeleri temizler', () => {
    const store = new BotStore<number>();
    store.set('a', 1).set('b', 2).set('c', 3);
    store.clear();
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(false);
  });

  it('get olmayan key undefined döner', () => {
    expect(new BotStore().get('yok')).toBeUndefined();
  });

  it('generic tip korunur (TypeScript derleme testi)', () => {
    const store = new BotStore<{ name: string }>();
    store.set('obj', { name: 'Bridge' });
    expect(store.get('obj')?.name).toBe('Bridge');
  });

  it('set chaining çalışır', () => {
    const store = new BotStore<number>();
    store.set('a', 1).set('b', 2);
    expect(store.get('a')).toBe(1);
    expect(store.get('b')).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// PaginationHelper
// ─────────────────────────────────────────────────────────────

describe('PaginationHelper', () => {
  const items = Array.from({ length: 25 }, (_, i) => `öğe-${i + 1}`);

  it('toplam sayfa sayısı doğru hesaplanır', () => {
    const pager = new PaginationHelper(items, { pageSize: 10 });
    expect(pager.total).toBe(3); // 25 öğe / 10 = 3 sayfa (10+10+5)
  });

  it('ilk sayfa doğru öğeleri içerir', () => {
    const pager  = new PaginationHelper(items, { pageSize: 10 });
    const page   = pager.getPage(0);
    expect(page.content).toContain('öğe-1');
    expect(page.content).toContain('öğe-10');
    expect(page.content).not.toContain('öğe-11');
  });

  it('son sayfa kalan öğeleri içerir', () => {
    const pager = new PaginationHelper(items, { pageSize: 10 });
    const page  = pager.getPage(2);
    expect(page.content).toContain('öğe-21');
    expect(page.content).toContain('öğe-25');
  });

  it('hasNext ve hasPrev doğru çalışır', () => {
    const pager = new PaginationHelper(items, { pageSize: 10 });
    expect(pager.getPage(0).hasPrev).toBe(false);
    expect(pager.getPage(0).hasNext).toBe(true);
    expect(pager.getPage(1).hasPrev).toBe(true);
    expect(pager.getPage(1).hasNext).toBe(true);
    expect(pager.getPage(2).hasNext).toBe(false);
    expect(pager.getPage(2).hasPrev).toBe(true);
  });

  it('current 0-indexed doğru döner', () => {
    const pager = new PaginationHelper(items, { pageSize: 10 });
    expect(pager.getPage(1).current).toBe(1);
  });

  it('başlık içeriğe eklenir', () => {
    const pager = new PaginationHelper(items, { pageSize: 10, title: '📋 Liste' });
    expect(pager.getPage(0).content).toContain('📋 Liste');
  });

  it('özel formatter kullanılır', () => {
    const pager = new PaginationHelper(['a', 'b'], {
      formatter: (item, i) => `${i + 1}: ${item.toUpperCase()}`,
    });
    expect(pager.getPage(0).content).toContain('1: A');
    expect(pager.getPage(0).content).toContain('2: B');
  });

  it('boş liste ile total=1 döner', () => {
    const pager = new PaginationHelper([], { pageSize: 10 });
    expect(pager.total).toBe(1);
    expect(pager.getPage(0).hasNext).toBe(false);
    expect(pager.getPage(0).hasPrev).toBe(false);
  });

  it('sayfa sınırı dışı index düzeltilir (overflow)', () => {
    const pager = new PaginationHelper(items, { pageSize: 10 });
    const page  = pager.getPage(999);
    expect(page.current).toBe(pager.total - 1);
  });

  it('negatif index düzeltilir (underflow)', () => {
    const pager = new PaginationHelper(items, { pageSize: 10 });
    const page  = pager.getPage(-5);
    expect(page.current).toBe(0);
  });

  it('dizi olmayan items fırlatır', () => {
    expect(() => new PaginationHelper('string' as never)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// SDK_VERSION
// ─────────────────────────────────────────────────────────────

describe('SDK_VERSION', () => {
  it('semver formatında string döner', () => {
    expect(typeof SDK_VERSION).toBe('string');
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ─────────────────────────────────────────────────────────────
// BridgeBot — bağlantı ve komut mekanizması
// ─────────────────────────────────────────────────────────────

describe('BridgeBot', () => {
  let bot: BridgeBot;

  const okResponse = (body: unknown = {}) => ({
    headers: { get: () => null },
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSocket.connected = true;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/bots/me')) return okResponse({ _id: 'bot-id', username: 'TestBot' });
      return okResponse({ commands: [] });
    });
    bot = new BridgeBot({ token: 'brg_bot_test_token', serverUrl: 'http://localhost:3001' });
  });

  afterEach(() => bot.disconnect());

  it('token zorunlu', () => {
    expect(() => new BridgeBot({ token: '' })).toThrow();
  });

  it('command() kayıt/chaining yapar ve duplicate adı reddeder', () => {
    expect(bot.command('ping', { description: 'Ping', handler: async () => {} })).toBe(bot);
    expect(() => bot.command('ping', { handler: async () => {} })).toThrow(/zaten/i);
  });

  it('connect gerçek bot identity endpointini doğrular, slash metadata kaydeder ve bot token ile socket açar', async () => {
    bot.command('ping', { description: 'Pong', usage: '/ping', handler: async () => {} });
    await bot.connect();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/bots/me',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bot brg_bot_test_token' }) }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/bots/me/slash-commands',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ commands: [{ name: 'ping', description: 'Pong', usage: '/ping' }] }),
      }),
    );
    const { io } = require('socket.io-client');
    expect(io).toHaveBeenCalledWith('http://localhost:3001', expect.objectContaining({ auth: { token: 'brg_bot_test_token', isBot: true } }));
    expect(bot.info).toMatchObject({ _id: 'bot-id', username: 'TestBot' });
    expect(bot.isConnected).toBe(true);
  });

  it('invalid/revoked bot identity connect sırasında görünür hata olur; sahte Bot identity üretilmez', async () => {
    mockFetch.mockResolvedValueOnce({
      headers: { get: () => null }, ok: false, status: 401, statusText: 'Unauthorized',
      json: async () => ({ error: 'Invalid or inactive bot token' }),
    });
    await expect(bot.connect()).rejects.toThrow(/401/);
    expect(bot.info).toBeNull();
    const { io } = require('socket.io-client');
    expect(io).not.toHaveBeenCalled();
  });

  it('registerContextCommands canonical metadata endpointine yazar', async () => {
    bot.contextCommand('User info', 'USER_COMMAND', async () => {});
    await bot.registerContextCommands();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/bots/me/context-commands',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.commands).toEqual([{ name: 'User info', type: 'USER_COMMAND', description: '' }]);
  });

  it('server canonical message:new olayı kayıtlı slash handlerını tetikler', async () => {
    // Typed parameter: `jest.fn(async () => {})` records calls as `[]`, so reading the
    // context below did not compile and this suite ran 0 tests (found in Final21 Phase 14).
    const handler = jest.fn(async (_ctx: CommandContext) => {});
    bot.command('ping', { handler });
    await bot.connect();
    const call = mockSocketOn.mock.calls.find(([event]) => event === 'message:new');
    expect(call).toBeTruthy();
    await call![1]({ _id: 'm1', content: '/ping a b', channelId: 'c1', serverId: 's1', userId: 'u1', createdAt: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].args).toEqual(['a', 'b']);
  });

  // Final21 Phase 14: before the reply authority existed ctx.reply called sendMessage,
  // which always throws — every documented command handler failed on its first reply.
  it('ctx.reply bir slash komutunu çağıran mesaja kanonik yanıt ucuyla cevap verir', async () => {
    let replied: unknown;
    bot.command('ping', { handler: async (ctx) => { replied = await ctx.reply('pong'); } });
    await bot.connect();
    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce(okResponse({ ok: true, message: { _id: 'r1', content: 'pong', botId: 'bot-id' } }));
    const call = mockSocketOn.mock.calls.find(([event]) => event === 'message:new');
    await call![1]({ _id: 'inv/1', content: '/ping', channelId: 'c1', serverId: 's1', userId: 'u1', createdAt: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/bots/interactions/inv%2F1/reply',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'pong' }),
        headers: expect.objectContaining({ Authorization: 'Bot brg_bot_test_token' }),
      }),
    );
    expect(replied).toEqual({ _id: 'r1', content: 'pong', botId: 'bot-id' });
  });

  it('reddedilen yanıt durum ve sunucu kodunu taşıyan BridgeApiError olur', async () => {
    mockFetch.mockResolvedValueOnce({
      headers: { get: () => null }, ok: false, status: 403, statusText: 'Forbidden',
      json: async () => ({ error: 'scope_required' }),
    });
    const refusal = bot.replyToInteraction('inv-1', 'pong');
    await expect(refusal).rejects.toBeInstanceOf(BridgeApiError);
    await expect(refusal).rejects.toMatchObject({ status: 403, code: 'scope_required', message: 'API hatası 403: scope_required' });

    mockFetch.mockResolvedValueOnce({
      headers: { get: () => null }, ok: false, status: 502, statusText: 'Bad Gateway',
      json: async () => { throw new SyntaxError('html'); },
    });
    await expect(bot.replyToInteraction('inv-1', 'pong')).rejects.toMatchObject({ status: 502, code: 'Bad Gateway' });
  });

  it('metin olmayan yanıt ağ çağrısı yapmadan açıkça desteklenmez', async () => {
    await expect(bot.replyToInteraction('inv-1', { title: 'embed' } as unknown as string)).rejects.toBeInstanceOf(BridgeUnsupportedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('disconnect gerçek socket.disconnect() çağırır', async () => {
    await bot.connect();
    bot.disconnect();
    expect(mockSocketDisconnect).toHaveBeenCalled();
    expect(bot.isConnected).toBe(false);
  });

  it('429 Retry-After command registration için sınırlı retry yapar', async () => {
    bot.command('ping', { handler: async () => {} });
    mockFetch
      .mockResolvedValueOnce({ headers: { get: () => null }, ok: false, status: 429, statusText: 'Too Many', json: async () => ({}) })
      .mockResolvedValueOnce(okResponse({ commands: [] }));
    await bot.registerSlashCommands();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('deprecation header warning/event üretir', async () => {
    const seen: unknown[] = [];
    bot.on('deprecationWarning', d => seen.push(d));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce({
      ...okResponse({ commands: [] }),
      headers: { get: (name: string) => name === 'Deprecation' ? 'true' : name === 'Link' ? '/api/v2' : null },
    });
    await bot.registerSlashCommands();
    expect(seen).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('shipping bot-principal authority olmayan public yüzeylerin tamamı açık unsupported hatası verir ve phantom HTTP çağrısı yapmaz', async () => {
    const asyncCalls: Array<Promise<unknown>> = [
      bot.sendMessage('c', 'x'),
      bot.editMessage('c', 'm', 'x'),
      bot.deleteMessage('c', 'm'),
      bot.addReaction('c', 'm', '👍'),
      bot.getMessages('c'),
      bot.sendInteractiveMessage('c', 'x', []),
      bot.getMembers('s'),
      bot.addRole('s', 'u', 'r'),
      bot.removeRole('s', 'u', 'r'),
      bot.kick('s', 'u'),
      bot.ban('s', 'u'),
      bot.timeout('s', 'u'),
    ];
    for (const promise of asyncCalls) await expect(promise).rejects.toBeInstanceOf(BridgeUnsupportedError);
    expect(() => bot.showModal('u', { customId: 'x', title: 'X', fields: [] })).toThrow(BridgeUnsupportedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
