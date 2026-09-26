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
import { checkOutboundUrl } from '../lib/urlSafety';
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
import { parsePersistedNonNegativeInteger } from '../lib/persistedInteger';

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

interface WebhookResult { ok: boolean; status: number; error?: string; permanent?: boolean }

function parseEvents(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.map(String) : []; }
    catch { return value ? [value] : []; }
  }
  return [];
}

function parseRequestEvents(value: unknown): { ok: true; events: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0)
    return { ok: false, error: 'events must be a non-empty string array' };
  if (!value.every(event => typeof event === 'string' && event.trim().length > 0))
    return { ok: false, error: 'events must contain only non-empty strings' };
  const events = [...new Set(value.map(event => (event as string).trim()))];
  const invalid = events.filter(event => event !== '*' && !SUPPORTED_EVENTS.includes(event));
  if (invalid.length) return { ok: false, error: `Unsupported events: ${invalid.join(', ')}` };
  return { ok: true, events };
}

function serializeWebhook(webhook: OutgoingWebhook): Record<string, unknown> {
  return {
    _id: webhook._id,
    name: webhook.name,
    url: webhook.url,
    events: parseEvents(webhook.events),
    enabled: !!webhook.enabled,
    // Never expose the stored signing secret after creation/update. Clients
    // only need to know whether a secret exists.
    secret: webhook.secret ? '••••••••' : null,
    lastFiredAt: webhook.lastFiredAt ?? null,
    lastStatus: webhook.lastStatus ?? null,
    consecutiveFailures: webhook.consecutiveFailures || 0,
    lastFailedAt: webhook.lastFailedAt ?? null,
    lastError: webhook.lastError ?? null,
    createdAt: webhook.createdAt,
  };
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
}

async function fireOutgoingWebhook(webhook: OutgoingWebhook, eventName: string, payload: unknown, deliveryId = uuidv4()): Promise<WebhookResult> {
  const body = JSON.stringify({ event: eventName, ...objectPayload(payload), timestamp: Date.now() });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Bridge-Event': eventName,
    'X-Bridge-Delivery': deliveryId,
  };
  if (webhook.secret) headers['X-Bridge-Signature'] = signPayload(webhook.secret, body);

  const deliveryCheck = await checkOutboundUrl(webhook.url);
  if (!deliveryCheck.ok) {
    const reason = deliveryCheck.reason ?? 'unsafe target';
    await OutgoingWebhooks.recordDeliveryFailure(webhook._id, 0, reason);
    logger.warn(
      { event: 'webhook.blocked_unsafe_target', webhookId: webhook._id, reason },
      '[webhook] Guvenli olmayan hedefe teslimat ENGELLENDI',
    );
    return { ok: false, status: 0, error: reason, permanent: true };
  }

  try {
    const res = await fetchT(webhook.url as string, { method: 'POST', headers, body, timeoutMs: 8000 });
    if (res.ok) {
      await OutgoingWebhooks.recordDeliverySuccess(webhook._id, res.status);
      return { ok: true, status: res.status };
    }

    const error = `HTTP ${res.status}`;
    const state = await OutgoingWebhooks.recordDeliveryFailure(webhook._id, res.status, error);
    if (state && parsePersistedNonNegativeInteger((state as { consecutiveFailures?: unknown }).consecutiveFailures, 'outgoing webhook failure count', { defaultWhenMissing: 0, max: 2_147_483_647 }) >= 10) {
      logger.warn({ url: webhook.url, webhookId: webhook._id, event: 'webhook.disabled.max_failures' },
        '[Webhook] 10 ardışık hata sonrası devre dışı bırakıldı');
    }
    const permanent = res.status >= 400 && res.status < 500 && ![408, 409, 425, 429].includes(res.status);
    return { ok: false, status: res.status, error, permanent };
  } catch (_err) {
    const err = _err as Error;
    const state = await OutgoingWebhooks.recordDeliveryFailure(webhook._id, 0, err.message);
    if (state && parsePersistedNonNegativeInteger((state as { consecutiveFailures?: unknown }).consecutiveFailures, 'outgoing webhook failure count', { defaultWhenMissing: 0, max: 2_147_483_647 }) >= 10) {
      logger.warn({ url: webhook.url, webhookId: webhook._id, event: 'webhook.disabled.max_failures' },
        '[Webhook] 10 ardışık hata sonrası devre dışı bırakıldı');
    }
    return { ok: false, status: 0, error: err.message };
  }
}

