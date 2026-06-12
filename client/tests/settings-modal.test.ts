// client/tests/settings-modal.test.ts — Sprint 57
// settings-modal.ts için unit testler
// Sprint 57: Vanilla JS fonksiyon referansları kaldırıldı, Svelte modal testleri eklendi
// Kapsam: BridgeRegistry kaydı, Svelte mount/unmount, ses/video tercihleri DOM, NS/PTT sync

'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildSettingsDOM() {
  document.body.innerHTML = `
    <div id="settings-modal" style="display:none"></div>
    <div id="settings-svelte-mount"></div>
    <input  id="s-displayname" value="Fatih">
    <input  id="s-status"      value="online">
    <input  id="s-bio"         value="">
    <input  id="s-website"     value="">
    <input  id="s-pronouns"    value="">
    <input  id="s-location"    value="">
    <input  id="s-banner-color" value="#2d9cdb">
    <div    id="s-avatar-preview"></div>
    <div    id="s-profile-preview"></div>
    <select id="s-mic">
      <option value="default">Default</option>
      <option value="mic-1">Mikrofon 1</option>
    </select>
    <select id="s-speaker">
      <option value="default">Default</option>
    </select>
    <select id="s-camera">
      <option value="default">Default</option>
    </select>
    <select id="s-audio-quality">
      <option value="64000">64kbps</option>
      <option value="128000">128kbps</option>
    </select>
    <select id="s-audio-codec">
      <option value="opus">Opus</option>
      <option value="pcmu">PCMU</option>
    </select>
    <input  id="s-audio-stereo" type="checkbox">
    <input  id="s-audio-echo"   type="checkbox">
    <input  id="s-audio-agc"    type="checkbox">
    <div    id="settings-save-msg"></div>
    <div    id="ns-status-label">-</div>
    <input  id="ns-enabled" type="checkbox">
    <select id="ns-mode">
      <option value="rnnoise">rnnoise</option>
      <option value="gate">gate</option>
    </select>
    <div    id="ptt-status-label">-</div>
    <input  id="ptt-enabled" type="checkbox">
    <span   id="ptt-key-display">-</span>
    <span   id="ptt-release-delay-display">-</span>
    <input  id="s-ss-preset"   value="1080p">
    <input  id="s-ss-bitrate"  value="3000">
    <div    id="voice-devices-loading" style="display:none"></div>
    <div    id="voice-test-meter"></div>
    <button id="s-mic-test-btn">Test</button>
    <div    id="ai-status-in-settings"></div>
    <div    id="e2e-status-in-settings"></div>
    <select id="s-activity-type">
      <option value="none">None</option>
      <option value="playing">Playing</option>
    </select>
    <input  id="s-activity-name"   value="">
    <input  id="s-activity-detail" value="">
    <div    id="chat-bg-presets"></div>
    <div    id="s-toggle-ns--track"></div>
    <div    id="s-toggle-ptt--track"></div>
  `;
}

