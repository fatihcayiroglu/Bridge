// server/tests/voice-authorization.test.ts
// FAZ G6 — SES / WEBRTC YETKİLENDİRMESİ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSURLAR
// ════════════════════════════════════════════════════════════════════════════
// 1. `voice:join` HİÇBİR yetki denetimi yapmıyordu. `channelId` ve `serverId`
//    doğrudan payload'dan alınıyordu. Sonuç: herhangi bir kimliği doğrulanmış
import type { SocketListener, SocketDouble, ServerDouble } from './helpers/socketDoubles';
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
//    kullanıcı, ÜYESİ OLMADIĞI sunucudaki bir ses kanalına katılabiliyor,
//    `voice:existing-peers` ile KATILIMCI LİSTESİNİ alıyor ve WebRTC
//    sinyalleşmesine başlayarak görüşmeye FİİLEN girebiliyordu.
//
// 2. `serverId` payload'dan geliyor ve `io.to('server:<id>')` yayın odası
//    olarak kullanılıyordu — kanalın gerçek sunucusuyla karşılaştırılmadan.
//
// 3. `webrtc:offer/answer/ice` payload'daki `targetSocketId`ye KOŞULSUZ
//    iletiliyordu: hiçbir odada olmayan biri, herhangi bir sokete SDP/ICE
//    enjekte edebiliyordu (çapraz-oda sinyalleşmesi).
//
// 4. `voice:state-update` / `voice:activity` odayı PAYLOAD'dan alıyordu; yani
//    içinde olmadığı bir odaya sahte mute/screenshare/konuşma durumu
//    yayılabiliyordu.
//
// 5. `voice:e2e-key` gönderenin odada olup olmadığını denetlemiyordu.
//
// NOT: insan sesi doğrulaması Faz J'ye aittir:
//   HUMAN_AUDIO_A_TO_B = HUMAN_PENDING
//   HUMAN_AUDIO_B_TO_A = HUMAN_PENDING
// Bu paket YALNIZCA yetkilendirme sınırını ölçer, ses aktarımını değil.

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../music', () => ({ readMusicQueue: jest.fn(async () => ({ current: null, queue: [] })) }));

// eslint-disable-next-line no-var
var vdb: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  vdb = createMockDb();
  return vdb;
});
jest.mock('../db/index', () => require('../db/loader'));

import { registerVoiceHandlers, voiceRooms } from '../socket/handlers/voice';

const SRV      = 'sv-auth';
const OTHER    = 'sv-other';
const VOICE_CH = 'vch-1';
const PRIV_CH  = 'vch-gizli';
const VIEW_CHANNELS = 1 << 0;

function makeSocket(id: string) {
  // `on()` sozlesmesi JENERIKTIR; sozluk `SocketListener` tutmali.
  const h: Record<string, SocketListener> = {};
  const rooms = new Set<string>([id]);
  const emitted: Array<{ event: string; data: unknown }> = [];
  return {
    id, rooms,
    // Urun bu alani `voice:join` sirasinda YAZAR; ikiz onu tasimali ki
    // "odaya girmeyen kullanici durum yayamaz" iddiasi olculebilsin.
    currentVoiceChannel: undefined as string | undefined,
    on(e: string, f: SocketListener) { h[e] = f; },
    emit(event: string, data: unknown) { emitted.push({ event, data }); },
    join(r: string) { rooms.add(r); },
    leave(r: string) { rooms.delete(r); },
    to() { return { emit() {} }; },
    _rooms: rooms, _emitted: emitted,
    async _trigger(e: string, d?: unknown) {
      const fn = h[e];
      if (typeof fn === 'function') await (fn as (payload?: unknown) => unknown)(d);
    },
    // `as never` KALDIRILDI: ikiz artik urun sozlesmesine (`SocketDouble`)
    // gercekten uyuyor ve uymadigi gun DERLEME kirilacak.
  } satisfies SocketDouble;
}

