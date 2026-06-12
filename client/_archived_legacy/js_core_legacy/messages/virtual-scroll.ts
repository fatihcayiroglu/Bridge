// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VirtualScrollPanel.svelte
//              client/js/core/virtual-scroll-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/messages/virtual-scroll.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// DOM penceresi sanal kaydırma — messages alt-modülü (aktif versiyon)
//
// core/virtual-scroll.ts'in messages/ altındaki canonical kopyası.
// Her zaman yüklenir; messages alt-modüllerinin son adımı.

export { virtualScrollReady } from '../virtual-scroll.js';

// Geriye dönük uyumluluk
export const messages_virtual_scrollReady = true;
