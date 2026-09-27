import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));

import MessageRenderer from '../js/core/MessageRenderer.svelte';
import {
  advanceMediaCredentialGeneration,
  getMediaCredentialGeneration,
  isMediaRenewalInFlight,
  isProtectedMediaUrl,
  renewMediaCredential,
  resetMediaRenewalState,
  withMediaRetry,
} from '../js/core/media-auth.ts';

function response(ok: boolean, status = ok ? 200 : 401): Response {
  return { ok, status } as Response;
}

function imageMessage(id = 'm-media') {
  return {
    _id: id,
    userId: 'u-1',
    displayName: 'Ada',
    createdAt: 1_754_000_000_000,
    fileUrl: `/uploads/${id}.png`,
    fileName: `${id}.png`,
    fileType: 'image/png',
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  resetMediaRenewalState();
});

describe('media credential single-flight', () => {
  it('coalesces simultaneous failures into one authenticated renewal', async () => {
    let finish!: (value: Response) => void;
    apiFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));

    const first = renewMediaCredential(0);
    const second = renewMediaCredential(0);

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(isMediaRenewalInFlight()).toBe(true);
    finish(response(true));
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(getMediaCredentialGeneration()).toBe(1);
    expect(isMediaRenewalInFlight()).toBe(false);
  });

  it('attempts a failed generation only once and does not form a retry storm', async () => {
    apiFetchMock.mockResolvedValue(response(false));

    await expect(renewMediaCredential(0)).resolves.toBe(false);
    await expect(renewMediaCredential(0)).resolves.toBe(false);

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(getMediaCredentialGeneration()).toBe(0);
  });

  it('only recognizes trusted /uploads URLs and creates a cache-busted retry URL', () => {
    expect(isProtectedMediaUrl('/uploads/private.png')).toBe(true);
    expect(isProtectedMediaUrl('https://attacker.invalid/uploads/private.png')).toBe(false);
    expect(isProtectedMediaUrl('/avatars/private.png')).toBe(false);
    expect(withMediaRetry('/uploads/private.png?size=2', 4)).toBe('/uploads/private.png?size=2&_bridge_media_retry=4');
  });

  it('eski nesil zaten yenilendiyse basarili, gelecek nesilse gecersiz sayar', async () => {
    advanceMediaCredentialGeneration();
    await expect(renewMediaCredential(0)).resolves.toBe(true);
    await expect(renewMediaCredential(2)).resolves.toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('basarisiz HTTP yaniti sirasinda nesil ilerlediyse baska yenilemeyi kabul eder', async () => {
    let finish!: (value: Response) => void;
    apiFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = renewMediaCredential(0);

    advanceMediaCredentialGeneration();
    finish(response(false));

    await expect(pending).resolves.toBe(true);
    expect(getMediaCredentialGeneration()).toBe(1);
  });

  it('ag hatasini nesil degismediyse reddeder, degistiyse tamamlanmis sayar', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(renewMediaCredential(0)).resolves.toBe(false);

    resetMediaRenewalState();
    let fail!: (reason: unknown) => void;
    apiFetchMock.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const pending = renewMediaCredential(0);
    advanceMediaCredentialGeneration();
    fail(new Error('offline'));
    await expect(pending).resolves.toBe(true);
  });

  it('eski tamamlanma yeni tek-ucus promiseini temizlemez', async () => {
    let finishOld!: (value: Response) => void;
    let finishCurrent!: (value: Response) => void;
    apiFetchMock
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishCurrent = resolve; }));

    const oldRun = renewMediaCredential(0);
    resetMediaRenewalState();
    const currentRun = renewMediaCredential(0);

    finishOld(response(true));
    await expect(oldRun).resolves.toBe(true);
    expect(isMediaRenewalInFlight()).toBe(true);

    finishCurrent(response(true));
    await expect(currentRun).resolves.toBe(true);
    expect(isMediaRenewalInFlight()).toBe(false);
  });

  it('bos/bozuk URLleri reddeder ve mutlak retry URLlerini korur', () => {
    expect(isProtectedMediaUrl(null)).toBe(false);
    expect(isProtectedMediaUrl('http://[invalid')).toBe(false);
    expect(withMediaRetry('https://bridge.example/uploads/a.png#preview', 3))
      .toBe('https://bridge.example/uploads/a.png?_bridge_media_retry=3#preview');
    expect(withMediaRetry('http://[invalid', 3)).toBe('http://[invalid');
  });

  it('kimlik dogrulama olaylari credential neslini ilerletir', () => {
    document.dispatchEvent(new Event('bridge:auth-success'));
    document.dispatchEvent(new Event('bridge:auth-logout'));
    expect(getMediaCredentialGeneration()).toBe(2);
  });

  it('document olmayan calisma ortaminda modul yan etkisiz yuklenir', async () => {
    vi.resetModules();
    vi.stubGlobal('document', undefined);
    await expect(import('../js/core/media-auth.ts')).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });
});

describe('MessageRenderer media recovery', () => {
  it('renews and changes an image URL exactly once, then shows an honest failure', async () => {
    apiFetchMock.mockResolvedValue(response(true));
    const view = render(MessageRenderer, { props: { message: imageMessage() } });

    await fireEvent.error(view.container.querySelector('img.msg-image')!);
    await waitFor(() => {
      expect(view.container.querySelector('img.msg-image')?.getAttribute('src')).toContain('_bridge_media_retry=1');
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await fireEvent.error(view.container.querySelector('img.msg-image')!);
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(/ek yüklenemedi/i));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed without repeated renewal calls when renewal is unavailable', async () => {
    apiFetchMock.mockResolvedValue(response(false));
    const view = render(MessageRenderer, { props: { message: imageMessage('m-fail') } });

    await fireEvent.error(view.container.querySelector('img.msg-image')!);
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(/ek yüklenemedi/i));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('img.msg-image')).not.toBeInTheDocument();
  });

  it('does not renew untrusted external media', async () => {
    const view = render(MessageRenderer, {
      props: { message: { ...imageMessage('external'), fileUrl: 'https://cdn.example.test/external.png' } },
    });

    await fireEvent.error(view.container.querySelector('img.msg-image')!);
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(/ek yüklenemedi/i));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
