// client/tests/moderation-tab.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// FAZ K+/2 — MODERASYON YÜZEYİ.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// Sunucu tarafı TAMDI ve izin korumalıydı (ban / kick / timeout / ban listesi),
// ama istemcide bu uçlara ULAŞAN TEK BİR YÜZEY YOKTU. `ModerationPanel.svelte`
// adında bir dosya vardı; 51 satırlık BOŞ bir kabuktu (sıfır API çağrısı) ve
// hiçbir giriş noktasından import edilmiyordu.
//
// ── BU PAKETİN ASIL İŞİ ───────────────────────────────────────────────────
// Yeni bir yönetim yüzeyi eklerken en kolay yapılan hata, istemci tarafı
// kontrolü YETKİ SINIRI sanmaktır. Buradaki testler iki yönü birden kilitler:
//   • yetkisi olmayana ölü kontrol GÖSTERİLMEZ (yanıltmama)
//   • sunucunun 403'ü İSTEMCİ TARAFINDAN EZİLMEZ (sınır arka uçtadır)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

const PERM_KICK    = 1 << 4;
const PERM_BAN     = 1 << 5;
const PERM_TIMEOUT = 1 << 7;
const PERM_ADMIN   = 1 << 30;

let myPerms = 0;
const registryMap: Record<string, unknown> = {};
let apiMock: ReturnType<typeof vi.fn>;
let currentServer: { _id?: string; id?: string } | null = { _id: 's1' };
let stillCurrent = true;
let permissionFailure: unknown = null;

vi.mock('../js/core/permissions/myPermissions.js', () => ({
  fetchMyPermissions: async () => {
    if (permissionFailure !== null) throw permissionFailure;
    return myPerms;
  },
  hasPerm: (perms: number, flag: number) =>
    (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
}));

vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: (...args: unknown[]) => apiMock(...args),
}));

vi.mock('../js/core/globals.js', () => ({ getAPI: () => '' }));

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    has:  (k: string) => k in registryMap,
    call: (k: string) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as () => unknown)() : v;
    },
    register: (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
    // Completed against the canonical BridgeRegistry surface (register /
    // unregister / call / get / has); a missing member throws before any
    // assertion runs.
    get: (k: string) => registryMap[k] ?? null,
  },
}));

vi.mock('../js/core/server-settings/stores/serverSettingsStore', () => ({
  getCurrentServerFromRegistry: () => currentServer,
  isStillCurrentServer: () => stillCurrent,
}));

import ModerationTab from '../js/core/server-settings/tabs/ModerationTab.svelte';

// ── Yardımcılar ────────────────────────────────────────────────────────────

const ok = (body: unknown = {}) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fail = (status: number, body: unknown = {}) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

function defaultApi(bans: unknown[] = []) {
  return vi.fn(async (url: string) =>
    String(url).includes('/bans') ? ok(bans) : ok());
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.mod-btn')];
const byText = (text: string) => buttons().find(b => b.textContent!.trim() === text);
const calls = (method: string) =>
  apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === method);

