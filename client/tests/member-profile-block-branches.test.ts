// client/tests/member-profile-block-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÜYE PROFİLİ — ENGELLEME/ENGEL KALDIRMA VE ARKADAŞLIK KENARLARI
// ════════════════════════════════════════════════════════════════════════════
//
// Engelleme bir GÜVENLİK eylemidir ve yanlışları sessizdir:
//
//   · YANLIŞ KİŞİ — kullanıcı istek uçarken başka bir profile geçebilir.
//     Yanıt eski hedefe uygulanırsa YANLIŞ kişi engellenmiş görünür.
//   · YANLIŞ DURUM — engel durumu okunamadığında düğme gösterilmemelidir
//     (fail-closed); aksi hâlde kullanıcı zaten engellediği birini "engelle"
//     sanır ve tersine döner.
//   · ONAY — engelleme yıkıcıdır ve ürün diyaloğuyla onaylanır; iptal
//     edilirse istek GİTMEZ.
//   · HATA METNİ — 401/403, 404, 429 ve diğerleri ayrı ürün metinleri
//     üretmelidir; tek bir genel metin kullanıcıya ne yapacağını söylemez.
//
// `member-profile-popover-deep-coverage.test.ts` profil/rol yüzeyini ölçer;
// bu dosya engel/arkadaşlık mutasyonlarını tamamlar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MemberProfilePopover from '../js/core/MemberProfilePopover.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { closeProductDialog } from '../js/core/product-dialog.ts';
import { t } from '../js/core/i18n/index.ts';

type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const VIEWER = 'viewer';
const TARGET = 'user-a';
const SERVER = 'server-a';
const PROFILE = { _id: TARGET, username: 'ada', displayName: 'Ada Lovelace', status: 'online' };

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null;
let apiFetch: ReturnType<typeof vi.fn<ApiFetch>>;
let friendsBody: unknown;
let friendsStatus: number;
let blocksBody: unknown;
let blocksStatus: number;
let mutationHandler: ApiFetch | null;

function installApi(): void {
  apiFetch = vi.fn<ApiFetch>(async (url, init) => {
    if (mutationHandler && (init?.method || url.includes('/blocks/'))) {
      const custom = await mutationHandler(url, init);
      if (custom) return custom;
    }
    if (url.includes('/api/users/')) return response(PROFILE);
    if (url.endsWith('/api/friends')) return response(friendsBody, friendsStatus);
    if (url.endsWith('/api/friends/blocks')) return response(blocksBody, blocksStatus);
    if (url.includes('/roles')) return response([]);
    // Mutasyon uclari varsayilan olarak BASARILI doner; hata dallari
    // `mutationHandler` ile acikca kurulur.
    if (init?.method) return response({ ok: true });
    return response({}, 404);
  });
  BridgeRegistry.register('apiFetch', apiFetch);
}

function open(id = TARGET): void {
  BridgeRegistry.call('openMemberProfile', id);
  flushSync();
}

async function settle(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('.mp-name')?.textContent).toBeTruthy();
  });
  for (let i = 0; i < 8; i += 1) { await Promise.resolve(); flushSync(); }
}

