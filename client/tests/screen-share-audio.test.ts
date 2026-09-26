// client/tests/screen-share-audio.test.ts
//
// PAYLAŞIM SESİ (SİSTEM SESİ)
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK ÖZELLİK BOŞLUĞU
// ════════════════════════════════════════════════════════════════════════════
// `startScreenShare(quality, includeAudio)` `includeAudio` değerini yalnızca
// `getDisplayMedia`ya iletiyordu. Tarayıcı bir ses track'i VERSE BİLE akranlara
// yalnızca `getVideoTracks()[0]` bağlanıyordu; ses track'i sessizce
// DÜŞÜRÜLÜYORDU.
//
// Kullanıcı deneyimi olarak: kutu işaretlenir, tarayıcı "sekme sesini paylaş"
// izni ister, kullanıcı onaylar — ve karşı taraf HİÇBİR ŞEY duymaz. Paylaşan
// kişi sesin gittiğini sanır.
//
// ── BU PAKETİN KİLİTLEDİĞİ SÖZLEŞMELER ────────────────────────────────────
//   1. Yakalanan ses track'i GERÇEKTEN iletilir.
//   2. Mikrofon gönderici yolu DEĞİŞTİRİLMEZ — sistem sesi mikrofonun yerine
//      geçmez ve onunla karıştırılmaz.
//   3. Alıcıda paylaşım sesi mikrofon akışını EZMEZ.
//   4. Sağırlaştırma ve hoparlör seçimi ikisine de uygulanır (tek ses sahibi).
//   5. Durdurma / tarayıcıdan durdurma / ayrılma yollarının hepsi temizler.
//   6. Platform ses vermediğinde ürün bunu DÜRÜSTÇE söyler.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENT = join(__dirname, '..');
const RTC   = readFileSync(join(CLIENT, 'js', 'webrtc.ts'), 'utf8');
const PANEL = readFileSync(join(CLIENT, 'js', 'core', 'VoicePanel.svelte'), 'utf8');
const CTRL  = readFileSync(join(CLIENT, 'js', 'core', 'VoiceScreenShareController.svelte'), 'utf8');

const startBlock = RTC.slice(RTC.indexOf('async startScreenShare'), RTC.indexOf('stopScreenShare(): void'));
const stopBlock  = RTC.slice(RTC.indexOf('stopScreenShare(): void'), RTC.indexOf('async setChannelBitrate'));

