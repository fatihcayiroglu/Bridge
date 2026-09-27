// client/tests/theme-on-solid-misuse.test.ts
//
// `--text-on-solid` YALNIZCA SOLID BİR YÜZEYİN ÜSTÜNDE KULLANILIR
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Kullanıcı bildirdi: açık temada sunucu adı yazarken metin görünmüyordu.
//
// Sebep `EmptyServerStart.svelte` içindeki şuydu:
//
//     input {
//       background: var(--bg-1);          /* açık temada AÇIK */
//       color: var(--text-on-solid);      /* açık temada BEYAZ */
//     }
//
// `--text-on-solid` "SOLID/marka renkli bir yüzeyin üstündeki metin" demektir.
// Değeri temaya göre TERS döner (tokens.css): koyu temada #0b1220, açık temada
// #ffffff. Yani normal bir yüzeyde kullanıldığında tam olarak yanlış tarafa
// düşer — açık temada beyaz zemine beyaz metin.
//
// Mevcut dört tema/jeton muhafızı bunu YAKALAMADI: hepsi jeton TANIMLARINI ve
// kontrastı denetliyor, jetonun YANLIŞ YERDE kullanılmasını değil. Bu paket o
// boşluğu kapatır.
//
// KURAL: bir kuralda `color: var(--text-on-solid)` varsa, AYNI kural bloğu
// solid bir arka plan da vermelidir (`--brand`, `--danger`, `--success` vb.).
// Aksi halde metnin hangi zeminde durduğu bilinmiyordur ve temalardan birinde
// okunamaz olması kaçınılmazdır.

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

/** Solid kabul edilen arka plan jetonları — bunların üstünde beyaz/koyu metin doğrudur. */
//
// ── LISTE GENISLETILDI ──────────────────────────────────────────────────────
// Onceki desen YALNIZCA jenerik adlari taniyordu (`--danger`, `--accent` …) ve
// Bridge'in KENDI solid jetonlarini KACIRIYORDU: `--bridge-danger` icinde
// `--danger` GECMEZ (arada `bridge-` vardir). Sonuc: solid bir dugme uzerinde
// `--text-on-solid` kullanmak — ki bu jetonun TAM OLARAK dogru kullanimidir —
// "yanlis kullanim" olarak sayiliyordu.
//
// Tavani yukseltmek yerine DEDEKTOR duzeltildi: tavani yukseltmek muhafizi
// korlestirirdi, dedektoru duzeltmek ise onu KESKINLESTIRIR.
const SOLID_BG = /--brand|--danger|--success|--warning|--accent|--positive|--negative|--critical|--bridge-(danger|blue|green|yellow|red)/;

interface Offence { file: string; rule: string }

/** Basit kural bloğu ayrıştırıcı: `{ ... }` içerikleri. */
function ruleBlocks(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') { if (depth === 0) start = i + 1; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) { out.push(css.slice(start, i)); start = -1; }
    }
  }
  return out;
}

