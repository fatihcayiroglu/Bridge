// server/jobs/autoModeration.ts
// Her 5 dakikada bir çalışır:
//  1. Son 5 dakikada gelen mesajları tarar
//  2. Kural tabanlı moderasyon uygular (AI olmadan da çalışır)
//  3. Şüpheli içerikleri sunucunun "mod-log" kanalına bildirir
//  4. AI aktifse yüksek riskli mesajları AI ile de kontrol eder

import { v4 as uuidv4 } from 'uuid';
import type { Server as SocketServer } from 'socket.io';

import { Channels, Servers, Messages, Users } from '../db/repositories';
import { rulesMod } from '../lib/modRules';
import { callAI, AI_ENABLED } from '../lib/aiProvider';
import logger from '../lib/logger';
// Sprint 122 FIX 7: atomik mod-log upsert için db loader
import db from '../db/loader';

interface ChannelRow { _id: string; serverId: string; name: string }
interface ServerRow  { _id: string; autoModerate?: boolean }
interface MsgRow {
  _id: string;
  channelId: string;
  serverId?: string;
  userId: string;
  content?: string;
  displayName?: string;
  username?: string;
  type?: string;
  autoModAlert?: boolean;
}
interface ModResult {
  safe: boolean;
  score: number;
  reason?: string;
  categories?: Record<string, boolean>;
  source?: string;
}

const JOB_INTERVAL_MS = 5 * 60 * 1000;
const SCAN_WINDOW_MS  = 5 * 60 * 1000;

let _io: SocketServer | null = null;

// ── AI moderasyon (opsiyonel) ──────────────────────────────────
async function aiMod(content: string): Promise<ModResult | null> {
  if (!AI_ENABLED || !content) return null;
  const systemPrompt = 'İçerik moderasyonu. Sadece JSON döndür: {"safe":bool,"score":0-100,"reason":"Türkçe kısa açıklama"}';
  const userPrompt   = `"${content.slice(0, 300)}"`;
  try {
    const raw = await callAI(systemPrompt, userPrompt, 80);
    return JSON.parse(raw.replace(/```json|```/g, '').trim()) as ModResult;
  } catch {
    return null;
  }
}

// ── Mod-log kanalını bul ya da oluştur ────────────────────────
// Sprint 122 FIX 7: PostgreSQL ON CONFLICT ile atomik upsert — paralel job
// çalışmasında iki ayrı mod-log kanalı oluşmasını engeller.
async function getOrCreateModChannel(serverId: string): Promise<ChannelRow> {
  // PostgreSQL atomic path — race condition'dan korunur
  if ((db as unknown as { _pool?: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> } })._pool?.query) {
    const pool = (db as unknown as { _pool: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> } })._pool;
    const newId = uuidv4();
    const now = Date.now();
    // INSERT … ON CONFLICT DO NOTHING — eşzamanlı iki insert gelirse biri sessizce atlanır
    await pool.query(
      `INSERT INTO channels ("_id", "serverId", name, type, topic, category, "order", "modOnly", "createdAt")
       VALUES ($1, $2, 'mod-log', 'text', 'Otomatik moderasyon bildirimleri', 'MOD', 9999, true, $3)
       ON CONFLICT DO NOTHING`,
      [newId, serverId, now],
    );
    const { rows } = await pool.query<ChannelRow>(
      `SELECT * FROM channels WHERE "serverId" = $1 AND name ~ '^(mod[- ]log|moderasyon)' LIMIT 1`,
      [serverId],
    );
    if (rows[0]) return rows[0];
  }

  // Collection API fallback (PostgreSQL yoksa)
  const rows = await Channels.findWhere({
    serverId,
    name: { $regex: /^(mod[- ]log|moderasyon)/i },
  });
  const existing = rows?.[0] || null;
  if (existing) return existing;

  return Channels.insert({
    _id:       uuidv4(),
    serverId,
    name:      'mod-log',
    type:      'text',
    topic:     'Otomatik moderasyon bildirimleri',
    category:  'MOD',
    order:     9999,
    modOnly:   true,
    createdAt: Date.now(),
  });
}

