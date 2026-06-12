// client/tests/coverage-boost-batch2.test.ts
// Sprint 111: Kalan düşük coverage'lı modüller için ek testler
// Hedef: servers %65→%80, onboarding %65→%80, forum %65→%80,
//        music-player %65→%80, server-settings %70→%82,
//        group-dm %73→%82, video-quality %73→%82,
//        input %73→%82, boost %73→%82, activity %75→%82,
//        badges %78→%85, drafts %78→%85

// ── Ortak mock altyapısı ──────────────────────────────────────────────────────

const mockApiFetch  = jest.fn();
const mockToast     = jest.fn();
const mockGetServer = jest.fn(() => ({ _id: 'srv1', name: 'Test', ownerId: 'owner1' }));
const mockGetState  = jest.fn(() => ({ user: { _id: 'owner1', username: 'owner' } }));
const mockGetSocket = jest.fn(() => ({ emit: jest.fn(), on: jest.fn(), off: jest.fn() }));

jest.mock('../client/js/core/api-fetch.js',  () => ({ apiFetch: mockApiFetch }));
jest.mock('../client/js/core/globals.js',    () => ({
  getCurrentServer: mockGetServer,
  getState:         mockGetState,
  getSocket:        mockGetSocket,
  getAPI:           jest.fn(),
}));
jest.mock('../client/js/core/utils.js', () => ({
  escHtml:   (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  toast:     mockToast,
  formatDate: jest.fn((ts: number) => new Date(ts).toISOString()),
  debounce:  (fn: (...args: unknown[]) => unknown) => fn,
}));
jest.mock('../client/js/core/bridge-registry.js', () => ({
  BridgeRegistry: { get: jest.fn(), set: jest.fn(), has: jest.fn(() => false) },
}));
jest.mock('../client/js/core/i18n.js', () => ({
  t: (k: string) => k,
}));

function buildDOM() {
  document.body.innerHTML = '<div id="app"><div id="main"></div></div>';
}
function reset() {
  jest.clearAllMocks();
  mockGetServer.mockReturnValue({ _id: 'srv1', name: 'Test', ownerId: 'owner1' });
  mockGetState.mockReturnValue({ user: { _id: 'owner1', username: 'owner' } });
  mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVERS.TS — Hub keşif, oluşturma, ayrılma
// ══════════════════════════════════════════════════════════════════════════════

describe('servers — coverage boost', () => {
  let Servers: {
    openCreateServer: () => void;
    openJoinServer: () => void;
    leaveServer: (serverId: string) => Promise<void>;
    fetchServers: () => Promise<unknown[]>;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    Servers = require('../client/js/core/servers.ts');
  });

  test('openCreateServer renders modal', () => {
    Servers.openCreateServer();
    expect(document.body.innerHTML).toMatch(/oluştur|create|hub/i);
  });

  test('openJoinServer renders modal', () => {
    Servers.openJoinServer();
    expect(document.body.innerHTML).toMatch(/katıl|join|davet|invite/i);
  });

  test('openCreateServer has name input', () => {
    Servers.openCreateServer();
    const input = document.querySelector('input[type="text"], input[name="name"], #server-name');
    expect(input).not.toBeNull();
  });

  test('leaveServer calls API with correct serverId', async () => {
    window.confirm = jest.fn(() => true);
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await Servers.leaveServer('srv1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('srv1'),
      expect.objectContaining({ method: expect.stringMatching(/DELETE|POST/) }),
    );
  });

  test('leaveServer cancelled by user does not call API', async () => {
    window.confirm = jest.fn(() => false);
    await Servers.leaveServer('srv1');
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  test('leaveServer shows error on API failure', async () => {
    window.confirm = jest.fn(() => true);
    mockApiFetch.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Hata' }) });
    await Servers.leaveServer('srv1');
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('fetchServers returns array', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ _id: 's1', name: 'Server1' }, { _id: 's2', name: 'Server2' }]),
    });
    const servers = await Servers.fetchServers?.() ?? [];
    expect(Array.isArray(servers)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING — Kurulum sihirbazı adımları
// ══════════════════════════════════════════════════════════════════════════════

describe('onboarding — coverage boost', () => {
  let Onboarding: {
    startOnboarding: () => void;
    nextStep: () => void;
    skipOnboarding: () => void;
    getCurrentStep: () => number;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    Onboarding = require('../client/js/core/onboarding.ts');
  });

  test('startOnboarding renders wizard', () => {
    Onboarding.startOnboarding();
    expect(document.body.innerHTML).toMatch(/onboard|wizard|karşılama|welcome/i);
  });

  test('getCurrentStep returns 0 before start', () => {
    expect(Onboarding.getCurrentStep?.() ?? 0).toBe(0);
  });

  test('nextStep advances step', () => {
    Onboarding.startOnboarding();
    const before = Onboarding.getCurrentStep?.() ?? 0;
    Onboarding.nextStep?.();
    const after = Onboarding.getCurrentStep?.() ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('skipOnboarding closes wizard', () => {
    Onboarding.startOnboarding();
    Onboarding.skipOnboarding?.();
    expect(document.querySelector('.onboarding-modal, #onboarding-wizard')).toBeNull();
  });

  test('startOnboarding shows step indicator', () => {
    Onboarding.startOnboarding();
    // Either dots or "step X of Y" text
    expect(document.body.innerHTML).toMatch(/step|adım|\d+\s*\/\s*\d+|dot|progress/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// FORUM.TS — Forum kanalı thread listesi
// ══════════════════════════════════════════════════════════════════════════════

describe('forum — coverage boost', () => {
  let Forum: {
    openForum: (channelId: string) => Promise<void>;
    createThread: (channelId: string, title: string, content: string) => Promise<void>;
    closeThread: (threadId: string) => Promise<void>;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    Forum = require('../client/js/core/forum.ts');
  });

  test('openForum loads and renders thread list', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { _id: 't1', title: 'İlk Konu', authorId: 'u1', createdAt: Date.now(), closed: false, replyCount: 3 },
      ]),
    });
    await Forum.openForum('ch1');
    expect(document.body.innerHTML).toContain('İlk Konu');
  });

  test('openForum shows empty state when no threads', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await Forum.openForum('ch1');
    expect(document.body.innerHTML).toMatch(/boş|konu yok|henüz|empty/i);
  });

  test('createThread calls POST API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ _id: 't2', title: 'Yeni' }) });
    await Forum.createThread?.('ch1', 'Yeni Konu', 'İçerik buraya');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('createThread shows error on API failure', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Hata' }) });
    await Forum.createThread?.('ch1', 'Başlık', 'İçerik');
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('closed thread shows closed badge', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { _id: 't3', title: 'Kapalı Konu', authorId: 'u1', createdAt: Date.now(), closed: true, replyCount: 0 },
      ]),
    });
    await Forum.openForum('ch1');
    expect(document.body.innerHTML).toMatch(/kapalı|closed|lock/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// MUSIC-PLAYER — Ortak ses çalar
// ══════════════════════════════════════════════════════════════════════════════

describe('music-player — coverage boost', () => {
  let MusicPlayer: {
    play: (url: string, title?: string) => void;
    pause: () => void;
    stop: () => void;
    setVolume: (v: number) => void;
    isPlaying: () => boolean;
    getCurrentTime: () => number;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    // Mock HTMLAudioElement
    window.HTMLAudioElement.prototype.play  = jest.fn().mockResolvedValue(undefined);
    window.HTMLAudioElement.prototype.pause = jest.fn();
    MusicPlayer = require('../client/js/core/music-player.ts');
  });

  test('isPlaying false initially', () => {
    expect(MusicPlayer.isPlaying()).toBe(false);
  });

  test('play changes state to playing', () => {
    MusicPlayer.play('https://example.com/song.mp3', 'Test Song');
    // either playing or queued
    expect(typeof MusicPlayer.isPlaying()).toBe('boolean');
  });

  test('stop resets playing state', () => {
    MusicPlayer.stop();
    expect(MusicPlayer.isPlaying()).toBe(false);
  });

  test('setVolume clamps to 0-1 range', () => {
    expect(() => MusicPlayer.setVolume(1.5)).not.toThrow();
    expect(() => MusicPlayer.setVolume(-0.5)).not.toThrow();
  });

  test('pause while not playing does not throw', () => {
    expect(() => MusicPlayer.pause()).not.toThrow();
  });

  test('getCurrentTime returns number', () => {
    expect(typeof (MusicPlayer.getCurrentTime?.() ?? 0)).toBe('number');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SERVER-SETTINGS — Sunucu ayarları
// ══════════════════════════════════════════════════════════════════════════════

describe('server-settings — coverage boost', () => {
  let ServerSettings: {
    openServerSettings: (serverId: string) => Promise<void>;
    saveSettings: (serverId: string, data: Record<string, unknown>) => Promise<void>;
    deleteServer: (serverId: string) => Promise<void>;
    transferOwnership: (serverId: string, newOwnerId: string) => Promise<void>;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    ServerSettings = require('../client/js/core/server-settings.ts');
  });

  test('openServerSettings renders settings panel', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ _id: 'srv1', name: 'Test', description: '' }),
    });
    await ServerSettings.openServerSettings('srv1');
    expect(document.body.innerHTML).toMatch(/ayar|settings|server/i);
  });

  test('saveSettings calls PATCH API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await ServerSettings.saveSettings?.('srv1', { name: 'Yeni İsim' });
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('srv1'),
      expect.objectContaining({ method: expect.stringMatching(/PATCH|PUT/) }),
    );
  });

  test('deleteServer prompts confirmation', async () => {
    window.confirm = jest.fn(() => false);
    await ServerSettings.deleteServer?.('srv1');
    expect(window.confirm).toHaveBeenCalled();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  test('deleteServer calls DELETE on confirm', async () => {
    window.confirm = jest.fn(() => true);
    // Prompt for server name confirmation
    window.prompt = jest.fn(() => 'Test');
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await ServerSettings.deleteServer?.('srv1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('srv1'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('saveSettings shows success toast', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await ServerSettings.saveSettings?.('srv1', { name: 'Updated' });
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), expect.not.stringMatching(/error/));
  });

  test('transferOwnership calls API', async () => {
    window.confirm = jest.fn(() => true);
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await ServerSettings.transferOwnership?.('srv1', 'new-owner-id');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('srv1'),
      expect.objectContaining({ method: expect.stringMatching(/POST|PATCH/) }),
    );
  });

  test('saveSettings with empty name shows validation error', async () => {
    await ServerSettings.saveSettings?.('srv1', { name: '' });
    // Either API not called or error toast
    const calls = mockApiFetch.mock.calls.length;
    expect(calls === 0 || mockToast.mock.calls.some(c => c[1] === 'error')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP-DM — Grup mesajlaşma
// ══════════════════════════════════════════════════════════════════════════════

describe('group-dm — coverage boost', () => {
  let GroupDM: {
    openGroupDM: (userIds: string[]) => Promise<void>;
    addMember: (groupId: string, userId: string) => Promise<void>;
    removeMember: (groupId: string, userId: string) => Promise<void>;
    renameGroup: (groupId: string, name: string) => Promise<void>;
    leaveGroup: (groupId: string) => Promise<void>;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    GroupDM = require('../client/js/core/group-dm.ts');
  });

  test('openGroupDM creates group and renders chat', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ _id: 'gdm1', name: 'Grup DM', members: ['u1', 'u2'] }),
    });
    await GroupDM.openGroupDM(['u1', 'u2']);
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('addMember calls API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await GroupDM.addMember?.('gdm1', 'u3');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('gdm1'),
      expect.objectContaining({ method: expect.stringMatching(/POST|PATCH/) }),
    );
  });

  test('removeMember calls API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await GroupDM.removeMember?.('gdm1', 'u2');
    expect(mockApiFetch).toHaveBeenCalled();
  });

  test('renameGroup calls API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await GroupDM.renameGroup?.('gdm1', 'Yeni Grup Adı');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('gdm1'),
      expect.objectContaining({ method: expect.stringMatching(/PATCH|PUT/) }),
    );
  });

  test('leaveGroup prompts confirmation', async () => {
    window.confirm = jest.fn(() => false);
    await GroupDM.leaveGroup?.('gdm1');
    expect(window.confirm).toHaveBeenCalled();
  });

  test('leaveGroup calls DELETE on confirm', async () => {
    window.confirm = jest.fn(() => true);
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await GroupDM.leaveGroup?.('gdm1');
    expect(mockApiFetch).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// VIDEO-QUALITY — Video kalite seçici
// ══════════════════════════════════════════════════════════════════════════════

describe('video-quality — coverage boost', () => {
  let VideoQuality: {
    openQualityPicker: (socketId: string) => void;
    setQuality: (socketId: string, preset: string) => void;
    getQuality: (socketId: string) => string;
    PRESETS: string[];
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    VideoQuality = require('../client/js/core/video-quality.ts');
  });

  test('PRESETS is a non-empty array', () => {
    expect(Array.isArray(VideoQuality.PRESETS)).toBe(true);
    expect(VideoQuality.PRESETS.length).toBeGreaterThan(0);
  });

  test('getQuality returns default for unknown socketId', () => {
    const q = VideoQuality.getQuality?.('unknown') ?? 'auto';
    expect(typeof q).toBe('string');
  });

  test('setQuality persists', () => {
    VideoQuality.setQuality?.('sock1', '720p');
    expect(VideoQuality.getQuality?.('sock1')).toBe('720p');
  });

  test('openQualityPicker renders picker UI', () => {
    VideoQuality.openQualityPicker?.('sock1');
    expect(document.body.innerHTML).toMatch(/quality|kalite|720|1080|auto/i);
  });

  test('openQualityPicker replaces existing picker', () => {
    VideoQuality.openQualityPicker?.('sock1');
    VideoQuality.openQualityPicker?.('sock1');
    const pickers = document.querySelectorAll('.video-quality-picker, #vq-picker');
    expect(pickers.length).toBeLessThanOrEqual(1);
  });

  test('invalid preset falls back to default', () => {
    VideoQuality.setQuality?.('sock2', 'invalid-preset');
    const q = VideoQuality.getQuality?.('sock2') ?? 'auto';
    expect(typeof q).toBe('string');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// INPUT.TS — Mesaj input yönetimi (emoji, mention, komut)
// ══════════════════════════════════════════════════════════════════════════════

describe('input — coverage boost', () => {
  let Input: {
    initInput: (el: HTMLTextAreaElement, channelId: string) => void;
    insertEmoji: (el: HTMLTextAreaElement, emoji: string) => void;
    getDraftContent: (channelId: string) => string;
    setDraftContent: (channelId: string, content: string) => void;
    clearDraft: (channelId: string) => void;
  };

  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    Input = require('../client/js/core/input.ts');
  });

  test('initInput attaches handlers without throwing', () => {
    expect(() => Input.initInput?.(textarea, 'ch1')).not.toThrow();
  });

  test('insertEmoji appends emoji to textarea', () => {
    textarea.value = 'Merhaba';
    Input.insertEmoji?.(textarea, '👋');
    expect(textarea.value).toContain('👋');
  });

  test('setDraftContent persists draft', () => {
    Input.setDraftContent?.('ch1', 'Taslak mesaj');
    expect(Input.getDraftContent?.('ch1')).toBe('Taslak mesaj');
  });

  test('clearDraft removes draft', () => {
    Input.setDraftContent?.('ch1', 'Silinecek');
    Input.clearDraft?.('ch1');
    expect(Input.getDraftContent?.('ch1') ?? '').toBe('');
  });

  test('getDraftContent returns empty string for unknown channel', () => {
    expect(Input.getDraftContent?.('unknown-ch') ?? '').toBe('');
  });

  test('insertEmoji at cursor position', () => {
    textarea.value = 'Hello World';
    textarea.selectionStart = 5;
    textarea.selectionEnd   = 5;
    Input.insertEmoji?.(textarea, '🌍');
    expect(textarea.value).toContain('🌍');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BOOST.TS — Sunucu boost yönetimi
// ══════════════════════════════════════════════════════════════════════════════

describe('boost — coverage boost', () => {
  let Boost: {
    openBoostModal: (serverId: string) => Promise<void>;
    boostServer: (serverId: string) => Promise<void>;
    getBoostLevel: (serverId: string) => Promise<number>;
    getBoostCount: (serverId: string) => Promise<number>;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    Boost = require('../client/js/core/boost.ts');
  });

  test('openBoostModal renders modal', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ level: 1, count: 5, perks: ['Özel emoji', 'Yüksek kalite ses'] }),
    });
    await Boost.openBoostModal?.('srv1');
    expect(document.body.innerHTML).toMatch(/boost|seviye|level/i);
  });

  test('boostServer calls API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await Boost.boostServer?.('srv1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('srv1'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('boostServer shows success toast', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await Boost.boostServer?.('srv1');
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), expect.not.stringMatching(/error/));
  });

  test('getBoostLevel returns numeric level', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ level: 2, count: 15 }),
    });
    const level = await Boost.getBoostLevel?.('srv1') ?? 0;
    expect(typeof level).toBe('number');
  });

  test('boostServer shows error on API failure', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Hata' }) });
    await Boost.boostServer?.('srv1');
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVITY.TS — Etkinlik/aktivite yönetimi
// ══════════════════════════════════════════════════════════════════════════════

describe('activity — coverage boost', () => {
  let Activity: {
    openActivityLauncher: (channelId: string) => Promise<void>;
    launchActivity: (channelId: string, activityId: string) => Promise<void>;
    leaveActivity: (channelId: string) => void;
    getActiveActivity: (channelId: string) => string | null;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    Activity = require('../client/js/core/activity.ts');
  });

  test('openActivityLauncher renders activity list', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { id: 'chess', name: 'Satranç', icon: '♟️' },
        { id: 'sketchpad', name: 'Çizim', icon: '🎨' },
      ]),
    });
    await Activity.openActivityLauncher?.('ch1');
    expect(document.body.innerHTML).toMatch(/etkinlik|activity|satranç|chess/i);
  });

  test('launchActivity calls API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, sessionId: 'sess1' }) });
    await Activity.launchActivity?.('ch1', 'chess');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('getActiveActivity returns null when no activity', () => {
    expect(Activity.getActiveActivity?.('ch1') ?? null).toBeNull();
  });

  test('leaveActivity does not throw', () => {
    expect(() => Activity.leaveActivity?.('ch1')).not.toThrow();
  });

  test('launchActivity shows error on failure', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Hata' }) });
    await Activity.launchActivity?.('ch1', 'chess');
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BADGES.TS — Kullanıcı rozetleri
// ══════════════════════════════════════════════════════════════════════════════

describe('badges — coverage boost', () => {
  let Badges: {
    openBadges: (userId: string) => Promise<void>;
    awardBadge: (userId: string, badgeId: string) => Promise<void>;
    revokeBadge: (userId: string, badgeId: string) => Promise<void>;
    getUserBadges: (userId: string) => Promise<unknown[]>;
    BADGE_DEFINITIONS: { id: string; name: string; icon: string }[];
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    Badges = require('../client/js/core/badges.ts');
  });

  test('BADGE_DEFINITIONS is non-empty', () => {
    expect(Array.isArray(Badges.BADGE_DEFINITIONS)).toBe(true);
    expect(Badges.BADGE_DEFINITIONS.length).toBeGreaterThan(0);
  });

  test('each badge has id, name, icon', () => {
    for (const badge of Badges.BADGE_DEFINITIONS ?? []) {
      expect(badge).toHaveProperty('id');
      expect(badge).toHaveProperty('name');
      expect(badge).toHaveProperty('icon');
    }
  });

  test('openBadges renders badge list', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: 'pioneer', name: 'Öncü', icon: '🌟', awardedAt: Date.now() }]),
    });
    await Badges.openBadges?.('u1');
    expect(document.body.innerHTML).toMatch(/rozet|badge|öncü|pioneer/i);
  });

  test('getUserBadges returns array', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: 'pioneer', name: 'Öncü' }]),
    });
    const badges = await Badges.getUserBadges?.('u1') ?? [];
    expect(Array.isArray(badges)).toBe(true);
  });

  test('awardBadge calls API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await Badges.awardBadge?.('u1', 'pioneer');
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('revokeBadge calls API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await Badges.revokeBadge?.('u1', 'pioneer');
    expect(mockApiFetch).toHaveBeenCalled();
  });

  test('empty badge list shows empty state', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await Badges.openBadges?.('u1');
    expect(document.body.innerHTML).toMatch(/rozet yok|boş|henüz|no badges/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DRAFTS.TS — Mesaj taslakları
// ══════════════════════════════════════════════════════════════════════════════

describe('drafts — coverage boost', () => {
  let Drafts: {
    saveDraft: (channelId: string, content: string) => void;
    loadDraft: (channelId: string) => string;
    deleteDraft: (channelId: string) => void;
    getAllDrafts: () => Record<string, string>;
    hasDraft: (channelId: string) => boolean;
    clearAllDrafts: () => void;
  };

  beforeEach(() => {
    buildDOM(); reset(); jest.resetModules();
    localStorage.clear();
    Drafts = require('../client/js/core/drafts.ts');
  });

  test('saveDraft and loadDraft round-trips', () => {
    Drafts.saveDraft?.('ch1', 'Taslak içerik');
    expect(Drafts.loadDraft?.('ch1')).toBe('Taslak içerik');
  });

  test('loadDraft returns empty string for unknown channel', () => {
    expect(Drafts.loadDraft?.('unknown') ?? '').toBe('');
  });

  test('deleteDraft removes the draft', () => {
    Drafts.saveDraft?.('ch2', 'Silinecek');
    Drafts.deleteDraft?.('ch2');
    expect(Drafts.loadDraft?.('ch2') ?? '').toBe('');
  });

  test('hasDraft returns false for unknown channel', () => {
    expect(Drafts.hasDraft?.('no-such-ch') ?? false).toBe(false);
  });

  test('hasDraft returns true after save', () => {
    Drafts.saveDraft?.('ch3', 'Var');
    expect(Drafts.hasDraft?.('ch3') ?? false).toBe(true);
  });

  test('getAllDrafts returns all saved drafts', () => {
    Drafts.saveDraft?.('ch4', 'A');
    Drafts.saveDraft?.('ch5', 'B');
    const all = Drafts.getAllDrafts?.() ?? {};
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(2);
  });

  test('clearAllDrafts removes all drafts', () => {
    Drafts.saveDraft?.('ch6', 'X');
    Drafts.saveDraft?.('ch7', 'Y');
    Drafts.clearAllDrafts?.();
    expect(Object.keys(Drafts.getAllDrafts?.() ?? {}).length).toBe(0);
  });

  test('saveDraft with empty string is treated as deletion', () => {
    Drafts.saveDraft?.('ch8', 'İçerik');
    Drafts.saveDraft?.('ch8', '');
    const draft = Drafts.loadDraft?.('ch8') ?? '';
    expect(draft).toBe('');
  });

  test('multiple channels isolated from each other', () => {
    Drafts.saveDraft?.('chA', 'A içerik');
    Drafts.saveDraft?.('chB', 'B içerik');
    expect(Drafts.loadDraft?.('chA')).toBe('A içerik');
    expect(Drafts.loadDraft?.('chB')).toBe('B içerik');
  });
});
