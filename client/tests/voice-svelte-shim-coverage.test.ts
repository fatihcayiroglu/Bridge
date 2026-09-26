import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mountMock } = vi.hoisted(() => ({ mountMock: vi.fn((..._args: unknown[]) => ({ instance: true })) }));
vi.mock('svelte', () => ({ mount: mountMock }));
vi.mock('../js/core/VoicePanel.svelte', () => ({ default: {} }));

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  BridgePTT,
  attachRemoteStream,
  leaveVoice,
  mountVoicePanel,
  openScreenShareQualityPicker,
  pinMessage,
  removeVoicePeer,
  renderVoicePeer,
  sfuAddVideoTile,
  sfuClearAllVideoTiles,
  sfuHandleNewProducer,
  sfuHandlePeerLeft,
  sfuRemoveVideoTile,
  startReply,
  toggleDeafen,
  toggleMute,
  toggleScreenShare,
  toggleVideo,
  updatePeerState,
} from '../js/core/voice-svelte.ts';

const registryNames = [
  'voicePanel:toggleMute', 'voicePanel:toggleDeafen', 'voicePanel:toggleVideo',
  'voicePanel:toggleScreenShare', 'voicePanel:openScreenShareQualityPicker', 'voicePanel:leaveVoice',
  'voicePanel:sfuAddVideoTile', 'voicePanel:sfuRemoveVideoTile', 'voicePanel:sfuClearAllVideoTiles',
  'voicePanel:sfuHandleNewProducer', 'voicePanel:sfuHandlePeerLeft', 'voicePanel:renderVoicePeer',
  'voicePanel:removeVoicePeer', 'voicePanel:updatePeerState', 'voicePanel:attachRemoteStream',
  'voicePanel:startReply', 'voicePanel:pinMessage', 'voicePanel:setPttEnabled', 'voicePanel:setPttMode',
  'voicePanel:setPttReleaseDelay', 'voicePanel:startPttKeyCapture', 'voicePanel:clearPttKey',
  'voicePanel:getPttStatus',
] as const;

beforeEach(() => {
  for (const name of registryNames) BridgeRegistry.unregister(name);
  document.body.innerHTML = '';
  mountMock.mockClear();
});

describe('voice-svelte compatibility owner', () => {
  it('creates the requested host once and preserves the real leave event contract', () => {
    const left = vi.fn();
    document.addEventListener('bridge:voice-left', left, { once: true });

    mountVoicePanel('voice-test-host');
    const host = document.getElementById('voice-test-host');
    expect(host).not.toBeNull();
    expect(mountMock).toHaveBeenCalledTimes(1);
    expect(mountMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ target: host }));

    const props = (mountMock.mock.calls[0]?.[1] as { props?: { onLeave?: () => void } } | undefined)?.props;
    props?.onLeave?.();
    expect(left).toHaveBeenCalledOnce();

    // Repeated bootstrap/socket-ready paths must converge on the same owner.
    mountVoicePanel('voice-test-host');
    document.dispatchEvent(new Event('bridge:socket-ready'));
    expect(mountMock).toHaveBeenCalledTimes(1);
  });

  it('delegates every legacy voice/SFU/message action through BridgeRegistry and remains safe when absent', async () => {
    // Missing owners are intentionally no-ops; async video must still resolve.
    expect(() => toggleMute()).not.toThrow();
    await expect(toggleVideo()).resolves.toBeUndefined();
    expect(BridgePTT.getStatus()).toEqual({ enabled: false, mode: 'hold', key: null, releaseDelay: 200, active: false });

    const fns = Object.fromEntries(registryNames.map(name => [name, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
    fns['voicePanel:toggleVideo']!.mockResolvedValue('video-ok');
    fns['voicePanel:getPttStatus']!.mockReturnValue({ enabled: true, mode: 'toggle' });
    for (const [name, fn] of Object.entries(fns)) BridgeRegistry.register(name, fn as never);

    const stream = {} as MediaStream;
    const peer = { id: 'u1', socketId: 's1', displayName: 'User', avatarColor: '#000000' };
    const state = { muted: true };

    toggleMute(); toggleDeafen(); toggleScreenShare(); openScreenShareQualityPicker(); leaveVoice();
    await expect(toggleVideo()).resolves.toBe('video-ok');
    sfuAddVideoTile('tile', stream, 'Camera', true, false);
    sfuRemoveVideoTile('tile'); sfuClearAllVideoTiles();
    sfuHandleNewProducer('s1', 'u1', stream, 'screen'); sfuHandlePeerLeft('s1');
    renderVoicePeer(peer, true); removeVoicePeer('s1'); updatePeerState('s1', state);
    attachRemoteStream('s1', stream); startReply('m1', 'User'); pinMessage('m1', 'c1');
    BridgePTT.init(); BridgePTT.setEnabled(true); BridgePTT.setMode('toggle');
    BridgePTT.setReleaseDelay(350); BridgePTT.startKeyCapture(); BridgePTT.clearKey();

    expect(fns['voicePanel:toggleMute']).toHaveBeenCalledOnce();
    expect(fns['voicePanel:toggleDeafen']).toHaveBeenCalledOnce();
    expect(fns['voicePanel:toggleVideo']).toHaveBeenCalledOnce();
    expect(fns['voicePanel:toggleScreenShare']).toHaveBeenCalledOnce();
    expect(fns['voicePanel:openScreenShareQualityPicker']).toHaveBeenCalledOnce();
    expect(fns['voicePanel:leaveVoice']).toHaveBeenCalledOnce();
    expect(fns['voicePanel:sfuAddVideoTile']).toHaveBeenCalledWith('tile', stream, 'Camera', true, false);
    expect(fns['voicePanel:sfuRemoveVideoTile']).toHaveBeenCalledWith('tile');
    expect(fns['voicePanel:sfuClearAllVideoTiles']).toHaveBeenCalledOnce();
    expect(fns['voicePanel:sfuHandleNewProducer']).toHaveBeenCalledWith('s1', 'u1', stream, 'screen');
    expect(fns['voicePanel:sfuHandlePeerLeft']).toHaveBeenCalledWith('s1');
    expect(fns['voicePanel:renderVoicePeer']).toHaveBeenCalledWith(peer, true);
    expect(fns['voicePanel:removeVoicePeer']).toHaveBeenCalledWith('s1');
    expect(fns['voicePanel:updatePeerState']).toHaveBeenCalledWith('s1', state);
    expect(fns['voicePanel:attachRemoteStream']).toHaveBeenCalledWith('s1', stream);
    expect(fns['voicePanel:startReply']).toHaveBeenCalledWith('m1', 'User');
    expect(fns['voicePanel:pinMessage']).toHaveBeenCalledWith('m1', 'c1');
    expect(fns['voicePanel:setPttEnabled']).toHaveBeenCalledWith(true);
    expect(fns['voicePanel:setPttMode']).toHaveBeenCalledWith('toggle');
    expect(fns['voicePanel:setPttReleaseDelay']).toHaveBeenCalledWith(350);
    expect(fns['voicePanel:startPttKeyCapture']).toHaveBeenCalledOnce();
    expect(fns['voicePanel:clearPttKey']).toHaveBeenCalledOnce();
    expect(BridgePTT.getStatus()).toEqual({ enabled: true, mode: 'toggle' });
  });
});
