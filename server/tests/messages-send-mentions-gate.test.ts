// P7 B1 — exercise the real message handler's mention policy, not only
// mentionsWithinLimit() in isolation. A rejected send must not create a row,
// broadcast, or silently leave the client's pending ackId waiting.
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';
import { ABUSE_POLICY } from '../lib/abusePolicy';

const db = createMockDb();
jest.mock('../db/loader', () => db);
jest.mock('../lib/linkPreview', () => ({
  extractUrls: () => [],
  fetchLinkPreview: jest.fn(),
}));

import { sendChannelMessage } from '../socket/handlers/messages-send';

type Event = { name: string; data: Record<string, unknown>; to?: string };

function socketStub() {
  const events: Event[] = [];
  return {
    id: 'mention-sock',
    rooms: new Set<string>(),
    events,
    on() {},
    emit(name: string, data: Record<string, unknown>) { events.push({ name, data }); },
    to(room: string) { return { emit(name: string, data: Record<string, unknown>) { events.push({ name, data, to: room }); } }; },
    join() {},
    leave() {},
  };
}
function ioStub() {
  const events: Event[] = [];
  return {
    events,
    to(room: string) { return { emit(name: string, data: Record<string, unknown>) { events.push({ name, data, to: room }); } }; },
  };
}

let owner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;
let socket: ReturnType<typeof socketStub>;
let io: ReturnType<typeof ioStub>;

beforeEach(async () => {
  db._reset();
  owner = makeUser();
  member = makeUser();
  server = makeServer(owner._id);
  channel = makeChannel(server._id);
  await db.users.insert(owner);
  await db.users.insert(member);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  for (const user of [owner, member]) {
    await db.members.insert({ userId: user._id, serverId: server._id, joinedAt: Date.now(), roles: '[]' });
  }
  socket = socketStub();
  io = ioStub();
});

async function send(content: string, as = member) {
  // type omitted intentionally: the canonical normal message schema does not
  // accept a literal type:'text'. An ack is echoed on a policy refusal.
  await sendChannelMessage(
    { channelId: channel._id, serverId: server._id, content, ackId: 'mention-policy-ack' } as never,
    socket as never, io as never, as as never, new Map(),
  );
}
const uniquePings = (n: number) => Array.from({ length: n }, (_, i) => `<@mention_${i}>`).join(' ');
const rejects = () => socket.events.filter(e => e.name === 'error:message');
const broadcasts = () => io.events.filter(e => e.name === 'message:new');
const stored = () => db.messages.find({ channelId: channel._id });

describe('P7 B1: user-visible mass-mention refusal through the real send handler', () => {
  it('a normal member sending one more distinct mention than the limit is refused with the ackId and no side effects', async () => {
    await send(uniquePings(ABUSE_POLICY.mentions.perMessage + 1));
    expect(rejects()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ code: 'TOO_MANY_MENTIONS', ackId: 'mention-policy-ack' }),
      }),
    ]);
    expect(socket.events.filter(e => e.name === 'message:ack')).toEqual([]);
    expect(broadcasts()).toEqual([]);
    expect(await stored()).toHaveLength(0);
  });

  it('repeating the same person is not counted as 21 distinct people', async () => {
    await send(Array(ABUSE_POLICY.mentions.perMessage + 1).fill('<@same_person>').join(' '));
    expect(rejects()).toEqual([]);
    expect(broadcasts()).toHaveLength(1);
    expect(await stored()).toHaveLength(1);
  });

  it('exactly the number of distinct mentions allowed by policy is delivered', async () => {
    await send(uniquePings(ABUSE_POLICY.mentions.perMessage));
    expect(rejects()).toEqual([]);
    expect(broadcasts()).toHaveLength(1);
    expect(await stored()).toHaveLength(1);
  });

  it('the server owner is exempt by authorization, not by the caller-supplied payload', async () => {
    await send(uniquePings(ABUSE_POLICY.mentions.perMessage + 1), owner);
    expect(rejects()).toEqual([]);
    expect(broadcasts()).toHaveLength(1);
    expect(await stored()).toHaveLength(1);
  });
});
