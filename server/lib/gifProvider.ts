// server/lib/gifProvider.ts
//
// GIF SAGLAYICI — SAGLAYICIDAN BAGIMSIZ SOYUTLAMA
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK BOSLUKLAR
// ════════════════════════════════════════════════════════════════════════════
// `routes/media.ts` icindeki iki uc dogru mimariyi kuruyordu (tarayici →
// Bridge → saglayici; anahtar sunucuda kalir) ama dort eksigi vardi:
//
//   1. HIZ SINIRI YOKTU. Diger tum uclar `limits.*()` kullanirken bu ikisi
//      yalnizca `authMiddleware` tasiyordu. Kimligi dogrulanmis bir kullanici
//      Bridge uzerinden saglayiciya sinirsiz istek surebilir; bu, KOTA
//      TUKETIMI ve FATURA anlamina gelir.
//
//   2. SAGLAYICI YANITI HAM GECIYORDU (`res.json(data)`). Istemci, Tenor'un
//      yanit semasina baglaniyordu ve yukaridan gelen KEYFI alanlar oldugu
//      gibi aktariliyordu.
//
//   3. SAGLAYICI SOYUTLAMASI YOKTU. Tenor URL'leri rota govdesine gomuluydu;
//      saglayici degistirmek urun mantigini degistirmeyi gerektirirdi.
//
//   4. YUKARI AKIS HATASI ELE ALINMIYORDU. Tenor 4xx/5xx donerse `r.json()`
//      ya patlar ya da hata govdesi SONUC gibi istemciye geciyordu.
//
// ── GUVENLIK KARARLARI ────────────────────────────────────────────────────
// · Cikti NORMALIZE edilir: yalnizca bilinen alanlar, yalnizca beklenen
//   tiplerde. Bilinmeyen alanlar DUSURULUR.
// · Medya URL'leri yalnizca HTTPS ve saglayicinin BILINEN alan adlarindan
//   kabul edilir. Boylece yukari akis ele gecse bile keyfi bir kaynak
//   istemciye enjekte edilemez.
// · HTML/markup ASLA tasinmaz — yalnizca URL ve olcu alanlari.

import { fetchT } from './fetch';
import logger from './logger';

/** Normalize edilmis, saglayicidan bagimsiz GIF kaydi. */
export interface GifItem {
  id: string;
  /** Oynatilabilir GIF/MP4 URL'si. */
  url: string;
  /** Kucuk onizleme URL'si. */
  previewUrl: string;
  width: number;
  height: number;
  /** Erisilebilirlik icin aciklama; saglayici vermezse bos. */
  description: string;
}

export interface GifSearchResult {
  items: GifItem[];
  provider: string;
}

/** Saglayici sozlesmesi — yeni saglayici eklemek urun mantigini degistirmez. */
export interface GifProvider {
  readonly name: string;
  /** Yapilandirilmis mi (anahtar var mi). */
  isConfigured(): boolean;
  search(query: string, limit: number): Promise<GifItem[]>;
  trending(limit: number): Promise<GifItem[]>;
}

/** Sonuc sayisi ust siniri — istemci daha fazlasini isteyemez. */
export const GIF_MAX_LIMIT = 24;
/** Sorgu uzunlugu ust siniri. */
export const GIF_MAX_QUERY = 100;
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Yalnizca bu alan adlarindan gelen medya kabul edilir. */
const TENOR_MEDIA_HOSTS = new Set([
  'media.tenor.com',
  'media1.tenor.com',
  'media2.tenor.com',
  'c.tenor.com',
]);

/**
 * URL guvenlik suzgeci.
 *
 * Yukari akis ele gecirilse bile istemciye keyfi bir kaynak (baska bir alan
 * adi, `javascript:`, `data:`) enjekte EDILEMEZ.
 */
function safeMediaUrl(raw: unknown, allowedHosts: Set<string>): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!allowedHosts.has(u.hostname)) return null;
  return u.toString();
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 200) : '';
}

/** Tenor v2 yanitini NORMALIZE eder. Bilinmeyen alanlar dusurulur. */
function normalizeTenor(payload: unknown): GifItem[] {
  const results = (payload as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];

  const items: GifItem[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const mediaFormats = r.media_formats;
    const formats = mediaFormats && typeof mediaFormats === 'object' && !Array.isArray(mediaFormats)
      ? mediaFormats as Record<string, Record<string, unknown> | null | undefined>
      : {};
    const gif = formats.gif ?? formats.mediumgif ?? {};
    const preview = formats.tinygif ?? formats.nanogif ?? gif;

    const url = safeMediaUrl(gif.url, TENOR_MEDIA_HOSTS);
    const previewUrl = safeMediaUrl(preview.url, TENOR_MEDIA_HOSTS);
    if (!url || !previewUrl) continue;          // guvenli degilse ATLA

    const dims = Array.isArray(gif.dims) ? gif.dims : [];
    items.push({
      id: text(r.id) || url,
      url,
      previewUrl,
      width: num(dims[0], 0),
      height: num(dims[1], 0),
      description: text(r.content_description),
    });
  }
  return items;
}

class TenorProvider implements GifProvider {
  readonly name = 'tenor';

  isConfigured(): boolean { return Boolean(process.env.TENOR_API_KEY); }

  private async call(url: string): Promise<GifItem[]> {
    const res = await fetchT(url, { timeoutMs: UPSTREAM_TIMEOUT_MS });
    // YUKARI AKIS HATASI sonuc gibi gecemez.
    if (!res.ok) {
      logger.warn({ event: 'gif.upstream_error', provider: this.name, status: res.status },
        'GIF saglayicisi hata dondu');
      return [];
    }
    let payload: unknown;
    try { payload = await res.json(); }
    catch (err) {
      logger.warn({ event: 'gif.upstream_bad_json', provider: this.name, err }, 'GIF yaniti cozulemedi');
      return [];
    }
    return normalizeTenor(payload);
  }

  async search(query: string, limit: number): Promise<GifItem[]> {
    const key = process.env.TENOR_API_KEY!;
    const url = `https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(key)}`
      + `&q=${encodeURIComponent(query)}&limit=${limit}&media_filter=gif,tinygif&contentfilter=medium`;
    return this.call(url);
  }

  async trending(limit: number): Promise<GifItem[]> {
    const key = process.env.TENOR_API_KEY!;
    const url = `https://tenor.googleapis.com/v2/featured?key=${encodeURIComponent(key)}`
      + `&limit=${limit}&media_filter=gif,tinygif&contentfilter=medium`;
    return this.call(url);
  }
}

/**
 * Etkin saglayici.
 *
 * Bugun tek uygulama Tenor'dur; onemli olan URUN MANTIGININ saglayiciyi
 * bilmemesidir. Ikinci bir saglayici eklemek yalnizca burayi degistirir.
 */
export function activeGifProvider(): GifProvider {
  return new TenorProvider();
}

/** Istemciden gelen limit degerini guvenli araliga kelepceler. */
export function clampGifLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), GIF_MAX_LIMIT);
}