// ── Mod kanalına sistem mesajı gönder ─────────────────────────
async function sendModAlert(
  serverId: string,
  channelId: string,
  flaggedMsg: MsgRow,
  result: ModResult,
  authorName: string,
): Promise<void> {
  const icon      = result.score < 40 ? '🚨' : '⚠️';
  const categories = Object.entries(result.categories || {})
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ') || 'genel';

  const content = [
    `${icon} **Otomatik Moderasyon Uyarısı**`,
    `👤 Kullanıcı: ${authorName}`,
    `💬 Mesaj: \`${(flaggedMsg.content || '').slice(0, 200)}\``,
    `📊 Risk skoru: ${result.score}/100`,
    `🏷️ Kategori: ${categories}`,
    `📝 Sebep: ${result.reason || '—'}`,
    result.source === 'ai' ? `🤖 Kaynak: [AI]` : `📏 Kaynak: Kural tabanlı`,
    `🔗 Mesaj ID: \`${flaggedMsg._id}\``,
  ].join('\n');

  const alertMsg = await Messages.create({
    _id:          uuidv4(),
    channelId,
    serverId,
    userId:       'system',
    username:     'AutoMod',
    displayName:  'AutoMod 🤖',
    avatarColor:  '#ed4245',
    content,
    type:         'system',
    reactions:    {},
    pinned:       false,
    createdAt:    Date.now(),
    autoModAlert: true,
    flaggedMsgId: flaggedMsg._id,
  });

  if (_io) {
    _io.to(`channel:${channelId}`).emit('message:new', alertMsg);
  }
}

// ── Ana tarama fonksiyonu ──────────────────────────────────────
async function runScan(): Promise<void> {
  const since = Date.now() - SCAN_WINDOW_MS;

  let recentMessages: MsgRow[];
  try {
    recentMessages = await Messages.findWhere({
      createdAt:    { $gte: since },
      type:         { $ne: 'system' },
      autoModAlert: { $ne: true },
    });
  } catch (e) {
    const err = e as Error;
    if (process.env.NODE_ENV !== 'test') {
      process.stderr.write(`[AutoMod] DB hatası: ${err.message}\n`);
    }
    return;
  }

  if (!recentMessages || recentMessages.length === 0) return;

  const byServer: Record<string, MsgRow[]> = {};
  for (const msg of recentMessages) {
    if (!msg.serverId) continue;
    if (!byServer[msg.serverId]) byServer[msg.serverId] = [];
    byServer[msg.serverId].push(msg);
  }

  for (const [serverId, msgs] of Object.entries(byServer)) {
    let server: ServerRow | null;
    try {
      server = await Servers.findById(serverId);
    } catch { continue; }

    if (!server?.autoModerate) continue;

    let modChannelId: string | null = null;

    for (const msg of msgs) {
      if (msg.type === 'system' || msg.autoModAlert) continue;
      const ruleResult = rulesMod(msg.content || '');

      let finalResult: ModResult = ruleResult;
      if (!ruleResult.safe || ruleResult.score >= 70) {
        if (AI_ENABLED) {
          const aiResult = await aiMod(msg.content || '');
          if (aiResult) {
            if (!aiResult.safe || aiResult.score > ruleResult.score) {
              finalResult = { ...aiResult, source: 'ai' };
            } else {
              finalResult = { ...ruleResult, source: 'rules' };
            }
          } else {
            finalResult = { ...ruleResult, source: 'rules' };
          }
        } else {
          finalResult = { ...ruleResult, source: 'rules' };
        }
      }

      if (finalResult.safe && finalResult.score < 70) continue;

      if (!modChannelId) {
        try {
          const modCh = await getOrCreateModChannel(serverId);
          modChannelId = modCh._id;
        } catch { continue; }
      }

      let authorName = msg.displayName || msg.username || 'Bilinmiyor';
      try {
        const author = await Users.findById(msg.userId);
        if (author) authorName = author.displayName || author.username;
      } catch { /* ignore */ }

      try {
        await sendModAlert(serverId, modChannelId, msg, finalResult, authorName);
      } catch { /* ignore */ }
    }
  }
}

// ── Job başlatıcı ──────────────────────────────────────────────
let _automodInterval: ReturnType<typeof setInterval> | null = null;
let _automodInitTimer: ReturnType<typeof setTimeout> | null = null;

export function startAutoModerationJob(io: SocketServer): void {
  _io = io;
  if (_automodInitTimer !== null || _automodInterval !== null) return;

  _automodInitTimer = setTimeout(() => {
    _automodInitTimer = null;
    void runScan();
    _automodInterval = setInterval(() => void runScan(), JOB_INTERVAL_MS);
    _automodInterval.unref?.();
  }, 30_000);
  _automodInitTimer.unref?.();

  if (process.env.NODE_ENV !== 'test') {
    process.stdout.write('   ✅ Auto Moderation Job (5dk aralık)\n');
  }
}

// Sprint 98: Graceful shutdown desteği
export function stopAutoModerationJob(): void {
  if (_automodInitTimer !== null) {
    clearTimeout(_automodInitTimer);
    _automodInitTimer = null;
  }
  if (_automodInterval !== null) {
    clearInterval(_automodInterval);
    _automodInterval = null;
    if (process.env.NODE_ENV !== 'test') {
      process.stdout.write('[AutoMod] Job durduruldu\n');
    }
  }
}

export { runScan };
