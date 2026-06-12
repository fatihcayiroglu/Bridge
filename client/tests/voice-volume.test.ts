// client/tests/voice-volume.test.ts — Sprint 52
// voice-volume.ts için unit testler
// Kapsam: applyVolume, openVolumePanel, preset butonlar, slider, kapatma

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(() => new Map()),
    call:     jest.fn(),
    has:      jest.fn(() => false),
  },
}), { virtual: true });

jest.mock('../js/core/utils', () => ({
  escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}), { virtual: true });

// ── AudioContext stub ──────────────────────────────────────────────────────────

const mockGainNode = {
  gain: { value: 1 },
  connect: jest.fn(),
};
const mockSource = { connect: jest.fn() };
const mockAudioCtx = {
  state: 'running',
  createMediaElementSource: jest.fn(() => mockSource),
  createGain: jest.fn(() => mockGainNode),
  destination: {},
};
global.AudioContext = jest.fn(() => mockAudioCtx);

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildDOM() {
  document.body.innerHTML = `
    <div class="voice-peer" data-socket="sock1" data-user-id="user1">
      <span class="peer-name">Ahmet</span>
    </div>
    <audio data-socket="sock1" volume="1"></audio>
  `;
}

function loadModule() {
  jest.resetModules();
  return require('../js/core/voice-volume');
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('applyVolume()', () => {
  beforeEach(() => buildDOM());

  test('data-socket\'e sahip audio elementinin volume\'ünü ayarlar', () => {
    const { BridgeVoiceVolume } = loadModule();
    const audio = document.querySelector('audio[data-socket="sock1"]');
    BridgeVoiceVolume.applyVolume('sock1', 80);
    expect(parseFloat(audio.volume)).toBeCloseTo(0.8);
  });

  test('100\'ün üzerinde değer 1\'e clamplanır', () => {
    const { BridgeVoiceVolume } = loadModule();
    const audio = document.querySelector('audio[data-socket="sock1"]');
    BridgeVoiceVolume.applyVolume('sock1', 150);
    expect(parseFloat(audio.volume)).toBeLessThanOrEqual(1);
  });

  test('gainNode varsa gain.value güncellenir', () => {
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.attachGain('sock1', document.querySelector('audio'));
    BridgeVoiceVolume.applyVolume('sock1', 50);
    expect(mockGainNode.gain.value).toBeCloseTo(0.5);
  });

  test('ses elementi yokken hata vermez', () => {
    const { BridgeVoiceVolume } = loadModule();
    expect(() => BridgeVoiceVolume.applyVolume('sock-yok', 50)).not.toThrow();
  });
});

describe('openVolumePanel()', () => {
  beforeEach(() => buildDOM());

  test('panel oluşturur', () => {
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', 'Ahmet');
    expect(document.getElementById('bvv-panel')).not.toBeNull();
  });

  test('panel başlığında kullanıcı adını escHtml ile gösterir', () => {
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', '<b>Hacker</b>');
    const panel = document.getElementById('bvv-panel');
    expect(panel.innerHTML).not.toContain('<b>Hacker</b>');
    expect(panel.innerHTML).toContain('&lt;b&gt;Hacker');
  });

  test('kapatma butonu panel\'i kaldırır', () => {
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', 'Ahmet');
    document.querySelector('[data-action="close"]').click();
    expect(document.getElementById('bvv-panel')).toBeNull();
  });

  test('önceki panel varsa önce kaldırılır', () => {
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', 'Ahmet');
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', 'Ahmet2');
    expect(document.querySelectorAll('#bvv-panel').length).toBe(1);
  });

  test('localStorage\'dan kaydedilmiş volume\'ü yükler', () => {
    localStorage.setItem('bridge-vol-user1', '75');
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', 'Ahmet');
    const slider = document.querySelector('.bvv-slider');
    expect(slider.value).toBe('75');
  });

  test('slider değişince volume güncellenir', () => {
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', 'Ahmet');
    const slider = document.querySelector('.bvv-slider');
    slider.value = '60';
    slider.dispatchEvent(new Event('input'));
    expect(localStorage.getItem('bridge-vol-user1')).toBe('60');
  });

  test('0% preset tıklandığında volume 0 olur', () => {
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', 'Ahmet');
    const muteBtn = document.querySelector('[data-vol="0"]');
    muteBtn.click();
    expect(localStorage.getItem('bridge-vol-user1')).toBe('0');
  });

  test('100% preset "Normal" seviyeye döndürür', () => {
    const { BridgeVoiceVolume } = loadModule();
    BridgeVoiceVolume.openVolumePanel('sock1', 'user1', 'Ahmet');
    const normalBtn = document.querySelector('[data-vol="100"]');
    normalBtn.click();
    const label = document.querySelector('.bvv-val');
    expect(label.textContent).toBe('100%');
  });
});

describe('BridgeRegistry.register', () => {
  test('modül yüklenince BridgeVoiceVolume register edilir', () => {
    const { BridgeRegistry } = require('../js/core/bridge-registry');
    loadModule();
    expect(BridgeRegistry.register).toHaveBeenCalledWith('BridgeVoiceVolume', expect.anything());
  });
});

describe('Contextmenu — voice peer', () => {
  beforeEach(() => buildDOM());

  test('voice-peer üzerinde contextmenu tetiklenince voice-ctx menüsü açılır', () => {
    loadModule();
    const peer = document.querySelector('.voice-peer');
    const evt = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 });
    peer.dispatchEvent(evt);
    expect(document.getElementById('voice-ctx')).not.toBeNull();
  });

  test('voice-peer dışında contextmenu tetiklenmez', () => {
    loadModule();
    const div = document.createElement('div');
    document.body.appendChild(div);
    div.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(document.getElementById('voice-ctx')).toBeNull();
  });

  test('volume menü öğesine tıklanınca menü kapanır', () => {
    loadModule();
    const peer = document.querySelector('.voice-peer');
    peer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const menuItem = document.querySelector('[data-action="volume"]');
    menuItem?.click();
    expect(document.getElementById('voice-ctx')).toBeNull();
  });
});
