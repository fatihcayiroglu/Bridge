// server/tests/federation-delivery-inbox-resolution.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// FEDERASYON TESLİMİ — GELEN KUTUSU ÇÖZÜMÜ, İMZA VE TAKİPÇİ DAĞITIMI
// ════════════════════════════════════════════════════════════════════════════
//
// Bir ActivityPub teslimi ancak DOĞRU gelen kutusuna ve DOĞRU imzayla giderse
// karşı taraf kabul eder. Ölçülmemiş dallar:
//
//   · GELEN KUTUSU ÇÖZÜMÜ — çağıranlar çoğu zaman aktör URL'sini değil NOT
//     URL'sini bilir. Not bir gelen kutusu değildir; sahibi izlenmelidir.
//     Sonsuz zincirlemeyi engellemek için derinlik sınırlıdır.
//   · İMZA — özel anahtar yoksa istek imzasız gider (bazı örnekler kabul
//     eder); anahtar varsa Digest/Signature başlıkları EKLENMELİDİR.
//   · KALICI HATA — 410 Gone yeniden denenmez; kuyruk satırı silinir. Diğer
//     hatalar yeniden denenir ve deneme sayısı ARTAR.
//   · TAKİPÇİ DAĞITIMI — aynı paylaşılan gelen kutusuna İKİ kez teslim
//     yapılmaz; kuyruğa yazılamayan teslim sessizce kaybolmaz.

'use strict';
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';

jest.useFakeTimers();

const fetchT = jest.fn();
const warn = jest.fn();
const info = jest.fn();
const federation = {
  claimPendingDeliveries: jest.fn(async () => []),
  removeDeliveryEntry: jest.fn(async () => undefined),
  releaseDeliveryClaim: jest.fn(async () => undefined),
  upsertDeliveryEntry: jest.fn(async () => undefined),
  findApFollows: jest.fn(async (): Promise<Array<Record<string, unknown>>> => []),
};
const users = { getApPrivateKey: jest.fn(async (): Promise<string | null> => null) };

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn, info } }));
jest.mock('../db/repositories', () => ({ Federation: federation, Users: users }));

const delivery = require('../routes/federation/delivery');

const ACTOR = { _id: 'u-1', username: 'ada' };
const ACTIVITY = { type: 'Create', id: 'act-1' };

const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body });

/** RSA anahtarı üretmek pahalıdır; imza yolu için TEK kez üretilir. */
let privateKeyPem: string;
beforeAll(() => {
  const { generateKeyPairSync } = require('crypto');
  privateKeyPem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchT.mockReset();
  users.getApPrivateKey.mockResolvedValue(null);
  federation.findApFollows.mockResolvedValue([]);
});

afterAll(() => { jest.clearAllTimers(); jest.useRealTimers(); });

function postCalls() {
  return fetchT.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
}

