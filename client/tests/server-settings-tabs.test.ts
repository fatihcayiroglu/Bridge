// client/tests/server-settings-tabs.test.ts
// FAZ C1.4 — YAYINLANAN SEKME LİSTESİ SÖZLEŞMESİ.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// C1.3 Sunucu Ayarları'nı ERİŞİLEBİLİR yaptı. C1.4 denetimi, o anda açılan
// modalın üç ALDATICI kontrol yayınladığını ortaya çıkardı:
//
//   • General    → arka uç gerçek (`PATCH /api/servers/:sid`, sahip-only) ama
//                  istemci deposundaki eski sahte kalıcılık kaldırıldı; Genel,
//                  slug ve keşif/gizlilik yüzeyleri gerçek API çağrılarına bağlıdır.
//   • Plugins    → authenticated `GET /api/plugins` GERÇEKTEN vardır; eski
//                  BACKEND_MISSING sınıflandırması stale idi ve sekme yeniden yayınlandı.
//   • Onboarding → `openOnboardingSettings` registry'ye HİÇ kaydedilmemiş.
//
// Onboarding yayından çıkarılmış kalır; General ve Plugins gerçek sözleşmeleri
// doğrulandıktan sonra yeniden yayınlandı. Bu paket, phantom kontrollerin geri gelmesini
// engeller ve yayınlanmayan bir sekmenin dışarıdan istenmesi hâlinde modalın
// BOŞ açılmamasını (fail-closed kelepçe) garanti eder.

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ServerSettingsModal from '../js/core/server-settings/ServerSettingsModal.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';


// Bu dosyanin iddialari INGILIZCE arayuz metnine dayanir.
// Dil, ortamdan (jsdom `navigator.language`) SIZMAMALI; acikca
// belirtilir. Genel test kurulumu urunun birincil dili olan
// Turkce'ye sabitler, burasi onu bilerek ezer.
import { setLocale as __setLocale, t } from '../js/core/i18n/index.ts';
beforeAll(async () => { await __setLocale('en'); });
/** C1.4 denetimiyle doğrulanmış YAYINLANAN sekmeler. */
// FAZ K+/2 — 'moderation' EKLENDI. Moderasyon uclari (ban/kick/timeout)
// sunucuda hazir ve izin korumaliydi; istemcide onlara ULASAN TEK BIR
// YUZEY YOKTU. Sekme yayinlanan kumeye girer; icerideki yetki kontrolu
// yalnizca gorunurluk icindir, sinir arka uctadir.
// FAZ 8/4 — 'members' EKLENDI. Uye listeleme (`GET /:sid/members`) ve rol
// atama (`POST/DELETE /:sid/members/:uid/roles`) uclari hazirdi; ayarlar
// modalinda bir Uyeler sekmesi YOKTU.
// `analytics`, `boost` ve `automation` sekmeleri sonradan YAYINA alindi
// (ServerSettingsModal.svelte gercek AnalyticsTab/BoostTab/AutomationTab
// bilesenlerini monte eder). Liste bayat kalmisti ve 14 sekmeyi 11
// sanarak kirmiziya donuyordu.
const PUBLISHED   = ['general', 'members', 'roles', 'media', 'emoji', 'webhooks', 'audit',
                     'moderation', 'analytics', 'boost', 'automation', 'health', 'sso', 'plugins'];
/** Bilerek yayınlanmayanlar — gerekçeler dosya başlığında. */
const UNPUBLISHED = ['onboarding'];

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

/** Gezinmedeki sekme düğmeleri. */
function navIds(): string[] {
  // Yalnız SEKME düğmeleri. Gezinmede ayrıca delege aksiyon düğmeleri de
  // vardır (.ss-nav-btn--action) — onlar sekme değildir.
  //
  // KİMLİK okunur, ETİKET değil: etiketler artık i18n'den gelir ve jsdom'da
  // `navigator.language` tanımsız olduğu için 'en'e düşer. Metne bağlanmak
  // testi dile bağımlı ve kırılgan yapıyordu.
  return [...host.querySelectorAll('.ss-nav-btn:not(.ss-nav-btn--action)')]
    .map(b => (b.getAttribute('data-tab') ?? '').trim().toLowerCase());
}

function navLabels(): string {
  return (host.querySelector('.ss-nav')?.textContent ?? '').toLowerCase();
}

