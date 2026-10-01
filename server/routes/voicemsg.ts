/**
 * @openapi
 * tags:
 *   - name: VoiceMsg
 *     description: VoiceMsg API endpoints

 *
 * /voicemsg:
 *   post:
 *     tags: [Messages]
 *     summary: Sesli mesaj yükle ve transkripsiyon başlat
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:      { type: string, format: binary, description: 'WebM/OGG ses dosyası' }
 *               channelId: { type: string }
 *               duration:  { type: integer, description: 'Saniye cinsinden süre' }
 *     responses:
 *       201:
 *         description: Sesli mesaj yüklendi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:          { type: string }
 *                 duration:     { type: integer }
 *                 transcriptId: { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /voicemsg/{vmId}/transcript:
 *   get:
 *     tags: [Messages]
 *     summary: Sesli mesaj transkripsiyonunu getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: vmId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transkripsiyon metni
 *       202:
 *         description: Transkripsiyon henüz hazır değil
 *       404: { $ref: '#/components/responses/NotFound' }
 */

// server/routes/voicemsg.ts — Voice Messages + AI Transcription
// Sprint 73: CDN entegrasyonu — getStorageAdapter() ile local/S3/R2/MinIO/B2 desteği
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { Channels, Messages, VoiceMessages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import logger from '../lib/logger';
import { limits } from '../middleware/rateLimit';
import { getPrivateStorageAdapter } from '../lib/storageAdapter';
import { PERMS, hasAllPermissions, resolvePermissions } from '../lib/permissions';

import { uploadRoot } from '../lib/runtimePaths';
import { parseNonNegativeSafeIntText } from '../lib/queryNumbers';
import { transcriptionTarget } from '../lib/aiProvider';
import { serverAllowsAi } from '../lib/aiServerPolicy';
// ── AI TRANSKRİPSİYON ─────────────────────────────────────────
// P6 AI-09: the provider decision lives in lib/aiProvider (AI_PROVIDER governs
// it); the server's own setting is checked by the caller before this runs.
async function transcribeAudio(filePath: string): Promise<string | null> {
  const target = transcriptionTarget();
  if (!target) return null;

  const fileBuffer = fs.readFileSync(filePath);
  const fileName   = path.basename(filePath);

  // Node >=22 exposes the WHATWG FormData/Blob implementation used by native
  // fetch. Avoid the legacy `form-data` stream package and its extra runtime
  // dependency chain; undici sets the multipart boundary header itself.
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: 'audio/webm' }), fileName);
  form.append('model', target.model);
  form.append('response_format', 'text');

  try {
    const r = await fetch(target.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${target.key}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      logger.warn({ status: r.status, event: 'transcription.api.http_error' }, '[Transcription] API hata');
      return null;
    }
    const text = (await r.text()).trim();
    return text || null;
  } catch (_err) { const err = _err as Error;
    logger.warn({ err, event: 'transcription.error' }, '[Transcription] Hata');
    return null;
  }
}

const UPLOAD_DIR = uploadRoot();
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const VOICE_MIME_EXT: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
};

// Multipart alanlarını okuyabilmek için multer gerekir; ancak diskStorage
// kullanılırsa channel/server yetkisi doğrulanmadan önce saldırgan diske dosya
// yazdırabilir. Buffer bellekte (10 MB üst sınır) tutulur, fiziksel dosya ancak
// canonical channel authorization başarıyla geçtikten sonra oluşturulur.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (VOICE_MIME_EXT[file.mimetype]) cb(null, true);
    else cb(Object.assign(new Error('Voice message file type not allowed'), { status: 415 }));
  },
});

function safeUnlink(filePath: string): void {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) {
    logger.warn({ err, filePath, event: 'voicemsg.local_cleanup_failed' }, 'Voice message yerel cleanup başarısız');
  }
}

async function cleanupUploadedObject(
  store: ReturnType<typeof getPrivateStorageAdapter>,
  result: { url: string; key: string | null; provider: string },
  localPath: string,
): Promise<void> {
  try {
    const key = result.key ?? store.keyFromUrl(result.url);
    if (key) await store.deleteFile(key);
  } catch (err) {
    logger.error({ err, url: result.url, event: 'voicemsg.storage_rollback_failed' }, 'Voice message storage rollback başarısız');
  }
  // Remote provider nesnesinden ayrı tuttuğumuz transkripsiyon kopyasıdır.
  if (result.provider !== 'local') safeUnlink(localPath);
}

