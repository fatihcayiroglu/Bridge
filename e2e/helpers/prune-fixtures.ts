// e2e/helpers/prune-fixtures.ts
//
// E2E FIKSTUR TEMIZLIGI — BIRIKEN SUNUCULARI BUDAR
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK KUSUR (TEST_ISOLATION_DEFECT)
// ════════════════════════════════════════════════════════════════════════════
// Cok sayida spec `beforeAll` icinde alice adina yeni bir test sunucusu
// olusturuyor ve HICBIRI silmiyordu. Bridge'in urun siniri kullanici basina
// `MAX_SERVERS_PER_USER` (varsayilan 100) sunucudur.
//
// OLCULDU: alice TAM OLARAK 100 sunucuya ulasmisti.
//   POST /api/servers → 400 "Server creation limit reached (max 100)"
//   → `createTestServer` null dondu
//   → `beforeAll` bos id yazdi
//   → bagimli TUM testler dustu
//
// Belirti yaniltiyordu: `keyboard-journeys` IZOLE kosumda bile dusuyordu ve
// hata `locator('.server-icon[data-id=""]')` — yani BOS id — seklindeydi.
// Bu, "ortam cekismesi" gibi gorunen basarisizliklarin buyuk bolumunu
// aciklar; sorun kalici fikstur birikimiydi.
//
// ── NEDEN GUVENLI ─────────────────────────────────────────────────────────
// · Yalnizca E2E kimliklerinin SAHIP OLDUGU sunucular silinir.
// · Urunun KENDI `DELETE /api/servers/:sid` ucu kullanilir — dogrudan DB
//   mudahalesi YOK, sema/yetki atlanmaz.
// · Gercek kullanici verisi ETKILENMEZ: bu hesaplar global setup tarafindan
//   olusturulan tek kullanimlik test kimlikleridir.
// · Urun siniri DEGISTIRILMEZ; `MAX_SERVERS_PER_USER` oldugu gibi kalir.

import type { APIRequestContext } from '@playwright/test';
import { getCsrf } from './csrf';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface ServerRow { _id?: string; id?: string; name?: string; ownerId?: string }

/**
 * Bir E2E kimliginin sahip oldugu sunucu sayisini `keep` degerine indirir.
 *
 * @param keep Birakilacak sunucu sayisi. Kucuk bir tampon birakmak, halen
 *   kosan baska bir paketin fikstur'unu sertce cekip almayi onler.
 */
export async function pruneOwnedServers(
  request: APIRequestContext,
  token: string,
  userId: string,
  keep = 5,
): Promise<{ before: number; deleted: number; after: number }> {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': UA };
  // DELETE bir MUTASYONDUR ve sunucu CSRF token ister (olculdu: 403
  // "CSRF token missing"). Koruma ATLANMAZ — kanonik yardimci kullanilir.
  const csrf = await getCsrf(request, token);
  const mutateHeaders = { ...headers, 'X-CSRF-Token': csrf };

  const listRes = await request.get(`${BASE}/api/servers`, { headers });
  if (!listRes.ok()) return { before: -1, deleted: 0, after: -1 };
  const all = (await listRes.json()) as ServerRow[];
  if (!Array.isArray(all)) return { before: -1, deleted: 0, after: -1 };

  // YALNIZCA sahibi bu kimlik olanlar. Baskasinin sunucusundan cikmak
  // (uyelik) silme DEGILDIR ve burada yapilmaz.
  const owned = all.filter(s => !s.ownerId || s.ownerId === userId);
  const excess = owned.slice(0, Math.max(0, owned.length - keep));

  let deleted = 0;
  for (const s of excess) {
    const id = s._id ?? s.id;
    if (!id) continue;
    const del = await request.delete(`${BASE}/api/servers/${id}`, { headers: mutateHeaders });
    if (del.ok()) deleted++;
    // Silme ucu `limits.servers()` ile hiz sinirlidir; sinira carpinca DUR.
    if (del.status() === 429) break;
  }

  const afterRes = await request.get(`${BASE}/api/servers`, { headers });
  const after = afterRes.ok() ? ((await afterRes.json()) as ServerRow[]).length : -1;
  return { before: all.length, deleted, after };
}

/** JWT govdesinden kullanici kimligi — yalnizca fikstur sahipligi icin. */
export function userIdOf(token: string): string {
  try {
    const body = token.split('.')[1] ?? '';
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return String(JSON.parse(json).id ?? '');
  } catch { return ''; }
}
