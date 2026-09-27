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
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { getCachedPerms } from '../lib/permCache';
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery } from '../lib/queryNumbers';

/**
 * GÜVENLİK — KANAL GÖRÜNÜRLÜĞÜ (VIEW_CHANNELS).
 *
 * ── KAPATILAN GERÇEK AÇIK ────────────────────────────────────────────────
 * Arama YALNIZCA sunucu ÜYELİĞİNE göre kapsanıyordu:
 *     Messages.ftsSearch(term, serverIds, 500)
 *     Channels.findWhere({ serverId: { $in: serverIds } })
 * Oysa ürünün kanonik sözleşmesi kanal başına görünürlüktür: normal mesaj
 * geçmişi `routes/messages.ts:152` içinde
 *     resolvePermissions(user, serverId, channelId) + VIEW_CHANNELS
 * ile korunur ve C2'de kanal başına allow/deny override'ları eklenmiştir.
 *
 * Sonuç: VIEW_CHANNELS'i REDDEDİLMİŞ bir sunucu üyesi, arama üzerinden
 *   · göremediği kanalların MESAJ İÇERİĞİNİ (üstelik vurgulanmış parçacıkla),
 *   · özel kanalların ADLARINI
 * elde edebiliyordu. Sunucu üyeliği kanal erişimi KANITLAMAZ — C2 dersinin
 * aynısı.
 *
 * Kanal başına tek kez çözümlenir (aynı kanal tekrar sorgulanmaz).
 */
async function viewableChannelIds(
  userId: string,
  pairs: ReadonlyArray<{ channelId?: unknown; serverId?: unknown }>,
): Promise<Set<string>> {
  const viewable = new Set<string>();
  const checked  = new Set<string>();

  for (const pair of pairs) {
    const channelId = String(pair.channelId ?? '');
    const serverId  = String(pair.serverId ?? '');
    if (!channelId || !serverId || checked.has(channelId)) continue;
    checked.add(channelId);

    // Hata durumunda fail-closed: kanal görünmez sayılır.
    const perms = await getCachedPerms(userId, serverId, resolvePermissions, channelId).catch(() => 0);
    if (hasPermission(perms, PERMS.VIEW_CHANNELS)) viewable.add(channelId);
  }
  return viewable;
}

/** `/unified` için kabul edilen kaynaklar — istemci girdisi allowlist'tir. */
const ALLOWED_SOURCES = ['channel', 'dm', 'thread', 'gdm'];
const MAX_SEARCH_TEXT_LENGTH = 200;
const MAX_SEARCH_ID_LENGTH = 128;

function scalarQueryText(value: unknown, maxLength: number): string | null {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength) return null;
  return value.trim();
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Tipler ────────────────────────────────────────────────────────────────

interface SearchModifiers {
  from?:      string;
  before?:    string;
  after?:     string;
  has?:       string;
  in?:        string;
  /** Urun ici tam kanal kapsami; kullanici sohbet sozdizimine acilmaz. */
  channelId?: string;
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
    const key = m?.[1];
    const value = m?.[2];
    if (key !== undefined && value !== undefined) {
      (modifiers as Record<string, string>)[key.toLowerCase()] = value;
    } else {
      terms.push(token);
    }
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
  const rawQ = scalarQueryText(req.query.q, MAX_SEARCH_TEXT_LENGTH);
  if (rawQ === null) return res.status(400).json({ error: 'Geçersiz arama metni' });
  const PAGE = parseBoundedPositiveIntQuery(req.query.limit, 25, 50);
  const offset = parseNonNegativeSafeIntQuery(req.query.offset, 0);
  if (PAGE === null || offset === null) return res.status(400).json({ error: 'Geçersiz sayfalama değeri' });

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

  // `channelId` is a structural product scope, not user search syntax. Keep it
  // separate from the ambiguous display-name `in:` modifier and validate it
  // with the same bounded scalar contract used by the unified endpoint.
  const exactChannelId = scalarQueryText(req.query.channelId, MAX_SEARCH_ID_LENGTH);
  if (exactChannelId === null) return res.status(400).json({ error: 'Geçersiz kanal kapsamı' });
  if (exactChannelId) modifiers.channelId = exactChannelId;

  const searchTerm = q || rawQ;
  // [3] Sprint 89: `any` yerine açık arayüz
  const results: SearchResults = {};