beforeEach(() => {
  for (const k of Object.keys(registryMap)) delete registryMap[k];
  document.body.innerHTML = '';
  myPerms = 0;
  currentServer = { _id: 's1' };
  stillCurrent = true;
  permissionFailure = null;
  apiMock = defaultApi();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ════════════════════════════════════════════════════════════════════════════
describe('görünürlük — yetkisiz kullanıcı', () => {
  it('YETKİSİZ kullanıcıya ÖLÜ KONTROL gösterilmez', async () => {
    myPerms = 0;
    render(ModerationTab);

    await waitFor(() => expect(document.querySelector('.mod-empty')).toBeTruthy());
    expect(buttons()).toHaveLength(0);
  });

  it('yetkisiz kullanıcıya NEDENİ ve nasıl alınacağı söylenir', async () => {
    myPerms = 0;
    render(ModerationTab);

    await waitFor(() => {
      const text = document.querySelector('.mod-empty')!.textContent!;
      expect(text).toContain('BAN_MEMBERS');
      expect(text).toContain('yetki');
    });
  });

  it('yetkisizken ban listesi bile İSTENMEZ', async () => {
    // Yetkisiz istek atmak 403 gürültüsü üretir ve hız sınırını yer.
    myPerms = 0;
    render(ModerationTab);

    await waitFor(() => expect(document.querySelector('.mod-empty')).toBeTruthy());
    expect(apiMock.mock.calls.filter(c => String(c[0]).includes('/bans'))).toHaveLength(0);
  });

  it('sunucu kimligi veya izin servisi yoksa yetki mesaji yerine gercek yukleme hatasini gosterir', async () => {
    currentServer = null;
    const first = render(ModerationTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('ssm_no_server')));
    expect(apiMock).not.toHaveBeenCalled();
    first.unmount();
    cleanup();

    currentServer = { _id: 's1' };
    permissionFailure = 'permission service unavailable';
    render(ModerationTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('Moderasyon verileri yüklenemedi'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('görünürlük — kısmi yetki', () => {
  it('YALNIZCA timeout yetkisi varsa yalnız susturma gösterilir', async () => {
    myPerms = PERM_TIMEOUT;
    render(ModerationTab);

    await waitFor(() => expect(buttons().length).toBeGreaterThan(0));
    expect(byText('5 dakika')).toBeTruthy();
    expect(byText('Yasakla')).toBeFalsy();
    expect(byText('Sunucudan çıkar')).toBeFalsy();
  });

  it('YALNIZCA kick yetkisi varsa yalnız çıkarma gösterilir', async () => {
    myPerms = PERM_KICK;
    render(ModerationTab);

    await waitFor(() => expect(byText('Sunucudan çıkar')).toBeTruthy());
    expect(byText('Yasakla')).toBeFalsy();
    expect(document.querySelector('.mod-bans')).toBeFalsy();
  });

  it('ban yetkisi ban listesini açar', async () => {
    myPerms = PERM_BAN;
    apiMock = defaultApi([{ userId: 'u9', displayName: 'Kötü Kullanıcı', reason: 'spam', bannedAt: 1 }]);
    render(ModerationTab);

    await waitFor(() => expect(document.body.textContent).toContain('Kötü Kullanıcı'));
    expect(document.body.textContent).toContain('spam');
  });

  it('ADMINISTRATOR tüm bitleri kapsar', async () => {
    myPerms = PERM_ADMIN;
    render(ModerationTab);

    await waitFor(() => {
      expect(byText('Yasakla')).toBeTruthy();
      expect(byText('Sunucudan çıkar')).toBeTruthy();
      expect(byText('5 dakika')).toBeTruthy();
    });
  });

  it('legacy sunucu id alanini ban listesi URL icin kacirir', async () => {
    currentServer = { id: 'legacy/id' };
    myPerms = PERM_BAN;
    render(ModerationTab);

    await waitFor(() => expect(apiMock.mock.calls.some(c => String(c[0]).includes('/servers/legacy%2Fid/bans'))).toBe(true));
  });

  it('ban listesinde 403 bos liste, diger hata ise acik hata olur', async () => {
    myPerms = PERM_BAN;
    apiMock = vi.fn(async () => fail(403));
    const first = render(ModerationTab);
    await waitFor(() => expect(document.body.textContent).toContain('yasaklı kimse yok'));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    first.unmount();
    cleanup();

    apiMock = vi.fn(async () => fail(502));
    render(ModerationTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_server')));
  });

  it('bozuk ban listesi ve bayat yanit guvenli bos listeye iner', async () => {
    myPerms = PERM_BAN;
    apiMock = vi.fn(async () => ok({ bans: [] }));
    const first = render(ModerationTab);
    await waitFor(() => expect(document.body.textContent).toContain('yasaklı kimse yok'));
    first.unmount();
    cleanup();

    apiMock = defaultApi([{ userId: 'u9', displayName: 'Bayat' }]);
    stillCurrent = false;
    render(ModerationTab);
    await waitFor(() => expect(document.body.textContent).toContain('yasaklı kimse yok'));
    expect(document.body.textContent).not.toContain('Bayat');
  });

  it('kanonik uye kaynagi bozuksa kimlik girdisine duser', async () => {
    myPerms = PERM_ADMIN;
    registryMap.getCurrentServerMembers = () => ({ members: [] });
    render(ModerationTab);

    await waitFor(() => expect(document.querySelector<HTMLInputElement>('.mod-field input')).toBeTruthy());
    expect(document.querySelector('.mod-field select')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('eylemler kanonik uçlara gider', () => {
  beforeEach(() => { myPerms = PERM_ADMIN; });

  async function selectTarget(id = 'u9') {
    await waitFor(() => expect(document.querySelector('.mod-field input, .mod-field select')).toBeTruthy());
    const field = document.querySelector<HTMLInputElement>('.mod-field input')!;
    await fireEvent.input(field, { target: { value: id } });
  }

  it('yasaklama POST /bans çağırır', async () => {
    render(ModerationTab);
    await selectTarget();
    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() => {
      const post = calls('POST').find(c => String(c[0]).endsWith('/bans'));
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ userId: 'u9' });
    });
  });

  it('gerekçe gönderilir (denetim günlüğü için)', async () => {
    render(ModerationTab);
    await selectTarget();
    const inputs = document.querySelectorAll<HTMLInputElement>('.mod-field input');
    await fireEvent.input(inputs[1]!, { target: { value: 'kurallara aykırı' } });
    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() => {
      const post = calls('POST').find(c => String(c[0]).endsWith('/bans'));
      expect(JSON.parse(String((post![1] as RequestInit).body)).reason).toBe('kurallara aykırı');
    });
  });

  it('çıkarma kanonik kick ucunu çağırır', async () => {
    render(ModerationTab);
    await selectTarget();
    await fireEvent.click(byText('Sunucudan çıkar')!);

    await waitFor(() =>
      expect(calls('POST').some(c => String(c[0]).includes('/members/u9/kick'))).toBe(true));
  });

  it('susturma süreyi MİLİSANİYE olarak gönderir', async () => {
    render(ModerationTab);
    await selectTarget();
    await fireEvent.click(byText('1 saat')!);

    await waitFor(() => {
      const post = calls('POST').find(c => String(c[0]).includes('/timeout'));
      expect(JSON.parse(String((post![1] as RequestInit).body)).durationMs).toBe(3_600_000);
    });
  });

  it('yasak kaldırma DELETE gönderir', async () => {
    apiMock = defaultApi([{ userId: 'u9', displayName: 'Kötü', bannedAt: 1 }]);
    render(ModerationTab);

    await waitFor(() => expect(byText('Yasağı kaldır')).toBeTruthy());
    await fireEvent.click(byText('Yasağı kaldır')!);

    await waitFor(() =>
      expect(calls('DELETE').some(c => String(c[0]).includes('/bans/u9'))).toBe(true));
  });

  it('basarili yasaklama alanlari temizler, bildirim gosterir ve listeyi yeniler', async () => {
    render(ModerationTab);
    await selectTarget('u9');
    const fields = document.querySelectorAll<HTMLInputElement>('.mod-field input');
    await fireEvent.input(fields[1]!, { target: { value: 'spam' } });
    const readsBefore = apiMock.mock.calls.filter(c => !(c[1] as RequestInit | undefined)?.method).length;

    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('yasaklandı'));
    await waitFor(() => expect(apiMock.mock.calls.filter(c => !(c[1] as RequestInit | undefined)?.method).length).toBeGreaterThan(readsBefore));
    const refreshedFields = document.querySelectorAll<HTMLInputElement>('.mod-field input');
    expect(refreshedFields[0]!.value).toBe('');
    expect(refreshedFields[1]!.value).toBe('');
  });

  it('basarili kick alanlari temizler ve durum bildirir', async () => {
    render(ModerationTab);
    await selectTarget('u9');
    const fields = document.querySelectorAll<HTMLInputElement>('.mod-field input');
    await fireEvent.input(fields[1]!, { target: { value: 'raid' } });

    await fireEvent.click(byText('Sunucudan çıkar')!);

    await waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('çıkarıldı'));
    expect(fields[0]!.value).toBe('');
    expect(fields[1]!.value).toBe('');
  });

  it('hedef seçilmeden eylem İSTEK ATMAZ', async () => {
    render(ModerationTab);
    await waitFor(() => expect(byText('Yasakla')).toBeTruthy());
    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    expect(calls('POST')).toHaveLength(0);
  });

  it('hedef olmadan kick ve timeout da istek atmaz', async () => {
    render(ModerationTab);
    await waitFor(() => expect(byText('Sunucudan çıkar')).toBeTruthy());

    await fireEvent.click(byText('Sunucudan çıkar')!);
    await fireEvent.click(byText('5 dakika')!);

    expect(calls('POST')).toHaveLength(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Kullanıcı seçin');
  });

  it('sunucu degistiyse tum mutasyonlari eski tenant icin reddeder', async () => {
    render(ModerationTab);
    await selectTarget('u9');
    stillCurrent = false;

    await fireEvent.click(byText('Sunucudan çıkar')!);

    expect(calls('POST')).toHaveLength(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Sunucu değişti');
  });

  it('kullanıcı kimliği URL için kaçılır', async () => {
    render(ModerationTab);
    await selectTarget('a/b');
    await fireEvent.click(byText('Sunucudan çıkar')!);

    await waitFor(() =>
      expect(calls('POST').some(c => String(c[0]).includes('/members/a%2Fb/kick'))).toBe(true));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sunucu SON SÖZÜ söyler', () => {
  beforeEach(() => { myPerms = PERM_ADMIN; });

  it('403 EZİLMEZ — kullanıcıya yetkisiz olduğu söylenir', async () => {
    // İstemci bitleri bayat olabilir (rol az önce alınmış olabilir).
    // Sınır arka uçtadır; istemci onu geçersiz kılmaz.
    apiMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? fail(403, { error: 'No permission' }) : ok([]));
    render(ModerationTab);

    await waitFor(() => expect(document.querySelector('.mod-field input')).toBeTruthy());
    await fireEvent.input(document.querySelector('.mod-field input')!, { target: { value: 'u9' } });
    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')!.textContent).toContain('yetkiniz yok'));
  });

  it('429 hız sınırı ayrı ayırt edilir', async () => {
    apiMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? fail(429) : ok([]));
    render(ModerationTab);

    await waitFor(() => expect(document.querySelector('.mod-field input')).toBeTruthy());
    await fireEvent.input(document.querySelector('.mod-field input')!, { target: { value: 'u9' } });
    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')!.textContent).toContain('hızlı'));
  });

  it('sunucunun hata GÖVDESİ SIZDIRILMADAN kanonik mesaj gösterilir', async () => {
    // Bu test eskiden sunucunun gövdesinin ekrana basılmasını bekliyordu.
    // api-error.ts güvenlik sözleşmesi bunu yasaklar; 400 kanonik metne
    // eşlenir ve gövde SIZMAZ.
    apiMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? fail(400, { error: 'Kendinizi banlayamazsınız' }) : ok([]));
    render(ModerationTab);

    await waitFor(() => expect(document.querySelector('.mod-field input')).toBeTruthy());
    await fireEvent.input(document.querySelector('.mod-field input')!, { target: { value: 'u9' } });
    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() => {
      const shown = document.querySelector('[role="alert"]')!.textContent ?? '';
      expect(shown).toContain(t('error_bad_request'));
      expect(shown).not.toContain('Kendinizi banlayamazsınız');
    });
  });

  it('okunamayan hata govdesi durum kodlu yedek mesaji kullanir', async () => {
    apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: false, status: 500, json: async () => { throw new Error('bad json'); } } as unknown as Response;
      }
      return ok([]);
    });
    render(ModerationTab);
    await waitFor(() => expect(document.querySelector('.mod-field input')).toBeTruthy());
    await fireEvent.input(document.querySelector('.mod-field input')!, { target: { value: 'u9' } });
    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_server')));
  });

  it('ağ hatası çökertmez', async () => {
    apiMock = vi.fn(async () => { throw new Error('offline'); });
    render(ModerationTab);

    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('erişilebilirlik ve boş durumlar', () => {
  it('yasaklı yoksa boş durum açıkça yazılır', async () => {
    myPerms = PERM_BAN;
    render(ModerationTab);

    await waitFor(() => expect(document.body.textContent).toContain('yasaklı kimse yok'));
  });

  it('üye listesi kanonik kaynaktan gelir', async () => {
    myPerms = PERM_ADMIN;
    registryMap.getCurrentServerMembers = () => [{ userId: 'u1', displayName: 'Ayşe' }];
    render(ModerationTab);

    await waitFor(() => {
      const select = document.querySelector<HTMLSelectElement>('.mod-field select');
      expect(select).toBeTruthy();
      expect(select!.textContent).toContain('Ayşe');
    });
  });

  it('uye ve ban adlari ile tarih/gerekce yedeklerini render eder', async () => {
    myPerms = PERM_ADMIN;
    registryMap.getCurrentServerMembers = () => [
      { _id: 'u-id', username: 'hesap' },
      { userId: 'u-only' },
      {},
    ];
    apiMock = defaultApi([
      { userId: 'b1', username: 'ban-user', reason: '', bannedAt: 0 },
      { userId: 'b2', reason: 'spam', bannedAt: Date.now() },
    ]);
    render(ModerationTab);

    await waitFor(() => expect(document.body.textContent).toContain('ban-user'));
    expect(document.body.textContent).toContain('b2');
    expect(document.body.textContent).toContain('spam');
    const select = document.querySelector<HTMLSelectElement>('.mod-field select')!;
    expect(select.textContent).toContain('hesap');
    expect(select.textContent).toContain('u-only');
    expect(select.textContent).toContain('Bilinmeyen kullanıcı');
    expect(document.querySelector('.mod-when')).not.toBeNull();
  });

  it('kimliksiz ban satirini silme istegine cevirmez', async () => {
    myPerms = PERM_BAN;
    apiMock = defaultApi([{ displayName: 'Bozuk kayıt' }]);
    render(ModerationTab);
    await waitFor(() => expect(byText('Yasağı kaldır')).toBeTruthy());

    await fireEvent.click(byText('Yasağı kaldır')!);

    expect(calls('DELETE')).toHaveLength(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('kimliği eksik');
  });

  it('basarisiz unban sonrasinda listeyi yenilemez', async () => {
    myPerms = PERM_BAN;
    apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return fail(403);
      return ok([{ userId: 'u9', displayName: 'Kötü' }]);
    });
    render(ModerationTab);
    await waitFor(() => expect(byText('Yasağı kaldır')).toBeTruthy());
    const readsBefore = apiMock.mock.calls.length;

    await fireEvent.click(byText('Yasağı kaldır')!);

    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('yetkiniz yok'));
    expect(apiMock.mock.calls).toHaveLength(readsBefore + 1);
  });

  it('gruplar ve bölümler adlandırılır', async () => {
    myPerms = PERM_ADMIN;
    render(ModerationTab);

    await waitFor(() => {
      expect(document.querySelector('[aria-labelledby="mod-action-title"]')).toBeTruthy();
      expect(document.querySelector('[role="group"]')!.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('işlem sırasında kontroller kilitlenir (çift gönderim yok)', async () => {
    myPerms = PERM_ADMIN;
    let release: (v: Response) => void = () => {};
    apiMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Promise<Response>(r => { release = r; }) : ok([]));
    render(ModerationTab);

    await waitFor(() => expect(document.querySelector('.mod-field input')).toBeTruthy());
    await fireEvent.input(document.querySelector('.mod-field input')!, { target: { value: 'u9' } });
    await fireEvent.click(byText('Yasakla')!);

    await waitFor(() => expect(byText('Yasakla')!.disabled).toBe(true));
    release(ok());
  });
});
