// client/tests/group-dm-xss.test.ts
// FAZ C4 — GRUP DM MESAJ RENDER GÜVENLİĞİ.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK
// ════════════════════════════════════════════════════════════════════════════
// `GroupDmPanel.svelte` mesaj gövdesini şöyle basıyordu:
//     {@html formatText(msg.content)}
// `formatText`, BridgeRegistry'den bir biçimlendirici çözmeye çalışıp
// bulamazsa girdiyi AYNEN döndürüyordu (`?? s`). Kayıt sayısı SIFIRDI, yani
// fonksiyon fiilen birimdi ve saldırgan denetimindeki mesaj içeriği doğrudan
// innerHTML'e yazılıyordu.
//
// Bu DORMANT bir dosya DEĞİLDİ: `app.ts` → `group-dm-svelte.ts` →
// `mount(GroupDmPanel)` zinciri canlıdır ve üretim paketinde yer alıyordu.
// Yani herhangi bir grup DM katılımcısı, diğer TÜM katılımcıların
// tarayıcısında betik çalıştırabilirdi (kalıcı/stored XSS).
//
// Bu paket o sınırın geri gelmemesini garanti eder.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount, unmount, flushSync } from 'svelte';
import GroupDmPanel from '../js/core/GroupDmPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const XSS_IMG    = '<img src=x onerror="window.__pwned=1">';
const XSS_SCRIPT = '<script>window.__pwned=1<\/script>';
const XSS_SVG    = '<svg onload="window.__pwned=1"></svg>';

let fetchMock: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

// GroupDmPanel modül import'u DEĞİL, kayıt defterini kullanır:
//   apiFetch → BridgeRegistry.get('apiFetch')   (GroupDmPanel.svelte:84)
//   me()     → BridgeRegistry.get('getMe')      (GroupDmPanel.svelte:93)
//   API()    → window.API                        (GroupDmPanel.svelte:89)
const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as unknown as Response);

const GROUP = {
  _id: 'gdm-1', name: 'Grup', ownerId: 'u1',
  members: ['u1', 'u2'], icon: null,
};

function msg(content: string, over: Record<string, unknown> = {}) {
  return {
    _id: `m-${Math.random()}`, groupId: 'gdm-1', userId: 'u2',
    displayName: 'Saldirgan', avatarColor: '#333',
    content, createdAt: Date.now(), ...over,
  };
}

/** GDM listesi + seçili grubun mesajları. */
function makeFetch(messages: unknown[]) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/messages')) return ok(messages);
    if (u.endsWith('/api/gdm'))  return ok([GROUP]);
    if (u.includes('/api/gdm/')) return ok(GROUP);
    return ok([]);
  });
}

const pwned = () => (window as unknown as Record<string, unknown>).__pwned;
const msgTexts = () => [...host.querySelectorAll('.dm-msg-text')];

/** Kanonik socket'e bağlanan dinleyiciler (tek teslim yolu). */
let gdmListeners: Record<string, Array<(d: unknown) => void>> = {};

/** Gerçek teslim yolundan canlı olay yayınlar. */
function fireGdm(event: string, detail: unknown): void {
  const fns = gdmListeners[event] ?? [];
  if (!fns.length) throw new Error(`${event} dinleyicisi YOK — boru hattı kopmuş`);
  for (const fn of [...fns]) fn(detail);
}

