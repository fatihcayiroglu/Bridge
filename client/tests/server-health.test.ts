import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import HealthTab from '../js/core/server-settings/tabs/HealthTab.svelte';

let apiFetch: ReturnType<typeof vi.fn>;

function response(status = 200): Response {
  const body = status === 200 ? {
    checkedAt: 1_755_000_000_000,
    overall: 'degraded',
    services: [
      { key: 'database', label: 'Veri hizmeti', status: 'operational', detail: 'Sunucu verileri erişilebilir.' },
      { key: 'voice', label: 'Ses ve ekran paylaşımı', status: 'degraded', detail: 'TURN relay yapılandırılmadı.' },
    ],
  } : { error: 'Forbidden' };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  apiFetch = vi.fn(async () => response());
  BridgeRegistry.register('getCurrentServer', (() => ({ _id: 'srv-health' })) as unknown as AnyFn);
  BridgeRegistry.register('apiFetch', apiFetch as unknown as AnyFn);
});

afterEach(() => {
  cleanup();
  BridgeRegistry.unregister('getCurrentServer');
  BridgeRegistry.unregister('apiFetch');
  vi.restoreAllMocks();
});

describe('Server health admin UX', () => {
  it('kanonik admin kapsamını otomatik yükler ve durumu metinle açıklar', async () => {
    render(HealthTab);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/health/server/srv-health/services'));
    await waitFor(() => expect(document.body.textContent).toContain('Genel durum: Kısıtlı'));
    expect(document.body.textContent).toContain('Veri hizmeti');
    expect(document.body.textContent).toContain('Çalışıyor');
    expect(document.body.textContent).toContain('Ses ve ekran paylaşımı');
  });

  it('403 durumunu sessiz boş listeye çevirmez', async () => {
    apiFetch.mockResolvedValue(response(403));
    render(HealthTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('Sunucuyu Yönet izni'));
  });

  it('Yenile aynı güvenli ucu tekrar kontrol eder', async () => {
    const view = render(HealthTab);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const refresh = view.getByRole('button', { name: 'Sistem durumunu yenile' });
    await waitFor(() => expect(refresh).not.toBeDisabled());
    await fireEvent.click(refresh);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  });

  it('sunucu seçimi veya bağlantı sahibi yoksa istek atmadan fail-closed olur', async () => {
    BridgeRegistry.unregister('getCurrentServer');
    render(HealthTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('kullanılamıyor'));
    expect(apiFetch).not.toHaveBeenCalled();
    cleanup();

    BridgeRegistry.register('getCurrentServer', (() => ({ _id: 'srv-health' })) as unknown as AnyFn);
    BridgeRegistry.unregister('apiFetch');
    render(HealthTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('kullanılamıyor'));
  });

  it('sunucu govdesini SIZDIRMADAN durum koduna gore mesaj gosterir', async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Bakım penceresi' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
    render(HealthTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_server')));
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('Bakım penceresi');
    cleanup();

    apiFetch.mockResolvedValueOnce(new Response('not-json', { status: 502 }));
    render(HealthTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_server')));
  });

  it('ag hatasini ve Error olmayan reddi kontrollu mesaja cevirir', async () => {
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    render(HealthTab);
    // `Error('offline')` AG hatasi olarak siniflandirilir; ham `message` gosterilmez.
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_network')));
    cleanup();

    apiFetch.mockRejectedValueOnce('offline');
    render(HealthTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('ui_sistem_durumu_alinamadi')));
  });

  it('BOZUK yaniti sessizce "unavailable"a indirgemez, acikca REDDEDER', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({
      checkedAt: 'yesterday',
      overall: 'unknown',
      services: { database: 'up' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(HealthTab);

    // Panel eskiden bozuk bir govdeyi "Kullanilamiyor + simdiki zaman" olarak
    // GOSTERIYORDU; yani dogrulanmamis veriyi gercek bir olcum gibi sunuyordu.
    // Uretim artik yaniti dogruluyor ve reddediyor.
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('ui_sistem_durumu_yaniti_dogrulanamadi_tekrar_deneyebili')));
    expect(document.querySelectorAll('.service')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Son kontrol');
  });

  it('sifir kontrol zamanini acikca henuz kontrol edilmedi diye gosterir', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({
      checkedAt: 0,
      overall: 'operational',
      services: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(HealthTab);

    await waitFor(() => expect(document.body.textContent).toContain('Genel durum: Çalışıyor'));
    expect(document.body.textContent).toContain('Henüz kontrol edilmedi');
  });

  it('hata durumundaki tekrar dene basarili cevaba gecebilir', async () => {
    apiFetch
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(200));
    render(HealthTab);
    const retry = await waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(candidate => candidate.textContent?.includes(t('retry')));
      expect(button).toBeTruthy();
      return button!;
    });

    await fireEvent.click(retry);

    await waitFor(() => expect(document.body.textContent).toContain('Genel durum: Kısıtlı'));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
