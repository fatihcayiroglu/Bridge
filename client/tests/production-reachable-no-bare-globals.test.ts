// client/tests/production-reachable-no-bare-globals.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SINIF KAPANIŞI: "TESTTE YEŞİL / ÜRÜNDE KIRIK" — TEST-ONLY GLOBAL BAĞIMLILIĞI
// ════════════════════════════════════════════════════════════════════════════
// CANLI ÜRÜNDE (v1.124.1): Soundboard paneli her açılışta gövdesinde ham
// `apiFetch is not defined` (ardından `API`, `toast`, `currentServer`)
// gösteriyordu. Kök neden TEK bir dosya değil, bir SINIFTI:
//
//   `js/types/bridge-legacy-globals.d.ts` ve `js/types/globals.d.ts` bu adları
//   AMBIENT GLOBAL DEĞER olarak `declare` ediyor (ör. `const API`, `const toast`,
//   `declare function apiFetch`). Derleyici bu yüzden `apiFetch(...)` gibi
//   SERBEST kullanımları kabul ediyor — ama üretimde böyle bir global YOK
//   (runtime'da hepsi `undefined`). Testler `vi.stubGlobal(...)` ile o globali
//   enjekte ettiği için sözleşme YALNIZCA testte var oluyordu.
//
// Bu adların üretimde ulaşılabilir HİÇBİR modülde SERBEST kullanılmadığını
// yapısal olarak garanti ederiz. Kanonik erişim yolları:
//   · apiFetch  → BridgeRegistry / import { apiFetch } from './core/api-fetch.ts'
//   · API tabanı→ import { getAPI } from './core/globals.ts'
//   · toast     → import { toast } from './core/utils.ts'
//   · currentServer → import { currentServer } from './core/globals.ts'
//                     ya da BridgeRegistry.call('getCurrentServer')
//
// Bu test, ölü (paketlenmeyen) legacy dosyaları KAPSAM DIŞI bırakır; onlar
// üretimde çalışmaz. Ama biri o dosyalardan birini yeniden import ederek
// ULAŞILABİLİR yaparsa, ya da ulaşılabilir bir modüle serbest bir global
// eklerse, bu test KIRILIR ve sınıf geri gelmeden yakalanır.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cov = require('../scripts/production-reachable-coverage.js') as {
  reachableSet(): Set<string>;
  stripComments(src: string): string;
  CLIENT: string;
};

// Runtime'da DESTEKSİZ (üretimde `undefined`) ambient global DEĞERLER.
// `currentUser` DAHİL DEĞİL: üretimde gerçekten window'a atanır (kanıtlandı).
// `BridgeRegistry` DAHİL DEĞİL: gerçek modül tipidir ve global köprüsü vardır.
const FORBIDDEN = [
  'apiFetch', 'API', 'api', 'toast', 'showToast', 'escHtml',
  'currentServer', 'rtc', 'socket', 'currentChannel',
  'cssColor', 'initials', 'formatText', 'openDm',
  'sendThreadMessage', 'closeMobilePanels',
] as const;

/** Yorumları çıkar (mevcut tarayıcıyla), sonra dize/şablon İÇERİĞİNİ boşlukla
 *  değiştir — böylece bir dizedeki `'toast'` kimlik olarak sayılmaz. Satır
 *  sonları korunur ki hata mesajları doğru satırı gösterebilsin. */
function stripCommentsAndStrings(src: string): string {
  const noComments = cov.stripComments(src);
  let out = '';
  let state: 'code' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (state === 'code') {
      if (c === "'") { state = 'single'; out += ' '; continue; }
      if (c === '"') { state = 'double'; out += ' '; continue; }
      if (c === '`') { state = 'template'; out += ' '; continue; }
      out += c; continue;
    }
    // dize/şablon içi
    if (c === '\\') { out += '  '; i++; continue; }       // kaçış + sonraki
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"')
      || (state === 'template' && c === '`')) { state = 'code'; out += ' '; continue; }
    out += (c === '\n' ? '\n' : ' ');
  }
  return out;
}

/** Dosya, adı import ediyor / bağlıyor / yerel tanımlıyor mu? Öyleyse o addaki
 *  kullanım "çözülmüş"tür — serbest (desteksiz) global değildir. Bağlanma
 *  biçimleri: statik import, `await import()`/`require()` DESTRUCTURING, doğrudan
 *  const/let/var/function/class bildirimi ve fonksiyon PARAMETRESİ. */
function fileResolves(src: string, name: string): boolean {
  const w = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // statik import:  import { ... name ... } from  |  import name from  |  import * as name from
  if (new RegExp(`import[^;]*\\b${w}\\b[^;]*from`, 's').test(src)) return true;
  // doğrudan bildirim: const/let/var/function/class name
  if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${w}\\b`).test(src)) return true;
  // destructuring bağı: const/let/var { ... name ... } = …  (dinamik import dâhil)
  //                      const/let/var [ ... name ... ] = …
  if (new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${w}\\b[^}]*\\}\\s*=`, 's').test(src)) return true;
  if (new RegExp(`\\b(?:const|let|var)\\s*\\[[^\\]]*\\b${w}\\b[^\\]]*\\]\\s*=`, 's').test(src)) return true;
  // fonksiyon parametresi olarak name (ör. `function f(name)`, `(name) =>`,
  // `f(a, name)`): parantez içinde bir parametre listesinde geçiyorsa yereldir.
  if (new RegExp(`\\([^)]*\\b${w}\\b[^)]*\\)\\s*(?::[^=]*)?=>`, 's').test(src)) return true;
  if (new RegExp(`function[^(]*\\([^)]*\\b${w}\\b[^)]*\\)`, 's').test(src)) return true;
  return false;
}

