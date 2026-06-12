// server/lib/contentScanner.ts — Oturum 17: scanFile return tipi, yardımcı fonksiyonlar
// Yüklenen medyaları tara: CSAM hash, VirusTotal, MIME anomali, SVG XSS

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import logger from './logger';
import { fetchT } from './fetch';

// ── Tipler ────────────────────────────────────────────────────
export interface ScanContext {
  userId?:    string;
  username?:  string;
  serverId?:  string;
  channelId?: string;
  filename?:  string;
  mimetype?:  string;
  fileSize?:  number;
}

export interface ScanResultSafe {
  safe:       true;
  hash:       string;
  fileSize:   number;
  vtResult?:  VtResult | null;
  scannedAt:  number;
  skipped?:   true;
}

export interface ScanResultSkipped {
  safe:     true;
  skipped:  true;
}

export type ScanResult = ScanResultSafe | ScanResultSkipped;

interface VtStats {
  malicious:  number;
  suspicious: number;
  undetected: number;
  [key: string]: number;
}

interface VtResult {
  source:     string;
  cached?:    boolean;
  pending?:   boolean;
  skipped?:   boolean;
  malicious?: number;
  suspicious?: number;
  undetected?: number;
  total?:     number;
  permalink?: string;
  analysisId?: string;
  error?:     string;
  reason?:    string;
}

export interface QuarantineEntry {
  filename:      string;
  path:          string;
  size:          number;
  originalPath?: string;
  quarantinedAt?: string;
  reason?:       string;
  [key: string]: unknown;
}

// ── Config ────────────────────────────────────────────────────
const VIRUSTOTAL_API_KEY   = process.env.VIRUSTOTAL_API_KEY || null;
const CONTENT_SCAN_ENABLED = process.env.CONTENT_SCAN_ENABLED !== 'false';
const KARANTINA_DIR        = path.join(__dirname, '../uploads/_quarantine');

if (!fs.existsSync(KARANTINA_DIR)) {
  fs.mkdirSync(KARANTINA_DIR, { recursive: true });
}

const KNOWN_BAD_HASHES = new Set(
  (process.env.CSAM_HASH_LIST || '').split(',').filter(Boolean).map(h => h.trim().toLowerCase())
);

const HASH_LIST_FILE = process.env.CSAM_HASH_LIST_FILE || null;
if (HASH_LIST_FILE && fs.existsSync(HASH_LIST_FILE)) {
  try {
    const lines = fs.readFileSync(HASH_LIST_FILE, 'utf8').split('\n');
    lines.forEach(l => { const h = l.trim().toLowerCase(); if (h.length === 64) KNOWN_BAD_HASHES.add(h); });
    logger.info({ count: KNOWN_BAD_HASHES.size, file: HASH_LIST_FILE, event: 'content_scan.hash_list.loaded' }, '[ContentScan] Hash listesi yüklendi');
  } catch (e) {
    logger.warn({ err: (e as Error).message, file: HASH_LIST_FILE, event: 'content_scan.hash_list.load_failed' }, '[ContentScan] Hash listesi yüklenemedi');
  }
}

// ── SHA-256 Dosya Hash ────────────────────────────────────────
export function fileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── VirusTotal Entegrasyonu ───────────────────────────────────
async function checkVirusTotal(filePath: string, hash: string): Promise<VtResult | null> {
  if (!VIRUSTOTAL_API_KEY) return null;

  try {
    const hashCheck = await fetchT(`https://www.virustotal.com/api/v3/files/${hash}`, {
      headers: { 'x-apikey': VIRUSTOTAL_API_KEY },
      timeoutMs: 15_000,
    });

    if (hashCheck.ok) {
      const data = await hashCheck.json() as {
        data?: { attributes?: { last_analysis_stats?: VtStats }; links?: { self?: string } }
      };
      const stats = data.data?.attributes?.last_analysis_stats;
      if (stats) {
        return {
          source: 'virustotal',
          cached: true,
          malicious:  stats.malicious || 0,
          suspicious: stats.suspicious || 0,
          undetected: stats.undetected || 0,
          total:      Object.values(stats).reduce((a, b) => a + b, 0),
          permalink:  data.data?.links?.self,
        };
      }
    }

    const stat = fs.statSync(filePath);
    if (stat.size > 32 * 1024 * 1024) {
      return { source: 'virustotal', skipped: true, reason: 'File too large for VT scan' };
    }

    const formData = new FormData();
    formData.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));

    const uploadRes = await fetchT('https://www.virustotal.com/api/v3/files', {
      method: 'POST',
      headers: { 'x-apikey': VIRUSTOTAL_API_KEY },
      body: formData,
      timeoutMs: 60_000,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json() as { error?: { message?: string } };
      return { source: 'virustotal', error: err.error?.message || 'Upload failed' };
    }

    const uploadData = await uploadRes.json() as { data?: { id?: string } };
    const analysisId = uploadData.data?.id;

    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const analysisRes = await fetchT(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
        headers: { 'x-apikey': VIRUSTOTAL_API_KEY },
        timeoutMs: 15_000,
      });
      if (analysisRes.ok) {
        const analysisData = await analysisRes.json() as {
          data?: { attributes?: { status?: string; stats?: VtStats } }
        };
        if (analysisData.data?.attributes?.status === 'completed') {
          const stats = analysisData.data.attributes.stats!;
          return {
            source: 'virustotal',
            cached: false,
            malicious:  stats.malicious || 0,
            suspicious: stats.suspicious || 0,
            undetected: stats.undetected || 0,
            total:      Object.values(stats).reduce((a, b) => a + b, 0),
          };
        }
      }
    }

    return { source: 'virustotal', pending: true, analysisId };
  } catch (err) {
    logger.warn({ err: (err as Error).message, event: 'content_scan.virustotal.error' }, '[ContentScan] VirusTotal error');
    return { source: 'virustotal', error: (err as Error).message };
  }
}

