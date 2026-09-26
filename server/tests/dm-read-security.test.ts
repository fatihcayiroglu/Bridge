// server/tests/dm-read-security.test.ts
// Faz 10.3.9 — `dm:read` yetkilendirme sözleşmesi (negatif kapsam).
//
// GERÇEK handler (socket/handlers/dm-read.ts) test edilir; yalnız veritabanı
// katmanı mock'lanır. Kimlik DAİMA `socket.user._id`'den gelir — istemcinin
// gönderdiği payload kimliği asla yetki kaynağı değildir.
//
// Şema (middleware/validate.ts:568): dmRead = { dmId: string, 1..128 }
import type { ServerDouble } from './helpers/socketDoubles';
// Payload'da userId ALANI YOKTUR; testler bunu uydurmaz, forge denemesi
// fazladan alan olarak gönderilip yok sayıldığı doğrulanır.

process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

import { registerDmReadHandlers, markRead } from '../socket/handlers/dm-read';
import db from '../db/loader';
import { requireDoc } from './helpers/mockDb';

const DM_AB = 'ua_ub';
const DM_CD = 'uc_ud';

type Handler = (payload: unknown) => void;

/** socket.io benzeri test çifti — yalnız gerçek handler'ın kullandığı yüzey. */
function makeSocket(userId?: string) {
  const handlers: Record<string, Handler> = {};
  return {
    user: userId ? { _id: userId } : undefined,
    on(event: string, fn: Handler) { handlers[event] = fn; },
    emit() { /* handler bunu kullanmıyor */ },
    _fire(event: string, payload: unknown) { handlers[event]?.(payload); },
    _has(event: string) { return Boolean(handlers[event]); },
  };
}

const io = {
  sockets: { sockets: new Map() },
  to() { return { emit() { /* alıcı yok */ } }; },
} satisfies ServerDouble as never;

async function readAtOf(dmId: string, userId: string): Promise<number | undefined> {
  const conv = await db.dmConversations.findOne({ _id: dmId });
  return (conv?.readAt as Record<string, number> | undefined)?.[userId];
}

/** Handler async çalışıyor; mikro görev kuyruğunun boşalmasını bekle. */
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(async () => {
  for (const c of await db.dmConversations.find({})) await db.dmConversations.remove({ _id: c._id });
  await db.dmConversations.insert({ _id: DM_AB, participants: ['ua', 'ub'], createdAt: 1, lastMessageAt: 1 });
  await db.dmConversations.insert({ _id: DM_CD, participants: ['uc', 'ud'], createdAt: 1, lastMessageAt: 1 });
});

describe('dm:read — pozitif sözleşme', () => {
  it('katılımcı kendi okundu imlecini yazabilir', async () => {
    const s = makeSocket('ua');
    registerDmReadHandlers(s as never, io);

    s._fire('dm:read', { dmId: DM_AB });
    await settle();

    expect(await readAtOf(DM_AB, 'ua')).toBeGreaterThan(0);
  });

  it('yalnız çağıran kullanıcının imleci yazılır, karşı tarafınki yazılmaz', async () => {
    const s = makeSocket('ua');
    registerDmReadHandlers(s as never, io);

    s._fire('dm:read', { dmId: DM_AB });
    await settle();

    expect(await readAtOf(DM_AB, 'ub')).toBeUndefined();
  });
});

describe('dm:read — negatif yetkilendirme', () => {
  it('kimliksiz socket handler bile KAYDETMEZ', () => {
    const s = makeSocket(undefined);

    registerDmReadHandlers(s as never, io);

    expect(s._has('dm:read')).toBe(false);
  });

  it('katılımcı OLMAYAN kullanıcı başkasının konuşmasını okundu işaretleyemez', async () => {
    const s = makeSocket('ua');           // ua, DM_CD'nin katılımcısı değil
    registerDmReadHandlers(s as never, io);

    s._fire('dm:read', { dmId: DM_CD });
    await settle();

    expect(await readAtOf(DM_CD, 'ua')).toBeUndefined();
    expect(await readAtOf(DM_CD, 'uc')).toBeUndefined();
  });

  it('payload\'a sızdırılan userId YETKİ KAYNAĞI DEĞİLDİR', async () => {
    const s = makeSocket('ua');
    registerDmReadHandlers(s as never, io);

    // Saldırgan başka kullanıcıyı okundu yapmaya çalışıyor.
    s._fire('dm:read', { dmId: DM_AB, userId: 'ub' });
    await settle();

    // Yalnız kimliği doğrulanmış kullanıcı (ua) etkilenir.
    expect(await readAtOf(DM_AB, 'ua')).toBeGreaterThan(0);
    expect(await readAtOf(DM_AB, 'ub')).toBeUndefined();
  });

  it('var olmayan konuşma güvenle yok sayılır (çökme yok)', async () => {
    const s = makeSocket('ua');
    registerDmReadHandlers(s as never, io);

    expect(() => s._fire('dm:read', { dmId: 'yok-boyle-bir-konusma' })).not.toThrow();
    await settle();

    expect(await db.dmConversations.findOne({ _id: 'yok-boyle-bir-konusma' })).toBeFalsy();
  });

  it('bozuk payload şema tarafından reddedilir — durum değişmez', async () => {
    const s = makeSocket('ua');
    registerDmReadHandlers(s as never, io);

    for (const bad of [{}, { dmId: '' }, { dmId: 123 }, { dmId: null }, null, undefined, 'metin']) {
      expect(() => s._fire('dm:read', bad)).not.toThrow();
    }
    await settle();

    expect(await readAtOf(DM_AB, 'ua')).toBeUndefined();
  });

  it('konuşma A okundu işaretlemesi konuşma B\'yi etkilemez', async () => {
    const s = makeSocket('uc');
    registerDmReadHandlers(s as never, io);

    s._fire('dm:read', { dmId: DM_CD });
    await settle();

    expect(await readAtOf(DM_CD, 'uc')).toBeGreaterThan(0);
    expect(await readAtOf(DM_AB, 'uc')).toBeUndefined();
  });

  it('markRead doğrudan çağrılsa da katılımcı kontrolü uygulanır', async () => {
    await markRead(io, DM_CD, 'ua');   // ua katılımcı değil

    expect(await readAtOf(DM_CD, 'ua')).toBeUndefined();
  });
});
