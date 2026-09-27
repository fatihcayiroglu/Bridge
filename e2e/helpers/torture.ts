// e2e/helpers/torture.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK ZAMANLI İŞKENCE — ÖLÇÜM VE BÜTÇE ALTYAPISI
// ════════════════════════════════════════════════════════════════════════════
//
// Faz 5'in kuralı şudur: EŞİKLER KOŞUMDAN ÖNCE TANIMLANIR ve sonuç görüldükten
// sonra OYNATILMAZ. Bu dosya o kuralı kodla uygular:
//
//   · `Budget` bir eşiği ADIYLA ve DEĞERİYLE taşır; spec dosyası bunları
//     tepede, senaryolar çalışmadan ÖNCE bildirir.
//   · `Scenario` ölçülen değerleri toplar ve `judge()` çağrıldığında bütçeyle
//     karşılaştırır. Karşılaştırma, ölçümü GÖRDÜKTEN sonra gevşetilemez —
//     bütçe nesnesi dondurulmuştur (`Object.freeze`).
//
// ── NEDEN "socket connected" YETMEZ ─────────────────────────────────────────
// Bir soketin bağlanması hiçbir şey kanıtlamaz. Kullanıcı için önemli olan
// KOPMA SONRASI NİHAİ DURUMUN DOĞRU olmasıdır: mesaj kaybolmamış, mesaj
// ÇİFTLENMEMİŞ, okunmamış sayacı yakınsamış, üyelik ve varlık yakınsamış,
// bayat pencere SINIRLI kalmış. Bu yüzden buradaki her senaryo nihai durumu
// ölçer, bağlantı olayını değil.

import fs from 'fs';
import path from 'path';

export interface Budget {
  readonly name: string;
  /** Ölçülen değerin AŞMAMASI gereken sınır. */
  readonly max: number;
  readonly unit: string;
}

export function budget(name: string, max: number, unit: string): Budget {
  return Object.freeze({ name, max, unit });
}

/** Sıralanmış örneklerden yüzdelik — küçük örneklemde de dürüst davranır. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  // En yakın sıra (nearest-rank): küçük örneklemde enterpolasyon UYDURUR.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export interface Measurement {
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly budgetMax: number | null;
  readonly verdict: 'PASS' | 'FAIL' | 'INFO';
}

export interface ScenarioResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  ms: number;
  measurements: Measurement[];
  note?: string;
}

const collected: ScenarioResult[] = [];

export class Scenario {
  private readonly started = Date.now();
  private readonly measurements: Measurement[] = [];
  private note?: string;
  private blocked = false;

  constructor(private readonly id: string, private readonly name: string) {}

  /** Bütçeye TABİ bir ölçüm. Bütçe dondurulmuştur; sonradan gevşetilemez. */
  check(b: Budget, value: number): void {
    this.measurements.push({
      label: b.name,
      value,
      unit: b.unit,
      budgetMax: b.max,
      verdict: Number.isFinite(value) && value <= b.max ? 'PASS' : 'FAIL',
    });
  }

  /** Bütçesiz, bilgilendirici ölçüm — geçti/kaldı üretmez. */
  info(label: string, value: number, unit: string): void {
    this.measurements.push({ label, value, unit, budgetMax: null, verdict: 'INFO' });
  }

  /**
   * Senaryo yürütülemedi (altyapı yok, dış bağımlılık kapalı, ...).
   * BAŞARI SAYILMAZ; raporda BLOCKED olarak görünür.
   */
  block(reason: string): void {
    this.blocked = true;
    this.note = reason;
  }

  fail(reason: string): void {
    this.note = this.note ? `${this.note}; ${reason}` : reason;
    this.measurements.push({
      label: reason, value: 1, unit: 'hata', budgetMax: 0, verdict: 'FAIL',
    });
  }

  end(): ScenarioResult {
    const failed = this.measurements.some((m) => m.verdict === 'FAIL');
    const result: ScenarioResult = {
      id: this.id,
      name: this.name,
      status: this.blocked ? 'BLOCKED' : failed ? 'FAIL' : 'PASS',
      ms: Date.now() - this.started,
      measurements: this.measurements,
      ...(this.note ? { note: this.note } : {}),
    };
    collected.push(result);
    return result;
  }
}

export function scenario(id: string, name: string): Scenario {
  return new Scenario(id, name);
}

export function tortureResults(): readonly ScenarioResult[] {
  return collected;
}

// Rapor adı depo kuralına uyar (`e2e/_<ad>-report.json`) — sürüm paketine girmez.
export function writeTortureReport(file = '_realtime-torture-report.json'): {
  pass: number; fail: number; blocked: number; failedMeasurements: number;
} {
  const pass = collected.filter((s) => s.status === 'PASS').length;
  const fail = collected.filter((s) => s.status === 'FAIL').length;
  const blocked = collected.filter((s) => s.status === 'BLOCKED').length;

  // ── KAPATILAN YARGI DELİĞİ ────────────────────────────────────────────────
  // İlk sürümde senaryo durumu BLOCKED ise içindeki FAIL ölçümleri toplam
  // başarısızlığa HİÇ girmiyordu; bir bütçe aşımı "bloke" etiketinin altında
  // sessizce kayboluyor ve paket YEŞİL görünüyordu. Bu tam olarak
  // "atlananı geçmiş saymak"tır ve yasaktır. Aşılan bütçe, senaryonun durumu
  // ne olursa olsun SAYILIR.
  const failedMeasurements = collected
    .reduce((n, s) => n + s.measurements.filter((m) => m.verdict === 'FAIL').length, 0);

  const target = path.join(__dirname, '..', file);
  fs.writeFileSync(target, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scenarios: collected,
    summary: { pass, fail, blocked, failedMeasurements, total: collected.length },
  }, null, 2) + '\n');

  // eslint-disable-next-line no-console
  console.log('\nGERCEK ZAMANLI ISKENCE RAPORU');
  for (const s of collected) {
    // eslint-disable-next-line no-console
    console.log(`  ${s.id.padEnd(4)} ${s.status.padEnd(8)} ${String(s.ms).padStart(6)}ms  ${s.name}${s.note ? ` — ${s.note}` : ''}`);
    for (const m of s.measurements) {
      const limit = m.budgetMax === null ? '' : `  (butce <= ${m.budgetMax}${m.unit})`;
      // eslint-disable-next-line no-console
      console.log(`         ${m.verdict.padEnd(5)} ${m.label}: ${m.value}${m.unit}${limit}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`  OZET: ${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED`
    + ` | asilan butce (durumdan bagimsiz): ${failedMeasurements}`);
  // eslint-disable-next-line no-console
  console.log(`  Rapor: ${target}`);
  return { pass, fail, blocked, failedMeasurements };
}
