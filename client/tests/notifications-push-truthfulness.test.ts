// client/tests/notifications-push-truthfulness.test.ts
// ÜRÜN DOĞRULUĞU regresyonu: Web Push kontrolü yalan söylememeli.
//
// ════════════════════════════════════════════════════════════════════════════
// NE KORUYOR
// ════════════════════════════════════════════════════════════════════════════
//
// Bu dosya push TESLİMATINI kapsamaz. Sunucu tarafı gerçek push gönderimi
// (server/lib/pushSender.ts) kendi sunucu süitleriyle korunur.
//
// Buradaki tek konu ÜRÜN DOĞRULUĞUDUR: kullanıcıya görünen bir anahtarın,
// arkasında hiçbir uygulama yokken "açıldı" izlenimi vermemesi.
//
// ── KORUNAN TARİHSEL DEFEKT ─────────────────────────────────────────────────
// Kontrol bir zamanlar `window.BridgeRegistry` (hiç atanmayan bir ad) okuyor,
// `push:enable`/`push:disable` (hiç kaydedilmeyen adlar) çağırıyor, her iki
// başarısızlığı da sessizce yutuyor ve ardından `pushEnabled`ı KOŞULSUZ true
// yapıyordu: kullanıcı anahtarı açık görüyor, ekran okuyucu
// `aria-pressed="true"` okuyor, ama hiçbir abonelik/izin/VAPID akışı
// çalışmıyordu.
//
// ── BU DOSYA NEDEN YENİDEN YAZILDI ──────────────────────────────────────────
// Akış artık GERÇEKTEN var: `notifications/web-push-client.ts` izin, service
// worker, VAPID yapılandırması ve sunucu eşitlemesini yürütür; kontrol de
// durumu oradan okur. Eski testler ise hâlâ "kontrol HER KOŞULDA devre
// dışıdır" boş-kabuk sözleşmesini ve artık var olmayan bir `aria-label`ı
// arıyordu; yani ürünün BUGÜNKÜ davranışını değil, kaldırılmış bir ara
// durumu ölçüyorlardı. Korunan asıl değer — "kontrol yalan söylemesin" —
// bugünkü uygulamaya karşı yeniden ifade edildi:
//
//   · durum SUNUCUDAN/TARAYICIDAN okunur, uydurulmaz,
//   · desteklenmiyor / yapılandırılmamış / izin reddedilmiş hâllerinde
//     kontrol DEVRE DIŞIDIR ve nedeni GÖRÜNÜR bir metinle açıklanır,
//   · devre dışıyken tıklama hiçbir abonelik çağrısı yapmaz,
//   · abonelik BAŞARISIZ olursa anahtar "açık" hâle GEÇMEZ — sahte başarı yok.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

const state = vi.hoisted(() => ({
  supported: true,
  configured: true,
  subscribed: false,
  permission: 'granted' as NotificationPermission | 'unsupported',
}));
const enableWebPush = vi.hoisted(() => vi.fn());
const disableWebPush = vi.hoisted(() => vi.fn());
const sendTestWebPush = vi.hoisted(() => vi.fn());

vi.mock('../js/core/notifications/web-push-client.ts', () => ({
  getWebPushState: vi.fn(async () => ({ ...state })),
  enableWebPush,
  disableWebPush,
  sendTestWebPush,
}));

import NotificationsTab from '../js/core/settings/tabs/NotificationsTab.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

const pushToggle = (): HTMLButtonElement =>
  document.querySelector(
    '.settings-card[aria-labelledby="web-push-title"] button.toggle-btn',
  ) as HTMLButtonElement;

/** Bileşen durumu `onMount` içinde ASENKRON okur; iddialar onu beklemelidir. */
async function renderTab(): Promise<void> {
  render(NotificationsTab, { props: { store: {} as never } });
  await waitFor(() => expect(pushToggle()).not.toBeNull());
  const expectDisabled = !state.supported || !state.configured || state.permission === 'denied';
  await waitFor(() => expect(pushToggle().disabled).toBe(expectDisabled));
}

beforeEach(() => {
  state.supported = true;
  state.configured = true;
  state.subscribed = false;
  state.permission = 'granted';
  enableWebPush.mockReset().mockResolvedValue({ ok: true });
  disableWebPush.mockReset().mockResolvedValue({ ok: true });
  sendTestWebPush.mockReset().mockResolvedValue({ ok: true });
  BridgeRegistry.register('apiFetch', async () => new Response('{}', { status: 200 }));
});

afterEach(() => {
  cleanup();
  BridgeRegistry.unregister('apiFetch');
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Web Push kontrolü — dürüstlük sözleşmesi', () => {
  it('kontrol GİZLENMEZ, kullanıcıya görünür kalır', async () => {
    await renderTab();
    expect(pushToggle()).not.toBeNull();
    expect(document.body.textContent).toContain(t('markup_web_push_bildirimleri_cfce4a0'));
  });

  it('başlangıçta abonelik YOKKEN basılı görünmez', async () => {
    await renderTab();
    expect(pushToggle().getAttribute('aria-pressed')).toBe('false');
    expect(pushToggle().classList.contains('on')).toBe(false);
  });

  it('tarayıcı desteklemiyorsa DEVRE DIŞIDIR ve nedeni yazılır', async () => {
    state.supported = false;
    await renderTab();
    expect(pushToggle().disabled).toBe(true);
    expect(document.body.textContent).toContain(t('push_unsupported'));
  });

  it('sunucuda VAPID yapılandırılmamışsa DEVRE DIŞIDIR ve nedeni yazılır', async () => {
    state.configured = false;
    await renderTab();
    expect(pushToggle().disabled).toBe(true);
    expect(document.body.textContent).toContain(t('push_vapid_required'));
  });

  it('izin reddedilmişse DEVRE DIŞIDIR ve nedeni yazılır', async () => {
    state.permission = 'denied';
    await renderTab();
    expect(pushToggle().disabled).toBe(true);
    expect(document.body.textContent).toContain(t('push_permission_denied'));
  });

  it('REGRESYON: devre dışıyken tıklama hiçbir abonelik çağrısı yapmaz', async () => {
    state.configured = false;
    await renderTab();
    await fireEvent.click(pushToggle());
    expect(enableWebPush).not.toHaveBeenCalled();
    expect(disableWebPush).not.toHaveBeenCalled();
    expect(pushToggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('REGRESYON: abonelik BAŞARISIZ olursa anahtar açık duruma GEÇMEZ', async () => {
    enableWebPush.mockResolvedValue({ ok: false, reason: 'subscribe_failed' });
    await renderTab();

    await fireEvent.click(pushToggle());

    await waitFor(() => expect(enableWebPush).toHaveBeenCalledTimes(1));
    // Sahte başarı yok: hem görsel hem erişilebilir durum KAPALI kalır ve
    // kullanıcıya nedeni gösterilir.
    await waitFor(() => expect(pushToggle().getAttribute('aria-pressed')).toBe('false'));
    expect(pushToggle().classList.contains('on')).toBe(false);
    expect(document.body.textContent).toContain(t('push_subscribe_failed'));
  });

  it('abonelik BAŞARILI olursa durum sunucudan yeniden okunur', async () => {
    enableWebPush.mockImplementation(async () => { state.subscribed = true; return { ok: true }; });
    await renderTab();

    await fireEvent.click(pushToggle());

    await waitFor(() => expect(pushToggle().getAttribute('aria-pressed')).toBe('true'));
    expect(document.body.textContent)
      .toContain(t('ui_web_push_bildirimleri_bu_cihazda_etkin'));
  });
});
