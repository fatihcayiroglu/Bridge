// server/tests/federation-inbox-handler-shapes.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ACTIVITYPUB GELEN KUTUSU İŞLEYİCİLERİ — NESNE ŞEKLİ VE KİMLİK SAHİPLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// Federe eden sunucular AYNI aktiviteyi farklı biçimlerde gönderir: `actor`
// bazen bir dize bazen bir nesne, `to`/`cc` bazen dizi bazen tek dize,
// `content` bazen yok (`name` var). Bu tamamlayıcı takım o şekilleri ve
// bunlara bağlı GÜVENLİK kararlarını ölçer:
//
//   · KİMLİK — bir AP nesne kimliği (`obj.id`) BİR aktöre aittir. Başka bir
//     aktörden aynı kimlikle gelen bir Create, var olan notu EZMEMELİDİR;
//     aksi hâlde herhangi bir sunucu başkasının notunun içeriğini değiştirir.
//   · DM SINIRI — yerel gönderenin kayıtlı `apUrl` değeri aktiviteyle
//     uyuşmuyorsa DM YAZILMAZ (kimliğe bürünme).
//   · SIRALAMA — `to`/`cc` şekli DM ile herkese açık notu ayırır; yanlış
//     sınıflandırma özel bir mesajı genel zaman akışına düşürür.
//   · KARARLI KİMLİKLER — satır kimlikleri içerikten türetilir, böylece aynı
//     aktivitenin yeniden teslimi ÇİFT satır üretmez.

'use strict';
process.env.NODE_ENV = 'test';

const Federation = {
  findApFollowOne: jest.fn(), insertApFollow: jest.fn(),
  removeApFollow: jest.fn(), removeApLike: jest.fn(), removeApAnnounce: jest.fn(),
  updateApOutgoingFollow: jest.fn(), removeApOutgoingFollow: jest.fn(),
  findApMessageOne: jest.fn(), insertApMessage: jest.fn(),
  updateApMessage: jest.fn(), removeApMessage: jest.fn(),
  insertApLike: jest.fn(), insertApAnnounce: jest.fn(),
};
const Notifications = { insertInbox: jest.fn() };
const Dms = { findOrCreateConversation: jest.fn(), insertMessage: jest.fn() };
const Users = { findByApUrl: jest.fn() };
const deliverApActivity = jest.fn();
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../db/repositories', () => ({ Federation, Notifications, Dms, Users }));
jest.mock('../routes/federation/delivery', () => ({ deliverApActivity: (...a: unknown[]) => deliverApActivity(...a) }));
jest.mock('../lib/logger', () => ({
  __esModule: true, default: log,
  info: (...a: unknown[]) => log.info(...a),
  warn: (...a: unknown[]) => log.warn(...a),
  error: (...a: unknown[]) => log.error(...a),
}));

import {
  handleApFollow, handleApUnfollow, handleApAccept, handleApReject,
  handleApCreate, handleApUpdate, handleApDelete, handleApLike, handleApAnnounce,
} from '../routes/federation/inbox-handlers';

const ALICE = { _id: 'local-1', username: 'alice' } as never;
const REMOTE = 'https://remote.test/users/bob';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

const previousInstanceUrl = process.env.INSTANCE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INSTANCE_URL = 'https://bridge.test';
  Federation.findApFollowOne.mockResolvedValue(null);
  Federation.insertApFollow.mockResolvedValue(undefined);
  Federation.removeApFollow.mockResolvedValue(undefined);
  Federation.removeApLike.mockResolvedValue(undefined);
  Federation.removeApAnnounce.mockResolvedValue(undefined);
  Federation.updateApOutgoingFollow.mockResolvedValue(undefined);
  Federation.removeApOutgoingFollow.mockResolvedValue(undefined);
  Federation.findApMessageOne.mockResolvedValue(null);
  Federation.insertApMessage.mockResolvedValue(undefined);
  Federation.updateApMessage.mockResolvedValue(undefined);
  Federation.removeApMessage.mockResolvedValue(undefined);
  Federation.insertApLike.mockResolvedValue(undefined);
  Federation.insertApAnnounce.mockResolvedValue(undefined);
  Notifications.insertInbox.mockResolvedValue(undefined);
  Dms.findOrCreateConversation.mockResolvedValue({ dmId: 'dm-1' });
  Dms.insertMessage.mockResolvedValue(undefined);
  Users.findByApUrl.mockResolvedValue(null);
  deliverApActivity.mockResolvedValue(undefined);
});

