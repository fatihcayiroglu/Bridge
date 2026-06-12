// client/js/core/onboarding-svelte.ts
// Sprint 116 — OnboardingFlow mount shim (ADR-0008 Faz 3)
// Yeni sunucu kurulum akışı
import { mount } from 'svelte';
import OnboardingFlow from './OnboardingFlow.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('OnboardingFlowShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountOnboardingFlow(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('onboarding-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'onboarding-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(OnboardingFlow, { target: el, props: {} });
  log.info('OnboardingFlow mounted via shim');
}

export function unmountOnboardingFlow(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountOnboardingFlow(), { once: true });
} else {
  mountOnboardingFlow();
}
document.addEventListener('bridge:socket-ready', () => mountOnboardingFlow(), { once: true });
