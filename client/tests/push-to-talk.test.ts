// client/tests/push-to-talk.test.ts
//
// BAS-KONUŞ (PUSH-TO-TALK)
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK — ÇALIŞAN AMA ERİŞİLEMEYEN ÖZELLİK
// ════════════════════════════════════════════════════════════════════════════
// Mekanizma eksiksizdi: `VoicePTTController` hold/toggle modları, tuş yakalama,
// `bridgePTT` kalıcılığı ve metin alanı bastırması hepsi çalışıyordu. Ama
// HİÇBİR ÜRETİM ARAYÜZÜ onu açmıyordu:
//
//   · `setPttEnabled` registry'de kayıtlı → çağıran YOK
//   · `BridgePTT.setEnabled` export       → çağıran YOK
//   · `setPttMode` export edilmiş         → registry'ye KAYDEDİLMEMİŞ
//   · tuş atama arayüzü                    → YOK
//
// Kullanıcı bas-konuşu geliştirici konsolu olmadan AÇAMIYORDU.
//
// İKİNCİ BİR BULGU: denetleyici YALNIZCA ses sahnesi açıldığında mount edilir.
// Ayarlar yalnızca registry üzerinden yazsaydı, bas-konuş ancak ZATEN bir
// aramadayken yapılandırılabilirdi. Bu yüzden kalıcılık `voice/ptt-settings.ts`
// modülüne ayrıldı — projedeki `input-sensitivity.ts` deseninin aynısı:
//
//   · DAVRANIŞ sahibi  → VoicePTTController (tuş dinleme, mute çağrıları)
//   · KALICILIK sahibi → voice/ptt-settings.ts (tek anahtar: `bridgePTT`)
//
// Bu paketteki EN ÖNEMLİ test `üretim yolunda ERİŞİLEBİLİR` olanıdır: önceki
// durumda çalışan kod + sıfır çağıran vardı ve hiçbir birim testi bunu
// yakalamıyordu.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import PushToTalkControl from '../js/core/voice/PushToTalkControl.svelte';

const CLIENT = join(__dirname, '..');
const CTRL   = readFileSync(join(CLIENT, 'js', 'core', 'VoicePTTController.svelte'), 'utf8');
const PANEL  = readFileSync(join(CLIENT, 'js', 'core', 'VoicePanel.svelte'), 'utf8');
const TAB    = readFileSync(join(CLIENT, 'js', 'core', 'settings', 'tabs', 'DevicesTab.svelte'), 'utf8');
const SRC    = readFileSync(join(CLIENT, 'js', 'core', 'voice', 'PushToTalkControl.svelte'), 'utf8');

/** Açıklama bloklarını çıkarır — yorum metni korumanın kendisini tetiklemesin. */
const codeOf = (src: string): string =>
  src.slice(src.indexOf('<script'))
    .split(/\r?\n/)
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const seed = (v: Record<string, unknown>): void =>
  localStorage.setItem('bridgePTT', JSON.stringify({
    mode: 'hold', key: null, releaseDelay: 200, ...v,
  }));

const stored = (): Record<string, never> => {
  try { return JSON.parse(localStorage.getItem('bridgePTT') ?? '{}'); }
  catch { return {} as Record<string, never>; }
};

beforeEach(() => {
  // Varsayılan senaryo: VoicePanel mount EDİLMEMİŞ — kullanıcı bir aramada değil.
  for (const k of ['getPttStatus', 'isPttCapturing', 'setPttEnabled',
                   'setPttMode', 'startPttKeyCapture', 'clearPttKey']) {
    BridgeRegistry.unregister?.(`voicePanel:${k}`);
  }
  localStorage.removeItem('bridgePTT');
});

