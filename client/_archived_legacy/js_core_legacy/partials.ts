// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/PartialsPanel.svelte
//              client/js/core/partials-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/partials.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Büyük modal/panel HTML'lerini lazy load eder

import { BridgeRegistry } from './bridge-registry.js';

import { createLogger } from './logger.js';
const log = createLogger('Partials');


// ── Tip tanımları ─────────────────────────────────────────────

interface PartialEntry {
  containerId: string;
  trigger: string;
}

// ── Partial registry ──────────────────────────────────────────

const REGISTRY: Record<string, PartialEntry> = {
  'settings':   { containerId: 'settings-modal-container',  trigger: '#settings-modal' },
  'addserver':  { containerId: 'addserver-modal-container', trigger: '#addserver-modal' },
  'friends':    { containerId: 'friends-panel-container',   trigger: '#friends-panel' },
  'dm-call':    { containerId: 'dm-call-container',         trigger: '#dm-call-overlay' },
};

const _loaded = new Set<string>();

async function load(name: string): Promise<boolean> {
  if (_loaded.has(name)) return true;
  const entry = REGISTRY[name];
  if (!entry) return false;

  try {
    const r = await fetch(`/partials/${name}.html`);
    if (!r.ok) return false;
    const html = await r.text();
    const container = document.getElementById(entry.containerId);
    if (container) {
      container.innerHTML = html;
      _loaded.add(name);
      return true;
    }
  } catch (e) {
    log.warn(`[Partials] ${name} yüklenemedi:`, (e as Error).message);
  }
  return false;
}

async function ensureLoaded(name: string): Promise<boolean> {
  return _loaded.has(name) || load(name);
}

function preloadVisible(): void {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const name = (entry.target as HTMLElement).dataset.partial;
        if (name) void load(name);
      }
    });
  }, { rootMargin: '200px' });

  document.querySelectorAll('[data-partial]').forEach(el => observer.observe(el));
}

function init(): void {
  preloadVisible();
  setTimeout(() => void load('settings'), 2000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init());
} else {
  init();
}

export const Partials = { load, ensureLoaded, init, isLoaded: (n: string) => _loaded.has(n) };
export const getPartials = (): typeof Partials | null =>
  (BridgeRegistry.get('Partials') as typeof Partials | null) ?? Partials;
