#!/usr/bin/env node
// @ts-nocheck
// server/db/migrate-to-postgres.js
// SQLite bridge.db → PostgreSQL tek seferlik migration
//
// KULLANIM:
//   DATABASE_URL=postgresql://user:pass@localhost:5432/bridge \
//   node db/migrate-to-postgres.js
//
//   # Sadece kontrol (veri yazmadan):
//   DRY_RUN=1 DATABASE_URL=... node db/migrate-to-postgres.js
//
// Güvenli: Mevcut SQLite'a dokunmaz. İdempotent (tekrar çalıştırılabilir).

'use strict';

require('dotenv').config();

const Database = require('better-sqlite3');
const { Pool }  = require('pg');
const path      = require('path');
const fs        = require('fs');

const SQLITE_PATH = path.join(__dirname, '../data/bridge.db');
const DRY_RUN     = process.env.DRY_RUN === '1';

if (!fs.existsSync(SQLITE_PATH)) {
  console.error('❌ SQLite dosyası bulunamadı:', SQLITE_PATH);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL tanımlı değil.');
  console.error('   Kullanım: DATABASE_URL=postgresql://user:pass@host/db node db/migrate-to-postgres.js');
  process.exit(1);
}

const sqlite = new Database(SQLITE_PATH, { readonly: true });
const pg     = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

function parseJson(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}
function boolify(val) { return val === 1 || val === true; }
function redactUrl(url) { return url?.replace(/:[^@]+@/, ':***@') || url; }

function progress(current, total, label) {
  const pct = Math.floor((current / total) * 100);
  const bar = String.fromCharCode(9608).repeat(Math.floor(pct / 5)).padEnd(20, String.fromCharCode(9617));
  process.stdout.write(`\r  [${bar}] ${pct}% — ${current}/${total} ${label}   `);
}

async function ensureSchema() {
  const pgDb = require('./postgres');
  await pgDb._initSchema();
}

async function migrateTable(tableName, transform = row => row) {
  let rows;
  try { rows = sqlite.prepare(`SELECT * FROM "${tableName}"`).all(); }
  catch { console.log(`  ⬜ ${tableName}: tablo yok, atlandı`); return { inserted: 0, skipped: 0, errors: 0 }; }

  if (!rows.length) { console.log(`  ⬜ ${tableName}: boş, atlandı`); return { inserted: 0, skipped: 0, errors: 0 }; }

  let inserted = 0, skipped = 0, errors = 0;
  const total = rows.length;

  for (let i = 0; i < rows.length; i++) {
    if (i % 100 === 0) progress(i, total, tableName);
    const transformed = transform(rows[i]);
    if (!transformed) { skipped++; continue; }
    const clean = Object.fromEntries(Object.entries(transformed).filter(([, v]) => v !== undefined));
    const keys = Object.keys(clean);
    if (!keys.length) { skipped++; continue; }
    if (DRY_RUN) { inserted++; continue; }
    const cols   = keys.map(k => `"${k}"`).join(', ');
    const phs    = keys.map((_, idx) => `$${idx + 1}`).join(', ');
    const values = keys.map(k => clean[k]);
    try {
      await pg.query(`INSERT INTO "${tableName}" (${cols}) VALUES (${phs}) ON CONFLICT DO NOTHING`, values);
      inserted++;
    } catch (err) {
      errors++;
      if (errors <= 3) { process.stdout.write('\n'); console.warn(`  ⚠️  Satır hatası (${tableName}): ${err.message.slice(0, 100)}`); }
    }
  }

  process.stdout.write('\n');
  const status = errors > 0 ? '⚠️ ' : '✅';
  console.log(`  ${status} ${tableName}: ${inserted} eklendi, ${skipped} atlandı, ${errors} hata`);
  return { inserted, skipped, errors };
}