// ════════════════════════════════════════════════════════════════════════════
describe('gönderen — ses GERÇEKTEN iletilir', () => {
  it('yakalanan ses track\'i saklanır', () => {
    // Asıl kusur: track alınıyordu ama hiçbir yere bağlanmıyordu.
    expect(startBlock).toMatch(/_screenAudioTrack = this\.screenStream\.getAudioTracks\(\)\[0\] \?\? null/);
  });

  it('her akrana ses eklenir', () => {
    expect(startBlock).toMatch(/this\._attachScreenAudioTo\(pc\)/);
  });

  it('ses AYRI bir gönderici ile taşınır — mikrofonun yerine GEÇMEZ', () => {
    // `replaceTrack` mikrofon göndericisine uygulanırsa karşı taraf konuşmayı
    // duymayı bırakırdı. Ses kendi transceiver'ında gider.
    const attach = RTC.slice(RTC.indexOf('private _attachScreenAudioTo'), RTC.indexOf('private _detachScreenAudio'));
    expect(attach).toMatch(/pc\.addTrack\(this\._screenAudioTrack, this\.screenStream\)/);
    expect(attach).not.toMatch(/replaceTrack/);
    expect(attach).not.toMatch(/localStream/);
  });

  it('aynı akrana ses İKİ KEZ eklenmez', () => {
    const attach = RTC.slice(RTC.indexOf('private _attachScreenAudioTo'), RTC.indexOf('private _detachScreenAudio'));
    expect(attach).toMatch(/if \(this\._screenAudioSenders\.has\(pc\)\) return/);
  });

  it('paylaşım SÜRERKEN katılan akran da sesi alır', () => {
    // Aksi halde sonradan gelen kişi görüntüyü görüp sesi hiç duymazdı.
    const peerCreate = RTC.slice(RTC.indexOf('this.peers.set(socketId, pc)'), RTC.indexOf('this._preferOpus(pc)'));
    expect(peerCreate).toMatch(/_attachScreenAudioTo\(pc\)/);
  });

  it('paylaşan kendi sistem sesini YEREL olarak çalmaz', () => {
    // Yerel geri besleme (loopback) hem çift ses hem yankı üretirdi.
    expect(startBlock).not.toMatch(/new Audio\(/);
    expect(startBlock).not.toMatch(/srcObject\s*=/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('gönderen — temizlik', () => {
  it('durdurma ses yolunu söker', () => {
    expect(stopBlock).toMatch(/this\._detachScreenAudio\(\)/);
  });

  it('ses SÖKÜMÜ akış null\'lanmadan ÖNCE olur', () => {
    // Ters sırada göndericiler sahipsiz kalır ve alıcıda asılı bir ses
    // akışı bırakırdı.
    expect(stopBlock.indexOf('_detachScreenAudio()'))
      .toBeLessThan(stopBlock.indexOf('this.screenStream  = null'));
  });

  it('söküm göndericileri KALDIRIR ve haritayı boşaltır', () => {
    const detach = RTC.slice(RTC.indexOf('private _detachScreenAudio'), RTC.indexOf('stopScreenShare(): void'));
    expect(detach).toMatch(/pc\.removeTrack\(sender\)/);
    expect(detach).toMatch(/_screenAudioSenders\.clear\(\)/);
    expect(detach).toMatch(/_screenAudioTrack = null/);
    expect(detach).toMatch(/screenAudioActive = false/);
  });

  it('TARAYICI arayüzünden ses durdurulursa durum güncellenir', () => {
    // Chrome'un kendi "paylaşımı durdur" kontrolü yalnızca ses track'ini de
    // bitirebilir; Bridge bunu kaçırırsa arayüz yalan söylerdi.
    expect(startBlock).toMatch(/_screenAudioTrack\.onended = \(\) => this\._detachScreenAudio\(\)/);
  });

  it('söküm video paylaşımını DURDURMAZ', () => {
    // Yalnızca ses biterse görüntü sürmelidir.
    const detach = RTC.slice(RTC.indexOf('private _detachScreenAudio'), RTC.indexOf('stopScreenShare(): void'));
    expect(detach).not.toMatch(/screenSharing = false/);
    expect(detach).not.toMatch(/screenStream\s*=\s*null/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('alıcı — mikrofon EZİLMEZ', () => {
  const attachFn = PANEL.slice(PANEL.indexOf('export function attachRemoteStream'), PANEL.indexOf('// ── Reply / Pin'));

  it('paylaşım sesi AYRI anahtara yazılır', () => {
    // Bu harita yalnızca `socketId` ile anahtarlanıyordu; ikinci ses akışı
    // mikrofon akışını düşürürdü.
    expect(attachFn).toMatch(/SCREEN_AUDIO_SUFFIX/);
    expect(attachFn).toMatch(/existing!\.id !== stream\.id/);
  });

  it('İLK ses akışı mikrofon olarak kalır', () => {
    expect(attachFn).toMatch(/const key = isScreenAudio \? .+ : socketId/);
  });

  it('sağırlaştırma ve hoparlör seçimi ikisine de uygulanır', () => {
    // Aynı `{#each remoteAudioStreams}` döngüsü çizer: ikinci bir ses sahibi
    // yaratılmadığı için `muted={deafened}` ve `use:remoteAudio` bedava gelir.
    expect(PANEL).toMatch(/\{#each \[\.\.\.remoteAudioStreams\.entries\(\)\]/);
    expect(PANEL).toMatch(/muted=\{deafened\}/);
    expect(PANEL).toMatch(/use:remoteAudio=\{stream\}/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('alıcı — temizlik', () => {
  const clearFn = PANEL.slice(PANEL.indexOf('function clearRemoteScreen'), PANEL.indexOf('Faz K2 — uzak katilimcinin konusma'));

  it('paylaşım bitince ses akışı KALDIRILIR', () => {
    expect(clearFn).toMatch(/next\.delete\(audioKey\)/);
  });

  it('ses temizliği SAHİPLİK kontrolünden ÖNCE yapılır', () => {
    // Başkası paylaşıyorken erken çıkış olur; ses orada bırakılırsa paylaşım
    // bittikten sonra da duyulmaya devam ederdi.
    expect(clearFn.indexOf('next.delete(audioKey)'))
      .toBeLessThan(clearFn.indexOf('if (screenSharerSocketId && screenSharerSocketId !== socketId) return'));
  });

  it('paylaşırken AYRILAN kişinin sesi de temizlenir', () => {
    const removeFn = PANEL.slice(PANEL.indexOf('export function removeVoicePeer'), PANEL.indexOf('export function updatePeerState'));
    expect(removeFn).toMatch(/clearRemoteScreen\(socketId\)/);
  });

  it('uzak durum `screensharing:false` olunca temizlenir', () => {
    const updateFn = PANEL.slice(PANEL.indexOf('export function updatePeerState'));
    expect(updateFn).toMatch(/state\.screensharing === false/);
    expect(updateFn).toMatch(/clearRemoteScreen\(socketId\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('arayüz — DÜRÜST durum', () => {
  it('gerçek yakalanan durum okunur, KUTU değil', () => {
    // Sözleşmenin özü: `includeAudio` kullanıcının NİYETİDİR, kanıt değildir.
    expect(CTRL).toMatch(/screenAudioActive/);
    expect(CTRL).toMatch(/const captured = Boolean\(/);
  });

  it('ses yokken bunu AÇIKÇA söyler', () => {
    expect(CTRL).toMatch(/ss_audio_unavailable/);
    expect(CTRL).toMatch(/ss_audio_shared/);
  });

  it('metinler i18n\'den gelir — sabit kod YOK', () => {
    const block = CTRL.slice(CTRL.indexOf('if (includeAudio)'), CTRL.indexOf('// Bitrate override'));
    expect(block).toMatch(/t\('ss_audio_shared'\)|t\(captured \? 'ss_audio_shared'/);
    expect(block).not.toMatch(/'(Sistem sesi|System audio)/);
  });

  it('her iki dilde de tanımlıdır', () => {
    for (const loc of ['en', 'tr']) {
      const table = readFileSync(join(CLIENT, 'js', 'core', 'i18n', `${loc}.ts`), 'utf8');
      expect(table, `${loc}: ss_audio_shared`).toMatch(/'ss_audio_shared':/);
      expect(table, `${loc}: ss_audio_unavailable`).toMatch(/'ss_audio_unavailable':/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('mimari sınırlar', () => {
  it('İKİNCİ bir RTC mimarisi kurulmaz', () => {
    // Paylaşım sesi mevcut akran bağlantıları üzerinden gider.
    const attach = RTC.slice(RTC.indexOf('private _attachScreenAudioTo'), RTC.indexOf('private _detachScreenAudio'));
    expect(attach).not.toMatch(/new RTCPeerConnection/);
  });

  it('P2P yolu koşulsuz kalır — SFU\'ya bağlanmaz', () => {
    expect(startBlock).not.toMatch(/isSFUReady|_sfuAvailable/);
  });

  it('platform ses vermezse video paylaşımı GÜVENLE sürer', () => {
    // `screenAudioActive` false olur ama akış kurulmaya devam eder.
    expect(startBlock).toMatch(/screenAudioActive = Boolean\(this\._screenAudioTrack\)/);
    expect(startBlock).toMatch(/this\.screenSharing = true/);
  });
});
