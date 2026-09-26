// client/tests/invite-dm-discoverability.test.ts
// UX/P0 — DAVET VE DM KEŞFEDİLEBİLİRLİĞİ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN İKİ ÇEKİRDEK AKIŞ EKSİĞİ
// ════════════════════════════════════════════════════════════════════════════
// 1) DAVET OLUŞTURMA HİÇ YOKTU.
//    Ölçüm: istemcinin tamamında `POST /api/servers/invites` çağrısı SIFIRDI.
//    Yalnızca `/invites/:code/use` (bir kodla KATILMA) vardı. Yani bir sunucu
//    sahibi kimseyi davet edemiyordu — sunucu paylaşılamazdı.
//    Ayrıca kabuktaki sunucu adı düğmesi `disabled` idi; Discord'un birincil
//    "Invite People" girişi Bridge'de hiç mevcut değildi.
//
// 2) ÜYEDEN DM BAŞLATMA YOKTU.
//    Üye satırları zaten `<button>` idi ama HİÇBİR tıklama eylemi yoktu.
//    DM'e ulaşmanın tek yolları sohbet başlığındaki liste düğmesi ve
//    Arkadaşlar paneliydi (yalnız arkadaşlar). "Sunucuda gördüğüm kişiye
//    yazmak" akışı YOKTU.
//
// Her iki düzeltme de KANONİK sahiplere delege eder:
//   · davet  → mevcut `POST /api/servers/invites` sözleşmesi
//   · DM     → `openDm` (DmPanel sahibi); yeni DM durumu/soketi KURULMAZ.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountInvitePanel, unmountInvitePanel } from '../js/core/invite-svelte.ts';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVER = { _id: 'srv-ux', name: 'UX Test Sunucu' };
const ok = (b: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => b } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const panel = () => document.querySelector('.inv-card');
const link  = () => document.querySelector<HTMLInputElement>('.inv-link');

beforeEach(() => {
  unmountInvitePanel();
  document.body.innerHTML = '';
  fetchMock = vi.fn(async () => ok({ code: 'ABC12345', expiresAt: Date.now() + 86_400_000, maxUses: 0, serverName: SERVER.name }));
  BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
  BridgeRegistry.register('currentServer', () => SERVER);
});

