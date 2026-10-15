// server/tests/messages-send-stickers.test.ts
//
// A sticker message carries a snapshot of one item from one of the server's
// sticker packs: id, pack, name, image URL and size. The URL comes from the
// database and every client renders it as an image, so the send handler only
// accepts what the server itself would have stored. None of the sticker branch
// of `sendChannelMessage` had run in a test. Here, through the real handler,
// payload schema, permission resolution and sticker repository (on the mock DB):
//   - a sticker from one of this server's packs is posted with its snapshot;
//   - a missing pack or sticker id, a pack of ANOTHER server, or an item of
//     another pack is refused as INVALID_STICKER_REFERENCE and nothing is
//     stored or broadcast;
//   - a stored URL that is not a plain file under /uploads/stickers/ (another
//     host, a traversal, another upload folder, a script URL, a dot file) is
//     refused the same way;
//   - an implausible stored size falls back to 160 px; the name is capped;
//   - a non-member is refused for membership BEFORE any sticker lookup, so
//     sticker ids cannot be probed across servers.
// Only link previews (network) are replaced.
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../lib/linkPreview', () => ({ extractUrls: () => [], fetchLinkPreview: jest.fn() }));

import { sendChannelMessage } from '../socket/handlers/messages-send';
import { ServerAssets } from '../db/repositories';

type Emitted = { ev: string; data: Record<string, unknown>; to?: string };

function makeSocket() {
  const emitted: Emitted[] = [];
  return {
    id: 'sock-sticker',
    rooms: new Set<string>(),
    emitted,
    on() {},
    emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data }); },
    to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; },
    join() {}, leave() {},
  };
}
function makeIo() {
  const emitted: Emitted[] = [];
  return { emitted, to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; } };
}

let owner: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let otherServer: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;
let socket: ReturnType<typeof makeSocket>;
let io: ReturnType<typeof makeIo>;

async function addPack(serverId: string, packId: string) {
  await mockDb.stickerPacks.insert({ _id: packId, serverId, name: `pack ${packId}`, description: '', authorId: owner._id, createdAt: Date.now() });
}
async function addItem(packId: string, itemId: string, fields: Record<string, unknown> = {}) {
  await mockDb.stickerPackItems.insert({
    _id: itemId, packId, name: `sticker ${itemId}`, url: `/uploads/stickers/${itemId}.png`,
    tags: [], width: 128, height: 96, position: 0, createdAt: Date.now(), ...fields,
  });
}
async function sendSticker(stickerPackId: unknown, stickerId: unknown, as = owner) {
  await sendChannelMessage(
    { channelId: channel._id, serverId: server._id, type: 'sticker', stickerPackId, stickerId, ackId: 'ack-sticker' } as never,
    socket as never, io as never, as as never, new Map(),
  );
}
const refusals = () => socket.emitted.filter(e => e.ev === 'error:message').map(e => e.data.code);
const broadcasts = () => io.emitted.filter(e => e.ev === 'message:new');
const storedStickers = async () => (await mockDb.messages.find({ channelId: channel._id })).filter((m: Record<string, unknown>) => m.type === 'sticker');

beforeEach(async () => {
  mockDb._reset();
  owner = makeUser();
  server = makeServer(owner._id);
  otherServer = makeServer(owner._id);
  channel = makeChannel(server._id);
  for (const doc of [owner]) await mockDb.users.insert(doc);
  for (const doc of [server, otherServer]) await mockDb.servers.insert(doc);
  await mockDb.channels.insert(channel);
  await mockDb.members.insert({ userId: owner._id, serverId: server._id, joinedAt: Date.now(), roles: '[]' });
  await addPack(server._id, 'pack-here');
  await addPack(otherServer._id, 'pack-elsewhere');
  socket = makeSocket();
  io = makeIo();
});

