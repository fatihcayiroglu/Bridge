// server/tests/outgoing-webhook-repository-queue-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GİDEN WEBHOOK DEPOSU — POSTGRES KUYRUĞU VE BOZUK GİRDİ SINIRLARI
// ════════════════════════════════════════════════════════════════════════════
//
// Giden webhook teslim kuyruğunun ÜRETİM yolu PostgreSQL'dir: danışma kilidi
// (advisory lock) altında sayım + ekleme, ve `FOR UPDATE SKIP LOCKED` ile
// atomik talep. Bellek-içi yedek yalnızca birim testleri içindir. Diğer
// testler yedeği ölçtüğü için üretim yolu ölçülmemiş kalıyordu — yani
// aşağıdaki hataların hiçbiri yakalanamazdı:
//
//   · BEKLEYEN TAVANI kilit altında ölçülmezse iki eşzamanlı olay tavanı
//     birlikte aşar ve kuyruk sınırsız büyür.
//   · Sayım tavanı AŞTIĞINDA işlem GERİ ALINMALIDIR; yalnız `return null`
//     demek açık bir işlem bırakırdı.
//   · Sorgu hata verdiğinde ROLLBACK + istemci iadesi ZORUNLUDUR; aksi
//     hâlde havuz bir bağlantı sızdırır ve sonunda tükenir.
//   · Talep kirası (`claimUntil`) taşarsa iki işçi aynı teslimi alır ve
//     webhook iki kez gönderilir.

'use strict';
process.env.NODE_ENV = 'test';

type Row = Record<string, unknown>;

const query = jest.fn();
const clientQuery = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query: clientQuery, release }));

const pool: { query?: typeof query; connect?: typeof connect } = {};

const webhooks = {
  findOne: jest.fn(), find: jest.fn(), insert: jest.fn(),
  update: jest.fn(), remove: jest.fn(),
};
const deliveries = {
  find: jest.fn(), insert: jest.fn(), update: jest.fn(), remove: jest.fn(),
};

const dbMock: Record<string, unknown> = {
  _pool: pool,
  outgoingWebhooks: webhooks,
  outgoingWebhookDeliveries: deliveries,
};

jest.mock('../db/loader', () => ({ __esModule: true, default: dbMock, ...dbMock }));

import { OutgoingWebhooks } from '../db/repositories';

/** Restores the pool surface a given code path probes for. */
function withPool(kind: 'query' | 'connect' | 'none') {
  delete pool.query; delete pool.connect;
  if (kind === 'query') pool.query = query;
  if (kind === 'connect') pool.connect = connect;
}

beforeEach(() => {
  jest.clearAllMocks();
  withPool('none');
  query.mockResolvedValue({ rows: [] });
  clientQuery.mockResolvedValue({ rows: [] });
  webhooks.findOne.mockResolvedValue(null);
  webhooks.find.mockResolvedValue([]);
  webhooks.update.mockResolvedValue(1);
  deliveries.find.mockResolvedValue([]);
  deliveries.insert.mockResolvedValue(undefined);
  deliveries.update.mockResolvedValue(1);
});

describe('list queries survive a collection that returns nothing', () => {
  it('returns an empty list rather than propagating undefined', async () => {
    webhooks.find.mockReturnValue(undefined);
    await expect(OutgoingWebhooks.findByServer('s1')).resolves.toEqual([]);
    await expect(OutgoingWebhooks.findActive('s1')).resolves.toEqual([]);
    await expect(OutgoingWebhooks.findEnabledByServer('s1')).resolves.toEqual([]);
    expect(webhooks.find).toHaveBeenCalledWith({ serverId: 's1', enabled: true });
  });

  it('passes real rows through untouched', async () => {
    webhooks.find.mockResolvedValue([{ _id: 'w1' }]);
    await expect(OutgoingWebhooks.findByServer('s1')).resolves.toEqual([{ _id: 'w1' }]);
  });
});

