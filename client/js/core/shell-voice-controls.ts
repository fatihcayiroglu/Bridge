// Compact current-user voice controls.
//
// VoicePanel remains the only behavior/state owner. This module only mirrors
// its canonical state into the persistent shell buttons and forwards clicks
// through BridgeRegistry, so the two surfaces cannot drift into separate RTC
// implementations.

import { BridgeRegistry } from './bridge-registry.ts';
import { locale, t } from './i18n/index.ts';

interface VoiceControlState {
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
}

const INITIAL_STATE: VoiceControlState = {
  inVoice: false,
  muted: false,
  deafened: false,
};

function canonicalState(): VoiceControlState | null {
  const read = BridgeRegistry.get<() => VoiceControlState>('voicePanel:getControlState');
  if (!read) return null;
  const state = read();
  return {
    inVoice: Boolean(state?.inVoice),
    muted: Boolean(state?.muted),
    deafened: Boolean(state?.deafened),
  };
}

export function bindShellVoiceControls(root: Document = document): () => void {
  const muteButton = root.getElementById('btn-mute') as HTMLButtonElement | null;
  const deafenButton = root.getElementById('btn-deafen') as HTMLButtonElement | null;
  if (!muteButton || !deafenButton) return () => undefined;

  // ── SES BAGLI SERIDI ─────────────────────────────────────────────────────
  // KAPATILAN GERCEK BOSLUK: metin kanalina gecildiginde `#voice-panel`
  // gizlenir; ayrilma dugmesi onun ICINDE oldugu icin kullanicinin sesten
  // cikmasinin TEK yolu ses kanalina geri gidip tekrar tiklamakti. Ayrica
  // hala bagli oldugunu gosteren hicbir sey yoktu.
  //
  // Serit ISTEGE BAGLIDIR: kabukta yoksa (eski surum, test parcasi) diger
  // kontroller aynen calisir.
  const voiceStatus  = root.getElementById('ud-voice-status');
  const voiceChannel = root.getElementById('ud-vs-channel');
  const leaveButton  = root.getElementById('ud-vs-leave') as HTMLButtonElement | null;
  if (muteButton.dataset.bridgeBound === 'voice') return () => undefined;

  muteButton.dataset.bridgeBound = 'voice';
  deafenButton.dataset.bridgeBound = 'voice';

  let state = canonicalState() ?? { ...INITIAL_STATE };
  let channelName = '';

  const sync = (): void => {
    const controls: Array<{
      button: HTMLButtonElement;
      active: boolean;
      activeLabel: string;
      idleLabel: string;
    }> = [
      // Final21 Faz 19: etiketler her dilde Türkçe kalıyordu (ekran okuyucu ve ipucu).
      { button: muteButton, active: state.muted, activeLabel: t('surface_mikrofonu_ac_b26660', 'Mikrofonu aç'), idleLabel: t('surface_mikrofonu_kapat_6f80da', 'Mikrofonu kapat') },
      { button: deafenButton, active: state.deafened, activeLabel: t('surface_sesi_ac_3bbb7e', 'Sesi aç'), idleLabel: t('surface_sesi_kapat_559649', 'Sesi kapat') },
    ];

    for (const { button, active, activeLabel, idleLabel } of controls) {
      button.disabled = !state.inVoice;
      button.setAttribute('aria-disabled', String(!state.inVoice));
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
      button.dataset.state = !state.inVoice ? 'unavailable' : active ? 'active' : 'idle';
      const label = state.inVoice ? (active ? activeLabel : idleLabel) : t('shell_voice_join_first', 'Ses kanalına katıldığınızda kullanılabilir');
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.dataset.tip = label;
    }

    // Serit yalnizca GERCEKTEN sesteyken gorunur.
    if (voiceStatus) {
      voiceStatus.hidden = !state.inVoice;
      voiceStatus.dataset.state = state.deafened ? 'deafened' : state.muted ? 'muted' : 'live';
    }
    if (voiceChannel) {
      // Ad yoksa alan BOS kalir; uydurma bir yer tutucu yazilmaz.
      voiceChannel.textContent = channelName;
      voiceChannel.hidden = !channelName;
    }
  };

  const onMuteClick = (event: Event): void => {
    event.preventDefault();
    if (!state.inVoice) return;
    BridgeRegistry.call('voicePanel:toggleMute');
  };
  const onDeafenClick = (event: Event): void => {
    event.preventDefault();
    if (!state.inVoice) return;
    BridgeRegistry.call('voicePanel:toggleDeafen');
  };
  const onJoined = (event: Event): void => {
    const detail = (event as CustomEvent<{ channelName?: unknown }>).detail;
    channelName = typeof detail?.channelName === 'string' ? detail.channelName : '';
    // The VoicePanel Svelte state flush may trail the document event by one
    // microtask. The event itself is the authoritative completed-join signal,
    // so never let a just-stale `getControlState()` keep shell controls locked.
    const current = canonicalState();
    state = {
      inVoice: true,
      muted: current?.muted ?? state.muted,
      deafened: current?.deafened ?? state.deafened,
    };
    sync();
  };
  const onLeft = (): void => {
    state = { ...INITIAL_STATE };
    channelName = '';
    sync();
  };
  const onMuted = (event: Event): void => {
    const muted = Boolean((event as CustomEvent<{ muted?: boolean }>).detail?.muted);
    state = { ...state, muted };
    sync();
  };
  const onDeafened = (event: Event): void => {
    const deafened = Boolean((event as CustomEvent<{ deafened?: boolean }>).detail?.deafened);
    state = { ...state, deafened };
    sync();
  };

  const onLeaveClick = (event: Event): void => {
    event.preventDefault();
    if (!state.inVoice) return;
    // Kanonik cikis yolu: VoicePanel'in sahibi oldugu `leaveVoice`.
    // Burada ikinci bir RTC cagrisi YAPILMAZ.
    BridgeRegistry.call('voicePanel:leaveVoice');
  };

  leaveButton?.addEventListener('click', onLeaveClick);
  muteButton.addEventListener('click', onMuteClick);
  deafenButton.addEventListener('click', onDeafenClick);
  root.addEventListener('bridge:voice-joined', onJoined);
  root.addEventListener('bridge:voice-left', onLeft);
  root.addEventListener('bridge:voice-mute-changed', onMuted);
  root.addEventListener('bridge:voice-deafen-changed', onDeafened);
  // Dil tablosu açılışta ASENKRON gelir ve kullanıcı dili değiştirebilir: etiketler yeniden yazılır.
  const unsubscribeLocale = locale.subscribe(() => sync());

  return () => {
    leaveButton?.removeEventListener('click', onLeaveClick);
    muteButton.removeEventListener('click', onMuteClick);
    deafenButton.removeEventListener('click', onDeafenClick);
    root.removeEventListener('bridge:voice-joined', onJoined);
    root.removeEventListener('bridge:voice-left', onLeft);
    root.removeEventListener('bridge:voice-mute-changed', onMuted);
    root.removeEventListener('bridge:voice-deafen-changed', onDeafened);
    unsubscribeLocale();
    delete muteButton.dataset.bridgeBound;
    delete deafenButton.dataset.bridgeBound;
  };
}

function bootstrap(): void {
  bindShellVoiceControls();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
