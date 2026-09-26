// server/lib/accountDeletion.ts
//
// HESAP SİLMENİN TEK UYGULAYICISI (Final21 Faz 19)
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BİR MODÜL
// ════════════════════════════════════════════════════════════════════════════
// Politika (`accountLifecycle.ts`) tek kaynaktı ama onu UYGULAYAN kod yalnızca kişinin kendi
// silme ucundaydı (`DELETE /api/account`). Yönetici silmesi (`DELETE /api/admin/users/:id`)
// politikayı HİÇ uygulamıyordu: yalnızca kanal mesajlarını ve üyelikleri siliyor, oturumu
// iptal edip `users` satırını siliyordu. Geride kalanlar (ölçüldü, bkz. p19-notes 19-10):
//   · sırlar: WebAuthn kayıtları, OAuth jetonları, push abonelikleri, ActivityPub özel anahtarı
//   · sosyal graf: arkadaşlıklar, engeller — karşı tarafta "hayalet arkadaş"
//   · DM, grup DM, konu ve sesli mesajlarda kişinin adı/avatarı, kimlik bağı KOPMADAN
//   · sahibi silinen sunucular/botlar/grup DM'ler SAHİPSİZ kalıyordu (sessiz öksüzleştirme)
//   · profil görselleri diskte
// Artık iki uç da BU modülü çağırır; politikanın iki ayrı uygulaması yoktur.

import { LIFECYCLE, TOMBSTONE_USER_ID } from './accountLifecycle';
import { prepareAuthorErasure, snapshotAssignments, type ErasurePlan } from './accountErasure';
import { releaseUnreferencedUploads, type ReleaseResult } from './uploadRelease';
import { invalidateChannelMessages } from './messageCache';

export type Queryable = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
};
export type TransactionRunner = <T>(fn: (client: Queryable) => Promise<T>) => Promise<T>;

/** Tablo gerçekten var mı — eski/kısmi şemalarda sorgu patlamasın. */
export async function existingTables(p: Queryable): Promise<Set<string>> {
  const { rows } = await p.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
  );
  return new Set(rows.map(r => r.table_name));
}