/** Listeden ilk grubu açar (GroupDmPanel.svelte:419 `onclick={openGroupDm}`). */
async function openFirstGroup(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector<HTMLElement>('.gdm-item')).not.toBeNull();
  }, { timeout: 3000 });

  host.querySelector<HTMLElement>('.gdm-item')!.click();
  flushSync();
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).API = 'http://test';
  // FAZ C4.7 — TEK BORU HATTI: canlı olaylar KANONİK socket üzerinden gelir.
  // Tarihsel `bridge:gdm-*` DOM köprüsünün hiçbir yayıncısı yoktu ve
  // kaldırıldı; testler artık gerçek teslim yolunu kullanır. Dinleyiciler
  // yakalanır, böylece "eklenmedi" iddiaları hiç dinleyici olmadığı için
  // değil, GERÇEK guard sayesinde geçer.
  gdmListeners = {};
  BridgeRegistry.register('socket', {
    emit: vi.fn(),
    on: (e: string, fn: (d: unknown) => void) => { (gdmListeners[e] ??= []).push(fn); },
    off: (e: string, fn: (d: unknown) => void) => {
      gdmListeners[e] = (gdmListeners[e] ?? []).filter(f => f !== fn);
    },
  });
  BridgeRegistry.register('getMe', () => ({ id: 'u1', displayName: 'Ben' }));
  fetchMock = makeFetch([]);
  BridgeRegistry.register('apiFetch', (...args: unknown[]) => fetchMock(...args));
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('apiFetch');
  BridgeRegistry.unregister('formatText');
  delete (window as unknown as Record<string, unknown>).__pwned;
  delete (window as unknown as Record<string, unknown>).API;
  BridgeRegistry.unregister('socket');
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/**
 * FAZ C4.7 — panel artık GİZLİ mount edilir; gerçek ürün açıcısıyla açılır.
 * Doğrudan görünürlük bayrağı zorlanmaz: açıcının kayıtlı olduğu da
 * böylece kanıtlanır.
 */
function openViaProductPath(): void {
  const open = BridgeRegistry.get('showGroupDmPanel') as (() => void) | undefined;
  if (!open) throw new Error('showGroupDmPanel kayıtlı değil — açıcı kopmuş');
  open();
  flushSync();
}

/** Paneli mount edip verilen mesajlar render edilene kadar bekler. */
async function renderMessages(contents: string[]): Promise<void> {
  fetchMock = makeFetch(contents.map(c => msg(c)));
  instance = mount(GroupDmPanel, { target: host });
  flushSync();
  openViaProductPath();
  await openFirstGroup();

  await vi.waitFor(() => {
    flushSync();
    expect(msgTexts().length).toBe(contents.length);
  }, { timeout: 3000 });
}

