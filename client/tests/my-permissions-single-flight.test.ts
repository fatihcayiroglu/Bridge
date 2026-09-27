// client/tests/my-permissions-single-flight.test.ts
//
// Final21 Faz 18 — girişten hemen sonra aynı sunucu için `GET /me/permissions` DÖRT kez
// gidiyordu (canlı ölçüm). Önbellek yalnız SONUCU tutuyordu; ilk gidiş-dönüş sürerken
// soran her yüzey ıskalıyor ve kendi isteğini atıyordu.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

import { clearPermsCache, fetchMyPermissions } from '../js/core/permissions/myPermissions.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const ok = (permissions: number) => ({ ok: true, json: async () => ({ permissions }) });

beforeEach(() => { apiFetch.mockReset(); clearPermsCache(); });
afterEach(() => { clearPermsCache(); });

describe('fetchMyPermissions — tek uçuş', () => {
  it('eşzamanlı dört soru TEK istekle cevaplanır', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    apiFetch.mockReturnValueOnce(gate.promise);

    const answers = Promise.all([
      fetchMyPermissions('s1'), fetchMyPermissions('s1'),
      fetchMyPermissions('s1'), fetchMyPermissions('s1'),
    ]);
    gate.resolve(ok(6));

    await expect(answers).resolves.toEqual([6, 6, 6, 6]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('farklı sunucular birbirini BEKLEMEZ', async () => {
    apiFetch.mockResolvedValueOnce(ok(2)).mockResolvedValueOnce(ok(8));
    await expect(Promise.all([fetchMyPermissions('s1'), fetchMyPermissions('s2')])).resolves.toEqual([2, 8]);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('başarısızlık önbelleğe ALINMAZ — sonraki çağrı yeniden sorar (fail-closed 0 kalıcı değil)', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) }).mockResolvedValueOnce(ok(4));
    await expect(fetchMyPermissions('s1')).resolves.toBe(0);
    await expect(fetchMyPermissions('s1')).resolves.toBe(4);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('önbellek temizlenince uçuştaki eski cevap yeni soruya DAĞITILMAZ', async () => {
    const stale = deferred<ReturnType<typeof ok>>();
    apiFetch.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(ok(1));

    const first = fetchMyPermissions('s1');
    clearPermsCache('s1');                         // ör. rol değişti
    const second = fetchMyPermissions('s1');
    stale.resolve(ok(1 << 30));                    // eski (yönetici) cevap

    await expect(second).resolves.toBe(1);
    await expect(first).resolves.toBe(1 << 30);
    expect(apiFetch).toHaveBeenCalledTimes(2);

    // Ve geç gelen eski cevap önbelleği EZMEZ: sonraki soru ağa gitmeden TAZE değeri alır.
    await expect(fetchMyPermissions('s1')).resolves.toBe(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
