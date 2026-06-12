// server/lib/modRules.ts
// Kural tabanlı moderasyon — API anahtarı gerektirmez.
// Önceden hem routes/ai.js hem jobs/autoModeration.js içinde aynı kod vardı.
// Tek kaynak: burası.

const TOXIC_WORDS = [
  'oç', 'amk', 'sik', 'göt', 'orospu', 'piç', 'kahpe', 'gerizekalı', 'bok',
];

// Tip alias — dönüş tipi imzada tanımlı; JSDoc kaldırıldı (checkJs+strict generic false-positive)
type ModResult = { safe: boolean; score: number; reason: string; categories: Record<string, boolean> };

function rulesMod(content: string): ModResult {
  if (!content || typeof content !== 'string') return { safe: true, score: 100, reason: 'Boş içerik', categories: {} };

  const lower = content.toLowerCase();
  const upper = (content.match(/[A-ZÇĞİÖŞÜ]/g) || []).length / content.length;

  if (content.length > 15 && upper > 0.65)
    return { safe: false, score: 35, reason: 'Aşırı büyük harf (spam)', categories: { spam: true } };

  if (/(.)(\1){9,}/.test(content))
    return { safe: false, score: 25, reason: 'Tekrar eden karakterler', categories: { spam: true } };

  if ((content.match(/https?:\/\//gi) || []).length > 3)
    return { safe: false, score: 30, reason: 'Çok fazla link (olası spam)', categories: { spam: true } };

  const toxic = TOXIC_WORDS.filter(w => lower.includes(w));
  if (toxic.length > 0)
    return {
      safe:       toxic.length < 2,
      score:      Math.max(20, 70 - toxic.length * 20),
      reason:     'Uygunsuz ifade',
      categories: { harassment: true },
    };

  return { safe: true, score: 95, reason: 'Temiz', categories: {} };
}

// Tip alias — JSDoc kaldırıldı (checkJs+strict Array<{...}> false-positive)
// createdAt zorunlu: DB'den gelen mesajlarda her zaman dolu; ?? 0 fallback 1970 tarihi basardı.
type MessageLike = { userId: string; content?: string; createdAt: number };

function rulesSummary(messages: MessageLike[], userMap: Record<string, string>): string {
  if (!messages.length) return 'Bu kanalda henüz mesaj yok.';

  const names  = [...new Set(messages.map(m => userMap[m.userId] || '?'))];
  const counts: Record<string, number> = {};
  messages.forEach(m => { counts[m.userId] = (counts[m.userId] || 0) + 1; });
  const [topId, topCnt] = Object.entries(counts).sort((a, b) => (b[1] as number) - (a[1] as number))[0] || [];
  const links  = messages.filter(m => /https?:\/\//.test(m.content || '')).length;
  const t1     = new Date(messages[0].createdAt).toLocaleString('tr-TR');
  const t2     = new Date(messages[messages.length - 1].createdAt).toLocaleString('tr-TR');

  return [
    `📊 ${messages.length} mesaj (${t1} — ${t2})`,
    `👥 ${names.length} katılımcı: ${names.slice(0, 4).join(', ')}${names.length > 4 ? '...' : ''}`,
    `🏆 En aktif: ${userMap[topId] || '?'} (${topCnt} mesaj)`,
    links ? `🔗 ${links} link paylaşıldı` : null,
    `\n💡 AI özeti için: .env'e GROQ_API_KEY ekle (groq.com — ücretsiz)`,
  ].filter(Boolean).join('\n');
}

export { rulesMod, rulesSummary };
export type { ModResult, MessageLike };
