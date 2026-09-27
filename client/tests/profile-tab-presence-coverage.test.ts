// client/tests/profile-tab-presence-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PROFİL SEKMESİ — GÖRÜNEN AD VE VARLIK DURUMU
// ════════════════════════════════════════════════════════════════════════════
//
// Varlık durumu ("çevrimdışı görün" dâhil) bir GİZLİLİK tercihidir; seçim
// yalnız sunucu ONAYLADIKTAN sonra kullanıcıya "uygulandı" gibi
// gösterilmelidir. Ölçülmemiş dalların taşıdığı riskler:
//
//   · İYİMSER SEÇİM — istemci seçimi ACK'ten önce işaretlerse kullanıcı
//     "çevrimdışı görünüyorum" sanır, oysa hâlâ çevrimiçidir. Bu, doğrudan
//     bir gizlilik yanlış beyanıdır.
//   · SESSİZ ZAMAN AŞIMI — ACK hiç gelmezse arayüz sonsuza dek "kaydediyor"
//     kalır ve kullanıcı bir daha durum değiştiremez.
//   · KOPUK SOKET — bağlantı yokken istek ağa hiç çıkmamalı, bunun yerine
//     anlaşılır bir hata gösterilmelidir.
//   · KİRLİ OLMAYAN KAYIT — değişmemiş adı kaydetmek boş bir yazma isteğidir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { t } from '../js/core/i18n/index.ts';

interface TestUser {
  _id: string;
  username: string;
  displayName?: string;
  status?: string;
  presenceStatus?: string;
}

let currentUser: TestUser | null = null;
const updatePanel = vi.fn();

vi.mock('../js/core/state', () => ({ getCurrentUser: () => currentUser }));
vi.mock('../js/core/auth-compat.ts', () => ({ updateUserPanel: (...args: unknown[]) => updatePanel(...args) }));

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import ProfileTab from '../js/core/settings/tabs/ProfileTab.svelte';

type Ack = { ok: boolean; status?: string; code?: string };
type Emitted = { event: string; payload: unknown };

function socket(handler: (payload: { status: string }, ack: (result: Ack) => void) => void, connected = true) {
  const emitted: Emitted[] = [];
  return {
    emitted,
    connected,
    emit(event: string, payload: { status: string }, ack: (result: Ack) => void) {
      emitted.push({ event, payload });
      handler(payload, ack);
    },
  };
}

function store(save: (patch: Record<string, unknown>) => Promise<boolean>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    save: async (patch: Record<string, unknown>) => { calls.push(patch); return save(patch); },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) { await tick(); await Promise.resolve(); }
}

const radios = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.presence-option')];
const radioFor = (label: string): HTMLButtonElement =>
  radios().find(button => button.textContent?.includes(label))!;
const selected = (): string | undefined => radios().find(button => button.getAttribute('aria-checked') === 'true')?.textContent ?? undefined;
const errorText = (): string => document.querySelector('.field-error')?.textContent ?? '';
const nameInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>('#display-name')!;
const saveButton = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.field-actions .btn')!;

const ONLINE = t('members_online', 'Çevrimiçi');
const IDLE = t('status_idle', 'Boşta');
const DND = t('status_dnd', 'Rahatsız etmeyin');
const INVISIBLE = t('ui_cevrimdisi_gorun', 'Çevrimdışı görün');

