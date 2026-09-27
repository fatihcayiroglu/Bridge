// client/tests/error-boundary-owner-handover.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ErrorBoundary.svelte — SAHİPLİK DEVRİ VE KAYNAĞI BİLİNMEYEN HATALAR
// ════════════════════════════════════════════════════════════════════════════
// Bu bileşen `captureUIError` / `clearUIErrors` sahiplerini kaydeder. Sökülme
// sırasında kaydı KOŞULSUZ silmek gerçek bir kusur olurdu: kısa bir süre iki
// örneğin birlikte var olduğu her geçişte (tema değişimi, sıcak yeniden
// yükleme, kabuk yeniden çizimi) eski örneğin sökülmesi YENİ örneğin kaydını
// silerdi. Uygulama o andan itibaren hiçbir UI hatasını yakalamazdı — ve bunu
// hiçbir yerde SÖYLEMEZDİ.
//
// Bu yüzden sökülme yalnızca kaydın HÂLÂ kendisine ait olması hâlinde siler.
//
// İkinci sözleşme: her hata bir bileşen adı taşımaz. `BridgeRegistry` üzerinden
// gelen çıplak bir çağrının kaynağı bilinmeyebilir. Böyle bir satır günlükte
// GÖRÜNMELİ, ama "[undefined]" gibi bir etiket ÜRETMEMELİDİR.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ErrorBoundary from '../js/core/ErrorBoundary.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  // Delegate to the canonical catalog `t` instead of hand-rolling a stub: a
  // `fallback ?? key` stub returns the raw key for every call that relies on
  // the catalog entry (e.g. `t('ui_error_count', undefined, { count })`), so
  // assertions on the rendered text could never pass.
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let host: HTMLDivElement;
const mounted: Array<ReturnType<typeof mount>> = [];

function mountBoundary(): ReturnType<typeof mount> {
  const instance = mount(ErrorBoundary, { target: host });
  mounted.push(instance);
  flushSync();
  return instance;
}

function openPanel(): void {
  flushSync();
  const toggle = host.querySelector('.eb-dev-header button') as HTMLButtonElement | null;
  if (!toggle) throw new Error('geliştirici paneli basılmadı');
  toggle.click();
  flushSync();
}

const rows = () => { flushSync(); return [...host.querySelectorAll('.eb-dev-item')]; };

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  BridgeRegistry.unregister('captureUIError');
  BridgeRegistry.unregister('clearUIErrors');
  BridgeRegistry.unregister('sentry');
});

afterEach(() => {
  while (mounted.length) {
    const instance = mounted.pop();
    if (instance) { try { unmount(instance); } catch { /* zaten sökülmüş */ } }
  }
  document.body.innerHTML = '';
  BridgeRegistry.unregister('captureUIError');
  BridgeRegistry.unregister('clearUIErrors');
  BridgeRegistry.unregister('sentry');
  vi.restoreAllMocks();
});

describe('unmounting never steals another instance’s ownership', () => {
  it('leaves a newer owner in place when an older instance is torn down', () => {
    const first = mountBoundary();
    const firstOwner = BridgeRegistry.get('captureUIError');
    expect(firstOwner).toBeTypeOf('function');

    // İkinci örnek monte olur ve sahipliği DEVRALIR (geçiş anı).
    mountBoundary();
    const secondOwner = BridgeRegistry.get('captureUIError');
    expect(secondOwner).not.toBe(firstOwner);

    // Eskisi sökülür: YENİ sahibin kaydı DOKUNULMADAN kalmalıdır.
    unmount(first);
    mounted.splice(mounted.indexOf(first), 1);
    flushSync();

    expect(BridgeRegistry.get('captureUIError')).toBe(secondOwner);
    expect(BridgeRegistry.get('clearUIErrors')).toBeTypeOf('function');
    // Ve yakalama HÂLÂ çalışır — sessiz bir kör nokta oluşmaz.
    expect(() => BridgeRegistry.call('captureUIError', new Error('devir sonrası'))).not.toThrow();
  });

  it('releases its own registration when it is the last owner', () => {
    const only = mountBoundary();
    expect(BridgeRegistry.get('captureUIError')).toBeTypeOf('function');

    unmount(only);
    mounted.splice(mounted.indexOf(only), 1);
    flushSync();

    expect(BridgeRegistry.has('captureUIError')).toBe(false);
    expect(BridgeRegistry.has('clearUIErrors')).toBe(false);
  });

  it('leaves an unrelated third-party owner alone', () => {
    const instance = mountBoundary();
    // Başka bir katman sahipliği açıkça devralır.
    const foreign = vi.fn();
    BridgeRegistry.register('captureUIError', foreign as never);
    BridgeRegistry.register('clearUIErrors', foreign as never);

    unmount(instance);
    mounted.splice(mounted.indexOf(instance), 1);
    flushSync();

    expect(BridgeRegistry.get('captureUIError')).toBe(foreign);
    expect(BridgeRegistry.get('clearUIErrors')).toBe(foreign);
  });
});

describe('errors with no known origin are still legible', () => {
  it('renders a row without fabricating a component label', () => {
    mountBoundary();
    BridgeRegistry.call('captureUIError', new Error('kaynağı bilinmeyen'));
    openPanel();

    const row = rows().at(-1)!;
    expect(row.textContent).toContain('kaynağı bilinmeyen');
    // Bileşen adı YOK: "[undefined]" gibi bir etiket basılmaz.
    expect(row.querySelector('.eb-comp')).toBeNull();
    expect(row.textContent).not.toContain('undefined');
  });

  it('labels the origin when one is supplied', () => {
    mountBoundary();
    BridgeRegistry.call('captureUIError', new Error('kaynaklı'), 'VoicePanel');
    openPanel();

    const row = rows().at(-1)!;
    expect(row.querySelector('.eb-comp')?.textContent).toBe('[VoicePanel]');
  });

  it('counts every captured error in the header', () => {
    mountBoundary();
    BridgeRegistry.call('captureUIError', new Error('bir'));
    BridgeRegistry.call('captureUIError', 'iki');
    BridgeRegistry.call('captureUIError', { toString: () => 'üç' });
    flushSync();

    const header = host.querySelector('.eb-dev-header span')?.textContent ?? '';
    expect(header).toContain('3');
    openPanel();
    // `Error` olmayan değerler de OKUNABİLİR metne çevrilir.
    expect(rows().map(row => row.textContent ?? '').join(' ')).toContain('iki');
  });

  it('clears the log through the registered owner', () => {
    mountBoundary();
    BridgeRegistry.call('captureUIError', new Error('temizlenecek'));
    flushSync();
    expect(host.querySelector('.eb-dev-panel')).not.toBeNull();

    BridgeRegistry.call('clearUIErrors');
    flushSync();
    expect(host.querySelector('.eb-dev-panel')).toBeNull();
  });
});