const transforms = {
  users:               row => ({ ...row, twoFactorBackup: parseJson(row.twoFactorBackup, []), emailVerified: boolify(row.emailVerified), twoFactorEnabled: boolify(row.twoFactorEnabled), isAdmin: boolify(row.isAdmin) }),
  messages:            row => ({ ...row, reactions: parseJson(row.reactions, {}), replyTo: parseJson(row.replyTo, null), bridgedFrom: parseJson(row.bridgedFrom, null), editHistory: parseJson(row.editHistory, []), pinned: boolify(row.pinned) }),
  members:             row => ({ ...row, roles: parseJson(row.roles, []), verified: boolify(row.verified) }),
  servers:             row => ({ ...row, tags: parseJson(row.tags, []), discoverable: boolify(row.discoverable), verificationEnabled: boolify(row.verificationEnabled) }),
  dm_conversations:    row => ({ ...row, participants: parseJson(row.participants, []) }),
  server_gifs:         row => ({ ...row, tags: parseJson(row.tags, []) }),
  scheduled_msgs:      row => ({ ...row, sent: boolify(row.sent) }),
  channel_bridges:     row => ({ ...row, active: boolify(row.active) }),
  polls:               row => ({ ...row, options: parseJson(row.options, []), multiSelect: boolify(row.multiSelect), closed: boolify(row.closed) }),
  channel_categories:  row => ({ ...row, collapsed: boolify(row.collapsed) }),
  thread_messages:     row => ({ ...row, reactions: parseJson(row.reactions, {}) }),
  bots:                row => ({ ...row, events: parseJson(row.events, []), active: boolify(row.active), isPublic: boolify(row.isPublic) }),
  federation_peers:    row => ({ ...row, verified: boolify(row.verified) }),
  push_subscriptions:  row => ({ ...row, subscription: parseJson(row.subscription, {}), keys: parseJson(row.keys, {}) }),
  // v45+ tables
  group_dm_messages:   row => ({ ...row, reactions: parseJson(row.reactions, {}) }),
  group_dm_members:    row => row,
  group_dm_conversations: row => row,
  automod_rules:       row => ({ ...row, config: parseJson(row.config, {}), enabled: boolify(row.enabled) }),
  outgoing_webhooks:   row => ({ ...row, events: parseJson(row.events, ['message:new']), enabled: boolify(row.enabled) }),
  server_onboarding:   row => ({ ...row, enabled: boolify(row.enabled), defaultRoles: parseJson(row.defaultRoles, []), questions: parseJson(row.questions, []) }),
  onboarding_completions: row => ({ ...row, answers: parseJson(row.answers, {}) }),
  reaction_roles:      row => row,
  blocks:              row => row,
  user_connections:    row => ({ ...row, verified: boolify(row.verified) }),
  ap_follows:          row => row,
  ap_activities:       row => ({ ...row, activity: parseJson(row.activity, {}) }),
  ap_messages:         row => row,
  webauthn_credentials: row => ({ ...row, transports: parseJson(row.transports, []) }),
  webhooks:            row => row,
  channel_permissions: row => row,
  fcm_tokens:          row => row,
  bot_ratings:         row => row,
  server_bots:         row => row,
  admin_logs:          row => ({ ...row, meta: parseJson(row.meta, {}) }),
  audit_logs:          row => ({ ...row, meta: parseJson(row.meta, {}) }),
  unread_counts:       row => row,
  notification_prefs:  row => ({ ...row, muted: boolify(row.muted) }),
  channel_overrides:   row => row,
  roles:               row => ({ ...row, hoist: boolify(row.hoist) }),
  threads:             row => ({ ...row, tags: parseJson(row.tags, []), pinned: boolify(row.pinned), locked: boolify(row.locked) }),
  soundboard:          row => row,
  friendships:         row => row,
  invites:             row => row,
  voice_messages:      row => row,
  refresh_tokens:      row => row,
};

const MIGRATION_ORDER = [
  // Temel tablolar (foreign key bağımlılık sırasına göre)
  'users', 'servers', 'channels', 'channel_categories', 'members', 'roles',
  'channel_overrides', 'channel_permissions', 'invites',
  // Mesajlar
  'messages', 'threads', 'thread_messages',
  // DM
  'dm_conversations', 'dm_messages',
  'group_dm_conversations', 'group_dm_members', 'group_dm_messages',
  // Sunucu içeriği
  'server_gifs', 'server_emojis', 'scheduled_msgs', 'channel_bridges',
  'polls', 'soundboard', 'reaction_roles',
  // Sosyal
  'friendships', 'blocks', 'user_connections',
  // Bildirim / token
  'notification_prefs', 'unread_counts', 'push_subscriptions', 'fcm_tokens',
  // Log
  'audit_logs', 'admin_logs',
  // Bot & webhook
  'bots', 'bot_ratings', 'server_bots', 'webhooks', 'outgoing_webhooks',
  // Ses
  'voice_messages',
  // Onboarding & otomasyon
  'server_onboarding', 'onboarding_completions', 'automod_rules',
  // Federation
  'federation_peers', 'ap_follows', 'ap_activities', 'ap_messages',
  // Auth & güvenlik
  'refresh_tokens', 'webauthn_credentials',
];

async function main() {
  const startTime = Date.now();
  console.log('\n🌉 Bridge SQLite → PostgreSQL Migration');
  if (DRY_RUN) console.log('   ⚠️  DRY RUN modu — veritabanına yazılmaz\n');
  console.log(`📂 Kaynak : ${SQLITE_PATH}`);
  console.log(`🐘 Hedef  : ${redactUrl(process.env.DATABASE_URL)}\n`);

  try { await pg.query('SELECT 1'); console.log('✅ PostgreSQL bağlantısı başarılı\n'); }
  catch (err) { console.error('❌ PostgreSQL bağlantı hatası:', err.message); process.exit(1); }

  const sqliteTables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map(r => r.name);
  console.log(`📊 SQLite tabloları: ${sqliteTables.length} adet`);
  console.log(`   ${sqliteTables.join(', ')}\n`);

  if (!DRY_RUN) { console.log('📋 PostgreSQL schema kuruluyor...'); await ensureSchema(); console.log('✅ Schema hazır\n'); }

  console.log('📦 Tablolar aktarılıyor...\n');
  let totalInserted = 0, totalErrors = 0;
  for (const table of MIGRATION_ORDER) {
    const result = await migrateTable(table, transforms[table] || (row => row));
    totalInserted += result.inserted;
    totalErrors   += result.errors;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '-'.repeat(50));
  console.log(`✅ Migration ${DRY_RUN ? '(DRY RUN) ' : ''}tamamlandı!`);
  console.log(`   Toplam satır : ${totalInserted}`);
  console.log(`   Hatalı satır : ${totalErrors}`);
  console.log(`   Süre         : ${elapsed}s`);
  if (!DRY_RUN) {
    console.log('\n📌 Sonraki adım:');
    console.log('   .env dosyasındaki DATABASE_URL aktif olduğunda sunucu otomatik PostgreSQL kullanır.');
    console.log('   (db/loader.js DATABASE_URL varsa postgres seçer)\n');
  }

  sqlite.close();
  await pg.end();
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => { console.error('\n❌ Migration hatası:', err.message); process.exit(1); });
export {};
