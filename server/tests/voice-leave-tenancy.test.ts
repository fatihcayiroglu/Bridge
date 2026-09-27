// server/tests/voice-leave-tenancy.test.ts
//
// SES ODASINDAN AYRILMA — ÇAPRAZ KİRACI (CROSS-TENANT) SIZINTISI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK
// ════════════════════════════════════════════════════════════════════════════
// `voice:join` yetkiyi HER ŞEYDEN ÖNCE denetler (`mayJoinVoice`): kanalın
// GERÇEK sunucusu ile istemcinin bildirdiği `serverId` eşleşmeli, kullanıcı o
// sunucunun üyesi olmalı ve CONNECT iznine sahip olmalıdır. O denetimin
// kendi yorumu, neden eklendiğini de söylüyor: saldırgan aksi hâlde yayını
// BAŞKA bir sunucunun odasına yönlendirebiliyordu.
//
// `voice:leave` ise AYNI korumadan yoksundu. Handler istemcinin gönderdiği
// `channelId` ve `serverId` değerlerine KOŞULSUZ güveniyordu:
//
//     socket.on('voice:leave', payload =>
//       leaveVoice(socket, payload.channelId, payload.serverId, io));
//
// ── SÖMÜRÜ ────────────────────────────────────────────────────────────────
// Saldırgan, ÜYESİ OLMADIĞI bir sunucudaki ses kanalının kimliğini ve KENDİ
// sunucusunun kimliğini gönderir:
//
//     voice:leave { channelId: <kurban kanalı>, serverId: <saldırgan sunucusu> }
//
// `leaveVoice` kurban kanalının GERÇEK katılımcı listesini yükler, kendi
// soketini çıkarmaya çalışır (listede yoktur, yani liste AYNEN kalır) ve
// sonucu saldırganın KENDİ sunucu odasına yayınlar:
//
//     io.to('server:<saldırgan>').emit('voice:room-update',
//       { channelId: <kurban>, peers: <GERÇEK KATILIMCILAR> })
//
// Saldırgan o odanın üyesi olduğu için yayını ALIR: başka bir sunucudaki ses
// kanalının userId / displayName / avatarColor listesi sızar.
//
// İKİNCİL ETKİLER: rastgele `channelId` ile durum YAZIMI tetiklenebiliyor
// (`_saveRoom`) ve rastgele bir sunucu odasına sahte `voice:room-update`
// enjekte edilebiliyordu.
//
// ── DÜZELTME ──────────────────────────────────────────────────────────────
// Ayrılma, istemcinin İDDİASINA değil soketin KENDİ kayıtlı durumuna
// dayanır. Bir kullanıcı yalnızca GERÇEKTEN içinde olduğu odadan ayrılabilir.
// Bağlantı kopması yolu (`infra.ts`) zaten bu güvenilir durumu kullanıyordu.

process.env.NODE_ENV = 'test';

import { registerVoiceHandlers, __setVoiceRoomForTest } from '../socket/handlers/voice';

interface Emitted { event: string; data: unknown; _target: string }

function makeIo() {
  const emitted: Emitted[] = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return { emit(event: string, data: unknown) { emitted.push({ event, data, _target: target }); } };
    },
  };
}

function makeSocket(id: string) {
  const handlers = new Map<string, (p: unknown) => unknown>();
  const emitted: Emitted[] = [];
  return {
    id,
    userId: 'attacker-user',
    currentVoiceChannel: null as string | null,
    currentVoiceServer: null as string | null,
    rooms: new Set<string>(),
    _emitted: emitted,
    on(ev: string, fn: (p: unknown) => unknown) { handlers.set(ev, fn); },
    emit(ev: string, data: unknown) { emitted.push({ event: ev, data, _target: 'self' }); },
    join(r: string) { this.rooms.add(r); },
    leave(r: string) { this.rooms.delete(r); },
    to(target: string) {
      return { emit(event: string, data: unknown) { emitted.push({ event, data, _target: target }); } };
    },
    async _trigger(ev: string, payload: unknown) { return handlers.get(ev)?.(payload); },
  };
}

const VICTIM_CHANNEL = 'victim-voice-channel';
const VICTIM_PEERS = [
  { socketId: 'victim-sock-1', userId: 'victim-user-1', displayName: 'Kurban Bir', avatarColor: '#111' },
  { socketId: 'victim-sock-2', userId: 'victim-user-2', displayName: 'Kurban Iki', avatarColor: '#222' },
];

