// client/tests/automation-tab-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AutomationTab — YETKİ AYRIMI, SUNUCU DEĞİŞİMİ VE ONAYLI SİLME
// ════════════════════════════════════════════════════════════════════════════
//
// Bu sekme ÜÇ ayrı otomasyon alanını yönetir (AutoMod, reaction role, giden
// webhook) ve her biri FARKLI bir yetkiye bağlıdır. Hiç ölçülmemiş 150 dalın
// taşıdığı riskler:
//
//   · YETKİ KARIŞMASI — MANAGE_ROLES olan biri webhook yönetememeli,
//     MANAGE_SERVER olan biri reaction role kuralı yazamamalıdır.
//   · SUNUCU DEĞİŞİMİ — kullanıcı sekme açıkken sunucu değiştirirse, sonraki
//     istek ESKİ sunucuya yazmamalıdır; bağlam her mutasyondan önce doğrulanır.
//   · SESSİZ SİLME — silme işlemleri ürün diyaloğuyla onaylanır; iptal
//     edildiğinde istek GİTMEZ.
//   · GİZLİLİK — sunucu hata gövdesi kullanıcıya HAM gösterilmez.
//   · KISMİ YÜKLEME — bir liste reddedilirse diğerleri boş kalmaz; reddedilen
//     liste BOŞ kabul edilir ve panel çalışmaya devam eder.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { t } from '../js/core/i18n/index.ts';

const PERM_MANAGE_ROLES = 1 << 2;
const PERM_MANAGE_SERVER = 1 << 3;
const PERM_ADMIN = 1 << 30;

let myPerms = 0;
let permissionFailure: unknown = null;
let apiMock: ReturnType<typeof vi.fn>;
let currentServer: { _id?: string; id?: string } | null = { _id: 'srv-1' };
let stillCurrent = true;
const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/permissions/myPermissions.js', () => ({
  fetchMyPermissions: async () => {
    if (permissionFailure !== null) throw permissionFailure;
    return myPerms;
  },
  hasPerm: (perms: number, flag: number) => (perms & PERM_ADMIN) !== 0 || (perms & flag) !== 0,
  PERM_MANAGE_ROLES: 1 << 2,
  PERM_MANAGE_SERVER: 1 << 3,
}));
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => apiMock(...args) }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => '' }));
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    has: (k: string) => k in registryMap,
    call: (k: string) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as () => unknown)() : v;
    },
    register: (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
    get: (k: string) => registryMap[k] ?? null,
  },
}));
vi.mock('../js/core/server-settings/stores/serverSettingsStore', () => ({
  getCurrentServerFromRegistry: () => currentServer,
  isStillCurrentServer: () => stillCurrent,
}));

import AutomationTab from '../js/core/server-settings/tabs/AutomationTab.svelte';

const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fail = (status: number, body: unknown = {}) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

const ROLES = [{ _id: 'role-1', name: 'Moderatör' }];
const AUTOMOD = [{ _id: 'am-1', type: 'link_filter', enabled: true }];
const REACTION = [{ _id: 'rr-1', channelId: 'ch-1', messageId: 'm-1', emoji: '👍', roleId: 'role-1' }];
const HOOKS = [{ _id: 'hk-1', name: 'CI', url: 'https://ci.test', events: ['message:new'], enabled: true, lastStatus: 200, consecutiveFailures: 0 }];

function defaultApi(over: Partial<Record<'roles' | 'automod' | 'hooks' | 'reaction', Response>> = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes('/roles')) return over.roles ?? ok(ROLES);
    if (url.includes('/automod')) return over.automod ?? ok(AUTOMOD);
    if (url.includes('/outgoing-webhooks')) return over.hooks ?? ok(HOOKS);
    if (url.includes('/reaction-roles')) return over.reaction ?? ok(REACTION);
    return ok({});
  });
}

async function flush(): Promise<void> {
  // Bir mutasyon ZİNCİRİ birden çok istek uçurur (mutasyon → yeniden yükleme →
  // roller → automod/webhook → reaction-role). Az sayıda tur, zincir bitmeden
  // ölçüm yapıp yanlış "boş" sonuç verirdi.
  for (let i = 0; i < 14; i += 1) { await tick(); await Promise.resolve(); }
}

async function chooseProductDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await flush();
  const button = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
  if (!button) throw new Error(`ürün diyaloğu ${action} düğmesi yok`);
  button.click();
  await flush();
}

const articles = () => [...document.querySelectorAll('.automation article')];
const errorText = () => document.querySelector('.state.error')?.textContent ?? '';
const noticeText = () => document.querySelector('.state.success')?.textContent ?? '';
const itemsIn = (index: number) => [...articles()[index]!.querySelectorAll('.item')];

