// server/tests/federation-peers-discovery-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// FEDERASYON EŞLERİ — KEŞİF, EL SIKIŞMA VE İMZALI KİMLİK EŞLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════
//
// Ölçülmemiş 42 dalın taşıdığı riskler:
//
//   · KİMLİK KAYMASI — `ping` ve `key-update` uçlarında GÖVDE otorite DEĞİLDİR.
//     Yazma, middleware'in kriptografik olarak doğruladığı eş kimliğine yapılır;
//     gövdedeki adres imzalı kimlikle EŞLEŞMEZSE istek reddedilir. Aksi hâlde
//     bir eş, BAŞKA bir eşin anahtarını değiştirebilirdi.
//   · KEŞİF DAYANIKLILIĞI — bir eş çöküyorsa, yavaşsa ya da bozuk gövde
//     döndürüyorsa keşif TAMAMEN başarısız olmaz; o eş atlanır.
//   · YÖNETİCİ SINIRI — eş ekleme/silme ve sağlık görünümü yalnız yöneticiye
//     açıktır.
//   · UZAK DOĞRULAMA — eklenen adresin gerçekten bir Bridge örneği olduğu
//     uzak uçtan doğrulanır; "yazılım" alanı uymuyorsa eş eklenmez.
//   · SEYREK SATIR — eksik alanlar `undefined` sızdırmaz, güvenli yedeğe düşer.

process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';
process.env.INSTANCE_NAME = 'Bridge Testi';

const repos = {
  Users: { findById: jest.fn(), count: jest.fn() },
  Servers: { find: jest.fn(), count: jest.fn() },
  Members: { findByServer: jest.fn() },
  Channels: { findWhere: jest.fn() },
  Federation: {
    findPeers: jest.fn(), findPeerByUrl: jest.fn(), insertPeer: jest.fn(),
    removePeerById: jest.fn(), updatePeer: jest.fn(),
  },
};
const fetchT = jest.fn();
let signedPeerUrl: string | undefined;
let signedPeerId: string | null | undefined;

