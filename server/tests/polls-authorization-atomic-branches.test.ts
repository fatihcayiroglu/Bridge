// server/tests/polls-authorization-atomic-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ANKETLER — KANAL GÖRÜNÜRLÜĞÜ, ATOMİK MUTASYON SONUÇLARI VE YARIŞLAR
// ════════════════════════════════════════════════════════════════════════════
//
// `polls.test.ts` mutlu yolu ve temel doğrulamayı ölçer. Ölçülmeyen üç sınıf
// dal doğrudan güvenlik ve veri bütünlüğü taşır:
//
//   · KANAL GÖRÜNÜRLÜĞÜ — sunucu üyeliği kanal görünürlüğü DEĞİLDİR. Göremediği
//     bir kanaldaki anketi okuyabilen/oy verebilen bir üye, o kanalın varlığını
//     ve içeriğini öğrenir. Her uç ayrı ayrı denetlenmelidir.
//   · ATOMİK YOL — üretimde PostgreSQL satır kilidiyle çalışan yol, birim test
//     ortamında `null` döndürür ve HİÇ ölçülmemişti. Depo bir hata durumu
//     bildirdiğinde uç doğru HTTP koduna eşlemezse istemci "başarılı" sanır.
//   · EŞ ZAMANLI SİLME — yazma ile tazeleme okuması arasında anket silinebilir.
//     Uç, silinmiş anketi "güncel" gibi döndürmemelidir.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import { recordsOf, at } from './helpers/narrow';
import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');
import { requireDoc } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
jest.mock('../middleware/rateLimit', () => ({
  limits: { messages: () => (_q: unknown, _s: unknown, n: () => void) => n(), ai: () => (_q: unknown, _s: unknown, n: () => void) => n(), polls: () => (_q: unknown, _s: unknown, n: () => void) => n() },
  rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));

import { Polls } from '../db/repositories';
import { PERMS } from '../lib/permissions';
import pollsRouter from '../routes/polls';
import type { MockDb } from './helpers/mockDb';

const token = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const OWNER = 'anket-sahibi';
const MEMBER = 'anket-uye';
const OUTSIDER = 'anket-yabanci';
const SRV = 'anket-srv';
const OPEN_CH = 'anket-acik-kanal';
const HIDDEN_CH = 'anket-gizli-kanal';
const MUTED_CH = 'anket-sessiz-kanal';

let app: express.Express;
let emitted: Array<{ room: string; event: string; payload: unknown }>;

function poll(over: Record<string, unknown> = {}) {
  return {
    _id: `poll-${Math.random().toString(36).slice(2, 10)}`,
    channelId: OPEN_CH, serverId: SRV, createdBy: OWNER,
    question: 'Favori renk?',
    options: [
      { id: '0', text: 'Kırmızı', votes: [] as string[] },
      { id: '1', text: 'Mavi', votes: [] as string[] },
    ],
    multiSelect: false, allowVoteChange: true, expiresAt: null, closed: false,
    ...over,
  };
}

beforeEach(async () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/index'), db);

  for (const id of [OWNER, MEMBER, OUTSIDER]) await db.users.insert({ _id: id, username: id, displayName: id });
  await db.servers.insert({ _id: SRV, name: 'Anket', ownerId: 'baska-sahip', createdAt: 1 });
  await db.members.insert({ userId: OWNER, serverId: SRV, roles: [], joinedAt: 1 });
  await db.members.insert({ userId: MEMBER, serverId: SRV, roles: [], joinedAt: 1 });

  for (const id of [OPEN_CH, HIDDEN_CH, MUTED_CH]) {
    await db.channels.insert({ _id: id, serverId: SRV, name: id, type: 'text', createdAt: 1 });
  }
  // Gizli kanal: kimse goremez. Sessiz kanal: gorunur ama mesaj gonderilemez.
  await db.channelOverrides.insert({
    _id: 'ovr-hidden', channelId: HIDDEN_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: PERMS.VIEW_CHANNELS, position: 0,
  });
  await db.channelOverrides.insert({
    _id: 'ovr-muted', channelId: MUTED_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: PERMS.SEND_MESSAGES, position: 0,
  });

  emitted = [];
  app = express();
  app.use(express.json());
  app.set('io', { to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }) });
  app.use('/api/channels', pollsRouter);
  app.use('/api/polls', pollsRouter);
  app.use((err: Error & { status?: number }, _q: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _n: unknown) => res.status(500).json({ error: err.message }));
});