describe('sticker messages: only this server\'s stickers, only safe stored URLs', () => {
  it('a sticker from one of this server\'s packs is posted with its snapshot', async () => {
    await addItem('pack-here', 'wave');
    await sendSticker('pack-here', 'wave');

    expect(refusals()).toEqual([]);
    const snapshot = { id: 'wave', packId: 'pack-here', name: 'sticker wave', url: '/uploads/stickers/wave.png', width: 128, height: 96 };
    expect(broadcasts()).toHaveLength(1);
    expect(broadcasts()[0]).toMatchObject({ to: `channel:${channel._id}`, data: { type: 'sticker', sticker: snapshot } });
    expect(await storedStickers()).toEqual([expect.objectContaining({ sticker: snapshot })]);
  });

  it.each([
    ['no pack id', undefined, 'wave'],
    ['no sticker id', 'pack-here', undefined],
    ['an empty sticker id', 'pack-here', ''],
  ])('%s is refused and nothing is stored', async (_label, packId, stickerId) => {
    await addItem('pack-here', 'wave');
    await sendSticker(packId, stickerId);
    expect(refusals()).toEqual(['INVALID_STICKER_REFERENCE']);
    expect(socket.emitted.find(e => e.ev === 'error:message')!.data).toMatchObject({ ackId: 'ack-sticker' });
    expect(broadcasts()).toEqual([]);
    expect(await storedStickers()).toEqual([]);
  });

  it('a pack that belongs to another server is refused', async () => {
    await addItem('pack-elsewhere', 'foreign');
    await sendSticker('pack-elsewhere', 'foreign');
    expect(refusals()).toEqual(['INVALID_STICKER_REFERENCE']);
    expect(await storedStickers()).toEqual([]);
  });

  it('an item of another pack is refused even when sent with this server\'s pack id', async () => {
    await addItem('pack-elsewhere', 'foreign');
    await sendSticker('pack-here', 'foreign');
    expect(refusals()).toEqual(['INVALID_STICKER_REFERENCE']);
    expect(await storedStickers()).toEqual([]);
  });

  it.each([
    ['another host', 'https://evil.example/uploads/stickers/x.png'],
    ['a protocol-relative host', '//evil.example/uploads/stickers/x.png'],
    ['a traversal out of the sticker folder', '/uploads/stickers/../avatars/x.png'],
    ['a traversal inside the file name', '/uploads/stickers/a..png'],
    ['another upload folder', '/uploads/avatars/x.png'],
    ['a nested path', '/uploads/stickers/sub/x.png'],
    ['a script URL', 'javascript:alert(1)'],
    ['a dot file', '/uploads/stickers/.hidden.png'],
    ['a query string', '/uploads/stickers/x.png?redirect=https://evil.example'],
    ['a non-string URL', 42],
  ])('a stored URL pointing at %s is refused', async (_label, url) => {
    await addItem('pack-here', 'bad', { url });
    await sendSticker('pack-here', 'bad');
    expect(refusals()).toEqual(['INVALID_STICKER_REFERENCE']);
    expect(broadcasts()).toEqual([]);
    expect(await storedStickers()).toEqual([]);
  });

  it.each([
    ['zero', 0, 160],
    ['negative', -5, 160],
    ['larger than 4096', 5000, 160],
    ['fractional', 12.5, 160],
    ['not a number', 'wide', 160],
    ['exactly 4096', 4096, 4096],
    ['one', 1, 1],
  ])('a stored size that is %s (%p) becomes %p px', async (_label, stored, expected) => {
    await addItem('pack-here', 'sized', { width: stored, height: stored });
    await sendSticker('pack-here', 'sized');
    expect(refusals()).toEqual([]);
    expect(broadcasts()[0]!.data.sticker).toMatchObject({ width: expected, height: expected });
  });

  it('the sticker name is capped at 100 characters', async () => {
    await addItem('pack-here', 'long', { name: 'n'.repeat(300) });
    await sendSticker('pack-here', 'long');
    expect((broadcasts()[0]!.data.sticker as { name: string }).name).toBe('n'.repeat(100));
  });

  it('a non-member is refused for membership before any sticker lookup (no cross-server probing)', async () => {
    const outsider = makeUser();
    await mockDb.users.insert(outsider);
    await addItem('pack-here', 'wave');
    const lookup = jest.spyOn(ServerAssets, 'findStickerPackByIdAndServer');
    try {
      await sendSticker('pack-here', 'wave', outsider);
      await sendSticker('pack-here', 'does-not-exist', outsider);
      expect(refusals()).toEqual(['NOT_A_MEMBER', 'NOT_A_MEMBER']);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
    expect(await storedStickers()).toEqual([]);
  });
});
