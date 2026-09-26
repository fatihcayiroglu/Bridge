// server/middleware/uploadAuthz.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÖZEL KANAL EKLERİ İÇİN GERÇEK YETKİLENDİRME
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (canlı üründe ölçüldü):
//   A, ÖZEL bir kanala dosya yükledi.
//   B, o kanalı GÖREMEYEN bir sunucu üyesi.
//     GET /api/channels/<özel>/messages -> 403   (doğru)
//     GET /api/channels/<özel>/files    -> 403   (doğru)
//     GET /uploads/<uuid>.txt           -> 200   <-- SIZINTI
//
// Yani listeleme yetkilendiriliyordu ama BAYTLAR yetkilendirilmiyordu.
// `express.static` hiçbir kimlik/yetki denetimi yapmıyordu; tek koruma URL'nin
// tahmin edilemez olmasıydı. "Saldırgan URL'yi bilemez" bir gizlilik modeli
// DEĞİLDİR: URL paylaşılır, loglanır, kopyalanır, Referer ile sızar.
//
// ════════════════════════════════════════════════════════════════════════════
// TASARIM — NEDEN BU YAKLAŞIM
// ════════════════════════════════════════════════════════════════════════════
// YAPISAL SINIR: mesaj ekleri `uploads/` KÖKÜNE `<uuid><ext>` olarak yazılır
// (routes/upload.ts diskStorage). Avatar/emoji/sticker/soundboard gibi HERKESE
// AÇIK varlıklar ALT DİZİNLERDE durur. Dolayısıyla yalnızca KÖK dosyalar
// yetkilendirilir; açık varlıklar hiç etkilenmez.
//
// `<img src>` YETKİLENDİRMESİ: tarayıcı `<img>`/`<video>` isteklerine
// `Authorization` başlığı EKLEYEMEZ. Bu yüzden salt Bearer tabanlı bir uç
// meşru önizlemeleri de kırardı. Çözüm: girişte `path=/uploads` kapsamlı,
// httpOnly bir MEDYA çerezi verilir; tarayıcı onu `<img>` isteğinde otomatik
// gönderir. Çerez yalnızca KİMLİK taşır — YETKİ her istekte dosya bazında
// yeniden hesaplanır (kanal görünürlüğü / DM / GDM üyeliği).
//
// FAIL-CLOSED: kimlik yoksa 401, yetki yoksa 403. Sahibi bulunamayan kök dosya
// (henüz mesaja bağlanmamış yeni yükleme) YALNIZCA yükleyen kişiye açıktır.
import type { Request, Response, NextFunction } from 'express';
import { verifyToken, getTokenVersion } from './auth';
import { parseTokenVersion } from '../lib/tokenVersion';
import { canViewChannel } from '../lib/permissions';
import { pool } from '../db/postgres/pool';
import { createLogger } from '../lib/logger';
import { getPrivateStorageAdapter, getPrivateStorageProvider } from '../lib/storageAdapter';

const log = createLogger('uploadAuthz');

type Owner =
  | { kind: 'channel'; serverId: string; channelId: string }
  | { kind: 'dm';      dmId: string }
  | { kind: 'gdm';     groupId: string }
  | { kind: 'orphan';  uploaderId: string | null };