describe('voice:leave — çapraz kiracı sızıntısı', () => {
  beforeEach(async () => {
    await __setVoiceRoomForTest(VICTIM_CHANNEL, VICTIM_PEERS);
  });

  afterEach(async () => {
    await __setVoiceRoomForTest(VICTIM_CHANNEL, []);
  });

  it('SALDIRI: üyesi olunmayan kanalın katılımcıları SIZDIRILMAZ', async () => {
    // KANITLAR   : istemcinin bildirdiği channelId/serverId artık kullanılmıyor.
    // KANITLAMAZ : yetki matrisinin tamamını (o ayrı testlerde).
    const socket = makeSocket('attacker-sock');
    const io = makeIo();
    registerVoiceHandlers(socket as never, io as never, { _id: 'attacker-user' } as never);

    // Saldirgan hicbir odada DEGIL — currentVoiceChannel null.
    await socket._trigger('voice:leave', {
      channelId: VICTIM_CHANNEL,
      serverId:  'attacker-own-server',
    });

    // Saldirganin kendi sunucu odasina HICBIR yayin gitmemeli.
    const toAttackerServer = io._emitted.filter(e => e._target === 'server:attacker-own-server');
    expect(toAttackerServer).toEqual([]);

    // Ve hicbir yayinda kurban kimlikleri gecmemeli.
    const leaked = JSON.stringify(io._emitted) + JSON.stringify(socket._emitted);
    expect(leaked).not.toContain('victim-user-1');
    expect(leaked).not.toContain('Kurban Bir');
  });

  it('SALDIRI: kurban odasının durumu DEĞİŞTİRİLEMEZ', async () => {
    // `_saveRoom` rastgele channelId ile cagrilabiliyordu; kurban odasinin
    // katilimci listesi bozulmamalidir.
    const socket = makeSocket('attacker-sock-2');
    const io = makeIo();
    registerVoiceHandlers(socket as never, io as never, { _id: 'attacker-user' } as never);

    await socket._trigger('voice:leave', { channelId: VICTIM_CHANNEL, serverId: 'x' });

    const { __getVoiceRoomForTest } = require('../socket/handlers/voice');
    const after = await __getVoiceRoomForTest(VICTIM_CHANNEL);
    expect(after).toHaveLength(2);
    expect(after.map((p: { userId: string }) => p.userId)).toEqual(['victim-user-1', 'victim-user-2']);
  });

  it('POZİTİF KONTROL: GERÇEKTEN içinde olunan odadan ayrılma ÇALIŞIR', async () => {
    // Duzeltme mesru islevi kirmamali. Bu test olmadan "hicbir sey yapma"
    // gibi asiri bir yama da gecerdi.
    const socket = makeSocket('member-sock');
    socket.userId = 'member-user';
    const io = makeIo();
    registerVoiceHandlers(socket as never, io as never, { _id: 'member-user' } as never);

    // Sunucu tarafi durum: kullanici GERCEKTEN bu odada.
    await __setVoiceRoomForTest('own-channel', [
      { socketId: 'member-sock', userId: 'member-user', displayName: 'Uye', avatarColor: '#333' },
    ]);
    socket.currentVoiceChannel = 'own-channel';
    socket.currentVoiceServer  = 'own-server';

    await socket._trigger('voice:leave', { channelId: 'own-channel', serverId: 'own-server' });

    const updates = io._emitted.filter(e => e.event === 'voice:room-update');
    expect(updates).toHaveLength(1);
    expect(updates[0]._target).toEqual(['voice:own-channel', 'channel:own-channel']);
    expect(socket.currentVoiceChannel).toBeNull();
  });

  it('NEGATİF KONTROL: sahte serverId yayını YENİDEN YÖNLENDİREMEZ', async () => {
    // Kullanici gercekten bir odada olsa BILE, bildirdigi serverId yayin
    // hedefini belirlememelidir.
    const socket = makeSocket('member-sock-2');
    socket.userId = 'member-user-2';
    const io = makeIo();
    registerVoiceHandlers(socket as never, io as never, { _id: 'member-user-2' } as never);

    await __setVoiceRoomForTest('own-channel-2', [
      { socketId: 'member-sock-2', userId: 'member-user-2', displayName: 'Uye2', avatarColor: '#444' },
    ]);
    socket.currentVoiceChannel = 'own-channel-2';
    socket.currentVoiceServer  = 'real-server';

    // Istemci BASKA bir sunucu iddia ediyor.
    await socket._trigger('voice:leave', { channelId: 'own-channel-2', serverId: 'spoofed-server' });

    const targets = io._emitted.map(e => e._target);
    expect(targets).not.toContain('server:spoofed-server');
    expect(targets).not.toContain('server:real-server');
    expect(targets).toContainEqual(['voice:own-channel-2', 'channel:own-channel-2']);
  });
});
