// server/routes/upload.js — Chunked upload (up to 2GB) + legacy 500MB + GIF 100MB
// CDN desteği: Cloudflare R2 / Backblaze B2 / local (CDN_PROVIDER env ile seçilir)
const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { limits }   = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');
const { scanFile } = require('../lib/contentScanner');
const { sanitizeSvgFile } = require('../lib/svgSanitizer');
const { uploadToCDN, deleteFromCDN, PROVIDER } = require('../lib/cdnStorage');

const router     = express.Router();
const UPLOAD_DIR = path.join(__dirname, '../uploads');
const CHUNK_DIR  = path.join(__dirname, '../uploads/_chunks');
[UPLOAD_DIR, CHUNK_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const ALLOWED_TYPES = [
  'image/jpeg','image/png','image/gif','image/webp','image/svg+xml','image/tiff','image/bmp',
  'application/pdf','text/plain','text/markdown','text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip','application/x-rar-compressed','application/x-7z-compressed',
  'application/x-tar','application/gzip',
  'application/json','text/xml','application/xml',
  'audio/mpeg','audio/ogg','audio/wav','audio/flac','audio/aac','audio/webm','audio/mp4',
  'video/mp4','video/webm','video/ogg','video/quicktime','video/x-msvideo',
  'text/html','text/css','text/javascript','application/javascript',
];

const MAGIC = [
  { mime: 'image/jpeg',  bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',   bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif',   bytes: [0x47, 0x49, 0x46] },
  { mime: 'image/webp',  bytes: null, check: (b) => b.slice(8, 12).toString() === 'WEBP' },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4B, 0x03, 0x04] },
];

const SKIP_MAGIC = [
  'text/','audio/','video/','application/json','application/javascript',
  'application/xml','text/xml','application/msword',
  'application/x-rar-compressed','application/x-7z-compressed',
  'application/x-tar','application/gzip',
  'image/svg+xml','image/tiff','image/bmp',
];

function checkMagicBytes(filePath, declaredMime) {
  if (SKIP_MAGIC.some(p => declaredMime.startsWith(p))) return true;
  const rule = MAGIC.find(m => m.mime === declaredMime);
  if (!rule) return true;
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (rule.check) return rule.check(buf);
    return rule.bytes.every((byte, i) => buf[i] === byte);
  } catch { return false; }
}

const MAX_FILE_SIZE    = parseInt(process.env.MAX_FILE_SIZE_MB   || '2048') * 1024 * 1024;
const CHUNK_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB per chunk

// CDN nesne anahtarı oluştur — provider=local ise null döner
function _cdnKey(filename) {
  return PROVIDER !== 'local' ? `uploads/${filename}` : null;
}

// ── LEGACY SINGLE UPLOAD (small files ≤ 500MB via multer) ────────────────────
const smallUpload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('File type not allowed'), { status: 415 }));
  },
});

router.post('/', authMiddleware, limits.upload(), smallUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filePath = req.file.path;

  if (!checkMagicBytes(filePath, req.file.mimetype)) {
    fs.unlink(filePath, () => {});
    return res.status(400).json({ error: 'File content does not match its declared type' });
  }

  try {
    await scanFile(filePath, {
      userId:   req.user?.id,
      username: req.user?.username,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      fileSize: req.file.size,
    });
  } catch (scanErr) {
    return res.status(scanErr.statusCode || 422).json({ error: scanErr.message, code: scanErr.code });
  }

  // ── SVG Sanitizasyonu — tehlikeli element/attribute'ları strip et ──────────
  if (req.file.mimetype === 'image/svg+xml') {
    const svgResult = await sanitizeSvgFile(filePath);
    if (!svgResult.safe) {
      fs.unlink(filePath, () => {});
      return res.status(422).json({ error: 'SVG contains dangerous content that could not be sanitized', code: 'SVG_UNSAFE' });
    }
    if (svgResult.rewritten) {
      require('../lib/logger').warn({
        userId: req.user?.id, stripped: svgResult.stripped, filename: req.file.originalname,
        event: 'upload.svg_sanitized',
      }, 'SVG sanitized before storage');
    }
  }

  const safeOriginalName = path.basename(req.file.originalname).replace(/[^\w.-]/g, '_').slice(0, 200);

  // CDN yükleme
  const cdnKey = _cdnKey(req.file.filename);
  const { url, provider } = await uploadToCDN(filePath, cdnKey);

  res.json({
    url,
    fileName: safeOriginalName,
    fileType: req.file.mimetype,
    size: req.file.size,
    // CDN bilgisi (ön yüz için opsiyonel)
    ...(provider !== 'local' && { cdn: provider, key: cdnKey }),
  });
}));

