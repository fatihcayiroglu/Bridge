import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { bindShellVoiceControls } from '../js/core/shell-voice-controls.ts';

describe('Phase 9 compact shell voice controls', () => {
  let cleanup = () => undefined;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="btn-mute" type="button"></button>
      <button id="btn-deafen" type="button"></button>
      <div id="ud-voice-status" hidden>
        <span id="ud-vs-channel"></span>
        <button id="ud-vs-leave" type="button"></button>
      </div>
    `;
  });

  afterEach(() => {
    cleanup();
    cleanup = () => undefined;
    BridgeRegistry.unregister('voicePanel:getControlState');
    BridgeRegistry.unregister('voicePanel:toggleMute');
    BridgeRegistry.unregister('voicePanel:toggleDeafen');
    BridgeRegistry.unregister('voicePanel:leaveVoice');
    document.body.innerHTML = '';
  });

  it('keeps unavailable controls honest until voice is joined', () => {
    cleanup = bindShellVoiceControls();

    const mute = document.querySelector<HTMLButtonElement>('#btn-mute')!;
    const deafen = document.querySelector<HTMLButtonElement>('#btn-deafen')!;
    expect(mute.disabled).toBe(true);
    expect(deafen.disabled).toBe(true);
    expect(mute.getAttribute('aria-disabled')).toBe('true');
    expect(mute.dataset.state).toBe('unavailable');
  });

  it('mirrors canonical VoicePanel state without owning a second RTC state', () => {
    BridgeRegistry.register('voicePanel:getControlState', () => ({
      inVoice: true,
      muted: true,
      deafened: false,
    }));
    cleanup = bindShellVoiceControls();

    const mute = document.querySelector<HTMLButtonElement>('#btn-mute')!;
    const deafen = document.querySelector<HTMLButtonElement>('#btn-deafen')!;
    expect(mute.disabled).toBe(false);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(mute.classList.contains('is-active')).toBe(true);
    expect(deafen.getAttribute('aria-pressed')).toBe('false');
  });

  it('delegates clicks to VoicePanel only while joined', () => {
    const toggleMute = vi.fn();
    const toggleDeafen = vi.fn();
    BridgeRegistry.register('voicePanel:getControlState', () => ({
      inVoice: true,
      muted: false,
      deafened: false,
    }));
    BridgeRegistry.register('voicePanel:toggleMute', toggleMute);
    BridgeRegistry.register('voicePanel:toggleDeafen', toggleDeafen);
    cleanup = bindShellVoiceControls();

    document.querySelector<HTMLButtonElement>('#btn-mute')!.click();
    document.querySelector<HTMLButtonElement>('#btn-deafen')!.click();
    expect(toggleMute).toHaveBeenCalledOnce();
    expect(toggleDeafen).toHaveBeenCalledOnce();
  });

  it('tracks events and resets controls after leaving voice', () => {
    cleanup = bindShellVoiceControls();
    document.dispatchEvent(new CustomEvent('bridge:voice-joined'));
    document.dispatchEvent(new CustomEvent('bridge:voice-mute-changed', { detail: { muted: true } }));
    document.dispatchEvent(new CustomEvent('bridge:voice-deafen-changed', { detail: { deafened: true } }));

    const mute = document.querySelector<HTMLButtonElement>('#btn-mute')!;
    const deafen = document.querySelector<HTMLButtonElement>('#btn-deafen')!;
    expect(mute.disabled).toBe(false);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(deafen.getAttribute('aria-pressed')).toBe('true');

    document.dispatchEvent(new CustomEvent('bridge:voice-left'));
    expect(mute.disabled).toBe(true);
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    expect(deafen.getAttribute('aria-pressed')).toBe('false');
  });

  it('treats the completed join event as truth while Svelte state is one tick stale', () => {
    BridgeRegistry.register('voicePanel:getControlState', () => ({
      inVoice: false,
      muted: false,
      deafened: false,
    }));
    cleanup = bindShellVoiceControls();

    document.dispatchEvent(new CustomEvent('bridge:voice-joined'));
    expect(document.querySelector<HTMLButtonElement>('#btn-mute')).toBeEnabled();
    expect(document.querySelector<HTMLButtonElement>('#btn-deafen')).toBeEnabled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kabuktaki SES BAĞLI şeridi', () => {
  // ══════════════════════════════════════════════════════════════════════════
  // KAPATILAN GERÇEK BOŞLUK
  // ══════════════════════════════════════════════════════════════════════════
  // Ses kanalındayken METİN kanalına geçildiğinde `#voice-panel` gizlenir
  // (ChannelStagePanel.syncStage). Ayrılma düğmesi o panelin İÇİNDE olduğu
  // için kullanıcının sesten çıkmasının TEK yolu, ses kanalına geri dönüp
  // tekrar tıklamaktı — ve hâlâ bağlı olduğunu gösteren hiçbir şey yoktu.
  let cleanup = () => undefined;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="btn-mute" type="button"></button>
      <button id="btn-deafen" type="button"></button>
      <div id="ud-voice-status" hidden>
        <span id="ud-vs-channel"></span>
        <button id="ud-vs-leave" type="button"></button>
      </div>
    `;
  });

  afterEach(() => {
    cleanup();
    cleanup = () => undefined;
    BridgeRegistry.unregister('voicePanel:getControlState');
    BridgeRegistry.unregister('voicePanel:leaveVoice');
    document.body.innerHTML = '';
  });

  const strip = () => document.querySelector<HTMLElement>('#ud-voice-status')!;
  const chan  = () => document.querySelector<HTMLElement>('#ud-vs-channel')!;

  it('seste DEĞİLKEN şerit gizlidir', () => {
    cleanup = bindShellVoiceControls();
    expect(strip().hidden).toBe(true);
  });

  it('sese katılınca şerit görünür ve KANAL ADINI gösterir', () => {
    cleanup = bindShellVoiceControls();
    document.dispatchEvent(new CustomEvent('bridge:voice-joined', {
      detail: { channelId: 'c1', channelName: 'genel-sohbet' },
    }));

    expect(strip().hidden).toBe(false);
    expect(chan().textContent).toBe('genel-sohbet');
  });

  it('kanal adı YOKSA uydurulmaz', () => {
    cleanup = bindShellVoiceControls();
    document.dispatchEvent(new CustomEvent('bridge:voice-joined', { detail: { channelId: 'c1' } }));

    expect(strip().hidden).toBe(false);      // bağlıyız
    expect(chan().hidden).toBe(true);        // ama ad iddia edilmez
    expect(chan().textContent).toBe('');
  });

  it('ayrılınca şerit gizlenir ve ad temizlenir', () => {
    cleanup = bindShellVoiceControls();
    document.dispatchEvent(new CustomEvent('bridge:voice-joined', {
      detail: { channelId: 'c1', channelName: 'genel' },
    }));
    document.dispatchEvent(new CustomEvent('bridge:voice-left'));

    expect(strip().hidden).toBe(true);
    expect(chan().textContent).toBe('');
  });

  it('AYRIL düğmesi KANONİK çıkış yolunu çağırır', () => {
    // İkinci bir RTC sahibi kurulmaz; iş VoicePanel'in `leaveVoice`ine gider.
    const leave = vi.fn();
    BridgeRegistry.register('voicePanel:leaveVoice', leave);
    cleanup = bindShellVoiceControls();
    document.dispatchEvent(new CustomEvent('bridge:voice-joined', {
      detail: { channelId: 'c1', channelName: 'genel' },
    }));

    document.querySelector<HTMLButtonElement>('#ud-vs-leave')!.click();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('seste DEĞİLKEN ayrıl düğmesi hiçbir şey yapmaz', () => {
    const leave = vi.fn();
    BridgeRegistry.register('voicePanel:leaveVoice', leave);
    cleanup = bindShellVoiceControls();

    document.querySelector<HTMLButtonElement>('#ud-vs-leave')!.click();
    expect(leave).not.toHaveBeenCalled();
  });

  it('sustur/kulaklık durumu şeride YANSIR', () => {
    cleanup = bindShellVoiceControls();
    document.dispatchEvent(new CustomEvent('bridge:voice-joined', {
      detail: { channelId: 'c1', channelName: 'genel' },
    }));
    expect(strip().dataset.state).toBe('live');

    document.dispatchEvent(new CustomEvent('bridge:voice-mute-changed', { detail: { muted: true } }));
    expect(strip().dataset.state).toBe('muted');

    document.dispatchEvent(new CustomEvent('bridge:voice-deafen-changed', { detail: { deafened: true } }));
    expect(strip().dataset.state).toBe('deafened');
  });

  it('şerit KABUKTA YOKSA diğer kontroller çalışmaya devam eder', () => {
    // Eski kabuk / kısmi test parçası: bağlama çökmemelidir.
    document.body.innerHTML = `
      <button id="btn-mute" type="button"></button>
      <button id="btn-deafen" type="button"></button>
    `;
    cleanup = bindShellVoiceControls();
    document.dispatchEvent(new CustomEvent('bridge:voice-joined', { detail: { channelId: 'c1' } }));

    expect(document.querySelector<HTMLButtonElement>('#btn-mute')!.disabled).toBe(false);
  });
});