// ════════════════════════════════════════════════════════════════════════════
describe('üretim yolunda ERİŞİLEBİLİR', () => {
  it('Ayarlar → Cihazlar GERÇEKTEN bir PTT kontrolü barındırır', () => {
    // Asıl kusur buydu: çalışan kod, SIFIR üretim çağıranı.
    expect(TAB).toMatch(/import PushToTalkControl from/);
    expect(TAB).toMatch(/<PushToTalkControl \/>/);
  });

  it('mod seçimi registry içinde KAYITLIDIR', () => {
    // `setPttMode` export ediliyordu ama kaydedilmemişti: hiçbir arayüzden
    // erişilebilir değildi.
    expect(PANEL).toMatch(/register\('voicePanel:setPttMode'/);
    expect(PANEL).toMatch(/unregister\?\.\('voicePanel:setPttMode'\)/);
  });

  it('kalıcılık KANONİK ayar modülünden geçer — ikinci depo YOK', () => {
    const code = codeOf(SRC);
    expect(code).toMatch(/from '\.\/ptt-settings\.ts'/);
    expect(code).not.toMatch(/localStorage/);
  });

  it('DAVRANIŞ sahibi devralınmaz', () => {
    const code = codeOf(SRC);
    // Mikrofonu bu bileşen AÇIP KAPATMAZ; bu `VoicePTTController` işidir.
    expect(code).not.toMatch(/setMuted/);
    // PTT tuşunu sürekli DİNLEMEZ — yalnızca yapılandırma sırasında yakalar.
    expect(code).not.toMatch(/addEventListener\('keyup'/);
  });

  it('denetleyici mount edilmişse ONUN kanonik yakalaması kullanılır', () => {
    expect(SRC).toMatch(/BridgeRegistry\.has\('voicePanel:startPttKeyCapture'\)/);
    expect(SRC).toMatch(/BridgeRegistry\.call\('voicePanel:startPttKeyCapture'\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yapılandırma', () => {
  it('etkinleştirme KALICI olur', async () => {
    const { container } = render(PushToTalkControl);
    await fireEvent.click(container.querySelector('input[type="checkbox"]')!);
    expect(stored().enabled).toBe(true);
  });

  it('devre dışı bırakma da çalışır', async () => {
    seed({ enabled: true });
    const { container } = render(PushToTalkControl);
    await fireEvent.click(container.querySelector('input[type="checkbox"]')!);
    expect(stored().enabled).toBe(false);
  });

  it('ARAMA DIŞINDA da yapılandırılabilir', () => {
    // Registry boş → VoicePanel yok. Kullanıcı bas-konuşu aramaya girmeden
    // hazırlayabilmelidir; aksi halde ayarı ancak konuşurken açabilirdi.
    const { container } = render(PushToTalkControl);
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled)
      .toBe(false);
  });

  it('mod seçenekleri yalnızca ETKİNKEN görünür', () => {
    seed({ enabled: false });
    const { container } = render(PushToTalkControl);
    expect(container.querySelectorAll('.ptt-mode')).toHaveLength(0);
  });

  it('HOLD ve TOGGLE modları seçilebilir', async () => {
    seed({ enabled: true });
    const { container } = render(PushToTalkControl);
    const modes = [...container.querySelectorAll('.ptt-mode')] as HTMLElement[];
    expect(modes).toHaveLength(2);
    await fireEvent.click(modes[1]);
    expect(stored().mode).toBe('toggle');
  });

  it('seçili mod RENKTEN başka işaret taşır', () => {
    seed({ enabled: true, mode: 'hold' });
    const { container } = render(PushToTalkControl);
    const selected = container.querySelector('.ptt-mode.selected');
    expect(selected).toBeTruthy();
    expect(selected?.getAttribute('aria-checked')).toBe('true');
  });

  it('atanmış tuş GÖRÜNÜR', () => {
    seed({ enabled: true, key: { code: 'KeyV', label: 'V' } });
    const { container } = render(PushToTalkControl);
    expect(container.querySelector('.ptt-key-display')?.textContent?.trim()).toBe('V');
  });

  it('tuş yakalanır ve KALICI olur', async () => {
    seed({ enabled: true });
    const { container } = render(PushToTalkControl);
    await fireEvent.click([...container.querySelectorAll('.ptt-btn')][0] as HTMLElement);
    await fireEvent.keyDown(document, { code: 'KeyV', key: 'v' });
    expect(stored().key).toEqual({ code: 'KeyV', label: 'V' });
  });

  it('Escape yakalamayı İPTAL eder — bağlama DEĞİŞMEZ', async () => {
    seed({ enabled: true, key: { code: 'KeyV', label: 'V' } });
    const { container } = render(PushToTalkControl);
    await fireEvent.click([...container.querySelectorAll('.ptt-btn')][0] as HTMLElement);
    await fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
    expect(stored().key).toEqual({ code: 'KeyV', label: 'V' });
  });

  it('tuş temizlenebilir — yalnızca atanmışken', async () => {
    seed({ enabled: true, key: { code: 'KeyV', label: 'V' } });
    const { container } = render(PushToTalkControl);
    const btns = [...container.querySelectorAll('.ptt-btn')] as HTMLElement[];
    expect(btns).toHaveLength(2);
    await fireEvent.click(btns[1]);
    expect(stored().key).toBeNull();
  });

  it('yarım yapılandırma SESSİZ kalmaz', () => {
    // Açık ama tuşsuz PTT çalışmaz; kullanıcı bunu bilmeli.
    seed({ enabled: true, key: null });
    const { container } = render(PushToTalkControl);
    expect(container.querySelector('.ptt-warn')).toBeTruthy();
  });

  it('BOZUK kayıt mikrofonu AÇIK bırakmaz', () => {
    localStorage.setItem('bridgePTT', '{bozuk');
    const { container } = render(PushToTalkControl);
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked)
      .toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('denetleyici sözleşmesi', () => {
  it('TUŞ TEKRARI toggle modunu defalarca çevirmez', () => {
    // `hold` `status.active` ile korunuyordu; `toggle` KORUNMUYORDU —
    // tuşu basılı tutmak sesi sürekli açıp kapatıyordu.
    expect(CTRL).toMatch(/if \(e\.repeat\) return;/);
  });

  it('metin alanlarında PTT tetiklenmez', () => {
    // Composer, arama, ayar alanları, komut paleti, modal metin alanları.
    expect(CTRL).toMatch(/tag === 'INPUT'/);
    expect(CTRL).toMatch(/tag === 'TEXTAREA'/);
    expect(CTRL).toMatch(/isContentEditable/);
  });

  it('HOLD: tuş bırakınca yeniden susturulur', () => {
    expect(CTRL).toMatch(/_onKeyUp[\s\S]{0,400}_scheduleRelease\(status\.releaseDelay\)/);
  });

  it('Escape tuş yakalamayı İPTAL eder', () => {
    expect(CTRL).toMatch(/e\.code === 'Escape'[\s\S]{0,60}stopCapture\(\)/);
  });

  it('yakalama diğer Bridge kısayollarını TETİKLEMEZ', () => {
    expect(CTRL).toMatch(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/);
    expect(CTRL).toMatch(/addEventListener\('keydown', _captureHandler as EventListener, true\)/);
  });

  it('yakalama dinleyicisi HER ZAMAN sökülür', () => {
    expect(CTRL).toMatch(/onDestroy\([\s\S]{0,400}stopCapture\(\)/);
  });

  it('kalıcılık kanonik modüle DELEGE edilir', () => {
    expect(CTRL).toMatch(/from '\.\/voice\/ptt-settings\.ts'/);
    expect(CTRL).toMatch(/savePttSettings\(/);
    expect(CTRL).toMatch(/loadPttSettings\(\)/);
  });

  it('geçici "şu an basılı" durumu KALICI olmaz', () => {
    // Aksi halde yeniden yüklemede mikrofon açık kalabilirdi.
    const settings = readFileSync(join(CLIENT, 'js', 'core', 'voice', 'ptt-settings.ts'), 'utf8');
    const save = settings.slice(settings.indexOf('export function savePttSettings'));
    expect(save).not.toMatch(/active/);
  });

  it('DIŞARIDAN yapılan değişiklik denetleyiciye ulaşır', () => {
    // Ayarlarda tuş değişirse mount edilmiş denetleyici bayat kalmamalı.
    expect(CTRL).toMatch(/_onExternalChange/);
    expect(CTRL).toMatch(/addEventListener\(PTT_CHANGED_EVENT, _onExternalChange\)/);
    expect(CTRL).toMatch(/removeEventListener\(PTT_CHANGED_EVENT, _onExternalChange\)/);
  });

  it('HER mutasyon bildirim yapar — bayat arayüz olmaz', () => {
    // Eskiden yalnızca `setEnabled` bildiriyordu; mod/tuş değişimi sessizdi.
    for (const fn of ['setMode', 'clearKey', 'setReleaseDelay']) {
      const block = CTRL.slice(CTRL.indexOf(`export function ${fn}`));
      expect(block.slice(0, 300), fn).toMatch(/_notify\(\)|_save\(\)/);
    }
  });

  it('devre dışı bırakma etkin yayını DURDURUR', () => {
    // PTT kapatılırken hâlâ konuşuyorsa mikrofon açık kalmamalı.
    const block = CTRL.slice(CTRL.indexOf('export function setEnabled'));
    expect(block.slice(0, 200)).toMatch(/if \(!on && status\.active\) _mute\(\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ayar modülü', () => {
  const settings = readFileSync(join(CLIENT, 'js', 'core', 'voice', 'ptt-settings.ts'), 'utf8');

  it('mevcut depolama anahtarını KORUR', () => {
    // Anahtar değişseydi kullanıcıların kayıtlı tercihi sessizce kaybolurdu.
    expect(settings).toMatch(/PTT_STORAGE_KEY = 'bridgePTT'/);
  });

  it('bozuk kayıt FAIL-SAFE davranır', () => {
    expect(settings).toMatch(/catch \{\s*\n?\s*return \{ \.\.\.PTT_DEFAULTS \};/);
    // `enabled` yalnızca gerçek `true` ile açılır.
    expect(settings).toMatch(/enabled: raw\.enabled === true/);
  });

  it('değişiklik sinyali TEK bir yerden yayılır', () => {
    expect(settings).toMatch(/PTT_CHANGED_EVENT = 'bridge:ptt-changed'/);
    expect(settings).toMatch(/dispatchEvent\(new CustomEvent\(PTT_CHANGED_EVENT\)\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('i18n ve erişilebilirlik', () => {
  it('metinler i18n içinden gelir — sabit kod YOK', () => {
    const markup = SRC.slice(SRC.indexOf('<section class="ptt"'), SRC.indexOf('<style>'));
    expect(markup).toMatch(/t\('ptt_title'/);
    expect(markup).toMatch(/t\('ptt_enable'/);
    expect(markup).not.toMatch(/>(Bas-konuş|Push-to-talk)</);
  });

  it('anahtarlar HER İKİ dilde tanımlıdır', () => {
    const need = ['ptt_title', 'ptt_hint', 'ptt_enable', 'ptt_mode', 'ptt_mode_hold',
                  'ptt_mode_toggle', 'ptt_key', 'ptt_key_none', 'ptt_key_change',
                  'ptt_key_set', 'ptt_key_clear', 'ptt_capturing', 'ptt_needs_key',
                  'ptt_unavailable'];
    for (const loc of ['en', 'tr']) {
      const table = readFileSync(join(CLIENT, 'js', 'core', 'i18n', `${loc}.ts`), 'utf8');
      for (const k of need) expect(table, `${loc}: ${k}`).toMatch(new RegExp(`'${k}':`));
    }
  });

  it('mod seçimi radiogroup semantiği taşır', () => {
    expect(SRC).toMatch(/role="radiogroup"/);
    expect(SRC).toMatch(/role="radio"/);
    expect(SRC).toMatch(/aria-checked=/);
  });

  it('yakalama durumu ekran okuyucuya DUYURULUR', () => {
    expect(SRC).toMatch(/aria-live="polite"/);
  });

  it('odak GÖRÜNÜR', () => {
    expect(SRC).toMatch(/:focus-visible/);
    expect(SRC).toMatch(/outline: 2px solid var\(--focus-ring\)/);
  });

  it('sabit renk ve sihirli z-index YOK', () => {
    const css = SRC.slice(SRC.indexOf('<style>'));
    expect(css).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(css).not.toMatch(/z-index:\s*\d+/);
  });

  it('hareket azaltma tercihine saygı duyar', () => {
    expect(SRC).toMatch(/prefers-reduced-motion: no-preference/);
  });

  it('dokunmatik cihazda DÜRÜSTÇE bozulur', () => {
    // Fiziksel klavye yoksa çalışıyormuş gibi gösterilmez.
    expect(SRC).toMatch(/pointer: coarse/);
    expect(SRC).toMatch(/ptt_unavailable/);
  });
});
