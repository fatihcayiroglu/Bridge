// server/routes/podcast.ts
// Stage → Podcast Yayınlama
// Stage kayıtları RSS feed + embed player olarak yayınlar.
//
// Endpoint'ler:
//   GET  /api/podcast/:channelId/rss          — RSS 2.0 + iTunes feed
//   GET  /api/podcast/:channelId/feed.json    — JSON Feed (modern)
//   POST /api/podcast/:channelId/episodes     — Yeni bölüm ekle (admin/owner)
//   GET  /api/podcast/:channelId/episodes     — Bölümleri listele
//   GET  /api/podcast/embed/:episodeId        — Embed player HTML (iframe)
//   PATCH /api/podcast/:channelId/settings   — Podcast meta güncelle
//   DELETE /api/podcast/:channelId/episodes/:id — Bölüm sil


import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();
import { v4 as uuidv4 } from 'uuid';
import { Channels, Servers, Users, Podcasts } from '../db/repositories';
import { authMiddleware, verifyToken } from '../middleware/auth';
// Stage → Podcast kayıt pipeline
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import logger from '../lib/logger';
import db from '../db/loader';
import { PERMS, hasPermission, resolvePermissions } from '../lib/permissions';
import { hasLiveUploadReference } from '../lib/uploadReferenceSafety';
import { assertUrlIsPublic } from '../lib/ssrfGuard';
import { parseBoundedPositiveIntQuery } from '../lib/queryNumbers';

import { uploadDir } from '../lib/runtimePaths';
import { parseNonNegativeSafeIntFlexible } from '../lib/queryNumbers';
import { envSafeInt } from '../lib/envNumbers';
import { cache } from '../lib/redisAdapter';
const INSTANCE = () => process.env.INSTANCE_URL || 'https://bridge.local';

// ── v65: Aktif FFmpeg kayıt süreçleri ─────────────────────────
interface ActiveRecording {
  proc: ReturnType<typeof spawn>;
  outputPath: string;
  fileName: string;
  startedAt: number;
  title: string;
  finished: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

// channelId → active or recently-completed recording awaiting explicit publish.
const activeRecordings = new Map<string, ActiveRecording>();
const COMPLETED_RECORDING_TTL_MS = envSafeInt('COMPLETED_RECORDING_TTL_MS', 60 * 60_000, {
  min: 60_000,
  max: 24 * 60 * 60_000,
});
const NODE_ID = process.env.INSTANCE_ID || `node-${process.pid}`;
const RECORDING_LOCK_PREFIX = 'podcast-recording:';
const RECORDING_STATE_PREFIX = 'podcast:recording-state:';

interface SharedRecordingState {
  ownerNodeId: string;
  fileName: string;
  startedAt: number;
  title: string;
  finished: boolean;
}

function isSharedRecordingState(value: unknown): value is SharedRecordingState {
  const v = value as Partial<SharedRecordingState> | null;
  return !!v && typeof v === 'object' &&
    typeof v.ownerNodeId === 'string' && v.ownerNodeId.length > 0 && v.ownerNodeId.length <= 128 &&
    typeof v.fileName === 'string' && path.basename(v.fileName) === v.fileName &&
    Number.isSafeInteger(v.startedAt) && Number(v.startedAt) > 0 &&
    typeof v.title === 'string' && typeof v.finished === 'boolean';
}

const ACTIVE_RECORDING_LEASE_SECONDS = 90;
const ACTIVE_RECORDING_HEARTBEAT_MS = 30_000;

async function readSharedRecording(channelId: string): Promise<SharedRecordingState | null> {
  const raw = await cache.getAuthoritative<unknown>(`${RECORDING_STATE_PREFIX}${channelId}`);
  if (raw === null) return null;
  if (!isSharedRecordingState(raw)) {
    throw new Error(`Malformed shared podcast recording state for channel ${channelId}`);
  }
  return raw;
}

async function writeSharedRecording(channelId: string, state: SharedRecordingState): Promise<void> {
  const ttlSeconds = state.finished
    ? Math.ceil(COMPLETED_RECORDING_TTL_MS / 1000) + 300
    : ACTIVE_RECORDING_LEASE_SECONDS;
  await cache.setAuthoritative(`${RECORDING_STATE_PREFIX}${channelId}`, state, ttlSeconds);
}

async function deleteSharedRecordingIfOwned(channelId: string): Promise<void> {
  await cache.withKeyLock(`${RECORDING_LOCK_PREFIX}${channelId}`, async () => {
    const shared = await readSharedRecording(channelId);
    if (shared?.ownerNodeId === NODE_ID) await cache.delAuthoritative(`${RECORDING_STATE_PREFIX}${channelId}`);
  }, { leaseSeconds: 10, waitMs: 5_000 });
}

const RECORDINGS_DIR = process.env.RECORDINGS_DIR
  || uploadDir('recordings');

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

async function cleanupRecordingIfUnreferenced(fileName: string): Promise<void> {
  if (!fileName || path.basename(fileName) !== fileName) return;
  const canonicalKey = `uploads/recordings/${fileName}`;
  try {
    if (await hasLiveUploadReference(db._pool, canonicalKey)) return;
    const filePath = path.join(RECORDINGS_DIR, fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    // DB/storage belirsizken fiziksel nesneyi koru: dangling DB reference veri
    // kaybından daha güvenlidir ve sonraki orphan-cleanup tarafından ele alınır.
    logger.error({ err, fileName, event: 'podcast.recording_cleanup_blocked' },
      'Podcast recording cleanup fail-closed');
  }
}

function scheduleCompletedRecordingCleanup(channelId: string, rec: ActiveRecording): void {
  if (rec.cleanupTimer) clearTimeout(rec.cleanupTimer);
  rec.cleanupTimer = setTimeout(() => {
    const current = activeRecordings.get(channelId);
    if (current !== rec || !rec.finished) return;
    activeRecordings.delete(channelId);
    if (rec.heartbeatTimer) { clearInterval(rec.heartbeatTimer); rec.heartbeatTimer = null; }
    void deleteSharedRecordingIfOwned(channelId).catch(err =>
      logger.error({ err, channelId, event: 'podcast.record.shared_cleanup_failed' }, 'Podcast shared recording cleanup failed.'),
    );
    void cleanupRecordingIfUnreferenced(rec.fileName);
  }, COMPLETED_RECORDING_TTL_MS);
  rec.cleanupTimer.unref?.();
}

async function stopChildProcess(proc: ReturnType<typeof spawn>): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('exit', done);
      proc.off('error', done);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.off('exit', done);
      proc.off('error', done);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    proc.once('exit', done);
    proc.once('error', done);
  });

  try { proc.kill('SIGTERM'); } catch { return; }
  if (await waitForExit(5_000)) return;
  try { proc.kill('SIGKILL'); } catch { return; }
  await waitForExit(2_000);
}

