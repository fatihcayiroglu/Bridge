// client/js/core/draft-store.ts
// Faz 8.2 — Taslak (draft) kalıcılık katmanı.
//
// GERİ KAZANILAN DAVRANIŞ
// ───────────────────────
// Sprint 116'da `drafts.ts` arşive taşındı; yerine bırakılan
// `DraftManager.svelte` yalnızca boş bir kabuktu (show/hide kaydı, hiç
// storage yok) ve `drafts-svelte.ts` shim'i hiçbir yerden import edilmiyordu.
// Sonuç: kullanıcı kanal değiştirdiğinde yazdığı yarım mesaj SESSİZCE
// KAYBOLUYORDU.
//
// Bu modül SALT KALICILIK katmanıdır: DOM yok, Svelte yok, zamanlayıcı yok.
// Zamanlama/debounce DraftManager.svelte'te, textarea sahipliği
// MessageInputPanel.svelte'tedir — her sorumluluğun tek sahibi var.
//
// ANAHTAR STRATEJİSİ
//   bridge:draft:v2:<userId>:<kind>:<scope>:<conversationId>
//
// Yalnızca DEĞİŞMEZ kimlikler kullanılır. Sunucu/kanal ADI, sıra/index veya
// token anahtara girmez: ad değişince taslak kaybolur, index kayınca başka
// konuşmanın taslağı okunur, token ise depoda sızdırılmış kimlik bilgisi olur.
//
// GÜVENLİK
//   - Taslak metni yalnızca düz metin olarak saklanır/döner; HTML üretilmez.
//   - Bozuk JSON, kota aşımı ve kapalı depolama uygulamayı çökertmez —
//     taslak kaybı mesaj göndermeyi ASLA engellemez.

import { createLogger } from './logger.ts';

const log = createLogger('DraftStore');

/** Anahtar öneki — sürüm eki, ileride şema değişirse eski kayıtları çakıştırmaz. */
export const DRAFT_KEY_PREFIX = 'bridge:draft:v2';

/**
 * Saklanabilecek en uzun taslak. MessageInputPanel.svelte:36 `MAX_LENGTH`
 * ile aynı: gönderilemeyecek uzunlukta metni saklamanın anlamı yok ve
 * localStorage kotasını şişirir.
 */
export const MAX_DRAFT_LENGTH = 2000;

/** A single user cannot grow localStorage without bound. */
export const MAX_DRAFTS_PER_USER = 50;

/** Konuşma türü — anahtar alanı olarak kullanılır. */
export type ConversationKind = 'channel' | 'dm' | 'gdm';

export interface DraftIdentity {
  userId: string;
  kind: ConversationKind;
  conversationId: string;
  /** Required for server channels; DM/GDM ids are globally scoped. */
  serverId?: string;
}

interface StoredDraft {
  /** Düz metin taslak içeriği. */
  t: string;
  /** Kaydedilme zamanı (ms). Bayat taslakların ayıklanması için. */
  s: number;
  /** A raw File is never stored; this only remembers that it must be reselected. */
  a?: boolean;
}

/** Bu süreden eski taslaklar okunmaz ve okundukları anda silinir. */
export const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün

// ── Anahtar üretimi ──────────────────────────────────────────────────────────

/**
 * Taslak anahtarını üretir. Kimliklerden herhangi biri eksikse `null` döner —
 * eksik kimlikle yazmak, farklı kullanıcı/konuşmaların aynı kovaya düşmesi
 * demek olurdu.
 */
export function draftKey(identity: Partial<DraftIdentity> | null | undefined): string | null {
  const userId = identity?.userId;
  const kind = identity?.kind;
  const conversationId = identity?.conversationId;
  if (!userId || !['channel', 'dm', 'gdm'].includes(String(kind)) || !conversationId) return null;
  const scope = kind === 'channel' ? identity?.serverId : kind;
  if (!scope) return null;
  const safe = (value: string) => encodeURIComponent(value);
  return `${DRAFT_KEY_PREFIX}:${safe(userId)}:${kind}:${safe(scope)}:${safe(conversationId)}`;
}

// ── Depolama erişimi ─────────────────────────────────────────────────────────

/**
 * localStorage'a güvenli erişim. Tarayıcı gizli modda, kurumsal politikayla
 * veya kota dolduğunda erişimi tamamen reddedebilir; bu durumda taslak
 * özelliği devre dışı kalır ama uygulama çalışmaya devam eder.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Depodan ham değeri okur; her tür hata `null` olarak yutulur. */