export async function tableColumns(p: Queryable, table: string): Promise<Set<string>> {
  const { rows } = await p.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`, [table],
  );
  return new Set(rows.map(r => r.column_name));
}

export interface OwnershipBlocker { kind: string; id: string; name?: string; memberCount: number }

/** Silmeyi engelleyen sahiplikler — sessiz devir YERİNE açık engel. */
export async function ownershipBlockers(p: Queryable, userId: string): Promise<OwnershipBlocker[]> {
  const present = await existingTables(p);
  const blockers: OwnershipBlocker[] = [];

  if (present.has('servers') && present.has('members')) {
    const { rows } = await p.query<{ _id: string; name: string; cnt: string }>(
      `SELECT s._id, s.name, (SELECT count(*) FROM members m WHERE m."serverId" = s._id) AS cnt
         FROM servers s WHERE s."ownerId" = $1`, [userId]);
    for (const r of rows) {
      const members = parseInt(r.cnt, 10) || 0;
      // Yalnızca BAŞKA üyesi olan sunucular engeldir.
      if (members > 1) blockers.push({ kind: 'server', id: r._id, name: r.name, memberCount: members });
    }
  }

  if (present.has('group_dm_conversations') && present.has('group_dm_members')) {
    const { rows } = await p.query<{ _id: string; cnt: string }>(
      `SELECT g._id, (SELECT count(*) FROM group_dm_members m WHERE m."groupId" = g._id) AS cnt
         FROM group_dm_conversations g WHERE g."ownerId" = $1`, [userId]).catch(() => ({ rows: [] }));
    for (const r of rows) {
      const members = parseInt(r.cnt, 10) || 0;
      if (members > 1) blockers.push({ kind: 'group_dm', id: r._id, memberCount: members });
    }
  }

  return blockers;
}

export interface ErasureOptions {
  /**
   * Yönetici (moderasyon) silmesi: kişinin KANAL mesajları anonimleştirilmek yerine silinir.
   * Bu, yönetici ucunun Faz 19 öncesi davranışıdır ("kullanıcı ve mesajları"); geri kalan
   * her şey kişinin kendi silmesiyle BİREBİR aynı politikadan geçer.
   */
  purgeChannelMessages?: boolean;
}

export interface ErasureResult {
  applied: Array<{ table: string; disposition: string; rows: number }>;
  plan: ErasurePlan;
}

/**
 * Politikayı TEK işlemde uygular. Sahiplik engelleri ÇAĞIRAN tarafından, bu çağrıdan
 * ÖNCE denetlenmiş olmalıdır (engel varken çağrılırsa tek-sahipli kayıtlar silinir).
 */
export async function eraseAccountData(
  p: Queryable, transaction: TransactionRunner, userId: string, options: ErasureOptions = {},
): Promise<ErasureResult> {
  const present = await existingTables(p);
  const applied: ErasureResult['applied'] = [];
  let plan: ErasurePlan = { assetUrls: [], channelIds: [], repliesScrubbed: 0 };

  await transaction(async (client: Queryable) => {
    // Kişinin GÖRÜNÜMÜ (ad/avatar) kimlik bağıyla birlikte gider — satırlar hâlâ
    // `userId` ile bulunabilirken (lib/accountErasure.ts).
    plan = await prepareAuthorErasure(client, userId, present, (table) => tableColumns(p, table));

    if (options.purgeChannelMessages && present.has('messages')) {
      const r = await client.query(`DELETE FROM messages WHERE "userId" = $1`, [userId]);
      applied.push({ table: 'messages', disposition: 'PURGE_BY_ADMIN', rows: r.rowCount ?? 0 });
    }

    for (const rule of LIFECYCLE) {
      if (!present.has(rule.table)) continue;
      if (rule.disposition === 'RETAIN') continue;

      const cols = await tableColumns(p, rule.table);

      if (rule.disposition === 'TRANSFER_REQUIRED') {
        // Buraya gelindiyse engel YOK demektir: yalnızca kullanıcının
        // TEK BAŞINA sahibi olduğu kayıtlar kalmıştır; onlar silinir.
        for (const col of rule.columns) {
          if (!cols.has(col)) continue;
          const r = await client.query(
            `DELETE FROM "${rule.table}" WHERE "${col}" = $1`, [userId]);
          applied.push({ table: rule.table, disposition: 'DELETE_SOLE_OWNED', rows: r.rowCount ?? 0 });
        }
        continue;
      }

      for (const col of rule.columns) {
        if (!cols.has(col)) continue;
        if (rule.disposition === 'DELETE') {
          const r = await client.query(
            `DELETE FROM "${rule.table}" WHERE "${col}" = $1`, [userId]);
          applied.push({ table: rule.table, disposition: 'DELETE', rows: r.rowCount ?? 0 });
        } else {
          // ANONYMIZE — satır kalır, kimlik bağı kopar. Yazarın ad/avatar anlık
          // görüntüsü AYNI UPDATE'te boşaltılır (ek tablo taraması yok).
          const snapshot = snapshotAssignments(rule.table, col, cols, 3);
          const r = await client.query(
            `UPDATE "${rule.table}" SET "${col}" = $2${snapshot.sql} WHERE "${col}" = $1`,
            [userId, TOMBSTONE_USER_ID, ...snapshot.params]);
          applied.push({ table: rule.table, disposition: 'ANONYMIZE', rows: r.rowCount ?? 0 });
        }
      }
    }

    // Son adım: kimlik satırının kendisi.
    await client.query(`DELETE FROM users WHERE _id = $1`, [userId]);
  });

  return { applied, plan };
}

/**
 * İşlem TAMAMLANDIKTAN sonra: kişinin artık hiçbir kaydın başvurmadığı profil görsellerini
 * bırakır ve mesaj önbelleğini düşürür. Dosya bırakılamazsa silme GERİ ALINMAZ.
 */
export async function releaseAfterErasure(
  p: Queryable, plan: ErasurePlan, onAssetError: (url: string, err: unknown) => void,
): Promise<ReleaseResult> {
  const assets = await releaseUnreferencedUploads(p, plan.assetUrls, onAssetError);
  await Promise.all(plan.channelIds.map(channelId => invalidateChannelMessages(channelId)));
  return assets;
}
