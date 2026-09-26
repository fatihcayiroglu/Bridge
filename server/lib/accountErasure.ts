// server/lib/accountErasure.ts
//
// HESAP SİLMEDE KİŞİNİN GÖRÜNÜMÜ: AD, AVATAR, PROFİL GÖRSELLERİ (Final21 Faz 19)
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN KUSUR (gerçek uçlar üzerinden ÜRETİLDİ: tools/p19-account-delete-privacy-probe.mjs)
// ════════════════════════════════════════════════════════════════════════════
// Politika (`accountLifecycle.ts`) paylaşılan sohbeti SİLMEZ, ANONİMLEŞTİRİR: mesaj kalır,
// kimlik bağı kopar. Ama silme yolu yalnızca `userId` sütununu `deleted-user` yapıyordu.
// Mesaj satırları yazarın görünümünü ANLIK GÖRÜNTÜ olarak da taşır:
//
//     messages           username, displayName, avatarColor, avatarUrl
//     thread_messages    username, displayName, avatarColor
//     dm_messages        displayName, avatarColor
//     group_dm_messages  displayName, avatarColor
//     voice_messages     displayName
//     messages.replyTo   { displayName } — başkasının yanıtındaki alıntı başlığı
//
// Sonuç: hesabı silinen kişinin adı ve fotoğrafı kalan herkesin geçmişinde AYNEN görünmeye
// devam ediyordu; `deleted-user` yalnızca görünmez bir kimlik alanıydı. Profil görselleri
// (hesap avatarı, afiş, sunucu profili avatarı/afişi ve Faz 8'den beri korunan ESKİ avatarlar)
// diskte kalıyor ve URL'si bilen herkese sunulmaya devam ediyordu.
//
// ── BU MODÜLÜN SÖZLEŞMESİ ──────────────────────────────────────────────────
// · Anlık görüntü sütunları kimlik bağıyla AYNI UPDATE'te boşaltılır (ek tablo taraması yok).
//   Ad boş dizgeye çekilir: sütunlar NOT NULL'dır ve istemci boş adı yerelleştirilmiş
//   "Bilinmeyen" etiketiyle çizer (`MessageRenderer`, `ThreadPanel`, `DmPanel`, arama).
// · İçerik KALIR (politika: paylaşılan sohbet bağlamı). Yalnızca kişiyi tanıtan görünüm gider.
// · Profil görsel dosyaları işlem ÖNCESİ toplanır (satırlar silinmeden), işlem SONRASI ve
//   yalnızca başka hiçbir kayıt onlara başvurmuyorsa silinir. Veritabanı yetkilidir: dosya
//   silinemezse hesap silme geri alınmaz, olay kaydedilir (lib/uploadRelease.ts).

import { locateAsset, memberProfileAssetUrls } from './uploadRelease';

/** Ürünün varsayılan avatar rengi (şema varsayılanı ile aynı). Kişisel renk seçimi silinir. */
export const TOMBSTONE_AVATAR_COLOR = '#2d9cdb';

/**
 * Yazar görünümü anlık görüntüleri. Anahtar: tablo; değer: sütun → mezar taşı değeri.
 * Bu tabloların kimlik sütunu `userId`'dir ve politikada ANONYMIZE sınıfındadır.
 */
export const AUTHOR_SNAPSHOTS: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  messages:          { username: '', displayName: '', avatarColor: TOMBSTONE_AVATAR_COLOR, avatarUrl: null },
  thread_messages:   { username: '', displayName: '', avatarColor: TOMBSTONE_AVATAR_COLOR },
  dm_messages:       { displayName: '', avatarColor: TOMBSTONE_AVATAR_COLOR },
  group_dm_messages: { displayName: '', avatarColor: TOMBSTONE_AVATAR_COLOR },
  voice_messages:    { displayName: '' },
};

/** Şema sözleşme testinin "yazar görünümü" saydığı sütun adları. */
export const SNAPSHOT_COLUMN_NAMES: readonly string[] = ['username', 'displayName', 'avatarColor', 'avatarUrl'];

