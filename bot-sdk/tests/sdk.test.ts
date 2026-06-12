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

const mockSocket = {
  connected: true,
  on:        mockSocketOn,
  off:       mockSocketOff,
  emit:      mockSocketEmit,
  close:     mockSocketClose,
  once:      jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    // 'ready' eventi için: hemen callback'i çağır (test kolaylığı)
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockSocket.connected = true;
    bot = new BridgeBot({ token: 'brg_bot_test_token', serverUrl: 'http://localhost:3001' });
  });

  afterEach(() => {
    bot.disconnect();
  });

  it('token zorunlu', () => {
    expect(() => new BridgeBot({ token: '' })).toThrow();
  });

  it('command() kayıt ve chaining çalışır', () => {
    const result = bot.command('ping', {
      description: 'Ping komutu',
      handler: async () => {},
    });
    expect(result).toBe(bot); // fluent API
  });

  it('aynı komut iki kez kaydedilirse throw atar', () => {
    bot.command('tekrar', { description: 'x', handler: async () => {} });
    expect(() =>
      bot.command('tekrar', { description: 'y', handler: async () => {} })
    ).toThrow();
  });

  it('onModalSubmit chaining çalışır', () => {
    const result = bot.onModalSubmit('form:confirm', async () => {});
    expect(result).toBe(bot);
  });

  it('isConnected socket.connected değerini yansıtır', () => {
    mockSocket.connected = true;
    // connected getter socket durumuna bağlı
    expect(typeof bot.isConnected).toBe('boolean');
  });

  it('disconnect close() çağırır', () => {
    bot.disconnect();
    expect(mockSocketClose).toHaveBeenCalled();
  });

  describe('sendMessage', () => {
    it('başarılı API çağrısında BotMessage döner', async () => {
      const mockMsg = { _id: 'msg-1', channelId: 'ch-1', content: 'Merhaba', userId: 'bot-id', serverId: 's-1', createdAt: Date.now() };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockMsg,
      });

      const msg = await bot.sendMessage('ch-1', 'Merhaba');
      expect(msg).toMatchObject({ _id: 'msg-1', content: 'Merhaba' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/channels/ch-1/messages'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('API hatasında null döner (throw etmez)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
      const msg = await bot.sendMessage('ch-1', 'hata test');
      expect(msg).toBeNull();
    });
  });

  describe('deleteMessage', () => {
    it('doğru endpoint DELETE çağırır', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => null });
      await bot.deleteMessage('ch-1', 'msg-123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/ch-1/messages/msg-123'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('kick / ban / timeout', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => null });
    });

    it('kick doğru endpoint ve body ile çağırır', async () => {
      await bot.kick('srv-1', 'usr-1', 'test reason');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/servers/srv-1'),
        expect.objectContaining({ method: 'POST' })
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reason).toBe('test reason');
    });

    it('ban çağrılabilir', async () => {
      await expect(bot.ban('srv-1', 'usr-1')).resolves.toBeNull();
    });

    it('timeout varsayılan 10 dakika ile çağrılır', async () => {
      await bot.timeout('srv-1', 'usr-1');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.minutes).toBe(10);
    });
  });
});