async function validateRecordingInputUrl(value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Invalid recording input URL');
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('Recording input URL must use HTTPS');

  const allowedHosts = new Set(
    String(process.env.PODCAST_INPUT_ALLOWLIST || '')
      .split(',').map(v => v.trim().toLowerCase()).filter(Boolean),
  );
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error('Recording input host is not allowlisted');
  }
  await assertUrlIsPublic(parsed);
  return parsed.toString();
}

// ── Yetki kontrolü: kanal sahibi veya admin ──────────────────
async function requireChannelAdmin(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> {
  const channelId = String(req.params.channelId ?? '');
  const channel = await Channels.findById(channelId);
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return; }

  const server = await Servers.findById(channel.serverId);
  if (!server) { res.status(404).json({ error: 'Server not found' }); return; }

  const user = await Users.findById(req.user.id);
  const isSiteAdmin = user?.isAdmin === true;
  const perms = await resolvePermissions(req.user.id, server._id, channelId).catch(() => 0);
  const canManage = hasPermission(perms, PERMS.MANAGE_CHANNELS) || hasPermission(perms, PERMS.MANAGE_SERVER);

  if (!isSiteAdmin && !canManage) {
    res.status(403).json({ error: 'You do not have permission to manage this channel' });
    return;
  }

  req.channel = channel;
  req.server  = server;
  next();
}