// ── CHUNKED UPLOAD ─────────────────────────────────────────────────────────────
router.post('/chunk', authMiddleware, asyncHandler(async (req, res) => {
  const uploadId    = String(req.headers['x-upload-id']    || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  const chunkIndex  = parseInt(req.headers['x-chunk-index']  || '0');
  const totalChunks = parseInt(req.headers['x-total-chunks'] || '1');
  const fileName    = String(req.headers['x-file-name']    || 'file').slice(0, 200);
  const fileType    = String(req.headers['x-file-type']    || 'application/octet-stream').slice(0, 100);

  if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks)) {
    return res.status(400).json({ error: 'Missing chunk metadata headers' });
  }
  if (!ALLOWED_TYPES.includes(fileType)) {
    return res.status(415).json({ error: 'File type not allowed' });
  }

  const sessionDir = path.join(CHUNK_DIR, uploadId);
  fs.mkdirSync(sessionDir, { recursive: true });

  if (totalChunks * CHUNK_SIZE_LIMIT > MAX_FILE_SIZE + CHUNK_SIZE_LIMIT) {
    return res.status(413).json({ error: `File too large (max ${process.env.MAX_FILE_SIZE_MB || 2048}MB)` });
  }

  const chunkPath = path.join(sessionDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
  const writeStream = fs.createWriteStream(chunkPath);

  let chunkSize = 0;
  req.on('data', (d) => {
    chunkSize += d.length;
    if (chunkSize > CHUNK_SIZE_LIMIT) {
      writeStream.destroy();
      fs.unlink(chunkPath, () => {});
      return res.status(413).json({ error: 'Single chunk too large (max 10MB per chunk)' });
    }
  });

  req.pipe(writeStream);

  writeStream.on('error', () => res.status(500).json({ error: 'Chunk write failed' }));
  writeStream.on('finish', async () => {
    if (chunkIndex === totalChunks - 1) {
      const ext = path.extname(fileName).slice(0, 10).toLowerCase();
      const finalName = `${uuidv4()}${ext}`;
      const finalPath = path.join(UPLOAD_DIR, finalName);
      try {
        await mergeChunks(sessionDir, totalChunks, finalPath);
        const { size } = fs.statSync(finalPath);
        if (size > MAX_FILE_SIZE) {
          fs.unlink(finalPath, () => {});
          return res.status(413).json({ error: `File too large (max ${process.env.MAX_FILE_SIZE_MB || 2048}MB)` });
        }
        if (!checkMagicBytes(finalPath, fileType)) {
          fs.unlink(finalPath, () => {});
          return res.status(400).json({ error: 'File content does not match its declared type' });
        }
        try {
          await scanFile(finalPath, {
            userId:   req.user?.id,
            username: req.user?.username,
            filename: fileName,
            mimetype: fileType,
            fileSize: size,
          });
        } catch (scanErr) {
          return res.status(scanErr.statusCode || 422).json({ error: scanErr.message, code: scanErr.code });
        }

        // ── SVG Sanitizasyonu (chunked upload) ─────────────────────
        if (fileType === 'image/svg+xml') {
          const svgResult = await sanitizeSvgFile(finalPath);
          if (!svgResult.safe) {
            fs.unlink(finalPath, () => {});
            return res.status(422).json({ error: 'SVG contains dangerous content', code: 'SVG_UNSAFE' });
          }
        }

        const safeFileName = path.basename(fileName).replace(/[^\w.-]/g, '_').slice(0, 200);

        // CDN yükleme (büyük dosyalar için de aynı akış)
        const cdnKey = _cdnKey(finalName);
        const { url, provider } = await uploadToCDN(finalPath, cdnKey);

        res.json({
          done: true,
          url,
          fileName: safeFileName,
          fileType,
          size,
          ...(provider !== 'local' && { cdn: provider, key: cdnKey }),
        });
      } catch (e) {
        res.status(500).json({ error: 'Merge failed: ' + e.message });
      } finally {
        fs.rm(sessionDir, { recursive: true, force: true }, () => {});
      }
    } else {
      res.json({ done: false, received: chunkIndex });
    }
  });
}));

async function mergeChunks(sessionDir, totalChunks, finalPath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(finalPath);
    let idx = 0;
    function writeNext() {
      if (idx === totalChunks) { out.end(); return; }
      const chunkPath = path.join(sessionDir, `chunk_${String(idx).padStart(6, '0')}`);
      const inp = fs.createReadStream(chunkPath);
      inp.pipe(out, { end: false });
      inp.on('error', reject);
      inp.on('end', () => { idx++; writeNext(); });
    }
    out.on('error', reject);
    out.on('finish', resolve);
    writeNext();
  });
}

// ── SERVER GIF UPLOAD ─────────────────────────────────────────────────────────
const gifUpload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/gif', 'image/webp', 'image/png', 'image/jpeg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Only image files allowed for GIFs'), { status: 415 }));
  },
});

router.post('/server-gif', authMiddleware, gifUpload.single('gif'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'File content mismatch' });
  }
  const cdnKey = _cdnKey(req.file.filename);
  const { url, provider } = await uploadToCDN(req.file.path, cdnKey);
  res.json({
    url,
    fileType: req.file.mimetype,
    size: req.file.size,
    ...(provider !== 'local' && { cdn: provider, key: cdnKey }),
  });
}));

// CDN'den silme endpoint (opsiyonel — mesaj silerken backend çağırabilir)
// DELETE /api/upload/cdn?key=uploads/abc.jpg
router.delete('/cdn', authMiddleware, asyncHandler(async (req, res) => {
  const key = String(req.query.key ?? '').replace(/\.\./g, '').slice(0, 512);
  if (!key || !key.startsWith('uploads/')) {
    return res.status(400).json({ error: 'Geçersiz CDN key' });
  }
  await deleteFromCDN(key);
  res.json({ deleted: true, key });
}));

// Error handler
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.status === 415) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'File too large' });
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
export {};