function makeIo() {
  const emitted: Array<{ event: string; data: unknown; _target: string }> = [];
  return {
    _emitted: emitted,
    to(target: string) { return { emit(event: string, data: unknown) { emitted.push({ event, data, _target: target }); } }; },
    // `as never` KALDIRILDI — ikiz `HandlerServer` sozlesmesine gercekten uyuyor.
  } satisfies ServerDouble;
}

beforeEach(async () => {
  for (const k of [...(voiceRooms as Map<string, unknown>).keys?.() ?? []]) (voiceRooms as Map<string, unknown>).delete(k);

  await vdb.servers.insert({ _id: SRV,   name: 'S', ownerId: 'o1', createdAt: 1 });
  await vdb.servers.insert({ _id: OTHER, name: 'O', ownerId: 'o2', createdAt: 1 });
  await vdb.channels.insert({ _id: VOICE_CH, serverId: SRV, name: 'sesli', type: 'voice', createdAt: 1 });
  await vdb.channels.insert({ _id: PRIV_CH,  serverId: SRV, name: 'gizli', type: 'voice', createdAt: 1 });
  await vdb.channelOverrides.insert({
    _id: 'ovr-v1', channelId: PRIV_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });
  // Yalnız `uye` gerçek üyedir.
  await vdb.members.insert({ userId: 'uye', serverId: SRV, roles: [], joinedAt: 1 });
});

const user = (id: string) => ({ _id: id, displayName: id, avatarColor: '#fff' } as never);

async function join(id: string, channelId: string, serverId = SRV) {
  const s = makeSocket(`s-${id}-${Math.random().toString(36).slice(2, 6)}`);
  registerVoiceHandlers(s, makeIo(), user(id));
  await (s as never as { _trigger(e: string, d: unknown): Promise<void> })._trigger('voice:join', { channelId, serverId });
  return s as never as { _rooms: Set<string>; _emitted: Array<{ event: string }>; currentVoiceChannel?: string };
}

// ════════════════════════════════════════════════════════════════════════════
describe('voice:join — yetkilendirme', () => {
  it('POZİTİF KONTROL: gerçek üye ses kanalına KATILIR', async () => {
    const s = await join('uye', VOICE_CH);

    expect(s._rooms.has(`voice:${VOICE_CH}`)).toBe(true);
    expect(s.currentVoiceChannel).toBe(VOICE_CH);
  });

  it('SUNUCU ÜYESİ OLMAYAN katılamaz', async () => {
    const s = await join('yabanci', VOICE_CH);

    expect(s._rooms.has(`voice:${VOICE_CH}`)).toBe(false);
  });

  it('katılamayan kişi KATILIMCI LİSTESİNİ almaz', async () => {
    // `voice:existing-peers` görüşmedekilerin kimliklerini ifşa eder.
    const s = await join('yabanci', VOICE_CH);

    expect(s._emitted.some(e => e.event === 'voice:existing-peers')).toBe(false);
  });

  it('GÖRÜNMEYEN ses kanalına üye bile olsa katılamaz', async () => {
    const s = await join('uye', PRIV_CH);

    expect(s._rooms.has(`voice:${PRIV_CH}`)).toBe(false);
  });

  it('payload\'daki serverId kanalın GERÇEK sunucusu değilse reddedilir', async () => {
    // Aksi hâlde saldırgan `voice:room-update` yayınını BAŞKA bir sunucunun
    // odasına yönlendirebilirdi.
    const s = await join('uye', VOICE_CH, OTHER);

    expect(s._rooms.has(`voice:${VOICE_CH}`)).toBe(false);
  });

  it('var olmayan kanala katılınamaz', async () => {
    const s = await join('uye', 'hic-yok');

    expect(s._rooms.has('voice:hic-yok')).toBe(false);
  });
});

