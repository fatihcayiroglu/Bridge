// client/tests/no-phantom-features.test.ts
//
// FAZ K+/3 — HAYALET ÖZELLİK MUHAFIZI.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU PAKET VAR
// ════════════════════════════════════════════════════════════════════════════
// Bu depodaki en tekrar eden kusur, kodun ÇALIŞMAMASI değil; ULAŞILAMAMASI.
// Aynı hikâye defalarca yaşandı:
//
//   • `SearchPanel`      — gerçek uygulama, hiçbir girişten import edilmiyor
//   • `DiscoverPanel`    — 798 satır, açacak kontrol yok
//   • `GlobalSearch`     — sunucu ucu hazır, istemcide TEK çağıran yok
//   • `NotificationPrefs`— 50 satırlık BOŞ kabuk, ürün "var" görünüp yoktu
//   • `ModerationPanel`  — 51 satırlık BOŞ kabuk, uçlar tamamen hazırdı
//
// İki ayrı hastalık var ve ikisi de "dosya mevcut" diye gözden kaçıyor:
//
//   1. DORMANT   — gerçek uygulama, ulaşılamıyor.
//   2. PHANTOM   — dosya bir özelliğin ADINI taşıyor ama İÇİ BOŞ:
//                  ~51 satır, sıfır API çağrısı, yalnızca `showX`/`hideX`.
//
// Bu paket ikisini de ÖLÇER ve mevcut sayıyı KİLİTLER. Amaç geçmişi bir
// gecede temizlemek değil; SESSİZCE BÜYÜMESİNİ durdurmak. Sayı düşerse test
// yeni (daha düşük) sınırı ister — ilerleme geri alınamaz hale gelir.

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
import { fileURLToPath } from 'url';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(CLIENT, 'js/core');

/** Üretim giriş noktaları (scripts/build.js ENTRY_POINTS ile aynı köken). */
const ENTRIES = ['js/app.ts', 'js/plugin-marketplace-page.ts'];

