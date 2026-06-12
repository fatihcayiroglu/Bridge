// client/js/core/onboarding-tour-svelte.ts
// Sprint 116 — OnboardingTour mount shim (ADR-0008 Faz 3)
// Arayüz tanıtım turu overlay
import { mount } from 'svelte';
import OnboardingTour from './OnboardingTour.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('OnboardingTourShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountOnboardingTour(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('onboarding-tour-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'onboarding-tour-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(OnboardingTour, { target: el, props: {} });
  log.info('OnboardingTour mounted via shim');
}

export function unmountOnboardingTour(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountOnboardingTour(), { once: true });
} else {
  mountOnboardingTour();
}
document.addEventListener('bridge:socket-ready', () => mountOnboardingTour(), { once: true });
