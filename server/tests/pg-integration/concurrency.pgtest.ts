// server/tests/pg-integration/concurrency.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL EŞZAMANLILIK KANITI
// ════════════════════════════════════════════════════════════════════════════
// Bu dosyadaki her test GERÇEKTEN eşzamanlı çağrılar yapar (`Promise.all`) ve
// sonucu GERÇEK bir PostgreSQL örneğinde ölçer. Mock'lanmış bir
// `SELECT ... FOR UPDATE` testi SQL'i ve kontrol akışını doğrulayabilir;
// SATIR KİLİDİNİN kaybedilen güncellemeyi ENGELLEDİĞİNİ kanıtlayamaz.
// Burada kanıtlanır.
//
// Kapsanan atomik sahipler:
//   · AuthRepository.rotateRefreshTokenAtomic  — tek kazanan + replay
//   · InviteRepository.consumeForMemberAtomic  — son slot yarışı
//   · PollRepository.mutateVoteAtomic          — oy yarışı
//   · MessageRepository.toggleReactionAtomic   — reaksiyon yarışı + 20 sınırı
//
// Her test kendi verisini benzersiz kimliklerle oluşturur ve siler; paylaşılan
// şemayı DEĞİŞTİRMEZ ve hiçbir tabloyu DROP etmez.

import crypto from 'crypto';

const RUN = process.env.PG_TEST_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require('../../db/loader').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuthRepository = require('../../db/repositories/AuthRepository');
import InviteRepository from '../../db/repositories/InviteRepository';
import PollRepository from '../../db/repositories/PollRepository';
import { Messages, Members, Servers, Users } from '../../db/repositories';

const uid = (): string => crypto.randomUUID();
const now = (): number => Date.now();
const created: Array<{ table: string; column: string; value: string }> = [];

async function q(sql: string, params: unknown[] = []) {
  return db._pool.query(sql, params);
}

async function makeUser(): Promise<string> {
  const id = uid();
  await q(
    'INSERT INTO users (_id, username, "displayName", password, "tokenVersion", "createdAt")' +
    ' VALUES ($1, $2, $3, $4, 0, $5)',
    [id, 'u_' + id.slice(0, 8), 'Test User', 'x', now()],
  );
  created.push({ table: 'users', column: '_id', value: id });
  return id;
}

async function makeServer(ownerId: string): Promise<string> {
  const id = uid();
  await q(
    'INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$2,$3,$4)',
    [id, 'PG Test Server', ownerId, now()],
  );
  created.push({ table: 'servers', column: '_id', value: id });
  return id;
}

async function makeChannel(serverId: string): Promise<string> {
  const id = uid();
  await q(
    'INSERT INTO channels (_id, "serverId", name, type, "createdAt") VALUES ($1,$2,$3,$4,$5)',
    [id, serverId, 'genel', 'text', now()],
  );
  created.push({ table: 'channels', column: '_id', value: id });
  return id;
}

afterAll(async () => {
  // Ters sırada temizle (FK zincirleri).
  for (const row of created.reverse()) {
    try {
      await q('DELETE FROM ' + row.table + ' WHERE "' + row.column + '" = $1', [row.value]);
    } catch {
      // Satır zaten cascade ile gitmiş olabilir.
    }
  }
  try { await db._pool.end(); } catch { /* zaten kapalı */ }
});

