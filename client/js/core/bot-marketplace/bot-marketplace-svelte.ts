// Canonical production mount/registry owner for BotMarketplace.svelte.
//
// Keep the registry owner in the initial graph, but lazy-load the heavy Svelte
// marketplace only when the user opens it. This preserves production
// reachability without paying marketplace rendering/catalog cost at startup.

import { BridgeRegistry } from '../bridge-registry.ts';
import { closeExclusivePeers } from '../exclusive-surface.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('BotMarketplaceShim');
type Unmount = (component: unknown) => void | Promise<void>;
let instance: unknown = null;
let unmountOwner: Unmount | null = null;
let host: HTMLElement | null = null;
let returnFocus: HTMLElement | null = null;
let generation = 0;

export function closeBotMarketplace(restoreFocus = true): void {
  generation += 1; // invalidate a dynamic import still in flight
  const mounted = instance;
  const mountedHost = host;
  const dispose = unmountOwner;
  const focusTarget = returnFocus;
  instance = null;
  unmountOwner = null;
  host = null;
  returnFocus = null;
  if (mounted && dispose) void dispose(mounted);
  if (mountedHost?.isConnected) mountedHost.remove();
  if (restoreFocus && focusTarget?.isConnected) queueMicrotask(() => focusTarget.focus());
}

export async function openBotMarketplace(): Promise<void> {
  if (instance || host) { closeBotMarketplace(); return; }
  closeExclusivePeers('marketplace');
  const myGeneration = ++generation;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const target = document.createElement('div');
  target.id = 'bot-marketplace-root';
  document.body.appendChild(target);
  host = target;

  try {
    const [{ mount, unmount }, { default: BotMarketplace }] = await Promise.all([
      import('svelte'),
      import('./BotMarketplace.svelte'),
    ]);
    if (generation !== myGeneration || host !== target || !target.isConnected) return;
    unmountOwner = unmount as Unmount;
    instance = mount(BotMarketplace, {
      target,
      props: { onClose: () => closeBotMarketplace() },
    });
  } catch (error) {
    log.error('Bot Marketplace yüklenemedi', error);
    if (generation === myGeneration) {
      closeBotMarketplace();
      void BridgeRegistry.call('toast', 'Bot Marketplace yüklenemedi. Tekrar deneyin.', 'error');
    }
  }
}

BridgeRegistry.register('openMarketplacePage', openBotMarketplace);
BridgeRegistry.register('openBotMarketplace', openBotMarketplace);
BridgeRegistry.register('closeBotMarketplace', closeBotMarketplace);
