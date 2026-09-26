// e2e/helpers/friction.ts
//
// ════════════════════════════════════════════════════════════════════════════
// YOLCULUK SÜRTÜNME ÖLÇERİ
// ════════════════════════════════════════════════════════════════════════════
//
// `daily-driver-journey.spec.ts` "adım takıldı mı?" sorusunu cevaplar ve bu
// değerlidir. Ama Final21 Faz 4 BAŞKA bir soru soruyor:
//
//     Kullanıcı bu işi yapmak için KAÇ ŞEY yapmak zorunda?
//
// Takılmayan ama pahalı bir akış da bir kusurdur: on tıklamayla yapılan iş
// üç tıklamayla yapılabiliyorsa, o yedi tıklama her gün, her kullanıcı için
// ödenir. Bu yüzden burada ÖLÇÜM yapılır, geçti/kaldı değil.
//
// ── NE SAYILIR ──────────────────────────────────────────────────────────────
//   tıklama        — işaretçiyle yapılan her etkileşim (dokunma dahil)
//   tuş            — klavye işlemi (tuş basımı; yazılan metin TEK işlem sayılır,
//                    çünkü kullanıcı için "yazmak" tek bir eylemdir)
//   diyalog        — açılan/kapanan her modal (bağlam değiştirir, yeniden
//                    yönelim maliyeti yaratır)
//   bağlamDeğişimi — kullanıcının bakışının taşındığı her ana yüzey geçişi
//   kurtarma       — hata/boş durumdan çıkmak için atılan fazladan adım
//   süre           — duvar saati (ms). Makine yüküne duyarlıdır; TEK BAŞINA
//                    kanıt değildir, sayımlarla BİRLİKTE okunur.
//
// ── DÜRÜSTLÜK ───────────────────────────────────────────────────────────────
// Sayaçlar, harness'in FİİLEN yaptığı işlemleri sayar — tahmin etmez. Bir
// yolculuk ölçülemiyorsa `skip()` ile AÇIK gerekçeyle işaretlenir ve
// raporda "ölçülmedi" olarak görünür; sıfır maliyet gibi GÖSTERİLMEZ.

import fs from 'fs';
import path from 'path';
import type { Locator, Page } from '@playwright/test';

export interface JourneyCost {
  id: string;
  name: string;
  clicks: number;
  keys: number;
  dialogs: number;
  contextSwitches: number;
  recoveries: number;
  ms: number;
  status: 'measured' | 'skipped' | 'failed';
  note?: string;
}

// `writeFrictionReport()` birden cok kez cagrilabilir; her cagri TAM
// listeyi yazar (ustune ekleme yapmaz).
// Üretilen ölçüm raporu depo kuralına uyar (`e2e/_<ad>-report.json`): sürüm paketine GİRMEZ.
// Eskiden `journey-friction.json` yazılıyordu ve kaynak ağacında bayat ölçüm olarak kalıyordu.
const REPORT_PATH = path.join(__dirname, '..', '_journey-friction-report.json');
const collected: JourneyCost[] = [];

export class Journey {
  private readonly started = Date.now();
  private clicks = 0;
  private keys = 0;
  private dialogs = 0;
  private contextSwitches = 0;
  private recoveries = 0;
  private status: JourneyCost['status'] = 'measured';
  private note?: string;

  constructor(
    private readonly id: string,
    private readonly name: string,
    private readonly page: Page,
  ) {}

  /** İşaretçi etkileşimi — bir kullanıcı tıklaması. */
  async click(target: Locator, _label?: string): Promise<void> {
    this.clicks += 1;
    await target.click({ timeout: 20_000 });
  }

  /** Metin yazma — kullanıcı için TEK eylem (tuş tuş sayılmaz). */
  async type(target: Locator, text: string): Promise<void> {
    this.keys += 1;
    await target.fill(text);
  }

  /** Tek tuş (Enter, Escape, Tab, ...). */
  async press(key: string, target?: Locator): Promise<void> {
    this.keys += 1;
    if (target) await target.press(key);
    else await this.page.keyboard.press(key);
  }

  /**
   * Playwright `Locator`'i OLMAYAN ama kullanicinin GERCEKTEN yaptigi bir
   * isaretci eylemi (ornegin isletim sisteminin dosya secicisinde dosyayi
   * secmek). Maliyet kullaniciya aittir; olcum aracinin o pencereye
   * erisememesi maliyeti SIFIR yapmaz.
   */
  pointer(count = 1): void { this.clicks += count; }

  /** Açılan ya da kapanan bir modal. */
  dialog(count = 1): void { this.dialogs += count; }

  /** Ana yüzey geçişi (kanal → DM, sohbet → ayarlar, ...). */
  contextSwitch(count = 1): void { this.contextSwitches += count; }

  /** Hata/boş durumdan çıkmak için gereken fazladan adım. */
  recovery(count = 1): void { this.recoveries += count; }

  /** Ölçülemedi — AÇIK gerekçeyle. */
  skip(reason: string): void {
    this.status = 'skipped';
    this.note = reason;
  }

  fail(reason: string): void {
    this.status = 'failed';
    this.note = reason;
  }

  end(): JourneyCost {
    const cost: JourneyCost = {
      id: this.id,
      name: this.name,
      clicks: this.clicks,
      keys: this.keys,
      dialogs: this.dialogs,
      contextSwitches: this.contextSwitches,
      recoveries: this.recoveries,
      ms: Date.now() - this.started,
      status: this.status,
      ...(this.note ? { note: this.note } : {}),
    };
    collected.push(cost);
    return cost;
  }
}

export function journey(id: string, name: string, page: Page): Journey {
  return new Journey(id, name, page);
}

/** Toplanan ölçümleri diske yazar ve konsola özet basar. */
export function writeFrictionReport(): void {
  const measured = collected.filter((c) => c.status === 'measured');
  const totals = measured.reduce(
    (acc, c) => ({
      clicks: acc.clicks + c.clicks,
      keys: acc.keys + c.keys,
      dialogs: acc.dialogs + c.dialogs,
      contextSwitches: acc.contextSwitches + c.contextSwitches,
      recoveries: acc.recoveries + c.recoveries,
      ms: acc.ms + c.ms,
    }),
    { clicks: 0, keys: 0, dialogs: 0, contextSwitches: 0, recoveries: 0, ms: 0 },
  );

  const report = {
    generatedAt: new Date().toISOString(),
    journeys: collected,
    measuredCount: measured.length,
    skippedCount: collected.filter((c) => c.status === 'skipped').length,
    failedCount: collected.filter((c) => c.status === 'failed').length,
    totals,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

  const pad = (value: string | number, width: number) => String(value).padStart(width);
  console.log('\nYOLCULUK SURTUNME RAPORU');
  console.log('  id   tik  tus  diy  bag  kur   ms   durum  ad');
  for (const c of collected) {
    console.log(
      `  ${c.id.padEnd(4)}${pad(c.clicks, 4)}${pad(c.keys, 5)}${pad(c.dialogs, 5)}` +
      `${pad(c.contextSwitches, 5)}${pad(c.recoveries, 5)}${pad(c.ms, 6)}  ` +
      `${c.status.padEnd(8)}${c.name}${c.note ? ` (${c.note})` : ''}`,
    );
  }
  console.log(
    `  TOPLAM (olculen ${measured.length}): ${totals.clicks} tiklama, ${totals.keys} tus, ` +
    `${totals.dialogs} diyalog, ${totals.contextSwitches} baglam, ${totals.recoveries} kurtarma`,
  );
  console.log(`  Rapor: ${REPORT_PATH}`);
}
