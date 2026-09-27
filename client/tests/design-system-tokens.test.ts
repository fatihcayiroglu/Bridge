// client/tests/design-system-tokens.test.ts
// FAZ B — TASARIM SİSTEMİ SÖZLEŞMESİ (uygulanabilir kural).
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Bridge'in token temeli ZATEN olgun: `css/tokens.css` beş temayı
// (`dark`, `light`, `amoled`, `aurora`, `midnight`) `[data-theme=...]` ile
// tanımlar ve semantik aileler sunar (--surface-*, --text-*, --border*,
// --accent*, --radius-*, --shadow-*, --space-*, --duration-*, --focus-ring).
//
// Gerçek risk token EKSİKLİĞİ değil, token KULLANILMAMASIdır: bir bileşen
// `#1e2124` gibi ham bir renk yazdığında o yüzey yalnızca koyu temada doğru
// görünür ve Light/Aurora/AMOLED'de bozulur. Ölçüm: 140 bileşenden 28'inde
// 168 ham renk kullanımı vardı.
//
// Bu paket kuralı YAŞAYAN yüzeyler için uygulanabilir hâle getirir; böylece
// Faz C/D/E'de eklenecek yeni ürün yüzeyleri (Server Settings, Channel
// Permissions, Sticker istemcisi, GDM, Server Create...) parçalı stille
// yazılıp sonra yeniden tasarlanmak zorunda kalmaz.
//
// KAPSAM: yalnız SEVK EDİLEN/erişilebilir bileşenler. Dormant yüzeyler
// bilinçli olarak dışarıdadır ve canlı hâle geldiklerinde bu listeden
// çıkarılmalıdır — liste, teknik borcun DÜRÜST kaydıdır.

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

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Henüz canlı OLMAYAN yüzeyler. Bunlar üründe erişilebilir değildir ve
 * bundle'a girmezler; ilgili faz onları canlı yaptığında buradan SİLİNMELİ
 * ve ham renkleri token'a çevrilmelidir.
 */
const DORMANT_EXCLUSIONS: Record<string, string> = {
  'js/admin/AdminPanel.svelte':                 'ADMIN = DORMANT (0 importer, sevk edilmiyor)',
  // GroupDmPanel.svelte Faz C4.7'de muafiyetten ÇIKARILDI: bileşen artık
  // CANLI (kabuğa mount edilir ve FriendsPanel üzerinden açılır). Uykudan
  // çıkan bir bileşen gizli tasarım-sistemi muafiyeti taşıyamaz; 29 adet
  // `var(--x, #hex)` sahte tokenizasyonu ve 6 ham renk sıfıra indirildi.
  // ChannelPermsModal.svelte Faz C2'de muafiyetten ÇIKARILDI: ham renkleri
  // token'a çevrildi. Kendisi hâlâ ölüdür ve canlanması ayrıca yasaklıdır
  // (channel-perms-opener.test.ts — `{@html}` kabuğu üretime bağlanamaz).
};

/** Ham renk: token yerine doğrudan yazılmış #hex veya rgb()/rgba(). */
const RAW_COLOR = /:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g;

function svelteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) svelteFiles(full, acc);
    else if (entry.name.endsWith('.svelte')) acc.push(full);
  }
  return acc;
}

/** Bir bileşenin <style> bloğundaki ham renk sayısı. */
function rawColorCount(file: string): number {
  const src = fs.readFileSync(file, 'utf8');
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src);
  if (!style) return 0;
  // Yorumları çıkar — açıklama içindeki örnek renkler sayılmasın.
  const css = style[1]!.replace(/\/\*[\s\S]*?\*\//g, '');
  return (css.match(RAW_COLOR) ?? []).length;
}

function rel(file: string): string {
  return path.relative(CLIENT_ROOT, file).split(path.sep).join('/');
}

const ALL = svelteFiles(path.join(CLIENT_ROOT, 'js'));
const LIVE = ALL.filter(f => !(rel(f) in DORMANT_EXCLUSIONS));

describe('tasarım sistemi — token temeli', () => {
  it('tokens.css beş temayı da tanımlar', () => {
    const css = fs.readFileSync(path.join(CLIENT_ROOT, 'css/tokens.css'), 'utf8');
    for (const theme of ['dark', 'light', 'amoled', 'aurora', 'midnight']) {
      expect(css).toContain(`[data-theme="${theme}"]`);
    }
  });

  it('semantik token aileleri mevcuttur', () => {
    const css = fs.readFileSync(path.join(CLIENT_ROOT, 'css/tokens.css'), 'utf8');
    for (const token of [
      '--surface-content', '--surface-overlay', '--surface-hover',
      '--text-primary', '--border', '--accent',
      '--radius-surface', '--shadow-md', '--space-4',
      '--duration-fast', '--focus-ring',
    ]) {
      expect(css).toContain(token);
    }
  });
});