function rawGet(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function rawRemove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* depolama kapalı — taslak kaybı kabul edilebilir */
  }
}

function parseStored(key: string): StoredDraft | null {
  const raw = rawGet(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'string') throw new Error('invalid draft');
    const savedAt = typeof parsed.s === 'number' ? parsed.s : 0;
    if (savedAt > 0 && Date.now() - savedAt > MAX_DRAFT_AGE_MS) {
      rawRemove(key);
      return null;
    }
    return {
      t: parsed.t.slice(0, MAX_DRAFT_LENGTH),
      s: savedAt,
      ...(parsed.a === true ? { a: true } : {}),
    };
  } catch {
    rawRemove(key);
    log.warn('Bozuk taslak kaydı silindi');
    return null;
  }
}

function rawSet(key: string, entry: StoredDraft): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(key, JSON.stringify(entry));
    return true;
  } catch (err) {
    log.warn('Taslak kaydedilemedi', err);
    return false;
  }
}

/** Remove stale/invalid records first, then the oldest overflow records. */
function pruneUserDrafts(userId: string): void {
  const store = storage();
  if (!store) return;
  const prefix = `${DRAFT_KEY_PREFIX}:${encodeURIComponent(userId)}:`;
  const records: Array<{ key: string; savedAt: number }> = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key?.startsWith(prefix)) continue;
      const entry = parseStored(key);
      if (entry) records.push({ key, savedAt: entry.s });
    }
    records.sort((a, b) => b.savedAt - a.savedAt);
    for (const record of records.slice(MAX_DRAFTS_PER_USER)) rawRemove(record.key);
  } catch {
    /* storage enumeration unavailable — current write still remains usable */
  }
}

// ── Genel API ────────────────────────────────────────────────────────────────

/**
 * Taslağı okur.
 *
 * @returns Taslak metni; kayıt yoksa, bozuksa veya bayatsa boş string.
 *          ASLA `null`/`undefined` dönmez — çağıran yerde ekstra kontrol
 *          gerekmesin diye.
 */
export function readDraft(identity: Partial<DraftIdentity> | null | undefined): string {
  const key = draftKey(identity);
  if (!key) return '';

  return parseStored(key)?.t ?? '';
}

/**
 * Taslağı yazar. Boş/yalnızca boşluk içeren metin taslak DEĞİLDİR: kayıt
 * silinir (kullanıcı metni sildiyse eski taslak geri gelmemeli).
 *
 * @returns Yazma/silme başarılıysa `true`. Başarısızlık çağıranı ASLA
 *          bloklamaz — mesaj gönderimi taslak hatasından etkilenmez.
 */
export function writeDraft(identity: Partial<DraftIdentity> | null | undefined, text: string): boolean {
  const key = draftKey(identity);
  if (!key) return false;

  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) {
    const existing = parseStored(key);
    if (existing?.a) return rawSet(key, { t: '', s: Date.now(), a: true });
    rawRemove(key);
    return true;
  }

  const existing = parseStored(key);
  const entry: StoredDraft = {
    t: value.length > MAX_DRAFT_LENGTH ? value.slice(0, MAX_DRAFT_LENGTH) : value,
    s: Date.now(),
    ...(existing?.a ? { a: true } : {}),
  };
  const written = rawSet(key, entry);
  if (written && identity?.userId) pruneUserDrafts(identity.userId);
  return written;
}

/** Remember only that a selected attachment must be reselected after navigation/reload. */
export function writeDraftAttachmentPending(
  identity: Partial<DraftIdentity> | null | undefined,
  pending: boolean,
): boolean {
  const key = draftKey(identity);
  if (!key) return false;
  const existing = parseStored(key);
  if (!pending) {
    if (!existing?.t.trim()) { rawRemove(key); return true; }
    return rawSet(key, { t: existing.t, s: Date.now() });
  }
  const written = rawSet(key, { t: existing?.t ?? '', s: Date.now(), a: true });
  if (written && identity?.userId) pruneUserDrafts(identity.userId);
  return written;
}

export function readDraftAttachmentPending(
  identity: Partial<DraftIdentity> | null | undefined,
): boolean {
  const key = draftKey(identity);
  return key ? parseStored(key)?.a === true : false;
}

/** Taslağı siler (başarılı gönderim, elle temizleme). */
export function clearDraft(identity: Partial<DraftIdentity> | null | undefined): void {
  const key = draftKey(identity);
  if (key) rawRemove(key);
}
