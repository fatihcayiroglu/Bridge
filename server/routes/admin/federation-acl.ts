// @ts-nocheck
// server/routes/admin/federation-acl.js
// Federation whitelist / blacklist yönetimi + checkFederationACL helper
// checkFederationACL → federation inbox tarafından import edilir

'use strict';

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Federation } = require('../../db/repositories');
const { authMiddleware, castAuthed } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { adminOnly, logAction } = require('./core');

function validateDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const d = domain.trim();
  return /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) && d.length <= 253;
}

// ── Whitelist ──────────────────────────────────────────────────
router.get('/federation/whitelist', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const entries = await Federation.findWhitelist();
  res.json({ whitelist: entries });
}));

router.post('/federation/whitelist', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { domain, reason = '' } = req.body;
  if (!validateDomain(domain)) return res.status(400).json({ error: 'Geçersiz domain formatı' });
  const d = domain.trim().toLowerCase();

  const exists = await Federation.findWhitelistOne({ domain: d });
  if (exists) return res.status(409).json({ error: "Bu domain zaten whitelist'te" });

  const entry = { _id: uuidv4(), domain: d, reason: (reason||'').slice(0,200), addedAt: Date.now(), addedBy: _u.id };
  await Federation.insertWhitelist(entry);
  await logAction(_u.id, 'federation_whitelist_add', d, { reason: entry.reason });
  res.json({ ok: true, entry });
}));

router.delete('/federation/whitelist/:domain', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const domain = decodeURIComponent(req.params.domain).trim().toLowerCase();
  if (!validateDomain(domain)) return res.status(400).json({ error: 'Geçersiz domain' });
  await Federation.removeWhitelistByDomain(domain);
  await logAction(_u.id, 'federation_whitelist_remove', domain);
  res.json({ ok: true });
}));

// ── Blacklist ──────────────────────────────────────────────────
router.get('/federation/blacklist', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const entries = await Federation.findBlacklist();
  res.json({ blacklist: entries });
}));

router.post('/federation/blacklist', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { domain, reason = '' } = req.body;
  if (!validateDomain(domain)) return res.status(400).json({ error: 'Geçersiz domain formatı' });
  const d = domain.trim().toLowerCase();

  const exists = await Federation.findBlacklistOne({ domain: d });
  if (exists) return res.status(409).json({ error: "Bu domain zaten blacklist'te" });

  const entry = { _id: uuidv4(), domain: d, reason: (reason||'').slice(0,200), addedAt: Date.now(), addedBy: _u.id };
  await Federation.insertBlacklist(entry);
  await logAction(_u.id, 'federation_blacklist_add', d, { reason: entry.reason });
  res.json({ ok: true, entry });
}));

router.delete('/federation/blacklist/:domain', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const domain = decodeURIComponent(req.params.domain).trim().toLowerCase();
  if (!validateDomain(domain)) return res.status(400).json({ error: 'Geçersiz domain' });
  await Federation.removeBlacklistByDomain(domain);
  await logAction(_u.id, 'federation_blacklist_remove', domain);
  res.json({ ok: true });
}));

// ── checkFederationACL — federation/activitypub.js'e export edilir ──
async function checkFederationACL(domain) {
  if (!domain) return { allowed: true };
  const d = domain.toLowerCase();

  const blacklist = await Federation.findBlacklist();
  for (const entry of blacklist) {
    if (entry.domain.startsWith('*.')) {
      const suffix = entry.domain.slice(1);
      if (d.endsWith(suffix) || d === suffix.slice(1)) return { allowed: false, reason: 'blacklisted', entry };
    } else if (entry.domain === d) {
      return { allowed: false, reason: 'blacklisted', entry };
    }
  }

  const whitelist = await Federation.findWhitelist();
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

module.exports = { router, checkFederationACL };
