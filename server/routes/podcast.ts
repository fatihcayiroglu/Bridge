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
import { Channels, Servers, Users, Members, Podcasts } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
// Stage → Podcast kayıt pipeline
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import logger from '../lib/logger';

const INSTANCE = () => process.env.INSTANCE_URL || 'https://bridge.local';

// ── v65: Aktif FFmpeg kayıt süreçleri ─────────────────────────
// channelId → { proc, outputPath, fileName, startedAt, title }
const activeRecordings = new Map();

const RECORDINGS_DIR = process.env.RECORDINGS_DIR
  || path.join(__dirname, '../../uploads/recordings');

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ── Yetki kontrolü: kanal sahibi veya admin ──────────────────
async function requireChannelAdmin(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> {
  const channelId = String(req.params.channelId ?? '');
  const channel = await Channels.findById(channelId);
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return; }

  const server = await Servers.findById(channel.serverId);
  if (!server) { res.status(404).json({ error: 'Server not found' }); return; }

  const user = await Users.findById(req.user.id);
  const isServerOwner = server.ownerId === req.user.id;
  const isSiteAdmin   = user?.isAdmin;

  if (!isServerOwner && !isSiteAdmin) {
    // Moderatör kontrolü
    const member = await Members.findOne(req.user.id, server._id);
    if (!member) { res.status(403).json({ error: 'You do not have permission to manage this channel' }); return; }
  }

  req.channel = channel;
  req.server  = server;
  next();
}

