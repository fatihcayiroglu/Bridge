// server/tests/federation-helpers-facade.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// routes/federation/helpers.ts — CEPHE (FACADE) KANONIK SAHIBE BAGLI KALMALI
// ════════════════════════════════════════════════════════════════════════════
// Bu dosyanin kendi mantigi YOKTUR ve olmamalidir. Var olma sebebi olculmus
// bir kusurdur: Bridge bir donem IKI bagimsiz ActivityPub uygulamasi
// tasiyordu — `helpers.ts` ve `inbox-handlers.ts` / `delivery.ts`.
//
// Uretimdeki `activitypub.ts` BIRINCISINI ic aktariyor, derin testler ise
// IKINCISINI calistiriyordu. Sonuc: bir gelen-kutusu kusuru duzeltilip
// testler yesile donebiliyor, ama CANLI rota hâlâ eski, duzeltilmemis
// uygulamayi kullaniyordu. Yani yesil test, korunan kod DEMEK DEGILDI.
//
// Cephe o bosluğu kapatir: eski ic aktarim yuzeyi korunur ama her islem
// kanonik sahibe DEVREDILIR. Bu testin isi tam olarak o devrin hâlâ
// gecerli oldugunu kanitlamaktir — cepheye yanlislikla ikinci bir uygulama
// geri sizarsa BURADA yakalanir.
process.env.NODE_ENV = 'test';

import * as facade from '../routes/federation/helpers';
import * as inbox from '../routes/federation/inbox-handlers';
import * as delivery from '../routes/federation/delivery';

const INBOX_OPERATIONS = [
  'handleApFollow', 'handleApUnfollow', 'handleApAccept', 'handleApReject',
  'handleApCreate', 'handleApDelete', 'handleApUpdate', 'handleApLike',
  'handleApAnnounce',
] as const;

const DELIVERY_OPERATIONS = [
  'signRequest', 'deliverApActivity', 'fanOutActivityToFollowers', 'deliverToFollowers',
] as const;

type AnyRecord = Record<string, unknown>;

describe('the compatibility facade delegates instead of re-implementing', () => {
  it.each(INBOX_OPERATIONS)('%s is the very same function object as the inbox owner', (name) => {
    // Referans esitligi araniyor, "benzer davranis" degil: kopyalanmis bir
    // uygulama testten gecer ama uretimde AYRISIR.
    expect((facade as AnyRecord)[name]).toBe((inbox as AnyRecord)[name]);
    expect(typeof (facade as AnyRecord)[name]).toBe('function');
  });

  it.each(DELIVERY_OPERATIONS)('%s is the very same function object as the delivery owner', (name) => {
    expect((facade as AnyRecord)[name]).toBe((delivery as AnyRecord)[name]);
    expect(typeof (facade as AnyRecord)[name]).toBe('function');
  });

  it('exposes exactly the historical surface and nothing more', () => {
    const exported = Object.keys(facade).filter(key => key !== '__esModule').sort();
    expect(exported).toEqual([...INBOX_OPERATIONS, ...DELIVERY_OPERATIONS].sort());
  });

  it('carries no implementation of its own', () => {
    // Cephe yalnizca yeniden disa aktarim yapar; her uye baska bir modulun
    // sahipligindedir. Buradan gelen HICBIR fonksiyon iki sahipte birden
    // bulunmamalidir.
    for (const name of INBOX_OPERATIONS) {
      expect((delivery as AnyRecord)[name]).toBeUndefined();
    }
    for (const name of DELIVERY_OPERATIONS) {
      expect((inbox as AnyRecord)[name]).toBeUndefined();
    }
  });
});
