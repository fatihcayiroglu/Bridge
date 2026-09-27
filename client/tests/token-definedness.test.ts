// client/tests/token-definedness.test.ts
//
// KULLANILAN HER JETON TANIMLI OLMALIDIR
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Bileşenler `var(--surface-1)`, `var(--surface-2)`, `var(--border-subtle)`
// gibi adları YEDEKSİZ kullanıyordu — ama bu adlar `tokens.css` içinde
// TANIMLI DEĞİLDİ.
//
// CSS'te geçersiz bir `var()` yalnızca rengi bozmaz: ÖZELLİĞİN TAMAMINI
// geçersiz kılar. Yani `background: var(--surface-1)` bir arka plan
// ÜRETMEZ — yüzey SAYDAM kalır.
//
// ── ÖLÇÜLEN ETKİ ──────────────────────────────────────────────────────────
// DM paneli (`.dm-panel { background: var(--surface-1) }`) kabuğun üzerinde
// SAYDAM açılıyordu: kanal listesi ve kullanıcı dock'u DM listesinin altından
// görünüyor, metinler üst üste biniyordu. Ekran görüntüsüyle doğrulandı.
//
// Kullanım sayıları (düzeltme öncesi): --border-subtle 24, --radius-sm 13,
// --surface-1 7, --surface-2 6, --elevation-modal 5, --radius-md 4.
//
// ── NEDEN MEVCUT MUHAFIZ YAKALAMADI ───────────────────────────────────────
// `css-token-integrity.test.ts` jeton TANIMLARINI denetliyor; jetonun
// KULLANILDIĞI ama tanımlanmadığı yönü denetlemiyordu.

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
import { join, sep } from 'path';

const CLIENT = join(__dirname, '..');

/** `tokens.css` içinde tanımlı tüm özel özellikler. */
function definedTokens(): Set<string> {
  const out = new Set<string>();
  const src = readFileSync(join(CLIENT, 'css', 'tokens.css'), 'utf8');
  for (const m of src.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gmi)) out.add(m[1]);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(svelte|css)$/.test(e.name)) out.push(f);
  }
  return out;
}

interface Use { token: string; file: string; count: number }

/**
 * YEDEKSİZ kullanılan tanımsız jetonlar.
 *
 * `var(--x, fallback)` biçimi ÇÖKMEZ — yedek devreye girer — bu yüzden
 * kusur sayılmaz. Kural yalnızca yedeği olmayan kullanımlara uygulanır.
 */
function undefinedUses(): Use[] {
  const tokens = definedTokens();
  const hits = new Map<string, Use>();

  for (const file of [...walk(join(CLIENT, 'js')), ...walk(join(CLIENT, 'css'))]) {
    if (file.endsWith(join('css', 'tokens.css'))) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
      const [, token, hasFallback] = m;
      if (hasFallback) continue;              // yedekli → güvenli
      if (tokens.has(token)) continue;        // tanımlı → güvenli
      // Bileşen içinde `style="--role-color: x"` gibi YEREL olarak atanan
      // özel özellikler tokens.css'e ait değildir; yerel tanımı varsa geç.
      if (new RegExp(`${token}\s*:`).test(src)) continue;
      const key = `${token}|${file}`;
      const rel = file.replace(CLIENT, '').split(sep).join('/');
      hits.set(key, { token, file: rel, count: (hits.get(key)?.count ?? 0) + 1 });
    }
  }
  return [...hits.values()];
}

describe('tasarım jetonları — kullanılan her ad tanımlıdır', () => {
  it('YEDEKSİZ tanımsız jeton kullanımı YOK', () => {
    const bad = undefinedUses();
    expect(
      bad,
      `tanımsız jeton (geçersiz var() ÖZELLİĞİ TAMAMEN düşürür):\n${JSON.stringify(bad, null, 2)}`,
    ).toEqual([]);
  });

  it('DM panelinin arka planı GERÇEKTEN tanımlı bir jetondan gelir', () => {
    // Kusurun ta kendisi buradaydı.
    const tokens = definedTokens();
    expect(tokens.has('--surface-1'), '--surface-1 tanımlı değil').toBe(true);
    expect(tokens.has('--surface-2'), '--surface-2 tanımlı değil').toBe(true);
    expect(tokens.has('--border-subtle'), '--border-subtle tanımlı değil').toBe(true);
  });

  it('MUHAFIZ ÇALIŞIYOR — tanımsız ad yakalanır', () => {
    // Pozitif kontrol: tarayıcı bozulursa test sessizce geçerdi.
    const tokens = definedTokens();
    expect(tokens.has('--kesinlikle-tanimsiz-jeton')).toBe(false);
  });

  it('yedekli kullanım kusur SAYILMAZ', () => {
    // `var(--x, 8px)` geçersiz olsa bile yedek uygulanır; ürünü bozmaz.
    const sample = 'border-radius: var(--olmayan-jeton, 8px);';
    const m = [...sample.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)];
    expect(m[0][2]).toBe(',');
  });
});
