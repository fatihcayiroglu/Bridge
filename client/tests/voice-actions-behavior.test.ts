import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { applySelectedSink, remoteAudio, setSrcObject } from '../js/core/voice-actions.ts';

afterEach(() => { BridgeRegistry.unregister('rtc'); vi.restoreAllMocks(); });

describe('voice media element actions', () => {
  it('sets, updates, and clears srcObject safely while ignoring a null element', () => {
    const media = document.createElement('audio');
    const stream = {} as MediaStream; const replacement = {} as MediaStream;
    const action = setSrcObject(media, stream); expect(media.srcObject).toBe(stream);
    action.update(replacement); expect(media.srcObject).toBe(replacement);
    action.update(null); expect(media.srcObject).toBeNull();
    setSrcObject(media, null); expect(media.srcObject).toBeNull();
    const nullAction = setSrcObject(null, stream);
    expect(() => nullAction.update(replacement)).not.toThrow();
  });

  it('applies the selected sink to newly-created remote audio', async () => {
    const media = document.createElement('audio') as HTMLAudioElement & { setSinkId: ReturnType<typeof vi.fn> };
    media.setSinkId = vi.fn().mockResolvedValue(undefined);
    BridgeRegistry.register('rtc', { selectedSpeakerId: 'speaker-2' } as never);
    applySelectedSink(media);
    expect(media.setSinkId).toHaveBeenCalledWith('speaker-2');
  });

  it('does not touch default/unsupported sinks and swallows disappearing-device rejection', async () => {
    const media = document.createElement('audio') as HTMLAudioElement & { setSinkId?: ReturnType<typeof vi.fn> };
    BridgeRegistry.register('rtc', { selectedSpeakerId: null } as never);
    applySelectedSink(media); expect(media.setSinkId).toBeUndefined();

    media.setSinkId = vi.fn().mockRejectedValue(new Error('device gone'));
    BridgeRegistry.register('rtc', { selectedSpeakerId: 'missing' } as never);
    expect(() => applySelectedSink(media)).not.toThrow();
    await Promise.resolve();
    expect(media.setSinkId).toHaveBeenCalledWith('missing');
  });

  it('remoteAudio binds stream + sink initially and on updates', () => {
    const media = document.createElement('audio') as HTMLAudioElement & { setSinkId: ReturnType<typeof vi.fn> };
    media.setSinkId = vi.fn().mockResolvedValue(undefined);
    BridgeRegistry.register('rtc', { selectedSpeakerId: 'speaker' } as never);
    const first = {} as MediaStream; const second = {} as MediaStream;
    const action = remoteAudio(media, first);
    expect(media.srcObject).toBe(first);
    expect(media.setSinkId).toHaveBeenCalledTimes(1);
    action.update(second);
    expect(media.srcObject).toBe(second);
    expect(media.setSinkId).toHaveBeenCalledTimes(2);
  });
});
