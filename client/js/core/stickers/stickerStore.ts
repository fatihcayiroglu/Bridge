// client/js/core/stickers/stickerStore.ts
// FAZ C3 — STICKER PAKETLERİ: TEK KANONİK KONTROLCÜ.
//
// ════════════════════════════════════════════════════════════════════════════
// ARKA UÇ SÖZLEŞMESİ (okundu, varsayılmadı — routes/sticker-packs.ts)
// ════════════════════════════════════════════════════════════════════════════
//   GET    /api/servers/:sid/sticker-packs                    → StickerPack[]
//          yetki: VIEW_CHANNELS
//   POST   /api/servers/:sid/sticker-packs                    → 201 StickerPack
//          multipart: `sticker` (≤50 dosya) + name + description
//          yetki: MANAGE_SERVER
//   DELETE /api/servers/:sid/sticker-packs/:packId            → 204
//          yetki: MANAGE_SERVER  ·  (packId + serverId) ile kiracı doğrulanır
//   PATCH  /api/servers/:sid/sticker-packs/:packId/stickers/:stickerId
//          gövde: { name?, tags? }   yetki: MANAGE_SERVER
//
// Paket şekli: { _id, serverId, name, description, authorId, stickers[], createdAt }
// Sticker şekli: { id, packId, name, url, tags[], width, height }
//
// ════════════════════════════════════════════════════════════════════════════
// P3 MESSAGE CONTRACT
// ════════════════════════════════════════════════════════════════════════════
// Gönderim owner'ı MessageInputPanel'dir. Bu store yalnız server-scoped asset
// listesini normalize eder; gönderimde packId+stickerId server tarafından tekrar
// doğrulanır ve mesaj satırına immutable safe snapshot yazılır. Asset byte'ları
// hiçbir zaman kopyalanmaz, dönüştürülmez veya yeniden encode edilmez.
//
// GÜVENLİK: bu kontrolcü HTML ÜRETMEZ. Paket/sticker adları ve etiketleri
// KULLANICI DENETİMİNDEDİR; yalnız tipli veri yayılır, render Svelte'in metin
// enterpolasyonuyla yapılır.

import { getCurrentServerFromRegistry, isStillCurrentServer } from '../server-settings/stores/serverSettingsStore';
import { safeApiErrorMessage } from '../api-error.ts';
import { t } from '../i18n/index.ts';

export interface Sticker {
  id:     string;
  packId: string;
  name:   string;
  url:    string;
  tags:   string[];
  width:  number;
  height: number;
}

export interface StickerPack {
  _id:         string;
  serverId:    string;
  name:        string;
  description: string;
  authorId:    string;
  stickers:    Sticker[];
  createdAt:   number;
}

/**
 * GÜVENLİK — STICKER URL BEYAZ LİSTESİ.
 *
 * Arka uç URL'yi `/uploads/stickers/<dosya>` olarak kendisi kurar
 * (routes/sticker-packs.ts:267). Buna rağmen istemci gelen değeri KANIT
 * saymaz: `javascript:` / `data:` / `//baska-site` gibi bir değer bir gün
 * veriye girerse `<img src>` üzerinden izleme veya daha kötüsü mümkün olurdu.
 *
 * Kural: yalnız TEK eğik çizgiyle başlayan, protokolsüz ve şema-görecesi
 * olmayan `/uploads/stickers/...` yolları kabul edilir. Kabul edilmeyen her
 * şey ELENİR (fail-closed) — sticker gösterilmez.
 */
export function isSafeStickerUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  // Sunucu dosya adini UUID + kanonik uzanti olarak uretir. Yalniz bu kokte
  // tek, ASCII bir dosya segmenti kabul etmek; `%2e%2e`, ters egik cizgi,
  // sorgu/hash ve URL-cozucu tarafindan yeniden yorumlanabilecek bicimleri de
  // kapatir. Tarihsel paketlerin basit `bir.png` adlari da uyumludur.
  return /^\/uploads\/stickers\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(u)
    && !u.includes('..');
}

function safeDimension(value: unknown): number {
  const dimension = Number(value);
  return Number.isSafeInteger(dimension) && dimension > 0 && dimension <= 4096
    ? dimension
    : 160;
}

