export function escHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}
export function toast(message: string, type = 'info', timeoutMs?: number): void {
  const fn = (globalThis as unknown as { toast?: (m: string, t?: string, ms?: number) => void }).toast;
  if (fn) fn(message, type, timeoutMs);
  else console[type === 'error' ? 'error' : 'log'](message);
}
export { toast as showToast };