// ════════════════════════════════════════════════════════════════════════════
// Kaynak sınırı — güvensiz sözleşme geri gelemez
// ════════════════════════════════════════════════════════════════════════════
describe('C4 — GroupDmPanel güvensiz HTML sözleşmesi taşımaz', () => {
  const source = () => fs.readFileSync(path.join(CLIENT_ROOT, 'js/core/GroupDmPanel.svelte'), 'utf8');

  /**
   * Yorumlar ARANMAZ: hem HTML (`<!-- -->`) hem de script içindeki `//`
   * yorumları eski güvensiz sözleşmeyi ADIYLA anlatır. Aranan şey KODdur.
   */
  const stripComments = (s: string) =>
    s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');

  it('GÜVENLİK: kodda `{@html}` KULLANILMAZ (yorumlar hariç)', () => {
    // Başlık/açıklama yorumları eski sözleşmeyi ADIYLA anlatır; kod aranır.
    const code = stripComments(source());

    expect(code).not.toMatch(/\{@html/);
  });

  it('GÜVENLİK: `formatText` birim-geri-dönüşlü yardımcısı KALDIRILDI', () => {
    const code = stripComments(source());

    expect(code).not.toMatch(/function formatText/);
  });

  it('svelte/no-at-html-tags susturması artık GEREKMİYOR', () => {
    const code = stripComments(source());

    expect(code).not.toMatch(/eslint-disable.*no-at-html-tags/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Davranış — gerçek DOM üzerinde saldırı yükleri
// ════════════════════════════════════════════════════════════════════════════
describe('C4 — GÜVENLİK: saldırgan denetimindeki mesaj içeriği METİN olarak basılır', () => {
  it('img/onerror yükü ÇALIŞMAZ ve eleman OLUŞMAZ', async () => {
    await renderMessages([XSS_IMG]);

    expect(pwned()).toBeUndefined();
    expect(host.querySelector('.dm-msg-text img')).toBeNull();
    expect(msgTexts()[0]!.textContent).toContain('onerror');
  });

  it('script yükü ÇALIŞMAZ ve eleman OLUŞMAZ', async () => {
    await renderMessages([XSS_SCRIPT]);

    expect(pwned()).toBeUndefined();
    expect(host.querySelector('.dm-msg-text script')).toBeNull();
  });

  it('svg/onload yükü ÇALIŞMAZ', async () => {
    await renderMessages([XSS_SVG]);

    expect(pwned()).toBeUndefined();
    expect(host.querySelector('.dm-msg-text svg')).toBeNull();
  });

  it('mesaj gövdesinde HİÇBİR enjekte eleman oluşmaz', async () => {
    await renderMessages([XSS_IMG, XSS_SCRIPT, XSS_SVG]);

    for (const el of msgTexts()) {
      expect(el.children).toHaveLength(0);      // yalnız metin düğümü
    }
    expect(pwned()).toBeUndefined();
  });

  it('GÜVENLİK: kayıtlı bir formatText bile HTML enjekte EDEMEZ', async () => {
    // Tarihsel açığın kalbi buydu: registry'den gelen dize {@html} ile
    // basılıyordu. Artık kayıt olsa DA render yolu metin enterpolasyonudur.
    BridgeRegistry.register('formatText', () => '<img src=x onerror="window.__pwned=1">');

    await renderMessages(['zararsiz metin']);

    expect(pwned()).toBeUndefined();
    expect(host.querySelector('.dm-msg-text img')).toBeNull();
  });

  it('zararsız içerik AYNEN ve okunur biçimde görünür (işlev kaybı yok)', async () => {
    await renderMessages(['merhaba dünya']);

    expect(msgTexts()[0]!.textContent).toBe('merhaba dünya');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ C4.6 — BAYAT DURUM / KONUŞMA KİMLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN GERÇEK SORUN ─────────────────────────────────────────────────
// `loadGroupDmMessages` yanıtı `messages`e KOŞULSUZ atıyordu. Yavaş bir A
// isteği, kullanıcı B'ye geçtikten SONRA dönerse B'nin başlığı altında A'nın
// mesajları görünüyordu. Aynı yol, kullanıcı A'dan çıkarıldıktan sonra gelen
// yanıtın kapatılmış konuşmayı geri getirmesine de izin veriyordu.
describe('C4.6 — GÜVENLİK: bayat geçmiş yanıtı yanlış konuşmayı doldurmaz', () => {
  /** İki grup ve gruba göre farklı mesajlar döndüren, elde tutulabilir fetch. */
  function makeDeferredFetch() {
    const pending: Array<{ groupId: string; resolve: (r: Response) => void }> = [];
    const groups = [
      { _id: 'gdm-A', name: 'Grup A', ownerId: 'u1', members: ['u1'], icon: null },
      { _id: 'gdm-B', name: 'Grup B', ownerId: 'u1', members: ['u1'], icon: null },
    ];
    const fn = vi.fn((url: unknown) => {
      const u = String(url);
      const m = u.match(/\/api\/gdm\/([^/?]+)\/messages/);
      if (m) {
        return new Promise<Response>(resolve => { pending.push({ groupId: m[1]!, resolve }); });
      }
      if (u.endsWith('/api/gdm')) return Promise.resolve(ok(groups));
      const g = u.match(/\/api\/gdm\/([^/?]+)$/);
      if (g) return Promise.resolve(ok(groups.find(x => x._id === g[1]) ?? groups[0]));
      return Promise.resolve(ok([]));
    });
    return { fn, pending };
  }

  const items = () => [...host.querySelectorAll<HTMLElement>('.gdm-item')];

  async function mountWithGroups(fn: ReturnType<typeof vi.fn>) {
    fetchMock = fn;
    instance = mount(GroupDmPanel, { target: host });
    flushSync();
    openViaProductPath();
    await vi.waitFor(() => { flushSync(); expect(items().length).toBe(2); }, { timeout: 3000 });
  }

  it('GÜVENLİK: A’nın GEÇ gelen yanıtı B açıkken uygulanmaz', async () => {
    const { fn, pending } = makeDeferredFetch();
    await mountWithGroups(fn);

    items()[0]!.click();                       // A açılır (istek beklemede)
    await vi.waitFor(() => expect(pending.length).toBe(1));
    items()[1]!.click();                       // B'ye geçilir
    await vi.waitFor(() => expect(pending.length).toBe(2));

    // Önce B çözülür, SONRA A'nın bayat yanıtı gelir.
    pending.find(p => p.groupId === 'gdm-B')!.resolve(ok([msg('B MESAJI', { _id: 'mb', groupId: 'gdm-B' })]));
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(1); });

    pending.find(p => p.groupId === 'gdm-A')!.resolve(ok([msg('A MESAJI', { _id: 'ma', groupId: 'gdm-A' })]));
    await new Promise(r => setTimeout(r, 30));
    flushSync();

    const shown = msgTexts().map(e => e.textContent).join(' ');
    expect(shown).toContain('B MESAJI');
    expect(shown).not.toContain('A MESAJI');
  });

  it('doğru sırada gelen yanıt normal şekilde uygulanır (pozitif kontrol)', async () => {
    const { fn, pending } = makeDeferredFetch();
    await mountWithGroups(fn);

    items()[0]!.click();
    await vi.waitFor(() => expect(pending.length).toBe(1));
    pending[0]!.resolve(ok([msg('A MESAJI', { _id: 'ma', groupId: 'gdm-A' })]));

    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(1); });
    expect(msgTexts()[0]!.textContent).toContain('A MESAJI');
  });

  it('GÜVENLİK: BAŞKA grubun canlı mesajı açık konuşmaya EKLENMEZ', async () => {
    const { fn, pending } = makeDeferredFetch();
    await mountWithGroups(fn);

    items()[0]!.click();
    await vi.waitFor(() => expect(pending.length).toBe(1));
    pending[0]!.resolve(ok([msg('A MESAJI', { _id: 'ma', groupId: 'gdm-A' })]));
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(1); });

    // B grubuna ait canlı mesaj köprüsü tetiklenir.
    fireGdm('gdm:message', msg('B SIZINTISI', { _id: 'mb', groupId: 'gdm-B' }));
    flushSync();

    const shown = msgTexts().map(e => e.textContent).join(' ');
    expect(shown).not.toContain('B SIZINTISI');
    expect(msgTexts()).toHaveLength(1);
  });

  it('AÇIK grubun canlı mesajı eklenir (pozitif kontrol)', async () => {
    const { fn, pending } = makeDeferredFetch();
    await mountWithGroups(fn);

    items()[0]!.click();
    await vi.waitFor(() => expect(pending.length).toBe(1));
    pending[0]!.resolve(ok([msg('A MESAJI', { _id: 'ma', groupId: 'gdm-A' })]));
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(1); });

    fireGdm('gdm:message', msg('A DEVAMI', { _id: 'ma2', groupId: 'gdm-A' }));
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(2); });

    expect(msgTexts().map(e => e.textContent).join(' ')).toContain('A DEVAMI');
  });

  it('GÜVENLİK: canlı mesaj da METİN olarak basılır (XSS regresyonu)', async () => {
    const { fn, pending } = makeDeferredFetch();
    await mountWithGroups(fn);

    items()[0]!.click();
    await vi.waitFor(() => expect(pending.length).toBe(1));
    pending[0]!.resolve(ok([msg('ilk mesaj', { _id: 'ma', groupId: 'gdm-A' })]));
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(1); });

    // Saldırgan denetimindeki içerik CANLI yoldan gelir.
    fireGdm('gdm:message', msg(XSS_IMG, { _id: 'mx', groupId: 'gdm-A' }));
    await vi.waitFor(() => { flushSync(); expect(msgTexts().length).toBe(2); });

    expect(pwned()).toBeUndefined();
    expect(host.querySelector('.dm-msg-text img')).toBeNull();
    expect(msgTexts()[1]!.textContent).toContain('onerror');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ C4.6 — ERİŞİM KALDIRILDIĞINDA İSTEMCİ TEMİZLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// Sunucu, üye ÇIKARILDIĞINDA veya grup SİLİNDİĞİNDE `gdm:deleted` yayınlar.
// Bu olay istemcide HİÇ dinlenmiyordu: erişimi kalkmış kullanıcının panelinde
// konuşma açık, mesajlar okunur ve besteci gönderiyormuş gibi kalıyordu.
// Güvenlik sınırı arka uçtadır; bu temizlik YANILTICI bayat erişimi kaldırır.
describe('C4.6 — erişim kaldırılınca istemci durumu temizlenir', () => {
  /** Panelin doğrudan sokete bağladığı dinleyicileri yakalayan sahte soket. */
  function socketWithListeners() {
    const listeners: Record<string, Array<(d: unknown) => void>> = {};
    const sock = {
      emit: vi.fn(),
      on: (e: string, fn: (d: unknown) => void) => { (listeners[e] ??= []).push(fn); },
      off: (e: string, fn: (d: unknown) => void) => {
        listeners[e] = (listeners[e] ?? []).filter(f => f !== fn);
      },
    };
    BridgeRegistry.register('socket', sock);
    return {
      fire: (e: string, d: unknown) => { for (const fn of listeners[e] ?? []) fn(d); },
      count: (e: string) => (listeners[e] ?? []).length,
    };
  }

  it('GÜVENLİK: gdm:deleted açık konuşmayı ve mesajları TEMİZLER', async () => {
    const bus = socketWithListeners();
    await renderMessages(['gizli mesaj']);
    expect(msgTexts()).toHaveLength(1);

    bus.fire('gdm:deleted', { groupId: 'gdm-1' });
    flushSync();

    expect(msgTexts()).toHaveLength(0);
    expect(host.textContent).not.toContain('gizli mesaj');
  });

  it('GÜVENLİK: grup listeden de KALDIRILIR (yeniden açılamaz)', async () => {
    const bus = socketWithListeners();
    await renderMessages(['mesaj']);
    expect(host.querySelectorAll('.gdm-item')).toHaveLength(1);

    bus.fire('gdm:deleted', { groupId: 'gdm-1' });
    flushSync();

    expect(host.querySelectorAll('.gdm-item')).toHaveLength(0);
  });

  it('BAŞKA grubun silinmesi AÇIK konuşmayı etkilemez', async () => {
    const bus = socketWithListeners();
    await renderMessages(['mesaj']);

    bus.fire('gdm:deleted', { groupId: 'baska-grup' });
    flushSync();

    expect(msgTexts()).toHaveLength(1);
  });

  it('bozuk/eksik payload güvenle yok sayılır', async () => {
    const bus = socketWithListeners();
    await renderMessages(['mesaj']);

    bus.fire('gdm:deleted', null);
    bus.fire('gdm:deleted', {});
    flushSync();

    expect(msgTexts()).toHaveLength(1);
  });

  it('unmount sonrası dinleyici ÇÖZÜLÜR (referansla, removeAllListeners değil)', async () => {
    const bus = socketWithListeners();
    await renderMessages(['mesaj']);
    expect(bus.count('gdm:deleted')).toBe(1);

    unmount(instance!);
    instance = null;

    expect(bus.count('gdm:deleted')).toBe(0);
  });
});
