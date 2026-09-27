// client/tests/screen-share-lifecycle.test.ts
//
// EKRAN PAYLAŞIMI — DONMUŞ KARE BIRAKMAZ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Paylaşan taraf durdurduğunda `webrtc.ts` şunu yapar:
//
//     sender.replaceTrack(null)
//
// Bu, ALICI tarafta yeni bir `ontrack` ÜRETMEZ ve `<video>` elemanı son
// boyanan KAREYİ ekranda tutar. Yani "paylaşım bitti" bilgisi görüntüye
// yansımaz.
//
// `updatePeerState` yalnızca `sfuRemoveVideoTile(...)` çağırıyordu; o ise SFU
// kutucuğunu kaldırır. Üretimde etkin yol P2P'dir (mediasoup kapalı) ve P2P
// görünümü `remoteScreenStream` ile beslenir — o değişken HİÇBİR YERDE
// sıfırlanmıyordu.
//
// Sonuç: izleyici, paylaşım bittikten SONRA donmuş bir kareye bakmaya devam
// ediyordu. Aynısı paylaşırken AYRILAN kullanıcı için de geçerliydi.
//
// Bu paket kaynağı okur: gerçek `RTCPeerConnection` ve iki tarayıcı olmadan
// bileşenin bu dalını çalıştırmak jsdom'da ağır ve kırılgan olurdu. Sınanan
// şey YAPISAL sözleşmedir; görsel doğrulama insan geçidindedir
// (docs/VOICE_HUMAN_VERIFICATION.md).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PANEL_RAW = readFileSync(
  join(__dirname, '..', 'js', 'core', 'VoicePanel.svelte'), 'utf8',
);

/** Yalnızca çalışan kod; yorumlar elenir (kusurun adı yorumlarda geçiyor). */
const PANEL = PANEL_RAW
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n')
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

/** Bir fonksiyonun gövdesini kabaca çıkarır. */
function body(name: string): string {
  const i = PANEL.indexOf(name);
  if (i === -1) return '';
  return PANEL.slice(i, i + 900);
}

// ════════════════════════════════════════════════════════════════════════════
describe('uzak paylaşım DURDUĞUNDA görüntü temizlenir', () => {
  it('temizlik fonksiyonu vardır', () => {
    expect(PANEL).toMatch(/function clearRemoteScreen\(/);
  });

  it('`screensharing === false` durumunda çağrılır', () => {
    const fn = body('export function updatePeerState');
    expect(fn).toMatch(/state\.screensharing === false/);
    expect(fn).toMatch(/clearRemoteScreen\(socketId\)/);
  });

  it('SFU kutucuğunu kaldırmak TEK BAŞINA yeterli sayılmaz', () => {
    // Kusur tam olarak buydu: yalnızca `sfuRemoveVideoTile` çağrılıyordu,
    // P2P görünümünü besleyen `remoteScreenStream` ise duruyordu.
    const fn = body('export function updatePeerState');
    const stopBranch = fn.slice(fn.indexOf('state.screensharing === false'));
    expect(stopBranch).toMatch(/clearRemoteScreen/);
  });

  it('temizlik P2P akışını GERÇEKTEN sıfırlar', () => {
    const fn = body('function clearRemoteScreen');
    expect(fn).toMatch(/remoteScreenStream\s*=\s*null/);
    expect(fn).toMatch(/sharerName\s*=\s*''/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('paylaşırken AYRILAN kullanıcı da kare bırakmaz', () => {
  it('`removeVoicePeer` temizliği çağırır', () => {
    const fn = body('export function removeVoicePeer');
    expect(fn).toMatch(/clearRemoteScreen\(socketId\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('temizlik SAHİPLİK denetimi yapar', () => {
  it('başkasının durum güncellemesi görünümü kapatmaz', () => {
    // Üç kişilik bir odada A paylaşırken B'nin `screensharing:false`
    // güncellemesi gelirse A'nın paylaşımı kapanmamalıdır.
    const fn = body('function clearRemoteScreen');
    expect(fn).toMatch(/screenSharerSocketId && screenSharerSocketId !== socketId/);
    expect(fn).toMatch(/return;/);
  });

  it('paylaşan kişinin kimliği akış bağlanırken KAYDEDİLİR', () => {
    expect(PANEL).toMatch(/screenSharerSocketId = socketId/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('KENDİ paylaşımımız korunur', () => {
  it('yerel paylaşım sürerken görünüm kapatılmaz', () => {
    // Uzak paylaşım bitse de kendi ekranımızı paylaşmaya devam ediyorsak
    // görünüm açık kalmalıdır.
    const fn = body('function clearRemoteScreen');
    expect(fn).toMatch(/if \(!localScreenStream\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yakalama izleri temizlenir', () => {
  const RTC = readFileSync(join(__dirname, '..', 'js', 'webrtc.ts'), 'utf8')
    .split('\n')
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join('\n');

  it('durdurmada TÜM ekran track\'leri stop edilir', () => {
    // Yalnızca video track'i durdurmak, izin göstergesini (tarayıcı
    // "paylaşıyorsunuz" çubuğu) açık bırakırdı.
    const fn = RTC.slice(RTC.indexOf('stopScreenShare(): void {'));
    expect(fn.slice(0, 400)).toMatch(/screenStream\?\.getTracks\(\)\.forEach\(t => t\.stop\(\)\)/);
  });

  it('durdurmada paylaşım durumu yayınlanır', () => {
    const fn = RTC.slice(RTC.indexOf('stopScreenShare(): void {'));
    expect(fn.slice(0, 400)).toMatch(/_broadcastState\(\)/);
  });
});
