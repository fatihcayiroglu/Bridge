// client/js/core/group-dm-svelte.ts
// ADR-0008 Faz 2 — GroupDmPanel.svelte mount + geriye dönük uyumluluk shim
//
// group-dm.ts'teki tüm dışa aktarımlar BridgeRegistry üzerinden
// erişilebilir; mevcut socket kodu değişmez.
//
// Sprint 113

import { mount, unmount } from 'svelte';
import GroupDmPanel        from './GroupDmPanel.svelte';
import { BridgeRegistry }  from './bridge-registry.ts';
import './group-dm-voice.ts'; // incoming + outgoing GDM call signaling owner

let _panelInstance: ReturnType<typeof mount> | null = null;

// ── Mount ─────────────────────────────────────────────────────────────────

export function mountGroupDmPanel(targetId = 'gdm-root'): void {
  if (_panelInstance) return;

  let target = document.getElementById(targetId);
  if (!target) {
    target = document.createElement('div');
    target.id = targetId;
    document.body.appendChild(target);
  }

  _panelInstance = mount(GroupDmPanel, { target, props: {} });
}

/**
 * Paneli söker ve tek-sahip guard'ını sıfırlar.
 * `dm-svelte.ts:24` (`unmountDmPanel`) ile aynı sözleşme. Bileşenin
 * `onDestroy`u socket dinleyicilerini REFERANSLA çözer.
 */
export function unmountGroupDmPanel(): void {
  if (!_panelInstance) return;
  void unmount(_panelInstance);
  _panelInstance = null;
}

// ── Geriye dönük uyumluluk ────────────────────────────────────────────────

export function openGroupDmPanel(): void {
  mountGroupDmPanel();
  if (BridgeRegistry.has('showGroupDmPanel')) {
    BridgeRegistry.call('showGroupDmPanel');
    return;
  }
  // `mount()` sonrası onMount kaydı bir mikro-görevde tamamlanabilir. Legacy
  // export bu dar yarışta çağrılırsa görünürlüğü DOM stiliyle ikinci kez
  // sahiplenmek yerine kanonik registry sahibini bir kez daha dener.
  queueMicrotask(() => BridgeRegistry.call('showGroupDmPanel'));
}

// Faz 11 — KAYIT KALDIRILDI. Bu ad hiçbir yerden çağrılmıyordu; kayıtlı
// bırakmak, tamamlanmamış bir paneli açabilecek bir kanca bırakmak olurdu.
// Gerçek bir Group DM ürün akışı yazıldığında yeniden kaydedilir.

export async function loadGroupDmList(): Promise<void> {
  await BridgeRegistry.get('groupDmPanel:loadList')?.();
}

export function openGroupDm(group: Record<string, unknown>): void {
  BridgeRegistry.get('groupDmPanel:openGroupDm')?.(group);
}

// ── Bootstrap — mount timing ─────────────────────────────────────────────
//
// voice-svelte.ts ile aynı strateji (ADR-0008):
//
//   DOMContentLoaded — DOM hazır olduğunda paneli bağlar.
//     GroupDmPanel, socket bağımlılıklarını lazy getter ile çözümlediğinden
//     socket hazır olmadan mount edilmesi güvenlidir.
//
//   bridge:socket-ready — Modül geç yüklendiyse güvenlik ağı.
//     mountGroupDmPanel() guard (_panelInstance) çifte mount'u önler.

// ── FAZ C4.7: GROUP DM CANLIYA ALINDI ────────────────────────────────────
//
// Faz 11'de bu istemci KASITLI olarak uykuya alınmıştı ve gerekçeleri
// ölçülmüştü:
//
//   • `#gdm-root` kalıcı olarak gizliydi ve paneli açan hiçbir çağrı yoktu,
//   • GroupDmPanel socket'i `window.socket` LEGACY GLOBAL'inden okuyordu;
//     bu, nesne-kimliği farkındalıklı yeniden bağlama mimarisinin dışında
//     kalıyor ve İKİNCİ bir socket sahibi yaratıyordu.
//
// Faz C4'te İKİ gerekçe de ortadan kaldırıldı:
//   • panel artık kanonik `BridgeRegistry.get('socket')` sahibine
//     nesne-kimliği farkındalıklı biçimde bağlanır (DmPanel kalıbı),
//   • `{@html}` mesaj sink'i kaldırıldı ve XSS regresyonlarıyla kilitlendi,
//   • gerçek bir ürün açıcısı eklendi (FriendsPanel → `showGroupDmPanel`),
//   • sunucu tarafı yetkilendirme C4.3/C4.4/C4.5'te sertleştirildi.
//
// Bu yüzden otomatik mount GERİ GETİRİLDİ — DmPanel (dm-svelte.ts:29) ile
// AYNI kabuk sözleşmesi: panel `#gdm-root`a GİZLİ mount edilir, yalnız
// gerçek bir kullanıcı eylemi onu görünür yapar.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountGroupDmPanel(), { once: true });
} else {
  mountGroupDmPanel();
}
// Modül geç yüklenirse güvenlik ağı; `_panelInstance` guard'ı çifte mount'u
// önler (tek kanonik sahip).
document.addEventListener('bridge:socket-ready', () => mountGroupDmPanel(), { once: true });