// Authority relationships are deliberately not cached. A file can move from
// uploader-only orphan state to a channel/DM/GDM message (or be deleted) at any
// moment; caching that relationship creates a stale authorization window.
async function findOwners(fileUrl: string): Promise<Owner[]> {
  const owners: Owner[] = [];

  // A physical object may legitimately be referenced by more than one live
  // message. Authorization must therefore consider ALL live authorities; a
  // LIMIT 1 owner makes access depend on arbitrary row order and can deny a
  // user who can view another valid reference to the same bytes.
  const ch = await pool.query(
    'SELECT "serverId", "channelId" FROM messages WHERE "fileUrl" = $1', [fileUrl]);
  for (const row of ch.rows) {
    owners.push({ kind: 'channel', serverId: String(row.serverId), channelId: String(row.channelId) });
  }

  const dm = await pool.query('SELECT "dmId" FROM dm_messages WHERE "fileUrl" = $1', [fileUrl]);
  for (const row of dm.rows) owners.push({ kind: 'dm', dmId: String(row.dmId) });

  const gdm = await pool.query('SELECT "groupId" FROM group_dm_messages WHERE "fileUrl" = $1', [fileUrl]);
  for (const row of gdm.rows) owners.push({ kind: 'gdm', groupId: String(row.groupId) });

  if (owners.length) return owners;

  // Henüz hiçbir mesaja bağlanmamış yükleme: yükleyen sahiplenir.
  // Depolanan legacy biçimlerin üçünü de ara. DB uncertainty fail-closed olur:
  // bilinmeyen uploader kimseye erişim vermez.
  const bare = fileUrl.replace(/^\/uploads\//, '');
  const up = await pool.query(
    'SELECT "userId" FROM uploads WHERE key = $1 OR key = $2 OR key = $3 LIMIT 1',
    [fileUrl, bare, `uploads/${bare}`]).catch(() => ({ rows: [] as Array<{ userId?: string }> }));
  return [{ kind: 'orphan', uploaderId: up.rows[0]?.userId ? String(up.rows[0].userId) : null }];
}

/**
 * Kimlik cozumleme — IKI kabul edilen bicim:
 *   · `Authorization: Bearer <erisim jetonu>`  (indirme/fetch yolu)
 *   · `bridge_media` cerezi (purpose='media')  (`<img>` / `<video>` yolu)
 *
 * MEDYA CEREZI ICIN `purpose === 'media'` ZORUNLUDUR. Cerezde herhangi bir
 * gecerli JWT kabul edilseydi, cerez kapsami bir GUVENLIK SINIRI olmaktan
 * cikardi. Ayrica her iki bicimde de JETON SURUMU (`v`) dogrulanir; boylece
 * oturum iptali medya yolunda da AYNEN gecerlidir.
 */
async function identify(req: Request): Promise<{ id: string } | null> {
  const accept = async (payload: { id?: unknown; v?: unknown } | null, requireMedia: boolean): Promise<{ id: string } | null> => {
    if (!payload?.id) return null;
    const purpose = (payload as { purpose?: string }).purpose;
    if (requireMedia && purpose !== 'media') return null;
    if (!requireMedia && purpose === 'media') return null;   // API jetonu yerine medya jetonu KABUL EDILMEZ

    const id = String(payload.id);
    const current = await getTokenVersion(id);
    if (current === null) return null;                        // kullanici yok
    // JWT claims are an untrusted wire format, not a database adapter.  Only a
    // JSON number is canonical here; accepting numeric strings lets alternate
    // encodings describe the same revocation generation.
    if (typeof payload.v !== 'number') return null;
    let issuedVersion: number;
    try { issuedVersion = parseTokenVersion(payload.v); } catch { return null; }
    if (issuedVersion !== current) return null;               // IPTAL EDILMIS
    return { id };
  };

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const viaHeader = await accept(verifyToken(header.slice(7)), false);
    if (viaHeader) return viaHeader;
  }
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.bridge_media;
  if (cookie) return accept(verifyToken(cookie), true);
  return null;
}

async function authorized(userId: string, owner: Owner): Promise<boolean> {
  if (owner.kind === 'channel') {
    return canViewChannel(userId, owner.serverId, owner.channelId);
  }
  if (owner.kind === 'dm') {
    const r = await pool.query('SELECT participants FROM dm_conversations WHERE _id = $1 LIMIT 1', [owner.dmId]);
    const parts = r.rows[0]?.participants;
    const list: string[] = Array.isArray(parts) ? parts : (typeof parts === 'string' ? JSON.parse(parts) : []);
    return list.map(String).includes(userId);
  }
  if (owner.kind === 'gdm') {
    const r = await pool.query(
      'SELECT 1 FROM group_dm_members WHERE "groupId" = $1 AND "userId" = $2 LIMIT 1',
      [owner.groupId, userId]);
    return r.rowCount ? r.rowCount > 0 : false;
  }
  // orphan: yalnız yükleyen erişebilir (sahibi bilinmiyorsa kimse).
  return owner.uploaderId !== null && owner.uploaderId === userId;
}

async function authorizedAny(userId: string, owners: Owner[]): Promise<boolean> {
  // Sequential evaluation intentionally short-circuits after the first valid
  // authority. Any DB/JSON error propagates to the middleware's fail-closed
  // boundary rather than being interpreted as authorization.
  for (const owner of owners) {
    if (await authorized(userId, owner)) return true;
  }
  return false;
}


function isNotFoundStorageError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.$metadata?.httpStatusCode === 404
    || e?.code === 'ENOENT'
    || e?.name === 'NoSuchKey'
    || e?.name === 'NotFound';
}

function isRangeStorageError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.$metadata?.httpStatusCode === 416
    || e?.code === 'InvalidRange'
    || e?.name === 'InvalidRange'
    || e?.name === 'RequestedRangeNotSatisfiable';
}

function setProtectedMediaHeaders(res: Response, rel: string, meta: {
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  acceptRanges?: string;
  etag?: string;
  lastModified?: Date;
}): void {
  const ext = rel.includes('.') ? `.${rel.split('.').pop()!.toLowerCase()}` : '';
  const inlineExts = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg',
    '.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.webm', '.mp4', '.ogv', '.mov', '.avi',
  ]);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Protected message bytes must never become a shared intermediary cache entry.
  res.setHeader('Cache-Control', 'private, no-store');
  if (meta.contentType) res.setHeader('Content-Type', meta.contentType);
  if (typeof meta.contentLength === 'number') res.setHeader('Content-Length', String(meta.contentLength));
  if (meta.contentRange) res.setHeader('Content-Range', meta.contentRange);
  if (meta.acceptRanges) res.setHeader('Accept-Ranges', meta.acceptRanges);
  if (meta.etag) res.setHeader('ETag', meta.etag);
  if (meta.lastModified) res.setHeader('Last-Modified', meta.lastModified.toUTCString());

  if (!inlineExts.has(ext)) res.setHeader('Content-Disposition', 'attachment');
  if (ext === '.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'; sandbox");
  }
}