// ── Podcast ayarlarını al / varsayılan oluştur ────────────────
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
 *     tags: [Podcast]
 *     summary: RSS 2.0 besleme
 *     parameters:
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: XML RSS belgesi }
 * /podcast/{channelId}/episodes:
 *   get:
 *     tags: [Podcast]
 *     summary: Bölüm listesi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Bölüm dizisi }
 *   post:
 *     tags: [Podcast]
 *     summary: Yeni bölüm yayınla
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       201: { description: Bölüm oluşturuldu }
 * /podcast/{channelId}/record/start:
 *   post:
 *     tags: [Podcast]
 *     summary: Canlı kayıt başlat
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Kayıt başladı }

 *
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
 *
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
 *
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
 *
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
 *
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
 *
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
 *
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
 *
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
 *
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
  episodes.sort((a, b) => b.publishedAt - a.publishedAt);

  const base      = INSTANCE();
  const feedUrl   = `${base}/api/podcast/${channelId}/rss`;
  const title     = escXml(settings.title || channel.name || 'Bridge Podcast');
  const desc      = escXml(settings.description || `Podcast feed for ${channel.name}`);
  const author    = escXml(settings.author || 'Bridge');
  const lang      = settings.language || 'tr';
  const category  = escXml(settings.category || 'Technology');
  const imageUrl  = settings.imageUrl || `${base}/default-podcast-cover.png`;
  const explicit  = settings.explicit ? 'yes' : 'no';

  const items = episodes.map(ep => {
    const pubDate = new Date(ep.publishedAt).toUTCString();
    const audioUrl = ep.audioUrl || `${base}/uploads/${ep.filename}`;
    const duration = ep.durationSeconds ? formatDuration(ep.durationSeconds) : '00:00';
    const epDesc   = escXml(ep.description || ep.title || '');
    const epTitle  = escXml(ep.title || 'Episode');

    return `    <item>
      <title>${epTitle}</title>
      <description><![CDATA[${ep.description || ep.title || ''}]]></description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${base}/api/podcast/episode/${ep._id}</guid>
      <link>${base}/api/podcast/embed/${ep._id}</link>
      <enclosure url="${escXml(audioUrl)}" length="${ep.fileSize || 0}" type="${ep.mimeType || 'audio/mpeg'}"/>
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
  episodes.sort((a, b) => b.publishedAt - a.publishedAt);

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
      date_published: new Date(ep.publishedAt).toISOString(),
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
  const ep = await Podcasts.findEpisodeOne({ _id: String(req.params.episodeId ?? ''), published: true });
  if (!ep) return res.status(404).send('Episode not found or unpublished');

  const base     = INSTANCE();
  const audioUrl = ep.audioUrl || `${base}/uploads/${ep.filename}`;
  const title    = htmlEsc(ep.title || 'Podcast Episode');
  const desc     = htmlEsc(ep.description?.slice(0, 160) || '');
  const duration = ep.durationSeconds ? formatDuration(ep.durationSeconds) : '';

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="music.song">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #1a1b1e;
    color: #dcddde;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
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
  <audio controls preload="metadata" src="${audioUrl}">
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
  const { published = 'true', page = 1, limit = 20 } = req.query;
  const filter: Record<string, unknown> = { channelId };
  if (published !== 'all') filter.published = published === 'true';

  const episodes = await Podcasts.findEpisodes(filter);
  episodes.sort((a, b) => b.publishedAt - a.publishedAt);

  const pageNum  = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const limitNum = Math.min(50, parseInt(String(limit ?? '20'), 10) || 20);
  const offset   = (pageNum - 1) * limitNum;
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
  const {
    title, description = '', filename, audioUrl,
    durationSeconds, season, episode: epNum,
    published = true, mimeType = 'audio/mpeg', fileSize = 0,
  } = req.body as { title?: string; description?: string; filename?: string; audioUrl?: string; durationSeconds?: string | number; season?: string | number; episode?: string | number; published?: boolean | string; mimeType?: string; fileSize?: string | number };

  if (!title?.trim()) return res.status(400).json({ error: 'Episode title is required' });
  if (!filename && !audioUrl) return res.status(400).json({ error: 'filename or audioUrl is required' });

  const ep = {
    _id:             uuidv4(),
    channelId,
    serverId:        req.channel?.serverId ?? '',
    title:           title.trim().slice(0, 200),
    description:     description.slice(0, 2000),
    filename:        filename || null,
    audioUrl:        audioUrl || null,
    mimeType,
    fileSize:        parseInt(String(fileSize ?? 0), 10) || 0,
    durationSeconds: durationSeconds ? parseInt(String(durationSeconds), 10) : null,
    season:          season ? parseInt(String(season), 10) : null,
    episode:         epNum  ? parseInt(String(epNum), 10)  : null,
    published:       Boolean(published),
    publishedAt:     Date.now(),
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
  res.json({ ok: true });
});

// ── Podcast Ayarları ──────────────────────────────────────────
router.patch('/:channelId/settings', authMiddleware, requireChannelAdmin, async (req, res) => {
  const channelId = String(req.params.channelId ?? '');
  const allowed = ['title', 'description', 'author', 'imageUrl', 'language', 'category', 'explicit'];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
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
  if (activeRecordings.has(channelId)) {
    return res.status(409).json({ error: 'Recording is already active for this channel' });
  }

  const title      = req.body?.title || `Stage Recording ${new Date().toISOString().slice(0, 10)}`;
  const inputUrl   = req.body?.inputUrl;
  const fileName   = `stage_${channelId}_${Date.now()}.mp3`;
  const outputPath = path.join(RECORDINGS_DIR, fileName);

  const ffmpegArgs = inputUrl
    ? ['-i', inputUrl, '-acodec', 'libmp3lame', '-ab', '128k', '-y', outputPath]
    : [
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-acodec', 'libmp3lame', '-ab', '128k',
        '-t', String(process.env.MAX_RECORDING_SECS || 14400),
        '-y', outputPath,
      ];

  let proc;
  try {
    proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (_err) { const err = _err as Error;
    logger.error({ err, event: 'podcast.record.spawn_failed' }, 'Failed to spawn FFmpeg process.');
    return res.status(500).json({
      error: 'FFmpeg could not be started. Ensure FFmpeg is installed on the server.',
      detail: err.message,
    });
  }

  const startedAt = Date.now();
  activeRecordings.set(channelId, { proc, outputPath, fileName, startedAt, title });

  proc.on('error', err => {
    logger.error({ err, channelId, event: 'podcast.record.process_error' }, 'FFmpeg recording process error.');
    activeRecordings.delete(channelId);
  });
  proc.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      logger.warn({ channelId, code, signal, event: 'podcast.record.unexpected_exit' }, 'FFmpeg exited unexpectedly.');
    }
  });

  logger.info({ channelId, outputPath, event: 'podcast.record.started' }, 'Podcast recording started.');
  res.json({ ok: true, channelId, title, startedAt, stub: !inputUrl });
});

// POST /api/podcast/:channelId/record/stop
// Kaydı durdurur ve yeni podcast episode oluşturur.
// Body: { title?, description?, audioFile? } — audioFile: base64 MP3/WebM (client-side kayıt)
router.post('/:channelId/record/stop', authMiddleware, requireChannelAdmin, async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.channelId ?? '');
  let outputPath, fileName, startedAt, title;

  if (activeRecordings.has(channelId)) {
    const rec = activeRecordings.get(channelId);
    ({ outputPath, fileName, startedAt, title } = rec);
    activeRecordings.delete(channelId);
    rec.proc.kill('SIGTERM');
    await new Promise(r => { rec.proc.on('exit', r); rec.proc.on('error', r); });
  } else if (req.body?.audioFile) {
    // Client-side WebRTC kaydı (MediaRecorder blob → base64)
    // SECURITY: Validate base64 payload size before writing to disk
    const audioFile = req.body.audioFile;
    if (typeof audioFile !== 'string') return res.status(400).json({ error: 'audioFile must be a string' });
    const MAX_AUDIO_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10);
    const estimatedBytes = Math.ceil(audioFile.length * 0.75); // base64 → bytes
    if (estimatedBytes > MAX_AUDIO_SIZE_MB * 1024 * 1024) {
      return res.status(413).json({ error: `Audio file exceeds ${MAX_AUDIO_SIZE_MB}MB limit` });
    }
    fileName   = `stage_${channelId}_${Date.now()}.mp3`;
    outputPath = path.join(RECORDINGS_DIR, fileName);
    startedAt  = req.body.startedAt || Date.now();
    title      = req.body.title || `Stage Recording ${new Date().toISOString().slice(0, 10)}`;
    fs.writeFileSync(outputPath, Buffer.from(audioFile, 'base64'));
  } else {
    return res.status(404).json({ error: 'No active recording found for this channel' });
  }

  let fileSizeBytes = 0;
  const durationSecs  = Math.round((Date.now() - startedAt) / 1000);
  try {
    fileSizeBytes = fs.statSync(outputPath).size;
    if (fileSizeBytes < 1024) {
      fs.unlinkSync(outputPath);
      return res.status(422).json({ error: 'Recording file is too small; no valid audio captured' });
    }
  } catch {
    return res.status(500).json({ error: 'Recording file could not be created' });
  }

  const episodeTitle = req.body?.title || title;
  const episode = {
    _id:         uuidv4(),
    channelId,
    title:       episodeTitle,
    description: req.body?.description || '',
    audioUrl:    `/uploads/recordings/${fileName}`,
    duration:    durationSecs,
    fileSize:    fileSizeBytes,
    published:   true,
    recordedAt:  startedAt,
    createdAt:   Date.now(),
    authorId:    _u._id,
  };
  await Podcasts.insertEpisode(episode);
  logger.info(
    { channelId, title: episodeTitle, durationSecs, fileSizeBytes, event: 'podcast.episode.created' },
    'Podcast episode created from recording.'
  );
  res.json({ ok: true, episode });
});

// GET /api/podcast/:channelId/record/status — Aktif kayıt durumu sorgula
router.get('/:channelId/record/status', authMiddleware, requireChannelAdmin, async (req, res) => {
  const rec = activeRecordings.get(String(req.params.channelId ?? ''));
  if (!rec) return res.json({ recording: false });
  res.json({
    recording:   true,
    title:       rec.title,
    startedAt:   rec.startedAt,
    elapsedSecs: Math.round((Date.now() - rec.startedAt) / 1000),
  });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
