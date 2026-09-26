import type { RequestBody } from './helpers/httpDoubles';
// server/tests/activitypub-instance-url-and-collection-shapes.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ACTIVITYPUB — ÖRNEK ADRESİ, AKTÖR KİMLİĞİ VE KOLEKSİYON ŞEKLİ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/activitypub-security-branches.test.ts` imza/ACL sınırlarını
// `INSTANCE_URL` AYARLIYKEN ölçer. Bu tamamlayıcı takım tam tersini yapar ve
// federasyonun sessizce bozulduğu üç yeri kapatır:
//
//   · ÖRNEK ADRESİ — `INSTANCE_URL` verilmemişse tüm uç noktalar AYNI
//     yedek adrese düşmelidir. Uçlar birbirinden farklı bir kimlik üretirse
//     üretilen aktör belgesi geçersizdir: uzak sunucu `id` ile getirdiği
//     adresi karşılaştırır ve eşleşmezse aktörü tümden reddeder.
//   · AKTÖR KİMLİĞİ — `actor` bir dize yerine nesne olabilir, sonda eğik
//     çizgi taşıyabilir ya da parça (#fragment) içerebilir. Bunlar AYNI
//     aktördür; farklı normalleştirme imza-aktör eşleşmesini bozar.
//   · KOLEKSİYON ŞEKLİ — depo katmanı dizi yerine `null` ya da bir thenable
//     döndürdüğünde uç nokta çökmemeli, boş/çözülmüş koleksiyon vermelidir.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'ap-shape-secretxxxxxxxxxxxxxxxxx';

const users = { findByUsername: jest.fn() };
const federation = {
  insertActivity: jest.fn(), updateActivity: jest.fn(),
  claimInboundActivity: jest.fn(), completeInboundActivity: jest.fn(), failInboundActivity: jest.fn(),
  findApFollows: jest.fn(), findApOutgoingFollows: jest.fn(),
  apActivitiesFind: jest.fn(), countActivities: jest.fn(),
};
const verify = jest.fn();
const acl = jest.fn();
const helpers = {
  handleApFollow: jest.fn(), handleApUnfollow: jest.fn(), handleApAccept: jest.fn(),
  handleApReject: jest.fn(), handleApCreate: jest.fn(), handleApDelete: jest.fn(),
  handleApUpdate: jest.fn(), handleApLike: jest.fn(), handleApAnnounce: jest.fn(),
  deliverApActivity: jest.fn(), deliverToFollowers: jest.fn(), fanOutActivityToFollowers: jest.fn(),
};
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../db/repositories', () => ({ Users: users, Federation: federation }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const id = req.headers['x-caller'];
    if (!id) return res.status(401).json({ error: 'No token' });
    req.user = { id: String(id) };
    return next();
  },
  castAuthed: (req: any) => req,
}));
jest.mock('../lib/httpSignature', () => ({ verifyHttpSignature: (...args: unknown[]) => verify(...args) }));
jest.mock('../routes/admin', () => ({ checkFederationACL: (...args: unknown[]) => acl(...args) }));
jest.mock('../routes/federation/helpers', () => helpers);
jest.mock('../lib/logger', () => ({ __esModule: true, default: log }));
jest.mock('../middleware/federationRateLimit', () => ({
  federationGlobalRateLimit: (_req: any, _res: any, next: any) => next(),
  federationInboxRateLimit: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { api: () => (_req: any, _res: any, next: any) => next() } }));

import express from 'express';
import request from 'supertest';
import router from '../routes/federation/activitypub';

const app = express();
app.use(express.json());
app.use('/api/federation', router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));

const alice = { _id: 'u1', username: 'alice', displayName: 'Alice', bio: 'hi', avatarUrl: 'https://cdn.test/a.png', apPublicKey: 'PEM' };

const previousInstanceUrl = process.env.INSTANCE_URL;
const previousPort = process.env.PORT;

beforeEach(() => {
  jest.clearAllMocks();
  // Another suite in the same worker may already have exported INSTANCE_URL.
  // These tests are specifically about its ABSENCE, so clear it explicitly.
  delete process.env.INSTANCE_URL;
  delete process.env.PORT;
  users.findByUsername.mockResolvedValue(alice);
  federation.insertActivity.mockResolvedValue({});
  federation.updateActivity.mockResolvedValue({});
  federation.claimInboundActivity.mockResolvedValue({ status: 'claimed', id: 'journal-claim' });
  federation.completeInboundActivity.mockResolvedValue(undefined);
  federation.failInboundActivity.mockResolvedValue(undefined);
  federation.findApFollows.mockResolvedValue([]);
  federation.findApOutgoingFollows.mockResolvedValue([]);
  federation.apActivitiesFind.mockResolvedValue([]);
  federation.countActivities.mockResolvedValue(0);
  verify.mockResolvedValue({ ok: true });
  acl.mockResolvedValue({ allowed: true });
  helpers.fanOutActivityToFollowers.mockResolvedValue({ followers: 0, failed: 0 });
});

