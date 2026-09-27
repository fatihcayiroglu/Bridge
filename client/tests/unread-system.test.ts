// client/tests/unread-system.test.ts
//
// FAZ 8/2 — OKUNMAMIŞ SİSTEMİ.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// Sunucu okunmamışları ZATEN sayıyordu ve `GET /api/notification-prefs/unread`
// onları VIEW_CHANNELS ile süzülmüş halde sunuyordu. `UnreadBadge` de gerçek
// bir durum sahibiydi (başlık + favicon). Aradaki tel YOKTU: sözleşmeyi çağıran
// kimse olmadığı için kullanıcı nerede yeni mesaj olduğunu göremiyordu.
//
// ── EN ÖNEMLİ İDDİALAR ────────────────────────────────────────────────────
//   • sayacın KAYNAĞI sunucudur; yeniden bağlanmada sunucu anlık görüntüsü
//     yerel durumu EZER (çevrimdışıyken kaçırılanlar yerelde yoktur)
//   • AÇIK kanal ve KENDİ mesajımız okunmamış ÜRETMEZ
//   • bahsetme bayrağı YAPIŞKANDIR — sonraki sıradan mesaj önceliği düşürmez

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Kayit defteri iki farkli belirtecle import edilir: modullerimiz `.ts`,
// Svelte bilesenleri `.js` uzantisini kullanir. IKISI de taklit edilmeli,
// yoksa bilesen GERCEK defteri gorur ve mock'la ayrisir.
const registryMap: Record<string, unknown> = {};
const registryMock = {
  BridgeRegistry: {
    has:  (k: string) => k in registryMap,
    get:  (k: string) => registryMap[k],
    call: (k: string, ...a: unknown[]) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...a) : v;
    },
    register:   (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
  },
};
vi.mock('../js/core/bridge-registry.ts', () => registryMock);
vi.mock('../js/core/bridge-registry.js', () => registryMock);

