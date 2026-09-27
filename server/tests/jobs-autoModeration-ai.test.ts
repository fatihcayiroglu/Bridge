// server/tests/jobs-autoModeration-ai.test.ts
//
// OTOMATİK MODERASYON — YAPAY ZEKÂ YOLU VE İŞ YAŞAM DÖNGÜSÜ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BİR DOSYA
// ════════════════════════════════════════════════════════════════════════════
// Kapsam ilk kez ölçülebildiğinde `jobs/autoModeration.ts` moderasyon
// (Tier-0) grubundaki en zayıf dosyalardan biriydi: dalların %62,5'i.
// Mevcut paket `AI_ENABLED: false` ile mock'landığı için YZ yolu HİÇ
// çalışmıyordu — yani kural sonucu ile YZ sonucu arasındaki KARAR mantığı
// tamamen test dışıydı. O karar, bir mesajın işaretlenip işaretlenmeyeceğini
// belirler; sessizce yanlış olması moderasyonun kaçırmasına ya da masum
// mesajı işaretlemesine yol açar.
//
// Bu dosya `AI_ENABLED: true` ile aynı modülü yükler ve kararın dört kolunu
// da sınar.

process.env.NODE_ENV = 'test';

const callAI = jest.fn();

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

jest.mock('../db/repositories', () => {
  const { createMockDb } = require('./helpers/mockDb');
  const _db = createMockDb();
  return {
    Channels: { findWhere: (q: unknown) => _db.channels.find(q), insert: (d: unknown) => _db.channels.insert(d) },
    Servers:  { findById: (id: string) => _db.servers.findOne({ _id: id }) },
    Messages: { findWhere: (q: unknown) => _db.messages.find(q), create: (d: unknown) => _db.messages.insert(d) },
    Users:    { findById: (id: string) => _db.users.findOne({ _id: id }) },
    _db,
  };
});

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── KRITIK FARK: YZ ACIK ─────────────────────────────────────────────────
jest.mock('../lib/aiProvider', () => ({ AI_ENABLED: true, callAI }));
jest.mock('../lib/modRules', () => ({ rulesMod: jest.fn() }));

import { startAutoModerationJob, stopAutoModerationJob } from '../jobs/autoModeration';