afterEach(() => {
  unmountInvitePanel();
  for (const k of ['apiFetch', 'currentServer', 'openInvitePanel', 'closeInvitePanel', 'openDm']) {
    BridgeRegistry.unregister(k);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function boot() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountInvitePanel(root);
  flushSync();
}
/** Panel acilir ve SONUC DOM'a yansiyana kadar beklenir.
 *  `flushSync` tek basina yetmez: `createInvite()` async'tir ve `res.json()`
 *  sonraki mikro-gorevde cozulur. */
async function open() {
  (BridgeRegistry.get<() => void>('openInvitePanel'))!();
  flushSync();
  await vi.waitFor(() => { flushSync(); expect(link()).not.toBeNull(); });
}
/** Hata/yetki durumlari icin: hata metni DOM'a yansiyana kadar bekler. */
async function openExpectingError() {
  (BridgeRegistry.get<() => void>('openInvitePanel'))!();
  flushSync();
  await vi.waitFor(() => { flushSync(); expect(document.querySelector('.inv-error')).not.toBeNull(); });
}

// ════════════════════════════════════════════════════════════════════════════
describe('DAVET — keşfedilebilirlik ve kanonik API', () => {
  it('kabukta GERÇEK bir davet açıcısı vardır (düğme artık disabled DEĞİL)', () => {
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');

    // UX/P1 GUNCELLEMESI: baslik artik DOGRUDAN daveti degil SUNUCU
    // MENUSUNU acar; davet menunun ILK ogesidir. Korunan degismez
    // "hangi oznitelik" degil ERISILEBILIRLIK ZINCIRIDIR:
    //   baslik -> sunucu menusu -> davet paneli
    expect(html).toMatch(/id="server-header-btn"[^>]*data-bridge-action="openServerMenu"/);
    // Regresyon kapısı: sunucu başlığı tekrar ölü bir düğmeye dönmemeli.
    expect(html).not.toMatch(/id="server-header-btn"[^>]*\bdisabled\b/);

    // Zincirin IKINCI halkasi: menu GERCEKTEN kanonik davet sahibini cagirir.
    const menuSrc = fs.readFileSync(path.join(CLIENT, 'js/core/ServerMenu.svelte'), 'utf8');
    expect(menuSrc).toMatch(/call\('openInvitePanel'\)/);
  });

  it('üretim giriş noktası davet köprüsünü İMPORT EDER', () => {
    const app = fs.readFileSync(path.join(CLIENT, 'js/app.ts'), 'utf8');
    expect(app).toMatch(/core\/invite-svelte/);
  });

  it('POZİTİF KONTROL: açılış KANONİK uca gider ve bağlantı gösterir', async () => {
    boot(); await open();

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/servers/invites');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ serverId: SERVER._id });

    expect(panel()).not.toBeNull();
    expect(link()!.value).toContain('ABC12345');
  });

  it('YETKİSİZ kullanıcıya (403) oluşturma yeteneği verilmez', async () => {
    fetchMock = vi.fn(async () => ok({ error: 'x' }, 403));
    boot();
    await openExpectingError();

    // Sunucunun kararı DÜRÜSTÇE gösterilir; istemci davet uydurmaz.
    expect(document.querySelector('.inv-error')?.textContent).toMatch(/yetkiniz yok/i);
    expect(link()).toBeNull();
  });

  it('HATA durumunda bağlantı gösterilmez', async () => {
    fetchMock = vi.fn(async () => ok({}, 500));
    boot();
    await openExpectingError();

    expect(document.querySelector('.inv-error')).not.toBeNull();
    expect(link()).toBeNull();
  });

  it('sunucu seçili değilken uca İSTEK ATILMAZ', async () => {
    BridgeRegistry.register('currentServer', () => null);
    boot();
    (BridgeRegistry.get<() => void>('openInvitePanel'))!();
    flushSync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('.inv-error')?.textContent).toMatch(/sunucu seçin/i);
  });

  it('Escape paneli kapatır ve odak tuzağı bırakılır', async () => {
    boot(); await open();
    expect(panel()).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    expect(panel()).toBeNull();
  });

  it('aynı sunucunun hazır kodunu yeniden kullanır ama başka sunucuya sızdırmaz', async () => {
    let selected = SERVER;
    BridgeRegistry.register('currentServer', () => selected);
    fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const serverId = JSON.parse(String(init.body)).serverId as string;
      return ok({ code: serverId === SERVER._id ? 'FIRST-CODE' : 'SECOND-CODE', maxUses: 0, serverName: selected.name });
    });
    BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
    boot();
    await open();

    (BridgeRegistry.get<() => void>('closeInvitePanel'))!();
    (BridgeRegistry.get<() => void>('openInvitePanel'))!();
    await vi.waitFor(() => { flushSync(); expect(link()?.value).toContain('FIRST-CODE'); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    selected = { _id: 'srv-other', name: 'Başka Sunucu' };
    (BridgeRegistry.get<() => void>('openInvitePanel'))!();
    await vi.waitFor(() => { flushSync(); expect(link()?.value).toContain('SECOND-CODE'); });
    expect(link()?.value).not.toContain('FIRST-CODE');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('geç tamamlanan eski sunucu isteğinin yeni sunucu kodunu ezmesine izin vermez', async () => {
    const first = deferred<Response>();
    let selected = SERVER;
    BridgeRegistry.register('currentServer', () => selected);
    fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const serverId = JSON.parse(String(init.body)).serverId as string;
      if (serverId === SERVER._id) return first.promise;
      return ok({ code: 'CURRENT-CODE', maxUses: 4, serverName: selected.name });
    });
    BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
    boot();
    (BridgeRegistry.get<() => void>('openInvitePanel'))!();
    flushSync();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    selected = { _id: 'srv-current', name: 'Güncel Sunucu' };
    (BridgeRegistry.get<() => void>('openInvitePanel'))!();
    await vi.waitFor(() => { flushSync(); expect(link()?.value).toContain('CURRENT-CODE'); });
    first.resolve(ok({ code: 'STALE-CODE', maxUses: 1, serverName: SERVER.name }));
    await Promise.resolve();
    flushSync();

    expect(link()?.value).toContain('CURRENT-CODE');
    expect(link()?.value).not.toContain('STALE-CODE');
    expect(document.querySelector('.inv-meta')).toHaveTextContent('en fazla 4 kullanım');
  });

  it('JSON aşamasında geciken eski yanıtı da reddeder', async () => {
    const oldJson = deferred<unknown>();
    let selected = SERVER;
    BridgeRegistry.register('currentServer', () => selected);
    fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const serverId = JSON.parse(String(init.body)).serverId as string;
      if (serverId === SERVER._id) {
        return { ok: true, status: 200, json: () => oldJson.promise } as Response;
      }
      return ok({ code: 'NEW-JSON-CODE', maxUses: 0, serverName: selected.name });
    });
    BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
    boot();
    (BridgeRegistry.get<() => void>('openInvitePanel'))!();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    selected = { _id: 'srv-json-new', name: 'JSON Yeni' };
    (BridgeRegistry.get<() => void>('openInvitePanel'))!();
    await vi.waitFor(() => { flushSync(); expect(link()?.value).toContain('NEW-JSON-CODE'); });
    oldJson.resolve({ code: 'OLD-JSON-CODE', maxUses: 9, serverName: SERVER.name });
    await Promise.resolve();
    flushSync();

    expect(link()?.value).toContain('NEW-JSON-CODE');
  });

  it.each([
    ['süresiz ve sınırsız', undefined, 0, /Süresiz · sınırsız kullanım/],
    ['süresi dolmuş', Date.now() - 1, 0, /Süresi doldu/],
    ['dakika', Date.now() + 30.5 * 60_000, 0, /30 dakika geçerli/],
    ['saat', Date.now() + 3.5 * 3_600_000, 0, /3 saat geçerli/],
    ['gün ve kullanım sınırı', Date.now() + 2.5 * 86_400_000, 7, /2 gün geçerli · en fazla 7 kullanım/],
  ])('%s meta verisini kanonik yanıttan gösterir', async (_label, expiresAt, maxUses, expected) => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    fetchMock = vi.fn(async () => ok({ code: 'META-CODE', expiresAt, maxUses }));
    BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
    boot();
    await open();

    expect(document.querySelector('.inv-meta')).toHaveTextContent(expected);
    expect(document.querySelector('.inv-sub')).toHaveTextContent(SERVER.name);
  });

  it('kopyalama durumunu yeniler, metni seçer ve pano reddini görünür kılar', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    boot();
    await open();

    const input = link()!;
    const select = vi.spyOn(input, 'select');
    input.focus();
    expect(select).toHaveBeenCalled();

    (document.querySelector('.inv-copy') as HTMLButtonElement).click();
    await vi.waitFor(() => { flushSync(); expect(document.querySelector('.inv-copy')).toHaveTextContent('Kopyalandı'); });
    expect(writeText).toHaveBeenCalledWith(input.value);

    vi.useFakeTimers();
    (document.querySelector('.inv-copy') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    flushSync();
    expect(document.querySelector('.inv-copy')).toHaveTextContent('Kopyala');

    vi.useRealTimers();
    writeText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    (document.querySelector('.inv-copy') as HTMLButtonElement).click();
    await vi.waitFor(() => { flushSync(); expect(document.querySelector('.inv-error')).toHaveTextContent('Panoya kopyalanamadı'); });
  });

  it('arka plan tıklaması kapatır, kart içi tıklama kapatmaz ve API sahibi yokluğu güvenli hata verir', async () => {
    boot();
    await open();
    panel()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(panel()).not.toBeNull();
    document.querySelector('.inv-overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(panel()).toBeNull();

    unmountInvitePanel();
    BridgeRegistry.unregister('apiFetch');
    boot();
    await openExpectingError();
    expect(document.querySelector('.inv-error')).toHaveTextContent('Davet oluşturulamadı');
  });

  it('eksik sunucu adı ve geçersiz kullanım sınırı için güvenli görünüm kullanır', async () => {
    BridgeRegistry.register('currentServer', () => ({ _id: 'nameless-server' }));
    fetchMock = vi.fn(async () => ok({ code: 'NAMELESS', maxUses: -4 }));
    BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
    boot();
    await open();

    expect(document.querySelector('.inv-sub')).toBeNull();
    expect(document.querySelector('.inv-meta')).toHaveTextContent('sınırsız kullanım');
  });

  it('yeniden üretim sürerken mevcut kodu korur ve unmount zamanlayıcı/yanıtı temizler', async () => {
    const pending = deferred<Response>();
    fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ code: 'STABLE', maxUses: 0, serverName: SERVER.name }))
      .mockImplementationOnce(() => pending.promise);
    BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    boot();
    await open();
    (document.querySelector('.inv-copy') as HTMLButtonElement).click();
    await vi.waitFor(() => { flushSync(); expect(document.querySelector('.inv-copy')).toHaveTextContent('Kopyalandı'); });

    (document.querySelector('.inv-new') as HTMLButtonElement).click();
    flushSync();
    expect(document.querySelector('.inv-new')).toBeDisabled();
    expect(document.querySelector('.inv-new')).toHaveTextContent('Oluşturuluyor');
    expect(link()?.value).toContain('STABLE');

    unmountInvitePanel();
    pending.resolve(ok({ code: 'TOO-LATE', maxUses: 1, serverName: SERVER.name }));
    await Promise.resolve();
    expect(panel()).toBeNull();
  });

  it('GİZLİ panel Escape\'i YUTMAZ', () => {
    boot();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.removeEventListener('keydown', spy);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it('unmount sonrası kayıtlar bırakılır (ölü bileşene çağrı gitmez)', () => {
    boot();
    expect(BridgeRegistry.has('openInvitePanel')).toBe(true);

    unmountInvitePanel();
    flushSync();

    expect(BridgeRegistry.has('openInvitePanel')).toBe(false);
  });

  it('İKİNCİ bir davet servisi kurulmaz (tek kanonik uç)', () => {
    const raw = fs.readFileSync(path.join(CLIENT, 'js/core/InvitePanel.svelte'), 'utf8');
    // Denetim KOD uzerinde: bu dosyanin yorumlari kusuru ANLATIRKEN eski
    // `/invites/:code/use` yolunu da geciriyor. Ayrica `[^/]+` YENI SATIRI da
    // eslestirdigi icin iki ayri satirdaki ifadeyi birlestirip DOGRU kodu
    // yanlislikla ihlal sayiyordu — desen tek satirla sinirlandi.
    const src = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect((src.match(/\/api\/servers\/invites/g) ?? []).length).toBeGreaterThan(0);
    // Final21 Phase 16: this line held a literal BACKSPACE where \b was meant, so the
    // assertion could never match anything and passed vacuously.
    expect(src).not.toMatch(/\/api\/invites\b/);
    expect(src).not.toMatch(/\/api\/servers\/[^/\s]+\/invites/);
  });
});

