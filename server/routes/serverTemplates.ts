// server/routes/serverTemplates.ts
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


import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import { v4 as uuidv4 } from 'uuid';
import { Servers,
  Channels,
  Messages,
  ServerAssets, } from '../db/repositories';
import { limits } from '../middleware/rateLimit';
import { authMiddleware} from '../middleware/auth';
import logger from '../lib/logger';
import { envSafeInt } from '../lib/envNumbers';

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
  } catch (_err) { const err = _err as Error;
    logger.warn({ err, event: 'serverTemplates.seed.error' }, '[serverTemplates] Seed hatası')
  }
}

// Testlerde seed durumunu sıfırlamak için
ensureSeeded._reset = () => { seeded = false; };

// ── Yardımcı: DB satırını API şekline çevir ───────────────────
interface TemplateRow {
  _id: string;
  name: string;
  icon: string;
  description: string;
  tags: string | string[];
  createdBy: string;
  createdAt: number;
  usageCount?: number;
  categories?: string | TemplateCategory[];
  channels?: unknown;
  roles?: unknown;
}

interface TemplateChannel { name: string; type?: string; topic?: string }
interface TemplateCategory { name: string; channels: TemplateChannel[] }

function asTemplateRow(row: unknown): TemplateRow {
  const r = row as Partial<TemplateRow> & Record<string, unknown>;
  return {
    _id: String(r._id ?? ''),
    name: String(r.name ?? ''),
    icon: String(r.icon ?? '🌐'),
    description: String(r.description ?? ''),
    tags: Array.isArray(r.tags) || typeof r.tags === 'string' ? r.tags : [],
    categories: Array.isArray(r.categories) || typeof r.categories === 'string' ? r.categories as string | TemplateCategory[] : [],
    createdBy: String(r.createdBy ?? ''),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    usageCount: typeof r.usageCount === 'number' ? r.usageCount : undefined,
    channels: r.channels,
    roles: r.roles,
  };
}

function parseCategories(value: string | TemplateCategory[] | undefined): TemplateCategory[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as TemplateCategory[] : [];
  } catch {
    return [];
  }
}
/**
 * ŞABLON KATEGORİ/KANAL YAPISINI SINIRLA VE KANONİK SÖZLEŞMEYE UYARLA.
 *
 * ── DÜZELTİLEN GERÇEK SORUN ───────────────────────────────────────────────
 * `name`/`icon`/`description`/`tags` alanları sınırlıydı (80/10/300/10) ama
 * GERÇEK KAYNAK YARATAN alan olan `categories` HİÇ sınırlanmıyordu:
 * `JSON.stringify(categories)` ham hâliyle saklanıyor, `/:id/apply` de onu
 * dolaşarak kanal başına bir satır açıyordu. Kimliği doğrulanmış herhangi bir
 * kullanıcı, tek bir POST ile 50.000 kanallı bir şablon oluşturup tek bir
 * POST ile uygulayarak sınırsız kaynak tüketimi tetikleyebilirdi. İki istek de
 * ayrı ayrı rate-limit'liydi ama HER BİRİ sınırsız iş yapıyordu.
 *
 * Ayrıca uygulama yolu kanonik kanal sözleşmesini ATLIYORDU
 * (`routes/servers/channels.ts`): tip beyaz listesi, ad normalizasyonu (32),
 * topic (100) ve kategori (32) sınırları uygulanmıyordu — şablon üzerinden
 * geçersiz `type` ve sınırsız uzunlukta ad yazılabiliyordu.
 *
 * Sınır UYDURULMADI: kanal üst sınırı, ürünün kanonik değeriyle aynıdır
 * (`MAX_CHANNELS_PER_SERVER`, varsayılan 500 — routes/servers/channels.ts).
 */
const TEMPLATE_CHANNEL_TYPES = new Set(['text', 'voice', 'announcement', 'forum', 'stage']);
const MAX_TEMPLATE_CATEGORIES = 50;

function maxTemplateChannels(): number {
  return envSafeInt('MAX_CHANNELS_PER_SERVER', 500, { min: 1, max: 100_000 });
}

