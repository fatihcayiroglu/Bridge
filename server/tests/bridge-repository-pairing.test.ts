// server/tests/bridge-repository-pairing.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BridgeRepository — KANAL KOPRUSU TEKLIGI VE YENIDEN ETKINLESTIRME
// ════════════════════════════════════════════════════════════════════════════
// Bir kanal koprusu, bir kanaldaki mesajlari BASKA bir sunucunun kanalina
// iletir. Ayni (kaynak, hedef) cifti icin IKI kopru olusursa her mesaj IKI
// KEZ iletilir — ve bu, gonderen tarafta hicbir belirti vermez.
//
// Bu yuzden olusturma ATOMIKTIR ve uc sonuctan birini verir:
//
//   'created'      — cift yeni
//   'reactivated'  — cift vardi ama kapaliydi; yeniden acilir (KOPYA URETMEZ)
//   'exists'       — cift zaten ETKIN; ikinci bir kayit ACILMAZ
//
// PostgreSQL yolunda bu bir advisory lock + `FOR UPDATE` ile saglanir. Havuz
// yoksa (tek dugum/test) ayni garanti bir SIRA (serial tail) ile saglanir:
// es zamanli iki cagri arka arkaya calisir, ic ice degil. Bu dosya o ikinci
// yolu ve giris dogrulamasini olcer.
'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import { recordOf, recordsOf } from './helpers/narrow';
import Bridges from '../db/repositories/BridgeRepository';

const db = require('../db/loader');

const PAIR = {
  id: 'br-1',
  sourceChannelId: 'c-source',
  targetChannelId: 'c-target',
  sourceServerId: 's-source',
  targetServerId: 's-target',
  label: 'Kopru',
  createdBy: 'admin-1',
  createdAt: 1_700_000_000_000,
};

beforeEach(() => {
  db._reset?.();
  jest.restoreAllMocks();
});

describe('input is validated before any write is attempted', () => {
  it.each([
    ['sourceChannelId'], ['targetChannelId'], ['sourceServerId'],
    ['targetServerId'], ['createdBy'], ['id'],
  ])('refuses a blank %s', async (field) => {
    await expect(Bridges.createOrReactivateAtomic({ ...PAIR, [field]: '   ' }))
      .rejects.toThrow(new RegExp(`${field} is invalid`));
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', {}],
  ])('refuses %s in place of a channel id', async (_label, value) => {
    await expect(Bridges.createOrReactivateAtomic({ ...PAIR, sourceChannelId: value as string }))
      .rejects.toThrow(/sourceChannelId is invalid/);
  });

  it('accepts an empty label, which is the only optional text', async () => {
    // Etiket kullaniciya gorunen bir suslemedir; bos olmasi kopruyu gecersiz
    // KILMAZ. Diger alanlar kimliktir ve bos olamaz.
    const result = await Bridges.createOrReactivateAtomic({ ...PAIR, label: '' });
    expect(result.status).toBe('created');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', 'dun' as unknown as number],
  ])('refuses a %s creation time', async (_label, createdAt) => {
    await expect(Bridges.createOrReactivateAtomic({ ...PAIR, createdAt: createdAt as number }))
      .rejects.toThrow(/createdAt must be positive/);
  });
});

