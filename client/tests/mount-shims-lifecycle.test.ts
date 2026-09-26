// client/tests/mount-shims-lifecycle.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MOUNT KÖPRÜLERİ — TEK SAHİP, KABUK TERCİHİ VE SIZINTISIZ SÖKÜM
// ════════════════════════════════════════════════════════════════════════════
//
// `js/core/*-svelte.ts` dosyaları Svelte bileşenlerini mevcut HTML kabuğuna
// bağlayan köprülerdir. Hiçbiri ölçülmüyordu; oysa dört ayrı üretim kusuru
// tam buradan doğar:
//
//   · ÇİFT MOUNT — köprü iki kez çağrılırsa (DOMContentLoaded + socket-ready,
//     ya da app.ts'nin geri uyumluluk çağrısı) aynı panel İKİ kez kurulur.
//     Sonuç yalnız görsel değildir: her örnek kendi belge dinleyicilerini ve
//     zamanlayıcılarını kaydeder.
//   · ERKEN MOUNT — belge hâlâ yükleniyorken kurulum, henüz var olmayan
//     kabuğu kaçırır ve panel sayfanın en altına düşer.
//   · SÖKÜLMEYEN ÖRNEK — `unmount` yalnız referansı null'larsa bileşen ve
//     dinleyicileri yaşamaya devam eder; ikinci söküm ise aynı örneği iki kez
//     atmaya çalışır. Sahiplik gerçekten bırakılmazsa yeniden kurulum SESSİZCE
//     hiçbir şey yapmaz.
//   · KABUĞUN KAÇIRILMASI — kabuk varken yedek düğüm yaratmak, panelin CSS
//     konumlandırmasını kaybettirir.
//
// Ölçüm noktası köprünün SAHİPLİK davranışıdır: yedek kökü yalnız gerçekten
// kurarken yaratır. Bileşen içeriği koşulludur (bazıları kapalıyken hiç düğüm
// çizmez), bu yüzden "içerik var mı" güvenilir bir sinyal DEĞİLDİR.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ShimSpec {
  name: string;
  mount: string;
  unmount: string;
  /** Kabuk yokken köprünün YARATMASI gereken düğüm kimliği. */
  fallbackId: string;
  /** Köprü `bridge:socket-ready` ile de kuruluyor mu? */
  socketReady: boolean;
  /** Varsa: kabuk HTML'i ve o kabuk kullanıldığında var olması gereken kimlik. */
  shell?: { html: string; id: string };
}

