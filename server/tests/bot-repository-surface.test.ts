// server/tests/bot-repository-surface.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BotRepository — SORGU YUZEYININ TAMAMI GERCEKTEN CALISTIRILIR
// ════════════════════════════════════════════════════════════════════════════
// Bu depo (repository) bot kimlik dogrulamasinin ve komut kesfinin altindaki
// TEK veri kapisidir. `bot-repository-behavior.test.ts` magaza arizalarinin
// yutulmadigini kanitlar; bu dosya SORGULARIN KENDISINI olcer.
//
// Neden onemli: buradaki her sorgu bir KAPSAM (scope) tasir ve kapsamin
// dusmesi sessiz bir yetki sizintisidir:
//
//   · `findByIdAndServer` — bir sunucunun botu, BASKA sunucudan okunamaz.
//   · `findByIdAndToken` — jeton eslesmesi kimlik dogrulamasidir; yanlis
//     jetonla ayni bot DONMEMELIDIR.
//   · `findByTokenHash` — DEVRE DISI birakilmis bot jetonu ARTIK gecerli
//     degildir. Bu, iptal (revocation) mekanizmasinin ta kendisidir.
//   · `findInstalledForServer` — sunucunun kendi botlari ile pazar yerinden
//     baglanmis botlarin BIRLESIMI; tekillestirilmis ve pasifler HARIC.
//     Tekillestirme duserse ayni komut iki kez kaydolur.
//
// `delete` ve `updateToken` iki imzali (overload) davranir; yanlis dal
// SUNUCU KAPSAMINI dusurur ve baska sunucunun botunu silebilir/yeniden
// jetonlayabilirdi. Iki dal da ayri ayri olculur.
'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import { recordOf, recordsOf, stringOf } from './helpers/narrow';
import Bots from '../db/repositories/BotRepository';

const db = require('../db/loader');

const bot = (id: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, serverId: 's1', name: id, active: true, tokenHash: `hash-${id}`, ...extra });

beforeEach(async () => {
  db._reset?.();
  jest.restoreAllMocks();
});

describe('single-bot lookups keep their scope', () => {
  beforeEach(async () => {
    await db.bots.insert(bot('b1'));
    await db.bots.insert(bot('b2', { serverId: 's2' }));
  });

  it('finds a bot by id', async () => {
    await expect(Bots.findById('b1')).resolves.toEqual(expect.objectContaining({ _id: 'b1' }));
    await expect(Bots.findById('nope')).resolves.toBeNull();
  });

  it('refuses to read another server’s bot through the scoped lookup', async () => {
    await expect(Bots.findByIdAndServer('b1', 's1')).resolves.toEqual(expect.objectContaining({ _id: 'b1' }));
    // Kapsam dusseydi bu satir baska sunucunun botunu dondururdu.
    await expect(Bots.findByIdAndServer('b2', 's1')).resolves.toBeNull();
  });

  it('treats the token hash as part of the identity', async () => {
    await expect(Bots.findByIdAndToken('b1', 's1', 'hash-b1'))
      .resolves.toEqual(expect.objectContaining({ _id: 'b1' }));
    await expect(Bots.findByIdAndToken('b1', 's1', 'wrong-hash')).resolves.toBeNull();
    await expect(Bots.findByIdAndToken('b1', 's2', 'hash-b1')).resolves.toBeNull();
  });

  it('stops honouring a token once the bot is deactivated', async () => {
    await expect(Bots.findByTokenHash('hash-b1')).resolves.toEqual(expect.objectContaining({ _id: 'b1' }));

    await Bots.deactivate('b1', 's1');
    // Iptal budur: pasif bot jetonu ARTIK kimlik dogrulamaz.
    await expect(Bots.findByTokenHash('hash-b1')).resolves.toBeNull();
  });

  it('lists a server’s bots and only that server’s', async () => {
    const rows = await Bots.findByServer('s1');
    expect(rows.map((r: { _id: string }) => r._id)).toEqual(['b1']);
  });

  it('resolves several ids at once and skips inactive ones', async () => {
    await db.bots.insert(bot('b3', { active: false }));
    const rows = await Bots.findByIds(['b1', 'b3', 'missing']);
    expect(rows[0]).toEqual(expect.objectContaining({ _id: 'b1' }));
    expect(rows[1]).toBeNull();      // pasif
    expect(rows[2]).toBeNull();      // yok
  });

  it('returns an empty result for an empty id list', async () => {
    await expect(Bots.findByIds([])).resolves.toEqual([]);
  });

  it('supports an open-ended query', async () => {
    const rows = await Bots.findWhere({ serverId: 's2' });
    expect(rows.map((r: { _id: string }) => r._id)).toEqual(['b2']);
  });
});

