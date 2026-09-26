// server/tests/outgoing-webhook-query-surface.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// OutgoingWebhookRepository — KAPSAMLI SORGU YUZEYI VE CLAIM SAHIPLIGI
// ════════════════════════════════════════════════════════════════════════════
// Kardes paketler bu deponun DAYANIKLILIGINI (`outgoing-webhook-durability`)
// ve DURUM MAKINESINI (`outgoing-webhook-state-machine`) olcer. Bu dosya
// sorgu yuzeyinin kendisini olcer — cunku her sorgu bir SUNUCU KAPSAMI
// tasir ve kapsamin dusmesi, bir sunucunun webhook'unun baska bir sunucudan
// okunmasi/silinmesi demektir.
//
// Ikinci sinif: TESLIMAT CLAIM'I. Kuyruktan is alan islemci bir `claimOwner`
// ile isaretler. `completeDelivery` YALNIZCA o sahibin kaydini silmelidir:
// baska bir islemcinin isini silmek, henuz gonderilmemis bir webhook'un
// sessizce kaybolmasi demektir.
'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import { recordOf, recordsOf } from './helpers/narrow';
import Webhooks from '../db/repositories/OutgoingWebhookRepository';

const db = require('../db/loader');

const hook = (id: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, serverId: 's1', url: `https://hook.test/${id}`, enabled: true, createdAt: Date.now(), ...extra });

beforeEach(() => {
  db._reset?.();
  jest.restoreAllMocks();
});

describe('the collection is discoverable before it is used', () => {
  it('reports that the store exists', () => {
    expect(Webhooks.hasCollection()).toBe(true);
  });
});

describe('lookups never cross a server boundary', () => {
  beforeEach(async () => {
    await db.outgoingWebhooks.insert(hook('w1'));
    await db.outgoingWebhooks.insert(hook('w2', { enabled: false }));
    await db.outgoingWebhooks.insert(hook('w3', { serverId: 's2' }));
  });

  it('finds by id alone', async () => {
    await expect(Webhooks.findById('w1')).resolves.toEqual(expect.objectContaining({ _id: 'w1' }));
    await expect(Webhooks.findById('missing')).resolves.toBeNull();
  });

  it('refuses to read another server’s webhook through the scoped lookup', async () => {
    await expect(Webhooks.findByIdAndServer('w1', 's1')).resolves.toEqual(expect.objectContaining({ _id: 'w1' }));
    // Kapsam dusseydi baska sunucunun ucu okunurdu.
    await expect(Webhooks.findByIdAndServer('w3', 's1')).resolves.toBeNull();
  });

  it('lists a server’s webhooks and nobody else’s', async () => {
    const rows = await Webhooks.findByServer('s1') as Array<{ _id: string }>;
    expect(rows.map(r => r._id).sort()).toEqual(['w1', 'w2']);
    await expect(Webhooks.findByServer('s-empty')).resolves.toEqual([]);
  });

  it.each([
    ['findActive', (id: string) => Webhooks.findActive(id)],
    ['findEnabledByServer', (id: string) => Webhooks.findEnabledByServer(id)],
  ])('%s excludes a disabled webhook', async (_label, call) => {
    const rows = await call('s1') as Array<{ _id: string }>;
    // Devre disi birakilmis bir uc, olay yayininda ATESLENMEMELIDIR.
    expect(rows.map(r => r._id)).toEqual(['w1']);
  });
});