const SHIMS: ShimSpec[] = [
  { name: 'state-svelte', mount: 'mountAppState', unmount: 'unmountAppState', fallbackId: 'state-root', socketReady: true },
  { name: 'theme-svelte', mount: 'mountThemeManager', unmount: 'unmountThemeManager', fallbackId: 'theme-root', socketReady: true },
  { name: 'offline-banner-svelte', mount: 'mountOfflineBanner', unmount: 'unmountOfflineBanner', fallbackId: 'offline-banner-root', socketReady: true },
  { name: 'drafts-svelte', mount: 'mountDraftManager', unmount: 'unmountDraftManager', fallbackId: 'drafts-root', socketReady: true },
  { name: 'emoji-picker-svelte', mount: 'mountEmojiPicker', unmount: 'unmountEmojiPicker', fallbackId: 'emoji-picker-root', socketReady: false },
  { name: 'messages-loader-svelte', mount: 'mountMessageLoader', unmount: 'unmountMessageLoader', fallbackId: 'messages-loader-root', socketReady: true },
  { name: 'notification-prefs-svelte', mount: 'mountNotificationPrefsPanel', unmount: 'unmountNotificationPrefsPanel', fallbackId: 'notification-prefs-root', socketReady: true },
  { name: 'onboarding-wizard-svelte', mount: 'mountOnboardingWizard', unmount: 'unmountOnboardingWizard', fallbackId: 'onboarding-wizard-root', socketReady: true },
  { name: 'voice-check-svelte', mount: 'mountVoiceCheck', unmount: 'unmountVoiceCheck', fallbackId: 'voice-check-root', socketReady: true },
  { name: 'empty-server-start-svelte', mount: 'mountEmptyServerStart', unmount: 'unmountEmptyServerStart', fallbackId: 'empty-server-start-root', socketReady: false },
  { name: 'dm-call-svelte', mount: 'mountDmCall', unmount: 'unmountDmCall', fallbackId: 'dm-call-root', socketReady: false },
  {
    name: 'channel-stage-svelte', mount: 'mountChannelStagePanel', unmount: 'unmountChannelStagePanel',
    fallbackId: 'channel-stage-root', socketReady: true, shell: { html: '<div id="voice-view"></div>', id: 'voice-view' },
  },
  {
    name: 'messages-svelte', mount: 'mountMessageListPanel', unmount: 'unmountMessageListPanel',
    fallbackId: 'messages-root', socketReady: true, shell: { html: '<div id="messages-area"></div>', id: 'messages-area' },
  },
  {
    name: 'api-error-toast-svelte', mount: 'mountApiErrorToast', unmount: 'unmountApiErrorToast',
    fallbackId: 'api-error-toast-root', socketReady: true, shell: { html: '<div id="toast-container"></div>', id: 'toast-container' },
  },
  {
    name: 'members-svelte', mount: 'mountMemberListPanel', unmount: 'unmountMemberListPanel',
    fallbackId: 'members-root', socketReady: true, shell: { html: '<div id="member-list-content"></div>', id: 'member-list-content' },
  },
  {
    name: 'messages-input-svelte', mount: 'mountMessageInputPanel', unmount: 'unmountMessageInputPanel',
    fallbackId: 'messages-input-root', socketReady: true, shell: { html: '<div id="composer"><div id="msg-input-wrap"></div></div>', id: 'messages-input-root' },
  },
  {
    name: 'servers-svelte', mount: 'mountServerSwitcher', unmount: 'unmountServerSwitcher',
    fallbackId: 'servers-root', socketReady: true, shell: { html: '<div id="server-list"><div class="server-add"></div></div>', id: 'servers-root' },
  },
  {
    name: 'channel-list-svelte', mount: 'mountChannelListManager', unmount: 'unmountChannelListManager',
    fallbackId: 'channel-list-root', socketReady: true, shell: { html: '<div id="channel-list"></div>', id: 'channel-list-root' },
  },
];

type ShimModule = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

function callable(mod: ShimModule, key: string): Fn {
  const fn = mod[key];
  if (typeof fn !== 'function') throw new Error(`${key} bir fonksiyon değil`);
  return fn as Fn;
}

/** `unmountMemberListPanel` bir Promise döndürür; diğerleri döndürmez. */
async function call(mod: ShimModule, key: string, ...args: unknown[]): Promise<void> {
  await Promise.resolve(callable(mod, key)(...args));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/**
 * Bir önceki köprünün örneği HER ZAMAN sökülür. `vi.resetModules()` modül
 * grafiğini atar ama MONTE ÖRNEĞİ yaşatır; öksüz kalan efektler bir sonraki
 * testte DOM temizlenince patlar ve yanlış başarısızlıklar üretir.
 */
let active: { mod: ShimModule; spec: ShimSpec } | null = null;

async function disposeActive(): Promise<void> {
  const current = active;
  active = null;
  if (!current) return;
  await Promise.resolve(callable(current.mod, current.spec.unmount)());
  await flush();
}

async function loadShim(spec: ShimSpec): Promise<ShimModule> {
  await disposeActive();
  vi.resetModules();
  const mod = await import(`../js/core/${spec.name}.ts`) as ShimModule;
  active = { mod, spec };
  return mod;
}

const roots = (id: string): number => document.querySelectorAll(`#${id}`).length;

function withReadyState(value: DocumentReadyState, run: () => Promise<void>): Promise<void> {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => value });
  return run().finally(() => { Reflect.deleteProperty(document, 'readyState'); });
}

/** Sahipliğin gerçekten bırakıldığını ölçmek için yedek kökü sahneden kaldırır. */
function clearFallback(id: string): void {
  for (const node of document.querySelectorAll(`#${id}`)) node.remove();
}

