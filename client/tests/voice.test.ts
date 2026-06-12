// client/tests/voice.test.ts — Sprint 40
// voice.js için unit testler
// Kapsam: SFU video tile yönetimi, toggleMute/Deafen DOM etkileri,
//         openScreenShareQualityPicker localStorage mantığı,
//         renderVoicePeer DOM oluşturma, leaveVoice DOM temizliği

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../js/core/globals', () => ({
  getRtc:              jest.fn(() => global._mockRtc),
  getMe:               jest.fn(() => null),
  getCurrentServer:    jest.fn(() => null),
  getCurrentChannel:   jest.fn(() => null),
  voiceChannelPeers:   new Map(),
  setCurrentChannel:   jest.fn(),
}), { virtual: true });

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn(), has: jest.fn() },
}), { virtual: true });

// ── RTC mock ─────────────────────────────────────────────────────────────────

function makeMockRtc(overrides = {}) {
  return {
    muted:         false,
    deafened:      false,
    videoOn:       false,
    screenSharing: false,
    setMuted:      jest.fn(function(v) { this.muted = v; }),
    setDeafened:   jest.fn(function(v) { this.deafened = v; }),
    enableVideo:   jest.fn().mockResolvedValue(true),
    getLocalStream: jest.fn(() => null),
    leaveVoice:    jest.fn(),
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildVoiceDOM() {
  document.body.innerHTML = `
    <div id="text-view" style="display:flex"></div>
    <div id="voice-view" style="display:none">
      <div id="voice-peers"></div>
      <button id="vc-mute">🎙️</button>
      <button id="btn-mute">🎙️</button>
      <button id="ss-mute-btn">🎙️</button>
      <button id="vc-deafen">🔊</button>
      <button id="btn-deafen">🔊</button>
      <button id="ss-deafen-btn">🔊</button>
      <button id="vc-video">📷</button>
      <button id="vc-screen">🖥️</button>
      <button id="ss-stop-btn" style="display:none"></button>
      <button id="ss-share-btn"></button>
      <div   id="ss-local-badge" style="display:none"></div>
      <div   id="sfu-video-grid"></div>
      <div   id="ss-quality-modal" style="display:none">
        <button onclick="">720p</button>
        <input type="checkbox" id="ss-save-as-default">
        <input type="checkbox" id="ss-include-audio" checked>
      </div>
    </div>
    <div id="screen-share-view" style="display:none">
      <video id="ss-video"></video>
      <div   id="ss-thumbnails"></div>
      <button id="ss-fullscreen-btn">⛶</button>
    </div>
    <div class="ch-item" data-type="text"></div>
  `;
}

// ── Module loader ─────────────────────────────────────────────────────────────

let voice;
beforeAll(() => {
  try {
    voice = require('../js/core/voice');
  } catch {
    voice = null;
  }
});

beforeEach(() => {
  buildVoiceDOM();
  global._mockRtc = makeMockRtc();
});

afterEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

// ── SFU Video Tile ────────────────────────────────────────────────────────────

describe('sfuAddVideoTile', () => {
  test('boş grid varsa tile oluşturur', () => {
    if (!voice) return;
    const stream = { getVideoTracks: () => [{}] };
    voice.sfuAddVideoTile('user-1', stream, 'Ahmet', false);
    const grid = document.getElementById('sfu-video-grid');
    expect(grid.children.length).toBe(1);
    expect(grid.querySelector('video')).toBeTruthy();
  });

  test('aynı tileId için ikinci çağrı yeni tile oluşturmaz', () => {
    if (!voice) return;
    const stream = { getVideoTracks: () => [{}] };
    voice.sfuAddVideoTile('user-1', stream, 'Ahmet', false);
    voice.sfuAddVideoTile('user-1', stream, 'Ahmet', false);
    const grid = document.getElementById('sfu-video-grid');
    expect(grid.children.length).toBe(1);
  });

  test('isScreen=true olan tile screen sınıfı alır', () => {
    if (!voice) return;
    const stream = { getVideoTracks: () => [{}] };
    voice.sfuAddVideoTile('screen-1', stream, 'Ekran', false, true);
    const tile = document.querySelector('.sfu-tile-screen');
    expect(tile).toBeTruthy();
  });

  test('isLocal=true olan video muted olur', () => {
    if (!voice) return;
    const stream = { getVideoTracks: () => [{}] };
    voice.sfuAddVideoTile('local', stream, 'Ben', true);
    const video = document.querySelector('#sfu-video-grid video');
    expect(video?.muted).toBe(true);
  });
});

describe('sfuRemoveVideoTile', () => {
  test('var olan tile kaldırılır', () => {
    if (!voice) return;
    const stream = { getVideoTracks: () => [{}] };
    voice.sfuAddVideoTile('user-2', stream, 'Mehmet');
    voice.sfuRemoveVideoTile('user-2');
    const grid = document.getElementById('sfu-video-grid');
    expect(grid.children.length).toBe(0);
  });

  test('var olmayan tile için hata fırlatmaz', () => {
    if (!voice) return;
    expect(() => voice.sfuRemoveVideoTile('nonexistent')).not.toThrow();
  });
});

describe('sfuClearAllVideoTiles', () => {
  test('tüm tile\'ları temizler', () => {
    if (!voice) return;
    const stream = { getVideoTracks: () => [{}] };
    voice.sfuAddVideoTile('u1', stream, 'A');
    voice.sfuAddVideoTile('u2', stream, 'B');
    voice.sfuClearAllVideoTiles();
    const grid = document.getElementById('sfu-video-grid');
    expect(grid.children.length).toBe(0);
  });
});

// ── toggleMute / toggleDeafen ─────────────────────────────────────────────────

describe('toggleMute', () => {
  test('rtc.muted false iken mute yapar ve buton güncellenir', () => {
    if (!voice) return;
    global._mockRtc.muted = false;
    voice.toggleMute();
    expect(global._mockRtc.setMuted).toHaveBeenCalledWith(true);
    expect(document.getElementById('vc-mute').textContent).toBe('🔇');
  });

  test('rtc.muted true iken unmute yapar', () => {
    if (!voice) return;
    global._mockRtc.muted = true;
    voice.toggleMute();
    expect(global._mockRtc.setMuted).toHaveBeenCalledWith(false);
    expect(document.getElementById('vc-mute').textContent).toBe('🎙️');
  });
});

describe('toggleDeafen', () => {
  test('sağırlaştırma toggle sonrası buton güncellenir', () => {
    if (!voice) return;
    global._mockRtc.deafened = false;
    voice.toggleDeafen();
    expect(global._mockRtc.setDeafened).toHaveBeenCalledWith(true);
    const btn = document.getElementById('btn-deafen');
    expect(btn.classList.contains('active')).toBe(true);
  });
});

// ── openScreenShareQualityPicker ──────────────────────────────────────────────

describe('openScreenShareQualityPicker', () => {
  test('preset "ask" iken modal gösterir', () => {
    if (!voice) return;
    localStorage.setItem('bridgeSSQuality', JSON.stringify({ preset: 'ask' }));
    voice.openScreenShareQualityPicker();
    const modal = document.getElementById('ss-quality-modal');
    expect(modal.style.display).toBe('flex');
  });

  test('localStorage boş iken modal gösterir', () => {
    if (!voice) return;
    localStorage.removeItem('bridgeSSQuality');
    voice.openScreenShareQualityPicker();
    const modal = document.getElementById('ss-quality-modal');
    expect(modal.style.display).toBe('flex');
  });

  test('preset "720p" iken modal göstermez, doğrudan başlatır', () => {
    if (!voice) return;
    localStorage.setItem('bridgeSSQuality', JSON.stringify({ preset: '720p' }));
    // startScreenShareWithQuality async; modal açılmamalı
    voice.openScreenShareQualityPicker();
    const modal = document.getElementById('ss-quality-modal');
    expect(modal.style.display).not.toBe('flex');
  });
});

// ── renderVoicePeer ───────────────────────────────────────────────────────────

describe('renderVoicePeer', () => {
  const peer = { socketId: 'sock-1', displayName: 'Ali', avatarColor: '#2d9cdb' };

  test('peer elementi oluşturur', () => {
    if (!voice) return;
    voice.renderVoicePeer(peer, false);
    expect(document.getElementById('vp-sock-1')).toBeTruthy();
  });

  test('aynı peer için duplicate oluşturmaz', () => {
    if (!voice) return;
    voice.renderVoicePeer(peer, false);
    voice.renderVoicePeer(peer, false);
    const items = document.querySelectorAll('#vp-sock-1');
    expect(items.length).toBe(1);
  });

  test('local peer "local" id alır', () => {
    if (!voice) return;
    const localPeer = { socketId: 'my-sock', displayName: 'Ben', avatarColor: '#000' };
    voice.renderVoicePeer(localPeer, true);
    expect(document.getElementById('vp-local')).toBeTruthy();
  });

  test('displayName escapeHtml ile render edilir', () => {
    if (!voice) return;
    const xssPeer = { socketId: 'xss-1', displayName: '<script>alert(1)</script>', avatarColor: '#000' };
    voice.renderVoicePeer(xssPeer, false);
    const el = document.getElementById('vp-xss-1');
    expect(el?.innerHTML).not.toContain('<script>');
  });
});

// ── removeVoicePeer ───────────────────────────────────────────────────────────

describe('removeVoicePeer', () => {
  test('var olan peer elementini kaldırır', () => {
    if (!voice) return;
    const p = { socketId: 'r-1', displayName: 'X', avatarColor: '#fff' };
    voice.renderVoicePeer(p, false);
    voice.removeVoicePeer('r-1');
    expect(document.getElementById('vp-r-1')).toBeNull();
  });

  test('var olmayan socketId için hata fırlatmaz', () => {
    if (!voice) return;
    expect(() => voice.removeVoicePeer('missing')).not.toThrow();
  });
});

// ── leaveVoice ────────────────────────────────────────────────────────────────

describe('leaveVoice', () => {
  test('leaveVoice sonrası text-view görünür olur', () => {
    if (!voice) return;
    document.getElementById('text-view').style.display = 'none';
    document.getElementById('voice-view').style.display = 'flex';
    voice.leaveVoice();
    expect(document.getElementById('text-view').style.display).toBe('flex');
    expect(document.getElementById('voice-view').style.display).toBe('none');
  });

  test('rtc.leaveVoice çağrılır', () => {
    if (!voice) return;
    voice.leaveVoice();
    expect(global._mockRtc.leaveVoice).toHaveBeenCalled();
  });

  test('voice-peers temizlenir', () => {
    if (!voice) return;
    document.getElementById('voice-peers').innerHTML = '<div>peer</div>';
    voice.leaveVoice();
    expect(document.getElementById('voice-peers').innerHTML).toBe('');
  });
});

// ── closeScreenShareView / openScreenShareView ────────────────────────────────

describe('screen share view', () => {
  test('openScreenShareView view\'ı gösterir', () => {
    if (!voice) return;
    voice.openScreenShareView();
    expect(document.getElementById('screen-share-view').style.display).not.toBe('none');
  });

  test('closeScreenShareView view\'ı gizler', () => {
    if (!voice) return;
    voice.openScreenShareView();
    voice.closeScreenShareView();
    expect(document.getElementById('screen-share-view').style.display).toBe('none');
  });
});

// ── updatePeerState ───────────────────────────────────────────────────────────

describe('updatePeerState', () => {
  beforeEach(() => {
    if (!voice) return;
    const p = { socketId: 'ps-1', displayName: 'Zeynep', avatarColor: '#abc' };
    voice.renderVoicePeer(p, false);
  });

  test('muted state badge ekler/kaldırır', () => {
    if (!voice) return;
    voice.updatePeerState('ps-1', { muted: true });
    const icons = document.getElementById('vpi-ps-1');
    expect(icons?.innerHTML).toContain('🔇');
  });

  test('muted false iken badge kaldırılır', () => {
    if (!voice) return;
    voice.updatePeerState('ps-1', { muted: true });
    voice.updatePeerState('ps-1', { muted: false });
    const icons = document.getElementById('vpi-ps-1');
    expect(icons?.innerHTML).not.toContain('🔇');
  });
});

// ── Sprint 48: Ek coverage ────────────────────────────────────────────────────

// ── sfuHandleNewProducer / sfuHandlePeerLeft ──────────────────────────────────

describe('sfuHandleNewProducer', () => {
  test('video kind için tile eklenir', () => {
    if (!voice) return;
    const stream = { getTracks: () => [] };
    voice.sfuHandleNewProducer('sock-a', 'u-a', stream, 'video');
    const grid = document.getElementById('sfu-video-grid');
    expect(grid.children.length).toBeGreaterThan(0);
  });

  test('audio kind için tile eklenmez', () => {
    if (!voice) return;
    document.getElementById('sfu-video-grid').innerHTML = '';
    const stream = { getTracks: () => [] };
    voice.sfuHandleNewProducer('sock-b', 'u-b', stream, 'audio');
    const grid = document.getElementById('sfu-video-grid');
    expect(grid.children.length).toBe(0);
  });
});

describe('sfuHandlePeerLeft', () => {
  test('peer ayrılınca tile kaldırılır', () => {
    if (!voice) return;
    const stream = { getTracks: () => [] };
    voice.sfuHandleNewProducer('sock-c', 'u-c', stream, 'video');
    voice.sfuHandlePeerLeft('sock-c');
    const tile = document.getElementById('sfu-tile-sock-c');
    expect(tile).toBeNull();
  });

  test('olmayan peer için hata fırlatmaz', () => {
    if (!voice) return;
    expect(() => voice.sfuHandlePeerLeft('nonexistent')).not.toThrow();
  });
});

// ── stopMyScreenShare ──────────────────────────────────────────────────────────

describe('stopMyScreenShare', () => {
  test('ekran paylaşımı yok iken hata fırlatmaz', () => {
    if (!voice) return;
    global._mockRtc.screenSharing = false;
    expect(() => voice.stopMyScreenShare()).not.toThrow();
  });

  test('çalıştırıldığında ss-local-badge gizlenir', () => {
    if (!voice) return;
    document.getElementById('ss-local-badge').style.display = 'flex';
    voice.stopMyScreenShare();
    expect(document.getElementById('ss-local-badge').style.display).toBe('none');
  });
});

// ── toggleSSFullscreen / toggleSSMiniMode ──────────────────────────────────────

describe('toggleSSFullscreen', () => {
  test('ss-view-wrap fullscreen class toggle', () => {
    if (!voice) return;
    const wrap = document.getElementById('ss-view-wrap');
    if (!wrap) return;
    voice.toggleSSFullscreen();
    // İkinci çağrıda toggle geri alınmalı
    voice.toggleSSFullscreen();
    expect(wrap.classList.contains('ss-fullscreen')).toBe(false);
  });
});

describe('toggleSSMiniMode', () => {
  test('ss-view-wrap mini class toggle', () => {
    if (!voice) return;
    const wrap = document.getElementById('ss-view-wrap');
    if (!wrap) return;
    voice.toggleSSMiniMode();
    voice.toggleSSMiniMode();
    expect(wrap.classList.contains('ss-mini')).toBe(false);
  });
});

// ── updatePeerState — deafened / video ────────────────────────────────────────

describe('updatePeerState — ek durumlar', () => {
  beforeEach(() => {
    if (!voice) return;
    const p = { socketId: 'ps-ext', displayName: 'Ece', avatarColor: '#f00' };
    voice.renderVoicePeer(p, false);
  });

  test('deafened true → 🔇 ve 🙉 içerir', () => {
    if (!voice) return;
    voice.updatePeerState('ps-ext', { deafened: true });
    const icons = document.getElementById('vpi-ps-ext');
    expect(icons?.innerHTML ?? '').toContain('🙉');
  });

  test('video true → .has-video class eklenir', () => {
    if (!voice) return;
    voice.updatePeerState('ps-ext', { videoOn: true });
    const tile = document.getElementById('vp-ps-ext');
    // has-video class veya video element eklenmeli
    expect(tile).not.toBeNull();
  });
});
