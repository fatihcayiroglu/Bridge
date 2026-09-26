// server/tests/pg-integration/durable-queues.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DAYANIKLI KUYRUKLAR — GERÇEK PostgreSQL İLE
// ════════════════════════════════════════════════════════════════════════════
// Faz 1 raporu açıkça şunu bıraktı: "zamanlanmış mesaj ve federasyon
// dayanıklılığı için gerçek PostgreSQL yeniden başlatma/eşzamanlılık kanıtı
// hâlâ yok." Bu dosya o boşluğu kapatır.
//
// Ölçülen sözleşmeler — HEPSİ gerçek eşzamanlı çağrılarla:
//
//   ZAMANLANMIŞ MESAJLAR
//     · iki dağıtıcı aynı vadeli işi talep eder → YALNIZ BİRİ alır
//     · başarılı finalize yalnızca KİRA SAHİBİNDEN kabul edilir
//     · geçici hata kirayı bırakır ve işi YENİDEN vadelendirir
//     · terminal hata işi kalıcı olarak devre dışı bırakır
//     · iptal, aktif bir dağıtıcıyla yarışırsa `dispatching` döner
//     · BAYAT kira (çökmüş işçi) süresi dolunca DEVRALINABİLİR
//     · gönderilmiş iş TEKRAR talep edilemez (çift gönderim koruması)
//
//   GİDEN WEBHOOK'LAR
//     · iki işçi aynı teslimatı talep eder → yalnız biri alır
//     · retry deneme sayacını artırır ve ileri tarihe atar
//     · tamamlama yalnızca kira sahibinden kabul edilir
//     · bekleyen satırlar webhook başına SINIRLANIR (kuyruk şişmesi)
//
//   FEDERASYON
//     · iki işçi aynı teslimatı talep eder → yalnız biri alır
//     · kira bırakma ve kayıt silme yalnızca sahibinden
//
// ── NEDEN MOCK YETMEZ ─────────────────────────────────────────────────────
// `FOR UPDATE SKIP LOCKED` semantiği yalnızca gerçek bir veritabanında
// vardır. Mock'lanmış bir test yalnızca hangi SQL'in yazıldığını gösterir;
// iki eşzamanlı işçinin AYNI işi almadığını KANITLAYAMAZ.

import crypto from 'crypto';

const RUN = process.env.PG_TEST_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require('../../db/loader').default;
import ScheduledMessages from '../../db/repositories/ScheduledMessageRepository';
import OutgoingWebhooks from '../../db/repositories/OutgoingWebhookRepository';
import FederationRepo from '../../db/repositories/FederationRepository';

const uid = (): string => crypto.randomUUID();
const now = (): number => Date.now();
const cleanup: Array<{ table: string; column: string; value: string }> = [];

async function q(sql: string, params: unknown[] = []) {
  return db._pool.query(sql, params);
}

async function seedUser(): Promise<string> {
  const id = uid();
  await q('INSERT INTO users (_id, username, "displayName", password, "tokenVersion", "createdAt")'
        + ' VALUES ($1,$2,$3,$4,0,$5)', [id, 'u_' + id.slice(0, 8), 'Q User', 'x', now()]);
  cleanup.push({ table: 'users', column: '_id', value: id });
  return id;
}

async function seedServerAndChannel(ownerId: string): Promise<{ serverId: string; channelId: string }> {
  const serverId = uid();
  await q('INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$2,$3,$4)',
    [serverId, 'Queue Server', ownerId, now()]);
  cleanup.push({ table: 'servers', column: '_id', value: serverId });

  const channelId = uid();
  await q('INSERT INTO channels (_id, "serverId", name, type, "createdAt") VALUES ($1,$2,$3,$4,$5)',
    [channelId, serverId, 'genel', 'text', now()]);
  cleanup.push({ table: 'channels', column: '_id', value: channelId });
  return { serverId, channelId };
}

