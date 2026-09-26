// server/tests/messages-send-error-semantics.test.ts
//
// GÖNDERİM HATA ANLAMBİLİMİ — REDDETME, "ZAMAN AŞIMI" DEĞİL
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `messages-send.ts` içindeki üç doğrulama dalı SESSİZCE çıkıyordu:
//
//     if (!valid) return;
//     if (type !== 'file' && type !== 'e2ee' && !content?.trim()) return;
//     if (content && content.length > 2000) return;
//
// Ne ACK ne hata yayılıyordu. İstemci (`MessageInputPanel`, ACK_TIMEOUT_MS =
// 10_000) kendi zaman aşımını yazıyordu:
//
//     "Sunucu onayı zaman aşımına uğradı."
//
// Yani KASITLI BİR REDDETME, SUNUCU CEVAP VERMİYOR gibi görünüyordu. Bunlar
// farklı sorunlardır: biri "düzelt", diğeri "yeniden dene" davranışı gerektirir.
//
// Hemen ALTINDAKİ dosya kontrolü zaten doğru sözleşmeyi uyguluyordu
// (`INVALID_FILE_REFERENCE` + ackId/tmpId yankısı) — eksik olan yalnızca
// doğrulama dallarıydı.
//
// ── CANLI ÖLÇÜM (iki soket, gerçek sunucu) ────────────────────────────────
// `type: 'text'` içeren tamamen makul bir yük şema enum'una
// (`['normal','file']`) uymadığı için SESSİZCE düşürüldü; aynı yük `type`
// alanı olmadan gönderildiğinde ACK aldı.
//
// ── ŞİDDET (dürüst) ───────────────────────────────────────────────────────
// Normal yazma alanından ULAŞILAMAZ: istemci `maxlength=2000` uygular, boş
// gönderimi engeller ve `type` alanını yalnızca dosyalarda gönderir. Bu bir
// P0 değildir. Ama sözleşme boşluğu gerçektir: entegrasyonlar, botlar, eski
// istemciler ve gelecekteki istemci hataları bu yola girip YANLIŞ teşhis alır.

import fs from 'fs';
import path from 'path';

const HANDLER = fs.readFileSync(
  path.join(__dirname, '..', 'socket', 'handlers', 'messages-send.ts'), 'utf8',
);

/** Açıklama satırları çıkarılır — yorum metni korumayı tetiklemesin. */
const code = HANDLER
  .split(/\r?\n/)
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

/** Doğrulama bloğu: `validateSocketPayload` çağrısından dosya kontrolüne kadar. */
const validationBlock = code.slice(
  code.indexOf('const { valid } = validateSocketPayload'),
  code.indexOf('INVALID_FILE_REFERENCE'),
);

describe('gönderim doğrulaması SESSİZCE düşürmez', () => {
  it('şema reddi AÇIK bir hata yayar', () => {
    expect(validationBlock).toMatch(/if \(!valid\) \{/);
    expect(validationBlock).toMatch(/INVALID_PAYLOAD/);
  });

  it('boş içerik AÇIK bir hata yayar', () => {
    expect(validationBlock).toMatch(/EMPTY_MESSAGE/);
  });

  it('aşırı uzun içerik AÇIK bir hata yayar', () => {
    expect(validationBlock).toMatch(/MESSAGE_TOO_LONG/);
  });

  it('hiçbir doğrulama dalı ÇIPLAK `return` ile çıkmaz', () => {
    // Asıl kusur buydu: hata yaymadan sessizce çıkmak.
    const bareReturns = validationBlock.match(/^\s*if \([^)]*\) return;\s*$/gm) ?? [];
    expect(bareReturns).toHaveLength(0);
  });

  it('reddetme `ackId` ve `tmpId` YANKILAR', () => {
    // İstemci hangi gönderimin reddedildiğini bilmeli; aksi halde iyimser
    // balon `pending` durumunda asılı kalır.
    const rejectFn = code.slice(code.indexOf('const reject ='), code.indexOf('if (!valid)'));
    expect(rejectFn).toMatch(/validAckId \? \{ ackId \}/);
    expect(rejectFn).toMatch(/validTmpId \? \{ tmpId: _tmpId \}/);
  });

  it('reddetme KANONİK `error:message` olayını kullanır — yeni olay icat edilmez', () => {
    const rejectFn = code.slice(code.indexOf('const reject ='), code.indexOf('if (!valid)'));
    expect(rejectFn).toMatch(/socket\.emit\('error:message'/);
    expect(rejectFn).toMatch(/event: 'message:send'/);
  });

  it('kodlar SABİT ve makine-okunur', () => {
    // İstemci/entegrasyon davranışını koda göre ayırabilmeli, metne göre değil.
    for (const c of ['INVALID_PAYLOAD', 'EMPTY_MESSAGE', 'MESSAGE_TOO_LONG']) {
      expect(code).toContain(`'${c}'`);
    }
  });

  it('reddetme İÇ AYRINTI sızdırmaz', () => {
    // Şema hataları, yığın izleri, dosya yolları kullanıcıya gitmez.
    const rejectFn = code.slice(code.indexOf('const reject ='), code.indexOf('if (!valid)'));
    expect(rejectFn).not.toMatch(/errors/);
    expect(rejectFn).not.toMatch(/stack/);
    expect(rejectFn).not.toMatch(/JSON\.stringify/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('şema ile işleyici tutarlılığı', () => {
  const VALIDATE = fs.readFileSync(
    path.join(__dirname, '..', 'middleware', 'validate.ts'), 'utf8',
  );

  it('işleyicinin kabul ettiği `type` değerleri BELGELENMİŞTİR', () => {
    // BULGU (düzeltilmedi, bilerek raporlanıyor):
    // İşleyici `type === 'e2ee'` dalını taşır (E2EE gönderimi, `encryptedContent`
    // ve `iv` zorunluluğu, kanal E2EE kontrolü). Fakat şema enum'u yalnızca
    // `['normal','file','sticker']` kabul eder — yani `type: 'e2ee'` şemadan
    // GEÇEMEZ ve `if (!valid)` dalında reddedilir. İstemci tarafında da
    // `type: 'e2ee'` gönderen HİÇBİR kod yoktur.
    //
    // Sonuç: soket üzerinden E2EE gönderim yolu UÇTAN UCA ULAŞILAMAZDIR.
    // Bu test durumu SABİTLER; davranışı değiştirmez. E2EE'yi etkinleştirmek
    // ürün kararıdır ve güvenlik incelemesi gerektirir — sessizce enum'a
    // değer eklemek yanlış olurdu.
    expect(HANDLER).toMatch(/type === 'e2ee'/);
    // Kanonik enum `sticker`'ı da içerir (sticker gönderimi ÜRÜNDE vardır);
    // `e2ee` hâlâ YOKTUR ve bu testin sabitlediği durum tam olarak budur.
    expect(VALIDATE).toMatch(/enum: \['normal', 'file', 'sticker'\]/);
    expect(VALIDATE).not.toMatch(/enum: \[[^\]]*'e2ee'[^\]]*\]/);
  });
});
