// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VoiceActionsPanel.svelte
//              client/js/core/voice-actions-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/voice-actions.ts
// Sprint 113 — VoicePanel.svelte Svelte action'ları
// <script lang="ts" module> bloğu .svelte içinde geçersiz sözdizimi olduğundan
// action'lar bu ayrı modüle taşındı.

/**
 * Svelte action: MediaStream'i video elementinin srcObject'ine bağlar.
 * $state reaktivitesiyle çalışır — stream değişince otomatik güncellenir.
 *
 * Kullanım: <video use:setSrcObject={stream}></video>
 */
export function setSrcObject(
  node: HTMLVideoElement,
  stream: MediaStream | null | undefined,
) {
  if (stream !== undefined) node.srcObject = stream ?? null;
  return {
    update(newStream: MediaStream | null | undefined) {
      if (newStream !== undefined) node.srcObject = newStream ?? null;
    },
    destroy() {
      node.srcObject = null;
    },
  };
}
