// server/tests/alert-rules-metric-contract.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ALARM KURALLARI, SUNUCUNUN GERÇEKTEN YAYDIĞI METRİKLERİ Mİ SORGULUYOR?
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN KUSUR (Final21, Faz 9 — F21-9-01) ─────────────────────────────
// Var olmayan bir metriği sorgulayan PromQL HATA VERMEZ: boş vektör döner ve
// alarm SONSUZA DEK sessiz kalır. `monitoring/rules/bridge_alerts.test.yml`
// promtool testleri bunu yakalayamaz, çünkü girdi serilerini kuralın
// kullandığı isimle KENDİLERİ üretirler.
//
// Çalışan sunucunun `/metrics` çıktısıyla ÖLÇÜLDÜ: 23 kuraldan 9'u hiçbir
// koşulda ya da adını taşıdığı koşulda ateşlenemiyordu:
//
//   · 5 kural ÖNEKSİZ ad sorguluyordu (`process_resident_memory_bytes`,
//     `nodejs_heap_size_*`, `nodejs_external_memory_bytes`,
//     `process_start_time_seconds`). Sunucu varsayılan metrikleri
//     `collectDefaultMetrics({ prefix: 'bridge_' })` ile yayar.
//   · `bridge_db_query_*` tanımlıydı ama HİÇ beslenmiyordu.
//   · `bridge_websocket_connections` hiç set edilmiyordu.
//   · `bridge_db_up` sabit bir yer tutucuydu (32 sn'lik gerçek kesintide 1 kaldı).
//
// Bu dosya İKİ şeyi kilitler:
//   1. AD/ETİKET SÖZLEŞMESİ — her kuraldaki her metrik adı ve her etiket
//      sunucunun GERÇEK prom-client kaydında vardır.
//   2. BESLEME — ad var olsa bile boş kalan göstergelerin (db_up,
//      websocket_connections, db sorgu metrikleri) GERÇEKTEN yazıldığı.

import fs from 'fs';
import path from 'path';

const RULES_PATH = path.join(__dirname, '..', '..', 'monitoring', 'rules', 'bridge_alerts.yml');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load(src: string): unknown };

interface Rule { alert: string; expr: string }

function loadRules(): Rule[] {
  const doc = yaml.load(fs.readFileSync(RULES_PATH, 'utf8')) as {
    groups?: Array<{ rules?: Array<{ alert?: string; expr?: string }> }>;
  };
  return (doc.groups ?? []).flatMap((g) => g.rules ?? [])
    .filter((r): r is { alert: string; expr: string } => typeof r.alert === 'string' && typeof r.expr === 'string');
}

const PROMQL_WORDS = new Set([
  'sum', 'rate', 'irate', 'increase', 'avg', 'max', 'min', 'count', 'by', 'without', 'on', 'ignoring',
  'group_left', 'group_right', 'and', 'or', 'unless', 'histogram_quantile', 'changes', 'resets', 'delta',
  'deriv', 'abs', 'clamp_min', 'clamp_max', 'absent', 'absent_over_time', 'avg_over_time', 'max_over_time',
  'min_over_time', 'sum_over_time', 'count_over_time', 'time', 'offset', 'bool', 'topk', 'bottomk', 'vector',
  'scalar', 'label_replace', 'predict_linear', 'quantile_over_time', 'last_over_time', 'timestamp',
]);
// Prometheus'un kendisinin ürettiği ya da kazımada eklediği.
const PROMETHEUS_SERIES = new Set(['up']);
const SCRAPE_LABELS = new Set(['job', 'instance', 'le']);
// Düğüm ihracatçısı metriği; kural onu `or vector(...)` ile İSTEĞE BAĞLI kullanır.
const OPTIONAL_EXTERNAL = new Set(['node_memory_MemTotal_bytes']);

function metricsIn(expr: string): string[] {
  const stripped = expr
    .replace(/"[^"]*"/g, '""')
    // Süre değişmezleri (`offset 10m`, `[1h]` dışındaki) metrik adı DEĞİLDİR.
    .replace(/\b\d+(ms|[smhdwy])\b/g, ' ')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, '');
  return [...new Set([...stripped.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)].map((m) => m[0]))]
    .filter((w) => !PROMQL_WORDS.has(w) && !/^[0-9]/.test(w) && !/^\d+[smhd]$/.test(w));
}

