// client/tests/e2ee-truthfulness.test.ts
// Faz 11 §20 / §32 — GÜVENLİK ETİKETLERİ DOĞRU OLMAK ZORUNDA.
//
// BULUNAN DURUM (üretimde ölçüldü):
//   - `e2ee-toggle-svelte.ts` app.ts:78'den import ediliyor ve KENDİLİĞİNDEN
//     bir `#e2ee-toggle-root` div'i yaratıp `document.body`ye ekleyerek
//     E2EEToggle'ı mount ediyordu.
//   - Mount `channelId: ''` ile yapılıyordu — hiçbir kanal bağlamı yok.
//   - Toggle `/api/channels/${channelId}/e2ee` çağırıyor; BÖYLE BİR UÇ YOK
//     (routes/servers/channels.ts ve routes/messages.ts'te tanımsız).
//   - `MessageInputPanel` HİÇBİR şifreleme yapmıyor: kanal mesajları toggle
//     ne durumda olursa olsun düz metin gönderiliyor.
//   - Buna rağmen `GET /api/e2e/feature-status` `{"enabled":true}` döndüğü
//     için kontrol GÖRÜNÜYOR ve "Uçtan uca şifreleme" iddiasında bulunuyor.
//
// Yani kullanıcıya uçtan uca şifreleme sunulduğu izlenimi veriliyordu; oysa
// ne istemci şifreliyor ne de sunucuda böyle bir uç var. Bu, yanlış bir
// güvenlik güvencesidir ve ürün yüzeyinden kaldırılmıştır.
//
// KARAR: kontrol ABSENT. Bileşen dosyası korunur (gerçek, kanal kapsamlı bir
// E2EE sahibi yazıldığında yeniden bağlanabilir), ancak kendi kendini
// mount ETMEZ.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// TAM SUIT YUKUNDE ZAMAN ASIMI (mevcut borc, bu calismayla ilgisiz):
// Bu dosyadaki testler ilk `await import(...)` sirasinda Vite'in SOGUK modul
// donusumunu tetikler. Tek basina 1sn'nin altinda biter; 88 dosyalik suit
// paralel kosarken 5sn'lik VARSAYILAN siniri asabiliyordu ve test mantik
// hatasi olmadan kirmizi oluyordu. KANIT: CSRF degisikligi TAMAMEN geri
// alinip dosya sayisi eski haline getirildiginde (87 dosya / 1388 test) AYNI
// testler yine kirildi -> nedensellik bu suitteki degisikliklerde degil.
// Sinir yalnizca BU dosya icin yukseltildi; gercek asilmalar hala yakalanir.
vi.setConfig({ testTimeout: 20_000 });


beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('E2EE kontrolü kendiliğinden mount OLMAZ', () => {
  it('shim import edildiğinde body\'ye E2EE kökü EKLENMEZ', async () => {
    await import('../js/core/e2ee-toggle-svelte.ts');
    // Shim DOMContentLoaded/hazır durumda çalışır; bir tik bekle.
    await new Promise(r => setTimeout(r, 0));

    expect(document.getElementById('e2ee-toggle-root')).toBeNull();
  });

  it('socket hazır olayı da E2EE kontrolünü mount ETMEZ', async () => {
    await import('../js/core/e2ee-toggle-svelte.ts');

    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    await new Promise(r => setTimeout(r, 0));

    expect(document.getElementById('e2ee-toggle-root')).toBeNull();
    // Sayfada "E2EE" iddiası taşıyan hiçbir görünür metin olmamalı.
    expect(document.body.textContent ?? '').not.toContain('E2EE');
  });

  it('açık mount fonksiyonu HÂLÂ vardır (gelecekte gerçek sahiple bağlanır)', async () => {
    const mod = await import('../js/core/e2ee-toggle-svelte.ts');

    // Bileşen silinmedi; yalnız kendini ürün yüzeyine dayatmıyor.
    expect(typeof mod.mountE2EEToggle).toBe('function');
  });

  it('açıkça mount edilirse GEÇERLİ bir channelId zorunludur', async () => {
    const mod = await import('../js/core/e2ee-toggle-svelte.ts');
    const host = document.createElement('div');
    document.body.appendChild(host);

    // channelId olmadan mount edilmeye çalışılırsa kontrol render EDİLMEZ:
    // kanal bağlamı olmayan bir E2EE anahtarı anlamsızdır ve yanıltıcıdır.
    mod.mountE2EEToggle(host, '');
    await new Promise(r => setTimeout(r, 0));

    expect(host.textContent ?? '').not.toContain('E2EE');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ D0 — ÜRÜN YÜZEYİNDE E2EE İDDİASI BULUNMAZ
// ════════════════════════════════════════════════════════════════════════════
//
// Durum: E2EE = ARCHITECTURE_REQUIRED.
//
// Ölçülen gerçek: istemci HİÇBİR şifreleme yapmıyor — `crypto.subtle` yok,
// `encryptedContent` üretilmiyor, sunucudaki anahtar değişim olaylarını
// (`channel:e2ee:setup`, `keys:get`, `keys:add`) çağıran istemci dosyası yok,
// cihaz kimliği/anahtar dağıtımı tablosu yok. Bu yüzden kullanıcıya
// "uçtan uca şifreleme aktif" diyen HİÇBİR kontrol ürüne bağlanamaz:
// doğrulanmayan bir güvenlik güvencesi, hiç güvence vermemekten kötüdür.
//
// Arka uç iskelesi (rotalar, olaylar, `encryptedContent`/`iv`, migration'lar)
// KASITLI olarak korunur — gerçek mimari yazıldığında gerekecektir.
describe('D0 — E2EE iddiası ürün yüzeyine bağlı DEĞİLDİR', () => {
  const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

  it('kabukta E2EE kökü YOKTUR (index.html)', () => {
    expect(read('index.html')).not.toContain('e2ee-toggle-root');
  });

  it('GÜVENLİK: `mountE2EEToggle` üretim kodundan ÇAĞRILMAZ', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (/\.(ts|js|svelte)$/.test(e.name)) files.push(f);
      }
    };
    walk(path.join(CLIENT, 'js'));

    const callers = files.filter(f => {
      const rel = path.relative(CLIENT, f).split(path.sep).join('/');
      if (rel === 'js/core/e2ee-toggle-svelte.ts') return false;   // tanımın kendisi
      return /mountE2EEToggle\s*\(/.test(fs.readFileSync(f, 'utf8'));
    });

    expect(callers).toEqual([]);
  });

  it('GÜVENLİK: app.ts E2EE toggle shim’ini ürün akışına BAĞLAMAZ', () => {
    // Shim import edilse bile kendiliğinden mount etmemeli; asıl güvence
    // yukarıdaki "çağıran yok" testidir. Burada iddia METNİNİN ürün
    // girişinden erişilebilir olmadığı sabitlenir.
    const app = read('js/app.ts');
    expect(app).not.toMatch(/mountE2EEToggle/);
  });

  it('GÜVENLİK: local-at-rest crypto E2EE uygulaması gibi sunulamaz', () => {
    // P7 local-first artık gerçek AES-GCM kullanır; bu yalnız cihazdaki yerel
    // kayıtları korur ve uçtan uca mesaj anahtar yönetimi anlamına GELMEZ.
    // Kripto yüzeyi beklenmedik biçimde başka client katmanlarına yayılırsa bu
    // test kırılır ve E2EE iddiaları yeniden değerlendirilmek zorunda kalır.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (/\.(ts|svelte)$/.test(e.name)) files.push(f);
      }
    };
    walk(path.join(CLIENT, 'js'));

    const crypto = files
      .filter(f => /crypto\.subtle|generateKey\(|deriveKey\(|subtle\.encrypt/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(CLIENT, f).split(path.sep).join('/'));

    expect(crypto).toEqual(['js/core/local-first/crypto.ts']);
    const localFirstCrypto = read('js/core/local-first/crypto.ts');
    expect(localFirstCrypto).toContain('local-first encryption envelope');
    expect(localFirstCrypto).not.toMatch(/dm:send|gdm:send|message:send/);
  });
});