RUN('gerçek PostgreSQL — sunucu aggregate oluşturma', () => {
  function aggregateInput(ownerId: string, suffix: string, maxOwnedServers = 100) {
    const createdAt = now();
    return {
      serverId: uid(),
      ownerId,
      name: `PG Aggregate ${suffix}`,
      icon: '🌐',
      textChannelId: uid(),
      voiceChannelId: uid(),
      createdAt,
      maxOwnedServers,
    };
  }

  async function removeAggregates(ownerId: string): Promise<void> {
    const owned = await q('SELECT _id FROM servers WHERE "ownerId"=$1', [ownerId]);
    const ids = owned.rows.map(row => String(row._id));
    if (!ids.length) return;
    await q('DELETE FROM members WHERE "serverId" = ANY($1::text[])', [ids]);
    await q('DELETE FROM channels WHERE "serverId" = ANY($1::text[])', [ids]);
    await q('DELETE FROM servers WHERE _id = ANY($1::text[])', [ids]);
  }

  it('creates the server, two default channels, and owner membership atomically', async () => {
    const ownerId = await makeUser();
    const input = aggregateInput(ownerId, 'single');
    try {
      const result = await Servers.createWithDefaultsAtomic(input);
      expect(result.status).toBe('created');
      if (result.status !== 'created') throw new Error('server aggregate was unexpectedly limited');
      expect(result.server._id).toBe(input.serverId);

      const channels = await q(
        'SELECT _id, name, type, "createdAt" FROM channels WHERE "serverId"=$1 ORDER BY "order", _id',
        [input.serverId],
      );
      // Final21 Faz 19 (19-27): BIGINT artık SAYI döner (db/postgres/pool.ts INT8 ayrıştırıcısı).
      expect(channels.rows).toMatchObject([
        { _id: input.textChannelId, name: 'general', type: 'text', createdAt: input.createdAt },
        { _id: input.voiceChannelId, name: 'General Voice', type: 'voice', createdAt: input.createdAt },
      ]);
      const member = await q(
        'SELECT "userId", roles, "joinedAt" FROM members WHERE "serverId"=$1',
        [input.serverId],
      );
      expect(member.rows).toMatchObject([
        { userId: ownerId, roles: [], joinedAt: input.createdAt },
      ]);
    } finally {
      await removeAggregates(ownerId);
    }
  });

  it('serializes concurrent creation at the owner limit with exactly one winner', async () => {
    const ownerId = await makeUser();
    const a = aggregateInput(ownerId, 'race-a', 1);
    const b = aggregateInput(ownerId, 'race-b', 1);
    try {
      const [ra, rb] = await Promise.all([
        Servers.createWithDefaultsAtomic(a),
        Servers.createWithDefaultsAtomic(b),
      ]);
      expect([ra.status, rb.status].sort()).toEqual(['created', 'limit']);

      const aggregate = await q(
        `SELECT
           (SELECT count(*)::int FROM servers WHERE "ownerId"=$1) AS servers,
           (SELECT count(*)::int FROM channels WHERE "serverId" IN
             (SELECT _id FROM servers WHERE "ownerId"=$1)) AS channels,
           (SELECT count(*)::int FROM members WHERE "serverId" IN
             (SELECT _id FROM servers WHERE "ownerId"=$1)) AS members`,
        [ownerId],
      );
      expect(aggregate.rows[0]).toEqual({ servers: 1, channels: 2, members: 1 });
    } finally {
      await removeAggregates(ownerId);
    }
  });
});

RUN('gerçek PostgreSQL — refresh token rotasyonu', () => {
  it('EŞZAMANLI iki rotasyondan YALNIZ BİRİ kazanır', async () => {
    // ── MOCK'UN KANITLAYAMADIĞI ────────────────────────────────────────────
    // Birim testi rotasyonu bir JS Map kilidiyle sıraya sokuyordu. Gerçek
    // dağıtımda iki istek AYRI süreçlere düşebilir; tek koruma
    // `SELECT ... FOR UPDATE`tir. Kaybedilen güncelleme burada, çalınmış bir
    // refresh token'ın kullanılmaya devam edebilmesi demektir.
    const userId = await makeUser();
    const oldHash = crypto.randomBytes(32).toString('hex');
    await q(
      'INSERT INTO refresh_tokens (token, "userId", "expiresAt", "createdAt", used, family, "tokenVersion")' +
      ' VALUES ($1,$2,$3,$4,false,$5,0)',
      [oldHash, userId, now() + 3600000, now(), uid()],
    );

    const rotate = () => AuthRepository.rotateRefreshTokenAtomic({
      oldTokenHash: oldHash,
      newTokenHash: crypto.randomBytes(32).toString('hex'),
      newFamily: uid(),
      now: now(),
      expiresAt: now() + 3600000,
    });

    const [a, b] = await Promise.all([rotate(), rotate()]);
    const statuses = [a?.status, b?.status];

    // Tam olarak bir kazanan; diğeri reddedilmeli.
    expect(statuses.filter((s) => s === 'ok')).toHaveLength(1);
    expect(statuses.filter((s) => s !== 'ok')).toHaveLength(1);

    // ── KAYBEDENİN DAVRANIŞI: REPLAY SAYILIR ─────────────────────────────
    // Kaybeden, satırı ARTIK `used=true` görür ve bunu bir REPLAY olarak
    // sınıflandırıp AİLEYİ İPTAL EDER. Bu, rotasyonlu refresh token'ların
    // kasıtlı ve savunulabilir sözleşmesidir: çalınmış bir token ile meşru
    // istemcinin yarışı ayırt edilemez, bu yüzden fail-closed davranılır ve
    // oturum sonlandırılır.
    //
    // OPERASYONEL SONUÇ (raporda belirtildi): istemcinin AYNI ANDA iki
    // yenileme göndermesi (örneğin iki sekme) oturumu düşürür. İstemci
    // tarafında yenileme çağrıları tekilleştirilmelidir.
    expect(statuses).toContain('reuse');

    // Aile iptal edildiği için eski satır artık var OLMAMALIDIR.
    const { rows } = await q('SELECT used FROM refresh_tokens WHERE token = $1', [oldHash]);
    expect(rows).toHaveLength(0);
  });

  it('KULLANILMIŞ token REPLAY edilirse TÜM aile iptal edilir', async () => {
    const userId = await makeUser();
    const family = uid();
    const usedHash = crypto.randomBytes(32).toString('hex');
    const siblingHash = crypto.randomBytes(32).toString('hex');

    await q(
      'INSERT INTO refresh_tokens (token, "userId", "expiresAt", "createdAt", used, family, "tokenVersion")' +
      ' VALUES ($1,$2,$3,$4,true,$5,0), ($6,$2,$3,$4,false,$5,0)',
      [usedHash, userId, now() + 3600000, now(), family, siblingHash],
    );

    const result = await AuthRepository.rotateRefreshTokenAtomic({
      oldTokenHash: usedHash,
      newTokenHash: crypto.randomBytes(32).toString('hex'),
      newFamily: uid(),
      now: now(),
      expiresAt: now() + 3600000,
    });

    expect(result?.status).toBe('reuse');

    // Aile zinciri iptal edilmeli: çalınan token bir oturumu ele geçiremesin.
    const { rows } = await q('SELECT token FROM refresh_tokens WHERE family = $1', [family]);
    expect(rows).toHaveLength(0);
  });
});