router.post('/', authMiddleware, limits.upload(), upload.single('audio'), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  const { channelId, serverId, duration } = req.body as Record<string, string>;
  if (!channelId || !serverId) return res.status(400).json({ error: 'channelId and serverId required' });

  // Client-supplied serverId/channelId yalnız locator'dır, authority değildir.
  // Kanalın gerçekten belirtilen sunucuya ait olduğu ve kullanıcının bu kanalda
  // voice-message gönderebildiği server-side resolver ile kanıtlanır.
  const channel = await Channels.findByIdAndServer(channelId, serverId);
  if (!channel) return res.status(403).json({ error: 'Channel unavailable' });
  const perms = await resolvePermissions(_u.id, serverId, channelId);
  if (!hasAllPermissions(perms, PERMS.VIEW_CHANNELS, PERMS.SEND_MESSAGES, PERMS.ATTACH_FILES)) {
    return res.status(403).json({ error: 'Missing channel permissions' });
  }

  const parsedDuration = parseNonNegativeSafeIntText(duration, 0);
  if (parsedDuration === null) return res.status(400).json({ error: 'duration must be a non-negative safe integer' });

  const ext = VOICE_MIME_EXT[req.file.mimetype];
  if (!ext) return res.status(415).json({ error: 'Voice message file type not allowed' });
  const fileName = `vm_${Date.now()}_${uuidv4().slice(0, 8)}${ext}`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, req.file.buffer);

  const store = getPrivateStorageAdapter();
  let result: Awaited<ReturnType<typeof store.uploadFile>> | null = null;
  let vm: Awaited<ReturnType<typeof VoiceMessages.insert>> | null = null;
  try {
    // Local modda fiziksel dosya zaten server/uploads altındadır; remote modda
    // transkripsiyon bitene kadar yerel kopyayı koruruz.
    result = await store.uploadFile(filePath, `uploads/${fileName}`, {
      deleteLocal: false,
      contentType: req.file.mimetype,
    });
    // Voice messages are private channel attachments. Keep their persisted
    // reference on Bridge even when bytes live in S3/R2/MinIO/B2; uploadAuthz
    // re-checks current channel visibility before proxying remote bytes.
    const fileUrl = `/uploads/${fileName}`;

    vm = await VoiceMessages.insert({
      _id: uuidv4(), channelId, serverId,
      userId: _u.id,
      // `voice_messages."displayName"` is NOT NULL with no default and was never written here,
      // so this insert could only fail on real PostgreSQL — the unit-test store does not
      // enforce NOT NULL (Final21 Phase 16: every insert audited against the schema).
      displayName: _u.displayName || _u.username,
      url: fileUrl, duration: parsedDuration, createdAt: Date.now(),
    });
    if (!vm?._id) throw new Error('Voice message persistence failed');

    const msg = await Messages.create({
      _id: uuidv4(), channelId, serverId,
      userId: _u.id, username: _u.username,
      displayName: _u.displayName, avatarColor: _u.avatarColor || '#2d9cdb',
      content: '', type: 'voice_message',
      fileUrl, fileName, fileType: req.file.mimetype,
      reactions: {}, createdAt: Date.now(),
    });
    if (!msg?._id) throw new Error('Message persistence failed');

    res.json({ ok: true, msg, vmId: vm._id });

    const vmId = String(vm._id);
    const messageId = String(msg._id);
    const provider = result.provider;
    setImmediate(async () => {
      try {
        // P6: a server that turned AI off never has its members' audio sent out.
        const transcript = await serverAllowsAi(String(channel.serverId)) ? await transcribeAudio(filePath) : null;
        if (transcript) {
          await VoiceMessages.update({ _id: vmId }, { $set: { transcript } });
          await Messages.update(messageId, { transcript });
          const io = req.app.get('io'); if (io) {
            io.to(channelId).emit('message:transcript', { messageId, transcript });
          }
        }
      } catch (_err) { const err = _err as Error;
        logger.warn({ err, event: 'transcription.background.error' }, '[Transcription] Arka plan hatası');
      } finally {
        // Remote provider'da bu kopya yalnız transkripsiyon içindi. Local
        // provider'da ise aynı dosya /uploads URL'sinin gerçek backing object'i.
        if (provider !== 'local') safeUnlink(filePath);
      }
    });
  } catch (err) {
    // İki tablo transaction paylaşmıyor. Voice row yazıldıktan sonra Message
    // insert'i başarısız olursa önce DB referansını geri al; DB rollback
    // başarısızsa fiziksel objeyi korumak fail-closed davranıştır.
    let safeToDeleteObject = true;
    if (vm?._id) {
      try { await VoiceMessages.remove({ _id: vm._id }); }
      catch (rollbackErr) {
        safeToDeleteObject = false;
        logger.error({ rollbackErr, vmId: vm._id, event: 'voicemsg.db_rollback_failed' }, 'Voice message DB rollback başarısız');
      }
    }
    if (result && safeToDeleteObject) await cleanupUploadedObject(store, result, filePath);
    else if (!result) safeUnlink(filePath);
    throw err;
  }
});

router.get('/:vmId/transcript', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const vm = await VoiceMessages.findOne({ _id: String(req.params.vmId ?? '') });
  if (!vm) return res.status(404).json({ error: 'Voice message not found' });

  const channelId = String(vm.channelId ?? '');
  const serverId = String(vm.serverId ?? '');
  const channel = channelId && serverId ? await Channels.findByIdAndServer(channelId, serverId) : null;
  if (!channel) return res.status(404).json({ error: 'Voice message not found' });
  const perms = await resolvePermissions(_u.id, serverId, channelId);
  if (!hasAllPermissions(perms, PERMS.VIEW_CHANNELS, PERMS.READ_HISTORY)) {
    return res.status(403).json({ error: 'Missing channel permissions' });
  }
  if (!vm.transcript) return res.json({ transcript: null, status: 'pending' });
  res.json({ transcript: vm.transcript, status: 'done' });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
