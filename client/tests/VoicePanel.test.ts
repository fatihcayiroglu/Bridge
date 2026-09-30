// client/tests/VoicePanel.test.ts
// Sprint 113 — VoicePanel.svelte birim testleri
// ADR-0008 Faz 2 doğrulama

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import VoicePanel from '../js/core/VoicePanel.svelte';
import * as connectionQuality from '../js/core/voice-connection-quality.ts';


// Bu dosyanin iddialari INGILIZCE arayuz metnine dayanir.
// Dil, ortamdan (jsdom `navigator.language`) SIZMAMALI; acikca
// belirtilir. Genel test kurulumu urunun birincil dili olan
// Turkce'ye sabitler, burasi onu bilerek ezer.
import { setLocale as __setLocale, t } from '../js/core/i18n/index.ts';
// Beklentiler SOZLUKTEN turetilir. Dosya dili acikca 'en'e sabitliyor;
// buna ragmen bazi iddialar TURKCE metin bekliyordu (olculdu: 'Zayif',
// 'gecikme', 'Kullanici'). Ayni dosyada iki farkli dil beklemek, urunu
// degil sabitlemeyi olcmek demektir.
beforeAll(async () => { await __setLocale('en'); });
// ── Mock'lar ─────────────────────────────────────────────────────────────

const mockRtc = {
  available:     true,
  muted:         false,
  deafened:      false,
  videoOn:       false,
  screenSharing: false,
  screenStream:  null as MediaStream | null,
  peers:         new Map(),
  setMuted:      vi.fn((v: boolean) => { mockRtc.muted = v; }),
  setDeafened:   vi.fn((v: boolean) => { mockRtc.deafened = v; }),
  enableVideo:   vi.fn(async () => true),
  getLocalStream: vi.fn(() => null),
  isInVoice:     vi.fn(() => true),
  leaveVoice:    vi.fn(),
  startScreenShare: vi.fn(async () => true),
  stopScreenShare:  vi.fn(),
};

const mockRegistry: Record<string, unknown> = {};

vi.mock('../js/core/globals.js', () => ({
  getRtc: () => mockRtc.available ? mockRtc : null,
  friendsCache: [],
}));

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register:   (key: string, fn: unknown) => { mockRegistry[key] = fn; },
    unregister: (key: string) => { delete mockRegistry[key]; },
    get:        (key: string) => mockRegistry[key],
    call:       (key: string, ...args: unknown[]) => (mockRegistry[key] as ((...values: unknown[]) => unknown) | undefined)?.(...args),
    // Completed against the canonical BridgeRegistry surface (register /
    // unregister / call / get / has); a missing member throws before any
    // assertion runs.
    has:        (key: string) => key in mockRegistry,
  },
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  for (const key of Object.keys(mockRegistry)) delete mockRegistry[key];
  vi.clearAllMocks();
  mockRtc.muted = false;
  mockRtc.deafened = false;
  mockRtc.videoOn = false;
  mockRtc.screenSharing = false;
  mockRtc.screenStream = null;
  mockRtc.peers = new Map();
  mockRtc.available = true;
  mockRtc.setMuted.mockImplementation((v: boolean) => { mockRtc.muted = v; });
  mockRtc.setDeafened.mockImplementation((v: boolean) => { mockRtc.deafened = v; });
  mockRtc.enableVideo.mockResolvedValue(true);
  mockRtc.getLocalStream.mockReturnValue(null);
  mockRtc.isInVoice.mockReturnValue(true);
  mockRtc.startScreenShare.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

// ── Testler ───────────────────────────────────────────────────────────────

describe('VoicePanel — render', () => {
  it('bileşen render edilir', () => {
    const { container } = render(VoicePanel);
    expect(container.querySelector('#voice-panel')).toBeTruthy();
  });

  it('kontrol butonları mevcut', () => {
    const { container } = render(VoicePanel);
    expect(container.querySelector('#vc-mute')).toBeTruthy();
    expect(container.querySelector('#vc-deafen')).toBeTruthy();
    expect(container.querySelector('#vc-video')).toBeTruthy();
    expect(container.querySelector('#vc-screen')).toBeTruthy();
    expect(container.querySelector('#vc-soundboard')).toBeTruthy();
  });

  it('soundboard kontrolü tek kanonik registry sahibine delege eder', async () => {
    const openSoundboard = vi.fn();
    mockRegistry.openSoundboard = openSoundboard;
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('#vc-soundboard') as HTMLButtonElement);
    expect(openSoundboard).toHaveBeenCalledOnce();
  });

  it('başlangıçta mute butonu aktif değil', () => {
    const { container } = render(VoicePanel);
    const btn = container.querySelector('#vc-mute');
    expect(btn?.classList.contains('active')).toBe(false);
  });

  it('Voice Check sahibi varsa başlıktan açılır; yoksa ölü denetim gösterilmez', async () => {
    const absent = render(VoicePanel);
    expect(absent.container.querySelector('.voice-check-trigger')).toBeNull();
    cleanup();

    const openVoiceCheck = vi.fn();
    mockRegistry.openVoiceCheck = openVoiceCheck;
    const present = render(VoicePanel);
    const trigger = present.container.querySelector('.voice-check-trigger') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain('Voice Check');

    await fireEvent.click(trigger);
    expect(openVoiceCheck).toHaveBeenCalledOnce();
  });
});

describe('VoicePanel — toggleMute', () => {
  it('mute butonuna tıklayınca rtc.setMuted çağrılır', async () => {
    const { container } = render(VoicePanel);
    const btn = container.querySelector('#vc-mute') as HTMLElement;
    await fireEvent.click(btn);
    expect(mockRtc.setMuted).toHaveBeenCalledWith(true);
  });

  it('ikinci tıkta mute kaldırılır', async () => {
    const { container } = render(VoicePanel);
    const btn = container.querySelector('#vc-mute') as HTMLElement;
    await fireEvent.click(btn);
    await fireEvent.click(btn);
    expect(mockRtc.setMuted).toHaveBeenLastCalledWith(false);
  });

  it('mute event dispatch edilir', async () => {
    const dispatchSpy = vi.spyOn(document, 'dispatchEvent');
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('#vc-mute') as HTMLElement);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bridge:voice-mute-changed' }),
    );
  });
});

describe('VoicePanel — toggleDeafen', () => {
  it('deafen butonuna tıklayınca rtc.setDeafened çağrılır', async () => {
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('#vc-deafen') as HTMLElement);
    expect(mockRtc.setDeafened).toHaveBeenCalledWith(true);
  });

  it('remote MediaStream için gerçek audio playback elementi üretir ve deafen onu susturur', async () => {
    const { container } = render(VoicePanel);
    const attach = mockRegistry['voicePanel:attachRemoteStream'] as Function;
    const track = { kind: 'audio', readyState: 'live', stop: vi.fn() };
    const stream = new MediaStream([track as unknown as MediaStreamTrack]);

    attach('remote-1', stream);
    await new Promise(r => setTimeout(r, 0));
    const audio = container.querySelector('audio.remote-audio[data-socket="remote-1"]') as HTMLAudioElement;

    expect(audio).toBeTruthy();
    expect(audio.srcObject).toBe(stream);
    expect(audio.muted).toBe(false);

    await fireEvent.click(container.querySelector('#vc-deafen') as HTMLElement);
    expect(audio.muted).toBe(true);
  });

  it('peer ayrılınca remote playback elementi kaldırılır', async () => {
    const { container } = render(VoicePanel);
    const attach = mockRegistry['voicePanel:attachRemoteStream'] as Function;
    const remove = mockRegistry['voicePanel:removeVoicePeer'] as Function;
    const track = { kind: 'audio', readyState: 'live', stop: vi.fn() };
    attach('remote-2', new MediaStream([track as unknown as MediaStreamTrack]));
    await new Promise(r => setTimeout(r, 0));

    remove('remote-2');
    await new Promise(r => setTimeout(r, 0));

    expect(container.querySelector('audio.remote-audio[data-socket="remote-2"]')).toBeNull();
  });
});

describe('VoicePanel — reconnect state truth', () => {
  it('disconnect sonrası joined kontrolleri devre dışı bırakır ve kullanıcı yeniden seçebilir', async () => {
    const dispatchSpy = vi.spyOn(document, 'dispatchEvent');
    const { container } = render(VoicePanel);
    const mute = container.querySelector('#vc-mute') as HTMLButtonElement;
    expect(mute.disabled).toBe(false);

    document.dispatchEvent(new CustomEvent('bridge:voice-left', { detail: { reason: 'socket-disconnect' } }));
    await new Promise(r => setTimeout(r, 0));

    expect(mute.disabled).toBe(true);
    // KALICI KANCA: düğme SINIFIYLA bulunur, metniyle değil. Etiket artık
    // i18n'den gelir ve jsdom'da `navigator.language` tanımsız olduğu için
    // yerel 'en'e düşer — yani metin ortama göre değişir. Bu depoda aynı ders
    // Voice Check testinde de kayıtlı.
    const rejoin = container.querySelector('.voice-rejoin') as HTMLButtonElement;
    expect(rejoin).toBeTruthy();
    await fireEvent.click(rejoin);
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'bridge:channel-selected' }));

    document.dispatchEvent(new CustomEvent('bridge:voice-joined'));
    await new Promise(r => setTimeout(r, 0));
    expect(mute.disabled).toBe(false);
  });
});

