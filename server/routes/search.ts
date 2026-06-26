// server/routes/search.ts
// URL param filtreleri (from, has, before, after, in),
//      mesaj sonuçlarında channelName + attachments,
//      üye member/search endpoint,
//      offset/limit sayfalama
//
// Sprint 89 düzeltmeleri:
//   [1] parseSearchQuery — implicit `any` kaldırıldı, tam TypeScript tipi eklendi.
//   [2] highlightSnippet / safeJSON — tip imzaları eklendi.
//   [3] results nesnesi — `Record<string,any>` → açık arayüz ile değiştirildi.
//   [4] /servers/:serverId/members/search — serverId'nin caller'ın üye olduğu
//       sunucular arasında olup olmadığı doğrulanıyor (önceden yalnızca
//       Members.findOne ile kontrol ediliyordu; bu zaten yeterliydi ama
//       ana /search endpoint'indeki serverIds zinciriyle tutarlı hale getirildi).

import express, { Request, Response } from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();
import { Members, Channels, Users, Messages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { sanitizeUser } from '../lib/userUtils';

// ── Tipler ────────────────────────────────────────────────────────────────

interface SearchModifiers {
  from?:   string;
  before?: string;
  after?:  string;
  has?:    string;
  in?:     string;
}

interface ParsedQuery {
  q:         string;
  modifiers: SearchModifiers;
}

interface MessageRecord {
  userId?:      unknown;
  username?:    unknown;
  displayName?: unknown;
  createdAt?:   unknown;
  type?:        unknown;
  attachments?: unknown;
  fileType?:    unknown;
  content?:     unknown;
  channelId?:   unknown;
  _score?:      unknown;
  [key: string]: unknown;
}

interface SearchResults {
  messages?:         (MessageRecord & { channelName: string | null; highlight: string; score: unknown })[]; 
  messagesHasMore?:  boolean;
  channels?:         unknown[];
  members?:          unknown[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

// [1] Sprint 89: implicit `any` kaldırıldı — raw string, typed döner.
function parseSearchQuery(raw: string): ParsedQuery {
  const modifiers: SearchModifiers = {};
  const terms: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const m = token.match(/^(from|before|after|has|in):(.+)$/i);
    if (m) (modifiers as Record<string, string>)[m[1].toLowerCase()] = m[2];
    else   terms.push(token);
  }
  return { q: terms.join(' '), modifiers };
}

// [2] Sprint 89: tip imzası eklendi.
function highlightSnippet(text: string, query: string): string {
  if (!text || !query) return text?.slice(0, 120) || '';
  const clean = text.replace(/[<>&"]/g, (c: string) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' } as Record<string, string>)[c] ?? c
  );
  const words = query.trim().split(/\s+/).filter((w: string) => w.length > 1);
  if (!words.length) return clean.slice(0, 120);

  let startIdx = 0;
  for (const w of words) {
    const idx = text.toLowerCase().indexOf(w.toLowerCase());
    if (idx !== -1) { startIdx = Math.max(0, idx - 40); break; }
  }

  let snippet = clean.slice(startIdx, startIdx + 200);
  if (startIdx > 0) snippet = '...' + snippet;
  if (startIdx + 200 < clean.length) snippet += '...';

  for (const w of words) {
    const re = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    snippet = snippet.replace(re, '<mark>$1</mark>');
  }
  return snippet;
}

// [2] Sprint 89: tip imzası eklendi.
function safeJSON<T>(val: unknown, fallback: T): T {
  if (Array.isArray(val)) return val as unknown as T;
  if (!val) return fallback;
  try { return JSON.parse(val as string) as T; } catch { return fallback; }
}

// ── GET /api/search ───────────────────────────────────────────────────────
/**
 * @openapi
 * /search:
 *   get:
 *     tags: [Search]
 *     summary: Mesaj & kullanıcı ara
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: serverId
 *         schema: { type: string }
 *       - in: query
 *         name: channelId
 *         schema: { type: string }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [messages, users] }
 *     responses:
 *       200:
 *         description: Arama sonuçları
 */
router.get('/', authMiddleware, limits.search(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { serverId, type } = req.query;
  const rawQ   = String(req.query.q ?? '').trim();
  const PAGE   = Math.min(50, Math.max(1, parseInt(String(req.query.limit  ?? '')) || 25));
  const offset = Math.max(0,              parseInt(String(req.query.offset ?? '')) || 0);

  if (!rawQ || rawQ.length < 2)
    return res.json({ messages: [], channels: [], members: [], hasMore: false });

  // Caller'ın üye olduğu sunucuları al — temel erişim denetimi
  const memberships = await Members.findByUser(_u.id);
  let serverIds = memberships.map((m: { serverId: string }) => m.serverId);

  // [4] Sprint 89: serverId filtresi — caller'ın o sunucuya üye olup olmadığını
  // zinciri kırmadan doğrula. Filtre zaten serverIds'i caller'ın üyelikleriyle
  // kesiştiriyor; sahte serverId sonuç döndürmez.
  if (serverId) {
    const sid = String(serverId);
    serverIds = serverIds.filter((id: string) => id === sid);
    if (!serverIds.length)
      return res.status(403).json({ error: 'Bu sunucuya erişim yetkiniz yok.' });
  }

  if (!serverIds.length)
    return res.json({ messages: [], channels: [], members: [], hasMore: false });

  const { q, modifiers } = parseSearchQuery(rawQ);

  // URL param'ları modifier'ları override eder
  if (req.query.from as string)   modifiers.from   = String(req.query.from as string);
  if (req.query.has as string)    modifiers.has    = String(req.query.has as string);
  if (req.query.before as string) modifiers.before = String(req.query.before as string);
  if (req.query.after as string)  modifiers.after  = String(req.query.after as string);
  if (req.query.in as string)     modifiers.in     = String(req.query.in as string);

  const searchTerm = q || rawQ;
  // [3] Sprint 89: `any` yerine açık arayüz
  const results: SearchResults = {};

  // ── Mesaj araması ──────────────────────────────────────────────────────
  if (!type || type === 'all' || type === 'messages') {
    let messages: MessageRecord[] = [];

    if (searchTerm && Messages.hasFtsSearch()) {
      messages = await Messages.ftsSearch(searchTerm, serverIds, 500) as MessageRecord[];
    } else if (searchTerm) {
      return res.status(503).json({ error: 'Search backend is not available.' });
    }

    if (modifiers.from) {
      const f = modifiers.from;
      const isId = /^[a-zA-Z0-9_-]{10,}$/.test(f);
      if (isId) {
        messages = messages.filter((m) => m.userId === f);
      } else {
        const fl = f.toLowerCase();
        messages = messages.filter((m) =>
          String(m.username    ?? '').toLowerCase().includes(fl) ||
          String(m.displayName ?? '').toLowerCase().includes(fl)
        );
      }
    }

    if (modifiers.before) {
      const ts = new Date(modifiers.before).getTime();
      if (!isNaN(ts)) messages = messages.filter((m) => (m.createdAt as number) < ts);
    }
    if (modifiers.after) {
      const ts = new Date(modifiers.after).getTime();
      if (!isNaN(ts)) messages = messages.filter((m) => (m.createdAt as number) > ts);
    }

    if (modifiers.has === 'file') {
      messages = messages.filter((m) =>
        m.type === 'file' || safeJSON<unknown[]>(m.attachments, []).length > 0
      );
    }
    if (modifiers.has === 'image') {
      messages = messages.filter((m) => {
        const atts = safeJSON<{ name?: string; url?: string }[]>(m.attachments, []);
        return String(m.fileType ?? '').startsWith('image/') ||
               atts.some((a) => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(a.name ?? a.url ?? ''));
      });
    }
    if (modifiers.has === 'link') {
      messages = messages.filter((m) => /https?:\/\//i.test(String(m.content ?? '')));
    }

    if (modifiers.in) {
      const chanName = modifiers.in.toLowerCase().replace(/^#/, '');
      const allChans = await Channels.findWhere({ serverId: { $in: serverIds } });
      const chan = allChans.find((c: { name?: string }) => (c.name ?? '').toLowerCase() === chanName);
      if (chan) messages = messages.filter((m) => m.channelId === (chan as { _id: string })._id);
    }

    const chanIds     = [...new Set(messages.map((m) => m.channelId).filter(Boolean))];
    const chanObjects = chanIds.length
      ? await Channels.findWhere({ _id: { $in: chanIds } })
      : [];
    const chanMap = Object.fromEntries(
      (chanObjects as { _id: string; name: string }[]).map((c) => [c._id, c.name])
    );

    const enriched = messages.map((m) => ({
      ...m,
      channelName: chanMap[m.channelId as string] ?? null,
      attachments: safeJSON<unknown[]>(m.attachments, []),
      highlight:   highlightSnippet(String(m.content ?? ''), searchTerm),
      score:       m._score ?? null,
    }));

    results.messagesHasMore = offset + PAGE < enriched.length;
    results.messages        = enriched.slice(offset, offset + PAGE);
  }

  // ── Kanal araması ──────────────────────────────────────────────────────
  if (!type || type === 'all' || type === 'channels') {
    const allChans = await Channels.findWhere({ serverId: { $in: serverIds } });
    const term = searchTerm.toLowerCase();
    results.channels = (allChans as { name?: string }[])
      .filter((c) => (c.name ?? '').toLowerCase().includes(term))
      .sort((a, b) => {
        const an = (a.name ?? '').toLowerCase();
        const bn = (b.name ?? '').toLowerCase();
        return (an.startsWith(term) ? 0 : 1) - (bn.startsWith(term) ? 0 : 1);
      })
      .slice(0, 10);
  }

  // ── Üye araması ────────────────────────────────────────────────────────
  if (!type || type === 'all' || type === 'users') {
    const allMembers = await Members.findWhere({ serverId: { $in: serverIds } });
    const userIds    = [...new Set((allMembers as { userId: string }[]).map((m) => m.userId))];
    const users      = await Users.findWhere({
      _id: { $in: userIds },
      $or: [
        { displayName: { $regex: searchTerm, $options: 'i' } },
        { username:    { $regex: searchTerm, $options: 'i' } },
      ],
    });
    results.members = (users as object[]).slice(0, 15).map(u => sanitizeUser(u));
  }

  res.json({
    messages:  results.messages  ?? [],
    channels:  results.channels  ?? [],
    members:   results.members   ?? [],
    hasMore:   results.messagesHasMore ?? false,
  });
});

// ── GET /api/search/servers/:serverId/members/search ─────────────────────
/**
 * @openapi
 * /search/servers/{serverId}/members/search:
 *   get:
 *     tags: [Search]
 *     summary: Sunucu üyelerinde ara
 */
router.get('/servers/:serverId/members/search', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (!q) return res.json([]);

  // Üyelik doğrulama
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Yetkisiz' });

  const allMembers = await Members.findByServer(serverId);
  const userIds    = (allMembers as { userId: string }[]).map((m) => m.userId);
  const users      = await Users.findByIds(userIds);

  const filtered = (users as { displayName?: string; username?: string }[])
    .filter((u) =>
      (u.displayName ?? '').toLowerCase().includes(q) ||
      (u.username    ?? '').toLowerCase().includes(q)
    )
    .slice(0, 8)
    .map(sanitizeUser);

  res.json(filtered);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