describe('WebRTC sinyalleşme — oda bağlama', () => {
  async function twoInRoom() {
    const io = makeIo();
    const s1 = makeSocket('sig-1');
    const s2 = makeSocket('sig-2');
    registerVoiceHandlers(s1, io, user('uye'));
    registerVoiceHandlers(s2, io, user('uye'));
    // Ikizler artik TIPLI oldugu icin `as never as {...}` zincirlerine gerek
    // yok: `_trigger` ve `_emitted` dogrudan okunabiliyor.
    const t = (s: ReturnType<typeof makeSocket>, e: string, d: unknown) => s._trigger(e, d);
    await t(s1, 'voice:join', { channelId: VOICE_CH, serverId: SRV });
    await t(s2, 'voice:join', { channelId: VOICE_CH, serverId: SRV });
    io._emitted.length = 0;
    return { io, s1, s2, t };
  }

  it('POZİTİF KONTROL: aynı odadaki eşe teklif İLETİLİR', async () => {
    const { io, s1, s2, t } = await twoInRoom();

    await t(s1, 'webrtc:offer', { targetSocketId: s2.id, offer: { sdp: 'v=0' }, channelId: VOICE_CH });

    const fwd = requireEmitted(io._emitted, 'webrtc:offer');
    expect(fwd).toBeDefined();
    expect(fwd!._target).toBe(s2.id);
  });

  it('ODAYA KATILMAMIŞ kullanıcı teklif enjekte EDEMEZ', async () => {
    const { io, s2, t } = await twoInRoom();
    const dis = makeSocket('sig-disarisi');
    registerVoiceHandlers(dis, io as never, user('yabanci'));
    io._emitted.length = 0;

    await t(dis, 'webrtc:offer', { targetSocketId: s2.id, offer: { sdp: 'KOTU' }, channelId: VOICE_CH });

    expect(io._emitted.some(e => e.event === 'webrtc:offer')).toBe(false);
  });

  it('ODADA OLMAYAN hedefe sinyal gönderilemez', async () => {
    const { io, s1, t } = await twoInRoom();
    io._emitted.length = 0;

    await t(s1, 'webrtc:ice-candidate', { targetSocketId: 'baska-oda-soketi', candidate: { candidate: 'x' } });

    expect(io._emitted.some(e => e.event === 'webrtc:ice-candidate')).toBe(false);
  });
});

describe('voice durum yayını — oda kimliği soketten alınır', () => {
  it('odada OLMAYAN kullanıcı sahte durum yayamaz', async () => {
    const io = makeIo();
    const dis = makeSocket('durum-disarisi');
    registerVoiceHandlers(dis, io, user('yabanci'));
    // Handler `socket.to(...)` kullanır; odada olmadığı için hiç yayın olmamalı.
    await dis._trigger('voice:state-update', { channelId: VOICE_CH, muted: true, deafened: false, screensharing: true, video: false });
    await dis._trigger('voice:activity', { channelId: VOICE_CH, speaking: true });

    expect(dis.currentVoiceChannel).toBeUndefined();
  });
});


describe('private voice realtime broadcast privacy', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('never publishes peer/state metadata to the whole server room', () => {
    const p2p = read('socket', 'handlers', 'voice.ts');
    const sfuIndex = read('socket', 'handlers', 'mediasoup', 'index.ts');
    const sfuRooms = read('socket', 'handlers', 'mediasoup', 'rooms.ts');
    const rest = read('routes', 'channels', 'voice.ts');
    for (const source of [p2p, sfuIndex, sfuRooms, rest]) {
      expect(source).not.toMatch(/to\(`server:\$\{[^}]+\}`\)\.emit\('voice:(?:room-update|state-update)'/);
    }
    expect(p2p).toContain("[`voice:${channelId}`, `channel:${channelId}`]");
    expect(sfuIndex).toContain("[`voice:${channelId}`, `channel:${channelId}`]");
    expect(rest).toContain("[`voice:${channelId}`, `channel:${channelId}`]");
  });
});