afterAll(() => {
  if (previousInstanceUrl === undefined) delete process.env.INSTANCE_URL;
  else process.env.INSTANCE_URL = previousInstanceUrl;
});

function note(extra: Record<string, unknown> = {}) {
  return {
    id: 'https://remote.test/notes/1', type: 'Note', content: 'hello',
    to: [PUBLIC], cc: [`${REMOTE}/followers`], ...extra,
  };
}
function createActivity(object: unknown, actor: unknown = REMOTE) {
  return { id: 'https://remote.test/activities/1', type: 'Create', actor, object } as never;
}

describe('actor identity accepts both AP shapes', () => {
  it('an object actor is recorded by its id, exactly like a string actor', async () => {
    await handleApFollow(ALICE, { id: 'https://remote.test/activities/f1', type: 'Follow', actor: { id: REMOTE } } as never);
    expect(Federation.insertApFollow).toHaveBeenCalledWith(
      expect.objectContaining({ actorUrl: REMOTE, targetUserId: 'local-1', accepted: true }));
    // The Accept is addressed back to the same resolved actor.
    expect(deliverApActivity).toHaveBeenCalledWith(REMOTE, expect.objectContaining({ type: 'Accept' }), ALICE);
  });

  it('an actor object with no id degrades to an empty identity rather than crashing', async () => {
    await handleApFollow(ALICE, { id: 'https://remote.test/activities/f2', type: 'Follow', actor: {} } as never);
    expect(Federation.insertApFollow).toHaveBeenCalledWith(expect.objectContaining({ actorUrl: '' }));
  });

  it('a repeated Follow does not create a second follow row but still re-sends Accept', async () => {
    Federation.findApFollowOne.mockResolvedValue({ _id: 'existing', actorUrl: REMOTE });
    await handleApFollow(ALICE, { id: 'https://remote.test/activities/f3', type: 'Follow', actor: REMOTE } as never);
    expect(Federation.insertApFollow).not.toHaveBeenCalled();
    // Re-sending Accept is what recovers a remote server that lost our reply.
    expect(deliverApActivity).toHaveBeenCalledTimes(1);
    expect(Notifications.insertInbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ap_follow', userId: 'local-1' }));
  });

  it('the Accept activity id is derived from the follow, so a retry is idempotent', async () => {
    const activity = { id: 'https://remote.test/activities/f4', type: 'Follow', actor: REMOTE } as never;
    await handleApFollow(ALICE, activity);
    await handleApFollow(ALICE, activity);
    const [firstAccept] = deliverApActivity.mock.calls[0] as any[];
    const ids = deliverApActivity.mock.calls.map(([, accept]: any[]) => accept.id);
    expect(firstAccept).toBe(REMOTE);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^https:\/\/bridge\.test\/api\/federation\/users\/alice\/activities\/accept_[0-9a-f]{64}$/);
  });
});

