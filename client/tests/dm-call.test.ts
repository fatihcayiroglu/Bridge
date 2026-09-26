// client/tests/dm-call.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// FAZ 8/1 — DM ARAMA SİNYALLEŞMESİ.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `DmCallPanel` gerçek bir uygulamaydı ama sunucununkinden FARKLI bir protokol
// konuşuyordu. Arama ÇALARDI, asla BAĞLANMAZDI:
//
//   · `callId`i istemci uyduruyordu — sunucu kendi uuid'sini üretir.
//   · `dm:call:start` `{ targetUserId, offer }` gönderiyordu; şema
//     `{ toUserId, type }` bekler ve teklifi ayrı olayla alır.
//   · `dm:call:answer` `targetUserId` taşımıyordu → `signalPeer()` null döner,
//     sinyal SESSİZCE düşer.
//   · İstemci `dm:call:answered` dinliyordu — sunucu böyle bir olay YAYMAZ.
//   · `accept` / `decline` / `ready` / `missed` hiç ele alınmıyordu.
//
// Bu paket sözleşmeyi ALAN ADI DÜZEYİNDE kilitler. Bir alan adı sapması bu
// özelliği tekrar sessizce öldürür ve tarayıcıda fark edilmesi çok zordur.

import { describe, it, expect } from 'vitest';
import {
  OUTBOUND, INBOUND,
  startPayload, callIdPayload, offerPayload, answerPayload, icePayload,
  parseIncoming, parseReady, parseOutgoing, parseAccepted, isForCall,
  type CallSession,
} from '../js/core/dm-call/dm-call-protocol.ts';

const session: CallSession = {
  callId: 'call-1', peerUserId: 'u-peer', type: 'voice', role: 'caller',
};