async function mount() {
  const view = render(AutomationTab);
  await waitFor(() => expect(document.querySelector('.state[aria-live]')).toBeNull());
  await flush();
  return view;
}

beforeEach(() => {
  myPerms = PERM_MANAGE_SERVER | PERM_MANAGE_ROLES;
  permissionFailure = null;
  currentServer = { _id: 'srv-1' };
  stillCurrent = true;
  apiMock = defaultApi();
  for (const key of Object.keys(registryMap)) delete registryMap[key];
  registryMap.getCurrentServerChannels = () => [
    { _id: 'ch-1', name: 'genel', type: 'text' },
    { _id: 'ch-2', name: 'duyuru', type: 'announcement' },
    { _id: 'v-1', name: 'ses', type: 'voice' },
  ];
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('AutomationTab — yükleme ve bağlam', () => {
  it('sunucu bağlamı yoksa istek GİTMEZ ve neden söylenir', async () => {
    currentServer = null;
    await mount();

    expect(apiMock).not.toHaveBeenCalled();
    expect(errorText()).toBe(t('ui_sunucu_degisti_otomasyon_verileri_yeniden_yuklenmeli'));
  });

  it('sunucu ARADA değiştiyse veri yüklenmez', async () => {
    stillCurrent = false;
    await mount();

    expect(apiMock).not.toHaveBeenCalled();
    expect(errorText()).toBe(t('ui_sunucu_degisti_otomasyon_verileri_yeniden_yuklenmeli'));
  });

  it('eski `id` alanlı sunucu kaydı da tanınır', async () => {
    currentServer = { id: 'srv-eski' };
    await mount();

    expect(String(apiMock.mock.calls[0]![0])).toContain('/api/servers/srv-eski/roles');
  });

  it('sunucu kimliği URL için KAÇIRILIR', async () => {
    currentServer = { _id: 'srv/slash' };
    await mount();

    expect(String(apiMock.mock.calls[0]![0])).toContain('/api/servers/srv%2Fslash/roles');
  });

  it('tüm listeler yüklenir ve sesli kanallar reaction-role seçeneğine GİRMEZ', async () => {
    await mount();

    expect(itemsIn(0)).toHaveLength(1);
    expect(itemsIn(1)).toHaveLength(1);
    expect(itemsIn(2)).toHaveLength(1);

    const channelOptions = [...articles()[1]!.querySelectorAll('select')[0]!.options].map(o => o.value);
    expect(channelOptions).toEqual(['ch-1', 'ch-2']);
  });

  it('kanal sahibi liste döndürmezse seçenek üretilmez', async () => {
    registryMap.getCurrentServerChannels = () => null;
    await mount();

    expect(articles()[1]!.querySelectorAll('select')[0]!.options).toHaveLength(0);
  });

  it.each([
    ['roller', 'roles'],
    ['automod', 'automod'],
    ['webhook', 'hooks'],
    ['reaction role', 'reaction'],
  ])('%s listesi reddedilirse diğerleri çalışmaya DEVAM eder', async (_label, key) => {
    apiMock = defaultApi({ [key]: fail(403) } as Partial<Record<'roles' | 'automod' | 'hooks' | 'reaction', Response>>);
    await mount();

    expect(document.querySelector('.automation')).not.toBeNull();
    expect(errorText()).toBe('');
  });

  it('yetki çözümü PATLARSA ham hata sızmaz', async () => {
    permissionFailure = new Error('GIZLI-SUNUCU-AYRINTISI');
    await mount();

    expect(errorText()).toBe(t('ui_otomasyon_ayarlari_yuklenemedi'));
    expect(errorText()).not.toContain('GIZLI-SUNUCU-AYRINTISI');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('AutomationTab — yetki ayrımı', () => {
  it('MANAGE_SERVER yoksa AutoMod ve webhook formları gizlenir', async () => {
    myPerms = PERM_MANAGE_ROLES;
    await mount();

    expect(articles()[0]!.querySelector('.form')).toBeNull();
    expect(articles()[2]!.querySelector('.form')).toBeNull();
    expect(articles()[1]!.querySelector('.form')).not.toBeNull();
    expect(apiMock.mock.calls.some(call => String(call[0]).includes('/automod'))).toBe(false);
  });

  it('MANAGE_ROLES yoksa reaction role formu gizlenir', async () => {
    myPerms = PERM_MANAGE_SERVER;
    await mount();

    expect(articles()[1]!.querySelector('.form')).toBeNull();
    expect(articles()[0]!.querySelector('.form')).not.toBeNull();
  });

  it('ADMIN her iki alanı da açar', async () => {
    myPerms = PERM_ADMIN;
    await mount();

    expect(articles()[0]!.querySelector('.form')).not.toBeNull();
    expect(articles()[1]!.querySelector('.form')).not.toBeNull();
    expect(articles()[2]!.querySelector('.form')).not.toBeNull();
  });

  it('hiç yetki yoksa üç alan da yalnız açıklama gösterir', async () => {
    myPerms = 0;
    await mount();

    expect(document.querySelectorAll('.form')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('AutomationTab — AutoMod', () => {
  const ruleSelect = () => articles()[0]!.querySelector<HTMLSelectElement>('select')!;
  const addButton = () => articles()[0]!.querySelector<HTMLButtonElement>('.form button')!;

  it('YASAKLI KELİME kuralı boş listeyle oluşturulamaz', async () => {
    await mount();
    await fireEvent.change(ruleSelect(), { target: { value: 'blocked_words' } });
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_en_az_bir_yasakli_kelime_girin'));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('yalnız boşluktan ibaret kelimeler de reddedilir', async () => {
    await mount();
    await fireEvent.change(ruleSelect(), { target: { value: 'blocked_words' } });
    await flush();
    const input = articles()[0]!.querySelector<HTMLInputElement>('.form input')!;
    await fireEvent.input(input, { target: { value: '  ,  , ' } });
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_en_az_bir_yasakli_kelime_girin'));
  });

  it('yasaklı kelimeler KIRPILIR ve boşlar süzülür', async () => {
    await mount();
    await fireEvent.change(ruleSelect(), { target: { value: 'blocked_words' } });
    await flush();
    await fireEvent.input(articles()[0]!.querySelector<HTMLInputElement>('.form input')!, {
      target: { value: ' küfür , , spam ' },
    });
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    const post = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { type: string; config: { words: string[] } };
    expect(body.type).toBe('blocked_words');
    expect(body.config.words).toEqual(['küfür', 'spam']);
    expect(noticeText()).toBe(t('ui_automod_kurali_olusturuldu'));
  });

  it('kelime gerektirmeyen kural doğrudan oluşturulur', async () => {
    await mount();
    apiMock.mockClear();

    addButton().click();
    await flush();

    const post = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { type: string; config: Record<string, unknown> };
    expect(body.type).toBe('link_filter');
    expect(body.config).not.toHaveProperty('words');
  });

  it('oluşturma reddedilirse HAM gövde gösterilmez', async () => {
    await mount();
    apiMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (init?.method === 'POST' ? fail(403, { error: 'GIZLI-SUNUCU-AYRINTISI' }) : ok([])));

    addButton().click();
    await flush();

    expect(errorText()).not.toBe('');
    expect(errorText()).not.toContain('GIZLI-SUNUCU-AYRINTISI');
    expect(noticeText()).toBe('');
  });

  it('SUNUCU DEĞİŞTİYSE mutasyon gönderilmez', async () => {
    await mount();
    apiMock.mockClear();
    stillCurrent = false;

    addButton().click();
    await flush();

    expect(apiMock).not.toHaveBeenCalled();
    expect(errorText()).toBe(t('ui_sunucu_degisti_otomasyon_verileri_yeniden_yuklenmeli'));
  });

  it('kural açma/kapama karşıt durumu gönderir', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(0)[0]!.querySelectorAll<HTMLButtonElement>('button')[0]!.click();
    await flush();

    const patch = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(String(patch[0])).toContain('/automod/am-1');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ enabled: false });
    expect(noticeText()).toBe(t('ui_automod_kurali_guncellendi'));
  });

  it('kapalı kural yeniden AÇILIR', async () => {
    apiMock = defaultApi({ automod: ok([{ _id: 'am-1', type: 'link_filter', enabled: false }]) });
    await mount();
    apiMock.mockClear();

    itemsIn(0)[0]!.querySelectorAll<HTMLButtonElement>('button')[0]!.click();
    await flush();

    const patch = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ enabled: true });
  });

  it('silme ONAYLANMAZSA istek gitmez', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(0)[0]!.querySelector<HTMLButtonElement>('.danger')!.click();
    await chooseProductDialog('cancel');

    expect(apiMock).not.toHaveBeenCalled();
  });

  it('silme onaylanırsa DELETE gider', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(0)[0]!.querySelector<HTMLButtonElement>('.danger')!.click();
    await chooseProductDialog('confirm');

    const del = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(String(del[0])).toContain('/automod/am-1');
    expect(noticeText()).toBe(t('ui_automod_kurali_silindi'));
  });

  it('bilinmeyen kural türü HAM kimliğiyle listelenir', async () => {
    apiMock = defaultApi({ automod: ok([{ _id: 'am-9', type: 'bilinmeyen_tur', enabled: true }]) });
    await mount();

    expect(itemsIn(0)[0]!.querySelector('strong')?.textContent).toBe('bilinmeyen_tur');
  });

  it('kural yoksa boş durum gösterilir', async () => {
    apiMock = defaultApi({ automod: ok([]) });
    await mount();

    expect(articles()[0]!.querySelector('.list .state')?.textContent).toBe(t('automation_no_automod'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('AutomationTab — reaction role', () => {
  const inputs = () => [...articles()[1]!.querySelectorAll<HTMLInputElement>('.form input')];
  const addButton = () => articles()[1]!.querySelector<HTMLButtonElement>('.form button')!;

  it.each([
    ['mesaj kimliği', 0],
    ['emoji', 1],
  ])('%s boşsa kural oluşturulmaz', async (_label, keepIndex) => {
    await mount();
    for (const [index, input] of inputs().entries()) {
      await fireEvent.input(input, { target: { value: index === keepIndex ? 'dolu' : '   ' } });
    }
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_kanal_mesaj_kimligi_emoji_ve_rol_zorunlu'));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('kanal seçeneği yoksa kural oluşturulmaz', async () => {
    registryMap.getCurrentServerChannels = () => [];
    await mount();
    for (const input of inputs()) await fireEvent.input(input, { target: { value: 'x' } });
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_kanal_mesaj_kimligi_emoji_ve_rol_zorunlu'));
  });

  it('rol seçeneği yoksa kural oluşturulmaz', async () => {
    apiMock = defaultApi({ roles: ok([]) });
    await mount();
    for (const input of inputs()) await fireEvent.input(input, { target: { value: 'x' } });
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_kanal_mesaj_kimligi_emoji_ve_rol_zorunlu'));
  });

  it('geçerli kural KIRPILMIŞ değerlerle oluşturulur ve form kısmen sıfırlanır', async () => {
    await mount();
    await fireEvent.input(inputs()[0]!, { target: { value: '  m-42  ' } });
    await fireEvent.input(inputs()[1]!, { target: { value: '  🎉  ' } });
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    const post = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      channelId: 'ch-1', messageId: 'm-42', emoji: '🎉', roleId: 'role-1',
    });
    await waitFor(() => expect(inputs()[0]!.value).toBe(''));
    expect(noticeText()).toBe(t('ui_reaction_role_olusturuldu'));
  });

  it('silme onayı iptal edilirse istek gitmez', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(1)[0]!.querySelector<HTMLButtonElement>('.danger')!.click();
    await chooseProductDialog('cancel');

    expect(apiMock).not.toHaveBeenCalled();
  });

  it('silme onaylanırsa DELETE gider', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(1)[0]!.querySelector<HTMLButtonElement>('.danger')!.click();
    await chooseProductDialog('confirm');

    const del = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(String(del[0])).toContain('/reaction-roles/rr-1');
  });

  it('emoji/rol eksik satırlar yine de okunur biçimde listelenir', async () => {
    apiMock = defaultApi({ reaction: ok([{ _id: 'rr-9' }]) });
    await mount();

    expect(itemsIn(1)[0]!.querySelector('strong')?.textContent).toBe('?');
    expect(itemsIn(1)[0]!.textContent).not.toContain('undefined');
  });

  it('kural yoksa boş durum gösterilir', async () => {
    apiMock = defaultApi({ reaction: ok([]) });
    await mount();

    expect(articles()[1]!.querySelector('.list .state')?.textContent).toBe(t('automation_no_reaction_role'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('AutomationTab — giden webhooklar', () => {
  const inputs = () => [...articles()[2]!.querySelectorAll<HTMLInputElement>('.form .grid input')];
  const eventBoxes = () => [...articles()[2]!.querySelectorAll<HTMLInputElement>('.events input')];
  const addButton = () => articles()[2]!.querySelector<HTMLButtonElement>('.form > button')!;

  it.each([
    ['ad', 0],
    ['URL', 1],
  ])('%s boşsa webhook oluşturulmaz', async (_label, emptyIndex) => {
    await mount();
    for (const [index, input] of inputs().entries()) {
      await fireEvent.input(input, { target: { value: index === emptyIndex ? '  ' : 'dolu' } });
    }
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_webhook_adi_url_ve_en_az_bir_event_zorunlu'));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('hiç event seçilmemişse webhook oluşturulmaz', async () => {
    await mount();
    await fireEvent.input(inputs()[0]!, { target: { value: 'CI' } });
    await fireEvent.input(inputs()[1]!, { target: { value: 'https://ci.test' } });
    await fireEvent.change(eventBoxes()[0]!);   // varsayılan tek seçim kaldırılır
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_webhook_adi_url_ve_en_az_bir_event_zorunlu'));
  });

  it('event seçimi eklenip çıkarılabilir ve gövdeye yansır', async () => {
    await mount();
    await fireEvent.input(inputs()[0]!, { target: { value: '  CI  ' } });
    await fireEvent.input(inputs()[1]!, { target: { value: '  https://ci.test  ' } });
    await fireEvent.change(eventBoxes()[2]!);
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    const post = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { name: string; url: string; events: string[]; secret: string | null };
    expect(body.name).toBe('CI');
    expect(body.url).toBe('https://ci.test');
    expect(body.events).toEqual(['message:new', 'member:join']);
    expect(body.secret).toBeNull();
  });

  it('gizli anahtar KIRPILIR ve gövdeye eklenir', async () => {
    await mount();
    await fireEvent.input(inputs()[0]!, { target: { value: 'CI' } });
    await fireEvent.input(inputs()[1]!, { target: { value: 'https://ci.test' } });
    await fireEvent.input(inputs()[2]!, { target: { value: '  s3cret  ' } });
    await flush();
    apiMock.mockClear();

    addButton().click();
    await flush();

    const post = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body)).secret).toBe('s3cret');
    await waitFor(() => expect(inputs()[2]!.value).toBe(''));
  });

  it('webhook açma/kapama karşıt durumu gönderir', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(2)[0]!.querySelectorAll<HTMLButtonElement>('.actions button')[1]!.click();
    await flush();

    const patch = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ enabled: false });
    expect(noticeText()).toBe(t('ui_webhook_guncellendi'));
  });

  it('TEST isteği gönderilir ve sonucu bildirilir', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(2)[0]!.querySelectorAll<HTMLButtonElement>('.actions button')[0]!.click();
    await flush();

    expect(apiMock.mock.calls.some(call => String(call[0]).includes('/outgoing-webhooks/hk-1/test'))).toBe(true);
    expect(noticeText()).toBe(t('ui_webhook_test_istegi_tamamlandi'));
  });

  it('TEST başarısızsa BAŞARI bildirimi verilmez', async () => {
    await mount();
    apiMock.mockImplementation(async (url: string) => (url.includes('/test') ? fail(502) : ok([])));

    itemsIn(2)[0]!.querySelectorAll<HTMLButtonElement>('.actions button')[0]!.click();
    await flush();

    expect(noticeText()).toBe('');
    expect(errorText()).not.toBe('');
  });

  it('silme onayı iptal edilirse istek gitmez', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(2)[0]!.querySelector<HTMLButtonElement>('.danger')!.click();
    await chooseProductDialog('cancel');

    expect(apiMock).not.toHaveBeenCalled();
  });

  it('silme onaylanırsa DELETE gider', async () => {
    await mount();
    apiMock.mockClear();

    itemsIn(2)[0]!.querySelector<HTMLButtonElement>('.danger')!.click();
    await chooseProductDialog('confirm');

    const del = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(String(del[0])).toContain('/outgoing-webhooks/hk-1');
  });

  it('adı olmayan webhook güvenli bir adla listelenir', async () => {
    apiMock = defaultApi({ hooks: ok([{ _id: 'hk-9', enabled: false }]) });
    await mount();

    expect(itemsIn(2)[0]!.querySelector('strong')?.textContent).toBe('Webhook');
    expect(itemsIn(2)[0]!.textContent).not.toContain('undefined');
  });

  it('webhook yoksa boş durum gösterilir', async () => {
    apiMock = defaultApi({ hooks: ok([]) });
    await mount();

    expect(articles()[2]!.querySelector('.list .state')?.textContent).toBe('Giden webhook yok.');
  });

  it('bir mutasyon SÜRERKEN ikincisi başlatılamaz', async () => {
    await mount();
    let release: (value: Response) => void = () => {};
    apiMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Promise<Response>(resolve => { release = resolve; });
      return Promise.resolve(ok([]));
    });

    const toggle = itemsIn(2)[0]!.querySelectorAll<HTMLButtonElement>('.actions button')[1]!;
    toggle.click();
    await flush();
    const patchCalls = () => apiMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'PATCH').length;
    expect(patchCalls()).toBe(1);

    toggle.click();
    await flush();
    expect(patchCalls()).toBe(1);

    release(ok({}));
    await flush();
  });
});
