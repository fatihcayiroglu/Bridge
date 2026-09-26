// client/tests/bot-marketplace-install-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BOT MARKETPLACE — KURULUM YETKİSİ, SUNUCU BAĞLAMI VE HATA YÜZEYİ
// ════════════════════════════════════════════════════════════════════════════
//
// `bot-marketplace-component.test.ts` katalog/arama/detay yüzeyini ölçer ve
// kurulumu "kullanılamaz" durumda bırakır. Kurulum yolu ise bir SUNUCU
// MUTASYONUDUR ve ölçülmemişti:
//
//   · YANLIŞ SUNUCU — kullanıcı marketplace açıkken sunucu değiştirebilir.
//     Kurulum isteği eski sunucuya giderse bot YANLIŞ topluluğa eklenir.
//   · YETKİ — yalnız sunucuyu yönetebilen kurabilir; yetki okuması geç
//     dönerse buton erken açılmamalıdır.
//   · ONAY — kaldırma yıkıcıdır ve ürün diyaloğuyla onaylanır; iptal edilirse
//     istek GİTMEZ.
//   · HATA METNİ — arka uç gövdesi HAM gösterilmez; katalog ve plugin
//     hataları ayrı ayrı raporlanır.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { t } from '../js/core/i18n/index.ts';

const {
  catalog, plugins, loadCatalogMock, fetchPluginsMock, injectStylesMock,
  fetchInstalledMock, grantsRef, installMock, uninstallMock, fetchPermsMock,
} = vi.hoisted(() => ({
  catalog: [] as Array<Record<string, unknown>>,
  plugins: [] as Array<Record<string, unknown>>,
  loadCatalogMock: vi.fn(async () => undefined),
  fetchPluginsMock: vi.fn(async () => undefined),
  injectStylesMock: vi.fn(),
  fetchInstalledMock: vi.fn(async () => new Set<string>()),
  grantsRef: { current: new Map<string, string[]>() },
  installMock: vi.fn(async () => undefined),
  uninstallMock: vi.fn(async () => undefined),
  fetchPermsMock: vi.fn(async () => 0),
}));

vi.mock('../js/core/bot-marketplace/bot-catalog.js', () => ({ getCatalog: () => catalog, loadCatalog: loadCatalogMock }));
vi.mock('../js/core/bot-marketplace/bot-api.js', () => ({
  fetchLoadedPlugins: fetchPluginsMock,
  getLoadedPlugins: () => plugins,
  fetchInstallState: async (...a: unknown[]) => ({ installed: await fetchInstalledMock(...a), grants: grantsRef.current }),
  installBotOnServer: (...a: unknown[]) => installMock(...a),
  BotConsentOutdatedError: class BotConsentOutdatedError extends Error {},
  uninstallBotFromServer: (...a: unknown[]) => uninstallMock(...a),
}));
vi.mock('../js/core/bot-marketplace/bot-styles.js', () => ({ injectStyles: injectStylesMock }));
vi.mock('../js/core/permissions/myPermissions.js', () => ({
  fetchMyPermissions: (...a: unknown[]) => fetchPermsMock(...a),
  hasPerm: (perms: number, flag: number) => (perms & flag) === flag,
  PERM_MANAGE_SERVER: 1 << 3,
}));
vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { closeProductDialog } from '../js/core/product-dialog.ts';
import BotMarketplace from '../js/core/bot-marketplace/BotMarketplace.svelte';
import { BotConsentOutdatedError } from '../js/core/bot-marketplace/bot-api.js';

const MANAGE_SERVER = 1 << 3;

function bot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mod', name: 'Mod Bot', category: 'moderation', tags: ['moderation'],
    description: 'moderasyon', longDescription: 'uzun', rating: 4.5, installs: 10,
    avatar: '🤖', author: 'Bridge', commands: [], featured: false, installable: true,
    ...over,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) { await tick(); await Promise.resolve(); }
}

async function answerDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await flush();
  const button = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
  if (!button) throw new Error(`ürün diyaloğu ${action} düğmesi yok`);
  button.click();
  await flush();
}

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.mp-card[data-bot-id]')];
const installButton = (botId = 'mod'): HTMLButtonElement =>
  cards().find(card => card.dataset.botId === botId)!.querySelector<HTMLButtonElement>('.mp-btn-inst')!;
const alertText = (): string => document.querySelector('[role="alert"]')?.textContent ?? '';

let currentServer: Record<string, unknown> | null;

