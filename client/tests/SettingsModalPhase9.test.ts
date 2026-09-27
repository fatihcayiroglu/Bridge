// Phase 9 — canonical reachable SettingsModal owner and accessibility contracts.
import { t } from '../js/core/i18n/index.ts';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import { flushSync, mount, unmount } from 'svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.js';
import SettingsModal from '../js/core/settings/SettingsModal.svelte';
import {
  closeSettingsModal,
  mountSettingsModalBridge,
  openSettingsModal,
  unmountSettingsModalBridge,
} from '../js/core/settings-modal-svelte.js';

let container: HTMLDivElement;

beforeEach(async () => {
  await unmountSettingsModalBridge();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  container = document.createElement('div');
  container.id = 'settings-modal-container';
  document.body.appendChild(container);
  mountSettingsModalBridge(container);
});

afterEach(async () => {
  await unmountSettingsModalBridge();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('settings modal owner', () => {
  it('registers one reachable open/close contract and mounts the real modal on demand', async () => {
    expect(BridgeRegistry.has('openSettingsModal')).toBe(true);
    expect(BridgeRegistry.has('closeSettingsModal')).toBe(true);
    expect(BridgeRegistry.call('isSettingsModalOpen')).toBe(false);

    await BridgeRegistry.call<Promise<void>>('openSettingsModal');
    expect(container.querySelector('[role="dialog"]')).toBeInTheDocument();
    expect(container.querySelector('.settings-modal-bridge')).not.toBeInTheDocument();
    expect(container).toHaveTextContent(t('profile'));
    expect(BridgeRegistry.call('isSettingsModalOpen')).toBe(true);
  });

  it('supports direct and dispatcher-style initial tabs with safe fallback', async () => {
    await openSettingsModal('appearance');
    expect(container.querySelector('#tab-appearance')).toHaveAttribute('aria-selected', 'true');
    expect(container).toHaveTextContent('Görünüm');

    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    await openSettingsModal(trigger, 'privacy');
    expect(container.querySelector('#tab-privacy')).toHaveAttribute('aria-selected', 'true');
    expect(container).toHaveTextContent('Kimden DM alabilirim');

    await openSettingsModal('not-a-tab');
    expect(container.querySelector('#tab-profile')).toHaveAttribute('aria-selected', 'true');
  });

  it('restores trigger focus after the canonical close contract', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Ayarları aç';
    document.body.prepend(trigger);
    trigger.focus();

    await openSettingsModal(trigger, 'profile');
    expect(document.activeElement).toBe(container.querySelector('#tab-profile'));
    await closeSettingsModal();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
  });

  it('makes production data-action settings triggers reachable without globals', async () => {
    const trigger = document.createElement('button');
    trigger.dataset.bridgeAction = 'openSettingsModal';
    trigger.dataset.bridgeArg = 'appearance';
    document.body.prepend(trigger);

    await fireEvent.click(trigger);
    await waitFor(() => expect(container.querySelector('#tab-appearance')).toHaveAttribute('aria-selected', 'true'));
  });

  it('closes on Escape and restores the external trigger', async () => {
    const trigger = document.createElement('button');
    document.body.prepend(trigger);
    trigger.focus();
    await openSettingsModal(trigger, 'notifications');

    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('closes only when the backdrop itself is clicked', async () => {
    await openSettingsModal('profile');
    const overlay = container.querySelector<HTMLElement>('.settings-overlay')!;
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await fireEvent.click(dialog);
    expect(container.querySelector('[role="dialog"]')).toBeInTheDocument();
    await fireEvent.click(overlay);
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument());
  });
});

describe('SettingsModal keyboard and visual semantics', () => {
  it('contains forward and reverse Tab focus inside the dialog', async () => {
    await openSettingsModal('profile');
    const first = container.querySelector<HTMLElement>('#tab-profile')!;
    const last = container.querySelector<HTMLButtonElement>('.settings-close')!;

    // FAZ E — OLAY KAYNAĞI GERÇEKÇİ HÂLE GETİRİLDİ (iddialar AYNEN korundu).
    //
    // Eskiden keydown doğrudan `window`a gönderiliyordu; bu, tuzağın `window`
    // dinleyicisiyle yazıldığı döneme ait bir alışkanlıktı. Gerçek tarayıcıda
    // Tab olayı ODAKLI ÖĞEDE doğar ve yukarı kabarcıklanır (öğe → dialog →
    // body → document → window). `window`a doğrudan gönderilen sentetik olay
    // ise dialog düğümünden HİÇ geçmez.
    //
    // Kanonik tuzak dinleyicisi düğüm seviyesindedir (Tab'ı genel olarak ele
    // geçirmemek için). Bu yüzden olay artık odaklı öğeden gönderilir —
    // aşağıdaki komşu test (`ArrowRight`) zaten bu gerçekçi biçimi kullanıyor.
    // İki `expect` satırı değiştirilmedi: ölçülen davranış aynı.
    last.focus();
    await fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    await fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('supports arrow-key tab navigation with roving tabindex', async () => {
    await openSettingsModal('profile');
    const profile = container.querySelector<HTMLElement>('#tab-profile')!;
    profile.focus();
    await fireEvent.keyDown(profile, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('#tab-appearance')));
    expect(container.querySelector('#tab-appearance')).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('#tab-profile')).toHaveAttribute('tabindex', '-1');
  });

  it('supports ArrowDown/ArrowLeft/Home/End and ignores unrelated tab keys', async () => {
    await openSettingsModal('profile');
    const profile = container.querySelector<HTMLElement>('#tab-profile')!;

    await fireEvent.keyDown(profile, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('#tab-appearance')));
    const appearance = container.querySelector<HTMLElement>('#tab-appearance')!;
    await fireEvent.keyDown(appearance, { key: 'ArrowLeft' });
    await waitFor(() => expect(document.activeElement).toBe(profile));

    await fireEvent.keyDown(profile, { key: 'End' });
    const security = container.querySelector<HTMLElement>('#tab-security')!;
    await waitFor(() => expect(document.activeElement).toBe(security));
    await fireEvent.keyDown(security, { key: 'Home' });
    await waitFor(() => expect(document.activeElement).toBe(profile));

    await fireEvent.keyDown(profile, { key: 'PageDown' });
    expect(document.activeElement).toBe(profile);
    expect(profile).toHaveAttribute('aria-selected', 'true');
  });

  it('wraps reverse arrow navigation from the first tab to the last tab', async () => {
    await openSettingsModal('profile');
    const profile = container.querySelector<HTMLElement>('#tab-profile')!;
    await fireEvent.keyDown(profile, { key: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('#tab-security')));
    expect(container.querySelector('#tab-security')).toHaveAttribute('aria-selected', 'true');
  });

  it('direct owner defaults invalid tabs, tolerates no close callback, and suppresses duplicate closes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const close = vi.fn();
    const instance = mount(SettingsModal, { target: host, props: { initialTab: 'invalid', onClose: close } });
    flushSync();
    expect(host.querySelector('#tab-profile')).toHaveAttribute('aria-selected', 'true');

    const closeButton = host.querySelector<HTMLButtonElement>('.settings-close')!;
    closeButton.click();
    closeButton.click();
    flushSync();
    expect(close).toHaveBeenCalledOnce();
    unmount(instance);
    host.remove();

    const noCallbackHost = document.createElement('div');
    document.body.appendChild(noCallbackHost);
    const noCallback = mount(SettingsModal, { target: noCallbackHost });
    flushSync();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    unmount(noCallback);
    noCallbackHost.remove();
  });

  it('uses inline SVG navigation/close icons without emoji product icons', async () => {
    await openSettingsModal('profile');
    // Guvenlik (2FA) tabi eklendiginde 5 -> 6. Sayi tek basina zayif bir
    // iddiadir: her tab ayni ikonu gosterse de gecerdi. Bu yuzden ikonlarin
    // BIRBIRINDEN FARKLI oldugu da dogrulanir — `security` kendi ikonu
    // olmadan eklendiginde `{:else}` dali yuzunden CIHAZLAR ikonunu
    // gosteriyordu ve iki tab ayirt edilemiyordu.
    const ikonlar = [...container.querySelectorAll('.settings-tab-btn .tab-icon svg')];
    expect(ikonlar).toHaveLength(6);
    const imzalar = new Set(ikonlar.map((i) => i.innerHTML.trim()));
    expect(imzalar.size).toBe(6);
    expect(container.querySelector('.settings-close svg')).toBeInTheDocument();
    expect(container.querySelector('nav')?.textContent).not.toMatch(/[👤🎨🔔🔒🎙️]/u);
  });

  it('locks background scrolling only while the modal is mounted', async () => {
    document.body.style.overflow = 'clip';
    await openSettingsModal('profile');
    expect(document.body.style.overflow).toBe('hidden');
    await closeSettingsModal();
    expect(document.body.style.overflow).toBe('clip');
  });
});
