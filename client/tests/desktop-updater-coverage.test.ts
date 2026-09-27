import { describe, it, expect, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function state(overrides: Record<string, unknown> = {}) {
  return {
    phase: 'idle', currentVersion: '1.0.0', availableVersion: null,
    releaseDate: null, releaseName: null, percent: 0, lastCheckedAt: null,
    lastError: null, canInstall: false, isPackaged: true, ...overrides,
  } as any;
}

describe('desktop updater renderer lifecycle and remote-metadata safety', () => {
  it('is idempotent, renders remote metadata as text, clamps progress and contains rejected actions', async () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (window as any).bridgeUpdater;

    const mod = await import('../js/core/desktop-updater.ts');
    expect(() => mod.initDesktopUpdater()).not.toThrow();
    expect(document.querySelector('#bridge-desktop-updater-toast')).toBeNull();

    let emitStatus: ((value: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const getStatus = vi.fn().mockResolvedValue(state({
      phase: 'available',
      availableVersion: '<img src=x onerror=alert(1)>',
    }));
    const check = vi.fn().mockResolvedValue(state({ phase: 'not-available' }));
    const install = vi.fn().mockRejectedValue(new Error('preload unavailable'));
    const onStatus = vi.fn((cb: (value: any) => void) => { emitStatus = cb; return unsubscribe; });
    (window as any).bridgeUpdater = { getStatus, check, install, onStatus };

    mod.initDesktopUpdater();
    await tick();
    const toast = document.querySelector<HTMLElement>('#bridge-desktop-updater-toast')!;
    expect(toast).toBeTruthy();
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(toast.querySelector('img')).toBeNull();
    expect(document.querySelectorAll('#bridge-desktop-updater-style')).toHaveLength(1);

    // Reinitialization refreshes state but must not duplicate subscriptions or
    // delegated click listeners.
    mod.initDesktopUpdater();
    await tick();
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('#bridge-desktop-updater-style')).toHaveLength(1);

    emitStatus!(state({ phase: 'downloading', availableVersion: '2.0.0', percent: 500 }));
    const progress = toast.querySelector<HTMLProgressElement>('progress')!;
    expect(progress.value).toBe(100);
    emitStatus!(state({ phase: 'downloading', availableVersion: null, percent: Number.NaN }));
    expect(toast.querySelector<HTMLProgressElement>('progress')!.value).toBe(0);

    emitStatus!(state({ phase: 'downloaded', availableVersion: '2.0.0' }));
    const installButton = [...toast.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.dataset.action === 'install')!;
    installButton.click();
    await tick();
    expect(install).toHaveBeenCalledTimes(1);

    emitStatus!(state({ phase: 'error', lastError: '<svg onload=alert(1)></svg>' }));
    // DAHA GUCLU SOZLESME: uzak surum akisindan gelen hata metni artik metin
    // olarak bile GOSTERILMEZ; sabit ve cevrilmis bir mesaj yazilir. (Eski
    // test "metin olarak render edilir" diyordu; uzak veriyi hic gostermemek
    // daha guvenlidir ve uretim bunu yapiyor.)
    expect(toast.textContent).toContain(t('updater_server_unreachable'));
    expect(toast.textContent).not.toContain('<svg onload=alert(1)>');
    expect(toast.querySelector('svg')).toBeNull();
    const retry = [...toast.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.dataset.action === 'check')!;
    retry.click();
    await tick();
    expect(check).toHaveBeenCalledTimes(1);
    expect(toast.hidden).toBe(true); // not-available response hides the toast

    check.mockRejectedValueOnce(new Error('offline'));
    emitStatus!(state({ phase: 'error', lastError: 'first failure' }));
    [...toast.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.dataset.action === 'check')!.click();
    await tick();
    expect(toast.textContent).toContain('Güncelleme sunucusuna ulaşılamadı');

    [...toast.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.dataset.action === 'hide')!.click();
    expect(toast.hidden).toBe(true);

    const secondOnStatus = vi.fn(() => undefined);
    const secondUpdater = {
      getStatus: vi.fn().mockResolvedValue(state({ phase: 'checking' })),
      check: vi.fn(), install: vi.fn(), onStatus: secondOnStatus,
    };
    (window as any).bridgeUpdater = secondUpdater;
    mod.initDesktopUpdater();
    await tick();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(secondOnStatus).toHaveBeenCalledTimes(1);

    delete (window as any).bridgeUpdater;
  });
});
