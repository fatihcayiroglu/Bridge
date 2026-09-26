// e2e/_memberpanel.cjs
//
// UYE LISTESI MOBILDE ULASILABILIR MI?
//
// UI denetimi 360/390/430/768'de `.member-panel` ve 13 alt elemanini
// "viewport disinda" olarak buldu (112 olcum). Iki olasilik var:
//   (a) KASITLI off-canvas cekmece  -> bir kontrolle acilir, KUSUR DEGIL
//   (b) ERISILEMEZ artik            -> mobil kullanici uye listesini goremez
//
// Fark yalnizca ETKILESIMLE anlasilir. Bu betik gercek bir tiklama dener.

const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    storageState: 'fixtures/auth-state.json',
    locale: 'tr-TR',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const durum = async (etiket) => {
    const r = await page.evaluate(() => {
      const p = document.querySelector('.member-panel');
      if (!p) return { yok: true };
      const b = p.getBoundingClientRect();
      return {
        yok: false,
        left: Math.round(b.left), right: Math.round(b.right),
        vw: document.documentElement.clientWidth,
        gorunur: b.left < document.documentElement.clientWidth && b.right > 0,
      };
    });
    console.log(etiket.padEnd(22), JSON.stringify(r));
    return r;
  };

  const once = await durum('BASLANGIC:');

  // Uye listesini acabilecek adaylari ara.
  const adaylar = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      const label = ((el.getAttribute('aria-label') || '') + ' ' +
                     (el.getAttribute('title') || '') + ' ' +
                     (el.className || '') + ' ' +
                     (el.textContent || '')).toLowerCase();
      if (/member|uye|üye|kisi|kişi|people|roster/.test(label)) {
        const r = el.getBoundingClientRect();
        out.push({
          desc: (el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\s+/)[0]).slice(0, 50),
          label: label.trim().slice(0, 45),
          gorunur: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= document.documentElement.clientWidth,
        });
      }
    }
    return out;
  });

  console.log('\n-- uye listesi acma adaylari --');
  if (!adaylar.length) console.log('  (HICBIRI BULUNAMADI)');
  for (const a of adaylar) console.log('  ' + (a.gorunur ? 'GORUNUR ' : 'gizli   ') + a.desc + '  | ' + a.label);

  // Gorunur bir aday varsa tikla ve panelin gelip gelmedigine bak.
  const tiklanabilir = adaylar.find(a => a.gorunur);
  let sonra = null;
  if (tiklanabilir) {
    const sel = 'button, [role="button"], a';
    const clicked = await page.evaluate((needle) => {
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const label = ((el.getAttribute('aria-label') || '') + ' ' +
                       (el.getAttribute('title') || '') + ' ' +
                       (el.className || '') + ' ' + (el.textContent || '')).toLowerCase();
        const r = el.getBoundingClientRect();
        if (/member|uye|üye|kisi|kişi|people|roster/.test(label) &&
            r.width > 0 && r.left >= 0 && r.right <= document.documentElement.clientWidth) {
          el.click(); return true;
        }
      }
      return false;
    }, null);
    console.log('\ntiklandi:', clicked);
    await page.waitForTimeout(1200);
    sonra = await durum('TIKLAMA SONRASI:');
  }

  console.log('\n== SONUC ==');
  if (once.yok) {
    console.log('Panel mobilde DOM\'da HIC yok — off-canvas degil, hic render edilmiyor.');
  } else if (!once.gorunur && sonra && sonra.gorunur) {
    console.log('KASITLI CEKMECE: panel bir kontrolle ACILIYOR. UI denetimindeki');
    console.log('112 "viewport disi" olcumu YANLIS POZITIF.');
  } else if (!once.gorunur && !tiklanabilir) {
    console.log('ERISILEMEZ: panel render ediliyor ama mobilde onu acacak GORUNUR');
    console.log('bir kontrol BULUNAMADI. Gercek UX kusuru adayi.');
  } else {
    console.log('BELIRSIZ: tiklama panelin konumunu degistirmedi.');
  }

  await browser.close();
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
