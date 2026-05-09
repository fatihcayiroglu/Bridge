// server/routes/search.js
// URL param filtreleri (from, has, before, after, in),
//      mesaj sonuçlarında channelName + attachments,
//      üye member/search endpoint,
//      offset/limit sayfalama

'use strict';

const express            = require('express');
const router             = express.Router();
const { Members, Channels, Users, Messages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { limits }         = require('../middleware/rateLimit');
const asyncHandler       = require('../middleware/asyncHandler');

// ── Modifier parser (query string içi from:ali has:file) ─────
function parseSearchQuery(raw) {
  const modifiers: Record<string,string> = {};
  const terms: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const m = token.match(/^(from|before|after|has|in):(.+)$/i);
    if (m) modifiers[m[1].toLowerCase()] = m[2];
    else   terms.push(token);
  }
  return { q: terms.join(' '), modifiers };
}

// GET /api/search?q=...&serverId=...&type=...&offset=0
//                &from=userId&has=file|image|link&after=YYYY-MM-DD&before=YYYY-MM-DD
router.get('/', authMiddleware, limits.search(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId, type } = req.query;
  const rawQ  = String(req.query.q ?? '').trim();
  const PAGE  = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? ''))  || 25));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? '')) || 0);

  if (!rawQ || rawQ.length < 1)
    return res.json({ messages: [], channels: [], members: [], hasMore: false });

  // Üye olduğu sunucuları bul
  const memberships = await Members.findByUser(_u.id);
  let serverIds = memberships.map(m => m.serverId);
  if (serverId) serverIds = serverIds.filter(id => id === serverId);
  if (!serverIds.length)
    return res.json({ messages: [], channels: [], members: [], hasMore: false });

  // Query string modifier'larını parse et; URL param'ları öncelikli
  const { q, modifiers } = parseSearchQuery(rawQ);

  // URL param'ları modifier'ları override eder
  if (req.query.from)   modifiers.from   = String(req.query.from ?? '');
  if (req.query.has)    modifiers.has    = String(req.query.has ?? '');
  if (req.query.before) modifiers.before = String(req.query.before ?? '');
  if (req.query.after)  modifiers.after  = String(req.query.after ?? '');
  if (req.query.in)     modifiers.in     = String(req.query.in ?? '');

  const searchTerm = q || rawQ;
  const results: Record<string,any> = {};

  // ── Mesaj araması ──────────────────────────────────────────
  if (!type || type === 'all' || type === 'messages') {
    let messages: any[] = [];

    if (searchTerm && Messages.hasFtsSearch()) {
      messages = await Messages.ftsSearch(searchTerm, serverIds, 500);
    } else if (searchTerm) {
      return res.status(503).json({ error: 'Search backend is not available.' });
    }

    // from: filtresi — URL param userId veya query string kullanıcı adı
    if (modifiers.from) {
      const f = modifiers.from;
      // UUID benzeri → userId ile eşleştir; değilse displayName/username
      const isId = /^[a-zA-Z0-9_-]{10,}$/.test(f);
      if (isId) {
        messages = messages.filter(m => m.userId === f);
      } else {
        const fl = f.toLowerCase();
        messages = messages.filter(m =>
          (m.username || '').toLowerCase().includes(fl) ||
          (m.displayName || '').toLowerCase().includes(fl)
        );
      }
    }

    // Tarih filtreleri
    if (modifiers.before) {
      const ts = new Date(modifiers.before).getTime();
      if (!isNaN(ts)) messages = messages.filter(m => m.createdAt < ts);
    }
    if (modifiers.after) {
      const ts = new Date(modifiers.after).getTime();
      if (!isNaN(ts)) messages = messages.filter(m => m.createdAt > ts);
    }

    // has: filtreleri
    if (modifiers.has === 'file') {
      messages = messages.filter(m =>
        m.type === 'file' || (m.attachments && JSON.parse(m.attachments || '[]').length > 0)
      );
    }
    if (modifiers.has === 'image') {
      messages = messages.filter(m => {
        const atts = safeJSON(m.attachments, []);
        return m.fileType?.startsWith('image/') ||
               atts.some(a => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(a.name || a.url || ''));
      });
    }
    if (modifiers.has === 'link') {
      messages = messages.filter(m => /https?:\/\//i.test(m.content || ''));
    }

    // in: filtresi
    if (modifiers.in) {
      const chanName = modifiers.in.toLowerCase().replace(/^#/, '');
      const allChans = await Channels.findWhere({ serverId: { $in: serverIds } });
      const chan      = allChans.find(c => (c.name || '').toLowerCase() === chanName);
      if (chan) messages = messages.filter(m => m.channelId === chan._id);
    }

    // channelName bilgisini ekle (UI'da #kanal göstermek için)
    const chanIds     = [...new Set(messages.map(m => m.channelId).filter(Boolean))];
    const chanObjects = chanIds.length ? await Channels.findWhere({ _id: { $in: chanIds } }) : [];
    const chanMap     = Object.fromEntries(chanObjects.map(c => [c._id, c.name]));

    const enriched = messages.map(m => ({
      ...m,
      channelName:  chanMap[m.channelId] || null,
      attachments:  safeJSON(m.attachments, []),
      // highlight: arama terimini <mark> ile sarmalayan snippet
      highlight:    highlightSnippet(m.content || '', searchTerm),
      // _score: FTS sıralama skoru (UI'da relevance göstergesi için)
      score:        m._score ?? null,
    }));

    results.messagesHasMore = offset + PAGE < enriched.length;
    results.messages        = enriched.slice(offset, offset + PAGE);
  }

  // ── Kanal araması ──────────────────────────────────────────
  if (!type || type === 'all' || type === 'channels') {
    const allChans = await Channels.findWhere({ serverId: { $in: serverIds } });
    // Kanal araması: tam eşleşme önce, sonra içeren, son olarak başlayan
    const term = searchTerm.toLowerCase();
    results.channels = allChans
      .filter(c => (c.name || '').toLowerCase().includes(term))
      .sort((a, b) => {
        const an = (a.name || '').toLowerCase();
        const bn = (b.name || '').toLowerCase();
        const aStarts = an.startsWith(term) ? 0 : 1;
        const bStarts = bn.startsWith(term) ? 0 : 1;
        return aStarts - bStarts;
      })
      .slice(0, 10);
  }

  // ── Üye araması ────────────────────────────────────────────
  if (!type || type === 'all' || type === 'users') {
    const allMembers = await Members.findWhere({ serverId: { $in: serverIds } });
    const userIds    = [...new Set(allMembers.map(m => m.userId))];
    const term       = searchTerm;
    const users = await Users.findWhere({
      _id: { $in: userIds },
      $or: [
        { displayName: { $regex: term, $options: 'i' } },
        { username:    { $regex: term, $options: 'i' } },
      ],
    });
    const { sanitizeUser } = require('../lib/userUtils');
    results.members = users.slice(0, 15).map(sanitizeUser);
  }

  res.json({
    messages:  results.messages  || [],
    channels:  results.channels  || [],
    members:   results.members   || [],
    hasMore:   results.messagesHasMore || false,
  });
}));

