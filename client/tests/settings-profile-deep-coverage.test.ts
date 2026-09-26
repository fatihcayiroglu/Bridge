import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import ProfileTab from '../js/core/settings/tabs/ProfileTab.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  delete (globalThis as { currentUser?: unknown }).currentUser;
});

afterEach(() => {
  cleanup();
  delete (globalThis as { currentUser?: unknown }).currentUser;
  vi.restoreAllMocks();
});

describe('ProfileTab persistence truth and busy state', () => {
  it('oturum acilmamis profili bos ve KALICILIK SOZUNU dogru anlatarak cizer', () => {
    // Bu test eskiden "sunucu tarafinda kalici kullanici tercihi henuz
    // yoktur" uyarisini bekliyordu; o zaman DOGRUYDU. Varlik tercihi bu arada
    // GERCEKTEN kalici hale geldi (ProfileTab -> presence kaydi + sunucu
    // dogrulamasi), ve metin de guncellendi. Korunan deger ayni: kullaniciya
    // yalnizca URUNUN GERCEKTEN yaptigi soz verilir.
    const save = vi.fn(async () => true);
    const view = render(ProfileTab, { props: { store: { save } as never } });

    expect(view.getByLabelText('Görünen Ad')).toHaveValue('');
    expect(view.getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    expect(view.container)
      .toHaveTextContent(t('markup_secimin_hesabina_kaydedilir_ve_yeniden_baglandig_c311fbc'));
    // Desteklenmeyen "durum metni" alani hala YOKTUR.
    expect(view.container.querySelector('#status-text')).not.toBeInTheDocument();
  });

  it('sends only the supported display name, blocks duplicate saves, and commits local truth after success', async () => {
    const user = { _id: 'u1', displayName: 'Eski', statusText: 'kalıcı değil' };
    (globalThis as { currentUser?: unknown }).currentUser = user;
    const request = deferred<boolean>();
    const save = vi.fn(() => request.promise);
    const view = render(ProfileTab, { props: { store: { save } as never } });

    const input = view.getByLabelText('Görünen Ad');
    await fireEvent.input(input, { target: { value: 'Yeni' } });
    const button = view.getByRole('button', { name: 'Kaydet' });
    expect(button).toBeEnabled();

    await fireEvent.click(button);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ displayName: 'Yeni' });
    expect(view.getByRole('button', { name: 'Kaydediliyor…' })).toBeDisabled();
    await fireEvent.click(view.getByRole('button', { name: 'Kaydediliyor…' }));
    expect(save).toHaveBeenCalledOnce();

    request.resolve(true);
    await waitFor(() => expect(view.getByRole('button', { name: 'Kaydet' })).toBeDisabled());
    expect(user).toEqual({ _id: 'u1', displayName: 'Yeni', statusText: 'kalıcı değil' });
  });

  it('does not mutate the current-user cache when the canonical store rejects the update', async () => {
    const user = { _id: 'u1', displayName: 'Eski' };
    (globalThis as { currentUser?: unknown }).currentUser = user;
    const save = vi.fn(async () => false);
    const view = render(ProfileTab, { props: { store: { save } as never } });

    await fireEvent.input(view.getByLabelText('Görünen Ad'), { target: { value: 'Reddedilen' } });
    await fireEvent.click(view.getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(user.displayName).toBe('Eski');
    expect(view.getByRole('button', { name: 'Kaydet' })).toBeEnabled();
  });
});
