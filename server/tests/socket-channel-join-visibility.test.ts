// server/tests/socket-channel-join-visibility.test.ts
// FAZ G5 — SOCKET `channel:join` KANAL GÖRÜNÜRLÜĞÜ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR — CANLI, SÜREKLİ İÇERİK SIZINTISI
// ════════════════════════════════════════════════════════════════════════════
// `channel:join` yalnızca SUNUCU ÜYELİĞİNİ denetliyor, ardından soketi
// `channel:<id>` odasına katıyordu.
//
// O odaya şunlar yayınlanır:
//   · `message:new`       (messages-send.ts:212)
//   · `message:edited`    (messages-edit.ts:87)
//   · `message:deleted`   (messages-edit.ts:67)
//   · `message:reaction`  (messages-edit.ts:108)
//
// Yani sunucunun sıradan bir üyesi, GÖREMEDİĞİ özel bir kanalın odasına
// katılıp o kanaldaki TÜM canlı mesaj trafiğini sürekli olarak alabiliyordu.
//
// Bu, HTTP tarafında Faz D/F/G'de kapatılan kusur sınıfının GERÇEK ZAMANLI
// eşdeğeridir ve daha ağırdır: tek seferlik bir okuma değil, kesintisiz akış.
//
// POZİTİF KONTROL KURALI: "katılamamalı" iddiasının yanında, görünür kanala
// katılımın GERÇEKTEN çalıştığını gösteren kontrol vardır.

'use strict';
process.env.NODE_ENV = 'test';

import type { SocketListener } from './helpers/socketDoubles';
import { createMockDb } from './helpers/mockDb';
import type { MockDb } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
jest.mock('../db/index', () => require('../db/loader'));

import { setupMemberships } from '../socket/handlers/members';

const VIEW_CHANNELS = 1 << 0;

const MEMBER = 'uye-S';
const SRV    = 'srv-SJ';
const PUBLIC_CH  = 'sjch-acik';
const PRIVATE_CH = 'sjch-gizli';

function makeSocket(id: string) {
  // Sozluk `SocketListener` tutar: `on()` sozlesmesi JENERIKTIR ve sabit
  // imzali bir dinleyici ona atanamaz.
  const handlers: Record<string, SocketListener> = {};
  const rooms = new Set<string>([id]);
  return {
    id, rooms,
    on(ev: string, fn: SocketListener) { handlers[ev] = fn; },
    emit() {},
    join(r: string) { rooms.add(r); },
    leave(r: string) { rooms.delete(r); },
    to() { return { emit() {} }; },
    _rooms: rooms,
    async _trigger(ev: string, d?: unknown) {
      const fn = handlers[ev];
      if (typeof fn === 'function') await (fn as (payload?: unknown) => unknown)(d);
    },
  };
}
const makeIo = () => ({ to() { return { emit() {} }; } });

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);

  await db.users.insert({ _id: MEMBER, username: MEMBER, displayName: 'Uye' });
  await db.servers.insert({ _id: SRV, name: 'SJ', ownerId: 'sahip-SJ', createdAt: 1 });
  await db.members.insert({ userId: MEMBER, serverId: SRV, roles: [], joinedAt: 1 });

  await db.channels.insert({ _id: PUBLIC_CH,  serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await db.channels.insert({ _id: PRIVATE_CH, serverId: SRV, name: 'gizli', type: 'text', createdAt: 1 });

  await db.channelOverrides.insert({
    _id: 'ovr-sj-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });
});

async function joinAs(userId: string, channelId: string) {
  const socket = makeSocket(`s-${userId}`);
  // Ham koleksiyonda `findById` YOKTUR (o depo katmanindadir); handler'a
  // yalnizca `_id` gereklidir.
  const user = { _id: userId, username: userId, displayName: userId };
  await setupMemberships(socket as never, user as never);
  await socket._trigger('channel:join', channelId);
  return socket;
}

// ════════════════════════════════════════════════════════════════════════════
describe('socket channel:join — kanal görünürlüğü', () => {
  it('POZİTİF KONTROL: GÖRÜNÜR kanalın odasına katılınır', async () => {
    // Bu kontrol olmadan aşağıdaki red testi, handler tümüyle bozulsa
    // (hiçbir odaya katmasa) da geçerdi.
    const socket = await joinAs(MEMBER, PUBLIC_CH);

    expect(socket._rooms.has(`channel:${PUBLIC_CH}`)).toBe(true);
  });

  it('GÖRÜNMEYEN kanalın odasına KATILINAMAZ', async () => {
    const socket = await joinAs(MEMBER, PRIVATE_CH);

    expect(socket._rooms.has(`channel:${PRIVATE_CH}`)).toBe(false);
  });

  it('reddedilen katılım mevcut GÖRÜNÜR odayı bozmaz', async () => {
    // Handler, katılmadan önce diğer `channel:` odalarından çıkar. Görünürlük
    // denetimi bu çıkıştan ÖNCE gelmeli; aksi hâlde başarısız bir katılım
    // denemesi kullanıcıyı mevcut kanalından KOPARIRDI (sessiz DoS).
    const socket = await joinAs(MEMBER, PUBLIC_CH);
    expect(socket._rooms.has(`channel:${PUBLIC_CH}`)).toBe(true);

    await socket._trigger('channel:join', PRIVATE_CH);

    expect(socket._rooms.has(`channel:${PRIVATE_CH}`)).toBe(false);
    expect(socket._rooms.has(`channel:${PUBLIC_CH}`)).toBe(true);
  });

  it('SUNUCU ÜYESİ OLMAYAN hiçbir odaya katılamaz', async () => {
    await db.users.insert({ _id: 'yabanci', username: 'yabanci', displayName: 'Y' });

    const socket = await joinAs('yabanci', PUBLIC_CH);

    expect(socket._rooms.has(`channel:${PUBLIC_CH}`)).toBe(false);
  });

  it('var olmayan kanal odasına katılınmaz', async () => {
    const socket = await joinAs(MEMBER, 'hic-olmayan-kanal');

    expect(socket._rooms.has('channel:hic-olmayan-kanal')).toBe(false);
  });

  it('string olmayan payload sessizce reddedilir', async () => {
    const socket = makeSocket('s-bad');
    const user = { _id: MEMBER, username: MEMBER, displayName: MEMBER };
    await setupMemberships(socket as never, user as never);

    await socket._trigger('channel:join', { evil: true });

    expect([...socket._rooms].some(r => r.startsWith('channel:'))).toBe(false);
  });
});
