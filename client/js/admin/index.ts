// client/js/admin/index.ts
// Sprint 118: Admin paneli tam Svelte 5 migrasyonu tamamlandı.
// Eski 10 vanilla TS dosyası → client/_archived_legacy/admin_legacy/
//
// Tüm admin işlevselliği AdminPanel.svelte + admin-svelte.ts üzerinden yürütülür.
// BridgeRegistry kaydı admin-svelte.ts içinde yapılır.

export { adminInjectButton, openAdminDashboard, adminTab } from './admin-svelte';
