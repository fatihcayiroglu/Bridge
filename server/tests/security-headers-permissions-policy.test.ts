// server/tests/security-headers-permissions-policy.test.ts
// Permissions-Policy — mikrofon/kamera birinci taraf sözleşmesi.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// `lib/security.ts` şu başlığı yayınlıyordu:
//     Permissions-Policy: camera=(), microphone=(), geolocation=()
// BOŞ allowlist `()` yalnızca üçüncü tarafları değil, KAYNAĞIN KENDİSİNİ de
// reddeder. Bu yüzden üst düzey Bridge dokümanı `getUserMedia()` çağırdığında
// Chrome şunu veriyordu:
//     [Violation] Permissions policy violation:
//     microphone is not allowed in this document.
// Site izni "Allow", `isSecureContext` true ve `navigator.mediaDevices` mevcut
// olmasına rağmen sesli sohbet HİÇBİR tarayıcıda çalışamıyordu.
//
// Bridge'de ses (P2P voice) ve görüntü birinci taraf v1 özellikleridir, bu
// yüzden doğru sözleşme `(self)`tir — `*` DEĞİL.
//
// Bu paket GERÇEK middleware'i çalıştırır; kopya/klon yoktur.

import type { Request, Response, NextFunction } from 'express';
import { securityHeaders } from '../lib/security';

/** securityHeaders'ı çalıştırıp yazılan başlıkları toplar. */
function runMiddleware(): { headers: Record<string, string>; nextCalled: boolean } {
  const headers: Record<string, string> = {};
  let nextCalled = false;

  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
  } as unknown as Response;

  securityHeaders({} as Request, res, (() => { nextCalled = true; }) as NextFunction);
  return { headers, nextCalled };
}

function permissionsPolicy(): string {
  return runMiddleware().headers['Permissions-Policy'] ?? '';
}

describe('Permissions-Policy — mikrofon birinci taraf sözleşmesi', () => {
  it('A: mikrofon KENDİ kaynağa izinlidir (self)', () => {
    expect(permissionsPolicy()).toMatch(/microphone=\(self\)/);
  });

  it('A2: mikrofon TÜMDEN reddedilmiş DEĞİLDİR', () => {
    // Asıl hata buydu: `microphone=()` self dahil her şeyi reddeder.
    expect(permissionsPolicy()).not.toMatch(/microphone=\(\)/);
  });

  it('B: GÜVENLİK — mikrofon joker (*) ile açılmaz', () => {
    // `*` üçüncü taraf iframe'lere de mikrofon verirdi.
    expect(permissionsPolicy()).not.toMatch(/microphone=\*/);
    expect(permissionsPolicy()).not.toMatch(/microphone=\(\s*\*\s*\)/);
  });

  it('kamera da birinci taraf video için self’tir, joker değildir', () => {
    const p = permissionsPolicy();
    expect(p).toMatch(/camera=\(self\)/);
    expect(p).not.toMatch(/camera=\*/);
  });

  it('kullanılmayan yetenek (geolocation) REDDEDİLMEYE devam eder', () => {
    expect(permissionsPolicy()).toMatch(/geolocation=\(\)/);
  });
});

describe('Permissions-Policy — ilgisiz güvenlik başlıkları korunur', () => {
  it('C: mevcut güvenlik başlıkları hâlâ yayınlanır', () => {
    const { headers } = runMiddleware();

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBeDefined();
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['X-XSS-Protection']).toBeDefined();
  });

  it('middleware zinciri devam ettirir (next çağrılır)', () => {
    expect(runMiddleware().nextCalled).toBe(true);
  });
});
