// server/routes/stats.ts — Sprint 94: Topluluk Analitiği
// Sprint 98: pool.query() → StatsRepository geçişi ✅
// Sprint 105: OpenAPI annotations eklendi

/**
 * @openapi
 * /servers/{sid}/stats:
 *   get:
 *     tags: [Stats]
 *     summary: Sunucu genel istatistikleri
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Genel istatistikler (üye, mesaj, aktif kanal sayısı) }
 * /servers/{sid}/stats/growth:
 *   get:
 *     tags: [Stats]
 *     summary: Üye büyüme trendi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *       - { name: days, in: query, schema: { type: integer, default: 30, maximum: 90 } }
 *     responses:
 *       200: { description: Günlük üye büyüme dizisi }
 * /servers/{sid}/stats/activity:
 *   get:
 *     tags: [Stats]
 *     summary: Mesaj aktivite trendi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *       - { name: days, in: query, schema: { type: integer, default: 7, maximum: 30 } }
 *     responses:
 *       200: { description: Günlük mesaj sayıları }
 * /servers/{sid}/stats/retention:
 *   get:
 *     tags: [Stats]
 *     summary: Üye retention oranı
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: 7/30/90 günlük retention oranları }
 * /servers/{sid}/stats/export.csv:
 *   get:
 *     tags: [Stats]
 *     summary: İstatistikleri CSV olarak dışa aktar
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: CSV dosyası
 *         content:
 *           text/csv:
 *             schema: { type: string }
 */

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();
import { Stats }         from '../db/repositories/StatsRepository.js';
import { Members, Channels, Servers } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';

// ── Yardımcı: unix ms → YYYY-MM-DD (UTC) ────────────────────────────────────
function toDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Yetki kontrolü: üye ──────────────────────────────────────────────────────
async function requireMember(userId: string, serverId: string): Promise<boolean> {
  const m = await Members.findOne(userId, serverId);
  return m !== null;
}