describe('writes preserve scope and stamp identity', () => {
  it('insert generates an id and a creation time', async () => {
    const created = recordOf(await Webhooks.insert({ serverId: 's1', url: 'https://x.test' }), 'created');
    expect(typeof created._id).toBe('string');
    expect(typeof created.createdAt).toBe('number');
  });

  it('update writes by id', async () => {
    await db.outgoingWebhooks.insert(hook('w1'));
    await Webhooks.update('w1', { enabled: false });
    await expect(Webhooks.findById('w1')).resolves.toEqual(expect.objectContaining({ enabled: false }));
  });

  it('the scoped update refuses a foreign server', async () => {
    await db.outgoingWebhooks.insert(hook('w1'));
    await Webhooks.updateInServer('w1', 's2', { url: 'https://ele-gecirildi.test' });
    await expect(Webhooks.findById('w1')).resolves.toEqual(
      expect.objectContaining({ url: 'https://hook.test/w1' }));
  });

  it('supports a raw modifier for counter arithmetic', async () => {
    await db.outgoingWebhooks.insert(hook('w1', { consecutiveFailures: 2 }));
    await Webhooks.updateByIdRaw('w1', { $inc: { consecutiveFailures: 1 } });
    await expect(Webhooks.findById('w1')).resolves.toEqual(
      expect.objectContaining({ consecutiveFailures: 3 }));
  });

  it('deletes by id and refuses a foreign server scope', async () => {
    await db.outgoingWebhooks.insert(hook('w1'));
    await db.outgoingWebhooks.insert(hook('w3', { serverId: 's2' }));

    await Webhooks.deleteInServer('w3', 's1');
    // Yanlis kapsamli silme ETKISIZDIR.
    await expect(Webhooks.findById('w3')).resolves.not.toBeNull();

    await Webhooks.deleteInServer('w3', 's2');
    await expect(Webhooks.findById('w3')).resolves.toBeNull();

    await Webhooks.delete('w1');
    await expect(Webhooks.findById('w1')).resolves.toBeNull();
  });
});

describe('delivery success is only recorded for a plausible status', () => {
  beforeEach(async () => {
    await db.outgoingWebhooks.insert(hook('w1', { consecutiveFailures: 4, lastError: 'onceki hata' }));
  });

  it('clears the failure streak on a real HTTP status', async () => {
    await Webhooks.recordDeliverySuccess('w1', 204);
    const row = recordOf(await Webhooks.findById('w1'), 'row');
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastStatus).toBe(204);
    expect(row.lastError ?? null).toBeNull();
    expect(typeof row.lastFiredAt).toBe('number');
  });

  it.each([
    ['a sub-HTTP number', 99],
    ['an impossible status', 600],
    ['a fractional status', 200.5],
    ['not a number at all', 'iki yuz'],
  ])('refuses to record %s', async (_label, status) => {
    // Uydurma bir durum kodu, arizali bir ucu "saglikli" gibi gostererek
    // ard arda hata sayacini sifirlardi.
    await expect(Webhooks.recordDeliverySuccess('w1', status as number)).rejects.toThrow(/Invalid outgoing webhook status/);
    const row = recordOf(await Webhooks.findById('w1'), 'row');
    expect(row.consecutiveFailures).toBe(4);
  });
});

describe('a queued delivery belongs to exactly one claim owner', () => {
  it.each([
    ['an empty owner', ''],
    ['a whitespace-only owner', '   '],
    ['an over-long owner', 'x'.repeat(201)],
    ['a non-string owner', 42],
  ])('refuses to complete a delivery with %s', async (_label, owner) => {
    await expect(Webhooks.completeDelivery('d1', owner as string))
      .rejects.toThrow(/Invalid outgoing webhook claim owner/);
  });

  it('removes only the row held by the completing owner', async () => {
    await db.outgoingWebhookDeliveries.insert({ _id: 'd1', webhookId: 'w1', claimOwner: 'worker-a' });
    await db.outgoingWebhookDeliveries.insert({ _id: 'd2', webhookId: 'w1', claimOwner: 'worker-b' });

    await Webhooks.completeDelivery('d1', 'worker-b');
    // Sahip eslesmedi: baska islemcinin isi SILINMEZ.
    await expect(db.outgoingWebhookDeliveries.findOne({ _id: 'd1' })).resolves.not.toBeNull();

    await Webhooks.completeDelivery('d1', 'worker-a');
    await expect(db.outgoingWebhookDeliveries.findOne({ _id: 'd1' })).resolves.toBeNull();
    // Digerinin isi el degmemis kalir.
    await expect(db.outgoingWebhookDeliveries.findOne({ _id: 'd2' })).resolves.not.toBeNull();
  });
});