// ════════════════════════════════════════════════════════════════════════════
describe('olay adları sunucuyla birebir', () => {
  it('giden olaylar sunucunun DİNLEDİĞİ adlardır', () => {
    // server/socket/handlers/dm.ts — socket.on(...)
    expect(OUTBOUND).toEqual({
      start:   'dm:call:start',
      accept:  'dm:call:accept',
      decline: 'dm:call:decline',
      end:     'dm:call:end',
      offer:   'dm:call:offer',
      answer:  'dm:call:answer',
      ice:     'dm:call:ice',
    });
  });

  it('gelen olaylar sunucunun YAYDIĞI adlardır', () => {
    expect(INBOUND).toEqual({
      incoming: 'dm:call:incoming',
      outgoing: 'dm:call:outgoing',
      accepted: 'dm:call:accepted',
      ready:    'dm:call:ready',
      declined: 'dm:call:declined',
      missed:   'dm:call:missed',
      offer:    'dm:call:offer',
      answer:   'dm:call:answer',
      ice:      'dm:call:ice',
      ended:    'dm:call:ended',
    });
  });

  it('YAYILMAYAN `dm:call:answered` adı hiçbir yerde KULLANILMAZ', () => {
    // Eski istemcinin dinlediği ad buydu; sunucu onu asla yaymaz.
    const names = [...Object.values(OUTBOUND), ...Object.values(INBOUND)];
    expect(names).not.toContain('dm:call:answered');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('giden gövdeler', () => {
  it('start `toUserId` gönderir — `targetUserId` DEĞİL', () => {
    // Şema (middleware/validate.ts:284) `toUserId` ister; yanlış ad
    // doğrulamada düşer ve arama hiç başlamaz.
    const payload = startPayload('u-peer', 'video');
    expect(payload).toEqual({ toUserId: 'u-peer', type: 'video' });
    expect(payload).not.toHaveProperty('targetUserId');
  });

  it('start TEKLİF TAŞIMAZ — teklif ayrı olaydır', () => {
    // Eski istemci teklifi start ile yolluyordu, yani karşı taraf daha
    // kabul etmeden.
    expect(startPayload('u-peer', 'voice')).not.toHaveProperty('offer');
  });

  it('start kendi `callId`ini UYDURMAZ', () => {
    // Sunucu uuid üretir; uydurma kimlik `activeDmCalls`te bulunmaz ve
    // sonraki her sinyal `callParticipant()` denetiminde düşer.
    expect(startPayload('u-peer', 'voice')).not.toHaveProperty('callId');
  });

  it('accept / decline / end yalnızca `callId` gönderir', () => {
    expect(callIdPayload('call-1')).toEqual({ callId: 'call-1' });
  });

  it('offer / answer / ice `targetUserId` TAŞIR', () => {
    // `signalPeer()` bunsuz null döner ve sinyal sessizce düşer.
    for (const payload of [
      offerPayload(session, { sdp: 'o' }),
      answerPayload(session, { sdp: 'a' }),
      icePayload(session, { candidate: 'c' }),
    ]) {
      expect(payload.callId).toBe('call-1');
      expect(payload.targetUserId).toBe('u-peer');
    }
  });

  it('sinyal gövdeleri kendi alanlarını doğru adla taşır', () => {
    expect(offerPayload(session, { sdp: 'o' }).offer).toEqual({ sdp: 'o' });
    expect(answerPayload(session, { sdp: 'a' }).answer).toEqual({ sdp: 'a' });
    expect(icePayload(session, { c: 1 }).candidate).toEqual({ c: 1 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('gelen gövdeler', () => {
  it('incoming sunucunun ALAN ADLARINI okur', () => {
    // Eski istemci `callerName`/`callerAvatar` okuyordu → İSİMSİZ arayan.
    const call = parseIncoming({
      callId: 'c1', type: 'video', callerId: 'u-a',
      callerDisplayName: 'Ayşe', callerAvatarColor: '#123456',
    });
    expect(call).toEqual({
      callId: 'c1', type: 'video', callerId: 'u-a',
      callerDisplayName: 'Ayşe', callerAvatarColor: '#123456',
    });
  });

  it('incoming eksik adı UYDURMAZ; görüntüleme yedeği bileşene aittir', () => {
    // Protokol çözümleyicisi ARTIK yerelleştirilmiş metin üretmez: bir metni
    // ayrıştırma anında sabitlemek, dil sonradan değişse bile o eski metni
    // taşırdı. Çözümleyici boş bırakır; `DmCallPanel` render anında
    // `t('ui_unknown_user')` yedeğini uygular.
    expect(parseIncoming({ callId: 'c1', callerId: 'u-a' })?.callerDisplayName).toBe('');
  });

  it('kimliksiz incoming REDDEDİLİR', () => {
    for (const bad of [null, {}, { callId: 'c1' }, { callerId: 'u' }]) {
      expect(parseIncoming(bad)).toBeNull();
    }
  });

  it('outgoing sunucunun KANONİK callId’ini taşır', () => {
    expect(parseOutgoing({ callId: 'server-uuid', type: 'voice', toUserId: 'u-b' }))
      .toEqual({ callId: 'server-uuid', type: 'voice', toUserId: 'u-b' });
  });

  it('ready ROLÜ taşır — teklifi kimin üreteceğini bu belirler', () => {
    expect(parseReady({ callId: 'c1', role: 'caller', type: 'video' }))
      .toEqual({ callId: 'c1', role: 'caller', type: 'video' });
    expect(parseReady({ callId: 'c1', role: 'callee' })?.role).toBe('callee');
  });

  it('tanınmayan rol callee’ye düşer (teklif ÜRETİLMEZ)', () => {
    // Fail-safe: şüphede kalırsa teklif üretmemek, iki taraflı teklif
    // çarpışmasından iyidir.
    expect(parseReady({ callId: 'c1', role: 'saçma' })?.role).toBe('callee');
  });

  it('accepted karşı tarafın adını taşır', () => {
    expect(parseAccepted({ callId: 'c1', calleeDisplayName: 'Veli' }))
      .toEqual({ callId: 'c1', calleeDisplayName: 'Veli' });
  });

  it('tip alanı yalnızca voice/video olabilir', () => {
    expect(parseIncoming({ callId: 'c', callerId: 'u', type: 'hack' })?.type).toBe('voice');
    expect(parseReady({ callId: 'c', type: 'hack' })?.type).toBe('voice');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sinyal eşleştirme', () => {
  it('yalnızca AKTİF görüşmenin sinyali kabul edilir', () => {
    expect(isForCall(session, { callId: 'call-1' })).toBe(true);
    expect(isForCall(session, { callId: 'BASKA' })).toBe(false);
  });

  it('oturum yokken hiçbir sinyal kabul edilmez', () => {
    // Görüşme yokken gelen sinyal, istenmeyen WebRTC enjeksiyonu olabilir.
    expect(isForCall(null, { callId: 'call-1' })).toBe(false);
  });

  it('bozuk gövde kabul edilmez', () => {
    for (const bad of [null, {}, { callId: 42 }, 'x']) {
      expect(isForCall(session, bad)).toBe(false);
    }
  });
});
