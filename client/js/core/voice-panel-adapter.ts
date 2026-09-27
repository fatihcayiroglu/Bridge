// client/js/core/voice-panel-adapter.ts
//
// The ONE bridge from the RTC engines (P2P `webrtc.ts` and SFU
// `webrtc-sfu.ts`) to the voice UI. `bridgeApp` was a legacy object contract
// that nothing in the production boot path registers; the Svelte VoicePanel
// owns these effects under explicit `voicePanel:*` registry keys.
//
// The P2P engine had already moved to these keys, the SFU engine had not: in
// SFU mode remote audio was decoded but never attached to a playing element
// and no peer tile, state or video tile was ever rendered (measured with real
// browsers in the P2 media lab). Both engines now share this adapter so the
// two cannot drift apart again.

import { BridgeRegistry } from './bridge-registry.ts';
import { toast } from './utils.ts';

export interface VoicePeerInfo {
  socketId: string;
  userId?: string;
  producers?: Array<{ producerId: string; kind: string }>;
}

export interface VoicePeerState {
  muted?: boolean;
  deafened?: boolean;
  screensharing?: boolean;
  video?: boolean;
}

export interface VoicePanelAdapter {
  toast(msg: string, type: string): void;
  showToast?(msg: string, type: string): void;
  renderVoicePeer(peer: VoicePeerInfo, initiator: boolean): void;
  removeVoicePeer(socketId: string): void;
  attachRemoteStream(socketId: string, stream: MediaStream, kind?: string): void;
  updatePeerState(socketId: string, state: VoicePeerState): void;
  /** Faz K2 — uzak katilimcinin GERCEK konusma durumu. */
  updatePeerSpeaking?(socketId: string, speaking: boolean): void;
  /** SFU: a remote camera / screen producer became consumable. */
  sfuHandleNewProducer(socketId: string, userId: string | undefined, stream: MediaStream, kind: string): void;
}

function reg<T>(name: string): T | null {
  return BridgeRegistry.get<(...args: unknown[]) => unknown>(name) as T | null;
}

export const voicePanelAdapter: VoicePanelAdapter = {
  toast,
  showToast: toast,
  renderVoicePeer: (peer, initiator) => reg<VoicePanelAdapter['renderVoicePeer']>('voicePanel:renderVoicePeer')?.(peer, initiator),
  removeVoicePeer: socketId => reg<VoicePanelAdapter['removeVoicePeer']>('voicePanel:removeVoicePeer')?.(socketId),
  attachRemoteStream: (socketId, stream, kind) => reg<VoicePanelAdapter['attachRemoteStream']>('voicePanel:attachRemoteStream')?.(socketId, stream, kind),
  updatePeerState: (socketId, state) => reg<VoicePanelAdapter['updatePeerState']>('voicePanel:updatePeerState')?.(socketId, state),
  updatePeerSpeaking: (socketId, speaking) => reg<NonNullable<VoicePanelAdapter['updatePeerSpeaking']>>('voicePanel:updatePeerSpeaking')?.(socketId, speaking),
  sfuHandleNewProducer: (socketId, userId, stream, kind) => reg<VoicePanelAdapter['sfuHandleNewProducer']>('voicePanel:sfuHandleNewProducer')?.(socketId, userId, stream, kind),
};
