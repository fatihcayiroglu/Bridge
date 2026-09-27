// e2e/tests/send-error-semantics.spec.ts
//
// GÖNDERİM HATA ANLAMBİLİMİ — REDDETME, ZAMAN AŞIMI DEĞİL
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `socket/handlers/messages-send.ts` geçersiz yükleri SESSİZCE düşürüyordu:
//
//     if (!valid) return;
//     if (type !== 'file' && type !== 'e2ee' && !content?.trim()) return;
//     if (content && content.length > 2000) return;
//
// Hiçbir `error:message` yayılmıyordu. Hemen ALTINDAKİ dosya kontrolü ise
// `INVALID_FILE_REFERENCE` kodunu `ackId`/`tmpId` ile DÜZGÜN yayıyordu —
// yani sözleşme dosyada doğru, doğrulamada eksikti.
//
// İSTEMCİ SONUCU: ACK gelmediği için `MessageInputPanel` 10 sn sonra kendi
// zaman aşımını yazar: "Sunucu onayı zaman aşımına uğradı." Kullanıcı
// REDDEDİLDİĞİNİ değil, SUNUCUNUN CEVAP VERMEDİĞİNİ sanır. İkisi farklı
// sorunlardır ve farklı davranış gerektirir (yeniden dene vs. düzelt).
//
// ── ŞİDDET DEĞERLENDİRMESİ (dürüst) ───────────────────────────────────────
// Normal yazma alanından ULAŞILAMAZ: istemci `maxlength=2000` uygular, boş
// gönderimi engeller ve uzun içerik için kendi hatasını gösterir. Yani bu
// bir P0 değildir. Ama sözleşme boşluğu gerçektir: bot/entegrasyon, eski
// istemci, yeniden bağlanma yarışları ve gelecekteki istemci hataları bu
// yola girer ve YANLIŞ teşhis alır.

import { test, expect } from '@playwright/test';
import { createTestServer, createTestChannel, getTokens } from '../helpers/bridge';
import { openSocket, closeSockets, joinChannelConfirmed } from '../helpers/socket';
import type { Socket } from 'socket.io-client';

let token = '';
let serverId = '';
let channelId = '';

test.beforeAll(async ({ request }) => {
  // Global setup'ta ZATEN saglanan kimlik kullanilir. Yeni hesap ACILMAZ:
  // sunucunun IP basina saatlik hesap kotasi (MAX_REG_PER_HOUR, varsayilan 3)
  // gercek bir kotuye kullanim korumasidir ve testler onu tuketmemelidir.
  token = getTokens().bob;
  const srv = await createTestServer(request, token, `ErrSem ${Date.now()}`);
  serverId = String((srv as { _id?: string })?._id ?? '');
  const ch = await createTestChannel(request, token, serverId, `errsem-${Date.now().toString(36)}`, 'text');
  channelId = String((ch as { _id?: string })?._id ?? '');
  expect(serverId, 'test sunucusu kurulamadı').toBeTruthy();
  expect(channelId, 'test kanalı kurulamadı').toBeTruthy();
});

/**
 * Gönderir ve İLK sonucu döndürür: ack mi, hata mı, yoksa SESSİZLİK mi.
 *
 * Sessizlik ayrı bir sonuçtur — asıl kusur buydu.
 */
async function sendAndAwait(
  sock: Socket, payload: Record<string, unknown>, waitMs = 5_000,
): Promise<{ kind: 'ack' | 'error' | 'silence'; data?: Record<string, unknown> }> {
  // ACK/HATA yalnizca BU gonderime aitse kabul edilir. Kanal katilimi bir
  // "probe" mesaji gonderir; onun geciken ACK'i filtrelenmezse yanlis sonuc
  // okunur (olculdu: gecersiz gonderim 'ack' gibi gorundu).
  const want = String(payload.ackId ?? '');
  return new Promise((resolve) => {
    const done = (r: { kind: 'ack' | 'error' | 'silence'; data?: Record<string, unknown> }) => {
      clearTimeout(timer);
      sock.off('message:ack', onAck);
      sock.off('error:message', onErr);
      resolve(r);
    };
    const timer = setTimeout(() => done({ kind: 'silence' }), waitMs);
    function onAck(d: Record<string, unknown>) {
      if (want && String(d?.ackId ?? '') !== want) return;      // baska gonderim
      done({ kind: 'ack', data: d });
    }
    function onErr(d: Record<string, unknown>) {
      const got = String(d?.ackId ?? '');
      if (want && got && got !== want) return;                  // baska gonderim
      done({ kind: 'error', data: d });
    }
    sock.on('message:ack', onAck);
    sock.on('error:message', onErr);
    sock.emit('message:send', payload);
  });
}