afterAll(() => {
  if (previousInstanceUrl === undefined) delete process.env.INSTANCE_URL;
  else process.env.INSTANCE_URL = previousInstanceUrl;
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
});

/** `apActivitiesFind` is chained as `.sort().limit()` by the outbox page path. */
function pagedActivities(rows: unknown) {
  const chain = { sort: () => chain, limit: () => Promise.resolve(rows) };
  return chain;
}

describe('instance URL fallback is consistent across every federation endpoint', () => {
  it('with no INSTANCE_URL and no PORT every endpoint agrees on http://localhost:3001', async () => {
    federation.countActivities.mockResolvedValue(3);

    const webfinger = await request(app).get('/api/federation/webfinger?resource=acct:alice@localhost').expect(200);
    const actor = await request(app).get('/api/federation/users/alice').expect(200);
    const outbox = await request(app).get('/api/federation/users/alice/outbox').expect(200);
    const followers = await request(app).get('/api/federation/users/alice/followers').expect(200);
    const following = await request(app).get('/api/federation/users/alice/following').expect(200);

    const expected = 'http://localhost:3001/api/federation/users/alice';
    expect(webfinger.body.links[0].href).toBe(expected);
    expect(actor.body.id).toBe(expected);
    // Every collection the actor advertises must live under that same id, or a
    // remote server cannot verify the actor it fetched.
    expect(actor.body.inbox).toBe(`${expected}/inbox`);
    expect(actor.body.outbox).toBe(`${expected}/outbox`);
    expect(actor.body.followers).toBe(`${expected}/followers`);
    expect(actor.body.following).toBe(`${expected}/following`);
    expect(actor.body.publicKey.id).toBe(`${expected}#main-key`);
    expect(outbox.body.id).toBe(`${expected}/outbox`);
    expect(followers.body.id).toBe(`${expected}/followers`);
    expect(following.body.id).toBe(`${expected}/following`);
  });

  it('the fallback honours the configured PORT', async () => {
    process.env.PORT = '8088';
    const actor = await request(app).get('/api/federation/users/alice').expect(200);
    expect(actor.body.id).toBe('http://localhost:8088/api/federation/users/alice');

    const webfinger = await request(app)
      .get('/api/federation/webfinger?resource=acct:alice@localhost').expect(200);
    expect(webfinger.body.links[0].href).toBe('http://localhost:8088/api/federation/users/alice');
  });

  it('an explicit INSTANCE_URL wins over the fallback', async () => {
    process.env.INSTANCE_URL = 'https://social.bridge.test';
    process.env.PORT = '8088';
    const actor = await request(app).get('/api/federation/users/alice').expect(200);
    expect(actor.body.id).toBe('https://social.bridge.test/api/federation/users/alice');
  });

  it('webfinger refuses a resource addressed to a different host', async () => {
    const r = await request(app)
      .get('/api/federation/webfinger?resource=acct:alice@elsewhere.test').expect(400);
    expect(r.body.error).toBe('Resource is not local to this instance');
    expect(users.findByUsername).not.toHaveBeenCalled();
  });

  it('webfinger without a resource parameter is a 400, not a crash', async () => {
    const r = await request(app).get('/api/federation/webfinger').expect(400);
    expect(r.body.error).toBe('Invalid resource');
  });
});

describe('actor document optional fields', () => {
  it('falls back to the username and omits the icon when the profile is bare', async () => {
    users.findByUsername.mockResolvedValue({ _id: 'u2', username: 'bare' });
    const r = await request(app).get('/api/federation/users/bare').expect(200);
    expect(r.body.name).toBe('bare');
    expect(r.body.summary).toBe('');
    expect(r.body.icon).toBeUndefined();
    // An absent key must be visible as such, never emitted as an empty PEM that
    // a remote server would try to import.
    expect(r.body.publicKey.publicKeyPem).toBe('(not yet generated)');
  });

  it('publishes the avatar as an Image icon when one exists', async () => {
    const r = await request(app).get('/api/federation/users/alice').expect(200);
    expect(r.body.icon).toEqual({ type: 'Image', mediaType: 'image/jpeg', url: 'https://cdn.test/a.png' });
    expect(r.body.name).toBe('Alice');
  });

  it('an unknown actor is 404 on every per-user endpoint', async () => {
    users.findByUsername.mockResolvedValue(null);
    for (const path of ['', '/outbox', '/followers', '/following', '/notes/n1']) {
      const r = await request(app).get(`/api/federation/users/ghost${path}`).expect(404);
      expect(r.body.error).toBe('Not found');
    }
  });
});