// GET /api/servers/:serverId/members/search?q=...  (from: picker için)
router.get('/servers/:serverId/members/search', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (!q) return res.json([]);

  // Üye mi kontrol et
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Yetkisiz' });

  const allMembers = await Members.findByServer(serverId);
  const userIds    = allMembers.map(m => m.userId);
  const users      = await Users.findByIds(userIds);

  const { sanitizeUser } = require('../lib/userUtils');
  const filtered = users
    .filter(u =>
      (u.displayName || '').toLowerCase().includes(q) ||
      (u.username    || '').toLowerCase().includes(q)
    )
    .slice(0, 8)
    .map(sanitizeUser);

  res.json(filtered);
}));

// ── Highlight helper ─────────────────────────────────────────
// Arama terimini içeren 120 karakterlik snippet üretir.
// Eşleşen kısmı <mark> ile sarmalar (HTML encode ile güvenli).
function highlightSnippet(text, query) {
  if (!text || !query) return text?.slice(0, 120) || '';
  const clean = text.replace(/[<>&"]/g, c =>
    ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' })[c]
  );
  const words = query.trim().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return clean.slice(0, 120);

  // İlk eşleşmenin konumunu bul
  let startIdx = 0;
  for (const w of words) {
    const idx = text.toLowerCase().indexOf(w.toLowerCase());
    if (idx !== -1) { startIdx = Math.max(0, idx - 40); break; }
  }

  let snippet = clean.slice(startIdx, startIdx + 200);
  if (startIdx > 0) snippet = '...' + snippet;
  if (startIdx + 200 < clean.length) snippet += '...';

  // Kelimeleri vurgula
  for (const w of words) {
    const re = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    snippet = snippet.replace(re, '<mark>$1</mark>');
  }
  return snippet;
}

function safeJSON(val, fallback) {
  if (Array.isArray(val)) return val;
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

module.exports = router;
export {};
