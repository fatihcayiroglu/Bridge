// client/tests/group-dm-reachability.test.ts
// FAZ C4.7 — GROUP DM GERÇEKTEN ULAŞILABİLİR Mİ?
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU PAKET VAR
// ════════════════════════════════════════════════════════════════════════════
// Group DM istemcisi Faz 11'de KASITLI olarak uykuya alınmıştı: panel hiç
// mount edilmiyordu, `#gdm-root` yoktu ve onu açan hiçbir çağrı bulunmuyordu.
// Ayrıca socket'i `window.socket` legacy global'inden okuyarak İKİNCİ bir
// socket sahibi yaratıyordu.
//
// Bu paket ulaşılabilirliği DAVRANIŞLA kanıtlar. Paket adı/CSS sınıfının
// bundle'da görünmesi kanıt DEĞİLDİR (bu tam olarak eski yanlış teşhisti):
// burada gerçek mount köprüsü çalıştırılır, gerçek açıcı çağrılır ve gerçek
// socket olayları işlenir.
//
// POZİTİF KONTROL KURALI: her negatif güvenlik iddiasının yanında, davranışa
// gerçekten ULAŞILDIĞINI gösteren bir pozitif kontrol bulunur. Hiçbir şey
// olmadığı için geçen bir test kanıt sayılmaz.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
// Mount köprüsü STATİK import edilir.
//
// DİKKAT: `vi.resetModules()` + dinamik import kullanılırsa köprü modülü
// KENDİ `svelte` kopyasını çözer; testteki `flushSync` o zamanlayıcıyı
// akıtmaz ve `onMount` etkileri hiç çalışmamış gibi görünür (kayıtlar
// oluşmaz). Tek svelte örneği korunur; modül durumu `unmountGroupDmPanel`
// ile sıfırlanır.
import { mountGroupDmPanel, unmountGroupDmPanel } from '../js/core/group-dm-svelte.ts';

const XSS_IMG = '<img src=x onerror="window.__pwned=1">';

/** Kaydedilen dinleyicileri gözlemlenebilir kılan sahte socket. */
function makeSocket(tag: string) {
  const listeners: Record<string, Array<(d: unknown) => void>> = {};
  return {
    _tag: tag,
    emit: vi.fn(),
    on: (e: string, fn: (d: unknown) => void) => { (listeners[e] ??= []).push(fn); },
    off: (e: string, fn: (d: unknown) => void) => {
      listeners[e] = (listeners[e] ?? []).filter(f => f !== fn);
    },
    _fire: (e: string, d: unknown) => { for (const fn of [...(listeners[e] ?? [])]) fn(d); },
    _count: (e: string) => (listeners[e] ?? []).length,
  };
}

type Sock = ReturnType<typeof makeSocket>;

const GROUPS = [
  { _id: 'gdm-A', name: 'Grup A', ownerId: 'u1', icon: '👥', memberCount: 2 },
  { _id: 'gdm-B', name: 'Grup B', ownerId: 'u1', icon: '🎮', memberCount: 2 },
];

function gmsg(content: string, groupId = 'gdm-A', over: Record<string, unknown> = {}) {
  return {
    _id: `m-${Math.random()}`, groupId, userId: 'u2',
    displayName: 'Diger', avatarColor: '#333',
    content, createdAt: Date.now(), ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let sock: Sock;

const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as unknown as Response);

/** Varsayılan: liste + boş geçmiş. Geçmiş elde tutulabilir. */
function makeFetch(history: Record<string, unknown[]> = {}) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    const m = u.match(/\/api\/gdm\/([^/?]+)\/messages/);
    if (m) return ok(history[m[1]!] ?? []);
    if (u.endsWith('/api/gdm')) return ok(GROUPS);
    const g = u.match(/\/api\/gdm\/([^/?]+)$/);
    if (g) return ok(GROUPS.find(x => x._id === g[1]) ?? GROUPS[0]);
    return ok([]);
  });
}

const panel    = () => document.querySelector('#gdm-panel');
const gdmRoot  = () => document.querySelector('#gdm-root');
const items    = () => [...document.querySelectorAll<HTMLElement>('.gdm-item')];
const msgTexts = () => [...document.querySelectorAll('.dm-msg-text')];
const pwned    = () => (window as unknown as Record<string, unknown>).__pwned;