function sanitizeCategories(value: unknown): TemplateCategory[] {
  if (!Array.isArray(value)) return [];
  const cap = maxTemplateChannels();
  const out: TemplateCategory[] = [];
  let total = 0;

  for (const rawCat of value.slice(0, MAX_TEMPLATE_CATEGORIES)) {
    if (!rawCat || typeof rawCat !== 'object') continue;
    const cat = rawCat as Record<string, unknown>;
    const name = String(cat.name ?? '').trim().slice(0, 32);
    if (!name) continue;

    const channels: TemplateCategory['channels'] = [];
    const rawChannels = Array.isArray(cat.channels) ? cat.channels : [];

    for (const rawCh of rawChannels) {
      if (total >= cap) break;
      if (!rawCh || typeof rawCh !== 'object') continue;
      const ch = rawCh as Record<string, unknown>;

      // Kanonik ad normalizasyonu (channels.ts:179 ile aynı).
      const chName = String(ch.name ?? '').trim().toLowerCase()
        .replace(/[^a-z0-9\-_]/g, '-').slice(0, 32);
      if (!chName) continue;

      const type = String(ch.type ?? 'text');
      channels.push({
        name:  chName,
        type:  TEMPLATE_CHANNEL_TYPES.has(type) ? type : 'text',
        topic: String(ch.topic ?? '').trim().slice(0, 100),
      } as TemplateCategory['channels'][number]);
      total++;
    }

    out.push({ name, channels } as TemplateCategory);
    if (total >= cap) break;
  }
  return out;
}

function parseStoredArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatTemplate(row: TemplateRow, full = false) {
  const out: Record<string, unknown> = {
    id:          row._id,
    name:        row.name,
    icon:        row.icon,
    description: row.description,
    tags:        parseStoredArray(row.tags),
    createdBy:   row.createdBy,
    createdAt:   row.createdAt,
  };
  if (full) out.categories = parseStoredArray(row.categories);
  return out;
}

// ── GET /api/server-templates ──────────────────────────────────
/**
 * @openapi
 * /server-templates:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu şablon listesi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Şablon listesi }
 *       401: { description: Kimlik doğrulaması gerekli }
 */
router.get('/', authMiddleware, async (req, res) => {
  await ensureSeeded();
  const rows = await ServerAssets.findTemplates({});
  res.json(rows.map(r => formatTemplate(asTemplateRow(r), false)));
});

// ── GET /api/server-templates/:id ─────────────────────────────
/**
 * @openapi
 * /server-templates/{id}:
 *   get:
 *     tags: [Servers]
 *     summary: Tek şablon detayı
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Şablon detayı }
 *       404: { description: Şablon bulunamadı }
 */
router.get('/:id', authMiddleware, async (req, res) => {
  await ensureSeeded();
  const row = await ServerAssets.findTemplate(String(req.params.id ?? ''));
  if (!row) return res.status(404).json({ error: 'Şablon bulunamadı' });
  res.json(formatTemplate(asTemplateRow(row), true));
});

// ── POST /api/server-templates — yeni şablon oluştur ──────────
/**
 * @openapi
 * /server-templates:
 *   post:
 *     tags: [Servers]
 *     summary: Yeni sunucu şablonu oluştur
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               icon: { type: string }
 *               tags: { type: array, items: { type: string } }
 *     responses:
 *       201: { description: Şablon oluşturuldu }
 *       400: { description: Geçersiz istek }
 */
router.post('/', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  const name = body.name;
  const icon = body.icon ?? '🌐';
  const description = body.description ?? '';
  const tags = body.tags ?? [];
  const categories = body.categories ?? [];

  if (typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Şablon adı gerekli' });
  if (typeof icon !== 'string' || typeof description !== 'string')
    return res.status(400).json({ error: 'icon and description must be strings' });
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string'))
    return res.status(400).json({ error: 'tags must be a string array' });
  if (!Array.isArray(categories) || categories.length === 0)
    return res.status(400).json({ error: 'En az bir kategori gerekli' });

  const row = await ServerAssets.insertTemplate({
    name:        name.trim().slice(0, 80),
    icon:        String(icon).slice(0, 10),
    description: String(description).slice(0, 300),
    tags:        JSON.stringify(Array.isArray(tags) ? tags.slice(0, 10) : []),
    // Sınırlandırılmış hâli SAKLANIR: bozuk/aşırı yapı hiç kalıcı olmaz.
    categories:  JSON.stringify(sanitizeCategories(categories)),
    createdBy:   _u.id,
    updatedAt:   null,
  });

  res.status(201).json(formatTemplate(asTemplateRow(row), true));
});

// ── PUT /api/server-templates/:id — güncelle ──────────────────
/**
 * @openapi
 * /server-templates/{id}:
 *   put:
 *     tags: [Servers]
 *     summary: Şablon güncelle (sadece oluşturan)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Şablon güncellendi }
 *       403: { description: Yetki yok }
 *       404: { description: Şablon bulunamadı }
 */
