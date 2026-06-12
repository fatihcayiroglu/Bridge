/**
 * @openapi
 * tags:
 *   - name: InvitePreview
 *     description: InvitePreview API endpoints

 *
 * /invite/{code}:
 *   get:
 *     tags: [Servers]
 *     summary: Davet onizleme sayfasi (OG meta + HTML)
 *     security: []
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Davet onizleme HTML sayfasi
 *         content:
 *           text/html:
 *             schema: { type: string }
 *       404: { $ref: '#/components/responses/NotFound' }
 */

// server/routes/invitePreview.ts.1
// GET /invite/:code
//
// Davet linkine gidildiğinde:
//  - Sunucu adı, üye sayısı ve ikonu içeren bir HTML sayfası döner
//  - Open Graph meta tag'leri sosyal medyada önizleme sağlar
//  - Twitter Card desteği
//  - Kullanıcı gerçek istemcideyse SPA'ya yönlendirme butonu gösterilir


import logger from '../lib/logger';
import express from 'express';
const router       = express.Router();
import { Invites, Servers, Members } from '../db/repositories';
import { escapeHtml } from '../lib/security';

// ── SSRF Koruması — iconUrl doğrulaması ──────────────────────
// iconUrl doğrudan OG image olarak kullanılıyor.
// Saldırgan internal URL (http://169.254.169.254) koyabilir.
const PRIVATE_IP_PATTERN = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|0\.0\.0\.0|169\.254\.)/i;

function isSafeIconUrl(url: unknown): url is string {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (PRIVATE_IP_PATTERN.test(u.hostname)) return false;
    return true;
  } catch { return false; }
}

// ── Sunucu ikonunu çöz (emoji veya URL olabilir) ──────────────
interface ServerRow { _id: string; name: string; description?: string; icon?: string | null; iconUrl?: string; }
function resolveIcon(server: ServerRow): { type: string; value: string } {
  if (server.iconUrl && isSafeIconUrl(server.iconUrl)) return { type: 'img', value: escapeHtml(server.iconUrl) };
  const icon = server.icon || '🌐';
  return { type: 'emoji', value: escapeHtml(icon) };
}