afterEach(() => { jest.restoreAllMocks(); });

describe('anket oluşturma yetkisi', () => {
  it('kanalı göremeyen üye anket açamaz', async () => {
    const res = await request(app).post(`/api/channels/${HIDDEN_CH}/polls`)
      .set('Authorization', `Bearer ${token(MEMBER)}`)
      .send({ question: 'Gizli?', options: ['a', 'b'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Missing channel permission');
    expect(await db.polls.find({})).toHaveLength(0);
  });

  it('mesaj gönderemeyen üye kanalı görse de anket açamaz', async () => {
    const res = await request(app).post(`/api/channels/${MUTED_CH}/polls`)
      .set('Authorization', `Bearer ${token(MEMBER)}`)
      .send({ question: 'Sessiz?', options: ['a', 'b'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Missing channel permission');
  });

  it('taşan süre güvenli olmayan bitiş zamanı ürettiğinde reddedilir', async () => {
    const res = await request(app).post(`/api/channels/${OPEN_CH}/polls`)
      .set('Authorization', `Bearer ${token(MEMBER)}`)
      .send({ question: 'Sonsuz?', options: ['a', 'b'], duration: Number.MAX_SAFE_INTEGER });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('duration produces an unsafe expiration timestamp');
    expect(await db.polls.find({})).toHaveLength(0);
  });
});

describe('anket listeleme yetkisi', () => {
  it('olmayan kanal 404 verir', async () => {
    const res = await request(app).get('/api/channels/yok-boyle-kanal/polls')
      .set('Authorization', `Bearer ${token(MEMBER)}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Channel not found');
  });

  it('görünmeyen kanalın anketleri listelenemez', async () => {
    await db.polls.insert(poll({ channelId: HIDDEN_CH, question: 'GIZLI-SORU' }));

    const res = await request(app).get(`/api/channels/${HIDDEN_CH}/polls`)
      .set('Authorization', `Bearer ${token(MEMBER)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Channel is not visible');
    expect(JSON.stringify(res.body)).not.toContain('GIZLI-SORU');
  });

  it('sunucunun üyesi olmayan hiç listeleyemez', async () => {
    const res = await request(app).get(`/api/channels/${OPEN_CH}/polls`)
      .set('Authorization', `Bearer ${token(OUTSIDER)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not a member');
  });

  it('oy dizisi hiç yazılmamış seçenek sıfır oy olarak sunulur', async () => {
    const row = poll();
    delete (row.options[0] as Record<string, unknown>).votes;
    await db.polls.insert(row);

    const res = await request(app).get(`/api/channels/${OPEN_CH}/polls`)
      .set('Authorization', `Bearer ${token(MEMBER)}`);

    expect(res.status).toBe(200);
    expect(res.body[0].options[0]).toEqual(expect.objectContaining({ voteCount: 0, votedByMe: false }));
    expect(res.body[0].options[0]).not.toHaveProperty('votes');
  });
});

describe('oylama yetkisi ve görünürlük', () => {
  it('görünmeyen kanaldaki ankete oy verilemez', async () => {
    const row = poll({ channelId: HIDDEN_CH });
    await db.polls.insert(row);

    const res = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['0'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(recordsOf(at(await requireDoc(db.polls, { _id: row._id }), 'options', 'anket'), 'secenekler')[0]!.votes).toEqual([]);
  });

  it('görünmeyen kanaldaki anket silinemez ve sonuçları okunamaz', async () => {
    const row = poll({ channelId: HIDDEN_CH });
    await db.polls.insert(row);

    const remove = await request(app).delete(`/api/polls/${row._id}`)
      .set('Authorization', `Bearer ${token(MEMBER)}`);
    expect(remove.status).toBe(403);
    expect(await db.polls.findOne({ _id: row._id })).toBeTruthy();

    const withdraw = await request(app).delete(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`);
    expect(withdraw.status).toBe(403);
  });
});

describe('atomik mutasyon sonuçlarının HTTP eşlemesi', () => {
  const cases: Array<[string, number, string]> = [
    ['not_found', 404, 'Poll not found'],
    ['closed', 400, 'Poll is closed'],
    ['expired', 400, 'Poll expired'],
    ['single_choice', 400, 'Single choice only'],
    ['invalid_option', 400, 'Invalid optionId'],
    ['vote_change_forbidden', 403, 'Vote change not allowed for this poll'],
    ['has_votes', 409, 'Cannot change options after votes have been cast'],
    ['beklenmeyen_durum', 500, 'Poll mutation failed'],
  ];

  it.each(cases)('oylamada "%s" durumu %i döner', async (status, code, message) => {
    const row = poll();
    await db.polls.insert(row);
    jest.spyOn(Polls, 'mutateVoteAtomic').mockResolvedValue({ status } as never);

    const res = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['0'] });

    expect(res.status).toBe(code);
    expect(res.body.error).toBe(message);
    // Basarisiz mutasyon yayin URETMEZ.
    expect(emitted).toHaveLength(0);
  });

  it('başarılı atomik oy, oy kimliklerini sızdırmadan yayınlanır', async () => {
    const row = poll();
    await db.polls.insert(row);
    const mutated = { ...row, options: [{ id: '0', text: 'Kırmızı', votes: [MEMBER, 'baska-kullanici'] }, row.options[1]] };
    jest.spyOn(Polls, 'mutateVoteAtomic').mockResolvedValue({ status: 'ok', poll: mutated } as never);

    const res = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['0'] });

    expect(res.status).toBe(200);
    expect(res.body.options[0]).toEqual(expect.objectContaining({ voteCount: 2, votedByMe: true }));
    expect(JSON.stringify(res.body)).not.toContain('baska-kullanici');
    expect(emitted).toEqual([{ room: `channel:${OPEN_CH}`, event: 'poll:updated', payload: { channelId: OPEN_CH, pollId: row._id } }]);
  });

  it('oy geri almada atomik hata da aynı biçimde eşlenir', async () => {
    const row = poll();
    await db.polls.insert(row);
    jest.spyOn(Polls, 'mutateVoteAtomic').mockResolvedValue({ status: 'closed' } as never);

    const res = await request(app).delete(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Poll is closed');
  });

  it('düzenlemede atomik hata eşlenir; başarı yeni içerikle döner', async () => {
    const row = poll();
    await db.polls.insert(row);

    jest.spyOn(Polls, 'updateEditableAtomic').mockResolvedValueOnce({ status: 'has_votes' } as never);
    const conflict = await request(app).patch(`/api/polls/${row._id}`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send({ options: ['x', 'y'] });
    expect(conflict.status).toBe(409);

    jest.spyOn(Polls, 'updateEditableAtomic')
      .mockResolvedValueOnce({ status: 'ok', poll: { ...row, question: 'Yeni soru' } } as never);
    const ok = await request(app).patch(`/api/polls/${row._id}`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send({ question: 'Yeni soru' });
    expect(ok.status).toBe(200);
    expect(ok.body.question).toBe('Yeni soru');
  });
});

describe('bellek içi uyumluluk yolu', () => {
  it('süresi geçmiş ankete oy verilemez ve oy geri alınamaz', async () => {
    const row = poll({ expiresAt: Date.now() - 1000 });
    await db.polls.insert(row);

    const vote = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['0'] });
    expect(vote.status).toBe(400);
    expect(vote.body.error).toBe('Poll expired');

    const withdraw = await request(app).delete(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`);
    expect(withdraw.status).toBe(400);
    expect(withdraw.body.error).toBe('Poll expired');
  });

  it('oy değişimine kapalı ankette aynı seçim tekrarlanabilir, farklı seçim reddedilir', async () => {
    const row = poll({
      allowVoteChange: false,
      options: [
        { id: '0', text: 'Kırmızı', votes: [MEMBER] },
        { id: '1', text: 'Mavi', votes: [] },
      ],
    });
    await db.polls.insert(row);

    const same = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['0'] });
    expect(same.status).toBe(200);
    expect(same.body.options[0]).toEqual(expect.objectContaining({ voteCount: 1, votedByMe: true }));

    const changed = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['1'] });
    expect(changed.status).toBe(403);
    expect(changed.body.error).toBe('Vote change not allowed for this poll');
    // Ilk oy YERINDE kalir.
    expect(recordsOf(at(await requireDoc(db.polls, { _id: row._id }), 'options', 'anket'), 'secenekler')[0]!.votes).toEqual([MEMBER]);
  });

  it('çok seçimli ankette aynı seçeneğe ikinci oy, oyu geri alır', async () => {
    const row = poll({ multiSelect: true });
    await db.polls.insert(row);

    const first = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['0', '1'] });
    expect(first.body.options.map((o: { voteCount: number }) => o.voteCount)).toEqual([1, 1]);

    const second = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['0'] });
    expect(second.body.options.map((o: { voteCount: number }) => o.voteCount)).toEqual([0, 1]);
    expect(second.body.options[0].votedByMe).toBe(false);
  });
});

describe('eş zamanlı silmede tazeleme okuması', () => {
  /** Anket yazma ile tazeleme okuması ARASINDA silinir. */
  function deleteBetweenWriteAndRefresh(row: { _id: string }): void {
    const real = Polls.findById.bind(Polls);
    let reads = 0;
    jest.spyOn(Polls, 'findById').mockImplementation(async (id: string) => {
      reads += 1;
      return reads === 1 ? real(id) : null;
    });
    void row;
  }

  it('oylamada silinmiş anket için eski içerik uydurulmaz', async () => {
    const row = poll();
    await db.polls.insert(row);
    deleteBetweenWriteAndRefresh(row);

    const res = await request(app).post(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`).send({ optionIds: ['0'] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Poll not found');
    expect(emitted).toHaveLength(0);
  });

  it('oy geri almada silinmiş anket için eski içerik uydurulmaz', async () => {
    const row = poll({ options: [{ id: '0', text: 'Kırmızı', votes: [MEMBER] }, { id: '1', text: 'Mavi', votes: [] }] });
    await db.polls.insert(row);
    deleteBetweenWriteAndRefresh(row);

    const res = await request(app).delete(`/api/polls/${row._id}/vote`)
      .set('Authorization', `Bearer ${token(MEMBER)}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Poll not found');
  });

  it('düzenlemede silinmiş anket için eski içerik uydurulmaz', async () => {
    const row = poll();
    await db.polls.insert(row);
    deleteBetweenWriteAndRefresh(row);

    const res = await request(app).patch(`/api/polls/${row._id}`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send({ question: 'Yeni' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Poll not found');
  });
});

describe('düzenleme doğrulaması', () => {
  it('taşan süre düzenlemede de reddedilir', async () => {
    const row = poll();
    await db.polls.insert(row);

    const res = await request(app).patch(`/api/polls/${row._id}`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ duration: Number.MAX_SAFE_INTEGER });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('duration produces an unsafe expiration timestamp');
  });

  it('oy değişimi bayrağı yalnız boolean kabul eder', async () => {
    const row = poll();
    await db.polls.insert(row);

    const res = await request(app).patch(`/api/polls/${row._id}`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send({ allowVoteChange: 'evet' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('allowVoteChange must be a boolean');
  });
});