// ── kaynak haritası ────────────────────────────────────────────────────────
const sources = new Map<string, string>();
(function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|svelte)$/.test(entry.name)) {
      sources.set(path.relative(CLIENT, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'));
    }
  }
})(path.join(CLIENT, 'js'));

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.join(path.posix.dirname(from), spec);
  for (const candidate of [
    base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.svelte`,
    base.replace(/\.ts$/, '.svelte'), `${base}/index.ts`,
  ]) {
    if (sources.has(candidate)) return candidate;
  }
  return null;
}

/** Giriş noktalarından ulaşılabilen dosya kümesi. */
const reachable = (() => {
  const seen = new Set<string>();
  const queue = ENTRIES.filter(e => sources.has(e));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = sources.get(file) ?? '';
    // DİNAMİK import da sayılır: ayarlar modalı `await import(...)` ile
    // yüklenir ve yalnızca statik `from '...'` aranırsa ULAŞILAMAZ görünür.
    // Bu tam olarak ölçüm hatasıdır — özellik ulaşılabilirken hayalet sanılır.
    const patterns = [
      /from\s+['"]([^'"]+)['"]/g,
      /(?:^|[^\w.])import\s+['"]([^'"]+)['"]/g,
      /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of src.matchAll(pattern)) {
        const target = resolveImport(file, match[1] || '');
        if (target) queue.push(target);
      }
    }
  }
  return seen;
})();

/**
 * PHANTOM tanımı — üçü BİRDEN doğruysa.
 *
 * Eşik gevşek tutuldu: gerçek ama küçük bir bileşeni yanlışlıkla suçlamaktansa
 * birkaç hayaleti kaçırmak yeğdir. Kilitlenen sayı yalnızca KESİN olanlardır.
 */
function isPhantom(src: string): boolean {
  const lines = src.split('\n').length;
  const talksToServer = /apiFetch|\/api\//.test(src);
  // Yalnızca görünürlük anahtarları: `showX` / `hideX` ve başka hiçbir şey.
  const registrations = [...src.matchAll(/BridgeRegistry\.register\(\s*['"]([^'"]+)/g)].map(m => m[1]!);
  const onlyVisibility = registrations.length > 0
    && registrations.every(k => /^(show|hide)[A-Z]/.test(k));
  return lines <= 60 && !talksToServer && onlyVisibility;
}

const components = [...sources.keys()].filter(f => /^js\/core\/[A-Z][A-Za-z0-9]*\.svelte$/.test(f));

const phantoms = components.filter(f => isPhantom(sources.get(f)!));
const dormantPhantoms = phantoms.filter(f => !reachable.has(f));
const reachablePhantoms = phantoms.filter(f => reachable.has(f));

// ── KİLİTLENEN SAYILAR ─────────────────────────────────────────────────────
//
// Bunlar HEDEF değil, TAVAN.
//
// FAZ 0.5 TEMİZLİĞİ SONRASI ölçüm (59 bileşen, 14 hayalet):
//   ulaşılamayan hayalet :  4   (önce 76)
//   ULAŞILABİLİR hayalet : 10   (önce 10 — bunlar SİLİNEMEDİ, aşağıya bak)
//
// Temizlik öncesi: 131 bileşen, 86 hayalet. 88 dosya + 65 yetim mount shim
// kaldırıldı; her biri altı bağımsız kanıt kontrolünden geçti (statik import,
// dinamik import, registry tüketicisi, olay tüketicisi, HTML referansı, test).
//
// ── FAZ K+/7: ULAŞILABİLİR HAYALETLER 10 → 0 ─────────────────────────────
// Önceki not "shim'ler gerçek yardımcılar da dışa aktarıyor, o yüzden
// silinemez" diyordu. Yardımcılar TEK TEK incelendiğinde bu doğru ÇIKMADI:
//
//   getAPI                  → `globals.ts`teki kanonik sürümün BİREBİR
//                             kopyasıydı; app.ts kanonik olana bağlandı.
//   bindGroupDmSocketEvents → `BridgeRegistry.get('bindGroupDmSocketEvents')`
//                             arıyordu; bu anahtarı KİMSE kaydetmiyor. Grup
//                             DM olayları zaten GroupDmPanel'in kendi
//                             `syncSocketBinding()` fonksiyonunda bağlanır.
//   onNativePushLogin       → boş kabuğu mount ediyordu (NO-OP)
//   initStageVideoGrid      → boş kabuğu mount ediyordu (NO-OP)
//   applyBoostFeatures      → boş kabuğu mount ediyordu, tüketicisi de yok
//
// Yani "yardımcı" sanılan beş fonksiyondan dördü hiçbir şey yapmıyordu.
// 10 boş bileşen + 10 mount shim kaldırıldı; her birinin `showX` kaydı için
// çağıran sayısı ÖLÇÜLDÜ ve hepsi 0'dı.
//
// Kaybolan ÖZELLİKLER sessizce silinmedi — Sprint 116'da asıl uygulamalar
// `_archived_legacy/` altına alınmıştı ve bu durum
// docs/PHANTOM_COMPONENT_FINAL_AUDIT.md içinde ABSENT olarak kayıtlıdır.
// TAVAN ÖLÇÜLEN DEĞERE İNDİRİLDİ.
// Ölçüm: dormant=0, reachable=0. Tavan 4'te bırakılınca "ilerleme geri
// alınamaz" testi haklı olarak kırılıyordu: temizlik yapılmış ama tavan
// gevşek kalmıştı, yani dört hayalet sessizce geri sızabilirdi.
const MAX_DORMANT_PHANTOMS = 0;
const MAX_REACHABLE_PHANTOMS = 0;

describe('hayalet özellik envanteri', () => {
  it('ulaşılamayan hayaletlerin sayısı ARTMAZ', () => {
    expect(dormantPhantoms.length).toBeLessThanOrEqual(MAX_DORMANT_PHANTOMS);
  });

  it('ULAŞILABİLİR hayaletlerin sayısı ARTMAZ', () => {
    // Bunlar mount edilir, bayt harcar ve hiçbir şey yapmaz.
    expect(reachablePhantoms.length).toBeLessThanOrEqual(MAX_REACHABLE_PHANTOMS);
  });

  it('sayı DÜŞTÜĞÜNDE tavan da düşürülmelidir (ilerleme geri alınamaz)', () => {
    // Bu test kasten "gevşek kalmış tavan"ı yakalar: temizlik yapıldığında
    // sabitler güncellenmezse hayaletler sessizce geri sızabilir.
    expect(MAX_DORMANT_PHANTOMS - dormantPhantoms.length).toBeLessThanOrEqual(2);
    expect(MAX_REACHABLE_PHANTOMS - reachablePhantoms.length).toBeLessThanOrEqual(2);
  });
});

describe('bu fazda ulaşılır kılınan yüzeyler GERİ UYUMAZ', () => {
  // Her biri gerçek bir kullanıcı yeteneğidir ve bir kez daha
  // "dosya var ama ürün yok" durumuna düşmemelidir.
  const mustBeReachable = [
    ['js/core/GlobalSearchPanel.svelte',       'küresel arama'],
    ['js/core/EmojiPickerPanel.svelte',        'composer emoji seçici'],
    ['js/core/NotificationPrefsPanel.svelte',  'bildirim tercihleri'],
    ['js/core/server-settings/tabs/ModerationTab.svelte', 'moderasyon'],
    ['js/core/permalink/permalink-router.ts',  'mesaj kalıcı bağlantıları'],
  ] as const;

  for (const [file, label] of mustBeReachable) {
    it(`${label} üretim girişinden ULAŞILABİLİR`, () => {
      expect(sources.has(file), `${file} bulunamadı`).toBe(true);
      expect(reachable.has(file), `${file} hiçbir girişten ulaşılamıyor`).toBe(true);
    });

    it(`${label} BOŞ KABUK DEĞİLDİR`, () => {
      // "Ulaşılabilir" yetmez: `NotificationPrefsPanel` ulaşılabilir olsaydı
      // bile 50 satırlık boş kabuk olarak kullanıcıya hiçbir şey vermezdi.
      expect(isPhantom(sources.get(file)!)).toBe(false);
    });
  }
});

describe('yeni panellerin gerçek bir açıcısı vardır', () => {
  /** Kabuk düğmesi, komut paleti ya da başka ulaşılabilir bir çağıran. */
  function hasOpener(key: string, self: string): boolean {
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
    if (html.includes(`data-bridge-action="${key}"`) || html.includes(`id="btn-emoji"`)) {
      if (html.includes(`data-bridge-action="${key}"`)) return true;
    }
    for (const [file, src] of sources) {
      if (file === self || !reachable.has(file)) continue;
      if (src.includes(`'${key}'`) || src.includes(`"${key}"`)) return true;
    }
    return false;
  }

  it('küresel arama açılabilir', () => {
    expect(hasOpener('openGlobalSearch', 'js/core/GlobalSearchPanel.svelte')).toBe(true);
  });

  it('bildirim tercihleri açılabilir', () => {
    expect(hasOpener('openNotificationPrefs', 'js/core/NotificationPrefsPanel.svelte')).toBe(true);
  });

  it('emoji seçicinin kabukta düğmesi vardır', () => {
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
    expect(html).toMatch(/id="btn-emoji"/);
    // İkon-only düğme ekran okuyucuda adsız kalmamalı.
    expect(html.match(/<button[^>]*id="btn-emoji"[^>]*>/)?.[0]).toMatch(/aria-label="[^"]+"/);
  });

  it('moderasyon sekmesi ayarlar modalına KAYITLIDIR', () => {
    const modal = sources.get('js/core/server-settings/ServerSettingsModal.svelte')!;
    expect(modal).toMatch(/id: 'moderation'/);
    expect(modal).toMatch(/<ModerationTab \/>/);
  });
});

describe('teşhis çıktısı', () => {
  it('envanteri raporlar (başarısızlıkta bakılacak yer)', () => {
    // Sayılar rapor edilebilir olmalı; bu test bilgi amaçlıdır.
    //
    // Bu alt sınır, TARAMANIN ÇALIŞTIĞINI kanıtlar: yol çözümü bozulursa
    // `components` boşalır ve yukarıdaki tüm hayalet kontrolleri sessizce
    // "0 hayalet" diye GEÇERDİ. Eşik 50 idi; Faz K+/7'de 10 boş bileşen
    // silinince gerçek sayı 49'a düştü — yani eşik düşürüldü çünkü SAYIM
    // AZALDI, kontrol zayıfladığı için değil.
    expect(components.length).toBeGreaterThan(40);
    expect(phantoms.length).toBe(dormantPhantoms.length + reachablePhantoms.length);
  });
});