function loadRealMetrics() {
  let mod: typeof import('../middleware/metrics') | undefined;
  jest.isolateModules(() => {
    process.env.METRICS_ENABLED = 'true';
    mod = require('../middleware/metrics');
  });
  return mod!;
}

describe('alarm kuralları ↔ gerçek metrik kaydı sözleşmesi', () => {
  const metrics = loadRealMetrics();
  const catalog = new Map(metrics._metricCatalogForTest().map((m) => [m.name, m]));
  const known = (name: string): { labelNames: string[] } | undefined => {
    if (catalog.has(name)) return catalog.get(name);
    for (const suffix of ['_bucket', '_sum', '_count']) {
      if (name.endsWith(suffix)) {
        const base = catalog.get(name.slice(0, -suffix.length));
        if (base?.type === 'histogram') return { labelNames: [...base.labelNames, 'le'] };
      }
    }
    return undefined;
  };

  it('gerçek kayıt yüklenir (boş kayıtla boşuna geçmez)', () => {
    expect(catalog.size).toBeGreaterThan(30);
    expect(catalog.has('bridge_nodejs_heap_size_used_bytes')).toBe(true);
  });

  const rules = loadRules();

  it('kural dosyası okunur', () => {
    expect(rules.length).toBeGreaterThanOrEqual(20);
  });

  it.each(rules.map((r) => [r.alert, r.expr] as const))('%s — sorguladığı her metrik kayıtlıdır', (_alert, expr) => {
    const missing = metricsIn(expr)
      .filter((m) => !PROMETHEUS_SERIES.has(m) && !OPTIONAL_EXTERNAL.has(m))
      .filter((m) => !known(m));
    expect(missing).toEqual([]);
  });

  it.each(rules.map((r) => [r.alert, r.expr] as const))('%s — kullandığı her etiket metrikte vardır', (_alert, expr) => {
    const problems: string[] = [];
    for (const sel of expr.matchAll(/([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{([^}]*)\}/g)) {
      const meta = known(sel[1]);
      if (!meta) continue;
      for (const kv of sel[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)/g)) {
        if (!SCRAPE_LABELS.has(kv[1]) && !meta.labelNames.includes(kv[1])) problems.push(`${sel[1]}{${kv[1]}}`);
      }
    }
    const grouped = [...expr.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean))
      .filter((l) => !SCRAPE_LABELS.has(l));
    const owners = metricsIn(expr).map(known).filter(Boolean) as Array<{ labelNames: string[] }>;
    for (const label of grouped) {
      if (owners.length && !owners.some((o) => o.labelNames.includes(label))) problems.push(`by(${label})`);
    }
    expect(problems).toEqual([]);
  });
});