describe('inbox actor identity normalization', () => {
  const inbox = (body: object) =>
    request(app).post('/api/federation/users/alice/inbox').set('signature', 'sig').send(body);

  it('an object actor is bound by its id, exactly like a string actor', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test/users/bob' });
    const r = await inbox({ type: 'Follow', actor: { id: 'https://remote.test/users/bob', type: 'Person' } });
    expect(r.status).toBe(202);
    expect(acl).toHaveBeenCalledWith('remote.test');
    expect(helpers.handleApFollow).toHaveBeenCalledTimes(1);
  });

  it('a trailing slash and a fragment describe the same actor as the bare URL', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test/users/bob#main-key' });
    const r = await inbox({ type: 'Follow', actor: 'https://remote.test/users/bob/' });
    expect(r.status).toBe(202);
  });

  it('an actor that is only a root path keeps its slash instead of collapsing to empty', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test///' });
    const r = await inbox({ type: 'Follow', actor: 'https://remote.test/' });
    expect(r.status).toBe(202);
    expect(acl).toHaveBeenCalledWith('remote.test');
  });

  it('an actor that is neither a string nor an object with an id cannot be signed for', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test/users/bob' });
    const r = await inbox({ type: 'Follow', actor: 12345 });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('HTTP Signature actor mismatch');
    expect(federation.claimInboundActivity).not.toHaveBeenCalled();
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });

  it('a signed activity id must be a bounded non-empty string', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test/users/bob' });
    for (const id of [123, '', '   ', 'x'.repeat(2049)]) {
      const r = await inbox({ type: 'Follow', actor: 'https://remote.test/users/bob', id });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/activity id must be a bounded non-empty string/);
    }
    expect(federation.claimInboundActivity).not.toHaveBeenCalled();
  });

  it('a signed, claimed activity releases its claim on success', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test/users/bob' });
    federation.claimInboundActivity.mockResolvedValue({ status: 'claimed', id: 'journal-9' });
    const r = await inbox({
      type: 'Like', actor: 'https://remote.test/users/bob', id: 'https://remote.test/activities/1',
    });
    expect(r.status).toBe(202);
    expect(helpers.handleApLike).toHaveBeenCalledTimes(1);
    expect(federation.completeInboundActivity).toHaveBeenCalledWith('journal-9', expect.any(String));
    expect(federation.updateActivity).not.toHaveBeenCalled();
  });

  it('a signed activity whose handler throws releases the claim with the failure reason', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test/users/bob' });
    federation.claimInboundActivity.mockResolvedValue({ status: 'claimed', id: 'journal-10' });
    helpers.handleApCreate.mockRejectedValueOnce(new Error('note persistence exploded'));
    const r = await inbox({
      type: 'Create', actor: 'https://remote.test/users/bob', id: 'https://remote.test/activities/2',
    });
    expect(r.status).toBe(500);
    expect(federation.failInboundActivity)
      .toHaveBeenCalledWith('journal-10', expect.any(String), 'note persistence exploded');
    expect(federation.completeInboundActivity).not.toHaveBeenCalled();
  });

  it('a non-Error handler failure still records a readable reason', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test/users/bob' });
    federation.claimInboundActivity.mockResolvedValue({ status: 'claimed', id: 'journal-11' });
    helpers.handleApAnnounce.mockRejectedValueOnce('boost backend offline');
    const r = await inbox({
      type: 'Announce', actor: 'https://remote.test/users/bob', id: 'https://remote.test/activities/3',
    });
    expect(r.status).toBe(500);
    expect(federation.failInboundActivity)
      .toHaveBeenCalledWith('journal-11', expect.any(String), 'boost backend offline');
  });

  it('a claim release that itself fails is logged without masking the original error', async () => {
    verify.mockResolvedValue({ ok: true, signerActor: 'https://remote.test/users/bob' });
    federation.claimInboundActivity.mockResolvedValue({ status: 'claimed', id: 'journal-12' });
    helpers.handleApDelete.mockRejectedValueOnce(new Error('original handler failure'));
    federation.failInboundActivity.mockRejectedValueOnce(new Error('journal offline'));
    const r = await inbox({
      type: 'Delete', actor: 'https://remote.test/users/bob', id: 'https://remote.test/activities/4',
    });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('original handler failure');
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.inbox.claim_release_failed' }), expect.any(String));
  });
});