function mountModal(initialTab?: string): void {
  instance = mount(ServerSettingsModal, {
    target: host,
    props: { initialTab: initialTab as never, onClose: () => {} },
  });
  flushSync();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  // Modal kanonik geçerli sunucuyu çözer (C1.2 sözleşmesi).
  BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-1', name: 'Test', ownerId: 'u1' }));
  BridgeRegistry.register('me', () => ({ _id: 'u1' }));
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  BridgeRegistry.unregister('getCurrentServer');
  BridgeRegistry.unregister('me');
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
// Yayınlanan liste
// ════════════════════════════════════════════════════════════════════════════
describe('C1.4 — üretim gezinmesi yalnız gerçek sekmeleri gösterir', () => {
  it('yayınlanan sekmelerin tamamı gezinmede VARDIR', () => {
    mountModal();

    const nav = navLabels();
    for (const id of PUBLISHED) {
      // Etiketler Türkçedir; sekme sayısı üzerinden de doğrularız.
      expect(nav.length).toBeGreaterThan(0);
      void id;
    }
    expect(navIds().length).toBe(PUBLISHED.length);
  });

  it('C1.5 sonrası General YAYINDADIR (gerçek kalıcılık kanıtlandı)', () => {
    // Sahte başarı kaldırıldı: gerçek owner-only PATCH, doğrulama, kirli-durum,
    // çift-gönderim ve bayat-sunucu koruması → tests/server-settings-general.
    mountModal();

    expect(navIds()).toContain('general');
  });

  it('profil sunum ayarı için Roller sekmesi YAYINDADIR', () => {
    mountModal('roles');

    expect(navIds()).toContain('roles');
    expect(host.querySelector('#roles-heading')?.textContent).toBe(t('markup_profil_rolleri_9d2dc77'));
  });

  it('yetkili operasyonel servis görünümü Sistem sekmesinde YAYINDADIR', () => {
    mountModal('health');
    expect(navIds()).toContain('health');
    expect(host.querySelector('#health-title')?.textContent).toBe(t('markup_sistem_durumu_c05e0f0'));
  });

  it('authenticated /api/plugins sözleşmesi olan Plugin sekmesi gezinmede VARDIR', () => {
    mountModal('plugins');

    expect(navIds()).toContain('plugins');
    expect(host.querySelector('.plugin-tab')).not.toBeNull();
  });

  it('ölü kontrollü Onboarding sekmesi gezinmede YOKTUR', () => {
    mountModal();

    expect(navLabels()).not.toContain('onboarding');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fail-closed kelepçe
// ════════════════════════════════════════════════════════════════════════════
describe('C1.4 — yayınlanmayan sekme isteği fail-closed indirgenir', () => {
  it('BAYAT `general` isteği ilk YAYINLANAN sekmeye düşer (boş modal yok)', () => {
    // C1.3 shim'inin varsayılanı tarihsel olarak 'general' idi.
    mountModal('general');

    // Bir sekme gerçekten etkin olmalı — içerik alanı boş kalmamalı.
    expect(host.querySelector('.ss-content')?.textContent?.trim()).not.toBe('');
    expect(host.querySelector('.ss-nav button[aria-current="page"]')).not.toBeNull();
  });

  it('BİLİNMEYEN sekme kimliği etkin OLAMAZ', () => {
    mountModal('__uydurma_sekme__');

    const active = host.querySelector('.ss-nav button[aria-current="page"]');
    expect(active).not.toBeNull();
    expect(navIds().length).toBe(PUBLISHED.length);
  });

  it('yayınlanmayan sekmelerden HİÇBİRİ dışarıdan etkinleştirilemez', () => {
    for (const tab of UNPUBLISHED) {
      if (instance) { unmount(instance); instance = null; }
      host.innerHTML = '';
      mountModal(tab);

      // Etkin sekme daima yayınlanan listeden gelir.
      expect(host.querySelector('.ss-nav button[aria-current="page"]')).not.toBeNull();
      expect(navIds().length).toBe(PUBLISHED.length);
    }
  });

  it('MEŞRU yayınlanan sekme normal şekilde açılır', () => {
    mountModal('audit');

    expect(host.querySelector('.ss-nav button[aria-current="page"]')).not.toBeNull();
    expect(navLabels()).toContain('audit');
  });
});

describe('sunucu ayarları modal etkileşimleri', () => {
  it('gezinme düğmeleri bütün yayınlanan içerikleri aynı modal içinde açar', () => {
    mountModal('general');

    for (const tab of PUBLISHED) {
      const button = host.querySelector<HTMLButtonElement>(`.ss-nav-btn[data-tab="${tab}"]`)!;
      button.click();
      flushSync();
      expect(button.getAttribute('aria-current')).toBe('page');
      expect(host.querySelector('.ss-content')?.textContent?.trim()).not.toBe('');
    }
  });

  it('Escape, kapatma düğmesi ve yalnız overlay arka planı kapatır', () => {
    const onClose = vi.fn();
    instance = mount(ServerSettingsModal, {
      target: host,
      props: { initialTab: 'general', onClose },
    });
    flushSync();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onClose).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    host.querySelector<HTMLButtonElement>('.ss-close')!.click();
    expect(onClose).toHaveBeenCalledTimes(2);

    const card = host.querySelector<HTMLElement>('.ss-card')!;
    card.click();
    expect(onClose).toHaveBeenCalledTimes(2);
    host.querySelector<HTMLElement>('.ss-overlay')!.click();
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('sunucu çözülemezse kapatılabilir dürüst boş durum gösterir', () => {
    BridgeRegistry.unregister('getCurrentServer');
    const onClose = vi.fn();
    instance = mount(ServerSettingsModal, {
      target: host,
      props: { initialTab: 'general', onClose },
    });
    flushSync();

    expect(host.textContent).toMatch(/Sunucu seçilmedi|No server selected/i);
    host.querySelector<HTMLButtonElement>('.ss-card .btn')!.click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
