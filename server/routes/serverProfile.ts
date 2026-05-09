// server/routes/serverProfile.js
// GET /s/:slug  — Herkese açık sunucu profil sayfası (SEO + sosyal önizleme)
// GET /api/servers/:sid/slug — Slug al
// PUT /api/servers/:sid/slug — Slug ayarla (owner only)

'use strict';

const express    = require('express');
const router     = express.Router();
const { Servers, Members, Channels, Users } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/[çÇ]/g,'c').replace(/[şŞ]/g,'s').replace(/[ğĞ]/g,'g')
    .replace(/[üÜ]/g,'u').replace(/[öÖ]/g,'o').replace(/[ıİ]/g,'i')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 40) || 'server';
}

// ── GET /api/servers/:sid/slug ────────────────────────────────
router.get('/:sid/slug', authMiddleware, asyncHandler(async (req, res) => {
  const server = await Servers.findById(req.params.sid);
  if (!server) return res.status(404).json({ error: 'Not found' });
  res.json({ slug: server.slug || null });
}));

// ── PUT /api/servers/:sid/slug ────────────────────────────────
router.put('/:sid/slug', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(req.params.sid);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Sadece sunucu sahibi değiştirebilir' });

  let slug = String(req.body.slug || '').trim();
  if (!slug) {
    // Boş gönderilirse sunucu adından otomatik üret
    slug = slugify(server.name);
  } else {
    slug = slugify(slug);
  }
  if (slug.length < 2) return res.status(400).json({ error: 'Slug en az 2 karakter olmalı' });

  // Benzersizlik kontrolü
  const existing = await Servers.findOne({ slug });
  if (existing && existing._id !== server._id) {
    return res.status(409).json({ error: 'Bu slug kullanımda. Başka bir isim dene.' });
  }

  await Servers.update(server._id, { slug });
  res.json({ slug });
}));

