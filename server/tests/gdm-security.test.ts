// server/tests/gdm-security.test.ts
// Faz 10.6 — Group DM socket YETKİLENDİRME negatif kapsamı.
//
// Mevcut `gdm-socket.test.ts` çoğunlukla mutlu yolu ve birkaç üyelik vakasını
// (gdm:send, gdm:call:start, gdm:call:join) kapsıyordu. Bu dosya eksik kalan
// negatif vakaları kilitler:
//
//   - üye OLMAYAN `gdm:join` ile özel odaya giremez
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
//   - A grubundaki üyelik B grubuna erişim vermez
//   - var olmayan / bozuk grup kimliği güvenle reddedilir
//   - istemci payload'ındaki kimlik YETKİ KAYNAĞI değildir
//   - üye olmayan özel gruba "yazıyor" bildirimi ENJEKTE EDEMEZ
//
// Gerçek `registerGroupDmHandlers` test edilir; yalnız db katmanı mock'lanır.

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';
import type { MockDb } from './helpers/mockDb';

let db: MockDb;

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

import { registerGroupDmHandlers } from '../socket/handlers/dm';
import type { SocketUserMap } from '../socket/handlers/dm';
import type { SocketDouble, ServerDouble, SocketListener } from './helpers/socketDoubles';

// ══════════════════════════════════════════════════════════════════════════
// IKIZLER URUN SOZLESMESINE BAGLI — `as never` YOK
// ══════════════════════════════════════════════════════════════════════════
// Her cagri `registerGroupDmHandlers(socket as never, makeIo() as never,
// member as never)` seklindeydi. `as never` `as any`den DE kotudur: hicbir
// sey dogrulamaz ama dogruluyormus gibi durur. Ustelik uc ARGUMANLA
// cagriliyordu; urun DORT bekliyor (`_socketUsers`). Yani imza degisikligi
// testlerde HIC yakalanmiyordu.
function makeSocket(id: string) {
  const handlers: Record<string, SocketListener> = {};
  const emitted: Array<{ ev: string; data: unknown; _room?: string }> = [];
  const rooms = new Set([id]);
  return {
    id, rooms,
    on(event: string, fn: SocketListener) { handlers[event] = fn; },
    emit(ev: string, data: unknown) { emitted.push({ ev, data }); },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room: string) { return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _room: room }); } }; },
    _emitted: emitted,
    _rooms: rooms,
    async _trigger(event: string, data?: unknown) {
      const fn = handlers[event];
      if (fn) await (fn as (payload?: unknown) => unknown)(data);
    },
    _has(event: string) { return Boolean(handlers[event]); },
  } satisfies SocketDouble;
}

function makeIo() {
  const emitted: Array<{ ev: string; data: unknown; _target?: string }> = [];
  return {
    _emitted: emitted,
    to(target: string) { return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); } }; },
    // `in()` SENKRONDUR — `socket.io` kapsami dogrudan dondurur. Ikiz onu
    // `async` yaziyordu; yani urun `io.in(room).fetchSockets()` derken ikiz
    // bir Promise dondururdu ve test URUNUN yolunu olcmezdi.
    in() { return { async fetchSockets() { return []; } }; },
  } satisfies ServerDouble;
}

/** Urunun DORDUNCU parametresi: socketId -> kullanici haritasi. */
function makeSocketUsers(): SocketUserMap {
  return new Map();
}

/** İki ayrı grup kurar: A'da `member`, B'de `stranger` üyedir. */
async function setup() {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);

  const member   = makeUser({ displayName: 'Uye',    avatarColor: '#111' });
  const stranger = makeUser({ displayName: 'Yabanci', avatarColor: '#222' });
  await db.users.insert(member);
  await db.users.insert(stranger);

  const groupA = { _id: 'grp-A', name: 'A', createdBy: member._id, createdAt: 1, lastMessageAt: 1 };
  const groupB = { _id: 'grp-B', name: 'B', createdBy: stranger._id, createdAt: 1, lastMessageAt: 1 };
  await db.groupDmConversations.insert(groupA);
  await db.groupDmConversations.insert(groupB);
  await db.groupDmMembers.insert({ _id: 'mA', groupId: 'grp-A', userId: member._id,   joinedAt: 1 });
  await db.groupDmMembers.insert({ _id: 'mB', groupId: 'grp-B', userId: stranger._id, joinedAt: 1 });

  return { member, stranger, groupA, groupB };
}

beforeEach(() => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
});