describe('writes stamp identity and preserve scope', () => {
  it('insert generates an id and a creation time', async () => {
    const created = recordOf(await Bots.insert({ serverId: 's1', name: 'yeni' }), 'created');
    expect(typeof created._id).toBe('string');
    expect(typeof created.createdAt).toBe('number');
  });

  it('create is the same owner as insert', async () => {
    const created = recordOf(await Bots.create({ serverId: 's1', name: 'ikiz' }), 'created');
    expect(await Bots.findById(String(created._id))).toEqual(expect.objectContaining({ name: 'ikiz' }));
  });

  it('update writes by id alone', async () => {
    await db.bots.insert(bot('b1'));
    await Bots.update('b1', { name: 'yeni ad' });
    expect(await Bots.findById('b1')).toEqual(expect.objectContaining({ name: 'yeni ad' }));
  });

  it('the scoped update refuses a foreign server', async () => {
    await db.bots.insert(bot('b1'));
    await Bots.updateByIdAndServer('b1', 's2', { name: 'ele gecirildi' });
    // Yanlis kapsamli yazma HICBIR SEY degistirmez.
    expect(await Bots.findById('b1')).toEqual(expect.objectContaining({ name: 'b1' }));
  });

  it('deletes with and without a server scope', async () => {
    await db.bots.insert(bot('b1'));
    await db.bots.insert(bot('b2', { serverId: 's2' }));

    // Kapsamli silme yanlis sunucuda ETKISIZDIR.
    await Bots.delete('b1', 's2');
    expect(await Bots.findById('b1')).not.toBeNull();

    await Bots.delete('b1', 's1');
    expect(await Bots.findById('b1')).toBeNull();

    // Kapsamsiz silme yalnizca kimlikle calisir.
    await Bots.delete('b2');
    expect(await Bots.findById('b2')).toBeNull();
  });

  it('re-tokens through both call shapes without losing the server scope', async () => {
    await db.bots.insert(bot('b1'));
    await db.bots.insert(bot('b2', { serverId: 's2' }));

    // Uc argumanli bicim: sunucu kapsami UYGULANIR.
    await Bots.updateToken('b1', 's1', 'hash-yeni');
    expect(await Bots.findById('b1')).toEqual(expect.objectContaining({ tokenHash: 'hash-yeni' }));

    await Bots.updateToken('b2', 's1', 'hash-calindi');
    // Yanlis sunucu kapsamiyla yeniden jetonlama ETKISIZDIR.
    expect(await Bots.findById('b2')).toEqual(expect.objectContaining({ tokenHash: 'hash-b2' }));

    // Iki argumanli bicim: kimlikle yazar.
    await Bots.updateToken('b2', 'hash-dogrudan');
    expect(await Bots.findById('b2')).toEqual(expect.objectContaining({ tokenHash: 'hash-dogrudan' }));
  });
});

