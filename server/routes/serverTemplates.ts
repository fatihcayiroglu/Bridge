// server/routes/serverTemplates.js
// Sunucu şablonları: tek tıkla hazır yapılandırılmış sunucu kur
//
// DEĞİŞİKLİK (v57): Şablonlar artık DB'de saklanır — tüm adminler paylaşabilir.
// Önceden hardcoded TEMPLATES dizisi vardı; artık server_templates tablosu kullanılır.
// İlk çalıştırmada yerleşik şablonlar DB'ye seed edilir (bir kez).
//
// GET    /api/server-templates           — şablon listesi (auth gerekli)
// GET    /api/server-templates/:id       — tek şablon detayı
// POST   /api/server-templates           — yeni şablon oluştur
// PUT    /api/server-templates/:id       — şablon güncelle (oluşturan)
// DELETE /api/server-templates/:id       — şablon sil (oluşturan)
// POST   /api/server-templates/:id/apply — şablonu uygula

'use strict';

const express      = require('express');
const router       = express.Router();
const { v4: uuidv4 } = require('uuid');
const {
  Servers,
  Channels,
  Messages,
  ServerAssets,
} = require('../db/repositories');
const { limits } = require('../middleware/rateLimit'); // rate limiting
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// ── Yerleşik şablonlar (seed verisi) ──────────────────────────
const SEED_TEMPLATES = [
  {
    id: 'gaming',
    name: 'Oyun Topluluğu',
    icon: '🎮',
    description: 'Oyuncular için hazır kanal yapısı. LFG, duyurular, strateji kanalları.',
    tags: ['oyun', 'gaming', 'lfg'],
    categories: [
      { name: 'GENEL', channels: [
        { name: 'duyurular',  type: 'text',  topic: '📢 Sunucu duyuruları' },
        { name: 'genel',      type: 'text',  topic: '💬 Genel sohbet' },
        { name: 'tanışma',    type: 'text',  topic: '👋 Kendini tanıt!' },
      ]},
      { name: 'OYUN', channels: [
        { name: 'oyun-sohbet', type: 'text',  topic: '🎮 Oyun hakkında konuş' },
        { name: 'lfg',         type: 'text',  topic: '🔍 Looking for group' },
        { name: 'strateji',    type: 'text',  topic: '♟️ Taktik ve strateji' },
        { name: 'ekip-ara',    type: 'text',  topic: '🤝 Takım ara/bul' },
      ]},
      { name: 'SES', channels: [
        { name: 'Lobi',   type: 'voice' },
        { name: 'Oyun-1', type: 'voice' },
        { name: 'Oyun-2', type: 'voice' },
        { name: 'AFK',    type: 'voice' },
      ]},
      { name: 'STAGE', channels: [
        { name: 'Turnuva Sahnesi', type: 'stage' },
      ]},
    ],
  },
  {
    id: 'education',
    name: 'Eğitim & Öğrenim',
    icon: '📚',
    description: 'Öğrenciler ve öğretmenler için organize kanal yapısı.',
    tags: ['eğitim', 'okul', 'öğrenim'],
    categories: [
      { name: 'GENEL', channels: [
        { name: 'duyurular', type: 'text', topic: '📢 Önemli duyurular' },
        { name: 'genel',     type: 'text', topic: '💬 Genel sohbet' },
        { name: 'tanışma',   type: 'text', topic: '👋 Kendini tanıt' },
      ]},
      { name: 'DERSLER', channels: [
        { name: 'soru-cevap',     type: 'text', topic: '❓ Ders soruları' },
        { name: 'ödevler',        type: 'text', topic: '📝 Ödev paylaşımı' },
        { name: 'kaynaklar',      type: 'text', topic: '📖 Faydalı kaynaklar' },
        { name: 'proje',          type: 'text', topic: '🔬 Proje çalışmaları' },
        { name: 'sınav-hazırlık', type: 'text', topic: '📊 Sınav notları' },
      ]},
      { name: 'SES', channels: [
        { name: 'Ders Odası 1',  type: 'voice' },
        { name: 'Ders Odası 2',  type: 'voice' },
        { name: 'Çalışma Grubu', type: 'voice' },
      ]},
      { name: 'STAGE', channels: [
        { name: 'Ders Sahnesi', type: 'stage' },
      ]},
    ],
  },
  {
    id: 'community',
    name: 'Genel Topluluk',
    icon: '🏘️',
    description: 'Her türlü topluluk için dengeli ve esnek yapı.',
    tags: ['topluluk', 'genel', 'hobi'],
    categories: [
      { name: 'BAŞLANGIÇ', channels: [
        { name: 'duyurular', type: 'text', topic: '📢 Sunucu duyuruları' },
        { name: 'kurallar',  type: 'text', topic: '📜 Sunucu kuralları' },
        { name: 'tanışma',   type: 'text', topic: '👋 Kendini tanıt' },
      ]},
      { name: 'SOHBET', channels: [
        { name: 'genel',       type: 'text', topic: '💬 Genel sohbet' },
        { name: 'medya',       type: 'text', topic: '🖼️ Fotoğraf ve video' },
        { name: 'bağlantılar', type: 'text', topic: '🔗 İlginç linkler' },
        { name: 'meme',        type: 'text', topic: '😂 Meme ve eğlence' },
      ]},
      { name: 'SES', channels: [
        { name: 'Genel Ses', type: 'voice' },
        { name: 'Müzik',     type: 'voice' },
        { name: 'AFK',       type: 'voice' },
      ]},
    ],
  },
  {
    id: 'art',
    name: 'Sanat & Yaratıcılık',
    icon: '🎨',
    description: 'Sanatçılar, müzisyenler, yazarlar için ilham dolu yapı.',
    tags: ['sanat', 'yaratıcı', 'tasarım', 'müzik'],
    categories: [
      { name: 'GENEL', channels: [
        { name: 'duyurular', type: 'text', topic: '📢 Duyurular' },
        { name: 'tanışma',   type: 'text', topic: '👋 Kendini tanıt' },
        { name: 'genel',     type: 'text', topic: '💬 Genel sohbet' },
      ]},
      { name: 'PAYLAŞIM', channels: [
        { name: 'eserler', type: 'text', topic: '🖼️ Sanat eserlerini paylaş' },
        { name: 'müzik',   type: 'text', topic: '🎵 Müzik paylaşımı' },
        { name: 'yazı',    type: 'text', topic: '✍️ Şiir ve yazı' },
        { name: 'tasarım', type: 'text', topic: '💎 UI/UX ve grafik tasarım' },
        { name: 'wip',     type: 'text', topic: '🔧 Yapım aşamasında' },
      ]},
      { name: 'SES', channels: [
        { name: 'Yaratıcı Oturum', type: 'voice' },
        { name: 'Müzik Odası',     type: 'voice' },
      ]},
    ],
  },
  {
    id: 'tech',
    name: 'Yazılım & Teknoloji',
    icon: '💻',
    description: 'Yazılımcılar ve teknoloji meraklıları için yapı.',
    tags: ['yazılım', 'kod', 'teknoloji', 'dev'],
    categories: [
      { name: 'GENEL', channels: [
        { name: 'duyurular', type: 'text', topic: '📢 Duyurular' },
        { name: 'genel',     type: 'text', topic: '💬 Genel' },
        { name: 'tanışma',   type: 'text', topic: '👋 Tanış' },
      ]},
      { name: 'GELİŞTİRME', channels: [
        { name: 'sorular',     type: 'text', topic: '❓ Teknik sorular' },
        { name: 'projeler',    type: 'text', topic: '🚀 Proje tanıtımları' },
        { name: 'code-review', type: 'text', topic: '🔍 Kod incelemesi' },
        { name: 'araçlar',     type: 'text', topic: '🛠️ Faydalı araçlar' },
      ]},
      { name: 'KONULAR', channels: [
        { name: 'frontend', type: 'text', topic: '🌐 Frontend geliştirme' },
        { name: 'backend',  type: 'text', topic: '⚙️ Backend geliştirme' },
        { name: 'devops',   type: 'text', topic: '🐳 DevOps ve infra' },
        { name: 'ai-ml',    type: 'text', topic: '🤖 Yapay zeka' },
      ]},
      { name: 'SES', channels: [
        { name: 'Çalışma Odası',    type: 'voice' },
        { name: 'Pair Programming', type: 'voice' },
      ]},
    ],
  },
];