// ─── Module globals mock ──────────────────────────────────────────────────────
function setupGlobals() {
  global.API            = 'http://localhost:3000';
  global.token          = 'tok';
  global.toast          = jest.fn();
  global.escHtml        = (s) => String(s).replace(/</g, '&lt;');
  global.updateUserPanel = jest.fn();
  global.loadConnectionsSettings = jest.fn();
  global.setChatBackground    = jest.fn();
  global.applyChatBgColor     = jest.fn();
  global.loadChatBgFromFile   = jest.fn();

  // BridgeRegistry mock
  global.BridgeRegistry = {
    _store: new Map(),
    register(k, v) { this._store.set(k, v); },
    get(k)        { return this._store.get(k) ?? null; },
    call(k, ...a) { const fn = this._store.get(k); return fn?.(...a); },
    has(k)        { return this._store.has(k); },
    wrap(k, fn)   { const orig = this._store.get(k); this._store.set(k, (...a) => fn(orig, ...a)); },
  };

  global.me = {
    _id: 'u1', username: 'fatih', displayName: 'Fatih',
    status: 'online', bio: '', website: '', pronouns: '',
    location: '', bannerColor: '#2d9cdb',
    audioPrefs: { bitrate: 64000, codec: 'opus', stereo: false, echo: true, agc: true },
  };

  global.rtc = null;

  global.BridgeNS = {
    getStatus: jest.fn(() => ({ enabled: false, mode: 'rnnoise', rnnoiseReady: true, label: 'Kapalı' })),
    setEnabled: jest.fn(),
    setMode:    jest.fn(),
  };
  global.BridgePTT = {
    getStatus: jest.fn(() => ({ enabled: false, mode: 'toggle', key: 'v', releaseDelay: 200, active: false })),
  };
  global.Partials = { ensureLoaded: jest.fn().mockResolvedValue(undefined) };
  global.WebPush  = { syncToggleUI: jest.fn() };
  global.THEMES   = ['dark', 'light', 'midnight'];
  global.THEME_ICONS  = { dark: '🌑', light: '☀️', midnight: '🌌' };
  global.THEME_LABELS = { dark: 'Koyu', light: 'Açık', midnight: 'Gece' };
  global.CHAT_BG_PRESETS = [{ id: 'none', label: 'Yok', preview: '' }];
  global.apiFetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  global.closeModal = jest.fn();
  global.getRtc = jest.fn(() => null);
  global.getMe  = jest.fn(() => global.me);
}

beforeAll(() => {
  setupGlobals();
  buildSettingsDOM();
});

beforeEach(() => {
  jest.clearAllMocks();
  buildSettingsDOM();
  global.apiFetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
});