function styleSection(src: string): string {
  const open = src.indexOf('<style');
  if (open === -1) return '';
  const bodyStart = src.indexOf('>', open) + 1;
  const close = src.lastIndexOf('</style>');
  return close > bodyStart ? src.slice(bodyStart, close) : '';
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(svelte|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

function findOffences(): Offence[] {
  const offences: Offence[] = [];
  for (const file of [...walk(join(CLIENT, 'js')), ...walk(join(CLIENT, 'css'))]) {
    const raw = readFileSync(file, 'utf8');
    const css = file.endsWith('.svelte') ? styleSection(raw) : raw;
    if (!css.includes('--text-on-solid')) continue;

    for (const block of ruleBlocks(css)) {
      // Yorum içindeki örnekler sayılmaz (bu dosyanın kendi açıklaması gibi).
      const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
      if (!/color\s*:\s*var\(\s*--text-on-solid/.test(code)) continue;
      const bg = code.match(/background(?:-color)?\s*:\s*([^;]+)/);
      if (bg && SOLID_BG.test(bg[1])) continue;      // doğru kullanım
      offences.push({
        file: file.replace(CLIENT, '').replace(/\\/g, '/'),
        rule: code.trim().slice(0, 140),
      });
    }
  }
  return offences;
}

// ════════════════════════════════════════════════════════════════════════════
// TAVAN — SIFIR DEĞİL, VE NEDENİ
// ════════════════════════════════════════════════════════════════════════════
// Tarama şu an 26 kullanım işaretliyor. İncelendiğinde ÇOĞU MEŞRU çıktı:
// gerçekten solid renkli yüzeyler, ama jeton adları bu testin "solid" listesine
// girmiyor (`--green`, `--red`, `--bridge-green`, `--bg-5` gibi). Bir kısmı ise
// video üzerindeki yarı saydam örtüler (`color-mix(... --bg-0 ...)`) — orada
// altta duran şey videodur ve karar TASARIM YARGISI gerektirir.
//
// Bu yüzden eşik sıfır DEĞİL. 26 kuralı tek tek iki temada görsel olarak
// doğrulamadan değiştirmek, kanıtsız toplu değişiklik olurdu; testi sıfıra
// zorlamak için kuralı gevşetmek ise muhafızı işe yaramaz hale getirirdi.
//
// KİLİTLENEN ŞEY: sayı BÜYÜMESİN. Yeni bir yanlış kullanım eklenirse test
// düşer. Kanıtlanmış kusur (EmptyServerStart) ayrıca aşağıda ismen sabitlenir.
// 2026-08-27: dedektor Bridge'in kendi solid jetonlarini da tanidiktan sonra
// GERCEK yanlis kullanim sayisi 26 -> 23'e dustu. Tavan da indirildi; bu
// circir yalnizca asagi doner.
// 2026-09-26 (Final21 UX turu): video döşemesi adı, ekran paylaşımı başlığı/rozeti/küçük
// resim etiketi (hepsi yarı saydam `--bg-0` örtüsü üstünde, yani HER temada okunamaz),
// ses paneli etiketi ve Keşfet harf döşemesi düzeltildi: 23 -> 15.
const MAX_KNOWN_OFFENCES = 15;

describe('`--text-on-solid` yanlış yüzeyde kullanılmaz', () => {
  it('bilinen yanlış kullanım sayısı ARTMAZ', () => {
    const offences = findOffences();
    expect(
      offences.length,
      `yeni --text-on-solid kullanımı: ${JSON.stringify(offences.slice(0, 5), null, 2)}`,
    ).toBeLessThanOrEqual(MAX_KNOWN_OFFENCES);
  });

  it('sayı DÜŞTÜĞÜNDE tavan da düşürülmelidir (ilerleme geri alınamaz)', () => {
    expect(MAX_KNOWN_OFFENCES - findOffences().length).toBeLessThanOrEqual(2);
  });

  it('DÜZELTİLEN dosya temizdir', () => {
    // Kullanıcının bildirdiği kusur burasıydı; geri gelmemeli.
    const offenders = findOffences().map(o => o.file);
    expect(offenders).not.toContain('/js/core/EmptyServerStart.svelte');
  });

  it('MUHAFIZIN KENDİSİ ÇALIŞIYOR — kusurlu örüntü yakalanır', () => {
    // Pozitif kontrol: tarayıcı bozulursa yukarıdaki test boş liste görüp
    // sessizce geçerdi. Kusurun ta kendisi burada sentetik olarak sınanır.
    const bad = `
      input {
        background: var(--bg-1);
        color: var(--text-on-solid);
      }
    `;
    const blocks = ruleBlocks(bad);
    const hit = blocks.some((b) => {
      if (!/color\s*:\s*var\(\s*--text-on-solid/.test(b)) return false;
      const bg = b.match(/background(?:-color)?\s*:\s*([^;]+)/);
      return !(bg && SOLID_BG.test(bg[1]));
    });
    expect(hit, 'muhafız kusurlu örüntüyü kaçırıyor').toBe(true);
  });

  it('DOĞRU kullanım işaretlenmez', () => {
    const good = `
      .primary {
        background: var(--brand);
        color: var(--text-on-solid);
      }
    `;
    const flagged = ruleBlocks(good).some((b) => {
      if (!/color\s*:\s*var\(\s*--text-on-solid/.test(b)) return false;
      const bg = b.match(/background(?:-color)?\s*:\s*([^;]+)/);
      return !(bg && SOLID_BG.test(bg[1]));
    });
    expect(flagged, 'doğru kullanım yanlışlıkla işaretlendi').toBe(false);
  });
});

describe('düzeltilen giriş kanonik jetonları kullanır', () => {
  const ESS = readFileSync(join(CLIENT, 'js', 'core', 'EmptyServerStart.svelte'), 'utf8');
  const css = styleSection(ESS).replace(/\/\*[\s\S]*?\*\//g, '');

  it('metin rengi `--text-primary`', () => {
    expect(css).toMatch(/color:\s*var\(--text-primary\)/);
  });

  it('kenarlık sabit renk DEĞİL', () => {
    // `#3d4762` yalnızca koyu temada doğruydu.
    expect(css).not.toMatch(/border:\s*1px solid #[0-9a-fA-F]{6}/);
  });

  it('yer tutucu ve caret tanımlı', () => {
    expect(css).toMatch(/input::placeholder/);
    expect(css).toMatch(/caret-color/);
  });

  it('odak halkası sabit rgba DEĞİL', () => {
    expect(css).not.toMatch(/box-shadow:\s*0 0 0 3px rgba\(/);
    expect(css).toMatch(/--focus-ring/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 UX (U-02/U-03) — İKİNCİ ÖRÜNTÜ: `--text-on-solid` bir TON olarak
// ════════════════════════════════════════════════════════════════════════════
// Yukarıdaki dedektör yalnız `color: var(--text-on-solid)` arar. Aynı jetonun
// `color-mix(in srgb, var(--text-on-solid) N%, transparent)` ile TON olarak (arka plan,
// kenarlık, ayraç, ilerleme izi, ikincil düğme) kullanılması onu atlatıyordu. Jeton her
// temada yüzeyle AYNI aileden (açık temada beyaz, koyu temada #0b1220) olduğu için ton
// HER temada görünmezdi: ölçüldü — tanıtım turunun 8 adım noktasından 7'si, ilerleme izi
// ve "Geri" düğmesi görünmüyordu; video döşemelerinde katılımcı adları okunmuyordu.
// Yüzey tonu `--text-primary`den alınır. İstisnalar yalnızca SOLID dolgunun İÇİNDEKİ
// öğelerdir ve gerekçesiyle burada listelenir.
const TINT = /color-mix\(\s*in\s+srgb\s*,\s*var\(\s*--text-on-solid\s*\)\s*\d+%/;
const TINT_ON_SOLID_ALLOWED: Record<string, string> = {
  '.ob-spinner': 'OfflineBanner: çevrimdışı/eşitleniyor şeridi solid danger/green dolgudur',
  '.discover-hero-sub': 'Keşfet başlığı marka gradyanının (solid dolgu) üstündedir',
};

function selectorBlocks(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1]!.trim(), body: m[2]! });
  return out;
}

function findTintOffences(): Offence[] {
  const offences: Offence[] = [];
  for (const file of [...walk(join(CLIENT, 'js')), ...walk(join(CLIENT, 'css'))]) {
    const raw = readFileSync(file, 'utf8');
    const css = file.endsWith('.svelte') ? styleSection(raw) : raw;
    if (!css.includes('--text-on-solid')) continue;
    for (const { selector, body } of selectorBlocks(css)) {
      if (!TINT.test(body)) continue;
      if (Object.keys(TINT_ON_SOLID_ALLOWED).some((allowed) => selector.split(',').map((s) => s.trim()).includes(allowed))) continue;
      offences.push({ file: file.replace(CLIENT, '').replace(/\\/g, '/'), rule: `${selector} { ${body.trim().slice(0, 100)} }` });
    }
  }
  return offences;
}

describe('`--text-on-solid` TON olarak yalnız solid dolgu içinde kullanılır (U-03)', () => {
  it('izin listesi dışında hiçbir ton kullanımı yok', () => {
    const offences = findTintOffences();
    expect(offences, JSON.stringify(offences.slice(0, 5), null, 2)).toEqual([]);
  });

  it('MUHAFIZ çalışıyor — yüzey üstündeki ton yakalanır (pozitif kontrol)', () => {
    const bad = selectorBlocks('.ow-dot::before { background: color-mix(in srgb, var(--text-on-solid) 15%, transparent); }');
    expect(bad.some(({ body }) => TINT.test(body))).toBe(true);
  });

  it('yüzey tonu `--text-primary`den gelir; turun noktaları ve ikincil düğmesi temiz', () => {
    const wizard = styleSection(readFileSync(join(CLIENT, 'js', 'core', 'OnboardingWizard.svelte'), 'utf8'));
    expect(wizard).not.toMatch(TINT);
    expect(wizard).toMatch(/\.ow-dot::before\s*\{[^}]*color-mix\(in srgb, var\(--text-primary\) 30%/);
    // Birincil eylem uygulamanın geri kalanıyla aynı marka dolgusudur (turuncu→mor gradyan değil).
    expect(wizard).toMatch(/\.ow-btn-primary\s*\{[^}]*background:\s*var\(--brand\)/);
  });

  it('ilk açılış kartı SABİT KOYU gradyan taşımaz (açık temada başlık görünmezdi)', () => {
    const ess = styleSection(readFileSync(join(CLIENT, 'js', 'core', 'EmptyServerStart.svelte'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    const card = ess.match(/\.empty-server-card\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(card).toMatch(/background:\s*var\(--surface\)/);
    expect(card).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
