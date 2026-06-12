// client/js/core/onboarding-wizard-svelte.ts
// Sprint 116 — OnboardingWizard mount shim (ADR-0008 Faz 3)
// Adım adım onboarding sihirbazı
import { mount } from 'svelte';
import OnboardingWizard from './OnboardingWizard.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('OnboardingWizardShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountOnboardingWizard(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('onboarding-wizard-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'onboarding-wizard-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(OnboardingWizard, { target: el, props: {} });
  log.info('OnboardingWizard mounted via shim');
}

export function unmountOnboardingWizard(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountOnboardingWizard(), { once: true });
} else {
  mountOnboardingWizard();
}
document.addEventListener('bridge:socket-ready', () => mountOnboardingWizard(), { once: true });

// Legacy compatibility export used by app.ts.
export function maybeShowOnboarding(): void {
  const shown = localStorage.getItem('bridge_onboarding_completed');
  if (!shown) mountOnboardingWizard();
}