describe('inbox without a signature (development fixtures)', () => {
  const unsigned = (body: object) =>
    request(app).post('/api/federation/users/alice/inbox').send(body);

  it('journals the activity and marks it processed without a claim', async () => {
    const r = await unsigned({ type: 'Follow', actor: 'https://remote.test/users/bob' });
    expect(r.status).toBe(202);
    expect(federation.claimInboundActivity).not.toHaveBeenCalled();
    expect(federation.insertActivity).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: 'u1', actorUrl: 'https://remote.test/users/bob', type: 'Follow', processed: false,
    }));
    expect(federation.updateActivity).toHaveBeenCalledWith(
      { _id: expect.any(String) },
      { $set: { processed: true, processedAt: expect.any(Number) } },
    );
  });

  it('an unparseable actor skips the domain ACL rather than blocking the whole inbox', async () => {
    const r = await unsigned({ type: 'Follow', actor: 'not-a-url' });
    expect(r.status).toBe(202);
    expect(acl).not.toHaveBeenCalled();
    // The journal still records the request; only the ACL step is skipped.
    expect(federation.insertActivity).toHaveBeenCalledWith(expect.objectContaining({ actorUrl: null }));
  });

  it('attributedTo stands in for a missing actor', async () => {
    const r = await unsigned({ type: 'Create', attributedTo: 'https://remote.test/users/carol' });
    expect(r.status).toBe(202);
    expect(acl).toHaveBeenCalledWith('remote.test');
    expect(federation.insertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actorUrl: 'https://remote.test/users/carol' }));
  });

  it('an object attributedTo is resolved through its id for the ACL check', async () => {
    const r = await unsigned({ type: 'Create', attributedTo: { id: 'https://remote.test/users/dave' } });
    expect(r.status).toBe(202);
    expect(acl).toHaveBeenCalledWith('remote.test');
  });

  it('an unsigned handler failure never touches the claim journal', async () => {
    helpers.handleApFollow.mockRejectedValueOnce(new Error('unsigned handler failure'));
    const r = await unsigned({ type: 'Follow', actor: 'https://remote.test/users/bob' });
    expect(r.status).toBe(500);
    expect(federation.failInboundActivity).not.toHaveBeenCalled();
    expect(federation.completeInboundActivity).not.toHaveBeenCalled();
  });

  it('an activity without a type is rejected before any persistence', async () => {
    const r = await unsigned({ actor: 'https://remote.test/users/bob' });
    expect(r.status).toBe(400);
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });
});

