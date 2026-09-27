// client/tests/voice-audio-graph.test.ts
//
// SES GRAFİĞİ — YANKI ÜRETEBİLECEK YOLLARIN YOKLUĞU
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Kullanıcı yankı bildirdi ve `echoCancellation=true` olsa bile bunun uçtan
// uca sessiz bir yol kanıtlamadığı doğrudur. Bu yüzden ses grafiğinin tamamı
// tek tek denetlendi. Bu paket, denetlenen her yolun BULGUSUNU kilitler ki
// aynı sınıf kusur sessizce geri gelmesin.
//
// Kilitlenen bulgular:
//   A  yerel mikrofon HİÇBİR yerde yerel olarak çalınmaz
//   B  uzak ses tek sahipten, katılımcı başına TEK elemandan çalar
//   D  mikrofon değiştirildiğinde eski track durdurulur ve senderlardan çıkar
//   F  soket dinleyicileri tek kez bağlanır, `removeAllListeners` kullanılmaz
//   §4 ekran paylaşımı sesi HİÇ İLETİLMEZ → dijital geri besleme yolu YOK
//   §5 seçili hoparlör SONRADAN gelen katılımcılara da uygulanır
//
// Kaynak okur: bu yollar gerçek `RTCPeerConnection`, gerçek `getUserMedia` ve
// iki tarayıcı gerektirir; jsdom'da kurmak testi ağır ve kırılgan yapardı.
// Sınanan şey YAPISAL değişmezlerdir. Davranışsal kanıt insan doğrulamasında.

import { describe, it, expect, vi } from 'vitest';
// ── KAYNAK TARAMASI G/Ç BAĞLIDIR ────────────────────────────────────────────
// Bu dosyadaki testler istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik
// VARSAYILAN zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir
// makinede aşılabilir; ölçüm bitmeden test kırmızıya döner ve bu, ürün hakkında
// HİÇBİR ŞEY söylemeyen bir kırılganlıktır. Sözleşme taramanın SONUCUNDA
// olduğu için bu dosyaya açık ve cömert bir zaman aşımı verilir. Hiçbir iddia
// gevşetilmemiştir; yalnızca zamanlama gürültüsü kaldırılmıştır.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CLIENT = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(CLIENT, ...p), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const WEBRTC     = stripComments(read('js', 'webrtc.ts'));
const WEBRTC_SFU = stripComments(read('js', 'webrtc-sfu.ts'));
const PANEL      = stripComments(read('js', 'core', 'VoicePanel.svelte'));
const ACTIONS    = stripComments(read('js', 'core', 'voice-actions.ts'));