/** Vadesi geçmiş bir zamanlanmış mesaj yazar. */
async function seedScheduled(opts: { sendAt?: number } = {}): Promise<string> {
  const userId = await seedUser();
  const { serverId, channelId } = await seedServerAndChannel(userId);
  const id = uid();
  await q(
    'INSERT INTO scheduled_msgs (_id, "channelId", "serverId", "userId", "displayName", username,'
    + ' content, "sendAt", "createdAt", sent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)',
    [id, channelId, serverId, userId, 'Q User', 'quser', 'zamanli mesaj',
      opts.sendAt ?? now() - 1000, now()],
  );
  cleanup.push({ table: 'scheduled_msgs', column: '_id', value: id });
  return id;
}

afterAll(async () => {
  for (const row of cleanup.reverse()) {
    try { await q(`DELETE FROM ${row.table} WHERE "${row.column}" = $1`, [row.value]); }
    catch { /* cascade ile gitmis olabilir */ }
  }
  try { await db._pool.end(); } catch { /* kapali */ }
});

// ════════════════════════════════════════════════════════════════════════════
RUN('gerçek PostgreSQL — zamanlanmış mesaj dayanıklılığı', () => {
  it('EŞZAMANLI iki dağıtıcıdan YALNIZ BİRİ işi talep eder', async () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // Kaybedilen bir kilit burada MESAJIN İKİ KEZ GÖNDERİLMESİ demektir —
    // kullanıcının gördüğü, geri alınamaz bir hata.
    const id = await seedScheduled();
    const at = now();

    const [a, b] = await Promise.all([
      ScheduledMessages.claimDueBefore(at, 'worker-A'),
      ScheduledMessages.claimDueBefore(at, 'worker-B'),
    ]);

    const claimedByA = a.filter(r => r._id === id).length;
    const claimedByB = b.filter(r => r._id === id).length;
    expect(claimedByA + claimedByB).toBe(1);

    const { rows } = await q('SELECT "claimOwner" FROM scheduled_msgs WHERE _id = $1', [id]);
    expect(['worker-A', 'worker-B']).toContain(rows[0].claimOwner);
  });

  it('finalize YALNIZCA kira sahibinden kabul edilir', async () => {
    const id = await seedScheduled();
    await ScheduledMessages.claimDueBefore(now(), 'worker-A');

    // Yabancı bir işçi finalize edemez.
    expect(await ScheduledMessages.finalizeSent(id, 'worker-B')).toBe(false);
    // Sahip edebilir.
    expect(await ScheduledMessages.finalizeSent(id, 'worker-A')).toBe(true);

    const { rows } = await q('SELECT sent, "claimOwner" FROM scheduled_msgs WHERE _id = $1', [id]);
    expect(rows[0].sent).toBe(true);
    expect(rows[0].claimOwner).toBeNull();
  });

  it('GÖNDERİLMİŞ iş tekrar talep EDİLEMEZ (çift gönderim koruması)', async () => {
    const id = await seedScheduled();
    await ScheduledMessages.claimDueBefore(now(), 'worker-A');
    await ScheduledMessages.finalizeSent(id, 'worker-A');

    const again = await ScheduledMessages.claimDueBefore(now() + 60_000, 'worker-C');
    expect(again.some(r => r._id === id)).toBe(false);
  });

  it('GEÇİCİ hata kirayı bırakır ve işi İLERİ tarihe atar', async () => {
    const id = await seedScheduled();
    await ScheduledMessages.claimDueBefore(now(), 'worker-A');

    const retryAt = now() + 300_000;
    expect(await ScheduledMessages.releaseClaim(id, 'worker-A', 'gecici ag hatasi', retryAt)).toBe(true);

    const { rows } = await q('SELECT "claimOwner", "claimUntil", "lastError", sent FROM scheduled_msgs WHERE _id = $1', [id]);
    expect(rows[0].claimOwner).toBeNull();
    expect(Number(rows[0].claimUntil)).toBe(retryAt);
    expect(rows[0].lastError).toContain('gecici');
    expect(rows[0].sent).toBe(false);

    // İleri vadelendirildiği için ŞİMDİ tekrar talep edilemez.
    const immediate = await ScheduledMessages.claimDueBefore(now(), 'worker-B');
    expect(immediate.some(r => r._id === id)).toBe(false);
  });

  it('TERMİNAL hata işi kalıcı olarak devre dışı bırakır', async () => {
    // Sonsuza kadar yeniden denenen bir iş, kuyruğu ve logu boğar.
    const id = await seedScheduled();
    await ScheduledMessages.claimDueBefore(now(), 'worker-A');

    expect(await ScheduledMessages.markFailed(id, 'worker-A', 'kanal silinmis')).toBe(true);

    const { rows } = await q('SELECT "failedAt", "failureReason" FROM scheduled_msgs WHERE _id = $1', [id]);
    expect(rows[0].failedAt).not.toBeNull();
    expect(rows[0].failureReason).toContain('kanal silinmis');

    // Bir daha ASLA talep edilmemeli.
    const later = await ScheduledMessages.claimDueBefore(now() + 3_600_000, 'worker-B');
    expect(later.some(r => r._id === id)).toBe(false);
  });

  it('BAYAT kira (çökmüş işçi) süresi dolunca DEVRALINABİLİR', async () => {
    // İşçi talep ettikten sonra çökerse iş sonsuza kadar kilitli kalmamalı.
    const id = await seedScheduled();
    await ScheduledMessages.claimDueBefore(now(), 'crashed-worker');

    // Kiranın süresini geçmişe çekerek çökmeyi taklit et.
    await q('UPDATE scheduled_msgs SET "claimUntil" = $1 WHERE _id = $2', [now() - 1000, id]);

    const taken = await ScheduledMessages.claimDueBefore(now(), 'recovery-worker');
    expect(taken.some(r => r._id === id)).toBe(true);

    const { rows } = await q('SELECT "claimOwner" FROM scheduled_msgs WHERE _id = $1', [id]);
    expect(rows[0].claimOwner).toBe('recovery-worker');
  });

  it('AKTİF kira varken iptal `dispatching` döner (yarış)', async () => {
    // Kullanıcı "iptal ettim" derken mesaj gönderiliyorsa, iptalin BAŞARILI
    // olduğunu söylemek yalan olurdu.
    const userId = await seedUser();
    const { serverId, channelId } = await seedServerAndChannel(userId);
    const id = uid();
    await q(
      'INSERT INTO scheduled_msgs (_id, "channelId", "serverId", "userId", "displayName", username,'
      + ' content, "sendAt", "createdAt", sent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)',
      [id, channelId, serverId, userId, 'Q', 'q', 'iptal yarisi', now() - 1000, now()],
    );
    cleanup.push({ table: 'scheduled_msgs', column: '_id', value: id });

    await ScheduledMessages.claimDueBefore(now(), 'active-dispatcher');
    expect(await ScheduledMessages.cancelPending(id, userId)).toBe('dispatching');
  });

  it('kira YOKKEN iptal başarılı olur (yanlış pozitif kontrolü)', async () => {
    const userId = await seedUser();
    const { serverId, channelId } = await seedServerAndChannel(userId);
    const id = uid();
    await q(
      'INSERT INTO scheduled_msgs (_id, "channelId", "serverId", "userId", "displayName", username,'
      + ' content, "sendAt", "createdAt", sent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)',
      [id, channelId, serverId, userId, 'Q', 'q', 'iptal edilebilir', now() + 3_600_000, now()],
    );
    cleanup.push({ table: 'scheduled_msgs', column: '_id', value: id });

    expect(await ScheduledMessages.cancelPending(id, userId)).toBe('cancelled');

    // İptal edilen iş artık talep edilmemeli.
    const claimed = await ScheduledMessages.claimDueBefore(now() + 7_200_000, 'worker-X');
    expect(claimed.some(r => r._id === id)).toBe(false);
  });

  it('BAŞKA kullanıcının işi iptal EDİLEMEZ', async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const { serverId, channelId } = await seedServerAndChannel(owner);
    const id = uid();
    await q(
      'INSERT INTO scheduled_msgs (_id, "channelId", "serverId", "userId", "displayName", username,'
      + ' content, "sendAt", "createdAt", sent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)',
      [id, channelId, serverId, owner, 'Q', 'q', 'baskasinin isi', now() + 3_600_000, now()],
    );
    cleanup.push({ table: 'scheduled_msgs', column: '_id', value: id });

    expect(await ScheduledMessages.cancelPending(id, stranger)).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════
RUN('gerçek PostgreSQL — giden webhook dayanıklılığı', () => {
  async function seedWebhook(): Promise<{ webhookId: string; serverId: string }> {
    const userId = await seedUser();
    const { serverId } = await seedServerAndChannel(userId);
    const webhookId = uid();
    await q(
      'INSERT INTO outgoing_webhooks (_id, "serverId", name, url, events, enabled, "createdBy", "createdAt")'
      + " VALUES ($1,$2,$3,$4,$5::jsonb,TRUE,$6,$7)",
      [webhookId, serverId, 'Queue Hook', 'https://example.invalid/hook',
        JSON.stringify(['message:new']), userId, now()],
    );
    cleanup.push({ table: 'outgoing_webhooks', column: '_id', value: webhookId });
    return { webhookId, serverId };
  }

  it('EŞZAMANLI iki işçiden YALNIZ BİRİ teslimatı talep eder', async () => {
    const { webhookId, serverId } = await seedWebhook();
    const deliveryId = await OutgoingWebhooks.enqueueDeliveryBounded(
      webhookId, serverId, 'message:new', { n: 1 }, 100,
    );
    expect(deliveryId).toBeTruthy();
    cleanup.push({ table: 'outgoing_webhook_deliveries', column: '_id', value: String(deliveryId) });

    const at = now();
    const [a, b] = await Promise.all([
      OutgoingWebhooks.claimDueDeliveries(at, 'wh-worker-A'),
      OutgoingWebhooks.claimDueDeliveries(at, 'wh-worker-B'),
    ]);

    const total = a.filter(r => r._id === deliveryId).length + b.filter(r => r._id === deliveryId).length;
    expect(total).toBe(1);
  });

  it('retry deneme sayısını artırır ve İLERİ tarihe atar', async () => {
    const { webhookId, serverId } = await seedWebhook();
    const deliveryId = String(await OutgoingWebhooks.enqueueDeliveryBounded(
      webhookId, serverId, 'message:new', { n: 2 }, 100,
    ));
    cleanup.push({ table: 'outgoing_webhook_deliveries', column: '_id', value: deliveryId });

    await OutgoingWebhooks.claimDueDeliveries(now(), 'wh-worker-A');
    const nextAt = now() + 600_000;
    await OutgoingWebhooks.retryDelivery(deliveryId, 'wh-worker-A', 1, nextAt, 'HTTP 503');

    const { rows } = await q('SELECT attempts, "nextAt", "claimOwner" FROM outgoing_webhook_deliveries WHERE _id = $1', [deliveryId]);
    expect(Number(rows[0].attempts)).toBe(1);
    expect(Number(rows[0].nextAt)).toBe(nextAt);
    expect(rows[0].claimOwner).toBeNull();

    // İleri vadelendirildiği için şimdi talep edilemez.
    const immediate = await OutgoingWebhooks.claimDueDeliveries(now(), 'wh-worker-B');
    expect(immediate.some(r => r._id === deliveryId)).toBe(false);
  });

  it('tamamlama YALNIZCA kira sahibinden kabul edilir', async () => {
    const { webhookId, serverId } = await seedWebhook();
    const deliveryId = String(await OutgoingWebhooks.enqueueDeliveryBounded(
      webhookId, serverId, 'message:new', { n: 3 }, 100,
    ));
    await OutgoingWebhooks.claimDueDeliveries(now(), 'wh-worker-A');

    await OutgoingWebhooks.completeDelivery(deliveryId, 'wh-worker-B');   // yabancı
    const stillThere = await q('SELECT 1 FROM outgoing_webhook_deliveries WHERE _id = $1', [deliveryId]);
    expect(stillThere.rows).toHaveLength(1);

    await OutgoingWebhooks.completeDelivery(deliveryId, 'wh-worker-A');   // sahip
    const gone = await q('SELECT 1 FROM outgoing_webhook_deliveries WHERE _id = $1', [deliveryId]);
    expect(gone.rows).toHaveLength(0);
  });

  it('bekleyen satırlar webhook başına SINIRLANIR (kuyruk şişmesi)', async () => {
    // Ulasilamayan bir uc nokta, veritabanini sinirsiz kuyrukla dolduramamali.
    // NOT: imza (webhookId, serverId, eventName, payload, maxPending) -- besinci
    // arguman SINIRDIR. Fazladan bir zaman damgasi gecirmek siniri devre disi
    // birakirdi; bu test tam olarak sinirin uygulandigini olcer.
    const { webhookId, serverId } = await seedWebhook();
    const limit = 3;
    const ids: string[] = [];
    for (let i = 0; i < limit + 3; i++) {
      const id = await OutgoingWebhooks.enqueueDeliveryBounded(
        webhookId, serverId, 'message:new', { i }, limit,
      );
      if (id) ids.push(String(id));
    }
    for (const id of ids) cleanup.push({ table: 'outgoing_webhook_deliveries', column: '_id', value: id });

    const { rows } = await q('SELECT count(*)::int AS n FROM outgoing_webhook_deliveries WHERE "webhookId" = $1', [webhookId]);
    expect(rows[0].n).toBeLessThanOrEqual(limit);
  });
});

// ════════════════════════════════════════════════════════════════════════════
RUN('gerçek PostgreSQL — federasyon teslimat dayanıklılığı', () => {
  // Kanonik tablo `ap_delivery_queue`tir (FederationRepository:190) ve
  // sutunlari: _id, payload, attempts, "nextAt", "createdAt",
  // "claimOwner", "claimUntil".
  async function seedDelivery(): Promise<string> {
    const id = uid();
    await FederationRepo.insertDeliveryEntry({
      _id: id,
      payload: JSON.stringify({ type: 'Create', target: 'https://remote.invalid/inbox' }),
      attempts: 0,
      nextAt: now() - 1000,
      createdAt: now(),
    });
    cleanup.push({ table: 'ap_delivery_queue', column: '_id', value: id });
    return id;
  }

  it('EŞZAMANLI iki işçiden YALNIZ BİRİ teslimatı talep eder', async () => {
    const id = await seedDelivery();
    const at = now();

    const [a, b] = await Promise.all([
      FederationRepo.claimPendingDeliveries(at, 'fed-A'),
      FederationRepo.claimPendingDeliveries(at, 'fed-B'),
    ]);

    const total = a.filter((r: { _id: string }) => r._id === id).length
                + b.filter((r: { _id: string }) => r._id === id).length;
    expect(total).toBe(1);
  });

  it('kayıt silme YALNIZCA kira sahibinden kabul edilir', async () => {
    const id = await seedDelivery();
    await FederationRepo.claimPendingDeliveries(now(), 'fed-A');

    await FederationRepo.removeDeliveryEntry(id, 'fed-B');    // yabancı
    let check = await q('SELECT 1 FROM ap_delivery_queue WHERE _id = $1', [id]);
    expect(check.rows).toHaveLength(1);

    await FederationRepo.removeDeliveryEntry(id, 'fed-A');    // sahip
    check = await q('SELECT 1 FROM ap_delivery_queue WHERE _id = $1', [id]);
    expect(check.rows).toHaveLength(0);
  });
});