describe('Undo routes to the matching collection', () => {
  it('Undo Follow removes only the follow', async () => {
    await handleApUnfollow(ALICE, {
      id: 'u1', type: 'Undo', actor: REMOTE, object: { type: 'Follow', id: 'f1' },
    } as never);
    expect(Federation.removeApFollow).toHaveBeenCalledWith({ actorUrl: REMOTE, targetUserId: 'local-1' }, {});
    expect(Federation.removeApLike).not.toHaveBeenCalled();
    expect(Federation.removeApAnnounce).not.toHaveBeenCalled();
  });

  it('Undo Like removes only the like, addressed by the inner object url', async () => {
    await handleApUnfollow(ALICE, {
      id: 'u2', type: 'Undo', actor: REMOTE,
      object: { type: 'Like', object: 'https://bridge.test/notes/9' },
    } as never);
    expect(Federation.removeApLike).toHaveBeenCalledWith(
      { actorUrl: REMOTE, objectUrl: 'https://bridge.test/notes/9' }, {});
    expect(Federation.removeApFollow).not.toHaveBeenCalled();
  });

  it('Undo Announce removes only the announce and resolves an object-form target', async () => {
    await handleApUnfollow(ALICE, {
      id: 'u3', type: 'Undo', actor: REMOTE,
      object: { type: 'Announce', object: { id: 'https://bridge.test/notes/10' } },
    } as never);
    expect(Federation.removeApAnnounce).toHaveBeenCalledWith(
      { actorUrl: REMOTE, objectUrl: 'https://bridge.test/notes/10' }, {});
    expect(Federation.removeApLike).not.toHaveBeenCalled();
  });

  it('an Undo of an unknown inner type touches nothing', async () => {
    await handleApUnfollow(ALICE, {
      id: 'u4', type: 'Undo', actor: REMOTE, object: { type: 'Block' },
    } as never);
    expect(Federation.removeApFollow).not.toHaveBeenCalled();
    expect(Federation.removeApLike).not.toHaveBeenCalled();
    expect(Federation.removeApAnnounce).not.toHaveBeenCalled();
  });

  it('an Undo whose object is a bare url is ignored instead of guessed', async () => {
    await handleApUnfollow(ALICE, {
      id: 'u5', type: 'Undo', actor: REMOTE, object: 'https://remote.test/activities/f1',
    } as never);
    expect(Federation.removeApFollow).not.toHaveBeenCalled();
  });

  it('an Undo Follow with no local target still scopes the removal to the actor', async () => {
    await handleApUnfollow(null, {
      id: 'u6', type: 'Undo', actor: REMOTE, object: { type: 'Follow' },
    } as never);
    expect(Federation.removeApFollow).toHaveBeenCalledWith(
      { actorUrl: REMOTE, targetUserId: undefined }, {});
  });
});