describe('gelen kutusu çözümü', () => {
  it('adres zaten bir gelen kutusuysa ağ sorgusu yapılmaz', async () => {
    fetchT.mockResolvedValue(ok());

    await delivery.deliverApActivity('https://uzak.test/users/bob/inbox', ACTIVITY, null);

    expect(fetchT).toHaveBeenCalledTimes(1);
    expect(fetchT.mock.calls[0]![0]).toBe('https://uzak.test/users/bob/inbox');
  });

  it('paylaşılan gelen kutusu adresi de doğrudan kabul edilir', async () => {
    fetchT.mockResolvedValue(ok());

    await delivery.deliverApActivity('https://uzak.test/sharedInbox', ACTIVITY, null);

    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  it('aktör belgesindeki paylaşılan gelen kutusu tercih edilir', async () => {
    fetchT
      .mockResolvedValueOnce(ok({ endpoints: { sharedInbox: 'https://uzak.test/shared' }, inbox: 'https://uzak.test/kendi' }))
      .mockResolvedValueOnce(ok());

    await delivery.deliverApActivity('https://uzak.test/users/bob', ACTIVITY, null);

    expect(postCalls()[0]![0]).toBe('https://uzak.test/shared');
  });

  it('paylaşılan kutu yoksa aktörün kendi kutusu kullanılır', async () => {
    fetchT
      .mockResolvedValueOnce(ok({ inbox: 'https://uzak.test/kendi' }))
      .mockResolvedValueOnce(ok());

    await delivery.deliverApActivity('https://uzak.test/users/bob', ACTIVITY, null);

    expect(postCalls()[0]![0]).toBe('https://uzak.test/kendi');
  });

  it('not adresinden sahibi izlenerek gelen kutusu bulunur', async () => {
    fetchT
      .mockResolvedValueOnce(ok({ attributedTo: 'https://uzak.test/users/bob' }))
      .mockResolvedValueOnce(ok({ inbox: 'https://uzak.test/kendi' }))
      .mockResolvedValueOnce(ok());

    await delivery.deliverApActivity('https://uzak.test/notes/1', ACTIVITY, null);

    expect(postCalls()[0]![0]).toBe('https://uzak.test/kendi');
  });

  it('sahip alanı dizi ya da `actor` olarak da okunur', async () => {
    fetchT
      .mockResolvedValueOnce(ok({ attributedTo: ['https://uzak.test/users/bob'] }))
      .mockResolvedValueOnce(ok({ inbox: 'https://uzak.test/kendi' }))
      .mockResolvedValueOnce(ok());
    await delivery.deliverApActivity('https://uzak.test/notes/1', ACTIVITY, null);
    expect(postCalls()[0]![0]).toBe('https://uzak.test/kendi');

    fetchT.mockReset();
    fetchT
      .mockResolvedValueOnce(ok({ actor: 'https://uzak.test/users/carol' }))
      .mockResolvedValueOnce(ok({ inbox: 'https://uzak.test/carol-inbox' }))
      .mockResolvedValueOnce(ok());
    await delivery.deliverApActivity('https://uzak.test/notes/2', ACTIVITY, null);
    expect(postCalls()[0]![0]).toBe('https://uzak.test/carol-inbox');
  });

  it('sahip zinciri kendine dönerse çözüm durur ve teslim denenmez', async () => {
    fetchT.mockResolvedValue(ok({ attributedTo: 'https://uzak.test/notes/1' }));

    await delivery.deliverApActivity('https://uzak.test/notes/1', ACTIVITY, null);

    expect(postCalls()).toHaveLength(0);
    expect(federation.upsertDeliveryEntry).toHaveBeenCalled();
  });

  it('sahip zinciri çok derinse çözüm sonlandırılır', async () => {
    // Her belge bir sonrakine isaret eder; derinlik siniri sonsuz dongude
    // takilmayi engeller.
    let n = 0;
    fetchT.mockImplementation(async () => {
      n += 1;
      return ok({ attributedTo: `https://uzak.test/notes/${n + 1}` });
    });

    await delivery.deliverApActivity('https://uzak.test/notes/1', ACTIVITY, null);

    expect(postCalls()).toHaveLength(0);
    expect(fetchT.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('aktör belgesi okunamazsa teslim yapılmaz, kuyruk satırı kalır', async () => {
    fetchT.mockResolvedValue(fail(404));

    await delivery.deliverApActivity('https://uzak.test/users/bob', ACTIVITY, null);

    expect(postCalls()).toHaveLength(0);
    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
  });

  it('ağ hatası çözümü düşürür, teslim denenmez', async () => {
    fetchT.mockRejectedValue(new Error('dns fail'));

    await delivery.deliverApActivity('https://uzak.test/users/bob', ACTIVITY, null);

    expect(postCalls()).toHaveLength(0);
  });
});

describe('imzalama', () => {
  it('özel anahtar yoksa istek imzasız gider ama Date başlığı taşır', async () => {
    fetchT.mockResolvedValue(ok());

    await delivery.deliverApActivity('https://uzak.test/inbox', ACTIVITY, ACTOR);

    const headers = (postCalls()[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Signature).toBeUndefined();
    expect(headers.Digest).toBeUndefined();
    expect(typeof headers.Date).toBe('string');
  });

  it('özel anahtar varsa Digest ve Signature eklenir ve keyId örnek adresidir', async () => {
    users.getApPrivateKey.mockResolvedValue(privateKeyPem);
    fetchT.mockResolvedValue(ok());

    await delivery.deliverApActivity('https://uzak.test/inbox', ACTIVITY, ACTOR);

    const headers = (postCalls()[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Digest.startsWith('SHA-256=')).toBe(true);
    expect(headers.Signature).toContain('keyId="https://bridge.test/api/federation/users/ada#main-key"');
    expect(headers.Signature).toContain('algorithm="rsa-sha256"');
    expect(headers.Signature).toContain('headers="(request-target) host date digest"');
  });

  it('bozuk anahtar imzayı düşürür ama teslimi engellemez', async () => {
    users.getApPrivateKey.mockResolvedValue('-----BEGIN PRIVATE KEY-----bozuk-----END PRIVATE KEY-----');
    fetchT.mockResolvedValue(ok());

    await delivery.deliverApActivity('https://uzak.test/inbox', ACTIVITY, ACTOR);

    const headers = (postCalls()[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Signature).toBeUndefined();
    expect(postCalls()).toHaveLength(1);
  });
});

describe('yanıt sınıflandırması', () => {
  it('başarılı teslim kuyruk satırını siler', async () => {
    fetchT.mockResolvedValue(ok());

    await delivery.deliverApActivity('https://uzak.test/inbox', ACTIVITY, null);

    expect(federation.removeDeliveryEntry).toHaveBeenCalledTimes(1);
  });

  it('410 Gone kalıcı hatadır; yeniden denenmez', async () => {
    fetchT.mockResolvedValue(fail(410));

    await delivery.deliverApActivity('https://uzak.test/inbox', ACTIVITY, null);

    expect(federation.removeDeliveryEntry).toHaveBeenCalledTimes(1);
    expect(federation.releaseDeliveryClaim).not.toHaveBeenCalled();
  });

  it('geçici hata yeniden denenmek üzere kuyrukta bırakılır', async () => {
    fetchT.mockResolvedValue(fail(503));

    await delivery.deliverApActivity('https://uzak.test/inbox', ACTIVITY, null);

    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
    // Ilk yazma + basarisizlik sonrasi yeniden yazma.
    expect(federation.upsertDeliveryEntry.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('ağ hatası da yeniden denemeye alınır', async () => {
    fetchT.mockRejectedValue(new Error('connection reset'));

    await delivery.deliverApActivity('https://uzak.test/inbox', ACTIVITY, null);

    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
  });
});

describe('takipçi dağıtımı', () => {
  it('aynı paylaşılan gelen kutusuna tek teslim yapılır', async () => {
    federation.findApFollows.mockResolvedValue([
      { actorInbox: 'https://uzak.test/sharedInbox' },
      { actorInbox: 'https://uzak.test/sharedInbox' },
      { actorUrl: 'https://uzak.test/users/bob/inbox' },
    ]);
    fetchT.mockResolvedValue(ok());

    const result = await delivery.fanOutActivityToFollowers(ACTOR, ACTIVITY);

    expect(result).toEqual({ followers: 2, failed: 0 });
    expect(postCalls()).toHaveLength(2);
  });

  it('takipçi yoksa hiç teslim yapılmaz', async () => {
    federation.findApFollows.mockResolvedValue([]);

    expect(await delivery.fanOutActivityToFollowers(ACTOR, ACTIVITY)).toEqual({ followers: 0, failed: 0 });
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('adresi olmayan takipçi satırı atlanır', async () => {
    federation.findApFollows.mockResolvedValue([{ actorInbox: '', actorUrl: '' }, { actorInbox: null }]);

    expect(await delivery.fanOutActivityToFollowers(ACTOR, ACTIVITY)).toEqual({ followers: 0, failed: 0 });
  });

  it('depo zincir sonucu döndürse de takipçiler okunur', async () => {
    federation.findApFollows.mockResolvedValue({
      then: (resolve: (v: unknown[]) => void) => resolve([{ actorInbox: 'https://uzak.test/inbox' }]),
    } as never);
    fetchT.mockResolvedValue(ok());

    expect(await delivery.fanOutActivityToFollowers(ACTOR, ACTIVITY)).toEqual({ followers: 1, failed: 0 });
  });

  it('kuyruğa yazılamayan teslim sessizce kaybolmaz', async () => {
    federation.findApFollows.mockResolvedValue([{ actorInbox: 'https://uzak.test/inbox' }]);
    federation.upsertDeliveryEntry.mockRejectedValueOnce(new Error('queue write failed'));

    const result = await delivery.fanOutActivityToFollowers(ACTOR, ACTIVITY);

    expect(result).toEqual({ followers: 1, failed: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.enqueue_failed' }),
      expect.any(String),
    );
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
