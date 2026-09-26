// client/tests/toast-host.test.ts
// Faz 8 — Bildirim (toast) sunucusu regression testleri.
//
// Kaybolan davranışın geri kazanımını korur: `core/utils.ts` içindeki toast()
// 199 çağrı yerinden çağrılıyor ve alıcısı yoktu; artık ApiErrorToast.svelte
// BridgeRegistry'ye kaydolarak mesajları gerçekten gösteriyor.
//
// Legacy `tests/api-error-toast.test.ts` dosyasının koruduğu sözleşmelerden
// hâlâ geçerli olanlar buraya taşındı:
//   - kullanıcıya güvenli mesaj gösterimi
//   - severity (error/success/info) ayrımı
//   - aynı hatanın tekrar tekrar gösterilmemesi (duplicate suppression)
// Legacy dosya SİLİNMEDİ; `handleApiError(Response)` eşlemesi hâlâ ürün
// boşluğu olarak duruyor (bkz. rapor: Remaining product gaps).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ApiErrorToast from '../js/core/ApiErrorToast.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { toast } from '../js/core/utils.ts';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

// Svelte 5 DOM güncellemelerini mikrotaskta uygular; testte deterministik
// olması için flushSync ile senkronize ediyoruz (dokümante edilen yol).
const visibleToasts = () => { flushSync(); return [...host.querySelectorAll('.toast')]; };
const advance = (ms: number) => { vi.advanceTimersByTime(ms); flushSync(); };

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  host.id = 'toast-container';
  document.body.appendChild(host);
  instance = mount(ApiErrorToast, { target: host });
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  vi.useRealTimers();
});

describe('toast host (ApiErrorToast)', () => {
  it('mount olunca kendini BridgeRegistry\'ye kaydeder', () => {
    expect(BridgeRegistry.has('toast')).toBe(true);
  });

  it('utils.toast() çağrısı kullanıcıya GÖRÜNÜR bildirim üretir (kaybolan davranış)', () => {
    toast('Mesaj gönderilemedi', 'error');

    const items = visibleToasts();
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Mesaj gönderilemedi');
  });

  it('severity sınıfa ve ARIA rolüne yansır', () => {
    toast('kaydedildi', 'success');
    toast('hata oldu', 'error');

    const items = visibleToasts();
    const success = items.find(e => e.getAttribute('data-toast-type') === 'success')!;
    const error   = items.find(e => e.getAttribute('data-toast-type') === 'error')!;

    expect(success.classList.contains('success')).toBe(true);
    expect(success.getAttribute('role')).toBe('status');
    expect(error.classList.contains('error')).toBe(true);
    expect(error.getAttribute('role')).toBe('alert');       // hata daha yüksek öncelik
    expect(error.getAttribute('aria-live')).toBe('assertive');
  });

  it('severity semantik ve ekran okuyucudan gizli bir simgeyle görünür', () => {
    toast('kaydedildi', 'success');

    const icon = visibleToasts()[0].querySelector('.toast-icon')!;
    expect(icon.textContent).toBe('✓');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(visibleToasts()[0].querySelector('.toast-text')!.textContent).toBe('kaydedildi');
  });

  it('bilinmeyen/boş tip info olarak normalize edilir (legacy çağrılar `` geçiyor)', () => {
    toast('bilgi', '');
    expect(visibleToasts()[0].getAttribute('data-toast-type')).toBe('info');
  });

  it('aynı mesaj kısa aralıkta tekrarlanırsa ikinci kez gösterilmez', () => {
    toast('bağlantı hatası', 'error');
    toast('bağlantı hatası', 'error');
    toast('bağlantı hatası', 'error');

    expect(visibleToasts()).toHaveLength(1);
  });

  it('dedupe penceresi geçince aynı mesaj tekrar gösterilebilir', () => {
    toast('tekrar', 'info');
    advance(2000); // DEDUPE_WINDOW_MS (1500) geçti
    toast('tekrar', 'info');

    // İlki hâlâ ekranda (3sn timeout) + ikincisi eklendi
    expect(visibleToasts().length).toBeGreaterThanOrEqual(2);
  });

  it('otomatik kapanır (varsayılan süre sonunda DOM\'dan düşer)', () => {
    toast('geçici', 'info');
    expect(visibleToasts()).toHaveLength(1);

    advance(3000 + 500 + 10); // timeout + fade
    expect(visibleToasts()).toHaveLength(0);
  });

  it('kapat düğmesi bildirimi kaldırır', () => {
    toast('elle kapatılacak', 'info');
    expect(visibleToasts()).toHaveLength(1);   // render'ı flush eder
    const closeBtn = host.querySelector<HTMLButtonElement>('.toast-close')!;

    closeBtn.click();
    advance(600); // fade

    expect(visibleToasts()).toHaveLength(0);
  });

  it('boş mesaj bildirim üretmez', () => {
    toast('', 'info');
    toast('   ', 'error');
    expect(visibleToasts()).toHaveLength(0);
  });

  it('çok uzun teknik metin kırpılır (ham hata dökümü gösterilmez)', () => {
    toast('x'.repeat(500), 'error');

    const text = visibleToasts()[0].querySelector('.toast-text')!.textContent!;
    expect(text.length).toBeLessThanOrEqual(201); // 200 + tek karakterlik "…"
    expect(text.endsWith('…')).toBe(true);
  });

  it('içerik metin olarak basılır — HTML enjekte edilmez (XSS)', () => {
    toast('<img src=x onerror="alert(1)">', 'error');

    const item = visibleToasts()[0];
    expect(item.querySelector('img')).toBeNull();
    expect(item.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('unmount tüm zamanlayıcıları ve kaydı temizler (leak yok)', () => {
    toast('kalıntı olmasın', 'info');
    expect(visibleToasts()).toHaveLength(1);

    unmount(instance!);
    instance = null;

    expect(BridgeRegistry.has('toast')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
