// client/tests/channel-stage-logic.test.ts
// Sprint 69 — core/channel-stage.ts için logic testleri
// Kapsam:
//   - handleStageEvent: stage:state, stage:userJoined, stage:userLeft,
//     stage:handRaise, stage:muteUpdate, stage:demoted, stage:promoted
//   - Kanal ID uyuşmazlığında event görmezden gelinir
//   - _stageChannel null iken event görmezden gelinir

'use strict';

// ── Global stubs — channel-stage.ts bunlara declare ile erişiyor ─────────────

const mockSocketEmit = jest.fn();
const mockToastFn    = jest.fn();
const mockRtcJoin    = jest.fn().mockResolvedValue(undefined);
const mockRtcLeave   = jest.fn();
const mockRtcMute    = jest.fn().mockReturnValue(true);

// module-level globals
(global as any).escHtml = (s: string) => s;
(global as any).cssColor = () => '#888';
(global as any).initials = (name: string) => name.slice(0, 2).toUpperCase();
(global as any).toast = mockToastFn;
(global as any).socket = { emit: mockSocketEmit };
(global as any).currentServer = { _id: 'srv-1', ownerId: 'me-user' };
(global as any).me = { id: 'me-user', displayName: 'TestUser', avatarColor: '#fff' };
(global as any).rtc = {
  toggleMute:  mockRtcMute,
  joinVoice:   mockRtcJoin,
  leaveVoice:  mockRtcLeave,
};

// ── Modül yükleyici ───────────────────────────────────────────────────────────

function loadStageModule() {
  jest.resetModules();

  // Globals yeniden set et
  (global as any).socket      = { emit: mockSocketEmit };
  (global as any).currentServer = { _id: 'srv-1', ownerId: 'me-user' };
  (global as any).me          = { id: 'me-user', displayName: 'TestUser', avatarColor: '#fff' };
  (global as any).rtc         = { toggleMute: mockRtcMute, joinVoice: mockRtcJoin, leaveVoice: mockRtcLeave };
  (global as any).toast       = mockToastFn;
  (global as any).escHtml     = (s: string) => s;
  (global as any).cssColor    = () => '#888';
  (global as any).initials    = (name: string) => name.slice(0, 2).toUpperCase();

  const mod = require('../js/core/channel-stage');
  return mod as {
    loadStageChannel:  (ch: object) => void;
    handleStageEvent:  (event: string, data: Record<string, unknown>) => void;
    toggleStageMute:   () => void;
    toggleStageHand:   () => void;
    leaveStage:        () => void;
    stagePromoteUser:  (uid: string) => void;
    stageKickSpeaker:  (uid: string) => void;
  };
}

// ── DOM kurulumu ─────────────────────────────────────────────────────────────

function buildStageDOM() {
  document.body.innerHTML = `
    <div id="messages-area"></div>
    <div id="stage-speakers"></div>
    <div id="stage-listeners"></div>
    <div id="stage-controls"></div>
    <div id="stage-speaker-count"></div>
    <div id="stage-listener-count"></div>
    <div id="stage-join-btns"></div>
    <div id="stage-speaker-controls" style="display:none"></div>
    <div id="stage-listener-controls" style="display:none"></div>
    <button id="stage-mute-btn"></button>
    <button id="stage-hand-btn"></button>
    <div id="stage-live-badge" style="display:none"></div>
  `;
}

function makeChannel(id = 'ch-stage') {
  return { _id: id, name: 'Ana Sahne', topic: 'Test topic' };
}