router.put('/:id', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const row = await ServerAssets.findTemplate(String(req.params.id ?? ''));
  if (!row) return res.status(404).json({ error: 'Şablon bulunamadı' });

  if (asTemplateRow(row).createdBy !== _u.id)
    return res.status(403).json({ error: 'Bu şablonu güncelleme yetkiniz yok' });

  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  const { name, icon, description, tags, categories } = body;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return res.status(400).json({ error: 'name must be a non-empty string' });
  if (icon !== undefined && typeof icon !== 'string') return res.status(400).json({ error: 'icon must be a string' });
  if (description !== undefined && typeof description !== 'string') return res.status(400).json({ error: 'description must be a string' });
  if (tags !== undefined && (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string'))) return res.status(400).json({ error: 'tags must be a string array' });
  if (categories !== undefined && !Array.isArray(categories)) return res.status(400).json({ error: 'categories must be an array' });
  const $set: Record<string, unknown> = { updatedAt: Date.now() };
  if (typeof name === 'string')        $set.name        = name.trim().slice(0, 80);
  if (typeof icon === 'string')        $set.icon        = icon.slice(0, 10);
  if (typeof description === 'string') $set.description = description.slice(0, 300);
  if (Array.isArray(tags))             $set.tags        = JSON.stringify(tags.slice(0, 10));
  if (Array.isArray(categories))       $set.categories  = JSON.stringify(sanitizeCategories(categories));

  await ServerAssets.updateTemplate(String(req.params.id ?? ''), $set);
  const updated = await ServerAssets.findTemplate(String(req.params.id ?? ''));
  if (!updated) return res.status(404).json({ error: 'Şablon bulunamadı' });
  res.json(formatTemplate(asTemplateRow(updated), true));
});

// ── DELETE /api/server-templates/:id ──────────────────────────
/**
 * @openapi
 * /server-templates/{id}:
 *   delete:
 *     tags: [Servers]
 *     summary: Şablon sil (sadece oluşturan)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: Silindi }
 *       403: { description: Yetki yok }
 *       404: { description: Şablon bulunamadı }
 */
router.delete('/:id', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const row = await ServerAssets.findTemplate(String(req.params.id ?? ''));
  if (!row) return res.status(404).json({ error: 'Şablon bulunamadı' });

  if (asTemplateRow(row).createdBy !== _u.id)
    return res.status(403).json({ error: 'Bu şablonu silme yetkiniz yok' });

  await ServerAssets.deleteTemplate(String(req.params.id ?? ''));
  res.json({ ok: true });
});

// ── POST /api/server-templates/:id/apply ──────────────────────
/**
 * @openapi
 * /server-templates/{id}/apply:
 *   post:
 *     tags: [Servers]
 *     summary: Şablonu uygula — yeni sunucu oluştur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, description: Yeni sunucu adı }
 *     responses:
 *       201: { description: Sunucu oluşturuldu }
 *       404: { description: Şablon bulunamadı }
 */
router.post('/:id/apply', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  await ensureSeeded();

  const row = await ServerAssets.findTemplate(String(req.params.id ?? ''));
  if (!row) return res.status(404).json({ error: 'Şablon bulunamadı' });

  const template = asTemplateRow(row);
  const serverName = String(req.body.name || template.name).trim().slice(0, 50);
  if (!serverName) return res.status(400).json({ error: 'Sunucu adı gerekli' });

  // SAVUNMA KATMANI: yazma anındaki sınırlama tek başına yetmez — bu satır
  // sınırlama eklenmeden ÖNCE oluşturulmuş (veya doğrudan DB'ye yazılmış)
  // olabilir. Uygulama anında da kanonik sözleşme zorlanır.
  const categories = sanitizeCategories(parseCategories(template.categories));

  // Sunucu oluştur
  const server = await Servers.create({
    _id:          uuidv4(),
    name:         serverName,
    icon:         template.icon,
    ownerId:      _u.id,
    description:  template.description,
    tags:         template.tags,
    discoverable: 0,
    createdAt:    Date.now(),
  });

  // Sahibi üye olarak ekle
  await Servers.addMember(_u.id, server._id, ['owner']);

  // Kategoriler ve kanalları oluştur
  let channelOrder = 0;
  // `entries()` hem sirayi hem de KESIN tanimli ogeyi verir; indeksli erisimin
  // `... | undefined` donmesi sorununu kokunden kaldirir.
  for (const [catIdx, cat] of categories.entries()) {

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
      avatarColor: '#2d9cdb',
      content:     `🎉 **${serverName}** şablondan oluşturuldu! ${template.icon} ${template.description}`,
      type:        'system',
      reactions:   '{}',
      createdAt:   Date.now(),
    });
  }

  res.json({ server, template: { id: template._id, name: template.name } });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
