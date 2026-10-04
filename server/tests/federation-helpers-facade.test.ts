// server/tests/federation-helpers-facade.test.ts
//
// routes/federation/helpers.ts remains a compatibility facade: every exported
// function must be owned by exactly one canonical module. P6 moves only the
// object lifecycle trio (Create/Update/Delete) to inbox-lifecycle.ts; the rest
// stay in inbox-handlers.ts / delivery.ts.
process.env.NODE_ENV = 'test';

import * as facade from '../routes/federation/helpers';
import * as inbox from '../routes/federation/inbox-handlers';
import * as lifecycle from '../routes/federation/inbox-lifecycle';
import * as delivery from '../routes/federation/delivery';

const INBOX_OPERATIONS = [
  'handleApFollow', 'handleApUnfollow', 'handleApAccept', 'handleApReject',
  'handleApLike', 'handleApAnnounce',
] as const;

const LIFECYCLE_OPERATIONS = [
  'handleApCreate', 'handleApDelete', 'handleApUpdate',
] as const;

const DELIVERY_OPERATIONS = [
  'signRequest', 'deliverApActivity', 'fanOutActivityToFollowers', 'deliverToFollowers',
] as const;

type AnyRecord = Record<string, unknown>;

describe('the compatibility facade delegates instead of re-implementing', () => {
  it.each(INBOX_OPERATIONS)('%s is the very same function object as the inbox owner', (name) => {
    expect((facade as AnyRecord)[name]).toBe((inbox as AnyRecord)[name]);
    expect(typeof (facade as AnyRecord)[name]).toBe('function');
  });

  it.each(LIFECYCLE_OPERATIONS)('%s is the very same function object as the lifecycle owner', (name) => {
    expect((facade as AnyRecord)[name]).toBe((lifecycle as AnyRecord)[name]);
    expect(typeof (facade as AnyRecord)[name]).toBe('function');
  });

  it.each(DELIVERY_OPERATIONS)('%s is the very same function object as the delivery owner', (name) => {
    expect((facade as AnyRecord)[name]).toBe((delivery as AnyRecord)[name]);
    expect(typeof (facade as AnyRecord)[name]).toBe('function');
  });

  it('exposes exactly the historical surface and nothing more', () => {
    const exported = Object.keys(facade).filter(key => key !== '__esModule').sort();
    expect(exported).toEqual([
      ...INBOX_OPERATIONS, ...LIFECYCLE_OPERATIONS, ...DELIVERY_OPERATIONS,
    ].sort());
  });

  it('carries no duplicate implementation owners', () => {
    for (const name of INBOX_OPERATIONS) {
      expect((lifecycle as AnyRecord)[name]).toBeUndefined();
      expect((delivery as AnyRecord)[name]).toBeUndefined();
    }
    for (const name of LIFECYCLE_OPERATIONS) {
      expect((delivery as AnyRecord)[name]).toBeUndefined();
    }
    for (const name of DELIVERY_OPERATIONS) {
      expect((inbox as AnyRecord)[name]).toBeUndefined();
      expect((lifecycle as AnyRecord)[name]).toBeUndefined();
    }
  });
});
