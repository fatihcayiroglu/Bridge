// server/routes/outgoingWebhooks.ts
// Outgoing Webhook sistemi: Bridge'de bir event olduğunda dış URL'e POST gönderir.
//
// ENDPOINTS:
//   GET    /api/servers/:sid/outgoing-webhooks          — listele
//   POST   /api/servers/:sid/outgoing-webhooks          — oluştur
//   PATCH  /api/servers/:sid/outgoing-webhooks/:id      — güncelle / toggle
//   DELETE /api/servers/:sid/outgoing-webhooks/:id      — sil
//   POST   /api/servers/:sid/outgoing-webhooks/:id/test — test gönder


import logger from '../lib/logger';
import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router({ mergeParams: true });
import { OutgoingWebhooks } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';
import { fetchT } from '../lib/fetch';
import type { OutgoingWebhook } from '../db/repositories/types/entities';

const SUPPORTED_EVENTS = [
  'message:new',
  'message:delete',
  'member:join',
  'member:leave',
  'channel:created',
  'channel:deleted',
];

// ── HELPERS ────────────────────────────────────────────────────

function signPayload(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

interface WebhookResult { ok: boolean; status: number; error?: string }

function parseEvents(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.map(String) : []; }
    catch { return value ? [value] : []; }
  }
  return [];
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
}

async function fireOutgoingWebhook(webhook: OutgoingWebhook, eventName: string, payload: unknown): Promise<WebhookResult> {
  const body = JSON.stringify({ event: eventName, ...objectPayload(payload), timestamp: Date.now() });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Bridge-Event': eventName,
    'X-Bridge-Delivery': uuidv4(),
  };
  if (webhook.secret) headers['X-Bridge-Signature'] = signPayload(webhook.secret, body);

  try {
    const res = await fetchT(webhook.url as string, { method: 'POST', headers, body, timeoutMs: 8000 });
    await OutgoingWebhooks.update(webhook._id, {
      lastFiredAt: Date.now(), lastStatus: res.status, consecutiveFailures: 0,
    });
    return { ok: res.ok, status: res.status };
  } catch (_err) { const err = _err as Error;
    const failures = (webhook.consecutiveFailures || 0) + 1;
    await OutgoingWebhooks.update(webhook._id, {
      lastFiredAt:         Date.now(),
      lastStatus:          0,
      consecutiveFailures: failures,
      lastFailedAt:        Date.now(),
      lastError:           err.message.slice(0, 200),
      ...(failures >= 10 ? { enabled: 0 } : {}),
    });
    if (failures >= 10) {
      logger.warn({ url: webhook.url, event: 'webhook.disabled.max_failures' }, '[Webhook] 10 ardışık hata sonrası devre dışı bırakıldı');
    }
    return { ok: false, status: 0, error: err.message };
  }
}

// Exponential backoff retry wrapper — max 3 attempts (30s, 60s delays)
async function fireWithRetry(webhook: OutgoingWebhook, eventName: string, payload: unknown, attempt = 1): Promise<WebhookResult> {
  const result = await fireOutgoingWebhook(webhook, eventName, payload);
  if (!result.ok && attempt < 3) {
    const delayMs = 30_000 * attempt; // 30s → 60s
    setTimeout(() => fireWithRetry(webhook, eventName, payload, attempt + 1), delayMs);
    logger.info(`[Webhook] Delivery başarısız (attempt ${attempt}/3), ${delayMs / 1000}s sonra yeniden denenecek: ${webhook.url}`);
  }
  return result;
}

// Export for use in socket/routes
async function dispatchEvent(serverId: string, eventName: string, payload: unknown): Promise<void> {
  if (!OutgoingWebhooks.hasCollection()) return;
  try {
    const webhooks = await OutgoingWebhooks.findEnabledByServer(serverId);
    for (const wh of webhooks) {
      const events = parseEvents(wh.events);
      if (events.includes(eventName) || events.includes('*')) {
        fireWithRetry(wh, eventName, payload).catch(() => {});
      }
    }
  } catch {}
}

// ── ROUTES ─────────────────────────────────────────────────────

// GET /api/servers/:sid/outgoing-webhooks
/**
 * @openapi
 * /servers/{sid}/outgoing-webhooks:
 *   get:
 *     tags: [Webhooks]
 *     summary: Sunucudaki outgoing webhook listesi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Webhook listesi }
 *       403: { description: Yetkisiz }
 */
router.get('/:sid/outgoing-webhooks', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const webhooks = await OutgoingWebhooks.findByServer(String(req.params.sid ?? ''));
  res.json(webhooks.map(w => ({
    _id: w._id, name: w.name, url: w.url,
    events: parseEvents(w.events),
    enabled: !!w.enabled, secret: w.secret ? '••••••••' : null,
    lastFiredAt:         w.lastFiredAt,
    lastStatus:          w.lastStatus,
    consecutiveFailures: w.consecutiveFailures || 0,
    lastFailedAt:        w.lastFailedAt || null,
    lastError:           w.lastError || null,
    createdAt:           w.createdAt,
  })));
});

// POST /api/servers/:sid/outgoing-webhooks
/**
 * @openapi
 * /servers/{sid}/outgoing-webhooks:
 *   post:
 *     tags: [Webhooks]
 *     summary: Yeni outgoing webhook oluştur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, events]
 *             properties:
 *               url:    { type: string, format: uri }
 *               events: { type: array, items: { type: string } }
 *               name:   { type: string }
 *     responses:
 *       201: { description: Webhook oluşturuldu }
 *       400: { description: Geçersiz URL veya event listesi }
 *       403: { description: Yetkisiz }
 */
