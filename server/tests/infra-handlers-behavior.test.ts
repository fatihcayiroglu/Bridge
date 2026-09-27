process.env.NODE_ENV = 'test';

jest.useFakeTimers();

const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
const mockUsersUpdate = jest.fn();
const mockMembersFindByUser = jest.fn();
const mockMembersFindOne = jest.fn();
const mockNotificationsUpsert = jest.fn();
const mockChannelsFindById = jest.fn();
const mockFindSound = jest.fn();
const mockRecordSoundPlay = jest.fn();
const mockFindFriendship = jest.fn();
const mockPushMemberCount = jest.fn();
const mockGetMembershipsCached = jest.fn();
const mockInvalidateMemberships = jest.fn();
const mockThrottleStatusWrite = jest.fn();
const mockMarkOnline = jest.fn();
const mockMarkOffline = jest.fn();
const mockIsPresenceVisible = jest.fn();
const mockReleaseSocket = jest.fn();
const mockValidate = jest.fn();
const mockResolvePermissions = jest.fn();

jest.mock('../lib/logger', () => mockLogger);
jest.mock('../db/repositories', () => ({
  Users: { update: (...a: any[]) => mockUsersUpdate(...a) },
  Members: {
    findByUser: (...a: any[]) => mockMembersFindByUser(...a),
    findOne: (...a: any[]) => mockMembersFindOne(...a),
  },
  Notifications: { upsertPref: (...a: any[]) => mockNotificationsUpsert(...a) },
  Channels: { findById: (...a: any[]) => mockChannelsFindById(...a) },
  ServerAssets: {
    findSoundByIdAndServer: (...a: any[]) => mockFindSound(...a),
    recordSoundPlay: (...a: any[]) => mockRecordSoundPlay(...a),
  },
  Social: { findFriendship: (...a: any[]) => mockFindFriendship(...a) },
}));
jest.mock('../socket/handlers/discover', () => ({ pushMemberCount: (...a: any[]) => mockPushMemberCount(...a) }));
jest.mock('../lib/presenceCache', () => ({
  getMembershipsCached: (...a: any[]) => mockGetMembershipsCached(...a),
  invalidateMemberships: (...a: any[]) => mockInvalidateMemberships(...a),
  throttleStatusWrite: (...a: any[]) => mockThrottleStatusWrite(...a),
  markOnline: (...a: any[]) => mockMarkOnline(...a),
  markOffline: (...a: any[]) => mockMarkOffline(...a),
  isPresenceVisible: (...a: any[]) => mockIsPresenceVisible(...a),
  releaseSocket: (...a: any[]) => mockReleaseSocket(...a),
}));
jest.mock('../middleware/validate', () => ({
  validateSocketPayload: (...a: any[]) => mockValidate(...a),
  socketSchemas: {
    typingChannel: {}, statusUpdate: {}, notifPref: {}, friendRequestNotify: {}, serverIdPayload: {}, soundboardPlay: {},
  },
}));
jest.mock('../lib/permissions', () => ({
  resolvePermissions: (...a: any[]) => mockResolvePermissions(...a),
  hasPermission: (p: number, b: number) => (p & b) === b,
  PERMS: { VIEW_CHANNELS: 1, CONNECT: 2, SPEAK: 4 },
}));

import { registerInfraHandlers, handleDisconnect } from '../socket/handlers/infra';

function makeSocket() {
  const handlers = new Map<string, Function>();
  const roomEmit = jest.fn();
  const socket: any = {
    id: 'sock1',
    rooms: new Set<string>(['sock1', 'channel:c1', 'voice:c1']),
    currentVoiceChannel: 'c1',
    currentVoiceServer: 's1',
    on: jest.fn((event: string, fn: Function) => handlers.set(event, fn)),
    to: jest.fn(() => ({ emit: roomEmit })),
    emit: jest.fn(),
    join: jest.fn((room: string) => socket.rooms.add(room)),
    leave: jest.fn((room: string) => socket.rooms.delete(room)),
  };
  return { socket, handlers, roomEmit };
}

function makeIo() {
  const emit = jest.fn();
  const io: any = { to: jest.fn(() => ({ emit })) };
  return { io, emit };
}