// ── Yetki kontrolü: sunucu sahibi (admin işlemler için) ──────────────────────
async function requireOwner(userId: string, serverId: string): Promise<boolean> {
  const server = await Servers.findById(serverId);
  return server != null && (server as { ownerId: string }).ownerId === userId;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/servers/:sid/stats
// Özet istatistikler (mevcut endpoint — genişletildi)
// ────────────────────────────────────────────────────────────────────────────
router.get('/:sid/stats', authMiddleware, async (req, res) => {
  const me  = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");
  if (!await requireMember(me.id, sid)) return res.status(403).json({ error: 'Not a member' });

  const stats = await Stats.getServerStats(sid);

  // Kanal isimlerini birleştir
  const allChannels = await Channels.findByServer(sid);
  const chanMap     = Object.fromEntries(allChannels.map(c => [c._id, c.name]));

  // isOwner: client CSV butonu göstermek için kullanır
  const isOwner = await requireOwner(me.id, sid);

  res.json({
    memberCount:      stats.memberCount,
    channelCount:     stats.channelCount,
    totalMessages:    stats.totalMessages,
    activeUsers7d:    stats.activeUsers7d,
    activeUsers30d:   stats.activeUsers30d,
    topUsers:         stats.topUsers,
    channelBreakdown: stats.channelBreakdown.map(r => ({
      channelId:   r.channelId,
      channelName: chanMap[r.channelId] ?? r.channelId,
      msgCount:    r.msgCount,
    })),
    isOwner,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/servers/:sid/stats/growth
// Üye büyümesi — günlük katılım zaman serisi (son 90 gün)
// ────────────────────────────────────────────────────────────────────────────
router.get('/:sid/stats/growth', authMiddleware, async (req, res) => {
  const me  = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");
  if (!await requireMember(me.id, sid)) return res.status(403).json({ error: 'Not a member' });

  const days  = Math.min(parseInt(String(req.query.days ?? '30'), 10), 90);
  const since = Date.now() - days * 86400_000;

  const { joinSeries, msgSeries, totalMembers: totalNow } = await Stats.getGrowthSeries(sid, since);

  // Tüm günleri doldur (boş günler 0 göstersin)
  const allDays: string[] = [];
  for (let d = 0; d < days; d++) {
    allDays.push(toDateStr(since + d * 86400_000));
  }

  const joinMap = Object.fromEntries(joinSeries.map(r => [r.day, r.newMembers]));
  const msgMap  = Object.fromEntries(msgSeries.map(r => [r.day, r.msgCount]));

  // Kümülatif hesapla (geriye doğru)
  const joinSeriesFull = allDays.map(day => ({ day, newMembers: joinMap[day] ?? 0 }));
  let cumulative = totalNow;
  const cumulativeSeries = [...joinSeriesFull].reverse().map(({ day, newMembers }) => {
    const val = cumulative;
    cumulative -= newMembers;
    return { day, totalMembers: val };
  }).reverse();

  res.json({
    days,
    joinSeries: joinSeriesFull,
    cumulativeSeries,
    messageSeries: allDays.map(day => ({ day, msgCount: msgMap[day] ?? 0 })),
    totalMembers: totalNow,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/servers/:sid/stats/activity
// Saat & gün dağılımı (heatmap için), aktif saatler, peak time
// ────────────────────────────────────────────────────────────────────────────
router.get('/:sid/stats/activity', authMiddleware, async (req, res) => {
  const me  = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");
  if (!await requireMember(me.id, sid)) return res.status(403).json({ error: 'Not a member' });

  const since = Date.now() - 30 * 86400_000; // son 30 gün
  const { hours, dows } = await Stats.getActivityDistribution(sid, since);

  const hourMap = Object.fromEntries(hours.map(r => [String(r.hour), r.msgCount]));
  const dowMap  = Object.fromEntries(dows.map(r => [String(r.dow),   r.msgCount]));

  const hourlyDistribution = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: `${String(h).padStart(2, '0')}:00`,
    msgCount: hourMap[String(h)] ?? 0,
  }));

  const DOW_LABELS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  const weeklyDistribution = Array.from({ length: 7 }, (_, d) => ({
    dow: d,
    label: DOW_LABELS[d],
    msgCount: dowMap[String(d)] ?? 0,
  }));

  const peakHour = hourlyDistribution.reduce((a, b) => a.msgCount >= b.msgCount ? a : b);
  const peakDay  = weeklyDistribution.reduce((a, b) => a.msgCount >= b.msgCount ? a : b);

  res.json({ hourlyDistribution, weeklyDistribution, peakHour, peakDay });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/servers/:sid/stats/retention
// 7 günlük ve 30 günlük mesaj gönderme retention (DAU/MAU oranı)
// ────────────────────────────────────────────────────────────────────────────
router.get('/:sid/stats/retention', authMiddleware, async (req, res) => {
  const me  = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");
  if (!await requireMember(me.id, sid)) return res.status(403).json({ error: 'Not a member' });

  const { dau: dauN, wau: wauN, mau: mauN, memberTotal } = await Stats.getRetention(sid);
  const total = memberTotal || 1;

  res.json({
    dau:    dauN,
    wau:    wauN,
    mau:    mauN,
    dauRate: +(dauN / total * 100).toFixed(1),
    wauRate: +(wauN / total * 100).toFixed(1),
    mauRate: +(mauN / total * 100).toFixed(1),
    dauMauRatio: mauN > 0 ? +(dauN / mauN * 100).toFixed(1) : 0,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/servers/:sid/stats/export.csv
// Tüm analitik verilerini CSV olarak döndürür — sadece sunucu sahibi
// ────────────────────────────────────────────────────────────────────────────
router.get('/:sid/stats/export.csv', authMiddleware, async (req, res) => {
  const me  = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");

  if (!await requireOwner(me.id, sid))
    return res.status(403).json({ error: 'Bu işlem için sunucu sahibi olmanız gerekiyor.' });

  const days  = Math.min(parseInt(String(req.query.days ?? '30'), 10), 90);
  const since = Date.now() - days * 86400_000;

  const { joinRows, msgRows, topUsers, chanBreakdown } = await Stats.getCsvData(sid, since);

  const allChannels = await Channels.findByServer(sid);
  const chanMap     = Object.fromEntries(allChannels.map(c => [c._id, c.name]));

  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const rows: string[] = [];

  rows.push('Bölüm,Gün/Ad,Değer1,Değer2');
  rows.push(`Özet,Dönem (gün),${days},`);

  for (const r of joinRows) {
    const msg = msgRows.find(m => m.day === r.day);
    rows.push([esc('Büyüme'), esc(r.day), esc(r.newMembers), esc(msg?.msgCount ?? '0')].join(','));
  }
  for (const u of topUsers) {
    rows.push([esc('Aktif Üye'), esc(u.displayName), esc(u.msgCount), ''].join(','));
  }
  for (const c of chanBreakdown) {
    const name = chanMap[c.channelId] ?? c.channelId;
    rows.push([esc('Kanal'), esc(name), esc(c.msgCount), ''].join(','));
  }

  const csv = '\uFEFF' + rows.join('\n');  // BOM for Excel

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bridge-analytics-${sid}-${toDateStr(Date.now())}.csv"`);
  res.send(csv);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
