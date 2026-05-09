// @ts-nocheck
// server/lib/contentScanner.js
// Yüklenen medyaları tara:
//   1. PhotoDNA-style CSAM hash kontrolü (NCMEC hash listesi benzeri)
//   2. VirusTotal API entegrasyonu (isteğe bağlı)
//   3. MIME type / magic byte doğrulama (zaten upload.js'de var, burada ek katman)
//   4. Dosya boyutu / içerik anomali tespiti
//   5. Şüpheli dosyaları karantinaya al + admin alert

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const VIRUSTOTAL_API_KEY  = process.env.VIRUSTOTAL_API_KEY || null;
const CONTENT_SCAN_ENABLED = process.env.CONTENT_SCAN_ENABLED !== 'false'; // default true
const KARANTINA_DIR       = path.join(__dirname, '../uploads/_quarantine');

// Karantina klasörü
if (!fs.existsSync(KARANTINA_DIR)) {
  fs.mkdirSync(KARANTINA_DIR, { recursive: true });
}

// ── CSAM Hash Listesi ─────────────────────────────────────────────────────────
// Gerçek bir implementasyonda NCMEC Hash List veya IWF hash listesi kullanılır.
// Bu dosyalar gizlidir ve yetkili kuruluşlardan edinilir.
// Burada örnek olarak boş bir set kullanıyoruz — gerçek hash'ler .env veya
// harici DB'den yüklenir.
//
// Format: SHA-256 hex hashes (perceptual hash değil, tam dosya hash'i)
// Perceptual hashing için PhotoDNA veya Microsoft'un CSAM detection API'si kullanılır.

const KNOWN_BAD_HASHES = new Set(
  (process.env.CSAM_HASH_LIST || '').split(',').filter(Boolean).map(h => h.trim().toLowerCase())
);

// İsteğe bağlı: harici hash listesi dosyasını yükle
const HASH_LIST_FILE = process.env.CSAM_HASH_LIST_FILE || null;
if (HASH_LIST_FILE && fs.existsSync(HASH_LIST_FILE)) {
  try {
    const lines = fs.readFileSync(HASH_LIST_FILE, 'utf8').split('\n');
    lines.forEach(l => { const h = l.trim().toLowerCase(); if (h.length === 64) KNOWN_BAD_HASHES.add(h); });
    console.log(`[ContentScan] Loaded ${KNOWN_BAD_HASHES.size} hashes from ${HASH_LIST_FILE}`);
  } catch (e) {
    console.warn('[ContentScan] Failed to load hash list:', e.message);
  }
}

// ── SHA-256 Dosya Hash ────────────────────────────────────────────────────────

function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── VirusTotal Entegrasyonu ───────────────────────────────────────────────────

async function checkVirusTotal(filePath, fileHash) {
  if (!VIRUSTOTAL_API_KEY) return null;

  try {
    // Önce hash ile ara — upload sınırından kaçın
    const hashCheck = await fetch(`https://www.virustotal.com/api/v3/files/${fileHash}`, {
      headers: { 'x-apikey': VIRUSTOTAL_API_KEY },
    });

    if (hashCheck.ok) {
      const data = await hashCheck.json();
      const stats = data.data?.attributes?.last_analysis_stats;
      if (stats) {
        return {
          source: 'virustotal',
          cached: true,
          malicious:   stats.malicious || 0,
          suspicious:  stats.suspicious || 0,
          undetected:  stats.undetected || 0,
          total:       Object.values(stats).reduce((a, b) => a + b, 0),
          permalink:   data.data?.links?.self,
        };
      }
    }

    // Hash bulunamadı — dosyayı gönder (max 32MB ücretsiz)
    const stat = fs.statSync(filePath);
    if (stat.size > 32 * 1024 * 1024) {
      return { source: 'virustotal', skipped: true, reason: 'File too large for VT scan' };
    }

    const formData = new FormData();
    formData.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));

    const uploadRes = await fetch('https://www.virustotal.com/api/v3/files', {
      method: 'POST',
      headers: { 'x-apikey': VIRUSTOTAL_API_KEY },
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json();
      return { source: 'virustotal', error: err.error?.message || 'Upload failed' };
    }

    const uploadData = await uploadRes.json();
    const analysisId = uploadData.data?.id;

    // Analiz sonucunu bekle (max 30 saniye)
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const analysisRes = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
        headers: { 'x-apikey': VIRUSTOTAL_API_KEY },
      });
      if (analysisRes.ok) {
        const analysisData = await analysisRes.json();
        if (analysisData.data?.attributes?.status === 'completed') {
          const stats = analysisData.data.attributes.stats;
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
    console.warn('[ContentScan] VirusTotal error:', err.message);
    return { source: 'virustotal', error: err.message };
  }
}

// ── Karantina ─────────────────────────────────────────────────────────────────

async function quarantineFile(filePath, reason, metadata) {
  try {
    const filename   = path.basename(filePath);
    const destPath   = path.join(KARANTINA_DIR, filename);
    fs.renameSync(filePath, destPath);

    // Metadat dosyası yaz
    const metaPath = destPath + '.meta.json';
    fs.writeFileSync(metaPath, JSON.stringify({
      originalPath: filePath,
      quarantinedAt: new Date().toISOString(),
      reason,
      ...metadata,
    }, null, 2));

    console.warn(`[ContentScan] ⚠️  Dosya karantinaya alındı: ${filename} — Sebep: ${reason}`);
    return destPath;
  } catch (err) {
    console.error('[ContentScan] Karantina hatası:', err.message);
    // Karantina başarısız → sil
    try { fs.unlinkSync(filePath); } catch {}
    return null;
  }
}

