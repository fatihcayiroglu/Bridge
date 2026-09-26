// e2e/tests/dm-call.spec.ts — 1:1 DM araması, GERÇEK sunucu el sıkışması.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU PAKET VAR
// ════════════════════════════════════════════════════════════════════════════
// İstemci paneli sunucununkinden FARKLI bir protokol konuşuyordu; arama ÇALAR
// ama asla BAĞLANMAZDI. Birim testleri gövde alan adlarını kilitler, ama
// yalnızca gerçek sunucu iki soket arasında el sıkışmanın GERÇEKTEN
// tamamlandığını gösterebilir.
//
// Burada WebRTC KURULMAZ (tarayıcı medyası gerekmez). Doğrulanan şey
// SİNYALLEŞMEDİR: ring → accept → ready(rol) → offer → answer → ice → end,
// artı reddetme ve yetkilendirme sınırları.
//
// KANONİK SÖZLEŞME (server/socket/handlers/dm.ts):
//   →  dm:call:start   { toUserId, type }
//   ←  dm:call:incoming{ callId, type, callerId, callerDisplayName }
//   ←  dm:call:outgoing{ callId, type, toUserId }
//   →  dm:call:accept  { callId }
//   ←  dm:call:accepted{ callId, calleeDisplayName }   (arayana)
//   ←  dm:call:ready   { callId, role, type }          (İKİ TARAFA)
//   →  dm:call:offer   { callId, targetUserId, offer }
//   →  dm:call:answer  { callId, targetUserId, answer }
//   →  dm:call:ice     { callId, targetUserId, candidate }
//   →  dm:call:decline { callId }  ←  dm:call:declined
//   →  dm:call:end     { callId }  ←  dm:call:ended

import { test, expect } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets } from '../helpers/socket';
import type { Socket } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

type Incoming = { callId: string; type: string; callerId: string; callerDisplayName: string };
type Ready    = { callId: string; role: 'caller' | 'callee'; type: string };

