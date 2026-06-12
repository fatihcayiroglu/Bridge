// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/MarketplaceStatePanel.svelte
//              client/js/core/marketplace-state-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bot-marketplace/marketplace-state.ts
const STORAGE_KEY = "bridge-installed-bots";

function _safeLocalStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function _safeLocalStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* non-fatal */ }
}

let _installedBots = new Set<string>(
  JSON.parse(_safeLocalStorageGet(STORAGE_KEY) ?? "[]") as string[]
);

export function getInstalledBots(): Set<string> { return _installedBots; }
export function isBotInstalled(id: string): boolean { return _installedBots.has(id); }
export function toggleInstalledLocal(id: string, install: boolean): void {
  if (install) _installedBots.add(id); else _installedBots.delete(id);
  _safeLocalStorageSet(STORAGE_KEY, JSON.stringify([..._installedBots]));
}

export function resetInstalledBots(): void {
  _installedBots = new Set<string>();
}

export function showToast(msg: string, type: "success" | "info" | "error" = "info"): void {
  const el = document.createElement("div");
  el.className = `mp-toast ${type}`; el.textContent = msg; document.body.appendChild(el);
  setTimeout(() => { el.classList.add("hide"); setTimeout(() => el.remove(), 220); }, 3000);
}