test.describe('gönderim hata anlambilimi', () => {
  test('GEÇERLİ gönderim değişmeden ACK alır', async () => {
    // Regresyon koruması: düzeltme mutlu yolu BOZMAMALI.
    const sock = await openSocket(token);
    try {
      await joinChannelConfirmed(sock, channelId, serverId);
      const ackId = `ok-${Date.now()}`;
      const res = await sendAndAwait(sock, {
        channelId, serverId, content: 'gecerli mesaj', ackId,
      }, 12_000);
      expect(res.kind, 'geçerli gönderim ACK almadı').toBe('ack');
      expect(res.data?.ackId).toBe(ackId);
      expect(String(res.data?.messageId ?? '')).not.toBe('');
    } finally { closeSockets(sock); }
  });

  test('AŞIRI UZUN içerik REDDEDİLİR — sessizce düşmez', async () => {
    // KANITLAR : sunucu açık bir reddetme yayar; istemci sahte "zaman aşımı"
    //            yerine gerçek sebebi gösterebilir.
    const sock = await openSocket(token);
    try {
      await joinChannelConfirmed(sock, channelId, serverId);
      const ackId = `long-${Date.now()}`;
      const res = await sendAndAwait(sock, {
        channelId, serverId, content: 'x'.repeat(2_500), ackId,
      });
      expect(res.kind, 'aşırı uzun içerik SESSİZCE düşürüldü').toBe('error');
      expect(res.data?.event).toBe('message:send');
      expect(String(res.data?.code ?? '')).toBe('MESSAGE_TOO_LONG');
      // ackId GERİ DÖNMELİ: istemci hangi gönderimin reddedildiğini bilmeli.
      expect(res.data?.ackId).toBe(ackId);
    } finally { closeSockets(sock); }
  });

  test('BOŞ içerik REDDEDİLİR — sessizce düşmez', async () => {
    const sock = await openSocket(token);
    try {
      await joinChannelConfirmed(sock, channelId, serverId);
      const ackId = `empty-${Date.now()}`;
      const res = await sendAndAwait(sock, {
        channelId, serverId, content: '   ', ackId,
      });
      expect(res.kind, 'boş içerik SESSİZCE düşürüldü').toBe('error');
      expect(String(res.data?.code ?? '')).toBe('EMPTY_MESSAGE');
      expect(res.data?.ackId).toBe(ackId);
    } finally { closeSockets(sock); }
  });

  test('ŞEMAYA UYMAYAN yük REDDEDİLİR — sessizce düşmez', async () => {
    const sock = await openSocket(token);
    try {
      await joinChannelConfirmed(sock, channelId, serverId);
      const ackId = `bad-${Date.now()}`;
      const res = await sendAndAwait(sock, {
        channelId: 12345, serverId, content: 'merhaba', type: 'text', ackId,
      });
      expect(res.kind, 'geçersiz yük SESSİZCE düşürüldü').toBe('error');
      expect(String(res.data?.code ?? '')).toBe('INVALID_PAYLOAD');
    } finally { closeSockets(sock); }
  });

  test('reddetme HASSAS BİLGİ sızdırmaz', async () => {
    // Hata metni kullanıcıya gösterilebilir olmalı; iç şema/yol/yığın DEĞİL.
    const sock = await openSocket(token);
    try {
      await joinChannelConfirmed(sock, channelId, serverId);
      const res = await sendAndAwait(sock, {
        channelId: 12345, serverId, content: 'merhaba', type: 'text', ackId: 'leak-1',
      });
      const blob = JSON.stringify(res.data ?? {});
      for (const leak of ['stack', 'at Object', '/server/', 'node_modules', 'zod', 'schema']) {
        expect(blob.toLowerCase(), `sızıntı: ${leak}`).not.toContain(leak.toLowerCase());
      }
    } finally { closeSockets(sock); }
  });
});

// Final21 UX (U-11): anti-spam reddi de "sessizlik" değildir. Sunucu `error:spam`i ackId'siz
// yayınlıyordu ve istemci onu dinlemiyordu; hızlı yazan kullanıcı 10 sn sonra "sunucu onayı
// zaman aşımına uğradı" görüyordu. Artık ret, reddedilen gönderimin ackId'sini taşır ve blok
// geçicidir: süre dolunca AYNI ackId ile yeniden gönderim ACK alır (istemcinin kendiliğinden
// yeniden gönderimi bu sözleşmeye dayanır). Blok bu testin kullanıcısında biter — sonraki
// dosyalara taşmaz.
test.describe('hız sınırı reddi bekleyen gönderimle eşleşir', () => {
  test('ani gönderim: fazlası ackId taşıyan error:spam alır; blok bitince aynı ackId ACK alır', async ({ request }) => {
    test.setTimeout(120_000);
    const t2 = getTokens().media2;
    const srv = await createTestServer(request, t2, `Burst ${Date.now()}`);
    const sid = String((srv as { _id?: string })?._id ?? '');
    const ch = await createTestChannel(request, t2, sid, `burst-${Date.now().toString(36)}`, 'text');
    const cid = String((ch as { _id?: string })?._id ?? '');
    const sock = await openSocket(t2);
    try {
      await joinChannelConfirmed(sock, cid, sid);
      const outcome = new Map<string, string>();
      sock.on('message:ack', (d: Record<string, unknown>) => { if (d?.ackId) outcome.set(String(d.ackId), 'ack'); });
      sock.on('error:spam', (d: Record<string, unknown>) => { if (d?.ackId) outcome.set(String(d.ackId), `spam:${String(d.reason)}`); });
      const ids = Array.from({ length: 9 }, (_, i) => `burst-${Date.now()}-${i}`);
      ids.forEach((ackId, i) => sock.emit('message:send', { channelId: cid, serverId: sid, content: `hızlı ${i}`, ackId }));
      await expect.poll(() => ids.filter((id) => outcome.has(id)).length, { timeout: 20_000, message: 'bazı gönderimler SESSİZ kaldı' }).toBe(ids.length);
      const rejected = ids.filter((id) => outcome.get(id)?.startsWith('spam:'));
      expect(rejected.length, 'anti-spam hiç devreye girmedi').toBeGreaterThan(0);
      expect(ids.filter((id) => outcome.get(id) === 'ack').length).toBeGreaterThanOrEqual(5);
      await new Promise((r) => setTimeout(r, 31_000));
      const retry = await sendAndAwait(sock, { channelId: cid, serverId: sid, content: 'hızlı yeniden', ackId: rejected[0] }, 12_000);
      expect(retry.kind).toBe('ack');
      expect(retry.data?.ackId).toBe(rejected[0]);
    } finally { closeSockets(sock); }
  });
});
