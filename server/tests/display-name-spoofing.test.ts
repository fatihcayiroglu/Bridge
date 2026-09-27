// server/tests/display-name-spoofing.test.ts
//
// GÖRÜNEN AD — KİMLİK TAKLİDİ SAVUNMASI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK (P2)
// ════════════════════════════════════════════════════════════════════════════
// `username` ASCII ile sınırlıdır, ama `displayName` yalnızca
// `{ type: 'string', max: 80 }` ile doğrulanıyordu. Kullanıcıların GÖRDÜĞÜ ad
// budur: üye listesi, mesaj başlığı, mention, ses katılımcıları, moderasyon
// kayıtları.
//
// CANLI SUNUCUYA KARŞI ÖLÇÜLDÜ (e2e/_identity-spoof.cjs, pozitif kontrol 200):
//   düzeltme ÖNCESİ  7/8 taklit vektörü kabul edildi ve AYNEN saklandı
//   düzeltme SONRASI 2/8 (yalnızca Kiril/Yunan — bilinçli, aşağıya bakın)
//
// En keskin olanı RTL geçersiz kılmaydı:
//   "user" + U+202E + "gnp.exe"   ekranda   "userexe.png"
// Dosya adı sahteciliğinin klasik biçiminin kimliğe uygulanmışı.
//
// ── NEDEN KİRİL/YUNAN HÂLÂ KABUL EDİLİYOR ───────────────────────────────────
// "Аdmin" (U+0410) GEÇERLİ Kiril metnidir. Karakter yasaklayarak çözmek,
// Kiril/Yunan/Türkçe adlı GERÇEK kullanıcıları cezalandırırdı. Mimari cevap
// şudur: görünen ad kimlik GARANTİSİ değildir; benzersiz `username` odur ve
// profil kartında `@username` olarak GÖSTERİLİR
// (client/js/core/MemberProfilePopover.svelte:269).

import { sanitizeDisplayName, hasDeceptiveCharacters, DISPLAY_NAME_MAX } from '../lib/displayName';

// Kod noktaları sayısal yazılır: kaynağa görünmez karakter koymak testi
// okunamaz ve `grep` açısından ikili hâle getirirdi.
const ZWSP   = String.fromCharCode(0x200b);
const ZWNJ   = String.fromCharCode(0x200c);
const ZWJ    = String.fromCharCode(0x200d);
const RLO    = String.fromCharCode(0x202e);
const LRO    = String.fromCharCode(0x202d);
const BOM    = String.fromCharCode(0xfeff);
const NBSP   = String.fromCharCode(0x00a0);
const FULL_A = String.fromCharCode(0xff21);   // fullwidth A
const CYR_A  = String.fromCharCode(0x0410);   // Kiril А
const ACUTE  = String.fromCharCode(0x0301);