describe('outbox collection paging', () => {
  it('a repository result that is not an array yields an empty page instead of a crash', async () => {
    federation.apActivitiesFind.mockReturnValue(pagedActivities(null));
    const r = await request(app).get('/api/federation/users/alice/outbox?page=true').expect(200);
    expect(r.body.type).toBe('OrderedCollectionPage');
    expect(r.body.orderedItems).toEqual([]);
    expect(r.body.next).toBeUndefined();
  });

  it('a full page advertises the next cursor from the oldest row', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      activity: { id: `a${i}` }, publishedAt: 2000 - i,
    }));
    federation.apActivitiesFind.mockReturnValue(pagedActivities(rows));
    const r = await request(app).get('/api/federation/users/alice/outbox?page=true').expect(200);
    expect(r.body.orderedItems).toHaveLength(20);
    expect(r.body.next).toBe('http://localhost:3001/api/federation/users/alice/outbox?page=true&min_id=1981');
  });

  it('a full page whose oldest row has no timestamp still emits a usable cursor', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => (
      i === 19 ? { activity: { id: 'last' } } : { activity: { id: `a${i}` }, publishedAt: 2000 - i }
    ));
    federation.apActivitiesFind.mockReturnValue(pagedActivities(rows));
    const r = await request(app).get('/api/federation/users/alice/outbox?page=true').expect(200);
    // 0 rather than `undefined`: a literal "undefined" in the cursor would make
    // the next request fail min_id validation and dead-end the collection.
    expect(r.body.next).toBe('http://localhost:3001/api/federation/users/alice/outbox?page=true&min_id=0');
  });

  it('a short page has no next cursor', async () => {
    federation.apActivitiesFind.mockReturnValue(pagedActivities([{ activity: { id: 'only' }, publishedAt: 5 }]));
    const r = await request(app).get('/api/federation/users/alice/outbox?page=true').expect(200);
    expect(r.body.next).toBeUndefined();
    expect(r.body.partOf).toBe('http://localhost:3001/api/federation/users/alice/outbox');
  });

  it('a cursor selects strictly older rows and is echoed in the page id', async () => {
    federation.apActivitiesFind.mockReturnValue(pagedActivities([]));
    const r = await request(app).get('/api/federation/users/alice/outbox?page=true&min_id=1500').expect(200);
    expect(federation.apActivitiesFind).toHaveBeenCalledWith(
      expect.objectContaining({ publishedAt: { $lt: 1500 } }));
    expect(r.body.id).toContain('&min_id=1500');
  });

  it('a non-integer cursor is rejected before the query runs', async () => {
    const r = await request(app).get('/api/federation/users/alice/outbox?page=true&min_id=abc').expect(400);
    expect(r.body.error).toMatch(/min_id must be a safe non-negative integer/);
    expect(federation.apActivitiesFind).not.toHaveBeenCalled();
  });

  it('the collection head reports zero when the count is missing', async () => {
    federation.countActivities.mockResolvedValue(undefined);
    const r = await request(app).get('/api/federation/users/alice/outbox').expect(200);
    expect(r.body.totalItems).toBe(0);
    expect(r.body.first).toBe('http://localhost:3001/api/federation/users/alice/outbox?page=true');
  });
});

describe('follower/following/note collections tolerate sparse repository results', () => {
  it('a null follower result becomes an empty collection', async () => {
    federation.findApFollows.mockResolvedValue(null);
    const r = await request(app).get('/api/federation/users/alice/followers').expect(200);
    expect(r.body.totalItems).toBe(0);
    expect(r.body.orderedItems).toEqual([]);
  });

  it('a thenable follower result is awaited before it is counted', async () => {
    const rows = [{ actorUrl: 'https://remote.test/users/bob' }];
    federation.findApFollows.mockResolvedValue({ then: (resolve: (v: unknown) => void) => resolve(rows) });
    const r = await request(app).get('/api/federation/users/alice/followers').expect(200);
    expect(r.body.totalItems).toBe(1);
    expect(r.body.orderedItems).toEqual(['https://remote.test/users/bob']);
  });

  it('a null following result becomes an empty collection', async () => {
    federation.findApOutgoingFollows.mockResolvedValue(null);
    const r = await request(app).get('/api/federation/users/alice/following').expect(200);
    expect(r.body.totalItems).toBe(0);
  });

  it('a thenable following result is awaited and only accepted follows are requested', async () => {
    const rows = [{ targetActorUrl: 'https://remote.test/users/eve' }];
    federation.findApOutgoingFollows.mockResolvedValue({ then: (resolve: (v: unknown) => void) => resolve(rows) });
    const r = await request(app).get('/api/federation/users/alice/following').expect(200);
    expect(federation.findApOutgoingFollows).toHaveBeenCalledWith({ fromUserId: 'u1', accepted: true });
    expect(r.body.orderedItems).toEqual(['https://remote.test/users/eve']);
  });

  it('a null note result is a 404, not a 500', async () => {
    federation.apActivitiesFind.mockResolvedValue(null);
    const r = await request(app).get('/api/federation/users/alice/notes/n1').expect(404);
    expect(r.body.error).toBe('Note not found');
  });

  it('a thenable note result is awaited and matched by the fully qualified note id', async () => {
    const noteId = 'http://localhost:3001/api/federation/users/alice/notes/n1';
    const rows = [
      { activity: { object: { id: 'http://localhost:3001/api/federation/users/alice/notes/other' } } },
      { activity: { object: { id: noteId, type: 'Note', content: 'hello' } } },
    ];
    federation.apActivitiesFind.mockResolvedValue({ then: (resolve: (v: unknown) => void) => resolve(rows) });
    const r = await request(app).get('/api/federation/users/alice/notes/n1').expect(200);
    expect(r.body).toEqual({ id: noteId, type: 'Note', content: 'hello' });
  });

  it('an activity row whose object is not a record cannot satisfy a note lookup', async () => {
    federation.apActivitiesFind.mockResolvedValue([{ activity: { object: 'https://remote.test/notes/1' } }]);
    await request(app).get('/api/federation/users/alice/notes/n1').expect(404);
  });
});