describe('Accept and Reject update the outgoing follow', () => {
  it('Accept marks the outgoing follow accepted', async () => {
    await handleApAccept(ALICE, { id: 'a1', type: 'Accept', actor: { id: REMOTE } } as never);
    expect(Federation.updateApOutgoingFollow).toHaveBeenCalledWith(
      { fromUserId: 'local-1', targetActorUrl: REMOTE },
      { $set: { accepted: true, acceptedAt: expect.any(Number) } });
  });

  it('Reject removes the outgoing follow entirely', async () => {
    await handleApReject(ALICE, { id: 'r1', type: 'Reject', actor: REMOTE } as never);
    expect(Federation.removeApOutgoingFollow).toHaveBeenCalledWith(
      { fromUserId: 'local-1', targetActorUrl: REMOTE }, {});
  });

  it('a repository failure surfaces so the remote server can retry', async () => {
    Federation.updateApOutgoingFollow.mockRejectedValueOnce(new Error('follow store offline'));
    await expect(handleApAccept(ALICE, { id: 'a2', type: 'Accept', actor: REMOTE } as never))
      .rejects.toThrow('follow store offline');
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('Create — audience classification', () => {
  it('a note addressed only to one actor is stored as a direct message', async () => {
    await handleApCreate(ALICE, createActivity(note({ to: [`https://bridge.test/users/alice`], cc: [] })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'direct', targetUserId: 'local-1' }));
  });

  it('a single-string `to` is treated exactly like a one-element array', async () => {
    await handleApCreate(ALICE, createActivity(note({ to: 'https://bridge.test/users/alice', cc: undefined })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'direct' }));
  });

  it('a single-string public `cc` keeps the note public', async () => {
    await handleApCreate(ALICE, createActivity(note({ to: 'https://bridge.test/users/alice', cc: PUBLIC })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public' }));
  });

  it('a followers-addressed note is not a direct message', async () => {
    await handleApCreate(ALICE, createActivity(note({ to: [`${REMOTE}/followers`], cc: [] })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public' }));
  });

  it('a note with no addressing at all is not treated as a direct message', async () => {
    await handleApCreate(ALICE, createActivity(note({ to: undefined, cc: undefined })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public' }));
  });

  it('non-note object types are ignored', async () => {
    for (const type of ['Video', 'Event', undefined]) {
      await handleApCreate(ALICE, createActivity(note({ type })));
    }
    await handleApCreate(ALICE, createActivity('https://remote.test/notes/2'));
    expect(Federation.insertApMessage).not.toHaveBeenCalled();
  });
});

describe('Create — direct messages between two local users', () => {
  const direct = () => createActivity(note({ to: ['https://bridge.test/users/alice'], cc: [] }));

  it('writes a DM and a DM notification when the sender is local and consistent', async () => {
    Users.findByApUrl.mockResolvedValue({
      _id: 'local-2', username: 'bob', displayName: 'Bob', avatarColor: '#abcdef', apUrl: REMOTE,
    });
    await handleApCreate(ALICE, direct());

    expect(Dms.insertMessage).toHaveBeenCalledWith(expect.objectContaining({
      dmId: 'dm-1', userId: 'local-2', displayName: 'Bob', avatarColor: '#abcdef', content: 'hello',
    }));
    expect(Notifications.insertInbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dm', dmId: 'dm-1', userId: 'local-1' }));
    // A DM must never also land in the federated public timeline.
    expect(Federation.insertApMessage).not.toHaveBeenCalled();
  });

  it('falls back to the username and a default colour for a sparse local row', async () => {
    Users.findByApUrl.mockResolvedValue({ _id: 'local-2', username: 'bob' });
    await handleApCreate(ALICE, direct());
    expect(Dms.insertMessage).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'bob', avatarColor: '#2d9cdb',
    }));
  });

  it('falls back to a generic display name when the row has neither', async () => {
    Users.findByApUrl.mockResolvedValue({ _id: 'local-2' });
    await handleApCreate(ALICE, direct());
    expect(Dms.insertMessage).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'Federated user',
    }));
  });

  it('refuses to write a DM when the local row claims a different AP url', async () => {
    Users.findByApUrl.mockResolvedValue({
      _id: 'local-2', username: 'bob', apUrl: 'https://remote.test/users/someone-else',
    });
    await handleApCreate(ALICE, direct());

    expect(Dms.insertMessage).not.toHaveBeenCalled();
    expect(Federation.insertApMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.dm.actor_mismatch' }), expect.any(String));
  });

  it('a local row without an AP url is accepted (no claim to contradict)', async () => {
    Users.findByApUrl.mockResolvedValue({ _id: 'local-2', username: 'bob' });
    await handleApCreate(ALICE, direct());
    expect(Dms.insertMessage).toHaveBeenCalled();
  });

  it('a relayed remote-to-remote DM is journalled as a direct federated note', async () => {
    Users.findByApUrl.mockResolvedValue(null);
    await handleApCreate(ALICE, direct());
    expect(Dms.insertMessage).not.toHaveBeenCalled();
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'direct' }));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.dm.sender_not_local' }));
  });

  it('uses the note id for the DM row identity so redelivery is idempotent', async () => {
    Users.findByApUrl.mockResolvedValue({ _id: 'local-2', username: 'bob', apUrl: REMOTE });
    await handleApCreate(ALICE, direct());
    await handleApCreate(ALICE, direct());
    const [first, second] = Dms.insertMessage.mock.calls.map(([row]: any[]) => row._id);
    expect(first).toBe(second);
  });

  it('an id-less note falls back to the activity id for the DM row identity', async () => {
    Users.findByApUrl.mockResolvedValue({ _id: 'local-2', username: 'bob', apUrl: REMOTE });
    await handleApCreate(ALICE, createActivity(note({
      id: undefined, to: ['https://bridge.test/users/alice'], cc: [],
    })));
    expect(Dms.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.stringMatching(/^apdm_[0-9a-f]{64}$/) }));
  });
});

