// server/tests/pg-integration/redis-sfu-ownership.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK REDIS — DAĞITIK SFU ODA SAHİPLİĞİ
// ════════════════════════════════════════════════════════════════════════════
// `lib/sfuRegistry.ts` bir ses odasının HANGİ node'da çalıştığını Redis'te
// tutar. Mock'lanmış bir Redis testi hangi komutun gönderildiğini gösterebilir;
// İKİ NODE'un aynı anda talep etmesi durumunda ne olduğunu KANITLAYAMAZ.
//
// ── ÖLÇÜLEN AÇIK ──────────────────────────────────────────────────────────
// `claimRoom` eskiden koşulsuz `SETEX` kullanıyordu; mevcut sahibi EZİYORDU.
// Çağıran taraf da önce `isLocalRoom()` bakıp sonra oda açtığı için klasik bir
// kontrol-et-sonra-davran yarışı vardı:
//
//     Node A: isLocalRoom → yok → "benim"    Node B: isLocalRoom → yok → "benim"
//     ikisi de yerel router oluşturur, ikisi de claimRoom çağırır
//
// Sonuç: aynı kanal için İKİ SFU odası; katılımcılar bölünür ve birbirini
// DUYAMAZ. Bu dosya iki ayrı node kimliğini gerçek Redis üzerinde yarıştırır.
//
// NOT: bu süit `PG_TEST_URL` ile aynı harness'ta çalışır ama PostgreSQL
// kullanmaz; yalnızca `REDIS_TEST_URL` gerektirir.

const REDIS_URL = process.env.REDIS_TEST_URL;
const RUN = REDIS_URL ? describe : describe.skip;

