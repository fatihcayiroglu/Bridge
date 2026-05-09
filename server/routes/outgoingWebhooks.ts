// server/routes/outgoingWebhooks.js
// Outgoing Webhook sistemi: Bridge'de bir event olduğunda dış URL'e POST gönderir.
//
// ENDPOINTS:
//   GET    /api/servers/:sid/outgoing-webhooks          — listele
//   POST   /api/servers/:sid/outgoing-webhooks          — oluştur
//   PATCH  /api/servers/:sid/outgoing-webhooks/:id      — güncelle / toggle
//   DELETE /api/servers/:sid/outgoing-webhooks/:id      — sil
//   POST   /api/servers/:sid/outgoing-webhooks/:id/test — test gönder

'use strict';

const express    = require('express');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router     = express.Router({ mergeParams: true });
const { OutgoingWebhooks } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { resolvePermissions, hasPermission, PERMS } = require('../lib/permissions');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

const SUPPORTED_EVENTS = [
  'message:new',
  'message:delete',
  'member:join',
  'member:leave',
  'channel:created',
  'channel:deleted',
];

// ── HELPERS ────────────────────────────────────────────────────

function signPayload(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function fireOutgoingWebhook(webhook, eventName, payload) {
  const body = JSON.stringify({ event: eventName, ...payload, timestamp: Date.now() });
  const headers = {
    'Content-Type': 'application/json',
    'X-Bridge-Event': eventName,
    'X-Bridge-Delivery': uuidv4(),
  };
  if (webhook.secret) headers['X-Bridge-Signature'] = signPayload(webhook.secret, body);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(webhook.url, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timeout);
    await OutgoingWebhooks.update(webhook._id, {
      lastFiredAt: Date.now(), lastStatus: res.status, consecutiveFailures: 0,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
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
      console.warn(`[Webhook] ${webhook.url} 10 ardışık hata sonrası devre dışı bırakıldı.`);
    }
    return { ok: false, status: 0, error: err.message };
  }
}

// Exponential backoff retry wrapper — max 3 attempts (30s, 60s delays)
async function fireWithRetry(webhook, eventName, payload, attempt = 1) {
  const result = await fireOutgoingWebhook(webhook, eventName, payload);
  if (!result.ok && attempt < 3) {
    const delayMs = 30_000 * attempt; // 30s → 60s
    setTimeout(() => fireWithRetry(webhook, eventName, payload, attempt + 1), delayMs);
    console.log(`[Webhook] Delivery başarısız (attempt ${attempt}/3), ${delayMs / 1000}s sonra yeniden denenecek: ${webhook.url}`);
  }
  return result;
}

// Export for use in socket/routes
async function dispatchEvent(serverId, eventName, payload) {
  if (!OutgoingWebhooks.hasCollection()) return;
  try {
    const webhooks = await OutgoingWebhooks.findEnabledByServer(serverId);
    for (const wh of webhooks) {
      const events = JSON.parse(wh.events || '[]');
      if (events.includes(eventName) || events.includes('*')) {
        fireWithRetry(wh, eventName, payload).catch(() => {});
      }
    }
  } catch {}
}

// ── ROUTES ─────────────────────────────────────────────────────

// GET /api/servers/:sid/outgoing-webhooks
router.get('/:sid/outgoing-webhooks', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const webhooks = await OutgoingWebhooks.findByServer(req.params.sid);
  res.json(webhooks.map(w => ({
    _id: w._id, name: w.name, url: w.url,
    events: JSON.parse(w.events || '[]'),
    enabled: !!w.enabled, secret: w.secret ? '••••••••' : null,
    lastFiredAt:         w.lastFiredAt,
    lastStatus:          w.lastStatus,
    consecutiveFailures: w.consecutiveFailures || 0,
    lastFailedAt:        w.lastFailedAt || null,
    lastError:           w.lastError || null,
    createdAt:           w.createdAt,
  })));
}));

// POST /api/servers/:sid/outgoing-webhooks
router.post('/:sid/outgoing-webhooks', authMiddleware, limits.webhooks(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const { name, url, events = ['message:new'], secret } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  if (!url?.trim())  return res.status(400).json({ error: 'URL required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const invalidEvents = (events || []).filter(e => e !== '*' && !SUPPORTED_EVENTS.includes(e));
  if (invalidEvents.length) return res.status(400).json({ error: `Unsupported events: ${invalidEvents.join(', ')}` });

  const existing = await OutgoingWebhooks.findByServer(req.params.sid);
  if (existing.length >= 20) return res.status(429).json({ error: 'Max 20 outgoing webhooks per server' });

  const webhook = await OutgoingWebhooks.insert({
    _id: uuidv4(),
    serverId: req.params.sid,
    name: name.trim().slice(0, 80),
    url: url.trim(),
    events: JSON.stringify(events),
    secret: secret?.trim() || null,
    enabled: 1,
    createdBy: _u.id,
    createdAt: Date.now(),
  });

  res.status(201).json({
    _id: webhook._id, name: webhook.name, url: webhook.url,
    events: JSON.parse(webhook.events), enabled: true,
    secret: webhook.secret ? '••••••••' : null,
    createdAt: webhook.createdAt,
  });
}));

// PATCH /api/servers/:sid/outgoing-webhooks/:id
router.patch('/:sid/outgoing-webhooks/:id', authMiddleware, limits.webhooks(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const wh = await OutgoingWebhooks.findByIdAndServer(req.params.id, req.params.sid);
  if (!wh) return res.status(404).json({ error: 'Outgoing webhook not found' });

  const updates: Record<string,any> = {};
  if (req.body.name !== undefined) updates.name = req.body.name.trim().slice(0, 80);
  if (req.body.url  !== undefined) {
    try { new URL(req.body.url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    updates.url = req.body.url.trim();
  }
  if (req.body.events !== undefined) updates.events = JSON.stringify(req.body.events);
  if (req.body.secret !== undefined) updates.secret = req.body.secret?.trim() || null;
  if (req.body.enabled !== undefined) updates.enabled = req.body.enabled ? 1 : 0;

  await OutgoingWebhooks.update(req.params.id, updates);
  const updated = await OutgoingWebhooks.findById(req.params.id);
  res.json({ ...updated, events: JSON.parse(updated.events || '[]'), enabled: !!updated.enabled });
}));

// DELETE /api/servers/:sid/outgoing-webhooks/:id
router.delete('/:sid/outgoing-webhooks/:id', authMiddleware, limits.webhooks(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const wh = await OutgoingWebhooks.findByIdAndServer(req.params.id, req.params.sid);
  if (!wh) return res.status(404).json({ error: 'Not found' });

  await OutgoingWebhooks.delete(req.params.id);
  res.json({ deleted: true });
}));

// POST /api/servers/:sid/outgoing-webhooks/:id/test
router.post('/:sid/outgoing-webhooks/:id/test', authMiddleware, limits.webhooks(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const wh = await OutgoingWebhooks.findByIdAndServer(req.params.id, req.params.sid);
  if (!wh) return res.status(404).json({ error: 'Not found' });

  const result = await fireOutgoingWebhook(wh, 'test', {
    message: 'Bu bir Bridge test payload\'ıdır.',
    serverId: req.params.sid,
  });

  res.json(result);
}));

// GET /api/outgoing-webhooks/events — desteklenen event listesi
router.get('/outgoing-webhooks/events', authMiddleware, (req, res) => {
  res.json({ events: SUPPORTED_EVENTS });
});

module.exports = { router, dispatchEvent };
export {};