// ── Podcast ayarlarını al / varsayılan oluştur ────────────────
function parsePublishedFlag(value: unknown, defaultValue = true): boolean | null {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

async function getPodcastSettings(channelId: string) {
  let settings = await Podcasts.findSettingsByChannel(channelId);
  if (!settings) {
    settings = {
      _id:         uuidv4(),
      channelId,
      title:       null,   // null → kanal adı kullanılır
      description: null,
      author:      null,
      imageUrl:    null,
      language:    'tr',
      category:    'Technology',
      explicit:    false,
      createdAt:   Date.now(),
    };
  }
  return settings;
}

// ── RSS 2.0 + iTunes Podcast Feed ────────────────────────────

/**
 * @openapi
 * /podcast/{channelId}/rss:
 *   get:
 *     tags: [Channels]
 *     summary: Kanal podcast RSS feed
 *     security: []
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: RSS XML
 *         content:
 *           application/rss+xml:
 *             schema: { type: string }
 * /podcast/{channelId}/feed.json:
 *   get:
 *     tags: [Channels]
 *     summary: Kanal podcast JSON feed
 *     security: []
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: JSON Feed
 * /podcast/embed/{episodeId}:
 *   get:
 *     tags: [Channels]
 *     summary: Episode embed player
 *     security: []
 *     parameters:
 *       - in: path
 *         name: episodeId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: HTML embed player
 *         content:
 *           text/html:
 *             schema: { type: string }
 * /podcast/{channelId}/episodes:
 *   get:
 *     tags: [Channels]
 *     summary: Podcast episodelerini listele
 *     security: []
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Episode listesi
 *   post:
 *     tags: [Channels]
 *     summary: Yeni episode ekle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, audioUrl]
 *             properties:
 *               title:       { type: string }
 *               description: { type: string }
 *               audioUrl:    { type: string, format: uri }
 *               duration:    { type: integer }
 *     responses:
 *       201:
 *         description: Episode eklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /podcast/{channelId}/episodes/{episodeId}:
 *   delete:
 *     tags: [Channels]
 *     summary: Episode sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: episodeId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /podcast/{channelId}/settings:
 *   patch:
 *     tags: [Channels]
 *     summary: Podcast ayarlarını güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:       { type: string }
 *               description: { type: string }
 *               coverUrl:    { type: string }
 *     responses:
 *       200:
 *         description: Güncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /podcast/{channelId}/record/start:
 *   post:
 *     tags: [Channels]
 *     summary: Podcast kaydını başlat
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Kayıt başladı
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /podcast/{channelId}/record/stop:
 *   post:
 *     tags: [Channels]
 *     summary: Podcast kaydını durdur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Kayıt durduruldu ve kaydedildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /podcast/{channelId}/record/status:
 *   get:
 *     tags: [Channels]
 *     summary: Kayıt durumunu sorgula
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Kayıt aktif mi, süre
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/:channelId/rss', async (req, res) => {
  const channelId = String(req.params.channelId ?? '');
  const channel  = await Channels.findById(channelId);
  if (!channel) return res.status(404).send('Channel not found');

  const settings = await getPodcastSettings(channelId);
  const episodes = await Podcasts.findPublishedEpisodes(channelId);
  episodes.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  const base      = INSTANCE();
  const feedUrl   = `${base}/api/podcast/${channelId}/rss`;
  const title     = escXml(settings.title || channel.name || 'Bridge Podcast');
  const desc      = escXml(settings.description || `Podcast feed for ${channel.name}`);
  const author    = escXml(settings.author || 'Bridge');
  const lang      = escXml(settings.language || 'tr');
  const category  = escXml(settings.category || 'Technology');
  const imageUrl  = settings.imageUrl || `${base}/default-podcast-cover.png`;
  const explicit  = settings.explicit ? 'yes' : 'no';

  const items = episodes.map(ep => {
    const pubDate = new Date(ep.publishedAt ?? ep.createdAt).toUTCString();
    const audioUrl = ep.audioUrl || `${base}/uploads/${ep.filename}`;
    const duration = ep.durationSeconds ? formatDuration(ep.durationSeconds) : '00:00';
    const epDesc   = escXml(ep.description || ep.title || '');
    const epTitle  = escXml(ep.title || 'Episode');

    return `    <item>
      <title>${epTitle}</title>
      <description><![CDATA[${cdataText(ep.description || ep.title || '')}]]></description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${base}/api/podcast/episode/${ep._id}</guid>
      <link>${base}/api/podcast/embed/${ep._id}</link>
      <enclosure url="${escXml(audioUrl)}" length="${ep.fileSize || 0}" type="${escXml(ep.mimeType || 'audio/mpeg')}"/>
      <itunes:title>${epTitle}</itunes:title>
      <itunes:summary>${epDesc}</itunes:summary>
      <itunes:duration>${duration}</itunes:duration>
      <itunes:explicit>${explicit}</itunes:explicit>
      ${ep.season ? `<itunes:season>${ep.season}</itunes:season>` : ''}
      ${ep.episode ? `<itunes:episode>${ep.episode}</itunes:episode>` : ''}
    </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${title}</title>
    <link>${base}</link>
    <description>${desc}</description>
    <language>${lang}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <itunes:author>${author}</itunes:author>
    <itunes:summary>${desc}</itunes:summary>
    <itunes:explicit>${explicit}</itunes:explicit>
    <itunes:category text="${category}"/>
    <itunes:image href="${escXml(imageUrl)}"/>
    <image>
      <url>${escXml(imageUrl)}</url>
      <title>${title}</title>
      <link>${base}</link>
    </image>
${items}
  </channel>
</rss>`;

  res.set({
    'Content-Type':  'application/rss+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
  res.send(xml);
});

// ── JSON Feed (modern alternatif) ─────────────────────────────
router.get('/:channelId/feed.json', async (req, res) => {
  const channelId = String(req.params.channelId ?? '');
  const channel  = await Channels.findById(channelId);
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return; }

  const settings = await getPodcastSettings(channelId);
  const episodes = await Podcasts.findPublishedEpisodes(channelId);
  episodes.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  const base = INSTANCE();

  res.json({
    version:       'https://jsonfeed.org/version/1.1',
    title:         settings.title || channel.name || 'Bridge Podcast',
    home_page_url: base,
    feed_url:      `${base}/api/podcast/${channelId}/feed.json`,
    description:   settings.description || '',
    authors:       [{ name: settings.author || 'Bridge' }],
    language:      settings.language || 'tr',
    items:         episodes.map(ep => ({
      id:           `${base}/api/podcast/episode/${ep._id}`,
      url:          `${base}/api/podcast/embed/${ep._id}`,
      title:        ep.title,
      summary:      ep.description || '',
      date_published: new Date(ep.publishedAt ?? ep.createdAt).toISOString(),
      attachments:  [{
        url:               ep.audioUrl || `${base}/uploads/${ep.filename}`,
        mime_type:         ep.mimeType || 'audio/mpeg',
        size_in_bytes:     ep.fileSize || 0,
        duration_in_seconds: ep.durationSeconds || 0,
      }],
    })),
  });
});

// ── Embed Player HTML ─────────────────────────────────────────
router.get('/embed/:episodeId', async (req, res) => {
  const cspNonce = String(res.locals.cspNonce || '');
  const ep = await Podcasts.findEpisodeOne({ _id: String(req.params.episodeId ?? ''), published: true });
  if (!ep) return res.status(404).send('Episode not found or unpublished');

  const base     = INSTANCE();
  const audioUrl = ep.audioUrl || `${base}/uploads/${ep.filename}`;
  const safeAudioUrl = htmlEsc(audioUrl);
  const title    = htmlEsc(ep.title || 'Podcast Episode');
  const desc     = htmlEsc(ep.description?.slice(0, 160) || '');
  const duration = ep.durationSeconds ? formatDuration(ep.durationSeconds) : '';

  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; media-src 'self' https:; style-src 'nonce-${cspNonce}'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta property="og:type" content="music.song">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<title>${title}</title>
<style nonce="${cspNonce}">
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #1a1b1e;
    color: #dcddde;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  }
  .player {
    width: 100%;
    max-width: 640px;
    background: #2f3136;
    border-radius: 12px;
    padding: 20px 24px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  .player-header {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 16px;
  }
  .player-icon {
    width: 56px;
    height: 56px;
    background: linear-gradient(135deg, #2d9cdb, #1bc8a8);
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    flex-shrink: 0;
  }
  .player-meta { flex: 1; min-width: 0; }
  .player-title {
    font-size: 15px;
    font-weight: 700;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .player-desc {
    font-size: 12px;
    color: #96989d;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .player-duration { font-size: 11px; color: #72767d; margin-top: 2px; }
  audio {
    width: 100%;
    border-radius: 8px;
    accent-color: #2d9cdb;
    height: 40px;
  }
  .player-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    font-size: 11px;
    color: #72767d;
  }
  .player-footer a {
    color: #2d9cdb;
    text-decoration: none;
  }
  .player-footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="player">
  <div class="player-header">
    <div class="player-icon">🎙️</div>
    <div class="player-meta">
      <div class="player-title">${title}</div>
      ${desc ? `<div class="player-desc">${desc}</div>` : ''}
      ${duration ? `<div class="player-duration">⏱ ${duration}</div>` : ''}
    </div>
  </div>
  <audio controls preload="metadata" src="${safeAudioUrl}">
    Tarayıcınız audio etiketini desteklemiyor.
  </audio>
  <div class="player-footer">
    <span>Bridge Podcast</span>
    <a href="${base}" target="_blank" rel="noopener">bridge.local →</a>
  </div>
</div>
</body>
</html>`);
});

// ── Bölüm Listesi ─────────────────────────────────────────────
router.get('/:channelId/episodes', async (req, res) => {
  const channelId = String(req.params.channelId ?? '');
  const { published = 'true', page, limit } = req.query;
  const filter: Record<string, unknown> = { channelId };

  // FAZ G — YAYINLANMAMIS BOLUMLER KIMLIKSIZ SERVIS EDILEMEZ.
  //
  // Bu uc KIMLIK DOGRULAMASIZDIR (podcast RSS'i kamuya aciktir ve bu
  // KASITLIDIR). Ancak `?published=all` / `?published=false` YAYINLANMAMIS
  // taslaklari da donduruyordu: baslik, aciklama, `filename` ve `audioUrl`
  // dahil. Yani herhangi biri, yalnizca channelId tahmin ederek yayina
  // alinmamis bolumleri (ve ses dosyasi yolunu) listeleyebiliyordu.
  //
  // Kamuya acik olan YALNIZCA yayinlanmis bolumlerdir; taslaklar kanal
  // yoneticisi yetkisi ister. Kimliksiz veya yetkisiz cagirana sessizce
  // yayinlanmis kume verilir (varligi ifsa etmemek icin 403 yerine daralt).
  const wantsUnpublished = published === 'all' || published === 'false';
  let maySeeDrafts = false;
  if (wantsUnpublished) {
    // ISTEGE BAGLI KIMLIK: bu rota `authMiddleware` TASIMAZ (kamuya acik
    // besleme). Bu yuzden `req.user` HICBIR ZAMAN dolmaz — token gonderilse
    // bile. Taslak gorebilmek icin token BURADA, kanonik dogrulayiciyla
    // cozulur; token yoksa/gecersizse istek reddedilmez, yalnizca
    // yayinlanmis kumeye daraltilir.
    const header = String(req.headers.authorization ?? '');
    const authed = header.startsWith('Bearer ')
      ? verifyToken(header.slice(7))
      : null;
    if (authed?.id) {
      const channel = await Channels.findById(channelId);
      if (channel) {
        const server = await Servers.findById(channel.serverId);
        const user   = await Users.findById(authed.id);
        const perms = server
          ? await resolvePermissions(authed.id, server._id, channelId).catch(() => 0)
          : 0;
        maySeeDrafts = Boolean(
          user?.isAdmin ||
          hasPermission(perms, PERMS.MANAGE_CHANNELS) ||
          hasPermission(perms, PERMS.MANAGE_SERVER),
        );
      }
    }
  }

  if (!wantsUnpublished || !maySeeDrafts) filter.published = true;

  const episodes = await Podcasts.findEpisodes(filter);
  episodes.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  const pageNum = parseBoundedPositiveIntQuery(page, 1, 1_000_000);
  const limitNum = parseBoundedPositiveIntQuery(limit, 20, 50);
  if (pageNum === null || limitNum === null) {
    return res.status(400).json({ error: 'page/limit must be positive safe integers' });
  }
  const offset = (pageNum - 1) * limitNum;
  const sliced   = episodes.slice(offset, offset + limitNum);

  const base = INSTANCE();
  res.json({
    total:    episodes.length,
    page:     pageNum,
    pages:    Math.ceil(episodes.length / limitNum),
    episodes: sliced.map(ep => ({
      ...ep,
      embedUrl: `${base}/api/podcast/embed/${ep._id}`,
      audioUrl: ep.audioUrl || `${base}/uploads/${ep.filename}`,
    })),
  });
});

// ── Yeni Bölüm Ekle ──────────────────────────────────────────
// Body: { title, description, filename (uploads'taki dosya adı), audioUrl?,
//         durationSeconds?, season?, episode?, published? }
router.post('/:channelId/episodes', authMiddleware, requireChannelAdmin, async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.channelId ?? '');
  const body = req.body as Record<string, unknown>;
  const title = body.title;
  const description = body.description ?? '';
  const filename = body.filename;
  const audioUrl = body.audioUrl;
  const mimeType = body.mimeType ?? 'audio/mpeg';
  const published = parsePublishedFlag(body.published, true);
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'Episode title is required' });
  if (typeof description !== 'string') return res.status(400).json({ error: 'description must be a string' });
  if (filename !== undefined && filename !== null && typeof filename !== 'string') return res.status(400).json({ error: 'filename must be a string' });
  if (audioUrl !== undefined && audioUrl !== null && typeof audioUrl !== 'string') return res.status(400).json({ error: 'audioUrl must be a string' });
  if (!filename && !audioUrl) return res.status(400).json({ error: 'filename or audioUrl is required' });
  if (typeof mimeType !== 'string' || !mimeType.trim()) return res.status(400).json({ error: 'mimeType must be a string' });
  if (published === null) return res.status(400).json({ error: 'published must be a boolean or exact boolean flag' });
  const fileSize = parseNonNegativeSafeIntFlexible(body.fileSize, 0);
  const durationSeconds = body.durationSeconds === null ? 0 : parseNonNegativeSafeIntFlexible(body.durationSeconds, 0);
  const season = body.season === null || body.season === undefined ? null : parseNonNegativeSafeIntFlexible(body.season, 0);
  const episodeNumber = body.episode === null || body.episode === undefined ? null : parseNonNegativeSafeIntFlexible(body.episode, 0);
  const invalidSeason = season === null && body.season !== null && body.season !== undefined;
  const invalidEpisode = episodeNumber === null && body.episode !== null && body.episode !== undefined;
  if (fileSize === null || durationSeconds === null || invalidSeason || invalidEpisode) {
    return res.status(400).json({ error: 'fileSize, durationSeconds, season and episode must be non-negative safe integers' });
  }

  const ep = {
    _id:             uuidv4(),
    channelId,
    serverId:        req.channel?.serverId ?? '',
    title:           title.trim().slice(0, 200),
    description:     description.slice(0, 2000),
    filename:        filename || null,
    audioUrl:        audioUrl || null,
    mimeType,
    fileSize,
    durationSeconds: body.durationSeconds === undefined || body.durationSeconds === null ? null : durationSeconds,
    season,
    episode: episodeNumber,
    published,
    publishedAt: published ? Date.now() : null,
    createdBy:       _u.id,
    createdAt:       Date.now(),
  };

  await Podcasts.insertEpisode(ep);

  const base = INSTANCE();
  res.status(201).json({
    ok: true,
    episode: {
      ...ep,
      embedUrl: `${base}/api/podcast/embed/${ep._id}`,
      rssUrl:   `${base}/api/podcast/${channelId}/rss`,
    },
  });
});

// ── Bölüm Sil ─────────────────────────────────────────────────
router.delete('/:channelId/episodes/:episodeId', authMiddleware, requireChannelAdmin, async (req, res) => {
  const episodeId = String(req.params.episodeId ?? '');
  const ep = await Podcasts.findEpisodeOne({ _id: episodeId, channelId: String(req.params.channelId ?? '') });
  if (!ep) return res.status(404).json({ error: 'Episode not found' });
  await Podcasts.removeEpisode({ _id: episodeId });
  const localRecording = typeof ep.audioUrl === 'string'
    ? ep.audioUrl.match(/^\/uploads\/recordings\/([^/?#]+)$/)?.[1]
    : null;
  if (localRecording) await cleanupRecordingIfUnreferenced(localRecording);
  res.json({ ok: true });
});

// ── Podcast Ayarları ──────────────────────────────────────────
router.patch('/:channelId/settings', authMiddleware, requireChannelAdmin, async (req, res) => {
  const channelId = String(req.params.channelId ?? '');
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Settings body must be an object' });
  }

  const stringLimits: Readonly<Record<string, number>> = {
    title: 200,
    description: 2_000,
    author: 200,
    imageUrl: 2_048,
    language: 35,
    category: 100,
  };
  const updates: Record<string, unknown> = {};
  for (const [key, maxLength] of Object.entries(stringLimits)) {
    const value = req.body[key];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== 'string' || value.length > maxLength)) {
      return res.status(400).json({ error: `${key} must be null or a string up to ${maxLength} characters` });
    }
    updates[key] = value;
  }
  if (req.body.explicit !== undefined) {
    if (typeof req.body.explicit !== 'boolean') {
      return res.status(400).json({ error: 'explicit must be a boolean' });
    }
    updates.explicit = req.body.explicit;
  }

  const existing = await Podcasts.findSettingsByChannel(channelId);
  await Podcasts.upsertSettings(channelId, updates);

  res.json({ ok: true, settings: { channelId, ...existing, ...updates } });
});

// ── Yardımcılar ───────────────────────────────────────────────
function escXml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdataText(value: unknown): string {
  return String(value ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
}

function htmlEsc(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(secs: number): string {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

// ── v65: Stage → Podcast Kayıt Pipeline ──────────────────────────────────

// POST /api/podcast/:channelId/record/start
// Stage kaydını başlatır. inputUrl varsa RTMP/HLS kaynağı kullanılır;
// yoksa anullsrc stub ile süre tutulur, gerçek ses client'tan stop'ta gönderilir.
router.post('/:channelId/record/start', authMiddleware, requireChannelAdmin, async (req, res) => {
  const channelId = String(req.params.channelId ?? '');
  const titleRaw = req.body?.title;
  if (titleRaw !== undefined && (typeof titleRaw !== 'string' || titleRaw.length > 200)) {
    return res.status(400).json({ error: 'title must be a string up to 200 characters' });
  }
  const title = (typeof titleRaw === 'string' && titleRaw.trim())
    ? titleRaw.trim()
    : `Stage Recording ${new Date().toISOString().slice(0, 10)}`;

  let inputUrl: string | null;
  try {
    inputUrl = await validateRecordingInputUrl(req.body?.inputUrl);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  try {
    const result = await cache.withKeyLock(`${RECORDING_LOCK_PREFIX}${channelId}`, async () => {
      const shared = await readSharedRecording(channelId);
      if (shared || activeRecordings.has(channelId)) {
        return { conflict: shared?.ownerNodeId ?? NODE_ID } as const;
      }

      const fileName   = `stage_${channelId}_${Date.now()}_${uuidv4().slice(0, 8)}.mp3`;
      const outputPath = path.join(RECORDINGS_DIR, fileName);
      const maxRecordingSecs = envSafeInt('MAX_RECORDING_SECS', 14_400, { min: 60, max: 86_400 });
      const ffmpegArgs = inputUrl
        ? ['-i', inputUrl, '-acodec', 'libmp3lame', '-ab', '128k', '-y', outputPath]
        : [
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-acodec', 'libmp3lame', '-ab', '128k',
            '-t', String(maxRecordingSecs), '-y', outputPath,
          ];

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        logger.error({ err, event: 'podcast.record.spawn_failed' }, 'Failed to spawn FFmpeg process.');
        return { spawnError: err instanceof Error ? err.message : String(err) } as const;
      }

      const startedAt = Date.now();
      const rec: ActiveRecording = {
        proc, outputPath, fileName, startedAt, title, finished: false, cleanupTimer: null, heartbeatTimer: null,
      };
      activeRecordings.set(channelId, rec);
      try {
        await writeSharedRecording(channelId, { ownerNodeId: NODE_ID, fileName, startedAt, title, finished: false });
        rec.heartbeatTimer = setInterval(() => {
          void cache.withKeyLock(`${RECORDING_LOCK_PREFIX}${channelId}`, async () => {
            if (activeRecordings.get(channelId) !== rec || rec.finished) return;
            const current = await readSharedRecording(channelId);
            if (!current || current.ownerNodeId !== NODE_ID || current.fileName !== fileName) {
              throw new Error('Podcast recording ownership lease was lost');
            }
            await writeSharedRecording(channelId, current);
          }, { leaseSeconds: 10, waitMs: 5_000 }).catch(async err => {
            // A recorder without authoritative coordination can become a second
            // writer after the lease expires. Stop it instead of risking split-brain.
            logger.error({ err, channelId, event: 'podcast.record.heartbeat_failed' },
              'Podcast recording ownership heartbeat failed; stopping local FFmpeg fail-closed.');
            if (activeRecordings.get(channelId) === rec) {
              activeRecordings.delete(channelId);
              rec.finished = true;
              if (rec.heartbeatTimer) { clearInterval(rec.heartbeatTimer); rec.heartbeatTimer = null; }
              await stopChildProcess(proc).catch(() => undefined);
              void cleanupRecordingIfUnreferenced(fileName);
            }
          });
        }, ACTIVE_RECORDING_HEARTBEAT_MS);
        rec.heartbeatTimer.unref?.();
      } catch (err) {
        activeRecordings.delete(channelId);
        void stopChildProcess(proc);
        void cleanupRecordingIfUnreferenced(fileName);
        throw err;
      }

      proc.on('error', err => {
        logger.error({ err, channelId, event: 'podcast.record.process_error' }, 'FFmpeg recording process error.');
        if (activeRecordings.get(channelId) === rec) {
          activeRecordings.delete(channelId);
          if (rec.cleanupTimer) clearTimeout(rec.cleanupTimer);
          if (rec.heartbeatTimer) { clearInterval(rec.heartbeatTimer); rec.heartbeatTimer = null; }
          void deleteSharedRecordingIfOwned(channelId).catch(sharedErr =>
            logger.error({ err: sharedErr, channelId, event: 'podcast.record.error_state_cleanup_failed' }, 'Podcast shared recording state cleanup failed.'),
          );
          void cleanupRecordingIfUnreferenced(fileName);
        }
      });
      proc.on('exit', (code, signal) => {
        if (activeRecordings.get(channelId) !== rec) return;
        if (rec.heartbeatTimer) { clearInterval(rec.heartbeatTimer); rec.heartbeatTimer = null; }
        rec.finished = true;
        if (code !== 0 && signal !== 'SIGTERM') {
          logger.warn({ channelId, code, signal, event: 'podcast.record.unexpected_exit' }, 'FFmpeg exited unexpectedly.');
        }
        void cache.withKeyLock(`${RECORDING_LOCK_PREFIX}${channelId}`, async () => {
          const current = await readSharedRecording(channelId);
          if (current?.ownerNodeId === NODE_ID && current.fileName === fileName) {
            await writeSharedRecording(channelId, { ...current, finished: true });
          }
        }, { leaseSeconds: 10, waitMs: 5_000 }).catch(err =>
          logger.error({ err, channelId, event: 'podcast.record.finish_state_failed' }, 'Podcast finished-state update failed.'),
        );
        scheduleCompletedRecordingCleanup(channelId, rec);
      });

      return { ok: true, fileName, outputPath, startedAt } as const;
    }, { leaseSeconds: 10, waitMs: 5_000 });

    if ('conflict' in result && typeof result.conflict === 'string') {
      return res.status(409).json({
        error: 'Recording is already active for this channel',
        ownerNodeId: result.conflict,
        retryHint: `Repeat node-owned recording operations with ?bridgeNode=${encodeURIComponent(result.conflict)}`,
      });
    }
    if ('spawnError' in result) {
      return res.status(500).json({
        error: 'FFmpeg could not be started. Ensure FFmpeg is installed on the server.',
        detail: result.spawnError,
      });
    }
    logger.info({ channelId, outputPath: result.outputPath, nodeId: NODE_ID, event: 'podcast.record.started' }, 'Podcast recording started.');
    return res.json({ ok: true, channelId, title, startedAt: result.startedAt, stub: !inputUrl, ownerNodeId: NODE_ID });
  } catch (err) {
    logger.error({ err, channelId, event: 'podcast.record.coordination_failed' }, 'Podcast recording coordination unavailable.');
    return res.status(503).json({ error: 'Recording coordination is temporarily unavailable' });
  }
});

// POST /api/podcast/:channelId/record/stop
// Kaydı durdurur ve yeni podcast episode oluşturur.
// Body: { title?, description?, audioFile? } — audioFile: base64 MP3/WebM (client-side kayıt)
router.post('/:channelId/record/stop', authMiddleware, requireChannelAdmin, async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.channelId ?? '');
  let outputPath: string | undefined;
  let fileName: string | undefined;
  let startedAt: number;
  let title: string;

  try {
    const claimed = await cache.withKeyLock(`${RECORDING_LOCK_PREFIX}${channelId}`, async () => {
      const shared = await readSharedRecording(channelId);
      if (shared && shared.ownerNodeId !== NODE_ID) return { remoteOwner: shared.ownerNodeId } as const;

      const rec = activeRecordings.get(channelId);
      if (rec) {
        if (shared && shared.fileName !== rec.fileName) {
          throw new Error('Local/shared recording identity mismatch');
        }
        activeRecordings.delete(channelId);
        if (rec.cleanupTimer) clearTimeout(rec.cleanupTimer);
        if (rec.heartbeatTimer) { clearInterval(rec.heartbeatTimer); rec.heartbeatTimer = null; }
        if (!rec.finished) await stopChildProcess(rec.proc);
        await cache.delAuthoritative(`${RECORDING_STATE_PREFIX}${channelId}`);
        return { rec } as const;
      }

      // This node is named as owner but no longer has the process (e.g. process
      // restart). Remove stale ownership rather than letting it block forever.
      if (shared?.ownerNodeId === NODE_ID) await cache.delAuthoritative(`${RECORDING_STATE_PREFIX}${channelId}`);
      return { none: true } as const;
    }, { leaseSeconds: 10, waitMs: 5_000 });

    if ('remoteOwner' in claimed && typeof claimed.remoteOwner === 'string') {
      return res.status(409).json({
        error: 'Recording is owned by another Bridge node',
        ownerNodeId: claimed.remoteOwner,
        retryHint: `Retry with ?bridgeNode=${encodeURIComponent(claimed.remoteOwner)}`,
      });
    }
    if ('rec' in claimed && claimed.rec) {
      ({ outputPath, fileName, startedAt, title } = claimed.rec);
    } else if (req.body?.audioFile) {
      const audioFile = req.body.audioFile;
      if (typeof audioFile !== 'string') return res.status(400).json({ error: 'audioFile must be a string' });
      const MAX_AUDIO_SIZE_MB = envSafeInt('MAX_FILE_SIZE_MB', 500, { min: 1, max: 100_000 });
      const estimatedBytes = Math.ceil(audioFile.length * 0.75);
      if (estimatedBytes > MAX_AUDIO_SIZE_MB * 1024 * 1024) {
        return res.status(413).json({ error: `Audio file exceeds ${MAX_AUDIO_SIZE_MB}MB limit` });
      }
      fileName   = `stage_${channelId}_${Date.now()}_${uuidv4().slice(0, 8)}.mp3`;
      outputPath = path.join(RECORDINGS_DIR, fileName);
      const parsedStartedAt = parseNonNegativeSafeIntFlexible(req.body.startedAt, Date.now());
      if (parsedStartedAt === null || parsedStartedAt <= 0 || parsedStartedAt > Date.now() + 60_000) {
        return res.status(400).json({ error: 'startedAt must be a valid epoch millisecond timestamp' });
      }
      startedAt = parsedStartedAt;
      title = typeof req.body.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 200)
        : `Stage Recording ${new Date().toISOString().slice(0, 10)}`;
      fs.writeFileSync(outputPath, Buffer.from(audioFile, 'base64'));
    } else {
      return res.status(404).json({ error: 'No active recording found for this channel' });
    }
  } catch (err) {
    logger.error({ err, channelId, event: 'podcast.record.stop_coordination_failed' }, 'Podcast stop coordination unavailable.');
    return res.status(503).json({ error: 'Recording coordination is temporarily unavailable' });
  }

  if (!outputPath || !fileName || !startedAt) {
    return res.status(500).json({ error: 'Recording state is incomplete' });
  }

  let fileSizeBytes: number;
  const durationSecs  = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  try {
    fileSizeBytes = fs.statSync(outputPath).size;
    if (fileSizeBytes < 1024) {
      fs.unlinkSync(outputPath);
      return res.status(422).json({ error: 'Recording file is too small; no valid audio captured' });
    }
  } catch {
    return res.status(500).json({ error: 'Recording file could not be created' });
  }

  const episodeTitle = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim().slice(0, 200)
    : title;
  const description = typeof req.body?.description === 'string' ? req.body.description.slice(0, 2000) : '';
  const episode = {
    _id: uuidv4(), channelId, serverId: req.channel?.serverId ?? null,
    title: episodeTitle, description, filename: fileName,
    audioUrl: `/uploads/recordings/${fileName}`, mimeType: 'audio/mpeg',
    fileSize: fileSizeBytes, durationSeconds: durationSecs, published: true,
    publishedAt: Date.now(), createdBy: _u.id, createdAt: Date.now(),
  };
  try {
    const inserted = await Podcasts.insertEpisode(episode);
    if (!inserted?._id) throw new Error('Podcast episode persistence failed');
  } catch (err) {
    await cleanupRecordingIfUnreferenced(fileName);
    throw err;
  }
  logger.info({ channelId, title: episodeTitle, durationSecs, fileSizeBytes, event: 'podcast.episode.created' }, 'Podcast episode created from recording.');
  return res.json({ ok: true, episode });
});

// GET /api/podcast/:channelId/record/status — Aktif kayıt durumu sorgula
router.get('/:channelId/record/status', authMiddleware, requireChannelAdmin, async (req, res) => {
  const channelId = String(req.params.channelId ?? '');
  try {
    const shared = await cache.withKeyLock(`${RECORDING_LOCK_PREFIX}${channelId}`, () => readSharedRecording(channelId), {
      leaseSeconds: 5, waitMs: 2_000,
    });
    if (!shared) return res.json({ recording: false });
    return res.json({
      recording: !shared.finished,
      readyToPublish: shared.finished,
      title: shared.title,
      startedAt: shared.startedAt,
      elapsedSecs: Math.max(0, Math.round((Date.now() - shared.startedAt) / 1000)),
      ownerNodeId: shared.ownerNodeId,
      localOwner: shared.ownerNodeId === NODE_ID,
    });
  } catch (err) {
    logger.error({ err, channelId, event: 'podcast.record.status_coordination_failed' }, 'Podcast recording status coordination unavailable.');
    return res.status(503).json({ error: 'Recording coordination is temporarily unavailable' });
  }
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