describe('ad var ama BESLENİYOR mu? (F21-9-01)', () => {
  afterEach(() => { jest.useRealTimers(); });

  // GERÇEK KESİNTİDE ÖLÇÜLEN: PostgreSQL 32 sn durdurulmuşken `/api/health`
  // 503 verdi ama eski `bridge_db_up` 1'de KALDI. Bu test aynı diziyi —
  // sağlıklı → kesinti → toparlanma — denetlenebilir bir havuzla yürütür.
  it('bridge_db_up gerçek bir yoklamadır: kesintide 0 olur, toparlanınca 1 döner', async () => {
    jest.useFakeTimers();
    let mod: typeof import('../middleware/metrics') | undefined;
    const pool = {
      down: false,
      query: jest.fn(async function (this: { down: boolean }) {
        if (pool.down) throw new Error('ECONNREFUSED 127.0.0.1:5432');
        return { rows: [{ '?column?': 1 }] };
      }),
    };
    jest.isolateModules(() => {
      process.env.METRICS_ENABLED = 'true';
      delete process.env.METRICS_SECRET;
      jest.doMock('../db/loader', () => ({ __esModule: true, default: { _pool: pool } }));
      mod = require('../middleware/metrics');
    });
    const scrape = async (): Promise<string> => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn(), end: jest.fn() };
      await mod!.metricsEndpoint({ headers: {} } as never, res as never);
      const line = String(res.end.mock.calls.at(-1)?.[0] ?? '').split('\n').find((l) => /^bridge_db_up /.test(l));
      return line ?? '(yok)';
    };

    await scrape();                                  // yoklamayı başlatır
    await jest.advanceTimersByTimeAsync(0);
    expect(await scrape()).toBe('bridge_db_up 1');   // sağlıklı

    pool.down = true;                                // kesinti
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await scrape()).toBe('bridge_db_up 0');

    pool.down = false;                               // toparlanma
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await scrape()).toBe('bridge_db_up 1');

    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    mod!._resetDbProbeForTest();
  });

  it('bridge_websocket_connections motorun gerçek istemci sayısından beslenir', async () => {
    let mod: typeof import('../middleware/metrics') | undefined;
    jest.isolateModules(() => {
      process.env.METRICS_ENABLED = 'true';
      delete process.env.METRICS_SECRET;
      jest.doMock('../socket', () => ({ getIo: () => ({ engine: { clientsCount: 7 } }) }));
      mod = require('../middleware/metrics');
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn(), end: jest.fn() };
    await mod!.metricsEndpoint({ headers: {} } as never, res as never);
    expect(String(res.end.mock.calls.at(-1)?.[0] ?? '')).toMatch(/^bridge_websocket_connections 7$/m);
  });

  it('PostgreSQL istemci sorguları süre ve sayı üretir; hatalar _err olarak sayılır', async () => {
    const metrics = loadRealMetrics();
    const client = {
      // Same shape as the instrumented pg client: (text, values?) arrive as rest arguments.
      query: jest.fn(async (...args: unknown[]) => {
        if (String(args[0] ?? '').includes('bozuk')) throw new Error('syntax');
        return { rows: [] };
      }),
    };
    metrics.instrumentPgClient(client);
    metrics.instrumentPgClient(client); // idempotent: iki kez sarılmaz
    await client.query('SELECT * FROM messages WHERE "channelId" = $1', ['c1']);
    await expect(client.query('SELECT bozuk FROM messages')).rejects.toThrow('syntax');

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn(), end: jest.fn() };
    delete process.env.METRICS_SECRET;
    await metrics.metricsEndpoint({ headers: {} } as never, res as never);
    const body = String(res.end.mock.calls.at(-1)?.[0] ?? '');
    expect(body).toMatch(/^bridge_db_queries_total\{operation="select",collection="messages"\} 1$/m);
    expect(body).toMatch(/^bridge_db_queries_total\{operation="select_err",collection="messages"\} 1$/m);
    expect(body).toMatch(/^bridge_db_query_duration_seconds_count\{operation="select",collection="messages"\} 1$/m);
  });

  it('SQL sınıflandırması doğru etiketler', () => {
    // Taze modül: etiket kümesi modül durumudur; önceki testler doldurmasın.
    const metrics = loadRealMetrics();
    expect(metrics.classifySql('BEGIN').operation).toBe('tx');
    expect(metrics.classifySql('INSERT INTO "messages" (a) VALUES ($1)')).toEqual({ operation: 'insert', collection: 'messages' });
    expect(metrics.classifySql('UPDATE users SET x=1')).toEqual({ operation: 'update', collection: 'users' });
    expect(metrics.classifySql('  select 1')).toEqual({ operation: 'select', collection: 'other' });
  });

  it('SQL sınıflandırma kardinalitesi SINIRLIDIR (şemadan büyük ama sonlu)', () => {
    const metrics = loadRealMetrics();
    const labels = new Set<string>();
    for (let i = 0; i < 500; i++) labels.add(metrics.classifySql(`SELECT * FROM tablo_${i}`).collection);
    // Tavan + `other`. Tavan, ~70 tablolu şema ve CTE adları için yeterince
    // geniş (ilk sürümde 64'tü ve gerçek tabloları `other`a itebilirdi).
    expect(labels.size).toBeLessThanOrEqual(129);
    expect(labels.has('other')).toBe(true);
  });

  it('geri çağrılı ve akış biçimli sorgular DOKUNULMADAN geçer', () => {
    const metrics = loadRealMetrics();
    const passthrough = jest.fn(() => 'submitted');
    const client = { query: passthrough as unknown as (...args: unknown[]) => unknown };
    metrics.instrumentPgClient(client);
    const cb = jest.fn();
    expect(client.query('SELECT 1', [], cb)).toBe('submitted');
    const submittable = { submit: jest.fn(), text: 'SELECT 1' };
    expect(client.query(submittable)).toBe('submitted');
  });
});