// ════════════════════════════════════════════════════════════════════════════
// SÖMÜRÜ VEKTÖRLERİ — gerileme kilidi
// ════════════════════════════════════════════════════════════════════════════
describe('görsel hile karakterleri', () => {
  it('SIFIR GENİŞLİKLİ karakterler kaldırılır — görünmez ikiz üretilemez', () => {
    expect(sanitizeDisplayName('Ad' + ZWSP + 'min')).toBe('Admin');
    expect(sanitizeDisplayName('Ad' + ZWJ + 'min')).toBe('Admin');
    expect(sanitizeDisplayName('Ad' + ZWNJ + 'min')).toBe('Admin');
    expect(sanitizeDisplayName('Admin' + BOM)).toBe('Admin');
  });

  it('RTL GEÇERSİZ KILMA kaldırılır — metin ters çevrilemez', () => {
    // Duzeltmeden once ekranda "userexe.png" olarak goruntuleniyordu.
    expect(sanitizeDisplayName('user' + RLO + 'gnp.exe')).toBe('usergnp.exe');
    expect(sanitizeDisplayName(LRO + 'Admin')).toBe('Admin');
  });

  it('TAM GENİŞLİK harfler NFKC ile normalleştirilir', () => {
    expect(sanitizeDisplayName(FULL_A + 'dmin')).toBe('Admin');
  });

  it('BOŞLUK TAKLİTLERİ normal boşluğa indirilir ve sıkıştırılır', () => {
    expect(sanitizeDisplayName('Ad' + NBSP + 'min')).toBe('Ad min');
    expect(sanitizeDisplayName('  Ali    Veli  ')).toBe('Ali Veli');
  });

  it('ZALGO yığını sınırlanır — UI taşması engellenir', () => {
    const zalgo = 'A' + ACUTE.repeat(40) + 'dmin';
    const out = sanitizeDisplayName(zalgo);
    // Ardisik birlestirici sayisi 2'yi asmamali.
    const enUzunSeri = Math.max(...out.split('').reduce((acc: number[], ch) => {
      if (ch === ACUTE) acc[acc.length - 1] = (acc[acc.length - 1] || 0) + 1;
      else acc.push(0);
      return acc;
    }, [0]));
    expect({ enUzunSeri: enUzunSeri <= 2 }).toEqual({ enUzunSeri: true });
    expect(out.length).toBeLessThan(zalgo.length);
  });

  it('KONTROL karakterleri (NUL / yeni satır) kaldırılır', () => {
    const NUL = String.fromCharCode(0x0000);
    const LF  = String.fromCharCode(0x000a);
    // NUL tamamen kaldirilir; LF once kaldirilir, kalan bosluk sikistirilir.
    expect(sanitizeDisplayName('Ad' + NUL + 'min')).toBe('Admin');
    expect(sanitizeDisplayName('Ad' + LF + 'min')).toBe('Admin');
  });

  it('birden çok vektör BİRLİKTE kullanılamaz', () => {
    const kotu = LRO + 'Ad' + ZWSP + NBSP + 'min' + RLO + BOM;
    expect(sanitizeDisplayName(kotu)).toBe('Ad min');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POZİTİF KONTROL — meşru uluslararası adlar KORUNUR
// ════════════════════════════════════════════════════════════════════════════
describe('POZİTİF KONTROL: meşru adlar bozulmaz', () => {
  it('Türkçe karakterler korunur', () => {
    // Asiri genis bir yama (orn. ASCII-disi her seyi at) bu testte dusurdu.
    expect(sanitizeDisplayName('Ayşe Çağrı Öz')).toBe('Ayşe Çağrı Öz');
    expect(sanitizeDisplayName('İsmail Işık')).toBe('İsmail Işık');
  });

  it('Kiril ve Yunan adlar korunur', () => {
    const dmitri = String.fromCharCode(0x0414, 0x043c, 0x0438, 0x0442, 0x0440, 0x0438, 0x0439);
    expect(sanitizeDisplayName(dmitri)).toBe(dmitri);
  });

  it('emoji korunur', () => {
    expect(sanitizeDisplayName('Ali 🎧')).toBe('Ali 🎧');
  });

  it('tek aksanlı harf korunur (Zalgo sınırı meşru aksanı bozmaz)', () => {
    const E_ACUTE = String.fromCharCode(0x00e9);          // bilesik é
    expect(sanitizeDisplayName('Jos' + E_ACUTE)).toBe('Jos' + E_ACUTE);
    // Ayrisik biçim NFKC ile bilesik hale gelir — ikisi de ayni sonucu verir.
    expect(sanitizeDisplayName('Jos' + 'e' + ACUTE)).toBe('Jos' + E_ACUTE);
    expect(sanitizeDisplayName('e' + ACUTE)).toBe(String.fromCharCode(0x00e9));
  });

  it('Kiril homoglifi KASITLI olarak korunur (mimari karar)', () => {
    // Bunu yasaklamak gercek Kiril kullanicilarini cezalandirirdi. Kimlik
    // garantisi benzersiz `username`dir ve profil kartinda gosterilir.
    expect(sanitizeDisplayName(CYR_A + 'dmin')).toBe(CYR_A + 'dmin');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SINIR DURUMLARI
// ════════════════════════════════════════════════════════════════════════════
describe('sınır durumları', () => {
  it('uzunluk sınırı korunur', () => {
    expect(sanitizeDisplayName('x'.repeat(200))).toHaveLength(DISPLAY_NAME_MAX);
  });

  it('tamamen görünmez girdi BOŞ döner — çağıran geri düşebilsin', () => {
    expect(sanitizeDisplayName(ZWSP + ZWJ + BOM + RLO)).toBe('');
    expect(sanitizeDisplayName('   ')).toBe('');
  });

  it('dize olmayan girdi güvenle boş döner', () => {
    expect({
      yok:   sanitizeDisplayName(undefined),
      nul:   sanitizeDisplayName(null),
      sayi:  sanitizeDisplayName(42),
      nesne: sanitizeDisplayName({}),
    }).toEqual({ yok: '', nul: '', sayi: '', nesne: '' });
  });

  it('idempotenttir — iki kez uygulamak sonucu değiştirmez', () => {
    for (const v of ['Ad' + ZWSP + 'min', 'Ayşe Çağrı', FULL_A + 'dmin', 'Ali 🎧']) {
      const bir = sanitizeDisplayName(v);
      expect(sanitizeDisplayName(bir)).toBe(bir);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESPİT — denetim/moderasyon için
// ════════════════════════════════════════════════════════════════════════════
describe('hasDeceptiveCharacters', () => {
  it('hile karakterlerini TESPİT eder', () => {
    expect({
      zwsp: hasDeceptiveCharacters('Ad' + ZWSP + 'min'),
      rlo:  hasDeceptiveCharacters('user' + RLO + 'x'),
      ctrl: hasDeceptiveCharacters('Ad' + String.fromCharCode(0x0007) + 'min'),
    }).toEqual({ zwsp: true, rlo: true, ctrl: true });
  });

  it('meşru adları hile olarak İŞARETLEMEZ', () => {
    expect({
      tr:    hasDeceptiveCharacters('Ayşe Çağrı'),
      emoji: hasDeceptiveCharacters('Ali 🎧'),
      duz:   hasDeceptiveCharacters('Admin'),
    }).toEqual({ tr: false, emoji: false, duz: false });
  });

  it('ardışık çağrılarda durum TAŞIMAZ (lastIndex hatası)', () => {
    // `g` bayrakli RegExp.test() lastIndex tasir; sifirlanmazsa ikinci cagri
    // YANLIS NEGATIF verir — sessiz ve tehlikeli bir hata sinifi.
    const v = 'Ad' + ZWSP + 'min';
    expect([1, 2, 3, 4].map(() => hasDeceptiveCharacters(v))).toEqual([true, true, true, true]);
  });
});