// ── HTML üret ─────────────────────────────────────────────────
function buildHtml({ server, memberCount, inviteCode, instanceName, instanceUrl }: { server: ServerRow; memberCount: number; inviteCode: string; instanceName: string; instanceUrl: string }): string {
  const safeName  = escapeHtml(server.name);
  const safeDesc  = escapeHtml(server.description || `${safeName} topluluğuna katıl!`);
  const icon      = resolveIcon(server);
  const joinUrl   = `${instanceUrl}/?invite=${encodeURIComponent(inviteCode)}`;
  const pageUrl   = `${instanceUrl}/invite/${encodeURIComponent(inviteCode)}`;
  const safeInst  = escapeHtml(instanceName);

  // OG image: eğer sunucunun bir iconUrl'si varsa onu kullan,
  // yoksa sunucu ismiyle bir placeholder URL oluştur
  const ogImage = (server.iconUrl && isSafeIconUrl(server.iconUrl))
    ? escapeHtml(server.iconUrl)
    : `${instanceUrl}/api/servers/${encodeURIComponent(server._id)}/og-image`;

  const iconHtml = icon.type === 'img'
    ? `<img src="${icon.value}" alt="${safeName} ikonu" class="server-icon-img">`
    : `<div class="server-icon-emoji" role="img" aria-label="${safeName} ikonu">${icon.value}</div>`;

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName} — Bridge Daveti</title>

  <!-- Open Graph -->
  <meta property="og:type"        content="website">
  <meta property="og:url"         content="${pageUrl}">
  <meta property="og:title"       content="${safeName} — Bridge'e katıl!">
  <meta property="og:description" content="${safeDesc} · ${memberCount} üye">
  <meta property="og:image"       content="${ogImage}">
  <meta property="og:site_name"   content="${safeInst}">

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary">
  <meta name="twitter:title"       content="${safeName} — Bridge'e katıl!">
  <meta name="twitter:description" content="${safeDesc} · ${memberCount} üye">
  <meta name="twitter:image"       content="${ogImage}">

  <!-- Theme color (Discord-style embed rengi) -->
  <meta name="theme-color" content="#2d9cdb">

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1b1e;
      color: #dcddde;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }

    .card {
      background: #2b2d31;
      border-radius: 16px;
      padding: 2.5rem 2rem;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,.45);
    }

    .server-icon-img {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      object-fit: cover;
      margin-bottom: 1rem;
    }

    .server-icon-emoji {
      font-size: 4rem;
      line-height: 1;
      margin-bottom: 1rem;
    }

    .server-name {
      font-size: 1.5rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: .4rem;
    }

    .server-desc {
      font-size: .9rem;
      color: #b5bac1;
      margin-bottom: 1.2rem;
      line-height: 1.5;
    }

    .badges {
      display: flex;
      justify-content: center;
      gap: .6rem;
      flex-wrap: wrap;
      margin-bottom: 1.8rem;
    }

    .badge {
      background: #383a40;
      border-radius: 999px;
      padding: .3rem .85rem;
      font-size: .78rem;
      color: #b5bac1;
      display: flex;
      align-items: center;
      gap: .35rem;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #23a55a;
      flex-shrink: 0;
    }

    .btn-join {
      display: inline-block;
      background: #2d9cdb;
      color: #fff;
      text-decoration: none;
      padding: .75rem 2rem;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      transition: background .15s;
      width: 100%;
    }

    .btn-join:hover { background: #1a6b8a; }

    .footer {
      margin-top: 1.2rem;
      font-size: .75rem;
      color: #6d6f78;
    }
  </style>
</head>
<body>
  <div class="card">
    ${iconHtml}
    <div class="server-name">${safeName}</div>
    <div class="server-desc">${safeDesc}</div>
    <div class="badges">
      <span class="badge"><span class="dot"></span>${memberCount} üye</span>
    </div>
    <a href="${joinUrl}" class="btn-join">Sunucuya Katıl</a>
    <p class="footer">Bridge üzerinden • ${safeInst}</p>
  </div>
</body>
</html>`;
}

// ── GET /invite/:code ─────────────────────────────────────────
router.get('/:code', async (req, res) => {
  const code = String(String(req.params.code ?? '') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!code) return res.status(400).send('<h1>Geçersiz davet kodu</h1>');

  const invite = await Invites.findByCode(code);
  if (!invite) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8">
<title>Geçersiz Davet</title>
<meta name="theme-color" content="#ed4245">
<style>body{background:#1a1b1e;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}</style>
</head><body><div><h1 style="font-size:3rem">😕</h1><h2>Bu davet geçersiz veya süresi dolmuş</h2><p style="color:#b5bac1;margin-top:.5rem">Davet kodu bulunamadı.</p></div></body></html>`);
  }

  if (invite.expiresAt < Date.now()) {
    return res.status(410).send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8">
<title>Süresi Dolmuş Davet</title>
<meta name="theme-color" content="#ed4245">
<style>body{background:#1a1b1e;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}</style>
</head><body><div><h1 style="font-size:3rem">⏰</h1><h2>Bu davetin süresi dolmuş</h2><p style="color:#b5bac1;margin-top:.5rem">Yeni bir davet linki isteyin.</p></div></body></html>`);
  }

  const server = await Servers.findById(invite.serverId);
  if (!server) return res.status(404).send('<h1>Sunucu bulunamadı</h1>');

  // Üye sayısını al
  let memberCount = 0;
  try {
    memberCount = await Members.countWhere({ serverId: server._id });
  } catch {
    try {
      const members = await Members.findByServer(server._id);
      memberCount = members.length;
    } catch (err) {
      logger.warn({ err, serverId: server._id, event: 'invitePreview.memberCount.error' },
        'Failed to fetch member count for invite preview — defaulting to 0');
    }
  }

  const instanceName = process.env.INSTANCE_NAME || 'Bridge';
  const instanceUrl  = (process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`)
    .replace(/\/$/, '');

  const html = buildHtml({ server: server as unknown as ServerRow, memberCount, inviteCode: code, instanceName, instanceUrl });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Önbellek: 5 dakika (üye sayısı sık değişebilir)
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
  res.send(html);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
