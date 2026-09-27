// client/tests/server-menu-channel-create.test.ts
import { t } from '../js/core/i18n/index.ts';
// UX/P1 — SUNUCU MENÜSÜ + UX/P0 — KANAL OLUŞTURMA.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN ÜÇÜNCÜ ÇEKİRDEK AKIŞ EKSİĞİ
// ════════════════════════════════════════════════════════════════════════════
// Davet eksiğiyle AYNI SINIFTA bir boşluk ölçüldü:
//   · `POST /api/servers/:sid/channels` sunucuda TAM olarak vardı
//     (MANAGE_CHANNELS, tür doğrulaması, hız sınırı, 500 kanal üst sınırı)
//     ama istemcide bu uca giden ÇAĞRI SAYISI SIFIRDI.
//     → Bir sunucu sahibi kendi sunucusuna KANAL EKLEYEMİYORDU.
//   · `POST /api/servers/:sid/leave` de aynı durumdaydı: istemcide çağrı YOK.
//     → Bir kullanıcı katıldığı sunucudan AYRILAMIYORDU.
//
// ════════════════════════════════════════════════════════════════════════════
// BU DOSYANIN KORUDUĞU DEĞİŞMEZLER
// ════════════════════════════════════════════════════════════════════════════
// 1. Menü YALNIZ gerçek yetenekleri gösterir (ölü satır yok).
// 2. Görünürlük SUNUCUDAN okunur ve FAIL-CLOSED'dur; istemci yetki UYDURMAZ.
// 3. İstemci görünürlüğü sunucu yetkilendirmesinin YERİNE GEÇMEZ — sunucunun
//    403/400 kararı dürüstçe gösterilir.
// 4. İkinci bir kanal listesi/servisi kurulmaz; kanonik `loadChannels` çağrılır.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountServerMenu, unmountServerMenu } from '../js/core/server-menu-svelte.ts';
import { mountCreateChannel, unmountCreateChannel } from '../js/core/create-channel-svelte.ts';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PERMS = { MANAGE_CHANNELS: 1 << 1, MANAGE_ROLES: 1 << 2, MANAGE_SERVER: 1 << 3, ADMIN: 1 << 30 };
const ME     = { id: 'user-1' };
const SERVER = { _id: 'srv-1', name: 'Test Sunucu', ownerId: 'user-owner' };

const ok = (b: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => b } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;
let permissions = 0;
let leaveResponse: Response = ok({ left: true });
let createResponse: Response = ok({ _id: 'chan-new', name: 'yeni-kanal' }, 201);

const menu   = () => document.querySelector('.sm-menu');
const items  = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const labels = () => items().map(el => el.textContent?.trim() ?? '');
const trigger = () => document.getElementById('server-header-btn') as HTMLButtonElement;

function routedFetch(url: string, init?: RequestInit): Response {
  if (url.includes('/me/permissions')) return ok({ permissions });
  if (url.includes('/leave'))          return leaveResponse;
  if (/\/channels$/.test(url) && init?.method === 'POST') return createResponse;
  return ok({});
}

beforeEach(() => {
  unmountServerMenu();
  unmountCreateChannel();
  document.body.innerHTML =
    '<button type="button" id="server-header-btn" aria-expanded="false">Test Sunucu</button>';

  permissions = 0;
  leaveResponse = ok({ left: true });
  createResponse = ok({ _id: 'chan-new', name: 'yeni-kanal' }, 201);

  fetchMock = vi.fn(async (u: string, i?: RequestInit) => routedFetch(String(u), i));
  BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
  BridgeRegistry.register('currentServer', () => SERVER);
  BridgeRegistry.register('me', () => ME);
});

