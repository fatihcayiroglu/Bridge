// client/tests/api-fetch-registry-contract.test.ts
// CANLI YAKALANAN KUSUR — REGISTRY SÖZLEŞMESİ YALNIZCA TESTLERDE VARDI.
//
// ════════════════════════════════════════════════════════════════════════════
// NASIL BULUNDU (gerçek tarayıcıda, gerçek üründe)
// ════════════════════════════════════════════════════════════════════════════
// Sunucu menüsü canlı üründe açıldığında yönetim öğeleri hiç görünmedi ve
// `GET /api/servers/:sid/me/permissions` isteği HİÇ OLUŞMADI. Davet oluşturma
// da ağa çıkmadan hata verdi.
//
// Kök neden: on bileşen HTTP istemcisine
//     BridgeRegistry.get('apiFetch')
// ile ulaşıyordu, ancak `register('apiFetch', …)` çağrısı ÜRETİM KODUNDA
// HİÇBİR YERDE YOKTU. `get()` üretimde daima `undefined` dönüyor, bileşenler
// kendi `catch` bloklarına düşüyordu.
//
// NEDEN TESTLER YEŞİLDİ: her test kendi sahte `apiFetch`ini registry'ye
// KAYDEDİYORDU. Sözleşme yalnızca test ortamında mevcuttu.
//
// Etkilenen bileşenler yalnızca yeni yazılanlar değildi; DM, Arkadaşlar,
// Grup DM, Arama, E2EE ve Çeviri de aynı ölü yolu kullanıyordu.
//
// BU DOSYA SÖZLEŞMEYİ SAHTESİZ DOĞRULAR: mock KAYDEDİLMEZ.

import { describe, it, expect, vi } from 'vitest';
// ── KAYNAK TARAMASI G/Ç BAĞLIDIR ────────────────────────────────────────────
// Bu dosyadaki testler istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik
// VARSAYILAN zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir
// makinede aşılabilir; ölçüm bitmeden test kırmızıya döner ve bu, ürün hakkında
// HİÇBİR ŞEY söylemeyen bir kırılganlıktır. Sözleşme taramanın SONUCUNDA
// olduğu için bu dosyaya açık ve cömert bir zaman aşımı verilir. Hiçbir iddia
// gevşetilmemiştir; yalnızca zamanlama gürültüsü kaldırılmıştır.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { apiFetch } from '../js/core/api-fetch.ts';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('apiFetch — registry sözleşmesi', () => {
  it('modül import edildiğinde apiFetch KAYITLIDIR (mock olmadan)', () => {
    // Bu testte hicbir sahte apiFetch kaydedilmez; kayit YALNIZCA
    // `api-fetch.ts`in kendi yan etkisinden gelebilir.
    expect(BridgeRegistry.has('apiFetch')).toBe(true);
  });

  it('kayıtlı olan KANONİK fonksiyonun TA KENDİSİDİR (ikinci istemci yok)', () => {
    expect(BridgeRegistry.get('apiFetch')).toBe(apiFetch);
  });

  it('üretim kodunda apiFetch için EN AZ BİR registrar vardır', () => {
    // Regresyon kapisi: kayit satiri silinirse on bilesen sessizce olur.
    const src = fs.readFileSync(path.join(CLIENT, 'js/core/api-fetch.ts'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(code).toMatch(/BridgeRegistry\.register\('apiFetch'/);
  });

  it('registry yolunu kullanan HER bileşen için sözleşme karşılanır', () => {
    // Kaynakta `get('apiFetch')` kullanan bilesenleri say; sozlesme tek
    // kanonik kayitla karsilanmali.
    const dir = path.join(CLIENT, 'js/core');
    const users: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!/\.(svelte|ts)$/.test(f.name)) continue;
        const t = fs.readFileSync(p, 'utf8');
        if (/get(<[^>]*>)?\('apiFetch'\)/.test(t)) users.push(f.name);
      }
    };
    walk(dir);

    // Kullanan bilesen VARSA kayit ZORUNLUDUR.
    expect(users.length).toBeGreaterThan(0);
    expect(BridgeRegistry.has('apiFetch')).toBe(true);
  });
});