function setupInfra(userOverrides: Record<string, unknown> = {}) {
  const { socket, handlers, roomEmit } = makeSocket();
  const { io, emit } = makeIo();
  const socketUsers = new Map<string, any>([
    ['sock1', { _id: 'u1', id: 'u1' }],
  ]);
  const typingTimers = new Map<string, any>();
  const rateStore = new Map<string, number[]>();
  const leaveVoice = jest.fn().mockResolvedValue(undefined);
  const voiceActivity = new Map<string, number>([['sock1', Date.now()]]);
  const refreshMemberships = jest.fn().mockResolvedValue(undefined);
  const safeUser: any = { _id: 'u1', id: 'u1', username: 'alice', displayName: 'Alice', avatarColor: '#abc', ...userOverrides };

  registerInfraHandlers(socket, socket, io, safeUser, {
    socketUsers, typingTimers, TYPING_TIMEOUT_MS: 5000,
    _socketRateStore: rateStore, leaveVoice, voiceActivity, refreshMemberships, safeUser,
  } as any);
  return { socket, handlers, roomEmit, io, emit, socketUsers, typingTimers, rateStore, leaveVoice, voiceActivity, refreshMemberships, safeUser };
}

beforeEach(() => {
  jest.clearAllTimers();
  jest.clearAllMocks();
  mockValidate.mockReturnValue({ valid: true });
  mockUsersUpdate.mockResolvedValue(undefined);
  mockMembersFindByUser.mockResolvedValue([{ serverId: 's1' }]);
  mockMembersFindOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
  mockNotificationsUpsert.mockResolvedValue(undefined);
  mockChannelsFindById.mockResolvedValue({ _id: 'c1', serverId: 's1', type: 'voice' });
  mockFindSound.mockResolvedValue({ _id: 'snd1', url: '/uploads/soundboard/s.ogg', name: 'Ping', emoji: '🔔' });
  mockRecordSoundPlay.mockResolvedValue({ playCount: 1 });
  mockFindFriendship.mockResolvedValue({ userId: 'u1', friendId: 'u2', status: 'pending' });
  mockPushMemberCount.mockResolvedValue(undefined);
  mockGetMembershipsCached.mockImplementation(async (_u: string, loader: Function) => loader());
  mockInvalidateMemberships.mockResolvedValue(undefined);
  mockThrottleStatusWrite.mockResolvedValue(true);
  mockMarkOnline.mockResolvedValue(undefined);
  mockMarkOffline.mockResolvedValue(undefined);
  mockIsPresenceVisible.mockResolvedValue(true);
  mockReleaseSocket.mockResolvedValue(0);
  mockResolvePermissions.mockResolvedValue(7);
});