describe('a channel pair can only be bridged once', () => {
  it('creates the pair the first time', async () => {
    const result = await Bridges.createOrReactivateAtomic(PAIR);
    expect(result.status).toBe('created');
    expect((result as { bridge: Record<string, unknown> }).bridge).toEqual(
      expect.objectContaining({ _id: 'br-1', active: true, sourceChannelId: 'c-source' }));
  });

  it('reports an existing active pair instead of creating a duplicate', async () => {
    await Bridges.createOrReactivateAtomic(PAIR);
    const second = await Bridges.createOrReactivateAtomic({ ...PAIR, id: 'br-2' });

    expect(second.status).toBe('exists');
    // Ikinci kayit ACILMADI: aksi hâlde her mesaj iki kez iletilirdi.
    const rows = await Bridges.find({ sourceChannelId: 'c-source' }) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('reactivates a disabled pair rather than inserting a second row', async () => {
    await Bridges.createOrReactivateAtomic(PAIR);
    await Bridges.update({ _id: 'br-1' }, { $set: { active: false } });

    const again = await Bridges.createOrReactivateAtomic({
      ...PAIR, id: 'br-yeni', label: 'Yeni etiket', createdBy: 'admin-2', createdAt: 1_700_000_999_000,
    });

    expect(again.status).toBe('reactivated');
    const rows = recordsOf(await Bridges.find({ sourceChannelId: 'c-source' }), 'rows');
    expect(rows).toHaveLength(1);
    // Yeniden etkinlestirme MEVCUT satiri gunceller; kimlik korunur.
    expect(rows[0]._id).toBe('br-1');
    expect(rows[0]).toEqual(expect.objectContaining({
      active: true, label: 'Yeni etiket', createdBy: 'admin-2', createdAt: 1_700_000_999_000,
    }));
  });

  it('serialises concurrent creation of the same pair', async () => {
    const [a, b] = await Promise.all([
      Bridges.createOrReactivateAtomic(PAIR),
      Bridges.createOrReactivateAtomic({ ...PAIR, id: 'br-2' }),
    ]);

    // Tam olarak biri yaratir, digeri var oldugunu bildirir.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['created', 'exists']);
    expect(await Bridges.find({ sourceChannelId: 'c-source' })).toHaveLength(1);
  });

  it('treats the reverse direction as a different pair', async () => {
    await Bridges.createOrReactivateAtomic(PAIR);
    const reverse = await Bridges.createOrReactivateAtomic({
      ...PAIR, id: 'br-rev',
      sourceChannelId: PAIR.targetChannelId,
      targetChannelId: PAIR.sourceChannelId,
    });
    // Kopru YONLUDUR; ters yon ayri bir karardir.
    expect(reverse.status).toBe('created');
    expect(await Bridges.find({})).toHaveLength(2);
  });

  it('reports a reactivation that cannot be read back', async () => {
    await Bridges.createOrReactivateAtomic(PAIR);
    await Bridges.update({ _id: 'br-1' }, { $set: { active: false } });

    const findOne = jest.spyOn(db.channelBridges, 'findOne');
    findOne.mockResolvedValueOnce({ _id: 'br-1', active: false } as never);
    findOne.mockResolvedValueOnce(null as never);

    // Guncelleme yazildi ama geri okunamadi: sessizce "basarili" DENMEZ.
    await expect(Bridges.createOrReactivateAtomic({ ...PAIR, id: 'br-x' }))
      .rejects.toThrow(/Bridge reactivation could not be loaded/);
  });
});

describe('reads are scoped to what the forwarder actually needs', () => {
  it('lists only active bridges leaving a source channel', async () => {
    await Bridges.insert({ _id: 'a', sourceChannelId: 'c1', targetChannelId: 't1', active: true });
    await Bridges.insert({ _id: 'b', sourceChannelId: 'c1', targetChannelId: 't2', active: false });
    await Bridges.insert({ _id: 'c', sourceChannelId: 'c2', targetChannelId: 't3', active: true });

    const rows = await Bridges.findActiveFromSourceChannel('c1') as Array<{ _id: string }>;
    // Kapali bir kopru mesaj iletmemelidir.
    expect(rows.map(r => r._id)).toEqual(['a']);
  });

  it('returns an empty list for a channel with no bridges', async () => {
    await expect(Bridges.findActiveFromSourceChannel('yok')).resolves.toEqual([]);
    await expect(Bridges.find({ sourceChannelId: 'yok' })).resolves.toEqual([]);
  });

  it('reads a single bridge by an arbitrary filter', async () => {
    await Bridges.insert({ _id: 'a', sourceChannelId: 'c1', targetChannelId: 't1', active: true });
    await expect(Bridges.findOne({ _id: 'a' })).resolves.toEqual(expect.objectContaining({ _id: 'a' }));
    await expect(Bridges.findOne({ _id: 'yok' })).resolves.toBeNull();
  });
});
