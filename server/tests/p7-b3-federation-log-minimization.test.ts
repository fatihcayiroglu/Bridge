// server/tests/p7-b3-federation-log-minimization.test.ts
//
// P7 B3: "logs/telemetry must not become a shadow social graph". The
// ActivityPub inbox handlers used to log, at info level on every delivery,
// who follows whom (local username + remote actor URL), who liked or boosted
// what (actor + object URL) and every federated DM (note id + DM id). Each
// line is an edge of the follow / like / DM graph. They now log the event and
// the remote host only. This drives every handler through the path that logs
// and checks every logged value, not just the fields that used to leak.

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
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../db/repositories', () => ({ Federation, Notifications, Dms, Users }));
jest.mock('../routes/federation/delivery', () => ({ deliverApActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: log }));

import {
  handleApFollow, handleApUnfollow, handleApAccept, handleApReject,
  handleApCreate, handleApLike, handleApAnnounce,
} from '../routes/federation/inbox-handlers';

const LOCAL = { _id: 'local-user-id', username: 'alice-local' } as never;
const SENDER = { _id: 'sender-user-id', username: 'carol-sender' };
const ACTOR = 'https://remote.test/users/bob-remote';
const SENDER_AP = 'https://Remote.Test/api/federation/users/carol-sender';
const NOTE = 'https://remote.test/notes/secret-note-17';
const DM_ID = 'dm-conversation-42';

// Anything here appearing in any logged value is a graph edge leaking.
const IDENTIFYING = ['alice-local', 'local-user-id', 'bob-remote', 'carol-sender', 'sender-user-id',
  'secret-note-17', DM_ID, '/users/', '/notes/'];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INSTANCE_URL = 'https://bridge.test';
  for (const fn of Object.values(Federation)) fn.mockResolvedValue(undefined);
  Federation.findApFollowOne.mockResolvedValue(null);
  Federation.findApMessageOne.mockResolvedValue(null);
  Notifications.insertInbox.mockResolvedValue(undefined);
  Dms.findOrCreateConversation.mockResolvedValue({ dmId: DM_ID });
  Dms.insertMessage.mockResolvedValue(undefined);
  Users.findByApUrl.mockResolvedValue(null);
});

const logged = () => [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls, ...log.debug.mock.calls];
const eventLine = (event: string) => log.info.mock.calls.map(c => c[0]).find(f => f && f.event === event);

const cases: Array<[string, () => Promise<void>]> = [
  ['federation.follow.received', () => handleApFollow(LOCAL, { id: 'https://remote.test/act/f1', type: 'Follow', actor: ACTOR } as never)],
  ['federation.follow.undo', () => handleApUnfollow(LOCAL, { id: 'https://remote.test/act/u1', type: 'Undo', actor: ACTOR, object: { type: 'Follow', actor: ACTOR } } as never)],
  ['federation.follow.accepted', () => handleApAccept(LOCAL, { id: 'https://remote.test/act/a1', type: 'Accept', actor: ACTOR } as never)],
  ['federation.follow.rejected', () => handleApReject(LOCAL, { id: 'https://remote.test/act/r1', type: 'Reject', actor: ACTOR } as never)],
  ['federation.like.received', () => handleApLike(LOCAL, { id: 'https://remote.test/act/l1', type: 'Like', actor: ACTOR, object: NOTE } as never)],
  ['federation.announce.received', () => handleApAnnounce(LOCAL, { id: 'https://remote.test/act/b1', type: 'Announce', actor: ACTOR, object: NOTE } as never)],
  ['federation.dm.received', async () => {
    Users.findByApUrl.mockResolvedValue(SENDER);
    await handleApCreate(LOCAL, {
      id: 'https://remote.test/act/c1', type: 'Create', actor: SENDER_AP,
      object: { id: NOTE, type: 'Note', content: 'hi', to: [SENDER_AP], cc: [], published: new Date().toISOString() },
    } as never);
    // The DM really was stored (the logging path ran, not an early return).
    expect(Dms.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ dmId: DM_ID }));
  }],
];

describe('P7 B3: federation inbox logs carry no social-graph edge', () => {
  it.each(cases)('%s logs the event and the remote host only', async (event, run) => {
    await run();
    expect(eventLine(event)).toEqual({ remoteHost: 'remote.test', event });
    const text = JSON.stringify(logged());
    for (const value of IDENTIFYING) expect({ event, leaked: text.includes(value) ? value : null }).toEqual({ event, leaked: null });
  });

  it('an actor that is not a URL logs an empty host, not the raw value', async () => {
    await handleApFollow(LOCAL, { id: 'x', type: 'Follow', actor: 'acct:bob-remote' } as never);
    expect(Federation.insertApFollow).toHaveBeenCalled();
    expect(eventLine('federation.follow.received')).toEqual({ remoteHost: '', event: 'federation.follow.received' });
    expect(JSON.stringify(logged())).not.toContain('bob-remote');
  });
});
