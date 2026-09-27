import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = new Map<string, Function>();
vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: {
    get: (key: string) => registry.get(key),
  },
}));
vi.mock('svelte', () => ({ mount: vi.fn(() => ({ destroy: vi.fn() })) }));
vi.mock('../js/core/VoicePanel.svelte', () => ({ default: {} }));

import {
  openScreenShareQualityPicker,
  toggleScreenShare,
  toggleVideo,
  BridgePTT,
} from '../js/core/voice-svelte.ts';

describe('voice-svelte compatibility delegation', () => {
  beforeEach(() => registry.clear());
  afterEach(() => registry.clear());

  it('opens the quality picker owner instead of toggling screen share', () => {
    const picker = vi.fn();
    const toggle = vi.fn();
    registry.set('voicePanel:openScreenShareQualityPicker', picker);
    registry.set('voicePanel:toggleScreenShare', toggle);

    openScreenShareQualityPicker();

    expect(picker).toHaveBeenCalledOnce();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('keeps toggleScreenShare mapped to the toggle owner', () => {
    const toggle = vi.fn();
    registry.set('voicePanel:toggleScreenShare', toggle);
    toggleScreenShare();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('returns a resolved promise when the optional video owner is absent', async () => {
    await expect(toggleVideo()).resolves.toBeUndefined();
  });

  it('keeps the legacy PTT fallback fail-safe when the panel is not mounted', () => {
    expect(BridgePTT.getStatus()).toEqual({
      enabled: false, mode: 'hold', key: null, releaseDelay: 200, active: false,
    });
  });
});
