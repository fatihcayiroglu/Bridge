// client/js/core/error-boundary-svelte.ts
// Sprint 116 — ErrorBoundary mount shim (ADR-0008 Faz 3)
// Hata sınırı yakalayıcı bileşeni
import { mount } from 'svelte';
import ErrorBoundary from './ErrorBoundary.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ErrorBoundaryShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountErrorBoundary(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('error-boundary-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'error-boundary-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ErrorBoundary, { target: el, props: {} });
  log.info('ErrorBoundary mounted via shim');
}

export function unmountErrorBoundary(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountErrorBoundary(), { once: true });
} else {
  mountErrorBoundary();
}
document.addEventListener('bridge:socket-ready', () => mountErrorBoundary(), { once: true });

// Legacy compatibility export used by app.ts.
export const errorBoundary = {
  wrap<T extends (...args: unknown[]) => unknown>(fn: T, context = 'app') {
    return ((...args: Parameters<T>) => {
      try {
        const result = fn(...args);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          return (result as Promise<unknown>).catch((err: unknown) => {
            console.error(`[Bridge:${context}]`, err);
          });
        }
        return result;
      } catch (err) {
        console.error(`[Bridge:${context}]`, err);
        return undefined;
      }
    }) as T;
  },
};