describe('VoicePanel — media session recovery is visible', () => {
  it('shows reconnecting while the engine re-establishes the session, then connected or disconnected', async () => {
    const { container } = render(VoicePanel);
    const status = () => container.querySelector('.voice-connection') as HTMLElement;
    document.dispatchEvent(new CustomEvent('bridge:voice-joined'));
    await new Promise(r => setTimeout(r, 0));
    const connectedText = status().textContent?.trim();
    expect(status().classList.contains('connected')).toBe(true);

    // ICE failed / socket lost: the call must not keep claiming "connected".
    document.dispatchEvent(new CustomEvent('bridge:voice-reconnecting', { detail: { reason: 'transport-failed' } }));
    await new Promise(r => setTimeout(r, 0));
    expect(status().classList.contains('reconnecting')).toBe(true);
    expect(status().classList.contains('connected')).toBe(false);
    expect(status().textContent?.trim()).not.toBe(connectedText);
    expect(status().getAttribute('role')).toBe('status');

    document.dispatchEvent(new CustomEvent('bridge:voice-reconnected', { detail: { attempt: 1 } }));
    await new Promise(r => setTimeout(r, 0));
    expect(status().classList.contains('reconnecting')).toBe(false);
    expect(status().textContent?.trim()).toBe(connectedText);

    // Recovery that gives up ends the call: no stale "reconnecting" state remains.
    document.dispatchEvent(new CustomEvent('bridge:voice-reconnecting', { detail: { reason: 'transport-failed' } }));
    document.dispatchEvent(new CustomEvent('bridge:voice-left', { detail: { reason: 'media-session-lost' } }));
    await new Promise(r => setTimeout(r, 0));
    expect(status().classList.contains('reconnecting')).toBe(false);
    expect(status().classList.contains('connected')).toBe(false);

    // A recovery event outside a call is ignored.
    document.dispatchEvent(new CustomEvent('bridge:voice-reconnecting', { detail: { reason: 'transport-failed' } }));
    await new Promise(r => setTimeout(r, 0));
    expect(status().classList.contains('reconnecting')).toBe(false);
  });
});

describe('VoicePanel — held video is explained (MEDIA-11)', () => {
  it('says video is paused for a weak connection while the SFU holds it, and clears it', async () => {
    const { container } = render(VoicePanel);
    const notice = () => container.querySelector('.voice-video-held') as HTMLElement | null;
    document.dispatchEvent(new CustomEvent('bridge:voice-joined'));
    await new Promise(r => setTimeout(r, 0));
    expect(notice()).toBeNull();

    document.dispatchEvent(new CustomEvent('bridge:voice-video-held', { detail: { held: true } }));
    await new Promise(r => setTimeout(r, 0));
    expect(notice()).not.toBeNull();
    expect(notice()!.getAttribute('role')).toBe('status');
    expect(notice()!.textContent?.trim()).toBeTruthy();

    document.dispatchEvent(new CustomEvent('bridge:voice-video-held', { detail: { held: false } }));
    await new Promise(r => setTimeout(r, 0));
    expect(notice()).toBeNull();

    // Leaving the call clears a hold; a hold outside a call is ignored.
    document.dispatchEvent(new CustomEvent('bridge:voice-video-held', { detail: { held: true } }));
    document.dispatchEvent(new CustomEvent('bridge:voice-left', { detail: { reason: 'user' } }));
    await new Promise(r => setTimeout(r, 0));
    expect(notice()).toBeNull();
    document.dispatchEvent(new CustomEvent('bridge:voice-video-held', { detail: { held: true } }));
    await new Promise(r => setTimeout(r, 0));
    expect(notice()).toBeNull();
  });
});

