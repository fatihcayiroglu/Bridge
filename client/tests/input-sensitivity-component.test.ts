import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import InputSensitivityControl from '../js/core/voice/InputSensitivityControl.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  BridgeRegistry.unregister('voice:sensitivityChanged');
  BridgeRegistry.unregister('voicePanel:getPttStatus');
});
afterEach(() => {
  cleanup();
  BridgeRegistry.unregister('voice:sensitivityChanged');
  BridgeRegistry.unregister('voicePanel:getPttStatus');
});

describe('InputSensitivityControl behavior', () => {
  it('renders auto mode and updates the live RMS meter without storing audio', async () => {
    render(InputSensitivityControl);
    const radios = [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('input[type="range"]')).toBeNull();

    document.dispatchEvent(new CustomEvent('bridge:voice-input-level', { detail: { rms: 0.05 } }));
    await waitFor(() => expect(Number(document.querySelector('[role="meter"]')?.getAttribute('aria-valuenow'))).toBeGreaterThan(0));
    expect(localStorage.length).toBe(0);
  });

  it('manual mode persists threshold and notifies the running VAD owner', async () => {
    const changed = vi.fn();
    BridgeRegistry.register('voice:sensitivityChanged', changed);
    render(InputSensitivityControl);
    const manual = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')][1]!;
    await fireEvent.click(manual);
    await waitFor(() => expect(document.querySelector('input[type="range"]')).not.toBeNull());
    expect(changed).toHaveBeenCalled();

    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    await fireEvent.input(slider, { target: { value: '0.055' } });
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2);
    const persisted = [...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i)!)).join(' ');
    expect(persisted).toContain('manual');
    expect(persisted).toContain('0.055');
  });

  it('reflects over-threshold speech state and clamps hostile meter input', async () => {
    render(InputSensitivityControl);
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')][1]!);
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    await fireEvent.input(slider, { target: { value: '0.02' } });
    document.dispatchEvent(new CustomEvent('bridge:voice-input-level', { detail: { rms: 0.08 } }));
    await waitFor(() => expect(document.body.textContent).toContain('Şu anda konuşuyor sayılıyorsunuz'));
    document.dispatchEvent(new CustomEvent('bridge:voice-input-level', { detail: { rms: undefined } }));
    await waitFor(() => expect(document.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('0'));
  });

  it('tracks PTT changes and explicitly tells the user threshold is inactive', async () => {
    let enabled = false;
    BridgeRegistry.register('voicePanel:getPttStatus', () => ({ enabled }));
    render(InputSensitivityControl);
    expect(document.body.textContent).not.toContain('Bas-konuş açık');
    enabled = true;
    document.dispatchEvent(new Event('bridge:ptt-changed'));
    await waitFor(() => expect(document.body.textContent).toContain('Bas-konuş açık'));
    enabled = false;
    document.dispatchEvent(new Event('bridge:ptt-changed'));
    await waitFor(() => expect(document.body.textContent).not.toContain('Bas-konuş açık'));
  });
});