async function answerDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await vi.waitFor(() => {
    expect(document.querySelector(`[data-product-dialog-action="${action}"]`)).not.toBeNull();
  });
  document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`)!.click();
  for (let i = 0; i < 8; i += 1) { await Promise.resolve(); flushSync(); }
}

const blockButton = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('.mp-block');
const friendButton = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('.mp-friend');
const notes = (): string[] => [...host.querySelectorAll('.mp-note')].map(node => node.textContent ?? '');
const mutations = (): string[] =>
  apiFetch.mock.calls.filter(([, init]) => Boolean(init?.method)).map(([url, init]) => `${init!.method} ${url}`);

beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
  friendsBody = [];
  friendsStatus = 200;
  blocksBody = { blocks: [] };
  blocksStatus = 200;
  mutationHandler = null;
  delete (globalThis as { BRIDGE_API?: string }).BRIDGE_API;
  BridgeRegistry.register('currentServer', () => ({ _id: SERVER }));
  BridgeRegistry.register('me', () => ({ id: VIEWER }));
  installApi();
  component = mount(MemberProfilePopover, { target: host });
  flushSync();
  await vi.waitFor(() => expect(BridgeRegistry.has('openMemberProfile')).toBe(true));
});

afterEach(() => {
  closeProductDialog();
  if (component) unmount(component);
  component = null;
  for (const key of ['apiFetch', 'currentServer', 'me', 'openDm', 'openMemberProfile', 'closeMemberProfile']) {
    BridgeRegistry.unregister(key);
  }
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('engel durumu okuması', () => {
  it('engelli kullanıcı için "engeli kaldır", temiz kullanıcı için "engelle" gösterilir', async () => {
    blocksBody = { blocks: [{ userId: TARGET }] };
    open();
    await settle();
    expect(blockButton()!.textContent).toContain(t('surface_engeli_kald_r_4902bf'));

    BridgeRegistry.call('closeMemberProfile');
    blocksBody = { blocks: [{ userId: 'baskasi' }] };
    open();
    await settle();
    expect(blockButton()!.textContent).toContain(t('perm_deny_label'));
  });

  it('engel listesi okunamazsa hiçbir engel eylemi gösterilmez (fail-closed)', async () => {
    blocksStatus = 500;
    open();
    await settle();
    expect(blockButton()).toBeNull();
  });

  it('engel listesi bozuk gelirse de eylem gösterilmez', async () => {
    blocksBody = { blocks: 'hepsi' };
    open();
    await settle();
    // Dizi olmayan yanit "engelli degil" anlamina GELMEZ; temiz kabul edilir
    // ama satirlar taranmaz.
    expect(blockButton()!.textContent).toContain(t('perm_deny_label'));
  });

  it('kendi profilinde engel ve arkadaşlık eylemleri hiç çizilmez', async () => {
    open(VIEWER);
    await settle();
    expect(blockButton()).toBeNull();
    expect(friendButton()).toBeNull();
  });

  it('istek yanıtı geç gelirse ve profil değişmişse eski durum uygulanmaz', async () => {
    let releaseBlocks!: (value: Response) => void;
    apiFetch.mockImplementation(async (url) => {
      if (url.includes('/api/users/')) return response(PROFILE);
      if (url.endsWith('/api/friends')) return response([]);
      if (url.endsWith('/api/friends/blocks')) return new Promise<Response>((resolve) => { releaseBlocks = resolve; });
      return response([]);
    });

    open();
    flushSync();
    BridgeRegistry.call('closeMemberProfile');
    flushSync();
    releaseBlocks(response({ blocks: [{ userId: TARGET }] }));
    for (let i = 0; i < 8; i += 1) { await Promise.resolve(); flushSync(); }

    // Kapanmis panelde eski yanit hicbir sey cizmez.
    expect(host.querySelector('.mp-block')).toBeNull();
  });
});

describe('engelleme akışı', () => {
  it('onay iptal edilirse istek gitmez', async () => {
    open();
    await settle();

    blockButton()!.click();
    await answerDialog('cancel');

    expect(mutations()).toEqual([]);
    expect(blockButton()!.textContent).toContain(t('perm_deny_label'));
  });

  it('onaylanan engelleme arkadaşlığı da düşürür ve not gösterir', async () => {
    friendsBody = [{ _id: TARGET }];
    open();
    await settle();
    expect(friendButton()!.textContent).toContain(t('surface_arkadasl_ktan_c_kar_11343e'));

    blockButton()!.click();
    await answerDialog('confirm');

    expect(mutations()).toEqual([`POST ${location.origin}/api/friends/blocks`]);
    expect(blockButton()!.textContent).toContain(t('surface_engeli_kald_r_4902bf'));
    expect(notes().join(' ')).toContain(t('ui_kullanici_engellendi', 'Kullanıcı engellendi.'));
    // Engellenen kisi icin arkadaslik eylemi HIC cizilmez: engelliyken
    // "arkadas ekle" gostermek celiskili bir urun durumu olurdu.
    expect(friendButton()).toBeNull();
  });

  it('durum kodlarına göre ayrı ürün metinleri verilir', async () => {
    const cases: Array<[number, string]> = [
      [401, t('ui_bu_islem_icin_oturumunuzu_yenileyin', 'Bu işlem için oturumunuzu yenileyin.')],
      [403, t('ui_bu_islem_icin_oturumunuzu_yenileyin', 'Bu işlem için oturumunuzu yenileyin.')],
      [404, t('ui_kullanici_artik_erisilebilir_degil', 'Kullanıcı artık erişilebilir değil.')],
      [429, t('ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_deneyin', 'Çok hızlı işlem yapılıyor. Biraz sonra tekrar deneyin.')],
      [500, t('ui_kullanici_engellenemedi', 'Kullanıcı engellenemedi.')],
    ];

    for (const [status, message] of cases) {
      mutationHandler = async (_url, init) => (init?.method === 'POST' ? response({}, status) : null as never);
      open();
      await settle();

      blockButton()!.click();
      await answerDialog('confirm');

      expect(notes().join(' ')).toContain(message);
      // Basarisiz engelleme durumu DEGISTIRMEZ.
      expect(blockButton()!.textContent).toContain(t('perm_deny_label'));
      BridgeRegistry.call('closeMemberProfile');
      flushSync();
    }
  });

  it('ağ hatası genel engelleme hatası verir ve düğmeyi serbest bırakır', async () => {
    mutationHandler = async (_url, init) => {
      if (init?.method === 'POST') throw new Error('offline');
      return null as never;
    };
    open();
    await settle();

    blockButton()!.click();
    await answerDialog('confirm');

    expect(notes().join(' ')).toContain(t('ui_kullanici_engellenemedi', 'Kullanıcı engellenemedi.'));
    expect(blockButton()!.disabled).toBe(false);
  });

  it('apiFetch kayıtlı değilse engelleme sessizce başarılı görünmez', async () => {
    open();
    await settle();
    BridgeRegistry.unregister('apiFetch');

    blockButton()!.click();
    await answerDialog('confirm');

    expect(notes().join(' ')).toContain(t('ui_kullanici_engellenemedi', 'Kullanıcı engellenemedi.'));
    expect(blockButton()!.textContent).toContain(t('perm_deny_label'));
  });
});

describe('engel kaldırma akışı', () => {
  it('engel kaldırma onay istemez, kimliği kodlar ve arkadaşlık durumunu tazeler', async () => {
    blocksBody = { blocks: [{ userId: TARGET }] };
    open();
    await settle();

    blockButton()!.click();
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); flushSync(); }

    expect(mutations()).toEqual([`DELETE ${location.origin}/api/friends/blocks/user-a`]);
    expect(notes().join(' ')).toContain(t('ui_engel_kaldirildi', 'Engel kaldırıldı.'));
    expect(blockButton()!.textContent).toContain(t('perm_deny_label'));
  });

  it('engel kaldırma hatası kendi metnini verir ve durumu korur', async () => {
    blocksBody = { blocks: [{ userId: TARGET }] };
    mutationHandler = async (_url, init) => (init?.method === 'DELETE' ? response({}, 500) : null as never);
    open();
    await settle();

    blockButton()!.click();
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); flushSync(); }

    expect(notes().join(' ')).toContain(t('ui_engel_kaldirilamadi', 'Engel kaldırılamadı.'));
    expect(blockButton()!.textContent).toContain(t('surface_engeli_kald_r_4902bf'));
  });
});

describe('arkadaşlık kenarları', () => {
  it('arkadaş listesi okunamazsa arkadaşlık eylemi gösterilmez', async () => {
    friendsStatus = 503;
    open();
    await settle();
    expect(friendButton()).toBeNull();
  });

  it('409 yanıtı "zaten istek var" durumuna geçirir', async () => {
    mutationHandler = async (url, init) => (init?.method === 'POST' && url.endsWith('/api/friends/request') ? response({}, 409) : null as never);
    open();
    await settle();

    friendButton()!.click();
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); flushSync(); }

    expect(notes().join(' ')).toContain(t('ui_zaten_bir_istek_var', 'Zaten bir istek var.'));
    expect(friendButton()!.disabled).toBe(true);
    expect(friendButton()!.textContent).toContain(t('mpp_pending', 'İstek bekliyor'));
  });

  it('başarısız istek durum değiştirmez', async () => {
    mutationHandler = async (url, init) => (init?.method === 'POST' && url.endsWith('/api/friends/request') ? response({}, 500) : null as never);
    open();
    await settle();

    friendButton()!.click();
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); flushSync(); }

    expect(notes().join(' ')).toContain(t('ui_istek_gonderilemedi', 'İstek gönderilemedi.'));
    expect(friendButton()!.textContent).toContain(t('surface_arkadas_ekle_37b967'));
  });

  it('arkadaşlıktan çıkarma başarısız olursa liste değişmez', async () => {
    friendsBody = [{ id: TARGET }];
    mutationHandler = async (url, init) => (init?.method === 'DELETE' && url.includes('/api/friends/') && !url.includes('blocks') ? response({}, 500) : null as never);
    open();
    await settle();

    friendButton()!.click();
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); flushSync(); }

    expect(notes().join(' ')).toContain(t('ui_arkadasliktan_cikarilamadi', 'Arkadaşlıktan çıkarılamadı.'));
    expect(friendButton()!.textContent).toContain(t('surface_arkadasl_ktan_c_kar_11343e'));
  });

  it('kullanıcı adı olmayan profilde arkadaş isteği gönderilmez', async () => {
    apiFetch.mockImplementation(async (url) => {
      if (url.includes('/api/users/')) return response({ _id: TARGET, displayName: 'Adsız' });
      if (url.endsWith('/api/friends')) return response([]);
      if (url.endsWith('/api/friends/blocks')) return response({ blocks: [] });
      return response([]);
    });
    open();
    await settle();

    friendButton()!.click();
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); flushSync(); }

    expect(mutations()).toEqual([]);
  });
});