beforeEach(() => {
  catalog.length = 0;
  plugins.length = 0;
  catalog.push(bot());
  currentServer = { _id: 'srv-1' };
  loadCatalogMock.mockClear().mockResolvedValue(undefined);
  fetchPluginsMock.mockClear().mockResolvedValue(undefined);
  fetchInstalledMock.mockClear().mockResolvedValue(new Set<string>());
  installMock.mockClear().mockResolvedValue(undefined);
  uninstallMock.mockClear().mockResolvedValue(undefined);
  fetchPermsMock.mockClear().mockResolvedValue(MANAGE_SERVER);
  grantsRef.current = new Map();
  BridgeRegistry.register('currentServer', () => currentServer);
  document.body.innerHTML = '';
});

afterEach(() => {
  closeProductDialog();
  cleanup();
  BridgeRegistry.unregister('currentServer');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('sunucu bağlamı çözümü', () => {
  it('kayıtlı sunucu yokken kurulum durumu sorgulanmaz', async () => {
    BridgeRegistry.unregister('currentServer');
    render(BotMarketplace);
    await flush();

    expect(fetchInstalledMock).not.toHaveBeenCalled();
    expect(fetchPermsMock).not.toHaveBeenCalled();
    expect(installButton().disabled).toBe(true);
  });

  it('sunucu kimliği `_id` veya `id` alanından okunur; ikisi de yoksa boş kalır', async () => {
    currentServer = { id: 'srv-alternatif' };
    render(BotMarketplace);
    await flush();
    expect(fetchInstalledMock).toHaveBeenCalledWith('srv-alternatif');
    cleanup();

    fetchInstalledMock.mockClear();
    currentServer = {};
    render(BotMarketplace);
    await flush();
    expect(fetchInstalledMock).not.toHaveBeenCalled();
  });

  it('sunucu çözümü çökerse marketplace çalışmaya devam eder', async () => {
    BridgeRegistry.register('currentServer', () => { throw new Error('registry down'); });
    render(BotMarketplace);
    await flush();

    expect(fetchInstalledMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Mod Bot');
  });

  it('kayıt null döndürürse boş sunucu kimliği kullanılır', async () => {
    currentServer = null;
    render(BotMarketplace);
    await flush();

    expect(fetchInstalledMock).not.toHaveBeenCalled();
    expect(installButton().disabled).toBe(true);
  });

  it('sunucu değişimi olayı kurulum durumunu sıfırlayıp yeniden yükler', async () => {
    fetchInstalledMock.mockResolvedValue(new Set(['mod']));
    render(BotMarketplace);
    await flush();
    expect(installButton().textContent).toContain(t('ui_kaldir'));

    currentServer = { _id: 'srv-2' };
    fetchInstalledMock.mockResolvedValue(new Set<string>());
    document.dispatchEvent(new Event('bridge:load-channels'));
    await flush();

    expect(fetchInstalledMock).toHaveBeenLastCalledWith('srv-2');
    expect(installButton().textContent).toContain('Kur');
  });

  it('yanıt gecikirken sunucu değişirse eski sunucunun durumu uygulanmaz', async () => {
    let release!: (value: Set<string>) => void;
    fetchInstalledMock.mockImplementationOnce(() => new Promise<Set<string>>((resolve) => { release = resolve; }));
    render(BotMarketplace);
    await tick();

    currentServer = { _id: 'srv-2' };
    release(new Set(['mod']));
    await flush();

    // Eski sunucunun kurulu bot listesi YENI sunucunun ekranina yazilmaz.
    expect(installButton().textContent).not.toContain(t('ui_kaldir'));
  });
});

describe('kurulum yetkisi', () => {
  it('sunucuyu yönetme yetkisi olmayan kurulum düğmesi göremez', async () => {
    fetchPermsMock.mockResolvedValue(0);
    render(BotMarketplace);
    await flush();

    const button = installButton();
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(t('surface_sunucuyu_yonetme_yetkisi_gerekli_3d2b95'));
    expect(button.textContent).toBe(t('market_install_unavailable'));
  });

  it('çalıştırılabilir olmayan katalog kaydı yetki olsa da kurulamaz', async () => {
    catalog.length = 0;
    catalog.push(bot({ installable: false }));
    render(BotMarketplace);
    await flush();

    const button = installButton();
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(t('surface_bu_katalog_kayd_henuz_cal_st_r_labilir_bir_b_8d7d9b'));
  });

  it('yetkili kullanıcı botu kurar ve durum tazelenir', async () => {
    render(BotMarketplace);
    await flush();

    fetchInstalledMock.mockResolvedValue(new Set(['mod']));
    installButton().click();
    await answerDialog('confirm');

    expect(installMock).toHaveBeenCalledWith('mod', 'srv-1', ['commands']);
    expect(uninstallMock).not.toHaveBeenCalled();
    expect(installButton().textContent).toContain(t('ui_kaldir'));
    expect(installButton().disabled).toBe(false);
  });
});

describe('kaldırma onayı', () => {
  it('onay iptal edilirse istek gitmez', async () => {
    fetchInstalledMock.mockResolvedValue(new Set(['mod']));
    render(BotMarketplace);
    await flush();

    installButton().click();
    await answerDialog('cancel');

    expect(uninstallMock).not.toHaveBeenCalled();
    expect(installButton().textContent).toContain(t('ui_kaldir'));
  });

  it('onaylanan kaldırma sunucuya gider ve durum tazelenir', async () => {
    fetchInstalledMock.mockResolvedValue(new Set(['mod']));
    render(BotMarketplace);
    await flush();

    installButton().click();
    fetchInstalledMock.mockResolvedValue(new Set<string>());
    await answerDialog('confirm');

    expect(uninstallMock).toHaveBeenCalledWith('mod', 'srv-1');
    expect(installButton().textContent).toContain('Kur');
  });
});

describe('hata yüzeyi', () => {
  it('kurulum hatası ham gövdeyi göstermez ve düğmeyi serbest bırakır', async () => {
    installMock.mockRejectedValue({ ok: false, status: 502, json: async () => ({ error: 'upstream bot registry 10.0.0.9' }) });
    render(BotMarketplace);
    await flush();

    installButton().click();
    await answerDialog('confirm');

    expect(alertText()).not.toContain('10.0.0.9');
    expect(alertText().length).toBeGreaterThan(0);
    expect(installButton().disabled).toBe(false);
  });

  it('kaldırma hatası kurulum hatasından farklı metin verir', async () => {
    fetchInstalledMock.mockResolvedValue(new Set(['mod']));
    // Siniflandirilamayan bir reddetme: yedek metin devreye girmelidir.
    uninstallMock.mockRejectedValue({ reason: 'uninstall refused by registry' });
    render(BotMarketplace);
    await flush();

    installButton().click();
    await answerDialog('confirm');

    expect(alertText()).toContain(t('ui_bot_kaldirilamadi', 'Bot kaldırılamadı.'));
    expect(alertText()).not.toContain('registry');
  });

  it('kurulum durumu okunamazsa ayrı bir uyarı gösterilir', async () => {
    fetchPermsMock.mockRejectedValue(new Error('perm store down'));
    render(BotMarketplace);
    await flush();

    expect(alertText()).toContain(t('ui_bot_kurulum_durumu_yuklenemedi', 'Bot kurulum durumu yüklenemedi.'));
  });

  it('katalog hatası öncelikli; plugin hatası yalnız katalog sağlamken gösterilir', async () => {
    loadCatalogMock.mockRejectedValue(new Error('catalog down'));
    fetchPluginsMock.mockRejectedValue(new Error('plugins down'));
    render(BotMarketplace);
    await flush();
    expect(alertText()).toContain(t('ui_bot_katalogu_yuklenemedi_tekrar_deneyebilirsin', 'Bot kataloğu yüklenemedi. Tekrar deneyebilirsin.'));
    cleanup();

    loadCatalogMock.mockResolvedValue(undefined);
    render(BotMarketplace);
    await flush();
    expect(alertText()).toContain(t('ui_plugin_listesi_yuklenemedi', 'Plugin listesi yüklenemedi.'));
  });

  it('yeniden dene düğmesi katalogu ve plugin listesini yeniden ister', async () => {
    loadCatalogMock.mockRejectedValueOnce(new Error('catalog down'));
    render(BotMarketplace);
    await flush();
    expect(alertText().length).toBeGreaterThan(0);

    document.querySelector<HTMLButtonElement>('[role="alert"] .mp-btn-detail')!.click();
    await flush();

    expect(loadCatalogMock).toHaveBeenCalledTimes(2);
    expect(alertText()).toBe('');
  });
});

describe('izin onayı ve güven sinyali (Final21 Faz 14)', () => {
  // Kurulum eskiden tek tıktı ve sunucu hiçbir izin kaydetmiyordu. Artık yönetici
  // botun ne yapabileceğini düz dille görür; istek yalnız GÖSTERİLEN kapsamları taşır.
  const dialogText = (): string => document.querySelector('.bridge-product-dialog-message')?.textContent ?? '';

  it('kurulum önce izinleri düz dille gösterir; iptal edilirse istek gitmez', async () => {
    catalog.length = 0;
    catalog.push(bot({ requestedScopes: ['commands', 'messages:reply'], author: 'Ayşe', authorVerified: false }));
    render(BotMarketplace);
    await flush();

    installButton().click();
    await flush();
    expect(document.querySelector('.bridge-product-dialog')?.textContent).toContain(t('bot_install_consent_title', undefined, { name: 'Mod Bot' }));
    expect(dialogText()).toContain(t('bot_perm_commands'));
    expect(dialogText()).toContain(t('bot_perm_messages_reply'));
    expect(dialogText()).toContain(t('bot_author_unverified'));
    expect(dialogText()).toContain('Ayşe');

    await answerDialog('cancel');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('onaylanan kurulum tam olarak gösterilen kapsamları gönderir', async () => {
    catalog.length = 0;
    catalog.push(bot({ requestedScopes: ['commands', 'messages:reply'] }));
    render(BotMarketplace);
    await flush();

    installButton().click();
    await answerDialog('confirm');
    expect(installMock).toHaveBeenCalledWith('mod', 'srv-1', ['commands', 'messages:reply']);
  });

  it('detay ekranı izinleri, desteklenmeyen beyanı ve geliştirici doğrulamasını gösterir', async () => {
    catalog.length = 0;
    catalog.push(
      bot({ id: 'mod', requestedScopes: ['commands'], unsupportedPermissions: ['members:ban'], authorVerified: false, installable: false }),
      bot({ id: 'trusted', name: 'Trusted Bot', requestedScopes: ['commands', 'messages:reply'], authorVerified: true }),
    );
    render(BotMarketplace);
    await flush();

    const openDetail = async (botId: string): Promise<HTMLElement> => {
      cards().find(card => card.dataset.botId === botId)!.querySelector<HTMLButtonElement>('.mp-btn-detail')!.click();
      await flush();
      return document.querySelector<HTMLElement>('.mp-det-panel')!;
    };

    let panel = await openDetail('mod');
    const unsupported = panel.querySelector('.mp-perm-unsupported');
    expect(unsupported?.textContent).toBe(t('bot_perm_unsupported', undefined, { name: 'members:ban' }));
    expect(panel.querySelector('.mp-perms-list')?.textContent).toContain(t('bot_perm_commands'));
    expect(panel.querySelector('.mp-trust')?.textContent).toContain(t('bot_author_unverified'));
    expect(panel.querySelector('.mp-trust')?.classList.contains('verified')).toBe(false);
    panel.querySelector<HTMLButtonElement>('.mp-det-cls')!.click();
    await flush();

    panel = await openDetail('trusted');
    expect(panel.querySelector('.mp-perms-list')?.textContent).toContain(t('bot_perm_messages_reply'));
    expect(panel.querySelector('.mp-perm-unsupported')).toBeNull();
    expect(panel.querySelector('.mp-trust')?.textContent).toContain(t('bot_author_verified'));
    expect(panel.querySelector('.mp-trust')?.classList.contains('verified')).toBe(true);
  });

  it('liste daha fazla kapsam istiyorsa kurulu bot yeniden onay ister; eşleşen izin normal kaldırmadır', async () => {
    catalog.length = 0;
    catalog.push(
      bot({ id: 'mod', requestedScopes: ['commands', 'messages:reply'] }),
      bot({ id: 'same', name: 'Same Bot', requestedScopes: ['messages:reply', 'commands'] }),
    );
    fetchInstalledMock.mockResolvedValue(new Set(['mod', 'same']));
    grantsRef.current = new Map([['mod', ['commands']], ['same', ['commands', 'messages:reply']]]);
    render(BotMarketplace);
    await flush();

    expect(installButton('mod').textContent).toBe(t('bot_review_new_permissions'));
    expect(installButton('same').textContent).toBe(t('ui_kaldir'));

    installButton('mod').click();
    await flush();
    expect(dialogText()).toContain(t('bot_perm_messages_reply'));
    grantsRef.current = new Map([['mod', ['commands', 'messages:reply']], ['same', ['commands', 'messages:reply']]]);
    await answerDialog('confirm');

    expect(installMock).toHaveBeenCalledWith('mod', 'srv-1', ['commands', 'messages:reply']);
    expect(uninstallMock).not.toHaveBeenCalled();
    expect(installButton('mod').textContent).toBe(t('ui_kaldir'));
  });

  it('izinler gösterildikten sonra değiştiyse katalog tazelenir ve açık bir uyarı çıkar', async () => {
    installMock.mockRejectedValue(new BotConsentOutdatedError());
    render(BotMarketplace);
    await flush();
    expect(loadCatalogMock).toHaveBeenCalledTimes(1);

    installButton().click();
    await answerDialog('confirm');

    expect(loadCatalogMock).toHaveBeenCalledTimes(2);
    expect(alertText()).toContain(t('bot_consent_outdated'));
    expect(installButton().disabled).toBe(false);
  });

  it('katalog hatasından sonra "Tekrar dene" yüklenen botları gerçekten çizer', async () => {
    // Katalog Svelte'in izleyemediği bir modül dizisinde tutuluyordu: yeniden deneme
    // katalogu indiriyor ama ızgara boş ("0 bot") kalıyordu.
    catalog.length = 0;
    loadCatalogMock.mockRejectedValueOnce(new Error('catalog down'));
    render(BotMarketplace, { props: { initialTab: 'all' } });
    await flush();
    expect(cards()).toHaveLength(0);

    loadCatalogMock.mockImplementationOnce(async () => { catalog.push(bot({ id: 'late', name: 'Late Bot' })); });
    document.querySelector<HTMLButtonElement>('[role="alert"] .mp-btn-detail')!.click();
    await flush();

    expect(cards().map(card => card.dataset.botId)).toEqual(['late']);
    expect(document.querySelector('.mp-badge')?.textContent).toBe(t('market_bot_count', undefined, { count: 1 }));
  });
});

describe('görsel ve klavye ayrıntıları', () => {
  it('geçersiz puan sıfır yıldıza düşer, geçerli puan yuvarlanır', async () => {
    catalog.length = 0;
    catalog.push(bot({ id: 'nan', rating: Number.NaN }), bot({ id: 'high', rating: 9 }), bot({ id: 'neg', rating: -3 }));
    render(BotMarketplace);
    await flush();

    const ratings = [...document.querySelectorAll('.mp-rating')].map(n => (n.textContent ?? '').trim());
    expect(ratings[0]).toContain('☆☆☆☆☆');
    expect(ratings[1]).toContain('★★★★★');
    expect(ratings[2]).toContain('☆☆☆☆☆');
  });

  it('bilinmeyen etiket rengi marka rengine düşer', async () => {
    catalog.length = 0;
    catalog.push(bot({ tags: ['bilinmeyen-etiket'] }));
    render(BotMarketplace);
    await flush();

    const tag = document.querySelector<HTMLElement>('.mp-tag')!;
    expect(tag.style.getPropertyValue('--tag-color')).toBe('var(--brand)');
  });

  it('sekme şeridi ok/Home/End tuşlarıyla dolaşılır, diğer tuşlar yutulmaz', async () => {
    render(BotMarketplace);
    await flush();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    const press = (index: number, key: string): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      tabs[index]!.dispatchEvent(event);
      return event;
    };

    expect(press(0, 'ArrowRight').defaultPrevented).toBe(true);
    await flush();
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');

    expect(press(1, 'ArrowLeft').defaultPrevented).toBe(true);
    await flush();
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');

    expect(press(0, 'End').defaultPrevented).toBe(true);
    await flush();
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');

    expect(press(2, 'Home').defaultPrevented).toBe(true);
    await flush();
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');

    // Ilgisiz tus sekme secimini DEGISTIRMEZ ve olayi yutmaz.
    expect(press(0, 'a').defaultPrevented).toBe(false);
    await flush();
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('plugin sekmesi boşken açık bir metin gösterir, dolu plugin açıklamasız da çizilir', async () => {
    render(BotMarketplace, { props: { initialTab: 'plugins' } });
    await flush();
    expect(document.body.textContent).toContain(t('markup_yuklu_plugin_yok_034cc98', 'Yuklu plugin yok'));
    cleanup();

    plugins.push({ id: 'p1', name: 'Zamanlayıcı' });
    render(BotMarketplace, { props: { initialTab: 'plugins' } });
    await flush();
    expect(document.body.textContent).toContain('Zamanlayıcı');
    expect(document.querySelector('.mp-card.installed .mp-card-desc')!.textContent).toBe('');
  });

  it('arka plana tıklamak kapatır, kartın içine tıklamak kapatmaz', async () => {
    const onClose = vi.fn();
    render(BotMarketplace, { props: { onClose } });
    await flush();

    document.querySelector<HTMLElement>('.mp-panel')!.click();
    expect(onClose).not.toHaveBeenCalled();

    document.getElementById('bot-marketplace-modal')!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
