// client/tests/theme-contrast-aa.test.ts
// TEMA KONTRASTI — WCAG AA (4.5:1) REGRESYON KAPISI.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (canlı üründe, hesaplanmış stillerle ölçüldü)
// ════════════════════════════════════════════════════════════════════════════
// Beş temanın tamamında GÖVDE METNİ mükemmeldi (14–18:1). Ancak SEMANTİK
// renklerin bir kısmı AA'nın altındaydı:
//
//   solid üzeri metin / marka  (BİRİNCİL DÜĞMELER: "Mesaj gönder", "Kopyala")
//       dark 3.15 · amoled 3.15 · light 3.15 · aurora 1.60   <-- en ağırı
//   danger / yüzey             (HATA METİNLERİ)
//       dark 4.32 · aurora 4.29 · light 3.79
//   marka / yüzey              (marka renkli metin/bağlantı)
//       light 3.15 · midnight 3.37
//   green / yüzey              (başarı metni)
//       light 2.05
//
// Yani en çok tıklanan yüzeyler (birincil eylem düğmeleri) ve hata metinleri
// okunabilirlik eşiğinin altındaydı.
//
// ════════════════════════════════════════════════════════════════════════════
// DÜZELTME İLKESİ — TEMA KİMLİĞİ KORUNUR
// ════════════════════════════════════════════════════════════════════════════
// TON (hue) ve DOYGUNLUK (saturation) DEĞİŞMEDİ. Yalnızca:
//   · katı dolgu üzerindeki mürekkep (`--text-on-solid`) tema başına seçildi,
//   · birkaç semantik rengin AÇIKLIĞI (lightness) ayarlandı.
// Yeni palet, yeni marka rengi veya "gri gibi" bir sadeleştirme YOKTUR.
//
// Bu test jeton dosyasını okuyup oranları YENİDEN hesaplar; bir jeton
// gerilerse burada kırmızıya döner.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(CLIENT, 'css/tokens.css'), 'utf8');

const THEMES = ['dark', 'light', 'amoled', 'aurora', 'midnight'] as const;

/** Bir tema bloğunun gövdesi (son tanım kazanır — CSS semantiği). */
function themeBlocks(theme: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\[data-theme="${theme}"\\][^{]*\\{([\\s\\S]*?)\\n\\}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS)) !== null) out.push(m[1]);
  return out;
}
/** `:root` blokları — tema override etmezse taban değer oradan gelir. */
function rootBlocks(): string[] {
  const out: string[] = [];
  const re = /(^|\n):root[^{]*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS)) !== null) out.push(m[2]);
  return out;
}

function readVar(theme: string, name: string): string | null {
  const search = [...rootBlocks(), ...themeBlocks(theme)];   // tema sonra => kazanır
  let found: string | null = null;
  for (const b of search) {
    const re = new RegExp(`(?:^|\\n)\\s*${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) found = m[1].trim();
  }
  return found;
}

/** `hsl(var(--brand-h), var(--brand-s), 58%)` gibi ifadeleri çözer. */
function resolve(theme: string, value: string, depth = 0): string {
  if (depth > 5) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, v: string) => {
    const r = readVar(theme, v);
    return r ? resolve(theme, r, depth + 1) : '';
  });
}

function toRgb(theme: string, raw: string | null): [number, number, number] | null {
  if (!raw) return null;
  const v = resolve(theme, raw).trim();
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hsl = v.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i);
  if (hsl) {
    const h = +hsl[1] / 360, s = +hsl[2] / 100, l = +hsl[3] / 100;
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
    };
    return [f(0), f(8), f(4)];
  }
  return null;
}

const lum = ([r, g, b]: [number, number, number]) => {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const L1 = lum(a), L2 = lum(b);
  return +(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2));
};

const AA = 4.5;

// ════════════════════════════════════════════════════════════════════════════
describe('TEMA KONTRASTI — beş temanın tamamı AA', () => {
  for (const theme of THEMES) {
    describe(theme, () => {
      const surface = toRgb(theme, readVar(theme, '--surface-1') ?? readVar(theme, '--bg-2'));
      const brand   = toRgb(theme, readVar(theme, '--brand'));

      it('jetonlar çözümlenebilir (test kendi kendini boşa düşürmez)', () => {
        expect(surface).not.toBeNull();
        expect(brand).not.toBeNull();
      });

      const check = (label: string, fgName: string, bg: () => [number, number, number] | null) => {
        it(`${label} >= ${AA}:1`, () => {
          const fg = toRgb(theme, readVar(theme, fgName));
          const background = bg();
          expect(fg).not.toBeNull();
          expect(background).not.toBeNull();
          expect(ratio(fg!, background!)).toBeGreaterThanOrEqual(AA);
        });
      };

      check('birincil metin / yüzey',   '--text-primary',  () => surface);
      check('ikincil metin / yüzey',    '--text-2',        () => surface);
      check('soluk metin / yüzey',      '--text-muted',    () => surface);
      check('marka metni / yüzey',      '--brand',         () => surface);
      check('hata metni / yüzey',       '--danger',        () => surface);
      check('başarı metni / yüzey',     '--green',         () => surface);
      // EN KRITIK: birincil dugme metni. Onceden aurora'da 1.60 idi.
      check('katı üzeri metin / marka', '--text-on-solid', () => brand);
    });
  }
});
