// client/js/core/voice-svelte.ts
// ADR-0008 Faz 2 — VoicePanel.svelte mount + geriye dönük uyumluluk shim
//
// voice.ts'te dışa aktarılan tüm fonksiyonlar BridgeRegistry üzerinden
// erişilebilir olarak tutulur. Mevcut socket/webrtc/app kodu değişmez.
//
// Sprint 113

import { mount }          from 'svelte';
import VoicePanel          from './VoicePanel.svelte';
import { BridgeRegistry }  from './bridge-registry.ts';

let _voicePanelInstance: ReturnType<typeof mount> | null = null;

// ── Mount ─────────────────────────────────────────────────────────────────

/**
 * `#voice-view` elementine VoicePanel'i bağlar.
 * Zaten bağlıysa ikinci kez bağlamaz.
 */
export function mountVoicePanel(targetId = 'voice-view'): void {
  if (_voicePanelInstance) return;

  let target = document.getElementById(targetId);
  if (!target) {
    target = document.createElement('div');
    target.id = targetId;
    document.body.appendChild(target);
  }

  _voicePanelInstance = mount(VoicePanel, {
    target,
    props: {
      onLeave: () => {
        // vanilla tarafın beklediği event
        document.dispatchEvent(new CustomEvent('bridge:voice-left'));
      },
    },
  });
}

// ── Geriye dönük uyumluluk — eski voice.ts fonksiyon imzaları ─────────────

export function toggleMute(): void {
  BridgeRegistry.get('voicePanel:toggleMute')?.();
}

export function toggleDeafen(): void {
  BridgeRegistry.get('voicePanel:toggleDeafen')?.();
}

export function toggleVideo(): Promise<void> {
  return BridgeRegistry.get('voicePanel:toggleVideo')?.() ?? Promise.resolve();
}

export function toggleScreenShare(): void {
  BridgeRegistry.get('voicePanel:toggleScreenShare')?.();
}

export function openScreenShareQualityPicker(): void {
  BridgeRegistry.get('voicePanel:toggleScreenShare')?.();
}

export function leaveVoice(): void {
  BridgeRegistry.get('voicePanel:leaveVoice')?.();
}

export function sfuAddVideoTile(
  tileId: string,
  stream: MediaStream,
  label: string,
  isLocal = false,
  isScreen = false,
): void {
  BridgeRegistry.get('voicePanel:sfuAddVideoTile')?.(tileId, stream, label, isLocal, isScreen);
}

export function sfuRemoveVideoTile(tileId: string): void {
  BridgeRegistry.get('voicePanel:sfuRemoveVideoTile')?.(tileId);
}

export function sfuClearAllVideoTiles(): void {
  BridgeRegistry.get('voicePanel:sfuClearAllVideoTiles')?.();
}

export function sfuHandleNewProducer(
  socketId: string,
  userId: string,
  stream: MediaStream,
  kind: 'video' | 'screen',
): void {
  BridgeRegistry.get('voicePanel:sfuHandleNewProducer')?.(socketId, userId, stream, kind);
}

export function sfuHandlePeerLeft(socketId: string): void {
  BridgeRegistry.get('voicePanel:sfuHandlePeerLeft')?.(socketId);
}

export function renderVoicePeer(
  peer: { id: string; socketId: string; displayName: string; avatarColor: string },
  isLocal = false,
): void {
  BridgeRegistry.get('voicePanel:renderVoicePeer')?.(peer, isLocal);
}

export function removeVoicePeer(socketId: string): void {
  BridgeRegistry.get('voicePanel:removeVoicePeer')?.(socketId);
}

export function updatePeerState(socketId: string, state: Record<string, unknown>): void {
  BridgeRegistry.get('voicePanel:updatePeerState')?.(socketId, state);
}

export function attachRemoteStream(socketId: string, stream: MediaStream): void {
  BridgeRegistry.get('voicePanel:attachRemoteStream')?.(socketId, stream);
}

export function startReply(msgId: string, displayName: string): void {
  BridgeRegistry.get('voicePanel:startReply')?.(msgId, displayName);
}

export function pinMessage(msgId: string, channelId: string): void {
  BridgeRegistry.get('voicePanel:pinMessage')?.(msgId, channelId);
}

// ── PTT shim ─────────────────────────────────────────────────────────────

export const BridgePTT = {
  init(): void { /* mount sırasında otomatik */},
  setEnabled(on: boolean): void {
    BridgeRegistry.get('voicePanel:setPttEnabled')?.(on);
  },
  setMode(m: 'hold' | 'toggle'): void {
    BridgeRegistry.get('voicePanel:setPttMode')?.(m);
  },
  setReleaseDelay(ms: number): void {
    BridgeRegistry.get('voicePanel:setPttReleaseDelay')?.(ms);
  },
  startKeyCapture(): void {
    BridgeRegistry.get('voicePanel:startPttKeyCapture')?.();
  },
  clearKey(): void {
    BridgeRegistry.get('voicePanel:clearPttKey')?.();
  },
  getStatus(): unknown {
    return BridgeRegistry.get('voicePanel:getPttStatus')?.() ?? {
      enabled: false, mode: 'hold', key: null, releaseDelay: 200, active: false,
    };
  },
};

// ── Bootstrap — mount timing ─────────────────────────────────────────────
//
// İki event dinleyicisi kasıtlıdır:
//
//   DOMContentLoaded — Sayfa yüklendiğinde paneli DOM'a bağlar.
//     VoicePanel, getRtc() / getCurrentChannel() gibi bağımlılıklarını
//     onMount'ta DEĞİL, her render'da lazy getter ile çözümlediğinden
//     socket henüz hazır olmasa bile güvenli biçimde mount edilebilir.
//
//   bridge:socket-ready — Socket bağlandıktan sonra ek güvenlik ağı.
//     Eğer bu modül socket hazır olduktan sonra yüklendiyse
//     DOMContentLoaded zaten tetiklenmiş olur ve bu listener mount'u başlatır.
//     mountVoicePanel() guard (_voicePanelInstance) sayesinde ikinci
//     çağrı no-op'tur; çifte mount riski yoktur.
//
// Tasarım kararı (ADR-0008): VoicePanel, vanilla socket/WebRTC kodunu
// doğrudan import etmez; BridgeRegistry üzerinden erişir. Bu sayede
// mount sırası socket yaşam döngüsünden bağımsızdır.

document.addEventListener('DOMContentLoaded',   () => mountVoicePanel());
document.addEventListener('bridge:socket-ready', () => mountVoicePanel());
