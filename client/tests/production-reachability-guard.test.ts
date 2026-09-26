// client/tests/production-reachability-guard.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÜRETİM ULAŞILABİLİRLİĞİ SESSİZCE DEĞİŞMEMELİ
// ════════════════════════════════════════════════════════════════════════════
// İki yönlü bir kapı:
//
//   1. BAĞLI bir özellik sessizce KOPARILAMAZ. `js/app.ts` içindeki bir
//      import kaldırılırsa (veya tree-shaking'e kurban giderse) o özellik
//      üründen çıkar ama hiçbir test düşmezdi — bu tam olarak daha önce
//      yaşanmış bir arıza sınıfı (bkz. app.ts:31 civarındaki `socket-svelte`
//      notu: yan etki import'u silinince gerçek zamanlı HER ŞEY sessizce
//      ölmüştü).
//
//   2. YENİ bir ölü modül sessizce EKLENEMEZ. Ulaşılamayan dosya listesi
//      BİLİNEN bir kümedir; büyürse birileri paketlenmeyen kod yazmış
//      demektir ve bu bilinçli bir karar olmalıdır.
//
// ── NEDEN SABİT LİSTE DEĞİL DE KÜME KARŞILAŞTIRMASI ───────────────────────
// Sabit bir SAYI ("42 olmalı") her yeni dosyada kırılır ve insanlar sayıyı
// güncellemeyi öğrenir — kapı ölür. Bunun yerine ADLARI karşılaştırılır:
// beklenen ölü küme açıkça yazılıdır, yeni bir ad görünürse test o adı
// söyleyerek düşer.
//
// ── ÖLÇÜM ARACININ KENDİSİ DE TEST EDİLİR ─────────────────────────────────
// Bu kapının dayandığı tarayıcı bir kez YANLIŞ NEGATİF üretti (yorum içindeki
// kesme işaretleri gerçek import'ları yutuyordu). Aşağıdaki ilk blok
// tarayıcının bu sınıfa karşı bağışık olduğunu doğrular.

import { describe, it, expect, vi } from 'vitest';
// ── KAYNAK TARAMASI G/Ç BAĞLIDIR ────────────────────────────────────────────
// Bu dosyadaki testler istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik
// VARSAYILAN zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir
// makinede aşılabilir; ölçüm bitmeden test kırmızıya döner ve bu, ürün hakkında
// HİÇBİR ŞEY söylemeyen bir kırılganlıktır. Sözleşme taramanın SONUCUNDA
// olduğu için bu dosyaya açık ve cömert bir zaman aşımı verilir. Hiçbir iddia
// gevşetilmemiştir; yalnızca zamanlama gürültüsü kaldırılmıştır.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scanner = require('../scripts/production-reachable-coverage.js');

const CLIENT: string = scanner.CLIENT;
const rel = (p: string): string => path.relative(CLIENT, p).split(path.sep).join('/');

const reachable = new Set<string>([...scanner.reachableSet()].map((p) => rel(p as string)));

/**
 * Enumerate the same production-source domain as `coverage.include` without
 * consulting `coverage-final.json`. During a coverage run that file is written
 * only after tests finish, so reading it here can silently validate yesterday's
 * source set and expose a new unwired module only on the next invocation.
 */
function productionSources(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()
        && (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte'))
        && !entry.name.endsWith('.d.ts')) found.push(rel(absolute));
    }
  };
  walk(path.join(CLIENT, 'js'));
  return found.sort();
}