describe('C2S outbox publish', () => {
  const publish = (body: RequestBody, caller = 'u1') =>
    request(app).post('/api/federation/users/alice/outbox').set('x-caller', caller).send(body);

  it('persists exactly the activity it delivers, addressed by visibility', async () => {
    const r = await publish({ content: 'hello fediverse', visibility: 'unlisted' }).expect(201);
    const persisted = federation.insertActivity.mock.calls[0]![0] as any;
    const delivered = helpers.fanOutActivityToFollowers.mock.calls[0]![1];
    expect(delivered).toBe(persisted.activity);
    expect(persisted.activity.to).toEqual(['http://localhost:3001/api/federation/users/alice/followers']);
    expect(persisted.activity.cc).toEqual(['https://www.w3.org/ns/activitystreams#Public']);
    expect(r.body.id).toBe(persisted.activityId);
    expect(r.body.noteId).toBe(persisted.noteId);
  });

  it('followers-only posts carry no public addressing at all', async () => {
    await publish({ content: 'private note', visibility: 'followers' }).expect(201);
    const persisted = federation.insertActivity.mock.calls[0]![0] as any;
    expect(persisted.activity.to).toEqual(['http://localhost:3001/api/federation/users/alice/followers']);
    expect(persisted.activity.cc).toEqual([]);
    expect(JSON.stringify(persisted.activity)).not.toContain('activitystreams#Public');
  });

  it('optional note fields are omitted rather than emitted as falsy values', async () => {
    await publish({ content: 'bare note' }).expect(201);
    const note = (federation.insertActivity.mock.calls[0]![0] as any).activity.object;
    expect(note).not.toHaveProperty('sensitive');
    expect(note).not.toHaveProperty('summary');
    expect(note).not.toHaveProperty('inReplyTo');
  });

  it('a failed fan-out still reports the local publish as durable but degraded', async () => {
    helpers.fanOutActivityToFollowers.mockRejectedValueOnce(new Error('follower lookup offline'));
    const r = await publish({ content: 'degraded delivery' }).expect(201);
    expect(r.body.delivery).toEqual({ followers: 0, failed: 1 });
    expect(federation.insertActivity).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.outbox.fanout_lookup_failed' }), expect.any(String));
  });

  it('publishing on behalf of another user is forbidden before anything is written', async () => {
    const r = await publish({ content: 'impersonation' }, 'someone-else').expect(403);
    expect(r.body.error).toBe('Cannot publish on behalf of another user');
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });

  // Govde tipi `RequestBody`dir: `.send()` `string | object` kabul eder ve
  // gecersiz senaryolarin hepsi zaten bu ikisinden biri.
  const invalid: Array<[string, RequestBody, RegExp]> = [
    ['a non-string body', 'plain text', /content is required/],
    ['blank content', { content: '   ' }, /content is required/],
    ['oversized content', { content: 'x'.repeat(5001) }, /exceeds maximum length/],
    ['non-boolean sensitive', { content: 'a', sensitive: 'yes' }, /sensitive must be a boolean/],
    ['non-string summary', { content: 'a', summary: 5 }, /summary must be a string or null/],
    ['non-string inReplyTo', { content: 'a', inReplyTo: 5 }, /inReplyTo must be a string or null/],
    ['unknown visibility', { content: 'a', visibility: 'secret' }, /visibility must be/],
  ];
  for (const [name, body, message] of invalid) {
    it(`rejects ${name} without persisting anything`, async () => {
      const r = await publish(body).expect(400);
      expect(r.body.error).toMatch(message);
      expect(federation.insertActivity).not.toHaveBeenCalled();
      expect(helpers.fanOutActivityToFollowers).not.toHaveBeenCalled();
    });
  }

  it('a persistence failure is a 500 that names the cause instead of a silent 201', async () => {
    federation.insertActivity.mockRejectedValueOnce(new Error('journal write refused'));
    const r = await publish({ content: 'will not persist' }).expect(500);
    expect(r.body).toEqual({ error: 'C2S outbox publish failed', detail: 'journal write refused' });
    expect(helpers.fanOutActivityToFollowers).not.toHaveBeenCalled();
  });

  it('a non-Error failure still produces a bounded 500 body', async () => {
    federation.insertActivity.mockRejectedValueOnce('journal offline');
    const r = await publish({ content: 'will not persist' }).expect(500);
    expect(r.body).toEqual({ error: 'C2S outbox publish failed', detail: 'Unknown error' });
  });
});