RUN('gerçek PostgreSQL — kalıcı MFA/X3DH tek-kullanım durumu', () => {
  it('aynı TOTP adımını eşzamanlı iki oturumdan yalnız biri tüketir', async () => {
    const userId = await makeUser();
    await q(
      `UPDATE users
          SET "twoFactorEnabled"=TRUE,
              "twoFactorSecret"='JBSWY3DPEHPK3PXP',
              "twoFactorBackup"='[]'::jsonb,
              "twoFactorLastUsedStep"=NULL
        WHERE _id=$1`,
      [userId],
    );
    const step = Math.floor(Date.now() / 30_000);
    const [a, b] = await Promise.all([
      Users.consumeTotpStep(userId, step),
      Users.consumeTotpStep(userId, step),
    ]);
    expect([a, b].sort()).toEqual([false, true]);
    const { rows } = await q('SELECT "twoFactorLastUsedStep" AS step FROM users WHERE _id=$1', [userId]);
    expect(Number(rows[0].step)).toBe(step);
  });

  it('eşzamanlı X3DH alıcıları aynı one-time prekey değerini alamaz', async () => {
    const userId = await makeUser();
    await q(
      `UPDATE users
          SET "x3dhIdentityKey"=$2,
              "x3dhSignedPreKey"=$3::jsonb,
              "x3dhOneTimePreKeys"=$4::jsonb
        WHERE _id=$1`,
      [userId, 'identity-key', JSON.stringify({ keyId: 9, publicKey: 'signed-key', signature: 'signature' }),
        JSON.stringify([{ keyId: 1, publicKey: 'otpk-one' }, { keyId: 2, publicKey: 'otpk-two' }])],
    );
    const [a, b] = await Promise.all([
      Users.consumeX3dhPreKeyBundle(userId),
      Users.consumeX3dhPreKeyBundle(userId),
    ]);
    const consumed = [a?.oneTimePreKey?.publicKey, b?.oneTimePreKey?.publicKey].sort();
    expect(consumed).toEqual(['otpk-one', 'otpk-two']);
    const { rows } = await q('SELECT jsonb_array_length("x3dhOneTimePreKeys") AS remaining FROM users WHERE _id=$1', [userId]);
    expect(Number(rows[0].remaining)).toBe(0);
  });

  it('DB constraints reject coercible backup objects and malformed enabled TOTP secrets', async () => {
    const userId = await makeUser();
    await expect(q(
      `UPDATE users SET "twoFactorBackup"='[{"code":"known"}]'::jsonb WHERE _id=$1`,
      [userId],
    )).rejects.toThrow(/users_two_factor_state_valid/);
    await expect(q(
      `UPDATE users SET "twoFactorEnabled"=TRUE, "twoFactorSecret"='!' WHERE _id=$1`,
      [userId],
    )).rejects.toThrow(/users_two_factor_state_valid/);
  });
});

