/**
 * @openapi
 * tags:
 *   - name: Servers
 *     description: Servers API endpoints

 *
 * /servers/{sid}/invites:
 *   post:
 *     tags: [Servers]
 *     summary: Davet linki olustur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               maxUses:   { type: integer, nullable: true }
 *               expiresIn: { type: integer, description: 'Saniye cinsinden sure', nullable: true }
 *     responses:
 *       201:
 *         description: Davet olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: string }
 *                 url:  { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /invites/{code}/use:
 *   post:
 *     tags: [Servers]
 *     summary: Davet kodunu kullanarak sunucuya katil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sunucuya katilindi
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /invites/{code}/qr:
 *   get:
 *     tags: [Servers]
 *     summary: Davet QR kodu (HTML sayfasi)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: QR kodu HTML
 *         content:
 *           text/html:
 *             schema: { type: string }
 *
 * /invites/{code}/qr/data:
 *   get:
 *     tags: [Servers]
 *     summary: Davet QR kodu JSON verisi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: QR veri URL'i ve metadata
 *
 * /invites/{code}/qr/png:
 *   get:
 *     tags: [Servers]
 *     summary: Davet QR kodu PNG gorsel
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: PNG gorsel
 *         content:
 *           image/png:
 *             schema: { type: string, format: binary }
 *       404: { $ref: '#/components/responses/NotFound' }
 */

// server/routes/servers/invites.ts — Invite CRUD + QR code routes
import express from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router({ mergeParams: true });

import { Invites, Members, Servers } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { afterMemberJoined } from '../../lib/serverMembership';
import { checkServerJoinMfa } from '../../lib/serverMfaPolicy';
import { checkServerJoinRaid } from '../../lib/raidProtection';


function assertInvite(invite: Awaited<ReturnType<typeof Invites.findByCode>>, res: express.Response): asserts invite is NonNullable<Awaited<ReturnType<typeof Invites.findByCode>>> {
  const err = Invites.isValid(invite);
  if (err) {
    res.status(invite ? 410 : 404).json({ error: err });
    throw new Error('invalid invite');
  }
}


// POST /api/servers/invites
router.post('/', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;

  // Faz 10.10 — GÖVDE TİP DOĞRULAMASI (sorgu operatörü enjeksiyonu).
  //
  // `serverId` gövdeden HAM olarak `Members.findOne(userId, serverId)`e
  // geçiyordu. Depo katmanı Mongo tarzı sorgu nesneleri kabul eder ve
  // Postgres adaptörü bunları GERÇEK SQL operatörlerine çevirir
  // (db/postgres/pgCollection.ts — $in/$ne/$gt/$gte/$lt/$regex/$exists).
  // `$`-anahtarlarını temizleyen global bir katman YOKTUR.
  //
  // Sonuç: `{ "serverId": { "$ne": "yok" } }` yükü, saldırganın HERHANGİ bir
  // sunucudaki üyelik satırıyla eşleşerek üyelik kontrolünü geçiyordu; ardından
  // `Servers.findById` rastgele bir sunucu döndürüp adını sızdırıyor ve nesne
  // `serverId` olarak davet satırına yazılıyordu. Yalnız düz string kabul edilir.
  const rawServerId = (req.body as Record<string, unknown> | undefined)?.serverId;
  const serverId    = typeof rawServerId === 'string' ? rawServerId.trim() : '';
  if (!serverId) return res.status(400).json({ error: 'serverId required' });

  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this server' });

  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // OpenAPI contract is an integer. `parseInt()` was too permissive here:
  // values such as "3x", [2] or -1 were silently coerced, and negative
  // values later behaved as unlimited because validity checks use `> 0`.
  // Keep unlimited explicit (`0`) and reject ambiguous/non-integer input.
  const rawMaxUses = (req.body as Record<string, unknown> | undefined)?.maxUses;
  let maxUses = 0;
  if (rawMaxUses !== undefined && rawMaxUses !== null) {
    if (typeof rawMaxUses !== 'number' || !Number.isSafeInteger(rawMaxUses) || rawMaxUses < 0) {
      return res.status(400).json({ error: 'maxUses must be a non-negative integer' });
    }
    maxUses = rawMaxUses;
  }
  const { code, expiresAt } = await Invites.create({ serverId, createdBy: _u.id, maxUses });
  res.json({ code, expiresAt, maxUses, serverName: server.name });
});