beforeEach(() => {
  currentUser = { _id: 'u-1', username: 'ada', displayName: 'Ada', presenceStatus: 'online' };
  updatePanel.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  BridgeRegistry.unregister('socket');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ProfileTab görünen ad', () => {
  it('değişmemiş ad kaydedilemez; değişince kaydedilir ve panel tazelenir', async () => {
    const settings = store(async () => true);
    render(ProfileTab, { props: { store: settings } });
    await flush();

    expect(saveButton()).toBeDisabled();
    saveButton().click();
    await flush();
    expect(settings.calls).toHaveLength(0);

    nameInput().value = 'Ada Lovelace';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(saveButton()).not.toBeDisabled();
    saveButton().click();
    await flush();

    expect(settings.calls).toEqual([{ displayName: 'Ada Lovelace' }]);
    expect(currentUser!.displayName).toBe('Ada Lovelace');
    expect(updatePanel).toHaveBeenCalledWith(currentUser);
    // Kaydedilen deger yeni temel olur: dugme yeniden kilitlenir.
    expect(saveButton()).toBeDisabled();
  });

  it('kayıt başarısız olursa yerel kimlik değiştirilmez ve yeniden denenebilir', async () => {
    const settings = store(async () => false);
    render(ProfileTab, { props: { store: settings } });
    await flush();

    nameInput().value = 'Yeni Ad';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    saveButton().click();
    await flush();

    expect(currentUser!.displayName).toBe('Ada');
    expect(updatePanel).not.toHaveBeenCalled();
    expect(saveButton()).not.toBeDisabled();
  });

  it('oturum kullanıcısı yokken kayıt yine çalışır ve panel tazelenmez', async () => {
    currentUser = null;
    const settings = store(async () => true);
    render(ProfileTab, { props: { store: settings } });
    await flush();

    nameInput().value = 'Anonim';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    saveButton().click();
    await flush();

    expect(settings.calls).toEqual([{ displayName: 'Anonim' }]);
    expect(updatePanel).not.toHaveBeenCalled();
  });
});