describe('Create — content fallbacks and ownership of an AP object id', () => {
  it('an Article without content uses its name', async () => {
    await handleApCreate(null, createActivity(note({
      type: 'Article', content: undefined, name: 'Headline only',
    })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Headline only' }));
  });

  it('a note with neither content nor name is stored as empty, not undefined', async () => {
    await handleApCreate(null, createActivity(note({ content: undefined, name: undefined })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '' }));
  });

  it('an explicit published timestamp is preserved', async () => {
    await handleApCreate(null, createActivity(note({ published: '2026-01-02T03:04:05.000Z' })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ published: Date.parse('2026-01-02T03:04:05.000Z') }));
  });

  it('a note with no id is still journalled without a duplicate lookup', async () => {
    await handleApCreate(null, createActivity(note({ id: undefined })));
    expect(Federation.findApMessageOne).not.toHaveBeenCalled();
    expect(Federation.insertApMessage).toHaveBeenCalledTimes(1);
  });

  it('a redelivery of the same note by the same actor is not inserted twice', async () => {
    Federation.findApMessageOne.mockResolvedValue({ apId: 'https://remote.test/notes/1', actorUrl: REMOTE });
    await handleApCreate(ALICE, createActivity(note({ tag: [{ type: 'Mention' }] })));
    expect(Federation.insertApMessage).not.toHaveBeenCalled();
    // The mention notification is still (idempotently) recorded.
    expect(Notifications.insertInbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ap_mention' }));
  });

  it('another actor cannot overwrite a note id that is already owned', async () => {
    Federation.findApMessageOne.mockResolvedValue({
      apId: 'https://remote.test/notes/1', actorUrl: 'https://elsewhere.test/users/mallory',
    });
    await handleApCreate(ALICE, createActivity(note({ tag: [{ type: 'Mention' }] })));

    expect(Federation.insertApMessage).not.toHaveBeenCalled();
    // The impostor must not be able to raise a mention notification either.
    expect(Notifications.insertInbox).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.note.ap_id_actor_conflict' }), expect.any(String));
  });

  it('a mention notification requires both a local target and a Mention tag', async () => {
    await handleApCreate(null, createActivity(note({ tag: [{ type: 'Mention' }] })));
    expect(Notifications.insertInbox).not.toHaveBeenCalled();

    await handleApCreate(ALICE, createActivity(note({ tag: [{ type: 'Hashtag' }] })));
    expect(Notifications.insertInbox).not.toHaveBeenCalled();

    await handleApCreate(ALICE, createActivity(note({ tag: [{ type: 'Mention' }] })));
    expect(Notifications.insertInbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ap_mention', noteId: 'https://remote.test/notes/1' }));
  });

  it('attachments are projected to a bounded shape', async () => {
    await handleApCreate(null, createActivity(note({
      attachment: [{ mediaType: 'image/png', url: 'https://remote.test/a.png', extra: 'dropped' }],
    })));
    expect(Federation.insertApMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{ type: 'image/png', url: 'https://remote.test/a.png' }],
    }));
  });
});

describe('Update and Delete are scoped to the owning actor', () => {
  it('Update rewrites only rows owned by the same actor', async () => {
    await handleApUpdate(null, {
      id: 'up1', type: 'Update', actor: REMOTE,
      object: { id: 'https://remote.test/notes/1', type: 'Note', content: 'edited' },
    } as never);
    expect(Federation.updateApMessage).toHaveBeenCalledWith(
      { apId: 'https://remote.test/notes/1', actorUrl: REMOTE },
      { $set: { content: 'edited', updatedAt: expect.any(Number) } });
  });

  it('an Update that clears the content stores an empty string', async () => {
    await handleApUpdate(null, {
      id: 'up2', type: 'Update', actor: REMOTE,
      object: { id: 'https://remote.test/notes/1', type: 'Note' },
    } as never);
    expect(Federation.updateApMessage).toHaveBeenCalledWith(
      expect.anything(), { $set: { content: '', updatedAt: expect.any(Number) } });
  });

  it('an Update without an object id is ignored', async () => {
    await handleApUpdate(null, { id: 'up3', type: 'Update', actor: REMOTE, object: { content: 'x' } } as never);
    await handleApUpdate(null, { id: 'up4', type: 'Update', actor: REMOTE, object: 'https://remote.test/notes/1' } as never);
    expect(Federation.updateApMessage).not.toHaveBeenCalled();
  });

  it('Delete resolves both object shapes and stays scoped to the actor', async () => {
    await handleApDelete(null, { id: 'd1', type: 'Delete', actor: REMOTE, object: 'https://remote.test/notes/1' } as never);
    await handleApDelete(null, { id: 'd2', type: 'Delete', actor: REMOTE, object: { id: 'https://remote.test/notes/2' } } as never);
    expect(Federation.removeApMessage).toHaveBeenNthCalledWith(1,
      { apId: 'https://remote.test/notes/1', actorUrl: REMOTE }, {});
    expect(Federation.removeApMessage).toHaveBeenNthCalledWith(2,
      { apId: 'https://remote.test/notes/2', actorUrl: REMOTE }, {});
  });

  it('a Delete with no resolvable object deletes nothing', async () => {
    await handleApDelete(null, { id: 'd3', type: 'Delete', actor: REMOTE, object: {} } as never);
    await handleApDelete(null, { id: 'd4', type: 'Delete', actor: REMOTE } as never);
    expect(Federation.removeApMessage).not.toHaveBeenCalled();
  });
});

