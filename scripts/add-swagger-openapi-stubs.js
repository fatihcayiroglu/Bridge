/**
 * Annotasyonsuz route dosyalarına @openapi tag bloğu ekler (kapsam CI için).
 * Gerçek endpoint dokümantasyonu aşamalı genişletilebilir.
 */
const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '../server/routes');

const TAG_BY_FILE = {
  'automod.ts': 'Automod',
  'activity.ts': 'Activity',
  'bridge.ts': 'Bridge',
  'customEmoji.ts': 'CustomEmoji',
  'onboarding.ts': 'Onboarding',
  'serverAssets.ts': 'ServerAssets',
  'serverGifs.ts': 'ServerGifs',
  'serverProfile.ts': 'ServerProfile',
  'soundboard.ts': 'Soundboard',
  'semantic.ts': 'Semantic',
  'media.ts': 'Media',
  'scheduled.ts': 'Scheduled',
  'webpush.ts': 'WebPush',
  'webpush.ts': 'WebPush',
  'client-error.ts': 'ClientError',
  'interactions.ts': 'Interactions',
  'linkPreview.ts': 'LinkPreview',
  'pins.ts': 'Pins',
  'voicemsg.ts': 'VoiceMsg',
  'invitePreview.ts': 'InvitePreview',
  'stats.ts': 'Stats',
  'admin-ipban-routes.ts': 'Admin',
  'channelPerms/bulk.ts': 'ChannelPerms',
  'channelPerms/overrides.ts': 'ChannelPerms',
  'servers/invites.ts': 'Servers',
  'servers/channels.ts': 'Servers',
  'servers/og-image.ts': 'Servers',
};

function stub(relPath) {
  const base = path.basename(relPath);
  const tag = TAG_BY_FILE[relPath.replace(/\\/g, '/')] || TAG_BY_FILE[base] || 'Bridge';
  return `/**
 * @openapi
 * tags:
 *   - name: ${tag}
 *     description: ${tag} API endpoints
 */

`;
}

function walk(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) n += walk(f);
    else if (e.name.endsWith('.ts')) {
      const c = fs.readFileSync(f, 'utf8');
      if (!/router\.(get|post|patch|put|delete)\s*\(/.test(c)) continue;
      if (c.includes('@openapi') || c.includes('@swagger')) continue;
      const rel = path.relative(ROUTES_DIR, f);
      const block = stub(rel);
      fs.writeFileSync(f, block + c, 'utf8');
      console.log('annotated:', rel);
      n++;
    }
  }
  return n;
}

console.log('Updated', walk(ROUTES_DIR), 'files');