beforeEach(async () => {
  await disposeActive();
  document.body.innerHTML = '';
});
afterEach(async () => {
  await disposeActive();
  document.body.innerHTML = '';
});

describe.each(SHIMS)('$name mount köprüsü', (spec) => {
  it('yüklenince tam bir kez kurulur ve tekrar çağrılınca ikinci kök yaratmaz', async () => {
    const mod = await loadShim(spec);

    // Import ANI kurulumdur: `readyState` "loading" degilse kopru hemen kurar.
    expect(roots(spec.fallbackId)).toBe(1);
    const bodyChildren = document.body.children.length;

    await call(mod, spec.mount);
    await call(mod, spec.mount);

    // Tek sahip: ikinci bir kok da, ikinci bir govde cocugu da olusmaz.
    expect(roots(spec.fallbackId)).toBe(1);
    expect(document.body.children.length).toBe(bodyChildren);
  });

  it('söküm örneği boşaltır, sahipliği bırakır ve ikinci söküm sessizdir', async () => {
    const mod = await loadShim(spec);
    const host = document.getElementById(spec.fallbackId)!;

    await call(mod, spec.unmount);
    await flush();
    expect(host.childNodes).toHaveLength(0);

    // Ikinci soküm ayni ornegi iki kez atmaya calismaz.
    await expect(call(mod, spec.unmount)).resolves.toBeUndefined();

    // Sahiplik gercekten birakildiysa kopru kokunu YENIDEN yaratir.
    clearFallback(spec.fallbackId);
    await call(mod, spec.mount);
    expect(roots(spec.fallbackId)).toBe(1);
  });

  it('açık bir hedef verildiğinde yedek kök aranmaz ve yaratılmaz', async () => {
    const mod = await loadShim(spec);
    await call(mod, spec.unmount);
    await flush();
    clearFallback(spec.fallbackId);

    const explicit = document.createElement('div');
    explicit.id = 'acik-hedef';
    document.body.appendChild(explicit);

    await call(mod, spec.mount, explicit);

    expect(roots(spec.fallbackId)).toBe(0);
    expect(document.getElementById('acik-hedef')).toBe(explicit);
  });

  it('belge hâlâ yükleniyorken kurulum DOMContentLoaded olayına ertelenir', async () => {
    await withReadyState('loading', async () => {
      await loadShim(spec);

      // Erken mount, henüz var olmayan kabuğu kaçırırdı.
      expect(roots(spec.fallbackId)).toBe(0);

      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(roots(spec.fallbackId)).toBe(1);
    });
  });

  if (spec.socketReady) {
    it('soket hazır olayı sökülmüş köprüyü yeniden kurar ve yalnız bir kez tetiklenir', async () => {
      const mod = await loadShim(spec);
      await call(mod, spec.unmount);
      await flush();
      clearFallback(spec.fallbackId);

      document.dispatchEvent(new Event('bridge:socket-ready'));
      // Aynı dosyadaki önceki modül yüklemeleri de belgeye birer dinleyici
      // bırakır (üretimde modül BİR kez yüklenir), bu yüzden ölçülen şey
      // "kök yeniden doğdu mu" olmalıdır — kesin sayı değil.
      const afterFirst = roots(spec.fallbackId);
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      // `once: true`: ikinci olay yeni bir kök doğurmaz.
      document.dispatchEvent(new Event('bridge:socket-ready'));
      expect(roots(spec.fallbackId)).toBe(afterFirst);
      await call(mod, spec.unmount);
    });
  }
});

describe.each(SHIMS.filter((spec): spec is ShimSpec & { shell: NonNullable<ShimSpec['shell']> } => Boolean(spec.shell)))(
  '$name mevcut kabuğu tercih eder',
  (spec) => {
    it('kabuk varken sayfanın sonuna yedek düğüm eklemez', async () => {
      document.body.innerHTML = spec.shell.html;
      await loadShim(spec);

      expect(document.getElementById(spec.shell.id)).not.toBeNull();
      // Kabuk kullanildiginda govde sonuna ikinci bir kok EKLENMEZ.
      expect(document.body.children).toHaveLength(1);
      expect(document.body.firstElementChild!.id).not.toBe('');
    });
  },
);
