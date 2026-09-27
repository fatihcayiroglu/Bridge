// server/tests/content-scanner-virustotal-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// İÇERİK TARAYICI — HASH LİSTESİ, VIRUSTOTAL VE YÜKLEME ARA KATMANI
// ════════════════════════════════════════════════════════════════════════════
//
// Bu modül bir GÜVENLİK KAPISIDIR: yüklenen her dosya buradan geçer. Ölçülmemiş
// dalların taşıdığı riskler somuttur:
//
//   · HASH LİSTESİ DOSYADAN — operatör CSAM hash listesini dosyayla verir.
//     Yükleme sessizce başarısız olursa kapı AÇIK kalır ve kimse fark etmez.
//   · VIRUSTOTAL YANITI — üçüncü taraf yanıtı tamamen dış kontroldedir: eksik
//     istatistik, hata gövdesi, "queued" durumu ve zaman aşımı hepsi ayrı
//     davranış gerektirir. `malicious` alanı eksikken 0 sayılmazsa tarama
//     `undefined > 0` ile SESSİZCE geçerdi.
//   · ARA KATMAN — `req.files` üç farklı biçimde gelir (tek dosya, dizi, alan
//     adına göre nesne). Biçim tanınmazsa dosya HİÇ taranmadan geçerdi.
//
// VirusTotal anahtarı ve hash listesi modül YÜKLENİRKEN okunur; bu yüzden
// ortam bu dosyada modülden önce kurulur.

process.env.NODE_ENV = 'test';
process.env.CONTENT_SCAN_ENABLED = 'true';
process.env.VIRUSTOTAL_API_KEY = 'vt-test-key';

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const QUARANTINE_ROOT = path.join(os.tmpdir(), `bridge-scan-${crypto.randomUUID()}`);
const HASH_LIST_PATH = path.join(os.tmpdir(), `bridge-hashlist-${crypto.randomUUID()}.txt`);

// Bilinen-kotu hash listesi: gecerli bir 64 haneli satir, kisa bir satir ve
// bos satirlar. Yalnizca 64 haneli olan listeye girmelidir.
const BAD_CONTENT = 'yasak içerik';
const BAD_HASH = crypto.createHash('sha256').update(BAD_CONTENT).digest('hex');
fs.writeFileSync(HASH_LIST_PATH, `${BAD_HASH.toUpperCase()}\n\nkisa-satir\n  \n`, 'utf8');
process.env.CSAM_HASH_LIST_FILE = HASH_LIST_PATH;

const fetchMock = jest.fn();
jest.mock('../lib/fetch', () => ({
  __esModule: true,
  default: (...args: unknown[]) => fetchMock(...args),
  fetchT: (...args: unknown[]) => fetchMock(...args),
}));
jest.mock('../lib/runtimePaths', () => ({
  __esModule: true,
  uploadDir: (...parts: string[]) => path.join(QUARANTINE_ROOT, ...parts),
  dataDir: (...parts: string[]) => path.join(QUARANTINE_ROOT, ...parts),
}));
jest.mock('../lib/logger', () => {
  const logger = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), trace: jest.fn(),
    child: () => logger,
  };
  return { __esModule: true, default: logger, logger, createLogger: () => logger };
});

const scanner = require('../lib/contentScanner') as typeof import('../lib/contentScanner');
const { contentScanMiddleware, fileHash, scanFile } = scanner;

const workDir = path.join(os.tmpdir(), `bridge-scan-work-${crypto.randomUUID()}`);
fs.mkdirSync(workDir, { recursive: true });

function tempFile(content: string | Buffer, name = `f-${crypto.randomUUID()}.bin`): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, content);
  return file;
}

function json(body: unknown, ok = true): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: async () => body };
}

function response(res: Partial<{ status: number; body: unknown }> = {}) {
  const captured: { status?: number; body?: unknown } = { ...res };
  return {
    captured,
    status(code: number) { captured.status = code; return this; },
    json(body: unknown) { captured.body = body; return this; },
  };
}

/**
 * Analiz yoklamasi tur basina 5 saniye bekler. Sahte zamanlayicilar burada
 * kullanilamaz: `fileHash` gercek bir dosya akisi tuketir ve akisin tamamlanmasi
 * icin olay dongusunun donmesi gerekir. Bunun yerine YALNIZ gecikme kisaltilir;
 * uretim akisi (tur sayisi, sira, kosullar) aynen calisir.
 */
function collapsePollingDelay(): () => void {
  const realSetTimeout = globalThis.setTimeout;
  const spy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(
    ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms && ms >= 5_000 ? 0 : ms, ...rest)) as never,
  );
  return () => spy.mockRestore();
}

beforeEach(() => { fetchMock.mockReset(); });

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(QUARANTINE_ROOT, { recursive: true, force: true });
  fs.rmSync(HASH_LIST_PATH, { force: true });
});

