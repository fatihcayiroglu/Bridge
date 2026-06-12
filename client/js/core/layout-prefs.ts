export type BridgeLayoutMode = 'comfortable' | 'compact' | 'cozy' | 'classic' | 'focus';
let currentMode: BridgeLayoutMode = 'comfortable';
export function getLayoutMode(): BridgeLayoutMode { return currentMode; }
export function setLayoutMode(mode: BridgeLayoutMode): void { currentMode = mode; }
export function subscribeLayoutMode(cb: (mode: BridgeLayoutMode) => void): () => void { cb(currentMode); return () => {}; }
