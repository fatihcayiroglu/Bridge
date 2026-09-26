// e2e/_memory.cjs
//
// BELLEK SIZINTISI — GERCEK TARAYICI HEAP OLCUMU
//
// ============================================================================
// NEDEN
// ============================================================================
// "Bellek sizintisi yok" iddiasi ancak GERCEK heap ZORLA GC sonrasi
// olculurse anlam tasir. Bu betik CDP kullanir:
//   HeapProfiler.collectGarbage  -> gercek GC (window.gc gerektirmez)
//   Performance.getMetrics       -> JSHeapUsedSize
//
// Olculen dongler (kullanicinin en sik yaptigi seyler):
//   1. Kanal degistirme
//   2. Modal ac/kapa
//   3. Uye listesi cekmecesi ac/kapa
//
// DOM dugum sayisi ve dinleyici sayisi da izlenir: heap sabit gorunurken
// dugum sayisi buyuyorsa bu da sizintiddir.

const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CYCLES = Number(process.env.CYCLES || 30);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    storageState: 'fixtures/auth-state.json', locale: 'tr-TR',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');

  async function olc() {
    // Uc kez GC: gecikmeli finalizer'lar icin.
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
    await new Promise(r => setTimeout(r, 400));
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
    return {
      heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2),
      nodes: m.Nodes,
      listeners: m.JSEventListeners,
      docs: m.Documents,
    };
  }

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // Isinma: ilk render kaciniilmaz olarak buyur; olcume dahil edilmez.
  const kanallar = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button.ch-open')).length);
  console.log('bulunan kanal dugmesi:', kanallar);

  async function dongu(ad, fn) {
    await fn(3);                       // isinma
    const once = await olc();
    await fn(CYCLES);
    const sonra = await olc();
    const d = {
      heap: +(sonra.heapMB - once.heapMB).toFixed(2),
      nodes: sonra.nodes - once.nodes,
      listeners: sonra.listeners - once.listeners,
      docs: sonra.docs - once.docs,
    };
    console.log(
      ad.padEnd(26) +
      'heap ' + String(once.heapMB).padStart(7) + ' -> ' + String(sonra.heapMB).padStart(7) +
      ' MB (' + (d.heap >= 0 ? '+' : '') + d.heap + ')' +
      '  dugum ' + (d.nodes >= 0 ? '+' : '') + d.nodes +
      '  dinleyici ' + (d.listeners >= 0 ? '+' : '') + d.listeners);
    return d;
  }

  const sonuc = {};

  sonuc.kanal = await dongu('kanal degistirme', async (n) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate((k) => {
        const b = document.querySelectorAll('button.ch-open');
        if (b.length) b[k % b.length].click();
      }, i);
      await page.waitForTimeout(120);
    }
  });

  sonuc.cekmece = await dongu('uye cekmecesi ac/kapa', async (n) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('button')) {
          const l = ((el.getAttribute('aria-label') || '') + el.className).toLowerCase();
          if (/uye|üye|member/.test(l)) { el.click(); return; }
        }
      });
      await page.waitForTimeout(120);
    }
  });

  sonuc.modal = await dongu('ayarlar modali ac/kapa', async (n) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('button')) {
          const l = ((el.getAttribute('aria-label') || '') + el.className).toLowerCase();
          if (/setting|ayar/.test(l)) { el.click(); return; }
        }
      });
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }
  });

  console.log('\n== DEGERLENDIRME (' + CYCLES + ' dongu) ==');
  let uyari = 0;
  for (const [ad, d] of Object.entries(sonuc)) {
    // Esik: dongu basina 40KB heap veya 20 dugum kalici artis.
    const heapPer = (d.heap * 1024) / CYCLES;
    const nodePer = d.nodes / CYCLES;
    const kotu = heapPer > 40 || nodePer > 20 || d.docs > 0;
    if (kotu) uyari++;
    console.log('  ' + ad.padEnd(12) +
      'dongu basina ' + heapPer.toFixed(1) + ' KB, ' + nodePer.toFixed(1) + ' dugum' +
      (kotu ? '  <-- INCELE' : '  OK'));
  }
  console.log(uyari ? '\n' + uyari + ' dongu esigi asti.' : '\nTum dongler esik altinda.');

  await browser.close();
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