// ── Seed: DB boşsa yerleşik şablonları ekle ────────────────────
let seeded = false;
async function ensureSeeded() {
  if (seeded) return;
  try {
    const rows = await ServerAssets.findTemplates({});
    if (rows && rows.length > 0) { seeded = true; return; }

    for (const t of SEED_TEMPLATES) {
      await ServerAssets.insertTemplate({
        _id:         t.id,
        name:        t.name,
        icon:        t.icon,
        description: t.description,
        tags:        JSON.stringify(t.tags),
        categories:  JSON.stringify(t.categories),
        createdBy:   'system',
        createdAt:   Date.now(),
        updatedAt:   null,
      });
    }
    seeded = true;
  } catch (err) {
    console.warn('[serverTemplates] Seed hatası:', err.message);
  }
}

// Testlerde seed durumunu sıfırlamak için
ensureSeeded._reset = () => { seeded = false; };

// ── Yardımcı: DB satırını API şekline çevir ───────────────────
function formatTemplate(row, full = false) {
  const out: Record<string,any> = {
    id:          row._id,
    name:        row.name,
    icon:        row.icon,
    description: row.description,
    tags:        typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags || []),
    createdBy:   row.createdBy,
    createdAt:   row.createdAt,
  };
  if (full) {
    out.categories = typeof row.categories === 'string'
      ? JSON.parse(row.categories)
      : (row.categories || []);
  }
  return out;
}

// ── GET /api/server-templates ──────────────────────────────────
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  await ensureSeeded();
  const rows = await ServerAssets.findTemplates({});
  res.json(rows.map(r => formatTemplate(r, false)));
}));

