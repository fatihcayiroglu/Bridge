// client/js/core/settings-modal-svelte.ts
// Phase 9 — canonical user-settings modal owner.
//
// The old shim mounted SettingsModalBridge, an inert placeholder that could
// neither open settings nor render a tab. This module now owns the reachable
// BridgeRegistry contract and mounts the real SettingsModal only while open.

import { mount, unmount } from 'svelte';
import SettingsModal from './settings/SettingsModal.svelte';
import type { SettingsTab } from './settings/stores/settingsStore.ts';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';

const log = createLogger('SettingsModalShim');

const SETTINGS_TABS = new Set<SettingsTab>([
  'profile', 'appearance', 'notifications', 'privacy', 'devices',
]);

type ModalInstance = ReturnType<typeof mount>;

let _instance: ModalInstance | null = null;
let _target: HTMLElement | null = null;
let _trigger: HTMLElement | null = null;
let _ownerMounted = false;
let _operation: Promise<void> = Promise.resolve();

function onSettingsTrigger(event: MouseEvent): void {
  const trigger = event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-bridge-action="openSettingsModal"]')
    : null;
  if (!trigger) return;
  event.preventDefault();
  void openSettingsModal(trigger, validTab(trigger.dataset.bridgeArg));
}

function validTab(value: unknown): SettingsTab {
  return typeof value === 'string' && SETTINGS_TABS.has(value) ? value : 'profile';
}

function elementFrom(value: unknown): HTMLElement | null {
  return typeof HTMLElement !== 'undefined' && value instanceof HTMLElement ? value : null;
}

function resolveTarget(preferred?: HTMLElement): HTMLElement {
  const found = preferred ?? _target ?? document.getElementById('settings-modal-container');
  if (found) {
    _target = found;
    return found;
  }

  // Production index.html provides this node. The fallback keeps isolated
  // embeds/tests safe without inventing a second mount ID.
  const created = document.createElement('div');
  created.id = 'settings-modal-container';
  document.body.appendChild(created);
  _target = created;
  return created;
}

function enqueue(work: () => Promise<void>): Promise<void> {
  _operation = _operation.then(work, work);
  return _operation;
}

async function destroyModal(restoreFocus: boolean): Promise<void> {
  const instance = _instance;
  const trigger = _trigger;
  _instance = null;
  _trigger = null;

  if (instance) await unmount(instance);

  if (restoreFocus && trigger?.isConnected) {
    queueMicrotask(() => trigger.focus({ preventScroll: true }));
  }
  if (instance) {
    document.dispatchEvent(new CustomEvent('bridge:settings-closed'));
    log.info('Ayarlar kapatıldı');
  }
}

/**
 * Opens settings. The first argument supports both direct calls
 * (`openSettingsModal('appearance')`) and index.html's data-action dispatcher,
 * which passes the trigger element first.
 */
export function openSettingsModal(
  triggerOrTab?: HTMLElement | SettingsTab | null,
  requestedTab?: SettingsTab,
): Promise<void> {
  const explicitTrigger = elementFrom(triggerOrTab);
  const tab = validTab(explicitTrigger ? requestedTab : triggerOrTab);

  return enqueue(async () => {
    // Reopening with another tab intentionally remounts the small modal state;
    // this avoids a second tab store in the shim.
    const previousTrigger = _trigger;
    const activeBeforeOpen = elementFrom(document.activeElement);
    if (_instance) await destroyModal(false);

    _trigger = explicitTrigger
      ?? (activeBeforeOpen && !_target?.contains(activeBeforeOpen) ? activeBeforeOpen : previousTrigger);
    const target = resolveTarget();

    _instance = mount(SettingsModal, {
      target,
      props: {
        initialTab: tab,
        onClose: () => { void closeSettingsModal(); },
      },
    });
    document.dispatchEvent(new CustomEvent('bridge:settings-opened', { detail: { tab } }));
    log.info(`Ayarlar açıldı (${tab})`);
  });
}

export function closeSettingsModal(): Promise<void> {
  return enqueue(() => destroyModal(true));
}

/** Register the single reachable settings-modal owner. */
export function mountSettingsModalBridge(target?: HTMLElement): void {
  if (target) _target = target;
  resolveTarget(target);
  if (_ownerMounted) return;

  BridgeRegistry.register('openSettingsModal', openSettingsModal);
  BridgeRegistry.register('closeSettingsModal', closeSettingsModal);
  BridgeRegistry.register('isSettingsModalOpen', () => Boolean(_instance));
  document.addEventListener('click', onSettingsTrigger);
  _ownerMounted = true;
  log.info('Ayarlar modal sahibi hazır');
}

export async function unmountSettingsModalBridge(): Promise<void> {
  if (!_ownerMounted && !_instance) return;
  await enqueue(() => destroyModal(false));
  BridgeRegistry.unregister('openSettingsModal');
  BridgeRegistry.unregister('closeSettingsModal');
  BridgeRegistry.unregister('isSettingsModalOpen');
  document.removeEventListener('click', onSettingsTrigger);
  _ownerMounted = false;
}

function initialize(): void { mountSettingsModalBridge(); }

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}
