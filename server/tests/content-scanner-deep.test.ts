import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const savedEnv = { ...process.env };
let root = '';

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
}

function mockResponse(ok: boolean, body: unknown) {
  return { ok, json: jest.fn(async () => body) };
}

function loadScanner(opts: {
  enabled?: boolean;
  badHashes?: string;
  vtKey?: string;
  fetchImpl?: jest.Mock;
} = {}) {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.BRIDGE_UPLOAD_ROOT = root;
  process.env.CONTENT_SCAN_ENABLED = opts.enabled === false ? 'false' : 'true';
  if (opts.badHashes !== undefined) process.env.CSAM_HASH_LIST = opts.badHashes;
  else delete process.env.CSAM_HASH_LIST;
  if (opts.vtKey) process.env.VIRUSTOTAL_API_KEY = opts.vtKey;
  else delete process.env.VIRUSTOTAL_API_KEY;

  const fetchT = opts.fetchImpl ?? jest.fn();
  jest.doMock('../lib/fetch', () => ({ fetchT }));
  const scanner = require('../lib/contentScanner');
  return { scanner, fetchT };
}

function write(name: string, data: string | Buffer): string {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

describe('contentScanner deep production behavior', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-content-scan-'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('../lib/fetch');
    fs.rmSync(root, { recursive: true, force: true });
    restoreEnv();
  });

  it('disabled scanner skips before filesystem access', async () => {
    const { scanner } = loadScanner({ enabled: false });
    await expect(scanner.scanFile(path.join(root, 'missing.bin')))
      .resolves.toEqual({ safe: true, skipped: true });
  });

  it('enabled scanner rejects a missing file', async () => {
    const { scanner } = loadScanner();
    await expect(scanner.scanFile(path.join(root, 'missing.bin')))
      .rejects.toThrow('File not found for scanning');
  });

  it('known bad hash is quarantined with metadata and fails closed', async () => {
    const content = Buffer.from('known-bad-content');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const fp = write('bad.bin', content);
    const { scanner } = loadScanner({ badHashes: ` ${hash.toUpperCase()} ` });

    await expect(scanner.scanFile(fp, { userId: 'u1', filename: 'bad.bin' }))
      .rejects.toMatchObject({ code: 'CONTENT_VIOLATION', statusCode: 422, safe: false });

    expect(fs.existsSync(fp)).toBe(false);
    const quarantined = scanner.listQuarantinedFiles();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({ filename: 'bad.bin', reason: 'CSAM_HASH_MATCH' });
    expect(quarantined[0].originalPath).toBe(fp);
  });

  it('cached VirusTotal clean result is returned in scan evidence', async () => {
    const fp = write('clean.bin', 'clean-vt');
    const fetchT = jest.fn().mockResolvedValue(mockResponse(true, {
      data: {
        attributes: { last_analysis_stats: { malicious: 0, suspicious: 1, undetected: 9, harmless: 2 } },
        links: { self: 'https://vt/files/hash' },
      },
    }));
    const { scanner } = loadScanner({ vtKey: 'vt-test', fetchImpl: fetchT });
    const result = await scanner.scanFile(fp, { mimetype: 'application/octet-stream' });

    expect(result).toMatchObject({
      safe: true,
      vtResult: { source: 'virustotal', cached: true, malicious: 0, suspicious: 1, undetected: 9, total: 12 },
    });
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  it('cached VirusTotal malware is quarantined and rejected', async () => {
    const fp = write('malware.bin', 'malware');
    const fetchT = jest.fn().mockResolvedValue(mockResponse(true, {
      data: { attributes: { last_analysis_stats: { malicious: 2, suspicious: 0, undetected: 1 } } },
    }));
    const { scanner } = loadScanner({ vtKey: 'vt-test', fetchImpl: fetchT });

    await expect(scanner.scanFile(fp, { userId: 'u-mal' }))
      .rejects.toMatchObject({ code: 'MALWARE_DETECTED', statusCode: 422, safe: false });
    expect(fs.existsSync(fp)).toBe(false);
    expect(scanner.listQuarantinedFiles()[0]).toMatchObject({ reason: 'VIRUSTOTAL_MALWARE' });
  });

  it('VirusTotal upload is skipped for files above 32 MiB without reading them into memory', async () => {
    const fp = path.join(root, 'large.bin');
    fs.writeFileSync(fp, Buffer.from([1]));
    fs.truncateSync(fp, 33 * 1024 * 1024);
    const fetchT = jest.fn().mockResolvedValue(mockResponse(false, {}));
    const { scanner } = loadScanner({ vtKey: 'vt-test', fetchImpl: fetchT });

    const result = await scanner.scanFile(fp);
    expect(result.vtResult).toMatchObject({ source: 'virustotal', skipped: true, reason: 'File too large for VT scan' });
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  it('VirusTotal upload API error is evidence, not an unsafe scan bypass exception', async () => {
    const fp = write('vt-upload.bin', 'small');
    const fetchT = jest.fn()
      .mockResolvedValueOnce(mockResponse(false, {}))
      .mockResolvedValueOnce(mockResponse(false, { error: { message: 'quota exceeded' } }));
    const { scanner } = loadScanner({ vtKey: 'vt-test', fetchImpl: fetchT });

    const result = await scanner.scanFile(fp);
    expect(result).toMatchObject({ safe: true, vtResult: { source: 'virustotal', error: 'quota exceeded' } });
    expect(fetchT).toHaveBeenCalledTimes(2);
  });

  it('VirusTotal network failure is contained and recorded', async () => {
    const fp = write('vt-net.bin', 'small');
    const fetchT = jest.fn().mockRejectedValue(new Error('network down'));
    const { scanner } = loadScanner({ vtKey: 'vt-test', fetchImpl: fetchT });

    const result = await scanner.scanFile(fp);
    expect(result.vtResult).toMatchObject({ source: 'virustotal', error: 'network down' });
  });

  it('empty files are removed and rejected', async () => {
    const fp = write('empty.bin', Buffer.alloc(0));
    const { scanner } = loadScanner();
    await expect(scanner.scanFile(fp)).rejects.toMatchObject({ code: 'EMPTY_FILE', statusCode: 400 });
    expect(fs.existsSync(fp)).toBe(false);
  });

  it.each([
    ['script', '<svg><script>alert(1)</script></svg>'],
    ['javascript-url', '<svg><a href="javascript:alert(1)">x</a></svg>'],
    ['event-handler', '<svg><rect onload="alert(1)" /></svg>'],
    ['foreign-object', '<svg><foreignObject><div>x</div></foreignObject></svg>'],
    ['external-xlink', '<svg><image xlink:href="https://evil.test/x" /></svg>'],
  ])('dangerous SVG pattern %s is quarantined', async (_label, svg) => {
    const fp = write(`${_label}.svg`, svg);
    const { scanner } = loadScanner();
    await expect(scanner.scanFile(fp, { mimetype: 'image/svg+xml' }))
      .rejects.toMatchObject({ code: 'SVG_XSS', statusCode: 422 });
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('clean SVG and non-SVG images pass anomaly scanning', async () => {
    const svg = write('clean.svg', '<svg><rect width="1" height="1" /></svg>');
    const pngLike = write('not-scanned-here.png', 'signature is handled by uploadFileSafety');
    const { scanner } = loadScanner();
    await expect(scanner.scanFile(svg, { mimetype: 'image/svg+xml' })).resolves.toMatchObject({ safe: true });
    await expect(scanner.scanFile(pngLike, { mimetype: 'image/png' })).resolves.toMatchObject({ safe: true });
  });

  it('quarantine failure deletes the original fail-closed and returns null', async () => {
    const fp = write('qfail.bin', 'x');
    const { scanner } = loadScanner();
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename denied'); });
    const result = await scanner.quarantineFile(fp, 'TEST', {});
    expect(result).toBeNull();
    expect(fs.existsSync(fp)).toBe(false);
    rename.mockRestore();
  });

  it('quarantine listing tolerates malformed metadata and deletion basename-confines input', () => {
    const { scanner } = loadScanner();
    const qdir = path.join(root, '_quarantine');
    fs.mkdirSync(qdir, { recursive: true });
    fs.writeFileSync(path.join(qdir, 'one.bin'), '123');
    fs.writeFileSync(path.join(qdir, 'one.bin.meta.json'), '{not-json');
    fs.writeFileSync(path.join(qdir, 'two.bin'), '12');
    fs.writeFileSync(path.join(qdir, 'two.bin.meta.json'), JSON.stringify({ reason: 'TEST' }));
    const outside = write('outside.bin', 'keep');

    const list = scanner.listQuarantinedFiles();
    expect(list.map((x: any) => x.filename).sort()).toEqual(['one.bin', 'two.bin']);
    expect(list.find((x: any) => x.filename === 'two.bin')).toMatchObject({ size: 2, reason: 'TEST' });

    scanner.deleteQuarantinedFile('../outside.bin');
    expect(fs.existsSync(outside)).toBe(true);
    scanner.deleteQuarantinedFile('two.bin');
    expect(fs.existsSync(path.join(qdir, 'two.bin'))).toBe(false);
    expect(fs.existsSync(path.join(qdir, 'two.bin.meta.json'))).toBe(false);
  });

  it('middleware handles no-file, missing-path, arrays and scan errors without widening status', async () => {
    const { scanner } = loadScanner();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;

    await scanner.contentScanMiddleware({} as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    next.mockClear();
    await scanner.contentScanMiddleware({ file: { originalname: 'x', mimetype: 'text/plain', size: 1 } } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const good1 = write('m1.txt', 'one');
    const good2 = write('m2.txt', 'two');
    next.mockClear();
    await scanner.contentScanMiddleware({
      user: { id: 'u', username: 'name' },
      files: { a: [
        { path: good1, originalname: 'm1.txt', mimetype: 'text/plain', size: 3 },
        { path: good2, originalname: 'm2.txt', mimetype: 'text/plain', size: 3 },
      ] },
    } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const empty = write('mw-empty.bin', Buffer.alloc(0));
    next.mockClear(); res.status.mockClear(); res.json.mockClear();
    await scanner.contentScanMiddleware({
      file: { path: empty, originalname: 'empty.bin', mimetype: 'application/octet-stream', size: 0 },
    } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EMPTY_FILE' }));
  });

  it('middleware short-circuits scanning when feature is disabled', async () => {
    const { scanner } = loadScanner({ enabled: false });
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    await scanner.contentScanMiddleware({ file: { path: '/missing', originalname: 'x', mimetype: 'x', size: 1 } } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