RUN('gerçek Redis — SFU oda sahipliği atomiktir', () => {
  const KEY_PREFIX = 'bridge:sfu:room:';
  const channels: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;

  /**
   * `sfuRegistry` modülünü VERİLEN node kimliğiyle taze yükler.
   *
   * `INSTANCE_ID` modül değerlendirmesinde okunur, bu yüzden iki "node"
   * simüle etmenin tek yolu modül kaydını izole etmektir. Bu, tek süreçte
   * çalışsa da GERÇEK Redis anahtarı üzerinden GERÇEK bir yarış üretir —
   * kritik olan paylaşılan durumun gerçek olmasıdır.
   */
  // Yüklenen her "node" kendi Redis bağlantısını açar; süit sonunda hepsi
  // KAPATILMALI, yoksa Jest çıkamaz (açık handle) ve koşu asılı kalır.
  const loadedNodes: Array<typeof import('../../lib/sfuRegistry')> = [];

  function loadNode(instanceId: string) {
    let mod!: typeof import('../../lib/sfuRegistry');
    jest.isolateModules(() => {
      process.env.INSTANCE_ID = instanceId;
      process.env.REDIS_URL = REDIS_URL;
      // Short liveness lease so the takeover/settle windows are observable in a test.
      process.env.SFU_NODE_LEASE_MS = '3000';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../../lib/sfuRegistry');
    });
    loadedNodes.push(mod);
    return mod;
  }

  const EPOCH_KEY = 'bridge:sfu:registry-epoch';
  let savedEpoch: string | null = null;
  // A long-running registry has a settled epoch; brand-new claims are refused
  // only right after the registry is (re)created (first boot / Redis data loss).
  const settleRegistry = () => raw.set(EPOCH_KEY, String(Date.now() - 10 * 60_000));

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require('redis');
    raw = createClient({ url: REDIS_URL });
    await raw.connect();
    savedEpoch = await raw.get(EPOCH_KEY);
    await settleRegistry();
  });

  afterAll(async () => {
    for (const ch of channels) {
      try { await raw.del(KEY_PREFIX + ch); } catch { /* yok */ }
    }
    try {
      await raw.del(['bridge:sfu:node:node-A', 'bridge:sfu:node:node-B']);
      if (savedEpoch === null) await raw.del(EPOCH_KEY); else await raw.set(EPOCH_KEY, savedEpoch);
    } catch { /* yok */ }
    // Her izole modülün açtığı Redis istemcisini kapat.
    for (const node of loadedNodes) {
      const disconnect = (node as unknown as { _closeForTest?: () => Promise<void> })._closeForTest;
      if (typeof disconnect === 'function') { try { await disconnect(); } catch { /* kapalı */ } }
    }
    try { await raw.quit(); } catch { /* kapalı */ }
  });

  function channel(name: string): string {
    const id = `review-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    channels.push(id);
    return id;
  }

  it('EŞZAMANLI iki node talebinden YALNIZ BİRİ sahiplik kazanır', async () => {
    const ch = channel('race');
    const nodeA = loadNode('node-A');
    const nodeB = loadNode('node-B');

    const [a, b] = await Promise.all([nodeA.claimRoom(ch), nodeB.claimRoom(ch)]);

    // Tam olarak bir kazanan.
    expect([a.owned, b.owned].filter(Boolean)).toHaveLength(1);

    // Kaybeden, KAZANANIN kimliğini öğrenmeli ki istemciyi yönlendirebilsin.
    const loser = a.owned ? b : a;
    const winner = a.owned ? 'node-A' : 'node-B';
    expect(loser.owned).toBe(false);
    expect(loser.owner).toBe(winner);

    // Redis'teki KANONİK kayıt kazananı göstermeli.
    expect(await raw.get(KEY_PREFIX + ch)).toBe(winner);
  });

  it('SAHİP OLMAYAN node tekrar talep etse de sahipliği ÇALAMAZ', async () => {
    // Eski `SETEX` davranışında bu çağrı sahibi sessizce değiştirirdi.
    const ch = channel('steal');
    const nodeA = loadNode('node-A');
    const nodeB = loadNode('node-B');

    expect((await nodeA.claimRoom(ch)).owned).toBe(true);

    const second = await nodeB.claimRoom(ch);
    expect(second.owned).toBe(false);
    expect(second.owner).toBe('node-A');
    expect(await raw.get(KEY_PREFIX + ch)).toBe('node-A');
  });

  it('SAHİP node yeniden talep ederse kirayı tazeler ve sahipliği KORUR', async () => {
    // Yeniden başlatma/yeniden çağrı kendi odamızı kaybettirmemeli.
    const ch = channel('renew');
    const nodeA = loadNode('node-A');

    expect((await nodeA.claimRoom(ch)).owned).toBe(true);
    const again = await nodeA.claimRoom(ch);

    expect(again.owned).toBe(true);
    expect(again.owner).toBe('node-A');
    expect(await raw.ttl(KEY_PREFIX + ch)).toBeGreaterThan(0);
  });

  it('sahip serbest bıraktıktan SONRA diğer node sahiplenebilir', async () => {
    // Yanlış pozitif kontrolü: kilit "her zaman reddet" olsaydı yukarıdaki
    // iddialar da geçerdi. Devir GERÇEKTEN mümkün olmalı.
    const ch = channel('handover');
    const nodeA = loadNode('node-A');
    const nodeB = loadNode('node-B');

    expect((await nodeA.claimRoom(ch)).owned).toBe(true);
    expect((await nodeB.claimRoom(ch)).owned).toBe(false);

    await nodeA.releaseRoom(ch);

    const afterRelease = await nodeB.claimRoom(ch);
    expect(afterRelease.owned).toBe(true);
    expect(await raw.get(KEY_PREFIX + ch)).toBe('node-B');
  });

  it('SAHİP OLMAYAN node releaseRoom çağırsa da kaydı SİLEMEZ', async () => {
    const ch = channel('release-authz');
    const nodeA = loadNode('node-A');
    const nodeB = loadNode('node-B');

    expect((await nodeA.claimRoom(ch)).owned).toBe(true);
    await nodeB.releaseRoom(ch);

    expect(await raw.get(KEY_PREFIX + ch)).toBe('node-A');
  });

  it('isLocalRoom sahibi olmayan node için FALSE döner', async () => {
    const ch = channel('is-local');
    const nodeA = loadNode('node-A');
    const nodeB = loadNode('node-B');

    await nodeA.claimRoom(ch);

    expect(await nodeA.isLocalRoom(ch)).toBe(true);
    expect(await nodeB.isLocalRoom(ch)).toBe(false);
  });

  it('gerçek Redis duraklamasında bounded fail-closed olur ve sonra yeniden bağlanır', async () => {
    const ch = channel('outage-recovery');
    const previousTimeout = process.env.REDIS_COMMAND_TIMEOUT_MS;
    process.env.REDIS_COMMAND_TIMEOUT_MS = '150';
    const nodeA = loadNode('node-outage-recovery');

    try {
      expect((await nodeA.claimRoom(ch)).owned).toBe(true);
      expect(await raw.ttl(KEY_PREFIX + ch)).toBeGreaterThan(0);

      // CLIENT PAUSE is a real server-side outage window: all connections are
      // accepted, but commands are black-holed long enough to hit the registry
      // deadline. The registry must not infer local ownership while Redis is
      // unavailable.
      await raw.sendCommand(['CLIENT', 'PAUSE', '700', 'ALL']);
      const started = Date.now();
      await expect(nodeA.getRoomOwner(ch)).rejects.toThrow(/timeout/i);
      const failureMs = Date.now() - started;
      expect(failureMs).toBeGreaterThanOrEqual(100);
      expect(failureMs).toBeLessThan(1_000);

      // Once Redis resumes, the timed-out connection has been discarded and a
      // fresh connection can observe/renew the original lease.
      await new Promise(resolve => setTimeout(resolve, 800));
      const recovered = await nodeA.claimRoom(ch);
      expect(recovered).toEqual({ owned: true, owner: 'node-outage-recovery' });
      expect(await raw.get(KEY_PREFIX + ch)).toBe('node-outage-recovery');
      expect(await raw.ttl(KEY_PREFIX + ch)).toBeGreaterThan(0);
      console.log('[redis-outage-proof]', JSON.stringify({ failureMs, recovered: true, ttl: await raw.ttl(KEY_PREFIX + ch) }));
    } finally {
      if (previousTimeout === undefined) delete process.env.REDIS_COMMAND_TIMEOUT_MS;
      else process.env.REDIS_COMMAND_TIMEOUT_MS = previousTimeout;
    }
  });

  // ── P1 çok-düğüm: SFU-05 (ölü sahip) ve SFU-08 (Redis veri kaybı) ─────────
  it('sahibinin canlılık kirası DOLMUŞ oda atomik olarak devralınır; CANLI sahip devralınamaz', async () => {
    const ch = channel('takeover');
    const nodeA = loadNode('node-A');
    const nodeB = loadNode('node-B');
    expect((await nodeA.claimRoom(ch)).owned).toBe(true);
    expect(await raw.exists('bridge:sfu:node:node-A')).toBe(1);

    // Negatif kontrol: sahip canlıyken B yalnızca yönlendirilir.
    expect(await nodeB.claimRoom(ch)).toEqual({ owned: false, owner: 'node-A' });

    // Sahip SIGKILL: kalp atışı durur, kira dolar (burada: 3 sn).
    await raw.del('bridge:sfu:node:node-A');
    const [x, y] = await Promise.all([nodeB.claimRoom(ch), nodeB.claimRoom(ch)]);
    expect(x.owned && y.owned).toBe(true);
    expect(await raw.get(KEY_PREFIX + ch)).toBe('node-B');
  });

  it('Redis boş başladıktan sonra: yeni talep yerleşme süresince reddedilir, canlı sahip odasını geri yazar, ikinci router AÇILMAZ', async () => {
    const ch = channel('dataloss');
    const nodeA = loadNode('node-A');
    const nodeB = loadNode('node-B');
    expect((await nodeA.claimRoom(ch)).owned).toBe(true);

    // Veri kaybı: oda kaydı ve kayıt dönemi yok.
    await raw.del([KEY_PREFIX + ch, EPOCH_KEY]);
    await expect(nodeB.claimRoom(ch)).rejects.toBeInstanceOf(nodeB.SfuRegistrySettlingError);
    expect(await raw.exists(KEY_PREFIX + ch)).toBe(0);

    // Canlı sahip bir kalp atışında odasını geri yazar.
    await expect(nodeA.refreshRoom(ch)).resolves.toBe(true);
    expect(await raw.get(KEY_PREFIX + ch)).toBe('node-A');

    // Yerleşme bittikten sonra B yönlendirilir; sahiplik A'da kalır. A canlıdır:
    // üründeki gibi her NODE_HEARTBEAT_MS'de kalp atışı yapar.
    const deadline = Date.now() + nodeB.REGISTRY_SETTLE_MS + 200;
    while (Date.now() < deadline) {
      await expect(nodeA.refreshRoom(ch)).resolves.toBe(true);
      await new Promise(r => setTimeout(r, nodeA.NODE_HEARTBEAT_MS));
    }
    expect(await nodeB.claimRoom(ch)).toEqual({ owned: false, owner: 'node-A' });
    await settleRegistry();
  }, 20_000);

  it('başka düğüme geçmiş odayı eski sahip kalp atışında KAYBETTİĞİNİ öğrenir (yerel router kapanmalı)', async () => {
    const ch = channel('lost');
    const nodeA = loadNode('node-A');
    const nodeB = loadNode('node-B');
    expect((await nodeA.claimRoom(ch)).owned).toBe(true);
    await raw.del('bridge:sfu:node:node-A');          // A duraksadı, kira doldu
    expect((await nodeB.claimRoom(ch)).owned).toBe(true);
    await expect(nodeA.refreshRoom(ch)).resolves.toBe(false);
    expect(await raw.get(KEY_PREFIX + ch)).toBe('node-B');
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