RUN('gerçek PostgreSQL — davet son slot yarışı', () => {
  it('maxUses=1 iken EŞZAMANLI iki katılımcıdan YALNIZ BİRİ üye olur', async () => {
    // Kaybedilen güncelleme burada "davet limiti aşıldı" demektir: kapalı bir
    // topluluğa limitin ötesinde üye sızar.
    const owner = await makeUser();
    const serverId = await makeServer(owner);
    const a = await makeUser();
    const b = await makeUser();

    const inviteId = uid();
    await q(
      'INSERT INTO invites (_id, code, "serverId", "createdBy", "expiresAt", "maxUses", uses)' +
      ' VALUES ($1,$2,$3,$4,$5,1,0)',
      [inviteId, 'c_' + inviteId.slice(0, 8), serverId, owner, now() + 3600000],
    );

    const [ra, rb] = await Promise.all([
      InviteRepository.consumeForMemberAtomic(inviteId, a, serverId),
      InviteRepository.consumeForMemberAtomic(inviteId, b, serverId),
    ]);

    expect([ra, rb].filter((r) => r?.status === 'ok')).toHaveLength(1);
    expect([ra, rb].filter((r) => r?.status === 'max_uses')).toHaveLength(1);

    const { rows: inv } = await q('SELECT uses FROM invites WHERE _id = $1', [inviteId]);
    expect(Number(inv[0].uses)).toBe(1);

    const { rows: mem } = await q(
      'SELECT "userId" FROM members WHERE "serverId" = $1 AND "userId" = ANY($2::text[])',
      [serverId, [a, b]],
    );
    expect(mem).toHaveLength(1);
  });

  it('REDDEDİLEN katılım kullanımı YAKMAZ (zaten üye)', async () => {
    const owner = await makeUser();
    const serverId = await makeServer(owner);
    const joiner = await makeUser();

    await Members.insert(joiner, serverId);

    const inviteId = uid();
    await q(
      'INSERT INTO invites (_id, code, "serverId", "createdBy", "expiresAt", "maxUses", uses)' +
      ' VALUES ($1,$2,$3,$4,$5,5,0)',
      [inviteId, 'c_' + inviteId.slice(0, 8), serverId, owner, now() + 3600000],
    );

    const r = await InviteRepository.consumeForMemberAtomic(inviteId, joiner, serverId);
    expect(r?.status).toBe('already_member');

    const { rows } = await q('SELECT uses FROM invites WHERE _id = $1', [inviteId]);
    expect(Number(rows[0].uses)).toBe(0);
  });

  it('BAŞKA sunucunun daveti kapsam dışı reddedilir (locator karıştırma)', async () => {
    const owner = await makeUser();
    const serverA = await makeServer(owner);
    const serverB = await makeServer(owner);
    const joiner = await makeUser();

    const inviteId = uid();
    await q(
      'INSERT INTO invites (_id, code, "serverId", "createdBy", "expiresAt", "maxUses", uses)' +
      ' VALUES ($1,$2,$3,$4,$5,5,0)',
      [inviteId, 'c_' + inviteId.slice(0, 8), serverA, owner, now() + 3600000],
    );

    // Çağıran serverB iddia ediyor; kanonik sahiplik serverA.
    const r = await InviteRepository.consumeForMemberAtomic(inviteId, joiner, serverB);
    expect(r?.status).toBe('scope_mismatch');

    const { rows } = await q('SELECT uses FROM invites WHERE _id = $1', [inviteId]);
    expect(Number(rows[0].uses)).toBe(0);
  });
});