/**
 * TypeScript TİP BİLDİRİMLERİ kullanım DEĞİLDİR.
 *
 * ÖLÇÜLEN YANLIŞ POZİTİF: `webrtc-sfu.ts` içindeki
 *   `interface BridgeAppModule { toast(msg: string, type: string): void; }`
 * satırı "serbest global `toast` kullanımı" sanılıyordu. Dosyadaki GERÇEK
 * çağrıların hepsi `_app()?.toast(...)` biçimindedir ve zaten property
 * erişimi olarak dışlanır. `interface` / `type` gövdelerini taramadan
 * çıkarmak, kuralı gevşetmeden yanlış pozitifi kaldırır.
 */
function stripTypeDeclarations(src: string): string {
  let out = src;
  for (;;) {
    // Her turda BASTAN aranir: islenen bildirimin tamami bosluga cevrildigi
    // icin bir daha eslesemez. (Onceki bicim `lastIndex`i elle tasiyordu ve
    // TEK SATIRLIK bir arayuzden sonra bir sonrakini ATLIYORDU: olculen
    // yanlis pozitif tam olarak boyle olustu.)
    const m = /(?:interface|type)\s+[A-Za-z_$][\w$]*[^{;]*\{/.exec(out);
    if (!m) break;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < out.length; i += 1) {
      if (out[i] === '{') depth += 1;
      else if (out[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    if (depth !== 0) break;
    const decl = out.slice(m.index, i + 1);
    out = out.slice(0, m.index) + decl.replace(/[^\n]/g, ' ') + out.slice(i + 1);
  }
  return out;
}

function bareUses(src: string, name: string): number {
  const stripped = stripTypeDeclarations(stripCommentsAndStrings(src));
  const w = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `.` veya kimlik karakteriyle ÖNCELENMEMİŞ bir kimlik olarak `name`.
  // `(?<![\w$.])` → property erişimini (`x.name`, `window.name`) ve daha uzun
  // kimliklerin parçalarını dışlar. `(?![\w$:])` → nesne anahtarı `name:` ve
  // daha uzun kimlikleri dışlar (tip/etiket konumlarını da azaltır).
  // `(?<![\w$.])`   → property/daha-uzun-kimlik değil (`x.API`, `myAPI` hariç)
  // `(?![\w$])`     → daha uzun kimliğin ön eki değil (`APIClient` hariç)
  // `(?!\s*\??\s*:)`→ nesne anahtarı / tip alanı değil (`API:`, `socket?:` hariç)
  // `(?!\s*\?\s*\()`→ arayüz metod imzası değil (`showToast?(` hariç)
  // Gerçek çağrı `toast(` ve gerçek değer okuması `return toast` YAKALANIR.
  const re = new RegExp(`(?<![\\w$.])${w}(?![\\w$])(?!\\s*\\??\\s*:)(?!\\s*\\?\\s*\\()`, 'g');
  const matches = stripped.match(re);
  return matches ? matches.length : 0;
}

describe('üretimde ulaşılabilir kod, desteksiz ambient global KULLANMAZ', () => {
  const reachable = [...cov.reachableSet()].filter(f => /\.(ts|svelte)$/.test(f) && !f.endsWith('.d.ts'));

  it('ulaşılabilir küme boş değildir (tarayıcı gerçekten çalışıyor)', () => {
    // Kırık bir reachability tarayıcısı sessizce boş küme üretir ve testi
    // ANLAMSIZCA yeşil gösterirdi. Alt sınır bunu engeller.
    expect(reachable.length).toBeGreaterThan(50);
  });

  // Bu tarama YÜZLERCE dosyayı okuyup her biri için birden çok regex geçişi
  // yapar. Varsayılan 5 sn'lik süre, `--coverage` altında (araçlanmış modüller
  // + paralel çalışan diğer dosyalar) AŞILIYORDU: sözleşme testi kapsam
  // komutunda kırmızıya dönüyor, tek başına çalıştırıldığında geçiyordu.
  // Süre, işin gerçek boyutuna göre açıkça verilir; tarama gevşetilmez.
  it('hiçbir ulaşılabilir modül yasaklı globali SERBEST kullanmaz', () => {
    const violations: Array<{ file: string; name: string; count: number }> = [];
    for (const file of reachable) {
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      // .svelte için yalnızca <script> içeriğini tara.
      let src = raw;
      if (file.endsWith('.svelte')) {
        src = [...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
      }
      for (const name of FORBIDDEN) {
        if (fileResolves(src, name)) continue;
        const count = bareUses(src, name);
        if (count > 0) {
          violations.push({ file: path.relative(cov.CLIENT, file).split(path.sep).join('/'), name, count });
        }
      }
    }
    // Boş olmalı. Değilse, hangi dosya/kimlik olduğunu net göster.
    expect(violations).toEqual([]);
  }, 120_000);
});
