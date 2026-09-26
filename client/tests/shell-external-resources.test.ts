// client/tests/shell-external-resources.test.ts
//
// ÜRÜN KABUĞU — HARİCİ ÇALIŞMA-ZAMANI KAYNAKLARI
//
// ════════════════════════════════════════════════════════════════════════════
// BU DOSYA NEYİN YERİNE GEÇTİ (İÇİ BOŞ TEST)
// ════════════════════════════════════════════════════════════════════════════
// Önceki test `startup-dependency-nonblocking.test.ts` şunu iddia ediyordu:
//
//     const tag = html.match(/<script[^>]+mediasoup-client[^>]*>/)?.[0] ?? '';
//     expect(tag).toContain(' async ');
//
// İddia DOĞRUYDU ve test YEŞİLDİ — ama ölçtüğü şey, KALICI OLARAK 404 DÖNEN
// bir URL'nin yükleme ÖZNİTELİĞİYDİ:
//
//     GET https://cdn.jsdelivr.net/npm/mediasoup-client@3/dist/mediasoup-client.min.js
//     → HTTP 404 | Content-Type: text/plain | X-Content-Type-Options: nosniff
//     (3/3 tekrarlanabilir)
//
// Yani betik HİÇBİR tarayıcıda HİÇBİR ZAMAN yüklenmedi. Test, var olmayan bir
// kaynağın "engellemeyen" biçimde yüklenmediğini doğruluyordu. Bu, tam olarak
// içi boş test tanımıdır: yeşil kalırken özellik tamamen ölüydü.
//
// Firefox bunu konsola MIME hatası olarak yazıyordu; Chromium sessizce
// yutuyordu — kusuru çapraz-tarayıcı koşusu ortaya çıkardı.
//
// ── BUGÜNKÜ CANONICAL ÇÖZÜM ─────────────────────────────────────────────
// mediasoup-client artık npm dependency'sidir ve `webrtc-sfu.ts` ESM `Device`
// import'u kullanır. Kabuk CDN/global yüklemez; tek RTC owner `webrtc.ts`,
// SFU engine factory ise server capability negotiation sonrasında seçilir.
//
// ── BU TESTİN ÖLÇTÜĞÜ GERÇEK DEĞİŞMEZ ──────────────────────────────────────
// Kabuk, üçüncü-taraf bir kaynaktan ÇALIŞMA ZAMANINDA kod çalıştırmamalıdır.
// Böyle bir kaynak eklenirse SRI (`integrity`) taşımak ZORUNDADIR — aksi
// halde CDN'i ele geçiren biri her Bridge oturumunda kod çalıştırabilir.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHELLS = ['index.html', 'index.dist.html'];
const read = (f: string) => readFileSync(resolve(process.cwd(), f), 'utf8');

/** Yorumları soyar: açıklamada anılan URL GERÇEK etiket sayılmamalı. */
function codeOnly(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Kabuktaki mutlak (http/https) kaynak referansları. */
function externalRefs(html: string): string[] {
  const out: string[] = [];
  const re = /<(script|link|iframe|img)\b[^>]*\b(?:src|href)\s*=\s*"(https?:\/\/[^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[0]);
  return out;
}

describe.each(SHELLS)('%s — harici çalışma-zamanı kaynakları', (shell) => {
  const html = codeOnly(read(shell));

  it('ÜÇÜNCÜ-TARAF çalışma-zamanı kaynağı YOK', () => {
    // Asil degismez: kabuk yalnizca birinci-parti kod calistirir.
    expect({ shell, external: externalRefs(html) }).toEqual({ shell, external: [] });
  });

  it('harici kaynak eklenirse SRI ZORUNLU', () => {
    // Bugun bos; yarin biri CDN eklerse bu test SRI'siz olani yakalar.
    const unprotected = externalRefs(html).filter(
      (tag) => !/\bintegrity\s*=/.test(tag) || !/\bcrossorigin\s*=/.test(tag),
    );
    expect({ shell, unprotected }).toEqual({ shell, unprotected: [] });
  });

  it('ÖLÜ mediasoup CDN etiketi geri GELMEDİ', () => {
    // Tam URL uzerinde gerileme kilidi: 404 donduren adres.
    expect(html).not.toContain('cdn.jsdelivr.net/npm/mediasoup-client');
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  it('kabuk GERÇEKTEN birinci-parti betik yüklüyor', () => {
    // Bu olmadan yukaridaki uc test BOS/EKSIK bir dosyada da yesil kalirdi.
    const firstParty = html.match(/<script\b[^>]*\bsrc\s*=\s*"(?!https?:)[^"]+"/gi) ?? [];
    expect({ shell, hasFirstPartyScripts: firstParty.length > 0 }).toEqual({
      shell, hasFirstPartyScripts: true,
    });
  });
});
