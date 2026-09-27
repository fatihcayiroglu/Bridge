// client/tests/dormant-owners.test.ts
// FAZ C4.7 — GROUP DM ARTIK UYKUDA DEĞİL (KARAR TERSİNE ÇEVRİLDİ).
//
// ════════════════════════════════════════════════════════════════════════════
// TARİHÇE — NEDEN UYKUDAYDI
// ════════════════════════════════════════════════════════════════════════════
// Faz 11'de Group DM istemcisi KASITLI olarak ürün yüzeyinden kaldırılmıştı.
// Gerekçeler ölçülmüştü:
//   1. `#gdm-root` gizliydi ve paneli görünür yapan `showGroupDmPanel`
//      çağrısı istemcide HİÇBİR YERDE yoktu — panel açılamıyordu.
//   2. Panel socket'i `window.socket` LEGACY GLOBAL'inden okuyordu; bu,
//      nesne-kimliği farkındalıklı yeniden bağlama mimarisinin dışında kalıp
//      İKİNCİ bir socket sahibi yaratıyordu.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN ARTIK CANLI
// ════════════════════════════════════════════════════════════════════════════
// Faz C4'te İKİ gerekçe de ortadan kaldırıldı:
//   • `{@html}` mesaj sink'i kaldırıldı; XSS regresyonlarıyla kilitlendi,
//   • panel kanonik `BridgeRegistry.get('socket')` sahibine nesne-kimliği
//     farkındalıklı biçimde bağlanır (DmPanel kalıbı),
//   • gerçek bir ürün açıcısı eklendi (FriendsPanel → `showGroupDmPanel`),
//   • sunucu tarafı yetkilendirme C4.3/C4.4/C4.5'te sertleştirildi,
//   • tasarım-sistemi borcu (29 sahte tokenizasyon + 6 ham renk) sıfırlandı.
//
// Bu dosya SİLİNMEDİ: kararın tersine çevrildiğini ve ARTIK ulaşılabilirliğin
// KASITLI olduğunu kayıt altına alır. Davranışsal ulaşılabilirlik kanıtı
// `tests/group-dm-reachability.test.ts` içindedir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountGroupDmPanel, unmountGroupDmPanel } from '../js/core/group-dm-svelte.ts';

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'gdm-root';
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  // Köprü modül YÜKLENİRKEN otomatik mount eder (üretim davranışı). Testler
  // temiz bir kabuktan başlasın diye tek-sahip durumu önce sıfırlanır.
  unmountGroupDmPanel();
  document.body.innerHTML = '';
  BridgeRegistry.register('apiFetch', async () => ({ ok: true, status: 200, json: async () => [] } as unknown as Response));
  BridgeRegistry.register('getMe', () => ({ id: 'u1' }));
});

afterEach(() => {
  unmountGroupDmPanel();
  BridgeRegistry.unregister('apiFetch');
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('socket');
  document.body.innerHTML = '';
});

describe('Group DM — ulaşılabilirlik KASITLIDIR (Faz 11 kararı tersine çevrildi)', () => {
  it('mount köprüsü paneli `#gdm-root` içine KURAR', () => {
    const root = makeRoot();

    mountGroupDmPanel();
    flushSync();
    // Panel GİZLİ mount edilir, yani açılmadan görsel çocuk üretmez.
    // Ulaşılabilirliğin kanıtı, gerçek açıcıdan sonra gövdenin KÖK İÇİNDE
    // belirmesidir (kabuk sözleşmesi böylece uçtan uca doğrulanır).
    (BridgeRegistry.get('showGroupDmPanel') as () => void)();
    flushSync();

    expect(root.querySelector('#gdm-panel')).not.toBeNull();
  });

  it('görünür kılan registry girişi ARTIK KAYITLIDIR', () => {
    makeRoot();

    mountGroupDmPanel();
    flushSync();

    expect(BridgeRegistry.has('showGroupDmPanel')).toBe(true);
    expect(BridgeRegistry.has('closeGroupDmPanel')).toBe(true);
  });

  it('mount edilir ama KENDİLİĞİNDEN AÇILMAZ (gizli mount sözleşmesi)', () => {
    makeRoot();

    mountGroupDmPanel();
    flushSync();

    // Panel gövdesi yalnız gerçek bir ürün eylemiyle görünür olur.
    expect(document.querySelector('#gdm-panel')).toBeNull();
  });

  it('GÜVENLİK: panel `window.socket` legacy global’ini KULLANMAZ', () => {
    makeRoot();
    // Legacy global bilerek YANLIŞ bir nesneye ayarlanır; panel bunu okursa
    // dinleyici oraya bağlanırdı.
    const legacy = { emit: () => {}, on: () => { throw new Error('legacy global kullanıldı'); }, off: () => {} };
    (window as unknown as Record<string, unknown>).socket = legacy;

    const canonical: Record<string, unknown> = {};
    const bound: string[] = [];
    BridgeRegistry.register('socket', {
      emit: () => {},
      on: (e: string) => { bound.push(e); },
      off: () => {},
      ...canonical,
    });

    mountGroupDmPanel();
    flushSync();

    expect(bound).toContain('gdm:message');   // KANONİK sahibe bağlandı
    delete (window as unknown as Record<string, unknown>).socket;
  });
});