describe('registerInfraHandlers', () => {
  test('typing:start validates room membership, replaces timer and auto-stops', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('typing:start')!;

    mockValidate.mockReturnValueOnce({ valid: false });
    fn({ channelId: 'c1' });
    expect(h.roomEmit).not.toHaveBeenCalled();

    h.socket.rooms.delete('channel:c1');
    fn({ channelId: 'c1' });
    expect(h.roomEmit).not.toHaveBeenCalled();
    h.socket.rooms.add('channel:c1');

    const old = setTimeout(() => {}, 9999);
    h.typingTimers.set('c1:u1', old);
    fn({ channelId: 'c1' });
    // FAZ 16: yayılan olay artık istemcinin GERÇEKTEN dinlediği `typing:update`.
    // Önceden `typing:start` yayılıyordu; hiçbir istemci onu dinlemiyordu.
    expect(h.roomEmit).toHaveBeenCalledWith('typing:update', expect.objectContaining({
      channelId: 'c1', userId: 'u1', typing: true,
    }));
    expect(h.typingTimers.has('c1:u1')).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(h.typingTimers.has('c1:u1')).toBe(false);
    // Süre aşımı emniyeti de tüketilen biçimde: `typing:false`.
    expect(h.roomEmit).toHaveBeenCalledWith('typing:update', expect.objectContaining({
      channelId: 'c1', userId: 'u1', typing: false,
    }));
  });

  test('FAZ 16: yazıyor yayını görünen adı ve kullanıcı adını birlikte taşır', () => {
    const h = setupInfra();
    h.handlers.get('typing:start')!({ channelId: 'c1' });

    // Faz 15'in görünen ad düzeltmesi İKİ handler'dan yalnızca birine girmişti;
    // tek sahipte tek bir doğru vardır.
    expect(h.roomEmit).toHaveBeenCalledWith('typing:update', expect.objectContaining({
      displayName: 'Alice', username: 'alice',
    }));
  });

  test('typing:stop ignores invalid/non-member and clears active timer for members', () => {
    const h = setupInfra();
    const fn = h.handlers.get('typing:stop')!;
    mockValidate.mockReturnValueOnce({ valid: false });
    fn({ channelId: 'c1' });
    h.socket.rooms.delete('channel:c1');
    fn({ channelId: 'c1' });
    expect(h.roomEmit).not.toHaveBeenCalled();

    h.socket.rooms.add('channel:c1');
    h.typingTimers.set('c1:u1', setTimeout(() => {}, 9999));
    fn({ channelId: 'c1' });
    expect(h.typingTimers.has('c1:u1')).toBe(false);
    expect(h.roomEmit).toHaveBeenCalledWith('typing:update', expect.objectContaining({
      channelId: 'c1', userId: 'u1', typing: false,
    }));
  });

  test('status:update validates status, enforces hidden presence, throttles writes and broadcasts offline', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('status:update')!;
    mockValidate.mockReturnValueOnce({ valid: false });
    await fn({ status: 'online' });
    await fn({ status: 'bogus' });
    expect(mockUsersUpdate).not.toHaveBeenCalled();

    mockIsPresenceVisible.mockResolvedValueOnce(false);
    mockThrottleStatusWrite.mockResolvedValueOnce(false);
    await fn({ status: 'online' });
    expect(mockUsersUpdate).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith('user:status', expect.objectContaining({ userId: 'u1', status: 'offline' }));
    expect(mockMarkOffline).toHaveBeenCalledWith('u1');

    // Kalici tercih (`presenceStatus`) ile canli durum (`status`) AYRI
    // alanlardir ve TEK yetkili yazmada birlikte kalicilastirilir; yoksa
    // yeniden baglanma idle/DND/manuel-offline tercihini siler.
    mockIsPresenceVisible.mockResolvedValueOnce(true);
    mockThrottleStatusWrite.mockResolvedValueOnce(true);
    await fn({ status: 'idle', statusText: 'busy', statusEmoji: '🧪' });
    expect(mockUsersUpdate).toHaveBeenCalledWith('u1', {
      presenceStatus: 'idle', status: 'idle', statusText: 'busy', statusEmoji: '🧪',
    });
    expect(mockMarkOnline).toHaveBeenCalledWith('u1');

    // Kisma anahtari YAZILAN DEMETIN TAMAMIDIR: yalnizca `status` uzerinden
    // kisilsaydi, durum `online` kalirken degistirilen ozel durum METNI
    // sessizce yutulurdu.
    mockUsersUpdate.mockClear();
    mockIsPresenceVisible.mockResolvedValue(true);
    mockThrottleStatusWrite.mockResolvedValue(true);
    await fn({ status: 'online', statusText: 'ilk', statusEmoji: '' });
    await fn({ status: 'online', statusText: 'ikinci', statusEmoji: '' });
    const tokens = mockThrottleStatusWrite.mock.calls.slice(-2).map((call: any[]) => call[1]);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(mockUsersUpdate).toHaveBeenCalledTimes(2);
  });

  test('status:update logs dependency failures without throwing', async () => {
    const h = setupInfra();
    mockIsPresenceVisible.mockRejectedValueOnce(new Error('presence down'));
    await expect(h.handlers.get('status:update')!({ status: 'online' })).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'socket.status_update.error', err: 'presence down' }), expect.any(String));
  });

  test('notif:pref validates level/channel/current permission and persists only authorized preferences', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('notif:pref')!;
    mockValidate.mockReturnValueOnce({ valid: false });
    await fn({ channelId: 'c1', level: 'all' });
    await fn({ channelId: 'c1', level: 'bad' });
    mockChannelsFindById.mockResolvedValueOnce(null);
    await fn({ channelId: 'c1', level: 'mute' });
    mockResolvePermissions.mockRejectedValueOnce(new Error('perm down'));
    await fn({ channelId: 'c1', level: 'all' });
    mockResolvePermissions.mockResolvedValueOnce(0);
    await fn({ channelId: 'c1', level: 'all' });
    expect(mockNotificationsUpsert).not.toHaveBeenCalled();

    mockResolvePermissions.mockResolvedValueOnce(3);
    await fn({ channelId: 'c1', level: 'mentions' });
    expect(mockNotificationsUpsert).toHaveBeenCalledWith('u1', 'c1', expect.objectContaining({ level: 'mentions', muteUntil: null }));
    expect(h.socket.emit).toHaveBeenCalledWith('notif:pref:updated', { channelId: 'c1', level: 'mentions' });
  });

  test('notif:pref logs persistence errors', async () => {
    const h = setupInfra();
    mockNotificationsUpsert.mockRejectedValueOnce(new Error('write failed'));
    await h.handlers.get('notif:pref')!({ channelId: 'c1', level: 'all' });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'socket.notif_pref.error', err: 'write failed' }), expect.any(String));
  });

  test('friend notification requires authoritative pending direction and emits to cluster-wide user room', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('friend:request:notify')!;
    mockValidate.mockReturnValueOnce({ valid: false });
    await fn({ toUserId: 'u2' });

    mockFindFriendship.mockRejectedValueOnce(new Error('db'));
    await fn({ toUserId: 'u2' });
    mockFindFriendship.mockResolvedValueOnce({ userId: 'u2', friendId: 'u1', status: 'pending' });
    await fn({ toUserId: 'u2' });
    expect(h.io.to).not.toHaveBeenCalled();

    mockFindFriendship.mockResolvedValueOnce({ userId: 'u1', friendId: 'u2', status: 'pending' });
    await fn({ toUserId: 'u2' });
    expect(h.io.to).toHaveBeenCalledWith('user:u2');
    expect(h.emit).toHaveBeenCalledWith('friend:request:received', { from: h.safeUser });
  });

  test('server:joined verifies existing membership before room join/cache refresh', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('server:joined')!;
    mockValidate.mockReturnValueOnce({ valid: false });
    await fn({ serverId: 's1' });
    mockMembersFindOne.mockRejectedValueOnce(new Error('db'));
    await fn({ serverId: 's1' });
    mockMembersFindOne.mockResolvedValueOnce(null);
    await fn({ serverId: 's1' });
    expect(h.socket.join).not.toHaveBeenCalled();

    mockMembersFindOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1' });
    mockPushMemberCount.mockRejectedValueOnce(new Error('advisory'));
    await fn({ serverId: 's1' });
    expect(h.socket.join).toHaveBeenCalledWith('server:s1');
    expect(mockInvalidateMemberships).toHaveBeenCalledWith('u1');
    expect(h.refreshMemberships).toHaveBeenCalledWith('u1');
  });

  test('server:left leaves room and invalidates membership cache', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('server:left')!;
    mockValidate.mockReturnValueOnce({ valid: false });
    await fn({ serverId: 's1' });
    expect(h.socket.leave).not.toHaveBeenCalledWith('server:s1');
    mockPushMemberCount.mockRejectedValueOnce(new Error('advisory'));
    await fn({ serverId: 's1' });
    expect(h.socket.leave).toHaveBeenCalledWith('server:s1');
    expect(mockInvalidateMemberships).toHaveBeenCalledWith('u1');
  });

  test('soundboard requires voice room, channel relation, VIEW+CONNECT and server-owned sound', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('soundboard:play')!;
    mockValidate.mockReturnValueOnce({ valid: false });
    await fn({ channelId: 'c1', soundId: 'snd1' });

    h.socket.currentVoiceChannel = 'other';
    await fn({ channelId: 'c1', soundId: 'snd1' });
    h.socket.currentVoiceChannel = 'c1';
    h.socket.rooms.delete('voice:c1');
    await fn({ channelId: 'c1', soundId: 'snd1' });
    h.socket.rooms.add('voice:c1');

    mockChannelsFindById.mockRejectedValueOnce(new Error('db'));
    await fn({ channelId: 'c1', soundId: 'snd1' });
    mockChannelsFindById.mockResolvedValueOnce({ _id: 'c1', serverId: 's1', type: 'voice' });
    mockResolvePermissions.mockRejectedValueOnce(new Error('perm'));
    await fn({ channelId: 'c1', soundId: 'snd1' });
    mockResolvePermissions.mockResolvedValueOnce(1); // VIEW only, no CONNECT
    await fn({ channelId: 'c1', soundId: 'snd1' });
    mockResolvePermissions.mockResolvedValueOnce(3); // VIEW+CONNECT, SPEAK denied
    await fn({ channelId: 'c1', soundId: 'snd1' });
    mockFindSound.mockRejectedValueOnce(new Error('asset'));
    await fn({ channelId: 'c1', soundId: 'snd1' });
    mockFindSound.mockResolvedValueOnce(null);
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.roomEmit).not.toHaveBeenCalled();

    mockFindSound.mockResolvedValueOnce({ _id: 'snd1', url: '/uploads/soundboard/s.ogg', name: 'Ping', emoji: '🔔' });
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.socket.to).toHaveBeenCalledWith('voice:c1');
    expect(mockRecordSoundPlay).toHaveBeenCalledWith('snd1', 'u1', 's1');
    expect(h.roomEmit).toHaveBeenCalledWith('soundboard:play', {
      channelId: 'c1', soundId: 'snd1', soundUrl: '/uploads/soundboard/s.ogg', soundName: 'Ping', emoji: '🔔', scope: 'server',
      playedBy: { id: 'u1', username: 'alice', displayName: 'Alice', avatarColor: '#abc', avatarUrl: null },
    });
  });

  // ── SPEAK REDDİ SOUNDBOARD ÜZERİNDEN AŞILAMAZ ─────────────────────────────
  // Soundboard, ses kanalındaki HERKESE duyulan ses üretir. `SPEAK` açıkça
  // reddedilmiş bir üye mikrofon açamıyorsa soundboard da açamamalıdır; aksi
  // hâlde kanal düzeyindeki "konuşma yok" yaptırımı tek tıkla atlanırdı.
  test('soundboard playback requires SPEAK exactly like a microphone producer', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('soundboard:play')!;

    mockResolvePermissions.mockResolvedValueOnce(1 | 2); // VIEW + CONNECT, SPEAK denied
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.roomEmit).not.toHaveBeenCalled();
    expect(mockRecordSoundPlay).not.toHaveBeenCalled();

    mockResolvePermissions.mockResolvedValueOnce(1 | 2 | 4);
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.roomEmit).toHaveBeenCalledWith('soundboard:play', expect.objectContaining({ soundId: 'snd1' }));
  });

  // ── ZAMAN AŞIMI SESİ DE KAPSAR ────────────────────────────────────────────
  // Timeout, üyenin ürettiği HER kanal içeriğini durdurur. Yalnızca metni
  // susturmak, moderasyon yaptırımını sesli kanalda etkisiz bırakırdı.
  test('soundboard playback is refused for revoked or timed-out membership', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('soundboard:play')!;

    mockMembersFindOne.mockResolvedValueOnce(null); // membership revoked
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.roomEmit).not.toHaveBeenCalled();

    mockMembersFindOne.mockRejectedValueOnce(new Error('members down')); // fail closed
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.roomEmit).not.toHaveBeenCalled();

    // PostgreSQL BIGINT'i ondalık dizge olarak döndürebilir; her iki gösterim de
    // aynı yaptırımı üretmelidir.
    mockMembersFindOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1', timeoutUntil: Date.now() + 60_000 });
    await fn({ channelId: 'c1', soundId: 'snd1' });
    mockMembersFindOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1', timeoutUntil: String(Date.now() + 60_000) });
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.roomEmit).not.toHaveBeenCalled();
    expect(mockRecordSoundPlay).not.toHaveBeenCalled();

    // Bozuk kalıcı değer moderasyonu SESSİZCE devre dışı bırakamaz: hata
    // yalıtım katmanına yükselir ve yayın yapılmaz.
    mockMembersFindOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1', timeoutUntil: 'not-a-timestamp' });
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.roomEmit).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'socket.soundboard:play.failed' }), expect.any(String),
    );

    mockMembersFindOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1', timeoutUntil: Date.now() - 60_000 });
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(h.roomEmit).toHaveBeenCalledWith('soundboard:play', expect.objectContaining({ soundId: 'snd1' }));
  });

  test('soundboard allows only catalogued bridge-sound IDs and attributes built-in playback', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('soundboard:play')!;
    await fn({ channelId: 'c1', soundId: 'global:chime' });
    expect(mockFindSound).not.toHaveBeenCalled();
    expect(mockRecordSoundPlay).toHaveBeenCalledWith('global:chime', 'u1', null);
    expect(h.roomEmit).toHaveBeenCalledWith('soundboard:play', expect.objectContaining({
      soundId: 'global:chime', soundUrl: 'bridge-sound:chime', scope: 'global',
      playedBy: expect.objectContaining({ id: 'u1', displayName: 'Alice' }),
    }));

    h.roomEmit.mockClear();
    mockFindSound.mockResolvedValueOnce({ _id: 'evil', url: 'bridge-sound:arbitrary', name: 'evil', emoji: 'x' });
    await fn({ channelId: 'c1', soundId: 'evil' });
    expect(h.roomEmit).not.toHaveBeenCalled();
  });

  test('soundboard tracking failure is observable but does not interrupt authorized playback', async () => {
    const h = setupInfra();
    const fn = h.handlers.get('soundboard:play')!;
    mockRecordSoundPlay.mockRejectedValueOnce(new Error('stats unavailable'));
    await fn({ channelId: 'c1', soundId: 'snd1' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ soundId: 'snd1', userId: 'u1' }),
      '[Soundboard] play tracking failed',
    );
    expect(h.roomEmit).toHaveBeenCalledWith('soundboard:play', expect.objectContaining({ soundId: 'snd1' }));
  });
});

