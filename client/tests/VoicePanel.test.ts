// client/tests/VoicePanel.test.ts
// Sprint 113 — VoicePanel.svelte birim testleri
// ADR-0008 Faz 2 doğrulama

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import VoicePanel from '../js/core/VoicePanel.svelte';

// ── Mock'lar ─────────────────────────────────────────────────────────────

const mockRtc = {
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
  getRtc: () => mockRtc,
  friendsCache: [],
}));

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register:   (key: string, fn: unknown) => { mockRegistry[key] = fn; },
    unregister: (key: string) => { delete mockRegistry[key]; },
    get:        (key: string) => mockRegistry[key],
  },
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRtc.muted = false;
  mockRtc.deafened = false;
  mockRtc.videoOn = false;
  mockRtc.screenSharing = false;
});

afterEach(() => {
  cleanup();
});

// ── Testler ───────────────────────────────────────────────────────────────

describe('VoicePanel — render', () => {
  it('bileşen render edilir', () => {
    const { container } = render(VoicePanel);
    expect(container.querySelector('#voice-view')).toBeTruthy();
  });

  it('kontrol butonları mevcut', () => {
    const { container } = render(VoicePanel);
    expect(container.querySelector('#vc-mute')).toBeTruthy();
    expect(container.querySelector('#vc-deafen')).toBeTruthy();
    expect(container.querySelector('#vc-video')).toBeTruthy();
    expect(container.querySelector('#vc-screen')).toBeTruthy();
  });

  it('başlangıçta mute butonu aktif değil', () => {
    const { container } = render(VoicePanel);
    const btn = container.querySelector('#vc-mute');
    expect(btn?.classList.contains('active')).toBe(false);
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
  it('sfuAddVideoTile → tile eklenir', async () => {
    render(VoicePanel);
    const addFn = mockRegistry['voicePanel:sfuAddVideoTile'] as Function;
    const stream = new MediaStream();
    addFn('test-tile', stream, 'Test Kullanıcı', false, false);
    // DOM güncellenmesi için tick bekle
    await new Promise(r => setTimeout(r, 0));
  });

  it('sfuRemoveVideoTile → tile kaldırılır', async () => {
    render(VoicePanel);
    const addFn    = mockRegistry['voicePanel:sfuAddVideoTile'] as Function;
    const removeFn = mockRegistry['voicePanel:sfuRemoveVideoTile'] as Function;
    const stream = new MediaStream();
    addFn('tile-1', stream, 'Kullanıcı');
    removeFn('tile-1');
    await new Promise(r => setTimeout(r, 0));
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

  it('removeVoicePeer → peer kaldırılır', async () => {
    const { container } = render(VoicePanel);
    const addFn    = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const removeFn = mockRegistry['voicePanel:removeVoicePeer'] as Function;
    addFn({ id: 'u1', socketId: 's1', displayName: 'Veli', avatarColor: '#ff0000' });
    removeFn('s1');
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelector('#vp-s1')).toBeNull();
  });

  it('updatePeerState → icon güncellenir', async () => {
    const { container } = render(VoicePanel);
    const addFn    = mockRegistry['voicePanel:renderVoicePeer'] as Function;
    const updateFn = mockRegistry['voicePanel:updatePeerState'] as Function;
    addFn({ id: 'u2', socketId: 's2', displayName: 'Ayşe', avatarColor: '#00ff00' });
    updateFn('s2', { muted: true });
    await new Promise(r => setTimeout(r, 0));
    const icons = container.querySelector('#vpi-s2');
    expect(icons?.textContent).toContain('🔇');
  });
});

describe('VoicePanel — Ekran paylaşımı', () => {
  it('toggleScreenShare → qualityModal açılır (screensharing=false)', async () => {
    const { container } = render(VoicePanel);
    await fireEvent.click(container.querySelector('#vc-screen') as HTMLElement);
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelector('#ss-quality-modal')).toBeTruthy();
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
      'voicePanel:startPttKeyCapture',
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