// ── Karantina ─────────────────────────────────────────────────
export async function quarantineFile(
  filePath: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<string | null> {
  try {
    const filename = path.basename(filePath);
    const destPath = path.join(KARANTINA_DIR, filename);
    fs.renameSync(filePath, destPath);

    const metaPath = destPath + '.meta.json';
    fs.writeFileSync(metaPath, JSON.stringify({
      originalPath: filePath,
      quarantinedAt: new Date().toISOString(),
      reason,
      ...metadata,
    }, null, 2));

    logger.warn({ filename, reason, event: 'content_scan.quarantine.success' }, '[ContentScan] ⚠️  Dosya karantinaya alındı');
    return destPath;
  } catch (err) {
    logger.error({ err: (err as Error).message, event: 'content_scan.quarantine.failed' }, '[ContentScan] Karantina hatası');
    try { fs.unlinkSync(filePath); } catch {}
    return null;
  }
}

// ── Ana Tarama Fonksiyonu ─────────────────────────────────────
/**
 * Dosyayı tara. Tehdit bulunursa dosyayı karantinaya al ve hata fırlat.
 */
export async function scanFile(
  filePath: string,
  context: ScanContext = {},
): Promise<ScanResult> {
  if (!CONTENT_SCAN_ENABLED) {
    return { safe: true, skipped: true };
  }

  if (!fs.existsSync(filePath)) {
    throw new Error('File not found for scanning');
  }

  const hash = await fileHash(filePath);

  // 1. CSAM hash kontrolü
  if (KNOWN_BAD_HASHES.size > 0 && KNOWN_BAD_HASHES.has(hash)) {
    await quarantineFile(filePath, 'CSAM_HASH_MATCH', {
      hash, ...context, severity: 'CRITICAL',
    });
    logger.fatal({ userId: context.userId, hash, event: 'content_scan.csam.hash_match' }, '[ContentScan] 🚨 CSAM HASH MATCH');
    throw Object.assign(new Error('Content policy violation'), {
      code: 'CONTENT_VIOLATION', statusCode: 422, safe: false,
    });
  }

  // 2. VirusTotal tarama
  let vtResult: VtResult | null = null;
  if (VIRUSTOTAL_API_KEY) {
    vtResult = await checkVirusTotal(filePath, hash);
    if (vtResult && (vtResult.malicious || 0) > 0) {
      await quarantineFile(filePath, 'VIRUSTOTAL_MALWARE', {
        hash, vtResult, ...context, severity: 'HIGH',
      });
      throw Object.assign(new Error('Malware detected in uploaded file'), {
        code: 'MALWARE_DETECTED', statusCode: 422, safe: false, vtResult,
      });
    }
  }

  // 3. Dosya anomali kontrolleri
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    fs.unlinkSync(filePath);
    throw Object.assign(new Error('Empty file rejected'), { code: 'EMPTY_FILE', statusCode: 400 });
  }

  if (context.mimetype?.startsWith('image/')) {
    try {
      if (context.mimetype === 'image/svg+xml') {
        const content = fs.readFileSync(filePath, 'utf8');
        const DANGEROUS_PATTERNS = [
          /<script/i, /javascript:/i, /on\w+\s*=/i,
          /<foreignObject/i, /xlink:href\s*=\s*["'](?!#)/i,
        ];
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(content)) {
            await quarantineFile(filePath, 'SVG_XSS_ATTEMPT', {
              hash, ...context, severity: 'HIGH', pattern: pattern.toString(),
            });
            throw Object.assign(new Error('SVG contains dangerous content'), {
              code: 'SVG_XSS', statusCode: 422,
            });
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code) throw err;
    }
  }

  return {
    safe:     true,
    hash,
    fileSize: stat.size,
    vtResult,
    scannedAt: Date.now(),
  };
}

// ── Express Middleware ────────────────────────────────────────
interface MulterFile {
  path?:         string;
  originalname:  string;
  mimetype:      string;
  size:          number;
}

export async function contentScanMiddleware(
  req: Request & { file?: MulterFile; files?: MulterFile[] | Record<string, MulterFile[]>; user?: { id?: string; username?: string } },
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.file && !req.files) { next(); return; }
  if (!CONTENT_SCAN_ENABLED) { next(); return; }

  const files: MulterFile[] = req.file
    ? [req.file]
    : (Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat());

  try {
    for (const file of files) {
      if (!file.path) continue;
      await scanFile(file.path, {
        userId:   req.user?.id,
        username: req.user?.username,
        filename: file.originalname,
        mimetype: file.mimetype,
        fileSize: file.size,
      });
    }
    next();
  } catch (err) {
    const e = err as Error & { statusCode?: number; code?: string };
    const status = e.statusCode || 422;
    res.status(status).json({ error: e.message, code: e.code || 'SCAN_FAILED' });
  }
}

// ── Karantina Admin API ───────────────────────────────────────
export function listQuarantinedFiles(): QuarantineEntry[] {
  try {
    const files = fs.readdirSync(KARANTINA_DIR).filter(f => !f.endsWith('.meta.json'));
    return files.map(f => {
      const filePath = path.join(KARANTINA_DIR, f);
      const metaPath = filePath + '.meta.json';
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      return { filename: f, path: filePath, size: fs.statSync(filePath).size, ...meta } as QuarantineEntry;
    });
  } catch { return []; }
}

export function deleteQuarantinedFile(filename: string): void {
  const safe     = path.basename(filename);
  const filePath = path.join(KARANTINA_DIR, safe);
  const metaPath = filePath + '.meta.json';
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
}
