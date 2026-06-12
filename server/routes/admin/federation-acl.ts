// server/routes/admin/federation-acl.ts
// Federation whitelist / blacklist yönetimi + checkFederationACL helper
/**
 * @openapi
 * /admin/federation/whitelist:
 *   get:
 *     tags: [Admin]
 *     summary: Federation whitelist'i getir
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Whitelist
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 whitelist: { type: array, items: { $ref: '#/components/schemas/AclEntry' } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Admin]
 *     summary: Whitelist'e domain ekle
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [domain]
 *             properties:
 *               domain: { type: string, example: mastodon.social }
 *               reason: { type: string, maxLength: 200 }
 *     responses:
 *       200: { description: 'Eklendi' }
 *       400: { description: 'Geçersiz domain' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: 'Domain zaten mevcut' }
 *
 * /admin/federation/whitelist/{domain}:
 *   delete:
 *     tags: [Admin]
 *     summary: Whitelist'ten domain çıkar
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: domain
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Çıkarıldı' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/federation/blacklist:
 *   get:
 *     tags: [Admin]
 *     summary: Federation blacklist'i getir
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Blacklist
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 blacklist: { type: array, items: { $ref: '#/components/schemas/AclEntry' } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Admin]
 *     summary: Blacklist'e domain ekle
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [domain]
 *             properties:
 *               domain: { type: string }
 *               reason: { type: string, maxLength: 200 }
 *     responses:
 *       200: { description: 'Eklendi' }
 *       400: { description: 'Geçersiz domain' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: 'Domain zaten mevcut' }
 *
 * /admin/federation/blacklist/{domain}:
 *   delete:
 *     tags: [Admin]
 *     summary: Blacklist'ten domain çıkar
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: domain
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Çıkarıldı' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * components:
 *   schemas:
 *     AclEntry:
 *       type: object
 *       properties:
 *         _id:     { type: string }
 *         domain:  { type: string }
 *         reason:  { type: string }
 *         addedAt: { type: integer }
 *         addedBy: { type: string }

 */

import express, { Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../../middleware/auth';

import { Federation } from '../../db/repositories';
import { adminOnly, logAction } from './middleware';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
interface AclEntry {
  _id: string;
  domain: string;
  reason: string;
  addedAt: number;
  addedBy: string;
}

function toAclEntry(row: unknown): AclEntry | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.domain !== 'string') return null;
  return {
    _id: typeof r._id === 'string' ? r._id : '',
    domain: r.domain,
    reason: typeof r.reason === 'string' ? r.reason : '',
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
    addedBy: typeof r.addedBy === 'string' ? r.addedBy : 'system',
  };
}

function validateDomain(domain: unknown): domain is string {
  if (!domain || typeof domain !== 'string') return false;
  const d = domain.trim();
  return /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) && d.length <= 253;
}

const router: Router = express.Router();

// ── Whitelist ──────────────────────────────────────────────────
router.get('/federation/whitelist', authMiddleware, adminOnly, async (_req: Request, res: Response) => {
  res.json({ whitelist: await Federation.findWhitelist() });
});

router.post('/federation/whitelist', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { domain, reason = '' } = req.body as { domain?: string; reason?: string };
  if (!validateDomain(domain)) return void res.status(400).json({ error: 'Geçersiz domain formatı' });
  const d = domain.trim().toLowerCase();
  if (await Federation.findWhitelistOne({ domain: d }))
    return void res.status(409).json({ error: "Bu domain zaten whitelist'te" });
  const entry: AclEntry = { _id: uuidv4(), domain: d, reason: (reason || '').slice(0, 200), addedAt: Date.now(), addedBy: _u.id };
  await Federation.insertWhitelist({ ...entry });
  await logAction(_u.id, 'federation_whitelist_add', d, { reason: entry.reason });
  res.json({ ok: true, entry });
});

router.delete('/federation/whitelist/:domain', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const domain = decodeURIComponent(String(req.params.domain ?? '')).trim().toLowerCase();
  if (!validateDomain(domain)) return void res.status(400).json({ error: 'Geçersiz domain' });
  await Federation.removeWhitelistByDomain(domain);
  await logAction(_u.id, 'federation_whitelist_remove', domain);
  res.json({ ok: true });
});

// ── Blacklist ──────────────────────────────────────────────────
router.get('/federation/blacklist', authMiddleware, adminOnly, async (_req: Request, res: Response) => {
  res.json({ blacklist: await Federation.findBlacklist() });
});

router.post('/federation/blacklist', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { domain, reason = '' } = req.body as { domain?: string; reason?: string };
  if (!validateDomain(domain)) return void res.status(400).json({ error: 'Geçersiz domain formatı' });
  const d = domain.trim().toLowerCase();
  if (await Federation.findBlacklistOne({ domain: d }))
    return void res.status(409).json({ error: "Bu domain zaten blacklist'te" });
  const entry: AclEntry = { _id: uuidv4(), domain: d, reason: (reason || '').slice(0, 200), addedAt: Date.now(), addedBy: _u.id };
  await Federation.insertBlacklist({ ...entry });
  await logAction(_u.id, 'federation_blacklist_add', d, { reason: entry.reason });
  res.json({ ok: true, entry });
});

router.delete('/federation/blacklist/:domain', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const domain = decodeURIComponent(String(req.params.domain ?? '')).trim().toLowerCase();
  if (!validateDomain(domain)) return void res.status(400).json({ error: 'Geçersiz domain' });
  await Federation.removeBlacklistByDomain(domain);
  await logAction(_u.id, 'federation_blacklist_remove', domain);
  res.json({ ok: true });
});

// ── checkFederationACL — federation route'larına export edilir ──
export async function checkFederationACL(domain: string | undefined): Promise<{ allowed: boolean; reason?: string; entry?: AclEntry }> {
  if (!domain) return { allowed: true };
  const d = domain.toLowerCase();
  const blacklist = (await Federation.findBlacklist()).map(toAclEntry).filter((entry): entry is AclEntry => entry !== null);
  for (const entry of blacklist) {
    if (entry.domain.startsWith('*.')) {
      const suffix = entry.domain.slice(1);
      if (d.endsWith(suffix) || d === suffix.slice(1)) return { allowed: false, reason: 'blacklisted', entry };
    } else if (entry.domain === d) {
      return { allowed: false, reason: 'blacklisted', entry };
    }
  }
  const whitelist = (await Federation.findWhitelist()).map(toAclEntry).filter((entry): entry is AclEntry => entry !== null);
  if (!whitelist.length) return { allowed: true };
  for (const entry of whitelist) {
    if (entry.domain.startsWith('*.')) {
      const suffix = entry.domain.slice(1);
      if (d.endsWith(suffix) || d === suffix.slice(1)) return { allowed: true };
    } else if (entry.domain === d) {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: 'not_whitelisted' };
}
export { router };