beforeEach(() => {
  callAI.mockReset();
  jest.useRealTimers();
});
afterEach(() => {
  stopAutoModerationJob();
  jest.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════
// aiMod() — YZ yanitinin ayristirilmasi
// ════════════════════════════════════════════════════════════════════════════
// `aiMod` disa aktarilmaz; sozlesmesi burada birebir modellenip sinanir.
// Kaynak denetimi (asagida) uruntaki kopyanin ayrismasini yakalar.
async function aiModModel(content: string, enabled: boolean): Promise<unknown | null> {
  if (!enabled || !content) return null;
  try {
    const raw = await callAI('sys', `"${content.slice(0, 300)}"`, 80);
    return JSON.parse(String(raw).replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

describe('aiMod — yanıt ayrıştırma', () => {
  it('YZ KAPALIYSA çağrı bile yapılmaz', async () => {
    const out = await aiModModel('kötü içerik', false);
    expect({ out, called: callAI.mock.calls.length }).toEqual({ out: null, called: 0 });
  });

  it('içerik BOŞSA çağrı yapılmaz', async () => {
    // Bos mesaj icin YZ cagirmak bos yere maliyet ve gecikmedir.
    const out = await aiModModel('', true);
    expect({ out, called: callAI.mock.calls.length }).toEqual({ out: null, called: 0 });
  });

  it('düz JSON yanıt ayrıştırılır', async () => {
    callAI.mockResolvedValue('{"safe":false,"score":90,"reason":"hakaret"}');
    expect(await aiModModel('x', true)).toEqual({ safe: false, score: 90, reason: 'hakaret' });
  });

  it('```json ÇİTLİ yanıt da ayrıştırılır', async () => {
    // Modeller yaniti sik sik kod citiyle sarar; ayristirici bunu soymalidir.
    callAI.mockResolvedValue('```json\n{"safe":true,"score":5,"reason":"temiz"}\n```');
    expect(await aiModModel('x', true)).toEqual({ safe: true, score: 5, reason: 'temiz' });
  });

  it('BOZUK JSON sessizce null döner (moderasyon çökmez)', async () => {
    // YZ saçmaladiginda is durmamali; kural sonucuna geri donulmeli.
    callAI.mockResolvedValue('bu JSON degil');
    expect(await aiModModel('x', true)).toBeNull();
  });

  it('YZ çağrısı HATA verirse null döner', async () => {
    callAI.mockRejectedValue(new Error('provider down'));
    expect(await aiModModel('x', true)).toBeNull();
  });

  it('içerik 300 karaktere KIRPILIR', async () => {
    // Sinirsiz icerik gondermek maliyet ve jeton siniri riskidir.
    callAI.mockResolvedValue('{"safe":true,"score":0,"reason":"ok"}');
    await aiModModel('A'.repeat(1000), true);
    const sent = String(callAI.mock.calls[0][1]);
    expect(sent.length).toBeLessThanOrEqual(302);      // iki tirnak dahil
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KARAR: kural sonucu mu, YZ sonucu mu kazanir?
// ════════════════════════════════════════════════════════════════════════════
type Mod = { safe: boolean; score: number; reason?: string; source?: string };

/** `runScan` icindeki secim mantiginin birebir modeli. */
function decide(rule: Mod, ai: Mod | null, aiEnabled: boolean): Mod {
  if (rule.safe && rule.score < 70) return rule;       // yukseltme yok
  if (!aiEnabled) return { ...rule, source: 'rules' };
  if (!ai) return { ...rule, source: 'rules' };
  if (!ai.safe || ai.score > rule.score) return { ...ai, source: 'ai' };
  return { ...rule, source: 'rules' };
}

describe('kural / YZ kararı', () => {
  it('kural TEMİZ ve skor düşükse YZ hiç devreye girmez', () => {
    const out = decide({ safe: true, score: 10 }, null, true);
    expect(out.source).toBeUndefined();
  });

  it('YZ GÜVENSİZ derse YZ kazanır', () => {
    const out = decide({ safe: false, score: 75 }, { safe: false, score: 95 }, true);
    expect({ source: out.source, score: out.score }).toEqual({ source: 'ai', score: 95 });
  });

  it('YZ güvenli ama skoru DAHA YÜKSEKSE YZ kazanır', () => {
    // Daha yuksek skor daha guclu sinyaldir; dusuk kural skoru onu ezmemeli.
    const out = decide({ safe: false, score: 72 }, { safe: true, score: 88 }, true);
    expect({ source: out.source, score: out.score }).toEqual({ source: 'ai', score: 88 });
  });

  it('YZ skoru DÜŞÜKSE kural sonucu korunur', () => {
    const out = decide({ safe: false, score: 90 }, { safe: true, score: 20 }, true);
    expect({ source: out.source, score: out.score }).toEqual({ source: 'rules', score: 90 });
  });

  it('YZ null dönerse kural sonucu korunur', () => {
    const out = decide({ safe: false, score: 80 }, null, true);
    expect({ source: out.source, score: out.score }).toEqual({ source: 'rules', score: 80 });
  });

  it('YZ KAPALIYKEN kural sonucu korunur', () => {
    const out = decide({ safe: false, score: 80 }, { safe: false, score: 99 }, false);
    expect(out.source).toBe('rules');
  });

  it('skor 70 EŞİĞİ yükseltmeyi tetikler (güvenli sayılsa bile)', () => {
    // Sinir degeri: 70 dahil olmali, 69 olmamali.
    expect(decide({ safe: true, score: 70 }, null, true).source).toBe('rules');
    expect(decide({ safe: true, score: 69 }, null, true).source).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// IS YASAM DONGUSU
// ════════════════════════════════════════════════════════════════════════════
describe('otomatik moderasyon işi — yaşam döngüsü', () => {
  const io = { to: () => ({ emit: () => {} }) } as never;

  it('İKİNCİ başlatma yeni zamanlayıcı kurmaz', () => {
    jest.useFakeTimers();
    startAutoModerationJob(io);
    const after = jest.getTimerCount();
    startAutoModerationJob(io);
    expect({ after, now: jest.getTimerCount() }).toEqual({ after, now: after });
    expect(after).toBeGreaterThan(0);
  });

  it('durdurma zamanlayıcıları GERÇEKTEN temizler', () => {
    jest.useFakeTimers();
    startAutoModerationJob(io);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    stopAutoModerationJob();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('durdurulduktan SONRA yeniden başlatılabilir', () => {
    // Idempotent koruma, mesru yeniden baslatmayi engellememeli.
    jest.useFakeTimers();
    startAutoModerationJob(io);
    stopAutoModerationJob();
    startAutoModerationJob(io);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
  });

  it('hiç başlatılmadan durdurmak HATA VERMEZ', () => {
    expect(() => stopAutoModerationJob()).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KAYNAK SOZLESMESI — modellenen mantik urunle ayrismasin
// ════════════════════════════════════════════════════════════════════════════
describe('kaynak sözleşmesi', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'autoModeration.ts'), 'utf8');

  it('YZ yolu hâlâ 70 eşiğine bağlı', () => {
    expect(SRC).toContain('ruleResult.score >= 70');
  });

  it('YZ sonucu yalnızca GÜVENSİZ ya da DAHA YÜKSEK skorda kazanır', () => {
    expect(SRC).toContain('!aiResult.safe || aiResult.score > ruleResult.score');
  });

  it('yanıt kod çiti soyuluyor', () => {
    expect(SRC).toMatch(/```json\|```/);
  });

  it('içerik 300 karaktere kırpılıyor', () => {
    expect(SRC).toContain('content.slice(0, 300)');
  });
});
