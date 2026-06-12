// server/routes/ai/translate.ts — Message translation route
/**
 * @openapi
 * /ai/translate:
 *   post:
 *     tags: [AI]
 *     summary: Metin çevir
 *     description: >
 *       LibreTranslate varsa önce onu dener; yoksa LLM ile çevirir.
 *       İkisi de yoksa 503 döner.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text]
 *             properties:
 *               text:       { type: string, maxLength: 1000 }
 *               targetLang: { type: string, default: tr, example: en }
 *               sourceLang: { type: string, default: auto }
 *     responses:
 *       200:
 *         description: Çeviri tamamlandı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 translated: { type: string }
 *                 provider:   { type: string }
 *                 targetLang: { type: string }
 *       400: { description: 'Geçersiz giriş' }
 *       429: { description: 'Rate limit aşıldı' }
 *       503: { description: 'Çeviri servisi yapılandırılmamış' }
 */

import express from 'express';
const router = express.Router();

import { authMiddleware } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { callAI, AI_ENABLED, PROVIDER, safeProvider } from '../../lib/aiProvider';
import { fetchT } from '../../lib/fetch';

const TRANSLATE_URL = process.env.LIBRETRANSLATE_URL;
const TRANSLATE_KEY = process.env.LIBRETRANSLATE_KEY || '';

const LANG_NAMES: Record<string, string> = {
  tr: 'Türkçe', en: 'İngilizce', de: 'Almanca', fr: 'Fransızca',
  es: 'İspanyolca', ar: 'Arapça', zh: 'Çince', ja: 'Japonca', ru: 'Rusça',
};

// POST /api/ai/translate
router.post('/', authMiddleware, limits.ai(), async (req, res) => {
  const { text, targetLang = 'tr', sourceLang = 'auto' } = req.body as Record<string, string>;
  if (!text?.trim())      return res.status(400).json({ error: 'text gerekli' });
  if (text.length > 1000) return res.status(400).json({ error: 'Max 1000 karakter' });

  // LibreTranslate (self-hosted, free)
  if (TRANSLATE_URL) {
    try {
      const r = await fetchT(`${TRANSLATE_URL}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: sourceLang, target: targetLang, api_key: TRANSLATE_KEY }),
        timeoutMs: 10_000,
        skipSsrfCheck: true, // LIBRETRANSLATE_URL yönetici tarafından yapılandırılır (self-hosted)
      });
      const d = await r.json() as { translatedText?: string };
      if (r.ok && d.translatedText)
        return res.json({ translated: d.translatedText, provider: safeProvider('libretranslate'), targetLang });
    } catch { /* fall through to AI */ }
  }

  if (AI_ENABLED) {
    const translated = await callAI(
      'Çeviri asistanı. Sadece çeviriyi ver.',
      `"${text}" → ${LANG_NAMES[targetLang] || targetLang}`,
    );
    return res.json({ translated, provider: safeProvider(PROVIDER), targetLang });
  }

  res.status(503).json({
    error: 'Çeviri servisi yok',
    hint:  'GROQ_API_KEY veya LIBRETRANSLATE_URL ekle (.env)',
    free: {
      groq:           'groq.com (ücretsiz kayıt)',
      libretranslate: 'docker run -p 5000:5000 libretranslate/libretranslate',
    },
  });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