describe('DM — üyeden başlatma', () => {
  it('üye satırı KANONİK openDm sahibine delege eder', () => {
    const src = fs.readFileSync(path.join(CLIENT, 'js/core/MemberListPanel.svelte'), 'utf8');

    // UX/P1 GUNCELLEMESI: satirin BIRINCIL eylemi artik PROFILI acmaktir
    // (Discord davranisi); DM oradaki "Mesaj gonder" ile baslatilir. DM yolu
    // KALDIRILMADI — profil sahibi kayitli degilse satir dogrudan DM'e duser.
    // Bu test o yedegin ve kanonik delegasyonun KORUNDUGUNU dogrular.
    expect(src).toMatch(/onclick=\{\(\) => openProfile\(member\)\}/);
    expect(src).toMatch(/has\('openMemberProfile'\)[\s\S]{0,120}startDm\(member\);/);
    // Kanonik sahibe delege edilir…
    expect(src).toMatch(/BridgeRegistry\.call\('openDm'/);
    // …ve İKİNCİ bir DM durumu/soketi kurulmaz.
    expect(src).not.toMatch(/io\(|socket\.on\('dm:/);
  });

  it('sahip kayıtlı değilse sessizce yok sayar (çökmeye yol açmaz)', () => {
    const src = fs.readFileSync(path.join(CLIENT, 'js/core/MemberListPanel.svelte'), 'utf8');
    expect(src).toMatch(/has\('openDm'\)/);
  });

  it('üye satırı erişilebilir ad taşır', () => {
    const src = fs.readFileSync(path.join(CLIENT, 'js/core/MemberListPanel.svelte'), 'utf8');
    // Ad, satirin GERCEK eylemini anlatir (profil acar, DM baslatmaz).
    //
    // Metin artik SABIT KODLU degil, kanonik i18n'den gelir: panelin geri
    // kalani Ingilizce sabit kodluydu ve ayni bilesende iki dil vardi
    // (bkz. tests/i18n-consistency.test.ts). Degisen sey metnin KAYNAGI;
    // erisilebilir adin VARLIGI ve iceriginin "profil ac" olmasi degil.
    expect(src).toMatch(/aria-label=\{`\$\{name\} — \$\{t\('open_profile'/);
  });
});

describe('KABUK ORANLARI — alt panel taşması', () => {
  it('kanal kenar çubuğu kullanıcı adına yer bırakır', () => {
    // OLCUM: 240px'de sabit tuketim 190px, ada ~50px kaliyordu.
    // 256px ile ad alani ~70px olur. Bu test oranin geri alinmasini engeller.
    const css = fs.readFileSync(path.join(CLIENT, 'css/tokens.css'), 'utf8');
    const m = /--shell-sidebar-width:\s*(\d+)px/.exec(css);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(256);
  });

  it('üye listesi satır içi nefes payına sahiptir', () => {
    const css = fs.readFileSync(path.join(CLIENT, 'css/tokens.css'), 'utf8');
    const m = /--shell-members-width:\s*(\d+)px/.exec(css);
    expect(Number(m![1])).toBeGreaterThanOrEqual(240);
  });

  it('1366px genişlikte sohbet alanı kullanılabilir kalır', () => {
    const css = fs.readFileSync(path.join(CLIENT, 'css/tokens.css'), 'utf8');
    const num = (n: string) => Number(new RegExp(`--shell-${n}:\\s*(\\d+)px`).exec(css)![1]);
    const chrome = num('rail-width') + num('sidebar-width') + num('members-width');

    // Kabuk 1366px'in yarisindan fazlasini YEMEMELI.
    expect(chrome).toBeLessThan(1366 / 2);
    expect(1366 - chrome).toBeGreaterThan(750);
  });
});