const DELIVERY_MAX_ATTEMPTS = 3;
const DELIVERY_RETRY_DELAYS = [30_000, 60_000, 120_000];
const DELIVERY_WORKER_ID = `webhook:${process.pid}:${uuidv4()}`;
const DELIVERY_LEASE_MS = 120_000;
const DELIVERY_BATCH = 100;
const DELIVERY_QUEUE_LIMIT_PER_WEBHOOK = 1000;
let _deliveryInterval: ReturnType<typeof setInterval> | null = null;
let _deliveryProcessing = false;

async function processOutgoingWebhookDeliveries(): Promise<void> {
  if (_deliveryProcessing) return;
  _deliveryProcessing = true;
  try {
    const rows = await OutgoingWebhooks.claimDueDeliveries(
      Date.now(), DELIVERY_WORKER_ID, DELIVERY_LEASE_MS, DELIVERY_BATCH,
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = String(row._id ?? '');
      const webhookId = String(row.webhookId ?? '');
      const serverId = String(row.serverId ?? '');
      const eventName = String(row.eventName ?? '');
      const payload = objectPayload(row.payload);
      let attempts: number;
      try {
        attempts = parsePersistedNonNegativeInteger(row.attempts, 'outgoing webhook delivery attempts', { defaultWhenMissing: 0, max: DELIVERY_MAX_ATTEMPTS });
      } catch {
        // Corrupt retry state is terminal rather than an accidental infinite retry budget.
        await OutgoingWebhooks.completeDelivery(id, DELIVERY_WORKER_ID);
        logger.error({ id, webhookId, event: 'webhook.delivery.invalid_attempt_state' }, '[Webhook] Invalid persisted retry state; delivery quarantined.');
        continue;
      }
      try {
        const webhook = await OutgoingWebhooks.findByIdAndServer(webhookId, serverId);
        if (!webhook || !webhook.enabled) {
          await OutgoingWebhooks.completeDelivery(id, DELIVERY_WORKER_ID);
          continue;
        }

        const result = await fireOutgoingWebhook(webhook, eventName, payload, id);
        if (result.ok || result.permanent) {
          await OutgoingWebhooks.completeDelivery(id, DELIVERY_WORKER_ID);
          continue;
        }

        const nextAttempts = attempts + 1;
        if (nextAttempts >= DELIVERY_MAX_ATTEMPTS) {
          await OutgoingWebhooks.completeDelivery(id, DELIVERY_WORKER_ID);
          logger.warn(
            { event: 'webhook.delivery.exhausted', webhookId, serverId, eventName, attempts: nextAttempts, error: result.error },
            '[Webhook] Durable delivery retry limit reached; delivery dropped after bounded retries.',
          );
          continue;
        }
        // Deneme sayisi tablo boyunu asarsa `undefined` ile toplama `NaN` bir
        // zaman damgasi uretir ve teslimat SONSUZA KADAR beklerdi.
        const nextAt = Date.now() + (DELIVERY_RETRY_DELAYS[nextAttempts - 1]
          ?? DELIVERY_RETRY_DELAYS[DELIVERY_RETRY_DELAYS.length - 1] ?? 0);
        await OutgoingWebhooks.retryDelivery(
          id, DELIVERY_WORKER_ID, nextAttempts, nextAt, result.error ?? `HTTP ${result.status}`,
        );
      } catch (err) {
        const nextAttempts = attempts + 1;
        if (nextAttempts >= DELIVERY_MAX_ATTEMPTS) {
          try {
            await OutgoingWebhooks.completeDelivery(id, DELIVERY_WORKER_ID);
          } catch (completeErr) {
            logger.error(
              { err: completeErr, id, webhookId, serverId, eventName, event: 'webhook.delivery.terminal_cleanup_failed' },
              '[Webhook] Terminal durable delivery state could not be cleared; lease expiry will retain it for recovery.',
            );
          }
          logger.error(
            { err, event: 'webhook.delivery.worker_exhausted', webhookId, serverId, eventName, attempts: nextAttempts },
            '[Webhook] Delivery worker exhausted retries after an internal error.',
          );
        } else {
          // Deneme sayisi tablo boyunu asarsa `undefined` ile toplama `NaN` bir
        // zaman damgasi uretir ve teslimat SONSUZA KADAR beklerdi.
        const nextAt = Date.now() + (DELIVERY_RETRY_DELAYS[nextAttempts - 1]
          ?? DELIVERY_RETRY_DELAYS[DELIVERY_RETRY_DELAYS.length - 1] ?? 0);
          await OutgoingWebhooks.retryDelivery(
            id, DELIVERY_WORKER_ID, nextAttempts, nextAt, err instanceof Error ? err.message : String(err),
          ).catch((releaseErr) => {
            logger.error({ err: releaseErr, id, event: 'webhook.delivery.release_failed' },
              '[Webhook] Failed to release durable delivery lease.');
          });
        }
      }
    }
  } finally {
    _deliveryProcessing = false;
  }
}

