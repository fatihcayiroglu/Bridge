// server/tests/pg-integration/federation-inbox-claim.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ActivityPub GELEN KUTUSU — AYNI ETKİNLİK İKİ DÜĞÜME DÜŞERSE
// ════════════════════════════════════════════════════════════════════════════
// Uzak sunucular teslimatı yeniden dener; yük dengeleyici aynı imzalı etkinliği
// farklı Bridge düğümlerine iletebilir. `FederationRepository.claimInboundActivity`
// kısmi-benzersiz anahtarlı UPSERT + kira ile bunu tek işlemeye indirir; kendi
// yorumu "eşzamanlılık kanıtı gerçek PostgreSQL'in sorumluluğudur" der — ama
// böyle bir kanıt YOKTU (P1 çok-düğüm dağıtık otorite envanteri). Burada:
//
//   · aynı etkinliği eşzamanlı talep eden iki "düğümden" YALNIZ BİRİ işler,
//   · işlenmiş etkinliğin tekrarı `processed` alır (yan etki yok),
//   · işleyen düğüm ölürse (kira dolar) etkinlik devralınır; ölü sahip artık
//     tamamlayamaz,
//   · başarısız işleme kirayı bırakır ve yeniden deneme işler.

import crypto from 'crypto';

const RUN = process.env.PG_TEST_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require('../../db/loader').default;
import Federation from '../../db/repositories/FederationRepository';

const uid = (): string => crypto.randomUUID();
const users: string[] = [];

async function seedUser(): Promise<string> {
  const id = uid();
  await db._pool.query('INSERT INTO users (_id, username, "displayName", password, "tokenVersion", "createdAt") VALUES ($1,$2,$3,$4,0,$5)',
    [id, 'ap_' + id.slice(0, 8), 'AP User', 'x', Date.now()]);
  users.push(id);
  return id;
}

function claimInput(targetUserId: string, activityId: string, owner: string, createdAt = Date.now(), leaseMs = 5 * 60_000) {
  return {
    id: uid(), targetUserId, actorUrl: 'https://remote.example/users/alice', activityId,
    type: 'Create', activity: { id: activityId, type: 'Create' },
    claimOwner: owner, claimUntil: createdAt + leaseMs, createdAt,
  };
}

RUN('gerçek PostgreSQL — ActivityPub gelen kutusu tek işleme', () => {
  afterAll(async () => {
    for (const u of users) {
      await db._pool.query('DELETE FROM ap_activities WHERE "targetUserId"=$1', [u]).catch(() => undefined);
      await db._pool.query('DELETE FROM users WHERE _id=$1', [u]).catch(() => undefined);
    }
  });

  it('the same activity delivered concurrently to several nodes is claimed by exactly one', async () => {
    const target = await seedUser();
    const activityId = `https://remote.example/activities/${uid()}`;
    const results = await Promise.all(['node-a', 'node-b', 'node-c', 'node-a2', 'node-b2', 'node-c2']
      .map(owner => Federation.claimInboundActivity(claimInput(target, activityId, owner))));
    const claimed = results.filter(r => r.status === 'claimed');
    expect(claimed).toHaveLength(1);
    expect(results.filter(r => r.status === 'busy')).toHaveLength(5);
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    const rows = await db._pool.query('SELECT count(*)::int AS n FROM ap_activities WHERE "targetUserId"=$1 AND "activityId"=$2', [target, activityId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('a processed activity is answered as processed on every later delivery (no second side effect)', async () => {
    const target = await seedUser();
    const activityId = `https://remote.example/activities/${uid()}`;
    const first = await Federation.claimInboundActivity(claimInput(target, activityId, 'node-a'));
    expect(first.status).toBe('claimed');
    await Federation.completeInboundActivity(first.id, 'node-a');
    const later = await Promise.all(['node-b', 'node-c'].map(o => Federation.claimInboundActivity(claimInput(target, activityId, o))));
    expect(later.map(r => r.status)).toEqual(['processed', 'processed']);
  });

  it('a claim held by a dead node is taken over after its lease; the dead owner can no longer complete', async () => {
    const target = await seedUser();
    const activityId = `https://remote.example/activities/${uid()}`;
    const past = Date.now() - 10 * 60_000;
    const dead = await Federation.claimInboundActivity(claimInput(target, activityId, 'node-dead', past, 60_000));
    expect(dead.status).toBe('claimed');
    // Negative control: a LIVE lease is not taken over.
    const liveTarget = await seedUser();
    const liveId = `https://remote.example/activities/${uid()}`;
    expect((await Federation.claimInboundActivity(claimInput(liveTarget, liveId, 'node-live'))).status).toBe('claimed');
    expect((await Federation.claimInboundActivity(claimInput(liveTarget, liveId, 'node-other'))).status).toBe('busy');

    const takeover = await Federation.claimInboundActivity(claimInput(target, activityId, 'node-b'));
    expect(takeover).toEqual({ status: 'claimed', id: dead.id });
    await expect(Federation.completeInboundActivity(dead.id, 'node-dead')).rejects.toThrow(/ownership lost/);
    await Federation.completeInboundActivity(takeover.id, 'node-b');
    expect((await Federation.claimInboundActivity(claimInput(target, activityId, 'node-c'))).status).toBe('processed');
  });

  it('a failed processing attempt releases the claim; the redelivery is processed', async () => {
    const target = await seedUser();
    const activityId = `https://remote.example/activities/${uid()}`;
    const first = await Federation.claimInboundActivity(claimInput(target, activityId, 'node-a'));
    await Federation.failInboundActivity(first.id, 'node-a', 'handler failed');
    const retry = await Federation.claimInboundActivity(claimInput(target, activityId, 'node-b'));
    expect(retry).toEqual({ status: 'claimed', id: first.id });
    await Federation.completeInboundActivity(retry.id, 'node-b');
  });
});

export {};
