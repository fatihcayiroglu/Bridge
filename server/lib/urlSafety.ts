// server/lib/urlSafety.ts
//
// GIDEN ISTEK HEDEFI GUVENLIGI — SSRF SAVUNMASI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK ACIK
// ════════════════════════════════════════════════════════════════════════════
// Giden webhook URL'si yalnizca SOZDIZIMSEL olarak dogrulaniyordu:
//
//     try { new URL(url); } catch { return res.status(400)... }
//
// `new URL()` bir adresin GUVENLI oldugunu SOYLEMEZ; yalnizca ayristirilabilir
// oldugunu soyler. Bu dogrulamayi gecen adresler arasinda sunlar vardi:
//
//     http://127.0.0.1:5433/            → yerel PostgreSQL
//     http://169.254.169.254/latest/…   → bulut metadata (KIMLIK BILGISI)
//     http://10.0.0.5/admin             → ic ag
//     http://[::1]:6379/                → yerel Redis
//
// Ardindan `fetchT(webhook.url, { method: 'POST' })` bu adrese Bridge'in AG
// KONUMUNDAN istek gonderiyordu. Yani webhook olusturabilen biri Bridge'i ic
// aga yonelik bir VEKIL olarak kullanabilirdi.
//
// Bridge KENDI SUNUCUNDA barindirilabilir; sunucu yoneticisi ile altyapi
// sahibi ayni kisi OLMAYABILIR. Bu yuzden hedef kisitlamasi urunun isidir.
//
// ── BILINEN SINIR ─────────────────────────────────────────────────────────
// DNS YENIDEN BAGLAMA (rebinding) burada TAMAMEN cozulmez: bir alan adi
// dogrulama aninda genel bir IP'ye, istek aninda ozel bir IP'ye cozulebilir.
// Tam koruma, cozulen IP'yi baglantiya SABITLEMEYI (pinning) gerektirir ve
// ozel bir HTTP agent ister. Buradaki denetim iki yerde birden yapilir
// (olusturma + teslimat) ve literal IP'ler ile cozulen adresleri kapsar;
// kalan risk bilerek kayit altindadir.

import { promises as dns } from 'dns';
import net from 'net';

/**
 * Ic aga cikmaya ACIKCA izin verildi mi?
 *
 * Kendi sunucusunda barindiran ve gercekten ic servise webhook gonderen
 * kurulumlar icin kacis kapisi. VARSAYILAN KAPALIDIR: guvenli taraf.
 */
function internalTargetsAllowed(): boolean {
  return process.env.ALLOW_INTERNAL_WEBHOOKS === 'true';
}

/** Yalnizca bu protokoller. `file:`, `gopher:`, `ftp:` vb. reddedilir. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface UrlCheck {
  ok: boolean;
  /** Reddedilme sebebi — kullaniciya gosterilebilecek kadar genel. */
  reason?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// TEK KANONIK ADRES DENETIMI — IKI AYRI UYGULAMA TUTULMAZ
// ════════════════════════════════════════════════════════════════════════════
// Bu dosyada ONCE ayri bir IPv4/IPv6 denetimi vardi ve `lib/fetch.ts`teki
// denetimden FARKLIYDI. Iki uygulamanin AYRISMASI gercek bir aciga yol acti:
//
//   POST /api/servers/:sid/outgoing-webhooks
//     url = http://[::ffff:127.0.0.1]:5433/   → 201 OLUSTURULDU
//     url = http://[::ffff:10.0.0.5]/         → 201 OLUSTURULDU
//     url = http://[64:ff9b::7f00:1]/         → 201 OLUSTURULDU
//   ayni hedeflerin duz yazimlari (127.0.0.1, 10.0.0.5) DOGRU sekilde 400 idi.
//
// KOK SEBEP: buradaki IPv6 denetimi `::ffff:` sonrasini NOKTALI IPv4 olarak
// ariyordu (`/::ffff:(\d+\.\d+\.\d+\.\d+)$/`). Oysa WHATWG URL ayristiricisi
// adresi NORMALLESTIRIR:
//
//     new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'
//
// Yani noktali form URL'den GELMEZ; o dal fiilen OLU KODDU. `lib/fetch.ts`
// ayni adresi dogru sekilde ozel sayiyordu — yani iki katman AYNI FIKIRDE
// DEGILDI ve zayif olan, dogrulamayi yapan katmandi.
//
// COZUM: tek kanonik uygulama. `lib/fetch.ts` adresi 16 BAYTA cozup aralik
// denetimi yapar; yazim bicimi (noktali, hex, genisletilmis, bolge ekli)
// artik sonucu degistirmez. Burasi ona DELEGE eder — kopyalanmis ikinci bir
// mantik BILEREK birakilmadi.
import { isPrivateIP as canonicalIsPrivateIP } from './fetch';

export function isPrivateAddress(ip: string): boolean {
  // Taniyamadigimiz girdi → guvenli taraf (fail-closed).
  if (!net.isIP(ip.replace(/^\[|\]$/g, ''))) return true;
  return canonicalIsPrivateIP(ip.replace(/^\[|\]$/g, ''));
}

/**
 * Giden istek hedefini dogrular.
 *
 * FAIL-CLOSED: emin olamadigimiz her durumda REDDEDER.
 */
export async function checkOutboundUrl(raw: unknown): Promise<UrlCheck> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'URL gerekli' };
  }

  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'Geçersiz URL' }; }

  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return { ok: false, reason: 'Yalnızca http/https adresleri kullanılabilir' };
  }

  if (internalTargetsAllowed()) return { ok: true };

  const host = u.hostname.replace(/^\[|\]$/g, '');

  // Literal IP ise dogrudan denetle — DNS'e hic gitme.
  if (net.isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: 'Özel/yerel ağ adresleri hedef olamaz' }
      : { ok: true };
  }

  // Bilinen yerel adlar.
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return { ok: false, reason: 'Özel/yerel ağ adresleri hedef olamaz' };
  }

  // Alan adi: cozulen TUM adresler genel olmali.
  try {
    const resolved = await dns.lookup(host, { all: true });
    if (!resolved.length) return { ok: false, reason: 'Adres çözümlenemedi' };
    if (resolved.some(r => isPrivateAddress(r.address))) {
      return { ok: false, reason: 'Özel/yerel ağ adresleri hedef olamaz' };
    }
  } catch {
    return { ok: false, reason: 'Adres çözümlenemedi' };
  }

  return { ok: true };
}