// POST /api/servers/invites/:code/use
router.post('/:code/use', authMiddleware, limits.servers(), async (req, res) => {
  const _u   = castAuthed(req).user;
  const code = String(String(req.params.code ?? '')).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  try { assertInvite(invite, res); } catch { return; }

  // BANLI SATIRLAR DA GORULMELIDIR: `findOne` artik yetkilendirme icin
  // banli satirlari eler; burada ise banli birinin davetle GERI DONMESINI
  // engellemek gerekir. Aksi halde ban, tek bir davet baglantisiyla
  // atlatilabilirdi.
  const existing = await Members.findIncludingBanned(_u.id, invite.serverId);
  if (existing && (existing as { banned?: boolean }).banned) {
    return res.status(403).json({ error: 'Bu sunucudan yasaklandınız' });
  }
  if (existing) return res.status(400).json({ error: 'Already a member' });

  // Invite join must enforce the same server MFA policy as the canonical
  // discoverable join route; an invite is not an authentication-policy bypass.
  const server = await Servers.findById(invite.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const mfa = await checkServerJoinMfa(
    _u.id,
    invite.serverId,
    (server as unknown as Record<string, unknown>).mfaLevel,
  );
  if (mfa.required && !mfa.satisfied) {
    return res.status(403).json({
      error: 'MFA_REQUIRED',
      message: 'Bu sunucuya katılmak için bir güvenlik anahtarı (passkey) kaydetmeniz gerekiyor.',
      mfaLevel: mfa.level,
    });
  }

  // Invite joins share the exact same server-wide aggregate as discoverable
  // joins. A raid cannot evade the window by alternating entry routes.
  const raid = await checkServerJoinRaid({
    serverId: invite.serverId,
    actorId: _u.id,
    server: server as unknown as Record<string, unknown>,
    source: 'invite',
  });
  if (!raid.allowed) {
    const retryAfterMs = Math.max(1, raid.retryAfterMs);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
    if (raid.code === 'RAID_AUTHORITY_UNAVAILABLE') {
      return res.status(503).json({ error: 'RAID_PROTECTION_UNAVAILABLE', retryAfterMs });
    }
    return res.status(429).json({
      error: 'RAID_LOCKDOWN',
      retryAfterMs,
      lockdownUntil: raid.lockdownUntil,
      level: raid.level,
    });
  }

  const atomicConsume = await Invites.consumeForMemberAtomic(invite._id, _u.id, invite.serverId);
  if (atomicConsume) {
    if (atomicConsume.status === 'not_found') return res.status(404).json({ error: 'Invalid invite code' });
    if (atomicConsume.status === 'expired') return res.status(410).json({ error: 'Invite has expired' });
    if (atomicConsume.status === 'max_uses') return res.status(410).json({ error: 'Invite has reached its maximum uses' });
    if (atomicConsume.status === 'banned') return res.status(403).json({ error: 'Bu sunucudan yasaklandınız' });
    if (atomicConsume.status === 'already_member') return res.status(400).json({ error: 'Already a member' });
    if (atomicConsume.status === 'scope_mismatch') return res.status(409).json({ error: 'Invite scope mismatch' });
  } else {
    // In-memory Jest compatibility path only. Production consumption above is
    // transaction-owned and never uses this read/modify/write fallback.
    await Members.insert(_u.id, invite.serverId);
    await Invites.incrementUses(invite._id);
  }

  // ── UYELIK ONBELLEGI GECERSIZ KILINMALI ──────────────────────────────────
  // Soket, baglanirken kullanicinin sunucu odalarina `presence:memberships:*`
  // ONBELLEGINDEN bakarak katilir (lib/presenceCache, TTL 300 sn).
  //
  // Burada yalnizca UYE SAYISI onbellegi temizleniyordu; UYELIK LISTESI
  // temizlenmiyordu. Sonuc: davet baglantisiyla katilan kullanici — ki bu
  // sunucuya katilmanin ASIL yoludur — 5 dakikaya kadar yeni sunucunun
  // soket odasina HIC girmiyordu. O sure boyunca sunucu duzeyindeki canli
  // olaylarin hicbirini almiyordu; yeniden baglanmak da yardimci olmuyordu
  // cunku bayat onbellek yeniden okunuyordu.
  //
  // Dogrudan katilma rotasi (routes/servers/core.ts) bunu ZATEN yapiyordu;
  // kardes yol olan davet akisi atlanmisti.
  await afterMemberJoined(
    { id: _u.id, username: _u.username, displayName: _u.displayName },
    invite.serverId,
  );

  res.json(server);
});

// GET /api/servers/invites/:code/qr  — SVG
router.get('/:code/qr', authMiddleware, async (req, res) => {
  const code   = String(String(req.params.code ?? '')).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  try { assertInvite(invite, res); } catch { return; }

  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;
  const qrSvg = await generateQrSvg(inviteUrl);
  if (!qrSvg) return res.status(501).json({ error: 'QR oluşturucu kullanılamıyor' });

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(qrSvg);
});

// GET /api/servers/invites/:code/qr/data  — JSON data URL
router.get('/:code/qr/data', authMiddleware, async (req, res) => {
  const code   = String(String(req.params.code ?? '')).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  try { assertInvite(invite, res); } catch { return; }

  const server    = await Servers.findById(invite.serverId);
  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;
  const qrSvg = await generateQrSvg(inviteUrl);
  if (!qrSvg) return res.status(501).json({ error: 'QR oluşturucu kullanılamıyor' });
  const dataUrl  = 'data:image/svg+xml;base64,' + Buffer.from(qrSvg ?? '').toString('base64');

  res.json({ code, inviteUrl, qrDataUrl: dataUrl, serverName: server?.name, expiresAt: invite.expiresAt });
});

// GET /api/servers/invites/:code/qr/png  — PNG (requires 'qrcode' package)
router.get('/:code/qr/png', authMiddleware, async (req, res) => {
  const QRCode = await loadQrCode();
  if (!QRCode) {
    return res.status(501).json({ error: 'QR PNG için: npm install qrcode', hint: 'SVG endpoint kullanın: /qr' });
  }

  const code   = String(String(req.params.code ?? '')).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  try { assertInvite(invite, res); } catch { return; }

  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;

  const pngBuffer = await QRCode.toBuffer(inviteUrl, { width: 300, margin: 2, color: { dark: '#2d9cdb', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(pngBuffer);
});

type QrCodeModule = {
  toString(text: string, options: Record<string, unknown>): Promise<string>;
  toBuffer(text: string, options: Record<string, unknown>): Promise<Buffer>;
};

async function loadQrCode(): Promise<QrCodeModule | null> {
  try {
    const imported = await import('qrcode') as unknown as QrCodeModule & { default?: QrCodeModule };
    return imported.default ?? imported;
  } catch {
    return null;
  }
}

// Gerçek, taranabilir SVG QR. Eski sürüm yalnızca "npm i qrcode" yazan bir
// placeholder SVG üretiyor ve test de sadece `<svg>` arıyordu.
async function generateQrSvg(text: string): Promise<string | null> {
  const QRCode = await loadQrCode();
  if (!QRCode) return null;
  return QRCode.toString(text, {
    type: 'svg',
    width: 300,
    margin: 2,
    color: { dark: '#2d9cdb', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
}

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