afterEach(() => {
  unmountServerMenu();
  unmountCreateChannel();
  for (const k of ['apiFetch', 'currentServer', 'me', 'openServerMenu', 'closeServerMenu',
                   'toggleServerMenu', 'openCreateChannel', 'closeCreateChannel',
                   'openInvitePanel', 'openServerSettings', 'loadChannels', 'selectChannel',
                   'loadServers', 'openBotMarketplace', 'showNotificationPrefsPanel']) {
    BridgeRegistry.unregister(k);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function bootMenu() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountServerMenu(root);
  flushSync();
}
function bootCreate() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountCreateChannel(root);
  flushSync();
}
/** Menuyu acar ve YETKILER DOM'a yansiyana kadar bekler (fetch async'tir). */
async function openMenu() {
  (BridgeRegistry.get<() => void>('openServerMenu'))!();
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelector('.sm-state')?.textContent ?? '').not.toMatch(/okunuyor/);
  });
}

// ════════════════════════════════════════════════════════════════════════════
describe('SUNUCU MENÜSÜ — gerçek yetenekler ve yetki', () => {
  it('kabuk başlığı menüyü açar (ölü/disabled düğme DEĞİL)', () => {
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');

    expect(html).toMatch(/id="server-header-btn"[^>]*data-bridge-action="openServerMenu"/);
    expect(html).toMatch(/id="server-header-btn"[^>]*aria-haspopup="menu"/);
    // Regresyon kapisi: baslik tekrar ölü bir düğmeye dönmemeli.
    expect(html).not.toMatch(/id="server-header-btn"[^>]*\bdisabled\b/);
  });

  it('kabuk düğmesine TIKLAMAK menüyü GERÇEKTEN açar (dispatcher güvenilmez)', async () => {
    // CANLI URUNDE YAKALANDI: `index.html` dispatcher'i KLASIK bir inline
    // script'tir; `BridgeRegistry` ise `window`a hic atanmayan bir ESM disa
    // aktarimidir. Bu yuzden dispatcher'in registry dali HIC calismaz ve
    // `data-bridge-action="openServerMenu"` TEK BASINA OLU bir baglantidir.
    // Menu, kabukta gercekten acilmiyordu.
    //
    // Bu test ONCEKI hali YAKALAR: yalnizca oznitelige bakan bir iddia
    // yesil kalirdi; burada GERCEK tiklama olculur.
    permissions = 0;
    bootMenu();
    await vi.waitFor(() => expect(BridgeRegistry.has('openServerMenu')).toBe(true));

    trigger().click();
    flushSync();
    await vi.waitFor(() => { flushSync(); expect(menu()).not.toBeNull(); });

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('tekrar tıklamak menüyü kapatır (toggle)', async () => {
    permissions = 0;
    bootMenu();
    await vi.waitFor(() => expect(BridgeRegistry.has('openServerMenu')).toBe(true));

    trigger().click(); flushSync();
    await vi.waitFor(() => { flushSync(); expect(menu()).not.toBeNull(); });
    trigger().click(); flushSync();

    expect(menu()).toBeNull();
  });

  it('unmount sonrası kabuk düğmesi dinleyicisi BIRAKILIR', async () => {
    bootMenu();
    await vi.waitFor(() => expect(BridgeRegistry.has('openServerMenu')).toBe(true));
    unmountServerMenu();
    flushSync();

    trigger().click();
    flushSync();

    expect(menu()).toBeNull();
  });

  it('üretim giriş noktası menü ve kanal köprülerini İMPORT EDER', () => {
    const app = fs.readFileSync(path.join(CLIENT, 'js/app.ts'), 'utf8');
    expect(app).toMatch(/core\/server-menu-svelte/);
    expect(app).toMatch(/core\/create-channel-svelte/);
  });

  it('YETKİSİZ üyeye yönetim öğeleri GÖSTERİLMEZ', async () => {
    permissions = 0;
    BridgeRegistry.register('openInvitePanel', () => {});
    BridgeRegistry.register('openCreateChannel', () => {});
    BridgeRegistry.register('openServerSettings', () => {});
    bootMenu(); await openMenu();

    expect(labels().join(' ')).not.toMatch(/Kanal oluştur/);
    expect(labels().join(' ')).not.toMatch(/Sunucu ayarları/);
    // Davet üyeliğe bağlıdır — uç 403 verirse panel dürüstçe söyler.
    expect(labels().join(' ')).toMatch(/davet/i);
  });

  it('bot pazaryeri sunucu menüsünden bulunur; yalnız MANAGE_SERVER sahibine gösterilir', async () => {
    // Final21 Faz 14: pazaryeri önceden yalnız komut paletinden açılabiliyordu.
    const openMarketplace = vi.fn();
    BridgeRegistry.register('openBotMarketplace', openMarketplace);
    const addBots = () => items().find(el => el.textContent?.includes(t('server_menu_add_bots')));

    permissions = PERMS.MANAGE_CHANNELS | PERMS.MANAGE_ROLES;
    bootMenu(); await openMenu();
    expect(addBots()).toBeUndefined();
    unmountServerMenu();

    permissions = PERMS.MANAGE_SERVER;
    bootMenu(); await openMenu();
    expect(addBots()).toBeDefined();
    addBots()!.click();
    flushSync();
    expect(openMarketplace).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    unmountServerMenu();

    BridgeRegistry.unregister('openBotMarketplace');
    bootMenu(); await openMenu();
    expect(addBots()).toBeUndefined();
  });

  it('MANAGE_CHANNELS varsa kanal oluşturma GÖRÜNÜR', async () => {
    permissions = PERMS.MANAGE_CHANNELS;
    BridgeRegistry.register('openCreateChannel', () => {});
    bootMenu(); await openMenu();

    expect(labels().join(' ')).toMatch(/Kanal oluştur/);
    expect(labels().join(' ')).not.toMatch(/Sunucu ayarları/);
  });

  it('MANAGE_ROLES sahibi rol ayarlarina erisir ve Roller sekmesinde acar', async () => {
    permissions = PERMS.MANAGE_ROLES;
    const openSettings = vi.fn();
    BridgeRegistry.register('openServerSettings', openSettings);
    bootMenu(); await openMenu();

    const settings = items().find(el => /Sunucu ayarları/i.test(el.textContent ?? ''));
    expect(settings).toBeDefined();
    settings!.click();

    expect(openSettings).toHaveBeenCalledWith('roles');
  });

  it('ADMINISTRATOR tüm yönetim öğelerini açar', async () => {
    permissions = PERMS.ADMIN;
    BridgeRegistry.register('openCreateChannel', () => {});
    BridgeRegistry.register('openServerSettings', () => {});
    bootMenu(); await openMenu();

    expect(labels().join(' ')).toMatch(/Kanal oluştur/);
    expect(labels().join(' ')).toMatch(/Sunucu ayarları/);
  });

  it('FAIL-CLOSED: yetki okunamazsa yönetim öğeleri gösterilmez', async () => {
    fetchMock = vi.fn(async (u: string) =>
      String(u).includes('/me/permissions') ? ok({}, 500) : ok({}));
    BridgeRegistry.register('openCreateChannel', () => {});
    BridgeRegistry.register('openServerSettings', () => {});
    bootMenu(); await openMenu();

    expect(labels().join(' ')).not.toMatch(/Kanal oluştur/);
    expect(labels().join(' ')).not.toMatch(/Sunucu ayarları/);
  });

  it('SAHİBİ olduğu sunucuda "ayrıl" gösterilmez (uç zaten reddeder)', async () => {
    BridgeRegistry.register('currentServer', () => ({ ...SERVER, ownerId: ME.id }));
    permissions = PERMS.ADMIN;
    bootMenu(); await openMenu();

    expect(labels().join(' ')).not.toMatch(/ayrıl/i);
  });

  it('SAHİBİ olmadığı sunucuda "ayrıl" görünür ve İKİ ADIMLI onay ister', async () => {
    permissions = 0;
    bootMenu(); await openMenu();

    const leave = items().find(el => /ayrıl/i.test(el.textContent ?? ''));
    expect(leave).toBeDefined();

    // İlk tıklama YALNIZ silahlandırır — uca istek GİTMEZ.
    leave!.click(); flushSync();
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes('/leave'))).toHaveLength(0);
    expect(document.body.textContent).toMatch(/onayla/i);

    // İkinci tıklama KANONİK uca gider.
    items().find(el => /onayla/i.test(el.textContent ?? ''))!.click();
    await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x => String(x[0]).includes('/leave'));
      expect(c).toBeDefined();
      expect((c![1] as RequestInit).method).toBe('POST');
    });
  });

  it('sunucunun ayrılma reddi DÜRÜSTÇE gösterilir (sahip ayrılamaz)', async () => {
    leaveResponse = ok({ error: 'Owner cannot leave — delete the server instead' }, 400);
    permissions = 0;
    bootMenu(); await openMenu();

    items().find(el => /ayrıl/i.test(el.textContent ?? ''))!.click(); flushSync();
    items().find(el => /onayla/i.test(el.textContent ?? ''))!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.sm-error')?.textContent).toBe(t('error_bad_request'));
    });
  });

  it('SAHİBİ kayıtlı olmayan eylem menüde ÜRETİLMEZ (ölü satır yok)', async () => {
    permissions = PERMS.ADMIN;   // yetki VAR ama sahip kayıtlı DEĞİL
    bootMenu(); await openMenu();

    expect(labels().join(' ')).not.toMatch(/Kanal oluştur/);
    expect(labels().join(' ')).not.toMatch(/Sunucu ayarları/);
  });

  it('UYDURMA öğe yok: kategori menüde DEĞİL; bildirim ayarları yalnız CANLI sahip kayıtlıyken', async () => {
    const raw = fs.readFileSync(path.join(CLIENT, 'js/core/ServerMenu.svelte'), 'utf8');
    // Denetim KOD uzerinde: yorumlar bu basligi KASITLI olarak anlatir.
    const src = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/Kategori/i);

    // Final21 Faz 4 bildirim tercihlerini menüye bilerek ekledi (panel app.ts'te mount
    // ediliyor; çalışma zamanında doğrulandı) ama bu test kaynakta "Bildirim" kelimesini
    // yasaklamaya devam ettiği için o günden beri kırmızıydı (Faz 14'te bulundu). Asıl
    // değişmez "ölü satır yok"tur: sahip kayıtlı değilse öğe ÜRETİLMEZ.
    const prefsLabel = t('surface_bildirim_ayarlar_fead6c');
    bootMenu(); await openMenu();
    expect(labels().join(' ')).not.toContain(prefsLabel);
    unmountServerMenu();

    const openPrefs = vi.fn();
    BridgeRegistry.register('showNotificationPrefsPanel', openPrefs);
    bootMenu(); await openMenu();
    const prefs = items().find(el => el.textContent?.includes(prefsLabel));
    expect(prefs).toBeDefined();
    prefs!.click();
    expect(openPrefs).toHaveBeenCalledTimes(1);
  });

  it('Escape menüyü kapatır ve ODAK TETİKLEYİCİYE döner', async () => {
    permissions = 0;
    bootMenu();
    // GERÇEK AKIŞ: kullanıcı düğmeye tıklar → düğme odaktadır. `focusTrap`
    // etkinleşirken bu ögeyi saklar ve kapanışta geri verir.
    trigger().focus();
    await openMenu();
    expect(menu()).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('GİZLİ menü Escape\'i YUTMAZ', () => {
    bootMenu();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.removeEventListener('keydown', spy);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('ok tuşları öğeler arasında dolaşır', async () => {
    permissions = PERMS.ADMIN;
    BridgeRegistry.register('openInvitePanel', () => {});
    BridgeRegistry.register('openCreateChannel', () => {});
    bootMenu(); await openMenu();

    expect(items().length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(items()[0]);

    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSync();
    expect(document.activeElement).toBe(items()[1]);
  });

  it('davet, kanal oluşturma ve MANAGE_SERVER ayar eylemlerini gerçek sahiplerine yollar', async () => {
    permissions = PERMS.MANAGE_CHANNELS | PERMS.MANAGE_SERVER;
    const invite = vi.fn();
    const create = vi.fn();
    const settings = vi.fn();
    BridgeRegistry.register('openInvitePanel', invite);
    BridgeRegistry.register('openCreateChannel', create);
    BridgeRegistry.register('openServerSettings', settings);
    bootMenu(); await openMenu();

    items().find(el => /davet/i.test(el.textContent ?? ''))!.click();
    expect(invite).toHaveBeenCalledOnce();

    await openMenu();
    items().find(el => /Kanal oluştur/i.test(el.textContent ?? ''))!.click();
    expect(create).toHaveBeenCalledOnce();

    await openMenu();
    items().find(el => /Sunucu ayarları/i.test(el.textContent ?? ''))!.click();
    expect(settings).toHaveBeenCalledWith('general');
  });

  it('başarılı ayrılış menüyü kapatır ve sunucu listesini tazeler', async () => {
    const loadServers = vi.fn();
    BridgeRegistry.register('loadServers', loadServers);
    bootMenu(); await openMenu();

    items().find(el => /ayrıl/i.test(el.textContent ?? ''))!.click(); flushSync();
    items().find(el => /onayla/i.test(el.textContent ?? ''))!.click();

    await vi.waitFor(() => expect(loadServers).toHaveBeenCalledOnce());
    expect(menu()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('ayrılma reddinde boş/okunamayan gövdeyi HTTP durumuyla sınırlar', async () => {
    leaveResponse = {
      ok: false, status: 503,
      json: async () => { throw new Error('invalid json'); },
    } as unknown as Response;
    bootMenu(); await openMenu();

    items().find(el => /ayrıl/i.test(el.textContent ?? ''))!.click(); flushSync();
    items().find(el => /onayla/i.test(el.textContent ?? ''))!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.sm-error')?.textContent).toContain(t('error_server'));
    });
  });

  it('ayrılma taşıma hatasını ve eksik apiFetch sahibini kullanıcıya gösterir', async () => {
    bootMenu(); await openMenu();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    items().find(el => /ayrıl/i.test(el.textContent ?? ''))!.click(); flushSync();
    items().find(el => /onayla/i.test(el.textContent ?? ''))!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.sm-error')?.textContent).toMatch(/tekrar deneyin/i);
    });

    await openMenu();
    BridgeRegistry.unregister('apiFetch');
    items().find(el => /ayrıl/i.test(el.textContent ?? ''))!.click(); flushSync();
    items().find(el => /onayla/i.test(el.textContent ?? ''))!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.sm-error')?.textContent).toMatch(/tekrar deneyin/i);
    });
  });

  it('eksik apiFetch ile izinleri fail-closed tutar ve bozuk izin değerini sıfırlar', async () => {
    permissions = PERMS.ADMIN;
    BridgeRegistry.register('openCreateChannel', vi.fn());
    BridgeRegistry.unregister('apiFetch');
    bootMenu(); await openMenu();
    expect(labels().join(' ')).not.toContain('Kanal oluştur');

    unmountServerMenu();
    fetchMock = vi.fn(async () => ok({ permissions: 'not-a-number' }));
    BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
    bootMenu(); await openMenu();
    expect(labels().join(' ')).not.toContain('Kanal oluştur');
  });

  it('eksik sunucu kimliği ve atan me sahibi güvenli boş durum üretir', async () => {
    BridgeRegistry.register('currentServer', () => ({ name: '' }));
    BridgeRegistry.register('me', () => { throw new Error('owner unavailable'); });
    bootMenu(); await openMenu();

    expect(menu()?.getAttribute('aria-label')).toContain('Sunucu');
    const leave = items().find(el => /ayrıl/i.test(el.textContent ?? ''))!;
    leave.click(); flushSync();
    items().find(el => /onayla/i.test(el.textContent ?? ''))!.click();
    await Promise.resolve();
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/leave'))).toBe(false);
  });

  it('owner kimliğini _id alanından da tanır ve boş currentServer sonucunu sınırlar', async () => {
    BridgeRegistry.register('currentServer', () => ({ ...SERVER, ownerId: 'owner-by-id' }));
    BridgeRegistry.register('me', () => ({ _id: 'owner-by-id' }));
    bootMenu(); await openMenu();
    expect(labels().join(' ')).not.toMatch(/ayrıl/i);

    unmountServerMenu();
    BridgeRegistry.register('currentServer', () => undefined);
    bootMenu(); await openMenu();
    expect(menu()?.getAttribute('aria-label')).toContain('Sunucu');
  });

  it('tüm menü gezinme tuşlarını, etkisiz tuşu ve çevrimsel odağı uygular', async () => {
    permissions = PERMS.ADMIN;
    BridgeRegistry.register('openInvitePanel', vi.fn());
    BridgeRegistry.register('openCreateChannel', vi.fn());
    BridgeRegistry.register('openServerSettings', vi.fn());
    bootMenu(); await openMenu();

    const key = (name: string) => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    key('ArrowUp'); flushSync();
    expect(document.activeElement).toBe(items().at(-1));
    key('Home'); flushSync();
    expect(document.activeElement).toBe(items()[0]);
    key('End'); flushSync();
    expect(document.activeElement).toBe(items().at(-1));
    key('PageDown'); flushSync();
    expect(document.activeElement).toBe(items().at(-1));
    key('ArrowDown'); flushSync();
    expect(document.activeElement).toBe(items()[0]);
  });

  it('scrim yalnız kendi yüzeyine tıklanınca kapatır; resize konumu yeniden ölçer', async () => {
    let width = 100;
    vi.spyOn(trigger(), 'getBoundingClientRect').mockImplementation(() => ({
      x: 10, y: 10, top: 10, left: 10, right: 10 + width, bottom: 30,
      width, height: 20, toJSON: () => ({}),
    } as DOMRect));
    BridgeRegistry.register('openInvitePanel', vi.fn());
    bootMenu(); await openMenu();
    expect((menu() as HTMLElement).style.minWidth).toBe('220px');

    width = 300;
    window.dispatchEvent(new Event('resize'));
    flushSync();
    expect((menu() as HTMLElement).style.minWidth).toBe('300px');

    const scrim = document.querySelector<HTMLElement>('.sm-scrim')!;
    const child = document.createElement('span');
    scrim.appendChild(child);
    child.click(); flushSync();
    expect(menu()).not.toBeNull();
    scrim.click(); flushSync();
    expect(menu()).toBeNull();
  });

  it('tetikleyici yokken açılabilir ve gizliyken close çağrısı etkisizdir', async () => {
    trigger().remove();
    bootMenu();
    BridgeRegistry.call('closeServerMenu');
    BridgeRegistry.call('openServerMenu');
    flushSync();
    await vi.waitFor(() => { flushSync(); expect(menu()).not.toBeNull(); });
    expect((menu() as HTMLElement).style.minWidth).toBe('220px');
  });

  it('unmount sonrası kayıtlar bırakılır', () => {
    bootMenu();
    expect(BridgeRegistry.has('openServerMenu')).toBe(true);

    unmountServerMenu();
    flushSync();

    expect(BridgeRegistry.has('openServerMenu')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('KANAL OLUŞTURMA — kanonik uç ve sahiplik', () => {
  async function openCreate() {
    (BridgeRegistry.get<() => void>('openCreateChannel'))!();
    flushSync();
    await vi.waitFor(() => { flushSync(); expect(document.querySelector('.cc-name')).not.toBeNull(); });
  }
  const nameInput = () => document.querySelector<HTMLInputElement>('.cc-name')!;
  const submit    = () => document.querySelector<HTMLButtonElement>('.cc-go')!;

  it('POZİTİF KONTROL: KANONİK uca POST eder ve listeyi kanonik sahibe tazeletir', async () => {
    const loadChannels = vi.fn();
    const selectChannel = vi.fn();
    BridgeRegistry.register('loadChannels', loadChannels);
    BridgeRegistry.register('selectChannel', selectChannel);
    bootCreate(); await openCreate();

    nameInput().value = 'Yeni Kanal';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    submit().click();

    await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x => /\/channels$/.test(String(x[0])));
      expect(c).toBeDefined();
      expect((c![1] as RequestInit).method).toBe('POST');
      // Sunucunun ad kuralı istemcide ÖNCEDEN uygulanır.
      expect(JSON.parse(String((c![1] as RequestInit).body))).toMatchObject({
        name: 'yeni-kanal', type: 'text',
      });
    });
    await vi.waitFor(() => expect(loadChannels).toHaveBeenCalled());
    expect(selectChannel).toHaveBeenCalled();
  });

  it('YETKİSİZ kullanıcıya (403) dürüst mesaj gösterilir', async () => {
    createResponse = ok({ error: 'Missing permission: MANAGE_CHANNELS' }, 403);
    bootCreate(); await openCreate();

    nameInput().value = 'deneme';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    submit().click();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.cc-error')?.textContent).toMatch(/yetkiniz yok/i);
    });
  });

  it('sunucunun 400 kararı (ör. kanal üst sınırı) DÜRÜSTÇE gösterilir', async () => {
    createResponse = ok({ error: 'Channel limit reached (max 500 per server)' }, 400);
    bootCreate(); await openCreate();

    nameInput().value = 'deneme';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    submit().click();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.cc-error')?.textContent).toBe(t('error_bad_request'));
    });
  });

  it('boş adla uca İSTEK ATILMAZ', async () => {
    bootCreate(); await openCreate();
    expect(submit().disabled).toBe(true);

    submit().click();
    flushSync();

    expect(fetchMock.mock.calls.filter(c => /\/channels$/.test(String(c[0])))).toHaveLength(0);
  });

  it('İKİNCİ bir kanal listesi/servisi kurulmaz', () => {
    const raw = fs.readFileSync(path.join(CLIENT, 'js/core/CreateChannelPanel.svelte'), 'utf8');
    const src = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(src).toMatch(/loadChannels/);
    expect(src).not.toMatch(/io\(|socket\.on\(/);
    // Kanal listesi burada TUTULMAZ.
    expect(src).not.toMatch(/channels\s*=\s*\$state/);
  });

  it('Escape paneli kapatır', async () => {
    bootCreate(); await openCreate();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(document.querySelector('.cc-name')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GİRDİ MİMARİSİ — ölü paket sevkiyatı geri gelmemeli', () => {
  it('build YALNIZ gerçekten talep edilen girdileri derler', () => {
    const build = fs.readFileSync(path.resolve(CLIENT, '..', 'scripts/build.js'), 'utf8');
    const src = build.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const entries = [...src.matchAll(/entry\('([^']+)'\)/g)].map(m => m[1]);

    // ÖLÇÜM: tüm HTML sayfalarındaki <script src> taraması yalnız bu ikisini
    // talep ediyordu; diğer 14 girdi tarayıcıya HİÇ gitmiyordu.
    expect(entries).toEqual(['app.js', 'plugin-marketplace-page.js']);
  });

  it('kabuk yalnız app.js çeker (15 eski paket geri EKLENMEZ)', () => {
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]*src="(js\/[^"]+)"/g)].map(m => m[1]);
    expect(srcs).toEqual(['js/app.js']);
  });

  it('marketplace.html girdisi KORUNUR (gerçekten yüklenen ikinci sayfa)', () => {
    const html = fs.readFileSync(path.join(CLIENT, 'marketplace.html'), 'utf8');
    expect(html).toMatch(/src="js\/plugin-marketplace-page\.js"/);
  });
});