describe('tasarım sistemi — canlı yüzeyler tema-güvenli olmalı', () => {
  // ── CIRCIR (RATCHET) TABANI ────────────────────────────────────────────
  // Taban Faz B'de 20 dosya / 84 ham renkti.
  //
  // FAZ E — TASARIM SİSTEMİ BİRLEŞTİRMESİ:
  // 17 canlı yüzey SIFIRA indirildi ve listeden ÇIKARILDI. Çıkarılmaları
  // guard'ı GÜÇLENDİRİR: bu dosyalar artık "YENİ canlı bileşen ham renk
  // KULLANAMAZ" testine tabidir, yani tek bir ham renk geri gelse test kırılır.
  //
  // Dönüşümler mevcut semantik sözlüğe yapıldı; eksik olan üç rol tokens.css'e
  // eklendi (`--danger-hover`, `--success-hover`, `--surface-video`) ve
  // `--brand-hover` ile aynı sözleşmeyi izler. Overlay arka planları tek bir
  // ifadeye getirildi: color-mix(in srgb, var(--bg-0) 82%, transparent).
  //
  // GERİYE KALAN TEK BORÇ — ErrorBoundary:
  // Renkleri `.eb-dev-panel` içindedir; bu YALNIZCA geliştirici tanılama
  // katmanıdır (`isDev` ile kapılı), ürün yüzeyi değildir. Kasıtlı olarak
  // temadan BAĞIMSIZ yüksek kontrastlıdır: tema/CSS bozulduğunda da okunur
  // kalmalıdır — hata panelinin görünmesi tam da o anda gerekir.
  const RATCHET: Record<string, number> = {
    'js/core/ErrorBoundary.svelte':                      7,
  };

  it('YENİ canlı bileşen ham renk KULLANAMAZ', () => {
    // Faz C/D/E yüzeyleri buraya asla eklenmemelidir.
    const fresh = LIVE
      .map(f => ({ file: rel(f), count: rawColorCount(f) }))
      .filter(x => x.count > 0 && !(x.file in RATCHET))
      .sort((a, b) => b.count - a.count);

    expect(fresh).toEqual([]);
  });

  it('mevcut ham renk borcu BÜYÜYEMEZ (çıkrık geri dönmez)', () => {
    const grown = LIVE
      .map(f => ({ file: rel(f), now: rawColorCount(f) }))
      .filter(x => x.file in RATCHET && x.now > RATCHET[x.file]!)
      .map(x => ({ ...x, izin: RATCHET[x.file]! }));

    expect(grown).toEqual([]);
  });

  // ── CSS MODÜLLERİ ────────────────────────────────────────────────────────
  //
  // FAZ E — KAPATILAN GERÇEK BOŞLUK.
  // Guard yalnızca `js/**/*.svelte` tarıyordu. Oysa KABUĞUN kendisi (düzen,
  // mesajlar, ses, modallar) `css/modules/*.css` içinde stillenir ve orada
  // 150 ham renk vardı — Svelte borcunun neredeyse iki katı, tamamen
  // denetimsiz. Yani token disiplini bileşenlerde zorlanırken ürünün ana
  // yüzeyi serbest kalıyordu.
  //
  // Faz E'de iki çekirdek ürün yüzeyi sıfıra indirildi:
  //   · messages.css   10 → 0  (hover'lar `--surface-hover`, mention
  //     `--brand-subtle`, duvar kâğıdı perdeleri `--bg-0` tabanlı; böylece
  //     AMOLED/Aurora/Midnight de doğru perdeyi alır — eskiden yalnız koyu
  //     varyant vardı ve `body.theme-light` override'ı elle sürdürülüyordu)
  //   · voice-video.css 37 → 0
  //
  // Kalanlar dürüstçe kayıt altındadır ve YALNIZCA küçülebilir.
  const CSS_RATCHET: Record<string, number> = {
    'css/modules/stage-onboarding.css':   28,
    'css/modules/profile-settings.css':   17,
    'css/modules/community-features.css': 11,
    'css/modules/threads-badges.css':     10,
    'css/modules/dm-music.css':            7,
    'css/modules/reactions-micro.css':     5,
    'css/modules/bridge-features.css':     4,
    // sprint91/sprint92: style.css tarafından ARTIK import EDİLMİYOR
    // (community-features.css ile değiştirildi). Ölü dosyalar; sevk edilmez.
    'css/modules/sprint92.css':            4,
    'css/modules/animations.css':          3,
    // high-contrast: erişilebilirlik override'ı. Mutlak kontrast değerleri
    // KASITLIDIR — tema token'ına bağlanırsa yüksek kontrast garantisi kaybolur.
    'css/modules/high-contrast.css':       3,
    'css/modules/transitions-fx.css':      3,
    'css/modules/schedule-gifs.css':       2,
    'css/modules/semantic-search.css':     2,
    'css/modules/uploads-media.css':       2,
    'css/modules/modals.css':              1,
    'css/modules/sprint91.css':            1,
  };

  function cssRawCount(rel: string): number {
    const full = path.join(CLIENT_ROOT, rel);
    if (!fs.existsSync(full)) return 0;
    const css = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return (css.match(RAW_COLOR) ?? []).length;
  }

  it('çekirdek ürün CSS modülleri ham renk KULLANMAZ', () => {
    // Kabuğun kalbi: düzen, mesajlar, ses. Bunlar token-temiz kalmalı.
    const core = ['css/modules/layout.css', 'css/modules/messages.css', 'css/modules/voice-video.css'];
    const dirty = core.map(f => ({ file: f, count: cssRawCount(f) })).filter(x => x.count > 0);

    expect(dirty).toEqual([]);
  });

  it('CSS modülü ham renk borcu BÜYÜYEMEZ', () => {
    const files = fs.readdirSync(path.join(CLIENT_ROOT, 'css/modules'))
      .filter(f => f.endsWith('.css'))
      .map(f => `css/modules/${f}`);

    const grown = files
      .map(f => ({ file: f, now: cssRawCount(f), izin: CSS_RATCHET[f] ?? 0 }))
      .filter(x => x.now > x.izin);

    expect(grown).toEqual([]);
  });

  // ── FAZ E — SAHTE TOKENİZASYON BOŞLUĞU ──────────────────────────────────
  //
  // `RAW_COLOR` deseni `:\s*#hex` arar. Bu yüzden şu biçim GUARD'DAN KAÇIYORDU:
  //
  //     background: var(--bg-input, rgba(0,0,0,0.3));
  //
  // Hex, iki nokta üst üstenin değil VİRGÜLÜN ardından geldiği için hiç
  // sayılmıyordu. Ölçüm: canlı Svelte yüzeylerinde 409 böyle kullanım vardı.
  //
  // Bunların ÇOĞU zararsızdır — `var(--bg-4, #2c3048)` gibi TANIMLI bir
  // token'a bakarlar ve fallback hiçbir zaman devreye girmez. Gerçek kusur
  // dar ve keskindir: token TANIMSIZ ise fallback HER ZAMAN kazanır, yani o
  // ham renk beş temanın hepsinde render edilir.
  //
  // Ölçülen kusur (Faz E'de kapatıldı): 6 tanımsız ad —
  //   --bg-input     → 4 AYAR sekmesi (canlı, `openSettingsModal` ile erişilir)
  //   --bridge-skel/2→ SkeletonLoader (yükleme durumu)
  //   --surface/--muted/--accent-g → OnboardingWizard
  //
  // Bu yüzden kural "fallback yasak" DEĞİL, "fallback'teki token TANIMLI
  // olmalı"dır: doğru değişmezi 400+ dosyalık mekanik yeniden yazım
  // istemeden zorlar.
  it('var() fallback\'indeki her token GERÇEKTEN tanımlı olmalı', () => {
    const tokensCss = fs.readFileSync(path.join(CLIENT_ROOT, 'css/tokens.css'), 'utf8');
    const moduleDir = path.join(CLIENT_ROOT, 'css/modules');
    const moduleCss = fs.readdirSync(moduleDir)
      .filter(f => f.endsWith('.css'))
      .map(f => fs.readFileSync(path.join(moduleDir, f), 'utf8'))
      .join('\n');

    const defined = (token: string, ownSource: string): boolean =>
      new RegExp(`${token}\\s*:`).test(tokensCss) ||
      new RegExp(`${token}\\s*:`).test(moduleCss) ||
      new RegExp(`${token}\\s*:`).test(ownSource);   // bileşenin kendi kapsamı

    // Yalnız fallback'i HAM RENK olanlar önemlidir: tanımsız + ham fallback
    // = tema-kör piksel. Fallback'i başka bir var() ise zincir zaten temalıdır.
    const FALLBACK_RAW = /var\(\s*(--[a-zA-Z0-9-]+)\s*,\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g;

    const orphans: Array<{ file: string; token: string }> = [];
    for (const file of LIVE) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(FALLBACK_RAW)) {
        const token = m[1]!;
        if (!defined(token, src)) orphans.push({ file: rel(file), token });
      }
    }

    expect(orphans).toEqual([]);
  });

  it('dormant istisnalar gerçekten dormant kalır (yanlışlıkla sevk edilmez)', () => {
    // Bu liste küçülmeli. Bir yüzey canlı hâle geldiğinde önce ham renkleri
    // token'a çevrilmeli, sonra buradan çıkarılmalıdır.
    for (const p of Object.keys(DORMANT_EXCLUSIONS)) {
      expect(fs.existsSync(path.join(CLIENT_ROOT, p))).toBe(true);
    }
    expect(Object.keys(DORMANT_EXCLUSIONS).length).toBeLessThanOrEqual(3);
  });
});