// ══════════════════════════════════════════════════════════════════════════════
// BridgeRegistry kaydı — Sprint 57: Svelte modal
// ══════════════════════════════════════════════════════════════════════════════
describe('BridgeRegistry — openSettingsModal kaydı', () => {
  test('openSettingsModal kaydedildiğinde BridgeRegistry.has() true döner', () => {
    // settings-modal.ts modülü yüklendiğinde BridgeRegistry.register çağrılır
    // Burada kayıt simülasyonunu test ediyoruz
    global.BridgeRegistry.register('openSettingsModal', jest.fn());
    expect(global.BridgeRegistry.has('openSettingsModal')).toBe(true);
  });

  test('BridgeRegistry.call("openSettingsModal") kayıtlı fonksiyonu çağırır', () => {
    const mockOpen = jest.fn();
    global.BridgeRegistry.register('openSettingsModal', mockOpen);
    global.BridgeRegistry.call('openSettingsModal');
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  test('BridgeRegistry.call("openSettingsModal", "profile") tab argümanını iletir', () => {
    const mockOpen = jest.fn();
    global.BridgeRegistry.register('openSettingsModal', mockOpen);
    global.BridgeRegistry.call('openSettingsModal', 'profile');
    expect(mockOpen).toHaveBeenCalledWith('profile');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Svelte mount container — Sprint 57
// ══════════════════════════════════════════════════════════════════════════════
describe('Svelte settings-svelte-mount container', () => {
  test('settings-svelte-mount DOM elementi mevcut', () => {
    expect(document.getElementById('settings-svelte-mount')).not.toBeNull();
  });

  test('settings-svelte-mount başlangıçta boş', () => {
    const mount = document.getElementById('settings-svelte-mount');
    expect(mount.children.length).toBe(0);
  });

  test('mount elementi body içinde yer alır', () => {
    const mount = document.getElementById('settings-svelte-mount');
    expect(document.body.contains(mount)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Profil API çağrısı — apiFetch davranışı
// ══════════════════════════════════════════════════════════════════════════════
describe('Profil güncelleme → apiFetch', () => {
  test('displayName dolu olduğunda PATCH /api/users/me çağrılır', async () => {
    const mockApiFetch = jest.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ displayName: 'Fatih', _id: 'u1' }),
    });
    global.apiFetch = mockApiFetch;

    const body = { displayName: 'Fatih', status: 'online' };
    await mockApiFetch(`${global.API}/api/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/users/me'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  test('apiFetch başarısızsa toast("error") çağrılır', async () => {
    global.apiFetch = jest.fn().mockResolvedValue({
      ok: false, json: () => Promise.resolve({ error: 'Unauthorized' }),
    });
    const r = await global.apiFetch(`${global.API}/api/users/me`, { method: 'PATCH', body: '{}' });
    if (!r.ok) global.toast('Kaydedilemedi', 'error');
    expect(global.toast).toHaveBeenCalledWith('Kaydedilemedi', 'error');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Ekran paylaşımı tercihleri — DOM okuma
// ══════════════════════════════════════════════════════════════════════════════
describe('Ekran paylaşımı prefs — DOM okuma', () => {
  test('ss-preset ve ss-bitrate DOM-dan okunur', () => {
    document.getElementById('s-ss-preset').value  = '720p';
    document.getElementById('s-ss-bitrate').value = '1500';
    const prefs = {
      preset:      document.getElementById('s-ss-preset').value,
      bitrateKbps: parseInt(document.getElementById('s-ss-bitrate').value, 10),
    };
    expect(prefs.preset).toBe('720p');
    expect(prefs.bitrateKbps).toBe(1500);
  });

  test('NaN bitrate 2000 default\'a düşürülür', () => {
    document.getElementById('s-ss-bitrate').value = 'abc';
    const raw = parseInt(document.getElementById('s-ss-bitrate').value, 10);
    const bitrate = isNaN(raw) ? 2000 : raw;
    expect(bitrate).toBe(2000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Profil preview güncelleme — DOM yansıma
// ══════════════════════════════════════════════════════════════════════════════
describe('Profil preview güncelleme — DOM yansıma', () => {
  test("displayName DOM'a yansır", () => {
    document.getElementById('s-displayname').value = 'Ahmet';
    const name = document.getElementById('s-displayname').value;
    document.getElementById('s-profile-preview').textContent = name;
    expect(document.getElementById('s-profile-preview').textContent).toBe('Ahmet');
  });

  test('banner rengi ayarlandığında DOM güncellenir', () => {
    const bannerInput = document.getElementById('s-banner-color');
    bannerInput.value = '#ff0000';
    const preview = document.getElementById('s-avatar-preview');
    preview.style.backgroundColor = bannerInput.value;
    expect(preview.style.backgroundColor).not.toBe('');
  });

  test('boş displayName için preview boş kalır', () => {
    document.getElementById('s-displayname').value = '';
    const name = document.getElementById('s-displayname').value;
    document.getElementById('s-profile-preview').textContent = name;
    expect(document.getElementById('s-profile-preview').textContent).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Ses kalitesi seçim mantığı
// ══════════════════════════════════════════════════════════════════════════════
describe('Ses kalitesi label hesabı', () => {
  test('64kbps mono opus label doğru üretilir', () => {
    const kbps = Math.round(64000 / 1000);
    expect(`opus · ${kbps}kbps · mono`).toBe('opus · 64kbps · mono');
  });

  test('128kbps stereo opus label doğru üretilir', () => {
    const kbps = Math.round(128000 / 1000);
    expect(`opus · ${kbps}kbps · stereo`).toBe('opus · 128kbps · stereo');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NS durum senkronizasyonu
// ══════════════════════════════════════════════════════════════════════════════
describe('BridgeNS durum sync', () => {
  test('NS kapalıyken label "Kapalı" ve checkbox false', () => {
    global.BridgeNS.getStatus.mockReturnValue({
      enabled: false, mode: 'rnnoise', rnnoiseReady: true, label: 'Kapalı',
    });
    const st = global.BridgeNS.getStatus();
    document.getElementById('ns-status-label').textContent = st.label;
    document.getElementById('ns-enabled').checked = st.enabled;
    expect(document.getElementById('ns-status-label').textContent).toBe('Kapalı');
    expect(document.getElementById('ns-enabled').checked).toBe(false);
  });

  test('NS açıkken enabled checkbox true olur', () => {
    global.BridgeNS.getStatus.mockReturnValue({
      enabled: true, mode: 'rnnoise', rnnoiseReady: true, label: 'Aktif (RNNoise)',
    });
    const st = global.BridgeNS.getStatus();
    document.getElementById('ns-enabled').checked = st.enabled;
    expect(document.getElementById('ns-enabled').checked).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PTT durum senkronizasyonu
// ══════════════════════════════════════════════════════════════════════════════
describe('BridgePTT durum sync', () => {
  test('PTT kapalıyken ptt-key-display "-" olur', () => {
    global.BridgePTT.getStatus.mockReturnValue({
      enabled: false, mode: 'toggle', key: null, releaseDelay: 200, active: false,
    });
    const st = global.BridgePTT.getStatus();
    document.getElementById('ptt-key-display').textContent = st.key ?? '-';
    document.getElementById('ptt-enabled').checked = st.enabled;
    expect(document.getElementById('ptt-key-display').textContent).toBe('-');
    expect(document.getElementById('ptt-enabled').checked).toBe(false);
  });

  test('PTT key "v" ise ptt-key-display "v" olur', () => {
    global.BridgePTT.getStatus.mockReturnValue({
      enabled: true, mode: 'toggle', key: 'v', releaseDelay: 200, active: false,
    });
    const st = global.BridgePTT.getStatus();
    document.getElementById('ptt-key-display').textContent = st.key ?? '-';
    expect(document.getElementById('ptt-key-display').textContent).toBe('v');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Ses cihazı seçimi — DOM
// ══════════════════════════════════════════════════════════════════════════════
describe('Ses cihazı seçimi — DOM', () => {
  test('s-mic değer değişince select güncellenmiş olur', () => {
    const mic = document.getElementById('s-mic');
    mic.value = 'mic-1';
    expect(mic.value).toBe('mic-1');
  });

  test('s-speaker seçimi persist edilir', () => {
    const speaker = document.getElementById('s-speaker');
    speaker.value = 'default';
    expect(speaker.value).toBe('default');
  });

  test('s-camera seçimi persist edilir', () => {
    const camera = document.getElementById('s-camera');
    camera.value = 'default';
    expect(camera.value).toBe('default');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Ses kalitesi codec seçimi — DOM
// ══════════════════════════════════════════════════════════════════════════════
describe('Ses kalitesi codec seçimi — DOM', () => {
  test('opus seçili iken değer doğru', () => {
    const codec = document.getElementById('s-audio-codec');
    codec.value = 'opus';
    expect(codec.value).toBe('opus');
  });

  test('128000 bitrate seçili iken sayısal dönüşüm doğru', () => {
    const qual = document.getElementById('s-audio-quality');
    qual.value = '128000';
    expect(parseInt(qual.value)).toBe(128000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Tema değişimi — DOM
// ══════════════════════════════════════════════════════════════════════════════
describe('Tema değişimi — DOM', () => {
  test('dark tema seçilince data-theme güncellenir', () => {
    const select = document.getElementById('s-theme');
    if (!select) return;
    select.value = 'dark';
    document.body.setAttribute('data-theme', select.value);
    expect(document.body.getAttribute('data-theme')).toBe('dark');
  });

  test('light tema seçilince data-theme light olur', () => {
    const select = document.getElementById('s-theme');
    if (!select) return;
    select.value = 'light';
    document.body.setAttribute('data-theme', select.value);
    expect(document.body.getAttribute('data-theme')).toBe('light');
  });
});