describe('modül kurulumu', () => {
  it('karantina dizini yoksa yaratılır', () => {
    expect(fs.existsSync(path.join(QUARANTINE_ROOT, '_quarantine'))).toBe(true);
  });

  it('hash listesi dosyadan yüklenir; yalnız 64 haneli satırlar sayılır', async () => {
    const file = tempFile(BAD_CONTENT);

    await expect(scanFile(file, { userId: 'u-1', filename: 'kotu.bin' }))
      .rejects.toMatchObject({ code: 'CONTENT_VIOLATION', statusCode: 422 });

    // Dosya yerinde birakilmaz; karantinaya tasinir.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(QUARANTINE_ROOT, '_quarantine', path.basename(file)))).toBe(true);
    // 64 haneli olmayan satirlar listeye girmedigi icin ag cagrisi yapilmadan
    // reddedilen tek sey bu hash'tir.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dosya hash\'i akış üzerinden SHA-256 olarak hesaplanır', async () => {
    const file = tempFile('merhaba');
    await expect(fileHash(file)).resolves.toBe(crypto.createHash('sha256').update('merhaba').digest('hex'));
  });
});

describe('VirusTotal önbellek yolu', () => {
  it('bilinen hash için önbellek sonucu döner ve eksik sayaçlar sıfır sayılır', async () => {
    fetchMock.mockResolvedValueOnce(json({
      data: { attributes: { last_analysis_stats: { harmless: 3 } }, links: { self: 'https://vt/permalink' } },
    }));
    const file = tempFile('temiz içerik');

    const result = await scanFile(file, { filename: 'temiz.txt' });

    expect(result).toMatchObject({
      safe: true,
      vtResult: {
        source: 'virustotal', cached: true,
        malicious: 0, suspicious: 0, undetected: 0, total: 3,
        permalink: 'https://vt/permalink',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v3/files/');
  });

  it('önbellekte kötücül bulunursa dosya karantinaya alınır ve yükleme reddedilir', async () => {
    fetchMock.mockResolvedValueOnce(json({
      data: { attributes: { last_analysis_stats: { malicious: 4, suspicious: 1, undetected: 60 } } },
    }));
    const file = tempFile('zararlı içerik');

    await expect(scanFile(file, { filename: 'virus.exe' }))
      .rejects.toMatchObject({ code: 'MALWARE_DETECTED', statusCode: 422 });

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(QUARANTINE_ROOT, '_quarantine', path.basename(file)))).toBe(true);
  });

  it('istatistik alanı eksikse yükleme yoluna geçilir', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: { attributes: {} } }))
      .mockResolvedValueOnce(json({ error: { message: 'quota exceeded' } }, false));
    const file = tempFile('bilinmeyen içerik');

    const result = await scanFile(file, { filename: 'yeni.bin' });

    expect(result).toMatchObject({ safe: true, vtResult: { source: 'virustotal', error: 'quota exceeded' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe('https://www.virustotal.com/api/v3/files');
  });

  it('hash sorgusu 2xx değilse ve yükleme hata gövdesi boşsa genel mesaj kullanılır', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'not found' }, false))
      .mockResolvedValueOnce(json({}, false));
    const file = tempFile('bilinmeyen içerik 2');

    const result = await scanFile(file, { filename: 'yeni2.bin' });

    expect(result).toMatchObject({ vtResult: { source: 'virustotal', error: 'Upload failed' } });
  });
});