// ════════════════════════════════════════════════════════════════════════════
describe('tarayıcı doğruluğu', () => {
  it('YORUM içindeki kesme işaretleri gerçek import’u YUTMAZ', () => {
    // Bu, tarayıcıda bulunan gerçek kusurun birebir yeniden üretimidir.
    const tricky = [
      "// Bu yorumda from kelimesi var ve Turkce bir kesme isareti: socket'in",
      "// ikinci satirda da bir kesme var: kullanici'nin",
      "import { X } from './hedef.ts';",
    ].join('\n');
    const stripped: string = scanner.stripComments(tricky);
    expect(stripped).not.toContain('kesme isareti');
    expect(stripped).toContain("from './hedef.ts'");
  });

  it('dize İÇİNDEKİ `//` yorum sanılmaz', () => {
    const code = "const url = 'https://example.com/x'; import y from './y.ts';";
    const stripped: string = scanner.stripComments(code);
    expect(stripped).toContain('https://example.com/x');
    expect(stripped).toContain("from './y.ts'");
  });

  it('blok yorum satır numaralarını korur', () => {
    const code = '/*\n\n*/\nimport a from "./a.ts";';
    const stripped: string = scanner.stripComments(code);
    expect(stripped.split('\n').length).toBe(code.split('\n').length);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kritik özellikler ÜRETİM PAKETİNDE kalmalı', () => {
  // Her biri kullanıcıya görünen bir yüzeydir. Biri listeden düşerse özellik
  // üründen çıkmış demektir — testin adı hangisi olduğunu söyler.
  const MUST_BE_BUNDLED = [
    'js/app.ts',
    'js/core/socket-svelte.ts',            // gerçek zamanlı her şey
    'js/core/auth-compat.ts',              // giriş/oturum
    'js/core/api-fetch.ts',                // TEK HTTP istemcisi
    'js/core/refresh-coordinator.ts',      // sekmeler arası token yenileme
    'js/core/state-svelte.ts',             // uygulama durumu
    'js/core/webauthn-svelte.ts',          // passkey (kanonik sahip)
    'js/core/discover-svelte.ts',          // Keşfet (auto-mount shim)
    'js/core/DiscoverPanel.svelte',
    'js/core/channel-stage-svelte.ts',     // Stage (kanonik sahip)
    'js/core/ChannelStagePanel.svelte',
    'js/core/stickers/StickerPanel.svelte',// Sticker (kanonik sahip)
    'js/core/a11y/focusTrap.ts',           // erişilebilirlik odak tuzağı
    'js/core/i18n/index.ts',               // yerelleştirme
    'js/core/dead-control-guard.ts',       // ölü düğme koruması
    'js/core/error-boundary-svelte.ts',
    'js/webrtc-sfu.ts',                    // SFU signaling/fallback engine must stay in production graph
  ];

  it.each(MUST_BE_BUNDLED)('%s ulaşılabilir', (file) => {
    expect(reachable.has(file)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('süperseded ikizler RELEASE TREE içinde kalmamalı', () => {
  const REMOVED: Array<[string, string]> = [
    ['js/webauthn.ts',              'js/core/webauthn-svelte.ts'],
    ['js/discover.ts',              'js/core/discover-svelte.ts'],
    ['js/core/StagePanel.svelte',   'js/core/ChannelStagePanel.svelte'],
    ['js/core/stage-svelte.ts',     'js/core/channel-stage-svelte.ts'],
    ['js/core/StickerPanel.svelte', 'js/core/stickers/StickerPanel.svelte'],
    ['js/core/FocusTrap.svelte',    'js/core/a11y/focusTrap.ts'],
    ['js/core/i18n.ts',             'js/core/i18n/index.ts'],
    ['js/marketplace.ts',           'js/core/bot-marketplace/bot-marketplace-svelte.ts'],
    ['js/polls.ts',                 'js/core/polls-svelte.ts'],
    ['js/profile.ts',               'js/core/member-profile-svelte.ts'],
    ['js/threads.ts',               'js/core/thread-svelte.ts'],
    ['js/twoFactor.ts',             'js/core/settings/tabs/SecurityTab.svelte'],
  ];

  it.each(REMOVED)('%s silinmiş, kanonik %s ulaşılabilir', (legacy, canonical) => {
    expect(fs.existsSync(path.join(CLIENT, legacy))).toBe(false);
    expect(reachable.has(canonical)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('production source graph tamamen kanonik olmalı', () => {
  it('runtime owner olmayan source modülü kalmamalı', () => {
    // Release tree'deki her production implementation bir canonical owner'a
    // ulaşmalı; KNOWN_UNWIRED gibi kalıcı istisnalar dead-code'u saklamamalı.
    const measured = productionSources();
    const unwired = measured.filter((f) => !reachable.has(f)).sort();
    expect(unwired).toEqual([]);
  });
});
