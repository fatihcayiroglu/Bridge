// client/js/core/onboarding-wizard-svelte.ts
// Sprint 116 — OnboardingWizard mount shim (ADR-0008 Faz 3)
// Adım adım onboarding sihirbazı
import { mount, unmount } from 'svelte';
import OnboardingWizard from './OnboardingWizard.svelte';
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
  // Faz 8.1: önceden yalnızca referans null'lanıyordu — bileşen DOM'da ve
  // dinleyicileri bağlı kalıyordu (sızıntı). Gerçekten unmount edilir.
  if (!_instance) return;
  const inst = _instance;
  _instance = null;
  void unmount(inst);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountOnboardingWizard(), { once: true });
} else {
  mountOnboardingWizard();
}
document.addEventListener('bridge:socket-ready', () => mountOnboardingWizard(), { once: true });

/**
 * Geriye dönük uyumluluk ihracı.
 *
 * Faz 8.1: burada `bridge_onboarding_completed` anahtarı okunuyordu; bileşenin
 * gerçekte kullandığı anahtar `bridge_onboarding_v3:<userId>` olduğu için bu
 * kontrol hiçbir zaman doğru sonuç vermiyordu. Uygunluk kararı tek yerde —
 * OnboardingWizard.svelte içinde (oturum + kullanıcı bazlı) verilir; shim
 * yalnızca mount eder.
 */
export function maybeShowOnboarding(): void {
  mountOnboardingWizard();
}