test.describe('DM Araması — sinyalleşme sözleşmesi', () => {
  let tokens: ReturnType<typeof getTokens>;
  let aliceId = '';
  let bobId = '';
  let alice: Socket;
  let bob: Socket;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const me = async (token: string) => {
      const res = await request.get(`${BASE_URL}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status()).toBe(200);
      const u = await res.json();
      return u._id || u.id;
    };
    aliceId = await me(tokens.alice);
    bobId = await me(tokens.bob);
  });

  test.beforeEach(async () => {
    alice = await openSocket(tokens.alice);
    bob = await openSocket(tokens.bob);
  });

  test.afterEach(() => {
    closeSockets(alice, bob);
  });

  // ── Tam akış ─────────────────────────────────────────────────────────────

  test('uçtan uca — ring, kabul, rol atama, teklif/yanıt, kapatma', async () => {
    const incoming = waitForEvent<Incoming>(bob, 'dm:call:incoming');
    const outgoing = waitForEvent<{ callId: string }>(alice, 'dm:call:outgoing');

    alice.emit('dm:call:start', { toUserId: bobId, type: 'voice' });

    const ring = await incoming;
    const out = await outgoing;

    // `callId` SUNUCUDAN gelir ve iki taraf için AYNIDIR.
    expect(ring.callId).toBe(out.callId);
    expect(ring.callerId).toBe(aliceId);
    expect(ring.callerDisplayName, 'arayan İSİMSİZ görünmemeli').toBeTruthy();
    expect(ring.type).toBe('voice');

    // Kabul → arayan `accepted`, İKİ TARAF `ready` alır.
    const accepted    = waitForEvent<{ callId: string; calleeDisplayName: string }>(alice, 'dm:call:accepted');
    const readyCaller = waitForEvent<Ready>(alice, 'dm:call:ready');
    const readyCallee = waitForEvent<Ready>(bob, 'dm:call:ready');

    bob.emit('dm:call:accept', { callId: ring.callId });

    const acc = await accepted;
    expect(acc.calleeDisplayName).toBeTruthy();

    // ROL ATAMASI: teklifi yalnızca `caller` üretir. İki taraf da `caller`
    // olsaydı çift teklif çarpışması olurdu.
    expect((await readyCaller).role).toBe('caller');
    expect((await readyCallee).role).toBe('callee');

    // Teklif → yanıt → ICE, hepsi `targetUserId` ile.
    const offerAtBob = waitForEvent<{ callId: string; offer: unknown }>(bob, 'dm:call:offer');
    alice.emit('dm:call:offer', { callId: ring.callId, targetUserId: bobId, offer: { type: 'offer', sdp: 'v=0' } });
    expect((await offerAtBob).offer).toBeTruthy();

    const answerAtAlice = waitForEvent<{ callId: string; answer: unknown }>(alice, 'dm:call:answer');
    bob.emit('dm:call:answer', { callId: ring.callId, targetUserId: aliceId, answer: { type: 'answer', sdp: 'v=0' } });
    expect((await answerAtAlice).answer).toBeTruthy();

    const iceAtBob = waitForEvent<{ candidate: unknown }>(bob, 'dm:call:ice');
    alice.emit('dm:call:ice', { callId: ring.callId, targetUserId: bobId, candidate: { candidate: 'x' } });
    expect((await iceAtBob).candidate).toBeTruthy();

    // Kapatma her iki tarafa da bildirilir.
    const endedAtBob   = waitForEvent<{ callId: string }>(bob, 'dm:call:ended');
    const endedAtAlice = waitForEvent<{ callId: string }>(alice, 'dm:call:ended');
    alice.emit('dm:call:end', { callId: ring.callId });
    expect((await endedAtBob).callId).toBe(ring.callId);
    expect((await endedAtAlice).callId).toBe(ring.callId);
  });

  test('reddetme — arayana `declined` ulaşır', async () => {
    const incoming = waitForEvent<Incoming>(bob, 'dm:call:incoming');
    alice.emit('dm:call:start', { toUserId: bobId, type: 'voice' });
    const ring = await incoming;

    const declined = waitForEvent<{ callId: string }>(alice, 'dm:call:declined');
    bob.emit('dm:call:decline', { callId: ring.callId });
    expect((await declined).callId).toBe(ring.callId);
  });

  test('görüntülü arama tipi korunur', async () => {
    const incoming = waitForEvent<Incoming>(bob, 'dm:call:incoming');
    alice.emit('dm:call:start', { toUserId: bobId, type: 'video' });
    expect((await incoming).type).toBe('video');
  });

  // ── Sözleşme ihlalleri sessizce düşer ────────────────────────────────────

  test('YANLIŞ alan adı (`targetUserId`) aramayı BAŞLATMAZ', async () => {
    // Eski istemcinin gönderdiği gövde buydu; şema `toUserId` ister.
    let rang = false;
    bob.once('dm:call:incoming', () => { rang = true; });
    alice.emit('dm:call:start', { targetUserId: bobId, type: 'voice' });
    await new Promise((r) => setTimeout(r, 700));
    expect(rang, 'şemayı ihlal eden gövde kabul edilmemeli').toBe(false);
  });

  test('`targetUserId` OLMADAN sinyal iletilmez', async () => {
    // `signalPeer()` onsuz null döner — eski istemcinin yanıt yolu tam
    // olarak burada sessizce ölüyordu.
    const incoming = waitForEvent<Incoming>(bob, 'dm:call:incoming');
    alice.emit('dm:call:start', { toUserId: bobId, type: 'voice' });
    const ring = await incoming;
    bob.emit('dm:call:accept', { callId: ring.callId });
    await waitForEvent<Ready>(alice, 'dm:call:ready');

    let delivered = false;
    bob.once('dm:call:offer', () => { delivered = true; });
    alice.emit('dm:call:offer', { callId: ring.callId, offer: { sdp: 'v=0' } });
    await new Promise((r) => setTimeout(r, 700));
    expect(delivered).toBe(false);

    alice.emit('dm:call:end', { callId: ring.callId });
  });

  // ── Yetkilendirme ────────────────────────────────────────────────────────

  test('GÜVENLİK: üçüncü taraf başkasının görüşmesini sonlandıramaz', async () => {
    // `callParticipant()` çağıranın iki uçtan biri olmasını şart koşar.
    const carol = await openSocket(tokens.carol);
    try {
      const incoming = waitForEvent<Incoming>(bob, 'dm:call:incoming');
      alice.emit('dm:call:start', { toUserId: bobId, type: 'voice' });
      const ring = await incoming;

      let ended = false;
      alice.once('dm:call:ended', () => { ended = true; });
      carol.emit('dm:call:end', { callId: ring.callId });
      await new Promise((r) => setTimeout(r, 700));
      expect(ended, 'katılımcı olmayan görüşmeyi kapatamamalı').toBe(false);

      alice.emit('dm:call:end', { callId: ring.callId });
    } finally {
      closeSockets(carol);
    }
  });

  test('GÜVENLİK: üçüncü taraf görüşmeye sinyal ENJEKTE edemez', async () => {
    // Denetim olmadan herhangi biri istenmeyen WebRTC teklifi gönderebilirdi.
    const carol = await openSocket(tokens.carol);
    try {
      const incoming = waitForEvent<Incoming>(bob, 'dm:call:incoming');
      alice.emit('dm:call:start', { toUserId: bobId, type: 'voice' });
      const ring = await incoming;

      let injected = false;
      bob.once('dm:call:offer', () => { injected = true; });
      carol.emit('dm:call:offer', { callId: ring.callId, targetUserId: bobId, offer: { sdp: 'evil' } });
      await new Promise((r) => setTimeout(r, 700));
      expect(injected, 'katılımcı olmayan sinyal enjekte edememeli').toBe(false);

      alice.emit('dm:call:end', { callId: ring.callId });
    } finally {
      closeSockets(carol);
    }
  });

  test('GÜVENLİK: bilinmeyen callId ile sinyal düşer', async () => {
    let delivered = false;
    bob.once('dm:call:offer', () => { delivered = true; });
    alice.emit('dm:call:offer', { callId: 'yok-boyle-bir-cagri', targetUserId: bobId, offer: { sdp: 'x' } });
    await new Promise((r) => setTimeout(r, 700));
    expect(delivered).toBe(false);
  });
});