describe('gdm:join — üyelik yetkilendirmesi', () => {
  it('ÜYE kendi grubunun odasına katılabilir', async () => {
    const { member } = await setup();
    const socket = makeSocket('s1');
    registerGroupDmHandlers(socket, makeIo(), member, makeSocketUsers());

    await socket._trigger('gdm:join', 'grp-A');

    expect(socket._rooms.has('gdm:grp-A')).toBe(true);
  });

  it('ÜYE OLMAYAN özel gruba KATILAMAZ', async () => {
    const { stranger } = await setup();
    const socket = makeSocket('s2');
    registerGroupDmHandlers(socket, makeIo(), stranger, makeSocketUsers());

    await socket._trigger('gdm:join', 'grp-A');   // stranger yalnız B üyesi

    expect(socket._rooms.has('gdm:grp-A')).toBe(false);
  });

  it('A grubundaki üyelik B grubuna erişim VERMEZ', async () => {
    const { member } = await setup();
    const socket = makeSocket('s3');
    registerGroupDmHandlers(socket, makeIo(), member, makeSocketUsers());

    await socket._trigger('gdm:join', 'grp-A');
    await socket._trigger('gdm:join', 'grp-B');

    expect(socket._rooms.has('gdm:grp-A')).toBe(true);
    expect(socket._rooms.has('gdm:grp-B')).toBe(false);
  });

  it('var olmayan grup güvenle reddedilir (çökme yok)', async () => {
    const { member } = await setup();
    const socket = makeSocket('s4');
    registerGroupDmHandlers(socket, makeIo(), member, makeSocketUsers());

    await expect(socket._trigger('gdm:join', 'grp-yok')).resolves.not.toThrow();

    expect(socket._rooms.has('gdm:grp-yok')).toBe(false);
  });

  it('bozuk/aşırı uzun grup kimliği reddedilir', async () => {
    const { member } = await setup();
    const socket = makeSocket('s5');
    registerGroupDmHandlers(socket, makeIo(), member, makeSocketUsers());

    for (const bad of [null, undefined, 42, {}, [], 'x'.repeat(200)]) {
      await socket._trigger('gdm:join', bad);
    }

    // Not: kayıt anında kullanıcı KENDİ gruplarının odalarına otomatik katılır
    // (joinGroupRooms). Asıl güvenlik değişmezi: bozuk girdiler kullanıcının
    // ÜYE OLMADIĞI bir odayı ASLA açamaz ve bozuk kimlikten oda üretilemez.
    const rooms = [...socket._rooms].map(String);
    expect(rooms).not.toContain('gdm:grp-B');          // üye olmadığı grup
    expect(rooms).not.toContain('gdm:grp-yok');
    expect(rooms.some(r => r.includes('x'.repeat(50)))).toBe(false);  // aşırı uzun kimlik
    expect(rooms.some(r => /gdm:(null|undefined|42|\[object)/.test(r))).toBe(false);
  });
});

describe('gdm:typing — üyelik yetkilendirmesi', () => {
  it('ÜYE kendi grubuna yazıyor bildirimi gönderebilir', async () => {
    const { member } = await setup();
    const socket = makeSocket('s6');
    registerGroupDmHandlers(socket, makeIo(), member, makeSocketUsers());

    await socket._trigger('gdm:typing', { groupId: 'grp-A' });

    expect(socket._emitted.filter(e => e.ev === 'gdm:typing' && e._room === 'gdm:grp-A')).toHaveLength(1);
  });

  it('ÜYE OLMAYAN özel gruba yazıyor bildirimi ENJEKTE EDEMEZ', async () => {
    const { stranger } = await setup();
    const socket = makeSocket('s7');
    registerGroupDmHandlers(socket, makeIo(), stranger, makeSocketUsers());

    // stranger yalnız B üyesi; A'ya sahte varlık sinyali göndermeye çalışıyor.
    await socket._trigger('gdm:typing', { groupId: 'grp-A' });

    expect(socket._emitted.filter(e => e._room === 'gdm:grp-A')).toHaveLength(0);
  });

  it('var olmayan gruba yazıyor bildirimi yayınlanmaz', async () => {
    const { member } = await setup();
    const socket = makeSocket('s8');
    registerGroupDmHandlers(socket, makeIo(), member, makeSocketUsers());

    await socket._trigger('gdm:typing', { groupId: 'grp-yok' });

    expect(socket._emitted.filter(e => e._room === 'gdm:grp-yok')).toHaveLength(0);
  });
});

describe('istemci kimliği yetki kaynağı değildir', () => {
  it('payload\'daki userId gönderen kimliğini DEĞİŞTİREMEZ', async () => {
    const { member, stranger } = await setup();
    const socket = makeSocket('s9');
    registerGroupDmHandlers(socket, makeIo(), member, makeSocketUsers());

    await socket._trigger('gdm:typing', { groupId: 'grp-A', userId: stranger._id });

    const evt = requireEmitted(socket._emitted, 'gdm:typing');
    // Sunucu DAİMA kimliği doğrulanmış kullanıcıyı yayınlar.
    expect((evt?.data as { userId: string }).userId).toBe(member._id);
  });

  it('üye olmayan payload hilesiyle gönderim yapamaz', async () => {
    const { member, stranger } = await setup();
    const socket = makeSocket('s10');
    registerGroupDmHandlers(socket, makeIo(), stranger, makeSocketUsers());

    await socket._trigger('gdm:send', { groupId: 'grp-A', content: 'sizinti', userId: member._id });

    const stored = await db.groupDmMessages.find({ groupId: 'grp-A' });
    expect(stored).toHaveLength(0);
  });
});