/**
 * ÜRETİM YOLU: kabukta `#gdm-root` bulunur ve mount köprüsü çağrılır.
 * `index.html` bu düğümü içerir; jsdom'da eşdeğeri kurulur.
 */
function bootShell(): void {
  const root = document.createElement('div');
  root.id = 'gdm-root';
  document.body.appendChild(root);
  mountGroupDmPanel();
  flushSync();
}

/** Gerçek ürün açıcısı (FriendsPanel bu kaydı çağırır). */
function openViaProductPath(): void {
  const open = BridgeRegistry.get('showGroupDmPanel') as (() => void) | undefined;
  if (!open) throw new Error('showGroupDmPanel KAYITLI DEĞİL — ürün açıcısı kopmuş');
  open();
  flushSync();
}

/**
 * Grubu açar ve GEÇMİŞ YÜKLEMESİ OTURANA kadar bekler.
 *
 * Bekleme şart: geçmiş yanıtı `messages`i topluca ATAR. Yükleme sürerken
 * gelen canlı bir mesaj, yanıt indiğinde üzerine yazılır. Gerçek kullanımda
 * canlı mesaj konuşma AÇIK ve YÜKLENMİŞken gelir; testler bu ön koşulu
 * modeller. (Yükleme sırasında gelen mesajın kaybı ayrı bir UX yarışıdır ve
 * C4 güvenlik kapsamının dışındadır.)
 */
async function openGroup(id: string): Promise<void> {
  await vi.waitFor(() => { flushSync(); expect(items().length).toBe(GROUPS.length); });
  const el = items()[GROUPS.findIndex(g => g._id === id)]!;
  const before = fetchMock.mock.calls.filter(c => /\/messages/.test(String(c[0]))).length;
  el.click();
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    const after = fetchMock.mock.calls.filter(c => /\/messages/.test(String(c[0]))).length;
    expect(after).toBeGreaterThan(before);
  });
  // Yanıtın uygulanması için bir tur bekle.
  await new Promise(r => setTimeout(r, 0));
  flushSync();
}

beforeEach(() => {
  
  (window as unknown as Record<string, unknown>).API = 'http://test';
  fetchMock = makeFetch();
  sock = makeSocket('A');
  BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
  BridgeRegistry.register('getMe', () => ({ id: 'u1', displayName: 'Ben' }));
  BridgeRegistry.register('socket', sock);
});