  // AUTHORIZATION MUST PRECEDE RANKING/LIMIT. If private rows enter the FTS
  // top-500 window and are filtered afterwards, they can displace visible
  // results and influence timing/rank behavior. Resolve the current channel
  // allowlist once and push it into PostgreSQL; post-filter remains defense in depth.
  const scopedChannels = await Channels.findWhere({ serverId: { $in: serverIds } }) as Array<{ _id?: unknown; serverId?: unknown }>;
  const visibleChannelSet = await viewableChannelIds(
    _u.id,
    scopedChannels.map(c => ({ channelId: c._id, serverId: c.serverId })),
  );
  const visibleChannelIds = [...visibleChannelSet];

  // Exact channel scope is fail-closed and existence-hiding. An unknown,
  // deleted or unauthorized id is indistinguishable from an empty channel;
  // critically, no FTS call sees the inaccessible id.
  if (exactChannelId && !visibleChannelSet.has(exactChannelId)) {
    return res.json({ messages: [], channels: [], members: [], hasMore: false });
  }

  // ── Mesaj araması ──────────────────────────────────────────────────────
  if (!type || type === 'all' || type === 'messages') {
    let messages: MessageRecord[] = [];

    if (searchTerm && Messages.hasFtsSearch()) {
      // Push structural channel scope into FTS so unrelated visible channels
      // cannot affect ranking/limit behavior.
      const ftsChannelIds = exactChannelId ? [exactChannelId] : visibleChannelIds;
      messages = await Messages.ftsSearch(searchTerm, serverIds, 500, ftsChannelIds) as MessageRecord[];
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

    if (modifiers.channelId) {
      messages = messages.filter((m) => String(m.channelId ?? '') === modifiers.channelId);
    } else if (modifiers.in) {
      // Display names are not unique. `in:#general` narrows to ALL visible
      // exact-name matches rather than silently choosing the first server's
      // channel. A nonexistent name narrows to zero (never broadens search).
      const chanName = modifiers.in.toLowerCase().replace(/^#/, '');
      const allChans = scopedChannels as Array<{ _id: string; name?: string; serverId?: string }>;
      const matchingIds = new Set(
        allChans
          .filter(c => visibleChannelSet.has(String(c._id ?? '')))
          .filter(c => (c.name ?? '').toLowerCase() === chanName)
          .map(c => String(c._id)),
      );
      messages = messages.filter((m) => matchingIds.has(String(m.channelId ?? '')));
    }

    // GÜVENLİK: sayfalama ve zenginleştirmeden ÖNCE görünmeyen kanalların
    // mesajları elenir. Sonra elenirse `hasMore`/offset sayıları da görünmeyen
    // içeriği ele verirdi.
    messages = messages.filter((m) => visibleChannelSet.has(String(m.channelId ?? '')));

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
    const allChans = scopedChannels;
    // GÜVENLİK: kanal ADLARI da sızdırılmaz — ayni pre-rank allowlist kullanilir.
    const chanVisible = visibleChannelSet;
    const term = searchTerm.toLowerCase();
    results.channels = (allChans as { _id?: unknown; name?: string }[])
      .filter((c) => chanVisible.has(String(c._id ?? '')))
      .filter((c) => !exactChannelId || String(c._id ?? '') === exactChannelId)
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
    const literalSearchTerm = escapeRegexLiteral(searchTerm);
    const users      = await Users.findWhere({
      _id: { $in: userIds },
      $or: [
        { displayName: { $regex: literalSearchTerm, $options: 'i' } },
        { username:    { $regex: literalSearchTerm, $options: 'i' } },
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


/**
 * Birleşik arama sonuçlarına `from:` / `in:` / `has:` filtrelerini uygular.
 *
 * TASARIM: filtreler yalnızca DARALTIR. Yetki elemesi (VIEW_CHANNELS ve
 * SQL'deki DM/grup üyeliği) çağrıdan ÖNCE yapılmıştır; buradaki hiçbir dal
 * sonuç kümesine satır EKLEYEMEZ.
 */
function applySearchFilters(
  rows: (MessageRecord & { _source?: unknown })[],
  modifiers: SearchModifiers,
  chanMap: Record<string, string>,
): (MessageRecord & { _source?: unknown })[] {
  let out = rows;

  if (modifiers.from) {
    const needle = modifiers.from.toLowerCase().replace(/^@/, '');
    out = out.filter(r =>
      String(r.userId ?? '') === modifiers.from ||
      String(r.username ?? '').toLowerCase().includes(needle) ||
      String(r.displayName ?? '').toLowerCase().includes(needle));
  }

  if (modifiers.channelId) {
    // Kanal-basligi aramasi benzersiz OLMAYAN ada degil tam kimlige kapsanir.
    // DM/GDM satirlarinin channelId'si olmadigi icin onlar da dogal olarak
    // bu yapisal kapsamdan disarida kalir.
    out = out.filter(r => String(r.channelId ?? '') === modifiers.channelId);
  } else if (modifiers.in) {
    const needle = modifiers.in.toLowerCase().replace(/^#/, '');
    out = out.filter(r => {
      const name = chanMap[String(r.channelId ?? '')] ?? '';
      return name.toLowerCase() === needle;
    });
  }

  if (modifiers.has) {
    const kind = modifiers.has.toLowerCase();
    out = out.filter(r => {
      if (kind === 'link')  return /https?:\/\//i.test(String(r.content ?? ''));
      if (kind === 'image') return String(r.fileType ?? '').startsWith('image/');
      if (kind === 'file')  return Boolean(r.fileUrl) || r.type === 'file';
      return true;   // tanınmayan tür sonucu DARALTMAZ
    });
  }

  if (modifiers.before) {
    const ts = new Date(modifiers.before).getTime();
    if (!Number.isNaN(ts)) out = out.filter(r => Number(r.createdAt ?? 0) < ts);
  }
  if (modifiers.after) {
    const ts = new Date(modifiers.after).getTime();
    if (!Number.isNaN(ts)) out = out.filter(r => Number(r.createdAt ?? 0) > ts);
  }

  return out;
}

// ── GET /api/search/unified ──────────────────────────────────────────────
/**
 * BİRLEŞİK ARAMA — kanal, DM, grup DM ve thread yanıtları tek yerden.
 *
 * NEDEN AYRI BİR UÇ NOKTA
 * `/api/search` sözleşme gereği KANAL mesajı döndürür: her satırda
 * `channelName` bulunur, `viewableChannelIds` ile kanal bazında filtrelenir
 * ve istemci bu şekle bağlıdır. DM satırlarının kanalı yoktur; onları aynı
 * diziye koymak mevcut istemciyi sessizce bozardı. Bu uç nokta yeni şekli
 * ayrı sunar, eskisi bit bit aynı kalır.
 *
 * YETKİLENDİRME İKİ KATMANLIDIR:
 *   • DM / grup DM  — üyelik SQL içinde zorunlu (db/postgres/fts.ts).
 *   • kanal / thread — SQL yalnızca sunucu üyeliğiyle kapsar; kanal bazlı
 *     VIEW_CHANNELS burada, `/api/search` ile AYNI yardımcıyla uygulanır.
 *     Sunucu üyeliği kanal erişimi kanıtlamaz (C2 dersi).
 */
router.get('/unified', authMiddleware, limits.search(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const rawQ = scalarQueryText(req.query.q, MAX_SEARCH_TEXT_LENGTH);
  if (rawQ === null) return res.status(400).json({ error: 'Geçersiz arama metni' });
  const PAGE = parseBoundedPositiveIntQuery(req.query.limit, 25, 50);
  const offset = parseNonNegativeSafeIntQuery(req.query.offset, 0);
  if (PAGE === null || offset === null || offset > 199) return res.status(400).json({ error: 'Geçersiz sayfalama değeri' });

  if (!rawQ || rawQ.length < 2) return res.json({ results: [], hasMore: false });

  if (!Messages.hasUnifiedSearch())
    return res.status(503).json({ error: 'Search backend is not available.' });

  // Kaynak filtresi isteğe bağlı: ?sources=dm,channel
  const requested = String(req.query.sources ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const sources = requested.filter(s => ALLOWED_SOURCES.includes(s));
  if (requested.length && !sources.length)
    return res.status(400).json({ error: 'Geçersiz kaynak.' });

  const memberships = await Members.findByUser(_u.id);
  const serverIds   = memberships.map((m: { serverId: string }) => m.serverId);

  const { q, modifiers } = parseSearchQuery(rawQ);
  // URL parametreleri de kabul edilir (istemci sohbet sözdizimi yerine
  // gerçek kontroller sunabilsin diye).
  if (req.query.from)   modifiers.from   = String(req.query.from);
  if (req.query.has)    modifiers.has    = String(req.query.has);
  if (req.query.in)     modifiers.in     = String(req.query.in);
  if (req.query.before) modifiers.before = String(req.query.before);
  if (req.query.after)  modifiers.after  = String(req.query.after);

  const exactChannelId = scalarQueryText(req.query.channelId, MAX_SEARCH_ID_LENGTH);
  if (exactChannelId === null) return res.status(400).json({ error: 'Geçersiz kanal kapsamı' });
  if (exactChannelId) modifiers.channelId = exactChannelId;

  const searchTerm = q || rawQ;

  const scopedChannels = await Channels.findWhere({ serverId: { $in: serverIds } }) as Array<{ _id?: unknown; serverId?: unknown }>;
  const visibleChannelSet = await viewableChannelIds(
    _u.id,
    scopedChannels.map(c => ({ channelId: c._id, serverId: c.serverId })),
  );
  const visibleChannelIds = [...visibleChannelSet];

  // Tam kanal kapsami, kullanicinin GOREBILDIGI kanal kimliklerinden biri
  // degilse varlik bilgisi sizdirmadan BOS sonuc doner. Repository'ye bile
  // gitmek gerekmez.
  if (exactChannelId && !visibleChannelSet.has(exactChannelId)) {
    return res.json({ results: [], hasMore: false });
  }

  // Kanal görünürlüğü sayfalamadan ÖNCE elenmeli; sonra elenirse `hasMore`
  // görünmeyen içeriğin varlığını ele verirdi (aynı gerekçe `/api/search`te).
  const rows = await Messages.unifiedSearch(
    searchTerm,
    {
      userId: _u.id,
      serverIds,
      channelIds: exactChannelId ? [exactChannelId] : visibleChannelIds,
      ...(sources.length ? { sources } : {}),
    },
    200,
  ) as (MessageRecord & { _source?: unknown; serverId?: unknown })[];

  const serverScoped = rows.filter(r => r._source === 'channel' || r._source === 'thread');

  const permitted = rows.filter(r =>
    (r._source === 'channel' || r._source === 'thread')
      ? visibleChannelSet.has(String(r.channelId ?? ''))
      : true,   // DM / grup DM: SQL'de zaten yetkilendirildi
  );

  const chanIds = [...new Set(serverScoped.map(r => r.channelId).filter(Boolean))];
  const chanMap = chanIds.length
    ? Object.fromEntries(
        (await Channels.findWhere({ _id: { $in: chanIds } }) as { _id: string; name: string }[])
          .map(c => [c._id, c.name]),
      )
    : {};

  // ── FİLTRELER ────────────────────────────────────────────────────────────
  //
  // Filtreler YALNIZCA DARALTIR. Görünürlük elemesinden (`permitted`) SONRA
  // uygulanırlar; önce uygulanmaları hiçbir şeyi hızlandırmaz ama bir
  // filtrenin yetki elemesini atlatma ihtimalini doğururdu.
  //
  //   from: kullanıcı adı / görünen ad / kimlik
  //   in:   kanal adı (yalnızca görünür kanallar zaten listede)
  //   has:  file | image | link
  const filtered = applySearchFilters(permitted, modifiers, chanMap);

  res.json({
    results: filtered.slice(offset, offset + PAGE).map(r => ({
      ...r,
      source:      r._source,
      channelName: chanMap[r.channelId as string] ?? null,
      highlight:   highlightSnippet(String(r.content ?? ''), searchTerm),
      score:       r._score ?? null,
    })),
    hasMore: filtered.length > offset + PAGE,
  });
});

// ── GET /api/search/context ──────────────────────────────────────────────
/**
 * ARAMA SONUCU BAĞLAM ÖNİZLEMESİ — bir isabetin ÇEVRESİNDEKİ konuşma.
 *
 * NEDEN GEREKLİ: tek satırlık bir isabet çoğu zaman yetmez. "tamam" yazan
 * bir mesaj neyin tamam olduğunu söylemez; kullanıcı isabete gitmeden önce
 * hangi konuşma olduğunu görmek ister.
 *
 * ════════════════════════════════════════════════════════════════════════
 * YETKİLENDİRME — ARAMADAN DAHA GEVŞEK DEĞİL
 * ════════════════════════════════════════════════════════════════════════
 * Bu uç nokta, kullanıcının SORGUSUYLA EŞLEŞMEYEN mesajları döndürür. Bu
 * yüzden yetki baştan sona yeniden uygulanır; istemciden gelen `source`
 * bir allowlist'tir ve hiçbir alan güven kaynağı değildir.
 *
 *   • DM / grup DM  — üyelik SQL İÇİNDE (db/postgres/search-context.ts)
 *   • kanal / thread — SQL sunucu üyeliğiyle kapsar, kanal bazlı
 *     VIEW_CHANNELS BURADA uygulanır: `/api/search` ve `/unified` ile AYNI
 *     `viewableChannelIds` yardımcısı. Sunucu üyeliği kanal erişimi
 *     KANITLAMAZ (C2 dersi).
 *
 * Bulunamayan çapa ile yetkisiz çapa AYNI yanıtı üretir (404). Ayrım
 * yapmak bir mesajın varlığını ele verirdi.
 *
 * İçerik DÜZ METİN döner — sunucu HTML üretmez. Vurgulama ve kaçış
 * istemcinin işidir (client/js/search/unified-search-client.ts
 * `highlightSegments`), böylece bu yanıt hiçbir yerde `innerHTML` olarak
 * kullanılamaz.
 */
router.get('/context', authMiddleware, limits.searchContext(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const messageId = scalarQueryText(req.query.id, MAX_SEARCH_ID_LENGTH);
  const source = scalarQueryText(req.query.source, 16);
  const radius = parseBoundedPositiveIntQuery(req.query.radius, 2, 5);

  if (messageId === null || source === null)
    return res.status(400).json({ error: 'Geçersiz arama bağlamı parametresi.' });
  if (!messageId) return res.status(400).json({ error: 'Mesaj kimliği gerekli.' });
  if (!ALLOWED_SOURCES.includes(source))
    return res.status(400).json({ error: 'Geçersiz kaynak.' });
  if (radius === null) return res.status(400).json({ error: 'Geçersiz bağlam yarıçapı.' });

  if (!Messages.hasSearchContext())
    return res.status(503).json({ error: 'Search backend is not available.' });

  const memberships = await Members.findByUser(_u.id);
  const serverIds   = memberships.map((m: { serverId: string }) => m.serverId);

  const ctx = await Messages.searchContext(messageId, source, { userId: _u.id, serverIds }, radius);
  if (!ctx) return res.status(404).json({ error: 'Bağlam bulunamadı.' });

  // ── KANAL BAZLI GÖRÜNÜRLÜK — sunucu üyeliği YETMEZ ──────────────────────
  //
  // İzinler ÇAPANIN GERÇEK sunucusuna karşı çözülür. İlk sürümde sunucu
  // kimliği TAHMİN ediliyordu (kullanıcının üye olduğu sunucular sırayla
  // deneniyordu) ve `viewableChannelIds` kanal kimliğine göre tekilleştirdiği
  // için YANLIŞ sunucuya karşı çözüm yapıp yetkili kullanıcıya bile 404
  // veriyordu. Kimliğin kaynağı artık SQL'dir.
  if (source === 'channel' || source === 'thread') {
    const channelId = ctx.channelId ?? '';
    const serverId  = ctx.serverId  ?? '';
    if (!channelId || !serverId) return res.status(404).json({ error: 'Bağlam bulunamadı.' });

    // Hata → fail-closed (yardımcının kendi davranışı).
    const viewable = await viewableChannelIds(_u.id, [{ channelId, serverId }]);
    if (!viewable.has(channelId)) return res.status(404).json({ error: 'Bağlam bulunamadı.' });
  }

  res.json({
    source,
    channelId: ctx.channelId,
    messages:  ctx.messages,
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
  const queryText = scalarQueryText(req.query.q, MAX_SEARCH_TEXT_LENGTH);
  if (queryText === null) return res.status(400).json({ error: 'Geçersiz arama metni' });
  const q = queryText.toLowerCase();
  if (!q) return res.json([]);

  // Üyelik doğrulama
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Yetkisiz' });

  const allMembers = await Members.findByServer(serverId);
  const userIds    = (allMembers as { userId: string }[]).map((m) => m.userId);
  const users      = await Users.findByIds(userIds);

  // The first check is only a snapshot. A concurrent kick/ban must prevent
  // another member's profile data from being serialized after revocation.
  if (!await Members.findOne(_u.id, serverId)) {
    return res.status(403).json({ error: 'Yetkisiz' });
  }

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