// ════════════════════════════════════════════════════════════════════════════
describe('A — yerel mikrofon yerel olarak ÇALINMAZ', () => {
  /** Tüm istemcide `srcObject` atayan dosyalar. */
  function srcObjectSites(): string[] {
    const hits: string[] = [];
    (function walk(dir: string): void {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|svelte)$/.test(e.name)) continue;
        const src = readFileSync(full, 'utf8');
        if (/srcObject\s*=/.test(src)) hits.push(full.replace(CLIENT, ''));
      }
    })(join(CLIENT, 'js'));
    return hits;
  }

  // ── KAYNAK TARAMASI G/Ç BAĞLIDIR, ZAMANLAMA İDDİASI DEĞİLDİR ────────────
  // Bu test tüm istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik varsayılan
  // zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir makinede
  // AŞILABİLİR ve tarama bitmeden test kırmızıya döner. Ölçülen sözleşme
  // sürede değil, taramanın SONUCUNDA olduğu için açık ve cömert bir zaman
  // aşımı verilir; hiçbir iddia gevşetilmez.
  it('srcObject atayan yer sayısı SINIRLI ve bilinen kümede', () => {
    // Yeni bir atama noktası eklendiğinde bu test düşer ve o yolun da
    // denetlenmesi gerekir — asıl amaç budur.
    const sites = srcObjectSites().map(p => p.replace(/\\/g, '/'));
    expect(sites.sort()).toEqual([
      '/js/core/DmCallPanel.svelte',
      '/js/core/EmptyServerStart.svelte',
      '/js/core/group-dm-voice.ts',
      '/js/core/voice-actions.ts',
    ]);
  }, 60_000);

  it('DM aramasında YEREL video elemanı muted', () => {
    const dm = read('js', 'core', 'DmCallPanel.svelte');
    const tag = dm.slice(dm.indexOf('bind:this={localVideo}'));
    expect(tag.slice(0, 160)).toMatch(/\bmuted\b/);
  });

  it('QR tarayıcı ses İSTEMEZ ve elemanı muted', () => {
    const qr = read('js', 'core', 'EmptyServerStart.svelte');
    expect(qr).toMatch(/audio:\s*false/);
    const tag = qr.slice(qr.indexOf('bind:this={videoEl}'));
    expect(tag.slice(0, 120)).toMatch(/\bmuted\b/);
  });

  it('hiçbir AudioContext çıkışa (destination) bağlanmaz', () => {
    // `source.connect(ctx.destination)` mikrofonu doğrudan hoparlöre verir —
    // kullanıcı kendi sesini duyar. Analiz grafiği çıkmaz sokak olmalıdır.
    for (const src of [WEBRTC, PANEL, stripComments(read('js', 'core', 'voice-activity-detector.ts'))]) {
      expect(src).not.toMatch(/connect\(\s*\w*\.?destination\s*\)/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('B — uzak ses tek yoldan çalar', () => {
  it('uzak ses elemanları katılımcı kimliğiyle ANAHTARLANIR', () => {
    // Anahtarsız `{#each}` aynı kişi için ikinci bir eleman üretebilirdi.
    expect(PANEL).toMatch(/\{#each \[\.\.\.remoteAudioStreams\.entries\(\)\] as \[socketId, stream\] \(socketId\)\}/);
  });

  it('video kutucukları ve ekran videosu HER ZAMAN muted', () => {
    expect(PANEL).not.toMatch(/muted=\{tile\.isLocal\}/);
    const screen = PANEL.slice(PANEL.indexOf('id="remote-screen-video"'));
    expect(screen.slice(0, 220)).toMatch(/\bmuted\b/);
  });

  it('ayrılan katılımcının ses girdisi SİLİNİR', () => {
    expect(PANEL).toMatch(/export function removeVoicePeer/);
    const fn = PANEL.slice(PANEL.indexOf('export function removeVoicePeer'));
    expect(fn.slice(0, 400)).toMatch(/audio\.delete\(socketId\)/);
  });

  it('sunucu sinyali de temizler — ICE zaman aşımı BEKLENMEZ', () => {
    // Yalnızca `onconnectionstatechange`e güvenmek, ayrılan kişinin girdisini
    // onlarca saniye ayakta tutardı.
    expect(WEBRTC).toMatch(/'voice:peer-left'/);
    const h = WEBRTC.slice(WEBRTC.indexOf("'voice:peer-left'"));
    expect(h.slice(0, 300)).toMatch(/removeVoicePeer\(socketId\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C — aynı katılımcı için ikinci bağlantı kalmaz', () => {
  it('yeni bağlantı kurulmadan önce eskisi KAPATILIR', () => {
    const fn = WEBRTC.slice(WEBRTC.indexOf('private _createPeerConnection('));
    const body = fn.slice(0, fn.indexOf('private _removePeer('));
    expect(body).toMatch(/const existing = this\.peers\.get\(socketId\)/);
    expect(body).toMatch(/existing\.close\(\)/);
    expect(body).toMatch(/this\.peers\.delete\(socketId\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('D — eski mikrofon track\'i yayında kalmaz', () => {
  it('değiştirmede eski track durdurulur VE akıştan çıkarılır', () => {
    const stops = WEBRTC.match(/getAudioTracks\(\)\.forEach\(t => \{ t\.stop\(\); this\.localStream!\.removeTrack\(t\); \}\)/g) ?? [];
    // İki yol: `setMicDevice` ve `setAudioProcessing`.
    expect(stops.length).toBeGreaterThanOrEqual(2);
  });

  it('yeni track TÜM senderlara takılır', () => {
    const replaces = WEBRTC.match(/sender\.replaceTrack\(newTrack\)/g) ?? [];
    expect(replaces.length).toBeGreaterThanOrEqual(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('F — soket dinleyicileri çoğalmaz', () => {
  it('dinleyiciler TEK bir yerden bağlanır', () => {
    const binds = WEBRTC.match(/this\._bindSocketEvents\(\)/g) ?? [];
    expect(binds).toHaveLength(1);
  });

  it('her dinleyici kaydedilir ve REFERANSIYLA sökülür', () => {
    expect(WEBRTC).toMatch(/this\._socketHandlers\.push\(\[event, handler\]\)/);
    expect(WEBRTC).toMatch(/this\.socket\.off\(event, handler\)/);
  });

  it('`removeAllListeners` KULLANILMAZ', () => {
    // Başka sahiplerin dinleyicilerini de söker; kanonik soket kimliği bozulur.
    expect(WEBRTC).not.toMatch(/removeAllListeners/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ── BU BÖLÜM YENİDEN YAZILDI ────────────────────────────────────────────────
// Eski sözleşme "ekran paylaşımı sesi HİÇ İLETİLMEZ; kutu DEVRE DIŞI" idi ve
// o zamanki ürün için doğruydu. Ekran sesi bu arada GERÇEKTEN uygulandı
// (webrtc.ts / webrtc-sfu.ts ses track'ini yakalayıp yayınlıyor,
// VoiceScreenShareController kutuyu okuyup aktarıyor). Eski iddialar bu
// yüzden ürünün BUGÜNKÜ davranışını değil, kaldırılmış bir ara durumu
// ölçüyordu.
//
// Korunması gereken asıl değer aynı kaldı ve buraya taşındı:
//   · ses YALNIZCA kullanıcı istediğinde yakalanır (varsayılan kapalı),
//   · kullanıcıya "ses paylaşılıyor" DENMEZ — yalnızca GERÇEKTEN yakalanan
//     durum bildirilir (işaretli kutu, teslim kanıtı değildir),
//   · mikrofon yolu ekran sesinden etkilenmez,
//   · ses yayını başarısız olursa yakalama durdurulur ve video yaşamaya
//     devam eder (izin alınmış ama kullanılmayan canlı sistem sesi kalmaz).
describe('§4 — ekran paylaşımı sesi YALNIZCA istendiğinde ve DÜRÜSTÇE iletilir', () => {
  it('her iki yolda da ses VARSAYILAN OLARAK İSTENMEZ', () => {
    expect(WEBRTC).toMatch(/includeAudio = false/);
    expect(WEBRTC_SFU).toMatch(/includeAudio = false/);
  });

  it('ses yakalama isteği kullanıcı seçimine BAĞLIDIR', () => {
    // `audio: includeAudio ? {...} : false` — koşulsuz bir ses isteği,
    // kullanıcıya gereksiz izin sorusu sordurur.
    for (const source of [WEBRTC, WEBRTC_SFU]) {
      const body = source.slice(source.indexOf('async startScreenShare('));
      expect(body.slice(0, 1400)).toMatch(/audio:\s*includeAudio/);
    }
  });

  it('SFU yolunda ses track\'i yalnızca istendiğinde ALINIR', () => {
    const fn = WEBRTC_SFU.slice(WEBRTC_SFU.indexOf('async startScreenShare('));
    const body = fn.slice(0, fn.indexOf('} catch {'));
    expect(body).toMatch(/getVideoTracks\(\)\[0\]/);
    expect(body).toMatch(/includeAudio\s*\?\s*stream\.getAudioTracks\(\)\[0\]\s*:\s*undefined/);
  });

  it('ses yayını başarısız olursa yakalama DURDURULUR, video yaşar', () => {
    const fn = WEBRTC_SFU.slice(WEBRTC_SFU.indexOf('async startScreenShare('));
    const body = fn.slice(0, fn.indexOf('} catch {'));
    expect(body).toMatch(/screenAudioTrack\.stop\(\)/);
    expect(body).toMatch(/this\.screenAudioActive = false/);
  });

  it('"ses paylaşılıyor" bildirimi KUTUYA değil GERÇEK track\'e bakar', () => {
    const raw = read('js', 'core', 'VoiceScreenShareController.svelte');
    expect(raw).toMatch(/const captured = Boolean\(\(r as unknown as \{ screenAudioActive\?: boolean \}\)\.screenAudioActive\)/);
    expect(raw).toMatch(/captured \? 'ss_audio_shared' : 'ss_audio_unavailable'/);
  });

  it('arayüzdeki "Ses Dahil" kutusu, desteğin YÜZEYE bağlı olduğunu söyler', () => {
    const raw = read('js', 'core', 'VoicePanel.svelte');
    const box = raw.slice(raw.indexOf('id="ss-include-audio"'));
    expect(box.slice(0, 320)).toMatch(/vp_audio_support_varies/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('§5 — seçili hoparlör SONRADAN gelenlere de uygulanır', () => {
  it('uzak ses elemanı çıkış cihazını da uygulayan eylemi kullanır', () => {
    expect(PANEL).toMatch(/use:remoteAudio=\{stream\}/);
  });

  it('eylem hem akışı bağlar hem çıkışı uygular', () => {
    expect(ACTIONS).toMatch(/export function remoteAudio/);
    const fn = ACTIONS.slice(ACTIONS.indexOf('export function remoteAudio'));
    expect(fn).toMatch(/setSrcObject\(el, stream\)/);
    expect(fn).toMatch(/applySelectedSink\(el\)/);
    // Akış degistiginde de yeniden uygulanmalı.
    expect(fn).toMatch(/update\(next/);
  });

  it('çıkış tercihi TEK kaynaktan okunur — ikinci depo yok', () => {
    expect(ACTIONS).toMatch(/BridgeRegistry\.get<\{ selectedSpeakerId\?: string \| null \}>\('rtc'\)/);
  });

  it('varsayılan cihazda setSinkId ÇAĞRILMAZ', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('export function applySelectedSink'));
    expect(fn.slice(0, 400)).toMatch(/if \(!deviceId\) return;/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// UX-8 — SES ODASI SOSYAL HİYERARŞİSİ
// ════════════════════════════════════════════════════════════════════════════
// Ses odası "insanların takıldığı bir yer" değil, durum etiketleri panosu gibi
// görünüyordu: her katılımcı kutucuğunda YAN YANA ÜÇ METİN ÇİPİ vardı —
// "Konuşuyor", "Paylaşıyor", "Kamera". Üstelik "Konuşuyor" çipi, kutucuğun
// zaten sahip olduğu HALKA ile aynı bilgiyi tekrarlıyordu.
//
// Ayrıca kendi kutucuğunuz Türkçe arayüzde "(You)" yazıyordu.
describe('UX-8 — katılımcı kutucuğu', () => {
  const VP = PANEL;   // yorumları elenmiş VoicePanel kaynağı

  it('konuşma METİN ÇİPİ olarak gösterilmez', () => {
    // Görsel sinyal halkadır; metin çipi gereksiz gürültüydü.
    expect(VP).not.toMatch(/peer-speaking-badge/);
  });

  it('konuşma halkası AVATARIN üzerindedir', () => {
    // Sosyal sinyal insanın üzerinde olmalı, kenardaki bir etikette değil.
    expect(VP).toMatch(/\.voice-peer\.speaking \.voice-peer-big-avatar/);
  });

  it('ekran okuyucu konuşmayı YİNE duyurur', () => {
    // Çipi kaldırmak erişilebilirlik bilgisini KAYBETTİRMEZ.
    expect(VP).toMatch(/vp-sr-only/);
    expect(VP).toMatch(/aria-live="polite"/);
    expect(VP).toMatch(/voice_speaking/);
  });

  it('paylaşım ve kamera METİN ÇİPİ değil İKON', () => {
    expect(VP).not.toMatch(/peer-sharing-badge/);
    expect(VP).not.toMatch(/peer-video-badge/);
    expect(VP).toMatch(/peer-state-icon/);
  });

  it('durum ikonları ERİŞİLEBİLİR ADA sahiptir', () => {
    // İkona indirgemek, ekran okuyucu kullanıcısını bilgisiz bırakmamalı.
    const icons = VP.match(/class="peer-state-icon"[^>]*/g) ?? [];
    expect(icons.length).toBeGreaterThanOrEqual(2);
    for (const tag of icons) expect(tag).toMatch(/aria-label=/);
  });

  it('"(You)" SABİT KODLU değil', () => {
    expect(VP).not.toMatch(/\(You\)/);
    expect(VP).toMatch(/voice_tile_you/);
  });
});
