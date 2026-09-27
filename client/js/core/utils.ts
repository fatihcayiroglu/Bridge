export function escHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}
import { createLogger } from './logger.ts';
import { BridgeRegistry } from './bridge-registry.ts';

const log = createLogger('Toast');

export function toast(message: string, type = 'info', timeoutMs?: number): void {
  // Faz 8: alıcı ApiErrorToast.svelte'tir ve kendini BridgeRegistry'ye kaydeder.
  // Önceden yalnızca `globalThis.toast` deneniyordu ve o hiçbir yerde tanımlı
  // olmadığı için 199 çağrı yerinin tamamı sessizce kayboluyordu.
  if (BridgeRegistry.has('toast')) {
    BridgeRegistry.call('toast', message, type, timeoutMs);
    return;
  }
  // Geriye dönük uyumluluk: eski global sözleşme (varsa) hâlâ desteklenir.
  const fn = (globalThis as unknown as { toast?: (m: string, t?: string, ms?: number) => void }).toast;
  if (fn) { fn(message, type, timeoutMs); return; }
  // Hiçbir alıcı yoksa geri düşüş — ortak logger (no-console politikası korunur).
  if (type === 'error') log.error(message); else log.info(message);
}
export { toast as showToast };