/**
 * Remote storage cannot be served by express.static. After authorization has
 * succeeded, proxy only root-level protected attachments through Bridge so the
 * same current channel/DM/GDM permission boundary applies to local and remote
 * providers. Public asset subdirectories continue to use their CDN URLs.
 */
async function serveRemoteProtectedUpload(req: Request, res: Response, rel: string): Promise<boolean> {
  if (getPrivateStorageProvider() === 'local') return false;

  const rawRange = req.headers.range;
  let range: string | undefined;
  if (typeof rawRange === 'string') {
    if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(rawRange)) {
      res.status(416).setHeader('Content-Range', 'bytes */*').end();
      return true;
    }
    range = rawRange;
  }

  try {
    const object = await getPrivateStorageAdapter().readFile(`uploads/${rel}`, range ? { range } : undefined);
    setProtectedMediaHeaders(res, rel, object);
    if (object.contentRange) res.status(206);

    const body = object.body as NodeJS.ReadableStream & { pipe(destination: NodeJS.WritableStream): unknown };
    body.on('error', (err: unknown) => {
      log.error({ err, rel, event: 'upload.remote_stream_failed' }, '[uploads] Remote byte stream failed');
      if (!res.headersSent) res.status(503).end();
      else res.destroy(err instanceof Error ? err : undefined);
    });
    body.pipe(res);
    return true;
  } catch (err) {
    if (isRangeStorageError(err)) {
      res.status(416).setHeader('Content-Range', 'bytes */*').end();
      return true;
    }
    if (isNotFoundStorageError(err)) {
      res.status(404).json({ error: 'Dosya bulunamadı.' });
      return true;
    }
    log.error({ err, rel, event: 'upload.remote_read_failed' }, '[uploads] Remote object read failed');
    res.status(503).json({ error: 'Dosya geçici olarak kullanılamıyor.' });
    return true;
  }
}

export function uploadAuthz() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      let rel: string;
      try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); }
      catch { res.status(400).json({ error: 'Bad path' }); return; }

      // Alt dizinler HERKESE AÇIK varlıklardır (emoji, avatar, sticker…).
      if (!rel || rel.includes('/')) { next(); return; }

      // ── GERIYE DONUK UYUMLULUK: KOKTEKI ESKI AVATAR/BANNER DOSYALARI ─────
      // Avatar ve banner ARTIK `uploads/avatars/` ve `uploads/banners/`
      // altina yazilir (bkz. routes/auth.ts). Ancak DAHA ONCE koke yazilmis
      // dosyalar mevcuttur ve kullanicilarin `avatarUrl` alanlari onlari
      // gosterir. Onlar da HERKESE ACIK varliklardir.
      //
      // NEDEN GUVENLI: mesaj ekleri sunucu tarafinda `${uuidv4()}${ext}`
      // olarak adlandirilir (routes/upload.ts diskStorage) — bir UUID asla
      // `avatar_`/`banner_` ile BASLAYAMAZ. Dosya adi kullanici girdisinden
      // TURETILMEZ, dolayisiyla bu muafiyet zorlanamaz.
      // Kalip, sunucunun urettigi bicime SIKI SIKIYA baglanir.
      if (/^(avatar|banner)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,6}$/i.test(rel)) {
        next(); return;
      }

      const fileUrl = `/uploads/${rel}`;
      const owners = await findOwners(fileUrl);

      const user = await identify(req);
      if (!user) { res.status(401).json({ error: 'Authentication required' }); return; }

      if (!(await authorizedAny(user.id, owners))) {
        res.status(403).json({ error: 'Bu dosyaya erişim yetkiniz yok.' });
        return;
      }
      if (await serveRemoteProtectedUpload(req, res, rel)) return;

      // Local bytes are served by express.static after this middleware. Set the
      // same privacy/security boundary *before* handing off so an intermediary
      // cannot cache an authenticated private attachment as a public object.
      setProtectedMediaHeaders(res, rel, {});
      next();
    } catch (err) {
      // FAIL-CLOSED: yetkilendirme çözümlenemiyorsa dosya SERVİS EDİLMEZ.
      log.error({ err, event: 'upload.authz.failed' }, '[uploads] Yetkilendirme başarısız — reddedildi');
      res.status(403).json({ error: 'Bu dosyaya erişim yetkiniz yok.' });
    }
  };
}

/** @deprecated Authority mapping is no longer cached; retained for test compatibility. */
export function _resetUploadAuthzCache(): void { /* no-op */ }