describe('server-bot links and installed-bot discovery', () => {
  it('records and reads a single link', async () => {
    await Bots.addToServer('b9', 's1', 'admin-1');
    const link = recordOf(await Bots.findServerBot('b9', 's1'), 'link');
    expect(link).toEqual(expect.objectContaining({ botId: 'b9', serverId: 's1', addedBy: 'admin-1' }));
    expect(typeof link.addedAt).toBe('number');

    await expect(Bots.findServerBot('b9', 's2')).resolves.toBeNull();
  });

  it('lists the links of one server', async () => {
    await Bots.addToServer('b1', 's1', 'a');
    await Bots.addToServer('b2', 's2', 'a');
    const rows = await Bots.findServerBots('s1');
    expect(rows.map((r) => stringOf(r.botId, 'botId'))).toEqual(['b1']);
  });

  it('returns an empty list for a server with no links', async () => {
    await expect(Bots.findServerBots('s-empty')).resolves.toEqual([]);
  });

  it('unions owned and linked bots, de-duplicated and without inactive ones', async () => {
    await db.bots.insert(bot('owned', { serverId: 's1' }));
    await db.bots.insert(bot('owned-off', { serverId: 's1', active: false }));
    await db.bots.insert(bot('market', { serverId: 'marketplace' }));
    await db.bots.insert(bot('market-off', { serverId: 'marketplace', active: false }));

    await Bots.addToServer('market', 's1', 'admin');
    await Bots.addToServer('market-off', 's1', 'admin');
    // Ayni bot hem SAHIPLI hem BAGLI olabilir; iki kez listelenmemelidir.
    await Bots.addToServer('owned', 's1', 'admin');

    const rows = await Bots.findInstalledForServer('s1') as Array<{ _id: string }>;
    const ids = rows.map(r => r._id).sort();

    expect(ids).toEqual(['market', 'owned']);
    // Tekillestirme duserse ayni komut iki kez kaydolurdu.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles a link row that names no bot at all', async () => {
    await db.bots.insert(bot('owned', { serverId: 's1' }));
    await db.serverBots.insert({ _id: 'broken', serverId: 's1' });   // botId yok

    const rows = await Bots.findInstalledForServer('s1') as Array<{ _id: string }>;
    // Bozuk baglanti satiri kesfi COKERTMEZ ve hayalet bot uretmez.
    expect(rows.map(r => r._id)).toEqual(['owned']);
  });

  it('returns nothing for a server with neither owned nor linked bots', async () => {
    await expect(Bots.findInstalledForServer('s-empty')).resolves.toEqual([]);
  });
});

describe('ratings', () => {
  it('stores, reads and updates a rating', async () => {
    const created = recordOf(await Bots.insertRating('b1', 'u1', 4), 'created');
    expect(created).toEqual(expect.objectContaining({ botId: 'b1', userId: 'u1', rating: 4 }));

    const found = recordOf(await Bots.findRating('b1', 'u1'), 'found');
    expect(found.rating).toBe(4);

    await Bots.updateRating(String(created._id), 2);
    const updated = recordOf(await Bots.findRating('b1', 'u1'), 'updated');
    expect(updated.rating).toBe(2);
    expect(typeof updated.updatedAt).toBe('number');
  });

  it('lists every rating for a bot and nothing for an unrated one', async () => {
    await Bots.insertRating('b1', 'u1', 5);
    await Bots.insertRating('b1', 'u2', 3);
    await Bots.insertRating('b2', 'u1', 1);

    const rows = await Bots.findAllRatings('b1') as Array<{ userId: string }>;
    expect(rows.map(r => r.userId).sort()).toEqual(['u1', 'u2']);
    await expect(Bots.findAllRatings('b-unrated')).resolves.toEqual([]);
  });

  it('reports no rating for a user who has not rated', async () => {
    await expect(Bots.findRating('b1', 'nobody')).resolves.toBeNull();
  });
});

describe('incoming webhooks', () => {
  it('reads a stored webhook and reports a missing one', async () => {
    await db.webhooks.insert({ _id: 'w1', channelId: 'c1' });
    await expect(Bots.findIncomingWebhook('w1')).resolves.toEqual(expect.objectContaining({ _id: 'w1' }));
    await expect(Bots.findIncomingWebhook('missing')).resolves.toBeNull();
  });
});