describe('handleDisconnect deeper branches', () => {
  test('cleans rooms/timers/rate/voice and broadcasts offline when last socket disappears', async () => {
    const h = setupInfra();
    h.socket.rooms.add('server:s1');
    h.typingTimers.set('c1:u1', setTimeout(() => {}, 9999));
    h.typingTimers.set('c1:other', setTimeout(() => {}, 9999));
    h.rateStore.set('u1:message', [1]);
    h.rateStore.set('other:message', [1]);
    const timer = setInterval(() => {}, 9999);
    const updateError = new Error('offline write failed');
    mockUsersUpdate.mockRejectedValueOnce(updateError);
    mockReleaseSocket.mockResolvedValueOnce(0);
    mockMembersFindByUser.mockRejectedValueOnce(new Error('membership db down'));

    await handleDisconnect(h.socket, h.safeUser, {
      socketUsers: h.socketUsers,
      typingTimers: h.typingTimers,
      _socketRateStore: h.rateStore,
      leaveVoice: h.leaveVoice,
      voiceActivity: h.voiceActivity,
      tokenCheckTimer: timer,
      io: h.io,
    } as any);

    expect(h.socketUsers.has('sock1')).toBe(false);
    expect(h.socket.leave).toHaveBeenCalledWith('channel:c1');
    expect(h.socket.leave).toHaveBeenCalledWith('voice:c1');
    expect(h.socket.leave).toHaveBeenCalledWith('server:s1');
    expect(h.typingTimers.has('c1:u1')).toBe(false);
    expect(h.typingTimers.has('c1:other')).toBe(true);
    expect(h.rateStore.has('u1:message')).toBe(false);
    expect(h.rateStore.has('other:message')).toBe(true);
    expect(h.leaveVoice).toHaveBeenCalledWith(h.socket, 'c1', 's1', h.io);
    expect(h.voiceActivity.has('sock1')).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'socket.disconnect.offline_update_error' }), expect.any(String));
  });

  test('does not mark offline when presence cache or another socket reports the user connected', async () => {
    const h = setupInfra();
    h.socketUsers.set('sock2', { _id: 'u1' });
    mockReleaseSocket.mockResolvedValueOnce(0);
    const timer = setInterval(() => {}, 9999);
    await handleDisconnect(h.socket, h.safeUser, {
      socketUsers: h.socketUsers, typingTimers: h.typingTimers, _socketRateStore: h.rateStore,
      leaveVoice: h.leaveVoice, voiceActivity: h.voiceActivity, tokenCheckTimer: timer, io: h.io,
    } as any);
    expect(mockUsersUpdate).not.toHaveBeenCalled();

    const h2 = setupInfra();
    mockReleaseSocket.mockResolvedValueOnce(2);
    await handleDisconnect(h2.socket, h2.safeUser, {
      socketUsers: h2.socketUsers, typingTimers: h2.typingTimers, _socketRateStore: h2.rateStore,
      leaveVoice: h2.leaveVoice, voiceActivity: h2.voiceActivity, tokenCheckTimer: setInterval(() => {}, 9999), io: h2.io,
    } as any);
    expect(mockUsersUpdate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 Phase 17 — an incomplete person, and a socket that is not in a call.
//
// Every test above uses one fully populated account and one socket sitting in a voice
// channel, so the fallbacks these handlers carry were never taken. They are not cosmetic:
// the typing line and the soundboard toast name a person, and "undefined is typing" is what
// a missing display name produces.
// ════════════════════════════════════════════════════════════════════════════
describe('Final21 Phase 17 — incomplete accounts and idle sockets', () => {
  test('the typing signal names a person without a display name by username', async () => {
    const h = setupInfra({ displayName: '' });

    await h.handlers.get('typing:start')!({ channelId: 'c1' });

    expect(h.roomEmit).toHaveBeenCalledWith('typing:update', expect.objectContaining({
      userId: 'u1', displayName: 'alice', typing: true,
    }));
  });

  test('typing:stop cancels the pending auto-stop instead of letting it fire later', async () => {
    const h = setupInfra();

    await h.handlers.get('typing:start')!({ channelId: 'c1' });
    expect(h.typingTimers.has('c1:u1')).toBe(true);
    await h.handlers.get('typing:stop')!({ channelId: 'c1' });

    expect(h.typingTimers.has('c1:u1')).toBe(false);
    expect(h.roomEmit).toHaveBeenLastCalledWith('typing:update', expect.objectContaining({ typing: false }));

    // The safety timeout must be gone: a second `typing:false` after the person started
    // typing again would blink the indicator off for everyone else.
    h.roomEmit.mockClear();
    jest.advanceTimersByTime(10_000);
    expect(h.roomEmit).not.toHaveBeenCalled();
  });

  test('a status with no text or emoji is published as empty strings, not undefined', async () => {
    const h = setupInfra();

    await h.handlers.get('status:update')!({ status: 'idle' });

    const call = h.emit.mock.calls.find(([event]: [string]) => event === 'user:status');
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ statusText: '', statusEmoji: '' });
  });

  test('the soundboard toast falls back to username and leaves missing avatars null', async () => {
    const h = setupInfra({ displayName: undefined, avatarColor: undefined, avatarUrl: undefined });

    await h.handlers.get('soundboard:play')!({ channelId: 'c1', soundId: 'snd1' });

    const call = h.roomEmit.mock.calls.find(([event]: [string]) => event === 'soundboard:play');
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ playedBy: expect.objectContaining({ displayName: 'alice', avatarColor: null, avatarUrl: null }) });
  });

  test('disconnect clears a pending token-expiry timer and skips voice teardown when not in a call', async () => {
    const h = setupInfra();
    h.socket.currentVoiceChannel = undefined;
    h.socket.currentVoiceServer = undefined;
    const expiry = setTimeout(() => { throw new Error("token expiry fired after disconnect"); }, 5_000);

    await handleDisconnect(h.socket, h.safeUser, {
      socketUsers: h.socketUsers, typingTimers: h.typingTimers, _socketRateStore: h.rateStore,
      leaveVoice: h.leaveVoice, voiceActivity: h.voiceActivity,
      tokenCheckTimer: setInterval(() => {}, 9_999), tokenExpiryTimer: expiry, io: h.io,
    } as any);

    // Nothing to leave: calling leaveVoice for a socket that never joined one would emit a
    // spurious "left the call" to the channel.
    expect(h.leaveVoice).not.toHaveBeenCalled();
    // And the expiry timer must not outlive the socket.
    expect(() => jest.advanceTimersByTime(10_000)).not.toThrow();
  });
});