/** Sunucudan gelen ham veriyi tipli ve GÜVENLİ hâle indirger. */
function normalizeSticker(raw: unknown, packId: string): Sticker | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id  = String(r.id ?? '');
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!id || !isSafeStickerUrl(url)) return null;   // güvensiz URL → ELENİR
  return {
    id,
    // Kapsayici paket kimligi kanoniktir; yanittaki yabanci `packId` bir
    // sticker'i baska kiraci/paket kimligine baglayamaz.
    packId,
    name:   String(r.name ?? ''),
    url,
    tags:   Array.isArray(r.tags) ? r.tags.map(t => String(t)) : [],
    width:  safeDimension(r.width),
    height: safeDimension(r.height),
  };
}

function normalizePack(raw: unknown): StickerPack | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r._id ?? '');
  if (!id) return null;
  return {
    _id:         id,
    serverId:    String(r.serverId ?? ''),
    name:        String(r.name ?? ''),
    description: String(r.description ?? ''),
    authorId:    String(r.authorId ?? ''),
    stickers:    Array.isArray(r.stickers)
      ? r.stickers.map(s => normalizeSticker(s, id)).filter((s): s is Sticker => s !== null)
      : [],
    createdAt:   Number(r.createdAt) || 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// YÜKLEME SINIRLARI — arka uçtan BİREBİR yansıtılır (routes/sticker-packs.ts)
// ════════════════════════════════════════════════════════════════════════════
// Bunlar GÜVENLİK DEĞİL, KULLANILABİLİRLİK içindir: kullanıcı 40 MB'lık bir
// dosyayı yükleyip 413 beklemesin diye önden söylenir. Yetkili sınır her zaman
// arka uçtur (multer `limits.fileSize`, `fileFilter`, `upload.array(...,50)`).
// Değerler uydurulmadı; kaynaktan okundu:
//   STICKER_MAX_SIZE      = 512 * 1024      (routes/sticker-packs.ts:81)
//   STICKER_ALLOWED_TYPES = png|webp|gif    (routes/sticker-packs.ts:82)
//   upload.array('sticker', 50)             (routes/sticker-packs.ts:232)
export const STICKER_MAX_FILES     = 50;
export const STICKER_MAX_FILE_SIZE = 512 * 1024;
export const STICKER_ACCEPTED_TYPES: ReadonlyArray<string> = ['image/png', 'image/webp', 'image/gif'];

/** Multipart alan adı — arka uçla BİREBİR aynı olmak ZORUNDA. */
export const STICKER_FILE_FIELD = 'sticker';

export type RejectReason = 'type' | 'size' | 'count';

export interface FileCheck {
  accepted: File[];
  rejected: Array<{ name: string; reason: RejectReason }>;
}

/**
 * Seçilen dosyaları arka uç sınırlarına göre AYIRIR.
 *
 * DİKKAT: `file.type` tarayıcıdan gelir ve GÜVENİLMEZ — burada yalnız
 * kullanıcıya erken geri bildirim için kullanılır. Arka uç aynı kontrolü
 * kendisi yapar ve son sözü söyler. Sessiz kırpma YAPILMAZ: sınır dışı kalan
 * her dosya gerekçesiyle birlikte döner ki arayüz kullanıcıya söyleyebilsin.
 */
export function checkStickerFiles(files: readonly File[]): FileCheck {
  const accepted: File[] = [];
  const rejected: Array<{ name: string; reason: RejectReason }> = [];

  for (const f of files) {
    if (!STICKER_ACCEPTED_TYPES.includes(f.type)) { rejected.push({ name: f.name, reason: 'type' }); continue; }
    if (f.size > STICKER_MAX_FILE_SIZE)           { rejected.push({ name: f.name, reason: 'size' }); continue; }
    if (accepted.length >= STICKER_MAX_FILES)     { rejected.push({ name: f.name, reason: 'count' }); continue; }
    accepted.push(f);
  }
  return { accepted, rejected };
}

export interface StickerSnapshot {
  serverId: string;
  packs:    StickerPack[];
  loading:  boolean;
  busy:     boolean;
  error:    string | null;
}

/**
 * Tek kontrolcü. İkinci bir sticker sahibi kurulmaz.
 */
export function createStickerController(serverId: string) {
  let packs: StickerPack[] = [];
  let loading = false;
  let busy    = false;
  let error: string | null = null;
  let loadGeneration = 0;
  let stateGeneration = 0;

  /** Bağlam hâlâ geçerli mi? Bayat sunucuya yazmayı/okumayı engeller. */
  function contextValid(): boolean {
    if (!serverId) return false;
    if (!isStillCurrentServer(serverId)) return false;
    return Boolean(getCurrentServerFromRegistry());
  }

  function fail(msg: string): false {
    error = msg;
    return false;
  }

  async function api() {
    const { apiFetch } = await import('../api-fetch.js');
    const { getAPI }   = await import('../globals.js');
    return { apiFetch, base: `${getAPI()}/api/servers/${encodeURIComponent(serverId)}/sticker-packs` };
  }

  const ctl = {
    get snapshot(): StickerSnapshot {
      return { serverId, packs, loading, busy, error };
    },

    /** Kiracı doğrulaması: paket GERÇEKTEN yüklenen listede mi? */
    knowsPack(packId: string): boolean {
      return packs.some(p => p._id === packId);
    },

    async load(): Promise<boolean> {
      if (!contextValid()) return fail(t('sticker_context_invalid'));
      const generation = ++loadGeneration;
      const startingStateGeneration = stateGeneration;
      const resultIsCurrent = () => generation === loadGeneration
        && startingStateGeneration === stateGeneration
        && contextValid();
      loading = true;
      error   = null;
      try {
        const { apiFetch, base } = await api();
        const res = await apiFetch(base);
        if (!res.ok) {
          if (!resultIsCurrent()) return false;
          return fail(safeApiErrorMessage(res, t('sticker_packs_load_failed', 'Sticker paketleri yüklenemedi.'), { report: true }));
        }
        const data = await res.json() as unknown;
        if (!resultIsCurrent()) return false;
        if (!Array.isArray(data)) return fail(t('sticker_response_invalid'));
        packs = data.map(normalizePack)
          .filter((p): p is StickerPack => p !== null && p.serverId === serverId);
        stateGeneration += 1;
        return true;
      } catch (e) {
        if (!resultIsCurrent()) return false;
        return fail(safeApiErrorMessage(e, t('sticker_packs_load_failed', 'Sticker paketleri yüklenemedi.'), { report: true }));
      } finally {
        if (generation === loadGeneration) loading = false;
      }
    },

    /**
     * Paket sil. Arka uç MANAGE_SERVER ister ve (packId + serverId) ile
     * kiracıyı ayrıca doğrular; istemci yalnız yanlış istek göndermemek için
     * aynı sınırı erkenden uygular.
     */
    async deletePack(packId: string): Promise<boolean> {
      if (busy) return false;                       // çift gönderim koruması
      if (!contextValid())        return fail(t('sticker_context_changed'));
      if (!packId)                return fail(t('sticker_pack_id_missing'));
      if (!ctl.knowsPack(packId)) return fail(t('sticker_pack_wrong_server'));

      busy  = true;
      error = null;
      try {
        const { apiFetch, base } = await api();
        const res = await apiFetch(`${base}/${encodeURIComponent(packId)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
          if (!contextValid()) return false;
          return fail(safeApiErrorMessage(res, t('sticker_pack_delete_failed'), { report: true }));
        }
        if (!contextValid()) return false;
        // Yalnız GERÇEK başarıdan sonra yerel durum güncellenir.
        packs = packs.filter(p => p._id !== packId);
        stateGeneration += 1;
        return true;
      } catch (e) {
        if (!contextValid()) return false;
        return fail(safeApiErrorMessage(e, t('sticker_pack_delete_failed'), { report: true }));
      } finally {
        busy = false;
      }
    },

    /** Sticker adını/etiketlerini güncelle (MANAGE_SERVER). */
    async renameSticker(packId: string, stickerId: string, name: string): Promise<boolean> {
      if (busy) return false;
      if (!contextValid())        return fail(t('sticker_context_changed'));
      if (!packId || !stickerId)  return fail(t('sticker_ids_missing'));
      if (!ctl.knowsPack(packId)) return fail(t('sticker_pack_wrong_server'));

      const pack = packs.find(p => p._id === packId)!;
      if (!pack.stickers.some(s => s.id === stickerId)) return fail(t('sticker_not_in_pack'));

      const next = name.trim();
      if (!next) return fail(t('sticker_name_empty'));

      busy  = true;
      error = null;
      try {
        const { apiFetch, base } = await api();
        const res = await apiFetch(`${base}/${encodeURIComponent(packId)}/stickers/${encodeURIComponent(stickerId)}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ name: next }),
        });
        if (!res.ok) {
          if (!contextValid()) return false;
          return fail(safeApiErrorMessage(res, t('sticker_update_failed', 'Sticker güncellenemedi.'), { report: true }));
        }
        if (!contextValid()) return false;
        // Keyed Svelte rows receive the pack object itself. Mutating its nested
        // array in place and cloning only the outer array can therefore leave
        // the successful server value visually stale. Publish immutable owners
        // at both levels so every consumer observes the committed rename.
        packs = packs.map(current => current._id === packId
          ? {
              ...current,
              stickers: current.stickers.map(s => (s.id === stickerId ? { ...s, name: next } : s)),
            }
          : current);
        stateGeneration += 1;
        return true;
      } catch (e) {
        if (!contextValid()) return false;
        return fail(safeApiErrorMessage(e, t('sticker_update_failed', 'Sticker güncellenemedi.'), { report: true }));
      } finally {
        busy = false;
      }
    },

    /**
     * Yeni paket oluştur (MANAGE_SERVER).
     *
     * SÖZLEŞME: multipart/form-data
     *   name        → paket adı (arka uçta trim edilir, boşsa 400)
     *   description → isteğe bağlı
     *   sticker     → 1..50 dosya (alan adı ÇOĞUL DEĞİL, `sticker`)
     *
     * `Content-Type` ELLE AYARLANMAZ: multipart sınırını (boundary) tarayıcı
     * üretir; elle yazmak bozuk bir gövdeye yol açardı. `apiFetch` yalnız
     * Authorization/Accept ekler, gövdeye dokunmaz.
     */
    async createPack(name: string, description: string, files: readonly File[]): Promise<boolean> {
      if (busy) return false;                            // çift gönderim koruması
      if (!contextValid()) return fail(t('sticker_context_changed'));

      const packName = name.trim();
      if (!packName)   return fail(t('sticker_pack_name_required'));
      if (!files.length) return fail(t('sticker_file_required'));
      if (files.length > STICKER_MAX_FILES) {
        return fail(t('sticker_file_limit', undefined, { count: STICKER_MAX_FILES }));
      }

      busy  = true;
      error = null;
      try {
        const form = new FormData();
        form.append('name', packName);
        form.append('description', description.trim());
        for (const f of files) form.append(STICKER_FILE_FIELD, f);

        const { apiFetch, base } = await api();
        const res = await apiFetch(base, { method: 'POST', body: form });

        if (!res.ok) {
          // Sunucu gövdesi güven sınırının dışındadır. Yükleme özelinde
          // güvenli, durum-koduna bağlı ürün metni yeterli ve daha tutarlıdır.
          if (!contextValid()) return false;
          return fail(uploadFallback(res.status));
        }

        // BAYAT SUNUCU KORUMASI: istek boyunca kullanıcı başka sunucuya
        // geçtiyse yanıt ARTIK geçerli bağlama ait değildir ve yerel duruma
        // UYGULANMAZ. `contextValid()` kayıttaki güncel sunucuyu okur
        // (`isStillCurrentServer`), bu yüzden geçiş burada yakalanır.
        if (!contextValid()) return false;

        const created = normalizePack(await res.json().catch(() => null));
        if (!created || created.serverId !== serverId) return fail(t('sticker_created_invalid'));
        packs = [...packs, created];
        stateGeneration += 1;
        return true;
      } catch (e) {
        if (!contextValid()) return false;
        return fail(safeApiErrorMessage(e, t('sticker_pack_create_failed', 'Sticker paketi oluşturulamadı.'), { report: true }));
      } finally {
        busy = false;
      }
    },

    clearError(): void { error = null; },
  };

  return ctl;
}

/** Arka uç gövdesiz hata döndüyse duruma göre DÜRÜST karşılık. */
function uploadFallback(status: number): string {
  if (status === 401) return t('sticker_session_expired');
  if (status === 403) return t('sticker_create_forbidden');
  if (status === 404) return t('sticker_server_not_found');
  if (status === 413) return t('sticker_file_too_large');
  if (status === 415) return t('sticker_invalid_format');
  if (status === 429) return t('sticker_upload_rate_limit');
  if (status >= 500)  return t('sticker_server_error');
  return t('sticker_upload_failed_status', undefined, { status });
}