describe('delivery outcome is written through PostgreSQL when a pool exists', () => {
  it('a success clears the failure counter and returns the updated row', async () => {
    withPool('query');
    query.mockResolvedValue({ rows: [{ _id: 'w1', consecutiveFailures: 0 }] });

    const row = await OutgoingWebhooks.recordDeliverySuccess('w1', 204);

    expect(row).toEqual({ _id: 'w1', consecutiveFailures: 0 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"consecutiveFailures" = 0');
    expect(sql).toContain('"lastError" = NULL');
    expect(params[0]).toBe('w1');
    expect(params[2]).toBe(204);
    // The in-memory compatibility path must not also run.
    expect(webhooks.update).not.toHaveBeenCalled();
  });

  it('a success against a deleted webhook returns null instead of undefined', async () => {
    withPool('query');
    query.mockResolvedValue({ rows: [] });
    await expect(OutgoingWebhooks.recordDeliverySuccess('gone', 200)).resolves.toBeNull();
  });

  it('a failure increments the counter, truncates the error and carries the disable threshold', async () => {
    withPool('query');
    query.mockResolvedValue({ rows: [{ _id: 'w1', consecutiveFailures: 3 }] });

    const row = await OutgoingWebhooks.recordDeliveryFailure('w1', 500, 'x'.repeat(500), 4);

    expect(row).toEqual({ _id: 'w1', consecutiveFailures: 3 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('COALESCE("consecutiveFailures", 0) + 1');
    expect(sql).toContain('enabled = CASE');
    expect(String(params[3])).toHaveLength(200);
    expect(params[4]).toBe(4);
  });

  it('a failure against a deleted webhook returns null', async () => {
    withPool('query');
    query.mockResolvedValue({ rows: [] });
    await expect(OutgoingWebhooks.recordDeliveryFailure('gone', 500, 'boom')).resolves.toBeNull();
  });

  it('the in-memory fallback returns null when the webhook no longer exists', async () => {
    webhooks.findOne.mockResolvedValue(null);
    await expect(OutgoingWebhooks.recordDeliveryFailure('gone', 500, 'boom')).resolves.toBeNull();
    expect(webhooks.update).not.toHaveBeenCalled();
  });

  it('the in-memory fallback disables a webhook that reached the threshold', async () => {
    webhooks.findOne.mockResolvedValue({ _id: 'w1', consecutiveFailures: 2 });
    await OutgoingWebhooks.recordDeliveryFailure('w1', 500, 'boom', 3);
    expect(webhooks.update).toHaveBeenCalledWith({ _id: 'w1' },
      { $set: expect.objectContaining({ consecutiveFailures: 3, enabled: false }) });
  });

  const badInputs: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['a status below 100', () => OutgoingWebhooks.recordDeliverySuccess('w1', 99), /Invalid outgoing webhook status/],
    ['a status above 599', () => OutgoingWebhooks.recordDeliverySuccess('w1', 600), /Invalid outgoing webhook status/],
    ['a fractional status', () => OutgoingWebhooks.recordDeliverySuccess('w1', 200.5), /Invalid outgoing webhook status/],
    ['a negative failure status', () => OutgoingWebhooks.recordDeliveryFailure('w1', -1, 'e'), /Invalid outgoing webhook status/],
    ['a non-string error', () => OutgoingWebhooks.recordDeliveryFailure('w1', 500, 42 as never), /Invalid outgoing webhook error/],
    ['a zero disable threshold', () => OutgoingWebhooks.recordDeliveryFailure('w1', 500, 'e', 0), /disable threshold/],
  ];
  for (const [name, run, message] of badInputs) {
    it(`rejects ${name} before touching storage`, async () => {
      withPool('query');
      await expect(run()).rejects.toThrow(message);
      expect(query).not.toHaveBeenCalled();
      expect(webhooks.update).not.toHaveBeenCalled();
    });
  }
});

describe('bounded enqueue is one advisory-locked transaction', () => {
  function sqlCalls(): string[] {
    return clientQuery.mock.calls.map(([sql]: unknown[]) => String(sql));
  }

  it('counts under the advisory lock and inserts inside the same transaction', async () => {
    withPool('connect');
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT COUNT')) return { rows: [{ count: '17' }] };
      return { rows: [] };
    });

    const id = await OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'message.create', { a: 1 }, 100);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const calls = sqlCalls();
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('pg_advisory_xact_lock');
    expect(calls[2]).toContain('SELECT COUNT');
    expect(calls[3]).toContain('INSERT INTO outgoing_webhook_deliveries');
    expect(calls[4]).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    // The payload is stored as jsonb text, not as a live object reference.
    const insertParams = clientQuery.mock.calls[3]![1] as unknown[];
    expect(insertParams[4]).toBe(JSON.stringify({ a: 1 }));
  });

  it('rolls back and enqueues nothing once the pending cap is reached', async () => {
    withPool('connect');
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT COUNT')) return { rows: [{ count: '100' }] };
      return { rows: [] };
    });

    await expect(OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'evt', {}, 100)).resolves.toBeNull();

    const calls = sqlCalls();
    expect(calls).toContain('ROLLBACK');
    expect(calls.some(sql => sql.includes('INSERT INTO'))).toBe(false);
    expect(calls).not.toContain('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('an absent count row is read as zero rather than as an overflowing queue', async () => {
    withPool('connect');
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT COUNT')) return { rows: [] };
      return { rows: [] };
    });

    await expect(OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'evt', {}, 1)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(sqlCalls()).toContain('COMMIT');
  });

  it('a failing insert rolls back, rethrows and still returns the connection', async () => {
    withPool('connect');
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT COUNT')) return { rows: [{ count: '0' }] };
      if (String(sql).includes('INSERT INTO')) throw new Error('unique violation');
      return { rows: [] };
    });

    await expect(OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'evt', {}))
      .rejects.toThrow('unique violation');
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a rollback that itself fails does not mask the original error', async () => {
    withPool('connect');
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql) === 'ROLLBACK') throw new Error('connection already gone');
      if (String(sql).includes('INSERT INTO')) throw new Error('disk full');
      if (String(sql).startsWith('SELECT COUNT')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });

    await expect(OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'evt', {}))
      .rejects.toThrow('disk full');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('the in-memory fallback treats a missing row set as an empty queue', async () => {
    deliveries.find.mockResolvedValue(undefined);
    const id = await OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'evt', {}, 5);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(deliveries.insert).toHaveBeenCalledWith(expect.objectContaining({
      webhookId: 'w1', serverId: 's1', eventName: 'evt', attempts: 0,
    }));
  });

  it('the in-memory fallback also honours the pending cap', async () => {
    deliveries.find.mockResolvedValue([{ _id: 'd1' }, { _id: 'd2' }]);
    await expect(OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'evt', {}, 2)).resolves.toBeNull();
    expect(deliveries.insert).not.toHaveBeenCalled();
  });

  const identityCases: Array<[string, [string, string, string]]> = [
    ['an empty webhook id', ['', 's1', 'evt']],
    ['an empty server id', ['w1', '', 'evt']],
    ['an empty event name', ['w1', 's1', '']],
  ];
  for (const [name, args] of identityCases) {
    it(`refuses ${name}`, async () => {
      withPool('connect');
      await expect(OutgoingWebhooks.enqueueDeliveryBounded(args[0], args[1], args[2], {}))
        .rejects.toThrow(/Invalid outgoing webhook delivery identity/);
      expect(connect).not.toHaveBeenCalled();
    });
  }

  it('refuses an out-of-range pending cap before opening a transaction', async () => {
    withPool('connect');
    await expect(OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'evt', {}, 0))
      .rejects.toThrow(/pending cap/);
    await expect(OutgoingWebhooks.enqueueDeliveryBounded('w1', 's1', 'evt', {}, 100_001))
      .rejects.toThrow(/pending cap/);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('claiming due deliveries', () => {
  it('claims atomically with SKIP LOCKED and commits', async () => {
    withPool('connect');
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('WITH due AS')) return { rows: [{ _id: 'd1', claimOwner: 'worker-1' }] };
      return { rows: [] };
    });

    const rows = await OutgoingWebhooks.claimDueDeliveries(1_000, 'worker-1', 120_000, 500);

    expect(rows).toEqual([{ _id: 'd1', claimOwner: 'worker-1' }]);
    const claim = clientQuery.mock.calls.find(([sql]: unknown[]) => String(sql).includes('WITH due AS'))!;
    expect(String(claim[0])).toContain('FOR UPDATE SKIP LOCKED');
    const params = claim[1] as unknown[];
    expect(params[1]).toBe('worker-1');
    expect(params[2]).toBe(1_000 + 120_000);
    // The requested limit is clamped so one worker cannot drain the queue.
    expect(params[3]).toBe(200);
    expect(clientQuery.mock.calls.map(([sql]: unknown[]) => String(sql))).toContain('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a short lease is raised to the 30 second floor', async () => {
    withPool('connect');
    clientQuery.mockResolvedValue({ rows: [] });
    await OutgoingWebhooks.claimDueDeliveries(1_000, 'worker-1', 1_000, 10);
    const claim = clientQuery.mock.calls.find(([sql]: unknown[]) => String(sql).includes('WITH due AS'))!;
    expect((claim[1] as unknown[])[2]).toBe(1_000 + 30_000);
  });

  it('a failing claim rolls back, rethrows and releases the connection', async () => {
    withPool('connect');
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('WITH due AS')) throw new Error('deadlock detected');
      return { rows: [] };
    });

    await expect(OutgoingWebhooks.claimDueDeliveries(1_000, 'worker-1'))
      .rejects.toThrow('deadlock detected');
    expect(clientQuery.mock.calls.map(([sql]: unknown[]) => String(sql))).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses a claim deadline that cannot be represented exactly', async () => {
    withPool('connect');
    await expect(OutgoingWebhooks.claimDueDeliveries(Number.MAX_SAFE_INTEGER, 'worker-1'))
      .rejects.toThrow(/claim deadline/);
    expect(connect).not.toHaveBeenCalled();
  });

  const claimInputs: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['a negative timestamp', () => OutgoingWebhooks.claimDueDeliveries(-1, 'w'), /claim timestamp/],
    ['an empty owner', () => OutgoingWebhooks.claimDueDeliveries(1, '  '), /claim owner/],
    ['an oversized owner', () => OutgoingWebhooks.claimDueDeliveries(1, 'x'.repeat(201)), /claim owner/],
    ['a non-positive lease', () => OutgoingWebhooks.claimDueDeliveries(1, 'w', 0), /lease/],
    ['an excessive lease', () => OutgoingWebhooks.claimDueDeliveries(1, 'w', 600_001), /lease/],
    ['a non-positive limit', () => OutgoingWebhooks.claimDueDeliveries(1, 'w', 1000, 0), /claim limit/],
  ];
  for (const [name, run, message] of claimInputs) {
    it(`refuses ${name}`, async () => {
      withPool('connect');
      await expect(run()).rejects.toThrow(message);
      expect(connect).not.toHaveBeenCalled();
    });
  }

  it('the in-memory fallback tolerates a sort that yields nothing', async () => {
    deliveries.find.mockReturnValue({ sort: () => undefined });
    await expect(OutgoingWebhooks.claimDueDeliveries(1_000, 'worker-1')).resolves.toEqual([]);
    expect(deliveries.update).not.toHaveBeenCalled();
  });

  it('the in-memory fallback skips rows still leased to another worker', async () => {
    deliveries.find.mockReturnValue({
      sort: () => Promise.resolve([
        { _id: 'free', nextAt: 100, claimUntil: null },
        { _id: 'leased', nextAt: 100, claimUntil: 5_000 },
      ]),
    });
    const rows = await OutgoingWebhooks.claimDueDeliveries(1_000, 'worker-1');
    expect(rows.map((row: Row) => row._id)).toEqual(['free']);
    expect(deliveries.update).toHaveBeenCalledTimes(1);
  });
});

