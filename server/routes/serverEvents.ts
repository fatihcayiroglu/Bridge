// server/routes/serverEvents.ts
// Sprint 95 — Sunucu Etkinlikleri (Guild Scheduled Events)
// Sprint 97 — db.query() → ServerEventRepository tam geçiş
// Sprint 105: OpenAPI annotations eklendi

/**
 * @openapi
 * /servers/{sid}/events:
 *   get:
 *     tags: [ServerEvents]
 *     summary: Sunucu etkinliklerini listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Etkinlik listesi }
 *   post:
 *     tags: [ServerEvents]
 *     summary: Yeni etkinlik oluştur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, startTime, type]
 *             properties:
 *               title:       { type: string, maxLength: 100 }
 *               description: { type: string, maxLength: 1000 }
 *               startTime:   { type: string, format: date-time }
 *               endTime:     { type: string, format: date-time }
 *               type:        { type: string, enum: [voice, stage, external] }
 *               location:    { type: string }
 *               channelId:   { type: string }
 *     responses:
 *       201: { description: Etkinlik oluşturuldu }
 * /servers/{sid}/events/{eid}:
 *   get:
 *     tags: [ServerEvents]
 *     summary: Etkinlik detayı
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *       - { name: eid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Etkinlik detayı }
 *       404: { description: Etkinlik bulunamadı }
 *   patch:
 *     tags: [ServerEvents]
 *     summary: Etkinliği güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *       - { name: eid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Etkinlik güncellendi }
 *   delete:
 *     tags: [ServerEvents]
 *     summary: Etkinliği iptal et
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *       - { name: eid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Etkinlik silindi }
 * /servers/{sid}/events/{eid}/rsvp:
 *   post:
 *     tags: [ServerEvents]
 *     summary: Etkinliğe katıl (RSVP)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *       - { name: eid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: RSVP kaydedildi }
 *   delete:
 *     tags: [ServerEvents]
 *     summary: Etkinlik katılımını iptal et
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *       - { name: eid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: RSVP iptal edildi }
 */
//
// Uç noktalar:
//   GET    /servers/:sid/events               — Etkinlik listesi (upcoming/past)
//   POST   /servers/:sid/events               — Etkinlik oluştur (admin/mod)
//   GET    /servers/:sid/events/:eid          — Tek etkinlik detayı + katılımcılar
//   PATCH  /servers/:sid/events/:eid          — Etkinlik güncelle
//   DELETE /servers/:sid/events/:eid          — Etkinlik sil
//   POST   /servers/:sid/events/:eid/rsvp     — RSVP: interested / going / not_going
//   DELETE /servers/:sid/events/:eid/rsvp     — RSVP iptal

import express, { Request, Response, NextFunction } from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router({ mergeParams: true });
const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();
function limitOrPass(maybeLimiter: unknown) {
  return typeof maybeLimiter === 'function' ? maybeLimiter as (req: Request, res: Response, next: NextFunction) => void : passThrough;
}

import { ServerEvents }                  from '../db/repositories/ServerEventRepository.js';
import { authMiddleware}    from '../middleware/auth';
import { limits }                        from '../middleware/rateLimit';
import { validate, z }                   from '../middleware/validate';
import { Members }                       from '../db/repositories';
import { isSafeUrl }                     from '../lib/security';

// ── Şemalar ───────────────────────────────────────────────────────────────────

const createEventSchema = z.object({
  title:       z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  location:    z.string().max(200).optional(),
  channelId:   z.string().optional(),
  startsAt:    z.string().datetime(),
  endsAt:      z.string().datetime().optional(),
  coverImage:  z.string()
    .refine(isSafeUrl, { message: 'coverImage must be a valid http/https URL' })
    .optional(),
});

const updateEventSchema = createEventSchema.partial().extend({
  status: z.enum(['scheduled', 'active', 'ended', 'cancelled']).optional(),
});

const rsvpSchema = z.object({
  status: z.enum(['interested', 'going', 'not_going']),
});

// ── İzin kontrol yardımcısı ───────────────────────────────────────────────────

async function requireEventPerm(userId: string, serverId: string): Promise<boolean> {
  const member = await Members.findOne({ userId, serverId });
  if (!member) return false;
  const perms = (member.permissions as Record<string, boolean> | null) ?? {};
  return !!(member.isOwner || perms.ADMINISTRATOR || perms.MANAGE_EVENTS);
}

// ── GET /servers/:sid/events ──────────────────────────────────────────────────

router.get(
  '/:sid/events',
  authMiddleware,
  limitOrPass((limits as unknown as { serverEvents?: unknown }).serverEvents),
  async (req: Request, res: Response) => {
    const u      = castAuthed(req).user;
    const sid    = String(String(req.params.sid ?? '') ?? "");
    const member = await Members.findOne({ userId: u.id, serverId: sid });
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const filter = (['upcoming', 'past', 'all'].includes(req.query.filter as string as string)
      ? req.query.filter as string as 'upcoming' | 'past' | 'all'
      : 'upcoming');
    const limit  = Math.min(parseInt(req.query.limit as string  as string) || 20, 100);
    const offset = parseInt(req.query.offset as string as string) || 0;

    const { events, total } = await ServerEvents.findByServer(sid, u.id, filter, limit, offset);
    return res.json({ events, total, limit, offset });
  },
);

// ── POST /servers/:sid/events ─────────────────────────────────────────────────