function startOutgoingWebhookDeliveryJob(): void {
  if (_deliveryInterval) return;
  void processOutgoingWebhookDeliveries().catch(err =>
    logger.error({ err, event: 'webhook.delivery.startup_worker_failed' }, '[Webhook] Startup delivery recovery failed.'),
  );
  _deliveryInterval = setInterval(() => {
    void processOutgoingWebhookDeliveries().catch(err =>
      logger.error({ err, event: 'webhook.delivery.worker_failed' }, '[Webhook] Durable delivery worker failed.'),
    );
  }, 5_000);
  _deliveryInterval.unref?.();
}

function stopOutgoingWebhookDeliveryJob(): void {
  if (_deliveryInterval) {
    clearInterval(_deliveryInterval);
    _deliveryInterval = null;
  }
}

async function dispatchEvent(serverId: string, eventName: string, payload: unknown): Promise<void> {
  if (!OutgoingWebhooks.hasCollection()) return;
  try {
    const webhooks = await OutgoingWebhooks.findEnabledByServer(serverId);
    for (const wh of webhooks) {
      const events = parseEvents(wh.events);
      if (!events.includes(eventName) && !events.includes('*')) continue;
      const queued = await OutgoingWebhooks.enqueueDeliveryBounded(
        wh._id, serverId, eventName, objectPayload(payload), DELIVERY_QUEUE_LIMIT_PER_WEBHOOK,
      );
      if (!queued) {
        logger.error(
          { webhookId: wh._id, serverId, eventName, event: 'webhook.delivery.queue_full' },
          '[Webhook] Per-webhook durable queue is full; new delivery was rejected instead of allowing unbounded growth.',
        );
      }
    }
    void processOutgoingWebhookDeliveries().catch(err => {
      logger.error({ err, serverId, eventName, event: 'webhook.delivery.immediate_worker_failed' },
        '[Webhook] Immediate durable delivery worker failed; queued rows remain for retry.');
    });
  } catch (err) {
    logger.error({ err, serverId, eventName, event: 'webhook.dispatch.lookup_failed' },
      '[Webhook] Enabled webhook lookup/enqueue failed; event dispatch was skipped.');
    throw err;
  }
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
  res.json(webhooks.map(serializeWebhook));
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

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
  if (!body) return res.status(400).json({ error: 'JSON object body required' });

  const { name, url, events, secret } = body;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (typeof url !== 'string' || !url.trim()) return res.status(400).json({ error: 'URL required' });
  if (secret !== undefined && secret !== null && typeof secret !== 'string')
    return res.status(400).json({ error: 'secret must be a string or null' });
  // `new URL()` yalnizca AYRISTIRILABILIRLIK soyler, GUVENLIK degil.
  // Onceki hali `http://169.254.169.254/` (bulut metadata) ve `http://127.0.0.1`
  // gibi hedefleri kabul ediyordu → SSRF. Bkz. lib/urlSafety.ts
  const normalizedUrl = url.trim();
  const urlCheck = await checkOutboundUrl(normalizedUrl);
  if (!urlCheck.ok) return res.status(400).json({ error: urlCheck.reason ?? 'Invalid URL' });

  const parsedEvents = events === undefined
    ? { ok: true as const, events: ['message:new'] }
    : parseRequestEvents(events);
  if (!parsedEvents.ok) return res.status(400).json({ error: parsedEvents.error });
  const eventList = parsedEvents.events;

  const existing = await OutgoingWebhooks.findByServer(String(req.params.sid ?? ''));
  if (existing.length >= 20) return res.status(429).json({ error: 'Max 20 outgoing webhooks per server' });

  const webhook = await OutgoingWebhooks.insert({
    _id: uuidv4(),
    serverId: String(req.params.sid ?? ''),
    name: name.trim().slice(0, 80),
    url: normalizedUrl,
    events: JSON.stringify(eventList),
    secret: typeof secret === 'string' ? secret.trim() || null : null,
    enabled: true,
    createdBy: _u.id,
    createdAt: Date.now(),
  });

  res.status(201).json(serializeWebhook(webhook as OutgoingWebhook));
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
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
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

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
  if (!body) return res.status(400).json({ error: 'JSON object body required' });

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim())
      return res.status(400).json({ error: 'name must be a non-empty string' });
    updates.name = body.name.trim().slice(0, 80);
  }
  if (body.url !== undefined) {
    if (typeof body.url !== 'string' || !body.url.trim())
      return res.status(400).json({ error: 'url must be a non-empty string' });
    const normalizedUrl = body.url.trim();
    const check = await checkOutboundUrl(normalizedUrl);
    if (!check.ok) return res.status(400).json({ error: check.reason ?? 'Invalid URL' });
    updates.url = normalizedUrl;
  }
  if (body.events !== undefined) {
    const parsed = parseRequestEvents(body.events);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    updates.events = JSON.stringify(parsed.events);
  }
  if (body.secret !== undefined) {
    if (body.secret !== null && typeof body.secret !== 'string')
      return res.status(400).json({ error: 'secret must be a string or null' });
    updates.secret = typeof body.secret === 'string' ? body.secret.trim() || null : null;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean')
      return res.status(400).json({ error: 'enabled must be a boolean' });
    updates.enabled = body.enabled;
  }
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'No supported webhook fields supplied' });

  await OutgoingWebhooks.updateInServer(String(req.params.id ?? ''), String(req.params.sid ?? ''), updates);
  const updated = await OutgoingWebhooks.findByIdAndServer(String(req.params.id ?? ''), String(req.params.sid ?? ''));
  if (!updated) return res.status(404).json({ error: 'Outgoing webhook not found' });
  res.json(serializeWebhook(updated as OutgoingWebhook));
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
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
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

  await OutgoingWebhooks.deleteInServer(String(req.params.id ?? ''), String(req.params.sid ?? ''));
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
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
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

export { router, dispatchEvent, processOutgoingWebhookDeliveries, startOutgoingWebhookDeliveryJob, stopOutgoingWebhookDeliveryJob };
