// Bridge v1.125 — product-level preferences that are intentionally local to a
// client installation. These values affect presentation/optional assistance;
// they are not authorization or privacy policy decisions on the server.
import { BridgeRegistry } from './bridge-registry.ts';

export type UiDensity = 'comfortable' | 'compact';

const DENSITY_KEY = 'bridge_ui_density';
const AI_KEY = 'bridge_ai_assistance';

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function getUiDensity(): UiDensity {
  return storage()?.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
}

export function setUiDensity(value: UiDensity): UiDensity {
  const next: UiDensity = value === 'compact' ? 'compact' : 'comfortable';
  storage()?.setItem(DENSITY_KEY, next);
  document.documentElement.dataset.uiDensity = next;
  document.dispatchEvent(new CustomEvent('bridge:ui-density-changed', { detail: { density: next } }));
  return next;
}

export function getAiAssistanceEnabled(): boolean {
  // Privacy-first: absence is OFF. No AI request is permitted merely because a
  // server happens to have an AI provider configured.
  return storage()?.getItem(AI_KEY) === 'enabled';
}

export function setAiAssistanceEnabled(enabled: boolean): boolean {
  const next = Boolean(enabled);
  storage()?.setItem(AI_KEY, next ? 'enabled' : 'disabled');
  document.documentElement.dataset.aiAssistance = next ? 'enabled' : 'disabled';
  document.dispatchEvent(new CustomEvent('bridge:ai-assistance-changed', { detail: { enabled: next } }));
  return next;
}

export function initProductPreferences(): void {
  document.documentElement.dataset.uiDensity = getUiDensity();
  document.documentElement.dataset.aiAssistance = getAiAssistanceEnabled() ? 'enabled' : 'disabled';

  BridgeRegistry.register('getUiDensity', getUiDensity);
  BridgeRegistry.register('setUiDensity', setUiDensity);
  BridgeRegistry.register('getAiAssistanceEnabled', getAiAssistanceEnabled);
  BridgeRegistry.register('setAiAssistanceEnabled', setAiAssistanceEnabled);
}

initProductPreferences();