afterEach(() => {
  unmountGroupDmPanel();
  for (const k of ['apiFetch', 'getMe', 'socket', 'showGroupDmPanel', 'openGroupDmPanel', 'closeGroupDmPanel']) {
    BridgeRegistry.unregister(k);
  }
  delete (window as unknown as Record<string, unknown>).__pwned;
  delete (window as unknown as Record<string, unknown>).API;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// 1) MOUNT / AÇ
// ════════════════════════════════════════════════════════════════════════════
describe('C4.7 — gerçek mount ve ürün açıcısı', () => {
  it('mount köprüsü paneli `#gdm-root` içine kurar', async () => {
    bootShell();

    expect(gdmRoot()).not.toBeNull();
    expect(BridgeRegistry.get('showGroupDmPanel')).toBeTypeOf('function');
  });

  it('GİZLİ mount edilir — kendiliğinden açılmaz', async () => {
    bootShell();

    expect(panel()).toBeNull();
  });

  it('POZİTİF: ürün açıcısı paneli GERÇEKTEN açar', async () => {
    bootShell();

    openViaProductPath();

    expect(panel()).not.toBeNull();
  });

  it('panel İKİ KEZ mount edilmez (tek kanonik sahip)', async () => {
    bootShell();

    mountGroupDmPanel();
    mountGroupDmPanel();
    flushSync();
    openViaProductPath();

    expect(document.querySelectorAll('#gdm-panel')).toHaveLength(1);
    expect(document.querySelectorAll('#gdm-root')).toHaveLength(1);
  });

  it('kapatma açıcısı paneli kapatır ve seçimi temizler', async () => {
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');

    (BridgeRegistry.get('closeGroupDmPanel') as () => void)();
    flushSync();

    expect(panel()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2) SOCKET BAĞLAMA — KİMLİK FARKINDALIĞI
// ════════════════════════════════════════════════════════════════════════════
describe('C4.7 — socket bağlama nesne kimliğine duyarlıdır', () => {
  it('POZİTİF: kanonik socket’e TAM OLARAK BİR dinleyici bağlanır', async () => {
    bootShell();

    expect(sock._count('gdm:message')).toBe(1);
    expect(sock._count('gdm:deleted')).toBe(1);
  });

  it('POZİTİF: bağlı socket’ten gelen mesaj AÇIK gruba eklenir', async () => {
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');

    sock._fire('gdm:message', gmsg('canli mesaj', 'gdm-A'));
    flushSync();

    expect(msgTexts().map(e => e.textContent).join(' ')).toContain('canli mesaj');
  });

  it('GÜVENLİK: BAŞKA grubun mesajı açık konuşmaya EKLENMEZ', async () => {
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');
    const before = msgTexts().length;

    sock._fire('gdm:message', gmsg('B SIZINTISI', 'gdm-B'));
    flushSync();

    expect(msgTexts()).toHaveLength(before);
    expect(document.body.textContent).not.toContain('B SIZINTISI');
  });

  it('socket DEĞİŞİNCE eski nesne çözülür, yenisine bağlanılır', async () => {
    bootShell();
    const eski = sock;
    expect(eski._count('gdm:message')).toBe(1);

    const yeni = makeSocket('B');
    BridgeRegistry.register('socket', yeni);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    flushSync();

    expect(eski._count('gdm:message')).toBe(0);   // eski çözüldü
    expect(yeni._count('gdm:message')).toBe(1);   // yeni bağlandı
  });

  it('POZİTİF: değişimden sonra YENİ socket’in olayı işlenir', async () => {
    bootShell();
    const yeni = makeSocket('B');
    BridgeRegistry.register('socket', yeni);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    flushSync();

    openViaProductPath();
    await openGroup('gdm-A');
    yeni._fire('gdm:message', gmsg('yeni socket mesaji', 'gdm-A'));
    flushSync();

    expect(msgTexts().map(e => e.textContent).join(' ')).toContain('yeni socket mesaji');
  });

  it('GÜVENLİK: tekrarlanan senkronizasyon dinleyiciyi ÇOĞALTMAZ', async () => {
    bootShell();

    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
      flushSync();
    }

    expect(sock._count('gdm:message')).toBe(1);
  });

  it('GÜVENLİK: aynı mesaj TEK KEZ eklenir (çift teslim yok)', async () => {
    bootShell();
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    flushSync();
    openViaProductPath();
    await openGroup('gdm-A');

    sock._fire('gdm:message', gmsg('tek kez', 'gdm-A'));
    flushSync();

    const kez = msgTexts().filter(e => (e.textContent ?? '').includes('tek kez'));
    expect(kez).toHaveLength(1);
  });

  it('unmount dinleyicileri REFERANSLA çözer (removeAllListeners yok)', async () => {
    bootShell();
    expect(sock._count('gdm:message')).toBe(1);

    unmountGroupDmPanel();
    flushSync();

    expect(sock._count('gdm:message')).toBe(0);
    expect(sock._count('gdm:deleted')).toBe(0);
    expect((sock as unknown as Record<string, unknown>).removeAllListeners).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3) ERİŞİM KALDIRMA
// ════════════════════════════════════════════════════════════════════════════
describe('C4.7 — erişim kaldırma gerçek yolda çalışır', () => {
  it('GÜVENLİK: `gdm:deleted` açık grubu kapatır ve mesajları siler', async () => {
    fetchMock = makeFetch({ 'gdm-A': [gmsg('gizli', 'gdm-A')] });
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(1); });

    sock._fire('gdm:deleted', { groupId: 'gdm-A' });
    flushSync();

    expect(msgTexts()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('gizli');
  });

  it('GÜVENLİK: kaldırılan grup listeden de çıkar', async () => {
    bootShell();
    openViaProductPath();
    await vi.waitFor(() => { flushSync(); expect(items().length).toBe(2); });

    sock._fire('gdm:deleted', { groupId: 'gdm-A' });
    flushSync();

    expect(items()).toHaveLength(1);
  });

  it('YABANCI grup için `gdm:deleted` açık grubu KAPATMAZ', async () => {
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');

    sock._fire('gdm:deleted', { groupId: 'baska-grup' });
    flushSync();

    expect(panel()).not.toBeNull();
    expect(document.querySelector('#dm-chat-header')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4) YARIŞ — BAYAT GEÇMİŞ
// ════════════════════════════════════════════════════════════════════════════
describe('C4.7 — bayat geçmiş yanıtı yanlış grubu doldurmaz', () => {
  it('GÜVENLİK: A’nın GEÇ yanıtı B açıkken uygulanmaz', async () => {
    const pending: Array<{ id: string; resolve: (r: Response) => void }> = [];
    fetchMock = vi.fn((url: unknown) => {
      const u = String(url);
      const m = u.match(/\/api\/gdm\/([^/?]+)\/messages/);
      if (m) return new Promise<Response>(resolve => { pending.push({ id: m[1]!, resolve }); });
      if (u.endsWith('/api/gdm')) return Promise.resolve(ok(GROUPS));
      return Promise.resolve(ok([]));
    });

    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');
    await vi.waitFor(() => expect(pending.length).toBe(1));
    await openGroup('gdm-B');
    await vi.waitFor(() => expect(pending.length).toBe(2));

    pending.find(p => p.id === 'gdm-B')!.resolve(ok([gmsg('B MESAJI', 'gdm-B')]));
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(1); });

    pending.find(p => p.id === 'gdm-A')!.resolve(ok([gmsg('A MESAJI', 'gdm-A')]));
    await new Promise(r => setTimeout(r, 30));
    flushSync();

    const shown = msgTexts().map(e => e.textContent).join(' ');
    expect(shown).toContain('B MESAJI');
    expect(shown).not.toContain('A MESAJI');
  });

  it('GÜVENLİK: erişim kaldırıldıktan sonra gelen geçmiş grubu DİRİLTMEZ', async () => {
    const pending: Array<(r: Response) => void> = [];
    fetchMock = vi.fn((url: unknown) => {
      const u = String(url);
      if (/\/messages/.test(u)) return new Promise<Response>(res => { pending.push(res); });
      if (u.endsWith('/api/gdm')) return Promise.resolve(ok(GROUPS));
      return Promise.resolve(ok([]));
    });

    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');
    await vi.waitFor(() => expect(pending.length).toBe(1));

    sock._fire('gdm:deleted', { groupId: 'gdm-A' });
    flushSync();

    pending[0]!(ok([gmsg('DIRILEN', 'gdm-A')]));
    await new Promise(r => setTimeout(r, 30));
    flushSync();

    expect(document.body.textContent).not.toContain('DIRILEN');
    expect(msgTexts()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5) XSS — ARTIK GERÇEKTEN ULAŞILABİLİR YÜZEYDE
// ════════════════════════════════════════════════════════════════════════════
describe('C4.7 — ULAŞILABİLİR yolda mesaj içeriği METİN olarak basılır', () => {
  it('geçmişten gelen img/onerror yükü ÇALIŞMAZ', async () => {
    fetchMock = makeFetch({ 'gdm-A': [gmsg(XSS_IMG, 'gdm-A')] });
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(1); });

    expect(pwned()).toBeUndefined();
    expect(document.querySelector('.dm-msg-text img')).toBeNull();
    expect(msgTexts()[0]!.textContent).toContain('onerror');
  });

  it('CANLI socket mesajındaki yük de ÇALIŞMAZ', async () => {
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');

    sock._fire('gdm:message', gmsg(XSS_IMG, 'gdm-A'));
    flushSync();

    expect(pwned()).toBeUndefined();
    expect(document.querySelector('.dm-msg-text img')).toBeNull();
  });

  it('svg/onload ve script yükleri ÇALIŞMAZ', async () => {
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');

    sock._fire('gdm:message', gmsg('<svg onload="window.__pwned=1"></svg>', 'gdm-A'));
    sock._fire('gdm:message', gmsg('<script>window.__pwned=1<\/script>', 'gdm-A'));
    flushSync();

    expect(pwned()).toBeUndefined();
    expect(document.querySelector('.dm-msg-text svg, .dm-msg-text script')).toBeNull();
  });

  it('zararlı GÖRÜNEN AD metin olarak basılır', async () => {
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');

    sock._fire('gdm:message', gmsg('merhaba', 'gdm-A', { displayName: XSS_IMG }));
    flushSync();

    expect(pwned()).toBeUndefined();
    expect(document.querySelector('.dm-msg-name img')).toBeNull();
  });

  it('bozuk/eksik payload çökertmez', async () => {
    bootShell();
    openViaProductPath();
    await openGroup('gdm-A');

    sock._fire('gdm:message', null);
    sock._fire('gdm:message', 'dize');
    sock._fire('gdm:message', {});
    flushSync();

    expect(panel()).not.toBeNull();
  });
});