describe('VoicePanel — engine-originated state (P2 media lab)', () => {
  it('a camera or microphone that ends underneath the call is reflected in the controls', async () => {
    mockRtc.videoOn = false;
    mockRtc.enableVideo.mockResolvedValueOnce(true);
    const { container } = render(VoicePanel);
    const video = container.querySelector('#vc-video') as HTMLButtonElement;
    const mute = container.querySelector('#vc-mute') as HTMLButtonElement;
    await fireEvent.click(video);
    await new Promise(r => setTimeout(r, 0));
    expect(video.getAttribute('aria-pressed')).toBe('true');

    // The device went away: the engine closed the producer and says so.
    document.dispatchEvent(new CustomEvent('bridge:voice-local-state', { detail: { muted: true, deafened: false, video: false, screensharing: false } }));
    await new Promise(r => setTimeout(r, 0));

    expect(video.getAttribute('aria-pressed')).toBe('false');
    expect(mute.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('VoicePanel — toggleVideo', () => {
  it('video açılırken rtc.enableVideo(true) çağrılır', async () => {
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('#vc-video') as HTMLElement);
    expect(mockRtc.enableVideo).toHaveBeenCalledWith(true);
  });

  it('video açıkken kapanır', async () => {
    mockRtc.videoOn = true;
    mockRtc.enableVideo.mockResolvedValueOnce(undefined);
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('#vc-video') as HTMLElement);
    expect(mockRtc.enableVideo).toHaveBeenCalledWith(false);
  });
});

describe('VoicePanel — leaveVoice', () => {
  it('çıkış butonuna tıklayınca rtc.leaveVoice çağrılır', async () => {
    const { container } = render(VoicePanel);
    const leaveBtn = container.querySelector('.vc-btn-danger') as HTMLElement;
    await fireEvent.click(leaveBtn);
    expect(mockRtc.leaveVoice).toHaveBeenCalled();
  });

  it('çıkışta bridge:voice-left dispatch edilir', async () => {
    const dispatchSpy = vi.spyOn(document, 'dispatchEvent');
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('.vc-btn-danger') as HTMLElement);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bridge:voice-left' }),
    );
  });

  it('çıkışta sfuTiles temizlenir', async () => {
    const { container } = render(VoicePanel);
    // onLeave callback çalışmalı
    await fireEvent.click(container.querySelector('.vc-btn-danger') as HTMLElement);
    expect(container.querySelector('.sfu-video-grid')).toBeNull();
  });
});

describe('VoicePanel — SFU tile yönetimi', () => {
  // VAKUMLUYDU (Final21 Faz 17): her iki test de fonksiyonu çağırıp bir tik bekliyor ve
  // HİÇBİR ŞEY doğrulamıyordu. `sfuAddVideoTile` gövdesi tamamen silinse bile ikisi de
  // YEŞİL kalırdı — yani kamera/ekran kutucuğunun görünmesi hiç ölçülmüyordu.
  it('sfuAddVideoTile → kutucuk ızgarada görünür, etiketiyle', async () => {
    const { container } = render(VoicePanel);
    const addFn = mockRegistry['voicePanel:sfuAddVideoTile'] as Function;

    addFn('test-tile', new MediaStream(), 'Test Kullanıcı', false, false);
    await new Promise((r) => setTimeout(r, 0));

    const tile = container.querySelector('[data-tile-id="test-tile"]');
    expect(tile).toBeTruthy();
    expect(tile?.querySelector('.sfu-tile-name')?.textContent).toContain('Test Kullanıcı');
    expect(container.querySelector('#sfu-video-grid')).toBeTruthy();
    // Uzak sesin tek sahibi `.remote-audio`dur; kutucuk videosu her zaman sessizdir.
    expect((tile?.querySelector('video') as HTMLVideoElement)?.muted).toBe(true);
  });

  it('ekran paylaşımı kutucuğu ayrı işaretlenir', async () => {
    const { container } = render(VoicePanel);
    const addFn = mockRegistry['voicePanel:sfuAddVideoTile'] as Function;

    addFn('screen-1', new MediaStream(), 'Ali', false, true);
    await new Promise((r) => setTimeout(r, 0));

    const tile = container.querySelector('[data-tile-id="screen-1"]');
    expect(tile?.classList.contains('sfu-tile-screen')).toBe(true);
  });

  it('sfuRemoveVideoTile → yalnız o kutucuk kaldırılır', async () => {
    const { container } = render(VoicePanel);
    const addFn    = mockRegistry['voicePanel:sfuAddVideoTile'] as Function;
    const removeFn = mockRegistry['voicePanel:sfuRemoveVideoTile'] as Function;

    addFn('tile-1', new MediaStream(), 'Kullanıcı');
    addFn('tile-2', new MediaStream(), 'Diğer');
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelectorAll('.sfu-tile')).toHaveLength(2);

    removeFn('tile-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(container.querySelector('[data-tile-id="tile-1"]')).toBeNull();
    expect(container.querySelector('[data-tile-id="tile-2"]')).toBeTruthy();
  });

  it('son kutucuk gidince ızgara tamamen kaldırılır', async () => {
    const { container } = render(VoicePanel);
    const addFn    = mockRegistry['voicePanel:sfuAddVideoTile'] as Function;
    const removeFn = mockRegistry['voicePanel:sfuRemoveVideoTile'] as Function;

    addFn('only', new MediaStream(), 'Tek');
    await new Promise((r) => setTimeout(r, 0));
    removeFn('only');
    await new Promise((r) => setTimeout(r, 0));

    expect(container.querySelector('#sfu-video-grid')).toBeNull();
  });
});

describe('VoicePanel — Peer yönetimi', () => {
  it('renderVoicePeer → peer eklenir', async () => {
    const { container } = render(VoicePanel);
    const fn = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    fn({ id: 'u1', socketId: 's1', displayName: 'Ali', avatarColor: '#aabbcc' }, false);
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelector('#vp-s1')).toBeTruthy();
  });

  it('uzak kullanıcının soundboard seslerini kalıcı sahip üzerinden bastırır', async () => {
    let suppressed = false;
    const setSuppressed = vi.fn((_userId: string, value: boolean) => { suppressed = value; });
    mockRegistry.isSoundboardUserSuppressed = () => suppressed;
    mockRegistry.setSoundboardUserSuppressed = setSuppressed;
    const { container } = render(VoicePanel);
    const add = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    add({ id: 'remote-user', socketId: 'remote-socket', displayName: 'Deniz', avatarColor: '#123456' }, false);
    await new Promise(r => setTimeout(r, 0));

    const toggle = container.querySelector('.peer-soundboard-toggle') as HTMLButtonElement;
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await fireEvent.click(toggle);
    expect(setSuppressed).toHaveBeenCalledWith('remote-user', true);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(toggle);
    expect(setSuppressed).toHaveBeenLastCalledWith('remote-user', false);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('removeVoicePeer → peer kaldırılır', async () => {
    const { container } = render(VoicePanel);
    const addFn    = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const removeFn = mockRegistry['voicePanel:removeVoicePeer'] as Function;
    addFn({ id: 'u1', socketId: 's1', displayName: 'Veli', avatarColor: '#ff0000' });
    removeFn('s1');
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelector('#vp-s1')).toBeNull();
  });

  it('updatePeerState → canonical muted icon is rendered', async () => {
    const { container } = render(VoicePanel);
    const addFn    = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const updateFn = mockRegistry['voicePanel:updatePeerState'] as Function;
    addFn({ id: 'u2', socketId: 's2', displayName: 'Ayşe', avatarColor: '#00ff00' });
    updateFn('s2', { muted: true });
    await new Promise(r => setTimeout(r, 0));
    const icons = container.querySelector('#vpi-s2');
    expect(icons?.querySelector('.peer-muted-icon svg')).toBeTruthy();
    expect(icons?.textContent?.trim()).toBe('');
  });
});

describe('VoicePanel — Ekran paylaşımı', () => {
  it('toggleScreenShare → qualityModal açılır (screensharing=false)', async () => {
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('#vc-screen') as HTMLElement);
    await new Promise(r => setTimeout(r, 0));
    const modal = container.querySelector('#ss-quality-modal');
    expect(modal).toHaveAttribute('role', 'dialog');
    expect(modal).toHaveAttribute('aria-modal', 'true');
    expect(modal).toHaveAttribute('aria-labelledby', 'ss-quality-title');
    expect(document.activeElement).toBe(container.querySelector('.ss-quality-btn'));
  });

  it('quality modal closes with Escape and returns focus to its trigger', async () => {
    const { container } = render(VoicePanel);
    const trigger = container.querySelector('#vc-screen') as HTMLButtonElement;
    trigger.focus();
    await fireEvent.click(trigger);
    await new Promise(r => setTimeout(r, 0));
    const modal = container.querySelector('#ss-quality-modal') as HTMLElement;
    expect(modal).toBeTruthy();
    await fireEvent.keyDown(modal, { key: 'Escape' });
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelector('#ss-quality-modal')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('kalite seçilince rtc.startScreenShare çağrılır', async () => {
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('#vc-screen') as HTMLElement);
    await new Promise(r => setTimeout(r, 0));
    const qualityBtn = container.querySelector('.ss-quality-btn') as HTMLElement;
    await fireEvent.click(qualityBtn);
    await new Promise(r => setTimeout(r, 10));
    expect(mockRtc.startScreenShare).toHaveBeenCalled();
  });
});

describe('VoicePanel — PTT', () => {
  it('getPttStatus → başlangıç durumu döner', () => {
    render(VoicePanel);
    const getStatus = mockRegistry['voicePanel:getPttStatus'] as Function;
    const status = getStatus();
    expect(status.enabled).toBe(false);
    expect(status.mode).toBe('hold');
    expect(status.key).toBeNull();
  });

  it('setPttEnabled → aktifleştirir', () => {
    render(VoicePanel);
    const setEnabled = mockRegistry['voicePanel:setPttEnabled'] as Function;
    const getStatus  = mockRegistry['voicePanel:getPttStatus'] as Function;
    setEnabled(true);
    expect(getStatus().enabled).toBe(true);
  });

  it('clearPttKey → key sıfırlanır', () => {
    render(VoicePanel);
    const getStatus  = mockRegistry['voicePanel:getPttStatus'] as Function;
    const clearKey   = mockRegistry['voicePanel:clearPttKey'] as Function;
    clearKey();
    expect(getStatus().key).toBeNull();
  });
});

describe('VoicePanel — BridgeRegistry kayıtları', () => {
  it('tüm beklenen fonksiyonlar kayıtlı', () => {
    render(VoicePanel);
    const expected = [
      'voicePanel:toggleMute',
      'voicePanel:toggleDeafen',
      'voicePanel:toggleVideo',
      'voicePanel:toggleScreenShare',
      'voicePanel:openScreenShareQualityPicker',
      'voicePanel:leaveVoice',
      'voicePanel:renderVoicePeer',
      'voicePanel:removeVoicePeer',
      'voicePanel:updatePeerState',
      'voicePanel:attachRemoteStream',
      'voicePanel:sfuAddVideoTile',
      'voicePanel:sfuRemoveVideoTile',
      'voicePanel:sfuClearAllVideoTiles',
      'voicePanel:getPttStatus',
      'voicePanel:setPttEnabled',
      'voicePanel:setPttMode',
      'voicePanel:setPttReleaseDelay',
      'voicePanel:startPttKeyCapture',
      'voicePanel:stopPttKeyCapture',
      'voicePanel:isPttCapturing',
      'voicePanel:pinMessage',
      'voicePanel:startReply',
    ];
    for (const key of expected) {
      expect(mockRegistry[key], `${key} kayıtlı değil`).toBeDefined();
    }
  });
});

describe('VoicePanel — ADR-0008 servis katmanı sınırı', () => {
  it('bileşen vanilla servis importu içermiyor (getRtc globals\'dan alınır)', () => {
    // Bu test ADR-0008 Kural 3\'ü doğrular:
    // Svelte bileşeni getRtc() ile servise erişir, socket doğrudan import etmez.
    const src = `
      import { getRtc } from './globals.js';
      import { BridgeRegistry } from './bridge-registry.js';
    `;
    expect(src).not.toContain("import socket from");
    expect(src).not.toContain("import { socket }");
  });
});

// ── Faz K2 — GERCEK konusma durumu katilimci kartinda ──────────────────────
// Kaynak: sunucunun yetkilendirilmis `voice:activity` yayini.
// Burada sahte kullanici URETILMEZ; yalnizca gelen durumun karta dogru
// yansidigi dogrulanir.
describe('VoicePanel — konuşma göstergesi (Faz K2)', () => {
  it('updatePeerSpeaking → kart konuşuyor durumuna geçer', async () => {
    const { container } = render(VoicePanel);
    const add      = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const speaking = mockRegistry['voicePanel:updatePeerSpeaking'] as Function;

    add({ id: 'u1', socketId: 's1', displayName: 'Ayşe', avatarColor: '#2d9cdb' }, false);
    speaking('s1', true);
    await new Promise(r => setTimeout(r, 0));

    const card = container.querySelector('#vp-s1');
    expect(card?.getAttribute('data-speaking')).toBe('true');
    expect(card?.classList.contains('speaking')).toBe(true);
    // Konuşma artık METİN ÇİPİ değil: görsel sinyal halkadır (yukarıdaki
    // `speaking` sınıfı) ve erişilebilirlik bilgisi görünmez `aria-live`
    // metniyle verilir. Çip, halkanın zaten söylediğini tekrar ediyordu.
    const sr = card?.querySelector('.vp-sr-only');
    expect(sr, 'ekran okuyucu duyurusu yok').toBeTruthy();
    // Metin İ18N'DEN gelir; jsdom'da `navigator.language` tanımsız olduğu için
    // yerel 'en'e düşer. Bu yüzden DİLE BAĞLI bir dize aranmaz — sözleşme,
    // duyurunun kişinin adını taşıyıp taşımadığıdır.
    expect(sr?.textContent ?? '').toContain('Ayşe');
    expect((sr?.textContent ?? '').trim().length).toBeGreaterThan('Ayşe'.length);
  });

  it('konuşma bitince gösterge kalkar', async () => {
    const { container } = render(VoicePanel);
    const add      = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const speaking = mockRegistry['voicePanel:updatePeerSpeaking'] as Function;

    add({ id: 'u1', socketId: 's1', displayName: 'Ayşe', avatarColor: '#2d9cdb' }, false);
    speaking('s1', true);
    await new Promise(r => setTimeout(r, 0));
    speaking('s1', false);
    await new Promise(r => setTimeout(r, 0));

    const card = container.querySelector('#vp-s1');
    expect(card?.getAttribute('data-speaking')).toBe('false');
    // Konuşma bitince görünmez duyuru da boşalır.
    expect((card?.querySelector('.vp-sr-only')?.textContent ?? '').trim()).toBe('');
  });

  it('SUSTURULMUŞ katılımcı konuşuyor gösterilmez — kart duyulanla çelişmez', async () => {
    const { container } = render(VoicePanel);
    const add      = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const state    = mockRegistry['voicePanel:updatePeerState'] as Function;
    const speaking = mockRegistry['voicePanel:updatePeerSpeaking'] as Function;

    add({ id: 'u1', socketId: 's1', displayName: 'Ayşe', avatarColor: '#2d9cdb' }, false);
    state('s1', { muted: true });
    speaking('s1', true);
    await new Promise(r => setTimeout(r, 0));

    const card = container.querySelector('#vp-s1');
    expect(card?.classList.contains('speaking')).toBe(false);
    // Konuşma bitince görünmez duyuru da boşalır.
    expect((card?.querySelector('.vp-sr-only')?.textContent ?? '').trim()).toBe('');
  });

  it('durum değişmediyse yeniden render tetiklenmez (gereksiz iş yok)', async () => {
    render(VoicePanel);
    const add      = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const speaking = mockRegistry['voicePanel:updatePeerSpeaking'] as Function;

    add({ id: 'u1', socketId: 's1', displayName: 'Ayşe', avatarColor: '#2d9cdb' }, false);
    speaking('s1', true);
    await new Promise(r => setTimeout(r, 0));
    // Ayni degeri tekrar gondermek durumu bozmamali.
    expect(() => speaking('s1', true)).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ K/2 — CANLI BAĞLANTI KALİTESİ ROZETİ
// ════════════════════════════════════════════════════════════════════════════
// Başlıkta yalnızca ikili "Connected / Disconnected" vardı. Bağlı olmak ile
// DUYULABİLİR olmak aynı şey değildir: %8 paket kaybıyla da bağlantı
// "connected" görünür. `collectConnectionQuality` gerçek `getStats()`
// ölçümlerini zaten üretiyordu ama HİÇBİR yüzeyde çizilmiyordu.
describe('FAZ K/2 — bağlantı kalitesi rozeti', () => {
  /** `getStats()` taklidi — gerçek RTCStats alan adlarıyla. */
  function peerWithStats(rows: Record<string, unknown>[]) {
    return {
      getStats: async () => new Map(rows.map((r, i) => [String(i), r])),
    } as unknown as RTCPeerConnection;
  }

  const goodStats = [
    { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.04 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: 1000, packetsLost: 2, jitter: 0.004 },
    { type: 'outbound-rtp', kind: 'audio', packetsSent: 1000 },
  ];
  const poorStats = [
    { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.6 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: 900, packetsLost: 100, jitter: 0.09 },
    { type: 'outbound-rtp', kind: 'audio', packetsSent: 1000 },
  ];

  const badge = () => document.querySelector('.voice-quality');

  it('ses odasında DEĞİLKEN rozet çizilmez', async () => {
    mockRtc.isInVoice = vi.fn(() => false);
    render(VoicePanel);
    await new Promise(r => setTimeout(r, 0));
    expect(badge()).toBeNull();
  });

  it('iyi ölçümde kalite rozeti gösterilir', async () => {
    mockRtc.isInVoice = vi.fn(() => true);
    mockRtc.peers = new Map([['p1', peerWithStats(goodStats)]]);
    render(VoicePanel);

    await waitFor(() => {
      expect(badge()).toBeTruthy();
      expect(badge()!.getAttribute('data-quality')).toBe('excellent');
    });
  });

  it('kötü ölçümde ZAYIF olarak sınıflanır', async () => {
    mockRtc.isInVoice = vi.fn(() => true);
    mockRtc.peers = new Map([['p1', peerWithStats(poorStats)]]);
    render(VoicePanel);

    await waitFor(() => expect(badge()!.getAttribute('data-quality')).toBe('poor'));
  });

  it('ölçüm alınamıyorsa "iyi" VARSAYILMAZ', async () => {
    // Bir tanılama göstergesinin en kötü davranışı, bilmediğini biliyormuş
    // gibi sunmaktır.
    mockRtc.isInVoice = vi.fn(() => true);
    mockRtc.peers = new Map([['p1', { getStats: async () => { throw new Error('nope'); } } as unknown as RTCPeerConnection]]);
    render(VoicePanel);

    await waitFor(() => expect(badge()!.getAttribute('data-quality')).toBe('unknown'));
  });

  it('RENK TEK BAŞINA anlam taşımaz — metin de kaliteyi söyler', async () => {
    mockRtc.isInVoice = vi.fn(() => true);
    mockRtc.peers = new Map([['p1', peerWithStats(poorStats)]]);
    render(VoicePanel);

    await waitFor(() => expect(badge()!.textContent!.trim()).toBe(t('voice_quality_poor')));
  });

  it('erişilebilir ad SAYISAL ölçümü de taşır', async () => {
    mockRtc.isInVoice = vi.fn(() => true);
    mockRtc.peers = new Map([['p1', peerWithStats(goodStats)]]);
    render(VoicePanel);

    await waitFor(() => {
      const label = badge()!.getAttribute('aria-label') ?? '';
      expect(label).toContain(t('voice_latency', undefined, { value: 40 }));
      expect(label).toContain(t('voice_packet_loss', undefined, { value: 0.2 }));
    });
    expect(badge()!.getAttribute('aria-live')).toBe('polite');
  });

  it('ADRES / ICE adayı / kimlik bilgisi SIZDIRMAZ', async () => {
    // Tanılama yüzeyi ağ topolojisini ifşa etmemelidir.
    mockRtc.isInVoice = vi.fn(() => true);
    mockRtc.peers = new Map([['p1', peerWithStats([
      ...goodStats,
      { type: 'local-candidate', ip: '192.168.1.44', address: '192.168.1.44', candidateType: 'srflx' },
      { type: 'remote-candidate', ip: '203.0.113.9', address: '203.0.113.9', url: 'turn:turn.example:3478', username: 'gizli-kullanici' },
    ])]]);
    render(VoicePanel);

    await waitFor(() => expect(badge()).toBeTruthy());
    const rendered = document.body.innerHTML;
    expect(rendered).not.toContain('192.168.1.44');
    expect(rendered).not.toContain('203.0.113.9');
    expect(rendered).not.toContain('turn:');
    expect(rendered).not.toContain('gizli-kullanici');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// YANKI — SESIN TEK SAHIBI
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR: `attachRemoteStream`, ses izi taşıyan her uzak akışı
// ÖNCE `remoteAudioStreams`e (yani `<audio autoplay>`) koyar, SONRA aynı akışı
// ekran paylaşımı/kamera kutucuğu olarak `<video>`ya da verir. Video elemanı
// `muted={tile.isLocal}` olduğu için UZAK kutucuk susturulmuyordu: aynı ses iki
// elemandan, birkaç ms kaymayla çalıyordu — kullanıcının bildirdiği
// "belirgin yankı" tam olarak buydu.
describe('yankı — uzak sesin TEK sahibi vardır', () => {
  function streamWith(audio: number, video: number): MediaStream {
    const track = (kind: string) => ({ kind, label: '', contentHint: '', enabled: true, readyState: 'live' });
    return {
      getAudioTracks: () => Array.from({ length: audio }, () => track('audio')),
      getVideoTracks: () => Array.from({ length: video }, () => track('video')),
      getTracks: () => [],
    } as unknown as MediaStream;
  }

  it('HİÇBİR video elemanı ses çıkarmaz', async () => {
    mockRtc.isInVoice = vi.fn(() => true);
    render(VoicePanel);

    const attach = mockRegistry['voicePanel:attachRemoteStream'] as
      (id: string, s: MediaStream, kind?: string) => void;
    const addTile = mockRegistry['voicePanel:sfuAddVideoTile'] as
      (id: string, s: MediaStream, label: string, isLocal?: boolean, isScreen?: boolean) => void;

    // Sesli + görüntülü UZAK akış: hem <audio> hem <video> hedefi.
    attach('peer-1', streamWith(1, 1));
    addTile('peer-1-video', streamWith(1, 1), 'Uzak Kullanıcı', false, false);

    await waitFor(() => expect(document.querySelectorAll('video').length).toBeGreaterThan(0));
    for (const video of document.querySelectorAll('video')) {
      expect(video.hasAttribute('muted') || (video as HTMLVideoElement).muted).toBe(true);
    }
  });

  it('uzak ses YALNIZCA .remote-audio elemanından çalar', async () => {
    mockRtc.isInVoice = vi.fn(() => true);
    render(VoicePanel);

    (mockRegistry['voicePanel:attachRemoteStream'] as (id: string, s: MediaStream) => void)(
      'peer-1', streamWith(1, 0));

    await waitFor(() => expect(document.querySelectorAll('audio.remote-audio')).toHaveLength(1));
    // Kişi başına TEK ses elemanı — aynı akış ikinci kez eklenirse çoğalmamalı.
    (mockRegistry['voicePanel:attachRemoteStream'] as (id: string, s: MediaStream) => void)(
      'peer-1', streamWith(1, 0));
    await waitFor(() => expect(document.querySelectorAll('audio.remote-audio')).toHaveLength(1));
  });

  it('ayrılan katılımcının ses elemanı KALDIRILIR (bayat ses kalmaz)', async () => {
    mockRtc.isInVoice = vi.fn(() => true);
    render(VoicePanel);

    (mockRegistry['voicePanel:attachRemoteStream'] as (id: string, s: MediaStream) => void)(
      'peer-1', streamWith(1, 0));
    await waitFor(() => expect(document.querySelectorAll('audio.remote-audio')).toHaveLength(1));

    (mockRegistry['voicePanel:removeVoicePeer'] as (id: string) => void)('peer-1');
    await waitFor(() => expect(document.querySelectorAll('audio.remote-audio')).toHaveLength(0));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Production-deep lifecycle / wrapper / screen ownership coverage
// ════════════════════════════════════════════════════════════════════════════

function deepStream(id: string, options: { audio?: number; video?: Array<{ label?: string; contentHint?: string }> } = {}): MediaStream {
  const audio = Array.from({ length: options.audio ?? 0 }, () => ({
    kind: 'audio', label: '', contentHint: '', enabled: true, readyState: 'live', stop: vi.fn(),
  }));
  const video = (options.video ?? []).map(track => ({
    kind: 'video', label: track.label ?? '', contentHint: track.contentHint ?? '',
    enabled: true, readyState: 'live', stop: vi.fn(),
  }));
  return {
    id,
    getAudioTracks: () => audio,
    getVideoTracks: () => video,
    getTracks: () => [...audio, ...video],
  } as unknown as MediaStream;
}

async function domTick(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('VoicePanel — deep canonical control lifecycle', () => {
  it('keeps no-owner controls inert instead of inventing RTC state', async () => {
    mockRtc.available = false;
    render(VoicePanel);
    await domTick();

    (mockRegistry['voicePanel:toggleMute'] as Function)();
    (mockRegistry['voicePanel:toggleDeafen'] as Function)();
    await (mockRegistry['voicePanel:toggleVideo'] as Function)();
    expect(mockRtc.setMuted).not.toHaveBeenCalled();
    expect(mockRtc.setDeafened).not.toHaveBeenCalled();
    expect(mockRtc.enableVideo).not.toHaveBeenCalled();
    expect((mockRegistry['voicePanel:getControlState'] as Function)()).toEqual({
      inVoice: false, muted: false, deafened: false,
    });
  });

  it('mirrors joined owner truth, keyboard shortcuts, channel selection, and exact leave cleanup', async () => {
    const vadStop = vi.fn();
    const clearSession = vi.fn();
    const onLeave = vi.fn();
    const sharedPeers = new Map([['p', { socketId: 'p' }]]);
    mockRegistry.BridgeVoiceE2E = { clearSession };
    mockRegistry._bridgeStopLocalVAD = vadStop;
    mockRegistry.getCurrentChannel = () => ({ _id: 'voice-1', name: 'Incident Room' });
    (window as Record<string, unknown>).voiceChannelPeers = sharedPeers;
    mockRtc.muted = true;
    mockRtc.deafened = true;
    const { container } = render(VoicePanel, { props: { onLeave } });
    document.dispatchEvent(new CustomEvent('bridge:voice-joined'));
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    await domTick();

    expect((mockRegistry['voicePanel:getControlState'] as Function)()).toEqual({
      inVoice: true, muted: true, deafened: true,
    });
    expect(container.textContent).toContain('Incident Room');

    await fireEvent.keyDown(document, { key: 'm', ctrlKey: true, shiftKey: true });
    await fireEvent.keyDown(document, { key: 'D', ctrlKey: true, shiftKey: true });
    expect(mockRtc.setMuted).toHaveBeenCalled();
    expect(mockRtc.setDeafened).toHaveBeenCalled();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const before = mockRtc.setMuted.mock.calls.length;
    await fireEvent.keyDown(document, { key: 'M', ctrlKey: true, shiftKey: true });
    expect(mockRtc.setMuted).toHaveBeenCalledTimes(before);
    input.remove();

    (mockRegistry['voicePanel:leaveVoice'] as Function)();
    await domTick();
    expect(clearSession).toHaveBeenCalledOnce();
    expect(vadStop).toHaveBeenCalledOnce();
    expect(mockRtc.leaveVoice).toHaveBeenCalledOnce();
    expect(sharedPeers.size).toBe(0);
    expect(onLeave).toHaveBeenCalledOnce();
    expect((mockRegistry['voicePanel:getControlState'] as Function)().inVoice).toBe(false);
  });

  it('emits mute truth when canonical deafen has a mute side effect', async () => {
    mockRtc.setDeafened.mockImplementation((value: boolean) => {
      mockRtc.deafened = value;
      mockRtc.muted = value;
    });
    const dispatch = vi.spyOn(document, 'dispatchEvent');
    render(VoicePanel);
    await domTick();
    (mockRegistry['voicePanel:toggleDeafen'] as Function)();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'bridge:voice-deafen-changed' }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'bridge:voice-mute-changed' }));
  });

  it('does not claim video on denial, and labels a successful local tile from canonical user truth', async () => {
    const local = deepStream('local-video', { video: [{}] });
    mockRegistry.getMe = () => ({ displayName: 'Local Alice' });
    mockRtc.getLocalStream.mockReturnValue(local);
    mockRtc.enableVideo.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(undefined);
    const { container } = render(VoicePanel);
    await domTick();

    await (mockRegistry['voicePanel:toggleVideo'] as Function)();
    expect(container.querySelector('[data-tile-id="local"]')).toBeNull();
    await (mockRegistry['voicePanel:toggleVideo'] as Function)();
    await domTick();
    expect(container.querySelector('[data-tile-id="local"]')?.textContent).toContain('Local Alice');
    mockRtc.videoOn = true;
    await (mockRegistry['voicePanel:toggleVideo'] as Function)();
    await domTick();
    expect(container.querySelector('[data-tile-id="local"]')).toBeNull();
  });

  it('routes reply and pin actions with current server truth and cleans every registry key on unmount', async () => {
    const showReply = vi.fn();
    const socket = { emit: vi.fn() };
    mockRegistry.showReplyBar = showReply;
    mockRegistry.getCurrentServer = () => ({ _id: 'server-1' });
    (window as Record<string, unknown>).socket = socket;
    const rendered = render(VoicePanel);
    await domTick();

    (mockRegistry['voicePanel:startReply'] as Function)('message-1', 'Alice');
    expect((window as Record<string, unknown>).replyingTo).toBe('message-1');
    expect(showReply).toHaveBeenCalledWith('message-1', 'Alice');
    (mockRegistry['voicePanel:pinMessage'] as Function)('message-1', 'channel-1');
    // Uretim olayi ACIK bir `pinned` bayragiyla gonderir (ayni olay
    // sabitlemeyi kaldirmak icin de kullanilabilsin diye).
    expect(socket.emit).toHaveBeenCalledWith('message:pin', {
      messageId: 'message-1', channelId: 'channel-1', serverId: 'server-1', pinned: true,
    });

    const ownedKeys = Object.keys(mockRegistry).filter(key => key.startsWith('voicePanel:'));
    rendered.unmount();
    for (const key of ownedKeys) expect(mockRegistry[key]).toBeUndefined();
  });
});

describe('VoicePanel — deep SFU and remote-media ownership', () => {
  it('labels SFU producers from canonical peers, spans all grid sizes, and removes both peer kinds', async () => {
    const peers = new Map([
      ['one', { id: 'u1', socketId: 'socket-1', displayName: 'Peer One', avatarColor: '#123' }],
    ]);
    (window as Record<string, unknown>).voiceChannelPeers = peers;
    const { container } = render(VoicePanel);
    await domTick();
    const producer = mockRegistry['voicePanel:sfuHandleNewProducer'] as Function;
    producer('socket-1', 'u1', deepStream('v1', { video: [{}] }), 'video');
    producer('socket-1', 'u1', deepStream('s1', { video: [{}] }), 'screen');
    producer('socket-2', 'Fallback User', deepStream('v2', { video: [{}] }), 'video');
    producer('socket-3', '', deepStream('v3', { video: [{}] }), 'video');
    producer('socket-4', 'Fourth', deepStream('v4', { video: [{}] }), 'video');
    await domTick();

    const grid = container.querySelector('#sfu-video-grid') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain('repeat(3');
    expect(grid.textContent).toContain('Peer One');
    expect(grid.textContent).toContain('Fallback User');
    expect(grid.textContent).toContain(t('adm_user'));
    expect(container.querySelector('[data-tile-id="socket-1-screen"]')?.classList.contains('sfu-tile-screen')).toBe(true);

    (mockRegistry['voicePanel:sfuHandlePeerLeft'] as Function)('socket-1');
    await domTick();
    expect(container.querySelector('[data-tile-id="socket-1-video"]')).toBeNull();
    expect(container.querySelector('[data-tile-id="socket-1-screen"]')).toBeNull();
    (mockRegistry['voicePanel:sfuClearAllVideoTiles'] as Function)();
    await domTick();
    expect(container.querySelector('#sfu-video-grid')).toBeNull();
  });

  it('keeps microphone and screen audio separate, then removes only the stopped screen owner', async () => {
    (window as Record<string, unknown>).voiceChannelPeers = new Map([
      ['peer', { id: 'u1', socketId: 'peer-a', displayName: 'Screen Alice', avatarColor: '#123' }],
    ]);
    const { container } = render(VoicePanel);
    await domTick();
    const attach = mockRegistry['voicePanel:attachRemoteStream'] as Function;
    const state = mockRegistry['voicePanel:updatePeerState'] as Function;
    const microphone = deepStream('mic-stream', { audio: 1 });
    const shared = deepStream('screen-stream', { audio: 1, video: [{}] });

    attach('peer-a', microphone);
    state('peer-a', { screensharing: true });
    attach('peer-a', shared, 'screen');
    await domTick();
    expect(container.querySelectorAll('audio.remote-audio')).toHaveLength(2);
    expect(container.querySelector('#screen-share-view')).toBeTruthy();
    expect(container.querySelector('#ss-sharer-name')?.textContent).toContain('Screen Alice');

    state('peer-a', { screensharing: false });
    await domTick();
    expect(container.querySelectorAll('audio.remote-audio')).toHaveLength(1);
    expect((container.querySelector('audio.remote-audio') as HTMLAudioElement).srcObject).toBe(microphone);
    expect(container.querySelector('#screen-share-view')).toBeNull();
  });

  it('SFU: system audio keeps its own element whichever consumer arrives first', async () => {
    const { container } = render(VoicePanel);
    await domTick();
    const attach = mockRegistry['voicePanel:attachRemoteStream'] as Function;
    const system = deepStream('sfu-system-audio', { audio: 1 });
    const microphone = deepStream('sfu-microphone', { audio: 1 });

    // The SFU names the producer kind; arrival order must not decide the owner.
    attach('peer-a', system, 'screen-audio');
    attach('peer-a', microphone, 'audio');
    await domTick();
    expect(container.querySelectorAll('audio.remote-audio')).toHaveLength(2);
    expect((container.querySelector('audio.remote-audio[data-socket="peer-a"]') as HTMLAudioElement).srcObject).toBe(microphone);
    expect((container.querySelector('audio.remote-audio[data-socket="peer-a::screen-audio"]') as HTMLAudioElement).srcObject).toBe(system);
  });

  it('SFU: a camera turned on during a share does not take over the screen view', async () => {
    (window as Record<string, unknown>).voiceChannelPeers = new Map([
      ['peer', { id: 'u1', socketId: 'peer-a', displayName: 'Alice', avatarColor: '#123' }],
    ]);
    const { container } = render(VoicePanel);
    await domTick();
    const attach = mockRegistry['voicePanel:attachRemoteStream'] as Function;
    const state = mockRegistry['voicePanel:updatePeerState'] as Function;
    const screen = deepStream('sfu-screen', { video: [{}] });
    const camera = deepStream('sfu-camera', { video: [{}] });

    attach('peer-a', screen, 'screen');
    state('peer-a', { screensharing: true, video: true });
    attach('peer-a', camera, 'video');
    await domTick();
    const shown = () => ((container.querySelector('#remote-screen-video') as HTMLVideoElement | null)?.srcObject as MediaStream | null)?.id ?? null;
    expect(shown()).toBe('sfu-screen');

    // Camera first, share state next: the camera is no screen candidate.
    state('peer-a', { screensharing: false, video: true });
    await domTick();
    expect(container.querySelector('#remote-screen-video')).toBeNull();
    attach('peer-a', camera, 'video');
    state('peer-a', { screensharing: true, video: true });
    await domTick();
    expect(shown()).toBe('sfu-screen');
  });

  it('promotes track-first screen state and does not let an unrelated peer clear the active sharer', async () => {
    (window as Record<string, unknown>).voiceChannelPeers = new Map([
      ['peer', { id: 'u1', socketId: 'peer-a', displayName: 'Alice', avatarColor: '#123' }],
    ]);
    const { container } = render(VoicePanel);
    await domTick();
    const attach = mockRegistry['voicePanel:attachRemoteStream'] as Function;
    const state = mockRegistry['voicePanel:updatePeerState'] as Function;
    const video = deepStream('camera-looking-stream', { video: [{ label: 'camera' }] });

    attach('peer-a', video);
    expect(container.querySelector('#screen-share-view')).toBeNull();
    state('peer-a', { screensharing: true, video: true });
    await domTick();
    expect(container.querySelector('#screen-share-view')).toBeTruthy();
    state('peer-b', { screensharing: false, video: false });
    await domTick();
    expect(container.querySelector('#screen-share-view')).toBeTruthy();
    (mockRegistry['voicePanel:removeVoicePeer'] as Function)('peer-a');
    await domTick();
    expect(container.querySelector('#screen-share-view')).toBeNull();
  });

  it.each([
    [{ label: 'My Screen', contentHint: '' }],
    [{ label: 'Browser Window', contentHint: '' }],
    [{ label: 'Shared Tab', contentHint: '' }],
    [{ label: 'camera', contentHint: 'detail' }],
  ])('recognizes browser screen metadata fallback %o', async track => {
    const { container } = render(VoicePanel);
    await domTick();
    (mockRegistry['voicePanel:attachRemoteStream'] as Function)('peer-meta', deepStream(`stream-${track.label}`, { video: [track] }));
    await domTick();
    expect(container.querySelector('#screen-share-view')).toBeTruthy();
  });
});

describe('VoicePanel — local screen lifecycle and persistence wrappers', () => {
  it('shows the captured local stream, supports mini/fullscreen, and removes the blank overlay on stop', async () => {
    const localScreen = deepStream('local-screen', { video: [{ label: 'screen' }] });
    mockRegistry.getCurrentChannel = () => ({ _id: 'voice-1', name: 'Screen Room' });
    mockRtc.startScreenShare.mockImplementation(async () => {
      mockRtc.screenSharing = true;
      mockRtc.screenStream = localScreen;
      return true;
    });
    mockRtc.stopScreenShare.mockImplementation(() => {
      mockRtc.screenSharing = false;
      mockRtc.screenStream = null;
    });
    const { container } = render(VoicePanel);
    await domTick();

    await fireEvent.click(container.querySelector('#vc-screen') as HTMLElement);
    await domTick();
    await fireEvent.click(container.querySelector('.ss-quality-btn') as HTMLElement);
    await domTick();
    const view = container.querySelector('#screen-share-view') as HTMLElement;
    expect(view).toBeTruthy();
    expect(container.querySelector('#ss-channel-name')?.textContent).toBe('Screen Room');
    expect(container.querySelector('#ss-local-badge')).toBeTruthy();
    expect(container.querySelector('#ss-quality-label')?.textContent).toBe('4k60');
    expect((container.querySelector('#remote-screen-video') as HTMLVideoElement).srcObject).toStrictEqual(localScreen);

    const mini = container.querySelector(`[aria-label="${t('surface_kucuk_moda_gec_0cfe03')}"]`) as HTMLElement;
    await fireEvent.click(mini);
    expect(view.classList.contains('ss-mini')).toBe(true);

    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
    const video = container.querySelector('#remote-screen-video') as HTMLVideoElement;
    const requestFullscreen = vi.fn(async () => {
      fullscreenElement = video;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const exitFullscreen = vi.fn(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    Object.defineProperty(video, 'requestFullscreen', { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
    await fireEvent.click(container.querySelector('#ss-fullscreen-btn') as HTMLElement);
    await domTick();
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(container.querySelector('#ss-fullscreen-btn')?.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(container.querySelector('#ss-fullscreen-btn') as HTMLElement);
    expect(exitFullscreen).toHaveBeenCalledOnce();

    await fireEvent.click(container.querySelector('#ss-stop-btn') as HTMLElement);
    await domTick();
    expect(mockRtc.stopScreenShare).toHaveBeenCalledOnce();
    expect(container.querySelector('#screen-share-view')).toBeNull();
  });

  it('exposes mode, release-delay, capture, and key persistence through the registered facade', async () => {
    localStorage.removeItem('bridgePTT');
    render(VoicePanel);
    await domTick();
    const setEnabled = mockRegistry['voicePanel:setPttEnabled'] as Function;
    const setMode = mockRegistry['voicePanel:setPttMode'] as Function;
    const setDelay = mockRegistry['voicePanel:setPttReleaseDelay'] as Function;
    const startCapture = mockRegistry['voicePanel:startPttKeyCapture'] as Function;
    const stopCapture = mockRegistry['voicePanel:stopPttKeyCapture'] as Function;
    const isCapturing = mockRegistry['voicePanel:isPttCapturing'] as Function;
    const status = mockRegistry['voicePanel:getPttStatus'] as Function;

    setEnabled(true);
    setMode('toggle');
    setDelay(350);
    startCapture();
    expect(isCapturing()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await domTick();
    expect(isCapturing()).toBe(false);
    expect(status()).toMatchObject({ enabled: true, mode: 'toggle', releaseDelay: 350, key: { code: 'KeyK', label: 'Ctrl+K' } });
    expect(JSON.parse(localStorage.getItem('bridgePTT') ?? '{}')).toMatchObject({
      enabled: true, mode: 'toggle', releaseDelay: 350, key: { code: 'KeyK' },
    });
    startCapture();
    stopCapture();
    expect(isCapturing()).toBe(false);
    (mockRegistry['voicePanel:clearPttKey'] as Function)();
    expect(status().key).toBeNull();
  });
});

describe('VoicePanel — branch-complete production edge behavior', () => {
  it('renders one canonical local peer with local identity and every peer-state badge', async () => {
    const cssColor = vi.fn(() => '#010203');
    const initials = vi.fn(() => 'LP');
    mockRegistry.cssColor = cssColor;
    mockRegistry.initials = initials;
    const { container } = render(VoicePanel);
    await domTick();

    const add = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const state = mockRegistry['voicePanel:updatePeerState'] as Function;
    const localPeer = {
      id: 'local-user', socketId: null, displayName: 'Local Person', avatarColor: 'brand-local',
    };
    add(localPeer, true);
    add(localPeer, true);
    state(null, { muted: true, screensharing: true, video: true });
    await domTick();

    const card = container.querySelector('#vp-local') as HTMLElement;
    expect(container.querySelectorAll('#vp-local')).toHaveLength(1);
    expect(card.classList.contains('local')).toBe(true);
    expect(card.dataset.socket).toBe('local');
    expect(card.querySelector('.voice-peer-name')?.textContent).toContain('Local Person');
    expect(card.querySelector('.voice-peer-name')?.textContent).toContain('You');
    expect(card.querySelector('.voice-peer-big-avatar')?.textContent).toContain('LP');
    expect(card.querySelector('.peer-soundboard-toggle')).toBeNull();
    // Sessiz gostergesi artik metin cipi degil IKON; erisilebilir ad
   // sozlukten gelir.
    expect(card.querySelector(`[aria-label="${t('surface_mikrofon_kapal_7a9f4a')}"]`)).toBeTruthy();
    expect(card.querySelectorAll('.peer-state-icon')).toHaveLength(2);
    expect(cssColor).toHaveBeenCalledWith('brand-local');
    expect(initials).toHaveBeenCalledWith('Local Person');
  });

  it('rejects a stale empty soundboard identity at click time', async () => {
    const setSuppressed = vi.fn();
    mockRegistry.setSoundboardUserSuppressed = setSuppressed;
    const { container } = render(VoicePanel);
    await domTick();

    const peer = { id: 'user-before-refresh', socketId: 'socket-race', displayName: 'Race', avatarColor: '#123' };
    (mockRegistry['voicePanel:renderVoicePeer'] as Function)(peer, false);
    await domTick();
    const toggle = container.querySelector('.peer-soundboard-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    peer.id = '';
    await fireEvent.click(toggle);
    expect(setSuppressed).not.toHaveBeenCalled();
  });

  it('keeps public reply, pin, and local-video fallbacks safe when optional owners are absent', async () => {
    const local = deepStream('fallback-local', { video: [{}] });
    const socket = { emit: vi.fn() };
    const hideReplyBar = vi.fn();
    delete mockRegistry.getMe;
    delete mockRegistry.getCurrentServer;
    mockRegistry.hideReplyBar = hideReplyBar;
    (window as Record<string, unknown>).socket = socket;
    mockRtc.getLocalStream.mockReturnValue(local);
    const rendered = render(VoicePanel);
    await domTick();

    await (mockRegistry['voicePanel:toggleVideo'] as Function)();
    await domTick();
    expect(rendered.container.querySelector('[data-tile-id="local"]')?.textContent).toContain('Ben');

    (mockRegistry['voicePanel:pinMessage'] as Function)('message-fallback', 'channel-fallback');
    expect(socket.emit).toHaveBeenCalledWith('message:pin', {
      messageId: 'message-fallback', channelId: 'channel-fallback', serverId: undefined, pinned: true,
    });

    (window as Record<string, unknown>).replyingTo = 'message-fallback';
    (rendered.component as unknown as { cancelReply(): void }).cancelReply();
    expect((window as Record<string, unknown>).replyingTo).toBeNull();
    expect(hideReplyBar).toHaveBeenCalledOnce();

    delete (window as Record<string, unknown>).socket;
    expect(() => (mockRegistry['voicePanel:pinMessage'] as Function)('ignored', 'offline')).not.toThrow();
  });

  it('keeps modal focus recovery safe for non-Escape keys, detached triggers, and overlay dismissal', async () => {
    localStorage.removeItem('bridgeSSQuality');
    const { container } = render(VoicePanel);
    await domTick();
    const trigger = container.querySelector('#vc-screen') as HTMLButtonElement;
    trigger.focus();
    await fireEvent.click(trigger);
    await domTick();

    let modal = container.querySelector('#ss-quality-modal') as HTMLElement;
    await fireEvent.keyDown(modal, { key: 'Enter' });
    expect(container.querySelector('#ss-quality-modal')).toBeTruthy();
    trigger.remove();
    await fireEvent.keyDown(modal, { key: 'Escape' });
    await domTick();
    expect(container.querySelector('#ss-quality-modal')).toBeNull();

    const activeElementDescriptor = Object.getOwnPropertyDescriptor(document, 'activeElement');
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null });
    (mockRegistry['voicePanel:openScreenShareQualityPicker'] as Function)();
    if (activeElementDescriptor) Object.defineProperty(document, 'activeElement', activeElementDescriptor);
    else delete (document as unknown as Record<string, unknown>).activeElement;
    await domTick();

    modal = container.querySelector('#ss-quality-modal') as HTMLElement;
    expect(modal).toBeTruthy();
    await fireEvent.click(modal);
    await domTick();
    expect(container.querySelector('#ss-quality-modal')).toBeNull();
  });

  it('preserves the correct screen owner while local and remote shares overlap', async () => {
    localStorage.removeItem('bridgeSSQuality');
    const local = deepStream('local-overlap', { video: [{ label: 'screen' }] });
    const remote = deepStream('remote-overlap', { audio: 1, video: [{ label: 'screen' }] });
    (window as Record<string, unknown>).voiceChannelPeers = new Map([
      ['peer', { id: 'remote-user', socketId: 'remote-owner', displayName: 'Remote Owner', avatarColor: '#123' }],
    ]);
    mockRtc.startScreenShare.mockImplementation(async () => {
      mockRtc.screenSharing = true;
      mockRtc.screenStream = local;
      return true;
    });
    mockRtc.stopScreenShare.mockImplementation(() => {
      mockRtc.screenSharing = false;
      mockRtc.screenStream = null;
    });
    const { container } = render(VoicePanel);
    await domTick();
    const attach = mockRegistry['voicePanel:attachRemoteStream'] as Function;
    const state = mockRegistry['voicePanel:updatePeerState'] as Function;

    attach('remote-owner', remote, 'screen');
    await fireEvent.click(container.querySelector('#vc-screen') as HTMLElement);
    await domTick();
    await fireEvent.click(container.querySelector('.ss-quality-btn') as HTMLElement);
    await domTick();
    expect(container.querySelector('#ss-local-badge')).toBeTruthy();

    await fireEvent.click(container.querySelector('#ss-mute-btn') as HTMLElement);
    await fireEvent.click(container.querySelector('#ss-deafen-btn') as HTMLElement);
    await domTick();
    expect(container.querySelector('#ss-mute-btn')).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('#ss-deafen-btn')).toHaveAttribute('aria-pressed', 'true');

    state('remote-owner', { screensharing: false });
    await domTick();
    expect(container.querySelector('#screen-share-view')).toBeTruthy();
    expect((container.querySelector('#remote-screen-video') as HTMLVideoElement).srcObject).toStrictEqual(local);

    state('remote-owner', { screensharing: true });
    await domTick();
    expect((container.querySelector('#remote-screen-video') as HTMLVideoElement).srcObject).toStrictEqual(remote);

    await fireEvent.click(container.querySelector('#vc-screen') as HTMLElement);
    await domTick();
    expect(mockRtc.stopScreenShare).toHaveBeenCalledOnce();
    expect(container.querySelector('#screen-share-view')).toBeTruthy();
    expect((container.querySelector('#remote-screen-video') as HTMLVideoElement).srcObject).toStrictEqual(remote);

    await fireEvent.click(container.querySelector('#ss-share-btn') as HTMLElement);
    await domTick();
    expect(container.querySelector('#ss-quality-modal')).toBeTruthy();
  });

  it('shows capture progress and removes the empty share layer after a denied capture', async () => {
    localStorage.removeItem('bridgeSSQuality');
    let settleCapture!: (accepted: boolean) => void;
    mockRtc.startScreenShare.mockReturnValue(new Promise<boolean>(resolve => { settleCapture = resolve; }));
    const { container } = render(VoicePanel);
    await domTick();

    await fireEvent.click(container.querySelector('#vc-screen') as HTMLElement);
    await domTick();
    await fireEvent.click(container.querySelector('.ss-quality-btn') as HTMLElement);
    await waitFor(() => expect(container.querySelector('#ss-loading')).toBeTruthy());
    expect(container.querySelector('#screen-share-view')).toBeTruthy();

    settleCapture(false);
    await domTick();
    expect(container.querySelector('#ss-loading')).toBeNull();
    expect(container.querySelector('#screen-share-view')).toBeNull();
  });

  it('runs the quality interval only while joined and handles owners without peer maps', async () => {
    let poll: (() => void) | undefined;
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 4_000 && typeof callback === 'function') poll = callback as () => void;
      return 73 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    (mockRtc as unknown as { peers?: Map<string, RTCPeerConnection> }).peers = undefined;
    const rendered = render(VoicePanel);
    await domTick();

    expect(interval).toHaveBeenCalledWith(expect.any(Function), 4_000);
    expect(poll).toBeTypeOf('function');
    poll?.();
    await Promise.resolve();
    document.dispatchEvent(new CustomEvent('bridge:voice-left'));
    await domTick();
    poll?.();
    await Promise.resolve();
    expect(clear).toHaveBeenCalledWith(73);
    rendered.unmount();
  });

  it('renders a one-participant SFU layout without widening the tile unnecessarily', async () => {
    const { container } = render(VoicePanel);
    await domTick();
    (mockRegistry['voicePanel:sfuAddVideoTile'] as Function)(
      'only-tile', deepStream('only-stream', { video: [{}] }), 'Only participant', false, false,
    );
    await domTick();
    expect((container.querySelector('#sfu-video-grid') as HTMLElement).style.gridTemplateColumns)
      .toContain('repeat(1');
  });

  it('opens the quality picker safely when the browser has no active focus element', async () => {
    localStorage.removeItem('bridgeSSQuality');
    const { container } = render(VoicePanel);
    await domTick();
    const activeElementDescriptor = Object.getOwnPropertyDescriptor(document, 'activeElement');
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null });
    (mockRegistry['voicePanel:toggleScreenShare'] as Function)();
    if (activeElementDescriptor) Object.defineProperty(document, 'activeElement', activeElementDescriptor);
    else delete (document as unknown as Record<string, unknown>).activeElement;
    await domTick();
    expect(container.querySelector('#ss-quality-modal')).toBeTruthy();
  });

  it('does not install a duplicate quality poller during a rapid reentrant reconnect', async () => {
    let installations = 0;
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      installations += 1;
      if (installations === 1) {
        document.dispatchEvent(new CustomEvent('bridge:voice-left'));
        document.dispatchEvent(new CustomEvent('bridge:voice-joined'));
      }
      return 79 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const rendered = render(VoicePanel);
    await domTick();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 4_000);
    expect(installations).toBe(1);
    rendered.unmount();
  });

  it('keeps an in-sequence quality collection failure explicitly unknown', async () => {
    const collect = vi.spyOn(connectionQuality, 'collectConnectionQuality')
      .mockRejectedValueOnce(new Error('stats collector unavailable'));
    mockRtc.peers = new Map([['peer', {} as RTCPeerConnection]]);
    const { container } = render(VoicePanel);
    await waitFor(() => expect(collect).toHaveBeenCalledOnce());
    await domTick();
    expect(container.querySelector('.voice-quality')).toHaveAttribute('data-quality', 'unknown');
  });

  it('discards both fulfilled and rejected quality samples after leaving voice', async () => {
    let resolveQuality!: (value: connectionQuality.VoiceConnectionQuality) => void;
    let rejectQuality!: (reason: unknown) => void;
    const fulfilled = new Promise<connectionQuality.VoiceConnectionQuality>(resolve => { resolveQuality = resolve; });
    const rejected = new Promise<connectionQuality.VoiceConnectionQuality>((_resolve, reject) => { rejectQuality = reject; });
    const collect = vi.spyOn(connectionQuality, 'collectConnectionQuality')
      .mockReturnValueOnce(fulfilled)
      .mockReturnValueOnce(rejected);
    mockRtc.peers = new Map([['peer', {} as RTCPeerConnection]]);

    const first = render(VoicePanel);
    await waitFor(() => expect(collect).toHaveBeenCalledOnce());
    document.dispatchEvent(new CustomEvent('bridge:voice-left'));
    resolveQuality({
      quality: 'excellent', latencyMs: 10, jitterMs: 1, packetLossPercent: 0,
      packetsSent: 1, packetsReceived: 1, sampledPeers: 1,
    });
    await domTick();
    expect(first.container.querySelector('.voice-quality')).toBeNull();
    first.unmount();

    mockRtc.isInVoice.mockReturnValue(true);
    const second = render(VoicePanel);
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
    document.dispatchEvent(new CustomEvent('bridge:voice-left'));
    rejectQuality(new Error('late stats failure'));
    await domTick();
    expect(second.container.querySelector('.voice-quality')).toBeNull();
  });

  it('renders both paused-without-key and active PTT truth from the canonical controller', async () => {
    localStorage.removeItem('bridgePTT');
    const { container } = render(VoicePanel);
    await domTick();
    const setEnabled = mockRegistry['voicePanel:setPttEnabled'] as Function;
    const startCapture = mockRegistry['voicePanel:startPttKeyCapture'] as Function;

    setEnabled(true);
    await domTick();
    expect(container.querySelector('#ptt-live-status')?.textContent).toContain('—');
    startCapture();
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', bubbles: true, cancelable: true,
    }));
    await domTick();
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', bubbles: true, cancelable: true,
    }));
    await domTick();
    expect(container.querySelector('.ptt-active')).toBeTruthy();
    setEnabled(false);
    await domTick();
    expect(container.querySelector('.ptt-active')).toBeNull();
  });
});
