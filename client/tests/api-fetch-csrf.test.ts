// client/tests/api-fetch-csrf.test.ts
// CANLI YAKALANAN KUSUR — KANONİK HTTP İSTEMCİSİNDE CSRF YOKTU.
//
// ════════════════════════════════════════════════════════════════════════════
// NASIL BULUNDU (testle değil, GERÇEK ÜRÜNÜ ÇALIŞTIRARAK)
// ════════════════════════════════════════════════════════════════════════════
// Canlı sunucuda (tünel) aynı istek iki kez denendi:
//   POST /api/servers/:sid/leave  jetonsuz → 403 {"error":"CSRF token missing"}
//   POST /api/servers/:sid/leave  X-CSRF-Token ile
//                                 → 400 {"error":"Owner cannot leave …"}
// Yani sunucu, Bearer taşıyan TÜM mutasyon isteklerinde CSRF zorunlu kılıyor
// (server/middleware/csrf.ts). Buna karşın uygulamanın TEK HTTP istemcisi olan
// `api-fetch.ts` jetonu HİÇ göndermiyordu; yalnız `EmptyServerStart.svelte`
// kendi özel kopyasını taşıyordu.
//
// SONUÇ: `apiFetch` üzerinden yapılan HER mutasyon üretimde 403 alıyordu —
// davet oluşturma, kanal oluşturma ve sunucudan ayrılma dahil. Bileşen
// testlerinde görünmüyordu ÇÜNKÜ onlar `fetch`i taklit ediyor. Bu, "testte
// yeşil, üründe kırık" sınıfının ta kendisidir.
//
// ════════════════════════════════════════════════════════════════════════════
// KORUNAN DEĞİŞMEZLER
// ════════════════════════════════════════════════════════════════════════════
// 1. Güvenli metotlar (GET/HEAD/OPTIONS) CSRF jetonu İSTEMEZ ve ek istek ATMAZ.
// 2. Mutasyon CSRF yüzünden reddedilirse jeton alınır ve istek BİR kez tekrarlanır.
// 3. Jeton önbelleğe alınır — sonraki mutasyonlar fazladan tur ATMAZ.
// 4. YETKİ kaynaklı 403 (ör. "Missing permission") TEKRARLANMAZ ve
//    GİZLENMEZ. CSRF onarımı bir yetkilendirme atlatma yoluna dönüşemez.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiFetch, resetCsrfState } from '../js/core/api-fetch.ts';

const CSRF = 'csrf-jetonu-123';

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  clone() { return json(body, status); },
} as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;

/** Cagrilardaki X-CSRF-Token basligini okur. */
function csrfHeaderOf(callIndex: number): string | null {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  if (!init?.headers) return null;
  return new Headers(init.headers).get('X-CSRF-Token');
}
const urlsCalled = () => fetchMock.mock.calls.map(c => String(c[0]));

beforeEach(() => {
  resetCsrfState();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  resetCsrfState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('apiFetch — CSRF', () => {
  it('GET jeton İSTEMEZ ve fazladan istek ATMAZ', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));

    await apiFetch('/api/servers');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(csrfHeaderOf(0)).toBeNull();
    expect(urlsCalled().some(u => u.includes('/api/csrf-token'))).toBe(false);
  });

  it('CSRF reddinde jeton alınır ve istek BİR kez tekrarlanır', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'CSRF token missing' }, 403))
      .mockResolvedValueOnce(json({ token: CSRF }))
      .mockResolvedValueOnce(json({ created: true }, 201));

    const res = await apiFetch('/api/servers/s1/channels', { method: 'POST' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlsCalled()[1]).toContain('/api/csrf-token');
    // Tekrar GERÇEKTEN jetonu taşır.
    expect(csrfHeaderOf(2)).toBe(CSRF);
    expect(res.status).toBe(201);
  });

  it('önbellekteki jeton sonraki mutasyona DOĞRUDAN iliştirilir', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'CSRF token missing' }, 403))
      .mockResolvedValueOnce(json({ token: CSRF }))
      .mockResolvedValueOnce(json({ created: true }, 201));
    await apiFetch('/api/servers/s1/channels', { method: 'POST' });

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(json({ left: true }));
    await apiFetch('/api/servers/s1/leave', { method: 'POST' });

    // Fazladan tur YOK: tek istek, jeton üstünde.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(csrfHeaderOf(0)).toBe(CSRF);
  });

  it('YETKİ 403\'ü tekrarlanmaz ve olduğu gibi çağırana döner', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Missing permission: MANAGE_CHANNELS' }, 403));

    const res = await apiFetch('/api/servers/s1/channels', { method: 'POST' });

    // TEK istek — CSRF onarımı yetki reddini maskelemez.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlsCalled().some(u => u.includes('/api/csrf-token'))).toBe(false);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Missing permission: MANAGE_CHANNELS' });
  });

  it('jeton alınamazsa ÖZGÜN 403 dürüstçe döner (sessiz başarı yok)', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'CSRF token missing' }, 403))
      .mockResolvedValueOnce(json({}, 500));           // jeton ucu düştü

    const res = await apiFetch('/api/servers/s1/leave', { method: 'POST' });

    expect(fetchMock).toHaveBeenCalledTimes(2);        // tekrar DENENMEZ
    expect(res.status).toBe(403);
  });

  it('yanıt gövdesi çağıran için TÜKETİLMEZ (klonlanarak incelenir)', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Missing permission: MANAGE_SERVER' }, 403));

    const res = await apiFetch('/api/servers/s1/channels', { method: 'POST' });

    // 403 sebebi okunmus olmasina ragmen gövde hâlâ okunabilir olmalı.
    expect(await res.json()).toMatchObject({ error: 'Missing permission: MANAGE_SERVER' });
  });
});
