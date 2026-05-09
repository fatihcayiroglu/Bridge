// @ts-nocheck
// server/jobs/autoModeration.ts
// Her 5 dakikada bir çalışır:
//  1. Son 5 dakikada gelen mesajları tarar
//  2. Kural tabanlı moderasyon uygular (AI olmadan da çalışır)
//  3. Şüpheli içerikleri sunucunun "mod-log" kanalına bildirir
//  4. AI aktifse yüksek riskli mesajları AI ile de kontrol eder

import { Channels, Servers, Messages, Users } from '../db/repositories';
import { v4 as uuidv4 } from 'uuid';
import { rulesMod }   from '../lib/modRules';
import { callAI, AI_ENABLED } from '../lib/aiProvider';
import logger from '../lib/logger';

const JOB_INTERVAL_MS = 5 * 60 * 1000;
const SCAN_WINDOW_MS  = 5 * 60 * 1000;

let _io: import('socket.io').Server | null = null;

// ── AI moderasyon (opsiyonel) ──────────────────────────────────
async function aiMod(content) {
  if (!AI_ENABLED || !content) return null;

  const systemPrompt = 'İçerik moderasyonu. Sadece JSON döndür: {"safe":bool,"score":0-100,"reason":"Türkçe kısa açıklama"}';
  const userPrompt   = `"${content.slice(0, 300)}"`;

  try {
    const raw = await callAI(systemPrompt, userPrompt, 80);
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    // AI ulaşılamaz → kural sonucu yeterli
    return null;
  }
}

// ── Mod-log kanalını bul ya da oluştur ────────────────────────
async function getOrCreateModChannel(serverId) {
  // Önce var olan mod kanalını bul (isim: mod-log, mod-logs, moderasyon)
  const existing = await Channels.findWhere({
    serverId,
    name: { $regex: /^(mod[- ]log|moderasyon)/i },
  }).then(rows => rows?.[0] || null);
  if (existing) return existing;

  const channel = await Channels.insert({
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
  return channel;
}

// ── Mod kanalına sistem mesajı gönder ─────────────────────────
async function sendModAlert(serverId, channelId, flaggedMsg, result, authorName) {
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
    _id:         uuidv4(),
    channelId,
    serverId,
    userId:      'system',
    username:    'AutoMod',
    displayName: 'AutoMod 🤖',
    avatarColor: '#ed4245',
    content,
    type:        'system',
    reactions:   {},
    pinned:      false,
    createdAt:   Date.now(),
    autoModAlert: true,
    flaggedMsgId: flaggedMsg._id,
  });

  // Socket üzerinden mod kanalına bildir
  if (_io) {
    _io.to(`channel:${channelId}`).emit('message:new', alertMsg);
  }

  return alertMsg;
}

// ── Ana tarama fonksiyonu ──────────────────────────────────────
async function runScan() {
  const since = Date.now() - SCAN_WINDOW_MS;

  let recentMessages;
  try {
    recentMessages = await Messages.findWhere({
      createdAt: { $gte: since },
      type:      { $ne: 'system' },
      autoModAlert: { $ne: true }, // kendi uyarılarımızı tarama
    });
  } catch (err) {
    // DB erişim hatası — sessizce geç
    if (process.env.NODE_ENV !== 'test') {
      process.stderr.write(`[AutoMod] DB hatası: ${err.message}\n`);
    }
    return;
  }

  if (!recentMessages || recentMessages.length === 0) return;

  // Sunucu bazında grupla (her sunucu için autoModerate kontrolü)
  const byServer = {};
  for (const msg of recentMessages) {
    if (!msg.serverId) continue;
    if (!byServer[msg.serverId]) byServer[msg.serverId] = [];
    byServer[msg.serverId].push(msg);
  }

  for (const [serverId, msgs] of Object.entries(byServer)) {
    // Sunucuda autoModerate aktif mi?
    let server;
    try {
      server = await Servers.findById(serverId);
    } catch { continue; }

    if (!server?.autoModerate) continue;

    let modChannelId = null;

    for (const msg of msgs) {
      const ruleResult = rulesMod(msg.content);

      // Skor 70+ ise riskli — AI ile de doğrula
      let finalResult = ruleResult;
      if (!ruleResult.safe || ruleResult.score >= 70) {
        if (AI_ENABLED) {
          const aiResult = await aiMod(msg.content);
          if (aiResult) {
            // AI daha yüksek skor verdiyse veya güvensiz dediyse AI'yı tercih et
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

      // Güvenli ve düşük riskli mesajları geç
      if (finalResult.safe && finalResult.score < 70) continue;

      // Mod kanalını bir kez bul/oluştur
      if (!modChannelId) {
        try {
          const modCh = await getOrCreateModChannel(serverId);
          modChannelId = modCh._id;
        } catch { continue; }
      }

      // Yazar adını bul
      let authorName = msg.displayName || msg.username || 'Bilinmiyor';
      try {
        const author = await Users.findById(msg.userId);
        if (author) authorName = author.displayName || author.username;
      } catch {}

      // Uyarı gönder
      try {
        await sendModAlert(serverId, modChannelId, msg, finalResult, authorName);
      } catch {}
    }
  }
}

// ── Job başlatıcı ──────────────────────────────────────────────
function startAutoModerationJob(io: import('socket.io').Server): void {
  _io = io;

  // İlk çalışmayı 30s geciktir (sunucu tam başlasın)
  setTimeout(() => {
    runScan();
    setInterval(runScan, JOB_INTERVAL_MS);
  }, 30_000);

  if (process.env.NODE_ENV !== 'test') {
    process.stdout.write('   ✅ Auto Moderation Job (5dk aralık)\n');
  }
}

export { startAutoModerationJob, runScan, rulesMod };