router.post(
  '/:sid/events',
  authMiddleware,
  limits.write,
  validate(createEventSchema),
  async (req: Request, res: Response) => {
    const u   = castAuthed(req).user;
    const sid = String(String(req.params.sid ?? '') ?? "");

    if (!(await requireEventPerm(u.id, sid))) {
      return res.status(403).json({ error: 'MANAGE_EVENTS permission required' });
    }

    const { title, description, location, channelId, startsAt, endsAt, coverImage } =
      req.body as z.infer<typeof createEventSchema>;

    if (coverImage !== undefined && !isSafeUrl(String(coverImage))) {
      return res.status(400).json({ error: 'coverImage must be a valid http/https URL' });
    }

    const startsDate = new Date(startsAt);
    const endsDate   = endsAt ? new Date(endsAt) : null;
    if (isNaN(startsDate.getTime())) return res.status(400).json({ error: 'Invalid startsAt' });
    if (endsDate && endsDate <= startsDate) {
      return res.status(400).json({ error: 'endsAt must be after startsAt' });
    }

    const event = await ServerEvents.create({
      serverId:    sid,
      creatorId:   u.id,
      title,
      description: description ?? null,
      location:    location    ?? null,
      channelId:   channelId   ?? null,
      startsAt:    startsDate,
      endsAt:      endsDate,
      coverImage:  coverImage  ?? null,
    });

    req.app.get('io')?.to(`server:${sid}`).emit('server:event:created', { event });
    return res.status(201).json({ event });
  },
);

// ── GET /servers/:sid/events/:eid ─────────────────────────────────────────────

router.get(
  '/:sid/events/:eid',
  authMiddleware,
  limitOrPass((limits as unknown as { serverEvents?: unknown }).serverEvents),
  async (req: Request, res: Response) => {
    const u            = castAuthed(req).user;
    const sid = String(req.params.sid ?? '');
  const eid = String(req.params.eid ?? '');

    const member = await Members.findOne({ userId: u.id, serverId: sid });
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const event = await ServerEvents.findOne(eid, sid);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const [rsvps, myRsvp] = await Promise.all([
      ServerEvents.findRsvpList(eid),
      ServerEvents.findMyRsvp(eid, u.id),
    ]);

    return res.json({ event, rsvps, myRsvp });
  },
);

// ── PATCH /servers/:sid/events/:eid ──────────────────────────────────────────

router.patch(
  '/:sid/events/:eid',
  authMiddleware,
  limits.write,
  validate(updateEventSchema),
  async (req: Request, res: Response) => {
    const u            = castAuthed(req).user;
    const sid = String(req.params.sid ?? '');
  const eid = String(req.params.eid ?? '');

    if (!(await requireEventPerm(u.id, sid))) {
      return res.status(403).json({ error: 'MANAGE_EVENTS permission required' });
    }

    const exists = await ServerEvents.exists(eid, sid);
    if (!exists) return res.status(404).json({ error: 'Event not found' });

    const updated = await ServerEvents.update(eid, sid, req.body as Record<string, string>);
    if (!updated) return res.status(400).json({ error: 'No fields to update' });

    req.app.get('io')?.to(`server:${sid}`).emit('server:event:updated', { event: updated });
    return res.json({ event: updated });
  },
);

// ── DELETE /servers/:sid/events/:eid ─────────────────────────────────────────

router.delete(
  '/:sid/events/:eid',
  authMiddleware,
  limits.write,
  async (req: Request, res: Response) => {
    const u            = castAuthed(req).user;
    const sid = String(req.params.sid ?? '');
  const eid = String(req.params.eid ?? '');

    if (!(await requireEventPerm(u.id, sid))) {
      return res.status(403).json({ error: 'MANAGE_EVENTS permission required' });
    }

    await ServerEvents.delete(eid, sid);
    req.app.get('io')?.to(`server:${sid}`).emit('server:event:deleted', { eventId: eid });
    return res.json({ ok: true });
  },
);

// ── POST /servers/:sid/events/:eid/rsvp ──────────────────────────────────────

router.post(
  '/:sid/events/:eid/rsvp',
  authMiddleware,
  limits.write,
  validate(rsvpSchema),
  async (req: Request, res: Response) => {
    const u            = castAuthed(req).user;
    const sid = String(req.params.sid ?? '');
  const eid = String(req.params.eid ?? '');
    const { status }   = req.body as { status: 'interested' | 'going' | 'not_going' };
    if (!['interested', 'going', 'not_going'].includes(status)) {
      return res.status(400).json({ error: 'Invalid RSVP status' });
    }

    const member = await Members.findOne({ userId: u.id, serverId: sid });
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const exists = await ServerEvents.exists(eid, sid);
    if (!exists) return res.status(404).json({ error: 'Event not found' });

    await ServerEvents.upsertRsvp(eid, u.id, status);
    const count = await ServerEvents.countAttendees(eid);

    req.app.get('io')?.to(`server:${sid}`).emit('server:event:rsvp', {
      eventId: eid, userId: u.id, status, count,
    });
    return res.json({ ok: true, status });
  },
);

// ── DELETE /servers/:sid/events/:eid/rsvp ────────────────────────────────────

router.delete(
  '/:sid/events/:eid/rsvp',
  authMiddleware,
  limits.write,
  async (req: Request, res: Response) => {
    const u            = castAuthed(req).user;
    const sid = String(req.params.sid ?? '');
  const eid = String(req.params.eid ?? '');

    await ServerEvents.deleteRsvp(eid, u.id);
    req.app.get('io')?.to(`server:${sid}`).emit('server:event:rsvp', {
      eventId: eid, userId: u.id, status: null,
    });
    return res.json({ ok: true });
  },
);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