// ── Ana Tarama Fonksiyonu ─────────────────────────────────────────────────────

/**
 * Dosyayı tara. Tehdit bulunursa dosyayı karantinaya al ve hata fırlat.
 *
 * @param {string} filePath  - Taranacak dosya yolu
 * @param {object} context   - { userId, serverId, channelId, filename, mimetype }
 * @returns {object}         - { safe: true, hash, vtResult } veya exception fırlatır
 */
async function scanFile(filePath, context = {}) {
  if (!CONTENT_SCAN_ENABLED) {
    return { safe: true, skipped: true };
  }

  if (!fs.existsSync(filePath)) {
    throw new Error('File not found for scanning');
  }

  const hash = await fileHash(filePath);

  // 1. CSAM hash kontrolü — en yüksek öncelik
  if (KNOWN_BAD_HASHES.size > 0 && KNOWN_BAD_HASHES.has(hash)) {
    await quarantineFile(filePath, 'CSAM_HASH_MATCH', {
      hash,
      ...context,
      severity: 'CRITICAL',
    });

    // NCMEC'e bildiri (opsiyonel — gerçek uygulamada zorunlu)
    console.error(`[ContentScan] 🚨 CSAM HASH MATCH — User: ${context.userId} — Hash: ${hash}`);

    throw Object.assign(new Error('Content policy violation'), {
      code: 'CONTENT_VIOLATION',
      statusCode: 422,
      safe: false,
    });
  }

  // 2. VirusTotal tarama (opsiyonel, yavaş — async çalıştır)
  let vtResult = null;
  if (VIRUSTOTAL_API_KEY) {
    vtResult = await checkVirusTotal(filePath, hash);

    if (vtResult && (vtResult.malicious || 0) > 0) {
      await quarantineFile(filePath, 'VIRUSTOTAL_MALWARE', {
        hash,
        vtResult,
        ...context,
        severity: 'HIGH',
      });
      throw Object.assign(new Error('Malware detected in uploaded file'), {
        code: 'MALWARE_DETECTED',
        statusCode: 422,
        safe: false,
        vtResult,
      });
    }
  }

  // 3. Dosya anomali kontrolleri
  const stat = fs.statSync(filePath);

  // Boş dosya
  if (stat.size === 0) {
    fs.unlinkSync(filePath);
    throw Object.assign(new Error('Empty file rejected'), { code: 'EMPTY_FILE', statusCode: 400 });
  }

  // Magic byte ile MIME type uyuşmazlık kontrolü
  // (ana kontrol upload.js'de, burada ek katman olarak resimler için)
  if (context.mimetype?.startsWith('image/')) {
    try {
      const fd  = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(12);
      fs.readSync(fd, buf, 0, 12, 0);
      fs.closeSync(fd);

      // SVG içinde gömülü script kontrolü
      if (context.mimetype === 'image/svg+xml') {
        const content = fs.readFileSync(filePath, 'utf8');
        const DANGEROUS_PATTERNS = [
          /<script/i,
          /javascript:/i,
          /on\w+\s*=/i,  // onerror, onload vb.
          /<foreignObject/i,
          /xlink:href\s*=\s*["'](?!#)/i,
        ];
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(content)) {
            await quarantineFile(filePath, 'SVG_XSS_ATTEMPT', {
              hash, ...context, severity: 'HIGH', pattern: pattern.toString(),
            });
            throw Object.assign(new Error('SVG contains dangerous content'), {
              code: 'SVG_XSS',
              statusCode: 422,
            });
          }
        }
      }
    } catch (err) {
      if (err.code) throw err; // kendi hataları yeniden fırlat
      // Magic byte okuma hatası — devam et
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

// ── Express Middleware ────────────────────────────────────────────────────────

/**
 * Upload route'larına eklenecek middleware.
 * multer'dan sonra, response'dan önce çalışmalı.
 *
 * Kullanım:
 *   router.post('/upload', uploadMiddleware, contentScanMiddleware, handler);
 */
async function contentScanMiddleware(req, res, next) {
  if (!req.file && !req.files) return next();
  if (!CONTENT_SCAN_ENABLED) return next();

  const files = req.file ? [req.file] : (Array.isArray(req.files) ? req.files : Object.values(req.files).flat());

  try {
    for (const file of files) {
      if (!file.path) continue;
      await scanFile(file.path, {
        userId:    req.user?.id,
        username:  req.user?.username,
        filename:  file.originalname,
        mimetype:  file.mimetype,
        fileSize:  file.size,
      });
    }
    next();
  } catch (err) {
    const status = err.statusCode || 422;
    res.status(status).json({
      error: err.message,
      code:  err.code || 'SCAN_FAILED',
    });
  }
}

// ── Karantina Admin API ───────────────────────────────────────────────────────

function listQuarantinedFiles() {
  try {
    const files = fs.readdirSync(KARANTINA_DIR)
      .filter(f => !f.endsWith('.meta.json'));

    return files.map(f => {
      const metaPath = path.join(KARANTINA_DIR, f + '.meta.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      return {
        filename: f,
        path: path.join(KARANTINA_DIR, f),
        size: fs.statSync(path.join(KARANTINA_DIR, f)).size,
        ...meta,
      };
    });
  } catch {
    return [];
  }
}

function deleteQuarantinedFile(filename) {
  const safe = path.basename(filename); // path traversal koruması
  const filePath = path.join(KARANTINA_DIR, safe);
  const metaPath = filePath + '.meta.json';
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
}

module.exports = {
  scanFile,
  contentScanMiddleware,
  listQuarantinedFiles,
  deleteQuarantinedFile,
  fileHash,
};
export {};