describe('ProfileTab varlık durumu', () => {
  it('kayıtlı durum seçili gelir; tanınmayan değer çevrimiçiye düşer', async () => {
    currentUser = { _id: 'u-1', username: 'ada', presenceStatus: 'dnd' };
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();
    expect(selected()).toContain(DND);
    cleanup();

    currentUser = { _id: 'u-1', username: 'ada', status: 'idle' };
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();
    expect(selected()).toContain(IDLE);
    cleanup();

    for (const bogus of ['invisible', '', 42, null, undefined]) {
      currentUser = { _id: 'u-1', username: 'ada', presenceStatus: bogus as unknown as string };
      render(ProfileTab, { props: { store: store(async () => true) } });
      await flush();
      expect(selected()).toContain(ONLINE);
      cleanup();
    }
  });

  it('onay gelene kadar seçim değişmez; onay gelince durum ve panel güncellenir', async () => {
    let release!: (result: Ack) => void;
    const io = socket((_payload, ack) => { release = ack; });
    BridgeRegistry.register('socket', io);
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(INVISIBLE).click();
    await flush();

    // ACK BEKLENIYOR: secim hala eski degerde; kullaniciya yanlis bir gizlilik
    // vaadi verilmez.
    expect(selected()).toContain(ONLINE);
    expect(radios().every(button => button.disabled)).toBe(true);
    expect(io.emitted).toEqual([{ event: 'status:update', payload: { status: 'offline' } }]);

    release({ ok: true, status: 'offline' });
    await flush();

    expect(selected()).toContain(INVISIBLE);
    expect(currentUser!.presenceStatus).toBe('offline');
    expect(currentUser!.status).toBe('offline');
    expect(updatePanel).toHaveBeenCalledWith(currentUser);
    expect(radios().every(button => !button.disabled)).toBe(true);
    expect(errorText()).toBe('');
  });

  it('sunucu farklı bir görünür durum bildirirse o durum yansıtılır', async () => {
    BridgeRegistry.register('socket', socket((_payload, ack) => ack({ ok: true })));
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(IDLE).click();
    await flush();

    // `status` alani yoksa secilen deger kullanilir.
    expect(currentUser!.status).toBe('idle');
    expect(currentUser!.presenceStatus).toBe('idle');
  });

  it('bağlantı yokken ağa çıkılmaz ve bağlantı hatası gösterilir', async () => {
    const offline = socket((_payload, ack) => ack({ ok: true }), false);
    BridgeRegistry.register('socket', offline);
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(DND).click();
    await flush();

    expect(offline.emitted).toHaveLength(0);
    expect(errorText()).toBe(t('ui_durum_degistirilemedi_baglantini_kontrol_edip_yenide', 'Durum değiştirilemedi. Bağlantını kontrol edip yeniden dene.'));
    expect(selected()).toContain(ONLINE);
  });

  it('kayıtlı soket hiç yokken de aynı bağlantı hatası verilir', async () => {
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(DND).click();
    await flush();

    expect(errorText()).toBe(t('ui_durum_degistirilemedi_baglantini_kontrol_edip_yenide', 'Durum değiştirilemedi. Bağlantını kontrol edip yeniden dene.'));
  });

  it('reddedilen durum ile genel hata ayrı metinler verir ve seçim taşınmaz', async () => {
    BridgeRegistry.register('socket', socket((_payload, ack) => ack({ ok: false, code: 'INVALID_STATUS' })));
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();
    radioFor(IDLE).click();
    await flush();
    expect(errorText()).toBe(t('ui_bu_durum_secenegi_kullanilamiyor', 'Bu durum seçeneği kullanılamıyor.'));
    expect(selected()).toContain(ONLINE);
    cleanup();
    BridgeRegistry.unregister('socket');

    BridgeRegistry.register('socket', socket((_payload, ack) => ack({ ok: false, code: 'RATE_LIMITED' })));
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();
    radioFor(IDLE).click();
    await flush();
    expect(errorText()).toBe(t('ui_durum_degistirilemedi_yeniden_dene', 'Durum değiştirilemedi. Yeniden dene.'));
    expect(currentUser!.presenceStatus).toBe('online');
  });

  it('nesne olmayan bir onay geçerli sayılmaz', async () => {
    BridgeRegistry.register('socket', socket((_payload, ack) => (ack as unknown as (v: unknown) => void)('tamam')));
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(IDLE).click();
    await flush();

    expect(errorText()).toBe(t('ui_durum_degistirilemedi_yeniden_dene', 'Durum değiştirilemedi. Yeniden dene.'));
    expect(selected()).toContain(ONLINE);
  });

  it('onay hiç gelmezse arayüz beş saniye sonra kilidini açar', async () => {
    vi.useFakeTimers();
    const silent = socket(() => { /* sunucu hiç yanıtlamıyor */ });
    BridgeRegistry.register('socket', silent);
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(IDLE).click();
    await flush();
    expect(radios().every(button => button.disabled)).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();

    expect(errorText()).toBe(t('ui_durum_degistirilemedi_yeniden_dene', 'Durum değiştirilemedi. Yeniden dene.'));
    expect(radios().every(button => !button.disabled)).toBe(true);
    expect(selected()).toContain(ONLINE);
  });

  it('geç gelen onay zaman aşımından sonra durumu değiştiremez', async () => {
    vi.useFakeTimers();
    let late!: (result: Ack) => void;
    BridgeRegistry.register('socket', socket((_payload, ack) => { late = ack; }));
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(IDLE).click();
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();

    late({ ok: true, status: 'idle' });
    await flush();

    // Eskimis onay sessizce yutulur; secim ve panel degismez.
    expect(selected()).toContain(ONLINE);
    expect(currentUser!.presenceStatus).toBe('online');
    expect(updatePanel).not.toHaveBeenCalled();
  });

  it('zaten seçili durum yeniden gönderilmez', async () => {
    const io = socket((_payload, ack) => ack({ ok: true }));
    BridgeRegistry.register('socket', io);
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(ONLINE).click();
    await flush();

    expect(io.emitted).toHaveLength(0);
  });

  it('bir istek uçarken ikinci seçim gönderilmez', async () => {
    const io = socket(() => { /* askıda */ });
    BridgeRegistry.register('socket', io);
    render(ProfileTab, { props: { store: store(async () => true) } });
    await flush();

    radioFor(IDLE).click();
    await flush();
    // Dugmeler devre disi; yine de programatik ikinci cagri korunmalidir.
    radios().forEach((button) => { button.disabled = false; });
    radioFor(DND).click();
    await flush();

    expect(io.emitted).toHaveLength(1);
  });
});