RUN('gerçek PostgreSQL — anket oyu yarışı', () => {
  it('EŞZAMANLI iki farklı kullanıcının oyu KAYBOLMAZ', async () => {
    // Oku-değiştir-yaz ile son yazan kazanır ve bir oy sessizce kaybolurdu.
    const owner = await makeUser();
    const serverId = await makeServer(owner);
    const channelId = await makeChannel(serverId);
    const v1 = await makeUser();
    const v2 = await makeUser();

    const pollId = uid();
    const options = [
      { id: 'o1', text: 'Evet', votes: [] },
      { id: 'o2', text: 'Hayir', votes: [] },
    ];
    await q(
      'INSERT INTO polls (_id, "channelId", "serverId", "createdBy", question, options,' +
      ' "multiSelect", "allowVoteChange", closed, "createdAt")' +
      ' VALUES ($1,$2,$3,$4,$5,$6::jsonb,false,true,false,$7)',
      [pollId, channelId, serverId, owner, 'Soru?', JSON.stringify(options), now()],
    );
    created.push({ table: 'polls', column: '_id', value: pollId });

    await Promise.all([
      PollRepository.mutateVoteAtomic(pollId, v1, ['o1'], 'toggle'),
      PollRepository.mutateVoteAtomic(pollId, v2, ['o2'], 'toggle'),
    ]);

    const { rows } = await q('SELECT options FROM polls WHERE _id = $1', [pollId]);
    const stored = typeof rows[0].options === 'string' ? JSON.parse(rows[0].options) : rows[0].options;
    const allVotes: string[] = stored.flatMap((o: { votes?: string[] }) => o.votes ?? []);

    // HER İKİ oy da hayatta olmalı — kaybedilen güncelleme yok.
    expect(allVotes).toContain(v1);
    expect(allVotes).toContain(v2);
  });
});

RUN('gerçek PostgreSQL — reaksiyon yarışı', () => {
  async function seedMessage(): Promise<string> {
    const owner = await makeUser();
    const serverId = await makeServer(owner);
    const channelId = await makeChannel(serverId);
    const msgId = uid();
    await q(
      'INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName",' +
      ' content, reactions, "createdAt")' +
      " VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8)",
      [msgId, channelId, serverId, owner, 'u', 'U', 'merhaba', now()],
    );
    created.push({ table: 'messages', column: '_id', value: msgId });
    return msgId;
  }

  const THUMB = '\u{1F44D}';
  const HEART = '❤️';
  const PARTY = '\u{1F389}';

  it('EŞZAMANLI iki farklı emoji İKİSİ de hayatta kalır', async () => {
    // Doğrudan ölçülen eski arıza: iki istek de 200 dönüyordu ama yalnız 1
    // reaksiyon kalıyordu — kullanıcının GÖRDÜĞÜ bir veri kaybı.
    const msgId = await seedMessage();
    const a = await makeUser();
    const b = await makeUser();

    await Promise.all([
      Messages.toggleReactionAtomic(msgId, THUMB, a),
      Messages.toggleReactionAtomic(msgId, HEART, b),
    ]);

    const { rows } = await q('SELECT reactions FROM messages WHERE _id = $1', [msgId]);
    const reactions = typeof rows[0].reactions === 'string'
      ? JSON.parse(rows[0].reactions) : rows[0].reactions;

    expect(Object.keys(reactions).sort()).toEqual([THUMB, HEART].sort());
    expect(reactions[THUMB]).toContain(a);
    expect(reactions[HEART]).toContain(b);
  });

  it('AYNI emojiye eşzamanlı basan iki kullanıcı da listede kalır', async () => {
    const msgId = await seedMessage();
    const a = await makeUser();
    const b = await makeUser();

    await Promise.all([
      Messages.toggleReactionAtomic(msgId, PARTY, a),
      Messages.toggleReactionAtomic(msgId, PARTY, b),
    ]);

    const { rows } = await q('SELECT reactions FROM messages WHERE _id = $1', [msgId]);
    const reactions = typeof rows[0].reactions === 'string'
      ? JSON.parse(rows[0].reactions) : rows[0].reactions;
    expect(reactions[PARTY].sort()).toEqual([a, b].sort());
  });

  it('20 BENZERSİZ emoji sınırı GERÇEK veritabanında uygulanır', async () => {
    const msgId = await seedMessage();
    const voter = await makeUser();

    for (let i = 0; i < 20; i++) {
      expect(await Messages.toggleReactionAtomic(msgId, 'e' + i, voter)).not.toBe(false);
    }

    // 21. YENİ emoji reddedilmeli…
    expect(await Messages.toggleReactionAtomic(msgId, 'yeni', voter)).toBe(false);
    // …ama MEVCUT bir emojiyi toggle etmek HÂLÂ çalışmalı (yanlış pozitif kontrolü).
    expect(await Messages.toggleReactionAtomic(msgId, 'e0', voter)).not.toBe(false);
  });
});