describe('retry and completion are scoped to the claim owner', () => {
  it('a retry clears the lease so another worker can pick the delivery up', async () => {
    await OutgoingWebhooks.retryDelivery('d1', 'worker-1', 2, 5_000, 'y'.repeat(400));
    expect(deliveries.update).toHaveBeenCalledWith(
      { _id: 'd1', claimOwner: 'worker-1' },
      { $set: expect.objectContaining({ attempts: 2, nextAt: 5_000, claimOwner: null, claimUntil: null }) });
    const lastError = (deliveries.update.mock.calls[0]![1] as { $set: { lastError: string } }).$set.lastError;
    expect(lastError).toHaveLength(200);
  });

  it('a retry with a non-string error is refused', async () => {
    await expect(OutgoingWebhooks.retryDelivery('d1', 'worker-1', 1, 1, null as never))
      .rejects.toThrow(/retry error/);
    expect(deliveries.update).not.toHaveBeenCalled();
  });

  it('a retry with an invalid owner or counter is refused', async () => {
    await expect(OutgoingWebhooks.retryDelivery('d1', '', 1, 1, 'e')).rejects.toThrow(/claim owner/);
    await expect(OutgoingWebhooks.retryDelivery('d1', 'w', -1, 1, 'e')).rejects.toThrow(/retry attempts/);
    await expect(OutgoingWebhooks.retryDelivery('d1', 'w', 1, -1, 'e')).rejects.toThrow(/retry timestamp/);
    expect(deliveries.update).not.toHaveBeenCalled();
  });

  it('completion removes only the row this worker holds', async () => {
    await OutgoingWebhooks.completeDelivery('d1', 'worker-1');
    expect(deliveries.remove).toHaveBeenCalledWith({ _id: 'd1', claimOwner: 'worker-1' });
  });

  it('completion refuses an empty owner', async () => {
    await expect(OutgoingWebhooks.completeDelivery('d1', '')).rejects.toThrow(/claim owner/);
    expect(deliveries.remove).not.toHaveBeenCalled();
  });
});
