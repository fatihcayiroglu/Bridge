// server/lib/deliveryAck.ts
// Sprint 89 — Server-side mesaj teslim ACK sistemi
// Sprint 96 — _tmpId echo: client optimistic render için geçici ID geri gönderilir
//
// Çözüm: Gönderen client, mesaj payload'una isteğe bağlı (opt-in) bir
// `ackId` (client-üretilen UUID) ekler. Server mesajı DB'ye kaydedip
// broadcast ettikten SONRA yalnızca gönderen socket'a:
//   { event: 'message:ack', ackId, messageId, channelId, ts, tmpId? }
// gönderir.
//
// Sprint 96 eklentisi — _tmpId:
//   Client optimistic render'da fake msg-${tmpId} elementi oluşturur.
//   Server ACK'da tmpId'yi echo'layarak client'ın DOM'u güncellemesini sağlar.
//   ackId zorunlu değil — _tmpId tek başına da gönderilebilir (sendTmpAck).

import { cache } from './redisAdapter';

const ACK_TTL_SECONDS = 300; // 5 dakika
const redisKey = (ackId: string) => `msg:ack:${ackId}`;

export interface AckRecord {
  messageId: string;
  channelId: string;
  userId:    string;
  ts:        number;
  tmpId?:    string; // Sprint 96: optimistic render için client geçici ID
}

/**
 * Bir ackId daha önce görülmüş mü? (deduplication)
 */
export async function getAckRecord(ackId: string): Promise<AckRecord | null> {
  return (await cache.get(redisKey(ackId))) as AckRecord | null;
}

/**
 * Mesaj başarıyla işlenince ACK kaydını Redis'e yaz.
 */
export async function setAckRecord(ackId: string, record: AckRecord): Promise<void> {
  await cache.set(redisKey(ackId), record, ACK_TTL_SECONDS);
}

/**
 * Gönderen socket'a ACK eventi gönder.
 * Sprint 96: tmpId varsa echo'la — client pending mesajını gerçeğiyle değiştirir.
 */
export function sendAck(
  socket: { emit(ev: string, data: unknown): void },
  ackId:  string,
  record: AckRecord,
): void {
  socket.emit('message:ack', {
    ackId,
    messageId: record.messageId,
    channelId: record.channelId,
    ts:        record.ts,
    ...(record.tmpId ? { tmpId: record.tmpId } : {}),
  });
}

/**
 * Sprint 96: ackId olmadan yalnızca _tmpId ile ACK gönder.
 * Lightweight — Redis kaydı yapmaz, sadece client DOM günceller.
 */
export function sendTmpAck(
  socket:    { emit(ev: string, data: unknown): void },
  tmpId:     string,
  messageId: string,
  channelId: string,
): void {
  socket.emit('message:ack', {
    tmpId,
    messageId,
    channelId,
    ts: Date.now(),
  });
}