const loggerMock = { createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
vi.mock('../js/core/logger.ts', () => loggerMock);
vi.mock('../js/core/logger.js', () => loggerMock);
import { UnreadStore, badgeLabel } from '../js/core/unread/unread-store.ts';

// ════════════════════════════════════════════════════════════════════════════
describe('UnreadStore — sayım kuralları', () => {
  let store: UnreadStore;
  beforeEach(() => { store = new UnreadStore(); });

  it('yeni mesaj sayacı artırır', () => {
    store.increment('c1', 's1');
    store.increment('c1', 's1');
    expect(store.countFor('c1')).toBe(2);
  });

  it('kanal açılınca sıfırlanır', () => {
    store.increment('c1', 's1');
    store.clear('c1');
    expect(store.countFor('c1')).toBe(0);
  });

  it('bahsetme bayrağı YAPIŞKANDIR', () => {
    // Bir kez bahsedildiyse, sonraki sıradan mesajlar önceliği düşürmemeli.
    store.increment('c1', 's1', { mention: true });
    store.increment('c1', 's1');
    expect(store.hasMention('c1')).toBe(true);
    expect(store.countFor('c1')).toBe(2);
  });

  it('temizlenince bahsetme de düşer', () => {
    store.increment('c1', 's1', { mention: true });
    store.clear('c1');
    expect(store.hasMention('c1')).toBe(false);
  });

  it('sunucu toplamı kanallarının toplamıdır', () => {
    store.increment('c1', 's1');
    store.increment('c1', 's1');
    store.increment('c2', 's1');
    store.increment('c3', 's2');
    expect(store.serverTotal('s1')).toBe(3);
    expect(store.serverTotal('s2')).toBe(1);
    expect(store.serverTotal('yok')).toBe(0);
  });

  it('sunucu rozeti bahsetmeyi yansıtır', () => {
    store.increment('c1', 's1');
    store.increment('c2', 's1', { mention: true });
    expect(store.serverHasMention('s1')).toBe(true);
    expect(store.serverHasMention('s2')).toBe(false);
  });

  it('toplam ve bahsetme toplamı ayrı hesaplanır', () => {
    store.increment('c1', 's1');
    store.increment('c2', 's1', { mention: true });
    store.increment('c2', 's1');
    expect(store.total()).toBe(3);
    expect(store.mentionTotal()).toBe(2);
  });

  it('kanal kimliği yoksa sayılmaz', () => {
    store.increment('', 's1');
    expect(store.total()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('UnreadStore — sunucu anlık görüntüsü KAZANIR', () => {
  it('replaceAll yerel durumu TAMAMEN değiştirir', () => {
    // Yeniden bağlanmada çevrimdışıyken kaçırılanlar yerelde YOKTUR;
    // yerel sayacı korumak yanlış (düşük) sayı gösterirdi.
    const store = new UnreadStore();
    store.increment('eski', 's1');
    store.replaceAll([{ channelId: 'c1', count: 7 }], () => 's1');

    expect(store.countFor('eski')).toBe(0);
    expect(store.countFor('c1')).toBe(7);
  });

  it('sıfır ve geçersiz sayılar atılır', () => {
    const store = new UnreadStore();
    store.replaceAll([
      { channelId: 'a', count: 0 },
      { channelId: 'b', count: -3 },
      { channelId: 'c', count: Number.NaN },
      { channelId: '', count: 5 },
      { channelId: 'd', count: 2 },
    ]);
    expect(store.channels().map(c => c.channelId)).toEqual(['d']);
  });

  it('sunucu kimliği sonradan doldurulabilir', () => {
    // Kanal listesi geç yüklenirse rozet sunucusuz kalırdı.
    const store = new UnreadStore();
    store.replaceAll([{ channelId: 'c1', count: 3 }]);
    expect(store.serverTotal('s1')).toBe(0);

    store.backfillServerIds((id) => (id === 'c1' ? 's1' : undefined));
    expect(store.serverTotal('s1')).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('badgeLabel', () => {
  it('sıfır rozet üretmez', () => expect(badgeLabel(0)).toBe(''));
  it('normal sayıyı yazar', () => expect(badgeLabel(7)).toBe('7'));
  it('99 üstü kısaltılır — yerleşim bozulmaz', () => {
    expect(badgeLabel(100)).toBe('99+');
    expect(badgeLabel(4231)).toBe('99+');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// ZAMAN AŞIMI ÖLÇÜLDÜ — GİZLENMİŞ REGRESYON DEĞİL
// ════════════════════════════════════════════════════════════════════════════
// Bu blok her testte `vi.resetModules()` + `unread-svelte.ts` modül grafiğini
// YENİDEN import ediyor. Ölçüm: tek testin kendisi ~4.6 sn sürüyor ve
// Vitest'in 5 sn varsayılanının hemen altında kalıyordu. 132 dosyalık tam
// koşunun eşzamanlılığı altında bu eşik AŞILIYOR ve test rastgele düşüyordu
// (izole koşuda geçiyordu — klasik yük kırılganlığı).
//
// Süre, ÖLÇÜLMÜŞ gerçek bir maliyettir (modül grafiği yeniden yüklemesi),
// gizlenen bir hata değil. Bu yüzden bütçe gerçeğe göre ayarlanır.
// Ayrıca `boot()` artık sabit uyku yerine BEKLENEN DURUMU bekler.
describe('bağlama — gerçek akış', { timeout: 20_000 }, () => {
  function fakeSocket() {
    const handlers: Record<string, Function[]> = {};
    return {
      on: (e: string, fn: Function) => { (handlers[e] ??= []).push(fn); },
      off: (e: string, fn: Function) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== fn); },
      emit: (e: string, payload: unknown) => { for (const h of handlers[e] ?? []) h(payload); },
      count: (e: string) => (handlers[e] ?? []).length,
    };
  }

  function channelAnchor(id: string) {
    const el = document.createElement('span');
    el.id = `unread-${id}`;
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  async function boot(opts: { unread?: Array<{ channelId: string; count: number }> } = {}) {
    const socket = fakeSocket();
    registryMap.socket = socket;
    registryMap.getMe = () => ({ _id: 'u-me' });
    registryMap.getCurrentChannel = () => ({ _id: 'c-open', serverId: 's1' });
    registryMap.getCurrentServerChannels = () => [
      { _id: 'c-open', serverId: 's1' }, { _id: 'c1', serverId: 's1' }, { _id: 'c2', serverId: 's1' },
    ];
    registryMap.getAvailableServers = () => [{ _id: 's1' }];
    registryMap.apiFetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ channels: opts.unread ?? [] }),
    }) as unknown as Response);

    vi.resetModules();
    const mod = await import('../js/core/unread-svelte.ts');
    mod.mountUnread();

    // ── SABİT BEKLEME YERİNE KOŞUL BEKLEME ────────────────────────────────
    // Önceden burada sabit `setTimeout(30)` vardı. `seed()` zinciri
    // mikro görev → `apiFetch` → `json()` → yeniden boyama adımlarından
    // geçiyor; 132 dosyalık tam koşuda 30 ms BAZEN yetmiyordu ve test
    // rastgele düşüyordu (izole koşuda 3/3 geçiyor).
    //
    // Süre uzatmak kırılganlığı gizlerdi; bunun yerine BEKLENEN DURUM
    // beklenir. Zaman aşımı yalnızca sonsuz beklemeyi önler.
    const expected = opts.unread?.[0];
    if (expected) {
      const deadline = Date.now() + 2_000;
      const anchor = () => document.querySelector<HTMLElement>(
        `#unread-${expected.channelId}`,
      );
      while (Date.now() < deadline) {
        if (anchor()?.textContent === String(expected.count)) break;
        await new Promise(r => setTimeout(r, 10));
      }
    } else {
      await new Promise(r => setTimeout(r, 30));
    }
    return { mod, socket };
  }

  beforeEach(() => {
    for (const k of Object.keys(registryMap)) delete registryMap[k];
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => { document.body.innerHTML = ''; });

  it('TOHUM sunucudan alınır ve kanal rozetine yazılır', async () => {
    const anchor = channelAnchor('c1');
    const { mod } = await boot({ unread: [{ channelId: 'c1', count: 4 }] });
    try {
      expect(anchor.textContent).toBe('4');
      expect(anchor.style.display).not.toBe('none');
      expect(anchor.getAttribute('aria-label')).toContain('4');
    } finally { mod.unmountUnread(); }
  });

  it('yeni mesaj rozeti artırır', async () => {
    const anchor = channelAnchor('c1');
    const { mod, socket } = await boot();
    try {
      socket.emit('message:new', { channelId: 'c1', serverId: 's1', userId: 'u-other' });
      expect(anchor.textContent).toBe('1');
    } finally { mod.unmountUnread(); }
  });

  it('AÇIK kanal okunmamış ÜRETMEZ', async () => {
    const anchor = channelAnchor('c-open');
    const { mod, socket } = await boot();
    try {
      socket.emit('message:new', { channelId: 'c-open', serverId: 's1', userId: 'u-other' });
      expect(anchor.style.display).toBe('none');
    } finally { mod.unmountUnread(); }
  });

  it('KENDİ mesajımız okunmamış ÜRETMEZ', async () => {
    const anchor = channelAnchor('c1');
    const { mod, socket } = await boot();
    try {
      socket.emit('message:new', { channelId: 'c1', serverId: 's1', userId: 'u-me' });
      expect(anchor.style.display).toBe('none');
    } finally { mod.unmountUnread(); }
  });

  it('bahsetme rozeti işaretler', async () => {
    const anchor = channelAnchor('c1');
    const { mod, socket } = await boot();
    try {
      socket.emit('notification:mention', { channelId: 'c1', serverId: 's1' });
      expect(anchor.classList.contains('has-mention')).toBe(true);
      // Renk TEK BAŞINA anlam taşımaz.
      expect(anchor.getAttribute('aria-label')).toContain('bahsedilme');
    } finally { mod.unmountUnread(); }
  });

  it('kanal seçilince rozet temizlenir', async () => {
    const anchor = channelAnchor('c1');
    const { mod, socket } = await boot();
    try {
      socket.emit('message:new', { channelId: 'c1', serverId: 's1', userId: 'u-other' });
      expect(anchor.textContent).toBe('1');

      registryMap.getCurrentChannel = () => ({ _id: 'c1', serverId: 's1' });
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      await new Promise(r => setTimeout(r, 20));
      expect(anchor.style.display).toBe('none');
    } finally { mod.unmountUnread(); }
  });

  it('SUNUCU rozeti kanal toplamını gösterir', async () => {
    const badge = document.createElement('span');
    badge.setAttribute('data-server-unread', 's1');
    badge.style.display = 'none';
    document.body.appendChild(badge);
    channelAnchor('c1'); channelAnchor('c2');

    const { mod, socket } = await boot();
    try {
      socket.emit('message:new', { channelId: 'c1', serverId: 's1', userId: 'u-other' });
      socket.emit('message:new', { channelId: 'c2', serverId: 's1', userId: 'u-other' });
      expect(badge.textContent).toBe('2');
    } finally { mod.unmountUnread(); }
  });

  it('yeniden bağlanmada SUNUCU anlık görüntüsü yerel sayacı EZER', async () => {
    const anchor = channelAnchor('c1');
    const { mod, socket } = await boot({ unread: [{ channelId: 'c1', count: 9 }] });
    try {
      expect(anchor.textContent).toBe('9');
      socket.emit('message:new', { channelId: 'c1', serverId: 's1', userId: 'u-other' });
      expect(anchor.textContent).toBe('10');

      // Sunucu artık 2 diyor (başka cihazda okunmuş olabilir).
      registryMap.apiFetch = vi.fn(async () => ({
        ok: true, status: 200, json: async () => ({ channels: [{ channelId: 'c1', count: 2 }] }),
      }) as unknown as Response);
      document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
      await new Promise(r => setTimeout(r, 30));

      expect(anchor.textContent).toBe('2');
    } finally { mod.unmountUnread(); }
  });

  it('yeniden bağlanmada sıfıra düşen authoritative snapshot aggregate/favicon stateini de temizler', async () => {
    const icon = document.createElement('link');
    icon.rel = 'icon'; icon.href = '/favicon.ico'; document.head.appendChild(icon);
    channelAnchor('c1');
    const { mod } = await boot({ unread: [{ channelId: 'c1', count: 9 }] });
    try {
      await vi.waitFor(() => expect((registryMap.getUnreadCount as (() => number))()).toBe(9));
      expect(document.title).toContain('(9)');

      registryMap.apiFetch = vi.fn(async () => ({
        ok: true, status: 200, json: async () => ({ channels: [] }),
      }) as unknown as Response);
      document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
      await vi.waitFor(() => expect((registryMap.getUnreadCount as (() => number))()).toBe(0));
      expect(document.title).toBe('Bridge');
      expect(icon.href).toContain('/favicon.ico');
    } finally { mod.unmountUnread(); icon.remove(); }
  });

  it('seyrek socket payloadlarını ve eksik/bozuk registry sahiplerini güvenle sınırlar', async () => {
    const anchor = channelAnchor('c-fallback');
    const { mod, socket } = await boot();
    try {
      delete registryMap.getCurrentServerChannels;
      delete registryMap.getAvailableServers;
      delete registryMap.getMe;
      registryMap.getCurrentChannel = () => null;

      socket.emit('message:new', null);
      socket.emit('message:new', {});
      socket.emit('notification:mention', null);
      socket.emit('notification:mention', {});
      expect(anchor.style.display).toBe('none');

      socket.emit('message:new', { channelId: 'c-fallback' });
      expect(anchor.textContent).toBe('1');
      socket.emit('notification:mention', { channelId: 'c-fallback' });
      expect(anchor.textContent).toBe('2');
      expect(anchor.classList.contains('has-mention')).toBe(true);

      registryMap.getCurrentServerChannels = () => ({ invalid: true });
      registryMap.getAvailableServers = () => ({ invalid: true });
      registryMap.getMe = () => ({});
      document.dispatchEvent(new CustomEvent('bridge:channels-updated'));

      registryMap.getCurrentChannel = () => ({ _id: 'c-fallback' });
      socket.emit('notification:mention', { channelId: 'c-fallback' });
      expect(anchor.textContent).toBe('2');

      registryMap.getCurrentChannel = () => null;
      delete registryMap.clearChannelUnread;
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      await Promise.resolve();

      delete registryMap.setChannelUnread;
      document.dispatchEvent(new CustomEvent('bridge:channels-updated'));
      expect(anchor.textContent).toBe('2');
    } finally { mod.unmountUnread(); }
  });

  it('sunucu rozet boyaması boş kimlikleri, eksik çapaları ve sıfır/mention durumlarını işler', async () => {
    const badge = document.createElement('span');
    badge.setAttribute('data-server-unread', 's1');
    badge.setAttribute('aria-label', 'stale');
    document.body.appendChild(badge);
    channelAnchor('c1');
    const { mod, socket } = await boot();
    try {
      registryMap.getAvailableServers = () => [null, {}, { _id: 'missing-anchor' }, { _id: 's1' }];
      document.dispatchEvent(new CustomEvent('bridge:channels-updated'));
      expect(badge.style.display).toBe('none');
      expect(badge.hasAttribute('aria-label')).toBe(false);

      socket.emit('notification:mention', { channelId: 'c1', serverId: 's1' });
      expect(badge.textContent).toBe('1');
      expect(badge.classList.contains('has-mention')).toBe(true);
      expect(badge.getAttribute('aria-label')).toContain('1');
    } finally { mod.unmountUnread(); }
  });

  it('seed eksik taşıyıcıyı, HTTP reddini ve bozuk channels biçimini yok sayar', async () => {
    const anchor = channelAnchor('c1');
    const { mod } = await boot();
    try {
      delete registryMap.apiFetch;
      document.dispatchEvent(new CustomEvent('bridge:auth-success'));
      await Promise.resolve();

      const rejected = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
      registryMap.apiFetch = rejected;
      document.dispatchEvent(new CustomEvent('bridge:auth-success'));
      await vi.waitFor(() => expect(rejected).toHaveBeenCalled());

      const malformed = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ channels: null }) }) as unknown as Response);
      registryMap.apiFetch = malformed;
      document.dispatchEvent(new CustomEvent('bridge:auth-success'));
      await vi.waitFor(() => expect(malformed).toHaveBeenCalled());
      expect(anchor.style.display).toBe('none');
    } finally { mod.unmountUnread(); }
  });

  it('socket-ready eski socketi çözer, yenisini tek kez bağlar ve null socketa geçer', async () => {
    const { mod, socket: first } = await boot();
    try {
      const second = fakeSocket();
      registryMap.socket = second;
      document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
      expect(first.count('message:new')).toBe(0);
      expect(second.count('message:new')).toBe(1);

      document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
      expect(second.count('message:new')).toBe(1);

      delete registryMap.socket;
      document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
      expect(second.count('message:new')).toBe(0);
    } finally { mod.unmountUnread(); }
  });

  it('mount yaşam döngüsü çift çağrıyı, verilen hedefi, mevcut kökü ve çift sökmeyi sınırlar', async () => {
    const { mod } = await boot();
    mod.mountUnread();
    mod.unmountUnread();
    mod.unmountUnread();

    const explicit = document.createElement('div');
    explicit.id = 'explicit-unread-target';
    document.body.appendChild(explicit);
    mod.mountUnread(explicit);
    expect(explicit.childNodes.length).toBeGreaterThan(0);
    mod.unmountUnread();

    document.getElementById('unread-root')?.remove();
    const canonical = document.createElement('div');
    canonical.id = 'unread-root';
    document.body.appendChild(canonical);
    mod.mountUnread();
    expect(canonical.childNodes.length).toBeGreaterThan(0);
    mod.unmountUnread();
  });

  it('loading belge yolunda DOMContentLoaded mountunu bir kez kurar', async () => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'readyState');
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
    try {
      registryMap.socket = fakeSocket();
      registryMap.apiFetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
      vi.resetModules();
      const mod = await import('../js/core/unread-svelte.ts');
      expect(document.getElementById('unread-root')).toBeNull();
      document.dispatchEvent(new Event('DOMContentLoaded'));
      await Promise.resolve();
      expect(document.getElementById('unread-root')).not.toBeNull();
      mod.unmountUnread();
    } finally {
      if (ownDescriptor) Object.defineProperty(document, 'readyState', ownDescriptor);
      else delete (document as unknown as Record<string, unknown>).readyState;
    }
  });

  it('sökme auth-success listenerını ve headless registry sahipliğini temizler', async () => {
    const { mod } = await boot();
    const apiFetch = registryMap.apiFetch as ReturnType<typeof vi.fn>;
    const before = apiFetch.mock.calls.length;
    expect(registryMap.setChannelUnread).toBeTypeOf('function');
    mod.unmountUnread();
    await new Promise(r => setTimeout(r, 0));
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await new Promise(r => setTimeout(r, 0));
    expect(apiFetch.mock.calls.length).toBe(before);
    expect(registryMap.setChannelUnread).toBeUndefined();
    expect(registryMap.clearChannelUnread).toBeUndefined();
    expect(registryMap.getUnreadCount).toBeUndefined();
  });

  it('tohum alınamazsa UYDURMA sayı gösterilmez', async () => {
    const anchor = channelAnchor('c1');
    registryMap.apiFetch = vi.fn(async () => { throw new Error('offline'); });
    const { mod } = await boot();
    try {
      expect(anchor.style.display).toBe('none');
    } finally { mod.unmountUnread(); }
  });

  it('sökme socket dinleyicilerini ÇÖZER', async () => {
    const { mod, socket } = await boot();
    expect(socket.count('message:new')).toBe(1);
    mod.unmountUnread();
    expect(socket.count('message:new')).toBe(0);
  });
});