describe('Like and Announce', () => {
  it('a like on a local note records the like and notifies the owner', async () => {
    await handleApLike(ALICE, {
      id: 'l1', type: 'Like', actor: REMOTE, object: 'https://bridge.test/notes/5',
    } as never);
    expect(Federation.insertApLike).toHaveBeenCalledWith(expect.objectContaining({
      actorUrl: REMOTE, objectUrl: 'https://bridge.test/notes/5', targetUserId: 'local-1',
    }));
    expect(Notifications.insertInbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ap_like', noteUrl: 'https://bridge.test/notes/5' }));
  });

  it('a like on a relayed remote note is recorded without notifying anyone', async () => {
    await handleApLike(null, {
      id: 'l2', type: 'Like', actor: REMOTE, object: { id: 'https://elsewhere.test/notes/5' },
    } as never);
    expect(Federation.insertApLike).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: null }));
    expect(Notifications.insertInbox).not.toHaveBeenCalled();
  });

  it('a like without an object is ignored', async () => {
    await handleApLike(ALICE, { id: 'l3', type: 'Like', actor: REMOTE, object: {} } as never);
    expect(Federation.insertApLike).not.toHaveBeenCalled();
  });

  it('an id-less like still gets a stable row id derived from the object', async () => {
    const activity = { type: 'Like', actor: REMOTE, object: 'https://bridge.test/notes/6' } as never;
    await handleApLike(ALICE, activity);
    await handleApLike(ALICE, activity);
    const ids = Federation.insertApLike.mock.calls.map(([row]: any[]) => row._id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^aplike_[0-9a-f]{64}$/);
  });

  it('an announce of a local note records the boost and notifies the owner', async () => {
    await handleApAnnounce(ALICE, {
      id: 'an1', type: 'Announce', actor: { id: REMOTE }, object: 'https://bridge.test/notes/7',
    } as never);
    expect(Federation.insertApAnnounce).toHaveBeenCalledWith(expect.objectContaining({
      actorUrl: REMOTE, objectUrl: 'https://bridge.test/notes/7', targetUserId: 'local-1',
    }));
    expect(Notifications.insertInbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ap_announce' }));
  });

  it('an announce with no local target records without a notification', async () => {
    await handleApAnnounce(null, {
      id: 'an2', type: 'Announce', actor: REMOTE, object: 'https://elsewhere.test/notes/7',
    } as never);
    expect(Federation.insertApAnnounce).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: null }));
    expect(Notifications.insertInbox).not.toHaveBeenCalled();
  });

  it('an announce without an object is ignored', async () => {
    await handleApAnnounce(ALICE, { id: 'an3', type: 'Announce', actor: REMOTE } as never);
    expect(Federation.insertApAnnounce).not.toHaveBeenCalled();
  });

  it('a notification failure surfaces so the inbox can answer 5xx and be retried', async () => {
    Notifications.insertInbox.mockRejectedValueOnce(new Error('inbox store offline'));
    await expect(handleApAnnounce(ALICE, {
      id: 'an4', type: 'Announce', actor: REMOTE, object: 'https://bridge.test/notes/8',
    } as never)).rejects.toThrow('inbox store offline');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.announce.handle_failed' }));
  });
});
