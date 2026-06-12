// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ChannelPermsAuditPanel.svelte
//              client/js/core/channel-perms-audit-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/channel-perms-audit.ts
// Sprint 33: Functionality absorbed into channel-perms/modal-audit.ts
// This re-exports for backward compat

export { channelPermsAuditReady } from './channel-perms/modal-audit';
