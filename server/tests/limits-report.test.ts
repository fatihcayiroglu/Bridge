// server/tests/limits-report.test.ts
//
// KATMANLI SINIRLARIN GÖRÜLEBİLİRLİĞİ
//
// Ölçüm sırasında ortaya çıkan gerçek sorun: "100 eşzamanlı istemci"
// hedefine ulaşmak, ÜÇ AYRI ve bağımsız kontrolün bulunmasını gerektirdi
// (`MAX_WS_PER_IP`, `RL_REGISTER_MAX`, `MAX_REG_PER_HOUR`). Hiçbiri yanlış
// değildi; hiçbiri de görünür değildi.
//
// Bu testler raporun DOĞRU ve EKSİKSİZ kalmasını sağlar. Rapor bir güvenlik
// kontrolü değildir — ama yanlış/eksik bir rapor, operatörü yanlış katmanda
// arattırır ve gerçek bir sorunu gizler.

import { collectLimits } from '../lib/limitsReport';

const ENV_KEYS = [
  'MAX_WS_PER_IP', 'MAX_WS_PER_USER', 'MAX_UNAUTH_WS_PER_IP',
  'RL_REGISTER_MAX', 'MAX_REG_PER_HOUR', 'RL_LOGIN_MAX',
  'MAX_FAILED_LOGINS', 'RL_GLOBAL_MAX', 'RL_SHARED_IP_FACTOR',
];

describe('katmanlı sınır raporu', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('ÖLÇÜMDE ENGEL OLAN ÜÇ KATMANIN HEPSİ raporda', () => {
    // Bu üçü birlikte bulunmazsa aynı tuzak tekrar kurulur.
    const envs = collectLimits().map(r => r.env);
    for (const e of ['MAX_WS_PER_IP', 'RL_REGISTER_MAX', 'MAX_REG_PER_HOUR']) {
      expect({ e, present: envs.includes(e) }).toEqual({ e, present: true });
    }
  });

  it('kayıt HIZI ile kayıt KOTASI AYRI katman olarak gösteriliyor', () => {
    // En pahalı yanılgı buydu: hız sınırını yükseltmek saatlik kotayı
    // AÇMIYOR. Rapor bu ayrımı açıkça göstermeli.
    const rows = collectLimits();
    const rate  = rows.find(r => r.env === 'RL_REGISTER_MAX');
    const quota = rows.find(r => r.env === 'MAX_REG_PER_HOUR');
    expect(rate?.layer).not.toBe(quota?.layer);
    expect(quota?.layer).toContain('AYRI');
  });

  it('varsayılanlar ÜRÜN değerleriyle aynı', () => {
    // Rapor yanlış bir varsayılan gösterirse operatör, gevşetilmiş bir
    // sınırı varsayılan sanabilir.
    const rows = collectLimits();
    const expected: Record<string, number> = {
      MAX_WS_PER_IP: 10, MAX_WS_PER_USER: 5, MAX_UNAUTH_WS_PER_IP: 3,
      RL_REGISTER_MAX: 5, MAX_REG_PER_HOUR: 3, RL_LOGIN_MAX: 10,
      MAX_FAILED_LOGINS: 5, RL_GLOBAL_MAX: 200, RL_SHARED_IP_FACTOR: 20,
    };
    for (const [env, val] of Object.entries(expected)) {
      const row = rows.find(r => r.env === env);
      expect({ env, fallback: row?.fallback }).toEqual({ env, fallback: val });
    }
  });

  it('ortam değişkeni SAPMASI tespit ediliyor', () => {
    process.env.MAX_WS_PER_IP = '500';
    const row = collectLimits().find(r => r.env === 'MAX_WS_PER_IP');
    expect({ value: row?.value, overridden: row?.value !== row?.fallback })
      .toEqual({ value: 500, overridden: true });
  });

  it('sapma YOKKEN yanlış alarm üretmiyor', () => {
    const overridden = collectLimits().filter(r => r.value !== r.fallback);
    expect(overridden).toEqual([]);
  });

  it('her satır 429 görüldüğünde bakılacak KATMANI söylüyor', () => {
    // "Sunucu bazen 429 veriyor" teşhisini mümkün kılan tek şey budur.
    const vague = collectLimits().filter(r => !r.layer || r.layer.length < 10).map(r => r.env);
    expect(vague).toEqual([]);
  });

  it('geçersiz ortam değeri varsayılana düşer (sunucu açılmayı sürdürür)', () => {
    process.env.RL_GLOBAL_MAX = 'abc';
    const row = collectLimits().find(r => r.env === 'RL_GLOBAL_MAX');
    // Uygulanan varsayılan 200'dür (Final21 Faz 11 — rapor 300 gösteriyordu).
    expect(row?.value).toBe(200);
  });
});
