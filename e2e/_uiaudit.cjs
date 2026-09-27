// e2e/_uiaudit.cjs
//
// UI/UX DENETIMI — GERCEK RENDER EDILMIS URUN
//
// ============================================================================
// NEDEN
// ============================================================================
// UI/UX alani bu programda "sistematik olarak denetlenmedi" diye LOW guvenle
// puanlanmisti. Statik CSS okumak bir sey kanitlamaz: tasma, kirpilma ve
// dokunma hedefi kusurlari yalnizca GERCEK render'da olculur.
//
// Bu betik urunu 7 genislikte ve 2 dilde acar ve OLCER:
//   1. Yatay tasma           (documentElement.scrollWidth > clientWidth)
//   2. Viewport disina tasan gorunur elemanlar
//   3. Kucuk dokunma hedefleri (WCAG 2.2 AA: 24x24 CSS px minimum)
//   4. Kirpilan metin        (scrollWidth > clientWidth + overflow:hidden)
//   5. Gorunmez metin        (renk == arka plan)
//   6. Ust uste binen etkilesimli elemanlar
//
// Bulgular DOSYA olarak yazilir; iddia degil OLCUM uretir.

const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const WIDTHS = [360, 390, 430, 768, 1024, 1280, 1440];
const LOCALES = ['tr-TR', 'en-US'];

// Sayfa icinde calisan olcum fonksiyonu.
const PROBE = () => {
  const out = {
    overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    offscreen: [], smallTargets: [], clipped: [], invisible: [], overlaps: [],
  };
  const vw = document.documentElement.clientWidth;
  const desc = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return (el.tagName.toLowerCase() + id + cls).slice(0, 70);
  };
  const visible = (el, r, cs) =>
    r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' &&
    cs.display !== 'none' && cs.opacity !== '0';

  const all = Array.from(document.querySelectorAll('body *'));
  const boxes = [];

  for (const el of all) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!visible(el, r, cs)) continue;

    // 2) viewport disina tasma (sag kenar)
    if (r.right > vw + 2 && cs.position !== 'fixed') {
      out.offscreen.push({ el: desc(el), right: Math.round(r.right), vw });
    }

    const interactive = el.matches('button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])');

    // 3) kucuk dokunma hedefi
    if (interactive && (r.width < 24 || r.height < 24)) {
      out.smallTargets.push({ el: desc(el), w: Math.round(r.width), h: Math.round(r.height) });
    }

    // 4) kirpilan metin
    const hasText = el.children.length === 0 && (el.textContent || '').trim().length > 0;
    if (hasText && /hidden|clip/.test(cs.overflow + cs.overflowX) &&
        el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis') {
      out.clipped.push({ el: desc(el), scroll: el.scrollWidth, client: el.clientWidth,
        text: (el.textContent || '').trim().slice(0, 40) });
    }

    // 5) gorunmez metin (renk == arka plan)
    if (hasText) {
      const fg = cs.color, bg = cs.backgroundColor;
      if (fg && bg && bg !== 'rgba(0, 0, 0, 0)' && fg === bg) {
        out.invisible.push({ el: desc(el), color: fg });
      }
    }

    if (interactive) boxes.push({ el: desc(el), r });
  }

  // 6) ust uste binen ETKILESIMLI elemanlar (ic ice olanlar haric)
  for (let i = 0; i < boxes.length && out.overlaps.length < 12; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 4 && oy > 4) {
        const contains = (a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom) ||
                         (b.left <= a.left && b.right >= a.right && b.top <= a.top && b.bottom >= a.bottom);
        if (!contains) {
          out.overlaps.push({ a: boxes[i].el, b: boxes[j].el, ox: Math.round(ox), oy: Math.round(oy) });
          break;
        }
      }
    }
  }
  return out;
};

(async () => {
  const browser = await chromium.launch();
  const rapor = [];

  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({
        storageState: 'fixtures/auth-state.json',
        locale,
        viewport: { width, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      const r = await page.evaluate(PROBE);
      rapor.push({ locale, width, ...r });

      const sorun = r.overflowPx > 2 || r.offscreen.length || r.smallTargets.length ||
                    r.clipped.length || r.invisible.length || r.overlaps.length;
      console.log(
        (locale + ' @' + width).padEnd(16) +
        'tasma=' + String(r.overflowPx).padEnd(5) +
        'disarda=' + String(r.offscreen.length).padEnd(4) +
        'kucukHedef=' + String(r.smallTargets.length).padEnd(4) +
        'kirpik=' + String(r.clipped.length).padEnd(4) +
        'gorunmez=' + String(r.invisible.length).padEnd(3) +
        'cakisma=' + String(r.overlaps.length).padEnd(4) +
        (sorun ? ' <-- INCELE' : ' OK'));
      await ctx.close();
    }
  }

  fs.writeFileSync(__dirname + '/_uiaudit-report.json', JSON.stringify(rapor, null, 2));

  // Ozet: en sik gorulen kusurlar
  const say = (k) => rapor.reduce((s, r) => s + r[k].length, 0);
  console.log('\n== TOPLAM ==');
  console.log('viewport disina tasan :', say('offscreen'));
  console.log('kucuk dokunma hedefi  :', say('smallTargets'));
  console.log('kirpilan metin        :', say('clipped'));
  console.log('gorunmez metin        :', say('invisible'));
  console.log('cakisan etkilesimli   :', say('overlaps'));
  console.log('yatay tasma olan gorunum:', rapor.filter(r => r.overflowPx > 2).length + '/' + rapor.length);

  const uniq = (k, f) => {
    const m = new Map();
    for (const r of rapor) for (const x of r[k]) {
      const key = f(x); m.set(key, (m.get(key) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  };
  console.log('\n-- en sik KUCUK HEDEF --');
  for (const [k, n] of uniq('smallTargets', x => x.el + ' ' + x.w + 'x' + x.h)) console.log('  ' + n + 'x  ' + k);
  console.log('\n-- en sik VIEWPORT DISI --');
  for (const [k, n] of uniq('offscreen', x => x.el)) console.log('  ' + n + 'x  ' + k);
  console.log('\n-- en sik KIRPIK METIN --');
  for (const [k, n] of uniq('clipped', x => x.el + ' :: ' + x.text)) console.log('  ' + n + 'x  ' + k);

  await browser.close();
})().catch(e => { console.error('HATA', e); process.exit(2); });