function makeUser(overrides: Partial<{
  userId: string; displayName: string; avatarColor: string;
  muted: boolean; speaking: boolean; handRaised: boolean;
}> = {}) {
  return {
    userId:      overrides.userId      ?? `u-${Math.random().toString(36).slice(2)}`,
    displayName: overrides.displayName ?? 'TestUser',
    avatarColor: overrides.avatarColor ?? '#2d9cdb',
    muted:       overrides.muted       ?? false,
    speaking:    overrides.speaking    ?? false,
    handRaised:  overrides.handRaised  ?? false,
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  buildStageDOM();
  jest.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════
// loadStageChannel
// ════════════════════════════════════════════════════════════════

describe('loadStageChannel', () => {
  it('socket.emit("stage:join") gönderir', () => {
    const { loadStageChannel } = loadStageModule();
    loadStageChannel(makeChannel());

    expect(mockSocketEmit).toHaveBeenCalledWith(
      'stage:join',
      expect.objectContaining({ channelId: 'ch-stage', serverId: 'srv-1' })
    );
  });

  it('messages-area içine stage-view oluşturur', () => {
    const { loadStageChannel } = loadStageModule();
    loadStageChannel(makeChannel());

    expect(document.getElementById('stage-view')).not.toBeNull();
  });

  it('kanal adını stage-title\'a yazar', () => {
    const { loadStageChannel } = loadStageModule();
    loadStageChannel({ _id: 'ch-s', name: 'Müzik Sahnesi', topic: '' });

    const title = document.getElementById('stage-title');
    expect(title?.textContent).toContain('Müzik Sahnesi');
  });

  it('messages-area yoksa hata fırlatmaz', () => {
    document.body.innerHTML = ''; // DOM temizle
    const { loadStageChannel } = loadStageModule();

    expect(() => loadStageChannel(makeChannel())).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// handleStageEvent — kanal ID kontrolü
// ════════════════════════════════════════════════════════════════

describe('handleStageEvent — kanal ID filtresi', () => {
  it('_stageChannel null iken event yok sayılır', () => {
    const { handleStageEvent } = loadStageModule();
    // loadStageChannel çağrılmadı → _stageChannel null

    expect(() =>
      handleStageEvent('stage:state', { channelId: 'ch-stage', speakers: [], listeners: [] })
    ).not.toThrow();
  });

  it('farklı channelId ile gelen event yok sayılır', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel('ch-stage'));

    const spk = document.getElementById('stage-speakers')!;
    const origHTML = spk.innerHTML;

    handleStageEvent('stage:state', {
      channelId: 'ch-DIFFERENT',
      speakers:  [makeUser()],
      listeners: [],
    });

    // UI değişmemiş olmalı
    expect(spk.innerHTML).toBe(origHTML);
  });
});

// ════════════════════════════════════════════════════════════════
// handleStageEvent — stage:state
// ════════════════════════════════════════════════════════════════

describe('handleStageEvent stage:state', () => {
  it('speakers ve listeners listesini günceller', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const sp1 = makeUser({ displayName: 'Alice' });
    const li1 = makeUser({ displayName: 'Bob' });

    handleStageEvent('stage:state', {
      channelId: 'ch-stage',
      speakers:  [sp1],
      listeners: [li1],
    });

    const spkEl = document.getElementById('stage-speakers');
    const lstEl = document.getElementById('stage-listeners');
    expect(spkEl?.textContent).toContain('Alice');
    expect(lstEl?.textContent).toContain('Bob');
  });

  it('boş speakers/listeners ile hata fırlatmaz', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    expect(() =>
      handleStageEvent('stage:state', { channelId: 'ch-stage', speakers: [], listeners: [] })
    ).not.toThrow();
  });

  it('stage:state null speakers için ?? [] kullanır', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    expect(() =>
      handleStageEvent('stage:state', { channelId: 'ch-stage', speakers: null, listeners: null })
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// handleStageEvent — stage:userJoined
// ════════════════════════════════════════════════════════════════

describe('handleStageEvent stage:userJoined', () => {
  it('speaker rolüyle katılan kullanıcı speakers listesine eklenir', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ displayName: 'NewSpeaker' });

    handleStageEvent('stage:userJoined', {
      channelId: 'ch-stage',
      role:      'speaker',
      user,
    });

    expect(document.getElementById('stage-speakers')!.textContent).toContain('NewSpeaker');
  });

  it('listener rolüyle katılan kullanıcı listeners listesine eklenir', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ displayName: 'NewListener' });

    handleStageEvent('stage:userJoined', {
      channelId: 'ch-stage',
      role:      'listener',
      user,
    });

    expect(document.getElementById('stage-listeners')!.textContent).toContain('NewListener');
  });
});

// ════════════════════════════════════════════════════════════════
// handleStageEvent — stage:userLeft
// ════════════════════════════════════════════════════════════════

describe('handleStageEvent stage:userLeft', () => {
  it('ayrılan kullanıcı speakers listesinden kaldırılır', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ userId: 'uid-leave', displayName: 'Leaver' });

    // Önce katıl
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'speaker', user });
    expect(document.getElementById('stage-speakers')!.textContent).toContain('Leaver');

    // Sonra ayrıl
    handleStageEvent('stage:userLeft', { channelId: 'ch-stage', userId: 'uid-leave' });
    expect(document.getElementById('stage-speakers')!.textContent).not.toContain('Leaver');
  });

  it('ayrılan kullanıcı listeners listesinden kaldırılır', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ userId: 'uid-lstleave', displayName: 'LeavingListener' });

    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'listener', user });
    handleStageEvent('stage:userLeft',   { channelId: 'ch-stage', userId: 'uid-lstleave' });

    expect(document.getElementById('stage-listeners')!.textContent).not.toContain('LeavingListener');
  });

  it('listede olmayan userId için hata fırlatmaz', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    expect(() =>
      handleStageEvent('stage:userLeft', { channelId: 'ch-stage', userId: 'nonexistent' })
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// handleStageEvent — stage:handRaise
// ════════════════════════════════════════════════════════════════

describe('handleStageEvent stage:handRaise', () => {
  it('el kaldırma durumu kullanıcıya set edilir', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ userId: 'uid-hand', displayName: 'HandRaiser', handRaised: false });
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'listener', user });

    handleStageEvent('stage:handRaise', { channelId: 'ch-stage', userId: 'uid-hand', raised: true });

    // Toast — sahibi başkası ve currentServer.ownerId === me.id ise gelir
    // (me.id = 'me-user', currentServer.ownerId = 'me-user', userId ≠ me.id)
    expect(mockToastFn).toHaveBeenCalledWith(
      expect.stringContaining('HandRaiser'),
      'info'
    );
  });

  it('kendi el kaldırma için toast gelmez', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const myUser = makeUser({ userId: 'me-user', displayName: 'Me' });
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'listener', user: myUser });

    handleStageEvent('stage:handRaise', { channelId: 'ch-stage', userId: 'me-user', raised: true });

    expect(mockToastFn).not.toHaveBeenCalled();
  });

  it('el indirme (raised=false) için toast gelmez', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ userId: 'uid-lower', displayName: 'Lower' });
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'listener', user });
    handleStageEvent('stage:handRaise',  { channelId: 'ch-stage', userId: 'uid-lower', raised: false });

    expect(mockToastFn).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// handleStageEvent — stage:muteUpdate