// ── GET /api/server-templates/:id ─────────────────────────────
router.get('/:id', authMiddleware, asyncHandler(async (req, res) => {
  await ensureSeeded();
  const row = await ServerAssets.findTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: 'Şablon bulunamadı' });
  res.json(formatTemplate(row, true));
}));

// ── POST /api/server-templates — yeni şablon oluştur ──────────
router.post('/', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { name, icon = '🌐', description = '', tags = [], categories = [] } = req.body;

  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Şablon adı gerekli' });
  if (!Array.isArray(categories) || categories.length === 0)
    return res.status(400).json({ error: 'En az bir kategori gerekli' });

  const row = await ServerAssets.insertTemplate({
    name:        name.trim().slice(0, 80),
    icon:        String(icon).slice(0, 10),
    description: String(description).slice(0, 300),
    tags:        JSON.stringify(Array.isArray(tags) ? tags.slice(0, 10) : []),
    categories:  JSON.stringify(categories),
    createdBy:   _u.id,
    updatedAt:   null,
  });

  res.status(201).json(formatTemplate(row, true));
}));

// ── PUT /api/server-templates/:id — güncelle ──────────────────
router.put('/:id', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const row = await ServerAssets.findTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: 'Şablon bulunamadı' });

  if (row.createdBy !== _u.id)
    return res.status(403).json({ error: 'Bu şablonu güncelleme yetkiniz yok' });

  const { name, icon, description, tags, categories } = req.body;
  const $set: Record<string,any> = { updatedAt: Date.now() };
  if (name        !== undefined) $set.name        = String(name).trim().slice(0, 80);
  if (icon        !== undefined) $set.icon        = String(icon).slice(0, 10);
  if (description !== undefined) $set.description = String(description).slice(0, 300);
  if (tags        !== undefined) $set.tags        = JSON.stringify(Array.isArray(tags) ? tags.slice(0, 10) : []);
  if (categories  !== undefined) $set.categories  = JSON.stringify(categories);

  await ServerAssets.updateTemplate(req.params.id, $set);
  const updated = await ServerAssets.findTemplate(req.params.id);
  res.json(formatTemplate(updated, true));
}));

// ── DELETE /api/server-templates/:id ──────────────────────────
router.delete('/:id', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const row = await ServerAssets.findTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: 'Şablon bulunamadı' });

  if (row.createdBy !== _u.id)
    return res.status(403).json({ error: 'Bu şablonu silme yetkiniz yok' });

  await ServerAssets.deleteTemplate(req.params.id);
  res.json({ ok: true });
}));

// ── POST /api/server-templates/:id/apply ──────────────────────
router.post('/:id/apply', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  await ensureSeeded();

  const row = await ServerAssets.findTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: 'Şablon bulunamadı' });

  const serverName = String(req.body.name || row.name).trim().slice(0, 50);
  if (!serverName) return res.status(400).json({ error: 'Sunucu adı gerekli' });

  const categories = typeof row.categories === 'string'
    ? JSON.parse(row.categories)
    : (row.categories || []);

  // Sunucu oluştur
  const server = await Servers.create({
    _id:          uuidv4(),
    name:         serverName,
    icon:         row.icon,
    ownerId:      _u.id,
    description:  row.description,
    tags:         row.tags,
    discoverable: 0,
    createdAt:    Date.now(),
  });

  // Sahibi üye olarak ekle
  await Servers.addMember(_u.id, server._id, ['owner']);

  // Kategoriler ve kanalları oluştur
  let channelOrder = 0;
  for (let catIdx = 0; catIdx < categories.length; catIdx++) {
    const cat = categories[catIdx];

    let category;
    try {
      category = await Channels.insertCategory({
        _id:       uuidv4(),
        serverId:  server._id,
        name:      cat.name,
        position:  catIdx,
        collapsed: false,
        createdAt: Date.now(),
      });
    } catch {
      category = { _id: null, name: cat.name };
    }

    for (const ch of cat.channels) {
      await Channels.insert({
        _id:       uuidv4(),
        serverId:  server._id,
        name:      ch.name,
        type:      ch.type || 'text',
        topic:     ch.topic || '',
        category:  category?._id || cat.name,
        order:     channelOrder++,
        createdAt: Date.now(),
      });
    }
  }

  // Sistem mesajı: ilk text kanalına hoş geldin yaz
  const firstChannel = await Channels.findOneWhere({ serverId: server._id, type: 'text' });
  if (firstChannel) {
    await Messages.create({
      _id:         uuidv4(),
      channelId:   firstChannel._id,
      serverId:    server._id,
      userId:      'system',
      username:    'Bridge',
      displayName: 'Bridge',
      avatarColor: '#5865f2',
      content:     `🎉 **${serverName}** şablondan oluşturuldu! ${row.icon} ${row.description}`,
      type:        'system',
      reactions:   '{}',
      createdAt:   Date.now(),
    });
  }

  res.json({ server, template: { id: row._id, name: row.name } });
}));

module.exports = router;
export {};