describe('VirusTotal yükleme ve analiz yolu', () => {
  it('32 MB üzeri dosya yüklenmeden atlanır', async () => {
    fetchMock.mockResolvedValueOnce(json({}, false));
    const file = path.join(workDir, `big-${crypto.randomUUID()}.bin`);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 33 * 1024 * 1024);

    const result = await scanFile(file, { filename: 'big.bin' });

    expect(result).toMatchObject({
      vtResult: { source: 'virustotal', skipped: true, reason: 'File too large for VT scan' },
    });
    // Dosya YUKLENMEDI: yalnizca hash sorgusu yapildi.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fs.rmSync(file, { force: true });
  });

  it('analiz tamamlanana kadar yoklanır; hatalı ve bekleyen turlar sonucu değiştirmez', async () => {
    const restore = collapsePollingDelay();
    fetchMock
      .mockResolvedValueOnce(json({}, false))                                   // hash sorgusu
      .mockResolvedValueOnce(json({ data: { id: 'analiz-1' } }))                // yukleme
      .mockResolvedValueOnce(json({}, false))                                   // 1. yoklama: HTTP hatasi
      .mockResolvedValueOnce(json({ data: { attributes: { status: 'queued' } } })) // 2. yoklama: sirada
      .mockResolvedValueOnce(json({ data: { attributes: { status: 'completed', stats: { malicious: 0, harmless: 5 } } } }));
    const file = tempFile('analiz içeriği');

    const result = await scanFile(file, { filename: 'analiz.bin' });

    expect(result).toMatchObject({
      vtResult: { source: 'virustotal', cached: false, malicious: 0, suspicious: 0, undetected: 0, total: 5 },
    });
    expect(String(fetchMock.mock.calls[2]![0])).toContain('/api/v3/analyses/analiz-1');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    restore();
  });

  it('altı turda tamamlanmayan analiz "beklemede" olarak raporlanır', async () => {
    const restore = collapsePollingDelay();
    fetchMock
      .mockResolvedValueOnce(json({}, false))
      .mockResolvedValueOnce(json({ data: { id: 'analiz-2' } }))
      .mockResolvedValue(json({ data: { attributes: { status: 'queued' } } }));
    const file = tempFile('bekleyen içerik');

    const result = await scanFile(file, { filename: 'bekleyen.bin' });

    // Sonuc kesin degil: "temiz" DEMEZ, beklemede der.
    expect(result).toMatchObject({ vtResult: { source: 'virustotal', pending: true, analysisId: 'analiz-2' } });
    // Tam alti tur yoklandi: 1 hash + 1 yukleme + 6 analiz.
    expect(fetchMock).toHaveBeenCalledTimes(8);
    restore();
  });

  it('ağ hatası taramayı çökertmez; hata sonuçta raporlanır', async () => {
    fetchMock.mockRejectedValueOnce(new Error('vt unreachable'));
    const file = tempFile('ağ hatası içeriği');

    const result = await scanFile(file, { filename: 'ag.bin' });

    expect(result).toMatchObject({ safe: true, vtResult: { source: 'virustotal', error: 'vt unreachable' } });
  });
});

describe('yükleme ara katmanı', () => {
  it('dosya yoksa tarama yapılmaz', async () => {
    const next = jest.fn();
    await contentScanMiddleware({} as never, response() as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tek dosya, dizi ve alan-adı sözlüğü biçimlerinin üçü de taranır', async () => {
    fetchMock.mockResolvedValue(json({ data: { attributes: { last_analysis_stats: { harmless: 1 } } } }));
    const a = tempFile('a içeriği');
    const b = tempFile('b içeriği');
    const c = tempFile('c içeriği');
    const file = (p: string) => ({ path: p, originalname: path.basename(p), mimetype: 'text/plain', size: 10 });

    const single = jest.fn();
    await contentScanMiddleware({ file: file(a), user: { id: 'u-1', username: 'ada' } } as never, response() as never, single);
    expect(single).toHaveBeenCalledTimes(1);

    const asArray = jest.fn();
    await contentScanMiddleware({ files: [file(b)] } as never, response() as never, asArray);
    expect(asArray).toHaveBeenCalledTimes(1);

    const asRecord = jest.fn();
    await contentScanMiddleware({ files: { avatar: [file(c)] } } as never, response() as never, asRecord);
    expect(asRecord).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('yolu olmayan dosya kaydı atlanır', async () => {
    const next = jest.fn();
    await contentScanMiddleware(
      { files: [{ originalname: 'yok.bin', mimetype: 'text/plain', size: 1 }] } as never,
      response() as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('politika ihlali isteği 422 ile durdurur ve sonraki katmana geçmez', async () => {
    const file = tempFile(BAD_CONTENT);
    const res = response();
    const next = jest.fn();

    await contentScanMiddleware(
      { file: { path: file, originalname: 'kotu.bin', mimetype: 'application/octet-stream', size: 12 } } as never,
      res as never,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.captured.status).toBe(422);
    expect(res.captured.body).toEqual({ error: 'Content policy violation', code: 'CONTENT_VIOLATION' });
  });

  it('durum kodu taşımayan hata 422/SCAN_FAILED olarak kapanır', async () => {
    const res = response();
    const next = jest.fn();

    // Var olmayan dosya: `scanFile` duz bir Error firlatir.
    await contentScanMiddleware(
      { file: { path: path.join(workDir, 'olmayan.bin'), originalname: 'olmayan.bin', mimetype: 'text/plain', size: 1 } } as never,
      res as never,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.captured.status).toBe(422);
    expect(res.captured.body).toEqual({ error: 'File not found for scanning', code: 'SCAN_FAILED' });
  });

  it('boş dosya 400 ile reddedilir ve diskten silinir', async () => {
    const file = tempFile('');
    const res = response();
    const next = jest.fn();

    await contentScanMiddleware(
      { file: { path: file, originalname: 'bos.bin', mimetype: 'text/plain', size: 0 } } as never,
      res as never,
      next,
    );

    expect(res.captured.status).toBe(400);
    expect(res.captured.body).toEqual({ error: 'Empty file rejected', code: 'EMPTY_FILE' });
    expect(fs.existsSync(file)).toBe(false);
  });
});
