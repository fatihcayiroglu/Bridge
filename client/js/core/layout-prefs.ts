import { createLogger } from './logger.ts';

export type BridgeLayoutMode = 'comfortable' | 'compact' | 'cozy' | 'classic' | 'focus';

const log = createLogger('LayoutPrefs');

const VALID_LAYOUT_MODES = new Set<BridgeLayoutMode>([
  'comfortable', 'compact', 'cozy', 'classic', 'focus',
]);

type LayoutSubscriber = (mode: BridgeLayoutMode) => void;

let currentMode: BridgeLayoutMode = 'comfortable';
const subscribers = new Set<LayoutSubscriber>();

export function isBridgeLayoutMode(value: unknown): value is BridgeLayoutMode {
  return typeof value === 'string' && VALID_LAYOUT_MODES.has(value as BridgeLayoutMode);
}

export function getLayoutMode(): BridgeLayoutMode {
  return currentMode;
}

export function setLayoutMode(mode: BridgeLayoutMode): void {
  if (!isBridgeLayoutMode(mode)) throw new TypeError('Invalid Bridge layout mode');
  if (mode === currentMode) return;
  currentMode = mode;
  // Snapshot iteration makes unsubscribe-during-notification deterministic.
  // Isolate subscribers: one broken UI consumer must not prevent every other
  // mounted surface from observing the already-committed layout change.
  for (const subscriber of [...subscribers]) {
    try { subscriber(mode); }
    catch (err) {
      // Do not roll back `currentMode`: the mutation already committed. Keep
      // delivery progressing and surface the faulty consumer for diagnostics.
      try { log.error('subscriber failed', err); } catch { /* logger may be stubbed */ }
    }
  }
}

export function subscribeLayoutMode(cb: LayoutSubscriber): () => void {
  if (typeof cb !== 'function') throw new TypeError('Layout subscriber must be a function');
  subscribers.add(cb);
  try { cb(currentMode); }
  catch (err) {
    // Initial delivery is part of the same observable contract as later
    // updates: a broken consumer must not make subscription itself throw.
    try { log.error('subscriber failed', err); } catch { /* logger may be stubbed */ }
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(cb);
  };
}

/** Test-only reset; production callers should not depend on this. */
export function __resetLayoutPrefsForTests(): void {
  currentMode = 'comfortable';
  subscribers.clear();
}
