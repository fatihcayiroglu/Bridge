// client/tests/rtc-renegotiation.test.ts
//
// YENİDEN PAZARLIK (RENEGOTIATION)
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR (P0) — EKRAN PAYLAŞIMI KARŞI TARAFA HİÇ ULAŞMIYORDU
// ════════════════════════════════════════════════════════════════════════════
// `webrtc.ts` içinde `onnegotiationneeded` ya da herhangi bir yeniden pazarlık
// yolu YOKTU. İlk teklif/yanıt turundan SONRA `pc.addTrack(...)` çağıran her
// yol track'i YALNIZCA YEREL olarak ekliyordu; uzak taraf onu hiç öğrenmiyordu.
//
// ÖLÇÜM (iki tarayıcı, gerçek çağrı, `pc.getSenders()` / `getReceivers()`):
//
//   paylaşımdan ÖNCE   A: gönderen=audio         B: alan=audio
//   paylaşımdan SONRA  A: gönderen=audio,video   B: alan=audio      ← DEĞİŞMEDİ
//   iki taraf da       signalingState = "stable"                    ← pazarlık YOK
//
//   DÜZELTMEDEN SONRA  A: gönderen=audio,video   B: alan=audio,video ← ULAŞTI
//
// Yani ekran paylaşımı — bir Discord alternatifinin tanımlayıcı özelliği —
// izleyiciye HİÇ gitmiyordu. Aynı kusur çağrı sırasında açılan KAMERA için de
// geçerliydi. Alma tarafı hazırdı (`_handleOffer` var olan bağlantıyı yeniden
// kullanıyordu); eksik olan BAŞLATMA tarafıydı.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENT = join(__dirname, '..');
const RTC = readFileSync(join(CLIENT, 'js', 'webrtc.ts'), 'utf8');

describe('yeniden pazarlık VARDIR', () => {
  it('pazarlık başlatan bir yol bulunur', () => {
    expect(RTC).toMatch(/private async _renegotiate\(/);
    expect(RTC).toMatch(/private async _renegotiateAll\(/);
  });

  it('teklif KANONİK sinyalleşme olayıyla gönderilir', () => {
    const fn = RTC.slice(RTC.indexOf('private async _renegotiate('), RTC.indexOf('private async _renegotiateAll('));
    expect(fn).toMatch(/this\.socket\.emit\('webrtc:offer'/);
    expect(fn).toMatch(/pc\.setLocalDescription\(offer\)/);
  });

  it('pazarlık sürerken İKİNCİ teklif yapılmaz', () => {
    const fn = RTC.slice(RTC.indexOf('private async _renegotiate('), RTC.indexOf('private async _renegotiateAll('));
    // İki kontrol de gerekli: `createOffer` beklerken durum değişebilir.
    expect(fn.match(/signalingState !== 'stable'/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('ÇAKIŞMA (glare) belirlenimci biçimde çözülür', () => {
    // İki taraf aynı anda teklif ederse `setRemoteDescription` "wrong state"
    // ile patlar ve paylaşım sessizce başlamazdı.
    const fn = RTC.slice(RTC.indexOf('private async _handleOffer('));
    expect(fn).toMatch(/signalingState === 'have-local-offer'/);
    expect(fn).toMatch(/type: 'rollback'/);
  });
});

describe('track EKLEYEN her yol pazarlık yapar', () => {
  const cases: Array<[string, string, string]> = [
    ['ekran paylaşımı başlatma', 'async startScreenShare', 'stopScreenShare(): void'],
    ['ekran paylaşımı durdurma', 'stopScreenShare(): void', 'async setChannelBitrate'],
    ['paylaşım sesi sökme',      'private _detachScreenAudio', 'stopScreenShare(): void'],
    ['kamera açma',              'async enableVideo', 'private _broadcastState'],
  ];

  for (const [label, from, to] of cases) {
    it(`${label} sonrası pazarlık yapılır`, () => {
      const a = RTC.indexOf(from);
      const b = RTC.indexOf(to, a + 1);
      const block = b > a ? RTC.slice(a, b) : RTC.slice(a);
      expect(block).toMatch(/_renegotiateAll\(\)/);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
describe('paylaşım sahnesi kullanıcıyı HAPSETMEZ', () => {
  const PANEL  = readFileSync(join(CLIENT, 'js', 'core', 'VoicePanel.svelte'), 'utf8');
  const TOKENS = readFileSync(join(CLIENT, 'css', 'tokens.css'), 'utf8');

  it('paylaşım görünümünde AYRILMA kontrolü vardır', () => {
    // KAPATILAN GERÇEK KUSUR (P1): `.screen-share-view` tam ekran sabit bir
    // örtüdür ve bu çubukta ayrılma kontrolü YOKTU. Kabuktaki "her zaman
    // erişilebilir çıkış" şeridi dahil TÜM ayrılma düğmeleri örtünün altında
    // kalıyordu — ölçüm: `elementFromPoint` her biri için `VIDEO` döndürdü.
    expect(PANEL).toMatch(/id="ss-leave-btn"/);
    expect(PANEL).toMatch(/id="ss-leave-btn"[\s\S]{0,160}onclick=\{leaveVoice\}/);
  });

  it('ayrılma KANONİK eylemi çağırır — ikinci sahip YOK', () => {
    const btn = PANEL.slice(PANEL.indexOf('id="ss-leave-btn"'));
    expect(btn.slice(0, 200)).toMatch(/onclick=\{leaveVoice\}/);
  });

  it('sahne ADLANDIRILMIŞ katman kullanır — sihirli sayı yok', () => {
    const view = PANEL.slice(PANEL.indexOf('.screen-share-view {'), PANEL.indexOf('.screen-share-view.ss-mini'));
    expect(view).toMatch(/z-index: var\(--z-stage\)/);
    expect(view).not.toMatch(/z-index:\s*\d+/);
  });

  it('kalite seçici sahnenin ÜSTÜNDE açılır', () => {
    // KAPATILAN GERÇEK KUSUR (P1): seçici `--layer-modal` (300) taşıyordu,
    // sahne 1000 — seçici sahnenin ALTINDA kalıyordu ve paylaşım görünümü
    // açıkken yeni paylaşım BAŞLATILAMIYORDU.
    expect(PANEL).toMatch(/#ss-quality-modal\)? \{ z-index: var\(--z-stage-modal\)/);
  });

  it('sahne katmanları jeton olarak tanımlıdır', () => {
    expect(TOKENS).toMatch(/--z-stage:\s*\d+/);
    expect(TOKENS).toMatch(/--z-stage-modal:\s*\d+/);
  });

  it('seçici katmanı sahne katmanının ÜSTÜNDEDİR', () => {
    const stage = Number(TOKENS.match(/--z-stage:\s*(\d+)/)?.[1] ?? 0);
    const modal = Number(TOKENS.match(/--z-stage-modal:\s*(\d+)/)?.[1] ?? 0);
    expect(modal).toBeGreaterThan(stage);
  });
});
