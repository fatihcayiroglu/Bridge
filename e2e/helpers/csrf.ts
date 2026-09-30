// e2e/helpers/csrf.ts — TEK kanonik CSRF token önbelleği.
//
// Sunucu kullanıcı BAŞINA TEK bir CSRF token saklar ve `/api/csrf-token`
// her çağrıldığında öncekini EZER (server/lib/security.ts generateCsrfToken).
// Bu yüzden birden fazla bağımsız önbellek olamaz: ikinci önbellek token
// alınca birincisininki geçersizleşir ve istekler
// `403 CSRF token invalid or expired` ile düşer.
//
// Tüm E2E yardımcıları bu modülü kullanmalıdır.

import type { APIRequestContext } from '@playwright/test';

const BASE = () => process.env.BASE_URL || 'http://127.0.0.1:3000';
const cache = new Map<string, string>();

/** Bearer için geçerli CSRF token döndürür (gerekirse alır ve önbelleğe koyar). */
export async function getCsrf(request: APIRequestContext, bearer: string): Promise<string> {
  const cached = cache.get(bearer);
  if (cached) return cached;
  return refreshCsrf(request, bearer);
}

/** Önbelleği atlayıp yeni token alır — 403 sonrası yeniden deneme için. */
export async function refreshCsrf(request: APIRequestContext, bearer: string): Promise<string> {
  const res = await request.get(`${BASE()}/api/csrf-token`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok()) return '';
  const body = await res.json() as { token?: string; csrfToken?: string };
  const token = body.token || body.csrfToken || '';
  if (token) cache.set(bearer, token);
  return token;
}

/** Bir token'ın artık geçersiz olduğunu bildirir. */
export function invalidateCsrf(bearer: string): void {
  cache.delete(bearer);
}

/** Önbellekteki token (varsa) — getirmeden. */
export function cachedCsrf(bearer: string): string | undefined {
  return cache.get(bearer);
}

/** Sunucunun CSRF reddi mi? (yetki 403'ünden ayırt etmek için gövdeye bakılır) */
export async function isCsrfRejection(res: { status(): number; text(): Promise<string> }): Promise<boolean> {
  if (res.status() !== 403) return false;
  const body = await res.text().catch(() => '');
  return /"error"\s*:\s*"CSRF token (invalid or expired|missing)"/.test(body);
}
