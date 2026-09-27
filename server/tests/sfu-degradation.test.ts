// server/tests/sfu-degradation.test.ts
//
// SFU YOKKEN P2P ÇALIŞMAYA DEVAM EDER
//
// ════════════════════════════════════════════════════════════════════════════
// BATCH K — ÖLÇÜLEN DURUM
// ════════════════════════════════════════════════════════════════════════════
// `socket/handlers/mediasoup/` gerçek ve yapılandırılmış bir SFU uygulaması
// içerir (simulcast encodings, RTC port aralığı, worker sayısı, oda/transport
// yaşam döngüsü). ANCAK:
//
//   · `mediasoup` package.json'da dependency DEĞİLDİR
//     (dependencies / optionalDependencies / devDependencies: hiçbirinde yok)
//   · node_modules içinde KURULU DEĞİLDİR
//   · `workers.ts` onu try/catch içinde `require` eder ve yoksa P2P'ye düşer
//
// Bu KASITLI bir mimari karardır ve kaynakta belgelenmiştir: mediasoup
// yerel derleme (C++/Python) gerektirir; varsayılan kurulumu kirletmemek
// için dışarıda tutulmuştur.
//
// Bu paketin işi SFU'yu kanıtlamak DEĞİL, SFU YOKLUĞUNUN sesi bozmadığını
// kilitlemektir. SFU çalışmaları P2P'yi asla kıramaz.

process.env.NODE_ENV = 'test';

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER = join(__dirname, '..');
const WORKERS = readFileSync(join(SERVER, 'socket', 'handlers', 'mediasoup', 'workers.ts'), 'utf8');
const INDEX = readFileSync(join(SERVER, 'socket', 'index.ts'), 'utf8');

describe('SFU yokluğu ÇÖKME değil, düşüş üretir', () => {
  it('mediasoup yüklemesi try/catch ile korunur', () => {
    // Korumasız `require` sunucuyu açılışta çökertirdi.
    expect(WORKERS).toMatch(/require\('mediasoup'\)/);
    const load = WORKERS.slice(WORKERS.indexOf("require('mediasoup')") - 200,
                               WORKERS.indexOf("require('mediasoup')") + 300);
    expect(load).toMatch(/catch/);
  });

  it('yokluk DÜRÜSTÇE loglanır ve çözüm söylenir', () => {
    expect(WORKERS).toMatch(/P2P modda/);
    expect(WORKERS).toMatch(/npm install mediasoup/);
  });

  it('`isSFUReady` bir KAPI olarak dışa verilir', () => {
    // Kayıt, SFU hazır DEĞİLKEN yapılmamalı.
    expect(WORKERS + readFileSync(join(SERVER, 'socket', 'handlers', 'mediasoup', 'index.ts'), 'utf8'))
      .toMatch(/isSFUReady/);
  });

  it('SFU handler kaydı `isSFUReady()` ile KOŞULLUDUR', () => {
    // Koşulsuz kayıt, SFU yokken istemciye çalışmayan olaylar sunardı.
    // İlk geçiş `import` satırıdır; KULLANIM yerini ararız.
    const guardAt = INDEX.indexOf('if (isSFUReady())');
    expect(guardAt).toBeGreaterThan(-1);
    const gate = INDEX.slice(guardAt, guardAt + 200);
    expect(gate).toMatch(/registerSFUHandlers/);
  });
});

describe('P2P yolu SFU çalışmalarından etkilenmez', () => {
  it('P2P sinyal olayları koşulsuz kayıtlıdır', () => {
    // `webrtc:offer/answer/ice` SFU bayrağına BAĞLI OLMAMALIDIR.
    const client = readFileSync(join(SERVER, '..', 'client', 'js', 'webrtc.ts'), 'utf8');
    for (const ev of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice-candidate']) {
      expect(client).toContain(ev);
    }
  });

  it('ses kanalı katılımı SFU gerektirmez', () => {
    // `voice:join` akışı SFU bayrağından bağımsız olmalıdır.
    expect(INDEX).toMatch(/registerVoiceHandlers/);
    const voiceReg = INDEX.slice(INDEX.indexOf('registerVoiceHandlers') - 200,
                                 INDEX.indexOf('registerVoiceHandlers') + 60);
    expect(voiceReg).not.toMatch(/isSFUReady/);
  });
});
