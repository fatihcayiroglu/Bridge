// Lightweight production owner for the global site-admin surface.
// AdminPanel and its Svelte runtime stay out of the initial app chunk; the
// command palette gets a real registry owner immediately and the heavy module
// is loaded only after an authorised user explicitly opens it.

import { BridgeRegistry } from '../core/bridge-registry.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('AdminLauncher');
let loadPromise: Promise<typeof import('./admin-svelte.ts')> | null = null;

function owner(): Promise<typeof import('./admin-svelte.ts')> {
  loadPromise ??= import('./admin-svelte.ts').catch((error) => {
    loadPromise = null;
    log.error('Admin paneli yüklenemedi', error);
    throw error;
  });
  return loadPromise;
}

export async function openAdminDashboard(): Promise<void> {
  try { (await owner()).openAdminDashboard(); }
  catch { void BridgeRegistry.call('toast', 'Admin paneli yüklenemedi. Tekrar deneyin.', 'error'); }
}

export async function closeAdminDashboard(): Promise<void> {
  if (!loadPromise) return;
  try { (await loadPromise).closeAdminDashboard(); } catch { /* load owner reports */ }
}

BridgeRegistry.register('openAdminDashboard', openAdminDashboard);
BridgeRegistry.register('closeAdminDashboard', closeAdminDashboard);