// ── GET /s/:slug — Herkese açık HTML profil sayfası ──────────
router.get('/:slug', asyncHandler(async (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi,'').toLowerCase().slice(0, 40);
  if (!slug) return res.status(400).send('<h1>Geçersiz</h1>');

  const server = await Servers.findOne({ slug });
  if (!server) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><title>Sunucu Bulunamadı — Bridge</title>
<meta name="theme-color" content="#ed4245">
<style>body{background:#1a1b1e;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}</style>
</head><body><div><h1 style="font-size:3rem">😕</h1><h2>Sunucu bulunamadı</h2>
<p style="color:#b5bac1;margin:.5rem 0 1.5rem">Bu slug'a sahip bir sunucu yok.</p>
<a href="/" style="color:#5865f2">← Bridge'e git</a></div></body></html>`);
  }

  let memberList: any[] = [];
  let memberCount = 0;
  try {
    memberList = await Members.findByServer(server._id);
    memberCount = memberList.length;
  } catch {}

  let onlineCount = 0;
  try {
    const userIds = memberList.map(m => m.userId);
    const userRows = userIds.length ? await Users.findByIds(userIds) : [];
    onlineCount = userRows.filter(u => u.status === 'online').length;
  } catch {}

  // Kanallar (ilk 8 text kanal)
  let channels: any[] = [];
  try {
    const allChannels = await Channels.findWhere({ serverId: server._id, type: 'text' });
    channels = allChannels.slice(0, 8);
  } catch {}

  const instanceUrl  = (process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
  const instanceName = process.env.INSTANCE_NAME || 'Bridge';
  const safeName     = escHtml(server.name);
  const safeDesc     = escHtml(server.description || `${server.name} topluluğuna Bridge'de katıl!`);
  const safeIcon     = escHtml(server.icon || '🌐');
  const tags         = JSON.parse(server.tags || '[]');
  const ogImage      = `${instanceUrl}/api/servers/${server._id}/og-image`;
  const joinUrl      = `${instanceUrl}/?join=${encodeURIComponent(server._id)}`;
  const pageUrl      = `${instanceUrl}/s/${slug}`;

  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName} — Bridge</title>
  <meta name="description" content="${safeDesc}">

  <!-- Open Graph -->
  <meta property="og:type"        content="website">
  <meta property="og:url"         content="${pageUrl}">
  <meta property="og:title"       content="${safeName} — Bridge Topluluğu">
  <meta property="og:description" content="${safeDesc} · ${memberCount} üye">
  <meta property="og:image"       content="${ogImage}">
  <meta property="og:site_name"   content="${escHtml(instanceName)}">

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${safeName} — Bridge">
  <meta name="twitter:description" content="${safeDesc} · ${memberCount} üye">
  <meta name="twitter:image"       content="${ogImage}">

  <meta name="theme-color" content="#5865f2">

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #111214; color: #dcddde;
      min-height: 100dvh;
    }
    .banner {
      height: 200px;
      background: ${server.bannerUrl ? `url('${escHtml(server.bannerUrl)}') center/cover` : 'linear-gradient(135deg,#5865f2 0%,#3b43a0 100%)'};
      position: relative;
    }
    .container { max-width: 860px; margin: 0 auto; padding: 0 20px; }
    .profile-row {
      display: flex; align-items: flex-end; gap: 20px;
      padding: 0 0 20px; margin-top: -48px; position: relative;
    }
    .server-avatar {
      width: 96px; height: 96px; border-radius: 50%;
      background: #5865f2; border: 6px solid #111214;
      display: flex; align-items: center; justify-content: center;
      font-size: 2.8rem; flex-shrink: 0; overflow: hidden;
    }
    .server-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .server-info { flex: 1; padding-bottom: 4px; }
    .server-name { font-size: 1.6rem; font-weight: 800; color: #fff; }
    .server-meta { font-size: 13px; color: #b5bac1; margin-top: 4px; display: flex; gap: 14px; flex-wrap: wrap; }
    .dot { color: #23a55a; }
    .join-btn {
      display: inline-block; background: #5865f2; color: #fff;
      text-decoration: none; padding: 10px 28px;
      border-radius: 8px; font-size: 15px; font-weight: 700;
      transition: background .15s; white-space: nowrap;
    }
    .join-btn:hover { background: #4752c4; }
    .section { margin: 28px 0; }
    .section-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #b5bac1; margin-bottom: 12px;
    }
    .desc { font-size: 15px; color: #dcddde; line-height: 1.6; }
    .tags { display: flex; gap: 8px; flex-wrap: wrap; }
    .tag {
      background: #2b2d31; border-radius: 999px;
      padding: 4px 12px; font-size: 12px; color: #b5bac1;
    }
    .channels { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px,1fr)); gap: 8px; }
    .ch-card {
      background: #2b2d31; border-radius: 8px; padding: 10px 14px;
      font-size: 13px; color: #b5bac1; border: 1px solid #1e1f22;
    }
    .footer { text-align: center; padding: 40px 20px; color: #555; font-size: 13px; }
    .footer a { color: #5865f2; text-decoration: none; }
    @media (max-width: 600px) {
      .profile-row { flex-direction: column; align-items: flex-start; }
      .join-btn { width: 100%; text-align: center; }
    }
  </style>
</head>
<body>
  <div class="banner"></div>
  <div class="container">
    <div class="profile-row">
      <div class="server-avatar">
        ${server.iconUrl ? `<img src="${escHtml(server.iconUrl)}" alt="${safeName}">` : safeIcon}
      </div>
      <div class="server-info">
        <div class="server-name">${safeName}</div>
        <div class="server-meta">
          <span><span class="dot">●</span> ${onlineCount} çevrimiçi</span>
          <span>👥 ${memberCount} üye</span>
          ${server.discoverable ? '<span>🔍 Keşfedilebilir</span>' : ''}
        </div>
      </div>
      <a href="${joinUrl}" class="join-btn">Topluluğa Katıl</a>
    </div>

    ${safeDesc ? `
    <div class="section">
      <div class="section-title">Hakkında</div>
      <div class="desc">${safeDesc}</div>
    </div>` : ''}

    ${tags.length ? `
    <div class="section">
      <div class="section-title">Etiketler</div>
      <div class="tags">
        ${tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}
      </div>
    </div>` : ''}

    ${channels.length ? `
    <div class="section">
      <div class="section-title">Kanallar</div>
      <div class="channels">
        ${channels.map(c => `<div class="ch-card"># ${escHtml(c.name)}${c.topic ? `<div style="font-size:11px;color:#666;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(c.topic)}</div>` : ''}</div>`).join('')}
      </div>
    </div>` : ''}
  </div>

  <div class="footer">
    <p>Powered by <a href="${instanceUrl}">${escHtml(instanceName)}</a> — Açık kaynak, ücretsiz topluluk platformu</p>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
  res.send(html);
}));

module.exports = router;
export {};