router.post('/:sid/outgoing-webhooks', authMiddleware, limits.webhooks(), async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const { name, url, events = ['message:new'], secret } = req.body as { name?: string; url?: string; events?: unknown; secret?: string };
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  if (!url?.trim())  return res.status(400).json({ error: 'URL required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const eventList = parseEvents(events);
  const invalidEvents = eventList.filter((e: string) => e !== '*' && !SUPPORTED_EVENTS.includes(e));
  if (invalidEvents.length) return res.status(400).json({ error: `Unsupported events: ${invalidEvents.join(', ')}` });

  const existing = await OutgoingWebhooks.findByServer(String(req.params.sid ?? ''));
  if (existing.length >= 20) return res.status(429).json({ error: 'Max 20 outgoing webhooks per server' });

  const webhook = await OutgoingWebhooks.insert({
    _id: uuidv4(),
    serverId: String(req.params.sid ?? ''),
    name: name.trim().slice(0, 80),
    url: url.trim(),
    events: JSON.stringify(eventList),
    secret: secret?.trim() || null,
    enabled: 1,
    createdBy: _u.id,
    createdAt: Date.now(),
  });

  res.status(201).json({
    _id: webhook._id, name: webhook.name, url: webhook.url,
    events: parseEvents(webhook.events), enabled: true,
    secret: webhook.secret ? '••••••••' : null,
    createdAt: webhook.createdAt,
  });
});

// PATCH /api/servers/:sid/outgoing-webhooks/:id
/**
 * @openapi
 * /servers/{sid}/outgoing-webhooks/{id}:
 *   patch:
 *     tags: [Webhooks]
 *     summary: Webhook güncelle (kısmi)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path; name: sid; required: true; schema: { type: string }
 *       - in: path; name: id;  required: true; schema: { type: string }
 *     responses:
 *       200: { description: Güncellendi }
 *       404: { description: Webhook bulunamadı }
 */
router.patch('/:sid/outgoing-webhooks/:id', authMiddleware, limits.webhooks(), async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const wh = await OutgoingWebhooks.findByIdAndServer(String(req.params.id ?? ''), String(req.params.sid ?? ''));
  if (!wh) return res.status(404).json({ error: 'Outgoing webhook not found' });

  const updates: Record<string, unknown> = {};
  if (typeof req.body.name === 'string') updates.name = req.body.name.trim().slice(0, 80);
  if (req.body.url  !== undefined) {
    const url = String(req.body.url);
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    updates.url = url.trim();
  }
  if (req.body.events !== undefined) updates.events = JSON.stringify(parseEvents(req.body.events));
  if (req.body.secret !== undefined) updates.secret = typeof req.body.secret === 'string' ? req.body.secret.trim() || null : null;
  if (req.body.enabled !== undefined) updates.enabled = req.body.enabled ? 1 : 0;

  await OutgoingWebhooks.update(String(req.params.id ?? ''), updates);
  const updated = await OutgoingWebhooks.findById(String(req.params.id ?? ''));
  if (!updated) return res.status(404).json({ error: 'Outgoing webhook not found' });
  res.json({ ...updated, events: parseEvents(updated.events), enabled: !!updated.enabled });
});

// DELETE /api/servers/:sid/outgoing-webhooks/:id
/**
 * @openapi
 * /servers/{sid}/outgoing-webhooks/{id}:
 *   delete:
 *     tags: [Webhooks]
 *     summary: Webhook sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path; name: sid; required: true; schema: { type: string }
 *       - in: path; name: id;  required: true; schema: { type: string }
 *     responses:
 *       204: { description: Silindi }
 *       404: { description: Webhook bulunamadı }
 */
router.delete('/:sid/outgoing-webhooks/:id', authMiddleware, limits.webhooks(), async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const wh = await OutgoingWebhooks.findByIdAndServer(String(req.params.id ?? ''), String(req.params.sid ?? ''));
  if (!wh) return res.status(404).json({ error: 'Not found' });

  await OutgoingWebhooks.delete(String(req.params.id ?? ''));
  res.json({ deleted: true });
});

// POST /api/servers/:sid/outgoing-webhooks/:id/test
/**
 * @openapi
 * /servers/{sid}/outgoing-webhooks/{id}/test:
 *   post:
 *     tags: [Webhooks]
 *     summary: Webhook'a test isteği gönder
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path; name: sid; required: true; schema: { type: string }
 *       - in: path; name: id;  required: true; schema: { type: string }
 *     responses:
 *       200: { description: Test isteği gönderildi }
 *       404: { description: Webhook bulunamadı }
 */
router.post('/:sid/outgoing-webhooks/:id/test', authMiddleware, limits.webhooks(), async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const wh = await OutgoingWebhooks.findByIdAndServer(String(req.params.id ?? ''), String(req.params.sid ?? ''));
  if (!wh) return res.status(404).json({ error: 'Not found' });

  const result = await fireOutgoingWebhook(wh, 'test', {
    message: 'Bu bir Bridge test payload\'ıdır.',
    serverId: String(req.params.sid ?? ''),
  });

  res.json(result);
});

// GET /api/outgoing-webhooks/events — desteklenen event listesi
/**
 * @openapi
 * /outgoing-webhooks/events:
 *   get:
 *     tags: [Webhooks]
 *     summary: Desteklenen webhook event türleri
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Event türleri listesi
 *         content:
 *           application/json:
 *             schema: { type: array, items: { type: string } }
 */
router.get('/outgoing-webhooks/events', authMiddleware, (req, res) => {
  res.json({ events: SUPPORTED_EVENTS });
});

export { router, dispatchEvent };
