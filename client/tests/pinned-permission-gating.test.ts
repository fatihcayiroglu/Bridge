// client/tests/pinned-permission-gating.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SABİTLEME YETKİSİ GÖRÜNÜRLÜK SİNYALİ — canManageMessages BİT MANTIĞI
// ════════════════════════════════════════════════════════════════════════════
// Sabitleme UI'si (mesaj menüsündeki Sabitle/Kaldır ve panel unpin) yalnızca
// MANAGE_MESSAGES kanıtlanınca gösterilir. Bu sinyal yanlışsa ya ölü kontrol
// (yetkisiz kullanıcıya) ya da eksik kontrol (yetkiliye) doğar. Gerçek modülü
// (mock DEĞİL) test ederiz; yalnızca ağ sınırını sahteleriz.
//
// Diğer testler `myPermissions`i TÜMÜYLE mock'luyordu; bit mantığını hiçbiri
// doğrulamıyordu. Bu test o boşluğu kapatır ve ayırt edicidir: MANAGE_MESSAGES
// bitini (1<<9) yanlış okumak ya da ADMINISTRATOR kapsamını kaçırmak testi düşürür.
import { describe, it, expect, beforeEach, vi } from 'vitest';

let permsBody: unknown = { permissions: 0 };
let okStatus = true;

vi.mock('../js/core/globals.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../js/core/globals.ts')>()), getAPI: () => 'http://test.local' }));
vi.mock('../js/core/api-fetch.ts', () => ({
  apiFetch: vi.fn(async () => ({
    ok: okStatus,
    status: okStatus ? 200 : 403,
    json: async () => permsBody,
  })),
}));

import {
  canManageMessages, clearPermsCache,
  PERM_MANAGE_MESSAGES, PERM_ADMINISTRATOR,
} from '../js/core/permissions/myPermissions.ts';

beforeEach(() => { clearPermsCache(); okStatus = true; permsBody = { permissions: 0 }; });

describe('canManageMessages — MANAGE_MESSAGES (1<<9) bit sinyali', () => {
  it('bit değeri 1<<9 sözleşmeye uyar', () => {
    expect(PERM_MANAGE_MESSAGES).toBe(1 << 9);   // arka uç PERMS.MANAGE_MESSAGES ile aynı
  });

  it('MANAGE_MESSAGES biti VARSA true', async () => {
    permsBody = { permissions: PERM_MANAGE_MESSAGES };
    expect(await canManageMessages('srv-1')).toBe(true);
  });

  it('MANAGE_MESSAGES biti YOKSA false (ölü kontrol gösterilmez)', async () => {
    permsBody = { permissions: (1 << 1) | (1 << 2) };  // başka yetkiler, pin yok
    expect(await canManageMessages('srv-2')).toBe(false);
  });

  it('ADMINISTRATOR her biti kapsar — MANAGE_MESSAGES olmasa da true', async () => {
    permsBody = { permissions: PERM_ADMINISTRATOR };
    expect(await canManageMessages('srv-3')).toBe(true);
  });

  it('yetkisiz/hatalı yanıt → fail-closed (false)', async () => {
    okStatus = false;                                  // 403
    permsBody = { permissions: PERM_MANAGE_MESSAGES }; // gövde umursanmaz
    expect(await canManageMessages('srv-4')).toBe(false);
  });

  it('bozuk gövde (permissions sayı değil) → fail-closed (false)', async () => {
    permsBody = { permissions: 'yes' };
    expect(await canManageMessages('srv-5')).toBe(false);
  });
});