jest.mock('../db/repositories', () => repos);
jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: import('express').Request & { user?: unknown },
    _res: import('express').Response,
    next: import('express').NextFunction,
  ) => { req.user = { id: 'user-1', _id: 'user-1', username: 'user-1', v: 0 }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    federation: () => (
      _req: import('express').Request,
      _res: import('express').Response,
      next: import('express').NextFunction,
    ) => next(),
  },
}));
jest.mock('../middleware/federationAuth', () => {
  const attach = (
    req: import('express').Request & { federationPeerUrl?: string; federationPeerId?: string | null },
    _res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    req.federationPeerUrl = signedPeerUrl;
    req.federationPeerId = signedPeerId ?? undefined;
    next();
  };
  return { federationAuth: attach, federationAuthRsaRequired: attach };
});
jest.mock('../lib/federationKeys', () => ({
  getOrCreateFederationKeys: jest.fn(async () => ({ publicKeyPem: 'PEM', privateKeyPem: 'KEY' })),
  getFederationPublicKeyDoc: jest.fn(() => ({ id: 'https://bridge.test/federation#main-key' })),
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/federation/peers';

const app = express();
app.use(express.json());
app.use('/api/federation', router);

const remote = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body });

const PEM = '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----';

beforeEach(() => {
  jest.clearAllMocks();
  signedPeerUrl = 'https://peer.test';
  signedPeerId = 'peer-1';
  repos.Users.findById.mockResolvedValue({ _id: 'user-1', isAdmin: true });
  repos.Users.count.mockResolvedValue(5);
  repos.Servers.find.mockResolvedValue([]);
  repos.Servers.count.mockResolvedValue(2);
  repos.Members.findByServer.mockResolvedValue([]);
  repos.Channels.findWhere.mockResolvedValue([]);
  repos.Federation.findPeers.mockResolvedValue([]);
  repos.Federation.findPeerByUrl.mockResolvedValue(null);
  repos.Federation.insertPeer.mockResolvedValue(undefined);
  repos.Federation.removePeerById.mockResolvedValue(undefined);
  repos.Federation.updatePeer.mockResolvedValue({ updated: 1 });
  fetchT.mockResolvedValue(remote({ software: 'bridge', url: 'https://peer.test', name: 'Eş' }));
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /servers ve /stats — seyrek satırlar', () => {
  it('eksik alanlar güvenli yedeklerle sunulur', async () => {
    repos.Servers.find.mockResolvedValue([{ _id: 'srv-1', name: 'Genel', icon: null }]);
    repos.Members.findByServer.mockResolvedValue([{ userId: 'u1' }]);
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'c1' }, { _id: 'c2' }]);

    const res = await request(app).get('/api/federation/servers');

    expect(res.status).toBe(200);
    expect(res.body.servers[0]).toMatchObject({
      id: 'srv-1', description: '', tags: [], memberCount: 1, channelCount: 2,
    });
    expect(JSON.stringify(res.body)).not.toContain('undefined');
  });

  it('istatistikler doğrulanmış eşleri AYRI sayar', async () => {
    repos.Federation.findPeers.mockResolvedValue([
      { _id: 'p1', verified: true }, { _id: 'p2', verified: false },
    ]);

    const res = await request(app).get('/api/federation/stats');

    expect(res.body).toMatchObject({
      peerCount: 2, verifiedPeerCount: 1, userCount: 5, serverCount: 2,
      instance: 'https://bridge.test', instanceName: 'Bridge Testi', federation: true,
    });
  });

  it('örnek adresi/adı tanımsızsa güvenli yedeğe düşülür', async () => {
    const url = process.env.INSTANCE_URL;
    const name = process.env.INSTANCE_NAME;
    delete process.env.INSTANCE_URL;
    delete process.env.INSTANCE_NAME;
    try {
      const res = await request(app).get('/api/federation/stats');

      expect(String(res.body.instance)).toContain('localhost');
      expect(res.body.instanceName).toBe('Bridge Instance');
    } finally {
      process.env.INSTANCE_URL = url;
      process.env.INSTANCE_NAME = name;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /peers — eş ekleme', () => {
  const addPeer = (body: unknown = { url: 'https://peer.test' }) =>
    request(app).post('/api/federation/peers').send(body as object);

  it('adres verilmezse 400', async () => {
    const res = await addPeer({});
    expect(res.status).toBe(400);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('YÖNETİCİ olmayan eş ekleyemez', async () => {
    repos.Users.findById.mockResolvedValue({ _id: 'user-1' });
    expect((await addPeer()).status).toBe(403);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('kullanıcı kaydı yoksa da eklenemez', async () => {
    repos.Users.findById.mockResolvedValue(null);
    expect((await addPeer()).status).toBe(403);
  });

  it('uzak uç REDDEDERSE eş eklenmez', async () => {
    fetchT.mockResolvedValue(remote({}, 502));

    const res = await addPeer();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('502');
    expect(repos.Federation.insertPeer).not.toHaveBeenCalled();
  });

  it('BRIDGE olmayan bir örnek eklenmez', async () => {
    fetchT.mockResolvedValue(remote({ software: 'mastodon' }));

    const res = await addPeer();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Not a Bridge instance');
  });

  it('uzak uca ulaşılamazsa açık neden döner', async () => {
    fetchT.mockRejectedValue(new Error('ENOTFOUND'));

    const res = await addPeer();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ENOTFOUND');
  });

  it('ZATEN kayıtlı eş yeniden eklenmez', async () => {
    repos.Federation.findPeerByUrl.mockResolvedValue({ _id: 'p1' });

    expect((await addPeer()).status).toBe(409);
    expect(repos.Federation.insertPeer).not.toHaveBeenCalled();
  });

  it('uzak bilgideki eksik alanlar İSTENEN adrese düşer', async () => {
    fetchT.mockResolvedValue(remote({ software: 'bridge' }));

    const res = await addPeer({ url: 'https://peer.test/' });

    expect(res.status).toBe(200);
    expect(repos.Federation.insertPeer).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://peer.test/', name: 'https://peer.test/', desc: '', verified: true, publicKey: null,
    }));
  });

  it('uzak bilgideki kanonik adres ve anahtar KORUNUR', async () => {
    fetchT.mockResolvedValue(remote({
      software: 'bridge', url: 'https://kanonik.test', name: 'Kanonik',
      description: 'açıklama', publicKey: { publicKeyPem: PEM },
    }));

    await addPeer({ url: 'https://peer.test' });

    expect(repos.Federation.findPeerByUrl).toHaveBeenCalledWith('https://kanonik.test');
    expect(repos.Federation.insertPeer).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://kanonik.test', name: 'Kanonik', desc: 'açıklama', publicKey: PEM,
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /peers/:id ve GET /health', () => {
  it('yönetici olmayan eş silemez', async () => {
    repos.Users.findById.mockResolvedValue({ _id: 'user-1' });

    expect((await request(app).delete('/api/federation/peers/p1')).status).toBe(403);
    expect(repos.Federation.removePeerById).not.toHaveBeenCalled();
  });

  it('yönetici eş silebilir', async () => {
    const res = await request(app).delete('/api/federation/peers/p1');

    expect(res.body).toEqual({ ok: true });
    expect(repos.Federation.removePeerById).toHaveBeenCalledWith('p1');
  });

  it('sağlık görünümü yalnız yöneticiye açıktır', async () => {
    repos.Users.findById.mockResolvedValue({ _id: 'user-1' });
    expect((await request(app).get('/api/federation/health')).status).toBe(403);
  });

  it('TAZE ve BAYAT eşler ayırt edilir; hiç görülmemiş eş yaşsızdır', async () => {
    const now = Date.now();
    repos.Federation.findPeers.mockResolvedValue([
      { _id: 'p1', url: 'https://a.test', name: 'A', lastSeen: now - 60_000 },
      { _id: 'p2', url: 'https://b.test', name: 'B', lastSeen: now - 20 * 60_000 },
      { _id: 'p3', url: 'https://c.test', name: 'C' },
    ]);

    const res = await request(app).get('/api/federation/health');

    expect(res.body.total).toBe(3);
    expect(res.body.online).toBe(1);
    expect(res.body.peers[1].online).toBe(false);
    expect(res.body.peers[2].ageMins).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /discover — dayanıklı keşif', () => {
  const peer = (url: string, name = 'Eş') => ({ _id: url, url, name });

  it('eş yoksa boş sonuç döner', async () => {
    const res = await request(app).get('/api/federation/discover');

    expect(res.body).toEqual({ count: 0, servers: [] });
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('ADRESSİZ eş atlanır', async () => {
    repos.Federation.findPeers.mockResolvedValue([{ _id: 'p1' }, { _id: 'p2', url: '' }]);

    const res = await request(app).get('/api/federation/discover');

    expect(res.body.count).toBe(0);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('bir eş ÇÖKSE de diğerinin sonuçları döner', async () => {
    repos.Federation.findPeers.mockResolvedValue([peer('https://kotu.test'), peer('https://iyi.test', 'İyi')]);
    fetchT.mockImplementation(async (url: string) => {
      if (url.includes('kotu')) throw new Error('offline');
      return remote({ servers: [{ id: 's1', name: 'Uzak', memberCount: 3 }] });
    });

    const res = await request(app).get('/api/federation/discover');

    expect(res.body.count).toBe(1);
    expect(res.body.servers[0]).toMatchObject({
      id: 's1', _instanceUrl: 'https://iyi.test', _instanceName: 'İyi', _remote: true,
    });
  });

  it('REDDEDEN eş atlanır', async () => {
    repos.Federation.findPeers.mockResolvedValue([peer('https://red.test')]);
    fetchT.mockResolvedValue(remote({}, 503));

    expect((await request(app).get('/api/federation/discover')).body.count).toBe(0);
  });

  it('sunucu listesi olmayan gövde boş sayılır', async () => {
    repos.Federation.findPeers.mockResolvedValue([peer('https://bos.test')]);
    fetchT.mockResolvedValue(remote({}));

    expect((await request(app).get('/api/federation/discover')).body.count).toBe(0);
  });

  it('SORGU ada, açıklamaya ve etikete göre süzer', async () => {
    repos.Federation.findPeers.mockResolvedValue([peer('https://a.test')]);
    fetchT.mockResolvedValue(remote({
      servers: [
        { id: 's1', name: 'Tasarım' },
        { id: 's2', description: 'tasarım topluluğu' },
        { id: 's3', tags: ['Tasarim'] },
        { id: 's4', name: 'Başka' },
      ],
    }));

    const res = await request(app).get('/api/federation/discover?q=tasar');

    expect(res.body.servers.map((s: { id: string }) => s.id).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('ETİKET süzgeci TAM eşleşme ister', async () => {
    repos.Federation.findPeers.mockResolvedValue([peer('https://a.test')]);
    fetchT.mockResolvedValue(remote({
      servers: [{ id: 's1', tags: ['Oyun'] }, { id: 's2', tags: ['oyunlar'] }, { id: 's3' }],
    }));

    const res = await request(app).get('/api/federation/discover?tag=oyun');

    expect(res.body.servers.map((s: { id: string }) => s.id)).toEqual(['s1']);
  });

  it('sonuçlar ÜYE SAYISINA göre sıralanır ve sayısı olmayan sona düşer', async () => {
    repos.Federation.findPeers.mockResolvedValue([peer('https://a.test')]);
    fetchT.mockResolvedValue(remote({
      servers: [{ id: 'az', memberCount: 2 }, { id: 'yok' }, { id: 'cok', memberCount: 90 }],
    }));

    const res = await request(app).get('/api/federation/discover');

    expect(res.body.servers.map((s: { id: string }) => s.id)).toEqual(['cok', 'az', 'yok']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /ping ve /key-update — İMZALI kimlik otoritedir', () => {
  const ping = (body: unknown) => request(app).post('/api/federation/ping').send(body as object);
  const keyUpdate = (body: unknown) => request(app).post('/api/federation/key-update').send(body as object);

  it('adres verilmezse ping reddedilir', async () => {
    expect((await ping({})).status).toBe(400);
    expect(repos.Federation.updatePeer).not.toHaveBeenCalled();
  });

  it('imzalı kimlik yoksa ping reddedilir', async () => {
    signedPeerUrl = undefined;

    expect((await ping({ url: 'https://peer.test' })).status).toBe(400);
  });

  it('gövdedeki adres imzalı kimlikle EŞLEŞMEZSE reddedilir', async () => {
    const res = await ping({ url: 'https://baska-es.test' });

    expect(res.status).toBe(403);
    expect(repos.Federation.updatePeer).not.toHaveBeenCalled();
  });

  it('eş kimliği çözülemiyorsa yazma yapılmaz', async () => {
    signedPeerId = null;

    const res = await ping({ url: 'https://peer.test' });

    expect(res.status).toBe(401);
    expect(repos.Federation.updatePeer).not.toHaveBeenCalled();
  });

  it('meşru ping İMZALI kimliğe yazar', async () => {
    const res = await ping({ url: 'https://peer.test/' });

    expect(res.status).toBe(200);
    expect(repos.Federation.updatePeer).toHaveBeenCalledWith('peer-1', {
      $set: expect.objectContaining({ verified: true }),
    });
  });

  it.each([
    ['adres yok', { publicKey: { publicKeyPem: PEM } }],
    ['adres çözülemiyor', { url: 'bu-url-degil', publicKey: { publicKeyPem: PEM } }],
    ['şema desteklenmiyor', { url: 'ftp://peer.test', publicKey: { publicKeyPem: PEM } }],
    ['anahtar yok', { url: 'https://peer.test' }],
  ])('anahtar güncelleme %s ise reddedilir', async (_label, body) => {
    const res = await keyUpdate(body);

    expect(res.status).toBe(400);
    expect(repos.Federation.updatePeer).not.toHaveBeenCalled();
  });

  it('imzalı kimlikten FARKLI bir eşin anahtarı güncellenemez', async () => {
    const res = await keyUpdate({ url: 'https://kurban.test', publicKey: { publicKeyPem: PEM } });

    expect(res.status).toBe(403);
    expect(repos.Federation.updatePeer).not.toHaveBeenCalled();
  });

  it('PEM biçimi doğrulanır', async () => {
    const res = await keyUpdate({ url: 'https://peer.test', publicKey: { publicKeyPem: 'düz metin' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid publicKeyPem');
  });

  it('eş kimliği yoksa anahtar yazılmaz', async () => {
    signedPeerId = undefined;

    const res = await keyUpdate({ url: 'https://peer.test', publicKey: { publicKeyPem: PEM } });

    expect(res.status).toBe(401);
  });

  it('meşru anahtar güncellemesi İMZALI kimliğe yazar', async () => {
    const res = await keyUpdate({ instanceUrl: 'https://peer.test', publicKey: { publicKeyPem: PEM } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, peerId: 'peer-1', instanceUrl: 'https://peer.test' });
    expect(repos.Federation.updatePeer).toHaveBeenCalledWith('peer-1', {
      $set: expect.objectContaining({ publicKey: PEM, verified: true }),
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /join-remote ve GET /fetch-remote', () => {
  it('eksik alanlar reddedilir', async () => {
    const res = await request(app).post('/api/federation/join-remote').send({ instanceUrl: 'https://a.test' });

    expect(res.status).toBe(400);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('uzak uç erişilemezse 502 döner', async () => {
    fetchT.mockResolvedValue(remote({}, 500));

    const res = await request(app).post('/api/federation/join-remote')
      .send({ instanceUrl: 'https://a.test', serverId: 's1' });

    expect(res.status).toBe(502);
  });

  it('sunucu uzak listede yoksa 404 döner', async () => {
    fetchT.mockResolvedValue(remote({ servers: [{ id: 'baska' }] }));

    const res = await request(app).post('/api/federation/join-remote')
      .send({ instanceUrl: 'https://a.test', serverId: 's1' });

    expect(res.status).toBe(404);
  });

  it('liste hiç yoksa da 404 döner', async () => {
    fetchT.mockResolvedValue(remote({}));

    const res = await request(app).post('/api/federation/join-remote')
      .send({ instanceUrl: 'https://a.test', serverId: 's1' });

    expect(res.status).toBe(404);
  });

  it('davet adresi yoksa TÜRETİLİR', async () => {
    fetchT.mockResolvedValue(remote({ servers: [{ id: 's1', name: 'Uzak' }] }));

    const res = await request(app).post('/api/federation/join-remote')
      .send({ instanceUrl: 'https://a.test', serverId: 's1' });

    expect(res.body.inviteUrl).toBe('https://a.test/invite-server/s1');
  });

  it('uzak davet adresi KORUNUR', async () => {
    fetchT.mockResolvedValue(remote({ servers: [{ id: 's1', inviteUrl: 'https://a.test/ozel' }] }));

    const res = await request(app).post('/api/federation/join-remote')
      .send({ instanceUrl: 'https://a.test', serverId: 's1' });

    expect(res.body.inviteUrl).toBe('https://a.test/ozel');
  });

  it.each([
    ['adres yok', ''],
    ['adres çözülemiyor', 'bu-url-degil'],
    ['şema desteklenmiyor', 'ftp://a.test/x'],
  ])('vekil isteği %s ise reddedilir', async (_label, url) => {
    const res = await request(app).get(`/api/federation/fetch-remote?url=${encodeURIComponent(url)}`);

    expect(res.status).toBe(400);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('uzak uç reddederse 502 döner', async () => {
    fetchT.mockResolvedValue(remote({}, 404));

    const res = await request(app).get('/api/federation/fetch-remote?url=https%3A%2F%2Fa.test%2Fx');

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('404');
  });

  it('uzak uç patlarsa 502 döner', async () => {
    fetchT.mockRejectedValue(new Error('timeout'));

    const res = await request(app).get('/api/federation/fetch-remote?url=https%3A%2F%2Fa.test%2Fx');

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('timeout');
  });

  it('başarılı vekil isteği gövdeyi aktarır', async () => {
    fetchT.mockResolvedValue(remote({ hello: 'world' }));

    const res = await request(app).get('/api/federation/fetch-remote?url=https%3A%2F%2Fa.test%2Fx');

    expect(res.body).toEqual({ hello: 'world' });
  });
});