/**
 * ANONYMIZE UPDATE'ine eklenecek atamalar. Yalnızca tabloda GERÇEKTEN var olan sütunlar
 * (kısmi/eski şemalar). Sütun adları politikadan gelir, istekten DEĞİL.
 * `firstParam`: ilk yer tutucunun numarası (UPDATE $1 ve $2'yi zaten kullanır).
 */
export function snapshotAssignments(
  table: string, identityColumn: string, present: ReadonlySet<string>, firstParam: number,
): { sql: string; params: Array<string | null> } {
  const rule = identityColumn === 'userId' ? AUTHOR_SNAPSHOTS[table] : undefined;
  if (!rule) return { sql: '', params: [] };
  const parts: string[] = [];
  const params: Array<string | null> = [];
  for (const [column, value] of Object.entries(rule)) {
    if (!present.has(column)) continue;
    params.push(value);
    parts.push(`"${column}" = $${firstParam + params.length - 1}`);
  }
  return { sql: parts.length ? `, ${parts.join(', ')}` : '', params };
}

type Queryable = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

export interface ErasurePlan {
  /** Kişiye ait profil görsellerinin URL'leri (yalnızca profil alt dizinleri). */
  assetUrls: string[];
  /** Mesaj önbelleği düşürülecek kanallar. */
  channelIds: string[];
  /** Adı alıntı başlığından silinen yanıt sayısı. */
  repliesScrubbed: number;
}

/**
 * Silme işlemi İÇİNDE, kimlik bağı koparılmadan ÖNCE çağrılır:
 *   1. başkalarının yanıtlarındaki alıntı başlığından kişinin adını siler;
 *   2. kişinin profil görsellerini ve mesaj yazdığı kanalları toplar.
 */
export async function prepareAuthorErasure(
  client: Queryable,
  userId: string,
  tables: ReadonlySet<string>,
  columnsOf: (table: string) => Promise<Set<string>>,
): Promise<ErasurePlan> {
  const urls = new Set<string>();
  const channels = new Set<string>();
  let repliesScrubbed = 0;

  if (tables.has('messages')) {
    const cols = await columnsOf('messages');
    if (cols.has('userId') && cols.has('channelId')) {
      if (cols.has('replyTo')) {
        // Alıntı başlığı yazar kimliği TAŞIMAZ; kişinin mesajına yalnızca `_id` ile bağlıdır.
        const r = await client.query(
          `UPDATE messages SET "replyTo" = "replyTo" - 'displayName'
            WHERE "replyTo" ? 'displayName'
              AND "replyTo"->>'_id' IN (SELECT _id FROM messages WHERE "userId" = $1)`,
          [userId]);
        repliesScrubbed = r.rowCount ?? 0;
      }
      const avatarSelect = cols.has('avatarUrl')
        ? `, array_agg(DISTINCT "avatarUrl") FILTER (WHERE "avatarUrl" IS NOT NULL) AS avatars`
        : '';
      const { rows } = await client.query<{ channels: string[] | null; avatars?: string[] | null }>(
        `SELECT array_agg(DISTINCT "channelId") AS channels${avatarSelect} FROM messages WHERE "userId" = $1`,
        [userId]);
      for (const c of rows[0]?.channels ?? []) if (c) channels.add(c);
      for (const a of rows[0]?.avatars ?? []) urls.add(a);
    }
  }

  if (tables.has('users')) {
    const cols = await columnsOf('users');
    const picks = ['avatarUrl', 'bannerUrl'].filter(c => cols.has(c));
    if (picks.length) {
      const { rows } = await client.query<Record<string, string | null>>(
        `SELECT ${picks.map(c => `"${c}"`).join(', ')} FROM users WHERE _id = $1`, [userId]);
      for (const c of picks) { const v = rows[0]?.[c]; if (v) urls.add(v); }
    }
  }

  if (tables.has('members')) {
    const cols = await columnsOf('members');
    if (cols.has('userId') && cols.has('serverProfile')) {
      const { rows } = await client.query<{ serverProfile: unknown }>(
        `SELECT "serverProfile" FROM members WHERE "userId" = $1 AND "serverProfile" IS NOT NULL`, [userId]);
      for (const u of memberProfileAssetUrls(rows)) urls.add(u);
    }
  }

  return {
    assetUrls: [...urls].filter(u => locateAsset(u) !== null),
    channelIds: [...channels],
    repliesScrubbed,
  };
}