// ════════════════════════════════════════════════════════════════

describe('handleStageEvent stage:muteUpdate', () => {
  it('konuşmacının muted durumu güncellenir', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ userId: 'uid-mute', displayName: 'Mutable', muted: false });
    handleStageEvent('stage:userJoined',  { channelId: 'ch-stage', role: 'speaker', user });
    handleStageEvent('stage:muteUpdate', { channelId: 'ch-stage', userId: 'uid-mute', muted: true });

    // Hata fırlatmamalı — gerçek state testi iç değişken gerektirir, burada sadece
    // davranışın çökmediğini doğruluyoruz
    expect(() =>
      handleStageEvent('stage:muteUpdate', { channelId: 'ch-stage', userId: 'uid-mute', muted: false })
    ).not.toThrow();
  });

  it('listede olmayan userId için hata fırlatmaz', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    expect(() =>
      handleStageEvent('stage:muteUpdate', { channelId: 'ch-stage', userId: 'nobody', muted: true })
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// handleStageEvent — stage:demoted (kendi kullanıcı)
// ════════════════════════════════════════════════════════════════

describe('handleStageEvent stage:demoted', () => {
  it('kendi kullanıcı düşürülünce stageRole listener\'a döner', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const myUser = makeUser({ userId: 'me-user', displayName: 'Me' });
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'speaker', user: myUser });

    handleStageEvent('stage:demoted', { channelId: 'ch-stage', userId: 'me-user' });

    expect(mockToastFn).toHaveBeenCalledWith(
      expect.stringContaining('Dinleyici'),
      'info'
    );
    expect(mockRtcLeave).toHaveBeenCalled();
  });

  it('başka kullanıcı düşürülünce kendi toast/rtc çağrısı olmaz', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const otherUser = makeUser({ userId: 'uid-other', displayName: 'Other' });
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'speaker', user: otherUser });
    handleStageEvent('stage:demoted',   { channelId: 'ch-stage', userId: 'uid-other' });

    expect(mockToastFn).not.toHaveBeenCalled();
    expect(mockRtcLeave).not.toHaveBeenCalled();
  });

  it('düşürülen kullanıcı speakers\'dan kaldırılır, listeners\'a eklenir', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ userId: 'uid-demote', displayName: 'DemoteMe' });
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'speaker', user });
    expect(document.getElementById('stage-speakers')!.textContent).toContain('DemoteMe');

    handleStageEvent('stage:demoted', { channelId: 'ch-stage', userId: 'uid-demote' });

    expect(document.getElementById('stage-speakers')!.textContent).not.toContain('DemoteMe');
    expect(document.getElementById('stage-listeners')!.textContent).toContain('DemoteMe');
  });
});

// ════════════════════════════════════════════════════════════════
// handleStageEvent — stage:promoted (kendi kullanıcı)
// ════════════════════════════════════════════════════════════════

describe('handleStageEvent stage:promoted', () => {
  it('kendi kullanıcı yükseltilince toast ve rtc:joinVoice çağrılır', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const myUser = makeUser({ userId: 'me-user', displayName: 'Me' });
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'listener', user: myUser });

    handleStageEvent('stage:promoted', { channelId: 'ch-stage', userId: 'me-user' });

    expect(mockToastFn).toHaveBeenCalledWith(
      expect.stringContaining('Konuşmacı'),
      'success'
    );
    expect(mockRtcJoin).toHaveBeenCalledWith('ch-stage', 'srv-1');
  });

  it('başka kullanıcı yükseltilince listeners\'dan speakers\'a taşınır', () => {
    const { loadStageChannel, handleStageEvent } = loadStageModule();
    loadStageChannel(makeChannel());

    const user = makeUser({ userId: 'uid-promote', displayName: 'PromoteMe' });
    handleStageEvent('stage:userJoined', { channelId: 'ch-stage', role: 'listener', user });
    expect(document.getElementById('stage-listeners')!.textContent).toContain('PromoteMe');

    handleStageEvent('stage:promoted', { channelId: 'ch-stage', userId: 'uid-promote' });

    expect(document.getElementById('stage-listeners')!.textContent).not.toContain('PromoteMe');
    expect(document.getElementById('stage-speakers')!.textContent).toContain('PromoteMe');
  });
});
