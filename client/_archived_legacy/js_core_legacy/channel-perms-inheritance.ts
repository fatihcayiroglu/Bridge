// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ChannelPermsInheritancePanel.svelte
//              client/js/core/channel-perms-inheritance-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { BridgeRegistry } from './bridge-registry.js';
// client/js/core/channel-perms-inheritance.ts
// Sprint 47: window.chpermsShowInheritance → BridgeRegistry
// modal-core.ts içinden chpermsShowInheritance BridgeRegistry'ye kaydedilir;
// bu dosya sadece geriye-dönük uyumluluk için noop sağlıyordu.
// Artık BridgeRegistry üzerinden çağırıyor — window.* bağımlılığı yok.

export const channelPermsInheritanceReady = true;

/**
 * Geriye-dönük uyumluluk wrapper.
 * Gerçek implementasyon channel-perms/modal-core.ts içinde
 * BridgeRegistry'ye 'chpermsShowInheritance' adıyla kaydediliyor.
 * @deprecated channel-perms-init.ts'in initChannelPerms() çağrıldıktan sonra
 *             bu fonksiyon doğrudan çağrılmamalı; BridgeRegistry.call kullan.
 */
export function showChannelPermsInheritance(btn?: unknown): void {
  BridgeRegistry.call('chpermsShowInheritance', btn);
}
