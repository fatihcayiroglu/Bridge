// client/tests/core-registry-ownership.test.ts
// ÇEKİRDEK REGISTRY SAHİPLİĞİ — "çağrılıyor ama kayıtlı değil" kusuru.
//
// ════════════════════════════════════════════════════════════════════════════
// KUSUR AİLESİ
// ════════════════════════════════════════════════════════════════════════════
// `BridgeRegistry.call('x')` kayıtsız bir anahtarda SESSİZCE `undefined`
// döner — çökme yok, uyarı yok. Bu yüzden "kayıt yok" hatası kullanıcıya
// HİÇBİR ŞEY OLMAMASI olarak görünür.
//
// Bu programda aynı aile üç kez yakalandı:
//   · `apiFetch`          — on bileşen çağırıyordu, ÜRETİMDE hiç kayıt yoktu
//                           (DM, Arkadaşlar, Grup DM, Arama, E2EE, Çeviri ölü).
//   · `navigateToChannel` — `SearchPanel` KORUMASIZ çağırıyordu; arama
//                           sonucuna tıklamak paneli kapatıp HİÇBİR YERE
//                           gitmiyordu.
//   · `createChannel`     — kenar çubuğu "+" girişi hiç render edilmiyordu.
//
// Bu test ÇEKİRDEK anahtarların üretim kaynağında GERÇEKTEN kaydedildiğini
// doğrular. Dormant/deneysel modüller kapsam DIŞIDIR — onlar ürün değildir.

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

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function productionSources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|__tests__/.test(e.name)) walk(p); }
      else if (/\.(ts|svelte)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(path.join(CLIENT, 'js'));
  return out;
}

const CODE = productionSources()
  .map(f => fs.readFileSync(f, 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '');

const registered = new Set(
  [...CODE.matchAll(/BridgeRegistry\.register\(\s*'([^']+)'/g)].map(m => m[1]),
);

/** Kullanıcının GERÇEKTEN ulaştığı çekirdek yetenekler. */
const CORE_KEYS = [
  // HTTP / taşıma
  'apiFetch',
  // kabuk gezinme
  'openServerMenu', 'showInbox', 'showSaved', 'showDmPanel', 'showFriendsPanel', 'openSearchFromShell', 'openServerStart',
  // sunucu eylemleri
  'openInvitePanel', 'openCreateChannel', 'openServerSettings',
  // kanal
  'loadChannels', 'selectChannel', 'navigateToChannel', 'createChannel',
  // kişiler
  'openMemberProfile', 'openDm', 'openDmPanel',
  // mesajlaşma
  'sendMessage', 'setReplyTarget', 'startEditMessage', 'deleteMessage', 'saveForLater',
  // ayarlar
  'openSettingsModal',
];

describe('ÇEKİRDEK registry anahtarları üretimde KAYITLIDIR', () => {
  it('kaynak taraması anlamlı bir küme buldu (test kendini boşa düşürmez)', () => {
    expect(registered.size).toBeGreaterThan(100);
  });

  for (const key of CORE_KEYS) {
    it(`'${key}' üretimde register edilir`, () => {
      expect(registered.has(key)).toBe(true);
    });
  }
});

describe('ARAMA SONUCU gezinmesi ölü değildir', () => {
  it('SearchPanel navigateToChannel çağırır ve o anahtarın SAHİBİ vardır', () => {
    const sp = fs.readFileSync(path.join(CLIENT, 'js/core/SearchPanel.svelte'), 'utf8');
    expect(sp).toMatch(/navigateToChannel/);
    // Cagri var ise sahip ZORUNLUDUR — aksi halde sonuc tiklamasi sessizce oluyor.
    expect(registered.has('navigateToChannel')).toBe(true);
  });
});
