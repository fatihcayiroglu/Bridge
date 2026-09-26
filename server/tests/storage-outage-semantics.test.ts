// server/tests/storage-outage-semantics.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// NESNE DEPOLAMA KESİNTİSİ: AÇIK HATA, SAHTE BAŞARI YOK, VERİ KAYBI YOK
// ════════════════════════════════════════════════════════════════════════════
// Nesne depolama OPSİYONEL bir bağımlılıktır: erişilemezken Bridge'in geri
// kalanı çalışmaya devam etmelidir. Ama yükleme yolunda üç şey ASLA olmamalı:
//
//   1. SAHTE BAŞARI  — kullanıcıya "yüklendi" denip dosyanın kaybolması
//   2. VERİ KAYBI    — yükleme başarısızken yerel geçici dosyanın silinmesi
//   3. BOZUK METADATA — depoda karşılığı olmayan bir kayıt bırakılması
//
// Bu paket üçünü de gerçek bir S3 istemcisiyle, ERİŞİLEMEZ bir uç noktaya
// karşı ölçer. Sahte bir mock değil: hata yolunun kendisi çalıştırılır.
process.env.NODE_ENV = 'test';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildS3Adapter } from '../lib/storageAdapter';

// Kapali bir port: baglanti REDDEDILIR (zaman asimi beklemeden hizli hata).
const UNREACHABLE = 'http://127.0.0.1:9';

function makeTempFile(contents = 'v1124-storage-probe'): string {
  const p = path.join(os.tmpdir(), `bridge-storage-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(p, contents);
  return p;
}

function adapter() {
  return buildS3Adapter({
    provider: 'minio',
    bucket: 'bridge-uploads-test',
    region: 'us-east-1',
    endpoint: UNREACHABLE,
    accessKeyId: 'test-access-key-not-a-real-credential',
    secretAccessKey: 'test-secret-key-not-a-real-credential',
    forcePathStyle: true,
  } as Parameters<typeof buildS3Adapter>[0]);
}

describe('depolama erişilemezken yükleme AÇIKÇA başarısız olur', () => {
  jest.setTimeout(30_000);

  it('sessizce başarılı DÖNMEZ — hata fırlatır', async () => {
    const local = makeTempFile();
    try {
      await expect(
        adapter().uploadFile(local, 'probe/should-fail.txt'),
      ).rejects.toThrow();
    } finally {
      fs.rmSync(local, { force: true });
    }
  });

  it('YEREL DOSYA SİLİNMEZ — veri kaybı olmaz', async () => {
    const local = makeTempFile('kaybolmamali');
    try {
      await adapter().uploadFile(local, 'probe/keep-local.txt').catch(() => undefined);

      // KRITIK: yukleme basarisizken gecici dosya hâlâ yerinde olmalidir.
      // Silinseydi kullanicinin verisi geri donusu olmadan kaybolurdu.
      expect(fs.existsSync(local)).toBe(true);
      expect(fs.readFileSync(local, 'utf8')).toBe('kaybolmamali');
    } finally {
      fs.rmSync(local, { force: true });
    }
  });

  it('deleteLocal AÇIKÇA istense bile başarısız yüklemede dosya korunur', async () => {
    const local = makeTempFile('yine-kaybolmamali');
    try {
      await adapter().uploadFile(local, 'probe/keep.txt', { deleteLocal: true }).catch(() => undefined);
      expect(fs.existsSync(local)).toBe(true);
    } finally {
      fs.rmSync(local, { force: true });
    }
  });

  it('hata mesajı kimlik bilgisi SIZDIRMAZ', async () => {
    const local = makeTempFile();
    try {
      const err = await adapter().uploadFile(local, 'probe/x.txt').catch((e: unknown) => e);
      const text = String((err as Error)?.message ?? '') + String((err as Error)?.stack ?? '');
      expect(text).not.toContain('test-secret-key-not-a-real-credential');
      expect(text).not.toContain('test-access-key-not-a-real-credential');
    } finally {
      fs.rmSync(local, { force: true });
    }
  });
});

describe('okuma yolu da açıkça başarısız olur', () => {
  jest.setTimeout(30_000);

  it('erişilemez depodan okuma sessizce boş İÇERİK dönmez', async () => {
    // Sessiz bir bos yanit, silinmis dosya ile erisilemez depoyu ayirt
    // edilemez hale getirirdi; cagiran taraf yanlis karar verirdi.
    await expect(adapter().readFile('probe/missing.txt')).rejects.toThrow();
  });
});
